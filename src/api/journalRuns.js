async function jsonResponse(response, fallback) {
  try {
    return await response.json();
  } catch {
    throw new Error(fallback);
  }
}

function requestError(response, body, fallback) {
  const error = new Error(body?.error?.message || fallback);
  error.code = body?.error?.code || "JOURNAL_RUN_REQUEST_FAILED";
  error.retryable = Boolean(body?.error?.retryable);
  error.status = response.status;
  return error;
}

function displayEvidenceScope(scope, documentStatus) {
  const rawScope = String(scope || "题录与摘要");
  if (documentStatus !== "ready") {
    return rawScope.replace(/全文尚待 MinerU 核验/gi, "全文尚待解析核验");
  }
  const sourceScope = rawScope
    .replace(/[；。]?\s*全文尚待 MinerU 核验[。]?/gi, "")
    .trim();
  if (!sourceScope || sourceScope === "全文") {
    return "全文已解析，尚未完成精读核验";
  }
  return `${sourceScope}；全文已解析，尚未完成精读核验`;
}

function mapZoteroTarget(target) {
  if (!target || typeof target !== "object" || typeof target.id !== "string") {
    throw new Error("Zotero collection 格式无效");
  }
  const name = target.name || "未命名 collection";
  const libraryName = target.library_name ?? target.libraryName ?? null;
  const targetPath = Array.isArray(target.path)
    && target.path.length > 0
    && target.path.every((segment) => typeof segment === "string" && segment.trim())
    ? [...target.path]
    : [libraryName, name].filter(Boolean)
      .filter((segment, index, path) => index === 0 || segment !== path[index - 1]);
  return {
    id: target.id,
    name,
    libraryId: target.library_id ?? target.libraryId ?? null,
    libraryName,
    level: Number.isSafeInteger(target.level) ? target.level : 0,
    path: targetPath,
    editable: target.editable !== false,
    filesEditable: target.files_editable ?? target.filesEditable ?? true,
  };
}

function mapZoteroOperation(proposal) {
  if (
    !proposal
    || typeof proposal !== "object"
    || typeof proposal.proposal_id !== "string"
    || typeof proposal.paper_id !== "string"
  ) {
    throw new Error("Zotero 写入提案格式无效");
  }
  const blocked = proposal.status === "blocked"
    || proposal.write_mode === "manual_update_required"
    || (proposal.status === "failed" && proposal.error?.retryable === false);
  const actionable = !blocked && proposal.status !== "committed";
  return {
    id: proposal.proposal_id,
    proposalId: proposal.proposal_id,
    paperId: proposal.paper_id,
    paperIds: [proposal.paper_id],
    target: "zotero",
    operation: proposal.operation,
    operationLabel: proposal.operation_label,
    writeMode: proposal.write_mode,
    targetLocator: proposal.target_locator,
    targetId: proposal.target_id,
    preview: proposal.preview_or_diff ?? [],
    contentHash: proposal.content_hash,
    targetVersionOrHash: proposal.target_version_or_hash,
    selected: blocked ? false : proposal.selected !== false,
    actionable,
    status: proposal.status ?? "draft",
    externalId: proposal.external_id ?? null,
    attachmentId: proposal.attachment_id ?? null,
    noteId: proposal.note_id ?? null,
    verificationResult: proposal.verification_result ?? null,
    attemptCount: proposal.attempt_count ?? 0,
    error: proposal.error?.message ?? proposal.error ?? null,
    errorCode: proposal.error?.code ?? null,
    retryable: proposal.error?.retryable !== false,
    metadata: proposal.metadata ?? null,
    pdf: proposal.pdf ?? null,
    guide: proposal.guide ?? null,
    title: proposal.metadata?.title ?? proposal.operation_label ?? "Zotero 归档",
  };
}

function mapZoteroState(zotero) {
  if (!zotero || typeof zotero !== "object") {
    return {
      status: "not_started",
      target: null,
      decisions: {},
      proposalId: null,
      proposalHash: null,
      proposals: [],
      approval: null,
      error: null,
    };
  }
  return {
    status: zotero.status ?? "not_started",
    target: zotero.target ? mapZoteroTarget(zotero.target) : null,
    decisions: zotero.decisions ?? {},
    proposalId: zotero.proposal_id ?? null,
    proposalHash: zotero.proposal_hash ?? null,
    proposals: (zotero.proposals ?? []).map(mapZoteroOperation),
    approval: zotero.approval ?? null,
    error: zotero.last_error?.message ?? zotero.last_error ?? null,
  };
}

function mapReadingPosition(position) {
  if (!position || typeof position !== "object") return null;
  return {
    mode: position.mode,
    blockId: position.block_id ?? null,
    updatedAt: position.updated_at ?? null,
  };
}

function mapReadingEvidence(evidence) {
  return (evidence ?? []).map((reference) => ({
    blockId: reference.block_id,
    path: reference.path ?? [],
    ordinal: reference.ordinal,
    excerpt: reference.excerpt,
    support: reference.support,
  }));
}

function mapReadingChatReference(reference) {
  if (!reference || typeof reference !== "object") return null;
  return {
    blockId: reference.block_id,
    path: reference.path ?? [],
    ordinal: reference.ordinal ?? null,
    startOffset: reference.start_offset,
    endOffset: reference.end_offset,
    quote: reference.quote ?? "",
    sourceHash: reference.source_hash ?? null,
    support: reference.support ?? null,
  };
}

