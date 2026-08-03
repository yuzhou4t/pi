import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promptRegistry } from "../promptRegistry.js";
import { createRunStore } from "./runStore.js";
import { createSourceStateStore } from "./sourceStateStore.js";
import { createJournalWorkflowService } from "./workflowService.js";
import { __test as zoteroArchivalTest } from "./zoteroArchival.js";

function candidates() {
  return Array.from({ length: 5 }, (_, index) => ({
    paper_id: `paper-${index + 1}`,
    title: `Paper ${index + 1}`,
    authors: ["A. Author"],
    venue: "ACL",
    published_at: "2026-07-01",
    abstract: "A reliable agent paper.",
    topic_matches: ["LLM Agent"],
    heat_signals: [],
    evidence_scope: "摘要",
    candidate_origin: index === 4 ? "classic_review" : "weekly_scan",
    is_new: index !== 4,
    pdf_url: `https://papers.example/${index + 1}.pdf`,
  }));
}

async function createReadyGuideRun(prefix = "pi-agent-guides-") {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const runStore = createRunStore({ dataDir });
  const run = await runStore.createRun();
  const papers = candidates().slice(0, 3);
  for (const paper of papers) {
    const markdown = [
      `# ${paper.title}`,
      "",
      "## Introduction",
      "",
      `Research problem for ${paper.paper_id}.`,
      "",
      "## Method",
      "",
      `Method and mechanism for ${paper.paper_id}.`,
      "",
      "## Results",
      "",
      `Experimental evidence for ${paper.paper_id}.`,
      "",
    ].join("\n");
    await runStore.writeArtifact(run.run_id, `extraction/${paper.paper_id}/paper.md`, markdown);
    await runStore.writeArtifact(run.run_id, `extraction/${paper.paper_id}/manifest.json`, {
      schema_version: 1,
      paper_id: paper.paper_id,
      markdown_chars: markdown.length,
      image_count: 0,
    });
  }
  await runStore.updateRun(run.run_id, {
    status: "review_ready",
    phase: "candidate_review",
    candidates: papers,
    mineru: {
      status: "ready",
      batch_id: "batch-guides",
      papers: Object.fromEntries(papers.map((paper) => [
        paper.paper_id,
        { status: "ready" },
      ])),
    },
  });
  return { dataDir, runStore, runId: run.run_id, papers };
}

function fixtureGuideResult({ paper, document }) {
  const contentBlocks = document.blocks.filter((block) => block.kind !== "heading");
  const references = [
    contentBlocks[0]?.block_id,
    contentBlocks[1]?.block_id,
    contentBlocks[2]?.block_id,
  ].filter(Boolean);
  return {
    guide: {
      paper_id: paper.paper_id,
      problem: `这篇论文研究 ${paper.title} 所对应的核心问题。`,
      why_read: "它提供了可回到原文逐段核验的问题、方法与证据。",
      intuition: "核心直觉来自方法章节所描述的机制。",
      evidence: "主要证据来自实验章节报告的比较结果。",
      limitations: "仍需核验实验边界、失败案例与外部有效性。",
      questions: [
        "主要结论由哪些实验直接支持？",
        "论文明确报告了哪些适用边界？",
      ],
      evidence_refs: references,
    },
    source: "fixture",
    prompt_id: "five-minute-guide",
    prompt_version: "five-minute-guide.v1",
    prompt_hash: "sha256:prompt",
    input_hash: `sha256:${paper.paper_id}`,
    input_block_count: document.blocks.length,
    input_chars: 100,
    provider_id: null,
    model_id: null,
    operation_id: null,
    upstream_request_id: null,
    usage: null,
  };
}

function supportedModelRegistry() {
  return {
    supports: (providerId, modelId) => (
      providerId === "codex-subscription"
      && ["account-default", "gpt-5.3-codex-spark"].includes(modelId)
    ),
  };
}

function translationResult(translations, overrides = {}) {
  const prompt = promptRegistry.loadPrompt("translation");
  return {
    translations,
    source: "fixture",
    prompt_id: prompt.id,
    prompt_version: prompt.version,
    prompt_hash: prompt.prompt_hash,
    input_hash: "sha256:test",
    provider_id: "codex-subscription",
    model_id: "gpt-5.3-codex-spark",
    reasoning_effort: "low",
    usage: null,
    ...overrides,
  };
}

test("workflow wires the injected usage ledger into its default model registry", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-usage-ledger-"));
  let captureReads = 0;
  const usageLedger = {};
  Object.defineProperty(usageLedger, "capture", {
    get() {
      captureReads += 1;
      return async ({ usage }) => usage;
    },
  });

  createJournalWorkflowService({
    env: { PI_DATA_DIR: dataDir, PI_MODEL_MODE: "fixture" },
    dataDir,
    runStore: createRunStore({ dataDir }),
    usageLedger,
    modelUsageService: { getUsage: async () => ({}) },
    sourceStateStore: createSourceStateStore({ dataDir }),
    mineruAdapter: null,
  });

  assert.equal(captureReads, 1);
});

test("workflow delegates paper usage queries to the injected usage service", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-usage-service-"));
  const calls = [];
  const expected = { period: "7d", totals: { totalTokens: 123 } };
  const service = createJournalWorkflowService({
    env: { PI_DATA_DIR: dataDir, PI_MODEL_MODE: "fixture" },
    dataDir,
    runStore: createRunStore({ dataDir }),
    modelUsageService: {
      getUsage: async (options) => {
        calls.push(options);
        return expected;
      },
    },
    sourceStateStore: createSourceStateStore({ dataDir }),
    mineruAdapter: null,
    modelProviders: supportedModelRegistry(),
  });

  assert.strictEqual(await service.getUsage({ period: "7d" }), expected);
  assert.deepEqual(calls, [{ period: "7d" }]);
});

test("workflow runs scan, ranks five papers, submits one MinerU batch, and becomes review ready", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-workflow-"));
  const runStore = createRunStore({ dataDir });
  const sourceStateStore = createSourceStateStore({ dataDir });
  const submitted = [];
  let resultDownloads = 0;
  let activePdfDownloads = 0;
  let maxPdfDownloads = 0;
  let startedPdfDownloads = 0;
  let releaseFirstPdfWave;
  const firstPdfWave = new Promise((resolve) => {
    releaseFirstPdfWave = resolve;
  });
  const service = createJournalWorkflowService({
    env: {
      PI_DATA_DIR: dataDir,
      PI_MODEL_MODE: "fixture",
      PI_MINERU_API_TOKEN: "token",
      PI_MINERU_POLL_INTERVAL_MS: "1",
      PI_MINERU_TIMEOUT_MS: "1000",
      PI_PDF_PREP_CONCURRENCY: "3",
    },
    dataDir,
    runStore,
    sourceStateStore,
    sourceScanner: async () => ({
      summary: {
        source_count: 11,
        successful_source_count: 10,
        failed_source_ids: ["journal-ai"],
      },
      candidateBatch: {
        mode: "new_papers",
        candidates: candidates(),
      },
    }),
    candidateRanker: async ({ papers }) => ({
      candidates: papers.map((paper, index) => ({
        ...paper,
        rank: index + 1,
        selection_summary: `论文 ${index + 1} 的简短说明。`,
        project_impact: "与工作流设计有关。",
      })),
      source: "model",
      prompt_id: "candidate-ranking",
      prompt_version: "candidate-ranking.v1",
      input_hash: "sha256:test",
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
    pdfDownloader: async ({ paperId, outputDir }) => {
      activePdfDownloads += 1;
      maxPdfDownloads = Math.max(maxPdfDownloads, activePdfDownloads);
      startedPdfDownloads += 1;
      if (startedPdfDownloads === 3) releaseFirstPdfWave();
      await firstPdfWave;
      const filePath = path.join(outputDir, `${paperId}.pdf`);
      await writeFile(filePath, "%PDF-1.7\nmock");
      activePdfDownloads -= 1;
      return {
        file_path: filePath,
        sha256: `hash-${paperId}`,
        byte_length: 13,
      };
    },
    mineruAdapter: {
      submitBatch: async (files) => {
        submitted.push(files);
        return {
          batchId: "batch-1",
          state: "uploaded",
          uploads: files.map((file) => ({
            dataId: file.dataId,
            fileName: file.fileName,
            state: "uploaded",
            error: null,
          })),
        };
      },
      getBatch: async () => ({
        batchId: "batch-1",
        state: "done",
        items: candidates().map((paper) => ({
          dataId: paper.paper_id,
          fileName: `${paper.paper_id}.pdf`,
          state: "done",
          fullZipUrl: `https://mineru.example/${paper.paper_id}.zip`,
          progress: null,
          error: null,
        })),
      }),
      downloadResult: async (url) => {
        resultDownloads += 1;
        return {
          markdown: `# ${url}\n\nParsed paper content.`,
          images: [],
        };
      },
    },
  });

  const started = await service.startRun();
  const completed = await service.waitForRun(started.run_id);
  assert.equal(completed.status, "review_ready");
  assert.equal(completed.candidates.length, 5);
  assert.equal(completed.candidates[4].display_label, "经典回顾 · 非本月新论文");
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].length, 5);
  assert.equal(completed.mineru.status, "ready");
  assert.equal(Object.values(completed.mineru.papers).every((paper) => paper.status === "ready"), true);
  assert.equal(resultDownloads, 5);
  assert.equal(maxPdfDownloads, 3);
  const eventPage = await runStore.readEvents(started.run_id);
  assert.equal(
    eventPage.events.filter((event) => event.type === "pdf_paper_prepared").length,
    5,
  );

  await service.resumeRun(started.run_id);
  const resumed = await service.waitForRun(started.run_id);
  assert.equal(resumed.mineru.status, "ready");
  assert.equal(resultDownloads, 5);
});

test("refreshRunCandidates appends this-month papers and records refresh state", async () => {
  const { dataDir, runStore, runId } = await createReadyGuideRun("pi-agent-refresh-");
  const sourceStateStore = createSourceStateStore({ dataDir });
  let commitCalls = 0;
  const service = createJournalWorkflowService({
    env: { PI_DATA_DIR: dataDir, PI_MODEL_MODE: "fixture" },
    dataDir,
    runStore,
    sourceStateStore,
    sourceScanner: async ({ scanKey, deferCursorCommit }) => {
      assert.ok(scanKey, "refresh scan must pass a scanKey");
      assert.equal(deferCursorCommit, true);
      return {
        summary: {
          observed_at: "2026-08-03T00:05:00.000Z",
          source_count: 11,
          successful_source_count: 11,
          failed_source_ids: [],
        },
        candidateBatch: {
          mode: "new_papers",
          candidates: [
            {
              paper_id: "fresh-1",
              dedupe_key: "key-fresh-1",
              title: "A Fresh Monthly Paper",
              authors: ["A. Author"],
              venue: "ACL",
              published_at: "2026-07-20",
              abstract: "Fresh abstract.",
              topic_matches: ["LLM Agent"],
              published_this_month: true,
              candidate_scope: "field",
              display_label: "本月新论文 · 领域视野",
              pdf_url: "https://papers.example/fresh-1.pdf",
            },
            {
              paper_id: "paper-1",
              dedupe_key: "key-paper-1",
              title: "Paper 1",
              published_this_month: true,
            },
          ],
        },
        cursor_commit_pending: true,
      };
    },
    sourceScanCommitter: async ({ scanKey, requiredArtifacts }) => {
      commitCalls += 1;
      assert.ok(scanKey);
      assert.deepEqual(requiredArtifacts, ["outputs/candidates-applied.json"]);
      const appliedRun = await runStore.getRun(runId);
      assert.ok(appliedRun.candidates.some((paper) => paper.paper_id === "fresh-1"));
      const marker = await runStore.readArtifact(
        runId,
        `refresh/${scanKey}/outputs/candidates-applied.json`,
      );
      assert.deepEqual(marker.paper_ids, ["fresh-1"]);
    },
  });

  const refreshed = await service.refreshRunCandidates(runId);
  const freshIds = refreshed.candidates.map((paper) => paper.paper_id);
  assert.ok(freshIds.includes("fresh-1"));
  assert.equal(freshIds.filter((id) => id === "paper-1").length, 1);
  assert.equal(refreshed.candidate_refresh.last_added_count, 1);
  assert.ok(refreshed.candidate_refresh.last_refreshed_at);
  assert.equal(
    refreshed.candidate_refresh.last_scan_observed_at,
    "2026-08-03T00:05:00.000Z",
  );
  assert.equal(
    refreshed.candidates.find((paper) => paper.paper_id === "fresh-1").display_label,
    "本月新论文 · 领域视野",
  );
  assert.equal(commitCalls, 1);
});

