import assert from "node:assert/strict";
import test from "node:test";
import {
  abandonJournalAgentNoteProposal,
  askJournalReadingQuestion,
  commitJournalAgentNoteProposal,
  commitArchiveBatch,
  createJournalAgentNoteProposal,
  createJournalReadingConversation,
  commitZoteroProposal,
  createObsidianPreview,
  createProjectStatePreview,
  createZoteroProposal,
  fetchObsidianPreview,
  fetchJournalPaperReading,
  fetchJournalPaperGuide,
  fetchJournalPaperDocument,
  fetchJournalPaperTranslation,
  fetchJournalRun,
  fetchJournalRuns,
  fetchProjectContext,
  fetchProjectStatePreview,
  fetchZoteroProposal,
  fetchZoteroTargets,
  generateJournalReadingStage,
  journalGuideNeedsRefresh,
  mapJournalPaperGuide,
  mapJournalPaperDocument,
  mapJournalPaperTranslation,
  mapJournalPaperReading,
  mapJournalRun,
  mapObsidianPreview,
  mapProjectStatePreview,
  mapZoteroProposal,
  mapZoteroTargets,
  pauseJournalPaperTranslation,
  pinJournalReadingConclusion,
  promoteJournalReadingConversation,
  resumeJournalRun,
  restartJournalReadingFromGuide,
  resetJournalPaperReading,
  retryJournalPaperDocument,
  saveJournalPaperDecisions,
  saveJournalReadingPosition,
  sendJournalReadingChatMessage,
  selectZoteroCommitOperations,
  startJournalGuides,
  startJournalPaperTranslation,
  startJournalRun,
  subscribeJournalRun,
  unpinJournalReadingConclusion,
} from "./journalRuns.js";

function withFetch(handler, task) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return Promise.resolve(task()).finally(() => {
    globalThis.fetch = original;
  });
}

const runBody = {
  run_id: "journal-run-1",
  project_id: "pi-agent-product",
  runtime_schema_version: 1,
  lifecycle: "awaiting_review",
  status: "review_ready",
  phase: "candidate_review",
  created_at: "2026-07-23T07:00:00.000Z",
  updated_at: "2026-07-23T08:00:00.000Z",
  scan_summary: { source_count: 11 },
  mineru: {
    status: "partial",
    papers: {
      "paper-1": { status: "ready" },
    },
  },
  guides: {
    status: "ready",
    requested_paper_ids: ["paper-1"],
    provider_id: "codex-subscription",
    model_id: "account-default",
    papers: {
      "paper-1": {
        status: "ready",
        document_revision: "sha256:abc",
        prompt_version: "five-minute-guide.v3",
        input_hash: "sha256:guide-input",
      },
    },
  },
  candidates: [{
    paper_id: "paper-1",
    rank: 1,
    title: "Classic agent paper",
    authors: ["A. Author"],
    venue: "ICLR",
    published_at: "2023",
    first_seen_at: null,
    display_label: "经典回顾 · 非本周新论文",
    candidate_origin: "classic_review",
    is_new: false,
    selection_summary: "A summary",
    project_impact: "An impact",
    topic_matches: ["LLM Agent"],
    heat_signals: [],
    evidence_scope: "全文",
  }],
};

test("journal runs keep classic origin and MinerU state visible", () => {
  const run = mapJournalRun(runBody);
  assert.equal(run.candidates[0].discoveryType, "经典回顾 · 非本周新论文");
  assert.equal(run.candidates[0].isNew, false);
  assert.equal(run.candidates[0].mineruStatus, "ready");
  assert.equal(run.candidates[0].mineruRunStatus, "partial");
  assert.equal(run.candidates[0].guideStatus, "ready");
  assert.deepEqual(run.guides.requestedPaperIds, ["paper-1"]);
  assert.equal(run.guides.papers["paper-1"].promptVersion, "five-minute-guide.v3");
  assert.equal(run.guides.papers["paper-1"].inputHash, "sha256:guide-input");
  assert.equal(run.candidates[0].evidenceScope, "全文已解析，尚未完成精读核验");
  assert.equal(run.candidates[0].isDemo, false);
  assert.equal(run.projectId, "pi-agent-product");
  assert.equal(run.runtimeSchemaVersion, 1);
  assert.equal(run.lifecycle, "awaiting_review");
  assert.equal(run.createdAt, "2026-07-23T07:00:00.000Z");
  assert.equal(run.phase, "candidate_review");
  assert.equal(run.scanSummary.source_count, 11);
});

test("journal run summaries keep the active paper conversation for read-only resume", () => {
  const run = mapJournalRun({
    ...runBody,
    paper_decisions: { "paper-1": "read" },
    readings: {
      status: "reading",
      paper_ids: ["paper-1"],
      papers: {
        "paper-1": {
          status: "reading",
          position: {
            mode: "full",
            block_id: "block-7",
            updated_at: "2026-07-23T09:00:00.000Z",
          },
          chat: {
            id: "reading-conversation-1",
            status: "ready",
            branch_type: "canonical",
            promotion_status: "canonical",
            turns: [],
          },
          active_conversation_id: "reading-conversation-1",
          canonical_conversation_id: "reading-conversation-1",
          conversations: [{
            id: "reading-conversation-1",
            title: "主研读",
            turn_count: 0,
            branch_type: "canonical",
            promotion_status: "canonical",
            canonical: true,
            active: true,
          }],
        },
      },
    },
  });

  assert.equal(
    run.readings.papers["paper-1"].activeConversationId,
    "reading-conversation-1",
  );
  assert.equal(run.readings.papers["paper-1"].position.blockId, "block-7");
  assert.equal(run.readings.papers["paper-1"].conversations[0].title, "主研读");
  assert.equal(run.readings.papers["paper-1"].chat.branchType, "canonical");
  assert.equal(run.readings.papers["paper-1"].conversations[0].canonical, true);
});

test("start and poll use the local journal endpoints", async () => {
  const calls = [];
  await withFetch(async (url, options = {}) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(runBody), {
      status: url === "/api/v1/journal-runs" ? 202 : 200,
      headers: { "content-type": "application/json" },
    });
  }, async () => {
    await startJournalRun({ providerId: "deepseek", modelId: "deepseek-v4-flash" });
    await fetchJournalRun("journal-run-1");
  });
  assert.equal(calls[0].url, "/api/v1/journal-runs");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    schema_version: 1,
    provider_id: "deepseek",
    model_id: "deepseek-v4-flash",
  });
  assert.equal(calls[1].url, "/api/v1/journal-runs/journal-run-1");
});

test("resume and reading branch creation send the versioned JSON mutation envelope", async () => {
  const calls = [];
  await withFetch(async (url, options = {}) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(
      url.endsWith("/resume") ? runBody : readingBody,
    ), {
      status: url.endsWith("/resume") ? 202 : 201,
      headers: { "content-type": "application/json" },
    });
  }, async () => {
    await resumeJournalRun("journal-run-1");
    await createJournalReadingConversation({
      runId: "journal-run-1",
      paperId: "paper-1",
      clientRequestId: "create-reading-conversation-1",
    });
  });

  assert.deepEqual(calls.map((call) => ({
    url: call.url,
    contentType: call.options.headers["content-type"],
    body: JSON.parse(call.options.body),
  })), [{
    url: "/api/v1/journal-runs/journal-run-1/resume",
    contentType: "application/json",
    body: { schema_version: 1 },
  }, {
    url: "/api/v1/journal-runs/journal-run-1/papers/paper-1/reading/conversations",
    contentType: "application/json",
    body: {
      schema_version: 1,
      client_request_id: "create-reading-conversation-1",
    },
  }]);
});