function mapAgentNoteAction(action) {
  if (!action || typeof action !== "object") return null;
  return {
    proposalId: action.proposal_id ?? null,
    turnId: action.turn_id ?? null,
    status: action.status ?? "draft",
    targetPath: action.target_locator ?? null,
    operationLabel: action.operation_label ?? "追加到 Agent 补充笔记",
    proposalHash: action.proposal_hash ?? null,
    contentHash: action.content_hash ?? null,
    targetVersionOrHash: action.target_version_or_hash ?? null,
    preview: Array.isArray(action.preview_or_diff) ? action.preview_or_diff : [],
    diff: action.diff && typeof action.diff === "object" ? action.diff : null,
    error: action.last_error ?? null,
    createdAt: action.created_at ?? null,
    updatedAt: action.updated_at ?? null,
    committedAt: action.committed_at ?? null,
  };
}

function mapReadingChat(chat) {
  return {
    status: chat?.status ?? "idle",
    turns: (chat?.turns ?? []).map((turn) => ({
      id: turn.id,
      clientRequestId: turn.client_request_id ?? null,
      question: turn.question ?? "",
      status: turn.status ?? "failed",
      reference: mapReadingChatReference(turn.reference),
      answer: turn.answer ?? null,
      citations: (turn.citations ?? []).map(mapReadingChatReference),
      providerId: turn.provider_id ?? null,
      modelId: turn.model_id ?? null,
      promptVersion: turn.prompt_version ?? null,
      inputHash: turn.input_hash ?? null,
      usage: turn.usage ?? null,
      cacheHit: Boolean(turn.cache_hit),
      cacheWriteFailed: Boolean(turn.cache_write_failed),
      projectContextRevision: turn.project_context_revision ?? null,
      projectContextSourcePath: turn.project_context_source_path ?? null,
      projectContextStatus: turn.project_context_status ?? "not_requested",
      includeProjectContext: Boolean(turn.project_context_requested),
      error: turn.error ?? null,
      createdAt: turn.created_at ?? null,
      answeredAt: turn.answered_at ?? null,
      noteAction: mapAgentNoteAction(turn.note_action),
    })),
    updatedAt: chat?.updated_at ?? null,
  };
}

function mapReadingSummary(readings) {
  if (!readings || typeof readings !== "object") {
    return {
      status: "not_started",
      paperIds: [],
      providerId: null,
      modelId: null,
      papers: {},
      lastError: null,
    };
  }
  return {
    status: readings.status ?? "not_started",
    paperIds: readings.paper_ids ?? [],
    providerId: readings.provider_id ?? null,
    modelId: readings.model_id ?? null,
    papers: Object.fromEntries(Object.entries(readings.papers ?? {}).map(([paperId, paper]) => [
      paperId,
      {
        status: paper?.status ?? "not_started",
        documentRevision: paper?.document_revision ?? null,
        currentStage: paper?.current_stage ?? "research-question",
        position: mapReadingPosition(paper?.position),
        stages: Object.fromEntries(Object.entries(paper?.stages ?? {}).map(([stage, state]) => [
          stage,
          {
            status: state?.status ?? "not_started",
            contentHash: state?.content_hash ?? null,
            inputHash: state?.input_hash ?? null,
            promptId: state?.prompt_id ?? null,
            promptVersion: state?.prompt_version ?? null,
            providerId: state?.provider_id ?? null,
            modelId: state?.model_id ?? null,
            error: state?.error ?? null,
            updatedAt: state?.updated_at ?? null,
          },
        ])),
        questions: (paper?.questions ?? []).map((question) => ({
          id: question.id,
          clientRequestId: question.client_request_id ?? null,
          stage: question.stage,
          blockId: question.block_id ?? null,
          text: question.text,
          status: question.status,
          error: question.error ?? null,
          createdAt: question.created_at ?? null,
          answeredAt: question.answered_at ?? null,
        })),
        chat: mapReadingChat(paper?.chat),
        agentActions: {
          status: paper?.agent_actions?.status ?? "idle",
          proposals: (paper?.agent_actions?.proposals ?? []).map(mapAgentNoteAction),
          updatedAt: paper?.agent_actions?.updated_at ?? null,
        },
        updatedAt: paper?.updated_at ?? null,
      },
    ])),
    lastError: readings.last_error ?? null,
  };
}

