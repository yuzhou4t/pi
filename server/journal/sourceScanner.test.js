import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRunStore } from "./runStore.js";
import {
  commitJournalSourceScan,
  publicationDiscovery,
  scanJournalSources,
} from "./sourceScanner.js";
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
    { published_this_month: true, display_label: "本月新论文" },
  );
  assert.deepEqual(
    publicationDiscovery("2025-09-17", "2026-07-23T08:00:00.000Z"),
    { published_this_month: false, display_label: "本月补发现 · 非本月新论文" },
  );
  assert.deepEqual(
    publicationDiscovery("2026-01-01", "2026-01-03T08:00:00.000Z", "year"),
    { published_this_month: false, display_label: "本月补发现 · 非本月新论文" },
  );
});

test("a hung source is timed out, recorded as failed, and later sources still complete", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-source-watchdog-"));
  const runStore = createRunStore({ dataDir });
  const sourceStateStore = createSourceStateStore({ dataDir });
  const run = await runStore.createRun({ sourceIds: sources.map((source) => source.source_id) });

  const result = await scanJournalSources({
    runId: run.run_id,
    runStore,
    sourceStateStore,
    sources,
    fetchSource: (source) => source.source_id === "source-ok"
      ? new Promise(() => {})
      : Promise.resolve({
          fetched_at: "2026-07-23T08:00:00.000Z",
          index_url: "https://dblp.org/db/journals/jmlr/index.xml",
          target_urls: ["https://dblp.org/db/journals/jmlr/jmlr26.xml"],
          papers: [{
            title: "Reliable LLM Agent Evaluation",
            authors: ["A. Author"],
            venue: "JMLR",
            published_at: "2026-07-20",
            official_id: "journals/jmlr/Agent26",
            official_url: "https://jmlr.org/papers/v27/agent26.html",
            pdf_url: "https://jmlr.org/papers/v27/agent26.pdf",
            abstract: "A benchmark for reliable and verifiable language agents.",
          }],
        }),
    fetchImpl: async () => new Response(JSON.stringify({ results: [] }), { status: 200 }),
    observedAt: "2026-07-23T08:00:00.000Z",
    sourceTimeoutMs: 25,
  });

  assert.equal(result.summary.successful_source_count, 1);
  assert.deepEqual(result.summary.failed_source_ids, ["source-ok"]);
  const hungScan = result.sourceScans.find((scan) => scan.source_id === "source-ok");
  assert.equal(hungScan.status, "failed");
  assert.equal(hungScan.error.code, "SOURCE_SCAN_TIMEOUT");
  assert.equal(hungScan.error.retryable, true);
  const runState = await runStore.getRun(run.run_id);
  assert.deepEqual(runState.source_progress.completed_source_ids.sort(), [
    "source-failed",
    "source-ok",
  ]);
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

test("weekly selection keeps one broader-field slot beside current core papers", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-field-slots-"));
  const runStore = createRunStore({ dataDir });
  const sourceStateStore = createSourceStateStore({ dataDir });
  const run = await runStore.createRun({ sourceIds: ["source-ok"] });
  // 四篇窄主题（LLM Agent）+ 两篇领域视野（扩散生成、图神经网络），均为本月发表。
  const papers = [
    ...Array.from({ length: 4 }, (_, index) => ({
      title: `An LLM Agent method ${index}`,
      authors: ["A. Author"],
      venue: "ACL",
      published_at: "2026-07-20",
      official_id: `conf/acl/Agent${index}`,
      official_url: `https://aclanthology.org/2026.acl.agent${index}/`,
      pdf_url: `https://aclanthology.org/2026.acl.agent${index}.pdf`,
      abstract: "An LLM agent with planning and tool use.",
    })),
    {
      title: "A diffusion model for image generation",
      authors: ["B. Author"],
      venue: "ACL",
      published_at: "2026-07-19",
      official_id: "conf/acl/Diffusion",
      official_url: "https://aclanthology.org/2026.acl.diffusion/",
      pdf_url: "https://aclanthology.org/2026.acl.diffusion.pdf",
      abstract: "We propose a diffusion model and generative model for image generation.",
    },
    {
      title: "A graph neural network for representation learning",
      authors: ["C. Author"],
      venue: "ACL",
      published_at: "2026-07-18",
      official_id: "conf/acl/GNN",
      official_url: "https://aclanthology.org/2026.acl.gnn/",
      pdf_url: "https://aclanthology.org/2026.acl.gnn.pdf",
      abstract: "A graph neural network with contrastive learning for representation learning.",
    },
  ];
  const result = await scanJournalSources({
    runId: run.run_id,
    runStore,
    sourceStateStore,
    sources: [sources[0]],
    fetchSource: async () => ({
      fetched_at: "2026-07-30T08:00:00.000Z",
      index_url: "https://dblp.org/db/conf/acl/index.xml",
      target_urls: ["https://dblp.org/db/conf/acl/acl2026.xml"],
      papers,
    }),
    fetchImpl: async () => new Response(JSON.stringify({ results: [] }), { status: 200 }),
    observedAt: "2026-07-30T08:00:00.000Z",
    fieldSlots: 2,
  });
  const candidates = result.candidateBatch.candidates;
  assert.equal(candidates.length, 5);
  const fieldPicks = candidates.filter((paper) => paper.candidate_scope === "field");
  // 默认周快照优先保留 3 篇当前核心和 1 篇领域视野，空余位再由核心补齐。
  assert.equal(fieldPicks.length, 1);
  assert.ok(fieldPicks.every((paper) => paper.display_label.includes("领域视野")));
  assert.equal(result.summary.field_slots_reserved, 1);
});

