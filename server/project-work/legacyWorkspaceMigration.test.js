import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createLegacyOverlayProjectWorkServiceForTests,
  createProjectWorkService,
} from "./projectWorkService.js";

function incrementalId(prefix) {
  let sequence = 0;
  return () => `${prefix}-${++sequence}`;
}

function sessionFactory() {
  const factory = async () => ({
    subscribe() {
      return () => {};
    },
    setActiveToolsByName(names) {
      return names;
    },
    async abort() {},
    dispose() {},
  });
  factory.listModels = async () => ({
    defaultProviderId: "deepseek",
    defaultModelId: "deepseek-v4-flash",
    providers: [{
      id: "deepseek",
      models: [{ id: "deepseek-v4-flash" }],
    }],
  });
  factory.dispose = async () => {};
  return factory;
}

async function createLegacyFixture({ changed = false } = {}) {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "pi-legacy-workspace-migration-"),
  );
  const projectRoot = path.join(temporaryRoot, "project");
  const storageRoot = path.join(temporaryRoot, "state");
  await mkdir(projectRoot);
  await writeFile(path.join(projectRoot, "Package.swift"), "// original\n", "utf8");
  const legacyService = createLegacyOverlayProjectWorkServiceForTests({
    storageRoot,
    sessionFactory: sessionFactory(),
    picker: async () => ({ rootPath: projectRoot }),
    idFactory: incrementalId("legacy"),
  });
  const selection = await legacyService.pickProjectRoot({ mode: "existing" });
  const project = await legacyService.registerProject({
    selectionId: selection.selectionId,
  });
  const conversation = await legacyService.createConversation(project.id, {
    title: "旧 Swift 验证",
  });
  const conversationDirectory = path.join(
    storageRoot,
    "conversations",
    conversation.id,
  );
  const baseRoot = path.join(conversationDirectory, "base");
  const workspaceRoot = path.join(conversationDirectory, "workspace");
  await writeFile(path.join(baseRoot, "Package.swift"), "// original\n", "utf8");
  await writeFile(
    path.join(workspaceRoot, "Package.swift"),
    changed ? "// changed\n" : "// original\n",
    "utf8",
  );
  await legacyService.dispose();

  const statePath = path.join(conversationDirectory, "conversation.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  delete state.runtimeMode;
  delete state.runtimeProfile;
  delete state.workspaceId;
  delete state.workspace;
  delete state.legacyMigration;
  state.status = "awaiting_confirmation";
  state.workspaceSnapshot = {
    schemaVersion: 1,
    rulesVersion: 2,
    mode: "sparse_overlay",
    includedFiles: 1,
    includedBytes: 12,
    skippedBinaryFiles: 0,
    skippedOversizedFiles: 0,
    truncated: false,
  };
  state.verifications = [1, 2, 3].map((index) => ({
    id: `legacy-swift-test-${index}`,
    status: "requested",
    recipeId: "swift.test",
    command: {
      file: "swift",
      args: ["test"],
      cwd: ".",
      environment: {},
    },
    createdAt: `2026-08-01T00:00:0${index}.000Z`,
  }));
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return {
    temporaryRoot,
    projectRoot,
    storageRoot,
    project,
    conversation,
    conversationDirectory,
    statePath,
  };
}