export function mapJournalRun(run) {
  if (!run || typeof run !== "object" || typeof run.run_id !== "string") {
    throw new Error("期刊运行格式无效");
  }
  const mineruPapers = run.mineru?.papers ?? {};
  const guidePapers = run.guides?.papers ?? {};
  return {
    id: run.run_id,
    status: run.status,
    phase: run.phase,
    pausedReason: run.paused_reason ?? null,
    updatedAt: run.updated_at,
    scanSummary: run.scan_summary,
    sourceProgress: run.source_progress,
    mineru: run.mineru,
    guides: {
      status: run.guides?.status ?? "not_started",
      requestedPaperIds: run.guides?.requested_paper_ids ?? [],
      providerId: run.guides?.provider_id ?? null,
      modelId: run.guides?.model_id ?? null,
      papers: Object.fromEntries(Object.entries(guidePapers).map(([paperId, state]) => [
        paperId,
        {
          status: state?.status ?? "not_started",
          documentRevision: state?.document_revision ?? state?.revision ?? null,
          promptVersion: state?.prompt_version ?? null,
          inputHash: state?.input_hash ?? null,
          providerId: state?.provider_id ?? null,
          modelId: state?.model_id ?? null,
          error: state?.error ?? null,
        },
      ])),
    },
    paperDecisions: run.paper_decisions ?? {},
    readings: mapReadingSummary(run.readings),
    readingRestart: run.reading_restart && typeof run.reading_restart === "object"
      ? {
          revision: run.reading_restart.revision ?? null,
          fromStep: run.reading_restart.from_step ?? null,
          restartedAt: run.reading_restart.restarted_at ?? null,
        }
      : null,
    obsidian: mapObsidianState(run.obsidian),
    projectState: mapProjectStateState(run.project_state),
    zotero: mapZoteroState(run.zotero),
    ranking: run.ranking,
    candidates: (run.candidates ?? []).map((paper) => {
      const documentState = mineruPapers[paper.paper_id] ?? {};
      return {
        id: paper.paper_id,
        title: paper.title,
        titleZh: paper.title,
        authors: paper.authors ?? [],
        venue: paper.venue,
        publishedAt: paper.published_at,
        firstSeenAt: paper.first_seen_at,
        discoveryType: paper.display_label,
        abstract: paper.abstract || "当前来源没有提供摘要，完整内容以正文解析结果为准。",
        relevance: paper.project_impact,
        recommendation: Number(paper.rank) <= 2 ? "优先精读" : "候选",
        topicMatches: paper.topic_matches ?? [],
        heatSignals: paper.heat_signals ?? [],
        evidenceScope: displayEvidenceScope(paper.evidence_scope, documentState.status),
        selectionSummary: paper.selection_summary,
        projectImpact: paper.project_impact,
        candidateOrigin: paper.candidate_origin,
        isNew: paper.is_new,
        publishedThisWeek: paper.published_this_week,
        pdfUrl: paper.pdf_url,
        mineruStatus: documentState.status ?? "not_started",
        mineruRunStatus: run.mineru?.status ?? "not_started",
        mineruError: documentState.error ?? null,
        guideStatus: guidePapers[paper.paper_id]?.status ?? "not_started",
        guideError: guidePapers[paper.paper_id]?.error ?? null,
        isDemo: false,
      };
    }),
  };
}

export function mapJournalPaperReading(body) {
  if (
    !body
    || typeof body !== "object"
    || typeof body.run_id !== "string"
    || typeof body.paper_id !== "string"
    || !Array.isArray(body.stage_order)
    || !body.stages
    || typeof body.stages !== "object"
    || !Array.isArray(body.questions)
  ) {
    throw new Error("分阶段精读格式无效");
  }
  return {
    runId: body.run_id,
    paperId: body.paper_id,
    paper: {
      title: body.paper?.title ?? "",
      authors: body.paper?.authors ?? [],
      venue: body.paper?.venue ?? "",
      publishedAt: body.paper?.published_at ?? null,
      doi: body.paper?.doi ?? null,
      canonicalUrl: body.paper?.canonical_url ?? null,
    },
    status: body.status,
    documentRevision: body.document_revision,
    currentStage: body.current_stage,
    position: mapReadingPosition(body.position),
    stageOrder: [...body.stage_order],
    stages: Object.fromEntries(Object.entries(body.stages).map(([stage, state]) => [
      stage,
      {
        status: state?.status ?? "not_started",
        contentHash: state?.content_hash ?? null,
        inputHash: state?.input_hash ?? null,
        promptId: state?.prompt_id ?? null,
        promptVersion: state?.prompt_version ?? null,
        providerId: state?.provider_id ?? null,
        modelId: state?.model_id ?? null,
        error: state?.error ?? null,
        updatedAt: state?.updated_at ?? null,
        result: state?.result ? {
          answer: state.result.answer,
          evidence: mapReadingEvidence(state.result.evidence),
          openQuestions: state.result.open_questions ?? [],
        } : null,
        provenance: state?.provenance ? {
          source: state.provenance.source,
          promptId: state.provenance.prompt_id,
          promptVersion: state.provenance.prompt_version,
          inputHash: state.provenance.input_hash,
          usage: state.provenance.usage ?? null,
        } : null,
      },
    ])),
    questions: body.questions.map((question) => ({
      id: question.id,
      clientRequestId: question.client_request_id ?? null,
      stage: question.stage,
      blockId: question.block_id ?? null,
      text: question.text,
      status: question.status,
      error: question.error ?? null,
      createdAt: question.created_at ?? null,
      answeredAt: question.answered_at ?? null,
      answer: question.answer ?? null,
      evidence: mapReadingEvidence(question.evidence),
      openQuestions: question.open_questions ?? [],
    })),
    chat: mapReadingChat(body.chat),
    activeConversationId: body.active_conversation_id ?? body.chat?.id ?? "current",
    conversations: (body.conversations ?? []).map((entry) => ({
      id: entry.id,
      title: entry.title ?? "新对话",
      turnCount: entry.turn_count ?? 0,
      updatedAt: entry.updated_at ?? null,
      active: Boolean(entry.active),
    })),
    agentActions: {
      status: body.agent_actions?.status ?? "idle",
      proposals: (body.agent_actions?.proposals ?? []).map(mapAgentNoteAction),
      updatedAt: body.agent_actions?.updated_at ?? null,
    },
  };
}

