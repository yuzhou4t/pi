import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createProjectWorkService } from "./projectWorkService.js";

function incrementalId(prefix = "test") {
  let sequence = 0;
  return () => `${prefix}-${++sequence}`;
}

function modelCatalog() {
  return {
    defaultProviderId: "deepseek",
    defaultModelId: "deepseek-v4-flash",
    providers: [{
      id: "deepseek",
      label: "DeepSeek",
      models: [{
        id: "deepseek-v4-flash",
        label: "DeepSeek V4 Flash",
      }],
    }],
  };
}

function createFakeSessionFactory({
  changedContent = "export const version = 2;\n",
  additionalChanges = [],
} = {}) {
  const sessions = [];
  const factory = async (options) => {
    let subscriber = null;
    const record = {
      options,
      prompts: [],
      aborts: 0,
    };
    const host = {
      subscribe(listener) {
        subscriber = listener;
        return () => {
          subscriber = null;
        };
      },
      async prompt(prompt) {
        record.prompts.push(prompt);
        await options.onPlan({
          explanation: "先检查，再修改，最后验证。",
          steps: [
            { id: "inspect", text: "检查文件", status: "completed" },
            { id: "change", text: "准备修改", status: "completed" },
            { id: "verify", text: "等待验证", status: "pending" },
          ],
        });
        const baseFile = path.join(options.baseRoot, "app.js");
        try {
          await access(baseFile);
        } catch {
          await writeFile(
            baseFile,
            await readFile(path.join(options.projectRoot, "app.js")),
          );
        }
        await writeFile(path.join(options.workspaceRoot, "app.js"), changedContent, "utf8");
        for (const change of additionalChanges) {
          const basePath = path.join(options.baseRoot, change.path);
          try {
            await access(basePath);
          } catch {
            await writeFile(
              basePath,
              await readFile(path.join(options.projectRoot, change.path)),
            );
          }
          await writeFile(
            path.join(options.workspaceRoot, change.path),
            change.content,
            "utf8",
          );
        }
        await options.onVerificationRequest({
          file: "node",
          args: ["--test"],
          checks: ["项目测试应通过"],
        });
        subscriber?.({ type: "agent_settled" });
      },
      async steer() {},
      async abort() {
        record.aborts += 1;
      },
      async compact() {},
      async setModel() {},
      dispose() {},
    };
    record.host = host;
    sessions.push(record);
    return host;
  };
  factory.listModels = async () => modelCatalog();
  factory.dispose = async () => {};
  factory.sessions = sessions;
  return factory;
}

function createBlockingSessionFactory() {
  const sessions = [];
  const factory = async () => {
    let releasePrompt;
    const record = {
      aborts: 0,
      release() {
        releasePrompt?.();
      },
    };
    const host = {
      subscribe() {
        return () => {};
      },
      prompt() {
        return new Promise((resolve) => {
          releasePrompt = resolve;
        });
      },
      async steer() {},
      async abort() {
        record.aborts += 1;
        record.release();
      },
      async compact() {},
      async setModel() {},
      dispose() {},
    };
    sessions.push(record);
    return host;
  };
  factory.listModels = async () => modelCatalog();
  factory.dispose = async () => {};
  factory.sessions = sessions;
  return factory;
}

async function eventually(read, predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await read();
    if (predicate(value)) return value;
    await delay(10);
  }
  assert.fail(message);
}

test("create-mode picking accepts no name and public project data never leaks its path", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-project-create-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const parentRoot = path.join(temporaryRoot, "selected-parent");
  await mkdir(parentRoot);
  const service = createProjectWorkService({
    storageRoot: path.join(temporaryRoot, "private-state"),
    sessionFactory: createFakeSessionFactory(),
    picker: async ({ mode, name }) => {
      assert.equal(mode, "create");
      assert.equal(name, undefined);
      return { parentPath: parentRoot };
    },
    idFactory: incrementalId("create"),
  });
  t.after(() => service.dispose());

  const selection = await service.pickProjectRoot({ mode: "create" });
  assert.equal(selection.mode, "create");
  assert.equal(Object.hasOwn(selection, "parentPath"), false);
  assert.equal(JSON.stringify(selection).includes(parentRoot), false);

  const project = await service.registerProject({
    selectionId: selection.selectionId,
    name: "Fresh Project",
  });

  assert.equal(project.name, "Fresh Project");
  assert.equal(project.rootLabel, "Fresh Project");
  assert.equal(Object.hasOwn(project, "rootPath"), false);
  assert.equal(JSON.stringify(project).includes(parentRoot), false);
  assert.equal(await readFile(
    path.join(temporaryRoot, "private-state", "projects.json"),
    "utf8",
  ).then((value) => value.includes(parentRoot)), true);
});

