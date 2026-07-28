import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRunStore } from "./runStore.js";
import { createReadingService } from "./readingService.js";
import {
  generateReadingFollowUp,
  generateReadingStage,
  READING_STAGE_ORDER,
} from "./readingGenerator.js";
import {
  generateReadingChatMessage,
  prepareReadingChatMessage,
} from "./readingChatGenerator.js";

const paper = {
  paper_id: "paper-reading-service",
  title: "A Persistent Reading Workflow",
  authors: ["Ada Author"],
  venue: "AAAI",
  published_at: "2026-07-01",
  doi: "10.1234/reading",
  canonical_url: "https://example.com/reading",
};

function paperDocument() {
  const sectionNames = [
    "Abstract",
    "Introduction",
    "Method",
    "Experimental Setup",
    "Main Results",
    "Limitations",
  ];
  return {
    schema_version: 1,
    run_id: "filled-by-test",
    paper_id: paper.paper_id,
    revision: "sha256:reading-document",
    title: paper.title,
    sections: sectionNames.map((title, index) => ({
      section_id: `section-${index}`,
      path: [title],
      title,
      level: 2,
    })),
    blocks: Array.from({ length: 18 }, (_, index) => {
      const title = sectionNames[index % sectionNames.length];
      return {
        block_id: `block-${(index + 1).toString(16).padStart(20, "0")}`,
        section_id: `section-${index % sectionNames.length}`,
        path: [title],
        ordinal: index + 1,
        kind: "text",
        text: `${title} evidence paragraph ${index + 1}.`,
        markdown: `${title} evidence paragraph ${index + 1}.`,
      };
    }),
  };
}

async function setup({
  stageGenerator,
  followUpGenerator,
  chatGenerator,
  chatPreparer,
  getProjectContext,
} = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-reading-service-"));
  const store = createRunStore({
    dataDir,
    now: () => new Date("2026-07-23T08:00:00.000Z"),
    idFactory: () => "12345678-aaaa-bbbb-cccc-dddddddddddd",
  });
  const created = await store.createRun();
  await store.updateRun(created.run_id, {
    status: "guide_ready",
    phase: "guide_review",
    paused_reason: "等待决定",
    candidates: [paper],
    guides: {
      status: "ready",
      requested_paper_ids: [paper.paper_id],
      provider_id: "codex-subscription",
      model_id: "account-default",
      papers: {
        [paper.paper_id]: {
          status: "ready",
          revision: paperDocument().revision,
        },
      },
    },
  });
  const getRunPaper = async (runId, paperId, { paperOptional = false } = {}) => {
    const run = await store.getRun(runId);
    if (!run) throw Object.assign(new Error("运行不存在"), { code: "RUN_NOT_FOUND", status: 404 });
    if (paperOptional && paperId == null) return { run, paper: null };
    const found = run.candidates.find((candidate) => candidate.paper_id === paperId);
    if (!found) throw Object.assign(new Error("论文不存在"), { code: "PAPER_NOT_FOUND", status: 404 });
    return { run, paper: found };
  };
  const getPaperDocument = async (runId, paperId) => ({
    ...paperDocument(),
    run_id: runId,
    paper_id: paperId,
  });
  const serviceOptions = {
    runStore: store,
    getRunPaper,
    getPaperDocument,
    getProjectContext: getProjectContext ?? (async () => ({
      source_path: "PRODUCT_MEETING.md",
      revision: "sha256:project-context",
      content: "项目以长期工作流、证据引用与显式写入确认作为当前约束。",
    })),
    modelProviders: {
      supports: () => true,
    },
    modelMode: "fixture",
    stageGenerator,
    followUpGenerator,
    chatGenerator,
    chatPreparer,
    now: () => new Date("2026-07-23T09:00:00.000Z"),
    idFactory: () => "question-id-1",
  };
  const makeService = (overrides = {}) => createReadingService({
    ...serviceOptions,
    ...overrides,
  });
  const service = makeService();
  return { store, service, runId: created.run_id, makeService };
}

test("paper decisions are durable workflow facts and reading precedes every external write", async () => {
  const { store, service, runId } = await setup();
  const decided = await service.setDecisions(runId, {
    [paper.paper_id]: "read",
  });

  assert.deepEqual(decided.paper_decisions, { [paper.paper_id]: "read" });
  assert.equal(decided.status, "reading");
  assert.equal(decided.phase, "close_reading");
  assert.equal(decided.readings.status, "reading");
  assert.equal(decided.zotero.status, "not_started");

  for (const stage of READING_STAGE_ORDER) {
    const reading = await service.generateStage(runId, paper.paper_id, stage);
    assert.equal(reading.stages[stage].status, "ready");
    assert.equal(reading.stages[stage].result.evidence.length > 0, true);
    assert.equal(
      reading.stages[stage].result.evidence.every((item) => item.block_id.startsWith("block-")),
      true,
    );
  }

  const completed = await store.getRun(runId);
  assert.equal(completed.status, "draft_ready");
  assert.equal(completed.phase, "write_preview");
  assert.equal(completed.readings.status, "ready_for_preview");
  assert.equal(completed.readings.papers[paper.paper_id].status, "complete");
  assert.equal(completed.zotero.status, "not_started");

  const restored = await service.getReading(runId, paper.paper_id);
  assert.equal(restored.status, "complete");
  assert.deepEqual(restored.stage_order, READING_STAGE_ORDER);
  assert.equal(restored.stages["project-relation"].result.answer.length > 20, true);
});

