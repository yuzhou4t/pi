import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLegacyWorkspaceArchiveService } from "./legacyWorkspaceArchive.js";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-legacy-archive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storageRoot = path.join(root, "state");
  const conversationsRoot = path.join(storageRoot, "conversations");
  await mkdir(conversationsRoot, { recursive: true });
  return {
    root,
    storageRoot,
    conversationsRoot,
    service: createLegacyWorkspaceArchiveService({ storageRoot }),
  };
}

async function writeConversation(fixtureRoot, id, {
  title = "旧 TTS 验证",
  migrationStatus = "completed",
  status = "idle",
  runtimeMode = "workspace-v2",
  runtimeProfile = "pi-native-v1",
  includeBase = true,
  includeWorkspace = true,
} = {}) {
  const directory = path.join(fixtureRoot.conversationsRoot, id);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "conversation.json"), `${JSON.stringify({
    id,
    title,
    workType: "project_work",
    status,
    runtimeMode,
    runtimeProfile,
    legacyMigration: { status: migrationStatus },
  })}\n`, "utf8");
  await writeFile(path.join(directory, "events.jsonl"), "historical event\n", "utf8");
  await mkdir(path.join(directory, "pi-sessions"));
  await writeFile(path.join(directory, "pi-sessions", "session.jsonl"), "session\n", "utf8");
  if (includeBase) {
    await mkdir(path.join(directory, "base", "Sources"), { recursive: true });
    await writeFile(path.join(directory, "base", "Sources", "App.swift"), "base\n", "utf8");
  }
  if (includeWorkspace) {
    await mkdir(path.join(directory, "workspace", ".build"), { recursive: true });
    await writeFile(path.join(directory, "workspace", ".build", "cache.bin"), "cache\n", "utf8");
  }
  return directory;
}

test("legacy archive summary exposes only safe identity, size, and hash", async (t) => {
  const current = await fixture(t);
  await writeConversation(current, "conversation-1");

  const summary = await current.service.getSummary();
  assert.equal(summary.itemCount, 1);
  assert.equal(summary.cleanupEligibleCount, 1);
  assert.equal(summary.totalBytes, Buffer.byteLength("base\ncache\n"));
  assert.equal(summary.totalFileCount, 2);
  assert.match(summary.mutationOrigin, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(summary.items[0].parts, ["base", "workspace"]);
  assert.equal(summary.items[0].conversationId, "conversation-1");
  assert.equal(summary.items[0].title, "旧 TTS 验证");
  assert.match(summary.items[0].archiveHash, /^sha256:[a-f0-9]{64}$/);
  const serialized = JSON.stringify(summary);
  assert.doesNotMatch(serialized, new RegExp(current.root.replaceAll("/", "\\/")));
  assert.doesNotMatch(serialized, /events\.jsonl|pi-sessions|conversation\.json/);
});

test("explicit hash-bound cleanup removes only legacy base and workspace", async (t) => {
  const current = await fixture(t);
  const directory = await writeConversation(current, "conversation-2");
  const before = await current.service.getSummary();
  const item = before.items[0];

  const after = await current.service.cleanup({
    mutationOrigin: before.mutationOrigin,
    items: [{
      conversationId: item.conversationId,
      archiveHash: item.archiveHash,
      bytes: item.bytes,
    }],
  });
  assert.equal(after.itemCount, 0);
  await assert.rejects(access(path.join(directory, "base")), { code: "ENOENT" });
  await assert.rejects(access(path.join(directory, "workspace")), { code: "ENOENT" });
  assert.equal(
    JSON.parse(await readFile(path.join(directory, "conversation.json"), "utf8")).id,
    "conversation-2",
  );
  assert.equal(await readFile(path.join(directory, "events.jsonl"), "utf8"), "historical event\n");
  assert.equal(
    await readFile(path.join(directory, "pi-sessions", "session.jsonl"), "utf8"),
    "session\n",
  );
});

test("cleanup rejects hash drift and never partially deletes the selected archive", async (t) => {
  const current = await fixture(t);
  const directory = await writeConversation(current, "conversation-3");
  const before = await current.service.getSummary();
  const item = before.items[0];
  await writeFile(path.join(directory, "workspace", "changed.txt"), "changed\n", "utf8");

  await assert.rejects(
    current.service.cleanup({
      mutationOrigin: before.mutationOrigin,
      items: [{
        conversationId: item.conversationId,
        archiveHash: item.archiveHash,
        bytes: item.bytes,
      }],
    }),
    (error) => error?.code === "PROJECT_WORK_LEGACY_ARCHIVE_DRIFT",
  );
  await access(path.join(directory, "base"));
  await access(path.join(directory, "workspace"));
});

test("cleanup rejects running, unmigrated, review, and blocked conversations", async (t) => {
  const current = await fixture(t);
  await writeConversation(current, "running", { status: "working" });
  await writeConversation(current, "unmigrated", {
    migrationStatus: "pending",
    runtimeMode: undefined,
    runtimeProfile: undefined,
  });
  await writeConversation(current, "review", { migrationStatus: "needs_review" });
  await writeConversation(current, "blocked", { migrationStatus: "blocked" });
  const summary = await current.service.getSummary();
  assert.equal(summary.cleanupEligibleCount, 0);
  assert.deepEqual(
    Object.fromEntries(summary.items.map((item) => [item.conversationId, item.blockedReason])),
    {
      blocked: "blocked",
      review: "needs_review",
      running: "conversation_running",
      unmigrated: "migration_incomplete",
    },
  );
  for (const item of summary.items) {
    await assert.rejects(
      current.service.cleanup({
        mutationOrigin: summary.mutationOrigin,
        items: [{
          conversationId: item.conversationId,
          archiveHash: item.archiveHash,
          bytes: item.bytes,
        }],
      }),
      (error) => error?.code === "PROJECT_WORK_LEGACY_ARCHIVE_CLEANUP_BLOCKED",
    );
  }
});

test("symlinks make an archive visible but permanently ineligible for cleanup", async (t) => {
  const current = await fixture(t);
  const directory = await writeConversation(current, "conversation-link");
  const outside = path.join(current.root, "outside.txt");
  await writeFile(outside, "keep me\n", "utf8");
  await symlink(outside, path.join(directory, "workspace", "outside-link"));

  const summary = await current.service.getSummary();
  assert.equal(summary.itemCount, 1);
  assert.equal(summary.items[0].cleanupEligible, false);
  assert.equal(summary.items[0].blockedReason, "archive_symlink");
  assert.equal(summary.items[0].archiveHash, null);
  await assert.rejects(
    current.service.cleanup({
      mutationOrigin: summary.mutationOrigin,
      items: [{
        conversationId: "conversation-link",
        archiveHash: `sha256:${"0".repeat(64)}`,
        bytes: 0,
      }],
    }),
    (error) => error?.code === "PROJECT_WORK_LEGACY_ARCHIVE_CLEANUP_BLOCKED",
  );
  assert.equal(await readFile(outside, "utf8"), "keep me\n");
  await access(path.join(directory, "workspace"));
});

test("standalone scratch history is outside the legacy project migration archive", async (t) => {
  const current = await fixture(t);
  const directory = await writeConversation(current, "scratch-history");
  const statePath = path.join(directory, "conversation.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.workspaceKind = "scratch";
  state.scope = "standalone";
  await writeFile(statePath, `${JSON.stringify(state)}\n`, "utf8");

  const summary = await current.service.getSummary();
  assert.equal(summary.itemCount, 0);
  await access(path.join(directory, "base"));
  await access(path.join(directory, "workspace"));
});