export function mapZoteroTargets(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.targets)) {
    throw new Error("Zotero collection 列表格式无效");
  }
  return {
    selectedTargetId: body.selected_target_id ?? null,
    targets: body.targets.map(mapZoteroTarget),
  };
}

export async function fetchZoteroTargets({ signal } = {}) {
  const response = await fetch("/api/v1/zotero/targets", { signal });
  const body = await jsonResponse(response, "本地 Zotero 服务返回了无法解析的 collection 列表");
  if (!response.ok) throw requestError(response, body, "无法读取 Zotero collection");
  return mapZoteroTargets(body);
}

export function mapZoteroProposal(body) {
  if (
    !body
    || typeof body !== "object"
    || typeof body.proposal_id !== "string"
    || typeof body.proposal_hash !== "string"
    || !Array.isArray(body.proposals)
  ) {
    throw new Error("Zotero 精确预览格式无效");
  }
  return {
    proposalId: body.proposal_id,
    proposalHash: body.proposal_hash,
    target: body.target ? mapZoteroTarget(body.target) : null,
    decisions: body.decisions ?? {},
    proposals: body.proposals.map(mapZoteroOperation),
    generatedAt: body.generated_at ?? null,
  };
}

export async function createZoteroProposal({
  runId,
  decisions,
  targetId,
  signal,
} = {}) {
  const response = await fetch(
    `/api/v1/journal-runs/${encodeURIComponent(runId)}/zotero/proposals`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: 1,
        target_id: targetId,
        decisions: Object.entries(decisions ?? {}).map(([paperId, decision]) => ({
          paper_id: paperId,
          decision,
        })),
      }),
      signal,
    },
  );
  const body = await jsonResponse(response, "本地 Zotero 服务返回了无法解析的精确预览");
  if (!response.ok) throw requestError(response, body, "无法生成 Zotero 精确预览");
  return mapZoteroProposal(body);
}

export async function fetchZoteroProposal(runId, { signal } = {}) {
  const response = await fetch(
    `/api/v1/journal-runs/${encodeURIComponent(runId)}/zotero/proposals`,
    { signal },
  );
  const body = await jsonResponse(response, "本地 Zotero 服务返回了无法解析的精确预览");
  if (!response.ok) throw requestError(response, body, "无法读取 Zotero 精确预览");
  return mapZoteroProposal(body);
}

export function selectZoteroCommitOperations(proposals, { retry = false } = {}) {
  return (proposals ?? [])
    .filter((proposal) => (
      retry
        ? (
            proposal.status === "failed"
            && proposal.retryable !== false
            && proposal.actionable !== false
          )
        : (
            proposal.selected
            && proposal.actionable !== false
            && (proposal.status !== "failed" || proposal.retryable !== false)
            && ["draft", "failed"].includes(proposal.status)
          )
    ))
    .map((proposal) => ({
      proposalId: proposal.proposalId ?? proposal.id,
      contentHash: proposal.contentHash,
      targetVersionOrHash: proposal.targetVersionOrHash,
    }));
}

export async function commitZoteroProposal({
  runId,
  proposalHash,
  operations,
  signal,
} = {}) {
  const response = await fetch(
    `/api/v1/journal-runs/${encodeURIComponent(runId)}/zotero/commit`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: 1,
        proposal_hash: proposalHash,
        operations: (operations ?? []).map((operation) => ({
          proposal_id: operation.proposalId,
          content_hash: operation.contentHash,
          target_version_or_hash: operation.targetVersionOrHash,
        })),
      }),
      signal,
    },
  );
  const body = await jsonResponse(response, "本地 Zotero 服务返回了无法解析的写入状态");
  if (!response.ok) throw requestError(response, body, "无法确认 Zotero 写入");
  return mapJournalRun(body);
}

export async function startJournalRun({ providerId, modelId, signal } = {}) {
  const response = await fetch("/api/v1/journal-runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      provider_id: providerId,
      model_id: modelId,
    }),
    signal,
  });
  const body = await jsonResponse(response, "本地期刊服务返回了无法解析的内容");
  if (!response.ok) throw requestError(response, body, "无法启动期刊扫描");
  return mapJournalRun(body);
}

export async function fetchJournalRun(runId, { signal } = {}) {
  const response = await fetch(`/api/v1/journal-runs/${encodeURIComponent(runId)}`, { signal });
  const body = await jsonResponse(response, "本地期刊服务返回了无法解析的运行状态");
  if (!response.ok) throw requestError(response, body, "无法读取期刊运行");
  return mapJournalRun(body);
}

export async function fetchJournalRuns({ signal } = {}) {
  const response = await fetch("/api/v1/journal-runs", { signal });
  const body = await jsonResponse(response, "本地期刊服务返回了无法解析的运行列表");
  if (!response.ok) throw requestError(response, body, "无法读取期刊运行列表");
  if (!Array.isArray(body?.runs)) throw new Error("期刊运行列表格式无效");
  return body.runs.map(mapJournalRun);
}