test("collect-only decisions go directly to preview readiness without creating reading state", async () => {
  const { service, runId } = await setup();
  const decided = await service.setDecisions(runId, {
    [paper.paper_id]: "collect",
  });
  assert.equal(decided.status, "draft_ready");
  assert.equal(decided.readings.status, "not_started");
  assert.deepEqual(decided.readings.paper_ids, []);
});

test("all four reading lenses are free-order while archival coverage still needs all four", async () => {
  const { service, runId } = await setup();
  await service.setDecisions(runId, { [paper.paper_id]: "read" });

  const projectFirst = await service.generateStage(
    runId,
    paper.paper_id,
    "project-relation",
  );
  assert.equal(projectFirst.stages["project-relation"].status, "ready");
  assert.equal(projectFirst.status, "reading");
  const methodSecond = await service.generateStage(runId, paper.paper_id, "method");
  assert.equal(methodSecond.stages.method.status, "ready");
  assert.equal(methodSecond.status, "reading");
  await assert.rejects(
    service.setDecisions(runId, { [paper.paper_id]: "collect" }),
    (error) => error.code === "PAPER_DECISION_LOCKED",
  );
});

test("restarting from the guide preserves the guide and clears unfinished reading state", async () => {
  const { store, service, runId, makeService } = await setup();
  await service.setDecisions(runId, { [paper.paper_id]: "read" });
  await service.generateStage(runId, paper.paper_id, "research-question");
  await service.savePosition(runId, paper.paper_id, {
    mode: "full",
    blockId: paperDocument().blocks[5].block_id,
  });

  await assert.rejects(
    service.restartFromGuide(runId),
    (error) => error.code === "JOURNAL_MUTATION_REQUEST_ID_REQUIRED",
  );
  const restartRequest = { clientRequestId: "restart-reading-1" };
  const restarted = await service.restartFromGuide(runId, restartRequest);
  assert.equal(restarted.status, "review_ready");
  assert.equal(restarted.phase, "candidate_review");
  assert.equal(restarted.guides.status, "ready");
  assert.deepEqual(restarted.paper_decisions, {});
  assert.deepEqual(restarted.readings, {
    schema_version: 1,
    status: "not_started",
    paper_ids: [],
    provider_id: null,
    model_id: null,
    papers: {},
    last_error: null,
  });
  assert.equal(restarted.reading_restart.from_step, "candidates");
  assert.equal(typeof restarted.reading_restart.revision, "string");
  const replayed = await makeService().restartFromGuide(runId, restartRequest);
  assert.equal(
    replayed.reading_restart.revision,
    restarted.reading_restart.revision,
  );
  assert.equal(
    (await store.getRun(runId)).journal_mutations.entries["restart-reading-1"].status,
    "completed",
  );
  await assert.rejects(
    makeService().createConversation(runId, paper.paper_id, restartRequest),
    (error) => error.code === "JOURNAL_MUTATION_REQUEST_CONFLICT",
  );

  // Returning to the weekly candidates means decisions need guide_ready again before reading resumes.
  await store.updateRun(runId, { status: "guide_ready", phase: "guide_review" });
  await service.setDecisions(runId, { [paper.paper_id]: "read" });
  const freshReading = await service.getReading(runId, paper.paper_id);
  assert.equal(freshReading.stages["research-question"].status, "not_started");
  assert.equal(freshReading.position.block_id, null);

  await store.updateRun(runId, {
    zotero: {
      ...(await store.getRun(runId)).zotero,
      status: "preview_ready",
    },
  });
  await assert.rejects(
    service.restartFromGuide(runId, {
      clientRequestId: "restart-reading-blocked",
    }),
    (error) => error.code === "READING_RESTART_EXTERNAL_STATE",
  );
});

test("questions and reading position persist with validated block anchors", async () => {
  let generationCount = 0;
  const { store, service, runId, makeService } = await setup({
    followUpGenerator: async (options) => {
      generationCount += 1;
      return generateReadingFollowUp(options);
    },
  });
  await service.setDecisions(runId, { [paper.paper_id]: "read" });
  await service.generateStage(runId, paper.paper_id, "research-question");
  const blockId = paperDocument().blocks[4].block_id;

  await assert.rejects(
    service.askQuestion(runId, paper.paper_id, {
      stage: "research-question",
      text: "缺少稳定请求标识",
      blockId,
    }),
    (error) => error.code === "JOURNAL_MUTATION_REQUEST_ID_REQUIRED",
  );
  const answered = await service.askQuestion(runId, paper.paper_id, {
    stage: "research-question",
    text: "作者真正要解决的矛盾是什么？",
    blockId,
    clientRequestId: "client-question-1",
  });
  assert.equal(answered.questions.length, 1);
  assert.equal(answered.questions[0].status, "answered");
  assert.equal(answered.questions[0].block_id, blockId);
  assert.equal(answered.questions[0].evidence.length > 0, true);

  const duplicate = await service.askQuestion(runId, paper.paper_id, {
    stage: "research-question",
    text: "作者真正要解决的矛盾是什么？",
    blockId,
    clientRequestId: "client-question-1",
  });
  assert.equal(duplicate.questions.length, 1);
  assert.equal(generationCount, 1);

  const restoredDuplicate = await makeService({
    followUpGenerator: async (options) => {
      generationCount += 1;
      return generateReadingFollowUp(options);
    },
  }).askQuestion(runId, paper.paper_id, {
    stage: "research-question",
    text: "作者真正要解决的矛盾是什么？",
    blockId,
    clientRequestId: "client-question-1",
  });
  assert.equal(restoredDuplicate.questions.length, 1);
  assert.equal(generationCount, 1);
  assert.equal(
    (await store.getRun(runId)).journal_mutations.entries["client-question-1"].status,
    "completed",
  );

  await assert.rejects(
    service.askQuestion(runId, paper.paper_id, {
      stage: "research-question",
      text: "相同请求标识不得承载另一道问题",
      blockId,
      clientRequestId: "client-question-1",
    }),
    (error) => error.code === "JOURNAL_MUTATION_REQUEST_CONFLICT",
  );

  await service.savePosition(runId, paper.paper_id, {
    mode: "focused",
    blockId,
  });
  const restored = await service.getReading(runId, paper.paper_id);
  assert.deepEqual(restored.position, {
    mode: "focused",
    block_id: blockId,
    updated_at: "2026-07-23T09:00:00.000Z",
  });

  await assert.rejects(service.savePosition(runId, paper.paper_id, {
    mode: "focused",
    blockId: "block-ffffffffffffffffffff",
  }), (error) => error.code === "READING_BLOCK_NOT_FOUND");
});

