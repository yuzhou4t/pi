import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import test from "node:test";
import { createProjectWorkService } from "./projectWorkService.js";

const run = promisify(execFile);

function incrementalId() {
  let value = 0;
  return () => `workspace-service-${++value}`;
}

function sessionFactory() {
  return {
    async listModels() {
      return {
        defaultProviderId: "deepseek",
        defaultModelId: "deepseek-v4-flash",
        providers: [{
          id: "deepseek",
          models: [{ id: "deepseek-v4-flash" }],
        }],
      };
    },
    async dispose() {},
  };
}

function contentHash(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function interactiveSessionFactory(onPrompt) {
  const sessions = [];
  const factory = async (options) => {
    let subscriber = null;
    const record = { options, prompts: [] };
    const host = {
      subscribe(listener) {
        subscriber = listener;
        return () => {
          subscriber = null;
        };
      },
      async prompt(prompt) {
        record.prompts.push(prompt);
        await onPrompt({ options, prompt, record });
        subscriber?.({ type: "agent_settled" });
      },
      setActiveToolsByName(names) {
        return [...names];
      },
      async steer() {},
      async abort() {},
      async compact() {},
      async setModel() {},
      dispose() {},
    };
    record.host = host;
    sessions.push(record);
    return host;
  };
  factory.listModels = async () => ({
    defaultProviderId: "deepseek",
    defaultModelId: "deepseek-v4-flash",
    providers: [{
      id: "deepseek",
      label: "DeepSeek",
      models: [{ id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" }],
    }],
  });
  factory.dispose = async () => {};
  factory.sessions = sessions;
  return factory;
}

function controlledRunSupervisor({ holdStart = false } = {}) {
  const starts = [];
  const runs = [];
  let releaseStart;
  const startGate = holdStart
    ? new Promise((resolve) => {
        releaseStart = resolve;
      })
    : null;
  return {
    starts,
    runs,
    releaseStart() {
      releaseStart?.();
    },
    complete(index = 0, overrides = {}) {
      const pending = runs[index];
      assert.ok(pending, `run ${index} was not started`);
      pending.resolve({
        id: pending.run.id,
        status: "succeeded",
        exitCode: 0,
        durationMs: 5,
        completedAt: "2026-08-02T02:00:01.000Z",
        output: { truncated: false },
        error: null,
        ...overrides,
      });
    },
    async start(input) {
      starts.push(structuredClone(input));
      if (startGate) await startGate;
      const run = {
        id: `controlled-run-${runs.length + 1}`,
        status: "running",
        startedAt: "2026-08-02T02:00:00.000Z",
      };
      let resolve;
      const completion = new Promise((settle) => {
        resolve = settle;
      });
      runs.push({ run, resolve });
      return { run, completion };
    },
    async snapshot(runId) {
      return {
        run: runs.find((item) => item.run.id === runId)?.run ?? null,
        events: [],
        nextSeq: 0,
        hasMore: false,
      };
    },
    async cancel(runId) {
      const index = runs.findIndex((item) => item.run.id === runId);
      if (index >= 0) {
        this.complete(index, { status: "cancelled", exitCode: null });
      }
      return runs[index]?.run ?? null;
    },
    async dispose() {},
  };
}

async function eventually(read, predicate, message) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const value = await read();
    if (predicate(value)) return value;
    await delay(10);
  }
  assert.fail(message);
}

async function registerProject(service) {
  const selection = await service.pickProjectRoot({ mode: "existing" });
  return service.registerProject({ selectionId: selection.selectionId });
}

function waitForEvent(service, conversationId, predicate) {
  return new Promise((resolve) => {
    const unsubscribe = service.subscribeEvents(conversationId, (event) => {
      if (!predicate(event)) return;
      unsubscribe();
      resolve(event);
    });
  });
}

async function initializeRepository(root) {
  await run("git", ["init", "-b", "main", root]);
  await run("git", ["-C", root, "config", "user.email", "pi@example.test"]);
  await run("git", ["-C", root, "config", "user.name", "Pi Agent Test"]);
  await writeFile(path.join(root, "README.md"), "workspace test\n", "utf8");
  await run("git", ["-C", root, "add", "README.md"]);
  await run("git", ["-C", root, "commit", "-m", "initial"]);
}

test("workspace-v2 conversations bind to discovered Git workspaces and remember selection", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-workspace-service-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  const storageRoot = path.join(temporaryRoot, "state");
  await mkdir(projectRoot);
  await initializeRepository(projectRoot);

  const service = createProjectWorkService({
    storageRoot,
    sessionFactory: sessionFactory(),
    workspaceRuntimeMode: "workspace-v2",
    picker: async () => ({ rootPath: projectRoot }),
    idFactory: incrementalId(),
  });
  t.after(() => service.dispose());

  const selection = await service.pickProjectRoot({ mode: "existing" });
  const project = await service.registerProject({
    selectionId: selection.selectionId,
  });
  const first = await service.createConversation(project.id);
  let workspaces = await service.listWorkspaces(project.id);
  assert.equal(workspaces.length, 1);
  assert.equal(workspaces[0].isMain, true);
  assert.equal(workspaces[0].isGit, true);
  assert.equal(workspaces[0].conversationCount, 1);
  assert.equal(first.workspace.id, workspaces[0].id);

  const secondary = await service.createWorkspace(project.id, {
    sourceWorkspaceId: workspaces[0].id,
    expectedHead: workspaces[0].head,
    title: "workspace routing",
  });
  assert.equal(secondary.isMain, false);
  assert.equal(secondary.branch.startsWith("pi/"), true);

  const second = await service.createConversation(project.id, {
    workspaceId: secondary.id,
  });
  const remembered = await service.createConversation(project.id);
  assert.equal(second.workspace.id, secondary.id);
  assert.equal(remembered.workspace.id, secondary.id);

  workspaces = await service.listWorkspaces(project.id);
  assert.equal(
    workspaces.find((workspace) => workspace.id === secondary.id)
      ?.conversationCount,
    2,
  );
  await assert.rejects(
    service.removeWorkspace(project.id, secondary.id, {
      expectedHead: secondary.head,
    }),
    (error) => error?.code === "PROJECT_WORK_WORKSPACE_HAS_CONVERSATIONS",
  );

  await service.removeConversation(project.id, second.id);
  await service.removeConversation(project.id, remembered.id);
  const removed = await service.removeWorkspace(project.id, secondary.id, {
    expectedHead: secondary.head,
  });
  assert.equal(removed.removed, true);
  assert.equal((await service.listWorkspaces(project.id)).length, 1);
});

