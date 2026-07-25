import assert from "node:assert/strict";
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
        await writeFile(
          path.join(options.workspaceRoot, "app.js"),
          changedContent,
          "utf8",
        );
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

test("conversation snapshots ignore nested Python virtual environments", async (t) => {
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
  assert.equal(snapshot.conversation.workspaceSnapshot.includedFiles, 1);
  assert.equal(JSON.stringify(tree).includes(".venv"), false);
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
        contentHash: "sha256:stale",
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
  const outsideSnapshotFile = await service.readProjectFile(project.id, {
    filePath: "created-after-snapshot.js",
  });
  await assert.rejects(
    service.sendMessage(conversation.id, {
      text: "Read the newly added file.",
      context: [{
        path: "created-after-snapshot.js",
        startLine: 1,
        endLine: 1,
        contentHash: outsideSnapshotFile.hash,
      }],
    }),
    (error) => {
      assert.equal(error.code, "PROJECT_WORK_CONTEXT_OUTSIDE_SNAPSHOT");
      assert.equal(error.status, 409);
      return true;
    },
  );

  await service.sendMessage(conversation.id, {
    text: "Update the implementation and prepare its verification.",
    context: [{
      path: "app.js",
      startLine: 1,
      endLine: 1,
      contentHash: file.hash,
    }],
  });
  assert.equal(
    sessionFactory.sessions[0].options.workspaceSnapshot.truncated,
    false,
  );
  const settled = await eventually(
    () => service.getConversation(conversation.id),
    (snapshot) => snapshot.conversation.status === "awaiting_confirmation",
    "agent_settled did not produce a reviewable change set",
  );

  assert.equal(settled.conversation.plan.steps.length, 3);
  assert.equal(settled.conversation.activeChangeSet.status, "ready");
  assert.equal(settled.conversation.activeChangeSet.files.length, 1);
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
    await readFile(path.join(projectRoot, "app.js"), "utf8"),
    "export const version = 2;\n",
  );

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