test("generated mutation ids survive an uncertain network failure until a response arrives", async () => {
  const bodies = [];
  let attempt = 0;
  await withFetch(async (_url, options = {}) => {
    bodies.push(JSON.parse(options.body));
    attempt += 1;
    if (attempt === 1) throw new TypeError("fetch failed");
    return new Response(JSON.stringify(runBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }, async () => {
    await assert.rejects(
      restartJournalReadingFromGuide({ runId: "journal-run-network-retry" }),
      /fetch failed/,
    );
    await restartJournalReadingFromGuide({
      runId: "journal-run-network-retry",
    });
  });

  assert.equal(typeof bodies[0].client_request_id, "string");
  assert.equal(
    bodies[1].client_request_id,
    bodies[0].client_request_id,
  );
});

test("journal run subscriptions resume after the snapshot watermark", () => {
  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      this.closed = false;
    }

    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }

    removeEventListener(type) {
      this.listeners.delete(type);
    }

    close() {
      this.closed = true;
    }

    emit(type, payload) {
      this.listeners.get(type)?.(payload);
    }
  }
  let source;
  const runs = [];
  const unsubscribe = subscribeJournalRun({
    runId: "journal-run-1",
    afterSeq: 4,
    eventSourceFactory: class extends FakeEventSource {
      constructor(url) {
        super(url);
        source = this;
      }
    },
    onRun: (run, metadata) => runs.push({ run, metadata }),
  });
  assert.equal(
    source.url,
    "/api/v1/journal-runs/journal-run-1/events?after_seq=4",
  );
  source.emit("snapshot", {
    data: JSON.stringify({
      schema_version: 1,
      snapshot_watermark: 7,
      last_seq: 7,
      run: {
        ...runBody,
        snapshot_watermark: 7,
        last_event_seq: 7,
      },
      events: [{ seq: 7, type: "run_ready" }],
    }),
  });
  assert.equal(runs[0].run.lastEventSeq, 7);
  assert.equal(runs[0].metadata.snapshotWatermark, 7);
  assert.equal(runs[0].metadata.events[0].seq, 7);
  unsubscribe();
  assert.equal(source.closed, true);
});

test("journal run request errors keep the server message for the inline status", async () => {
  await withFetch(async () => new Response(JSON.stringify({
    error: {
      code: "JOURNAL_RUN_START_FAILED",
      message: "无法启动期刊扫描",
      retryable: true,
    },
  }), {
    status: 503,
    headers: { "content-type": "application/json" },
  }), async () => {
    await assert.rejects(
      startJournalRun(),
      (error) => (
        error.message === "无法启动期刊扫描"
        && error.code === "JOURNAL_RUN_START_FAILED"
        && error.retryable === true
      ),
    );
  });
});

test("run list restores the newest persisted journal run without starting work", async () => {
  const calls = [];
  const runs = await withFetch(async (url, options = {}) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ schema_version: 1, runs: [runBody] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }, () => fetchJournalRuns());

  assert.equal(runs[0].id, "journal-run-1");
  assert.deepEqual(calls.map((call) => call.url), ["/api/v1/journal-runs"]);
  assert.equal(calls[0].options.method, undefined);
});

test("paper documents map stable sections, blocks, and the opaque PDF URL", async () => {
  const body = {
    schema_version: 1,
    run_id: "journal-run-1",
    paper_id: "paper-1",
    revision: "sha256:abc",
    title: "Paper",
    paper: { title: "Paper", authors: ["A. Author"], venue: "ACL" },
    sections: [{
      section_id: "section-intro",
      parent_section_id: "section-root",
      path: ["Paper", "Introduction"],
      ordinal: 2,
      level: 2,
      title: "Introduction",
      first_block_id: "block-1",
    }],
    blocks: [{
      block_id: "block-1",
      section_id: "section-intro",
      path: ["Paper", "Introduction"],
      ordinal: 1,
      kind: "text",
      text: "Original paragraph.",
      markdown: "Original paragraph.\n",
      previous_block_id: null,
      next_block_id: null,
    }],
    links: {
      original_pdf: "/api/v1/journal-runs/journal-run-1/papers/paper-1/pdf",
    },
  };

  const mapped = mapJournalPaperDocument(body);
  assert.equal(mapped.sections[0].firstBlockId, "block-1");
  assert.equal(mapped.blocks[0].text, "Original paragraph.");
  assert.equal(mapped.originalPdfUrl.endsWith("/paper-1/pdf"), true);

  const fetched = await withFetch(async () => new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  }), () => fetchJournalPaperDocument("journal-run-1", "paper-1"));
  assert.equal(fetched.paperId, "paper-1");
});

test("guide requests preserve exact paper ids and map only server-verified references", async () => {
  const guideBody = {
    schema_version: 1,
    run_id: "journal-run-1",
    paper_id: "paper-1",
    document_revision: "sha256:abc",
    guide: {
      paper_id: "paper-1",
      problem: "Problem",
      why_read: "Why read",
      intuition: "Intuition",
      evidence: "Evidence",
      limitations: "Limitations",
      questions: ["Question one?", "Question two?"],
      evidence_refs: ["block-00000000000000000001"],
    },
    references: [{
      block_id: "block-00000000000000000001",
      path: ["Introduction"],
      ordinal: 4,
      excerpt: "Original paragraph.",
    }],
    provenance: { prompt_version: "five-minute-guide.v2" },
  };
  const calls = [];
  await withFetch(async (url, options = {}) => {
    calls.push({ url, options });
    const body = options.method === "POST" ? runBody : guideBody;
    return new Response(JSON.stringify(body), {
      status: options.method === "POST" ? 202 : 200,
      headers: { "content-type": "application/json" },
    });
  }, async () => {
    await startJournalGuides({
      runId: "journal-run-1",
      paperIds: ["paper-1"],
      providerId: "codex-subscription",
      modelId: "account-default",
    });
    const guide = await fetchJournalPaperGuide("journal-run-1", "paper-1");
    assert.equal(guide.whyRead, "Why read");
    assert.equal(guide.references[0].ordinal, 4);
  });

  assert.equal(calls[0].url, "/api/v1/journal-runs/journal-run-1/guides");
  assert.deepEqual(JSON.parse(calls[0].options.body).paper_ids, ["paper-1"]);
  assert.equal(calls[1].url, "/api/v1/journal-runs/journal-run-1/papers/paper-1/guide");
  assert.equal(mapJournalPaperGuide(guideBody).references[0].blockId, "block-00000000000000000001");
});