export async function resumeJournalRun(runId, { signal } = {}) {
  const response = await fetch(`/api/v1/journal-runs/${encodeURIComponent(runId)}/resume`, {
    method: "POST",
    signal,
  });
  const body = await jsonResponse(response, "本地期刊服务返回了无法解析的恢复状态");
  if (!response.ok) throw requestError(response, body, "无法恢复期刊运行");
  return mapJournalRun(body);
}

export async function saveJournalPaperDecisions({
  runId,
  decisions,
  signal,
} = {}) {
  const response = await fetch(
    `/api/v1/journal-runs/${encodeURIComponent(runId)}/paper-decisions`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: 1,
        decisions: Object.entries(decisions ?? {}).map(([paperId, decision]) => ({
          paper_id: paperId,
          decision,
        })),
      }),
      signal,
    },
  );
  const body = await jsonResponse(response, "本地精读服务返回了无法解析的论文决定状态");
  if (!response.ok) throw requestError(response, body, "无法保存论文决定");
  return mapJournalRun(body);
}

export async function restartJournalReadingFromGuide({ runId, signal } = {}) {
  const response = await fetch(
    `/api/v1/journal-runs/${encodeURIComponent(runId)}/reading/restart`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: 1,
        from_step: "guide",
      }),
      signal,
    },
  );
  const body = await jsonResponse(response, "本地精读服务返回了无法解析的重新研读状态");
  if (!response.ok) throw requestError(response, body, "无法从五分钟导读重新开始");
  return mapJournalRun(body);
}

export async function fetchJournalPaperReading(runId, paperId, { signal } = {}) {
  const response = await fetch(
    `/api/v1/journal-runs/${encodeURIComponent(runId)}/papers/${encodeURIComponent(paperId)}/reading`,
    { signal },
  );
  const body = await jsonResponse(response, "本地精读服务返回了无法解析的精读内容");
  if (!response.ok) throw requestError(response, body, "无法读取分阶段精读");
  return mapJournalPaperReading(body);
}

export async function generateJournalReadingStage({
  runId,
  paperId,
  stage,
  providerId,
  modelId,
  signal,
} = {}) {
  const response = await fetch(
    `/api/v1/journal-runs/${encodeURIComponent(runId)}/papers/${encodeURIComponent(paperId)}/reading/stages/${encodeURIComponent(stage)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: 1,
        provider_id: providerId,
        model_id: modelId,
      }),
      signal,
    },
  );
  const body = await jsonResponse(response, "本地精读服务返回了无法解析的阶段结果");
  if (!response.ok) throw requestError(response, body, "无法生成当前精读阶段");
  return mapJournalPaperReading(body);
}

export async function askJournalReadingQuestion({
  runId,
  paperId,
  stage,
  text,
  blockId = null,
  clientRequestId = null,
  providerId,
  modelId,
  signal,
} = {}) {
  const response = await fetch(
    `/api/v1/journal-runs/${encodeURIComponent(runId)}/papers/${encodeURIComponent(paperId)}/reading/questions`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: 1,
        stage,
        text,
        block_id: blockId,
        client_request_id: clientRequestId,
        provider_id: providerId,
        model_id: modelId,
      }),
      signal,
    },
  );
  const body = await jsonResponse(response, "本地精读服务返回了无法解析的追问结果");
  if (!response.ok) throw requestError(response, body, "无法回答当前精读追问");
  return mapJournalPaperReading(body);
}

export async function sendJournalReadingChatMessage({
  runId,
  paperId,
  text,
  reference = null,
  clientRequestId = null,
  includeProjectContext = false,
  providerId,
  modelId,
  signal,
} = {}) {
  if (typeof clientRequestId !== "string" || !clientRequestId.trim()) {
    const error = new Error("论文对话必须提供稳定的请求标识");
    error.code = "READING_CHAT_CLIENT_REQUEST_ID_REQUIRED";
    error.retryable = false;
    error.status = 400;
    throw error;
  }
  const response = await fetch(
    `/api/v1/journal-runs/${encodeURIComponent(runId)}/papers/${encodeURIComponent(paperId)}/reading/chat/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: 1,
        client_request_id: clientRequestId,
        text,
        reference: reference
          ? (Array.isArray(reference.blockIds)
              ? {
                  document_revision: reference.documentRevision,
                  block_ids: reference.blockIds,
                }
              : {
                  document_revision: reference.documentRevision,
                  block_id: reference.blockId,
                  start_offset: reference.startOffset,
                  end_offset: reference.endOffset,
                })
          : null,
        include_project_context: includeProjectContext,
        provider_id: providerId,
        model_id: modelId,
      }),
      signal,
    },
  );
  const body = await jsonResponse(response, "本地论文服务返回了无法解析的对话结果");
  if (!response.ok) throw requestError(response, body, "无法完成当前论文对话");
  return mapJournalPaperReading(body);
}

export async function createJournalReadingConversation({ runId, paperId, signal } = {}) {
  const response = await fetch(
    `/api/v1/journal-runs/${encodeURIComponent(runId)}/papers/${encodeURIComponent(paperId)}/reading/conversations`,
    { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal },
  );
  const body = await jsonResponse(response, "本地论文服务返回了无法解析的会话结果");
  if (!response.ok) throw requestError(response, body, "无法新建研读会话");
  return mapJournalPaperReading(body);
}

