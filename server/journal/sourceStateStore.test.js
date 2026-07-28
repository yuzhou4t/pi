import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createSourceStateStore,
  SourceStateConflictError,
} from "./sourceStateStore.js";

test("source state separates first seen time from publication time", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-source-state-"));
  const store = createSourceStateStore({
    dataDir,
    now: () => new Date("2026-07-23T08:00:00.000Z"),
  });
  const paper = {
    dedupe_key: "doi:10.1000/test",
    published_at: "2024-01-02",
  };
  const observedAt = "2026-07-23T08:00:00.000Z";
  const first = store.classifyPapers(await store.load(), "source-1", [paper], observedAt);
  assert.equal(first[0].is_new, true);
  assert.equal(first[0].first_seen_at, observedAt);
  assert.equal(first[0].published_at, "2024-01-02");

  const committed = store.applySuccessfulScan(await store.load(), {
    sourceId: "source-1",
    papers: first,
    cursorAfter: { modified_at: "2026-07-23" },
    observedAt,
  });
  await store.save(committed);

  const second = store.classifyPapers(await store.load(), "source-1", [paper], "2026-07-30T08:00:00.000Z");
  assert.equal(second[0].is_new, false);
  assert.equal(second[0].first_seen_at, observedAt);
});

test("a failed source attempt preserves its previous cursor", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-source-failed-"));
  const store = createSourceStateStore({ dataDir });
  let state = store.applySuccessfulScan(await store.load(), {
    sourceId: "source-1",
    papers: [],
    cursorAfter: { token: "stable" },
    observedAt: "2026-07-23T08:00:00.000Z",
  });
  state = store.applyFailedScan(state, {
    sourceId: "source-1",
    error: "HTTP 503",
    observedAt: "2026-07-30T08:00:00.000Z",
  });
  assert.deepEqual(state.sources["source-1"].cursor, { token: "stable" });
});

test("scan transactions commit with CAS and are idempotent by transaction id", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-source-cas-"));
  const store = createSourceStateStore({
    dataDir,
    now: () => new Date("2026-07-27T08:00:00.000Z"),
  });
  const sourceScans = [{
    source_id: "source-1",
    status: "success",
    next_cursor: { token: "next" },
    papers: [{
      dedupe_key: "doi:10.1000/transaction",
      first_seen_at: "2026-07-27T08:00:00.000Z",
    }],
    error: null,
  }];

  const first = await store.commitScanTransaction({
    transactionId: "scan:run-1",
    expectedRevision: 0,
    sourceScans,
    observedAt: "2026-07-27T08:00:00.000Z",
  });
  const repeated = await store.commitScanTransaction({
    transactionId: "scan:run-1",
    expectedRevision: 0,
    sourceScans,
    observedAt: "2026-07-27T08:00:00.000Z",
  });

  assert.equal(first.already_committed, false);
  assert.equal(first.revision, 1);
  assert.equal(repeated.already_committed, true);
  assert.equal(repeated.revision, 1);
  assert.deepEqual(repeated.state.sources["source-1"].cursor, { token: "next" });
  assert.equal(repeated.state.applied_transactions.length, 1);
});

test("concurrent transactions from the same source-state revision cannot last-write-win", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-source-conflict-"));
  const firstStore = createSourceStateStore({ dataDir });
  const secondStore = createSourceStateStore({ dataDir });
  const scan = (token) => [{
    source_id: "source-1",
    status: "success",
    next_cursor: { token },
    papers: [],
    error: null,
  }];

  const results = await Promise.allSettled([
    firstStore.commitScanTransaction({
      transactionId: "scan:run-a",
      expectedRevision: 0,
      sourceScans: scan("a"),
      observedAt: "2026-07-27T08:00:00.000Z",
    }),
    secondStore.commitScanTransaction({
      transactionId: "scan:run-b",
      expectedRevision: 0,
      sourceScans: scan("b"),
      observedAt: "2026-07-27T08:00:00.000Z",
    }),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.equal(rejected.reason instanceof SourceStateConflictError, true);
  assert.equal(rejected.reason.code, "SOURCE_STATE_CONFLICT");
  assert.equal((await firstStore.load()).revision, 1);
});