test("guide mapping rejects a citation not verified by the server reference list", () => {
  assert.throws(() => mapJournalPaperGuide({
    run_id: "journal-run-1",
    paper_id: "paper-1",
    document_revision: "sha256:abc",
    guide: {
      questions: [],
      evidence_refs: ["block-unknown"],
    },
    references: [],
  }), /引用格式无效/);
});

test("guide cache refreshes when the durable artifact identity changes", () => {
  const cachedGuide = {
    documentRevision: "sha256:document-v1",
    provenance: {
      prompt_version: "five-minute-guide.v2",
      input_hash: "sha256:input-v1",
    },
  };
  assert.equal(journalGuideNeedsRefresh(cachedGuide, {
    documentRevision: "sha256:document-v1",
    promptVersion: "five-minute-guide.v3",
    inputHash: "sha256:input-v1",
  }), true);
  assert.equal(journalGuideNeedsRefresh(cachedGuide, {
    documentRevision: "sha256:document-v1",
    promptVersion: "five-minute-guide.v2",
    inputHash: "sha256:input-v1",
  }), false);
  assert.equal(journalGuideNeedsRefresh(cachedGuide, {
    documentRevision: "sha256:document-v2",
    promptVersion: "five-minute-guide.v2",
    inputHash: "sha256:input-v1",
  }), true);
});

