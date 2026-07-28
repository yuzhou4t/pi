import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createRunStore,
  JOURNAL_RUN_SCHEMA_VERSION,
  journalWeekWindowKey,
} from "./runStore.js";

test("run store creates, updates, lists, and restores a run", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-run-store-"));
  const store = createRunStore({
    dataDir,
    now: () => new Date("2026-07-23T08:00:00.000Z"),
    idFactory: () => "12345678-aaaa-bbbb-cccc-dddddddddddd",
  });

  const created = await store.createRun({ sourceIds: ["jmlr", "acl"] });
  assert.equal(created.run_id, "journal-2026-07-23T08-00-00-000Z-12345678");
  assert.equal(created.project_id, "pi-agent-product");
  assert.equal(created.window_key, "2026-07-20");
  assert.equal(created.status, "scanning");
  assert.deepEqual(created.guides, {
    status: "not_started",
    requested_paper_ids: [],
    provider_id: null,
    model_id: null,
    papers: {},
  });
  assert.deepEqual(created.paper_decisions, {});
  assert.deepEqual(created.readings, {
    schema_version: 1,
    status: "not_started",
    paper_ids: [],
    provider_id: null,
    model_id: null,
    papers: {},
    last_error: null,
  });
  assert.deepEqual(created.journal_mutations, {
    schema_version: 1,
    entries: {},
  });

  const updated = await store.updateRun(created.run_id, {
    status: "review_ready",
    phase: "candidate_review",
  });
  assert.equal(updated.status, "review_ready");
  assert.equal((await store.getRun(created.run_id)).phase, "candidate_review");
  assert.deepEqual((await store.listRuns()).map((run) => run.run_id), [created.run_id]);

  const events = await readFile(path.join(dataDir, "runs", created.run_id, "events.jsonl"), "utf8");
  assert.match(events, /run_created/);
});

test("legacy runs without a mutation ledger are normalized without a destructive migration", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-run-legacy-ledger-"));
  const store = createRunStore({
    dataDir,
    now: () => new Date("2026-07-23T08:00:00.000Z"),
    idFactory: () => "12345678-aaaa-bbbb-cccc-dddddddddddd",
  });
  const created = await store.createRun();
  const runPath = path.join(dataDir, "runs", created.run_id, "run.json");
  const legacy = JSON.parse(await readFile(runPath, "utf8"));
  delete legacy.journal_mutations;
  await writeFile(runPath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

  const restored = await store.getRun(created.run_id);
  assert.deepEqual(restored.journal_mutations, {
    schema_version: 1,
    entries: {},
  });
  const persisted = JSON.parse(await readFile(runPath, "utf8"));
  assert.equal("journal_mutations" in persisted, false);
});

test("run records migrate version zero and reject future schema versions", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-run-schema-"));
  const store = createRunStore({
    dataDir,
    now: () => new Date("2026-07-23T08:00:00.000Z"),
    idFactory: () => "12345678-aaaa-bbbb-cccc-dddddddddddd",
  });
  const created = await store.createRun();
  const runPath = path.join(dataDir, "runs", created.run_id, "run.json");
  const legacy = JSON.parse(await readFile(runPath, "utf8"));
  legacy.schema_version = 0;
  await writeFile(runPath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

  assert.equal(
    (await store.getRun(created.run_id)).schema_version,
    JOURNAL_RUN_SCHEMA_VERSION,
  );
  assert.equal(
    JSON.parse(await readFile(runPath, "utf8")).schema_version,
    JOURNAL_RUN_SCHEMA_VERSION,
  );

  const future = {
    ...legacy,
    schema_version: JOURNAL_RUN_SCHEMA_VERSION + 1,
  };
  const futureContent = `${JSON.stringify(future, null, 2)}\n`;
  await writeFile(runPath, futureContent, "utf8");
  await assert.rejects(
    () => store.getRun(created.run_id),
    (error) => error.code === "JOURNAL_RUN_DATA_VERSION_UNSUPPORTED",
  );
  assert.equal(await readFile(runPath, "utf8"), futureContent);
});

test("journal week windows start on Monday and active runs are reused atomically", async () => {
  assert.equal(
    journalWeekWindowKey("2026-07-27T00:00:00.000Z"),
    "2026-07-27",
  );
  assert.equal(
    journalWeekWindowKey("2026-08-02T23:59:59.000Z"),
    "2026-07-27",
  );
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-run-window-"));
  let createdCount = 0;
  const options = {
    dataDir,
    now: () => new Date("2026-07-27T08:00:00.000Z"),
    idFactory: () => {
      createdCount += 1;
      return `${String(createdCount).padStart(8, "0")}-aaaa-bbbb-cccc-dddddddddddd`;
    },
  };
  const firstStore = createRunStore(options);
  const secondStore = createRunStore(options);

  const [first, second] = await Promise.all([
    firstStore.createOrReuseActiveRun({ projectId: "research-project" }),
    secondStore.createOrReuseActiveRun({ projectId: "research-project" }),
  ]);

  assert.equal(first.run.run_id, second.run.run_id);
  assert.deepEqual([first.created, second.created].sort(), [false, true]);
  assert.equal(createdCount, 1);
});

