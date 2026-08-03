import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createMonthlyJournalScheduler,
  monthlyScheduleWindow,
  shanghaiNaturalWeekWindow,
} from "./monthlyScheduler.js";

test("Shanghai natural weeks turn over at Monday 00:00", () => {
  const before = shanghaiNaturalWeekWindow("2026-08-02T15:59:59.000Z");
  const after = shanghaiNaturalWeekWindow("2026-08-02T16:00:00.000Z");
  assert.equal(before.weekKey, "2026-07-27");
  assert.equal(before.nextDueAt, "2026-08-02T16:00:00.000Z");
  assert.equal(after.weekKey, "2026-08-03");
  assert.equal(after.dueAt, "2026-08-02T16:00:00.000Z");
});

test("monthly schedule resolves the current local month window and next due time", () => {
  const now = new Date(2026, 6, 29, 9, 30);
  const window = monthlyScheduleWindow(now, {
    day: 1,
    hour: 8,
    minute: 0,
  });
  assert.equal(window.monthKey, "2026-07");
  const due = new Date(window.dueAt);
  const next = new Date(window.nextDueAt);
  assert.equal(due.getDate(), 1);
  assert.equal(due.getHours(), 8);
  assert.equal(next.getMonth(), (due.getMonth() + 1) % 12);
  assert.equal(next.getDate(), 1);
});

test("monthly schedule before this month's due time falls back to last month", () => {
  const window = monthlyScheduleWindow(new Date(2026, 7, 1, 7, 59), {
    day: 1,
    hour: 8,
    minute: 0,
  });
  assert.equal(window.monthKey, "2026-07");
});

test("scheduler catches up once on startup and does not duplicate the same month", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-monthly-scheduler-"));
  let current = new Date(2026, 6, 29, 9, 30);
  const starts = [];
  const delays = [];
  const scheduler = createMonthlyJournalScheduler({
    dataDir,
    env: {
      PI_MONTHLY_RUN_DAY: "1",
      PI_MONTHLY_RUN_HOUR: "8",
      PI_MONTHLY_RUN_MINUTE: "0",
    },
    now: () => new Date(current),
    workflowService: {
      async startRun() {
        const run = { run_id: `run-${starts.length + 1}` };
        starts.push(run);
        return run;
      },
    },
    setTimer: (_callback, delay) => {
      delays.push(delay);
      return { unref() {} };
    },
    clearTimer: () => {},
  });

  await scheduler.start();
  await scheduler.tick();
  assert.deepEqual(starts, [{ run_id: "run-1" }]);
  const statePath = path.join(dataDir, "scheduler", "monthly.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.last_started_month_key, "2026-07");
  assert.equal(state.last_started_run_id, "run-1");
  assert.equal(delays.length >= 2, true);

  current = new Date(2026, 7, 1, 8, 1);
  await scheduler.tick();
  assert.deepEqual(starts, [{ run_id: "run-1" }, { run_id: "run-2" }]);
  scheduler.dispose();
});

test("an August 1 monthly scan refreshes once after the August 3 week boundary", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-natural-week-refresh-"));
  let current = new Date("2026-08-01T00:01:00.000Z");
  let refreshes = 0;
  const scheduler = createMonthlyJournalScheduler({
    dataDir,
    now: () => new Date(current),
    workflowService: {
      async startRun() {
        return { run_id: "run-august" };
      },
      async refreshCurrentMonthCandidates() {
        refreshes += 1;
        return { run_id: "run-august" };
      },
    },
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {},
  });

  await scheduler.start();
  await scheduler.tick();
  assert.equal(refreshes, 0);

  current = new Date("2026-08-02T16:01:00.000Z");
  await scheduler.tick();
  await scheduler.tick();
  assert.equal(refreshes, 1);

  const state = JSON.parse(await readFile(
    path.join(dataDir, "scheduler", "monthly.json"),
    "utf8",
  ));
  assert.equal(state.last_scan_week_key, "2026-08-03");
  assert.equal(state.next_refresh_due_at, "2026-08-09T16:00:00.000Z");
  scheduler.dispose();
});

test("scheduler persists a retryable startup failure without advancing the month", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-monthly-failure-"));
  let scheduledDelay = null;
  const scheduler = createMonthlyJournalScheduler({
    dataDir,
    now: () => new Date(2026, 6, 27, 9),
    workflowService: {
      async startRun() {
        const error = new Error("project state missing");
        error.code = "PROJECT_CONTEXT_MISSING";
        throw error;
      },
    },
    setTimer: (_callback, delay) => {
      scheduledDelay = delay;
      return { unref() {} };
    },
    clearTimer: () => {},
  });

  const state = await scheduler.start();
  assert.equal(state.last_started_month_key, null);
  assert.equal(state.last_error.code, "PROJECT_CONTEXT_MISSING");
  assert.equal(scheduledDelay, 5 * 60 * 1_000);
  scheduler.dispose();
});

test("scheduler retries a failed weekly refresh without delaying it for another week", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-monthly-refresh-retry-"));
  let current = new Date(2026, 6, 1, 8, 1);
  let refreshAttempts = 0;
  let scheduledDelay = null;
  const scheduler = createMonthlyJournalScheduler({
    dataDir,
    now: () => new Date(current),
    workflowService: {
      async startRun() {
        return { run_id: "run-july" };
      },
      async refreshCurrentMonthCandidates() {
        refreshAttempts += 1;
        if (refreshAttempts === 1) throw new Error("temporary refresh failure");
        return { run_id: "run-july" };
      },
    },
    setTimer: (_callback, delay) => {
      scheduledDelay = delay;
      return { unref() {} };
    },
    clearTimer: () => {},
  });

  await scheduler.start();
  current = new Date(2026, 6, 8, 8, 2);
  const failed = await scheduler.tick();
  assert.equal(refreshAttempts, 1);
  assert.equal(failed.last_refresh_at, null);
  assert.equal(failed.last_refresh_error.code, "MONTHLY_REFRESH_FAILED");
  assert.equal(scheduledDelay, 5 * 60 * 1_000);

  current = new Date(2026, 6, 8, 8, 7);
  const recovered = await scheduler.tick();
  assert.equal(refreshAttempts, 2);
  assert.ok(recovered.last_refresh_at);
  assert.equal(recovered.last_refresh_error, null);
  scheduler.dispose();
});