test("a refresh scan commits its cursor only after the applied marker is durable", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-refresh-scan-"));
  const runStore = createRunStore({ dataDir });
  const sourceStateStore = createSourceStateStore({ dataDir });
  const run = await runStore.createRun({ sourceIds: ["source-ok"] });
  const scanArgs = {
    runId: run.run_id,
    runStore,
    sourceStateStore,
    sources: [sources[0]],
    fetchSource: async () => ({
      fetched_at: "2026-07-23T08:00:00.000Z",
      index_url: "https://dblp.org/db/conf/acl/index.xml",
      target_urls: ["https://dblp.org/db/conf/acl/acl2026.xml"],
      papers: [{
        title: "An LLM Agent with Tool Use",
        authors: ["A. Author"],
        venue: "ACL",
        published_at: "2026-07-20",
        official_id: "conf/acl/Fresh",
        official_url: "https://aclanthology.org/2026.acl.fresh/",
        pdf_url: "https://aclanthology.org/2026.acl.fresh.pdf",
        abstract: "",
      }],
    }),
    fetchImpl: async () => new Response(JSON.stringify({ results: [] }), { status: 200 }),
    observedAt: "2026-07-23T08:00:00.000Z",
  };
  await scanJournalSources({ ...scanArgs });
  const refresh = await scanJournalSources({
    ...scanArgs,
    scanKey: "refresh-2026-07-30",
    deferCursorCommit: true,
  });
  assert.equal(refresh.cursor_commit_pending, true);
  assert.equal((await sourceStateStore.load()).revision, 1);
  // 刷新扫描的事务写在独立的 refresh/ 命名空间，不覆盖首次扫描的工件。
  let refreshTransaction = await runStore.readArtifact(
    run.run_id,
    "refresh/refresh-2026-07-30/inputs/source-scan-transaction.json",
  );
  assert.equal(refreshTransaction.scan_key, "refresh-2026-07-30");
  assert.equal(refreshTransaction.status, "staged");
  await assert.rejects(commitJournalSourceScan({
    runId: run.run_id,
    runStore,
    sourceStateStore,
    scanKey: "refresh-2026-07-30",
    requiredArtifacts: ["outputs/candidates-applied.json"],
  }), (error) => error?.code === "ENOENT");
  assert.equal((await sourceStateStore.load()).revision, 1);
  await runStore.writeArtifact(
    run.run_id,
    "refresh/refresh-2026-07-30/outputs/candidates-applied.json",
    { schema_version: 1, run_id: run.run_id, scan_key: "refresh-2026-07-30" },
  );
  const committed = await commitJournalSourceScan({
    runId: run.run_id,
    runStore,
    sourceStateStore,
    scanKey: "refresh-2026-07-30",
    requiredArtifacts: ["outputs/candidates-applied.json"],
  });
  assert.equal(committed.cursor_commit_pending, false);
  assert.equal((await sourceStateStore.load()).revision, 2);
  refreshTransaction = await runStore.readArtifact(
    run.run_id,
    "refresh/refresh-2026-07-30/inputs/source-scan-transaction.json",
  );
  assert.equal(refreshTransaction.status, "committed");
  const baseTransaction = await runStore.readArtifact(
    run.run_id,
    "inputs/source-scan-transaction.json",
  );
  assert.equal(baseTransaction.scan_key, undefined);
});

