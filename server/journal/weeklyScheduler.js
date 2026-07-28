import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;
const RETRY_MS = 5 * 60 * 1_000;

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}

function localDateKey(date) {
  return [
    String(date.getFullYear()).padStart(4, "0"),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

export function weeklyScheduleWindow(nowValue, {
  day = 1,
  hour = 8,
  minute = 0,
} = {}) {
  const now = new Date(nowValue);
  const due = new Date(now);
  due.setHours(hour, minute, 0, 0);
  const daysSinceDueDay = (due.getDay() - day + 7) % 7;
  due.setDate(due.getDate() - daysSinceDueDay);
  if (due.getTime() > now.getTime()) {
    due.setDate(due.getDate() - 7);
  }
  const nextDue = new Date(due.getTime() + WEEK_MS);
  return {
    weekKey: localDateKey(due),
    dueAt: due.toISOString(),
    nextDueAt: nextDue.toISOString(),
  };
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporaryPath, filePath);
}

async function readState(filePath) {
  try {
    const state = JSON.parse(await readFile(filePath, "utf8"));
    return state?.schema_version === 1 ? state : null;
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

export function createWeeklyJournalScheduler({
  workflowService,
  dataDir,
  env = process.env,
  now = () => new Date(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (!workflowService || typeof workflowService.startRun !== "function") {
    throw new TypeError("workflowService.startRun is required");
  }
  if (typeof dataDir !== "string" || !dataDir.trim()) {
    throw new TypeError("dataDir is required");
  }
  const schedule = {
    day: boundedInteger(env.PI_WEEKLY_RUN_DAY, 1, 0, 6),
    hour: boundedInteger(env.PI_WEEKLY_RUN_HOUR, 8, 0, 23),
    minute: boundedInteger(env.PI_WEEKLY_RUN_MINUTE, 0, 0, 59),
  };
  const statePath = path.resolve(dataDir, "scheduler", "weekly.json");
  let timer = null;
  let stopped = false;
  let running = null;

  function arm(delayMs) {
    if (stopped) return;
    clearTimer(timer);
    timer = setTimer(() => {
      tick().catch(() => undefined);
    }, Math.max(1, Math.min(delayMs, 2_147_000_000)));
    timer.unref?.();
  }

  async function tick() {
    if (stopped) return null;
    if (running) return running;
    running = (async () => {
      const currentTime = now();
      const window = weeklyScheduleWindow(currentTime, schedule);
      const previous = await readState(statePath);
      if (previous?.last_started_week_key === window.weekKey) {
        arm(new Date(window.nextDueAt).getTime() - currentTime.getTime());
        return previous;
      }
      try {
        const run = await workflowService.startRun();
        const next = {
          schema_version: 1,
          schedule,
          last_started_week_key: window.weekKey,
          last_started_run_id: run?.run_id ?? null,
          last_started_at: currentTime.toISOString(),
          last_error: null,
          next_due_at: window.nextDueAt,
        };
        await writeJsonAtomic(statePath, next);
        arm(new Date(window.nextDueAt).getTime() - currentTime.getTime());
        return next;
      } catch (error) {
        const failed = {
          schema_version: 1,
          schedule,
          last_started_week_key:
            previous?.last_started_week_key ?? null,
          last_started_run_id:
            previous?.last_started_run_id ?? null,
          last_started_at:
            previous?.last_started_at ?? null,
          last_error: {
            code: typeof error?.code === "string"
              ? error.code
              : "WEEKLY_RUN_START_FAILED",
            message: typeof error?.message === "string"
              ? error.message.slice(0, 300)
              : "每周追踪未能启动",
            at: currentTime.toISOString(),
          },
          next_due_at: new Date(currentTime.getTime() + RETRY_MS).toISOString(),
        };
        await writeJsonAtomic(statePath, failed);
        arm(RETRY_MS);
        return failed;
      }
    })().finally(() => {
      running = null;
    });
    return running;
  }

  async function start() {
    stopped = false;
    return tick();
  }

  function dispose() {
    stopped = true;
    clearTimer(timer);
    timer = null;
  }

  return Object.freeze({
    dispose,
    start,
    tick,
  });
}