test("workspace-v2 non-Git projects stay bound to the selected original directory", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-workspace-folder-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "folder");
  await mkdir(projectRoot);
  await writeFile(path.join(projectRoot, "notes.txt"), "original\n", "utf8");
  const service = createProjectWorkService({
    storageRoot: path.join(temporaryRoot, "state"),
    sessionFactory: sessionFactory(),
    workspaceRuntimeMode: "workspace-v2",
    picker: async () => ({ rootPath: projectRoot }),
    idFactory: incrementalId(),
  });
  t.after(() => service.dispose());

  const selection = await service.pickProjectRoot({ mode: "existing" });
  const project = await service.registerProject({
    selectionId: selection.selectionId,
  });
  const conversation = await service.createConversation(project.id);
  const [workspace] = await service.listWorkspaces(project.id);
  assert.equal(workspace.isGit, false);
  assert.equal(workspace.kind, "project_root");
  assert.equal(workspace.id, conversation.workspace.id);
});

test("workspace-v2 direct writes require exact confirmation, settle stale review, and undo by hash", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-workspace-write-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  const original = "export const value = 1;\n";
  const updated = "export const value = 2;\n";
  const staleCandidate = "export const value = 3;\n";
  await mkdir(projectRoot);
  await writeFile(path.join(projectRoot, "app.js"), original, "utf8");
  const requests = [updated, staleCandidate];
  let toolCallSequence = 0;
  const agentFactory = interactiveSessionFactory(async ({ options }) => {
    const content = requests.shift();
    assert.ok(content, "unexpected direct write turn");
    toolCallSequence += 1;
    await options.onWorkspaceWrite({
      path: "app.js",
      content,
      operation: "update",
      baseExists: true,
      baseHash: contentHash(original),
      baseMode: 0o644,
      afterHash: contentHash(content),
      afterMode: 0o644,
      patch: `@@ -1 +1 @@\n-${original.trim()}\n+${content.trim()}`,
      toolCallId: `write-${toolCallSequence}`,
    });
  });
  const service = createProjectWorkService({
    storageRoot: path.join(temporaryRoot, "state"),
    sessionFactory: agentFactory,
    workspaceRuntimeMode: "workspace-v2",
    picker: async () => ({ rootPath: projectRoot }),
    idFactory: incrementalId(),
  });
  t.after(() => service.dispose());
  const project = await registerProject(service);
  const conversation = await service.createConversation(project.id);

  const firstRequested = waitForEvent(
    service,
    conversation.id,
    (event) => event.type === "workspace_write.requested",
  );
  await service.sendMessage(conversation.id, { text: "把 value 更新为 2" });
  const firstRequestEvent = await firstRequested;
  const pendingSnapshot = await Promise.race([
    service.getConversation(conversation.id),
    delay(500).then(() => assert.fail(
      "pending Workspace write blocked refresh recovery",
    )),
  ]);
  assert.equal(pendingSnapshot.conversation.status, "awaiting_confirmation");
  assert.equal(await readFile(path.join(projectRoot, "app.js"), "utf8"), original);
  await service.confirmWorkspaceWrite(conversation.id, firstRequestEvent.data.id);
  const written = await eventually(
    () => service.getConversation(conversation.id),
    (snapshot) => (
      snapshot.conversation.workspaceWrites.at(-1)?.status === "written"
      && ["applied", "idle"].includes(snapshot.conversation.status)
    ),
    "confirmed Workspace write did not settle",
  );
  assert.equal(await readFile(path.join(projectRoot, "app.js"), "utf8"), updated);
  const confirmedWrite = written.conversation.workspaceWrites.at(-1);
  assert.equal(confirmedWrite.undo.status, "available");
  await assert.rejects(
    service.undoApply(conversation.id, confirmedWrite.id, {
      undoHash: contentHash("wrong undo binding"),
    }),
    (error) => error?.code === "PROJECT_WORK_UNDO_BINDING_MISMATCH",
  );
  assert.equal(await readFile(path.join(projectRoot, "app.js"), "utf8"), updated);
  await service.undoApply(conversation.id, confirmedWrite.id, {
    undoHash: confirmedWrite.undo.hash,
  });
  assert.equal(await readFile(path.join(projectRoot, "app.js"), "utf8"), original);

  const secondRequested = waitForEvent(
    service,
    conversation.id,
    (event) => event.type === "workspace_write.requested",
  );
  await service.sendMessage(conversation.id, { text: "把 value 更新为 3" });
  const secondRequestEvent = await secondRequested;
  const external = "export const value = 99;\n";
  await writeFile(path.join(projectRoot, "app.js"), external, "utf8");
  await assert.rejects(
    service.confirmWorkspaceWrite(conversation.id, secondRequestEvent.data.id),
    (error) => error?.code === "PROJECT_WORKSPACE_WRITE_STALE",
  );
  const stale = await eventually(
    () => service.getConversation(conversation.id),
    (snapshot) => (
      snapshot.conversation.workspaceWrites.at(-1)?.status === "stale"
      && snapshot.conversation.status !== "awaiting_confirmation"
    ),
    "stale direct write left an empty awaiting-confirmation state",
  );
  assert.equal(
    stale.conversation.workspaceWrites.at(-1).error?.code,
    "PROJECT_WORKSPACE_WRITE_STALE",
  );
  assert.equal(await readFile(path.join(projectRoot, "app.js"), "utf8"), external);
});