const readingBody = {
  schema_version: 1,
  run_id: "journal-run-1",
  paper_id: "paper-1",
  paper: {
    title: "Classic agent paper",
    authors: ["A. Author"],
    venue: "ICLR",
    published_at: "2023",
    doi: "10.1000/example",
    canonical_url: "https://example.com/paper-1",
  },
  status: "reading",
  document_revision: "sha256:abc",
  current_stage: "research-question",
  position: {
    mode: "focused",
    block_id: "block-00000000000000000001",
    updated_at: "2026-07-23T09:00:00.000Z",
  },
  stage_order: ["research-question", "method", "evidence", "project-relation"],
  stages: {
    "research-question": {
      status: "ready",
      content_hash: "sha256:stage",
      input_hash: "sha256:input",
      prompt_id: "research-question",
      prompt_version: "research-question.v2",
      provider_id: "deepseek",
      model_id: "deepseek-v4-flash",
      error: null,
      updated_at: "2026-07-23T09:00:00.000Z",
      result: {
        answer: "The paper studies a persistent workflow.",
        evidence: [{
          block_id: "block-00000000000000000001",
          path: ["Introduction"],
          ordinal: 1,
          excerpt: "Original paragraph.",
          support: "This paragraph states the research problem.",
        }],
        open_questions: ["How is persistence measured?"],
      },
      provenance: {
        source: "model",
        prompt_id: "research-question",
        prompt_version: "research-question.v2",
        input_hash: "sha256:input",
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    },
  },
  questions: [{
    id: "question-1",
    client_request_id: "client-question-1",
    stage: "research-question",
    block_id: "block-00000000000000000001",
    text: "核心矛盾是什么？",
    status: "answered",
    error: null,
    created_at: "2026-07-23T09:01:00.000Z",
    answered_at: "2026-07-23T09:02:00.000Z",
    answer: "核心矛盾是长期状态与单次执行之间的断裂。",
    evidence: [{
      block_id: "block-00000000000000000001",
      path: ["Introduction"],
      ordinal: 1,
      excerpt: "Original paragraph.",
      support: "This paragraph states the research problem.",
    }],
    open_questions: [],
  }],
  chat: {
    id: "reading-conversation-1",
    title: "主研读",
    status: "ready",
    branch_type: "canonical",
    parent_checkpoint: null,
    promotion_status: "canonical",
    promoted_at: null,
    turns: [{
      id: "chat-turn-1",
      client_request_id: "client-chat-1",
      question: "这部分是什么意思？",
      status: "answered",
      reference: {
        block_id: "block-00000000000000000001",
        path: ["Introduction"],
        ordinal: 1,
        start_offset: 0,
        end_offset: 8,
        quote: "Original",
        source_hash: "sha256:quote",
      },
      answer: "这是原文中的核心问题。",
      citations: [{
        block_id: "block-00000000000000000001",
        path: ["Introduction"],
        ordinal: 1,
        start_offset: 0,
        end_offset: 8,
        quote: "Original",
        source_hash: "sha256:quote",
        support: "该选文直接提出问题。",
      }],
      provider_id: "deepseek",
      model_id: "deepseek-v4-flash",
      prompt_version: "reading-chat.v1",
      input_hash: "sha256:chat-input",
      usage: { input_tokens: 30, output_tokens: 10 },
      cache_hit: false,
      cache_write_failed: true,
      project_context_revision: "sha256:project",
      project_context_source_path: "PRODUCT_MEETING.md",
      project_context_status: "available",
      project_context_requested: true,
      error: null,
      created_at: "2026-07-23T09:03:00.000Z",
      answered_at: "2026-07-23T09:04:00.000Z",
      note_action: {
        proposal_id: "agent-note-1",
        turn_id: "chat-turn-1",
        status: "draft",
        target_locator: "/Vault/Paper.md",
        operation_label: "追加到 Agent 补充笔记",
        proposal_hash: "sha256:proposal",
        content_hash: "sha256:content",
        target_version_or_hash: "sha256:target",
        preview_or_diff: ["追加本次回答"],
        diff: { mode: "create", before: null, after: "# Paper" },
        last_error: null,
        created_at: "2026-07-23T09:05:00.000Z",
        updated_at: "2026-07-23T09:05:00.000Z",
        committed_at: null,
      },
    }],
    updated_at: "2026-07-23T09:04:00.000Z",
  },
  active_conversation_id: "reading-conversation-1",
  canonical_conversation_id: "reading-conversation-1",
  conversations: [{
    id: "reading-conversation-1",
    title: "主研读",
    turn_count: 1,
    branch_type: "canonical",
    parent_checkpoint: null,
    promotion_status: "canonical",
    promoted_at: null,
    canonical: true,
    active: true,
    updated_at: "2026-07-23T09:04:00.000Z",
  }, {
    id: "reading-conversation-branch",
    title: "方法复核",
    turn_count: 2,
    branch_type: "scratch",
    parent_checkpoint: {
      conversation_id: "reading-conversation-1",
      turn_id: "chat-turn-1",
      turn_count: 1,
      checkpoint_hash: "sha256:checkpoint",
      created_at: "2026-07-23T09:05:00.000Z",
    },
    promotion_status: "not_promoted",
    promoted_at: null,
    canonical: false,
    active: false,
    updated_at: "2026-07-23T09:06:00.000Z",
  }],
  pinned_conclusions: [{
    schema_version: 1,
    conclusion_id: "pinned-conclusion-1",
    source_conversation_id: "reading-conversation-1",
    source_turn_id: "chat-turn-1",
    source_input_hash: "sha256:chat-input",
    content: "这是原文中的核心问题。",
    content_hash: "sha256:conclusion",
    citations: [{
      block_id: "block-00000000000000000001",
      path: ["Introduction"],
      ordinal: 1,
      start_offset: 0,
      end_offset: 8,
      quote: "Original",
      source_hash: "sha256:quote",
      support: "该选文直接提出问题。",
    }],
    confirmed_by: "local-user",
    status: "pinned",
    pinned_at: "2026-07-23T09:06:00.000Z",
    unpinned_at: null,
    updated_at: "2026-07-23T09:06:00.000Z",
  }],
  agent_actions: {
    schema_version: 1,
    status: "proposal_ready",
    proposals: [],
    updated_at: "2026-07-23T09:05:00.000Z",
  },
};

test("paper reading maps stage results, exact block references, and durable questions", () => {
  const reading = mapJournalPaperReading(readingBody);
  assert.equal(reading.paperId, "paper-1");
  assert.equal(reading.paper.publishedAt, "2023");
  assert.equal(reading.position.blockId, "block-00000000000000000001");
  assert.deepEqual(reading.stageOrder, [
    "research-question",
    "method",
    "evidence",
    "project-relation",
  ]);
  assert.equal(
    reading.stages["research-question"].result.evidence[0].blockId,
    "block-00000000000000000001",
  );
  assert.equal(reading.stages["research-question"].result.openQuestions[0], "How is persistence measured?");
  assert.equal(reading.questions[0].clientRequestId, "client-question-1");
  assert.equal(reading.questions[0].answer, "核心矛盾是长期状态与单次执行之间的断裂。");
  assert.equal(reading.chat.status, "ready");
  assert.equal(reading.chat.branchType, "canonical");
  assert.equal(reading.canonicalConversationId, "reading-conversation-1");
  assert.equal(reading.conversations[0].canonical, true);
  assert.equal(reading.conversations[1].branchType, "scratch");
  assert.equal(
    reading.conversations[1].parentCheckpoint.checkpointHash,
    "sha256:checkpoint",
  );
  assert.equal(reading.chat.turns[0].reference.blockId, "block-00000000000000000001");
  assert.equal(reading.chat.turns[0].citations[0].support, "该选文直接提出问题。");
  assert.equal(reading.chat.turns[0].providerId, "deepseek");
  assert.equal(reading.chat.turns[0].cacheWriteFailed, true);
  assert.equal(reading.chat.turns[0].projectContextStatus, "available");
  assert.equal(reading.chat.turns[0].projectContextSourcePath, "PRODUCT_MEETING.md");
  assert.equal(reading.chat.turns[0].includeProjectContext, true);
  assert.equal(reading.chat.turns[0].noteAction.proposalId, "agent-note-1");
  assert.equal(reading.chat.turns[0].noteAction.diff.after, "# Paper");
  assert.equal(reading.pinnedConclusions[0].conclusionId, "pinned-conclusion-1");
  assert.equal(reading.pinnedConclusions[0].sourceTurnId, "chat-turn-1");
  assert.equal(
    reading.pinnedConclusions[0].citations[0].support,
    "该选文直接提出问题。",
  );
  assert.equal(reading.agentActions.status, "proposal_ready");
});

test("reading workflow requests match the server routes and snake-case contracts", async () => {
  const calls = [];
  const runWithReading = {
    ...runBody,
    paper_decisions: { "paper-1": "read" },
    readings: {
      schema_version: 1,
      status: "reading",
      paper_ids: ["paper-1"],
      provider_id: "deepseek",
      model_id: "deepseek-v4-flash",
      papers: {
        "paper-1": {
          status: "reading",
          document_revision: "sha256:abc",
          current_stage: "research-question",
          position: readingBody.position,
          stages: readingBody.stages,
          questions: readingBody.questions,
          chat: readingBody.chat,
          updated_at: "2026-07-23T09:02:00.000Z",
        },
      },
      last_error: null,
    },
  };
  await withFetch(async (url, options = {}) => {
    calls.push({ url, options });
    const responseBody = (
      url.endsWith("/paper-decisions")
      || url.endsWith("/reading/position")
      || url.endsWith("/reading/restart")
    )
      ? runWithReading
      : readingBody;
    return new Response(JSON.stringify(responseBody), {
      status: options.method === "POST" && !url.endsWith("/reading/position") ? 201 : 200,
      headers: { "content-type": "application/json" },
    });
  }, async () => {
    const decided = await saveJournalPaperDecisions({
      runId: "journal-run-1",
      decisions: { "paper-1": "read" },
    });
    assert.deepEqual(decided.paperDecisions, { "paper-1": "read" });
    assert.equal(decided.readings.papers["paper-1"].currentStage, "research-question");

    await fetchJournalPaperReading("journal-run-1", "paper-1");
    await generateJournalReadingStage({
      runId: "journal-run-1",
      paperId: "paper-1",
      stage: "research-question",
      providerId: "deepseek",
      modelId: "deepseek-v4-flash",
    });
    await askJournalReadingQuestion({
      runId: "journal-run-1",
      paperId: "paper-1",
      stage: "research-question",
      text: "核心矛盾是什么？",
      blockId: "block-00000000000000000001",
      clientRequestId: "client-question-1",
      providerId: "deepseek",
      modelId: "deepseek-v4-flash",
    });
    const chat = await sendJournalReadingChatMessage({
      runId: "journal-run-1",
      paperId: "paper-1",
      text: "这部分和我们的工作流有什么关系？",
      roundId: "orientation",
      reference: {
        documentRevision: "sha256:abc",
        blockId: "block-00000000000000000001",
        startOffset: 0,
        endOffset: 8,
      },
      clientRequestId: "client-chat-1",
      includeProjectContext: true,
      providerId: "deepseek",
      modelId: "deepseek-v4-flash",
    });
    assert.equal(chat.chat.turns[0].promptVersion, "reading-chat.v1");
    await saveJournalReadingPosition({
      runId: "journal-run-1",
      paperId: "paper-1",
      mode: "focused",
      blockId: "block-00000000000000000001",
    });
    await restartJournalReadingFromGuide({
      runId: "journal-run-1",
      clientRequestId: "restart-reading-1",
    });
  });

  assert.deepEqual(calls.map((call) => [call.options.method, call.url]), [
    ["PUT", "/api/v1/journal-runs/journal-run-1/paper-decisions"],
    [undefined, "/api/v1/journal-runs/journal-run-1/papers/paper-1/reading"],
    ["POST", "/api/v1/journal-runs/journal-run-1/papers/paper-1/reading/stages/research-question"],
    ["POST", "/api/v1/journal-runs/journal-run-1/papers/paper-1/reading/questions"],
    ["POST", "/api/v1/journal-runs/journal-run-1/papers/paper-1/reading/chat/messages"],
    ["POST", "/api/v1/journal-runs/journal-run-1/papers/paper-1/reading/position"],
    ["POST", "/api/v1/journal-runs/journal-run-1/reading/restart"],
  ]);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    schema_version: 1,
    decisions: [{ paper_id: "paper-1", decision: "read" }],
  });
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    schema_version: 1,
    provider_id: "deepseek",
    model_id: "deepseek-v4-flash",
  });
  assert.deepEqual(JSON.parse(calls[3].options.body), {
    schema_version: 1,
    stage: "research-question",
    text: "核心矛盾是什么？",
    block_id: "block-00000000000000000001",
    client_request_id: "client-question-1",
    provider_id: "deepseek",
    model_id: "deepseek-v4-flash",
  });
  assert.deepEqual(JSON.parse(calls[6].options.body), {
    schema_version: 1,
    from_step: "guide",
    client_request_id: "restart-reading-1",
  });
  assert.deepEqual(JSON.parse(calls[4].options.body), {
    schema_version: 1,
    client_request_id: "client-chat-1",
    text: "这部分和我们的工作流有什么关系？",
    round_id: "orientation",
    reference: {
      document_revision: "sha256:abc",
      block_id: "block-00000000000000000001",
      start_offset: 0,
      end_offset: 8,
    },
    include_project_context: true,
    provider_id: "deepseek",
    model_id: "deepseek-v4-flash",
  });
  assert.deepEqual(JSON.parse(calls[5].options.body), {
    schema_version: 1,
    mode: "focused",
    block_id: "block-00000000000000000001",
  });
});