test("refreshRunCandidates does not append after the run leaves candidate review", async () => {
  const { dataDir, runStore, runId } = await createReadyGuideRun("pi-agent-refresh-race-");
  let commitCalls = 0;
  const service = createJournalWorkflowService({
    env: { PI_DATA_DIR: dataDir, PI_MODEL_MODE: "fixture" },
    dataDir,
    runStore,
    sourceStateStore: createSourceStateStore({ dataDir }),
    sourceScanner: async () => {
      await runStore.updateRun(runId, { status: "guide_ready", phase: "guide_review" });
      return {
        summary: {},
        candidateBatch: {
          mode: "new_papers",
          candidates: [{
            paper_id: "too-late",
            dedupe_key: "key-too-late",
            title: "A Paper That Arrived Too Late",
            published_this_month: true,
          }],
        },
        cursor_commit_pending: true,
      };
    },
    sourceScanCommitter: async () => {
      commitCalls += 1;
    },
  });

  await assert.rejects(
    service.refreshRunCandidates(runId),
    (error) => error.code === "WEEKLY_RUN_NOT_READY" && error.status === 409,
  );
  const current = await runStore.getRun(runId);
  assert.equal(current.status, "guide_ready");
  assert.equal(current.candidates.some((paper) => paper.paper_id === "too-late"), false);
  assert.equal(current.candidate_refresh, undefined);
  assert.equal(commitCalls, 0);
});

test("refreshRunCandidates resumes a failed cursor commit without rescanning or duplicating", async () => {
  const { dataDir, runStore, runId } = await createReadyGuideRun("pi-agent-refresh-resume-");
  let scanCalls = 0;
  let translationCalls = 0;
  let commitCalls = 0;
  const service = createJournalWorkflowService({
    env: {
      PI_DATA_DIR: dataDir,
      PI_MODEL_MODE: "live",
    },
    dataDir,
    runStore,
    sourceStateStore: createSourceStateStore({ dataDir }),
    modelProviders: {
      completeStructured: async ({ input }) => {
        translationCalls += 1;
        return {
          value: {
            translations: input.items.map((item) => ({ id: item.id, zh: `中文:${item.text}` })),
          },
        };
      },
    },
    sourceScanner: async () => {
      scanCalls += 1;
      return {
        summary: {},
        candidateBatch: {
          mode: "new_papers",
          candidates: [{
            paper_id: "recoverable-paper",
            dedupe_key: "key-recoverable-paper",
            title: "A Recoverable Refresh Paper",
            abstract: "A durable refresh result.",
            published_this_month: true,
            display_label: "本月新论文",
          }],
        },
        cursor_commit_pending: true,
      };
    },
    sourceScanCommitter: async ({ scanKey }) => {
      commitCalls += 1;
      await runStore.readArtifact(
        runId,
        `refresh/${scanKey}/outputs/candidates-applied.json`,
      );
      if (commitCalls === 1) {
        const error = new Error("FINALIZATION_INTERRUPTED");
        error.code = "FINALIZATION_INTERRUPTED";
        error.retryable = true;
        throw error;
      }
    },
  });

  await assert.rejects(service.refreshRunCandidates(runId), /FINALIZATION_INTERRUPTED/);
  const interrupted = await runStore.getRun(runId);
  assert.equal(interrupted.candidate_refresh.last_added_count, 1);
  assert.ok(interrupted.candidate_refresh.last_applied_at);
  assert.equal(interrupted.candidate_refresh.last_refreshed_at, undefined);
  assert.equal(interrupted.candidates.filter(
    (paper) => paper.paper_id === "recoverable-paper",
  ).length, 1);

  const recovered = await service.refreshRunCandidates(runId);
  assert.ok(recovered.candidate_refresh.last_refreshed_at);
  assert.equal(recovered.candidate_refresh.last_error, null);
  assert.equal(recovered.candidates.filter(
    (paper) => paper.paper_id === "recoverable-paper",
  ).length, 1);
  const recoveredPaper = recovered.candidates.find(
    (paper) => paper.paper_id === "recoverable-paper",
  );
  assert.equal(recoveredPaper.title_zh, "中文:A Recoverable Refresh Paper");
  assert.equal(recoveredPaper.abstract_zh, "中文:A durable refresh result.");
  assert.equal(recoveredPaper.selection_summary, "中文:A durable refresh result.");
  assert.equal(
    recovered.candidate_refresh.language_artifact.provenance.model_id,
    "gpt-5.3-codex-spark",
  );
  assert.equal(scanCalls, 1);
  assert.equal(translationCalls, 1);
  assert.equal(commitCalls, 2);
});

test("refreshRunCandidates honors a paper dismissed while translation is running", async () => {
  const { dataDir, runStore, runId } = await createReadyGuideRun("pi-agent-refresh-dismiss-");
  let dismissedKeys = [];
  let releaseTranslation;
  const translationStarted = new Promise((resolve) => {
    releaseTranslation = resolve;
  });
  let continueTranslation;
  const translationBarrier = new Promise((resolve) => {
    continueTranslation = resolve;
  });
  const service = createJournalWorkflowService({
    env: { PI_DATA_DIR: dataDir, PI_MODEL_MODE: "live" },
    dataDir,
    runStore,
    sourceStateStore: createSourceStateStore({ dataDir }),
    dismissedPapersStore: {
      listKeys: async () => [...dismissedKeys],
    },
    modelProviders: {
      completeStructured: async ({ input }) => {
        releaseTranslation();
        await translationBarrier;
        return {
          value: {
            translations: input.items.map((item) => ({ id: item.id, zh: `中文:${item.text}` })),
          },
        };
      },
    },
    sourceScanner: async () => ({
      summary: { observed_at: "2026-08-03T00:10:00.000Z" },
      candidateBatch: {
        mode: "new_papers",
        candidates: [{
          paper_id: "dismissed-during-refresh",
          dedupe_key: "key-dismissed-during-refresh",
          title: "Dismiss This Paper",
          published_this_month: true,
        }],
      },
      cursor_commit_pending: true,
    }),
    sourceScanCommitter: async ({ scanKey }) => {
      const marker = await runStore.readArtifact(
        runId,
        `refresh/${scanKey}/outputs/candidates-applied.json`,
      );
      assert.equal(marker.added_count, 0);
    },
  });

  const refresh = service.refreshRunCandidates(runId);
  await translationStarted;
  dismissedKeys = ["key-dismissed-during-refresh"];
  continueTranslation();
  const refreshed = await refresh;
  assert.equal(refreshed.candidate_refresh.last_added_count, 0);
  assert.equal(
    refreshed.candidate_refresh.last_scan_observed_at,
    "2026-08-03T00:10:00.000Z",
  );
  assert.equal(refreshed.candidates.some(
    (paper) => paper.paper_id === "dismissed-during-refresh",
  ), false);
});

test("translateJournalRunLibrary backfills Chinese titles and abstracts via Codex 5.3 Spark", async () => {
  const { dataDir, runStore, runId } = await createReadyGuideRun("pi-agent-translate-lib-");
  await writeFile(path.join(dataDir, "project_state.md"), [
    "# 项目状态",
    "",
    "## 当前目标",
    "",
    "构建可核验的论文工作流。",
    "",
    "## 已确认决定",
    "",
    "- 中文展示使用固定语言服务。",
    "",
    "## 开放问题",
    "",
    "- 如何核验项目作用？",
    "",
    "## 下一步",
    "",
    "- 回填历史论文。",
  ].join("\n"), "utf8");
  const beforeTranslation = await runStore.getRun(runId);
  await runStore.updateRun(runId, {
    candidates: beforeTranslation.candidates.map((paper, index) => index === 0
      ? {
          ...paper,
          selection_summary: "A concise explanation of the paper contribution.",
          project_impact: "Useful for verifiable workflow design.",
        }
      : paper),
    recent_classics: {
      schema_version: 1,
      status: "success",
      papers: [{
        paper_id: "rc-1",
        dedupe_key: "key-rc-1",
        title: "A Novel Benchmark for Urban Scene Understanding",
        abstract: "We introduce a new dataset for 2D and 3D scene understanding.",
      }],
    },
  });
  const sourceStateStore = createSourceStateStore({ dataDir });
  let usedModelId = null;
  let usedReasoningEffort = null;
  let translationCalls = 0;
  let insertedConcurrentCandidate = false;
  const service = createJournalWorkflowService({
    env: {
      PI_DATA_DIR: dataDir,
      PI_PROJECT_ROOT: dataDir,
      PI_MODEL_MODE: "live",
    },
    dataDir,
    runStore,
    sourceStateStore,
    modelRegistry: supportedModelRegistry(),
    modelProviders: {
      supports: () => true,
      completeStructured: async ({ input, schema, modelId, reasoningEffort }) => {
        translationCalls += 1;
        usedModelId = modelId;
        usedReasoningEffort = reasoningEffort;
        if (!insertedConcurrentCandidate) {
          insertedConcurrentCandidate = true;
          const current = await runStore.getRun(runId);
          await runStore.updateRun(runId, {
            candidates: [{
              paper_id: "late-candidate",
              dedupe_key: "key-late-candidate",
              title: "Inserted While Translation Was Running",
            }, ...(current.candidates ?? [])],
          });
        }
        if (Object.hasOwn(schema.properties, "impacts")) {
          return {
            value: {
              impacts: input.papers.map((paper) => ({
                request_id: paper.request_id,
                project_impact: "可用于核验当前项目的论文工作流。",
              })),
            },
            provider_id: "codex-subscription",
            model_id: modelId,
            operation_id: "op-impact",
            usage: null,
          };
        }
        return {
          value: { translations: input.items.map((item) => ({ id: item.id, zh: `中文:${item.text.slice(0, 8)}` })) },
          provider_id: "codex-subscription",
          model_id: modelId,
          operation_id: "op-tr",
          usage: null,
        };
      },
    },
  });

  const [translated, duplicate] = await Promise.all([
    service.translateJournalRunLibrary(runId),
    service.translateJournalRunLibrary(runId),
  ]);
  assert.equal(usedModelId, "gpt-5.3-codex-spark");
  assert.equal(usedReasoningEffort, "low");
  assert.equal(translationCalls, 3);
  assert.equal(duplicate.updated_at, translated.updated_at);
  assert.ok(translated.recent_classics.papers[0].title_zh?.startsWith("中文:"));
  assert.ok(translated.recent_classics.papers[0].abstract_zh?.startsWith("中文:"));
  assert.equal(
    translated.recent_classics.papers[0].project_impact,
    "可用于核验当前项目的论文工作流。",
  );
  assert.equal(
    translated.candidates.find((paper) => paper.paper_id === "late-candidate")?.title_zh,
    null,
  );
  assert.ok(translated.candidates
    .filter((paper) => paper.paper_id !== "late-candidate")
    .every((paper) => paper.title_zh?.startsWith("中文:")));
  assert.ok(translated.candidates
    .filter((paper) => paper.paper_id !== "late-candidate")
    .every((paper) => paper.abstract_zh?.startsWith("中文:")));
  assert.ok(translated.candidates[1].selection_summary?.startsWith("中文:"));
  assert.ok(translated.candidates[1].project_impact?.startsWith("中文:"));
  assert.equal(translated.library_translation.provenance.provider_id, "codex-subscription");
  assert.equal(translated.library_translation.provenance.model_id, "gpt-5.3-codex-spark");
  assert.equal(translated.library_translation.provenance.reasoning_effort, "low");
});