test("workspace-v2 exact commands run in place without fake verification interruption", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-workspace-command-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(projectRoot, "marker.txt"), "real workspace\n", "utf8");
  await writeFile(
    path.join(projectRoot, "verify-workspace.mjs"),
    [
      "import assert from 'node:assert/strict';",
      "import { readFile } from 'node:fs/promises';",
      "assert.equal(await readFile('marker.txt', 'utf8'), 'real workspace\\n');",
      "console.log('selected Workspace cwd confirmed');",
      "",
    ].join("\n"),
    "utf8",
  );
  const agentFactory = interactiveSessionFactory(async ({ options }) => {
    await options.onWorkspaceCommandRequest({
      executable: "node",
      argv: ["verify-workspace.mjs"],
      cwd: ".",
      purpose: "验证真实 Workspace cwd",
    });
  });
  const service = createProjectWorkService({
    storageRoot: path.join(temporaryRoot, "state"),
    sessionFactory: agentFactory,
    workspaceRuntimeMode: "workspace-v2",
    picker: async () => ({ rootPath: projectRoot }),
    idFactory: incrementalId(),
  });
  t.after(() => service.dispose());
  const project = await registerProject(service);
  const conversation = await service.createConversation(project.id);
  await service.sendMessage(conversation.id, { text: "运行精确 Workspace 检查" });
  const requested = await eventually(
    () => service.getConversation(conversation.id),
    (snapshot) => snapshot.conversation.workspaceRuns.at(-1)?.status === "requested",
    "custom Workspace command did not wait for exact confirmation",
  );
  const command = requested.conversation.workspaceRuns.at(-1);
  const runCompletedEvent = waitForEvent(
    service,
    conversation.id,
    (event) => (
      event.type === "workspace_run.completed"
      && event.data.id === command.id
    ),
  );
  const runStatusEvent = waitForEvent(
    service,
    conversation.id,
    (event) => event.type === "agent.status" && event.data.status === "idle",
  );
  const confirmation = await service.confirmWorkspaceRun(
    conversation.id,
    command.id,
    { requestHash: command.requestHash },
  );
  assert.notEqual(confirmation.conversation.workspaceRuns.at(-1).status, "interrupted");
  assert.equal(
    confirmation.events.some((event) => event.type === "verification.interrupted"),
    false,
  );
  const completed = await eventually(
    () => service.getConversation(conversation.id),
    (snapshot) => snapshot.conversation.workspaceRuns.at(-1)?.status === "succeeded",
    "confirmed Workspace command did not finish",
  );
  assert.equal(completed.conversation.workspaceRuns.at(-1).exitCode, 0);
  assert.match(completed.conversation.workspaceRuns.at(-1).output, /selected Workspace cwd confirmed/);
  assert.deepEqual(completed.conversation.verifications, []);
  assert.equal(
    completed.events.some((event) => event.type === "verification.interrupted"),
    false,
  );
  await Promise.all([runCompletedEvent, runStatusEvent]);
  await delay(0);
});