test("paper chat client requires a request id before making a paid POST", async () => {
  let fetchCalls = 0;
  await assert.rejects(
    withFetch(async () => {
      fetchCalls += 1;
      throw new Error("fetch must not run");
    }, () => sendJournalReadingChatMessage({
      runId: "journal-run-1",
      paperId: "paper-1",
      text: "解释当前证据。",
    })),
    (error) => (
      error.code === "READING_CHAT_CLIENT_REQUEST_ID_REQUIRED"
      && error.status === 400
      && error.retryable === false
    ),
  );
  assert.equal(fetchCalls, 0);
});

test("paper chat client preserves a request-id conflict response", async () => {
  await assert.rejects(
    withFetch(async () => new Response(JSON.stringify({
      error: {
        code: "READING_CHAT_REQUEST_CONFLICT",
        message: "同一论文对话请求标识已用于不同内容",
        retryable: false,
      },
    }), {
      status: 409,
      headers: { "content-type": "application/json" },
    }), () => sendJournalReadingChatMessage({
      runId: "journal-run-1",
      paperId: "paper-1",
      text: "不同的内容",
      clientRequestId: "client-chat-1",
    })),
    (error) => (
      error.code === "READING_CHAT_REQUEST_CONFLICT"
      && error.status === 409
      && error.retryable === false
    ),
  );
});

test("reading branch promotion and pinned conclusions use explicit durable mutations", async () => {
  const calls = [];
  await withFetch(async (url, options = {}) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(readingBody), {
      status: url.endsWith("/pin") ? 201 : 200,
      headers: { "content-type": "application/json" },
    });
  }, async () => {
    await promoteJournalReadingConversation({
      runId: "journal-run-1",
      paperId: "paper-1",
      conversationId: "reading-conversation-branch",
      clientRequestId: "promote-request-1",
      confirmedBy: "local-user",
    });
    await pinJournalReadingConclusion({
      runId: "journal-run-1",
      paperId: "paper-1",
      turnId: "chat-turn-1",
      clientRequestId: "pin-request-1",
      confirmedBy: "local-user",
    });
    await unpinJournalReadingConclusion({
      runId: "journal-run-1",
      paperId: "paper-1",
      conclusionId: "pinned-conclusion-1",
      clientRequestId: "unpin-request-1",
      confirmedBy: "local-user",
    });
  });

  assert.deepEqual(calls.map((call) => call.url), [
    "/api/v1/journal-runs/journal-run-1/papers/paper-1/reading/conversations/reading-conversation-branch/promote",
    "/api/v1/journal-runs/journal-run-1/papers/paper-1/reading/chat/turns/chat-turn-1/pin",
    "/api/v1/journal-runs/journal-run-1/papers/paper-1/reading/pinned-conclusions/pinned-conclusion-1/unpin",
  ]);
  assert.deepEqual(
    calls.map((call) => JSON.parse(call.options.body)),
    [{
      schema_version: 1,
      client_request_id: "promote-request-1",
      confirmed_by: "local-user",
    }, {
      schema_version: 1,
      client_request_id: "pin-request-1",
      confirmed_by: "local-user",
    }, {
      schema_version: 1,
      client_request_id: "unpin-request-1",
      confirmed_by: "local-user",
    }],
  );
});

test("Agent note actions stay hash-bound and use explicit preview, commit, and abandon routes", async () => {
  const calls = [];
  await withFetch(async (url, options = {}) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(readingBody), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  }, async () => {
    await createJournalAgentNoteProposal({
      runId: "journal-run-1",
      paperId: "paper-1",
      turnId: "chat-turn-1",
      clientRequestId: "preview-request-1",
    });
    await commitJournalAgentNoteProposal({
      runId: "journal-run-1",
      paperId: "paper-1",
      proposalId: "agent-note-1",
      clientRequestId: "commit-request-1",
      proposalHash: "sha256:proposal",
      contentHash: "sha256:content",
      targetVersionOrHash: "sha256:target",
    });
    await abandonJournalAgentNoteProposal({
      runId: "journal-run-1",
      paperId: "paper-1",
      proposalId: "agent-note-1",
      clientRequestId: "abandon-request-1",
    });
  });

  assert.deepEqual(calls.map((call) => call.url), [
    "/api/v1/journal-runs/journal-run-1/papers/paper-1/reading/chat/turns/chat-turn-1/obsidian-note-proposals",
    "/api/v1/journal-runs/journal-run-1/papers/paper-1/reading/agent-actions/agent-note-1/commit",
    "/api/v1/journal-runs/journal-run-1/papers/paper-1/reading/agent-actions/agent-note-1/abandon",
  ]);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    schema_version: 1,
    client_request_id: "preview-request-1",
  });
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    schema_version: 1,
    client_request_id: "commit-request-1",
    proposal_hash: "sha256:proposal",
    content_hash: "sha256:content",
    target_version_or_hash: "sha256:target",
  });
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    schema_version: 1,
    client_request_id: "abandon-request-1",
  });
});