test("addPastRunPapersToWeekly moves an unread past paper into the current-month run", async () => {
  const { dataDir, runStore, runId } = await createReadyGuideRun("pi-agent-past-add-");
  const sourceStateStore = createSourceStateStore({ dataDir });
  const sourceRun = await runStore.createRun();
  await runStore.updateRun(sourceRun.run_id, {
    status: "completed",
    candidates: [{
      paper_id: "past-1",
      dedupe_key: "key-past-1",
      title: "An Unread Past Paper",
      authors: ["A. Author"],
      venue: "NeurIPS",
      published_at: "2026-05-01",
      abstract: "Past abstract.",
      abstract_zh: "往期中文摘要。",
      rank: 1,
    }],
  });
  const service = createJournalWorkflowService({
    env: { PI_DATA_DIR: dataDir, PI_MODEL_MODE: "fixture" },
    dataDir,
    runStore,
    sourceStateStore,
  });

  const updated = await service.addPastRunPapersToWeekly({
    sourceRunId: sourceRun.run_id,
    paperIds: ["past-1"],
  });
  assert.equal(updated.run_id, runId);
  const added = updated.candidates.find((paper) => paper.paper_id === "past-1");
  assert.ok(added);
  assert.equal(added.candidate_origin, "resurfaced_unread");
  assert.equal(added.selection_summary, "往期中文摘要。");
  assert.equal(updated.mineru.papers["past-1"].status, "pdf_not_prepared");
});

test("addPastRunPapersToWeekly rejects a paper already read in the source run", async () => {
  const { dataDir, runStore } = await createReadyGuideRun("pi-agent-past-handled-");
  const sourceStateStore = createSourceStateStore({ dataDir });
  const sourceRun = await runStore.createRun();
  await runStore.updateRun(sourceRun.run_id, {
    status: "completed",
    candidates: [{
      paper_id: "past-read-1",
      dedupe_key: "key-past-read-1",
      title: "An Already Read Paper",
    }],
    paper_decisions: { "past-read-1": "read" },
  });
  const service = createJournalWorkflowService({
    env: { PI_DATA_DIR: dataDir, PI_MODEL_MODE: "fixture" },
    dataDir,
    runStore,
    sourceStateStore,
  });

  await assert.rejects(
    service.addPastRunPapersToWeekly({
      sourceRunId: sourceRun.run_id,
      paperIds: ["past-read-1"],
    }),
    (error) => error.code === "PAST_PAPER_ALREADY_HANDLED",
  );
});

test("live workflow fails closed before ranking or cursor commit when project state is missing", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-live-context-"));
  const runStore = createRunStore({ dataDir });
  const sourceStateStore = createSourceStateStore({ dataDir });
  let rankingCalls = 0;
  let commitCalls = 0;
  let pdfCalls = 0;
  const service = createJournalWorkflowService({
    env: {
      PI_DATA_DIR: dataDir,
      PI_MODEL_MODE: "live",
      PI_PROJECT_ROOT: dataDir,
      PI_PROJECT_STATE_PATH: "project_state.md",
    },
    dataDir,
    runStore,
    sourceStateStore,
    sourceScanner: async () => ({
      summary: {
        source_count: 11,
        successful_source_count: 11,
        failed_source_ids: [],
      },
      candidateBatch: {
        mode: "new_papers",
        candidates: candidates(),
      },
      cursor_commit_pending: true,
    }),
    sourceScanCommitter: async () => {
      commitCalls += 1;
    },
    candidateRanker: async () => {
      rankingCalls += 1;
      return { candidates: candidates(), source: "model" };
    },
    pdfDownloader: async () => {
      pdfCalls += 1;
      throw new Error("must not download");
    },
    mineruAdapter: null,
  });

  const started = await service.startRun();
  const failed = await service.waitForRun(started.run_id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.phase, "failed");
  assert.equal(
    failed.last_error.code,
    "PROJECT_STATE_NOT_CONFIGURED",
  );
  assert.equal(rankingCalls, 0);
  assert.equal(commitCalls, 0);
  assert.equal(pdfCalls, 0);
  assert.deepEqual(failed.candidates, []);
  assert.equal((await sourceStateStore.load()).revision, 0);
});

test("workflow stays reviewable when MinerU is not configured", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-workflow-no-mineru-"));
  const runStore = createRunStore({ dataDir });
  const service = createJournalWorkflowService({
    env: { PI_DATA_DIR: dataDir, PI_MODEL_MODE: "fixture" },
    dataDir,
    runStore,
    sourceStateStore: createSourceStateStore({ dataDir }),
    sourceScanner: async () => ({
      summary: { source_count: 11, successful_source_count: 11, failed_source_ids: [] },
      candidateBatch: { mode: "classic_review", candidates: candidates() },
    }),
    candidateRanker: async ({ papers }) => ({
      candidates: papers.map((paper, index) => ({
        ...paper,
        rank: index + 1,
        selection_summary: "一条足够长的经典论文选择说明。",
        project_impact: "与项目相关。",
      })),
      source: "deterministic",
    }),
    pdfDownloader: async ({ paperId, outputDir }) => {
      const filePath = path.join(outputDir, `${paperId}.pdf`);
      await writeFile(filePath, "%PDF-1.7\nmock");
      return { file_path: filePath, sha256: "hash", byte_length: 13 };
    },
    mineruAdapter: null,
  });
  const started = await service.startRun();
  const completed = await service.waitForRun(started.run_id);
  assert.equal(completed.status, "review_ready");
  assert.equal(completed.mineru.status, "not_configured");
});

test("resumeRun re-executes a run interrupted during the source scan", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-resume-scan-"));
  const runStore = createRunStore({ dataDir });
  const interrupted = await runStore.createRun({ sourceIds: ["source-ok"] });
  await runStore.updateRun(interrupted.run_id, {
    source_progress: {
      total_count: 11,
      completed_source_ids: ["journal-ai", "journal-tpami", "journal-ijcv", "journal-jmlr"],
      successful_source_ids: ["journal-ai", "journal-tpami", "journal-ijcv", "journal-jmlr"],
      failed_source_ids: [],
    },
  });
  let scannerCalls = 0;
  const service = createJournalWorkflowService({
    env: { PI_DATA_DIR: dataDir, PI_MODEL_MODE: "fixture" },
    dataDir,
    runStore,
    sourceStateStore: createSourceStateStore({ dataDir }),
    sourceScanner: async () => {
      scannerCalls += 1;
      return {
        summary: { source_count: 11, successful_source_count: 11, failed_source_ids: [] },
        candidateBatch: { mode: "classic_review", candidates: candidates() },
      };
    },
    candidateRanker: async ({ papers }) => ({
      candidates: papers.map((paper, index) => ({
        ...paper,
        rank: index + 1,
        selection_summary: "一条足够长的经典论文选择说明。",
        project_impact: "与项目相关。",
      })),
      source: "deterministic",
    }),
    pdfDownloader: async ({ paperId, outputDir }) => {
      const filePath = path.join(outputDir, `${paperId}.pdf`);
      await writeFile(filePath, "%PDF-1.7\nmock");
      return { file_path: filePath, sha256: "hash", byte_length: 13 };
    },
    mineruAdapter: null,
  });

  const stuck = await runStore.getRun(interrupted.run_id);
  assert.equal(stuck.status, "scanning");
  const resumed = await service.resumeRun(interrupted.run_id);
  assert.equal(resumed.run_id, interrupted.run_id);
  const completed = await service.waitForRun(interrupted.run_id);
  assert.equal(completed.status, "review_ready");
  assert.equal(scannerCalls, 1);

  const again = await service.resumeRun(interrupted.run_id);
  assert.equal(again.status, "review_ready");
  assert.equal(scannerCalls, 1);
});

test("one failed paper can retry without reprocessing papers that are already ready", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-paper-retry-"));
  const runStore = createRunStore({ dataDir });
  const run = await runStore.createRun();
  const papers = candidates();
  await runStore.updateRun(run.run_id, {
    status: "review_ready",
    phase: "candidate_review",
    candidates: papers,
    mineru: {
      status: "partial",
      batch_id: "old-batch",
      papers: Object.fromEntries(papers.map((paper, index) => [
        paper.paper_id,
        index === 4
          ? {
              status: "pdf_failed",
              error: { code: "PDF_DOWNLOAD_FAILED", retryable: true },
            }
          : {
              status: "ready",
              markdown_chars: 100,
              image_count: 0,
            },
      ])),
    },
  });
  const submitted = [];
  const service = createJournalWorkflowService({
    env: {
      PI_DATA_DIR: dataDir,
      PI_MODEL_MODE: "fixture",
      PI_MINERU_API_TOKEN: "token",
      PI_MINERU_POLL_INTERVAL_MS: "1",
      PI_MINERU_TIMEOUT_MS: "1000",
    },
    dataDir,
    runStore,
    sourceStateStore: createSourceStateStore({ dataDir }),
    pdfDownloader: async ({ paperId, outputDir }) => {
      const filePath = path.join(outputDir, `${paperId}.pdf`);
      await writeFile(filePath, "%PDF-1.7\nretry");
      return {
        file_path: filePath,
        sha256: `hash-${paperId}`,
        byte_length: 14,
      };
    },
    mineruAdapter: {
      submitBatch: async (files) => {
        submitted.push(files.map((file) => file.dataId));
        return {
          batchId: "retry-batch",
          state: "uploaded",
          uploads: files.map((file) => ({
            dataId: file.dataId,
            fileName: file.fileName,
            state: "uploaded",
            error: null,
          })),
        };
      },
      getBatch: async () => ({
        batchId: "retry-batch",
        state: "done",
        items: [{
          dataId: "paper-5",
          fileName: "paper-5.pdf",
          state: "done",
          fullZipUrl: "https://mineru.example/paper-5.zip",
          progress: null,
          error: null,
        }],
      }),
      downloadResult: async () => ({
        markdown: "# Paper 5\n\nRecovered.",
        images: [],
      }),
    },
  });

  const retrying = await service.retryPaperDocument(run.run_id, "paper-5", {
    clientRequestId: "retry-paper-5",
  });
  assert.equal(retrying.mineru.papers["paper-5"].status, "pdf_retrying");
  assert.equal(
    retrying.mineru.papers["paper-5"].retry_request_id,
    "retry-paper-5",
  );
  let completed;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    completed = await runStore.getRun(run.run_id);
    if (completed.mineru.papers["paper-5"].status === "ready") break;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(completed.mineru.status, "ready");
  assert.equal(completed.mineru.papers["paper-5"].status, "ready");
  assert.deepEqual(submitted, [["paper-5"]]);
  assert.equal(
    papers.slice(0, 4).every(
      (paper) => completed.mineru.papers[paper.paper_id].status === "ready",
    ),
    true,
  );
});