test("creating empty conversations performs no project snapshot or copy", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-project-empty-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  const storageRoot = path.join(temporaryRoot, "private-state");
  await mkdir(projectRoot);
  await writeFile(path.join(projectRoot, "app.js"), "export const ready = true;\n");
  let snapshotCalls = 0;
  const service = createProjectWorkService({
    storageRoot,
    sessionFactory: createFakeSessionFactory(),
    snapshotter: async () => {
      snapshotCalls += 1;
      throw new Error("empty conversations must not create a snapshot");
    },
    picker: async () => ({ rootPath: projectRoot }),
    idFactory: incrementalId("empty"),
  });
  t.after(() => service.dispose());

  const selection = await service.pickProjectRoot({ mode: "existing" });
  const project = await service.registerProject({
    selectionId: selection.selectionId,
  });
  const conversations = await Promise.all([
    service.createConversation(project.id),
    service.createConversation(project.id),
  ]);

  assert.equal(snapshotCalls, 0);
  for (const conversation of conversations) {
    const directory = path.join(storageRoot, "conversations", conversation.id);
    assert.deepEqual(await readdir(path.join(directory, "base")), []);
    assert.deepEqual(await readdir(path.join(directory, "workspace")), []);
    const current = await service.getConversation(conversation.id);
    assert.equal(current.conversation.workspaceSnapshot.mode, "sparse_overlay");
    assert.equal(current.conversation.workspaceSnapshot.includedFiles, 0);
  }
});

test("conversation file reads prefer overlay content and can open overlay-only files", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-conversation-file-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "private-project");
  const storageRoot = path.join(temporaryRoot, "private-state");
  await mkdir(projectRoot);
  await writeFile(path.join(projectRoot, "app.js"), "export const source = 'live';\n");
  const service = createProjectWorkService({
    storageRoot,
    sessionFactory: createFakeSessionFactory(),
    picker: async () => ({ rootPath: projectRoot }),
    idFactory: incrementalId("conversation-file"),
  });
  t.after(() => service.dispose());

  const selection = await service.pickProjectRoot({ mode: "existing" });
  const project = await service.registerProject({
    selectionId: selection.selectionId,
  });
  const conversation = await service.createConversation(project.id);
  const overlayRoot = path.join(
    storageRoot,
    "conversations",
    conversation.id,
    "workspace",
  );
  await mkdir(path.join(overlayRoot, "src"));
  await writeFile(path.join(overlayRoot, "app.js"), "export const source = 'overlay';\n");
  await writeFile(
    path.join(overlayRoot, "src", "generated.js"),
    "export const generated = true;\n",
  );

  const modified = await service.readConversationFile(conversation.id, {
    filePath: "app.js",
  });
  const created = await service.readConversationFile(conversation.id, {
    filePath: "src/generated.js",
  });
  const live = await service.readProjectFile(project.id, {
    filePath: "app.js",
  });

  assert.match(modified.content, /source = 'overlay'/);
  assert.match(created.content, /generated = true/);
  assert.notEqual(modified.hash, live.hash);
  assert.equal(JSON.stringify({ modified, created }).includes(projectRoot), false);
  assert.equal(JSON.stringify({ modified, created }).includes(storageRoot), false);
});

test("a replaced bound root is rejected before a live-overlay conversation starts", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-project-replaced-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  const movedRoot = path.join(temporaryRoot, "project-original");
  await mkdir(projectRoot);
  const service = createProjectWorkService({
    storageRoot: path.join(temporaryRoot, "private-state"),
    sessionFactory: createFakeSessionFactory(),
    picker: async () => ({ rootPath: projectRoot }),
    idFactory: incrementalId("replaced"),
  });
  t.after(() => service.dispose());

  const selection = await service.pickProjectRoot({ mode: "existing" });
  const project = await service.registerProject({
    selectionId: selection.selectionId,
  });
  await rename(projectRoot, movedRoot);
  await mkdir(projectRoot);

  await assert.rejects(
    service.createConversation(project.id),
    (error) => {
      assert.equal(error.code, "PROJECT_WORK_ROOT_CHANGED");
      assert.equal(error.status, 409);
      return true;
    },
  );
});

