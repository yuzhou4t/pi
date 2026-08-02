import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  createWorkspaceRunEnvironment,
  createWorkspaceRunSupervisor,
  validateWorkspaceRunCommand,
} from "./workspaceRunSupervisor.js";

function fakeChild({ pid = 41_001 } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  return child;
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "pi-workspace-run-"));
  const storageRoot = path.join(root, "storage");
  const workspaceRoot = path.join(root, "workspace");
  await mkdir(path.join(workspaceRoot, "packages", "app"), { recursive: true });
  const children = [];
  const spawnCalls = [];
  let sequence = 0;
  const supervisor = createWorkspaceRunSupervisor({
    storageRoot,
    idFactory: () => `run-${++sequence}`,
    spawnImpl: (file, args, spawnOptions) => {
      spawnCalls.push({ file, args, options: spawnOptions });
      const child = fakeChild({ pid: 41_000 + sequence });
      children.push(child);
      return child;
    },
    ...options,
  });
  t.after(async () => {
    await supervisor.dispose({ cancelActive: false });
  });
  return {
    children,
    root,
    spawnCalls,
    storageRoot,
    supervisor,
    workspaceRoot,
  };
}

test("workspace run environment preserves toolchain caches and removes Pi, model, API, and notification secrets", () => {
  const environment = createWorkspaceRunEnvironment({
    baseEnvironment: {
      PATH: "/usr/bin:/bin",
      HOME: "/Users/alice",
      CARGO_HOME: "/Users/alice/.cargo",
      GRADLE_USER_HOME: "/Users/alice/.gradle",
      JAVA_HOME: "/Applications/Xcode.app/jre",
      PI_PROJECT_WORK_STORAGE_ROOT: "/private/pi",
      OPENAI_API_KEY: "openai-secret",
      DEEPSEEK_TOKEN: "deepseek-secret",
      LARK_APP_ID: "notification-id",
      MY_SERVICE_API_KEY: "generic-secret",
      SSH_AUTH_SOCK: "/private/ssh-agent",
      NODE_OPTIONS: "--require ./inject.js",
    },
    environment: {
      CI: "1",
      CARGO_NET_OFFLINE: "true",
    },
  });

  assert.equal(environment.PATH, "/usr/bin:/bin");
  assert.equal(environment.HOME, "/Users/alice");
  assert.equal(environment.CARGO_HOME, "/Users/alice/.cargo");
  assert.equal(environment.GRADLE_USER_HOME, "/Users/alice/.gradle");
  assert.equal(environment.JAVA_HOME, "/Applications/Xcode.app/jre");
  assert.equal(environment.CI, "1");
  assert.equal(environment.CARGO_NET_OFFLINE, "true");
  assert.equal(environment.PI_PROJECT_WORK_STORAGE_ROOT, undefined);
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.DEEPSEEK_TOKEN, undefined);
  assert.equal(environment.LARK_APP_ID, undefined);
  assert.equal(environment.MY_SERVICE_API_KEY, undefined);
  assert.equal(environment.SSH_AUTH_SOCK, undefined);
  assert.equal(environment.NODE_OPTIONS, undefined);

  assert.throws(
    () => createWorkspaceRunEnvironment({
      baseEnvironment: {},
      environment: { PATH: "/tmp/bin" },
    }),
    { code: "PROJECT_WORK_RUN_ENVIRONMENT_BLOCKED" },
  );
});