test("an interrupted durable question never repeats the paid generator after restart", async () => {
  let generationCount = 0;
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const neverCompletes = new Promise(() => {});
  const { store, service, runId, makeService } = await setup({
    followUpGenerator: async () => {
      generationCount += 1;
      markStarted();
      return neverCompletes;
    },
  });
  await service.setDecisions(runId, { [paper.paper_id]: "read" });
  await service.generateStage(runId, paper.paper_id, "research-question");
  const options = {
    stage: "research-question",
    text: "这次调用在模型返回前中断",
    blockId: paperDocument().blocks[4].block_id,
    clientRequestId: "client-question-interrupted",
  };
  void service.askQuestion(runId, paper.paper_id, options);
  await started;
  assert.equal(
    (await store.getRun(runId)).journal_mutations.entries[
      options.clientRequestId
    ].status,
    "in_flight",
  );

  const restored = makeService({
    followUpGenerator: async (generatorOptions) => {
      generationCount += 1;
      return generateReadingFollowUp(generatorOptions);
    },
  });
  await assert.rejects(
    restored.askQuestion(runId, paper.paper_id, options),
    (error) => error.code === "READING_QUESTION_INTERRUPTED",
  );
  assert.equal(generationCount, 1);
  const recovered = await store.getRun(runId);
  assert.equal(
    recovered.journal_mutations.entries[options.clientRequestId].status,
    "failed",
  );
  assert.equal(
    recovered.readings.papers[paper.paper_id].questions[0].status,
    "failed",
  );
});

test("paper chat is explicit, selection-anchored, durable, and idempotent", async () => {
  let generatorCalls = 0;
  const { service, runId } = await setup({
    chatGenerator: async (options) => {
      generatorCalls += 1;
      return generateReadingChatMessage(options);
    },
  });
  await service.setDecisions(runId, { [paper.paper_id]: "read" });
  const block = paperDocument().blocks[4];
  const selected = "evidence paragraph";
  const start = block.text.indexOf(selected);
  const options = {
    text: "把这部分翻译成中文。",
    roundId: "orientation",
    reference: {
      document_revision: paperDocument().revision,
      block_id: block.block_id,
      start_offset: start,
      end_offset: start + selected.length,
    },
    clientRequestId: "client-chat-1",
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
  };

  const answered = await service.sendChatMessage(runId, paper.paper_id, options);
  assert.equal(generatorCalls, 1);
  assert.equal(answered.chat.status, "ready");
  assert.equal(answered.chat.turns.length, 1);
  assert.equal(answered.chat.turns[0].reference.block_id, block.block_id);
  assert.equal(answered.chat.turns[0].reference.quote, selected);
  assert.equal(answered.chat.turns[0].citations[0].block_id, block.block_id);
  assert.equal(answered.chat.turns[0].provider_id, "deepseek");
  assert.equal(answered.chat.turns[0].model_id, "deepseek-v4-flash");
  assert.equal(answered.chat.turns[0].round_id, "orientation");
  assert.equal(answered.chat.turns[0].audit_only, false);
  assert.equal(answered.questions.length, 0);

  const duplicate = await service.sendChatMessage(runId, paper.paper_id, options);
  assert.equal(generatorCalls, 1);
  assert.equal(duplicate.chat.turns.length, 1);
});

test("legacy guided-reading prompts recover their durable round id", async () => {
  const { store, service, runId, makeService } = await setup();
  await service.setDecisions(runId, { [paper.paper_id]: "read" });
  await service.sendChatMessage(runId, paper.paper_id, {
    text: "第 1 步 · 领域定位。只回答一个问题：这篇论文属于哪个研究领域？",
    roundId: "field",
    clientRequestId: "client-legacy-round-1",
  });

  const stored = await store.getRun(runId);
  stored.readings.papers[paper.paper_id].chat.turns[0].round_id = null;
  await store.updateRun(runId, { readings: stored.readings });

  const restored = await makeService().getReading(runId, paper.paper_id);
  assert.equal(restored.chat.turns[0].round_id, "field");
});

test("legacy short answers remain auditable but never re-enter reading context", async () => {
  const observedHistory = [];
  const { service, runId } = await setup({
    chatGenerator: async (options) => {
      const generated = await generateReadingChatMessage(options);
      return {
        ...generated,
        result: {
          ...generated.result,
          answer: "待核验",
        },
      };
    },
    chatPreparer: (options) => {
      observedHistory.push(structuredClone(options.recentTurns ?? []));
      return prepareReadingChatMessage(options);
    },
  });
  await service.setDecisions(runId, { [paper.paper_id]: "read" });
  const first = await service.sendChatMessage(runId, paper.paper_id, {
    text: "第一轮历史回答。",
    clientRequestId: "client-short-audit-1",
  });
  assert.equal(first.chat.turns[0].answer, "待核验");
  assert.equal(first.chat.turns[0].audit_only, true);

  await service.sendChatMessage(runId, paper.paper_id, {
    text: "第二轮不应看到占位回答。",
    clientRequestId: "client-short-audit-2",
  });
  assert.deepEqual(observedHistory.at(-1), []);
});

