import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

function archivalError(code, message, status = 409, retryable = false) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.retryable = retryable;
  return error;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(
    typeof value === "string" ? value : JSON.stringify(canonicalize(value)),
  ).digest("hex")}`;
}

const PUBLIC_ERRORS = Object.freeze({
  PDF_CORRUPT: {
    message: "论文原版校验失败，请重新获取全文后再试",
    retryable: false,
  },
  PDF_UNAVAILABLE: {
    message: "论文原版暂时不可用，请确认全文仍可访问后再试",
    retryable: true,
  },
  ZOTERO_APPROVAL_CORRUPT: {
    message: "Zotero 批准记录缺失或校验失败，请重新确认写入预览",
    retryable: false,
  },
  ZOTERO_DUPLICATE_AMBIGUOUS: {
    message: "Zotero 中存在多个冲突条目，需要先人工处理重复项",
    retryable: false,
  },
  ZOTERO_EXISTING_ITEM_CHANGED: {
    message: "Zotero 中的匹配条目已变化，请重新生成写入预览",
    retryable: false,
  },
  ZOTERO_FILES_NOT_EDITABLE: {
    message: "所选 Zotero 目标不允许写入附件",
    retryable: false,
  },
  ZOTERO_INVALID_REQUEST: {
    message: "Zotero 写入内容未通过本地校验",
    retryable: false,
  },
  ZOTERO_LOCAL_API_DISABLED: {
    message: "Zotero 本地 API 未启用",
    retryable: false,
  },
  ZOTERO_MANUAL_REPAIR_REQUIRED: {
    message: "Zotero 写入未能安全完成，需要人工检查后再继续",
    retryable: false,
  },
  ZOTERO_MANUAL_UPDATE_REQUIRED: {
    message: "Zotero 已有同一论文条目；当前版本不会修改现有条目，请先人工处理",
    retryable: false,
  },
  ZOTERO_OPERATION_CONFLICT: {
    message: "Zotero 中存在冲突的归档操作记录，需要先人工处理",
    retryable: false,
  },
  ZOTERO_PREVIEW_STALE: {
    message: "Zotero 写入预览已变化，请重新检查后再确认",
    retryable: false,
  },
  ZOTERO_PROPOSAL_CORRUPT: {
    message: "Zotero 写入预览缺失或校验失败，请重新生成",
    retryable: false,
  },
  ZOTERO_REQUEST_REJECTED: {
    message: "Zotero 拒绝了本次写入，请检查本地 Zotero 状态",
    retryable: false,
  },
  ZOTERO_TARGET_STALE: {
    message: "Zotero 写入目标已变化，请重新生成预览",
    retryable: false,
  },
  ZOTERO_TEMPORARILY_UNAVAILABLE: {
    message: "Zotero 暂时不可用，请稍后重试",
    retryable: true,
  },
  ZOTERO_UNAVAILABLE: {
    message: "Zotero 暂时不可用，请稍后重试",
    retryable: true,
  },
  ZOTERO_VERIFICATION_FAILED: {
    message: "Zotero 写入后的核验未通过，请检查后重试",
    retryable: true,
  },
});

function publicError(error) {
  const code = typeof error?.code === "string" && PUBLIC_ERRORS[error.code]
    ? error.code
    : "ZOTERO_WRITE_FAILED";
  const known = PUBLIC_ERRORS[code];
  return {
    code,
    message: known?.message ?? "Zotero 写入失败，请检查本地状态后重试",
    retryable: known?.retryable ?? false,
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function paragraph(value) {
  return `<p>${escapeHtml(value)}</p>`;
}

function guideNoteHtml({ paper, guide, references = [], runId, operationId }) {
  const questions = guide.questions
    .map((question) => `<li>${escapeHtml(question)}</li>`)
    .join("");
  const citations = references
    .map((reference) => [
      "<li>",
      `<code>${escapeHtml(reference.block_id)}</code>`,
      reference.path?.length ? ` · ${escapeHtml(reference.path.join(" › "))}` : "",
      reference.excerpt ? `<br>${escapeHtml(reference.excerpt)}` : "",
      "</li>",
    ].join(""))
    .join("");
  return [
    `<h1>${escapeHtml(paper.title)} · 五分钟导读</h1>`,
    "<h2>这篇论文解决什么问题</h2>",
    paragraph(guide.problem),
    "<h2>为什么值得读</h2>",
    paragraph(guide.why_read),
    "<h2>方法的核心直觉</h2>",
    paragraph(guide.intuition),
    "<h2>作者提供的主要证据</h2>",
    paragraph(guide.evidence),
    "<h2>局限与待核验内容</h2>",
    paragraph(guide.limitations),
    "<h2>进入精读最值得追问</h2>",
    `<ol>${questions}</ol>`,
    "<h2>原文证据锚点</h2>",
    citations ? `<ol>${citations}</ol>` : "<p>暂无可用证据锚点</p>",
    `<p><small>Pi Agent Run：${escapeHtml(runId)}<br>归档操作：${escapeHtml(operationId)}</small></p>`,
  ].join("");
}

function guidePayload(guideResponse, noteHtml) {
  return {
    document_revision: guideResponse.document_revision,
    prompt_version: guideResponse.provenance?.prompt_version ?? null,
    note_sha256: sha256(noteHtml),
    sections: {
      problem: guideResponse.guide.problem,
      why_read: guideResponse.guide.why_read,
      intuition: guideResponse.guide.intuition,
      evidence: guideResponse.guide.evidence,
      limitations: guideResponse.guide.limitations,
      questions: guideResponse.guide.questions,
    },
    references: (guideResponse.references ?? []).map((reference) => ({
      block_id: reference.block_id,
      path: reference.path ?? [],
      excerpt: reference.excerpt ?? "",
    })),
  };
}

function zoteroItem(paper, runId, operationId) {
  const conferencePaper = paper.paper_type === "conference-paper";
  return {
    itemType: conferencePaper ? "conferencePaper" : "journalArticle",
    title: paper.title,
    creators: (paper.authors ?? []).map((name) => ({
      creatorType: "author",
      name,
    })),
    ...(conferencePaper
      ? { proceedingsTitle: paper.venue ?? "" }
      : { publicationTitle: paper.venue ?? "" }),
    date: paper.published_at ?? "",
    DOI: paper.doi ?? "",
    url: paper.canonical_url ?? paper.official_url ?? "",
    abstractNote: paper.abstract ?? "",
    tags: ["Pi Agent"],
    extra: [
      paper.official_id ? `DBLP Key: ${paper.official_id}` : null,
      paper.dedupe_key ? `Pi-Agent-Dedupe-Key: ${paper.dedupe_key}` : null,
      paper.paper_id ? `Pi-Agent-Paper-ID: ${paper.paper_id}` : null,
      `Pi Agent Run: ${runId}`,
      `Pi Agent Operation: ${operationId}`,
      `Pi-Agent-Operation-ID: ${operationId}`,
    ].filter(Boolean).join("\n"),
  };
}

function operationContent(proposal) {
  const noteHash = sha256(proposal.note_html);
  const content = {
    paper_id: proposal.paper_id,
    decision: proposal.decision,
    target_id: proposal.target_id,
    operation: proposal.operation,
    write_mode: proposal.write_mode,
    connector_session_id: proposal.connector_session_id,
    connector_item_id: proposal.connector_item_id,
    item: proposal.item,
    pdf: proposal.pdf,
    guide: {
      ...proposal.guide,
      note_sha256: noteHash,
    },
    existing_item_key: proposal.existing_item_key ?? null,
  };
  return {
    content,
    contentHash: sha256(content),
    noteHash,
  };
}

function assertOperationIntegrity(proposal) {
  if (
    !proposal
    || typeof proposal !== "object"
    || Array.isArray(proposal)
    || !isNonEmptyString(proposal.proposal_id)
    || !isNonEmptyString(proposal.paper_id)
    || !["collect", "read"].includes(proposal.decision)
    || !(
      (proposal.operation === "create" && proposal.write_mode === "create_with_assets")
      || (
        proposal.operation === "update"
        && proposal.write_mode === "manual_update_required"
        && isNonEmptyString(proposal.existing_item_key)
      )
    )
    || !isNonEmptyString(proposal.target_id)
    || !isNonEmptyString(proposal.connector_session_id)
    || !isNonEmptyString(proposal.connector_item_id)
    || !proposal.item
    || typeof proposal.item !== "object"
    || Array.isArray(proposal.item)
    || !proposal.pdf
    || typeof proposal.pdf !== "object"
    || Array.isArray(proposal.pdf)
    || !proposal.guide
    || typeof proposal.guide !== "object"
    || Array.isArray(proposal.guide)
    || !isNonEmptyString(proposal.note_html)
  ) {
    throw archivalError("ZOTERO_PROPOSAL_CORRUPT", "Zotero 写入预览校验失败");
  }
  const computed = operationContent(proposal);
  if (
    proposal.guide.note_sha256 !== computed.noteHash
    || proposal.content_hash !== computed.contentHash
  ) {
    throw archivalError("ZOTERO_PROPOSAL_CORRUPT", "Zotero 写入预览校验失败");
  }
  return computed;
}

function itemPreview(item) {
  return {
    item_type: item.itemType,
    title: item.title,
    authors: (item.creators ?? []).map((creator) => creator.name).filter(Boolean),
    venue: item.proceedingsTitle ?? item.publicationTitle ?? "",
    date: item.date ?? "",
    doi: item.DOI || null,
    url: item.url || null,
    abstract: item.abstractNote ?? "",
    tags: structuredClone(item.tags ?? []),
    extra: item.extra ?? "",
  };
}

function emptyZoteroState() {
  return {
    status: "not_started",
    target: null,
    decisions: {},
    proposal_id: null,
    proposal_hash: null,
    artifact_path: null,
    proposals: [],
    approval: null,
    last_error: null,
  };
}

function normalizeZoteroState(run) {
  const state = run?.zotero;
  if (!state || typeof state !== "object" || Array.isArray(state)) return emptyZoteroState();
  return {
    ...emptyZoteroState(),
    ...state,
    decisions: state.decisions && typeof state.decisions === "object"
      ? { ...state.decisions }
      : {},
    proposals: Array.isArray(state.proposals)
      ? state.proposals.map((proposal) => ({ ...proposal }))
      : [],
  };
}

function targetHash(target) {
  return sha256({
    id: target.id,
    name: target.name,
    library_id: target.libraryId ?? target.library_id ?? null,
    library_name: target.libraryName ?? target.library_name ?? null,
    level: target.level ?? 0,
    path: Array.isArray(target.path) ? [...target.path] : [],
    editable: target.editable !== false,
    files_editable: target.filesEditable !== false,
  });
}

function targetPath(target, libraryName = target.libraryName ?? target.library_name ?? null) {
  if (
    Array.isArray(target.path)
    && target.path.length > 0
    && target.path.every(isNonEmptyString)
  ) {
    return [...target.path];
  }
  return [libraryName, target.name].filter(isNonEmptyString)
    .filter((segment, index, path) => index === 0 || segment !== path[index - 1]);
}

function normalizeTargetBundle(bundle) {
  const targets = Array.isArray(bundle) ? bundle : bundle?.targets;
  if (!Array.isArray(targets)) {
    throw archivalError("ZOTERO_TARGETS_INVALID", "Zotero 返回的目标列表无效", 502, true);
  }
  return {
    selectedTargetId: bundle?.selectedTargetId ?? bundle?.selected_target_id ?? null,
    targets: targets.map((target) => {
      const libraryName = target.libraryName
        ?? target.library_name
        ?? bundle?.libraryName
        ?? null;
      return {
        id: target.id,
        name: target.name,
        libraryId: target.libraryId ?? target.library_id ?? bundle?.libraryId ?? null,
        libraryName,
        level: target.level ?? 0,
        path: targetPath(target, libraryName),
        editable: target.editable !== false,
        filesEditable: target.filesEditable !== false,
      };
    }),
  };
}

function uniqueMatches(matches) {
  const byKey = new Map();
  for (const match of Array.isArray(matches) ? matches : []) {
    if (isNonEmptyString(match?.key)) byKey.set(match.key, match);
  }
  return [...byKey.values()];
}

function exactDuplicate(result, { hasDoi }) {
  if (!result || typeof result !== "object") {
    return { match: null, matchedBy: null, ambiguous: false };
  }
  const operationMatch = isNonEmptyString(result.operationMatch?.key)
    ? result.operationMatch
    : null;
  const doiMatches = uniqueMatches(result.doiMatches ?? result.doi_matches);
  const titleMatches = uniqueMatches(result.titleMatches ?? result.title_matches);
  const sourceMatches = hasDoi ? [...doiMatches, ...titleMatches] : titleMatches;
  const sourceKeys = new Set(sourceMatches.map((match) => match.key));
  if (
    doiMatches.length > 1
    || titleMatches.length > 1
    || sourceKeys.size > 1
    || (
      operationMatch
      && sourceKeys.size === 1
      && !sourceKeys.has(operationMatch.key)
    )
  ) {
    return { match: null, matchedBy: null, ambiguous: true };
  }
  if (operationMatch) {
    return { match: operationMatch, matchedBy: "operation", ambiguous: false };
  }
  if (hasDoi && doiMatches.length === 1) {
    return {
      match: doiMatches[0],
      matchedBy: "doi",
      ambiguous: false,
    };
  }
  if (titleMatches.length === 1) {
    return { match: titleMatches[0], matchedBy: "title", ambiguous: false };
  }
  return { match: null, matchedBy: null, ambiguous: false };
}

function safeProposal(proposal) {
  const {
    item,
    note_html: _noteHtml,
    connector_session_id: _connectorSessionId,
    connector_item_id: _connectorItemId,
    ...safe
  } = proposal;
  return structuredClone({
    ...safe,
    metadata: itemPreview(item),
  });
}

export function createZoteroArchivalService({
  runStore,
  zoteroAdapter,
  getPaperGuide,
  getPaperPdf,
  now = () => new Date(),
  idFactory = randomUUID,
} = {}) {
  if (!runStore || !zoteroAdapter || !getPaperGuide || !getPaperPdf) {
    throw new Error("runStore, zoteroAdapter, getPaperGuide, and getPaperPdf are required");
  }
  const commitJobs = new Map();
  const commitStartLocks = new Map();
  const proposalLocks = new Map();

  async function update(runId, patch, event) {
    const run = await runStore.updateRun(runId, patch);
    if (event) await runStore.appendEvent(runId, { ...event, at: run.updated_at });
    return run;
  }

  async function getTargets() {
    return normalizeTargetBundle(await zoteroAdapter.getTargets());
  }

  async function getPdf(runId, paperId) {
    try {
      const pdf = await getPaperPdf(runId, paperId);
      if (
        !pdf
        || typeof pdf !== "object"
        || !isNonEmptyString(pdf.file_path)
        || !isNonEmptyString(pdf.file_name)
        || !isNonEmptyString(pdf.sha256)
        || !Number.isSafeInteger(pdf.byte_length)
        || pdf.byte_length <= 0
      ) {
        throw new Error("invalid PDF descriptor");
      }
      return pdf;
    } catch {
      throw archivalError("PDF_UNAVAILABLE", "论文原版暂时不可用", 409, true);
    }
  }

  async function validateRunAndDecisions(runId, decisions) {
    const run = await runStore.getRun(runId);
    if (!run) throw archivalError("RUN_NOT_FOUND", "运行不存在", 404);
    if (![
      "draft_ready",
      "awaiting_approval",
      "manual_action_required",
      "partial",
    ].includes(run.status)) {
      throw archivalError("ZOTERO_PROPOSAL_NOT_ALLOWED", "当前阶段不能生成 Zotero 预览");
    }
    if (!decisions || typeof decisions !== "object" || Array.isArray(decisions)) {
      throw archivalError("ZOTERO_DECISIONS_INVALID", "阅读决定格式无效", 400);
    }
    const entries = Object.entries(decisions);
    if (
      entries.length < 1
      || entries.length > 2
      || entries.some(([, decision]) => !["collect", "read"].includes(decision))
    ) {
      throw archivalError("ZOTERO_DECISIONS_INVALID", "必须为一至两篇论文选择收藏或精读", 400);
    }
    const authoritative = run.paper_decisions && typeof run.paper_decisions === "object"
      && !Array.isArray(run.paper_decisions)
      ? run.paper_decisions
      : null;
    const requiresCompleteDecisionSet = run.status === "draft_ready";
    if (
      authoritative
      && (
        entries.some(([paperId, decision]) => authoritative[paperId] !== decision)
        || (
          requiresCompleteDecisionSet
          && Object.keys(authoritative).length !== entries.length
        )
      )
    ) {
      throw archivalError(
        "ZOTERO_DECISIONS_STALE",
        "Zotero 预览中的论文决定与当前 Run 不一致，需要重新生成",
      );
    }
    for (const [paperId] of entries) {
      if (
        !run.candidates?.some((paper) => paper.paper_id === paperId)
        || run.guides?.papers?.[paperId]?.status !== "ready"
      ) {
        throw archivalError("ZOTERO_PAPER_NOT_READY", "只有导读已完成的论文才能进入 Zotero 预览");
      }
      if (
        decisions[paperId] === "read"
        && authoritative
        && run.readings?.papers?.[paperId]?.status !== "complete"
      ) {
        throw archivalError(
          "ZOTERO_READING_NOT_READY",
          "进入精读的论文必须补齐归档所需的四类证据后才能生成 Zotero 预览",
        );
      }
    }
    return { run, entries };
  }

  async function buildOperation({ run, paperId, decision, target }) {
    const paper = run.candidates.find((candidate) => candidate.paper_id === paperId);
    const guideResponse = await getPaperGuide(run.run_id, paperId);
    const pdf = await getPdf(run.run_id, paperId);
    const operationSeed = sha256({
      run_id: run.run_id,
      paper_id: paperId,
      target_id: target.id,
      guide_revision: guideResponse.document_revision,
      pdf_sha256: pdf.sha256,
    }).slice(7, 23);
    const operationId = `zotero-${paperId}-${operationSeed}`.slice(0, 150);
    const duplicateResult = await zoteroAdapter.findDuplicates({
      doi: paper.doi ?? null,
      title: paper.title,
      operationId,
    });
    const duplicate = exactDuplicate(duplicateResult, { hasDoi: isNonEmptyString(paper.doi) });
    if (duplicate.ambiguous) {
      throw archivalError(
        "ZOTERO_DUPLICATE_AMBIGUOUS",
        `Zotero 中有多个条目匹配《${paper.title}》，需要先人工处理重复项`,
      );
    }
    const blockedDuplicate = duplicate.match && duplicate.matchedBy !== "operation";
    const item = zoteroItem(paper, run.run_id, operationId);
    const noteHtml = guideNoteHtml({
      paper,
      guide: guideResponse.guide,
      references: guideResponse.references,
      runId: run.run_id,
      operationId,
    });
    const proposal = {
      proposal_id: operationId,
      run_id: run.run_id,
      paper_id: paperId,
      decision,
      target: "zotero",
      target_id: target.id,
      operation: blockedDuplicate ? "update" : "create",
      write_mode: blockedDuplicate ? "manual_update_required" : "create_with_assets",
      connector_session_id: `pi-session-${operationSeed}`,
      connector_item_id: `pi-item-${operationSeed}`,
      item,
      pdf: {
        file_name: pdf.file_name,
        sha256: pdf.sha256,
        byte_length: pdf.byte_length,
        source_url: paper.pdf_url ?? null,
      },
      guide: guidePayload(guideResponse, noteHtml),
      note_html: noteHtml,
      existing_item_key: blockedDuplicate ? duplicate.match.key : null,
    };
    const { contentHash } = operationContent(proposal);
    const locator = targetPath(target).join(" / ");
    return {
      ...proposal,
      operation_label: blockedDuplicate
        ? "需要人工更新现有条目"
        : duplicate.match
        ? "核验已发起的归档操作"
        : "新建题录并附加全文与导读",
      target_locator: blockedDuplicate
        ? `${locator}（现有条目 ${duplicate.match.key}）`
        : locator,
      preview_or_diff: [
        `动作：${blockedDuplicate
          ? `不自动修改现有条目 ${duplicate.match.key}`
          : duplicate.match
            ? "核验同一归档操作"
            : "新建题录"}`,
        `查重：${paper.doi ? `DOI ${paper.doi}` : `标题 ${paper.title}`}`,
        `题录：${paper.authors?.join("、") || "作者待补"} · ${paper.venue || "来源待补"} · ${paper.published_at || "日期待补"}`,
        `原版 PDF：${pdf.file_name} · ${pdf.byte_length} bytes · ${pdf.sha256}`,
        `五分钟导读：${guideResponse.guide.questions.length} 个精读问题 · ${guideResponse.guide.evidence_refs.length} 条原文引用`,
        ...(blockedDuplicate
          ? [`已有条目不会被移动到「${locator}」，PDF 与导读也不会被改动；请先人工更新`]
          : duplicate.match
          ? ["发现同一 Pi Agent 归档操作；确认后只做幂等核验，不创建普通重复项"]
          : []),
      ],
      content_hash: contentHash,
      target_version_or_hash: targetHash(target),
      selected: !blockedDuplicate,
      status: blockedDuplicate ? "blocked" : "draft",
      external_id: duplicate.match?.key ?? null,
      verification_result: null,
      idempotency_key: sha256(`${run.run_id}:${paperId}:${target.id}:${contentHash}`),
      attempt_count: 0,
      blocked_by: blockedDuplicate ? "existing_zotero_item" : null,
      last_verified_at: null,
      error: blockedDuplicate
        ? publicError(archivalError(
            "ZOTERO_MANUAL_UPDATE_REQUIRED",
            "Zotero 已有同一论文条目",
          ))
        : null,
    };
  }

  async function createProposalUnlocked(runId, { decisions, targetId } = {}) {
    const { run, entries } = await validateRunAndDecisions(runId, decisions);
    const targetBundle = await getTargets();
    const resolvedTargetId = targetId ?? targetBundle.selectedTargetId;
    const target = targetBundle.targets.find((candidate) => candidate.id === resolvedTargetId);
    if (!target || !target.editable || !target.filesEditable) {
      throw archivalError("ZOTERO_TARGET_UNAVAILABLE", "所选 Zotero collection 不可写或已不存在");
    }
    const proposals = [];
    try {
      for (const [paperId, decision] of entries) {
        proposals.push(await buildOperation({ run, paperId, decision, target }));
      }
    } catch (error) {
      const safeError = publicError(error);
      await update(runId, (current) => ({
        zotero: {
          ...normalizeZoteroState(current),
          status: "blocked",
          last_error: safeError,
        },
      }), {
        type: "zotero_proposal_blocked",
        error: safeError,
      });
      throw archivalError(
        safeError.code,
        safeError.message,
        Number.isInteger(error?.status) ? error.status : 409,
        safeError.retryable,
      );
    }
    const generatedAt = now().toISOString();
    const artifactCore = {
      schema_version: 1,
      run_id: runId,
      target,
      decisions,
      proposals,
      generated_at: generatedAt,
    };
    const proposalHash = sha256(artifactCore);
    const proposalId = `zotero-preview-${proposalHash.slice(7, 23)}`;
    const artifactPath = `proposals/${proposalId}.json`;
    const artifact = {
      ...artifactCore,
      proposal_id: proposalId,
      proposal_hash: proposalHash,
    };
    await runStore.writeArtifact(runId, artifactPath, artifact);
    const allBlocked = proposals.every((proposal) => proposal.status === "blocked");
    await update(runId, {
      status: allBlocked ? "manual_action_required" : "awaiting_approval",
      phase: "zotero_preview",
      paused_reason: allBlocked
        ? "全部论文需在 Zotero 手工处理；当前没有可自动写入的条目"
        : "等待确认 Zotero 写入预览",
      zotero: {
        status: allBlocked ? "blocked" : "awaiting_approval",
        target,
        decisions: { ...decisions },
        proposal_id: proposalId,
        proposal_hash: proposalHash,
        artifact_path: artifactPath,
        proposals: proposals.map(safeProposal),
        approval: null,
        last_error: proposals.find((proposal) => proposal.status === "blocked")?.error ?? null,
      },
    }, {
      type: "zotero_proposal_created",
      proposal_id: proposalId,
      proposal_hash: proposalHash,
      paper_ids: entries.map(([paperId]) => paperId),
      target_id: target.id,
    });
    return {
      ...artifact,
      proposals: artifact.proposals.map(safeProposal),
    };
  }

  async function withProposalLock(runId, operation) {
    const previous = proposalLocks.get(runId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    proposalLocks.set(runId, current);
    try {
      return await current;
    } finally {
      if (proposalLocks.get(runId) === current) proposalLocks.delete(runId);
    }
  }

  function createProposal(runId, options) {
    return withProposalLock(runId, () => createProposalUnlocked(runId, options));
  }

  async function withCommitStartLock(runId, operation) {
    const previous = commitStartLocks.get(runId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    commitStartLocks.set(runId, current);
    try {
      return await current;
    } finally {
      if (commitStartLocks.get(runId) === current) commitStartLocks.delete(runId);
    }
  }

  function proposalCore(artifact) {
    return {
      schema_version: 1,
      run_id: artifact.run_id,
      target: artifact.target,
      decisions: artifact.decisions,
      proposals: artifact.proposals,
      generated_at: artifact.generated_at,
    };
  }

  function assertArtifactIntegrity(runId, state, artifact) {
    if (
      !artifact
      || typeof artifact !== "object"
      || Array.isArray(artifact)
      || artifact.schema_version !== 1
      || artifact.run_id !== runId
      || artifact.proposal_id !== state.proposal_id
      || artifact.proposal_hash !== state.proposal_hash
      || !artifact.target
      || typeof artifact.target !== "object"
      || !artifact.decisions
      || typeof artifact.decisions !== "object"
      || Array.isArray(artifact.decisions)
      || !Array.isArray(artifact.proposals)
      || artifact.proposals.length < 1
      || artifact.proposals.length > 2
      || !isNonEmptyString(artifact.generated_at)
    ) {
      throw archivalError("ZOTERO_PROPOSAL_CORRUPT", "Zotero 写入预览校验失败");
    }
    const proposalIds = new Set();
    for (const proposal of artifact.proposals) {
      assertOperationIntegrity(proposal);
      if (
        proposal.run_id !== runId
        || proposal.target_id !== artifact.target.id
        || proposal.target_version_or_hash !== targetHash(artifact.target)
        || artifact.decisions[proposal.paper_id] !== proposal.decision
        || proposalIds.has(proposal.proposal_id)
      ) {
        throw archivalError("ZOTERO_PROPOSAL_CORRUPT", "Zotero 写入预览校验失败");
      }
      proposalIds.add(proposal.proposal_id);
    }
    if (
      Object.keys(artifact.decisions).length !== artifact.proposals.length
      || sha256(proposalCore(artifact)) !== artifact.proposal_hash
    ) {
      throw archivalError("ZOTERO_PROPOSAL_CORRUPT", "Zotero 写入预览校验失败");
    }
  }

  async function readCurrentArtifact(runId, run = null) {
    const current = run ?? await runStore.getRun(runId);
    if (!current) throw archivalError("RUN_NOT_FOUND", "运行不存在", 404);
    const state = normalizeZoteroState(current);
    if (!state.artifact_path || !state.proposal_id || !state.proposal_hash) {
      throw archivalError("ZOTERO_PROPOSAL_NOT_FOUND", "Zotero 写入预览不存在", 404);
    }
    let artifact;
    try {
      artifact = await runStore.readArtifact(runId, state.artifact_path);
    } catch {
      throw archivalError("ZOTERO_PROPOSAL_CORRUPT", "Zotero 写入预览缺失或损坏");
    }
    try {
      assertArtifactIntegrity(runId, state, artifact);
    } catch {
      throw archivalError("ZOTERO_PROPOSAL_CORRUPT", "Zotero 写入预览校验失败");
    }
    return { run: current, state, artifact };
  }

  async function getProposal(runId) {
    const { artifact } = await readCurrentArtifact(runId);
    return {
      ...artifact,
      proposals: artifact.proposals.map(safeProposal),
    };
  }

  async function assertLiveTarget(target) {
    const targets = await getTargets();
    const liveTarget = targets.targets.find((candidate) => candidate.id === target.id);
    if (
      !liveTarget
      || !liveTarget.editable
      || !liveTarget.filesEditable
      || targetHash(liveTarget) !== targetHash(target)
    ) {
      throw archivalError("ZOTERO_TARGET_STALE", "Zotero 目标已变化，请重新生成预览");
    }
  }

  async function assertCreateDuplicateState(proposal) {
    const duplicateResult = await zoteroAdapter.findDuplicates({
      doi: proposal.item.DOI || null,
      title: proposal.item.title,
      operationId: proposal.proposal_id,
    });
    const duplicate = exactDuplicate(duplicateResult, {
      hasDoi: isNonEmptyString(proposal.item.DOI),
    });
    if (duplicate.ambiguous || (duplicate.match && duplicate.matchedBy !== "operation")) {
      throw archivalError(
        "ZOTERO_PREVIEW_STALE",
        "Zotero 查重结果已变化，请重新生成预览",
      );
    }
  }

  async function validateApproval(runId, { proposalHash, operations } = {}) {
    const { run, state, artifact } = await readCurrentArtifact(runId);
    if (!["awaiting_approval", "partial", "committing"].includes(run.status)) {
      throw archivalError("ZOTERO_APPROVAL_NOT_ALLOWED", "当前阶段不能确认 Zotero 写入");
    }
    if (proposalHash !== artifact.proposal_hash) {
      throw archivalError("ZOTERO_PREVIEW_STALE", "预览内容已变化，请重新检查后再确认");
    }
    if (!Array.isArray(operations) || operations.length === 0) {
      throw archivalError("ZOTERO_APPROVAL_EMPTY", "至少选择一篇论文写入 Zotero", 400);
    }
    const requested = new Map();
    for (const operation of operations) {
      if (
        !operation
        || !isNonEmptyString(operation.proposal_id)
        || !isNonEmptyString(operation.content_hash)
        || !isNonEmptyString(operation.target_version_or_hash)
        || requested.has(operation.proposal_id)
      ) {
        throw archivalError("ZOTERO_APPROVAL_INVALID", "Zotero 批准内容格式无效", 400);
      }
      requested.set(operation.proposal_id, operation);
    }
    const allowedStatuses = run.status === "partial" ? ["failed"] : ["draft", "failed"];
    for (const [proposalId, approval] of requested) {
      const proposal = artifact.proposals.find((candidate) => candidate.proposal_id === proposalId);
      const currentState = state.proposals.find((candidate) => candidate.proposal_id === proposalId);
      if (proposal?.status === "blocked" || proposal?.write_mode !== "create_with_assets") {
        throw archivalError(
          "ZOTERO_APPROVAL_INVALID",
          "需要人工处理的 Zotero 条目不能进入自动写入",
          400,
        );
      }
      if (
        !proposal
        || !currentState
        || !allowedStatuses.includes(currentState.status)
        || proposal.content_hash !== approval.content_hash
        || proposal.target_version_or_hash !== approval.target_version_or_hash
      ) {
        throw archivalError("ZOTERO_PREVIEW_STALE", "批准内容与当前预览不一致");
      }
      assertOperationIntegrity(proposal);
    }
    await assertLiveTarget(artifact.target);
    for (const proposalId of requested.keys()) {
      const proposal = artifact.proposals.find((candidate) => candidate.proposal_id === proposalId);
      await assertCreateDuplicateState(proposal);
    }
    return { run, state, artifact, requested };
  }

  async function verifyOperationInputs(runId, proposal) {
    assertOperationIntegrity(proposal);
    const run = await runStore.getRun(runId);
    const paper = run?.candidates?.find((candidate) => candidate.paper_id === proposal.paper_id);
    if (!paper) {
      throw archivalError("ZOTERO_PREVIEW_STALE", "论文元数据已变化，请重新生成预览");
    }
    const guideResponse = await getPaperGuide(runId, proposal.paper_id);
    const pdf = await getPdf(runId, proposal.paper_id);
    const expectedItem = zoteroItem(paper, runId, proposal.proposal_id);
    const expectedNoteHtml = guideNoteHtml({
      paper,
      guide: guideResponse.guide,
      references: guideResponse.references,
      runId,
      operationId: proposal.proposal_id,
    });
    const expectedGuide = guidePayload(guideResponse, expectedNoteHtml);
    const expectedPdf = {
      file_name: pdf.file_name,
      sha256: pdf.sha256,
      byte_length: pdf.byte_length,
      source_url: paper.pdf_url ?? null,
    };
    if (
      sha256(proposal.item) !== sha256(expectedItem)
      || proposal.note_html !== expectedNoteHtml
      || sha256(proposal.guide) !== sha256(expectedGuide)
      || sha256(proposal.pdf) !== sha256(expectedPdf)
    ) {
      throw archivalError("ZOTERO_PREVIEW_STALE", "论文全文或导读已变化，请重新生成预览");
    }
    let bytes;
    try {
      bytes = await readFile(pdf.file_path);
    } catch {
      throw archivalError("PDF_UNAVAILABLE", "论文原版暂时不可用", 409, true);
    }
    const expectedHash = String(pdf.sha256).replace(/^sha256:/, "").toLowerCase();
    if (
      !/^[a-f0-9]{64}$/.test(expectedHash)
      || bytes.length !== pdf.byte_length
      || createHash("sha256").update(bytes).digest("hex") !== expectedHash
      || bytes.subarray(0, 5).toString("ascii") !== "%PDF-"
    ) {
      throw archivalError("PDF_CORRUPT", "论文原版校验失败");
    }
    return { pdf, bytes };
  }

  async function commitOne(runId, proposal, target) {
    assertOperationIntegrity(proposal);
    await assertLiveTarget(target);
    await assertCreateDuplicateState(proposal);
    const { bytes } = await verifyOperationInputs(runId, proposal);
    return zoteroAdapter.createItem({
      operationId: proposal.proposal_id,
      sessionId: proposal.connector_session_id,
      connectorItemId: proposal.connector_item_id,
      targetId: proposal.target_id,
      item: proposal.item,
      noteHtml: proposal.note_html,
      pdf: {
        bytes,
        fileName: proposal.pdf.file_name,
        url: proposal.pdf.source_url,
        sha256: proposal.pdf.sha256.replace(/^sha256:/, ""),
      },
    });
  }

  function writeLedgerPath(proposalId) {
    return `writes/zotero/${proposalId}.json`;
  }

  async function writeLedger(runId, proposal, {
    approvalId,
    attemptCount,
    status,
    startedAt,
    completedAt = null,
    result = null,
    error = null,
  }) {
    await runStore.writeArtifact(runId, writeLedgerPath(proposal.proposal_id), {
      schema_version: 1,
      run_id: runId,
      proposal_id: proposal.proposal_id,
      approval_id: approvalId,
      operation_id: proposal.proposal_id,
      target_id: proposal.target_id,
      content_hash: proposal.content_hash,
      target_version_or_hash: proposal.target_version_or_hash,
      connector_session_id: proposal.connector_session_id,
      connector_item_id: proposal.connector_item_id,
      status,
      attempt_count: attemptCount,
      started_at: startedAt,
      completed_at: completedAt,
      external_ids: result
        ? {
            item_key: result.itemKey,
            attachment_key: result.attachmentKey ?? null,
            note_key: result.noteKey ?? null,
          }
        : null,
      verified: Boolean(result?.verified),
      idempotent: Boolean(result?.idempotent),
      error,
    });
  }

  async function executeCommit(runId, artifact, selectedIds) {
    for (const proposalId of selectedIds) {
      let proposal = artifact.proposals.find((candidate) => candidate.proposal_id === proposalId);
      const current = await runStore.getRun(runId);
      const currentZotero = normalizeZoteroState(current);
      const currentProposal = currentZotero.proposals.find(
        (candidate) => candidate.proposal_id === proposalId,
      );
      if (currentProposal?.status === "committed") continue;
      const attemptCount = (currentProposal?.attempt_count ?? 0) + 1;
      const startedAt = now().toISOString();
      try {
        const currentArtifact = await readCurrentArtifact(runId, current);
        if (currentArtifact.artifact.proposal_hash !== artifact.proposal_hash) {
          throw archivalError("ZOTERO_PREVIEW_STALE", "Zotero 写入预览已变化");
        }
        await readStoredApproval(runId, currentZotero, currentArtifact.artifact);
        proposal = currentArtifact.artifact.proposals.find(
          (candidate) => candidate.proposal_id === proposalId,
        );
        if (!proposal) {
          throw archivalError("ZOTERO_PROPOSAL_CORRUPT", "Zotero 写入预览校验失败");
        }
        assertOperationIntegrity(proposal);
        await writeLedger(runId, proposal, {
          approvalId: currentZotero.approval?.approval_id ?? null,
          attemptCount,
          status: "committing",
          startedAt,
        });
        const result = await commitOne(runId, proposal, currentArtifact.artifact.target);
        if (!result?.verified || !isNonEmptyString(result.itemKey)) {
          throw archivalError("ZOTERO_VERIFICATION_FAILED", "Zotero 写后核验失败", 502, true);
        }
        const completedAt = now().toISOString();
        await writeLedger(runId, proposal, {
          approvalId: currentZotero.approval?.approval_id ?? null,
          attemptCount,
          status: "committed",
          startedAt,
          completedAt,
          result,
        });
        await update(runId, (run) => {
          const zotero = normalizeZoteroState(run);
          return {
            zotero: {
              ...zotero,
              proposals: zotero.proposals.map((candidate) => candidate.proposal_id === proposalId
                ? {
                    ...candidate,
                    selected: true,
                    status: "committed",
                    attempt_count: attemptCount,
                    external_id: result.itemKey,
                    attachment_id: result.attachmentKey ?? null,
                    note_id: result.noteKey ?? null,
                    verification_result: result.message
                      ?? "Zotero 写入已返回并记录外部 ID；适配器未提供更细的读回核验范围",
                    last_verified_at: completedAt,
                    error: null,
                  }
                : candidate),
            },
          };
        }, {
          type: "zotero_proposal_committed",
          proposal_id: proposalId,
          item_key: result.itemKey,
          attachment_key: result.attachmentKey ?? null,
          note_key: result.noteKey ?? null,
          idempotent: Boolean(result.idempotent),
        });
      } catch (error) {
        const safeError = publicError(error);
        await writeLedger(runId, proposal, {
          approvalId: currentZotero.approval?.approval_id ?? null,
          attemptCount,
          status: "failed",
          startedAt,
          completedAt: now().toISOString(),
          error: safeError,
        }).catch(() => undefined);
        await update(runId, (run) => {
          const zotero = normalizeZoteroState(run);
          return {
            zotero: {
              ...zotero,
              proposals: zotero.proposals.map((candidate) => candidate.proposal_id === proposalId
                ? {
                    ...candidate,
                    selected: true,
                    status: "failed",
                    attempt_count: attemptCount,
                    error: safeError,
                  }
                : candidate),
            },
          };
        }, {
          type: "zotero_proposal_failed",
          proposal_id: proposalId,
          error: safeError,
        });
      }
    }
    return update(runId, (run) => {
      const zotero = normalizeZoteroState(run);
      const selected = zotero.proposals.filter((proposal) => proposal.selected);
      const committed = selected.filter((proposal) => proposal.status === "committed");
      const failed = selected.filter((proposal) => proposal.status === "failed");
      const blocked = zotero.proposals.filter((proposal) => proposal.status === "blocked");
      const retryableFailed = failed.filter((proposal) => proposal.error?.retryable !== false);
      const nonRetryableFailed = failed.filter((proposal) => proposal.error?.retryable === false);
      const allSucceeded = selected.length > 0 && failed.length === 0
        && blocked.length === 0 && committed.length === selected.length;
      const someSucceeded = committed.length > 0;
      const manualActionRequired = !someSucceeded
        && retryableFailed.length === 0
        && (nonRetryableFailed.length > 0 || blocked.length > 0);
      const partial = !allSucceeded
        && !manualActionRequired
        && (someSucceeded || nonRetryableFailed.length > 0 || blocked.length > 0);
      return {
        status: allSucceeded
          ? "completed"
          : manualActionRequired
            ? "manual_action_required"
            : partial
              ? "partial"
              : "awaiting_approval",
        phase: allSucceeded
          ? "zotero_completed"
          : manualActionRequired
            ? "zotero_manual_action"
            : partial
              ? "zotero_partial"
              : "zotero_preview",
        paused_reason: allSucceeded
          ? null
          : manualActionRequired
            ? "自动写入已停止；请先在 Zotero 中人工检查，再重新生成精确预览"
            : partial
            ? blocked.length > 0
              ? "部分论文需要人工更新现有 Zotero 条目；已成功条目不会重复创建"
              : "部分 Zotero 归档失败；已成功条目不会重复创建"
            : "Zotero 尚未写入，可检查后重试",
        zotero: {
          ...zotero,
          status: allSucceeded
            ? "completed"
            : manualActionRequired
              ? "blocked"
              : partial
                ? "partial"
                : "awaiting_approval",
          last_error: failed.length > 0
            ? failed[0].error
            : blocked.length > 0
              ? blocked[0].error
              : null,
        },
      };
    }, {
      type: "zotero_commit_completed",
      selected_proposal_ids: selectedIds,
    });
  }

  function approvalCore(record) {
    return {
      schema_version: 1,
      run_id: record.run_id,
      approval_id: record.approval_id,
      proposal_id: record.proposal_id,
      proposal_hash: record.proposal_hash,
      operations: record.operations,
      approved_at: record.approved_at,
    };
  }

  async function readStoredApproval(runId, state, artifact) {
    if (!isNonEmptyString(state.approval?.artifact_path)) {
      throw archivalError("ZOTERO_APPROVAL_CORRUPT", "Zotero 批准记录不存在");
    }
    let stored;
    try {
      stored = await runStore.readArtifact(runId, state.approval.artifact_path);
    } catch {
      throw archivalError("ZOTERO_APPROVAL_CORRUPT", "Zotero 批准记录缺失或损坏");
    }
    const operations = stored?.operations;
    const uniqueIds = new Set(
      Array.isArray(operations) ? operations.map((operation) => operation?.proposal_id) : [],
    );
    const computedHash = stored && sha256(approvalCore(stored));
    if (
      !stored
      || stored.schema_version !== 1
      || stored.run_id !== runId
      || stored.approval_id !== state.approval.approval_id
      || stored.proposal_id !== artifact.proposal_id
      || stored.proposal_hash !== artifact.proposal_hash
      || stored.approval_hash !== state.approval.approval_hash
      || stored.approval_hash !== computedHash
      || !Array.isArray(operations)
      || operations.length < 1
      || operations.length > artifact.proposals.length
      || uniqueIds.size !== operations.length
      || !Array.isArray(state.approval.operations)
      || sha256(operations) !== sha256(state.approval.operations)
    ) {
      throw archivalError("ZOTERO_APPROVAL_CORRUPT", "Zotero 批准记录校验失败");
    }
    for (const operation of operations) {
      const proposal = artifact.proposals.find(
        (candidate) => candidate.proposal_id === operation?.proposal_id,
      );
      if (
        !proposal
        || proposal.status === "blocked"
        || proposal.write_mode !== "create_with_assets"
        || operation.content_hash !== proposal.content_hash
        || operation.target_version_or_hash !== proposal.target_version_or_hash
      ) {
        throw archivalError("ZOTERO_APPROVAL_CORRUPT", "Zotero 批准内容与预览不一致");
      }
      assertOperationIntegrity(proposal);
    }
    await assertLiveTarget(artifact.target);
    for (const operation of operations) {
      const proposal = artifact.proposals.find(
        (candidate) => candidate.proposal_id === operation.proposal_id,
      );
      await assertCreateDuplicateState(proposal);
    }
    return stored;
  }

  async function pauseCommitForReview(runId, error) {
    const safeError = publicError(error);
    return update(runId, (run) => {
      const zotero = normalizeZoteroState(run);
      const hasCommitted = zotero.proposals.some((proposal) => proposal.status === "committed");
      return {
        status: hasCommitted ? "partial" : "awaiting_approval",
        phase: hasCommitted ? "zotero_partial" : "zotero_preview",
        paused_reason: hasCommitted
          ? `部分 Zotero 归档已成功；${safeError.message}`
          : safeError.message,
        zotero: {
          ...zotero,
          status: hasCommitted ? "partial" : "awaiting_approval",
          approval: null,
          last_error: safeError,
          proposals: zotero.proposals.map((proposal) => proposal.status === "committed"
            || proposal.status === "blocked"
            ? proposal
            : {
                ...proposal,
                status: "draft",
                error: safeError,
              }),
        },
      };
    }, {
      type: "zotero_commit_paused",
      error: safeError,
    });
  }

  async function startCommitUnlocked(runId, approval) {
    if (commitJobs.has(runId)) return runStore.getRun(runId);
    const { artifact, requested } = await validateApproval(runId, approval);
    const selectedIds = [...requested.keys()];
    const approvalRecord = {
      run_id: runId,
      approval_id: `approval-${idFactory().slice(0, 12)}`,
      proposal_id: artifact.proposal_id,
      proposal_hash: artifact.proposal_hash,
      operations: selectedIds.map((proposalId) => ({
        proposal_id: proposalId,
        content_hash: requested.get(proposalId).content_hash,
        target_version_or_hash: requested.get(proposalId).target_version_or_hash,
      })),
      approved_at: now().toISOString(),
    };
    approvalRecord.approval_hash = sha256(approvalCore(approvalRecord));
    const approvalArtifactPath = `approvals/${approvalRecord.approval_id}.json`;
    await runStore.writeArtifact(runId, approvalArtifactPath, {
      ...approvalCore(approvalRecord),
      approval_hash: approvalRecord.approval_hash,
    });
    const { run_id: _runId, ...approvalState } = approvalRecord;
    const started = await update(runId, (run) => {
      const zotero = normalizeZoteroState(run);
      return {
        status: "committing",
        phase: "zotero_commit",
        paused_reason: null,
        zotero: {
          ...zotero,
          status: "committing",
          approval: {
            ...approvalState,
            artifact_path: approvalArtifactPath,
          },
          last_error: null,
          proposals: zotero.proposals.map((proposal) => ({
            ...proposal,
            selected: selectedIds.includes(proposal.proposal_id)
              || proposal.status === "committed",
            status: selectedIds.includes(proposal.proposal_id)
              ? "committing"
              : proposal.status === "blocked"
                ? "blocked"
              : proposal.status === "committed"
                ? "committed"
                : "skipped",
          })),
        },
      };
    }, {
      type: "zotero_commit_approved",
      approval_id: approvalRecord.approval_id,
      proposal_id: artifact.proposal_id,
      selected_proposal_ids: selectedIds,
    });
    const job = executeCommit(runId, artifact, selectedIds)
      .finally(() => commitJobs.delete(runId));
    commitJobs.set(runId, job);
    return started;
  }

  function startCommit(runId, approval) {
    return withCommitStartLock(runId, () => startCommitUnlocked(runId, approval));
  }

  async function resumeCommitUnlocked(runId) {
    if (commitJobs.has(runId)) return runStore.getRun(runId);
    let current;
    try {
      current = await readCurrentArtifact(runId);
      const { run, state, artifact } = current;
      if (run.status !== "committing") return run;
      const approval = await readStoredApproval(runId, state, artifact);
      const selectedIds = approval.operations
        .map((operation) => operation.proposal_id)
        .filter((proposalId) => state.proposals.some((proposal) => (
          proposal.proposal_id === proposalId && proposal.status !== "committed"
        )));
      if (selectedIds.length === 0) return executeCommit(runId, artifact, []);
      const job = executeCommit(runId, artifact, selectedIds)
        .finally(() => commitJobs.delete(runId));
      commitJobs.set(runId, job);
      return run;
    } catch (error) {
      const run = current?.run ?? await runStore.getRun(runId);
      if (run?.status !== "committing") throw error;
      return pauseCommitForReview(runId, error);
    }
  }

  function resumeCommit(runId) {
    return withCommitStartLock(runId, () => resumeCommitUnlocked(runId));
  }

  function waitForCommit(runId) {
    return commitJobs.get(runId) ?? Promise.resolve(runStore.getRun(runId));
  }

  return Object.freeze({
    createProposal,
    getProposal,
    getTargets,
    resumeCommit,
    startCommit,
    validateCommit: validateApproval,
    waitForCommit,
  });
}

export const __test = Object.freeze({
  canonicalize,
  guideNoteHtml,
  sha256,
  targetHash,
  zoteroItem,
});