test("refresh scan keys cannot escape their artifact namespace", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-refresh-key-"));
  const runStore = createRunStore({ dataDir });
  const sourceStateStore = createSourceStateStore({ dataDir });
  const run = await runStore.createRun({ sourceIds: ["source-ok"] });
  await assert.rejects(scanJournalSources({
    runId: run.run_id,
    runStore,
    sourceStateStore,
    sources: [sources[0]],
    scanKey: "../outside",
  }), /SOURCE_SCAN_KEY_INVALID/);
});

test("historical first discoveries backfill candidates before the classic pool", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-source-backfill-"));
  const runStore = createRunStore({ dataDir });
  const sourceStateStore = createSourceStateStore({ dataDir });
  const run = await runStore.createRun({ sourceIds: ["source-ok"] });
  // 两篇今年早些时候发表、本月才首次被发现的主题相关论文；没有本月新论文。
  const result = await scanJournalSources({
    runId: run.run_id,
    runStore,
    sourceStateStore,
    sources: [sources[0]],
    fetchSource: async () => ({
      fetched_at: "2026-07-29T08:00:00.000Z",
      index_url: "https://dblp.org/db/conf/acl/index.xml",
      target_urls: ["https://dblp.org/db/conf/acl/acl2026.xml"],
      papers: [
        {
          title: "LLM Agent Planning in March",
          authors: ["A. Author"],
          venue: "ACL",
          published_at: "2026-03-14",
          official_id: "conf/acl/March26",
          official_url: "https://aclanthology.org/2026.acl.march/",
          pdf_url: "https://aclanthology.org/2026.acl.march.pdf",
          abstract: "An agent planning study.",
        },
        {
          title: "LLM Agent Memory in May",
          authors: ["B. Writer"],
          venue: "ACL",
          published_at: "2026-05-02",
          official_id: "conf/acl/May26",
          official_url: "https://aclanthology.org/2026.acl.may/",
          pdf_url: "https://aclanthology.org/2026.acl.may.pdf",
          abstract: "An agent memory study.",
        },
      ],
    }),
    fetchImpl: async () => new Response(JSON.stringify({ results: [] }), { status: 200 }),
    observedAt: "2026-07-29T08:00:00.000Z",
  });

  assert.equal(result.summary.recent_topic_candidate_count, 0);
  assert.equal(result.summary.historical_backfill_count, 2);
  const titles = result.candidateBatch.candidates.map((paper) => paper.title);
  // 近半年补发现先按确定性质量分选择，剩余名额才由经典补位。
  assert.equal(titles[0], "LLM Agent Planning in March");
  assert.equal(titles[1], "LLM Agent Memory in May");
  const backfill = result.candidateBatch.candidates[0];
  assert.equal(backfill.published_this_month, false);
  assert.equal(backfill.display_label, "近半年优质未读");
  const classicCount = result.candidateBatch.candidates.filter(
    (paper) => paper.candidate_origin === "classic_review",
  ).length;
  assert.equal(classicCount, 3);
});

