import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRunStore } from "./runStore.js";
import { __test, createZoteroArchivalService } from "./zoteroArchival.js";

function paper(index) {
  return {
    paper_id: `paper-${index}`,
    paper_type: "conference-paper",
    title: `Paper ${index}`,
    authors: [`Author ${index}`],
    venue: "AAAI",
    published_at: "2026-07-23",
    doi: `10.1234/paper.${index}`,
    official_id: `conf/test/Paper${index}`,
    dedupe_key: `doi:10.1234/paper.${index}`,
    canonical_url: `https://doi.org/10.1234/paper.${index}`,
    pdf_url: `https://papers.example/paper-${index}.pdf`,
    abstract: `Abstract ${index}`,
  };
}

function guide(runId, paperId) {
  return {
    schema_version: 1,
    run_id: runId,
    paper_id: paperId,
    document_revision: `sha256:document-${paperId}`,
    guide: {
      paper_id: paperId,
      problem: "研究问题",
      why_read: "值得阅读的原因",
      intuition: "方法直觉",
      evidence: "实验证据",
      limitations: "局限与边界",
      questions: ["问题一？", "问题二？"],
      evidence_refs: ["block-00000000000000000001"],
    },
    references: [{
      block_id: "block-00000000000000000001",
      path: ["实验", "主要结果"],
      ordinal: 1,
      excerpt: "模型在三个数据集上均优于基线。",
    }],
    provenance: {
      prompt_version: "five-minute-guide.v2",
    },
  };
}