test("empty review overlays still filter unsafe project paths", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-project-venv-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "private-project-root");
  const storageRoot = path.join(temporaryRoot, "private-state");
  const virtualEnvironment = path.join(
    projectRoot,
    "benchmark-baselines",
    "DeepScientist",
    ".venv",
    "lib",
  );
  const assetDirectory = path.join(
    projectRoot,
    "benchmark-baselines",
    "DeepScientist",
    "assets",
    "readme",
  );
  await mkdir(virtualEnvironment, { recursive: true });
  await mkdir(assetDirectory, { recursive: true });
  await writeFile(path.join(projectRoot, "app.py"), "print('ready')\n", "utf8");
  await writeFile(
    path.join(virtualEnvironment, "_rust.abi3.so"),
    Buffer.alloc((4 * 1024 * 1024) + 1),
  );
  await writeFile(
    path.join(assetDirectory, "paper-output-1.png"),
    Buffer.alloc((4 * 1024 * 1024) + 1),
  );

  const service = createProjectWorkService({
    storageRoot,
    sessionFactory: createFakeSessionFactory(),
    picker: async () => ({ rootPath: projectRoot }),
    idFactory: incrementalId("venv"),
  });
  t.after(() => service.dispose());

  const selection = await service.pickProjectRoot({ mode: "existing" });
  const project = await service.registerProject({
    selectionId: selection.selectionId,
  });
  const conversation = await service.createConversation(project.id);
  const tree = await service.getProjectTree(project.id, { depth: 5 });
  const snapshot = await service.getConversation(conversation.id);

  assert.equal(conversation.status, "idle");
  assert.equal(snapshot.conversation.workspaceSnapshot.truncated, false);
  assert.equal(snapshot.conversation.workspaceSnapshot.includedFiles, 0);
  assert.equal(snapshot.conversation.workspaceSnapshot.mode, "sparse_overlay");
  assert.equal(JSON.stringify(tree).includes(".venv"), false);
});

test("verification never runs from a truncated or skipped project materialization", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-verification-incomplete-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  const storageRoot = path.join(temporaryRoot, "private-state");
  await mkdir(projectRoot);
  const source = "export const version = 1;\n";
  await writeFile(path.join(projectRoot, "app.js"), source);
  const reports = [
    {
      files: 1,
      bytes: source.length,
      truncated: true,
      skippedBinaryFiles: 0,
      skippedOversizedFiles: 0,
    },
    {
      files: 1,
      bytes: source.length,
      truncated: false,
      skippedBinaryFiles: 1,
      skippedOversizedFiles: 0,
    },
    {
      files: 1,
      bytes: source.length,
      truncated: false,
      skippedBinaryFiles: 0,
      skippedOversizedFiles: 1,
    },
  ];
  let runnerCalls = 0;
  const service = createProjectWorkService({
    storageRoot,
    sessionFactory: createFakeSessionFactory({ changedContent: source }),
    snapshotter: async ({ baseRoot, workspaceRoot }) => {
      await Promise.all([
        mkdir(baseRoot, { recursive: true }),
        mkdir(workspaceRoot, { recursive: true }),
      ]);
      return reports.shift();
    },
    picker: async () => ({ rootPath: projectRoot }),
    runner: async () => {
      runnerCalls += 1;
      return {
        exitCode: 0,
        durationMs: 1,
        stdout: "must not run",
        stderr: "",
        truncated: false,
        timedOut: false,
        aborted: false,
      };
    },
    idFactory: incrementalId("incomplete"),
  });
  t.after(() => service.dispose());

  const selection = await service.pickProjectRoot({ mode: "existing" });
  const project = await service.registerProject({
    selectionId: selection.selectionId,
  });
  const conversation = await service.createConversation(project.id);
  await service.sendMessage(conversation.id, {
    text: "Prepare a verification request without changing the file.",
  });
  const settled = await eventually(
    () => service.getConversation(conversation.id),
    (snapshot) => (
      snapshot.conversation.status === "idle"
      && snapshot.conversation.verifications.some((item) => item.status === "requested")
    ),
    "verification request was not prepared",
  );
  const request = settled.conversation.verifications.find(
    (item) => item.status === "requested",
  );

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const completed = await service.runVerification(conversation.id, {
      requestId: request.id,
    });
    assert.equal(completed.status, "failed");
    assert.equal(completed.exitCode, null);
    assert.match(completed.output, /无法完整物化项目，未运行验证/);
  }
  assert.equal(runnerCalls, 0);
  assert.equal(reports.length, 0);
});