for (const persistedState of ["queued", "running"]) {
  test(`workspace-v2 service recovery marks ${persistedState} commands interrupted without rerun`, async (t) => {
    const temporaryRoot = await mkdtemp(path.join(
      os.tmpdir(),
      `pi-workspace-${persistedState}-recovery-`,
    ));
    t.after(() => rm(temporaryRoot, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 20,
    }));
    const projectRoot = path.join(temporaryRoot, "project");
    const storageRoot = path.join(temporaryRoot, "state");
    await mkdir(projectRoot);
    await writeFile(path.join(projectRoot, "check.test.js"), "", "utf8");
    const agentFactory = interactiveSessionFactory(async ({ options }) => {
      await options.onWorkspaceCommandRequest({
        executable: "node",
        argv: ["--test", "check.test.js"],
        cwd: ".",
        purpose: "恢复边界检查",
      });
    });
    const supervisor = controlledRunSupervisor({
      holdStart: persistedState === "queued",
    });
    const firstService = createProjectWorkService({
      storageRoot,
      sessionFactory: agentFactory,
      workspaceRuntimeMode: "workspace-v2",
      picker: async () => ({ rootPath: projectRoot }),
      runSupervisor: supervisor,
      idFactory: incrementalId(),
    });
    t.after(() => firstService.dispose());
    const project = await registerProject(firstService);
    const conversation = await firstService.createConversation(project.id);
    await firstService.sendMessage(conversation.id, { text: "准备恢复边界命令" });
    const requested = await eventually(
      () => firstService.getConversation(conversation.id),
      (snapshot) => snapshot.conversation.workspaceRuns.at(-1)?.status === "requested",
      "restart fixture did not prepare a Workspace command",
    );
    const command = requested.conversation.workspaceRuns.at(-1);
    const confirmed = await firstService.confirmWorkspaceRun(
      conversation.id,
      command.id,
      { requestHash: command.requestHash },
    );
    assert.notEqual(confirmed.conversation.workspaceRuns.at(-1).status, "interrupted");
    const active = await eventually(
      () => firstService.getConversation(conversation.id),
      (snapshot) => (
        supervisor.starts.length === 1
        && snapshot.conversation.workspaceRuns.at(-1)?.status === persistedState
      ),
      `Workspace command did not persist as ${persistedState}`,
    );
    assert.equal(
      active.events.some((event) => event.type === "verification.interrupted"),
      false,
    );

    const restoredService = createProjectWorkService({
      storageRoot,
      sessionFactory: sessionFactory(),
      workspaceRuntimeMode: "workspace-v2",
      picker: async () => ({ rootPath: projectRoot }),
      runSupervisor: controlledRunSupervisor(),
      idFactory: incrementalId(),
    });
    t.after(() => restoredService.dispose());
    const restored = await restoredService.getConversation(conversation.id);
    assert.equal(restored.conversation.workspaceRuns.at(-1).status, "interrupted");
    assert.equal(restored.conversation.status, "interrupted");
    assert.equal(
      restored.conversation.workspaceRuns.at(-1).error?.code,
      "PROJECT_WORKSPACE_RUN_INTERRUPTED",
    );
    assert.equal(
      restored.events.some((event) => event.type === "verification.interrupted"),
      false,
    );
    assert.equal(
      restored.events.some((event) => (
        event.type === "workspace_run.completed"
        && event.data.status === "interrupted"
        && event.data.errorCode === "PROJECT_WORKSPACE_RUN_INTERRUPTED"
      )),
      true,
    );

    const originalRunCompleted = waitForEvent(
      firstService,
      conversation.id,
      (event) => (
        event.type === "workspace_run.completed"
        && event.data.id === command.id
        && event.data.status === "succeeded"
      ),
    );
    const originalStatusSettled = waitForEvent(
      firstService,
      conversation.id,
      (event) => event.type === "agent.status" && event.data.status === "idle",
    );
    if (persistedState === "queued") {
      supervisor.releaseStart();
      await eventually(
        async () => supervisor.runs.length,
        (count) => count === 1,
        "queued supervisor did not leave its test gate",
      );
    }
    supervisor.complete(0);
    await Promise.all([originalRunCompleted, originalStatusSettled]);
    await delay(0);
  });
}

