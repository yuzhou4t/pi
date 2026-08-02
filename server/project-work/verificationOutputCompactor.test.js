import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import {
  createVerificationOutputCompactor,
} from "./verificationOutputCompactor.js";

function callbackSoon(callback, error, stdout = "", stderr = "") {
  queueMicrotask(() => callback(error, stdout, stderr));
  return {};
}

test("verification output compactor runs rtk against an isolated temporary log", async () => {
  const calls = [];
  let inputPath;
  const compact = createVerificationOutputCompactor({
    minSavingsBytes: 1,
    evidenceTailCharacters: 64,
    diagnosticCharacters: 0,
    execFileImpl: (file, args, options, callback) => {
      calls.push({ file, args, options });
      if (args[0] === "--version") {
        return callbackSoon(callback, null, "rtk 0.42.0\n");
      }
      inputPath = args[1];
      readFile(inputPath, "utf8").then((contents) => {
        assert.match(contents, /failure repeated/);
        callback(null, "1 test failed at src/example.test.js:12\n", "");
      });
      return {};
    },
  });
  const rawOutput = "failure repeated\n".repeat(100);

  const compacted = await compact({ output: rawOutput });

  assert.equal(compacted.applied, true);
  assert.match(compacted.output, /RTK heuristic summary \(non-authoritative\)/);
  assert.match(compacted.output, /1 test failed at src\/example\.test\.js:12/);
  assert.match(compacted.output, /Final excerpt preserved/);
  assert.match(compacted.output, /failure repeated/);
  assert.equal(compacted.rawBytes, Buffer.byteLength(rawOutput));
  assert.equal(compacted.compactBytes, Buffer.byteLength(compacted.output));
  assert.equal(compacted.version, "rtk 0.42.0");
  assert.deepEqual(compacted.command, ["rtk", "log"]);
  assert.equal(compacted.reason, null);
  assert.deepEqual(calls.map((call) => call.args[0]), ["--version", "log"]);
  assert.equal(calls[1].options.shell, false);
  assert.equal(calls[1].options.env.RTK_TELEMETRY_DISABLED, "1");
  assert.equal(calls[1].options.env.DO_NOT_TRACK, "1");
  assert.notEqual(calls[1].options.env.HOME, process.env.HOME);
  await assert.rejects(access(inputPath));
});

test("verification output compactor preserves unique diagnostics and the final raw excerpt", async () => {
  const rawOutput = [
    "test progress line\n".repeat(2_000),
    "AssertionError: expected 0 but received 24",
    "    at src/settings.test.js:42:9",
    "npm ERR! Test failed",
  ].join("\n");
  const compact = createVerificationOutputCompactor({
    execFileImpl: (file, args, options, callback) => (
      args[0] === "--version"
        ? callbackSoon(callback, null, "rtk 0.44.0\n")
        : callbackSoon(callback, null, "Log Summary\n1 failed")
    ),
  });

  const compacted = await compact({ output: rawOutput });

  assert.equal(compacted.applied, true);
  assert.match(compacted.output, /AssertionError: expected 0 but received 24/);
  assert.match(compacted.output, /src\/settings\.test\.js:42:9/);
  assert.match(compacted.output, /npm ERR! Test failed/);
  assert.match(compacted.output, /Final excerpt preserved from the complete log/);
  assert.ok(compacted.compactBytes < compacted.rawBytes);
});

test("failed verification drops misleading zero-failure summaries and prioritizes errors", async () => {
  const rawOutput = [
    "WARNING repeated setup warning\n".repeat(1_000),
    `${"x".repeat(2_000)} Error: oversized diagnostic line`,
    "AssertionError: expected true but received false",
    "    at src/important.test.js:72:4",
    "ordinary trailing output\n".repeat(1_000),
  ].join("\n");
  const compact = createVerificationOutputCompactor({
    evidenceTailCharacters: 256,
    diagnosticCharacters: 220,
    execFileImpl: (file, args, options, callback) => (
      args[0] === "--version"
        ? callbackSoon(callback, null, "rtk 0.44.0\n")
        : callbackSoon(callback, null, "0 errors\n0 failed\n20 warnings")
    ),
  });

  const compacted = await compact({ output: rawOutput, failed: true });

  assert.equal(compacted.applied, true);
  assert.match(compacted.output, /AssertionError: expected true but received false/);
  assert.match(compacted.output, /src\/important\.test\.js:72:4/);
  assert.doesNotMatch(compacted.output, /\b0 errors\b/);
  assert.doesNotMatch(compacted.output, /\b0 failed\b/);
});