test("source scanner reconsiders current-window records without marking them newly discovered", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-source-scanner-"));
  const now = () => new Date("2026-07-23T08:00:00.000Z");
  const ids = [
    "12345678-aaaa-bbbb-cccc-dddddddddddd",
    "87654321-aaaa-bbbb-cccc-dddddddddddd",
  ];
  const runStore = createRunStore({
    dataDir,
    now,
    idFactory: () => ids.shift(),
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
  assert.equal(second.summary.reconsidered_record_count, 1);
  assert.equal(second.candidateBatch.mode, "mixed_review");
  assert.equal(second.candidateBatch.candidates.length, 5);
  const reconsidered = second.candidateBatch.candidates.find(
    (paper) => paper.title === "Reliable LLM Agent Evaluation",
  );
  assert.ok(reconsidered);
  assert.equal(reconsidered.is_new, false);
  assert.equal(reconsidered.candidate_origin, "previously_seen");
  assert.equal(reconsidered.published_this_month, true);

  const state = await sourceStateStore.load();
  assert.equal(state.sources["source-failed"].cursor ?? null, null);
});

test("current-window reconsideration excludes papers already handled or dismissed", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-source-reconsider-"));
  const now = () => new Date("2026-07-30T08:00:00.000Z");
  const runStore = createRunStore({ dataDir, now });
  const sourceStateStore = createSourceStateStore({ dataDir, now });
  const papers = [
    ["available", "Unprocessed LLM Agent Memory"],
    ["handled", "Handled LLM Agent Planning"],
    ["dismissed", "Dismissed LLM Agent Evaluation"],
  ].map(([id, title], index) => ({
    title,
    authors: ["A. Author"],
    venue: "ACL",
    published_at: `2026-07-${String(20 + index).padStart(2, "0")}`,
    official_id: `conf/acl/${id}`,
    official_url: `https://aclanthology.org/2026.acl.${id}/`,
    abstract: "A current-window language agent paper.",
  }));
  const fetchSource = async () => ({
    fetched_at: "2026-07-30T08:00:00.000Z",
    index_url: "https://aclanthology.org/venues/acl/",
    target_urls: ["https://aclanthology.org/2026.acl-long/"],
    papers,
  });

  const firstRun = await runStore.createRun({ sourceIds: ["source-ok"] });
  const first = await scanJournalSources({
    runId: firstRun.run_id,
    runStore,
    sourceStateStore,
    sources: [sources[0]],
    fetchSource,
    observedAt: "2026-07-30T08:00:00.000Z",
  });
  const handled = first.candidateBatch.candidates.find(
    (paper) => paper.title === "Handled LLM Agent Planning",
  );
  await runStore.updateRun(firstRun.run_id, {
    candidates: first.candidateBatch.candidates,
    paper_decisions: { [handled.paper_id]: "read" },
  });

  const dismissed = first.candidateBatch.candidates.find(
    (paper) => paper.title === "Dismissed LLM Agent Evaluation",
  );
  const secondRun = await runStore.createRun({ sourceIds: ["source-ok"] });
  const second = await scanJournalSources({
    runId: secondRun.run_id,
    runStore,
    sourceStateStore,
    sources: [sources[0]],
    fetchSource,
    observedAt: "2026-07-30T08:00:00.000Z",
    dismissedKeys: [dismissed.dedupe_key],
  });
  const titles = second.candidateBatch.candidates.map((paper) => paper.title);

  assert.equal(titles.includes("Unprocessed LLM Agent Memory"), true);
  assert.equal(titles.includes("Handled LLM Agent Planning"), false);
  assert.equal(titles.includes("Dismissed LLM Agent Evaluation"), false);
  assert.equal(second.summary.reconsidered_record_count, 1);
});

test("global source state stays unchanged when a required run artifact is not durable", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-source-staging-"));
  const runStore = createRunStore({ dataDir });
  const sourceStateStore = createSourceStateStore({ dataDir });
  const run = await runStore.createRun({ sourceIds: ["source-ok"] });
  const failingRunStore = {
    ...runStore,
    writeArtifact: async (runId, relativePath, value) => {
      if (relativePath === "inputs/ranking-pool.json") {
        throw new Error("RANKING_POOL_DURABILITY_FAILURE");
      }
      return runStore.writeArtifact(runId, relativePath, value);
    },
  };

  await assert.rejects(scanJournalSources({
    runId: run.run_id,
    runStore: failingRunStore,
    sourceStateStore,
    sources: [sources[0]],
    fetchSource: async () => ({
      fetched_at: "2026-07-27T08:00:00.000Z",
      index_url: "https://source.example/index",
      target_urls: ["https://source.example/volume"],
      papers: [{
        title: "A Reliable LLM Agent",
        authors: ["A. Author"],
        venue: "ACL",
        published_at: "2026-07-27",
        doi: "10.1000/staging",
        official_url: "https://doi.org/10.1000/staging",
      }],
    }),
    fetchImpl: async () => new Response(JSON.stringify({ results: [] }), { status: 200 }),
    observedAt: "2026-07-27T08:00:00.000Z",
  }), /RANKING_POOL_DURABILITY_FAILURE/);

  const state = await sourceStateStore.load();
  assert.equal(state.revision, 0);
  assert.deepEqual(state.sources, {});
});

