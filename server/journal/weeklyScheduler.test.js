import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createWeeklyJournalScheduler,
  weeklyScheduleWindow,
} from "./weeklyScheduler.js";

test("weekly schedule resolves the current local Monday window and next due time", () => {
  const now = new Date(2026, 6, 29, 9, 30);
  const window = weeklyScheduleWindow(now, {
    day: 1,
    hour: 8,
    minute: 0,
  });
  assert.equal(window.weekKey, "2026-07-27");
  const due = new Date(window.dueAt);
  const next = new Date(window.nextDueAt);
  assert.equal(due.getDay(), 1);
  assert.equal(due.getHours(), 8);
  assert.equal(next.getTime() - due.getTime(), 7 * 24 * 60 * 60 * 1_000);
});

test("scheduler catches up once on startup and does not duplicate the same week", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-weekly-scheduler-"));
  let current = new Date(2026, 6, 29, 9, 30);
  const starts = [];
  const delays = [];
  const scheduler = createWeeklyJournalScheduler({
    dataDir,
    env: {
      PI_WEEKLY_RUN_DAY: "1",
      PI_WEEKLY_RUN_HOUR: "8",
      PI_WEEKLY_RUN_MINUTE: "0",
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
  const statePath = path.join(dataDir, "scheduler", "weekly.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.last_started_week_key, "2026-07-27");
  assert.equal(state.last_started_run_id, "run-1");
  assert.equal(delays.length >= 2, true);

  current = new Date(2026, 7, 3, 8, 1);
  await scheduler.tick();
  assert.deepEqual(starts, [{ run_id: "run-1" }, { run_id: "run-2" }]);
  scheduler.dispose();
});

test("scheduler persists a retryable startup failure without advancing the week", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-weekly-failure-"));
  let scheduledDelay = null;
  const scheduler = createWeeklyJournalScheduler({
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
  assert.equal(state.last_started_week_key, null);
  assert.equal(state.last_error.code, "PROJECT_CONTEXT_MISSING");
  assert.equal(scheduledDelay, 5 * 60 * 1_000);
  scheduler.dispose();
});