test("real project-work chain binds context and changes, applies by hash, and preserves verification attempts", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-project-chain-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "private-project-root");
  const storageRoot = path.join(temporaryRoot, "private-state");
  await mkdir(projectRoot);
  await writeFile(
    path.join(projectRoot, "app.js"),
    "export const version = 1;\n",
    "utf8",
  );

  const sessionFactory = createFakeSessionFactory();
  const runnerCalls = [];
  let verificationAttempt = 0;
  const service = createProjectWorkService({
    storageRoot,
    sessionFactory,
    picker: async ({ mode }) => {
      assert.equal(mode, "existing");
      return { rootPath: projectRoot };
    },
    runner: async (request) => {
      runnerCalls.push(request);
      verificationAttempt += 1;
      return verificationAttempt === 1
        ? {
            exitCode: 0,
            durationMs: 12,
            stdout: `passed in ${request.cwd}`,
            stderr: "",
            truncated: false,
            timedOut: false,
            aborted: false,
          }
        : {
            exitCode: 1,
            durationMs: 7,
            stdout: "",
            stderr: "one assertion failed",
            truncated: false,
            timedOut: false,
            aborted: false,
          };
    },
    idFactory: incrementalId("chain"),
  });
  t.after(() => service.dispose());

  const selection = await service.pickProjectRoot({ mode: "existing" });
  const project = await service.registerProject({
    selectionId: selection.selectionId,
    name: "Bound project",
  });
  const conversation = await service.createConversation(project.id, {
    title: "Make a safe change",
  });

  for (const value of [selection, project, conversation]) {
    assert.equal(JSON.stringify(value).includes(projectRoot), false);
    assert.equal(JSON.stringify(value).includes(storageRoot), false);
  }

  const file = await service.readProjectFile(project.id, {
    filePath: "app.js",
  });
  await assert.rejects(
    service.sendMessage(conversation.id, {
      text: "Use the attached file.",
      context: [{
        path: "app.js",
        startLine: 1,
        endLine: 1,
        contentHash: `${file.hash}-stale`,
      }],
    }),
    (error) => {
      assert.equal(error.code, "PROJECT_WORK_CONTEXT_STALE");
      assert.equal(error.status, 409);
      assert.equal(error.retryable, true);
      return true;
    },
  );
  assert.equal(sessionFactory.sessions[0].prompts.length, 0);

  await writeFile(path.join(projectRoot, "created-after-snapshot.js"), "late\n");
  const liveContextFile = await service.readProjectFile(project.id, {
    filePath: "created-after-snapshot.js",
  });
  await service.sendMessage(conversation.id, {
    text: "Update the implementation and prepare its verification.",
    context: [{
      path: "created-after-snapshot.js",
      startLine: 1,
      endLine: 1,
      contentHash: liveContextFile.hash,
    }],
  });
  assert.match(sessionFactory.sessions[0].prompts[0], /created-after-snapshot\.js/);
  assert.match(sessionFactory.sessions[0].prompts[0], /late/);
  assert.equal(
    sessionFactory.sessions[0].options.workspaceSnapshot.truncated,
    false,
  );
  assert.equal(
    sessionFactory.sessions[0].options.workspaceSnapshot.mode,
    "sparse_overlay",
  );
  const settled = await eventually(
    () => service.getConversation(conversation.id),
    (snapshot) => snapshot.conversation.status === "awaiting_confirmation",
    "agent_settled did not produce a reviewable change set",
  );

  assert.equal(settled.conversation.plan.steps.length, 3);
  assert.equal(settled.conversation.activeChangeSet.status, "ready");
  assert.equal(settled.conversation.activeChangeSet.files.length, 1);
  assert.equal(settled.conversation.pendingChangeFileCount, 1);
  const listedWhilePending = await service.listConversations(project.id);
  assert.equal(listedWhilePending[0].pendingChangeFileCount, 1);
  const renamedWhilePending = await service.renameConversation(
    project.id,
    conversation.id,
    { title: "Review the safe change" },
  );
  assert.equal(renamedWhilePending.pendingChangeFileCount, 1);
  const changeReady = settled.events.find(
    (event) => event.type === "change_set.ready",
  );
  const awaitingConfirmation = settled.events.find(
    (event) => (
      event.type === "agent.status"
      && event.data.status === "awaiting_confirmation"
    ),
  );
  assert.ok(changeReady);
  assert.ok(awaitingConfirmation);
  assert.ok(changeReady.seq < awaitingConfirmation.seq);

  const changeSet = settled.conversation.activeChangeSet;
  const changedFile = changeSet.files[0];
  const bindings = [{
    fileId: changedFile.id,
    baseHash: changedFile.baseHash,
    afterHash: changedFile.afterHash,
  }];
  await assert.rejects(
    service.applyChangeSet(conversation.id, {
      changeSetId: changeSet.id,
      changeSetHash: "sha256:wrong",
      files: bindings,
    }),
    (error) => {
      assert.equal(error.code, "PROJECT_WORK_CHANGE_BINDING_MISMATCH");
      return true;
    },
  );
  assert.equal(
    await readFile(path.join(projectRoot, "app.js"), "utf8"),
    "export const version = 1;\n",
  );

  const applied = await service.applyChangeSet(conversation.id, {
    changeSetId: changeSet.id,
    changeSetHash: changeSet.hash,
    files: bindings,
  });
  assert.equal(applied.appliedChangeSet.status, "applied");
  assert.equal(applied.remainingChangeSet.status, "clean");
  assert.equal(
    (await service.listConversations(project.id))[0].pendingChangeFileCount,
    0,
  );
  assert.equal(
    await readFile(path.join(projectRoot, "app.js"), "utf8"),
    "export const version = 2;\n",
  );
  const privateConversationRoot = path.join(
    storageRoot,
    "conversations",
    conversation.id,
  );
  await assert.rejects(access(path.join(privateConversationRoot, "base", "app.js")));
  await assert.rejects(access(path.join(privateConversationRoot, "workspace", "app.js")));

  const requestedVerification = settled.conversation.verifications.find(
    (item) => item.status === "requested",
  );
  assert.ok(requestedVerification);
  const passed = await service.runVerification(conversation.id, {
    requestId: requestedVerification.id,
  });
  const failed = await service.runVerification(conversation.id, {
    requestId: requestedVerification.id,
  });

  assert.equal(passed.status, "passed");
  assert.equal(passed.exitCode, 0);
  assert.equal(passed.output.includes(storageRoot), false);
  assert.match(passed.output, /<workspace>/);
  assert.equal(failed.status, "failed");
  assert.equal(failed.exitCode, 1);
  assert.equal(runnerCalls.length, 2);
  const canonicalStorageRoot = await realpath(storageRoot);
  assert.equal(
    runnerCalls.every((call) => {
      const relative = path.relative(canonicalStorageRoot, call.cwd);
      return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
    }),
    true,
  );
  assert.equal(runnerCalls.every((call) => call.cwd !== projectRoot), true);

  const history = await service.listVerifications(conversation.id);
  assert.deepEqual(
    history.map((item) => item.status),
    ["requested", "passed", "failed"],
  );
});