test("workflow deferral commits only after final candidate and ranking artifacts are durable", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-source-deferred-"));
  const runStore = createRunStore({ dataDir });
  const sourceStateStore = createSourceStateStore({ dataDir });
  const run = await runStore.createRun({ sourceIds: ["source-ok"] });
  const staged = await scanJournalSources({
    runId: run.run_id,
    runStore,
    sourceStateStore,
    sources: [sources[0]],
    fetchSource: async () => ({
      fetched_at: "2026-07-27T08:00:00.000Z",
      index_url: "https://source.example/index",
      target_urls: ["https://source.example/volume"],
      papers: [{
        title: "A Reliable LLM Agent",
        authors: ["A. Author"],
        venue: "ACL",
        published_at: "2026-07-27",
        doi: "10.1000/deferred",
        official_url: "https://doi.org/10.1000/deferred",
      }],
    }),
    fetchImpl: async () => new Response(JSON.stringify({ results: [] }), { status: 200 }),
    observedAt: "2026-07-27T08:00:00.000Z",
    deferCursorCommit: true,
  });

  assert.equal(staged.cursor_commit_pending, true);
  assert.equal((await sourceStateStore.load()).revision, 0);
  await assert.rejects(commitJournalSourceScan({
    runId: run.run_id,
    runStore,
    sourceStateStore,
    requiredArtifacts: [
      "inputs/candidates.json",
      "audit/candidate-ranking.json",
    ],
  }), (error) => error?.code === "ENOENT");
  assert.equal((await sourceStateStore.load()).revision, 0);

  await runStore.writeArtifact(run.run_id, "inputs/candidates.json", staged.candidateBatch.candidates);
  await runStore.writeArtifact(run.run_id, "audit/candidate-ranking.json", {
    source: "deterministic",
    candidates: staged.candidateBatch.candidates.map((paper, index) => ({
      paper_id: paper.paper_id,
      rank: index + 1,
    })),
  });
  const committed = await commitJournalSourceScan({
    runId: run.run_id,
    runStore,
    sourceStateStore,
    requiredArtifacts: [
      "inputs/candidates.json",
      "audit/candidate-ranking.json",
    ],
  });

  assert.equal(committed.cursor_commit_pending, false);
  assert.equal((await sourceStateStore.load()).revision, 1);
});

test("a crash after CAS commit resumes from run-owned staging without fetching or advancing twice", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-source-resume-"));
  const runStore = createRunStore({ dataDir });
  const sourceStateStore = createSourceStateStore({ dataDir });
  const run = await runStore.createRun({ sourceIds: ["source-ok"] });
  let fetchCount = 0;
  let failFinalization = true;
  const fetchSource = async () => {
    fetchCount += 1;
    return {
      fetched_at: "2026-07-27T08:00:00.000Z",
      index_url: "https://source.example/index",
      target_urls: ["https://source.example/volume"],
      papers: [{
        title: "A Reliable LLM Agent",
        authors: ["A. Author"],
        venue: "ACL",
        published_at: "2026-07-27",
        doi: "10.1000/resume",
        official_url: "https://doi.org/10.1000/resume",
      }],
    };
  };
  const interruptedRunStore = {
    ...runStore,
    writeArtifact: async (runId, relativePath, value) => {
      if (
        failFinalization
        && relativePath === "inputs/source-scan-transaction.json"
        && value?.status === "committed"
      ) {
        failFinalization = false;
        throw new Error("FINALIZATION_INTERRUPTED");
      }
      return runStore.writeArtifact(runId, relativePath, value);
    },
  };
  const options = {
    runId: run.run_id,
    sourceStateStore,
    sources: [sources[0]],
    fetchSource,
    fetchImpl: async () => new Response(JSON.stringify({ results: [] }), { status: 200 }),
    observedAt: "2026-07-27T08:00:00.000Z",
  };

  await assert.rejects(scanJournalSources({
    ...options,
    runStore: interruptedRunStore,
  }), /FINALIZATION_INTERRUPTED/);
  assert.equal((await sourceStateStore.load()).revision, 1);

  const resumed = await scanJournalSources({
    ...options,
    runStore,
  });

  assert.equal(fetchCount, 1);
  assert.equal(resumed.summary.new_record_count, 1);
  assert.equal(resumed.sourceScans[0].cursor_committed, true);
  assert.equal((await sourceStateStore.load()).revision, 1);
  assert.equal(
    (await runStore.readArtifact(
      run.run_id,
      "inputs/source-scan-transaction.json",
    )).status,
    "committed",
  );
});