test("verification output compactor fails open when RTK writes to stderr", async () => {
  const rawOutput = "complete raw verification evidence";
  const compact = createVerificationOutputCompactor({
    execFileImpl: (file, args, options, callback) => (
      args[0] === "--version"
        ? callbackSoon(callback, null, "rtk 0.44.0\n")
        : callbackSoon(callback, null, "summary", "unsupported log format")
    ),
  });

  const compacted = await compact({ output: rawOutput, failed: true });

  assert.equal(compacted.applied, false);
  assert.equal(compacted.output, rawOutput);
  assert.equal(compacted.reason, "process_stderr");
});

test("verification output compactor caches the RTK version", async () => {
  const calls = [];
  const compact = createVerificationOutputCompactor({
    minSavingsBytes: 1,
    execFileImpl: (file, args, options, callback) => {
      calls.push(args);
      if (args[0] === "--version") {
        return callbackSoon(callback, null, "rtk 0.42.0\n");
      }
      return callbackSoon(callback, null, "short\n");
    },
  });

  await compact({ output: "long output ".repeat(100) });
  await compact({ output: "another long output ".repeat(100) });

  assert.equal(
    calls.filter((args) => args[0] === "--version").length,
    1,
  );
  assert.equal(calls.filter((args) => args[0] === "log").length, 2);
});

test("verification output compactor fails open when RTK is missing", async () => {
  const rawOutput = "complete raw verification evidence";
  const compact = createVerificationOutputCompactor({
    execFileImpl: (file, args, options, callback) => {
      const error = new Error("spawn rtk ENOENT");
      error.code = "ENOENT";
      return callbackSoon(callback, error);
    },
  });

  const compacted = await compact({ output: rawOutput });

  assert.equal(compacted.applied, false);
  assert.equal(compacted.output, rawOutput);
  assert.equal(compacted.rawBytes, Buffer.byteLength(rawOutput));
  assert.equal(compacted.compactBytes, Buffer.byteLength(rawOutput));
  assert.equal(compacted.ratio, 1);
  assert.equal(compacted.version, null);
  assert.equal(compacted.reason, "binary_missing");
});

test("verification output compactor keeps raw output when reduction is too small", async () => {
  const rawOutput = "0123456789".repeat(20);
  const compact = createVerificationOutputCompactor({
    execFileImpl: (file, args, options, callback) => (
      args[0] === "--version"
        ? callbackSoon(callback, null, "rtk 0.42.0\n")
        : callbackSoon(callback, null, rawOutput.slice(0, -2))
    ),
  });

  const compacted = await compact({ output: rawOutput });

  assert.equal(compacted.applied, false);
  assert.equal(compacted.output, rawOutput);
  assert.equal(compacted.reason, "reduction_too_small");
  assert.equal(compacted.version, "rtk 0.42.0");
});

test("verification output compactor does not pass oversized input to RTK", async () => {
  let callCount = 0;
  const rawOutput = "too large";
  const compact = createVerificationOutputCompactor({
    maxInputBytes: 4,
    execFileImpl: () => {
      callCount += 1;
      throw new Error("should not spawn");
    },
  });

  const compacted = await compact({ output: rawOutput });

  assert.equal(compacted.applied, false);
  assert.equal(compacted.output, rawOutput);
  assert.equal(compacted.reason, "input_too_large");
  assert.equal(callCount, 0);
});

test("verification output compactor honors cancellation before spawning", async () => {
  const controller = new AbortController();
  controller.abort();
  let callCount = 0;
  const compact = createVerificationOutputCompactor({
    execFileImpl: () => {
      callCount += 1;
      throw new Error("should not spawn");
    },
  });

  const compacted = await compact({
    output: "raw output",
    signal: controller.signal,
  });

  assert.equal(compacted.applied, false);
  assert.equal(compacted.output, "raw output");
  assert.equal(compacted.reason, "aborted");
  assert.equal(callCount, 0);
});

test("verification output compactor fails open after an RTK timeout", async () => {
  const rawOutput = "timeout evidence";
  const compact = createVerificationOutputCompactor({
    execFileImpl: (file, args, options, callback) => {
      if (args[0] === "--version") {
        return callbackSoon(callback, null, "rtk 0.42.0\n");
      }
      const error = new Error("timed out");
      error.killed = true;
      return callbackSoon(callback, error);
    },
  });

  const compacted = await compact({ output: rawOutput });

  assert.equal(compacted.applied, false);
  assert.equal(compacted.output, rawOutput);
  assert.equal(compacted.reason, "timeout");
});