test("workspace run command accepts literal argv and rejects shell, inline code, installers, and download shims", () => {
  assert.deepEqual(
    validateWorkspaceRunCommand({ file: "node", args: ["--test", "a;b.js"] }),
    { file: "node", args: ["--test", "a;b.js"] },
  );
  assert.deepEqual(
    validateWorkspaceRunCommand({ file: "./gradlew", args: ["test"] }),
    { file: "./gradlew", args: ["test"] },
  );
  assert.throws(
    () => validateWorkspaceRunCommand({ file: "/bin/zsh", args: ["-lc", "pwd"] }),
    { code: "PROJECT_WORK_RUN_SHELL_BLOCKED" },
  );
  assert.throws(
    () => validateWorkspaceRunCommand({ file: "node", args: ["-e", "process.exit()"] }),
    { code: "PROJECT_WORK_RUN_INLINE_CODE_BLOCKED" },
  );
  assert.throws(
    () => validateWorkspaceRunCommand({ file: "python3", args: ["-cprint('x')"] }),
    { code: "PROJECT_WORK_RUN_INLINE_CODE_BLOCKED" },
  );
  assert.throws(
    () => validateWorkspaceRunCommand({ file: "npm", args: ["install"] }),
    { code: "PROJECT_WORK_RUN_INSTALL_BLOCKED" },
  );
  assert.throws(
    () => validateWorkspaceRunCommand({
      file: "npm",
      args: ["--prefix", "packages/app", "install"],
    }),
    { code: "PROJECT_WORK_RUN_INSTALL_BLOCKED" },
  );
  assert.throws(
    () => validateWorkspaceRunCommand({ file: "npx", args: ["vite"] }),
    { code: "PROJECT_WORK_RUN_SHELL_BLOCKED" },
  );
  for (const command of [
    { file: "git", args: ["push"] },
    { file: "git", args: ["reset", "--hard"] },
    { file: "rm", args: ["-rf", "src"] },
  ]) {
    assert.throws(
      () => validateWorkspaceRunCommand(command),
      { code: "PROJECT_WORK_RUN_MUTATION_BLOCKED" },
    );
  }
  assert.throws(
    () => validateWorkspaceRunCommand({ file: "npm", args: ["run", "arbitrary"] }),
    { code: "PROJECT_WORK_RUN_UNREGISTERED_SCRIPT_BLOCKED" },
  );
  assert.deepEqual(
    validateWorkspaceRunCommand({
      file: "npm",
      args: ["test"],
      registeredRecipe: true,
    }),
    { file: "npm", args: ["test"] },
  );
});

