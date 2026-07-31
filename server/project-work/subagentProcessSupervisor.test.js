import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import {
  resolveSupervisedPiCliPath,
  startSupervisedSubagentProcess,
} from "./subagentProcessSupervisor.js";

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function withTimeout(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("supervisor abort timed out")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function waitForOutput(stream, pattern, timeoutMs = 2_000) {
  return withTimeout(new Promise((resolve, reject) => {
    let output = "";
    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(pattern);
      if (!match) return;
      stream.off("data", onData);
      stream.off("error", onError);
      resolve(match);
    };
    const onError = (error) => {
      stream.off("data", onData);
      reject(error);
    };
    stream.on("data", onData);
    stream.once("error", onError);
  }), timeoutMs);
}

test("supervised Pi CLI resolves to the pinned project dependency", () => {
  const cliPath = resolveSupervisedPiCliPath();
  assert.match(cliPath, /@earendil-works\/pi-coding-agent\/dist\/cli\.js$/);
});

test("supervisor escalates to SIGKILL when a child ignores SIGTERM", {
  skip: process.platform === "win32",
}, async (context) => {
  const supervised = startSupervisedSubagentProcess({
    command: process.execPath,
    args: [
      "-e",
      [
        "process.on('SIGTERM', () => {});",
        "process.stdout.write('ready\\n');",
        "setInterval(() => {}, 1000);",
      ].join(""),
    ],
    stdio: ["ignore", "pipe", "pipe"],
    forceKillAfterMs: 100,
  });
  const pid = supervised.child.pid;
  context.after(() => {
    if (pid && processExists(pid)) process.kill(pid, "SIGKILL");
  });
  await once(supervised.child.stdout, "data");

  const startedAt = Date.now();
  assert.equal(supervised.terminate("SIGTERM"), true);
  const outcome = await withTimeout(supervised.completion, 2_000);

  assert.equal(outcome.requestedSignal, "SIGTERM");
  assert.equal(outcome.forced, true);
  assert.equal(outcome.signal, "SIGKILL");
  assert.ok(Date.now() - startedAt < 1_500);
  assert.equal(processExists(pid), false);
});

test("supervisor OS abort signal settles promptly when the Pi child ignores SIGTERM", {
  skip: process.platform === "win32",
}, async (context) => {
  const moduleUrl = new URL("./subagentProcessSupervisor.js", import.meta.url).href;
  const childSource = [
    "process.on('SIGTERM', () => {});",
    "process.stdout.write(`child-ready:${process.pid}\\n`);",
    "setInterval(() => {}, 1000);",
  ].join("");
  const harnessSource = [
    `import { runSupervisedSubagentCommand } from ${JSON.stringify(moduleUrl)};`,
    "const outcome = await runSupervisedSubagentCommand({",
    "command: process.execPath,",
    `args: ['-e', ${JSON.stringify(childSource)}],`,
    "forceKillAfterMs: 100,",
    "});",
    "process.exitCode = outcome.exitCode;",
  ].join("\n");
  const harness = spawn(process.execPath, ["--input-type=module", "-e", harnessSource], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let childPid = null;
  context.after(() => {
    if (childPid && processExists(childPid)) process.kill(childPid, "SIGKILL");
    if (harness.pid && processExists(harness.pid)) process.kill(harness.pid, "SIGKILL");
  });
  const ready = await waitForOutput(harness.stdout, /child-ready:(\d+)/);
  childPid = Number(ready[1]);

  const startedAt = Date.now();
  assert.equal(harness.kill("SIGTERM"), true);
  const [code, signal] = await withTimeout(once(harness, "close"), 2_000);

  assert.equal(code, 143);
  assert.equal(signal, null);
  assert.ok(Date.now() - startedAt < 1_500);
  assert.equal(processExists(childPid), false);
  assert.equal(processExists(harness.pid), false);
});

test("supervisor does not force kill a child that exits after SIGTERM", {
  skip: process.platform === "win32",
}, async (context) => {
  const supervised = startSupervisedSubagentProcess({
    command: process.execPath,
    args: [
      "-e",
      [
        "process.on('SIGTERM', () => process.exit(0));",
        "process.stdout.write('ready\\n');",
        "setInterval(() => {}, 1000);",
      ].join(""),
    ],
    stdio: ["ignore", "pipe", "pipe"],
    forceKillAfterMs: 300,
  });
  const pid = supervised.child.pid;
  context.after(() => {
    if (pid && processExists(pid)) process.kill(pid, "SIGKILL");
  });
  await once(supervised.child.stdout, "data");

  assert.equal(supervised.terminate("SIGTERM"), true);
  const outcome = await supervised.completion;

  assert.equal(outcome.requestedSignal, "SIGTERM");
  assert.equal(outcome.forced, false);
  assert.equal(outcome.code, 0);
  assert.equal(processExists(pid), false);
});