test("legacy project conversations migrate once to the real main Workspace", async (t) => {
  const fixture = await createLegacyFixture();
  t.after(() => rm(fixture.temporaryRoot, { recursive: true, force: true }));
  const service = createProjectWorkService({
    storageRoot: fixture.storageRoot,
    sessionFactory: sessionFactory(),
    picker: async () => ({ rootPath: fixture.projectRoot }),
    idFactory: incrementalId("native"),
  });
  t.after(() => service.dispose());

  const [firstList, secondList] = await Promise.all([
    service.listConversations(fixture.project.id),
    service.listConversations(fixture.project.id),
  ]);
  assert.equal(firstList[0].runtimeProfile, "pi-native-v1");
  assert.equal(firstList[0].executionPolicy.mode, "native");
  assert.equal(secondList[0].legacyMigration.status, "completed");
  const workspaces = await service.listWorkspaces(fixture.project.id);
  assert.equal(workspaces.length, 1);
  assert.equal(firstList[0].workspace.id, workspaces[0].id);

  const persisted = JSON.parse(await readFile(fixture.statePath, "utf8"));
  assert.equal(persisted.runtimeMode, "workspace-v2");
  assert.equal(persisted.runtimeProfile, "pi-native-v1");
  assert.equal(persisted.executionPolicy.mode, "native");
  assert.equal(persisted.workspaceId, workspaces[0].id);
  assert.equal(persisted.workspaceSnapshot.mode, "real_workspace");
  assert.deepEqual(
    persisted.verifications.map((verification) => verification.status),
    ["legacy_superseded", "legacy_superseded", "legacy_superseded"],
  );
  const events = (await readFile(
    path.join(fixture.conversationDirectory, "events.jsonl"),
    "utf8",
  )).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(
    events.filter((event) => event.type === "workspace.migration_started").length,
    1,
  );
  assert.equal(
    events.filter((event) => event.type === "workspace.migration_completed").length,
    1,
  );
  await assert.rejects(
    access(path.join(fixture.conversationDirectory, "verification-runs")),
    (error) => error?.code === "ENOENT",
  );
});

test("test injections cannot select the overlay product runtime", async (t) => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "pi-native-default-runtime-"),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  const storageRoot = path.join(temporaryRoot, "state");
  await mkdir(projectRoot);
  const service = createProjectWorkService({
    storageRoot,
    sessionFactory: sessionFactory(),
    workspaceRuntimeMode: "overlay-v1",
    picker: async () => ({ rootPath: projectRoot }),
    idFactory: incrementalId("native-default"),
  });
  t.after(() => service.dispose());
  const selection = await service.pickProjectRoot({ mode: "existing" });
  const project = await service.registerProject({
    selectionId: selection.selectionId,
  });
  const conversation = await service.createConversation(project.id);
  const conversationDirectory = path.join(
    storageRoot,
    "conversations",
    conversation.id,
  );
  const persisted = JSON.parse(await readFile(
    path.join(conversationDirectory, "conversation.json"),
    "utf8",
  ));
  assert.equal(persisted.runtimeMode, "workspace-v2");
  assert.equal(persisted.runtimeProfile, "pi-native-v1");
  await assert.rejects(
    access(path.join(conversationDirectory, "base")),
    (error) => error?.code === "ENOENT",
  );
  await assert.rejects(
    access(path.join(conversationDirectory, "workspace")),
    (error) => error?.code === "ENOENT",
  );
});

test("Session migration failure blocks before runtimeMode or runtimeProfile changes", async (t) => {
  const fixture = await createLegacyFixture();
  t.after(() => rm(fixture.temporaryRoot, { recursive: true, force: true }));
  let migrationCalls = 0;
  const service = createProjectWorkService({
    storageRoot: fixture.storageRoot,
    sessionFactory: sessionFactory(),
    sessionMigrator: async () => {
      migrationCalls += 1;
      const error = new Error("injected fork failure");
      error.code = "PROJECT_WORK_SESSION_WORKSPACE_MIGRATION_BLOCKED";
      error.status = 409;
      error.retryable = true;
      throw error;
    },
    picker: async () => ({ rootPath: fixture.projectRoot }),
    idFactory: incrementalId("native-failed-session"),
  });
  t.after(() => service.dispose());

  const snapshot = await service.getConversation(fixture.conversation.id);
  assert.equal(migrationCalls, 1);
  assert.equal(snapshot.conversation.status, "recovery_blocked");
  assert.equal(snapshot.conversation.legacyMigration.status, "blocked");
  assert.equal(snapshot.conversation.runtimeProfile, null);
  const persisted = JSON.parse(await readFile(fixture.statePath, "utf8"));
  assert.equal(persisted.runtimeMode, undefined);
  assert.equal(persisted.runtimeProfile, undefined);
});