test("workflow stays reviewable when none of the five PDFs can be downloaded", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-workflow-no-pdf-"));
  const runStore = createRunStore({ dataDir });
  const service = createJournalWorkflowService({
    env: { PI_DATA_DIR: dataDir, PI_MODEL_MODE: "fixture" },
    dataDir,
    runStore,
    sourceStateStore: createSourceStateStore({ dataDir }),
    sourceScanner: async () => ({
      summary: { source_count: 11, successful_source_count: 11, failed_source_ids: [] },
      candidateBatch: { mode: "new_papers", candidates: candidates() },
    }),
    candidateRanker: async ({ papers }) => ({
      candidates: papers.map((paper, index) => ({
        ...paper,
        rank: index + 1,
        selection_summary: "一条足够长的论文选择说明。",
        project_impact: "与项目相关。",
      })),
      source: "deterministic",
    }),
    pdfDownloader: async () => {
      throw new Error("PDF_URL_UNAVAILABLE");
    },
    mineruAdapter: null,
  });

  const started = await service.startRun();
  const completed = await service.waitForRun(started.run_id);

  assert.equal(completed.status, "review_ready");
  assert.equal(completed.phase, "candidate_review");
  assert.equal(completed.mineru.status, "unavailable");
  assert.equal(
    Object.values(completed.mineru.papers).every((paper) => paper.status === "pdf_failed"),
    true,
  );
});

test("concurrent starts reuse one active project-week run and execute one scan", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-workflow-dedupe-"));
  const runStore = createRunStore({ dataDir });
  let scanCount = 0;
  const service = createJournalWorkflowService({
    env: { PI_DATA_DIR: dataDir, PI_MODEL_MODE: "fixture" },
    dataDir,
    runStore,
    sourceStateStore: createSourceStateStore({ dataDir }),
    sourceScanner: async () => {
      scanCount += 1;
      return {
        summary: { source_count: 11, successful_source_count: 11, failed_source_ids: [] },
        candidateBatch: { mode: "new_papers", candidates: candidates() },
      };
    },
    candidateRanker: async ({ papers }) => ({
      candidates: papers.map((paper, index) => ({
        ...paper,
        rank: index + 1,
        selection_summary: "一条足够长的论文选择说明。",
        project_impact: "与项目相关。",
      })),
      source: "deterministic",
    }),
    pdfDownloader: async () => {
      throw new Error("PDF_URL_UNAVAILABLE");
    },
    mineruAdapter: null,
  });

  const [first, second] = await Promise.all([
    service.startRun(),
    service.startRun(),
  ]);
  await service.waitForRun(first.run_id);

  assert.equal(first.run_id, second.run_id);
  assert.equal(scanCount, 1);
});

test("a run paused before MinerU submission can resume after the token is configured", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-workflow-resume-mineru-"));
  const runStore = createRunStore({ dataDir });
  const sourceStateStore = createSourceStateStore({ dataDir });
  const sourceScanner = async () => ({
    summary: { source_count: 11, successful_source_count: 11, failed_source_ids: [] },
    candidateBatch: { mode: "new_papers", candidates: candidates() },
  });
  const candidateRanker = async ({ papers }) => ({
    candidates: papers.map((paper, index) => ({
      ...paper,
      rank: index + 1,
      selection_summary: "一条足够长的论文选择说明。",
      project_impact: "与项目相关。",
    })),
    source: "deterministic",
  });
  const pdfDownloader = async ({ paperId, outputDir }) => {
    const filePath = path.join(outputDir, `${paperId}.pdf`);
    await writeFile(filePath, "%PDF-1.7\nmock");
    return { file_path: filePath, sha256: `hash-${paperId}`, byte_length: 13 };
  };
  const withoutMineru = createJournalWorkflowService({
    env: { PI_DATA_DIR: dataDir, PI_MODEL_MODE: "fixture" },
    dataDir,
    runStore,
    sourceStateStore,
    sourceScanner,
    candidateRanker,
    pdfDownloader,
    mineruAdapter: null,
  });
  const started = await withoutMineru.startRun();
  const paused = await withoutMineru.waitForRun(started.run_id);
  assert.equal(paused.mineru.status, "not_configured");

  const withMineru = createJournalWorkflowService({
    env: {
      PI_DATA_DIR: dataDir,
      PI_MODEL_MODE: "fixture",
      PI_MINERU_API_TOKEN: "token",
      PI_MINERU_POLL_INTERVAL_MS: "1",
      PI_MINERU_TIMEOUT_MS: "1000",
    },
    dataDir,
    runStore,
    sourceStateStore,
    sourceScanner,
    candidateRanker,
    pdfDownloader,
    mineruAdapter: {
      submitBatch: async (files) => ({
        batchId: "batch-resumed",
        state: "uploaded",
        uploads: files.map((file) => ({
          dataId: file.dataId,
          fileName: file.fileName,
          state: "uploaded",
          error: null,
        })),
      }),
      getBatch: async () => ({
        batchId: "batch-resumed",
        state: "done",
        items: candidates().map((paper) => ({
          dataId: paper.paper_id,
          fileName: `${paper.paper_id}.pdf`,
          state: "done",
          fullZipUrl: `https://mineru.example/${paper.paper_id}.zip`,
          progress: null,
          error: null,
        })),
      }),
      downloadResult: async () => ({ markdown: "# Parsed\n\nContent.", images: [] }),
    },
  });

  const resuming = await withMineru.resumeRun(started.run_id);
  assert.equal(resuming.status, "preparing_documents");
  const completed = await withMineru.waitForRun(started.run_id);
  assert.equal(completed.status, "review_ready");
  assert.equal(completed.mineru.status, "ready");
});

test("a failed PDF upload stays failed when MinerU reports waiting-file", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-workflow-partial-upload-"));
  const runStore = createRunStore({ dataDir });
  const papers = candidates();
  const service = createJournalWorkflowService({
    env: {
      PI_DATA_DIR: dataDir,
      PI_MODEL_MODE: "fixture",
      PI_MINERU_API_TOKEN: "token",
      PI_MINERU_POLL_INTERVAL_MS: "1",
      PI_MINERU_TIMEOUT_MS: "1000",
    },
    dataDir,
    runStore,
    sourceStateStore: createSourceStateStore({ dataDir }),
    sourceScanner: async () => ({
      summary: { source_count: 11, successful_source_count: 11, failed_source_ids: [] },
      candidateBatch: { mode: "new_papers", candidates: papers },
    }),
    candidateRanker: async ({ papers: rankedPapers }) => ({
      candidates: rankedPapers.map((paper, index) => ({
        ...paper,
        rank: index + 1,
        selection_summary: "一条足够长的论文选择说明。",
        project_impact: "与项目相关。",
      })),
      source: "deterministic",
    }),
    pdfDownloader: async ({ paperId, outputDir }) => {
      const filePath = path.join(outputDir, `${paperId}.pdf`);
      await writeFile(filePath, "%PDF-1.7\nmock");
      return { file_path: filePath, sha256: `hash-${paperId}`, byte_length: 13 };
    },
    mineruAdapter: {
      submitBatch: async (files) => ({
        batchId: "batch-partial",
        state: "partial",
        uploads: files.map((file, index) => ({
          dataId: file.dataId,
          fileName: file.fileName,
          state: index === files.length - 1 ? "failed" : "uploaded",
          error: index === files.length - 1
            ? { code: "MINERU_UPSTREAM_RETRYABLE", retryable: true }
            : null,
        })),
      }),
      getBatch: async () => ({
        batchId: "batch-partial",
        state: "partial",
        items: papers.map((paper, index) => ({
          dataId: paper.paper_id,
          fileName: `${paper.paper_id}.pdf`,
          state: index === papers.length - 1 ? "waiting-file" : "done",
          fullZipUrl: index === papers.length - 1
            ? null
            : `https://mineru.example/${paper.paper_id}.zip`,
          progress: null,
          error: null,
        })),
      }),
      downloadResult: async () => ({ markdown: "# Parsed\n\nContent.", images: [] }),
    },
  });

  const started = await service.startRun();
  const completed = await service.waitForRun(started.run_id);

  assert.equal(completed.status, "review_ready");
  assert.equal(completed.mineru.status, "partial");
  assert.equal(completed.mineru.papers["paper-5"].status, "mineru_upload_failed");

  await runStore.updateRun(started.run_id, (current) => ({
    mineru: {
      ...current.mineru,
      papers: {
        ...current.mineru.papers,
        "paper-5": {
          ...current.mineru.papers["paper-5"],
          status: "mineru_waiting-file",
          error: null,
        },
      },
    },
  }));
  await service.resumeRun(started.run_id);
  const resumed = await service.waitForRun(started.run_id);
  assert.equal(resumed.status, "review_ready");
  assert.equal(resumed.mineru.papers["paper-5"].status, "mineru_upload_failed");
  assert.equal(resumed.mineru.papers["paper-5"].error.code, "MINERU_UPLOAD_INCOMPLETE");
});

test("paper document and PDF reads are scoped to an exact run candidate", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-paper-artifacts-"));
  const runStore = createRunStore({ dataDir });
  const run = await runStore.createRun();
  const paperId = "paper-document";
  const markdown = "# Paper Document\n\n## Introduction\n\nOriginal paragraph.\n";
  const pdf = Buffer.from("%PDF-1.7\npaper document\n", "utf8");
  const pdfSha256 = createHash("sha256").update(pdf).digest("hex");
  await runStore.updateRun(run.run_id, {
    status: "review_ready",
    phase: "candidate_review",
    candidates: [{
      paper_id: paperId,
      title: "Paper Document",
      authors: ["Ada Author"],
      venue: "ACL",
      published_at: "2026-07-23",
    }],
    mineru: {
      status: "ready",
      batch_id: "batch-document",
      papers: {
        [paperId]: {
          status: "ready",
          pdf_sha256: pdfSha256,
          pdf_bytes: pdf.length,
        },
      },
    },
  });
  await runStore.writeArtifact(run.run_id, `extraction/${paperId}/paper.md`, markdown);
  await runStore.writeArtifact(run.run_id, `extraction/${paperId}/manifest.json`, {
    schema_version: 1,
    paper_id: paperId,
    markdown_chars: markdown.length,
    image_count: 0,
  });
  const pdfDirectory = path.join(dataDir, "cache", "pdfs");
  const pdfPath = path.join(pdfDirectory, `${paperId}.pdf`);
  await mkdir(pdfDirectory, { recursive: true });
  await writeFile(pdfPath, pdf);
  await writeFile(`${pdfPath}.json`, JSON.stringify({
    schema_version: 1,
    paper_id: paperId,
    file_name: `${paperId}.pdf`,
    byte_length: pdf.length,
    sha256: pdfSha256,
  }));

  const service = createJournalWorkflowService({
    env: { PI_DATA_DIR: dataDir, PI_MODEL_MODE: "fixture" },
    dataDir,
    runStore,
    sourceStateStore: createSourceStateStore({ dataDir }),
    mineruAdapter: null,
  });

  const document = await service.getPaperDocument(run.run_id, paperId);
  assert.equal(document.title, "Paper Document");
  assert.equal(document.blocks.map((block) => block.markdown).join(""), markdown);
  assert.match(document.revision, /^sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(document).includes(dataDir), false);
  assert.equal(document.links.original_pdf.endsWith(`/${paperId}/pdf`), true);

  const resolvedPdf = await service.getPaperPdf(run.run_id, paperId);
  assert.equal(resolvedPdf.byte_length, pdf.length);
  assert.equal(resolvedPdf.sha256, pdfSha256);
  await assert.rejects(
    service.getPaperDocument(run.run_id, "paper-not-in-run"),
    (error) => error.code === "PAPER_NOT_FOUND" && error.status === 404,
  );

  await writeFile(`${pdfPath}.json`, JSON.stringify({
    schema_version: 1,
    paper_id: paperId,
    byte_length: pdf.length,
    sha256: "wrong",
  }));
  await assert.rejects(
    service.getPaperPdf(run.run_id, paperId),
    (error) => error.code === "PDF_CORRUPT" && error.status === 409,
  );
});