test("legacy test turns and leaked internal fields stay audit-only", async () => {
  let generated = 0;
  const observedHistory = [];
  const { service, runId } = await setup({
    chatGenerator: async (options) => {
      generated += 1;
      const artifact = await generateReadingChatMessage(options);
      const answer = generated === 1
        ? "测试换行已经完成，现在可以继续正常阅读论文。"
        : generated === 2
          ? "上一轮回答错误地暴露了 `recent_turns` 内部字段，不能进入阅读上下文。"
          : artifact.result.answer;
      return {
        ...artifact,
        result: { ...artifact.result, answer },
      };
    },
    chatPreparer: (options) => {
      observedHistory.push(structuredClone(options.recentTurns ?? []));
      return prepareReadingChatMessage(options);
    },
  });
  await service.setDecisions(runId, { [paper.paper_id]: "read" });

  const first = await service.sendChatMessage(runId, paper.paper_id, {
    text: "测试换行",
    clientRequestId: "client-legacy-test-turn-1",
  });
  assert.equal(first.chat.turns[0].audit_only, true);

  const second = await service.sendChatMessage(runId, paper.paper_id, {
    text: "上一题答案是什么？",
    clientRequestId: "client-legacy-test-turn-2",
  });
  assert.equal(second.chat.turns[1].audit_only, true);

  await service.sendChatMessage(runId, paper.paper_id, {
    text: "请重新概括论文的核心贡献。",
    clientRequestId: "client-legacy-test-turn-3",
  });
  assert.deepEqual(observedHistory.at(-1), []);
});

test("paper chat supports multiple conversations with preserved history and switching", async () => {
  const { service, runId, makeService } = await setup();
  await service.setDecisions(runId, { [paper.paper_id]: "read" });

  const first = await service.sendChatMessage(runId, paper.paper_id, {
    text: "第一条会话的问题。",
    reference: null,
    clientRequestId: "client-conv-a",
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
  });
  assert.equal(first.chat.turns.length, 1);
  assert.equal(first.conversations.length, 1);

  // New conversation archives the first and starts empty.
  await assert.rejects(
    service.createConversation(runId, paper.paper_id),
    (error) => error.code === "JOURNAL_MUTATION_REQUEST_ID_REQUIRED",
  );
  const branchRequest = { clientRequestId: "create-reading-branch-1" };
  const created = await service.createConversation(
    runId,
    paper.paper_id,
    branchRequest,
  );
  assert.equal(created.chat.turns.length, 0);
  assert.equal(created.conversations.length, 2);
  assert.equal(created.conversations[0].active, true);
  const archivedEntry = created.conversations.find((entry) => !entry.active);
  assert.ok(archivedEntry, "first conversation should be archived");
  assert.equal(archivedEntry.turn_count, 1);
  assert.notEqual(created.active_conversation_id, archivedEntry.id);
  const replayed = await makeService().createConversation(
    runId,
    paper.paper_id,
    branchRequest,
  );
  assert.equal(replayed.active_conversation_id, created.active_conversation_id);
  assert.equal(replayed.conversations.length, created.conversations.length);

  // Second conversation gets its own turn.
  const second = await service.sendChatMessage(runId, paper.paper_id, {
    text: "第二条会话的问题。",
    reference: null,
    clientRequestId: "client-conv-b",
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
  });
  assert.equal(second.chat.turns.length, 1);
  assert.equal(second.chat.turns[0].question, "第二条会话的问题。");

  // Switching back restores the first conversation's history.
  const switched = await service.switchConversation(runId, paper.paper_id, archivedEntry.id);
  assert.equal(switched.active_conversation_id, archivedEntry.id);
  assert.equal(switched.chat.turns.length, 1);
  assert.equal(switched.chat.turns[0].question, "第一条会话的问题。");
  assert.equal(switched.conversations.length, 2);

  await assert.rejects(
    service.switchConversation(runId, paper.paper_id, "conversation-does-not-exist"),
    (error) => error.code === "READING_CONVERSATION_NOT_FOUND",
  );
});