export async function switchJournalReadingConversation({ runId, paperId, conversationId, signal } = {}) {
  const response = await fetch(
    `/api/v1/journal-runs/${encodeURIComponent(runId)}/papers/${encodeURIComponent(paperId)}/reading/conversations/activate`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schema_version: 1, conversation_id: conversationId }),
      signal,
    },
  );
  const body = await jsonResponse(response, "本地论文服务返回了无法解析的会话结果");
  if (!response.ok) throw requestError(response, body, "无法切换研读会话");
  return mapJournalPaperReading(body);
}

export async function createJournalAgentNoteProposal({
  runId,
  paperId,
  turnId,
  clientRequestId,
  signal,
} = {}) {
  const response = await fetch(
    `/api/v1/journal-runs/${encodeURIComponent(runId)}/papers/${encodeURIComponent(paperId)}/reading/chat/turns/${encodeURIComponent(turnId)}/obsidian-note-proposals`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: 1,
        client_request_id: clientRequestId,
      }),
      signal,
    },
  );
  const body = await jsonResponse(response, "本地论文服务返回了无法解析的修改预览");
  if (!response.ok) throw requestError(response, body, "无法生成 Obsidian 修改预览");
  return mapJournalPaperReading(body);
}

export async function commitJournalAgentNoteProposal({
  runId,
  paperId,
  proposalId,
  clientRequestId,
  proposalHash,
  contentHash,
  targetVersionOrHash,
  signal,
} = {}) {
  const response = await fetch(
    `/api/v1/journal-runs/${encodeURIComponent(runId)}/papers/${encodeURIComponent(paperId)}/reading/agent-actions/${encodeURIComponent(proposalId)}/commit`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: 1,
        client_request_id: clientRequestId,
        proposal_hash: proposalHash,
        content_hash: contentHash,
        target_version_or_hash: targetVersionOrHash,
      }),
      signal,
    },
  );
  const body = await jsonResponse(response, "本地论文服务返回了无法解析的写入结果");
  if (!response.ok) throw requestError(response, body, "无法确认写入 Obsidian");
  return mapJournalPaperReading(body);
}

export async function abandonJournalAgentNoteProposal({
  runId,
  paperId,
  proposalId,
  clientRequestId,
  signal,
} = {}) {
  const response = await fetch(
    `/api/v1/journal-runs/${encodeURIComponent(runId)}/papers/${encodeURIComponent(paperId)}/reading/agent-actions/${encodeURIComponent(proposalId)}/abandon`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: 1,
        client_request_id: clientRequestId,
      }),
      signal,
    },
  );
  const body = await jsonResponse(response, "本地论文服务返回了无法解析的放弃结果");
  if (!response.ok) throw requestError(response, body, "无法放弃这次 Obsidian 修改");
  return mapJournalPaperReading(body);
}

export async function fetchProjectContext({ signal } = {}) {
  const response = await fetch("/api/v1/project-context", { signal });
  const body = await jsonResponse(response, "本地项目状态服务返回了无法解析的内容");
  if (!response.ok) throw requestError(response, body, "无法读取项目状态");
  if (
    body?.schema_version !== 1
    || !["available", "partial"].includes(body.status)
    || typeof body.source_path !== "string"
    || typeof body.revision !== "string"
    || !body.state
    || !Array.isArray(body.state.decisions)
    || !Array.isArray(body.state.open_questions)
    || !Array.isArray(body.state.next_actions)
  ) {
    throw new Error("项目状态读取结果格式无效");
  }
  return {
    status: body.status,
    sourcePath: body.source_path,
    revision: body.revision,
    byteLength: body.byte_length ?? null,
    title: body.state.title ?? "项目状态",
    goal: body.state.goal ?? "",
    decisions: body.state.decisions,
    openQuestions: body.state.open_questions,
    nextAction: body.state.next_action ?? "",
    nextActions: body.state.next_actions,
    missingSections: body.missing_sections ?? [],
  };
}

export async function saveJournalReadingPosition({
  runId,
  paperId,
  mode,
  blockId = null,
  signal,
} = {}) {
  const response = await fetch(
    `/api/v1/journal-runs/${encodeURIComponent(runId)}/papers/${encodeURIComponent(paperId)}/reading/position`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: 1,
        mode,
        block_id: blockId,
      }),
      signal,
    },
  );
  const body = await jsonResponse(response, "本地精读服务返回了无法解析的阅读位置状态");
  if (!response.ok) throw requestError(response, body, "无法保存阅读位置");
  return mapJournalRun(body);
}

function mapObsidianOperation(proposal) {
  return {
    id: proposal.proposal_id,
    proposalId: proposal.proposal_id,
    paperId: proposal.paper_id,
    paperIds: [proposal.paper_id],
    target: "obsidian",
    operation: proposal.operation,
    writeMode: proposal.write_mode,
    targetLocator: proposal.target_locator,
    targetDetails: proposal.target_details ?? null,
    targetHash: proposal.target_hash,
    targetVersionOrHash: proposal.target_version_or_hash,
    contentHash: proposal.content_hash,
    actionable: Boolean(proposal.actionable),
    selected: Boolean(proposal.selected),
    status: proposal.status,
    preview: proposal.preview_or_diff ?? [],
    markdown: proposal.markdown ?? "",
    diff: proposal.diff ?? null,
    title: proposal.target_details?.file_name ?? "Obsidian 精读笔记",
  };
}