test("five-minute guides run in the background, persist JSON and Markdown, and expose enriched references", async () => {
  const { dataDir, runStore, runId } = await createReadyGuideRun();
  const generated = [];
  const service = createJournalWorkflowService({
    env: { PI_DATA_DIR: dataDir, PI_MODEL_MODE: "fixture" },
    dataDir,
    runStore,
    sourceStateStore: createSourceStateStore({ dataDir }),
    mineruAdapter: null,
    modelProviders: supportedModelRegistry(),
    guideGenerator: async (request) => {
      generated.push(request.paper.paper_id);
      return fixtureGuideResult(request);
    },
  });

  const started = await service.startGuides(runId, {
    paperIds: ["paper-1", "paper-2"],
    providerId: "codex-subscription",
    modelId: "account-default",
  });
  assert.equal(started.status, "preparing_guides");
  assert.equal(started.guides.status, "running");

  const completed = await service.waitForGuides(runId);
  assert.equal(completed.status, "guide_ready");
  assert.equal(completed.phase, "guide_review");
  assert.equal(completed.guides.status, "ready");
  assert.deepEqual(completed.guides.requested_paper_ids, ["paper-1", "paper-2"]);
  assert.deepEqual(generated, ["paper-1", "paper-2"]);
  assert.equal(completed.guides.papers["paper-1"].status, "ready");

  const artifact = await runStore.readArtifact(runId, "guides/paper-1.json");
  const markdown = await runStore.readArtifact(runId, "guides/paper-1.md");
  assert.equal(artifact.paper_id, "paper-1");
  assert.equal(artifact.revision, completed.guides.papers["paper-1"].revision);
  assert.match(markdown, /^# Paper 1 · 五分钟导读/m);

  const guide = await service.getPaperGuide(runId, "paper-1");
  assert.equal(guide.guide.paper_id, "paper-1");
  assert.equal(guide.references.length, 3);
  assert.deepEqual(guide.references[0].path, ["Paper 1", "Introduction"]);
  assert.equal(Number.isSafeInteger(guide.references[0].ordinal), true);
  assert.match(guide.references[0].excerpt, /Research problem/);
  assert.equal("page" in guide.references[0], false);
  assert.equal(JSON.stringify(guide).includes(dataDir), false);
});

test("concurrent guide requests for the same run merge without duplicate model work", async () => {
  const { dataDir, runStore, runId } = await createReadyGuideRun("pi-agent-guides-merge-");
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const generated = [];
  const service = createJournalWorkflowService({
    env: { PI_DATA_DIR: dataDir, PI_MODEL_MODE: "fixture" },
    dataDir,
    runStore,
    sourceStateStore: createSourceStateStore({ dataDir }),
    mineruAdapter: null,
    modelProviders: supportedModelRegistry(),
    guideGenerator: async (request) => {
      generated.push(request.paper.paper_id);
      if (request.paper.paper_id === "paper-1") await firstGate;
      return fixtureGuideResult(request);
    },
  });

  await service.startGuides(runId, {
    paperIds: ["paper-1"],
    providerId: "codex-subscription",
    modelId: "account-default",
  });
  await service.startGuides(runId, {
    paperIds: ["paper-1", "paper-2"],
    providerId: "codex-subscription",
    modelId: "account-default",
  });
  releaseFirst();

  const completed = await service.waitForGuides(runId);
  assert.equal(completed.status, "guide_ready");
  assert.deepEqual(completed.guides.requested_paper_ids, ["paper-1", "paper-2"]);
  assert.deepEqual(generated, ["paper-1", "paper-2"]);
});

test("a partial guide failure keeps successful artifacts and retries only failed work", async () => {
  const { dataDir, runStore, runId } = await createReadyGuideRun("pi-agent-guides-partial-");
  const callCounts = new Map();
  const service = createJournalWorkflowService({
    env: { PI_DATA_DIR: dataDir, PI_MODEL_MODE: "fixture" },
    dataDir,
    runStore,
    sourceStateStore: createSourceStateStore({ dataDir }),
    mineruAdapter: null,
    modelProviders: supportedModelRegistry(),
    guideGenerator: async (request) => {
      const count = (callCounts.get(request.paper.paper_id) ?? 0) + 1;
      callCounts.set(request.paper.paper_id, count);
      if (request.paper.paper_id === "paper-2" && count === 1) {
        throw new Error("MODEL_TEMPORARY_FAILURE");
      }
      return fixtureGuideResult(request);
    },
  });

  await service.startGuides(runId, {
    paperIds: ["paper-1", "paper-2"],
    providerId: "codex-subscription",
    modelId: "account-default",
  });
  const partial = await service.waitForGuides(runId);
  assert.equal(partial.status, "review_ready");
  assert.equal(partial.guides.status, "partial");
  assert.equal(partial.guides.papers["paper-1"].status, "ready");
  assert.equal(partial.guides.papers["paper-2"].status, "failed");
  assert.equal((await service.getPaperGuide(runId, "paper-1")).paper_id, "paper-1");
  await assert.rejects(
    service.getPaperGuide(runId, "paper-2"),
    (error) => error.code === "GUIDE_NOT_READY",
  );

  await service.startGuides(runId, {
    paperIds: ["paper-1", "paper-2"],
    providerId: "codex-subscription",
    modelId: "account-default",
  });
  const retried = await service.waitForGuides(runId);
  assert.equal(retried.status, "guide_ready");
  assert.equal(callCounts.get("paper-1"), 1);
  assert.equal(callCounts.get("paper-2"), 2);
});

test("default guide generation does not reuse an artifact from an older prompt version", async () => {
  const { dataDir, runStore, runId } = await createReadyGuideRun("pi-agent-guides-prompt-");
  const service = createJournalWorkflowService({
    env: { PI_DATA_DIR: dataDir, PI_MODEL_MODE: "fixture" },
    dataDir,
    runStore,
    sourceStateStore: createSourceStateStore({ dataDir }),
    mineruAdapter: null,
    modelProviders: supportedModelRegistry(),
  });

  await service.startGuides(runId, {
    paperIds: ["paper-1"],
    providerId: "codex-subscription",
    modelId: "account-default",
  });
  await service.waitForGuides(runId);
  const current = await runStore.readArtifact(runId, "guides/paper-1.json");
  await runStore.writeArtifact(runId, "guides/paper-1.json", {
    ...current,
    provenance: {
      ...current.provenance,
      prompt_version: "five-minute-guide.v2",
      prompt_hash: "sha256:old-prompt",
    },
  });

  await service.startGuides(runId, {
    paperIds: ["paper-1"],
    providerId: "codex-subscription",
    modelId: "account-default",
  });
  await service.waitForGuides(runId);
  const regenerated = await runStore.readArtifact(runId, "guides/paper-1.json");
  assert.equal(regenerated.provenance.prompt_version, "five-minute-guide.v3");
  assert.notEqual(regenerated.provenance.prompt_hash, "sha256:old-prompt");
});

test("guide reads reject cross-paper artifacts, unknown references, and stale revisions", async () => {
  const { dataDir, runStore, runId } = await createReadyGuideRun("pi-agent-guides-corrupt-");
  const service = createJournalWorkflowService({
    env: { PI_DATA_DIR: dataDir, PI_MODEL_MODE: "fixture" },
    dataDir,
    runStore,
    sourceStateStore: createSourceStateStore({ dataDir }),
    mineruAdapter: null,
    modelProviders: supportedModelRegistry(),
    guideGenerator: async (request) => fixtureGuideResult(request),
  });
  await service.startGuides(runId, {
    paperIds: ["paper-1", "paper-2"],
    providerId: "codex-subscription",
    modelId: "account-default",
  });
  await service.waitForGuides(runId);
  const paperOneArtifact = await runStore.readArtifact(runId, "guides/paper-1.json");
  const paperTwoArtifact = await runStore.readArtifact(runId, "guides/paper-2.json");

  await runStore.writeArtifact(runId, "guides/paper-2.json", paperOneArtifact);
  await assert.rejects(
    service.getPaperGuide(runId, "paper-2"),
    (error) => error.code === "GUIDE_CORRUPT",
  );

  await runStore.writeArtifact(runId, "guides/paper-2.json", paperTwoArtifact);
  await runStore.writeArtifact(runId, "guides/paper-1.json", {
    ...paperOneArtifact,
    guide: {
      ...paperOneArtifact.guide,
      evidence_refs: ["block-not-in-document"],
    },
  });
  await assert.rejects(
    service.getPaperGuide(runId, "paper-1"),
    (error) => error.code === "GUIDE_CORRUPT",
  );

  await runStore.writeArtifact(runId, "guides/paper-1.json", paperOneArtifact);
  const changedMarkdown = "# Paper 1\n\n## Changed\n\nA new revision.\n";
  await runStore.writeArtifact(runId, "extraction/paper-1/paper.md", changedMarkdown);
  await runStore.writeArtifact(runId, "extraction/paper-1/manifest.json", {
    schema_version: 1,
    paper_id: "paper-1",
    markdown_chars: changedMarkdown.length,
    image_count: 0,
  });
  await assert.rejects(
    service.getPaperGuide(runId, "paper-1"),
    (error) => error.code === "GUIDE_STALE",
  );
});

test("guide generation rejects papers without ready full text and unsupported models", async () => {
  const { dataDir, runStore, runId } = await createReadyGuideRun("pi-agent-guides-invalid-");
  await runStore.updateRun(runId, (current) => ({
    mineru: {
      ...current.mineru,
      papers: {
        ...current.mineru.papers,
        "paper-2": { status: "mineru_failed" },
      },
    },
  }));
  const service = createJournalWorkflowService({
    env: { PI_DATA_DIR: dataDir, PI_MODEL_MODE: "fixture" },
    dataDir,
    runStore,
    sourceStateStore: createSourceStateStore({ dataDir }),
    mineruAdapter: null,
    modelProviders: supportedModelRegistry(),
    guideGenerator: async (request) => fixtureGuideResult(request),
  });

  await assert.rejects(
    service.startGuides(runId, {
      paperIds: ["paper-2"],
      providerId: "codex-subscription",
      modelId: "account-default",
    }),
    (error) => error.code === "DOCUMENT_NOT_READY",
  );
  await assert.rejects(
    service.startGuides(runId, {
      paperIds: ["paper-1"],
      providerId: "deepseek",
      modelId: "unknown-model",
    }),
    (error) => error.code === "GUIDE_PROVIDER_UNSUPPORTED" && error.status === 400,
  );
});

test("workflow exposes Zotero status and targets through the configured loopback base URL", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-zotero-status-"));
  const requestedUrls = [];
  const service = createJournalWorkflowService({
    env: {
      PI_DATA_DIR: dataDir,
      PI_MODEL_MODE: "fixture",
      PI_ZOTERO_BASE_URL: "http://localhost:24567",
    },
    dataDir,
    runStore: createRunStore({ dataDir }),
    sourceStateStore: createSourceStateStore({ dataDir }),
    mineruAdapter: null,
    fetchImpl: async (url) => {
      requestedUrls.push(url);
      if (url.endsWith("/api/")) {
        return new Response("", {
          status: 200,
          headers: { "zotero-api-version": "3" },
        });
      }
      if (url.endsWith("/connector/ping")) return new Response("", { status: 200 });
      if (url.endsWith("/connector/getSelectedCollection")) {
        return Response.json({
          libraryID: 1,
          id: 2,
          targets: [
            {
              id: "L1",
              name: "我的文库",
              level: 0,
              filesEditable: true,
            },
            {
              id: "C2",
              name: "AI前沿论文",
              level: 1,
              filesEditable: true,
            },
          ],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  assert.deepEqual(await service.getZoteroStatus(), {
    available: true,
    apiVersion: 3,
    connectorAvailable: true,
  });
  const targets = await service.getZoteroTargets();
  assert.equal(targets.selectedTargetId, "C2");
  assert.equal(targets.targets[1].name, "AI前沿论文");
  assert.equal(requestedUrls.every((url) => url.startsWith("http://localhost:24567/")), true);
});

test("resumeRun validates an in-progress Zotero commit before MinerU early returns", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-zotero-resume-"));
  const runStore = createRunStore({ dataDir });
  const run = await runStore.createRun();
  const target = {
    id: "C1",
    name: "AI前沿论文",
    libraryId: 1,
    libraryName: "我的文库",
    level: 1,
    path: ["我的文库", "AI前沿论文"],
    editable: true,
    filesEditable: true,
  };
  const proposal = {
    proposal_id: "zotero-paper-1-test",
    content_hash: "sha256:content",
    target_version_or_hash: "sha256:target",
  };
  const core = {
    schema_version: 1,
    run_id: run.run_id,
    target,
    decisions: { "paper-1": "collect" },
    proposals: [proposal],
  };
  const proposalHash = zoteroArchivalTest.sha256(core);
  const artifact = {
    ...core,
    proposal_id: "zotero-preview-test",
    proposal_hash: proposalHash,
    generated_at: "2026-07-23T12:00:00.000Z",
  };
  await runStore.writeArtifact(run.run_id, "proposals/zotero-preview-test.json", artifact);
  await runStore.updateRun(run.run_id, {
    status: "committing",
    phase: "zotero_commit",
    zotero: {
      status: "committing",
      target,
      decisions: { "paper-1": "collect" },
      proposal_id: artifact.proposal_id,
      proposal_hash: proposalHash,
      artifact_path: "proposals/zotero-preview-test.json",
      proposals: [{
        ...proposal,
        selected: true,
        status: "committed",
        external_id: "ITEM0001",
      }],
      approval: {
        approval_id: "approval-test",
        proposal_id: artifact.proposal_id,
        proposal_hash: proposalHash,
        operations: [proposal],
        approved_at: "2026-07-23T12:00:00.000Z",
      },
      last_error: null,
    },
  });
  const service = createJournalWorkflowService({
    env: { PI_DATA_DIR: dataDir, PI_MODEL_MODE: "fixture" },
    dataDir,
    runStore,
    sourceStateStore: createSourceStateStore({ dataDir }),
    mineruAdapter: null,
    zoteroAdapter: {
      status: async () => ({ available: true }),
      getTargets: async () => ({ selectedTargetId: "C1", targets: [target] }),
      findDuplicates: async () => ({
        operationMatch: null,
        doiMatches: [],
        titleMatches: [],
      }),
      createItem: async () => {
        throw new Error("A completed operation must not be written again");
      },
    },
  });

  const resumed = await service.resumeRun(run.run_id);
  assert.equal(resumed.status, "partial");
  assert.equal(resumed.zotero.status, "partial");
  assert.equal(resumed.zotero.last_error.code, "ZOTERO_PROPOSAL_CORRUPT");
  assert.equal((await service.waitForZoteroCommit(run.run_id)).status, "partial");
});

test("full-text translation runs in bounded batches and stays durable per revision", async () => {
  const { dataDir, runStore, runId } = await createReadyGuideRun("pi-agent-translation-");
  const service = createJournalWorkflowService({
    env: { PI_DATA_DIR: dataDir, PI_MODEL_MODE: "fixture" },
    dataDir,
    runStore,
    sourceStateStore: createSourceStateStore({ dataDir }),
    mineruAdapter: null,
    modelProviders: supportedModelRegistry(),
  });

  const initial = await service.getPaperTranslation(runId, "paper-1");
  assert.equal(initial.status, "not_started");
  assert.ok(initial.total_blocks > 0);

  const started = await service.generatePaperTranslation(runId, "paper-1");
  assert.ok(["running", "ready"].includes(started.status));
  await service.waitForTranslation(runId, "paper-1");

  const done = await service.getPaperTranslation(runId, "paper-1");
  assert.equal(done.status, "ready");
  assert.equal(done.translated_blocks, done.total_blocks);
  assert.equal(done.provider_id, "codex-subscription");
  assert.equal(done.model_id, "gpt-5.3-codex-spark");
  assert.equal(done.reasoning_effort, "low");
  assert.equal(done.prompt_id, "translation");
  assert.match(done.prompt_version, /^translation\./);
  const document = await service.getPaperDocument(runId, "paper-1");
  assert.equal(done.document_revision, document.revision);
  for (const zh of Object.values(done.blocks)) assert.ok(zh.length > 0);

});

test("successful model translation batches persist usage receipts", async () => {
  const { dataDir, runStore, runId } = await createReadyGuideRun(
    "pi-agent-translation-usage-",
  );
  const usage = {
    input_tokens: 90,
    cached_input_tokens: 30,
    output_tokens: 10,
    total_tokens: 100,
    billing: {
      kind: "chatgpt_subscription",
      api_equivalent_cost_usd: null,
      cost_source: "unpriced",
    },
  };
  const service = createJournalWorkflowService({
    env: { PI_DATA_DIR: dataDir, PI_MODEL_MODE: "fixture" },
    dataDir,
    runStore,
    sourceStateStore: createSourceStateStore({ dataDir }),
    mineruAdapter: null,
    modelProviders: supportedModelRegistry(),
    translationGenerator: async ({ batch }) => translationResult(
      Object.fromEntries(batch.map((block) => [
        block.block_id,
        `【译】${block.source}`,
      ])),
      {
        source: "model",
        operation_id: "translation-operation-1",
        upstream_request_id: "translation-request-1",
        usage,
      },
    ),
  });

  await service.generatePaperTranslation(runId, "paper-1");
  await service.waitForTranslation(runId, "paper-1");

  const artifact = await runStore.readArtifact(
    runId,
    "translation/paper-1.json",
  );
  assert.equal(artifact.status, "ready");
  assert.equal(artifact.usage_receipts.length, 1);
  const [receipt] = artifact.usage_receipts;
  assert.deepEqual({
    workflow_scope: receipt.workflow_scope,
    step: receipt.step,
    run_id: receipt.run_id,
    paper_id: receipt.paper_id,
    provider_id: receipt.provider_id,
    model_id: receipt.model_id,
    operation_id: receipt.operation_id,
    upstream_request_id: receipt.upstream_request_id,
  }, {
    workflow_scope: "paper_reading",
    step: "translation",
    run_id: runId,
    paper_id: "paper-1",
    provider_id: "codex-subscription",
    model_id: "gpt-5.3-codex-spark",
    operation_id: "translation-operation-1",
    upstream_request_id: "translation-request-1",
  });
  assert.deepEqual(receipt.usage, usage);
  assert.match(receipt.occurred_at, /^\d{4}-\d{2}-\d{2}T/);
});

test("full-text translation reports formula passthrough separately from model progress", async () => {
  const { dataDir, runStore, runId } = await createReadyGuideRun("pi-agent-translation-formula-");
  const markdown = [
    "# Paper 1",
    "",
    "## Method",
    "",
    "The first paragraph explains the objective.",
    "",
    "$$",
    "x = y + 1",
    "$$",
    "",
    "The second paragraph explains the evidence.",
    "",
  ].join("\n");
  await runStore.writeArtifact(runId, "extraction/paper-1/paper.md", markdown);
  await runStore.writeArtifact(runId, "extraction/paper-1/manifest.json", {
    schema_version: 1,
    paper_id: "paper-1",
    markdown_chars: markdown.length,
    image_count: 0,
  });
  const service = createJournalWorkflowService({
    env: { PI_DATA_DIR: dataDir, PI_MODEL_MODE: "fixture" },
    dataDir,
    runStore,
    sourceStateStore: createSourceStateStore({ dataDir }),
    mineruAdapter: null,
    modelProviders: supportedModelRegistry(),
  });

  const initial = await service.getPaperTranslation(runId, "paper-1");
  assert.equal(initial.total_blocks, 4);
  assert.equal(initial.translated_blocks, 0);
  assert.equal(initial.passthrough_blocks, 1);

  await service.generatePaperTranslation(runId, "paper-1");
  await service.waitForTranslation(runId, "paper-1");
  const done = await service.getPaperTranslation(runId, "paper-1");
  assert.equal(done.status, "ready");
  assert.equal(done.total_blocks, 4);
  assert.equal(done.translated_blocks, 4);
  assert.equal(done.passthrough_blocks, 1);
  assert.equal(Object.keys(done.blocks).length, 5);
});

test("full-text translation pauses after the active batch and resumes with the locked profile", async () => {
  const { dataDir, runStore, runId } = await createReadyGuideRun("pi-agent-translation-pause-");
  const markdown = [
    "# Paper 1",
    "",
    "## Body",
    "",
    ...Array.from({ length: 30 }, (_, index) => `Paragraph ${index + 1} explains one result.\n`),
  ].join("\n");
  await runStore.writeArtifact(runId, "extraction/paper-1/paper.md", markdown);
  await runStore.writeArtifact(runId, "extraction/paper-1/manifest.json", {
    schema_version: 1,
    paper_id: "paper-1",
    markdown_chars: markdown.length,
    image_count: 0,
  });

  let releaseFirstBatch;
  let markFirstBatchStarted;
  const firstBatchStarted = new Promise((resolve) => {
    markFirstBatchStarted = resolve;
  });
  const firstBatchGate = new Promise((resolve) => {
    releaseFirstBatch = resolve;
  });
  const requests = [];
  const service = createJournalWorkflowService({
    env: { PI_DATA_DIR: dataDir, PI_MODEL_MODE: "fixture" },
    dataDir,
    runStore,
    sourceStateStore: createSourceStateStore({ dataDir }),
    mineruAdapter: null,
    modelProviders: supportedModelRegistry(),
    translationGenerator: async (request) => {
      requests.push(request);
      if (requests.length === 1) {
        markFirstBatchStarted();
        await firstBatchGate;
      }
      return translationResult(
        Object.fromEntries(request.batch.map((block) => [
          block.block_id,
          `【译】${block.source}`,
        ])),
      );
    },
  });

  const started = await service.generatePaperTranslation(runId, "paper-1");
  assert.equal(started.status, "running");
  await firstBatchStarted;
  const pausing = await service.pausePaperTranslation(runId, "paper-1");
  assert.equal(pausing.status, "pausing");
  assert.equal((await service.pausePaperTranslation(runId, "paper-1")).status, "pausing");
  releaseFirstBatch();
  await service.waitForTranslation(runId, "paper-1");

  const paused = await service.getPaperTranslation(runId, "paper-1");
  assert.equal(paused.status, "paused");
  assert.ok(paused.translated_blocks > 0);
  assert.ok(paused.translated_blocks < paused.total_blocks);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].providerId, "codex-subscription");
  assert.equal(requests[0].modelId, "gpt-5.3-codex-spark");
  assert.equal(requests[0].reasoningEffort, "low");
  assert.equal((await service.pausePaperTranslation(runId, "paper-1")).status, "paused");

  const resumed = await service.generatePaperTranslation(runId, "paper-1");
  assert.equal(resumed.status, "running");
  await service.waitForTranslation(runId, "paper-1");
  const done = await service.getPaperTranslation(runId, "paper-1");
  assert.equal(done.status, "ready");
  assert.equal(done.translated_blocks, done.total_blocks);
  assert.equal(requests.length, 2);
});

test("orphaned active jobs pause and legacy translation profiles restart cleanly", async () => {
  const { dataDir, runStore, runId } = await createReadyGuideRun("pi-agent-translation-profile-");
  const service = createJournalWorkflowService({
    env: { PI_DATA_DIR: dataDir, PI_MODEL_MODE: "fixture" },
    dataDir,
    runStore,
    sourceStateStore: createSourceStateStore({ dataDir }),
    mineruAdapter: null,
    modelProviders: supportedModelRegistry(),
  });
  await service.generatePaperTranslation(runId, "paper-1");
  await service.waitForTranslation(runId, "paper-1");

  const artifact = await runStore.readArtifact(runId, "translation/paper-1.json");
  const [removedBlockId] = Object.keys(artifact.blocks);
  const orphanedBlocks = { ...artifact.blocks };
  delete orphanedBlocks[removedBlockId];
  await runStore.writeArtifact(runId, "translation/paper-1.json", {
    ...artifact,
    status: "pausing",
    blocks: orphanedBlocks,
  });

  const restartedService = createJournalWorkflowService({
    env: { PI_DATA_DIR: dataDir, PI_MODEL_MODE: "fixture" },
    dataDir,
    runStore,
    sourceStateStore: createSourceStateStore({ dataDir }),
    mineruAdapter: null,
    modelProviders: supportedModelRegistry(),
  });
  const recovered = await restartedService.getPaperTranslation(runId, "paper-1");
  assert.equal(recovered.status, "paused");
  assert.equal(
    (await runStore.readArtifact(runId, "translation/paper-1.json")).status,
    "paused",
  );

  await runStore.writeArtifact(runId, "translation/paper-1.json", {
    ...artifact,
    model_id: "account-default",
    blocks: Object.fromEntries(
      Object.keys(artifact.blocks).map((blockId) => [blockId, `legacy:${blockId}`]),
    ),
  });
  const legacy = await restartedService.getPaperTranslation(runId, "paper-1");
  assert.equal(legacy.model_id, "account-default");
  assert.ok(Object.values(legacy.blocks).every((value) => value.startsWith("legacy:")));

  const restarted = await restartedService.generatePaperTranslation(runId, "paper-1");
  assert.equal(restarted.status, "running");
  assert.equal(restarted.model_id, "gpt-5.3-codex-spark");
  await restartedService.waitForTranslation(runId, "paper-1");
  const regenerated = await restartedService.getPaperTranslation(runId, "paper-1");
  assert.equal(regenerated.status, "ready");
  assert.equal(regenerated.model_id, "gpt-5.3-codex-spark");
  assert.equal(regenerated.reasoning_effort, "low");
  assert.ok(Object.values(regenerated.blocks).every((value) => !value.startsWith("legacy:")));
});

test("a batch with mismatched model provenance is never merged", async () => {
  const { dataDir, runStore, runId } = await createReadyGuideRun("pi-agent-translation-mismatch-");
  const service = createJournalWorkflowService({
    env: { PI_DATA_DIR: dataDir, PI_MODEL_MODE: "fixture" },
    dataDir,
    runStore,
    sourceStateStore: createSourceStateStore({ dataDir }),
    mineruAdapter: null,
    modelProviders: supportedModelRegistry(),
    translationGenerator: async ({ batch }) => ({
      ...translationResult(Object.fromEntries(batch.map((block) => [
        block.block_id,
        `【译】${block.source}`,
      ]))),
      model_id: "account-default",
    }),
  });

  await service.generatePaperTranslation(runId, "paper-1");
  await service.waitForTranslation(runId, "paper-1");
  const result = await service.getPaperTranslation(runId, "paper-1");
  assert.equal(result.status, "partial");
  assert.equal(result.translated_blocks, 0);
  assert.equal(result.error.code, "TRANSLATION_PROFILE_MISMATCH");
});

test("a non-retryable translation failure stops before the next batch", async () => {
  const { dataDir, runStore, runId } = await createReadyGuideRun("pi-agent-translation-stop-");
  const markdown = [
    "# Paper 1",
    "",
    "## Body",
    "",
    ...Array.from({ length: 30 }, (_, index) => `Paragraph ${index + 1} explains one result.\n`),
  ].join("\n");
  await runStore.writeArtifact(runId, "extraction/paper-1/paper.md", markdown);
  await runStore.writeArtifact(runId, "extraction/paper-1/manifest.json", {
    schema_version: 1,
    paper_id: "paper-1",
    markdown_chars: markdown.length,
    image_count: 0,
  });
  let calls = 0;
  const service = createJournalWorkflowService({
    env: { PI_DATA_DIR: dataDir, PI_MODEL_MODE: "fixture" },
    dataDir,
    runStore,
    sourceStateStore: createSourceStateStore({ dataDir }),
    mineruAdapter: null,
    modelProviders: supportedModelRegistry(),
    translationGenerator: async () => {
      calls += 1;
      const error = new Error("Codex 未使用可用的 ChatGPT 订阅登录");
      error.code = "CODEX_AUTH_NOT_CHATGPT";
      error.retryable = false;
      throw error;
    },
  });

  await service.generatePaperTranslation(runId, "paper-1");
  await service.waitForTranslation(runId, "paper-1");
  const result = await service.getPaperTranslation(runId, "paper-1");
  assert.equal(calls, 1);
  assert.equal(result.status, "partial");
  assert.equal(result.translated_blocks, 0);
  assert.equal(result.error.code, "CODEX_AUTH_NOT_CHATGPT");
  assert.equal(result.error.retryable, false);
});

test("a failed translation batch stays retryable without losing finished blocks", async () => {
  const { dataDir, runStore, runId } = await createReadyGuideRun("pi-agent-translation-retry-");
  let calls = 0;
  const service = createJournalWorkflowService({
    env: { PI_DATA_DIR: dataDir, PI_MODEL_MODE: "fixture" },
    dataDir,
    runStore,
    sourceStateStore: createSourceStateStore({ dataDir }),
    mineruAdapter: null,
    modelProviders: supportedModelRegistry(),
    translationGenerator: async ({ batch }) => {
      calls += 1;
      if (calls === 1) {
        const error = new Error("批次超时");
        error.code = "TRANSLATION_OUTPUT_INVALID";
        error.retryable = true;
        throw error;
      }
      return translationResult(
        Object.fromEntries(batch.map((block) => [
          block.block_id,
          `【译】${block.source}`,
        ])),
      );
    },
  });

  await service.generatePaperTranslation(runId, "paper-1");
  await service.waitForTranslation(runId, "paper-1");
  const partial = await service.getPaperTranslation(runId, "paper-1");
  assert.equal(partial.status, "partial");
  assert.equal(partial.error.code, "TRANSLATION_OUTPUT_INVALID");

  await service.generatePaperTranslation(runId, "paper-1");
  await service.waitForTranslation(runId, "paper-1");
  const done = await service.getPaperTranslation(runId, "paper-1");
  assert.equal(done.status, "ready");
  assert.equal(done.translated_blocks, done.total_blocks);
});

test("a translation for an older document revision reports stale", async () => {
  const { dataDir, runStore, runId } = await createReadyGuideRun("pi-agent-translation-stale-");
  const service = createJournalWorkflowService({
    env: { PI_DATA_DIR: dataDir, PI_MODEL_MODE: "fixture" },
    dataDir,
    runStore,
    sourceStateStore: createSourceStateStore({ dataDir }),
    mineruAdapter: null,
    modelProviders: supportedModelRegistry(),
  });
  await service.generatePaperTranslation(runId, "paper-1");
  await service.waitForTranslation(runId, "paper-1");

  const artifact = await runStore.readArtifact(runId, "translation/paper-1.json");
  await runStore.writeArtifact(runId, "translation/paper-1.json", {
    ...artifact,
    document_revision: "sha256:outdated",
  });
  const stale = await service.getPaperTranslation(runId, "paper-1");
  assert.equal(stale.status, "stale");
  assert.deepEqual(stale.blocks, {});
});

test("ArchiveBatch stops before Zotero when any required Obsidian note is blocked", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-archive-dependency-"));
  const runStore = createRunStore({ dataDir });
  const run = await runStore.createRun();
  await runStore.updateRun(run.run_id, {
    status: "awaiting_approval",
    phase: "archive_preview",
    candidates: [
      { paper_id: "paper-1", title: "Paper 1" },
      { paper_id: "paper-2", title: "Paper 2" },
    ],
    paper_decisions: {
      "paper-1": "read",
      "paper-2": "read",
    },
    obsidian: {
      status: "partially_blocked",
      proposals: [
        {
          proposal_id: "obsidian-1",
          paper_id: "paper-1",
          actionable: true,
          selected: true,
          status: "draft",
        },
        {
          proposal_id: "obsidian-2",
          paper_id: "paper-2",
          actionable: false,
          selected: false,
          status: "blocked",
        },
      ],
    },
    zotero: {
      status: "awaiting_approval",
      proposals: [
        { proposal_id: "zotero-1", paper_id: "paper-1", status: "draft" },
        { proposal_id: "zotero-2", paper_id: "paper-2", status: "draft" },
      ],
    },
  });
  let zoteroStarts = 0;
  const service = createJournalWorkflowService({
    env: { PI_DATA_DIR: dataDir, PI_MODEL_MODE: "fixture" },
    dataDir,
    runStore,
    sourceStateStore: createSourceStateStore({ dataDir }),
    obsidianPreviewService: {
      validateCommit: async () => undefined,
      commit: async () => runStore.updateRun(run.run_id, (current) => ({
        obsidian: {
          ...current.obsidian,
          status: "completed",
          proposals: current.obsidian.proposals.map((proposal) => (
            proposal.proposal_id === "obsidian-1"
              ? { ...proposal, status: "committed" }
              : proposal
          )),
        },
      })),
    },
    zoteroArchivalService: {
      validateCommit: async () => undefined,
      startCommit: async () => {
        zoteroStarts += 1;
      },
      waitForCommit: async () => undefined,
      resumeCommit: async () => undefined,
    },
  });

  await service.startArchiveCommit(run.run_id, {
    clientRequestId: "archive-blocked-obsidian",
    obsidian: {
      proposalHash: "sha256:obsidian",
      operations: [{
        proposal_id: "obsidian-1",
        content_hash: "sha256:content-1",
        target_version_or_hash: "sha256:target-1",
      }],
    },
    zotero: {
      proposalHash: "sha256:zotero",
      operations: [{
        proposal_id: "zotero-1",
        content_hash: "sha256:content-z1",
        target_version_or_hash: "sha256:target-z1",
      }],
    },
  });
  const completed = await service.waitForArchiveCommit(run.run_id);
  assert.equal(zoteroStarts, 0);
  assert.equal(completed.status, "manual_action_required");
  assert.equal(completed.archive_batch.status, "manual_action_required");
  assert.equal(completed.obsidian.proposals[0].status, "committed");
  assert.equal(completed.obsidian.proposals[1].status, "blocked");
});

test("ArchiveBatch serializes starts and replays a completed request idempotently", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-archive-idempotent-"));
  const runStore = createRunStore({ dataDir });
  const run = await runStore.createRun();
  await runStore.updateRun(run.run_id, {
    status: "awaiting_approval",
    phase: "archive_preview",
    candidates: [{ paper_id: "paper-1", title: "Paper 1" }],
    paper_decisions: { "paper-1": "collect" },
    zotero: {
      status: "awaiting_approval",
      proposals: [{
        proposal_id: "zotero-1",
        paper_id: "paper-1",
        actionable: true,
        selected: true,
        status: "draft",
      }],
    },
  });
  let releaseCommit;
  const commitGate = new Promise((resolve) => {
    releaseCommit = resolve;
  });
  let validations = 0;
  let starts = 0;
  const zoteroArchivalService = {
    validateCommit: async () => {
      validations += 1;
    },
    startCommit: async () => {
      starts += 1;
      await commitGate;
      await runStore.updateRun(run.run_id, (current) => ({
        status: "completed",
        zotero: {
          ...current.zotero,
          status: "completed",
          proposals: current.zotero.proposals.map((proposal) => ({
            ...proposal,
            status: "committed",
          })),
        },
      }));
    },
    waitForCommit: async () => undefined,
    resumeCommit: async () => undefined,
  };
  const service = createJournalWorkflowService({
    env: { PI_DATA_DIR: dataDir, PI_MODEL_MODE: "fixture" },
    dataDir,
    runStore,
    sourceStateStore: createSourceStateStore({ dataDir }),
    zoteroArchivalService,
  });
  const request = {
    clientRequestId: "archive-idempotent-1",
    zotero: {
      proposalHash: "sha256:zotero",
      operations: [{
        proposal_id: "zotero-1",
        content_hash: "sha256:content",
        target_version_or_hash: "sha256:target",
      }],
    },
  };
  await service.startArchiveCommit(run.run_id, request);
  await assert.rejects(
    service.startArchiveCommit(run.run_id, {
      ...request,
      clientRequestId: "archive-conflicting-2",
    }),
    (error) => error.code === "ARCHIVE_APPROVAL_IN_PROGRESS",
  );
  releaseCommit();
  const completed = await service.waitForArchiveCommit(run.run_id);
  assert.equal(completed.status, "completed");
  assert.equal(starts, 1);
  assert.equal(validations, 1);

  const replayed = await service.startArchiveCommit(run.run_id, request);
  assert.equal(replayed.archive_batch.status, "completed");
  assert.equal(starts, 1);
  assert.equal(validations, 1);
});

test("ArchiveBatch recovery skips verified child writes and continues only project state", async (t) => {
  for (const [topStatus, recoveryEntry] of [
    ["completed", "getRun"],
    ["partial", "listRuns"],
  ]) {
    await t.test(`${topStatus} through ${recoveryEntry}`, async () => {
      const dataDir = await mkdtemp(path.join(
        os.tmpdir(),
        `pi-archive-recovery-${topStatus}-`,
      ));
      const runStore = createRunStore({ dataDir });
      const run = await runStore.createRun();
      const obsidianRequest = {
        proposalHash: "sha256:obsidian-preview",
        operations: [{
          proposal_id: "obsidian-1",
          content_hash: "sha256:obsidian-content",
          target_version_or_hash: "sha256:obsidian-target",
        }],
      };
      const zoteroRequest = {
        proposalHash: "sha256:zotero-preview",
        operations: [{
          proposal_id: "zotero-1",
          content_hash: "sha256:zotero-content",
          target_version_or_hash: "sha256:zotero-target",
        }],
      };
      const projectStateRequest = {
        proposalHash: "sha256:project-state-preview",
        operation: {
          proposal_id: "project-state-1",
          content_hash: "sha256:project-state-content",
          target_version_or_hash: "sha256:project-state-target",
        },
      };
      const clientRequestId = `archive-recovery-${topStatus}`;
      const requestFingerprint = `sha256:${createHash("sha256")
        .update(JSON.stringify({
          run_id: run.run_id,
          client_request_id: clientRequestId,
          obsidian: obsidianRequest,
          zotero: zoteroRequest,
          project_state: projectStateRequest,
        }))
        .digest("hex")}`;
      const batchId = `archive-${requestFingerprint.slice(7, 23)}`;
      const artifactPath = `archive-batches/${batchId}.json`;
      const batch = {
        schema_version: 1,
        batch_id: batchId,
        client_request_id: clientRequestId,
        request_fingerprint: requestFingerprint,
        selected_targets: ["obsidian", "zotero", "project_state"],
        status: "committing",
        approved_at: "2026-07-27T08:00:00.000Z",
        completed_at: null,
        last_error: null,
        updated_at: "2026-07-27T08:00:00.000Z",
        artifact_path: artifactPath,
      };
      await runStore.writeArtifact(run.run_id, artifactPath, {
        ...batch,
        request: {
          obsidian: obsidianRequest,
          zotero: zoteroRequest,
          project_state: projectStateRequest,
        },
      });
      await runStore.updateRun(run.run_id, {
        status: topStatus,
        phase: topStatus === "completed" ? "zotero_completed" : "zotero_partial",
        candidates: [{ paper_id: "paper-1", title: "Paper 1" }],
        paper_decisions: { "paper-1": "read" },
        obsidian: {
          status: "completed",
          proposals: [{
            proposal_id: "obsidian-1",
            paper_id: "paper-1",
            actionable: true,
            selected: true,
            status: "committed",
          }],
        },
        zotero: {
          status: topStatus === "completed" ? "completed" : "partial",
          proposals: [
            {
              proposal_id: "zotero-1",
              paper_id: "paper-1",
              actionable: true,
              selected: true,
              status: "committed",
            },
            ...(topStatus === "partial"
              ? [{
                  proposal_id: "zotero-unrelated-blocked",
                  paper_id: "paper-not-required",
                  actionable: false,
                  selected: false,
                  status: "blocked",
                }]
              : []),
          ],
        },
        project_state: {
          status: "preview_ready",
          proposal_id: "project-state-1",
          actionable: true,
        },
        archive_batch: batch,
      });

      let obsidianCommits = 0;
      let zoteroStarts = 0;
      let zoteroResumes = 0;
      let projectStateCommits = 0;
      const service = createJournalWorkflowService({
        env: { PI_DATA_DIR: dataDir, PI_MODEL_MODE: "fixture" },
        dataDir,
        runStore,
        sourceStateStore: createSourceStateStore({ dataDir }),
        obsidianPreviewService: {
          commit: async () => {
            obsidianCommits += 1;
            return runStore.getRun(run.run_id);
          },
        },
        zoteroArchivalService: {
          startCommit: async () => {
            zoteroStarts += 1;
          },
          resumeCommit: async () => {
            zoteroResumes += 1;
          },
          waitForCommit: async () => runStore.getRun(run.run_id),
        },
        projectStatePreviewService: {
          commit: async () => {
            projectStateCommits += 1;
            return runStore.updateRun(run.run_id, (current) => ({
              project_state: {
                ...current.project_state,
                status: "completed",
                committed_at: "2026-07-27T08:05:00.000Z",
                verified_at: "2026-07-27T08:05:00.000Z",
              },
            }));
          },
        },
      });

      if (recoveryEntry === "getRun") {
        await service.getRun(run.run_id);
      } else {
        await service.listRuns();
      }
      const recovered = await service.waitForArchiveCommit(run.run_id);
      assert.equal(recovered.status, "completed");
      assert.equal(recovered.archive_batch.status, "completed");
      assert.equal(recovered.project_state.status, "completed");
      assert.equal(projectStateCommits, 1);
      assert.equal(obsidianCommits, 0);
      assert.equal(zoteroStarts, 0);
      assert.equal(zoteroResumes, 0);
    });
  }
});

test("workflow archive entrypoints fail closed while a scratch reading branch is active", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-archive-scratch-"));
  const runStore = createRunStore({ dataDir });
  const run = await runStore.createRun();
  await runStore.updateRun(run.run_id, {
    status: "draft_ready",
    phase: "write_preview",
    candidates: [{ paper_id: "paper-1", title: "Paper 1" }],
    paper_decisions: { "paper-1": "read" },
    readings: {
      schema_version: 1,
      status: "ready_for_preview",
      paper_ids: ["paper-1"],
      provider_id: null,
      model_id: null,
      last_error: null,
      papers: {
        "paper-1": {
          status: "complete",
          canonical_conversation_id: "conversation-canonical",
          chat: {
            id: "conversation-scratch",
            status: "idle",
            turns: [],
            branch_type: "scratch",
            parent_checkpoint: {
              conversation_id: "conversation-canonical",
              turn_id: null,
              turn_count: 0,
              checkpoint_hash: "sha256:checkpoint",
              created_at: "2026-07-27T08:00:00.000Z",
            },
            promotion_status: "not_promoted",
          },
          archived_conversations: [{
            id: "conversation-canonical",
            status: "idle",
            turns: [],
            branch_type: "canonical",
            parent_checkpoint: null,
            promotion_status: "canonical",
          }],
        },
      },
    },
  });
  let previewCalls = 0;
  let zoteroProposalCalls = 0;
  let zoteroCommitCalls = 0;
  const service = createJournalWorkflowService({
    env: { PI_DATA_DIR: dataDir, PI_MODEL_MODE: "fixture" },
    dataDir,
    runStore,
    sourceStateStore: createSourceStateStore({ dataDir }),
    obsidianPreviewService: {
      createPreview: async () => {
        previewCalls += 1;
      },
    },
    projectStatePreviewService: {
      createPreview: async () => {
        previewCalls += 1;
      },
    },
    zoteroArchivalService: {
      createProposal: async () => {
        zoteroProposalCalls += 1;
      },
      startCommit: async () => {
        zoteroCommitCalls += 1;
      },
    },
  });

  for (const operation of [
    () => service.createObsidianPreview(run.run_id),
    () => service.createProjectStatePreview(run.run_id),
    () => service.createZoteroProposal(run.run_id, {}),
    () => service.startZoteroCommit(run.run_id, {}),
    () => service.startArchiveCommit(run.run_id, {}),
  ]) {
    await assert.rejects(
      operation(),
      (error) => error.code === "READING_SCRATCH_ARCHIVE_BLOCKED",
    );
  }
  assert.equal(previewCalls, 0);
  assert.equal(zoteroProposalCalls, 0);
  assert.equal(zoteroCommitCalls, 0);
  assert.equal((await runStore.getRun(run.run_id)).archive_batch, undefined);
});
