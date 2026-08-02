import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CONVERSATION_RECORD_SCHEMA_VERSION,
  createConversationStore,
} from "./conversationStore.js";

test("legacy events receive stable derived seq values and live subscribers continue after the watermark", async (t) => {
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), "pi-event-store-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const conversationId = "conversation-legacy-events";
  const directory = path.join(storageRoot, "conversations", conversationId);
  await mkdir(directory, { recursive: true });
  const store = createConversationStore({ storageRoot });
  await store.create({
    id: conversationId,
    projectId: null,
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z",
  });
  await writeFile(
    path.join(directory, "events.jsonl"),
    [
      JSON.stringify({ type: "legacy.first", at: "2026-07-27T00:00:01.000Z" }),
      JSON.stringify({ type: "legacy.second", at: "2026-07-27T00:00:02.000Z" }),
      "",
    ].join("\n"),
    "utf8",
  );

  const initial = await store.readEvents(conversationId);
  assert.deepEqual(initial.events.map((event) => event.seq), [1, 2]);
  assert.equal(initial.lastSeq, 2);

  const observed = [];
  const unsubscribe = store.subscribe(conversationId, (event) => {
    observed.push(event);
  });
  const appended = await store.appendEvent(conversationId, {
    type: "current.third",
    at: "2026-07-27T00:00:03.000Z",
    data: { ok: true },
  });
  unsubscribe();
  await store.appendEvent(conversationId, {
    type: "current.fourth",
    at: "2026-07-27T00:00:04.000Z",
    data: {},
  });

  assert.equal(appended.seq, 3);
  assert.equal((await store.get(conversationId)).lastEventSeq, 4);
  assert.deepEqual(observed.map((event) => event.seq), [3]);
  const incremental = await store.readEvents(conversationId, {
    afterSeq: 1,
  });
  assert.deepEqual(
    incremental.events.map((event) => event.seq),
    [2, 3, 4],
  );
  assert.equal(incremental.lastSeq, 4);
});

test("a truncated JSONL tail is repaired while middle corruption fails closed", async (t) => {
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), "pi-event-tail-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const conversationId = "conversation-tail-recovery";
  const directory = path.join(storageRoot, "conversations", conversationId);
  await mkdir(directory, { recursive: true });
  const store = createConversationStore({ storageRoot });
  await store.create({
    id: conversationId,
    projectId: null,
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z",
  });
  const eventPath = path.join(directory, "events.jsonl");
  const valid = [
    JSON.stringify({ seq: 1, type: "one", at: "2026-07-27T00:00:01.000Z" }),
    JSON.stringify({ seq: 2, type: "two", at: "2026-07-27T00:00:02.000Z" }),
  ];
  await writeFile(
    eventPath,
    `${valid.join("\n")}\n{"seq":3,"type":"truncated"`,
    "utf8",
  );

  const recovered = await store.readEvents(conversationId);
  assert.deepEqual(recovered.events.map((event) => event.seq), [1, 2]);
  assert.equal(
    await readFile(eventPath, "utf8"),
    `${valid.join("\n")}\n`,
  );
  const appended = await store.appendEvent(conversationId, {
    type: "three",
    at: "2026-07-27T00:00:03.000Z",
    data: {},
  });
  assert.equal(appended.seq, 3);

  await writeFile(
    eventPath,
    `${valid[0]}\nnot-json\n${valid[1]}\n`,
    "utf8",
  );
  await assert.rejects(
    () => store.readEvents(conversationId),
    (error) => error.code === "PROJECT_WORK_EVENT_LOG_CORRUPT",
  );
});

