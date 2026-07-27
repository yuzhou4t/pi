import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRunStore } from "./runStore.js";

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
