import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
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
      providerId === "codex-subscription" && modelId === "account-default"
    ),
  };
}

test("workflow runs scan, ranks five papers, submits one MinerU batch, and becomes review ready", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-workflow-"));
  const runStore = createRunStore({ dataDir });
  const sourceStateStore = createSourceStateStore({ dataDir });
  const submitted = [];
  let resultDownloads = 0;
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
      const filePath = path.join(outputDir, `${paperId}.pdf`);
      await writeFile(filePath, "%PDF-1.7\nmock");
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
  assert.equal(completed.candidates[4].display_label, "经典回顾 · 非本周新论文");
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].length, 5);
  assert.equal(completed.mineru.status, "ready");
  assert.equal(Object.values(completed.mineru.papers).every((paper) => paper.status === "ready"), true);
  assert.equal(resultDownloads, 5);

  await service.resumeRun(started.run_id);
  const resumed = await service.waitForRun(started.run_id);
  assert.equal(resumed.mineru.status, "ready");
  assert.equal(resultDownloads, 5);
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
