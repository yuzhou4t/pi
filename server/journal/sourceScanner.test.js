import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRunStore } from "./runStore.js";
import { publicationDiscovery, scanJournalSources } from "./sourceScanner.js";
import { createSourceStateStore } from "./sourceStateStore.js";

const sources = [
  {
    source_id: "source-ok",
    id: "source-ok",
    name: "ACL",
    type: "conference",
    dblp_path: "conf/acl",
  },
  {
    source_id: "source-failed",
    id: "source-failed",
    name: "JMLR",
    type: "journal",
    dblp_path: "journals/jmlr",
  },
];

test("publication labels distinguish weekly publication from historical first discovery", () => {
  assert.deepEqual(
    publicationDiscovery("2026-07-20", "2026-07-23T08:00:00.000Z"),
    { published_this_week: true, display_label: "本周新论文" },
  );
  assert.deepEqual(
    publicationDiscovery("2025-09-17", "2026-07-23T08:00:00.000Z"),
    { published_this_week: false, display_label: "本周补发现 · 非本周新论文" },
  );
});

test("source cap keeps title-matched papers even when they appear after the raw limit", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-source-priority-"));
  const runStore = createRunStore({ dataDir });
  const sourceStateStore = createSourceStateStore({ dataDir });
  const run = await runStore.createRun({ sourceIds: ["source-ok"] });
  const fetchedPapers = Array.from({ length: 82 }, (_, index) => ({
    title: index === 81 ? "An LLM Agent with Tool Use" : `Unrelated vision paper ${index}`,
    authors: ["A. Author"],
    venue: "ACL",
    published_at: "2026-07-20",
    official_id: `conf/acl/Paper${index}`,
    official_url: `https://aclanthology.org/2026.acl.${index}/`,
    pdf_url: `https://aclanthology.org/2026.acl.${index}.pdf`,
    abstract: "",
  }));

  const result = await scanJournalSources({
    runId: run.run_id,
    runStore,
    sourceStateStore,
    sources: [sources[0]],
    fetchSource: async () => ({
      fetched_at: "2026-07-23T08:00:00.000Z",
      index_url: "https://dblp.org/db/conf/acl/index.xml",
      target_urls: ["https://dblp.org/db/conf/acl/acl2026.xml"],
      papers: fetchedPapers,
    }),
    fetchImpl: async () => new Response(JSON.stringify({ results: [] }), { status: 200 }),
    observedAt: "2026-07-23T08:00:00.000Z",
    maxPapersPerSource: 5,
  });

  assert.equal(result.summary.raw_record_count, 82);
  assert.equal(result.candidateBatch.candidates[0].title, "An LLM Agent with Tool Use");
});

test("source scanner persists reliable results, keeps failed sources visible, and avoids a second new batch", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-source-scanner-"));
  const now = () => new Date("2026-07-23T08:00:00.000Z");
  const runStore = createRunStore({
    dataDir,
    now,
    idFactory: () => "12345678-aaaa-bbbb-cccc-dddddddddddd",
  });
  const sourceStateStore = createSourceStateStore({ dataDir, now });
  const fetchSource = async (source) => {
    if (source.source_id === "source-failed") throw new Error("DBLP_HTTP_503");
    return {
      fetched_at: "2026-07-23T08:00:00.000Z",
      index_url: "https://dblp.org/db/conf/acl/index.xml",
      target_urls: ["https://dblp.org/db/conf/acl/acl2026.xml"],
      papers: [{
        title: "Reliable LLM Agent Evaluation",
        authors: ["A. Author"],
        venue: "ACL",
        published_at: "2026-07-20",
        doi: "10.1000/agent",
        official_id: "conf/acl/Agent26",
        official_url: "https://aclanthology.org/2026.acl.1/",
        pdf_url: "https://aclanthology.org/2026.acl.1.pdf",
        abstract: "A benchmark for reliable and verifiable language agents.",
      }],
    };
  };
  const fetchImpl = async () => new Response(JSON.stringify({ results: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

  const firstRun = await runStore.createRun({ sourceIds: sources.map((source) => source.source_id) });
  const first = await scanJournalSources({
    runId: firstRun.run_id,
    runStore,
    sourceStateStore,
    sources,
    fetchSource,
    fetchImpl,
    observedAt: "2026-07-23T08:00:00.000Z",
  });
  assert.equal(first.summary.successful_source_count, 1);
  assert.deepEqual(first.summary.failed_source_ids, ["source-failed"]);
  assert.equal(first.summary.new_record_count, 1);
  assert.equal(first.candidateBatch.mode, "mixed_review");
  const firstRunState = await runStore.getRun(firstRun.run_id);
  assert.deepEqual(firstRunState.source_progress, {
    total_count: 2,
    completed_source_ids: ["source-ok", "source-failed"],
    successful_source_ids: ["source-ok"],
    failed_source_ids: ["source-failed"],
  });

  const secondRun = await runStore.createRun({ sourceIds: sources.map((source) => source.source_id) });
  const second = await scanJournalSources({
    runId: secondRun.run_id,
    runStore,
    sourceStateStore,
    sources,
    fetchSource,
    fetchImpl,
    observedAt: "2026-07-30T08:00:00.000Z",
  });
  assert.equal(second.summary.new_record_count, 0);
  assert.equal(second.candidateBatch.mode, "classic_review");
  assert.equal(second.candidateBatch.candidates.length, 5);
  assert.equal(second.candidateBatch.candidates.every((paper) => paper.is_new === false), true);

  const state = await sourceStateStore.load();
  assert.equal(state.sources["source-failed"].cursor ?? null, null);
});