function mapObsidianState(obsidian) {
  if (!obsidian || typeof obsidian !== "object") {
    return {
      status: "not_started",
      proposalHash: null,
      proposals: [],
      error: null,
    };
  }
  return {
    status: obsidian.status ?? "not_started",
    proposalHash: obsidian.proposal_hash ?? null,
    proposals: (obsidian.proposals ?? []).map(mapObsidianOperation),
    error: obsidian.last_error?.message ?? obsidian.last_error ?? null,
  };
}

export function mapObsidianPreview(body) {
  if (
    !body
    || typeof body !== "object"
    || typeof body.proposal_hash !== "string"
    || !Array.isArray(body.proposals)
  ) {
    throw new Error("Obsidian 精确预览格式无效");
  }
  return {
    runId: body.run_id,
    status: body.status,
    writeCapability: body.write_capability,
    externalWritePerformed: Boolean(body.external_write_performed),
    targetDirectory: body.target_directory ?? null,
    sourceHash: body.source_hash ?? null,
    proposalHash: body.proposal_hash,
    generatedAt: body.generated_at ?? null,
    proposals: body.proposals.map(mapObsidianOperation),
  };
}

export async function fetchObsidianPreview(runId, { signal } = {}) {
  const response = await fetch(
    `/api/v1/journal-runs/${encodeURIComponent(runId)}/obsidian/proposals`,
    { signal },
  );
  const body = await jsonResponse(response, "本地 Obsidian 服务返回了无法解析的精确预览");
  if (!response.ok) throw requestError(response, body, "无法读取 Obsidian 精确预览");
  return mapObsidianPreview(body);
}

export async function createObsidianPreview({ runId, signal } = {}) {
  const response = await fetch(
    `/api/v1/journal-runs/${encodeURIComponent(runId)}/obsidian/proposals`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schema_version: 1 }),
      signal,
    },
  );
  const body = await jsonResponse(response, "本地 Obsidian 服务返回了无法解析的精确预览");
  if (!response.ok) throw requestError(response, body, "无法生成 Obsidian 精确预览");
  return mapObsidianPreview(body);
}

function mapProjectStateOperation(proposal) {
  const paperReferences = (proposal.paper_references ?? []).map((reference) => ({
    paperId: reference.paper_id,
    title: reference.title ?? null,
    obsidianNote: reference.obsidian_note ?? null,
  }));
  return {
    id: proposal.proposal_id,
    proposalId: proposal.proposal_id,
    paperIds: paperReferences
      .map((reference) => reference.paperId)
      .filter((paperId) => typeof paperId === "string"),
    target: "project_state",
    operation: proposal.operation,
    writeMode: proposal.write_mode,
    targetLocator: proposal.target_locator,
    targetDetails: proposal.target_details ?? null,
    contentHash: proposal.content_hash,
    targetHash: proposal.target_hash,
    targetVersionOrHash: proposal.target_version_or_hash,
    marker: proposal.marker ?? null,
    actionable: Boolean(proposal.actionable),
    selected: Boolean(proposal.selected),
    status: proposal.status,
    preview: proposal.preview_or_diff ?? [],
    markdown: proposal.markdown ?? "",
    diff: proposal.diff ?? null,
    paperReferences,
    title: proposal.target_details?.source_path ?? "项目状态更新建议",
  };
}

function mapProjectStateState(projectState) {
  if (!projectState || typeof projectState !== "object") {
    return {
      status: "not_started",
      proposalId: null,
      proposalHash: null,
      targetLocator: null,
      targetHash: null,
      contentHash: null,
      actionable: false,
      approval: null,
      error: null,
      updatedAt: null,
    };
  }
  return {
    status: projectState.status ?? "not_started",
    proposalId: projectState.proposal_id ?? null,
    proposalHash: projectState.proposal_hash ?? null,
    targetLocator: projectState.target_locator ?? null,
    targetHash: projectState.target_hash ?? null,
    contentHash: projectState.content_hash ?? null,
    actionable: Boolean(projectState.actionable),
    approval: projectState.approval ?? null,
    error: projectState.last_error?.message ?? projectState.last_error ?? null,
    updatedAt: projectState.updated_at ?? null,
  };
}

export function mapProjectStatePreview(body) {
  if (
    !body
    || typeof body !== "object"
    || typeof body.run_id !== "string"
    || typeof body.proposal_hash !== "string"
    || !body.proposal
    || typeof body.proposal !== "object"
    || typeof body.proposal.proposal_id !== "string"
  ) {
    throw new Error("项目状态精确预览格式无效");
  }
  const proposal = mapProjectStateOperation(body.proposal);
  return {
    runId: body.run_id,
    status: body.status,
    writeCapability: body.write_capability,
    externalWritePerformed: Boolean(body.external_write_performed),
    sourceHash: body.source_hash ?? null,
    proposalHash: body.proposal_hash,
    generatedAt: body.generated_at ?? null,
    proposal,
    proposals: [proposal],
  };
}

export async function fetchProjectStatePreview(runId, { signal } = {}) {
  const response = await fetch(
    `/api/v1/journal-runs/${encodeURIComponent(runId)}/project-state/proposals`,
    { signal },
  );
  const body = await jsonResponse(response, "本地项目状态服务返回了无法解析的精确预览");
  if (!response.ok) throw requestError(response, body, "无法读取项目状态精确预览");
  return mapProjectStatePreview(body);
}