test("scratch reading branches persist their checkpoint and must be promoted before archive", async () => {
  const { service, runId, makeService } = await setup();
  await service.setDecisions(runId, { [paper.paper_id]: "read" });
  const canonical = await service.sendChatMessage(runId, paper.paper_id, {
    text: "这篇论文最重要的结论是什么？",
    reference: null,
    clientRequestId: "client-branch-canonical",
  });
  const canonicalId = canonical.active_conversation_id;
  const canonicalTurnId = canonical.chat.turns[0].id;
  assert.equal(canonical.chat.branch_type, "canonical");
  assert.equal(canonical.canonical_conversation_id, canonicalId);

  const scratch = await service.createConversation(
    runId,
    paper.paper_id,
    { clientRequestId: "create-scratch-branch-1" },
  );
  const scratchId = scratch.active_conversation_id;
  assert.equal(scratch.chat.branch_type, "scratch");
  assert.equal(scratch.chat.promotion_status, "not_promoted");
  assert.deepEqual(scratch.chat.parent_checkpoint, {
    conversation_id: canonicalId,
    turn_id: canonicalTurnId,
    turn_count: 1,
    checkpoint_hash: scratch.chat.parent_checkpoint.checkpoint_hash,
    created_at: "2026-07-23T09:00:00.000Z",
  });
  assert.equal(
    scratch.chat.parent_checkpoint.checkpoint_hash.startsWith("sha256:"),
    true,
  );
  await assert.rejects(
    service.assertCanonicalForArchive(runId),
    (error) => error.code === "READING_SCRATCH_ARCHIVE_BLOCKED",
  );

  const restoredService = makeService();
  const restoredScratch = await restoredService.getReading(runId, paper.paper_id);
  assert.equal(restoredScratch.active_conversation_id, scratchId);
  assert.equal(restoredScratch.chat.branch_type, "scratch");
  assert.equal(
    restoredScratch.chat.parent_checkpoint.conversation_id,
    canonicalId,
  );

  const promoted = await restoredService.promoteConversation(
    runId,
    paper.paper_id,
    scratchId,
    {
      clientRequestId: "client-promote-scratch",
      confirmedBy: "local-user",
    },
  );
  assert.equal(promoted.chat.branch_type, "canonical");
  assert.equal(promoted.chat.promotion_status, "promoted");
  assert.equal(promoted.canonical_conversation_id, scratchId);
  assert.equal(
    promoted.conversations.find((entry) => entry.id === canonicalId)
      .promotion_status,
    "superseded",
  );
  await restoredService.assertCanonicalForArchive(runId);

  await restoredService.switchConversation(runId, paper.paper_id, canonicalId);
  await assert.rejects(
    restoredService.assertCanonicalForArchive(runId),
    (error) => error.code === "READING_SCRATCH_ARCHIVE_BLOCKED",
  );
});

test("answered turns become durable PinnedConclusions without approving any write", async () => {
  const { store, service, runId, makeService } = await setup();
  await service.setDecisions(runId, { [paper.paper_id]: "read" });
  const block = paperDocument().blocks[4];
  const selected = "evidence paragraph";
  const start = block.text.indexOf(selected);
  const answered = await service.sendChatMessage(runId, paper.paper_id, {
    text: "固定这一结论供归档综合使用。",
    reference: {
      document_revision: paperDocument().revision,
      block_id: block.block_id,
      start_offset: start,
      end_offset: start + selected.length,
    },
    clientRequestId: "client-pin-source-turn",
  });
  const turnId = answered.chat.turns[0].id;

  const pinned = await service.pinConclusion(runId, paper.paper_id, turnId, {
    clientRequestId: "client-pin-conclusion",
    confirmedBy: "local-user",
  });
  assert.equal(pinned.pinned_conclusions.length, 1);
  const conclusion = pinned.pinned_conclusions[0];
  assert.equal(conclusion.source_turn_id, turnId);
  assert.equal(conclusion.source_conversation_id, pinned.active_conversation_id);
  assert.equal(conclusion.confirmed_by, "local-user");
  assert.equal(conclusion.status, "pinned");
  assert.equal(conclusion.content, answered.chat.turns[0].answer);
  assert.equal(conclusion.citations.length > 0, true);
  assert.equal(conclusion.citations[0].block_id, block.block_id);

  const runAfterPin = await store.getRun(runId);
  assert.equal(runAfterPin.status, "reading");
  assert.equal(runAfterPin.zotero.status, "not_started");
  assert.equal(runAfterPin.obsidian, undefined);
  assert.equal(runAfterPin.project_state, undefined);
  assert.equal(runAfterPin.archive_batch, undefined);

  const restored = await makeService().getReading(runId, paper.paper_id);
  assert.equal(restored.pinned_conclusions[0].status, "pinned");
  assert.deepEqual(
    restored.pinned_conclusions[0].citations,
    conclusion.citations,
  );

  const unpinned = await makeService().unpinConclusion(
    runId,
    paper.paper_id,
    conclusion.conclusion_id,
    {
      clientRequestId: "client-unpin-conclusion",
      confirmedBy: "local-user",
    },
  );
  assert.equal(unpinned.pinned_conclusions[0].status, "unpinned");
  assert.equal(
    (await store.getRun(runId)).archive_batch,
    undefined,
  );
});

test("an answer without verified citations cannot become a PinnedConclusion", async () => {
  const { service, runId } = await setup({
    chatGenerator: async (options) => {
      const generated = await generateReadingChatMessage(options);
      return {
        ...generated,
        result: {
          ...generated.result,
          citations: [],
        },
      };
    },
  });
  await service.setDecisions(runId, { [paper.paper_id]: "read" });
  const answered = await service.sendChatMessage(runId, paper.paper_id, {
    text: "给出没有引用的回答。",
    clientRequestId: "client-pin-without-citation-source",
  });
  await assert.rejects(
    service.pinConclusion(
      runId,
      paper.paper_id,
      answered.chat.turns[0].id,
      {
        clientRequestId: "client-pin-without-citation",
        confirmedBy: "local-user",
      },
    ),
    (error) => error.code === "PINNED_CONCLUSION_CITATIONS_REQUIRED",
  );
  assert.deepEqual(
    (await service.getReading(runId, paper.paper_id)).pinned_conclusions,
    [],
  );
});