test("partial apply keeps unselected files reviewable and blocks verification", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-project-partial-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  await mkdir(projectRoot);
  await writeFile(path.join(projectRoot, "app.js"), "app v1\n", "utf8");
  await writeFile(path.join(projectRoot, "other.js"), "other v1\n", "utf8");

  const service = createProjectWorkService({
    storageRoot: path.join(temporaryRoot, "private-state"),
    sessionFactory: createFakeSessionFactory({
      changedContent: "app v2\n",
      additionalChanges: [{
        path: "other.js",
        content: "other v2\n",
      }],
    }),
    picker: async () => ({ rootPath: projectRoot }),
    idFactory: incrementalId("partial"),
  });
  t.after(() => service.dispose());

  const selection = await service.pickProjectRoot({ mode: "existing" });
  const project = await service.registerProject({ selectionId: selection.selectionId });
  const conversation = await service.createConversation(project.id);
  await service.sendMessage(conversation.id, { text: "修改两个文件" });
  const settled = await eventually(
    () => service.getConversation(conversation.id),
    (snapshot) => snapshot.conversation.status === "awaiting_confirmation",
    "two-file change set did not become reviewable",
  );
  const initial = settled.conversation.activeChangeSet;
  assert.equal(initial.files.length, 2);
  const appFile = initial.files.find((file) => file.path === "app.js");

  const partial = await service.applyChangeSet(conversation.id, {
    changeSetId: initial.id,
    changeSetHash: initial.hash,
    files: [{
      fileId: appFile.id,
      baseHash: appFile.baseHash,
      afterHash: appFile.afterHash,
    }],
  });
  assert.equal(partial.appliedChangeSet.status, "partially_applied");
  assert.equal(partial.remainingChangeSet.status, "ready");
  assert.deepEqual(
    partial.remainingChangeSet.files.map((file) => file.path),
    ["other.js"],
  );
  assert.equal(await readFile(path.join(projectRoot, "app.js"), "utf8"), "app v2\n");
  assert.equal(await readFile(path.join(projectRoot, "other.js"), "utf8"), "other v1\n");

  const afterPartial = await service.getConversation(conversation.id);
  assert.equal(afterPartial.conversation.status, "awaiting_confirmation");
  assert.equal(afterPartial.conversation.activeChangeSet.status, "ready");
  assert.deepEqual(
    afterPartial.conversation.activeChangeSet.files.map((file) => file.path),
    ["other.js"],
  );
  const verification = afterPartial.conversation.verifications.find(
    (item) => item.status === "requested",
  );
  await assert.rejects(
    service.runVerification(conversation.id, { requestId: verification.id }),
    (error) => {
      assert.equal(error.code, "PROJECT_WORK_CHANGES_NOT_APPLIED");
      return true;
    },
  );

  const remaining = afterPartial.conversation.activeChangeSet;
  const otherFile = remaining.files[0];
  const completed = await service.applyChangeSet(conversation.id, {
    changeSetId: remaining.id,
    changeSetHash: remaining.hash,
    files: [{
      fileId: otherFile.id,
      baseHash: otherFile.baseHash,
      afterHash: otherFile.afterHash,
    }],
  });
  assert.equal(completed.remainingChangeSet.status, "clean");
  assert.equal(await readFile(path.join(projectRoot, "other.js"), "utf8"), "other v2\n");
});