test("legacy overlay changes stop migration for review and cannot run copied verification", async (t) => {
  const fixture = await createLegacyFixture({ changed: true });
  t.after(() => rm(fixture.temporaryRoot, { recursive: true, force: true }));
  const service = createProjectWorkService({
    storageRoot: fixture.storageRoot,
    sessionFactory: sessionFactory(),
    picker: async () => ({ rootPath: fixture.projectRoot }),
    idFactory: incrementalId("native-review"),
  });
  t.after(() => service.dispose());

  const snapshot = await service.getConversation(fixture.conversation.id);
  assert.equal(snapshot.conversation.legacyMigration.status, "needs_review");
  assert.equal(snapshot.conversation.activeChangeSet.status, "ready");
  assert.equal(snapshot.conversation.activeChangeSet.files.length, 1);
  assert.equal(
    snapshot.conversation.verifications.every(
      (verification) => verification.status === "legacy_superseded",
    ),
    true,
  );
  const persisted = JSON.parse(await readFile(fixture.statePath, "utf8"));
  assert.notEqual(persisted.runtimeMode, "workspace-v2");

  await assert.rejects(
    service.runVerification(fixture.conversation.id, {
      requestId: "legacy-swift-test-1",
    }),
    (error) => error?.code === "PROJECT_WORK_VERIFICATION_NOT_FOUND",
  );
  await assert.rejects(
    access(path.join(fixture.conversationDirectory, "verification-runs")),
    (error) => error?.code === "ENOENT",
  );

  const changeSet = snapshot.conversation.activeChangeSet;
  await service.applyChangeSet(fixture.conversation.id, {
    changeSetId: changeSet.id,
    changeSetHash: changeSet.hash,
    files: changeSet.files.map((file) => ({
      fileId: file.id,
      baseHash: file.baseHash,
      afterHash: file.afterHash,
    })),
  });
  const migrated = await service.getConversation(fixture.conversation.id);
  assert.equal(migrated.conversation.legacyMigration.status, "completed");
  assert.equal(migrated.conversation.runtimeProfile, "pi-native-v1");
  assert.equal(migrated.conversation.executionPolicy.mode, "native");
  assert.equal(
    await readFile(path.join(fixture.projectRoot, "Package.swift"), "utf8"),
    "// changed\n",
  );
});

test("legacy migration can export or hash-bound abandon without deleting its archive", async (t) => {
  const fixture = await createLegacyFixture({ changed: true });
  t.after(() => rm(fixture.temporaryRoot, { recursive: true, force: true }));
  const service = createProjectWorkService({
    storageRoot: fixture.storageRoot,
    sessionFactory: sessionFactory(),
    picker: async () => ({ rootPath: fixture.projectRoot }),
    idFactory: incrementalId("native-abandon"),
  });
  t.after(() => service.dispose());

  const snapshot = await service.getConversation(fixture.conversation.id);
  const changeSet = snapshot.conversation.activeChangeSet;
  assert.deepEqual(
    snapshot.conversation.legacyMigration.recovery.actions,
    ["apply", "export", "abandon"],
  );
  const exported = await service.exportLegacyMigrationChanges(
    fixture.conversation.id,
    { changeSetId: changeSet.id, changeSetHash: changeSet.hash },
  );
  assert.equal(exported.mimeType, "text/x-diff; charset=utf-8");
  assert.match(exported.bytes.toString("utf8"), /Package\.swift/);
  assert.match(exported.bytes.toString("utf8"), /\/\/ changed/);
  await assert.rejects(
    service.abandonLegacyMigrationChanges(fixture.conversation.id, {
      changeSetId: changeSet.id,
      changeSetHash: `sha256:${"0".repeat(64)}`,
    }),
    (error) => error?.code === "PROJECT_WORK_CHANGE_BINDING_MISMATCH",
  );

  const abandoned = await service.abandonLegacyMigrationChanges(
    fixture.conversation.id,
    { changeSetId: changeSet.id, changeSetHash: changeSet.hash },
  );
  assert.equal(abandoned.conversation.legacyMigration.status, "completed");
  assert.equal(abandoned.conversation.legacyMigration.resolution, "abandoned");
  assert.equal(abandoned.conversation.activeChangeSet.status, "cancelled");
  assert.equal(
    await readFile(path.join(fixture.projectRoot, "Package.swift"), "utf8"),
    "// original\n",
  );
  assert.equal(
    await readFile(
      path.join(fixture.conversationDirectory, "workspace", "Package.swift"),
      "utf8",
    ),
    "// changed\n",
  );
});
