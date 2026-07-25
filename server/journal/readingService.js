import { createHash, randomUUID } from "node:crypto";
import {
  generateReadingFollowUp,
  generateReadingStage,
  READING_STAGE_ORDER,
} from "./readingGenerator.js";
import {
  generateReadingChatMessage,
  prepareReadingChatMessage,
} from "./readingChatGenerator.js";

const PAPER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const MAX_INTERVENTIONS_PER_STAGE = 2;
const CORE_READING_STAGES = READING_STAGE_ORDER.filter(
  (stage) => stage !== "project-relation",
);
const READING_STATUSES = new Set([
  "guide_ready",
  "reading",
  "draft_ready",
  "reading_ready",
  "manual_action_required",
  "partial",
]);

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  const source = typeof value === "string" ? value : stableStringify(value);
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

function publicError(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "READING_STEP_FAILED",
    message: typeof error?.message === "string"
      ? error.message.slice(0, 300)
      : "精读步骤失败",
    retryable: error?.retryable !== false,
  };
}

function readingError(code, message, status = 409, retryable = false) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.retryable = retryable;
  return error;
}

function emptyReadings() {
  return {
    schema_version: 1,
    status: "not_started",
    paper_ids: [],
    provider_id: null,
    model_id: null,
    papers: {},
    last_error: null,
  };
}

function normalizeReadings(run) {
  const readings = run?.readings;
  if (!readings || typeof readings !== "object" || Array.isArray(readings)) {
    return emptyReadings();
  }
  return {
    ...emptyReadings(),
    ...readings,
    paper_ids: Array.isArray(readings.paper_ids) ? [...readings.paper_ids] : [],
    papers: readings.papers && typeof readings.papers === "object" && !Array.isArray(readings.papers)
      ? structuredClone(readings.papers)
      : {},
  };
}

function emptyStageState() {
  return {
    status: "not_started",
    artifact_json: null,
    artifact_markdown: null,
    content_hash: null,
    input_hash: null,
    prompt_id: null,
    prompt_version: null,
    provider_id: null,
    model_id: null,
    error: null,
    updated_at: null,
  };
}

function emptyChatState() {
  return {
    id: null,
    title: null,
    status: "idle",
    turns: [],
    created_at: null,
    updated_at: null,
  };
}

function conversationTitle(turns) {
  const firstQuestion = (turns ?? []).find(
    (turn) => typeof turn?.question === "string" && turn.question.trim(),
  )?.question?.trim();
  if (!firstQuestion) return "新对话";
  return firstQuestion.length > 24 ? `${firstQuestion.slice(0, 24)}…` : firstQuestion;
}

function emptyAgentActionsState() {
  return {
    schema_version: 1,
    status: "idle",
    proposals: [],
    updated_at: null,
  };
}

function publicAgentAction(proposal) {
  if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) return null;
  return {
    proposal_id: proposal.proposal_id ?? null,
    turn_id: proposal.turn_id ?? null,
    status: proposal.status ?? "draft",
    target_locator: proposal.target_locator ?? null,
    operation_label: proposal.operation_label ?? "追加到 Agent 补充笔记",
    proposal_hash: proposal.proposal_hash ?? null,
    content_hash: proposal.content_hash ?? null,
    target_version_or_hash: proposal.target_version_or_hash ?? null,
    preview_or_diff: Array.isArray(proposal.preview_or_diff)
      ? [...proposal.preview_or_diff]
      : [],
    diff: proposal.diff && typeof proposal.diff === "object"
      ? structuredClone(proposal.diff)
      : null,
    last_error: proposal.last_error ?? null,
    created_at: proposal.created_at ?? null,
    updated_at: proposal.updated_at ?? null,
    committed_at: proposal.committed_at ?? null,
  };
}

function emptyPaperState(documentRevision = null) {
  return {
    status: "not_started",
    document_revision: documentRevision,
    current_stage: READING_STAGE_ORDER[0],
    position: {
      mode: "focused",
      block_id: null,
      updated_at: null,
    },
    stages: Object.fromEntries(
      READING_STAGE_ORDER.map((stage) => [stage, emptyStageState()]),
    ),
    questions: [],
    chat: emptyChatState(),
    archived_conversations: [],
    agent_actions: emptyAgentActionsState(),
    updated_at: null,
  };
}

function normalizePaperState(value, documentRevision = null) {
  const base = emptyPaperState(documentRevision);
  if (!value || typeof value !== "object" || Array.isArray(value)) return base;
  const stages = Object.fromEntries(READING_STAGE_ORDER.map((stage) => [
    stage,
    {
      ...emptyStageState(),
      ...(value.stages?.[stage] && typeof value.stages[stage] === "object"
        ? value.stages[stage]
        : {}),
    },
  ]));
  return {
    ...base,
    ...value,
    document_revision: value.document_revision ?? documentRevision,
    position: {
      ...base.position,
      ...(value.position && typeof value.position === "object" ? value.position : {}),
    },
    stages,
    questions: Array.isArray(value.questions) ? structuredClone(value.questions) : [],
    chat: {
      ...emptyChatState(),
      ...(value.chat && typeof value.chat === "object" && !Array.isArray(value.chat)
        ? value.chat
        : {}),
      turns: Array.isArray(value.chat?.turns) ? structuredClone(value.chat.turns) : [],
    },
    agent_actions: {
      ...emptyAgentActionsState(),
      ...(value.agent_actions
        && typeof value.agent_actions === "object"
        && !Array.isArray(value.agent_actions)
        ? value.agent_actions
        : {}),
      proposals: Array.isArray(value.agent_actions?.proposals)
        ? structuredClone(value.agent_actions.proposals)
        : [],
    },
    archived_conversations: Array.isArray(value.archived_conversations)
      ? structuredClone(value.archived_conversations)
      : [],
  };
}

function paperDecisions(run) {
  const primary = run?.paper_decisions && typeof run.paper_decisions === "object"
    && !Array.isArray(run.paper_decisions)
    ? run.paper_decisions
    : {};
  const legacy = run?.zotero?.decisions && typeof run.zotero.decisions === "object"
    && !Array.isArray(run.zotero.decisions)
    ? run.zotero.decisions
    : {};
  return { ...legacy, ...primary };
}

function stagePaths(paperId, stage) {
  return {
    json: `readings/${paperId}/${stage}.json`,
    markdown: `readings/${paperId}/${stage}.md`,
  };
}

function questionPath(paperId, questionId) {
  return `readings/${paperId}/questions/${questionId}.json`;
}

function chatCachePath(paperId, inputHash) {
  const digest = String(inputHash ?? "").replace(/^sha256:/, "");
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw readingError("READING_CHAT_CACHE_INVALID", "论文对话缓存标识无效");
  }
  return `readings/${paperId}/chat/cache/${digest}.json`;
}

function chatRequestFingerprint({
  text,
  reference,
  includeProjectContext,
  providerId,
  modelId,
}) {
  return sha256({
    text,
    reference: reference == null
      ? null
      : Array.isArray(reference.block_ids)
        ? {
            document_revision: reference.document_revision,
            block_ids: reference.block_ids,
          }
        : {
            document_revision: reference.document_revision,
            block_id: reference.block_id,
            start_offset: reference.start_offset,
            end_offset: reference.end_offset,
          },
    include_project_context: includeProjectContext,
    provider_id: providerId,
    model_id: modelId,
  });
}

function stageMarkdown(paper, artifact) {
  const evidence = artifact.result.evidence.map((item) => (
    `- \`${item.locator}\`：${item.support}`
  )).join("\n");
  const questions = artifact.result.open_questions.length > 0
    ? artifact.result.open_questions.map((item) => `- ${item}`).join("\n")
    : "- 暂无";
  return [
    `# ${paper.title} · ${artifact.stage}`,
    "",
    artifact.result.answer,
    "",
    "## 论文证据",
    "",
    evidence,
    "",
    "## 尚待核验",
    "",
    questions,
    "",
  ].join("\n");
}

function questionMarkdown(paper, artifact) {
  const evidence = artifact.result.evidence.map((item) => (
    `- \`${item.locator}\`：${item.support}`
  )).join("\n");
  return [
    `# ${paper.title} · 精读追问`,
    "",
    `> 阶段：${artifact.stage}`,
    "",
    `## 用户问题`,
    "",
    artifact.question,
    "",
    "## 回答",
    "",
    artifact.result.answer,
    "",
    "## 论文证据",
    "",
    evidence,
    "",
  ].join("\n");
}