test("paper chat rejects a reused request id when any paid input changes", async () => {
  let generatorCalls = 0;
  const { service, runId } = await setup({
    chatGenerator: async (options) => {
      generatorCalls += 1;
      return generateReadingChatMessage(options);
    },
  });
  await service.setDecisions(runId, { [paper.paper_id]: "read" });
  const request = {
    text: "解释当前证据。",
    reference: null,
    clientRequestId: "client-chat-conflict",
    includeProjectContext: false,
    providerId: "codex-subscription",
    modelId: "account-default",
  };
  await service.sendChatMessage(runId, paper.paper_id, request);

  const block = paperDocument().blocks[0];
  const variants = [
    { ...request, text: "换一个问题。" },
    {
      ...request,
      reference: {
        document_revision: paperDocument().revision,
        block_id: block.block_id,
        start_offset: 0,
        end_offset: 8,
      },
    },
    { ...request, includeProjectContext: true },
    { ...request, roundId: "orientation" },
    { ...request, providerId: "deepseek" },
    { ...request, modelId: "another-model" },
  ];
  for (const variant of variants) {
    await assert.rejects(
      service.sendChatMessage(runId, paper.paper_id, variant),
      (error) => (
        error.code === "READING_CHAT_REQUEST_CONFLICT"
        && error.status === 409
      ),
    );
  }
  assert.equal(generatorCalls, 1);
});

test("paper chat requires a stable client request id before generation", async () => {
  let generatorCalls = 0;
  const { service, runId } = await setup({
    chatGenerator: async (options) => {
      generatorCalls += 1;
      return generateReadingChatMessage(options);
    },
  });
  await service.setDecisions(runId, { [paper.paper_id]: "read" });
  await assert.rejects(
    service.sendChatMessage(runId, paper.paper_id, {
      text: "解释当前证据。",
    }),
    (error) => (
      error.code === "READING_CHAT_CLIENT_REQUEST_ID_REQUIRED"
      && error.status === 400
    ),
  );
  assert.equal(generatorCalls, 0);
});

test("concurrent chat requests with different ids share one input-hash generation", async () => {
  let generatorCalls = 0;
  let releaseGeneration;
  let markGenerationStarted;
  const generationStarted = new Promise((resolve) => {
    markGenerationStarted = resolve;
  });
  const generationGate = new Promise((resolve) => {
    releaseGeneration = resolve;
  });
  const { service, runId } = await setup({
    chatGenerator: async (options) => {
      generatorCalls += 1;
      markGenerationStarted();
      await generationGate;
      return generateReadingChatMessage(options);
    },
  });
  await service.setDecisions(runId, { [paper.paper_id]: "read" });
  const request = {
    text: "解释当前有界论文证据。",
    providerId: "codex-subscription",
    modelId: "account-default",
  };
  const first = service.sendChatMessage(runId, paper.paper_id, {
    ...request,
    clientRequestId: "client-concurrent-a",
  });
  await generationStarted;
  const second = service.sendChatMessage(runId, paper.paper_id, {
    ...request,
    clientRequestId: "client-concurrent-b",
  });
  await new Promise((resolve) => setImmediate(resolve));
  releaseGeneration();

  const responses = await Promise.all([first, second]);
  assert.equal(generatorCalls, 1);
  assert.equal(
    responses[0].chat.turns.find(
      (turn) => turn.client_request_id === "client-concurrent-a",
    )?.status,
    "answered",
  );
  assert.equal(
    responses[1].chat.turns.find(
      (turn) => turn.client_request_id === "client-concurrent-b",
    )?.status,
    "answered",
  );
  const restored = await service.getReading(runId, paper.paper_id);
  assert.equal(restored.chat.turns.length, 2);
  assert.deepEqual(
    new Set(restored.chat.turns.map((turn) => turn.client_request_id)),
    new Set(["client-concurrent-a", "client-concurrent-b"]),
  );
  assert.equal(restored.chat.turns[0].answer, restored.chat.turns[1].answer);
});

test("chat cache write failures preserve and restore the paid answer inline", async () => {
  let generatorCalls = 0;
  const generator = async (options) => {
    generatorCalls += 1;
    return generateReadingChatMessage(options);
  };
  const { store, service, runId, makeService } = await setup({
    chatGenerator: generator,
  });
  await service.setDecisions(runId, { [paper.paper_id]: "read" });
  const originalWriteArtifact = store.writeArtifact.bind(store);
  store.writeArtifact = async (targetRunId, artifactPath, artifact) => {
    if (artifactPath.includes("/chat/cache/")) {
      throw Object.assign(new Error("disk unavailable"), { code: "EIO" });
    }
    return originalWriteArtifact(targetRunId, artifactPath, artifact);
  };
  const request = {
    text: "解释当前证据。",
    clientRequestId: "client-cache-write-failure",
  };

  const answered = await service.sendChatMessage(runId, paper.paper_id, request);
  assert.equal(generatorCalls, 1);
  assert.equal(answered.chat.turns[0].status, "answered");
  assert.equal(answered.chat.turns[0].cache_write_failed, true);
  assert.equal(answered.chat.turns[0].answer.length > 0, true);

  const restarted = makeService({ chatGenerator: generator });
  const restored = await restarted.sendChatMessage(
    runId,
    paper.paper_id,
    request,
  );
  assert.equal(generatorCalls, 1);
  assert.equal(restored.chat.turns.length, 1);
  assert.equal(restored.chat.turns[0].status, "answered");
  assert.equal(restored.chat.turns[0].cache_write_failed, true);
  assert.equal(restored.chat.turns[0].answer, answered.chat.turns[0].answer);
});