test("workspace-v2 recipe verification shares the Workspace lease and rejects stale applied files", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-workspace-lease-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  const storageRoot = path.join(temporaryRoot, "state");
  const appBefore = "export const version = 1;\n";
  const appAfter = "export const version = 2;\n";
  const notesBefore = "before\n";
  const notesAfter = "after\n";
  await mkdir(projectRoot);
  await Promise.all([
    writeFile(path.join(projectRoot, "app.js"), appBefore, "utf8"),
    writeFile(path.join(projectRoot, "notes.txt"), notesBefore, "utf8"),
    writeFile(
      path.join(projectRoot, "package.json"),
      `${JSON.stringify({ scripts: { test: "node --test" } }, null, 2)}\n`,
      "utf8",
    ),
  ]);
  const writeRequest = ({ filePath, before, after, toolCallId }) => ({
    path: filePath,
    content: after,
    operation: "update",
    baseExists: true,
    baseHash: contentHash(before),
    baseMode: 0o644,
    afterHash: contentHash(after),
    afterMode: 0o644,
    patch: `@@ -1 +1 @@\n-${before.trim()}\n+${after.trim()}`,
    toolCallId,
  });
  const agentFactory = interactiveSessionFactory(async ({ options, prompt }) => {
    if (prompt.includes("主会话修改")) {
      await options.onVerificationRequest({
        recipeId: "node.test",
        checks: ["项目测试应通过"],
      });
      await options.onWorkspaceWrite(writeRequest({
        filePath: "app.js",
        before: appBefore,
        after: appAfter,
        toolCallId: "main-write",
      }));
      return;
    }
    if (prompt.includes("次会话修改")) {
      await options.onWorkspaceWrite(writeRequest({
        filePath: "notes.txt",
        before: notesBefore,
        after: notesAfter,
        toolCallId: "secondary-write",
      }));
      return;
    }
    if (prompt.includes("再次准备验证")) {
      await options.onVerificationRequest({
        recipeId: "node.test",
        checks: ["再次验证 Workspace"],
      });
      return;
    }
    assert.fail("unexpected lease-test prompt");
  });
  const supervisor = controlledRunSupervisor();
  const service = createProjectWorkService({
    storageRoot,
    sessionFactory: agentFactory,
    workspaceRuntimeMode: "workspace-v2",
    picker: async () => ({ rootPath: projectRoot }),
    runSupervisor: supervisor,
    verificationOutputCompactor: async ({ output }) => ({
      output,
      applied: false,
      rawBytes: Buffer.byteLength(output, "utf8"),
      compactBytes: Buffer.byteLength(output, "utf8"),
      ratio: 1,
      command: [],
      version: null,
      reason: "test",
    }),
    idFactory: incrementalId(),
  });
  t.after(() => service.dispose());
  const project = await registerProject(service);
  const mainConversation = await service.createConversation(project.id);
  const secondaryConversation = await service.createConversation(project.id);

  const mainWriteRequested = waitForEvent(
    service,
    mainConversation.id,
    (event) => event.type === "workspace_write.requested",
  );
  await service.sendMessage(mainConversation.id, { text: "主会话修改并准备验证" });
  const mainWriteEvent = await mainWriteRequested;
  await service.confirmWorkspaceWrite(
    mainConversation.id,
    mainWriteEvent.data.id,
  );
  const mainReady = await eventually(
    () => service.getConversation(mainConversation.id),
    (snapshot) => (
      snapshot.conversation.activeChangeSet?.workspaceDirect === true
      && snapshot.conversation.activeChangeSet?.status === "applied"
      && snapshot.conversation.verifications.some((item) => item.status === "requested")
    ),
    "main Workspace write did not become verification evidence",
  );
  const firstVerification = mainReady.conversation.verifications.find(
    (item) => item.status === "requested",
  );

  const secondaryWriteRequested = waitForEvent(
    service,
    secondaryConversation.id,
    (event) => event.type === "workspace_write.requested",
  );
  await service.sendMessage(secondaryConversation.id, { text: "次会话修改" });
  const secondaryWriteEvent = await secondaryWriteRequested;

  const verifying = service.runVerification(mainConversation.id, {
    requestId: firstVerification.id,
  });
  await eventually(
    () => service.getConversation(mainConversation.id),
    (snapshot) => (
      supervisor.starts.length === 1
      && snapshot.conversation.verifications.at(-1)?.status === "running"
    ),
    "recipe verification did not start in the Workspace",
  );
  assert.equal(supervisor.starts[0].workspaceRoot, await realpath(projectRoot));
  let secondaryWriteSettled = false;
  const secondaryConfirmation = service.confirmWorkspaceWrite(
    secondaryConversation.id,
    secondaryWriteEvent.data.id,
  ).then((value) => {
    secondaryWriteSettled = true;
    return value;
  });
  await delay(30);
  assert.equal(
    secondaryWriteSettled,
    false,
    "Workspace write escaped the verification lease",
  );
  supervisor.complete(0);
  assert.equal((await verifying).status, "passed");
  await secondaryConfirmation;
  assert.equal(await readFile(path.join(projectRoot, "notes.txt"), "utf8"), notesAfter);

  await service.sendMessage(mainConversation.id, { text: "再次准备验证" });
  const secondReady = await eventually(
    () => service.getConversation(mainConversation.id),
    (snapshot) => {
      const attempted = new Set(snapshot.conversation.verifications
        .map((item) => item.commandId)
        .filter(Boolean));
      return snapshot.conversation.verifications.filter(
        (item) => item.status === "requested" && !attempted.has(item.id),
      ).length === 1;
    },
    "second recipe verification request was not prepared",
  );
  const attempted = new Set(secondReady.conversation.verifications
    .map((item) => item.commandId)
    .filter(Boolean));
  const secondVerification = secondReady.conversation.verifications.find(
    (item) => item.status === "requested" && !attempted.has(item.id),
  );
  const external = "export const version = 99;\n";
  await writeFile(path.join(projectRoot, "app.js"), external, "utf8");
  let staleError = null;
  for (let attempt = 0; attempt < 100 && !staleError; attempt += 1) {
    try {
      await service.runVerification(mainConversation.id, {
        requestId: secondVerification.id,
      });
      assert.fail("stale applied Workspace file unexpectedly started verification");
    } catch (error) {
      if (error?.code === "PROJECT_WORK_VERIFICATION_BUSY") {
        await delay(5);
      } else {
        staleError = error;
      }
    }
  }
  assert.equal(staleError?.code, "PROJECT_WORK_CHANGE_STALE");
  assert.equal(supervisor.starts.length, 1);
  assert.equal(await readFile(path.join(projectRoot, "app.js"), "utf8"), external);
});
