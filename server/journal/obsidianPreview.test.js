import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRunStore } from "./runStore.js";
import {
  __test,
  createObsidianPreviewService,
} from "./obsidianPreview.js";
import { READING_STAGE_ORDER } from "./readingGenerator.js";

const paper = {
  paper_id: "paper-obsidian-preview",
  dedupe_key: "doi:10.1234/obsidian.preview",
  title: "A Persistent / Reading: Workflow?",
  authors: ["Ada Author", "Bob Builder"],
  venue: "AAAI",
  published_at: "2026-07-01",
  doi: "10.1234/obsidian.preview",
  canonical_url: "https://example.com/obsidian-preview",
};

function citation(index) {
  return {
    block_id: `block-${index.toString(16).padStart(20, "0")}`,
    path: ["Experiments", `Section ${index}`],
    ordinal: index,
    excerpt: `Original evidence excerpt ${index}.`,
    support: `This paragraph supports claim ${index}.`,
  };
}

function reading(runId, overrides = {}) {
  const stages = Object.fromEntries(
    READING_STAGE_ORDER.map((stage, index) => [stage, {
      status: "ready",
      content_hash: `sha256:${String(index + 1).repeat(64).slice(0, 64)}`,
      result: {
        answer: `${stage} answer grounded in the paper.`,
        evidence: [citation(index + 1)],
        open_questions: [`Open question for ${stage}?`],
      },
    }]),
  );
  return {
    schema_version: 1,
    run_id: runId,
    paper_id: paper.paper_id,
    paper: {
      title: paper.title,
      authors: paper.authors,
      venue: paper.venue,
      published_at: paper.published_at,
      doi: paper.doi,
      canonical_url: paper.canonical_url,
    },
    status: "complete",
    document_revision: "sha256:reading-document",
    current_stage: "project-relation",
    position: {
      mode: "focused",
      block_id: citation(4).block_id,
      updated_at: "2026-07-23T08:30:00.000Z",
    },
    stage_order: [...READING_STAGE_ORDER],
    stages,
    questions: [{
      id: "question-1",
      client_request_id: "client-question-1",
      stage: "method",
      block_id: citation(2).block_id,
      text: "这个机制为什么能够减少错误？",
      status: "answered",
      error: null,
      created_at: "2026-07-23T08:15:00.000Z",
      answered_at: "2026-07-23T08:16:00.000Z",
      answer: "它通过显式约束中间状态减少错误传播。",
      evidence: [citation(8)],
      open_questions: ["该结论能否推广到其他任务？"],
    }],
    ...overrides,
  };
}

async function setup({
  runStatus = "draft_ready",
  decisions = { [paper.paper_id]: "read" },
  readingStatus = "complete",
  readingFactory = reading,
} = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-obsidian-preview-"));
  const noteDir = path.join(dataDir, "vault", "论文精读");
  await mkdir(noteDir, { recursive: true });
  const runStore = createRunStore({
    dataDir,
    now: () => new Date("2026-07-23T08:00:00.000Z"),
    idFactory: () => "12345678-aaaa-bbbb-cccc-dddddddddddd",
  });
  const created = await runStore.createRun();
  await runStore.updateRun(created.run_id, {
    status: runStatus,
    phase: "write_preview",
    candidates: [paper],
    paper_decisions: decisions,
    readings: {
      status: readingStatus === "complete" ? "ready_for_preview" : "reading",
      paper_ids: decisions[paper.paper_id] === "read" ? [paper.paper_id] : [],
      papers: decisions[paper.paper_id] === "read"
        ? {
            [paper.paper_id]: {
              status: readingStatus,
              document_revision: "sha256:reading-document",
              stages: Object.fromEntries(
                READING_STAGE_ORDER.map((stage) => [
                  stage,
                  { status: readingStatus === "complete" ? "ready" : "not_started" },
                ]),
              ),
            },
          }
        : {},
    },
  });
  const calls = [];
  const getPaperReading = async (runId, paperId) => {
    calls.push({ runId, paperId });
    return readingFactory(runId);
  };
  const service = createObsidianPreviewService({
    runStore,
    getPaperReading,
    obsidianNoteDir: noteDir,
    now: () => new Date("2026-07-23T09:00:00.000Z"),
  });
  return {
    calls,
    dataDir,
    noteDir,
    runId: created.run_id,
    runStore,
    service,
  };
}