test("paper chat reuses an input-hash artifact without another model call", async () => {
  let generatorCalls = 0;
  const { store, service, runId } = await setup({
    chatGenerator: async (options) => {
      generatorCalls += 1;
      return generateReadingChatMessage(options);
    },
  });
  await service.setDecisions(runId, { [paper.paper_id]: "read" });
  const request = {
    text: "概括当前有界论文证据。",
    reference: null,
    clientRequestId: "client-cache-1",
    providerId: "codex-subscription",
    modelId: "account-default",
  };
  const first = await service.sendChatMessage(runId, paper.paper_id, request);
  assert.equal(generatorCalls, 1);
  assert.equal(first.chat.turns[0].cache_hit, false);

  await store.updateRun(runId, (current) => {
    const next = structuredClone(current);
    next.readings.papers[paper.paper_id].chat = {
      status: "idle",
      turns: [],
      updated_at: null,
    };
    return { readings: next.readings };
  });
  const cached = await service.sendChatMessage(runId, paper.paper_id, {
    ...request,
    clientRequestId: "client-cache-2",
  });
  assert.equal(generatorCalls, 1);
  assert.equal(cached.chat.turns[0].cache_hit, true);
  assert.equal(cached.chat.turns[0].answer, first.chat.turns[0].answer);
});

test("project context is included only by explicit request and read failures degrade visibly", async () => {
  let projectReads = 0;
  const preparedInputs = [];
  const { service, runId } = await setup({
    getProjectContext: async () => {
      projectReads += 1;
      if (projectReads === 2) throw new Error("temporary project read failure");
      return {
        source_path: "PRODUCT_MEETING.md",
        revision: "sha256:project-context",
        content: "项目当前在验证论文精读工作流。",
      };
    },
    chatPreparer: (options) => {
      const prepared = prepareReadingChatMessage(options);
      preparedInputs.push(prepared.input);
      return prepared;
    },
  });
  await service.setDecisions(runId, { [paper.paper_id]: "read" });

  await service.sendChatMessage(runId, paper.paper_id, {
    text: "把第一段翻译成中文。",
    clientRequestId: "client-normal-chat",
  });
  assert.equal(projectReads, 0);
  assert.equal(Object.hasOwn(preparedInputs[0], "project_context"), false);

  const related = await service.sendChatMessage(runId, paper.paper_id, {
    text: "它与我们的工作流有什么关系？",
    clientRequestId: "client-project-chat",
    includeProjectContext: true,
  });
  assert.equal(projectReads, 1);
  assert.equal(preparedInputs[1].project_context.status, "available");
  assert.equal(
    related.chat.turns.at(-1).project_context_revision,
    "sha256:project-context",
  );
  assert.equal(
    related.chat.turns.at(-1).project_context_source_path,
    "PRODUCT_MEETING.md",
  );

  const degraded = await service.sendChatMessage(runId, paper.paper_id, {
    text: "对这个项目的下一步还有什么启发？",
    clientRequestId: "client-project-fallback",
    includeProjectContext: true,
  });
  assert.equal(projectReads, 2);
  assert.equal(preparedInputs[2].project_context.status, "unavailable");
  assert.equal(degraded.chat.turns.at(-1).status, "answered");
  assert.equal(
    degraded.chat.turns.at(-1).project_context_status,
    "unavailable",
  );
});

test("invalid chat references fail before generation", async () => {
  let generatorCalls = 0;
  const { service, runId } = await setup({
    chatGenerator: async (options) => {
      generatorCalls += 1;
      return generateReadingChatMessage(options);
    },
  });
  await service.setDecisions(runId, { [paper.paper_id]: "read" });
  await assert.rejects(service.sendChatMessage(runId, paper.paper_id, {
    text: "解释选文。",
    reference: {
      document_revision: paperDocument().revision,
      block_id: paperDocument().blocks[0].block_id,
      start_offset: 0,
      end_offset: 20_000,
    },
    clientRequestId: "client-invalid-chat",
  }), (error) => error.code === "READING_CHAT_INPUT_INVALID");
  assert.equal(generatorCalls, 0);
});

test("later stages receive only the two most recent answered prior-stage interventions", async () => {
  const stageCalls = [];
  const { service, runId } = await setup({
    stageGenerator: async (options) => {
      stageCalls.push({
        stage: options.stage,
        previousStages: structuredClone(options.previousStages),
      });
      return generateReadingStage(options);
    },
  });
  await service.setDecisions(runId, { [paper.paper_id]: "read" });
  await service.generateStage(runId, paper.paper_id, "research-question");

  for (let index = 1; index <= 3; index += 1) {
    await service.askQuestion(runId, paper.paper_id, {
      stage: "research-question",
      text: `第 ${index} 条用户追问或纠正`,
      clientRequestId: `client-intervention-${index}`,
    });
  }
  await service.generateStage(runId, paper.paper_id, "method");

  const methodCall = stageCalls.find((call) => call.stage === "method");
  const interventions = methodCall.previousStages[0].interventions;
  assert.equal(interventions.length, 2);
  assert.deepEqual(
    interventions.map((item) => item.question),
    ["第 2 条用户追问或纠正", "第 3 条用户追问或纠正"],
  );
  assert.equal(interventions.every((item) => item.answer.includes("针对追问")), true);
  assert.equal(interventions.every((item) => item.evidence.length > 0), true);
});