function stageArtifactCore(artifact) {
  return {
    schema_version: artifact.schema_version,
    run_id: artifact.run_id,
    paper_id: artifact.paper_id,
    stage: artifact.stage,
    document_revision: artifact.document_revision,
    result: artifact.result,
    provenance: artifact.provenance,
  };
}

function questionArtifactCore(artifact) {
  return {
    schema_version: artifact.schema_version,
    run_id: artifact.run_id,
    paper_id: artifact.paper_id,
    question_id: artifact.question_id,
    client_request_id: artifact.client_request_id,
    stage: artifact.stage,
    block_id: artifact.block_id,
    question: artifact.question,
    document_revision: artifact.document_revision,
    stage_content_hash: artifact.stage_content_hash,
    result: artifact.result,
    provenance: artifact.provenance,
  };
}

function chatArtifactCore(artifact) {
  return {
    schema_version: artifact.schema_version,
    run_id: artifact.run_id,
    paper_id: artifact.paper_id,
    document_revision: artifact.document_revision,
    input_hash: artifact.input_hash,
    references: artifact.references,
    result: artifact.result,
    provenance: artifact.provenance,
  };
}

function documentBlockSource(block) {
  if (block?.kind === "table" && typeof block.markdown === "string") {
    return block.markdown.trim();
  }
  if (typeof block?.text === "string" && block.text.trim()) return block.text.trim();
  return typeof block?.markdown === "string" ? block.markdown.trim() : "";
}

function validateChatArtifact(artifact, {
  runId,
  paperId,
  document,
  inputHash = null,
}) {
  if (
    !artifact
    || typeof artifact !== "object"
    || Array.isArray(artifact)
    || artifact.schema_version !== 1
    || artifact.run_id !== runId
    || artifact.paper_id !== paperId
    || artifact.document_revision !== document.revision
    || (inputHash && artifact.input_hash !== inputHash)
    || artifact.content_hash !== sha256(chatArtifactCore(artifact))
    || !Array.isArray(artifact.references)
    || artifact.references.length < 1
    || artifact.references.length > 8
    || !artifact.result
    || artifact.result.paper_id !== paperId
    || typeof artifact.result.answer !== "string"
    || artifact.result.answer.trim().length < 2
    || artifact.result.answer.length > 3_000
    || !Array.isArray(artifact.result.citations)
    || artifact.result.citations.length > 8
  ) {
    throw readingError("READING_CHAT_ARTIFACT_CORRUPT", "论文对话产物校验失败");
  }
  const documentBlocks = new Map(document.blocks.map((block) => [block.block_id, block]));
  const referenceIds = new Set();
  for (const reference of artifact.references) {
    const block = documentBlocks.get(reference?.block_id);
    const source = documentBlockSource(block);
    if (
      !reference
      || typeof reference.reference_id !== "string"
      || referenceIds.has(reference.reference_id)
      || !block
      || !Number.isSafeInteger(reference.start_offset)
      || !Number.isSafeInteger(reference.end_offset)
      || reference.start_offset < 0
      || reference.end_offset <= reference.start_offset
      || reference.end_offset > source.length
      || source.slice(reference.start_offset, reference.end_offset) !== reference.content
      || reference.source_hash !== sha256(reference.content)
    ) {
      throw readingError("READING_CHAT_ARTIFACT_CORRUPT", "论文对话引用校验失败");
    }
    referenceIds.add(reference.reference_id);
  }
  const cited = new Set();
  for (const citation of artifact.result.citations) {
    if (
      !citation
      || typeof citation.reference_id !== "string"
      || !referenceIds.has(citation.reference_id)
      || cited.has(citation.reference_id)
      || typeof citation.support !== "string"
      || citation.support.trim().length < 2
      || citation.support.length > 300
    ) {
      throw readingError("READING_CHAT_ARTIFACT_CORRUPT", "论文对话引用校验失败");
    }
    cited.add(citation.reference_id);
  }
  if (
    !artifact.provenance
    || typeof artifact.provenance.prompt_id !== "string"
    || typeof artifact.provenance.prompt_version !== "string"
    || artifact.provenance.input_hash !== artifact.input_hash
    || (
      artifact.provenance.project_context_status === "available"
      && (
        typeof artifact.provenance.project_context_revision !== "string"
        || typeof artifact.provenance.project_context_source_path !== "string"
        || !artifact.provenance.project_context_source_path.trim()
      )
    )
  ) {
    throw readingError("READING_CHAT_ARTIFACT_CORRUPT", "论文对话来源校验失败");
  }
  return artifact;
}

function publicChatReference(reference) {
  if (!reference) return null;
  return {
    block_id: reference.block_id,
    path: [...(reference.path ?? [])],
    ordinal: reference.ordinal ?? null,
    start_offset: reference.start_offset,
    end_offset: reference.end_offset,
    quote: reference.content,
    source_hash: reference.source_hash,
  };
}

function expandedChatCitations(artifact) {
  const references = new Map(
    artifact.references.map((reference) => [reference.reference_id, reference]),
  );
  return artifact.result.citations.map((citation) => ({
    ...publicChatReference(references.get(citation.reference_id)),
    support: citation.support,
  }));
}

function validateResult(result, paperId, stage, blockIds) {
  if (
    !result
    || typeof result !== "object"
    || Array.isArray(result)
    || result.paper_id !== paperId
    || result.stage !== stage
    || typeof result.answer !== "string"
    || result.answer.trim().length < 8
    || !Array.isArray(result.evidence)
    || result.evidence.length < 1
    || result.evidence.length > 8
    || !Array.isArray(result.open_questions)
    || result.open_questions.length > 5
  ) {
    throw readingError("READING_ARTIFACT_CORRUPT", "精读产物校验失败");
  }
  const seen = new Set();
  for (const item of result.evidence) {
    if (
      !item
      || typeof item.locator !== "string"
      || !blockIds.has(item.locator)
      || seen.has(item.locator)
      || typeof item.support !== "string"
      || item.support.trim().length < 2
    ) {
      throw readingError("READING_ARTIFACT_CORRUPT", "精读引用校验失败");
    }
    seen.add(item.locator);
  }
  return result;
}

function validateStageArtifact(artifact, {
  runId,
  paperId,
  stage,
  document,
}) {
  const blockIds = new Set(document.blocks.map((block) => block.block_id));
  if (
    !artifact
    || typeof artifact !== "object"
    || Array.isArray(artifact)
    || artifact.schema_version !== 1
    || artifact.run_id !== runId
    || artifact.paper_id !== paperId
    || artifact.stage !== stage
    || artifact.document_revision !== document.revision
    || artifact.content_hash !== sha256(stageArtifactCore(artifact))
  ) {
    throw readingError("READING_ARTIFACT_CORRUPT", "精读产物校验失败");
  }
  validateResult(artifact.result, paperId, stage, blockIds);
  return artifact;
}

function validateQuestionArtifact(artifact, {
  runId,
  paperId,
  document,
  stageArtifact,
}) {
  const blockIds = new Set(document.blocks.map((block) => block.block_id));
  if (
    !artifact
    || typeof artifact !== "object"
    || Array.isArray(artifact)
    || artifact.schema_version !== 1
    || artifact.run_id !== runId
    || artifact.paper_id !== paperId
    || artifact.document_revision !== document.revision
    || artifact.stage_content_hash !== stageArtifact.content_hash
    || artifact.content_hash !== sha256(questionArtifactCore(artifact))
  ) {
    throw readingError("READING_QUESTION_CORRUPT", "精读追问产物校验失败");
  }
  validateResult(artifact.result, paperId, artifact.stage, blockIds);
  return artifact;
}

function expandedEvidence(document, evidence) {
  const blocks = new Map(document.blocks.map((block) => [block.block_id, block]));
  return evidence.map((item) => {
    const block = blocks.get(item.locator);
    if (!block) throw readingError("READING_ARTIFACT_CORRUPT", "精读引用已不在当前正文中");
    return {
      block_id: block.block_id,
      path: [...(block.path ?? [])],
      ordinal: block.ordinal,
      excerpt: String(block.text || block.markdown)
        .trim()
        .replaceAll(/\s+/g, " ")
        .slice(0, 280),
      support: item.support,
    };
  });
}

