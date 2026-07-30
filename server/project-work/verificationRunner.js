import { spawn } from "node:child_process";
import { projectWorkError } from "./errors.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 128 * 1024;
const TRUNCATION_MARKER = Buffer.from(
  "\n… 验证输出达到安全采集上限；以下保留末尾诊断内容 …\n",
);

function createBoundedOutput() {
  return {
    complete: Buffer.alloc(0),
    head: Buffer.alloc(0),
    tail: Buffer.alloc(0),
    truncated: false,
    maxBytes: null,
  };
}

function appendBoundedOutput(state, chunk, maxBytes) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  if (!state.truncated) {
    const combined = Buffer.concat([state.complete, buffer]);
    if (combined.length <= maxBytes) {
      state.complete = combined;
      return;
    }
    const evidenceBytes = Math.max(0, maxBytes - TRUNCATION_MARKER.length);
    const headBytes = Math.ceil(evidenceBytes / 2);
    const tailBytes = evidenceBytes - headBytes;
    state.complete = Buffer.alloc(0);
    state.head = combined.subarray(0, headBytes);
    state.tail = combined.subarray(Math.max(0, combined.length - tailBytes));
    state.truncated = true;
    state.maxBytes = maxBytes;
    return;
  }
  const tailBytes = Math.max(
    0,
    maxBytes - TRUNCATION_MARKER.length - state.head.length,
  );
  state.tail = tailBytes > 0
    ? Buffer.concat([state.tail, buffer]).subarray(-tailBytes)
    : Buffer.alloc(0);
}

function boundedOutputBuffer(state) {
  if (!state.truncated) return state.complete;
  return Buffer.concat([state.head, TRUNCATION_MARKER, state.tail])
    .subarray(0, state.maxBytes);
}

function safeEnvironment() {
  return Object.fromEntries(
    ["PATH", "LANG", "LC_ALL", "TMPDIR"].flatMap((name) => (
      typeof process.env[name] === "string" ? [[name, process.env[name]]] : []
    )),
  );
}

function killProcessTree(child, signal) {
  if (
    process.platform !== "win32"
    && Number.isInteger(child.pid)
    && child.pid > 0
  ) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (error?.code !== "ESRCH") {
        child.kill(signal);
      }
      return;
    }
  }
  child.kill(signal);
}

export function createVerificationRunner({
  spawnImpl = spawn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  now = () => Date.now(),
} = {}) {
  return function runVerificationCommand({
    file,
    args = [],
    cwd,
    signal,
  } = {}) {
    if (typeof file !== "string" || !file || !Array.isArray(args)) {
      throw projectWorkError(
        "PROJECT_WORK_VERIFICATION_COMMAND_INVALID",
        "验证命令无效",
        400,
      );
    }
    return new Promise((resolve, reject) => {
      const startedAt = now();
      const child = spawnImpl(file, args, {
        cwd,
        detached: process.platform !== "win32",
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...safeEnvironment(),
          CI: "1",
          NO_COLOR: "1",
        },
      });
      const stdout = createBoundedOutput();
      const stderr = createBoundedOutput();
      let timedOut = false;
      let settled = false;
      let forceKill;
      let hardStop;

      const cleanup = () => {
        clearTimeout(timeout);
        clearTimeout(forceKill);
        clearTimeout(hardStop);
        signal?.removeEventListener("abort", onAbort);
      };

      const resolveForcedStop = () => {
        if (settled) return;
        settled = true;
        cleanup();
        child.stdout?.destroy?.();
        child.stderr?.destroy?.();
        resolve({
          exitCode: null,
          signal: "SIGKILL",
          timedOut,
          aborted: signal?.aborted === true,
          durationMs: Math.max(0, now() - startedAt),
          stdout: boundedOutputBuffer(stdout).toString("utf8"),
          stderr: boundedOutputBuffer(stderr).toString("utf8"),
          truncated: stdout.truncated || stderr.truncated,
        });
      };

      const terminate = () => {
        if (!child.killed) {
          killProcessTree(child, "SIGTERM");
          forceKill = setTimeout(() => {
            if (!settled) killProcessTree(child, "SIGKILL");
          }, 1_000);
          forceKill.unref?.();
          hardStop = setTimeout(resolveForcedStop, 4_000);
          hardStop.unref?.();
        }
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeoutMs);
      timeout.unref?.();
      const onAbort = () => terminate();
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();

      child.stdout?.on("data", (chunk) => {
        appendBoundedOutput(stdout, chunk, maxOutputBytes);
      });
      child.stderr?.on("data", (chunk) => {
        appendBoundedOutput(stderr, chunk, maxOutputBytes);
      });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      });
      child.on("close", (exitCode, exitSignal) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          exitCode,
          signal: exitSignal,
          timedOut,
          aborted: signal?.aborted === true,
          durationMs: Math.max(0, now() - startedAt),
          stdout: boundedOutputBuffer(stdout).toString("utf8"),
          stderr: boundedOutputBuffer(stderr).toString("utf8"),
          truncated: stdout.truncated || stderr.truncated,
        });
      });
    });
  };
}