test("deleting conversations removes only their private state and updates project counts", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-conversation-delete-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const firstProjectRoot = path.join(temporaryRoot, "first-project");
  const secondProjectRoot = path.join(temporaryRoot, "second-project");
  const storageRoot = path.join(temporaryRoot, "private-state");
  await Promise.all([
    mkdir(firstProjectRoot),
    mkdir(secondProjectRoot),
  ]);
  await Promise.all([
    writeFile(path.join(firstProjectRoot, "app.js"), "first project\n", "utf8"),
    writeFile(path.join(secondProjectRoot, "app.js"), "second project\n", "utf8"),
  ]);
  const pickedRoots = [firstProjectRoot, secondProjectRoot];
  const service = createProjectWorkService({
    storageRoot,
    sessionFactory: createFakeSessionFactory(),
    picker: async () => ({ rootPath: pickedRoots.shift() }),
    idFactory: incrementalId("delete"),
  });
  t.after(() => service.dispose());

  const firstSelection = await service.pickProjectRoot({ mode: "existing" });
  const firstProject = await service.registerProject({
    selectionId: firstSelection.selectionId,
  });
  const secondSelection = await service.pickProjectRoot({ mode: "existing" });
  const secondProject = await service.registerProject({
    selectionId: secondSelection.selectionId,
  });
  const firstConversation = await service.createConversation(firstProject.id);
  const remainingConversation = await service.createConversation(firstProject.id);
  const otherProjectConversation = await service.createConversation(secondProject.id);
  const firstConversationDirectory = path.join(
    storageRoot,
    "conversations",
    firstConversation.id,
  );

  await assert.rejects(
    service.removeConversation(secondProject.id, firstConversation.id),
    (error) => {
      assert.equal(error.code, "PROJECT_WORK_CONVERSATION_NOT_FOUND");
      assert.equal(error.status, 404);
      return true;
    },
  );
  await assert.rejects(
    service.removeConversation(firstProject.id, "conversation-missing"),
    (error) => {
      assert.equal(error.code, "PROJECT_WORK_CONVERSATION_NOT_FOUND");
      assert.equal(error.status, 404);
      return true;
    },
  );
  await access(firstConversationDirectory);

  const firstRemoval = await service.removeConversation(
    firstProject.id,
    firstConversation.id,
  );
  assert.deepEqual(firstRemoval, {
    id: firstConversation.id,
    projectId: firstProject.id,
    removed: true,
    conversationCount: 1,
  });
  assert.equal(JSON.stringify(firstRemoval).includes(storageRoot), false);
  await assert.rejects(access(firstConversationDirectory), { code: "ENOENT" });
  assert.equal(
    (await service.getConversation(remainingConversation.id)).conversation.id,
    remainingConversation.id,
  );
  assert.equal(
    (await service.getConversation(otherProjectConversation.id)).conversation.id,
    otherProjectConversation.id,
  );
  let projects = await service.listProjects();
  assert.equal(
    projects.find((project) => project.id === firstProject.id).conversationCount,
    1,
  );
  assert.equal(
    projects.find((project) => project.id === secondProject.id).conversationCount,
    1,
  );

  const lastRemoval = await service.removeConversation(
    firstProject.id,
    remainingConversation.id,
  );
  assert.equal(lastRemoval.conversationCount, 0);
  assert.deepEqual(await service.listConversations(firstProject.id), []);
  projects = await service.listProjects();
  assert.equal(
    projects.find((project) => project.id === firstProject.id).conversationCount,
    0,
  );
  assert.equal(
    await readFile(path.join(firstProjectRoot, "app.js"), "utf8"),
    "first project\n",
  );
  assert.equal(
    (await service.getConversation(otherProjectConversation.id)).conversation.id,
    otherProjectConversation.id,
  );
});

