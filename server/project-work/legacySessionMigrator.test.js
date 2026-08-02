import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { migrateLegacyProjectWorkSession } from "./legacySessionMigrator.js";

function userMessage(text, timestamp) {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp,
  };
}

function assistantMessage(text, timestamp) {
  return {
    role: "assistant",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    content: [{ type: "text", text }],
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  };
}

test("legacy Session migration validates the complete tree, leaf, checkpoints, and cwd before commit", async (t) => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "pi-legacy-session-migrator-"),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const legacyWorkspaceRoot = path.join(temporaryRoot, "legacy-workspace");
  const targetWorkspaceRoot = path.join(temporaryRoot, "target-workspace");
  const sessionDir = path.join(temporaryRoot, "sessions");
  await Promise.all([
    mkdir(legacyWorkspaceRoot),
    mkdir(targetWorkspaceRoot),
    mkdir(sessionDir),
  ]);
  const source = SessionManager.create(legacyWorkspaceRoot, sessionDir);
  const userId = source.appendMessage(userMessage("检查项目", 1));
  const assistantId = source.appendMessage(assistantMessage("检查完成", 2));
  const siblingUserId = source.appendMessage(userMessage("方案甲", 3));
  source.appendMessage(assistantMessage("方案甲完成", 4));
  source.branch(assistantId);
  source.appendMessage(userMessage("方案乙", 5));
  const leafId = source.appendMessage(assistantMessage("方案乙完成", 6));
  const sourceIds = source.getEntries().map((entry) => entry.id);

  const result = await migrateLegacyProjectWorkSession({
    legacyWorkspaceRoot,
    targetWorkspaceRoot,
    sessionDir,
    checkpoints: [
      { id: userId, role: "user" },
      { id: assistantId, role: "assistant" },
      { id: siblingUserId, role: "user" },
    ],
  });
  assert.equal(result.status, "migrated");
  assert.equal(result.entryCount, sourceIds.length);
  assert.equal(result.leafId, leafId);
  const canonicalTargetWorkspace = await realpath(targetWorkspaceRoot);
  const migrated = SessionManager.continueRecent(
    canonicalTargetWorkspace,
    sessionDir,
  );
  assert.deepEqual(
    migrated.getEntries().map((entry) => entry.id),
    sourceIds,
  );
  assert.equal(migrated.getLeafId(), leafId);
  assert.equal(
    path.resolve(migrated.getCwd()),
    path.resolve(canonicalTargetWorkspace),
  );
  assert.ok(migrated.getEntry(userId));
  assert.ok(migrated.getEntry(assistantId));
  assert.ok(migrated.getEntry(siblingUserId));
  assert.deepEqual(
    source.getEntries().map((entry) => entry.id),
    sourceIds,
  );
  assert.equal(source.getLeafId(), leafId);
});
