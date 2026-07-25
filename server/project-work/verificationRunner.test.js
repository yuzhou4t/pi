import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createVerificationRunner } from "./verificationRunner.js";

function fakeChild({ onKill } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = (signal) => {
    child.killed = true;
    onKill?.(signal, child);
    return true;
  };
  return child;
}

test("verification runner captures a successful bounded command without a shell", async () => {
  const calls = [];
  let clock = 100;
  const runner = createVerificationRunner({
    now: () => {
      clock += 5;
      return clock;
    },
    spawnImpl: (file, args, options) => {
      calls.push({ file, args, options });
      const child = fakeChild();
      queueMicrotask(() => {
        child.stdout.end("all checks passed\n");
        child.stderr.end("");
        child.emit("close", 0, null);
      });
      return child;
    },
  });

  const result = await runner({
    file: "node",
    args: ["--test"],
    cwd: "/tmp/safe-workspace",
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.equal(result.timedOut, false);
  assert.equal(result.aborted, false);
  assert.equal(result.stdout, "all checks passed\n");
  assert.equal(result.durationMs, 5);
  assert.equal(calls[0].options.shell, false);
  assert.deepEqual(calls[0].options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(calls[0].options.env.CI, "1");
});

test("verification runner terminates and marks a timed-out child", async () => {
  const signals = [];
  const runner = createVerificationRunner({
    timeoutMs: 5,
    spawnImpl: () => fakeChild({
      onKill: (signal, child) => {
        signals.push(signal);
        queueMicrotask(() => child.emit("close", null, signal));
      },
    }),
  });

  const result = await runner({
    file: "node",
    args: ["--test"],
    cwd: "/tmp/safe-workspace",
  });

  assert.equal(result.exitCode, null);
  assert.equal(result.timedOut, true);
  assert.equal(result.aborted, false);
  assert.deepEqual(signals, ["SIGTERM"]);
});

test("verification runner honors a signal that was already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const signals = [];
  const runner = createVerificationRunner({
    timeoutMs: 1_000,
    spawnImpl: () => fakeChild({
      onKill: (signal, child) => {
        signals.push(signal);
        queueMicrotask(() => child.emit("close", null, signal));
      },
    }),
  });

  const result = await runner({
    file: "node",
    args: ["--test"],
    cwd: "/tmp/safe-workspace",
    signal: controller.signal,
  });

  assert.equal(result.exitCode, null);
  assert.equal(result.timedOut, false);
  assert.equal(result.aborted, true);
  assert.deepEqual(signals, ["SIGTERM"]);
});