export async function createProjectStatePreview({ runId, signal } = {}) {
  const response = await fetch(
    `/api/v1/journal-runs/${encodeURIComponent(runId)}/project-state/proposals`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schema_version: 1 }),
      signal,
    },
  );
  const body = await jsonResponse(response, "本地项目状态服务返回了无法解析的精确预览");
  if (!response.ok) throw requestError(response, body, "无法生成项目状态精确预览");
  return mapProjectStatePreview(body);
}

export async function startJournalGuides({
  runId,
  paperIds,
  providerId,
  modelId,
  signal,
} = {}) {
  const response = await fetch(
    `/api/v1/journal-runs/${encodeURIComponent(runId)}/guides`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: 1,
        paper_ids: paperIds,
        provider_id: providerId,
        model_id: modelId,
      }),
      signal,
    },
  );
  const body = await jsonResponse(response, "本地导读服务返回了无法解析的运行状态");
  if (!response.ok) throw requestError(response, body, "无法准备五分钟导读");
  return mapJournalRun(body);
}

export function mapJournalPaperGuide(body) {
  if (
    !body
    || typeof body !== "object"
    || typeof body.run_id !== "string"
    || typeof body.paper_id !== "string"
    || typeof body.document_revision !== "string"
    || !body.guide
    || typeof body.guide !== "object"
    || !Array.isArray(body.guide.questions)
    || !Array.isArray(body.guide.evidence_refs)
    || !Array.isArray(body.references)
  ) {
    throw new Error("五分钟导读格式无效");
  }
  const references = body.references.map((reference) => ({
    blockId: reference.block_id,
    path: reference.path ?? [],
    ordinal: reference.ordinal,
    excerpt: reference.excerpt,
  }));
  const knownReferenceIds = new Set(references.map((reference) => reference.blockId));
  if (
    references.some((reference) => (
      typeof reference.blockId !== "string"
      || !Number.isSafeInteger(reference.ordinal)
      || typeof reference.excerpt !== "string"
    ))
    || body.guide.evidence_refs.some((blockId) => !knownReferenceIds.has(blockId))
  ) {
    throw new Error("五分钟导读引用格式无效");
  }
  return {
    runId: body.run_id,
    paperId: body.paper_id,
    documentRevision: body.document_revision,
    problem: body.guide.problem,
    whyRead: body.guide.why_read,
    intuition: body.guide.intuition,
    evidence: body.guide.evidence,
    limitations: body.guide.limitations,
    questions: body.guide.questions,
    evidenceRefs: body.guide.evidence_refs,
    references,
    provenance: body.provenance ?? null,
  };
}

export function journalGuideNeedsRefresh(cachedGuide, guideState) {
  if (!cachedGuide) return true;
  if (
    guideState?.documentRevision
    && cachedGuide.documentRevision !== guideState.documentRevision
  ) return true;
  const provenance = cachedGuide.provenance ?? {};
  return Boolean(
    (guideState?.promptVersion && provenance.prompt_version !== guideState.promptVersion)
    || (guideState?.inputHash && provenance.input_hash !== guideState.inputHash),
  );
}

export async function fetchJournalPaperGuide(runId, paperId, { signal } = {}) {
  const response = await fetch(
    `/api/v1/journal-runs/${encodeURIComponent(runId)}/papers/${encodeURIComponent(paperId)}/guide`,
    { signal },
  );
  const body = await jsonResponse(response, "本地导读服务返回了无法解析的导读");
  if (!response.ok) throw requestError(response, body, "无法读取五分钟导读");
  return mapJournalPaperGuide(body);
}

export function mapJournalPaperDocument(body) {
  if (
    !body
    || typeof body !== "object"
    || typeof body.run_id !== "string"
    || typeof body.paper_id !== "string"
    || !Array.isArray(body.sections)
    || !Array.isArray(body.blocks)
  ) {
    throw new Error("论文正文格式无效");
  }
  return {
    runId: body.run_id,
    paperId: body.paper_id,
    revision: body.revision,
    title: body.title,
    paper: body.paper,
    originalPdfUrl: body.links?.original_pdf ?? null,
    sections: body.sections.map((section) => ({
      id: section.section_id,
      parentId: section.parent_section_id,
      path: section.path ?? [],
      ordinal: section.ordinal,
      level: section.level,
      title: section.title,
      firstBlockId: section.first_block_id,
    })),
    blocks: body.blocks.map((block) => ({
      id: block.block_id,
      sectionId: block.section_id,
      path: block.path ?? [],
      ordinal: block.ordinal,
      kind: block.kind,
      text: block.text,
      markdown: block.markdown,
      imageUrl: block.image_url ?? null,
      previousBlockId: block.previous_block_id,
      nextBlockId: block.next_block_id,
    })),
  };
}

export async function fetchJournalPaperDocument(runId, paperId, { signal } = {}) {
  const response = await fetch(
    `/api/v1/journal-runs/${encodeURIComponent(runId)}/papers/${encodeURIComponent(paperId)}/document`,
    { signal },
  );
  const body = await jsonResponse(response, "本地论文服务返回了无法解析的正文");
  if (!response.ok) throw requestError(response, body, "无法读取论文正文");
  return mapJournalPaperDocument(body);
}