test("supervisor runs exact argv in the real Workspace, persists safe chunks, and replays afterSeq", async (t) => {
  const hidden = "CUSTOM_PRIVATE_VALUE";
  const setup = await fixture(t, {
    baseEnvironment: {
      PATH: "/usr/bin:/bin",
      HOME: "/Users/alice",
      CARGO_HOME: "/Users/alice/.cargo",
      PI_INTERNAL_TOKEN: "hidden",
      OPENAI_API_KEY: "hidden",
    },
    redactOutput: (value) => value.replaceAll(hidden, "<custom-redacted>"),
  });
  const delivered = [];
  const unsubscribe = setup.supervisor.subscribe("run-1", (event) => {
    delivered.push(event);
  });
  t.after(unsubscribe);

  const started = await setup.supervisor.start({
    workspaceId: "workspace-main",
    workspaceRoot: setup.workspaceRoot,
    file: "node",
    args: ["--test", "tests/example.test.js"],
    cwd: "packages/app",
    environment: { CI: "1" },
    metadata: { conversationId: "conversation-1", recipeId: "node-test" },
  });

  assert.equal(started.run.status, "running");
  assert.equal(started.run.cwd, path.join("packages", "app"));
  assert.deepEqual(started.run.metadata, {
    conversationId: "conversation-1",
    recipeId: "node-test",
  });
  assert.equal(setup.spawnCalls.length, 1);
  assert.equal(setup.spawnCalls[0].file, "node");
  assert.deepEqual(setup.spawnCalls[0].args, ["--test", "tests/example.test.js"]);
  assert.equal(
    setup.spawnCalls[0].options.cwd,
    await import("node:fs/promises").then(({ realpath }) => realpath(
      path.join(setup.workspaceRoot, "packages", "app"),
    )),
  );
  assert.equal(setup.spawnCalls[0].options.shell, false);
  assert.equal(setup.spawnCalls[0].options.detached, process.platform !== "win32");
  assert.deepEqual(setup.spawnCalls[0].options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(setup.spawnCalls[0].options.env.HOME, "/Users/alice");
  assert.equal(setup.spawnCalls[0].options.env.CARGO_HOME, "/Users/alice/.cargo");
  assert.equal(setup.spawnCalls[0].options.env.PI_INTERNAL_TOKEN, undefined);
  assert.equal(setup.spawnCalls[0].options.env.OPENAI_API_KEY, undefined);

  setup.children[0].stdout.write(
    `checking ${setup.workspaceRoot}/Sources/App.swift ${hidden}\n`,
  );
  setup.children[0].stderr.write(
    "api_key=super-secret-value\n",
  );
  setup.children[0].stdout.end();
  setup.children[0].stderr.end();
  setup.children[0].emit("close", 0, null);
  const completed = await started.completion;

  assert.equal(completed.status, "succeeded");
  assert.equal(completed.exitCode, 0);
  assert.equal(completed.error, null);
  const snapshot = await setup.supervisor.snapshot(completed.id, {
    afterSeq: 0,
    limit: 3,
  });
  assert.equal(snapshot.events.length, 3);
  assert.equal(snapshot.hasMore, true);
  assert.deepEqual(snapshot.events.map((event) => event.seq), [1, 2, 3]);
  const replay = await setup.supervisor.snapshot(completed.id, {
    afterSeq: snapshot.nextSeq,
  });
  const allEvents = [...snapshot.events, ...replay.events];
  assert.deepEqual(
    allEvents.map((event) => event.seq),
    allEvents.map((_, index) => index + 1),
  );
  const chunks = allEvents.filter((event) => event.type === "chunk");
  assert.deepEqual(chunks.map((event) => event.stream).sort(), ["stderr", "stdout"]);
  assert.ok(chunks.every((event) => Number.isInteger(event.offset)));
  const text = chunks.map((event) => event.text).join("");
  assert.match(text, /<workspace>\/Sources\/App\.swift/);
  assert.match(text, /<custom-redacted>/);
  assert.match(text, /api_key=<redacted>/);
  assert.doesNotMatch(text, new RegExp(setup.workspaceRoot));
  assert.doesNotMatch(text, /super-secret-value/);
  assert.ok(delivered.length >= allEvents.length);

  const listed = await setup.supervisor.list({ workspaceId: "workspace-main" });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].status, "succeeded");
  assert.equal(Object.hasOwn(listed[0], "workspaceRoot"), false);
  assert.equal(Object.hasOwn(listed[0], "pid"), false);

  const eventLog = await readFile(
    path.join(setup.storageRoot, "workspace-runs", "run-1", "events.jsonl"),
    "utf8",
  );
  assert.doesNotMatch(eventLog, new RegExp(setup.workspaceRoot));
  assert.doesNotMatch(eventLog, /super-secret-value/);
});

test("supervisor captures a real shell-free child process", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-workspace-run-real-"));
  const workspaceRoot = path.join(root, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(
    path.join(workspaceRoot, "emit.mjs"),
    "process.stdout.write('real child output\\n');\n",
    "utf8",
  );
  const supervisor = createWorkspaceRunSupervisor({
    storageRoot: path.join(root, "storage"),
    idFactory: () => "run-real-child",
  });
  t.after(async () => supervisor.dispose({ cancelActive: false }));

  const started = await supervisor.start({
    workspaceId: "workspace-main",
    workspaceRoot,
    file: process.execPath,
    args: ["emit.mjs"],
  });
  const completed = await started.completion;
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.exitCode, 0);
  const snapshot = await supervisor.snapshot(completed.id);
  assert.equal(
    snapshot.events
      .filter((event) => event.type === "chunk" && event.stream === "stdout")
      .map((event) => event.text)
      .join(""),
    "real child output\n",
  );
});

test("supervisor rejects cwd and project-local executable symlinks that escape the Workspace", async (t) => {
  const setup = await fixture(t);
  const outside = path.join(setup.root, "outside");
  await mkdir(outside);
  await symlink(outside, path.join(setup.workspaceRoot, "outside-link"));
  await symlink(process.execPath, path.join(setup.workspaceRoot, "tool"));

  await assert.rejects(
    setup.supervisor.start({
      workspaceId: "workspace-main",
      workspaceRoot: setup.workspaceRoot,
      file: "node",
      cwd: "outside-link",
    }),
    { code: "PROJECT_WORK_RUN_CWD_OUTSIDE_WORKSPACE" },
  );
  await assert.rejects(
    setup.supervisor.start({
      workspaceId: "workspace-main",
      workspaceRoot: setup.workspaceRoot,
      file: "./tool",
    }),
    { code: "PROJECT_WORK_RUN_COMMAND_OUTSIDE_WORKSPACE" },
  );
  assert.equal(setup.spawnCalls.length, 0);
});