test("project context maps the canonical Markdown state without returning its full contents", async () => {
  const context = await withFetch(async () => new Response(JSON.stringify({
    schema_version: 1,
    status: "available",
    source_path: "project_state.md",
    revision: "sha256:project",
    byte_length: 512,
    state: {
      title: "Pi Agent 项目状态",
      goal: "验证首个真实工作流",
      decisions: ["工作流推进项目"],
      open_questions: ["真实质量如何？"],
      next_action: "完成真实试跑",
      next_actions: ["完成真实试跑"],
    },
    missing_sections: [],
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }), () => fetchProjectContext());

  assert.equal(context.sourcePath, "project_state.md");
  assert.equal(context.goal, "验证首个真实工作流");
  assert.deepEqual(context.nextActions, ["完成真实试跑"]);
  assert.equal("content" in context, false);
});

test("Obsidian preview stays preview-only and uses no caller-selected path", async () => {
  const body = {
    schema_version: 1,
    run_id: "journal-run-1",
    status: "preview_ready",
    write_capability: "hash_bound_commit",
    external_write_performed: false,
    target_directory: "/vault/论文精读",
    source_hash: "sha256:source",
    proposal_hash: "sha256:proposal",
    generated_at: "2026-07-23T12:00:00.000Z",
    proposals: [{
      proposal_id: "obsidian-preview-1",
      paper_id: "paper-1",
      operation: "create",
      write_mode: "create_only",
      target_locator: "/vault/论文精读/2026-Ada-Paper--abcd1234.md",
      target_details: {
        file_name: "2026-Ada-Paper--abcd1234.md",
        exists: false,
      },
      target_hash: "sha256:target",
      target_version_or_hash: "sha256:target",
      content_hash: "sha256:content",
      actionable: true,
      selected: true,
      status: "draft",
      preview_or_diff: ["新建文件"],
      markdown: "# Paper\n",
      diff: { mode: "create", before: null, after: "# Paper\n" },
    }],
  };
  const mapped = mapObsidianPreview(body);
  assert.equal(mapped.writeCapability, "hash_bound_commit");
  assert.equal(mapped.externalWritePerformed, false);
  assert.equal(mapped.proposals[0].target, "obsidian");
  assert.equal(mapped.proposals[0].markdown, "# Paper\n");

  const calls = [];
  const fetched = await withFetch(async (url, options = {}) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(body), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  }, () => createObsidianPreview({ runId: "journal-run-1" }));
  assert.equal(fetched.proposalHash, "sha256:proposal");
  assert.equal(
    calls[0].url,
    "/api/v1/journal-runs/journal-run-1/obsidian/proposals",
  );
  assert.deepEqual(JSON.parse(calls[0].options.body), { schema_version: 1 });

  await withFetch(async (url, options = {}) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }, () => fetchObsidianPreview("journal-run-1"));
  assert.equal(
    calls[1].url,
    "/api/v1/journal-runs/journal-run-1/obsidian/proposals",
  );
  assert.equal(calls[1].options.method, undefined);
});

test("project-state preview maps the exact append and accepts no caller-selected path", async () => {
  const body = {
    schema_version: 1,
    run_id: "journal-run-1",
    target_type: "project_state",
    write_capability: "hash_bound_commit",
    external_write_performed: false,
    status: "preview_ready",
    source_hash: "sha256:source",
    proposal_hash: "sha256:proposal",
    generated_at: "2026-07-23T12:30:00.000Z",
    proposal: {
      proposal_id: "project-state-preview-1",
      run_id: "journal-run-1",
      target: "project_state",
      operation: "append",
      write_mode: "append_after_approval",
      target_locator: "/project/PRODUCT_MEETING.md",
      target_details: {
        source_path: "PRODUCT_MEETING.md",
        byte_length: 321,
        current_content_hash: "sha256:before",
      },
      content_hash: "sha256:append",
      target_hash: "sha256:target",
      target_version_or_hash: "sha256:target",
      marker: "<!-- pi-agent:project-state-run:journal-run-1 -->",
      actionable: true,
      selected: true,
      status: "draft",
      preview_or_diff: ["追加到：/project/PRODUCT_MEETING.md"],
      paper_references: [{
        paper_id: "paper-1",
        title: "Classic agent paper",
        obsidian_note: "2026-Ada-Paper--abcd1234.md",
      }],
      markdown: "<!-- pi-agent:project-state-run:journal-run-1 -->\n## 阶段更新\n",
      diff: {
        mode: "append",
        append_offset_chars: 321,
        append_offset_bytes: 321,
        append_text: "\n\n<!-- pi-agent:project-state-run:journal-run-1 -->\n## 阶段更新\n",
        before_hash: "sha256:before",
        after_hash: "sha256:after",
        before_byte_length: 321,
        after_byte_length: 389,
      },
    },
  };

  const mapped = mapProjectStatePreview(body);
  assert.equal(mapped.writeCapability, "hash_bound_commit");
  assert.equal(mapped.externalWritePerformed, false);
  assert.equal(mapped.proposal.target, "project_state");
  assert.equal(mapped.proposal.title, "PRODUCT_MEETING.md");
  assert.deepEqual(mapped.proposal.paperIds, ["paper-1"]);
  assert.equal(mapped.proposal.paperReferences[0].obsidianNote, "2026-Ada-Paper--abcd1234.md");
  assert.equal(mapped.proposal.diff.appendText, undefined);
  assert.equal(
    mapped.proposal.diff.append_text,
    "\n\n<!-- pi-agent:project-state-run:journal-run-1 -->\n## 阶段更新\n",
  );
  assert.deepEqual(mapped.proposals, [mapped.proposal]);

  const calls = [];
  const created = await withFetch(async (url, options = {}) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(body), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  }, () => createProjectStatePreview({
    runId: "journal-run-1",
    targetPath: "/tmp/caller-must-not-control.md",
  }));
  assert.equal(created.proposalHash, "sha256:proposal");
  assert.equal(
    calls[0].url,
    "/api/v1/journal-runs/journal-run-1/project-state/proposals",
  );
  assert.deepEqual(JSON.parse(calls[0].options.body), { schema_version: 1 });
  assert.equal(calls[0].options.body.includes("caller-must-not-control"), false);

  const fetched = await withFetch(async (url, options = {}) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }, () => fetchProjectStatePreview("journal-run-1"));
  assert.equal(fetched.proposal.markdown, body.proposal.markdown);
  assert.equal(
    calls[1].url,
    "/api/v1/journal-runs/journal-run-1/project-state/proposals",
  );
  assert.equal(calls[1].options.method, undefined);
});

test("journal runs expose the project-state preview binding without preview contents", () => {
  const run = mapJournalRun({
    ...runBody,
    project_state: {
      schema_version: 1,
      status: "preview_ready",
      proposal_id: "project-state-preview-1",
      proposal_hash: "sha256:proposal",
      target_locator: "/project/PRODUCT_MEETING.md",
      target_hash: "sha256:target",
      content_hash: "sha256:append",
      actionable: true,
      approval: null,
      last_error: null,
      updated_at: "2026-07-23T12:30:00.000Z",
    },
  });

  assert.equal(run.projectState.status, "preview_ready");
  assert.equal(run.projectState.proposalId, "project-state-preview-1");
  assert.equal(run.projectState.proposalHash, "sha256:proposal");
  assert.equal(run.projectState.targetLocator, "/project/PRODUCT_MEETING.md");
  assert.equal(run.projectState.actionable, true);
});

const zoteroTargetBody = {
  selected_target_id: "C2",
  targets: [{
    id: "C1",
    name: "AI 前沿论文",
    library_id: 1,
    library_name: "我的文库",
    level: 2,
    path: ["我的文库", "研究", "AI 前沿论文"],
    editable: true,
    files_editable: true,
  }, {
    id: "C2",
    name: "AI 前沿论文",
    library_id: 1,
    library_name: "我的文库",
    level: 2,
    path: ["我的文库", "产品", "AI 前沿论文"],
    editable: true,
    files_editable: true,
  }],
};