export function createReadingService({
  runStore,
  getPaperDocument,
  getRunPaper,
  getProjectContext,
  modelProviders,
  modelMode = "fixture",
  defaultProviderId = "codex-subscription",
  defaultModelId = "account-default",
  stageGenerator = generateReadingStage,
  followUpGenerator = generateReadingFollowUp,
  chatGenerator = generateReadingChatMessage,
  chatPreparer = prepareReadingChatMessage,
  now = () => new Date(),
  idFactory = randomUUID,
} = {}) {
  if (!runStore || !getPaperDocument || !getRunPaper || !getProjectContext) {
    throw new Error("reading service dependencies are required");
  }
  const inFlight = new Map();
  const chatRequestInFlight = new Map();
  const chatGenerationInFlight = new Map();
  const chatMemoryCache = new Map();

  async function update(runId, patch, event) {
    const run = await runStore.updateRun(runId, patch);
    if (event) await runStore.appendEvent(runId, { ...event, at: run.updated_at });
    return run;
  }

  async function setDecisions(runId, nextDecisions) {
    const { run } = await getRunPaper(runId, null, { paperOptional: true });
    if (!READING_STATUSES.has(run.status)) {
      throw readingError("PAPER_DECISION_NOT_ALLOWED", "当前阶段不能修改论文决定");
    }
    if (!nextDecisions || typeof nextDecisions !== "object" || Array.isArray(nextDecisions)) {
      throw readingError("PAPER_DECISION_INVALID", "论文决定格式无效", 400);
    }
    const requested = (run.guides?.requested_paper_ids ?? []).filter(
      (paperId) => run.guides?.papers?.[paperId]?.status === "ready",
    );
    const entries = Object.entries(nextDecisions);
    if (
      requested.length < 1
      || requested.length > 2
      || entries.length < 1
      || entries.some(([paperId, decision]) => (
        !requested.includes(paperId)
        || !["collect", "read"].includes(decision)
      ))
    ) {
      throw readingError(
        "PAPER_DECISION_INVALID",
        "只能为本轮一至两篇导读已完成的论文选择收藏或精读",
        400,
      );
    }
    const currentDecisions = paperDecisions(run);
    const currentReadings = normalizeReadings(run);
    for (const [paperId, decision] of entries) {
      const prior = currentDecisions[paperId];
      const paperState = normalizePaperState(currentReadings.papers[paperId]);
      const hasStarted = Object.values(paperState.stages).some(
        (stage) => stage.status !== "not_started",
      );
      if (prior && prior !== decision && hasStarted) {
        throw readingError(
          "PAPER_DECISION_LOCKED",
          "该论文已经开始精读，不能直接改为另一种处理方式",
        );
      }
    }
    const decisions = Object.fromEntries(requested.map((paperId) => [
      paperId,
      nextDecisions[paperId] ?? currentDecisions[paperId],
    ]).filter(([, decision]) => ["collect", "read"].includes(decision)));
    const allDecided = requested.every((paperId) => decisions[paperId]);
    const readPaperIds = requested.filter((paperId) => decisions[paperId] === "read");
    const documents = allDecided && readPaperIds.length > 0
      ? await Promise.all(readPaperIds.map((paperId) => getPaperDocument(runId, paperId)))
      : [];
    const documentByPaperId = new Map(documents.map((document) => [document.paper_id, document]));
    const nextReadings = normalizeReadings(run);
    nextReadings.paper_ids = [...readPaperIds];
    nextReadings.status = allDecided && readPaperIds.length > 0 ? "reading" : "not_started";
    nextReadings.last_error = null;
    for (const paperId of readPaperIds) {
      const document = documentByPaperId.get(paperId);
      const paperState = normalizePaperState(
        nextReadings.papers[paperId],
        document.revision,
      );
      if (
        paperState.document_revision
        && paperState.document_revision !== document.revision
      ) {
        throw readingError(
          "READING_DOCUMENT_CHANGED",
          "论文正文已经变化，需要重新开始精读",
        );
      }
      nextReadings.papers[paperId] = {
        ...paperState,
        document_revision: document.revision,
      };
    }
    return update(runId, (current) => {
      const hasExternalOutcome = [
        "committed",
        "partial",
        "blocked",
        "manual_action_required",
      ].includes(current.zotero?.status);
      const status = !allDecided
        ? "guide_ready"
        : hasExternalOutcome
          ? current.status
          : readPaperIds.length > 0
            ? "reading"
            : "draft_ready";
      return {
        status,
        phase: !allDecided
          ? "guide_review"
          : readPaperIds.length > 0
            ? "close_reading"
            : "write_preview",
        paused_reason: !allDecided
          ? `还需决定 ${requested.length - Object.keys(decisions).length} 篇论文`
          : readPaperIds.length > 0
            ? "等待生成第一阶段精读"
            : "导读决定已完成，等待生成写入预览",
        paper_decisions: decisions,
        readings: nextReadings,
      };
    }, {
      type: "paper_decisions_updated",
      decisions,
    });
  }

  function assertRestartableFromGuide(run) {
    if (!["guide_ready", "reading", "draft_ready"].includes(run?.status)) {
      throw readingError(
        "READING_RESTART_NOT_ALLOWED",
        "当前阶段不能返回五分钟导读重新开始",
      );
    }
    const externalState = [
      run.zotero?.status,
      run.obsidian?.status,
      run.project_state?.status,
    ].find((status) => status && status !== "not_started");
    if (externalState) {
      throw readingError(
        "READING_RESTART_EXTERNAL_STATE",
        "归档预览或外部写入已经开始，不能再清空本轮研读状态",
      );
    }
    const committedAgentAction = Object.values(normalizeReadings(run).papers)
      .some((paperState) => normalizePaperState(paperState).agent_actions.proposals
        .some((proposal) => proposal?.status === "committed"));
    if (committedAgentAction) {
      throw readingError(
        "READING_RESTART_EXTERNAL_STATE",
        "已有论文 Agent 笔记完成写入，不能再清空本轮研读状态",
      );
    }
    const readyGuideIds = (run.guides?.requested_paper_ids ?? []).filter(
      (paperId) => run.guides?.papers?.[paperId]?.status === "ready",
    );
    if (readyGuideIds.length < 1) {
      throw readingError(
        "READING_RESTART_GUIDE_NOT_READY",
        "当前没有可返回的五分钟导读",
      );
    }
  }

  async function restartFromGuide(runId) {
    const run = await runStore.getRun(runId);
    if (!run) {
      throw readingError("RUN_NOT_FOUND", "运行不存在", 404);
    }
    assertRestartableFromGuide(run);
    const restartedAt = now().toISOString();
    const revision = sha256({
      run_id: runId,
      restarted_at: restartedAt,
      nonce: idFactory(),
    });
    const snapshotPath = `restarts/${revision.slice(7)}.json`;
    await runStore.writeArtifact(runId, snapshotPath, {
      schema_version: 1,
      run_id: runId,
      from_step: "candidates",
      paper_decisions: paperDecisions(run),
      readings: normalizeReadings(run),
      created_at: restartedAt,
    });
    const restarted = await update(runId, (current) => {
      assertRestartableFromGuide(current);
      return {
        status: "review_ready",
        phase: "candidate_review",
        paused_reason: "已返回本周推荐文章，可重新选择要研读的论文",
        paper_decisions: {},
        readings: emptyReadings(),
        reading_restart: {
          revision,
          from_step: "candidates",
          restarted_at: restartedAt,
        },
      };
    }, {
      type: "reading_restarted_from_guide",
      from_step: "candidates",
      revision,
      snapshot_artifact: snapshotPath,
    });
    return restarted;
  }

  let conversationSeq = 0;
  function nextConversationId() {
    conversationSeq += 1;
    return `conversation-${sha256({ seq: conversationSeq, nonce: idFactory() }).slice(7, 23)}`;
  }

  async function createConversation(runId, paperId) {
    await getRunPaper(runId, paperId);
    const createdAt = now().toISOString();
    await update(runId, (current) => {
      const readings = normalizeReadings(current);
      const paperState = normalizePaperState(readings.papers[paperId]);
      const archived = [...paperState.archived_conversations];
      if (paperState.chat.turns.length > 0) {
        archived.unshift({
          id: paperState.chat.id ?? nextConversationId(),
          title: paperState.chat.title ?? conversationTitle(paperState.chat.turns),
          created_at: paperState.chat.created_at ?? createdAt,
          updated_at: paperState.chat.updated_at ?? createdAt,
          turns: structuredClone(paperState.chat.turns),
        });
      }
      readings.papers[paperId] = {
        ...paperState,
        chat: {
          id: nextConversationId(),
          title: null,
          status: "idle",
          turns: [],
          created_at: createdAt,
          updated_at: createdAt,
        },
        archived_conversations: archived,
        updated_at: createdAt,
      };
      return { readings };
    }, { type: "reading_conversation_created", paper_id: paperId });
    return getReading(runId, paperId);
  }

  async function switchConversation(runId, paperId, conversationId) {
    if (typeof conversationId !== "string" || !conversationId) {
      throw readingError("READING_CONVERSATION_INVALID", "缺少会话标识", 400);
    }
    const { run } = await getRunPaper(runId, paperId);
    const current0 = normalizePaperState(normalizeReadings(run).papers[paperId]);
    const activeId0 = current0.chat.id ?? "current";
    if (conversationId === activeId0) return getReading(runId, paperId);
    if (!current0.archived_conversations.some((entry) => entry.id === conversationId)) {
      throw readingError("READING_CONVERSATION_NOT_FOUND", "会话不存在", 404);
    }
    const switchedAt = now().toISOString();
    await update(runId, (currentRun) => {
      const readings = normalizeReadings(currentRun);
      const paperState = normalizePaperState(readings.papers[paperId]);
      const archived = [...paperState.archived_conversations];
      const targetIndex = archived.findIndex((entry) => entry.id === conversationId);
      if (targetIndex < 0) return { readings };
      const [target] = archived.splice(targetIndex, 1);
      archived.unshift({
        id: paperState.chat.id ?? nextConversationId(),
        title: paperState.chat.title ?? conversationTitle(paperState.chat.turns),
        created_at: paperState.chat.created_at ?? switchedAt,
        updated_at: paperState.chat.updated_at ?? switchedAt,
        turns: structuredClone(paperState.chat.turns),
      });
      readings.papers[paperId] = {
        ...paperState,
        chat: {
          id: target.id,
          title: target.title ?? null,
          status: "idle",
          turns: structuredClone(target.turns ?? []),
          created_at: target.created_at ?? switchedAt,
          updated_at: switchedAt,
        },
        archived_conversations: archived,
        updated_at: switchedAt,
      };
      return { readings };
    }, { type: "reading_conversation_switched", paper_id: paperId });
    return getReading(runId, paperId);
  }

  async function stageArtifacts(runId, paperId, stageIds, document) {
    const run = await runStore.getRun(runId);
    const paperState = normalizePaperState(
      normalizeReadings(run).papers[paperId],
      document.revision,
    );
    const results = [];
    for (const stage of stageIds) {
      const paths = stagePaths(paperId, stage);
      const artifact = validateStageArtifact(
        await runStore.readArtifact(runId, paths.json),
        { runId, paperId, stage, document },
      );
      const answeredQuestions = paperState.questions
        .filter((question) => question.stage === stage && question.status === "answered")
        .slice(-MAX_INTERVENTIONS_PER_STAGE);
      const interventions = [];
      for (const question of answeredQuestions) {
        const questionArtifact = validateQuestionArtifact(
          await runStore.readArtifact(runId, questionPath(paperId, question.id)),
          { runId, paperId, document, stageArtifact: artifact },
        );
        interventions.push({
          question: questionArtifact.question,
          answer: questionArtifact.result.answer,
          evidence: questionArtifact.result.evidence.map((item) => ({ ...item })),
        });
      }
      results.push({
        ...artifact.result,
        interventions,
      });
    }
    return results;
  }

  function chatStateWithTurns(chat, turns, updatedAt) {
    const last = turns.at(-1);
    return {
      ...chat,
      status: turns.some((turn) => turn.status === "running")
        ? "running"
        : last?.status === "failed"
          ? "failed"
          : turns.some((turn) => turn.status === "answered")
            ? "ready"
            : "idle",
      turns,
      updated_at: updatedAt,
    };
  }

  function chatMemoryKey(runId, paperId, inputHash) {
    return `${runId}:${paperId}:${inputHash}`;
  }

  async function readChatCache(
    runId,
    paperId,
    inputHash,
    document,
    { strict = false, inlineArtifact = null } = {},
  ) {
    const memoryKey = chatMemoryKey(runId, paperId, inputHash);
    const memoryRecord = chatMemoryCache.get(memoryKey);
    if (memoryRecord) {
      try {
        return {
          ...memoryRecord,
          artifact: validateChatArtifact(memoryRecord.artifact, {
            runId,
            paperId,
            document,
            inputHash,
          }),
        };
      } catch {
        chatMemoryCache.delete(memoryKey);
      }
    }
    if (inlineArtifact) {
      try {
        const artifact = validateChatArtifact(inlineArtifact, {
          runId,
          paperId,
          document,
          inputHash,
        });
        const record = { artifact, cacheWriteFailed: true };
        chatMemoryCache.set(memoryKey, record);
        return record;
      } catch (error) {
        if (strict) throw error;
      }
    }
    try {
      const artifact = validateChatArtifact(
        await runStore.readArtifact(runId, chatCachePath(paperId, inputHash)),
        { runId, paperId, document, inputHash },
      );
      const record = { artifact, cacheWriteFailed: false };
      chatMemoryCache.set(memoryKey, record);
      return record;
    } catch (error) {
      if (strict) throw error;
      return null;
    }
  }

  async function recentChatTurns(runId, paperId, paperState, document) {
    const turns = paperState.chat.turns
      .filter((turn) => turn.status === "answered" && typeof turn.input_hash === "string")
      .slice(-4);
    const history = [];
    for (const turn of turns) {
      const cached = await readChatCache(
        runId,
        paperId,
        turn.input_hash,
        document,
        {
          strict: true,
          inlineArtifact: turn.inline_artifact ?? null,
        },
      );
      history.push({
        question: turn.question,
        answer: cached.artifact.result.answer,
      });
    }
    return history;
  }

  async function generateChatArtifact({
    runId,
    paperId,
    document,
    prepared,
    providerId,
    modelId,
  }) {
    const generated = await chatGenerator({
      prepared,
      providerId,
      modelId,
      modelProviders,
      modelMode,
    });
    const artifactBase = {
      schema_version: 1,
      run_id: runId,
      paper_id: paperId,
      document_revision: document.revision,
      input_hash: prepared.inputHash,
      references: prepared.references.map((item) => ({
        ...item,
        source_hash: sha256(item.content),
      })),
      result: generated.result,
      provenance: {
        source: generated.source,
        provider_id: generated.provider_id ?? null,
        model_id: generated.model_id ?? null,
        prompt_id: generated.prompt_id,
        prompt_version: generated.prompt_version,
        prompt_hash: generated.prompt_hash,
        input_hash: generated.input_hash,
        input_reference_count: generated.input_reference_count,
        input_chars: generated.input_chars,
        project_context_revision: generated.project_context_revision ?? null,
        project_context_source_path:
          generated.project_context_source_path ?? null,
        project_context_requested: Boolean(generated.project_context_requested),
        project_context_status: prepared.projectContext?.status ?? "not_requested",
        operation_id: generated.operation_id ?? null,
        upstream_request_id: generated.upstream_request_id ?? null,
        usage: generated.usage ?? null,
      },
    };
    const artifact = {
      ...artifactBase,
      content_hash: sha256(artifactBase),
      generated_at: now().toISOString(),
    };
    validateChatArtifact(artifact, {
      runId,
      paperId,
      document,
      inputHash: prepared.inputHash,
    });
    const memoryKey = chatMemoryKey(runId, paperId, prepared.inputHash);
    chatMemoryCache.set(memoryKey, { artifact, cacheWriteFailed: false });
    let cacheWriteFailed = false;
    try {
      await runStore.writeArtifact(
        runId,
        chatCachePath(paperId, prepared.inputHash),
        artifact,
      );
    } catch (error) {
      cacheWriteFailed = true;
      chatMemoryCache.set(memoryKey, { artifact, cacheWriteFailed: true });
      console.warn(
        `Pi Agent reading chat cache write failed (${error?.code || "unknown"})`,
      );
    }
    return { artifact, cacheWriteFailed };
  }

  function getOrGenerateChatArtifact(options) {
    const key = chatMemoryKey(
      options.runId,
      options.paperId,
      options.prepared.inputHash,
    );
    if (chatGenerationInFlight.has(key)) return chatGenerationInFlight.get(key);
    const operation = generateChatArtifact(options)
      .finally(() => {
        if (chatGenerationInFlight.get(key) === operation) {
          chatGenerationInFlight.delete(key);
        }
      });
    chatGenerationInFlight.set(key, operation);
    return operation;
  }

  async function sendChatMessageUnlocked(runId, paperId, {
    text,
    reference = null,
    clientRequestId,
    includeProjectContext = false,
    providerId = defaultProviderId,
    modelId = defaultModelId,
    requestFingerprint = null,
  } = {}) {
    const requestId = clientRequestId;
    if (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId)) {
      throw readingError(
        "READING_CHAT_CLIENT_REQUEST_ID_REQUIRED",
        "论文对话必须提供稳定的请求标识",
        400,
      );
    }
    const question = typeof text === "string" ? text.trim() : "";
    if (!question || question.length > 1_000) {
      throw readingError(
        "READING_CHAT_INPUT_INVALID",
        "论文对话任务必须是 1 至 1000 个字符",
        400,
      );
    }
    const fingerprint = requestFingerprint ?? chatRequestFingerprint({
      text: question,
      reference,
      includeProjectContext: includeProjectContext === true,
      providerId,
      modelId,
    });
    const { run, paper } = await getRunPaper(runId, paperId);
    if (paperDecisions(run)[paperId] !== "read") {
      throw readingError("READING_NOT_SELECTED", "该论文尚未明确选择进入精读");
    }
    const readings = normalizeReadings(run);
    const document = await getPaperDocument(runId, paperId);
    const paperState = normalizePaperState(readings.papers[paperId], document.revision);
    if (
      paperState.document_revision
      && paperState.document_revision !== document.revision
    ) {
      throw readingError(
        "READING_DOCUMENT_CHANGED",
        "论文正文已经变化，需要重新开始精读",
      );
    }
    const existing = paperState.chat.turns.find(
      (turn) => turn.client_request_id === requestId,
    );
    if (existing) {
      if (existing.request_fingerprint !== fingerprint) {
        throw readingError(
          "READING_CHAT_REQUEST_CONFLICT",
          "同一论文对话请求标识已用于不同内容",
          409,
        );
      }
      return getReading(runId, paperId);
    }
    if (
      typeof modelProviders?.supports === "function"
      && !modelProviders.supports(providerId, modelId)
    ) {
      throw readingError(
        "READING_CHAT_PROVIDER_UNSUPPORTED",
        "当前模型不支持论文对话",
        400,
      );
    }
    const projectContextRequested = includeProjectContext === true;
    let projectContext = null;
    if (projectContextRequested) {
      try {
        projectContext = await getProjectContext();
      } catch {
        projectContext = null;
      }
    }
    const prepared = chatPreparer({
      paper,
      document,
      question,
      reference,
      recentTurns: await recentChatTurns(runId, paperId, paperState, document),
      projectContext,
      projectContextRequested,
      providerId,
      modelId,
    });
    const turnId = `chat-turn-${sha256({
      run_id: runId,
      paper_id: paperId,
      client_request_id: requestId,
    }).slice(7, 23)}`;
    const cachePath = chatCachePath(paperId, prepared.inputHash);
    const createdAt = now().toISOString();
    const inlineArtifact = paperState.chat.turns.find(
      (turn) => (
        turn.input_hash === prepared.inputHash
        && turn.inline_artifact
      ),
    )?.inline_artifact ?? null;
    const cachedRecord = await readChatCache(
      runId,
      paperId,
      prepared.inputHash,
      document,
      { inlineArtifact },
    );
    if (cachedRecord) {
      const cached = cachedRecord.artifact;
      await update(runId, (current) => {
        const nextReadings = normalizeReadings(current);
        const nextPaper = normalizePaperState(nextReadings.papers[paperId], document.revision);
        const turns = [
          ...nextPaper.chat.turns,
          {
            id: turnId,
            client_request_id: requestId,
            request_fingerprint: fingerprint,
            question: prepared.question,
            status: "answered",
            reference: reference == null ? null : publicChatReference(cached.references[0]),
            input_hash: prepared.inputHash,
            artifact_json: cachePath,
            provider_id: cached.provenance.provider_id ?? providerId,
            model_id: cached.provenance.model_id ?? modelId,
            cache_hit: true,
            cache_write_failed: cachedRecord.cacheWriteFailed,
            inline_artifact: cachedRecord.cacheWriteFailed ? cached : null,
            project_context_status:
              cached.provenance.project_context_status ?? "not_requested",
            project_context_requested: Boolean(
              cached.provenance.project_context_requested,
            ),
            project_context_source_path:
              cached.provenance.project_context_source_path ?? null,
            error: null,
            created_at: createdAt,
            answered_at: createdAt,
          },
        ];
        nextReadings.papers[paperId] = {
          ...nextPaper,
          chat: chatStateWithTurns(nextPaper.chat, turns, createdAt),
          updated_at: createdAt,
        };
        return { readings: nextReadings };
      }, {
        type: "reading_chat_cache_hit",
        paper_id: paperId,
        turn_id: turnId,
        input_hash: prepared.inputHash,
      });
      return getReading(runId, paperId);
    }

    let started = false;
    await update(runId, (current) => {
      const nextReadings = normalizeReadings(current);
      const nextPaper = normalizePaperState(nextReadings.papers[paperId], document.revision);
      const turns = [
        ...nextPaper.chat.turns,
          {
            id: turnId,
            client_request_id: requestId,
            request_fingerprint: fingerprint,
            question: prepared.question,
          status: "running",
          reference: reference == null
            ? null
            : publicChatReference({
                ...prepared.references[0],
                source_hash: sha256(prepared.references[0].content),
              }),
          input_hash: prepared.inputHash,
          artifact_json: cachePath,
          provider_id: providerId,
          model_id: modelId,
            cache_hit: false,
            cache_write_failed: false,
            inline_artifact: null,
          project_context_status:
            prepared.projectContext?.status ?? "not_requested",
          project_context_requested: Boolean(prepared.projectContext),
          project_context_source_path:
            prepared.projectContext?.status === "available"
              ? prepared.projectContext.source_path
              : null,
          error: null,
          created_at: createdAt,
          answered_at: null,
        },
      ];
      nextReadings.papers[paperId] = {
        ...nextPaper,
        chat: chatStateWithTurns(nextPaper.chat, turns, createdAt),
        updated_at: createdAt,
      };
      return { readings: nextReadings };
    }, {
      type: "reading_chat_started",
      paper_id: paperId,
      turn_id: turnId,
      provider_id: providerId,
      model_id: modelId,
    });
    started = true;

    try {
      const { artifact, cacheWriteFailed } = await getOrGenerateChatArtifact({
        runId,
        paperId,
        document,
        prepared,
        providerId,
        modelId,
      });
      const answeredAt = now().toISOString();
      await update(runId, (current) => {
        const nextReadings = normalizeReadings(current);
        const nextPaper = normalizePaperState(nextReadings.papers[paperId], document.revision);
        const turns = nextPaper.chat.turns.map((turn) => (
          turn.id === turnId
            ? {
                ...turn,
                status: "answered",
                provider_id: artifact.provenance.provider_id ?? providerId,
                model_id: artifact.provenance.model_id ?? modelId,
                cache_write_failed: cacheWriteFailed,
                inline_artifact: cacheWriteFailed ? artifact : null,
                error: null,
                answered_at: answeredAt,
              }
            : turn
        ));
        nextReadings.papers[paperId] = {
          ...nextPaper,
          chat: chatStateWithTurns(nextPaper.chat, turns, answeredAt),
          updated_at: answeredAt,
        };
        return { readings: nextReadings };
      }, {
        type: "reading_chat_answered",
        paper_id: paperId,
        turn_id: turnId,
        input_hash: prepared.inputHash,
        cache_write_failed: cacheWriteFailed,
      });
      return getReading(runId, paperId);
    } catch (error) {
      if (started) {
        const failedAt = now().toISOString();
        const safeError = publicError(error);
        await update(runId, (current) => {
          const nextReadings = normalizeReadings(current);
          const nextPaper = normalizePaperState(nextReadings.papers[paperId], document.revision);
          const turns = nextPaper.chat.turns.map((turn) => (
            turn.id === turnId
              ? { ...turn, status: "failed", error: safeError }
              : turn
          ));
          nextReadings.papers[paperId] = {
            ...nextPaper,
            chat: chatStateWithTurns(nextPaper.chat, turns, failedAt),
            updated_at: failedAt,
          };
          return { readings: nextReadings };
        }, {
          type: "reading_chat_failed",
          paper_id: paperId,
          turn_id: turnId,
          error: safeError,
        });
      }
      throw error;
    }
  }

  function sendChatMessage(runId, paperId, options) {
    const normalized = {
      text: typeof options?.text === "string" ? options.text.trim() : "",
      reference: options?.reference ?? null,
      clientRequestId: options?.clientRequestId ?? null,
      includeProjectContext: options?.includeProjectContext === true,
      providerId: options?.providerId ?? defaultProviderId,
      modelId: options?.modelId ?? defaultModelId,
    };
    if (
      typeof normalized.clientRequestId !== "string"
      || !REQUEST_ID_PATTERN.test(normalized.clientRequestId)
    ) {
      return Promise.reject(readingError(
        "READING_CHAT_CLIENT_REQUEST_ID_REQUIRED",
        "论文对话必须提供稳定的请求标识",
        400,
      ));
    }
    if (!normalized.text || normalized.text.length > 1_000) {
      return Promise.reject(readingError(
        "READING_CHAT_INPUT_INVALID",
        "论文对话任务必须是 1 至 1000 个字符",
        400,
      ));
    }
    const fingerprint = chatRequestFingerprint(normalized);
    const key = `${runId}:${paperId}:chat-request:${normalized.clientRequestId}`;
    const existing = chatRequestInFlight.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.reject(readingError(
          "READING_CHAT_REQUEST_CONFLICT",
          "同一论文对话请求标识已用于不同内容",
          409,
        ));
      }
      return existing.operation;
    }
    const operation = sendChatMessageUnlocked(runId, paperId, {
      ...normalized,
      requestFingerprint: fingerprint,
    })
      .finally(() => {
        if (chatRequestInFlight.get(key)?.operation === operation) {
          chatRequestInFlight.delete(key);
        }
      });
    chatRequestInFlight.set(key, { fingerprint, operation });
    return operation;
  }

  async function getReading(runId, paperId) {
    const { run, paper } = await getRunPaper(runId, paperId);
    const readings = normalizeReadings(run);
    const paperState = normalizePaperState(readings.papers[paperId]);
    const document = await getPaperDocument(runId, paperId);
    if (
      paperState.document_revision
      && paperState.document_revision !== document.revision
    ) {
      throw readingError("READING_STALE", "论文正文已变化，当前精读结果需要重新生成");
    }
    const stages = {};
    for (const stage of READING_STAGE_ORDER) {
      const state = paperState.stages[stage];
      let artifact = null;
      if (state.status === "ready") {
        artifact = validateStageArtifact(
          await runStore.readArtifact(runId, stagePaths(paperId, stage).json),
          { runId, paperId, stage, document },
        );
      }
      stages[stage] = {
        status: state.status,
        content_hash: state.content_hash,
        input_hash: state.input_hash,
        prompt_id: state.prompt_id,
        prompt_version: state.prompt_version,
        provider_id: state.provider_id,
        model_id: state.model_id,
        error: state.error,
        updated_at: state.updated_at,
        result: artifact
          ? {
              answer: artifact.result.answer,
              evidence: expandedEvidence(document, artifact.result.evidence),
              open_questions: [...artifact.result.open_questions],
            }
          : null,
        provenance: artifact ? {
          source: artifact.provenance.source,
          prompt_id: artifact.provenance.prompt_id,
          prompt_version: artifact.provenance.prompt_version,
          input_hash: artifact.provenance.input_hash,
          usage: artifact.provenance.usage ?? null,
        } : null,
      };
    }
    const questions = [];
    for (const question of paperState.questions) {
      let artifact = null;
      if (question.status === "answered") {
        const stageArtifact = validateStageArtifact(
          await runStore.readArtifact(runId, stagePaths(paperId, question.stage).json),
          { runId, paperId, stage: question.stage, document },
        );
        artifact = validateQuestionArtifact(
          await runStore.readArtifact(runId, questionPath(paperId, question.id)),
          { runId, paperId, document, stageArtifact },
        );
      }
      questions.push({
        id: question.id,
        client_request_id: question.client_request_id,
        stage: question.stage,
        block_id: question.block_id ?? null,
        text: question.text,
        status: question.status,
        error: question.error ?? null,
        created_at: question.created_at,
        answered_at: question.answered_at ?? null,
        answer: artifact?.result.answer ?? null,
        evidence: artifact
          ? expandedEvidence(document, artifact.result.evidence)
          : [],
        open_questions: artifact ? [...artifact.result.open_questions] : [],
      });
    }
    const agentActions = paperState.agent_actions.proposals
      .map(publicAgentAction)
      .filter(Boolean);
    const agentActionsById = new Map(
      agentActions.map((proposal) => [proposal.proposal_id, proposal]),
    );
    const chatTurns = [];
    for (const turn of paperState.chat.turns) {
      const cachedRecord = turn.status === "answered"
        ? await readChatCache(
            runId,
            paperId,
            turn.input_hash,
            document,
            {
              strict: true,
              inlineArtifact: turn.inline_artifact ?? null,
            },
          )
        : null;
      const artifact = cachedRecord?.artifact ?? null;
      chatTurns.push({
        id: turn.id,
        client_request_id: turn.client_request_id,
        question: turn.question,
        status: turn.status,
        reference: turn.reference ? structuredClone(turn.reference) : null,
        answer: artifact?.result.answer ?? null,
        citations: artifact ? expandedChatCitations(artifact) : [],
        provider_id: turn.provider_id ?? artifact?.provenance.provider_id ?? null,
        model_id: turn.model_id ?? artifact?.provenance.model_id ?? null,
        prompt_version: artifact?.provenance.prompt_version ?? null,
        input_hash: turn.input_hash ?? artifact?.input_hash ?? null,
        usage: artifact?.provenance.usage ?? null,
        cache_hit: Boolean(turn.cache_hit),
        cache_write_failed: Boolean(
          turn.cache_write_failed ?? cachedRecord?.cacheWriteFailed,
        ),
        project_context_revision:
          artifact?.provenance.project_context_revision ?? null,
        project_context_source_path:
          turn.project_context_source_path
          ?? artifact?.provenance.project_context_source_path
          ?? null,
        project_context_status:
          turn.project_context_status
          ?? artifact?.provenance.project_context_status
          ?? "not_requested",
        project_context_requested:
          turn.project_context_requested
          ?? Boolean(artifact?.provenance.project_context_requested),
        error: turn.error ?? null,
        created_at: turn.created_at,
        answered_at: turn.answered_at ?? null,
        note_action: turn.action_proposal_id
          ? agentActionsById.get(turn.action_proposal_id) ?? null
          : null,
      });
    }
    return {
      schema_version: 1,
      run_id: runId,
      paper_id: paperId,
      paper: {
        title: paper.title,
        authors: [...(paper.authors ?? [])],
        venue: paper.venue ?? "",
        published_at: paper.published_at ?? null,
        doi: paper.doi ?? null,
        canonical_url: paper.canonical_url ?? null,
      },
      status: paperState.status,
      document_revision: document.revision,
      current_stage: paperState.current_stage,
      position: structuredClone(paperState.position),
      stage_order: [...READING_STAGE_ORDER],
      stages,
      questions,
      chat: {
        id: paperState.chat.id ?? "current",
        title: paperState.chat.title ?? conversationTitle(paperState.chat.turns),
        status: paperState.chat.status,
        turns: chatTurns,
        updated_at: paperState.chat.updated_at,
      },
      active_conversation_id: paperState.chat.id ?? "current",
      conversations: [
        {
          id: paperState.chat.id ?? "current",
          title: paperState.chat.title ?? conversationTitle(paperState.chat.turns),
          turn_count: paperState.chat.turns.length,
          updated_at: paperState.chat.updated_at,
          active: true,
        },
        ...paperState.archived_conversations.map((entry) => ({
          id: entry.id,
          title: entry.title ?? conversationTitle(entry.turns),
          turn_count: Array.isArray(entry.turns) ? entry.turns.length : 0,
          updated_at: entry.updated_at ?? entry.created_at ?? null,
          active: false,
        })),
      ],
      agent_actions: {
        schema_version: 1,
        status: paperState.agent_actions.status,
        proposals: agentActions,
        updated_at: paperState.agent_actions.updated_at,
      },
    };
  }

  async function generateStageUnlocked(runId, paperId, stage, {
    providerId = defaultProviderId,
    modelId = defaultModelId,
  } = {}) {
    if (!READING_STAGE_ORDER.includes(stage)) {
      throw readingError("READING_STAGE_INVALID", "未知的精读阶段", 400);
    }
    if (
      typeof modelProviders?.supports === "function"
      && !modelProviders.supports(providerId, modelId)
    ) {
      throw readingError("READING_PROVIDER_UNSUPPORTED", "当前模型不支持精读", 400);
    }
    const { run, paper } = await getRunPaper(runId, paperId);
    if (paperDecisions(run)[paperId] !== "read") {
      throw readingError("READING_NOT_SELECTED", "该论文尚未明确选择进入精读");
    }
    const readings = normalizeReadings(run);
    const document = await getPaperDocument(runId, paperId);
    const paperState = normalizePaperState(readings.papers[paperId], document.revision);
    if (
      paperState.document_revision
      && paperState.document_revision !== document.revision
    ) {
      throw readingError("READING_DOCUMENT_CHANGED", "论文正文已经变化，需要重新开始精读");
    }
    const missingCoreStage = stage === "project-relation"
      ? CORE_READING_STAGES.find(
          (coreStage) => paperState.stages[coreStage].status !== "ready",
        )
      : null;
    if (missingCoreStage) {
      throw readingError(
        "READING_STAGE_ORDER_INVALID",
        "请先完成研究问题、方法机制和实验依据三个阅读镜头",
      );
    }
    if (paperState.stages[stage].status === "ready") return getReading(runId, paperId);
    const startedAt = now().toISOString();
    await update(runId, (current) => {
      const nextReadings = normalizeReadings(current);
      const nextPaper = normalizePaperState(nextReadings.papers[paperId], document.revision);
      nextReadings.status = "reading";
      nextReadings.provider_id = providerId;
      nextReadings.model_id = modelId;
      nextReadings.last_error = null;
      nextReadings.papers[paperId] = {
        ...nextPaper,
        status: "reading",
        document_revision: document.revision,
        current_stage: stage,
        stages: {
          ...nextPaper.stages,
          [stage]: {
            ...nextPaper.stages[stage],
            status: "running",
            error: null,
            updated_at: startedAt,
          },
        },
        updated_at: startedAt,
      };
      return {
        ...(current.status === "guide_ready" || current.status === "draft_ready"
          ? {
              status: "reading",
              phase: "close_reading",
              paused_reason: `正在生成${stage}阶段`,
            }
          : {}),
        readings: nextReadings,
      };
    }, {
      type: "reading_stage_started",
      paper_id: paperId,
      stage,
      provider_id: providerId,
      model_id: modelId,
    });

    try {
      const readyStageIds = READING_STAGE_ORDER.filter(
        (stageId) => (
          stageId !== stage
          && paperState.stages[stageId].status === "ready"
        ),
      );
      const previousStages = await stageArtifacts(runId, paperId, readyStageIds, document);
      const projectContext = stage === "project-relation"
        ? await getProjectContext()
        : null;
      const generated = await stageGenerator({
        paper,
        stage,
        document,
        previousStages,
        projectContext,
        providerId,
        modelId,
        modelProviders,
        modelMode,
      });
      const artifactBase = {
        schema_version: 1,
        run_id: runId,
        paper_id: paperId,
        stage,
        document_revision: document.revision,
        result: generated.result,
        provenance: {
          source: generated.source,
          provider_id: generated.provider_id ?? null,
          model_id: generated.model_id ?? null,
          prompt_id: generated.prompt_id,
          prompt_version: generated.prompt_version,
          prompt_hash: generated.prompt_hash,
          input_hash: generated.input_hash,
          input_block_count: generated.input_block_count,
          input_chars: generated.input_chars,
          project_context_revision: generated.project_context_revision ?? null,
          operation_id: generated.operation_id ?? null,
          upstream_request_id: generated.upstream_request_id ?? null,
          usage: generated.usage ?? null,
        },
      };
      const artifact = {
        ...artifactBase,
        content_hash: sha256(artifactBase),
        generated_at: now().toISOString(),
      };
      validateStageArtifact(artifact, { runId, paperId, stage, document });
      const paths = stagePaths(paperId, stage);
      await runStore.writeArtifact(runId, paths.json, artifact);
      await runStore.writeArtifact(runId, paths.markdown, stageMarkdown(paper, artifact));
      const completedAt = now().toISOString();
      await update(runId, (current) => {
        const nextReadings = normalizeReadings(current);
        const nextPaper = normalizePaperState(nextReadings.papers[paperId], document.revision);
        const stages = {
          ...nextPaper.stages,
          [stage]: {
            status: "ready",
            artifact_json: paths.json,
            artifact_markdown: paths.markdown,
            content_hash: artifact.content_hash,
            input_hash: generated.input_hash,
            prompt_id: generated.prompt_id,
            prompt_version: generated.prompt_version,
            provider_id: generated.provider_id ?? providerId,
            model_id: generated.model_id ?? modelId,
            error: null,
            updated_at: completedAt,
          },
        };
        const paperComplete = READING_STAGE_ORDER.every(
          (stageId) => stages[stageId].status === "ready",
        );
        nextReadings.papers[paperId] = {
          ...nextPaper,
          status: paperComplete ? "complete" : "reading",
          current_stage: stage,
          position: {
            ...nextPaper.position,
            block_id: nextPaper.position.block_id
              ?? generated.result.evidence[0]?.locator
              ?? null,
          },
          stages,
          updated_at: completedAt,
        };
        const readIds = Object.entries(paperDecisions(current))
          .filter(([, decision]) => decision === "read")
          .map(([id]) => id);
        const allComplete = readIds.length > 0 && readIds.every((id) => (
          normalizePaperState(nextReadings.papers[id]).status === "complete"
        ));
        nextReadings.paper_ids = readIds;
        nextReadings.status = allComplete ? "ready_for_preview" : "reading";
        nextReadings.last_error = null;
        const mayOwnTopLevel = ["guide_ready", "reading", "draft_ready"].includes(current.status);
        return {
          ...(mayOwnTopLevel ? {
            status: allComplete ? "draft_ready" : "reading",
            phase: allComplete ? "write_preview" : "close_reading",
            paused_reason: allComplete
              ? "四阶段精读已完成，等待生成正式写入预览"
              : "精读进度已保存，可继续下一阶段",
          } : {}),
          readings: nextReadings,
        };
      }, {
        type: "reading_stage_completed",
        paper_id: paperId,
        stage,
        content_hash: artifact.content_hash,
      });
      return getReading(runId, paperId);
    } catch (error) {
      const safeError = publicError(error);
      const failedAt = now().toISOString();
      await update(runId, (current) => {
        const nextReadings = normalizeReadings(current);
        const nextPaper = normalizePaperState(nextReadings.papers[paperId], document.revision);
        nextReadings.status = "reading";
        nextReadings.last_error = safeError;
        nextReadings.papers[paperId] = {
          ...nextPaper,
          status: "failed",
          current_stage: stage,
          stages: {
            ...nextPaper.stages,
            [stage]: {
              ...nextPaper.stages[stage],
              status: "failed",
              error: safeError,
              updated_at: failedAt,
            },
          },
          updated_at: failedAt,
        };
        return {
          ...(current.status === "reading" ? {
            phase: "close_reading",
            paused_reason: `${stage}阶段生成失败，可单独重试`,
          } : {}),
          readings: nextReadings,
        };
      }, {
        type: "reading_stage_failed",
        paper_id: paperId,
        stage,
        error: safeError,
      });
      throw error;
    }
  }

  function generateStage(runId, paperId, stage, options) {
    const key = `${runId}:${paperId}:stage:${stage}`;
    if (inFlight.has(key)) return inFlight.get(key);
    const operation = generateStageUnlocked(runId, paperId, stage, options)
      .finally(() => inFlight.delete(key));
    inFlight.set(key, operation);
    return operation;
  }

  async function askQuestionUnlocked(runId, paperId, {
    stage,
    text,
    blockId = null,
    clientRequestId = null,
    providerId = defaultProviderId,
    modelId = defaultModelId,
  } = {}) {
    if (!READING_STAGE_ORDER.includes(stage)) {
      throw readingError("READING_STAGE_INVALID", "未知的精读阶段", 400);
    }
    const question = typeof text === "string" ? text.trim() : "";
    if (!question || question.length > 1_000) {
      throw readingError("READING_QUESTION_INVALID", "追问必须是 1 至 1000 个字符", 400);
    }
    const requestId = clientRequestId ?? `question-request-${idFactory()}`;
    if (!REQUEST_ID_PATTERN.test(requestId)) {
      throw readingError("READING_QUESTION_INVALID", "追问请求标识格式无效", 400);
    }
    const { run, paper } = await getRunPaper(runId, paperId);
    const readings = normalizeReadings(run);
    const document = await getPaperDocument(runId, paperId);
    const paperState = normalizePaperState(readings.papers[paperId], document.revision);
    const existing = paperState.questions.find(
      (item) => item.client_request_id === requestId,
    );
    if (existing) return getReading(runId, paperId);
    const stageState = paperState.stages[stage];
    if (stageState.status !== "ready") {
      throw readingError("READING_STAGE_NOT_READY", "当前阶段完成后才能提交追问");
    }
    if (
      blockId != null
      && !document.blocks.some((block) => block.block_id === blockId)
    ) {
      throw readingError("READING_BLOCK_NOT_FOUND", "追问引用的原文段落不存在", 400);
    }
    const stageArtifact = validateStageArtifact(
      await runStore.readArtifact(runId, stagePaths(paperId, stage).json),
      { runId, paperId, stage, document },
    );
    const questionId = `question-${sha256({
      run_id: runId,
      paper_id: paperId,
      client_request_id: requestId,
    }).slice(7, 23)}`;
    const createdAt = now().toISOString();
    await update(runId, (current) => {
      const nextReadings = normalizeReadings(current);
      const nextPaper = normalizePaperState(nextReadings.papers[paperId], document.revision);
      nextReadings.papers[paperId] = {
        ...nextPaper,
        questions: [
          ...nextPaper.questions,
          {
            id: questionId,
            client_request_id: requestId,
            stage,
            block_id: blockId,
            text: question,
            status: "running",
            error: null,
            created_at: createdAt,
            answered_at: null,
          },
        ],
        updated_at: createdAt,
      };
      return { readings: nextReadings };
    }, {
      type: "reading_question_started",
      paper_id: paperId,
      stage,
      question_id: questionId,
      block_id: blockId,
    });

    try {
      const projectContext = stage === "project-relation"
        ? await getProjectContext()
        : null;
      const generated = await followUpGenerator({
        paper,
        stage,
        document,
        currentStage: stageArtifact.result,
        question,
        focusBlockIds: blockId ? [blockId] : [],
        projectContext,
        providerId,
        modelId,
        modelProviders,
        modelMode,
      });
      const artifactBase = {
        schema_version: 1,
        run_id: runId,
        paper_id: paperId,
        question_id: questionId,
        client_request_id: requestId,
        stage,
        block_id: blockId,
        question,
        document_revision: document.revision,
        stage_content_hash: stageArtifact.content_hash,
        result: generated.result,
        provenance: {
          source: generated.source,
          provider_id: generated.provider_id ?? null,
          model_id: generated.model_id ?? null,
          prompt_id: generated.prompt_id,
          prompt_version: generated.prompt_version,
          prompt_hash: generated.prompt_hash,
          input_hash: generated.input_hash,
          operation_id: generated.operation_id ?? null,
          upstream_request_id: generated.upstream_request_id ?? null,
          usage: generated.usage ?? null,
        },
      };
      const artifact = {
        ...artifactBase,
        content_hash: sha256(artifactBase),
        generated_at: now().toISOString(),
      };
      validateQuestionArtifact(artifact, {
        runId,
        paperId,
        document,
        stageArtifact,
      });
      await runStore.writeArtifact(runId, questionPath(paperId, questionId), artifact);
      await runStore.writeArtifact(
        runId,
        `readings/${paperId}/questions/${questionId}.md`,
        questionMarkdown(paper, artifact),
      );
      const answeredAt = now().toISOString();
      await update(runId, (current) => {
        const nextReadings = normalizeReadings(current);
        const nextPaper = normalizePaperState(nextReadings.papers[paperId], document.revision);
        nextReadings.papers[paperId] = {
          ...nextPaper,
          questions: nextPaper.questions.map((item) => (
            item.id === questionId
              ? { ...item, status: "answered", error: null, answered_at: answeredAt }
              : item
          )),
          updated_at: answeredAt,
        };
        return { readings: nextReadings };
      }, {
        type: "reading_question_answered",
        paper_id: paperId,
        stage,
        question_id: questionId,
      });
      return getReading(runId, paperId);
    } catch (error) {
      const safeError = publicError(error);
      await update(runId, (current) => {
        const nextReadings = normalizeReadings(current);
        const nextPaper = normalizePaperState(nextReadings.papers[paperId], document.revision);
        nextReadings.papers[paperId] = {
          ...nextPaper,
          questions: nextPaper.questions.map((item) => (
            item.id === questionId
              ? { ...item, status: "failed", error: safeError }
              : item
          )),
        };
        return { readings: nextReadings };
      }, {
        type: "reading_question_failed",
        paper_id: paperId,
        stage,
        question_id: questionId,
        error: safeError,
      });
      throw error;
    }
  }

  function askQuestion(runId, paperId, options) {
    const requestId = options?.clientRequestId ?? null;
    const key = requestId
      ? `${runId}:${paperId}:question:${requestId}`
      : null;
    if (key && inFlight.has(key)) return inFlight.get(key);
    const operation = askQuestionUnlocked(runId, paperId, options)
      .finally(() => {
        if (key) inFlight.delete(key);
      });
    if (key) inFlight.set(key, operation);
    return operation;
  }

  async function savePosition(runId, paperId, { mode, blockId } = {}) {
    if (!["focused", "full"].includes(mode)) {
      throw readingError("READING_POSITION_INVALID", "阅读模式无效", 400);
    }
    const { run } = await getRunPaper(runId, paperId);
    const document = await getPaperDocument(runId, paperId);
    if (
      blockId != null
      && !document.blocks.some((block) => block.block_id === blockId)
    ) {
      throw readingError("READING_BLOCK_NOT_FOUND", "阅读位置不在当前正文中", 400);
    }
    const readings = normalizeReadings(run);
    if (!readings.papers[paperId]) {
      throw readingError("READING_NOT_STARTED", "该论文尚未开始精读");
    }
    const updatedAt = now().toISOString();
    return update(runId, (current) => {
      const nextReadings = normalizeReadings(current);
      const nextPaper = normalizePaperState(nextReadings.papers[paperId], document.revision);
      nextReadings.papers[paperId] = {
        ...nextPaper,
        position: {
          mode,
          block_id: blockId,
          updated_at: updatedAt,
        },
        updated_at: updatedAt,
      };
      return { readings: nextReadings };
    }, {
      type: "reading_position_updated",
      paper_id: paperId,
      mode,
      block_id: blockId,
    });
  }

  async function resume(runId) {
    const run = await runStore.getRun(runId);
    if (!run) return null;
    const readings = normalizeReadings(run);
    let changed = false;
    let workflowInterrupted = false;
    for (const paperId of readings.paper_ids) {
      const paperState = normalizePaperState(readings.papers[paperId]);
      for (const stage of READING_STAGE_ORDER) {
        if (paperState.stages[stage].status !== "running") continue;
        changed = true;
        workflowInterrupted = true;
        paperState.stages[stage] = {
          ...paperState.stages[stage],
          status: "failed",
          error: {
            code: "READING_INTERRUPTED",
            message: "上次阶段生成未完成；为避免重复模型调用，请手动重试当前阶段",
            retryable: true,
          },
          updated_at: now().toISOString(),
        };
        paperState.status = "failed";
      }
      paperState.questions = paperState.questions.map((question) => {
        if (question.status !== "running") return question;
        changed = true;
        workflowInterrupted = true;
        return {
          ...question,
          status: "failed",
          error: {
            code: "READING_QUESTION_INTERRUPTED",
            message: "上次追问未完成；为避免重复模型调用，请手动重试",
            retryable: true,
          },
        };
      });
      let chatInterrupted = false;
      const chatTurns = paperState.chat.turns.map((turn) => {
        if (turn.status !== "running") return turn;
        changed = true;
        chatInterrupted = true;
        return {
          ...turn,
          status: "failed",
          error: {
            code: "READING_CHAT_INTERRUPTED",
            message: "上次论文对话未完成；为避免重复模型调用，请手动重试",
            retryable: true,
          },
        };
      });
      paperState.chat = chatStateWithTurns(
        paperState.chat,
        chatTurns,
        chatInterrupted ? now().toISOString() : paperState.chat.updated_at,
      );
      readings.papers[paperId] = paperState;
    }
    if (!changed) return run;
    if (workflowInterrupted) {
      readings.status = "reading";
      readings.last_error = {
        code: "READING_INTERRUPTED",
        message: "精读生成被中断，可从失败阶段继续",
        retryable: true,
      };
    }
    return update(runId, {
      readings,
      ...(workflowInterrupted
        ? { paused_reason: "精读生成被中断，可从失败阶段继续" }
        : {}),
    }, {
      type: workflowInterrupted
        ? "reading_interrupted_recovered"
        : "reading_chat_interrupted_recovered",
    });
  }

  return Object.freeze({
    askQuestion,
    generateStage,
    getReading,
    restartFromGuide,
    createConversation,
    switchConversation,
    resume,
    savePosition,
    sendChatMessage,
    setDecisions,
  });
}