test("cancel escalates SIGINT to SIGTERM and SIGKILL before persisting cancelled", async (t) => {
  const signals = [];
  let child;
  const setup = await fixture(t, {
    interruptGraceMs: 2,
    terminateGraceMs: 2,
    killGraceMs: 20,
    killImpl: (target, signal) => {
      signals.push(signal);
      if (signal === "SIGKILL") {
        queueMicrotask(() => target.emit("close", null, signal));
      }
      return true;
    },
    spawnImpl: (file, args, options) => {
      setup.spawnCalls.push({ file, args, options });
      child = fakeChild();
      setup.children.push(child);
      return child;
    },
  });
  const started = await setup.supervisor.start({
    workspaceId: "workspace-main",
    workspaceRoot: setup.workspaceRoot,
    file: "swift",
    args: ["test"],
  });

  const cancelled = await setup.supervisor.cancel(started.run.id);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.exitCode, null);
  assert.equal(cancelled.signal, "SIGKILL");
  assert.deepEqual(signals, ["SIGINT", "SIGTERM", "SIGKILL"]);
  assert.equal(await started.completion, cancelled);

  const snapshot = await setup.supervisor.snapshot(started.run.id);
  assert.deepEqual(
    snapshot.events.filter((event) => event.type === "status").map((event) => event.status),
    ["queued", "running", "cancel_requested", "cancelled"],
  );
});

test("a cancel racing with normal process exit does not append a second terminal transition", async (t) => {
  const setup = await fixture(t, {
    interruptGraceMs: 2,
    terminateGraceMs: 2,
    killGraceMs: 2,
  });
  const started = await setup.supervisor.start({
    workspaceId: "workspace-main",
    workspaceRoot: setup.workspaceRoot,
    file: "node",
    args: ["--test"],
  });
  setup.children[0].emit("close", 0, null);
  const [completed, cancelled] = await Promise.all([
    started.completion,
    setup.supervisor.cancel(started.run.id),
  ]);
  assert.equal(completed.status, "succeeded");
  assert.equal(cancelled.status, "succeeded");
  const snapshot = await setup.supervisor.snapshot(started.run.id);
  const terminal = snapshot.events.filter((event) => (
    event.type === "status"
    && ["succeeded", "failed", "cancelled", "interrupted"].includes(event.status)
  ));
  assert.equal(terminal.length, 1);
  assert.deepEqual(
    snapshot.events.map((event) => event.seq),
    snapshot.events.map((_, index) => index + 1),
  );
});

test("initialize marks persisted queued or running work interrupted without rerunning it", async (t) => {
  const setup = await fixture(t);
  const queued = await setup.supervisor.start({
    workspaceId: "workspace-a",
    workspaceRoot: setup.workspaceRoot,
    file: "go",
    args: ["test", "./..."],
  });
  const running = await setup.supervisor.start({
    workspaceId: "workspace-b",
    workspaceRoot: setup.workspaceRoot,
    file: "swift",
    args: ["test"],
  });
  assert.equal(queued.run.status, "running");
  assert.equal(running.run.status, "running");
  await setup.supervisor.dispose({ cancelActive: false });
  const queuedRecordPath = path.join(
    setup.storageRoot,
    "workspace-runs",
    queued.run.id,
    "run.json",
  );
  const queuedRecord = JSON.parse(await readFile(queuedRecordPath, "utf8"));
  queuedRecord.status = "queued";
  queuedRecord.startedAt = null;
  await writeFile(queuedRecordPath, `${JSON.stringify(queuedRecord, null, 2)}\n`);

  let respawned = 0;
  const recoveredSupervisor = createWorkspaceRunSupervisor({
    storageRoot: setup.storageRoot,
    spawnImpl: () => {
      respawned += 1;
      return fakeChild();
    },
  });
  t.after(async () => recoveredSupervisor.dispose({ cancelActive: false }));
  await recoveredSupervisor.initialize();

  const recoveredQueued = await recoveredSupervisor.get(queued.run.id);
  const recoveredRunning = await recoveredSupervisor.get(running.run.id);
  assert.equal(recoveredQueued.status, "interrupted");
  assert.equal(recoveredRunning.status, "interrupted");
  assert.equal(recoveredQueued.exitCode, null);
  assert.equal(recoveredRunning.exitCode, null);
  assert.match(recoveredQueued.error, /未自动重试/);
  assert.match(recoveredRunning.error, /未自动重试/);
  assert.equal(respawned, 0);
  const snapshot = await recoveredSupervisor.snapshot(running.run.id);
  assert.equal(snapshot.events.at(-1).status, "interrupted");
});

