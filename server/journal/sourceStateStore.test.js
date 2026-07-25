import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSourceStateStore } from "./sourceStateStore.js";

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