test("resume marks unresolved model calls retryable instead of charging again", async () => {
  const { store, service, runId } = await setup();
  await service.setDecisions(runId, { [paper.paper_id]: "read" });
  await store.updateRun(runId, (current) => ({
    readings: {
      ...current.readings,
      papers: {
        ...current.readings.papers,
        [paper.paper_id]: {
          ...current.readings.papers[paper.paper_id],
          status: "reading",
          stages: {
            ...current.readings.papers[paper.paper_id].stages,
            "research-question": {
              ...current.readings.papers[paper.paper_id].stages["research-question"],
              status: "running",
            },
          },
          questions: [{
            id: "question-interrupted",
            client_request_id: "client-interrupted",
            stage: "research-question",
            block_id: null,
            text: "未完成问题",
            status: "running",
            error: null,
            created_at: "2026-07-23T08:30:00.000Z",
            answered_at: null,
          }],
        },
      },
    },
  }));

  const resumed = await service.resume(runId);
  assert.equal(
    resumed.readings.papers[paper.paper_id].stages["research-question"].status,
    "failed",
  );
  assert.equal(
    resumed.readings.papers[paper.paper_id].stages["research-question"].error.code,
    "READING_INTERRUPTED",
  );
  assert.equal(resumed.readings.papers[paper.paper_id].questions[0].status, "failed");
});

test("resume fails an interrupted chat without changing the reading workflow state", async () => {
  const { store, service, runId } = await setup();
  await service.setDecisions(runId, { [paper.paper_id]: "read" });
  const before = await store.getRun(runId);
  await store.updateRun(runId, (current) => {
    const next = structuredClone(current);
    next.readings.papers[paper.paper_id].chat = {
      status: "running",
      turns: [{
        id: "chat-turn-interrupted",
        client_request_id: "client-chat-interrupted",
        question: "未完成的论文对话",
        status: "running",
        reference: null,
        input_hash: `sha256:${"a".repeat(64)}`,
        artifact_json: null,
        provider_id: "deepseek",
        model_id: "deepseek-v4-flash",
        cache_hit: false,
        error: null,
        created_at: "2026-07-23T08:30:00.000Z",
        answered_at: null,
      }],
      updated_at: "2026-07-23T08:30:00.000Z",
    };
    return { readings: next.readings };
  });

  const resumed = await service.resume(runId);
  assert.equal(
    resumed.readings.papers[paper.paper_id].chat.turns[0].error.code,
    "READING_CHAT_INTERRUPTED",
  );
  assert.equal(resumed.readings.papers[paper.paper_id].chat.status, "failed");
  assert.equal(resumed.status, before.status);
  assert.equal(resumed.phase, before.phase);
  assert.equal(resumed.readings.status, before.readings.status);
  assert.equal(resumed.readings.last_error, before.readings.last_error);
});

test("deleting one paper's reading record withdraws the decision and returns it to the weekly pool", async () => {
  const { service, runId } = await setup();
  await service.setDecisions(runId, { [paper.paper_id]: "read" });
  await service.generateStage(runId, paper.paper_id, "research-question");
  await service.savePosition(runId, paper.paper_id, {
    mode: "full",
    blockId: paperDocument().blocks[5].block_id,
  });

  await assert.rejects(
    service.resetPaperReading(runId, paper.paper_id),
    (error) => error.code === "JOURNAL_MUTATION_REQUEST_ID_REQUIRED",
  );
  const resetRequest = { clientRequestId: "reset-reading-1" };
  const reset = await service.resetPaperReading(
    runId,
    paper.paper_id,
    resetRequest,
  );
  assert.equal(reset.status, "guide_ready");
  assert.equal(reset.phase, "guide_review");
  assert.deepEqual(reset.paper_decisions, {});
  assert.deepEqual(reset.readings.paper_ids, []);
  assert.equal(reset.readings.status, "not_started");
  assert.equal(reset.readings.papers[paper.paper_id], undefined);
  const replayed = await service.resetPaperReading(
    runId,
    paper.paper_id,
    resetRequest,
  );
  assert.deepEqual(replayed.paper_decisions, reset.paper_decisions);
  assert.equal(
    replayed.journal_mutations.entries["reset-reading-1"].status,
    "completed",
  );

  // The paper can be chosen again and starts a completely fresh reading.
  await service.setDecisions(runId, { [paper.paper_id]: "read" });
  const fresh = await service.getReading(runId, paper.paper_id);
  assert.equal(fresh.stages["research-question"].status, "not_started");
  assert.equal(fresh.position.block_id, null);
  assert.equal(fresh.chat.turns.length, 0);
});

test("deleting a fully read paper's record steps the run back from draft_ready", async () => {
  const { store, service, runId } = await setup();
  await service.setDecisions(runId, { [paper.paper_id]: "read" });
  for (const stage of READING_STAGE_ORDER) {
    await service.generateStage(runId, paper.paper_id, stage);
  }
  assert.equal((await store.getRun(runId)).status, "draft_ready");

  const reset = await service.resetPaperReading(
    runId,
    paper.paper_id,
    { clientRequestId: "reset-complete-reading-1" },
  );
  assert.equal(reset.status, "guide_ready");
  assert.equal(reset.phase, "guide_review");
  assert.equal(reset.readings.status, "not_started");
  assert.deepEqual(reset.readings.paper_ids, []);
});

test("paper reading reset is blocked after external writes begin or without a read decision", async () => {
  const { store, service, runId } = await setup();
  await assert.rejects(
    service.resetPaperReading(runId, paper.paper_id, {
      clientRequestId: "reset-reading-not-selected",
    }),
    (error) => error.code === "READING_RESET_NOT_ALLOWED",
  );

  await service.setDecisions(runId, { [paper.paper_id]: "read" });
  await store.updateRun(runId, {
    zotero: {
      ...(await store.getRun(runId)).zotero,
      status: "preview_ready",
    },
  });
  await assert.rejects(
    service.resetPaperReading(runId, paper.paper_id, {
      clientRequestId: "reset-reading-external-state",
    }),
    (error) => error.code === "READING_RESET_EXTERNAL_STATE",
  );
});