test("run store keeps an explicit project owner on new runs", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-run-project-"));
  const store = createRunStore({
    dataDir,
    now: () => new Date("2026-07-23T08:00:00.000Z"),
    idFactory: () => "12345678-aaaa-bbbb-cccc-dddddddddddd",
  });

  const created = await store.createRun({ projectId: "research-project" });
  assert.equal(created.project_id, "research-project");
  await assert.rejects(
    store.createRun({ projectId: "../outside" }),
    /unsupported characters/,
  );
});

test("run events use stable sequences, snapshot watermarks, and incremental reads", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-run-events-"));
  const store = createRunStore({
    dataDir,
    now: () => new Date("2026-07-23T08:00:00.000Z"),
    idFactory: () => "12345678-aaaa-bbbb-cccc-dddddddddddd",
  });
  const run = await store.createRun();
  const notifications = [];
  const unsubscribe = store.subscribeEvents(
    run.run_id,
    (event) => notifications.push(event),
  );
  const [first, second] = await Promise.all([
    store.appendEvent(run.run_id, { type: "first", at: "2026-07-23T08:01:00.000Z" }),
    store.appendEvent(run.run_id, { type: "second", at: "2026-07-23T08:02:00.000Z" }),
  ]);
  unsubscribe();

  assert.deepEqual([first.seq, second.seq], [2, 3]);
  assert.deepEqual(notifications.map((event) => event.seq), [2, 3]);
  const page = await store.readEvents(run.run_id, {
    afterSeq: 1,
    limit: 1,
  });
  assert.deepEqual(page.events.map((event) => event.seq), [2]);
  assert.equal(page.hasMore, true);
  assert.equal(page.lastSeq, 3);
  const restored = await store.getRun(run.run_id);
  assert.equal(restored.snapshot_watermark, 3);
  assert.equal(restored.last_event_seq, 3);
});

test("run events recover a truncated tail but reject corruption before the tail", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-run-tail-"));
  const store = createRunStore({
    dataDir,
    now: () => new Date("2026-07-23T08:00:00.000Z"),
    idFactory: () => "12345678-aaaa-bbbb-cccc-dddddddddddd",
  });
  const run = await store.createRun();
  const eventPath = path.join(
    dataDir,
    "runs",
    run.run_id,
    "events.jsonl",
  );
  const committed = await readFile(eventPath, "utf8");
  await writeFile(
    eventPath,
    `${committed}{"seq":2,"type":"truncated"`,
    "utf8",
  );

  const recovered = await store.readEvents(run.run_id);
  assert.deepEqual(recovered.events.map((event) => event.seq), [1]);
  assert.equal(await readFile(eventPath, "utf8"), committed);
  assert.equal(
    (await store.appendEvent(run.run_id, {
      type: "second",
      at: "2026-07-23T08:01:00.000Z",
    })).seq,
    2,
  );

  await writeFile(
    eventPath,
    `${committed}not-json\n`,
    "utf8",
  );
  await assert.rejects(
    () => store.readEvents(run.run_id),
    (error) => error.code === "JOURNAL_EVENT_LOG_CORRUPT",
  );
});

test("concurrent run updates are serialized and preserve unrelated fields", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-run-concurrency-"));
  const store = createRunStore({
    dataDir,
    now: () => new Date("2026-07-23T08:00:00.000Z"),
    idFactory: () => "12345678-aaaa-bbbb-cccc-dddddddddddd",
  });
  const run = await store.createRun();
  let releaseFirst;
  const firstWaiting = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let firstStarted;
  const firstStartedPromise = new Promise((resolve) => {
    firstStarted = resolve;
  });

  const first = store.updateRun(run.run_id, async () => {
    firstStarted();
    await firstWaiting;
    return { paper_decisions: { "paper-1": "read" } };
  });
  await firstStartedPromise;
  const second = store.updateRun(run.run_id, (current) => ({
    readings: {
      ...current.readings,
      status: "reading",
    },
  }));
  releaseFirst();
  await Promise.all([first, second]);

  const restored = await store.getRun(run.run_id);
  assert.deepEqual(restored.paper_decisions, { "paper-1": "read" });
  assert.equal(restored.readings.status, "reading");
});

test("run artifacts cannot escape their run directory", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-run-artifact-"));
  const store = createRunStore({
    dataDir,
    now: () => new Date("2026-07-23T08:00:00.000Z"),
    idFactory: () => "12345678-aaaa-bbbb-cccc-dddddddddddd",
  });
  const run = await store.createRun();

  await store.writeArtifact(run.run_id, "inputs/candidates.json", [{ id: "paper-1" }]);
  assert.deepEqual(await store.readArtifact(run.run_id, "inputs/candidates.json"), [{ id: "paper-1" }]);
  await assert.rejects(store.writeArtifact(run.run_id, "../outside.json", {}), /inside the run/);
  await assert.rejects(store.writeArtifact(run.run_id, undefined, {}), /inside the run/);
  await assert.rejects(store.getRun(".."), /unsupported characters/);
  await assert.rejects(store.getRun("."), /unsupported characters/);
});