test("renaming a conversation updates only safe scoped metadata", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-conversation-rename-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const firstProjectRoot = path.join(temporaryRoot, "first-project");
  const secondProjectRoot = path.join(temporaryRoot, "second-project");
  await Promise.all([
    mkdir(firstProjectRoot),
    mkdir(secondProjectRoot),
  ]);
  await writeFile(path.join(firstProjectRoot, "app.js"), "unchanged\n", "utf8");
  const pickedRoots = [firstProjectRoot, secondProjectRoot];
  const sessionFactory = createFakeSessionFactory();
  const service = createProjectWorkService({
    storageRoot: path.join(temporaryRoot, "private-state"),
    sessionFactory,
    picker: async () => ({ rootPath: pickedRoots.shift() }),
    idFactory: incrementalId("rename"),
  });
  t.after(() => service.dispose());

  const firstSelection = await service.pickProjectRoot({ mode: "existing" });
  const firstProject = await service.registerProject({
    selectionId: firstSelection.selectionId,
  });
  const secondSelection = await service.pickProjectRoot({ mode: "existing" });
  const secondProject = await service.registerProject({
    selectionId: secondSelection.selectionId,
  });
  const conversation = await service.createConversation(firstProject.id);

  await assert.rejects(
    service.renameConversation(secondProject.id, conversation.id, {
      title: "不应成功",
    }),
    (error) => {
      assert.equal(error.code, "PROJECT_WORK_CONVERSATION_NOT_FOUND");
      assert.equal(error.status, 404);
      return true;
    },
  );
  for (const title of ["   ", "x".repeat(81)]) {
    await assert.rejects(
      service.renameConversation(firstProject.id, conversation.id, { title }),
      (error) => {
        assert.equal(error.code, "PROJECT_WORK_CONVERSATION_TITLE_INVALID");
        assert.equal(error.status, 400);
        return true;
      },
    );
  }

  const renamed = await service.renameConversation(
    firstProject.id,
    conversation.id,
    { title: "  修复   登录流程  " },
  );
  assert.equal(renamed.title, "修复 登录流程");
  assert.equal(renamed.projectId, firstProject.id);
  assert.equal(Object.hasOwn(renamed, "messages"), false);
  assert.equal(Object.hasOwn(renamed, "rootPath"), false);
  assert.equal(
    (await service.getConversation(conversation.id)).conversation.title,
    "修复 登录流程",
  );
  assert.equal(sessionFactory.sessions.length, 0);
  assert.equal(
    await readFile(path.join(firstProjectRoot, "app.js"), "utf8"),
    "unchanged\n",
  );

  const movedProjectRoot = path.join(temporaryRoot, "moved-first-project");
  await rename(firstProjectRoot, movedProjectRoot);
  const renamedAfterMove = await service.renameConversation(
    firstProject.id,
    conversation.id,
    { title: "项目已移动后的会话" },
  );
  assert.equal(renamedAfterMove.title, "项目已移动后的会话");
  const removedAfterMove = await service.removeConversation(
    firstProject.id,
    conversation.id,
  );
  assert.equal(removedAfterMove.removed, true);
  assert.equal(removedAfterMove.conversationCount, 0);
});

