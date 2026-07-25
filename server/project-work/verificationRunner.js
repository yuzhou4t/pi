import { spawn } from "node:child_process";
import { projectWorkError } from "./errors.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 128 * 1024;

function boundedChunk(current, chunk, maxBytes) {
  if (current.length >= maxBytes) return { value: current, truncated: true };
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  const remaining = maxBytes - current.length;
  return {
    value: Buffer.concat([current, buffer.subarray(0, remaining)]),
    truncated: buffer.length > remaining,
  };
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
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let stdoutTruncated = false;
      let stderrTruncated = false;
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
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8"),
          truncated: stdoutTruncated || stderrTruncated,
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
        const bounded = boundedChunk(stdout, chunk, maxOutputBytes);
        stdout = bounded.value;
        stdoutTruncated ||= bounded.truncated;
      });
      child.stderr?.on("data", (chunk) => {
        const bounded = boundedChunk(stderr, chunk, maxOutputBytes);
        stderr = bounded.value;
        stderrTruncated ||= bounded.truncated;
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
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8"),
          truncated: stdoutTruncated || stderrTruncated,
        });
      });
    });
  };
}