test("a cold sparse event index resumes near the cursor and stays current after append", async (t) => {
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), "pi-event-sparse-index-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const conversationId = "conversation-sparse-index";
  const directory = path.join(storageRoot, "conversations", conversationId);
  await mkdir(directory, { recursive: true });
  const store = createConversationStore({ storageRoot });
  await store.create({
    id: conversationId,
    projectId: null,
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
  });
  const committed = Array.from({ length: 300 }, (_, index) => JSON.stringify({
    seq: index + 1,
    type: "agent.progress",
    at: "2026-08-02T00:00:00.000Z",
    data: { summary: `进展 ${index + 1} · ${"长".repeat(index % 9)}` },
  }));
  const eventPath = path.join(directory, "events.jsonl");
  await writeFile(
    eventPath,
    `${committed.join("\n")}\n{"seq":301,"type":"truncated"`,
    "utf8",
  );

  const coldPage = await store.readEvents(conversationId, {
    afterSeq: 250,
    limit: 10,
  });
  assert.deepEqual(
    coldPage.events.map((event) => event.seq),
    [251, 252, 253, 254, 255, 256, 257, 258, 259, 260],
  );
  assert.equal(coldPage.hasMore, true);
  assert.equal(coldPage.lastSeq, 300);
  assert.equal(await readFile(eventPath, "utf8"), `${committed.join("\n")}\n`);

  const appended = await store.appendEvent(conversationId, {
    type: "agent.status",
    at: "2026-08-02T00:00:01.000Z",
    data: { status: "completed" },
  });
  assert.equal(appended.seq, 301);
  const resumed = await store.readEvents(conversationId, {
    afterSeq: 295,
    limit: 20,
  });
  assert.deepEqual(
    resumed.events.map((event) => event.seq),
    [296, 297, 298, 299, 300, 301],
  );
  assert.equal(resumed.hasMore, false);
  assert.equal(resumed.lastSeq, 301);

  const recent = await store.readEventsBefore(conversationId, { limit: 5 });
  assert.deepEqual(recent.events.map((event) => event.seq), [297, 298, 299, 300, 301]);
  assert.equal(recent.hasMore, true);
  assert.equal(recent.nextBeforeSeq, 297);
  const older = await store.readEventsBefore(conversationId, {
    beforeSeq: recent.nextBeforeSeq,
    limit: 5,
  });
  assert.deepEqual(older.events.map((event) => event.seq), [292, 293, 294, 295, 296]);
  assert.equal(older.nextBeforeSeq, 292);
});

test("event appends leave the full conversation record untouched and recover the watermark after restart", async (t) => {
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), "pi-event-watermark-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const conversationId = "conversation-event-watermark";
  const store = createConversationStore({ storageRoot });
  await store.create({
    id: conversationId,
    projectId: null,
    workType: "project_work",
    title: "不重写完整状态",
    lastEventSeq: 0,
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
  });
  const recordPath = path.join(
    storageRoot,
    "conversations",
    conversationId,
    "conversation.json",
  );
  const beforeContent = await readFile(recordPath, "utf8");
  const beforeStat = await stat(recordPath);

  for (let index = 0; index < 80; index += 1) {
    await store.appendEvent(conversationId, {
      type: "message.delta",
      at: "2026-08-02T00:00:01.000Z",
      data: { delta: String(index), revision: index + 1 },
    });
  }

  const afterStat = await stat(recordPath);
  assert.equal(await readFile(recordPath, "utf8"), beforeContent);
  assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
  assert.equal(JSON.parse(beforeContent).lastEventSeq, 0);
  assert.equal((await store.get(conversationId)).lastEventSeq, 80);

  const restarted = createConversationStore({ storageRoot });
  assert.equal((await restarted.get(conversationId)).lastEventSeq, 80);
  const tail = await restarted.readEventsBefore(conversationId, { limit: 3 });
  assert.deepEqual(tail.events.map((event) => event.seq), [78, 79, 80]);
});

test("conversation records migrate legacy versions and reject future or corrupt data", async (t) => {
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), "pi-record-schema-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const conversationId = "conversation-record-schema";
  const store = createConversationStore({ storageRoot });
  const created = await store.create({
    id: conversationId,
    projectId: null,
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z",
  });
  assert.equal(created.schemaVersion, CONVERSATION_RECORD_SCHEMA_VERSION);
  const recordPath = path.join(
    storageRoot,
    "conversations",
    conversationId,
    "conversation.json",
  );
  const legacy = JSON.parse(await readFile(recordPath, "utf8"));
  legacy.schemaVersion = 0;
  await writeFile(recordPath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");
  assert.equal(
    (await store.get(conversationId)).schemaVersion,
    CONVERSATION_RECORD_SCHEMA_VERSION,
  );
  assert.equal(
    JSON.parse(await readFile(recordPath, "utf8")).schemaVersion,
    CONVERSATION_RECORD_SCHEMA_VERSION,
  );

  const future = {
    ...legacy,
    schemaVersion: CONVERSATION_RECORD_SCHEMA_VERSION + 1,
  };
  const futureContent = `${JSON.stringify(future, null, 2)}\n`;
  await writeFile(recordPath, futureContent, "utf8");
  await assert.rejects(
    () => store.get(conversationId),
    (error) => error.code === "PROJECT_WORK_DATA_VERSION_UNSUPPORTED",
  );
  assert.equal(await readFile(recordPath, "utf8"), futureContent);

  await writeFile(recordPath, "{\"schemaVersion\":", "utf8");
  await assert.rejects(
    () => store.get(conversationId),
    (error) => error.code === "PROJECT_WORK_CONVERSATION_RECORD_CORRUPT",
  );
});