test("the first explicit message derives a short title without overriding a user rename", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-conversation-title-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  await mkdir(projectRoot);
  await writeFile(path.join(projectRoot, "app.js"), "project\n", "utf8");
  const sessionFactory = createFakeSessionFactory();
  const service = createProjectWorkService({
    storageRoot: path.join(temporaryRoot, "private-state"),
    sessionFactory,
    picker: async () => ({ rootPath: projectRoot }),
    idFactory: incrementalId("title"),
  });
  t.after(() => service.dispose());

  const selection = await service.pickProjectRoot({ mode: "existing" });
  const project = await service.registerProject({ selectionId: selection.selectionId });
  const automatic = await service.createConversation(project.id);
  const task = "  请   检查这个项目中的登录流程，并修复所有会导致用户无法保存设置的问题，同时补充相关测试和验证说明  ";
  await service.sendMessage(automatic.id, { text: task });
  const automaticSettled = await eventually(
    () => service.getConversation(automatic.id),
    (snapshot) => snapshot.conversation.status === "awaiting_confirmation",
    "automatic-title conversation did not settle",
  );
  const expectedTitle = task
    .normalize("NFKC")
    .trim()
    .replaceAll(/\s+/g, " ")
    .slice(0, 48);
  assert.equal(automaticSettled.conversation.title, expectedTitle);
  assert.ok(automaticSettled.conversation.title.length <= 48);

  const userNamed = await service.createConversation(project.id);
  await service.renameConversation(project.id, userNamed.id, {
    title: "我的自定义会话",
  });
  await service.sendMessage(userNamed.id, { text: "这条消息不能覆盖名称" });
  const userNamedSettled = await eventually(
    () => service.getConversation(userNamed.id),
    (snapshot) => snapshot.conversation.status === "awaiting_confirmation",
    "user-named conversation did not settle",
  );
  assert.equal(userNamedSettled.conversation.title, "我的自定义会话");
  assert.equal(sessionFactory.sessions.length, 2);
  assert.deepEqual(
    sessionFactory.sessions.map((session) => session.prompts.length),
    [1, 1],
  );
});

test("deleting a running conversation is rejected without aborting it", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-conversation-delete-busy-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  const storageRoot = path.join(temporaryRoot, "private-state");
  await mkdir(projectRoot);
  await writeFile(path.join(projectRoot, "app.js"), "project\n", "utf8");
  const sessionFactory = createBlockingSessionFactory();
  const service = createProjectWorkService({
    storageRoot,
    sessionFactory,
    picker: async () => ({ rootPath: projectRoot }),
    idFactory: incrementalId("delete-busy"),
  });
  t.after(() => service.dispose());

  const selection = await service.pickProjectRoot({ mode: "existing" });
  const project = await service.registerProject({ selectionId: selection.selectionId });
  const conversation = await service.createConversation(project.id);
  await service.sendMessage(conversation.id, { text: "继续运行" });
  await eventually(
    () => service.getConversation(conversation.id),
    (snapshot) => snapshot.conversation.status === "running",
    "conversation did not enter running state",
  );

  await assert.rejects(
    service.removeConversation(project.id, conversation.id),
    (error) => {
      assert.equal(error.code, "PROJECT_WORK_CONVERSATION_DELETE_BUSY");
      assert.equal(error.status, 409);
      return true;
    },
  );
  assert.equal(sessionFactory.sessions[0].aborts, 0);
  await access(path.join(storageRoot, "conversations", conversation.id));

  sessionFactory.sessions[0].release();
  await eventually(
    () => service.getConversation(conversation.id),
    (snapshot) => snapshot.conversation.status === "idle",
    "conversation did not settle after release",
  );
});