test("spawn failure becomes a durable failed run and redacts its diagnostics", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-workspace-run-failure-"));
  const workspaceRoot = path.join(root, "workspace");
  await mkdir(workspaceRoot);
  const supervisor = createWorkspaceRunSupervisor({
    storageRoot: path.join(root, "storage"),
    idFactory: () => "run-spawn-failure",
    spawnImpl: () => {
      throw new Error(`failed in ${workspaceRoot} token=private-token-value`);
    },
  });
  t.after(async () => supervisor.dispose({ cancelActive: false }));

  const started = await supervisor.start({
    workspaceId: "workspace-main",
    workspaceRoot,
    file: "node",
    args: ["--test"],
  });
  const failed = await started.completion;
  assert.equal(started.run.status, "failed");
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /<workspace>/);
  assert.match(failed.error, /token=<redacted>/);
  assert.doesNotMatch(failed.error, new RegExp(workspaceRoot));
  assert.doesNotMatch(failed.error, /private-token-value/);
  assert.equal((await supervisor.list()).length, 1);
});

test("log chunks preserve UTF-8 offsets and emit one durable truncation marker", async (t) => {
  const setup = await fixture(t, {
    maxEventBytes: 256,
    maxStreamBytes: 300,
    partialLineBytes: 256,
    redactionTailBytes: 64,
  });
  const started = await setup.supervisor.start({
    workspaceId: "workspace-main",
    workspaceRoot: setup.workspaceRoot,
    file: "node",
    args: ["--test"],
  });
  const encoded = Buffer.from(`${"你".repeat(200)}\n`, "utf8");
  setup.children[0].stdout.write(encoded.subarray(0, 101));
  setup.children[0].stdout.write(encoded.subarray(101));
  setup.children[0].emit("close", 1, null);
  const failed = await started.completion;
  assert.equal(failed.status, "failed");
  assert.equal(failed.output.truncated, true);

  const snapshot = await setup.supervisor.snapshot(started.run.id);
  const chunks = snapshot.events.filter((event) => event.type === "chunk");
  assert.equal(
    chunks.filter((event) => event.text.includes("运行日志达到持久化上限")).length,
    1,
  );
  let expectedOffset = 0;
  for (const chunk of chunks) {
    assert.equal(chunk.offset, expectedOffset);
    assert.doesNotMatch(chunk.text, /�/u);
    expectedOffset += Buffer.byteLength(chunk.text, "utf8");
  }
  assert.equal(failed.output.stdoutBytes, expectedOffset);
});

test("metadata rejects credential-shaped fields before a run is persisted", async (t) => {
  const setup = await fixture(t);
  await assert.rejects(
    setup.supervisor.start({
      workspaceId: "workspace-main",
      workspaceRoot: setup.workspaceRoot,
      file: "node",
      args: ["--test"],
      metadata: { apiKey: "must-not-persist" },
    }),
    { code: "PROJECT_WORK_RUN_METADATA_UNSAFE" },
  );
  assert.equal(setup.spawnCalls.length, 0);
  assert.deepEqual(await setup.supervisor.list(), []);
});