test("creates an exact deterministic preview artifact without writing the Obsidian target", async () => {
  const {
    calls,
    noteDir,
    runId,
    runStore,
    service,
  } = await setup();

  const first = await service.createPreview(runId);
  const proposal = first.proposals[0];
  assert.equal(first.write_capability, "preview_only");
  assert.equal(first.external_write_performed, false);
  assert.equal(first.status, "preview_ready");
  assert.equal(calls.length, 1);
  assert.match(
    proposal.target_details.file_name,
    /^2026-Ada-Author-A-Persistent-Reading-Workflow--[a-f0-9]{8}\.md$/,
  );
  assert.equal(path.dirname(proposal.target_locator), await realDirectory(noteDir));
  assert.equal(proposal.operation, "create");
  assert.equal(proposal.write_mode, "create_only");
  assert.equal(proposal.actionable, true);
  assert.equal(proposal.diff.before, null);
  assert.equal(proposal.diff.after, proposal.markdown);
  assert.match(proposal.content_hash, /^sha256:[a-f0-9]{64}$/);
  assert.match(proposal.target_hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(proposal.content_hash, __test.sha256(proposal.markdown));
  assert.match(proposal.markdown, /## 1\. 研究问题/);
  assert.match(proposal.markdown, /## 2\. 方法与机制/);
  assert.match(proposal.markdown, /## 3\. 实验证据/);
  assert.match(proposal.markdown, /## 4\. 与项目的关系/);
  assert.match(proposal.markdown, /这个机制为什么能够减少错误/);
  assert.match(proposal.markdown, /`block-00000000000000000008`/);
  assert.match(proposal.markdown, /位置：Experiments › Section 8/);
  assert.match(proposal.markdown, /段落序号：8/);
  assert.match(proposal.markdown, /原文摘录：Original evidence excerpt 8\./);
  assert.match(proposal.markdown, /支持关系：This paragraph supports claim 8\./);
  await assert.rejects(readFile(proposal.target_locator, "utf8"), { code: "ENOENT" });

  assert.equal(
    await runStore.readArtifact(runId, proposal.markdown_artifact_path),
    proposal.markdown,
  );
  const storedArtifact = await runStore.readArtifact(runId, first.artifact_path);
  assert.equal(storedArtifact.proposal_hash, first.proposal_hash);
  assert.equal(storedArtifact.external_write_performed, false);
  const storedRun = await runStore.getRun(runId);
  assert.equal(storedRun.obsidian.status, "preview_ready");
  assert.equal(storedRun.obsidian.approval, null);

  await runStore.updateRun(runId, {
    status: "awaiting_approval",
    phase: "archive_approval",
  });
  const restored = await service.getPreview(runId);
  assert.equal(restored.proposal_hash, first.proposal_hash);
  assert.equal(restored.proposals[0].markdown, proposal.markdown);

  await runStore.updateRun(runId, {
    status: "draft_ready",
    phase: "write_preview",
  });
  const second = await service.createPreview(runId);
  assert.equal(second.proposal_hash, first.proposal_hash);
  assert.equal(second.proposals[0].proposal_id, proposal.proposal_id);
  assert.equal(second.proposals[0].content_hash, proposal.content_hash);
  assert.equal(second.proposals[0].target_hash, proposal.target_hash);
  await assert.rejects(readFile(proposal.target_locator, "utf8"), { code: "ENOENT" });
});

test("an Agent note action invalidates an older whole-note preview", async () => {
  const {
    runId,
    runStore,
    service,
  } = await setup();
  await service.createPreview(runId);

  await runStore.updateRun(runId, (current) => {
    const readings = structuredClone(current.readings);
    readings.papers[paper.paper_id].agent_actions = {
      schema_version: 1,
      status: "committed",
      proposals: [{
        proposal_id: "reading-note-agent-1",
        turn_id: "chat-turn-1",
        status: "committed",
        content_hash: `sha256:${"a".repeat(64)}`,
        target_version_or_hash: `sha256:${"b".repeat(64)}`,
        committed_at: "2026-07-23T09:05:00.000Z",
      }],
      updated_at: "2026-07-23T09:05:00.000Z",
    };
    return { readings };
  });

  await assert.rejects(
    service.getPreview(runId),
    (error) => error.code === "OBSIDIAN_PREVIEW_STALE",
  );
});

test("only draft-ready runs with authoritative read decisions and complete stages can preview", async () => {
  const wrongStatus = await setup({ runStatus: "reading" });
  await assert.rejects(
    wrongStatus.service.createPreview(wrongStatus.runId),
    (error) => error.code === "OBSIDIAN_PREVIEW_NOT_ALLOWED",
  );
  assert.equal(wrongStatus.calls.length, 0);

  const collectOnly = await setup({
    decisions: { [paper.paper_id]: "collect" },
  });
  await assert.rejects(
    collectOnly.service.createPreview(collectOnly.runId),
    (error) => error.code === "OBSIDIAN_NOT_REQUIRED",
  );
  assert.equal(collectOnly.calls.length, 0);

  const incompleteSummary = await setup({ readingStatus: "reading" });
  await assert.rejects(
    incompleteSummary.service.createPreview(incompleteSummary.runId),
    (error) => error.code === "OBSIDIAN_READING_NOT_READY",
  );

  const incompleteArtifact = await setup({
    readingFactory: (runId) => {
      const result = reading(runId);
      result.stages.evidence.status = "not_started";
      result.stages.evidence.result = null;
      return result;
    },
  });
  await assert.rejects(
    incompleteArtifact.service.createPreview(incompleteArtifact.runId),
    (error) => error.code === "OBSIDIAN_READING_NOT_READY",
  );
});

test("caller input cannot redirect the configured directory and unsafe metadata stays in one file name", async () => {
  const context = await setup();
  const outside = path.join(context.dataDir, "outside.md");
  const current = await context.runStore.getRun(context.runId);
  await context.runStore.updateRun(context.runId, {
    candidates: [{
      ...current.candidates[0],
      title: "../../Outside: Note",
      authors: ["../Unsafe/Author"],
    }],
  });

  const result = await context.service.createPreview(context.runId, {
    obsidianNoteDir: path.dirname(outside),
    targetPath: outside,
  });
  const proposal = result.proposals[0];
  assert.equal(path.dirname(proposal.target_locator), await realDirectory(context.noteDir));
  assert.equal(proposal.target_details.file_name.includes("/"), false);
  assert.equal(proposal.target_details.file_name.includes("\\"), false);
  await assert.rejects(readFile(outside, "utf8"), { code: "ENOENT" });
  await assert.rejects(readFile(proposal.target_locator, "utf8"), { code: "ENOENT" });
});

test("an existing target becomes a non-actionable manual-update preview and is never modified", async () => {
  const context = await setup();
  const expectedName = __test.noteFileName(paper);
  const targetPath = path.join(context.noteDir, expectedName);
  const original = "# Existing user note\n\nKeep me.\n";
  await writeFile(targetPath, original, "utf8");

  const result = await context.service.createPreview(context.runId);
  const proposal = result.proposals[0];
  assert.equal(result.status, "blocked");
  assert.equal(proposal.actionable, false);
  assert.equal(proposal.selected, false);
  assert.equal(proposal.status, "blocked");
  assert.equal(proposal.operation, "update");
  assert.equal(proposal.write_mode, "manual_update_required");
  assert.equal(proposal.target_details.exists, true);
  assert.equal(proposal.diff.mode, "blocked_existing");
  assert.equal(proposal.diff.changes.length, 0);
  assert.equal(proposal.diff.before_hash, __test.sha256(original));
  assert.equal(proposal.diff.after_hash, proposal.diff.before_hash);
  assert.match(proposal.preview_or_diff.join("\n"), /不会覆盖、追加或改名/);
  assert.equal(await readFile(targetPath, "utf8"), original);
});

test("a managed note update preserves confirmed Agent notes exactly", async () => {
  const context = await setup();
  const initial = await context.service.createPreview(context.runId);
  const targetPath = initial.proposals[0].target_locator;
  const agentRegion = [
    "## Agent 补充笔记",
    "",
    "<!-- pi-agent:agent-action:agent-note-1:start -->",
    "### 为什么这段方法重要？",
    "",
    "它把项目状态和单次执行显式连接起来。",
    "<!-- pi-agent:agent-action:agent-note-1:end -->",
  ].join("\n");
  const managed = initial.proposals[0].markdown.replace(
    "## Agent 补充笔记\n\n- 暂无",
    agentRegion,
  );
  await writeFile(targetPath, managed, "utf8");

  const result = await context.service.createPreview(context.runId);
  const proposal = result.proposals[0];
  assert.equal(result.status, "preview_ready");
  assert.equal(proposal.actionable, true);
  assert.equal(proposal.operation, "update");
  assert.equal(proposal.write_mode, "managed_update");
  assert.equal(proposal.diff.mode, "replace_managed_workflow");
  assert.equal(proposal.diff.preserved_region, "agent-notes");
  assert.match(proposal.markdown, /agent-action:agent-note-1:start/);
  assert.match(proposal.markdown, /它把项目状态和单次执行显式连接起来/);
  assert.equal(await readFile(targetPath, "utf8"), managed);
});

test("missing citation fields and unfinished questions block a durable preview", async () => {
  const invalidCitation = await setup({
    readingFactory: (runId) => {
      const result = reading(runId);
      delete result.stages.method.result.evidence[0].support;
      return result;
    },
  });
  await assert.rejects(
    invalidCitation.service.createPreview(invalidCitation.runId),
    (error) => error.code === "OBSIDIAN_READING_INVALID",
  );

  const runningQuestion = await setup({
    readingFactory: (runId) => {
      const result = reading(runId);
      result.questions[0].status = "running";
      result.questions[0].answer = null;
      result.questions[0].evidence = [];
      return result;
    },
  });
  await assert.rejects(
    runningQuestion.service.createPreview(runningQuestion.runId),
    (error) => error.code === "OBSIDIAN_READING_NOT_READY",
  );
});

async function realDirectory(directory) {
  return realpath(directory);
}