const zoteroProposalBody = {
  schema_version: 1,
  run_id: "journal-run-1",
  proposal_id: "zotero-preview-abc",
  proposal_hash: "sha256:proposal",
  target: zoteroTargetBody.targets[1],
  decisions: { "paper-1": "collect" },
  proposals: [{
    proposal_id: "zotero-paper-1-abc",
    paper_id: "paper-1",
    target: "zotero",
    operation: "create",
    write_mode: "create_with_assets",
    operation_label: "新建题录并附加全文与导读",
    target_locator: "我的文库 / 产品 / AI 前沿论文",
    target_id: "C2",
    preview_or_diff: ["动作：新建题录"],
    content_hash: "sha256:content",
    target_version_or_hash: "sha256:target",
    selected: true,
    status: "draft",
    metadata: {
      title: "Classic agent paper",
      authors: ["A. Author"],
      venue: "ICLR",
      published_at: "2023",
      doi: "10.1000/example",
    },
    pdf: {
      file_name: "paper.pdf",
      byte_length: 2048,
      sha256: "sha256:pdf",
    },
    guide: {
      sections: {
        problem: "Problem",
        why_read: "Why read",
        intuition: "Intuition",
        evidence: "Evidence",
        limitations: "Limitations",
        questions: ["Question?"],
      },
      references: [{ block_id: "block-1", path: ["Introduction"] }],
    },
  }],
};

test("Zotero mappers preserve the exact per-paper approval bindings", () => {
  const targets = mapZoteroTargets(zoteroTargetBody);
  const proposal = mapZoteroProposal(zoteroProposalBody);

  assert.equal(targets.selectedTargetId, "C2");
  assert.equal(targets.targets[0].filesEditable, true);
  assert.deepEqual(targets.targets.map((target) => target.path), [
    ["我的文库", "研究", "AI 前沿论文"],
    ["我的文库", "产品", "AI 前沿论文"],
  ]);
  assert.equal(proposal.target.level, 2);
  assert.deepEqual(proposal.target.path, ["我的文库", "产品", "AI 前沿论文"]);
  assert.equal(proposal.proposalHash, "sha256:proposal");
  assert.equal(proposal.proposals[0].paperId, "paper-1");
  assert.deepEqual(proposal.proposals[0].paperIds, ["paper-1"]);
  assert.equal(proposal.proposals[0].contentHash, "sha256:content");
  assert.equal(proposal.proposals[0].targetVersionOrHash, "sha256:target");
  assert.equal(proposal.proposals[0].targetLocator, "我的文库 / 产品 / AI 前沿论文");
  assert.equal(proposal.proposals[0].guide.references[0].block_id, "block-1");

  const blocked = mapZoteroProposal({
    ...zoteroProposalBody,
    proposals: [{
      ...zoteroProposalBody.proposals[0],
      status: "blocked",
      write_mode: "manual_update_required",
      selected: true,
      error: {
        code: "ZOTERO_MANUAL_REPAIR_REQUIRED",
        message: "需要手工处理",
        retryable: false,
      },
    }],
  }).proposals[0];
  assert.equal(blocked.actionable, false);
  assert.equal(blocked.selected, false);
  assert.equal(blocked.errorCode, "ZOTERO_MANUAL_REPAIR_REQUIRED");
  assert.equal(blocked.retryable, false);

  const run = mapJournalRun({
    ...runBody,
    status: "awaiting_approval",
    zotero: {
      status: "awaiting_approval",
      target: zoteroProposalBody.target,
      decisions: zoteroProposalBody.decisions,
      proposal_id: zoteroProposalBody.proposal_id,
      proposal_hash: zoteroProposalBody.proposal_hash,
      proposals: zoteroProposalBody.proposals,
      approval: null,
      last_error: null,
    },
  });
  assert.equal(run.zotero.proposalId, "zotero-preview-abc");
  assert.equal(run.zotero.proposals[0].title, "Classic agent paper");
});

test("Zotero preview stays read-only and the legacy commit client surfaces the ArchiveBatch migration", async () => {
  const calls = [];
  await withFetch(async (url, options = {}) => {
    calls.push({ url, options });
    let body = zoteroProposalBody;
    if (url === "/api/v1/zotero/targets") body = zoteroTargetBody;
    if (url.endsWith("/zotero/commit")) {
      return new Response(JSON.stringify({
        error: {
          code: "ZOTERO_COMMIT_DEPRECATED",
          message: "旧版 Zotero 单独确认入口已停用，请通过联合归档预览确认写入",
          retryable: false,
        },
      }), {
        status: 410,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify(body), {
      status: options.method === "POST" ? 202 : 200,
      headers: { "content-type": "application/json" },
    });
  }, async () => {
    await fetchZoteroTargets();
    await createZoteroProposal({
      runId: "journal-run-1",
      targetId: "C2",
      decisions: { "paper-1": "collect" },
    });
    await fetchZoteroProposal("journal-run-1");
    await assert.rejects(
      commitZoteroProposal({
        runId: "journal-run-1",
        proposalHash: "sha256:proposal",
        operations: [{
          proposalId: "zotero-paper-1-abc",
          contentHash: "sha256:content",
          targetVersionOrHash: "sha256:target",
        }],
      }),
      (error) => (
        error.code === "ZOTERO_COMMIT_DEPRECATED"
        && error.status === 410
      ),
    );
  });

  assert.deepEqual(calls.map((call) => call.url), [
    "/api/v1/zotero/targets",
    "/api/v1/journal-runs/journal-run-1/zotero/proposals",
    "/api/v1/journal-runs/journal-run-1/zotero/proposals",
    "/api/v1/journal-runs/journal-run-1/zotero/commit",
  ]);
  assert.deepEqual(JSON.parse(calls[1].options.body).decisions, [{
    paper_id: "paper-1",
    decision: "collect",
  }]);
  assert.equal(JSON.parse(calls[1].options.body).target_id, "C2");
  assert.deepEqual(JSON.parse(calls[3].options.body), {
    schema_version: 1,
    proposal_hash: "sha256:proposal",
    operations: [{
      proposal_id: "zotero-paper-1-abc",
      content_hash: "sha256:content",
      target_version_or_hash: "sha256:target",
    }],
  });
});

test("ArchiveBatch sends one request with exact bindings for all selected targets", async () => {
  const calls = [];
  const committed = await withFetch(async (url, options = {}) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({
      ...runBody,
      status: "committing",
      archive_batch: {
        batch_id: "archive-1",
        status: "committing",
        selected_targets: ["obsidian", "zotero", "project_state"],
      },
    }), {
      status: 202,
      headers: { "content-type": "application/json" },
    });
  }, () => commitArchiveBatch({
    runId: "journal-run-1",
    clientRequestId: "archive-request-1",
    obsidian: {
      proposalHash: "sha256:obsidian-proposal",
      operations: [{
        proposalId: "obsidian-1",
        contentHash: "sha256:obsidian-content",
        targetVersionOrHash: "sha256:obsidian-target",
      }],
    },
    zotero: {
      proposalHash: "sha256:zotero-proposal",
      operations: [{
        proposalId: "zotero-1",
        contentHash: "sha256:zotero-content",
        targetVersionOrHash: "sha256:zotero-target",
      }],
    },
    projectState: {
      proposalHash: "sha256:project-proposal",
      operation: {
        proposalId: "project-state-1",
        contentHash: "sha256:project-content",
        targetVersionOrHash: "sha256:project-target",
      },
    },
  }));

  assert.equal(committed.archiveBatch.status, "committing");
  assert.equal(
    calls[0].url,
    "/api/v1/journal-runs/journal-run-1/archive/commit",
  );
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    schema_version: 1,
    client_request_id: "archive-request-1",
    obsidian: {
      proposal_hash: "sha256:obsidian-proposal",
      operations: [{
        proposal_id: "obsidian-1",
        content_hash: "sha256:obsidian-content",
        target_version_or_hash: "sha256:obsidian-target",
      }],
    },
    zotero: {
      proposal_hash: "sha256:zotero-proposal",
      operations: [{
        proposal_id: "zotero-1",
        content_hash: "sha256:zotero-content",
        target_version_or_hash: "sha256:zotero-target",
      }],
    },
    project_state: {
      proposal_hash: "sha256:project-proposal",
      operation: {
        proposal_id: "project-state-1",
        content_hash: "sha256:project-content",
        target_version_or_hash: "sha256:project-target",
      },
    },
    simulate_obsidian_failure: false,
  });
});