async function setup({ paperCount = 1, decisions = null } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-zotero-archive-"));
  const runStore = createRunStore({ dataDir });
  const run = await runStore.createRun();
  const papers = Array.from({ length: paperCount }, (_, index) => paper(index + 1));
  const pdfs = new Map();
  const guides = new Map();
  for (const candidate of papers) {
    const bytes = Buffer.from(`%PDF-1.7\n${candidate.paper_id}\n`, "utf8");
    const filePath = path.join(dataDir, `${candidate.paper_id}.pdf`);
    await writeFile(filePath, bytes);
    pdfs.set(candidate.paper_id, {
      file_path: filePath,
      file_name: `${candidate.paper_id}.pdf`,
      byte_length: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    guides.set(candidate.paper_id, guide(run.run_id, candidate.paper_id));
  }
  const paperDecisions = decisions ?? Object.fromEntries(
    papers.map((candidate) => [candidate.paper_id, "collect"]),
  );
  const readingPapers = Object.fromEntries(
    Object.entries(paperDecisions)
      .filter(([, decision]) => decision === "read")
      .map(([paperId]) => [paperId, {
        status: "complete",
        completed_stages: [
          "research-question",
          "method",
          "evidence",
          "project-relation",
        ],
      }]),
  );
  await runStore.updateRun(run.run_id, {
    status: "draft_ready",
    phase: "archive_preview",
    candidates: papers,
    paper_decisions: paperDecisions,
    readings: {
      status: Object.keys(readingPapers).length ? "ready_for_preview" : "not_required",
      papers: readingPapers,
    },
    guides: {
      status: "ready",
      requested_paper_ids: papers.map((candidate) => candidate.paper_id),
      provider_id: "codex-subscription",
      model_id: "account-default",
      papers: Object.fromEntries(papers.map((candidate) => [
        candidate.paper_id,
        { status: "ready", revision: `sha256:document-${candidate.paper_id}` },
      ])),
    },
  });
  const createCalls = [];
  const findCalls = [];
  const duplicateByPaper = new Map();
  const createErrorByPaper = new Map();
  let targets = {
    selectedTargetId: "C1",
    targets: [{
      id: "C1",
      name: "AI前沿论文",
      libraryId: 1,
      libraryName: "我的文库",
      level: 1,
      path: ["我的文库", "AI前沿论文"],
      editable: true,
      filesEditable: true,
    }],
  };
  const adapter = {
    getTargets: async () => structuredClone(targets),
    findDuplicates: async (input) => {
      findCalls.push(structuredClone(input));
      return structuredClone(
        duplicateByPaper.get(input.doi || input.title) ?? {
          operationMatch: null,
          doiMatches: [],
          titleMatches: [],
        },
      );
    },
    createItem: async (input) => {
      createCalls.push(input);
      const paperId = input.operationId.match(/paper-\d+/)?.[0];
      const configuredError = createErrorByPaper.get(paperId);
      if (configuredError) throw configuredError;
      return {
        itemKey: `ITEM-${paperId}`,
        attachmentKey: `PDF-${paperId}`,
        noteKey: `NOTE-${paperId}`,
        sessionId: input.sessionId,
        connectorItemId: input.connectorItemId,
        verified: true,
        idempotent: false,
        message: "已按测试适配器声明的有限范围读回核验",
      };
    },
  };
  const makeService = () => createZoteroArchivalService({
    runStore,
    zoteroAdapter: adapter,
    getPaperGuide: async (_runId, paperId) => structuredClone(guides.get(paperId)),
    getPaperPdf: async (_runId, paperId) => structuredClone(pdfs.get(paperId)),
    now: () => new Date("2026-07-23T12:00:00.000Z"),
    idFactory: () => "approval-test-id",
  });
  return {
    adapter,
    createCalls,
    createErrorByPaper,
    dataDir,
    duplicateByPaper,
    findCalls,
    guides,
    makeService,
    papers,
    pdfs,
    runId: run.run_id,
    runStore,
    service: makeService(),
    setTargets: (next) => {
      targets = next;
    },
  };
}

function approvalFor(
  artifact,
  proposalIds = artifact.proposals
    .filter((proposal) => proposal.status !== "blocked")
    .map((proposal) => proposal.proposal_id),
) {
  return {
    proposalHash: artifact.proposal_hash,
    operations: artifact.proposals
      .filter((proposal) => proposalIds.includes(proposal.proposal_id))
      .map((proposal) => ({
        proposal_id: proposal.proposal_id,
        content_hash: proposal.content_hash,
        target_version_or_hash: proposal.target_version_or_hash,
      })),
  };
}

async function readPrivateProposal(context) {
  const run = await context.runStore.getRun(context.runId);
  return context.runStore.readArtifact(context.runId, run.zotero.artifact_path);
}

async function stageInterruptedCommit(context, artifact) {
  const approval = approvalFor(artifact);
  const approvalId = "approval-resume-test";
  const approvedAt = "2026-07-23T12:00:00.000Z";
  const core = {
    schema_version: 1,
    run_id: context.runId,
    approval_id: approvalId,
    proposal_id: artifact.proposal_id,
    proposal_hash: artifact.proposal_hash,
    operations: approval.operations,
    approved_at: approvedAt,
  };
  const approvalHash = __test.sha256(core);
  const artifactPath = `approvals/${approvalId}.json`;
  await context.runStore.writeArtifact(context.runId, artifactPath, {
    ...core,
    approval_hash: approvalHash,
  });
  await context.runStore.updateRun(context.runId, (run) => ({
    status: "committing",
    phase: "zotero_commit",
    zotero: {
      ...run.zotero,
      status: "committing",
      approval: {
        approval_id: approvalId,
        proposal_id: artifact.proposal_id,
        proposal_hash: artifact.proposal_hash,
        operations: approval.operations,
        approved_at: approvedAt,
        approval_hash: approvalHash,
        artifact_path: artifactPath,
      },
      proposals: run.zotero.proposals.map((proposal) => ({
        ...proposal,
        selected: proposal.status !== "blocked",
        status: proposal.status === "blocked" ? "blocked" : "committing",
      })),
    },
  }));
  return artifactPath;
}

test("guide review cannot skip staged reading and create a Zotero preview", async () => {
  const context = await setup();
  await context.runStore.updateRun(context.runId, {
    status: "guide_ready",
    phase: "guide_review",
  });

  await assert.rejects(
    context.service.createProposal(context.runId, {
      decisions: { "paper-1": "collect" },
      targetId: "C1",
    }),
    (error) => error.code === "ZOTERO_PROPOSAL_NOT_ALLOWED",
  );
  assert.equal(context.createCalls.length, 0);
});

test("a close-reading decision cannot create a Zotero preview before all stages complete", async () => {
  const context = await setup({
    decisions: { "paper-1": "read" },
  });
  await context.runStore.updateRun(context.runId, {
    readings: {
      status: "in_progress",
      papers: {
        "paper-1": {
          status: "in_progress",
          completed_stages: ["research-question"],
        },
      },
    },
  });

  await assert.rejects(
    context.service.createProposal(context.runId, {
      decisions: { "paper-1": "read" },
      targetId: "C1",
    }),
    (error) => error.code === "ZOTERO_READING_NOT_READY",
  );
  assert.equal(context.createCalls.length, 0);
});

test("a Zotero preview cannot use decisions that differ from the current run", async () => {
  const context = await setup({
    decisions: { "paper-1": "read" },
  });

  await assert.rejects(
    context.service.createProposal(context.runId, {
      decisions: { "paper-1": "collect" },
      targetId: "C1",
    }),
    (error) => error.code === "ZOTERO_DECISIONS_STALE",
  );
  assert.equal(context.createCalls.length, 0);
});

test("safe preview is exact and hides raw write payload and connector IDs", async () => {
  const context = await setup();
  const artifact = await context.service.createProposal(context.runId, {
    decisions: { "paper-1": "collect" },
    targetId: "C1",
  });
  const proposal = artifact.proposals[0];

  assert.equal(context.createCalls.length, 0);
  assert.equal(proposal.operation, "create");
  assert.equal(proposal.target_locator, "我的文库 / AI前沿论文");
  assert.match(proposal.content_hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(proposal.item, undefined);
  assert.equal(proposal.note_html, undefined);
  assert.equal(proposal.connector_session_id, undefined);
  assert.equal(proposal.connector_item_id, undefined);
  assert.deepEqual(proposal.metadata, {
    item_type: "conferencePaper",
    title: "Paper 1",
    authors: ["Author 1"],
    venue: "AAAI",
    date: "2026-07-23",
    doi: "10.1234/paper.1",
    url: "https://doi.org/10.1234/paper.1",
    abstract: "Abstract 1",
    tags: ["Pi Agent"],
    extra: [
      "DBLP Key: conf/test/Paper1",
      "Pi-Agent-Dedupe-Key: doi:10.1234/paper.1",
      "Pi-Agent-Paper-ID: paper-1",
      `Pi Agent Run: ${context.runId}`,
      `Pi Agent Operation: ${proposal.proposal_id}`,
      `Pi-Agent-Operation-ID: ${proposal.proposal_id}`,
    ].join("\n"),
  });
  assert.equal(proposal.guide.sections.questions.length, 2);
  assert.equal(proposal.guide.references[0].block_id, "block-00000000000000000001");

  const privateArtifact = await readPrivateProposal(context);
  assert.match(privateArtifact.proposals[0].connector_session_id, /^pi-session-/);
  assert.match(privateArtifact.proposals[0].connector_item_id, /^pi-item-/);
  assert.equal(privateArtifact.proposals[0].item.title, "Paper 1");
  assert.match(privateArtifact.proposals[0].note_html, /五分钟导读/);

  const restored = await context.service.getProposal(context.runId);
  assert.equal(restored.proposals[0].item, undefined);
  assert.equal(restored.proposals[0].note_html, undefined);
  assert.equal(JSON.stringify(restored).includes("pi-session-"), false);
  assert.equal(JSON.stringify(restored).includes(context.dataDir), false);
});

test("target hierarchy is preserved in the locator and target approval hash", async () => {
  const context = await setup();
  context.setTargets({
    selectedTargetId: "C25",
    targets: [{
      id: "C23",
      name: "Reading",
      libraryId: 1,
      libraryName: "我的文库",
      level: 2,
      path: ["我的文库", "Research", "Reading"],
      editable: true,
      filesEditable: true,
    }, {
      id: "C25",
      name: "Reading",
      libraryId: 1,
      libraryName: "我的文库",
      level: 2,
      path: ["我的文库", "Products", "Reading"],
      editable: true,
      filesEditable: true,
    }],
  });

  const artifact = await context.service.createProposal(context.runId, {
    decisions: { "paper-1": "collect" },
    targetId: "C25",
  });

  assert.deepEqual(artifact.target.path, ["我的文库", "Products", "Reading"]);
  assert.equal(artifact.proposals[0].target_locator, "我的文库 / Products / Reading");
  assert.notEqual(
    __test.targetHash(artifact.target),
    __test.targetHash({
      ...artifact.target,
      path: ["我的文库", "Research", "Reading"],
    }),
  );
});

test("commit requires the exact preview hash and live target before any write", async () => {
  const context = await setup();
  const artifact = await context.service.createProposal(context.runId, {
    decisions: { "paper-1": "collect" },
    targetId: "C1",
  });

  await assert.rejects(
    context.service.startCommit(context.runId, {
      ...approvalFor(artifact),
      proposalHash: "sha256:stale",
    }),
    (error) => error.code === "ZOTERO_PREVIEW_STALE",
  );
  context.setTargets({
    selectedTargetId: "C1",
    targets: [{
      id: "C1",
      name: "已改名",
      libraryId: 1,
      libraryName: "我的文库",
      editable: true,
      filesEditable: true,
    }],
  });
  await assert.rejects(
    context.service.startCommit(context.runId, approvalFor(artifact)),
    (error) => error.code === "ZOTERO_TARGET_STALE",
  );
  assert.equal(context.createCalls.length, 0);
});

test("approved create uses persisted connector IDs and records them before verification", async () => {
  const context = await setup();
  const artifact = await context.service.createProposal(context.runId, {
    decisions: { "paper-1": "collect" },
    targetId: "C1",
  });
  const privateArtifact = await readPrivateProposal(context);
  const privateProposal = privateArtifact.proposals[0];

  const started = await context.service.startCommit(context.runId, approvalFor(artifact));
  assert.equal(started.status, "committing");
  const completed = await context.service.waitForCommit(context.runId);

  assert.equal(context.createCalls.length, 1);
  assert.equal(context.createCalls[0].sessionId, privateProposal.connector_session_id);
  assert.equal(context.createCalls[0].connectorItemId, privateProposal.connector_item_id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.zotero.proposals[0].external_id, "ITEM-paper-1");
  const approval = await context.runStore.readArtifact(
    context.runId,
    completed.zotero.approval.artifact_path,
  );
  assert.equal(approval.proposal_hash, artifact.proposal_hash);
  assert.match(approval.approval_hash, /^sha256:[a-f0-9]{64}$/);
  const ledger = await context.runStore.readArtifact(
    context.runId,
    `writes/zotero/${artifact.proposals[0].proposal_id}.json`,
  );
  assert.equal(ledger.status, "committed");
  assert.equal(ledger.connector_session_id, privateProposal.connector_session_id);
  assert.equal(ledger.connector_item_id, privateProposal.connector_item_id);
});

test("partial retry skips a previously verified paper", async () => {
  const context = await setup({
    paperCount: 2,
    decisions: { "paper-1": "collect", "paper-2": "read" },
  });
  const artifact = await context.service.createProposal(context.runId, {
    decisions: {
      "paper-1": "collect",
      "paper-2": "read",
    },
    targetId: "C1",
  });
  const temporary = new Error("temporary");
  temporary.code = "ZOTERO_UNAVAILABLE";
  context.createErrorByPaper.set("paper-2", temporary);
  await context.service.startCommit(context.runId, approvalFor(artifact));
  const partial = await context.service.waitForCommit(context.runId);
  assert.equal(partial.status, "partial");

  context.createErrorByPaper.delete("paper-2");
  const failedId = partial.zotero.proposals.find(
    (proposal) => proposal.status === "failed",
  ).proposal_id;
  await context.service.startCommit(context.runId, approvalFor(artifact, [failedId]));
  const completed = await context.service.waitForCommit(context.runId);
  assert.equal(completed.status, "completed");
  assert.equal(completed.phase, "zotero_completed");
  assert.equal(completed.zotero.status, "completed");
  assert.equal(completed.paused_reason, null);
  assert.equal(context.createCalls.filter((call) => call.operationId.includes("paper-1")).length, 1);
  assert.equal(context.createCalls.filter((call) => call.operationId.includes("paper-2")).length, 2);
});

test("a DOI paper with a title-only conflict is blocked before approval", async () => {
  const context = await setup();
  context.duplicateByPaper.set("10.1234/paper.1", {
    operationMatch: null,
    doiMatches: [],
    titleMatches: [{ key: "TITLE001", title: "Paper 1" }],
  });
  const artifact = await context.service.createProposal(context.runId, {
    decisions: { "paper-1": "collect" },
    targetId: "C1",
  });
  assert.equal(artifact.proposals[0].write_mode, "manual_update_required");
  assert.equal(artifact.proposals[0].status, "blocked");
  assert.equal(artifact.proposals[0].external_id, "TITLE001");
  assert.equal(
    artifact.proposals[0].target_locator,
    "我的文库 / AI前沿论文（现有条目 TITLE001）",
  );
});

test("a paper without a DOI uses an exact title duplicate and blocks automatic updates", async () => {
  const context = await setup();
  await context.runStore.updateRun(context.runId, (run) => ({
    candidates: run.candidates.map((candidate) => ({
      ...candidate,
      doi: null,
      dedupe_key: `title:${candidate.title}`,
    })),
  }));
  context.duplicateByPaper.set("Paper 1", {
    operationMatch: null,
    doiMatches: [],
    titleMatches: [{ key: "TITLE001", title: "Paper 1" }],
  });
  const artifact = await context.service.createProposal(context.runId, {
    decisions: { "paper-1": "collect" },
    targetId: "C1",
  });
  assert.equal(artifact.proposals[0].write_mode, "manual_update_required");
  assert.equal(artifact.proposals[0].external_id, "TITLE001");
});

test("conflicting DOI matches block preview creation with a stable public error", async () => {
  const context = await setup();
  context.duplicateByPaper.set("10.1234/paper.1", {
    operationMatch: { key: "OPMATCH1", title: "Paper 1" },
    doiMatches: [{ key: "OTHER001", title: "Paper 1" }],
    titleMatches: [],
  });
  await assert.rejects(
    context.service.createProposal(context.runId, {
      decisions: { "paper-1": "collect" },
      targetId: "C1",
    }),
    (error) => (
      error.code === "ZOTERO_DUPLICATE_AMBIGUOUS"
      && !error.message.includes(context.dataDir)
    ),
  );
  const run = await context.runStore.getRun(context.runId);
  assert.equal(run.status, "draft_ready");
  assert.equal(run.zotero.status, "blocked");
  assert.equal(run.zotero.last_error.code, "ZOTERO_DUPLICATE_AMBIGUOUS");
  assert.equal(context.createCalls.length, 0);
});

test("ordinary existing items stay blocked while another paper can archive as partial", async () => {
  const context = await setup({
    paperCount: 2,
    decisions: { "paper-1": "collect", "paper-2": "read" },
  });
  context.duplicateByPaper.set("10.1234/paper.1", {
    operationMatch: null,
    doiMatches: [{ key: "EXISTING1", title: "Paper 1" }],
    titleMatches: [],
  });
  const artifact = await context.service.createProposal(context.runId, {
    decisions: {
      "paper-1": "collect",
      "paper-2": "read",
    },
    targetId: "C1",
  });
  const blocked = artifact.proposals.find((proposal) => proposal.paper_id === "paper-1");
  const writable = artifact.proposals.find((proposal) => proposal.paper_id === "paper-2");
  assert.equal(blocked.operation, "update");
  assert.equal(blocked.write_mode, "manual_update_required");
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.selected, false);
  assert.equal(blocked.external_id, "EXISTING1");
  assert.equal(blocked.error.code, "ZOTERO_MANUAL_UPDATE_REQUIRED");
  assert.match(blocked.preview_or_diff.join("\n"), /不会被移动.*PDF 与导读也不会被改动/);

  await assert.rejects(
    context.service.startCommit(context.runId, approvalFor(artifact, [blocked.proposal_id])),
    (error) => error.code === "ZOTERO_APPROVAL_INVALID",
  );
  await context.service.startCommit(context.runId, approvalFor(artifact, [writable.proposal_id]));
  const partial = await context.service.waitForCommit(context.runId);
  assert.equal(context.createCalls.length, 1);
  assert.equal(context.createCalls[0].operationId, writable.proposal_id);
  assert.equal(partial.status, "partial");
  assert.equal(partial.zotero.status, "partial");
  assert.equal(partial.zotero.proposals.find(
    (proposal) => proposal.paper_id === "paper-1",
  ).status, "blocked");
  assert.equal(partial.zotero.last_error.code, "ZOTERO_MANUAL_UPDATE_REQUIRED");

  context.duplicateByPaper.delete("10.1234/paper.1");
  const refreshed = await context.service.createProposal(context.runId, {
    decisions: { "paper-1": "collect" },
    targetId: "C1",
  });
  assert.equal(refreshed.proposals[0].paper_id, "paper-1");
  assert.equal(refreshed.proposals[0].status, "draft");
  assert.equal((await context.runStore.getRun(context.runId)).status, "awaiting_approval");
});

test("an all-blocked preview remains visible without pretending to await an automatic write", async () => {
  const context = await setup();
  context.duplicateByPaper.set("10.1234/paper.1", {
    operationMatch: null,
    doiMatches: [{ key: "EXISTING1", title: "Paper 1" }],
    titleMatches: [],
  });
  const artifact = await context.service.createProposal(context.runId, {
    decisions: { "paper-1": "collect" },
    targetId: "C1",
  });
  const run = await context.runStore.getRun(context.runId);
  assert.equal(artifact.proposals[0].status, "blocked");
  assert.equal(run.status, "manual_action_required");
  assert.equal(run.zotero.status, "blocked");
  assert.equal(
    run.paused_reason,
    "全部论文需在 Zotero 手工处理；当前没有可自动写入的条目",
  );
  await assert.rejects(
    context.service.startCommit(context.runId, approvalFor(artifact)),
    (error) => error.code === "ZOTERO_APPROVAL_NOT_ALLOWED",
  );
  assert.equal(context.createCalls.length, 0);

  context.duplicateByPaper.delete("10.1234/paper.1");
  const refreshed = await context.service.createProposal(context.runId, {
    decisions: { "paper-1": "collect" },
    targetId: "C1",
  });
  assert.equal(refreshed.proposals[0].status, "draft");
  assert.equal((await context.runStore.getRun(context.runId)).status, "awaiting_approval");
});

test("artifact changes to item, note, PDF, or guide are rejected before writes", async (t) => {
  const mutations = [
    ["item", (proposal) => {
      proposal.item.title = "Tampered title";
    }],
    ["note", (proposal) => {
      proposal.note_html += "<p>tampered</p>";
    }],
    ["pdf", (proposal) => {
      proposal.pdf.byte_length += 1;
    }],
    ["guide", (proposal) => {
      proposal.guide.sections.problem = "tampered";
    }],
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name, async () => {
      const context = await setup();
      await context.service.createProposal(context.runId, {
        decisions: { "paper-1": "collect" },
        targetId: "C1",
      });
      const run = await context.runStore.getRun(context.runId);
      const privateArtifact = await context.runStore.readArtifact(
        context.runId,
        run.zotero.artifact_path,
      );
      mutate(privateArtifact.proposals[0]);
      await context.runStore.writeArtifact(
        context.runId,
        run.zotero.artifact_path,
        privateArtifact,
      );
      await assert.rejects(
        context.service.getProposal(context.runId),
        (error) => error.code === "ZOTERO_PROPOSAL_CORRUPT",
      );
      assert.equal(context.createCalls.length, 0);
    });
  }
});

test("a duplicate appearing after preview makes approval stale and prevents writes", async () => {
  const context = await setup();
  const artifact = await context.service.createProposal(context.runId, {
    decisions: { "paper-1": "collect" },
    targetId: "C1",
  });
  context.duplicateByPaper.set("10.1234/paper.1", {
    operationMatch: null,
    doiMatches: [{ key: "LATE0001", title: "Paper 1" }],
    titleMatches: [],
  });
  await assert.rejects(
    context.service.startCommit(context.runId, approvalFor(artifact)),
    (error) => error.code === "ZOTERO_PREVIEW_STALE",
  );
  assert.equal(context.createCalls.length, 0);
});

test("resume validates the durable approval and pauses on a stale target", async () => {
  const context = await setup();
  const artifact = await context.service.createProposal(context.runId, {
    decisions: { "paper-1": "collect" },
    targetId: "C1",
  });
  await stageInterruptedCommit(context, artifact);
  context.setTargets({
    selectedTargetId: "C1",
    targets: [{
      id: "C1",
      name: "目标已变化",
      libraryId: 1,
      libraryName: "我的文库",
      editable: true,
      filesEditable: true,
    }],
  });

  const resumed = await context.makeService().resumeCommit(context.runId);
  assert.equal(resumed.status, "awaiting_approval");
  assert.equal(resumed.zotero.status, "awaiting_approval");
  assert.equal(resumed.zotero.last_error.code, "ZOTERO_TARGET_STALE");
  assert.equal(resumed.zotero.approval, null);
  assert.equal(context.createCalls.length, 0);
});

test("resume continues a valid durable approval and completes exactly once", async () => {
  const context = await setup();
  const artifact = await context.service.createProposal(context.runId, {
    decisions: { "paper-1": "collect" },
    targetId: "C1",
  });
  await stageInterruptedCommit(context, artifact);

  const resumedService = context.makeService();
  const resumed = await resumedService.resumeCommit(context.runId);
  assert.equal(resumed.status, "committing");
  const completed = await resumedService.waitForCommit(context.runId);
  assert.equal(completed.status, "completed");
  assert.equal(completed.zotero.status, "completed");
  assert.equal(context.createCalls.length, 1);
});

test("resume keeps a previously committed item visible when recovery needs review", async () => {
  const context = await setup({
    paperCount: 2,
    decisions: { "paper-1": "collect", "paper-2": "read" },
  });
  const artifact = await context.service.createProposal(context.runId, {
    decisions: { "paper-1": "collect", "paper-2": "read" },
    targetId: "C1",
  });
  await stageInterruptedCommit(context, artifact);
  await context.runStore.updateRun(context.runId, (run) => ({
    zotero: {
      ...run.zotero,
      proposals: run.zotero.proposals.map((proposal, index) => index === 0
        ? {
            ...proposal,
            status: "committed",
            external_id: "ITEM-1",
            verification_result: "已按有限范围读回核验",
          }
        : proposal),
    },
  }));
  context.setTargets({
    selectedTargetId: "C1",
    targets: [{
      id: "C1",
      name: "目标已变化",
      libraryId: 1,
      libraryName: "我的文库",
      editable: true,
      filesEditable: true,
    }],
  });

  const resumed = await context.makeService().resumeCommit(context.runId);
  assert.equal(resumed.status, "partial");
  assert.equal(resumed.zotero.status, "partial");
  assert.equal(resumed.zotero.proposals[0].status, "committed");
  assert.match(resumed.paused_reason, /部分 Zotero 归档已成功/);
  assert.equal(context.createCalls.length, 0);
});

test("resume rejects a tampered approval artifact before external writes", async () => {
  const context = await setup();
  const artifact = await context.service.createProposal(context.runId, {
    decisions: { "paper-1": "collect" },
    targetId: "C1",
  });
  const approvalPath = await stageInterruptedCommit(context, artifact);
  const stored = await context.runStore.readArtifact(context.runId, approvalPath);
  stored.operations[0].content_hash = "sha256:tampered";
  await context.runStore.writeArtifact(context.runId, approvalPath, stored);

  const resumed = await context.makeService().resumeCommit(context.runId);
  assert.equal(resumed.status, "awaiting_approval");
  assert.equal(resumed.zotero.last_error.code, "ZOTERO_APPROVAL_CORRUPT");
  assert.equal(context.createCalls.length, 0);
});

test("PDF filesystem failures persist fixed public errors without absolute paths", async () => {
  const context = await setup();
  const artifact = await context.service.createProposal(context.runId, {
    decisions: { "paper-1": "collect" },
    targetId: "C1",
  });
  const sensitivePath = path.join(context.dataDir, "private", "missing-paper.pdf");
  context.pdfs.get("paper-1").file_path = sensitivePath;

  await context.service.startCommit(context.runId, approvalFor(artifact));
  const failed = await context.service.waitForCommit(context.runId);
  const ledger = await context.runStore.readArtifact(
    context.runId,
    `writes/zotero/${artifact.proposals[0].proposal_id}.json`,
  );
  assert.equal(failed.status, "awaiting_approval");
  assert.equal(failed.zotero.last_error.code, "PDF_UNAVAILABLE");
  assert.equal(ledger.error.code, "PDF_UNAVAILABLE");
  assert.equal(JSON.stringify({ failed, ledger }).includes(sensitivePath), false);
  assert.equal(JSON.stringify({ failed, ledger }).includes(context.dataDir), false);
  assert.equal(context.createCalls.length, 0);
});

test("manual-repair adapter errors are fixed, persisted, and path-safe", async () => {
  const context = await setup();
  const artifact = await context.service.createProposal(context.runId, {
    decisions: { "paper-1": "collect" },
    targetId: "C1",
  });
  const unsafe = new Error(`repair ${context.dataDir}/secret.json`);
  unsafe.code = "ZOTERO_MANUAL_REPAIR_REQUIRED";
  context.createErrorByPaper.set("paper-1", unsafe);

  await context.service.startCommit(context.runId, approvalFor(artifact));
  const failed = await context.service.waitForCommit(context.runId);
  const ledger = await context.runStore.readArtifact(
    context.runId,
    `writes/zotero/${artifact.proposals[0].proposal_id}.json`,
  );
  assert.equal(failed.status, "manual_action_required");
  assert.equal(failed.zotero.status, "blocked");
  assert.equal(failed.zotero.last_error.code, "ZOTERO_MANUAL_REPAIR_REQUIRED");
  assert.equal(ledger.error.code, "ZOTERO_MANUAL_REPAIR_REQUIRED");
  assert.equal(JSON.stringify({ failed, ledger }).includes(context.dataDir), false);
});
