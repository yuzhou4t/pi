import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const RETRY_MS = 5 * 60 * 1_000;

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}

function monthKeyOf(date) {
  return [
    String(date.getFullYear()).padStart(4, "0"),
    String(date.getMonth() + 1).padStart(2, "0"),
  ].join("-");
}

// day 限定 1-28，避免月末溢出；due 为本月第 day 天 hour:minute，未到则回退到上一个月。
export function monthlyScheduleWindow(nowValue, {
  day = 1,
  hour = 8,
  minute = 0,
} = {}) {
  const now = new Date(nowValue);
  const due = new Date(now);
  due.setHours(hour, minute, 0, 0);
  due.setDate(day);
  if (due.getTime() > now.getTime()) {
    due.setMonth(due.getMonth() - 1);
  }
  const nextDue = new Date(due);
  nextDue.setMonth(nextDue.getMonth() + 1);
  return {
    monthKey: monthKeyOf(due),
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

export function createMonthlyJournalScheduler({
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
    day: boundedInteger(env.PI_MONTHLY_RUN_DAY, 1, 1, 28),
    hour: boundedInteger(env.PI_MONTHLY_RUN_HOUR, 8, 0, 23),
    minute: boundedInteger(env.PI_MONTHLY_RUN_MINUTE, 0, 0, 59),
  };
  const statePath = path.resolve(dataDir, "scheduler", "monthly.json");
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
      const window = monthlyScheduleWindow(currentTime, schedule);
      const previous = await readState(statePath);
      if (previous?.last_started_month_key === window.monthKey) {
        arm(new Date(window.nextDueAt).getTime() - currentTime.getTime());
        return previous;
      }
      try {
        const run = await workflowService.startRun();
        const next = {
          schema_version: 1,
          schedule,
          last_started_month_key: window.monthKey,
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
          last_started_month_key:
            previous?.last_started_month_key ?? null,
          last_started_run_id:
            previous?.last_started_run_id ?? null,
          last_started_at:
            previous?.last_started_at ?? null,
          last_error: {
            code: typeof error?.code === "string"
              ? error.code
              : "MONTHLY_RUN_START_FAILED",
            message: typeof error?.message === "string"
              ? error.message.slice(0, 300)
              : "每月追踪未能启动",
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