test("Zotero retry operations exclude blocked and non-retryable failures", () => {
  const base = {
    target: "zotero",
    selected: true,
    contentHash: "sha256:content",
    targetVersionOrHash: "sha256:target",
  };
  const proposals = [{
    ...base,
    id: "retryable",
    proposalId: "retryable",
    status: "failed",
    retryable: true,
  }, {
    ...base,
    id: "manual",
    proposalId: "manual",
    status: "failed",
    retryable: false,
  }, {
    ...base,
    id: "blocked",
    proposalId: "blocked",
    status: "blocked",
    retryable: false,
    actionable: false,
  }, {
    ...base,
    id: "manual-update",
    proposalId: "manual-update",
    status: "failed",
    retryable: true,
    actionable: false,
    writeMode: "manual_update_required",
  }, {
    ...base,
    id: "committed",
    proposalId: "committed",
    status: "committed",
  }];

  assert.deepEqual(
    selectZoteroCommitOperations(proposals, { retry: true }).map((operation) => operation.proposalId),
    ["retryable"],
  );
  assert.deepEqual(
    selectZoteroCommitOperations(proposals).map((operation) => operation.proposalId),
    ["retryable"],
  );
});

test("full-text translation maps status, progress, and per-block Chinese text", async () => {
  const body = {
    schema_version: 1,
    run_id: "journal-run-1",
    paper_id: "paper-1",
    document_revision: "sha256:abc",
    status: "partial",
    provider_id: "codex-subscription",
    model_id: "gpt-5.3-codex-spark",
    reasoning_effort: "low",
    prompt_id: "translation",
    prompt_version: "translation.v1",
    total_blocks: 3,
    translated_blocks: 2,
    passthrough_blocks: 1,
    blocks: {
      "block-1": "第一段译文。",
      "block-2": "第二段译文。",
      "block-3": 42,
    },
    error: { code: "TRANSLATION_OUTPUT_INVALID", message: "批次失败" },
    updated_at: "2026-07-25T00:00:00.000Z",
  };
  const mapped = mapJournalPaperTranslation(body);
  assert.equal(mapped.status, "partial");
  assert.equal(mapped.documentRevision, "sha256:abc");
  assert.equal(mapped.translatedBlocks, 2);
  assert.equal(mapped.totalBlocks, 3);
  assert.equal(mapped.passthroughBlocks, 1);
  assert.equal(mapped.modelId, "gpt-5.3-codex-spark");
  assert.equal(mapped.reasoningEffort, "low");
  assert.equal(mapped.promptVersion, "translation.v1");
  assert.deepEqual(Object.keys(mapped.blocks).sort(), ["block-1", "block-2"]);
  assert.equal(mapped.error.code, "TRANSLATION_OUTPUT_INVALID");

  assert.throws(
    () => mapJournalPaperTranslation({ ...body, document_revision: null }),
    /全文翻译格式无效/,
  );
  assert.throws(
    () => mapJournalPaperTranslation({ ...body, status: "unknown" }),
    /全文翻译格式无效/,
  );

  const calls = [];
  const fetched = await withFetch(async (url, options = {}) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }, () => fetchJournalPaperTranslation("journal-run-1", "paper-1"));
  assert.equal(fetched.paperId, "paper-1");
  assert.equal(
    calls[0].url,
    "/api/v1/journal-runs/journal-run-1/papers/paper-1/translation",
  );
  assert.notEqual(calls[0].options.method, "POST");

  await withFetch(async (url, options = {}) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ ...body, status: "running" }), {
      status: 202,
      headers: { "content-type": "application/json" },
    });
  }, () => startJournalPaperTranslation({
    runId: "journal-run-1",
    paperId: "paper-1",
  }));
  assert.equal(calls[1].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    schema_version: 1,
  });

  const paused = await withFetch(async (url, options = {}) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ ...body, status: "paused" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }, () => pauseJournalPaperTranslation({
    runId: "journal-run-1",
    paperId: "paper-1",
  }));
  assert.equal(paused.status, "paused");
  assert.equal(
    calls[2].url,
    "/api/v1/journal-runs/journal-run-1/papers/paper-1/translation/pause",
  );
  assert.deepEqual(JSON.parse(calls[2].options.body), { schema_version: 1 });
});

test("paper documents without a string revision are rejected", () => {
  assert.throws(
    () => mapJournalPaperDocument({
      schema_version: 1,
      run_id: "journal-run-1",
      paper_id: "paper-1",
      sections: [],
      blocks: [],
    }),
    /论文正文格式无效/,
  );
});

test("one failed paper can retry full-text preparation without re-running ready papers", async () => {
  const calls = [];
  const nextRunBody = {
    ...runBody,
    status: "review_ready",
    mineru: {
      ...runBody.mineru,
      papers: {
        ...runBody.mineru.papers,
        "paper-2": { status: "uploading" },
      },
    },
  };
  const retried = await withFetch(async (url, options = {}) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(nextRunBody), {
      status: 202,
      headers: { "content-type": "application/json" },
    });
  }, () => retryJournalPaperDocument({
    runId: "journal-run-1",
    paperId: "paper-2",
    clientRequestId: "document-retry-1",
  }));

  assert.equal(retried.id, "journal-run-1");
  assert.equal(
    calls[0].url,
    "/api/v1/journal-runs/journal-run-1/papers/paper-2/document/retry",
  );
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    schema_version: 1,
    client_request_id: "document-retry-1",
  });
});

test("clearing one paper's reading progress posts the reset endpoint", async () => {
  const calls = [];
  const run = await withFetch(async (url, options = {}) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(runBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }, () => resetJournalPaperReading({
    runId: "journal-run-1",
    paperId: "paper-1",
    clientRequestId: "reset-reading-1",
  }));

  assert.equal(run.id, "journal-run-1");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(
    calls[0].url,
    "/api/v1/journal-runs/journal-run-1/papers/paper-1/reading/reset",
  );
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    schema_version: 1,
    client_request_id: "reset-reading-1",
  });
});
