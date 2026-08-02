import {
  BUILT_IN_WORKERS,
  DELIVERY_STATUS,
  WORKER_ACTION_CATALOG,
  WORKER_ARTIFACTS,
  WORKER_IDS,
  WORKER_STATUS,
} from "./workerState.js";

const BUSY_CONVERSATION_STATUSES = new Set([
  "queued",
  "planning",
  "running",
  "streaming",
  "executing",
  "steering",
  "aborting",
  "compacting",
  "verifying",
]);

const PROPOSAL_STATUS = Object.freeze({
  preparing: DELIVERY_STATUS.CONFIRMING,
  pending_confirmation: DELIVERY_STATUS.PREPARED,
  retryable_failed: DELIVERY_STATUS.FAILED,
  failed: DELIVERY_STATUS.FAILED,
  invalidated: DELIVERY_STATUS.STALE,
  executing: DELIVERY_STATUS.CONFIRMING,
  succeeded: DELIVERY_STATUS.COMPLETED,
  unknown_outcome: DELIVERY_STATUS.UNKNOWN,
  abandoned: DELIVERY_STATUS.ABANDONED,
});

const LARK_OPERATION_CONTRACTS = Object.freeze({
  create: "full_after",
  overwrite: "full_before_and_after",
  history_revert: "full_before_and_after",
  append: "full_before_with_exact_operation_diff",
  str_replace: "full_before_with_exact_operation_diff",
  block_insert_after: "full_before_with_exact_operation_diff",
  block_replace: "full_before_with_exact_operation_diff",
  block_delete: "full_before_with_exact_operation_diff",
  block_move_after: "full_before_with_exact_operation_diff",
});

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function compactText(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function stringifyPreview(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function stringList(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.every(nonEmptyString);
}

function normalizeExactOperationDiff(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const kind = compactText(value.kind);
  if (!kind) return null;
  if (kind === "append") {
    return {
      kind,
      content: typeof value.content === "string" ? value.content : null,
      format: typeof value.format === "string" ? value.format : null,
    };
  }
  if (kind === "str_replace") {
    return {
      kind,
      pattern: typeof value.pattern === "string" ? value.pattern : null,
      replacement: typeof value.replacement === "string" ? value.replacement : null,
      format: typeof value.format === "string" ? value.format : null,
    };
  }
  if (["block_insert_after", "block_replace"].includes(kind)) {
    return {
      kind,
      blockId: typeof value.blockId === "string" ? value.blockId : null,
      content: typeof value.content === "string" ? value.content : null,
      format: typeof value.format === "string" ? value.format : null,
    };
  }
  if (kind === "block_delete") {
    return {
      kind,
      blockIds: asArray(value.blockIds).filter((item) => typeof item === "string"),
    };
  }
  if (kind === "block_move_after") {
    return {
      kind,
      anchorBlockId: typeof value.anchorBlockId === "string" ? value.anchorBlockId : null,
      sourceBlockIds: asArray(value.sourceBlockIds).filter((item) => typeof item === "string"),
    };
  }
  return { kind };
}

function exactOperationDiffComplete(operation, diff) {
  if (!diff || diff.kind !== operation) return false;
  if (operation === "append") {
    return typeof diff.content === "string" && nonEmptyString(diff.format);
  }
  if (operation === "str_replace") {
    return nonEmptyString(diff.pattern)
      && typeof diff.replacement === "string"
      && nonEmptyString(diff.format);
  }
  if (["block_insert_after", "block_replace"].includes(operation)) {
    return nonEmptyString(diff.blockId)
      && typeof diff.content === "string"
      && nonEmptyString(diff.format);
  }
  if (operation === "block_delete") return stringList(diff.blockIds);
  if (operation === "block_move_after") {
    return nonEmptyString(diff.anchorBlockId) && stringList(diff.sourceBlockIds);
  }
  return false;
}

function larkPreviewComplete(proposal, preview, exactOperationDiff) {
  const contract = preview.contentContract;
  if (contract !== LARK_OPERATION_CONTRACTS[proposal.operation]) return false;
  const hasFullBefore = hasOwn(preview, "fullBefore")
    && preview.fullBefore !== null
    && preview.fullBefore !== undefined;
  const hasFullAfter = hasOwn(preview, "fullAfter")
    && preview.fullAfter !== null
    && preview.fullAfter !== undefined;
  if (contract === "full_after") return hasFullAfter;
  if (contract === "full_before_and_after") return hasFullBefore && hasFullAfter;
  return contract === "full_before_with_exact_operation_diff"
    && hasFullBefore
    && exactOperationDiffComplete(proposal.operation, exactOperationDiff);
}

function mailPreviewComplete(proposal, preview) {
  const hasBefore = hasOwn(preview, "before")
    && preview.before !== null
    && preview.before !== undefined;
  const hasAfter = hasOwn(preview, "after")
    && preview.after !== null
    && preview.after !== undefined;
  const target = preview.target && typeof preview.target === "object"
    ? preview.target
    : {};
  if (proposal.operation === "trash") {
    return hasBefore && preview.after === null && nonEmptyString(target.messageId);
  }
  if (proposal.operation === "send") {
    return preview.before === null && hasAfter && stringList(target.to);
  }
  if (["reply", "reply_all", "forward"].includes(proposal.operation)) {
    const recipients = proposal.operation === "forward"
      ? target.to
      : target.resolvedRecipients?.to;
    return hasBefore && hasAfter && stringList(recipients);
  }
  return false;
}

function proposalDeliveryStatus(proposal) {
  if (proposal.status !== "queued") {
    return PROPOSAL_STATUS[proposal.status] ?? DELIVERY_STATUS.FAILED;
  }
  if (proposal.workerId === WORKER_IDS.AGENT_MAIL) return DELIVERY_STATUS.COMPLETED;
  if (
    proposal.workerId === WORKER_IDS.LARK_DOCUMENT
    && proposal.operation === "history_revert"
  ) return DELIVERY_STATUS.PROVIDER_PENDING;
  return DELIVERY_STATUS.UNKNOWN;
}

function createdAtLabel(value) {
  const date = new Date(value ?? "");
  if (!Number.isFinite(date.getTime())) return "刚刚";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function unwrapWorkerConversation(value) {
  return value?.conversation && typeof value.conversation === "object"
    ? value.conversation
    : value ?? null;
}

export function isWorkerConversationBusy(value) {
  const conversation = unwrapWorkerConversation(value);
  return BUSY_CONVERSATION_STATUSES.has(
    conversation?.turnStatus || conversation?.status,
  );
}

export function normalizeWorkerDefinitions(definitions) {
  const byId = new Map(BUILT_IN_WORKERS.map((worker) => [worker.id, worker]));
  return asArray(definitions).map((definition) => {
    const fallback = byId.get(definition?.id) ?? {};
    return {
      ...fallback,
      ...definition,
      name: compactText(definition?.name, fallback.name || "Worker"),
      shortName: compactText(definition?.shortName, fallback.shortName || definition?.name),
      description: compactText(definition?.purpose, fallback.description),
      connectionLabel: compactText(
        definition?.connectionLabel,
        fallback.connectionLabel || "外部连接",
      ),
    };
  });
}

function connectionLabel(connection, fallback) {
  if (connection?.status === "connected") {
    return connection.identity ? `已连接 · ${connection.identity}` : "已连接";
  }
  if (connection?.status === "checking") return "正在检查连接";
  if (connection?.status === "unchecked") return "尚未检查";
  if (connection?.status === "unavailable") {
    return connection.reason ? `连接不可用 · ${connection.reason}` : "连接不可用";
  }
  return fallback || "未连接";
}

export function normalizeWorkerConnections(connections, definitions = []) {
  const normalized = {};
  for (const connection of asArray(connections)) {
    if (!connection?.workerId) continue;
    const status = connection.status === "connected"
      ? "connected"
      : connection.status === "checking"
        ? "checking"
        : connection.status === "unchecked"
          ? "disconnected"
          : "degraded";
    const value = {
      ...connection,
      status,
      label: connectionLabel(connection),
    };
    normalized[connection.workerId] = value;
    if (connection.connectorId) normalized[connection.connectorId] = value;
  }
  for (const definition of definitions) {
    if (normalized[definition.id]) continue;
    const value = {
      status: "disconnected",
      label: `尚未检查${definition.connectionLabel || "连接"}`,
      verified: false,
    };
    normalized[definition.id] = value;
    if (definition.connectorId && !normalized[definition.connectorId]) {
      normalized[definition.connectorId] = value;
    }
  }
  return normalized;
}

function operationLabel(workerId, operation) {
  return (WORKER_ACTION_CATALOG[workerId] ?? [])
    .find((item) => item.id === operation)?.label ?? operation ?? "外部操作";
}

function proposalTarget(proposal) {
  const target = proposal?.preview?.target;
  if (!target || typeof target !== "object") return "未指定外部目标";
  if (asArray(target.resolvedRecipients?.to).length > 0) {
    return asArray(target.resolvedRecipients.to).join("、");
  }
  if (asArray(target.to).length > 0) return asArray(target.to).join("、");
  if (target.document) return String(target.document);
  if (target.messageId) return `邮件 ${target.messageId}`;
  if (target.parentToken) return `父级 ${target.parentToken}`;
  if (target.parentPosition) return `位置 ${target.parentPosition}`;
  return "当前连接身份";
}

function normalizeMailRecipientDetails(target) {
  if (!target || typeof target !== "object") return null;
  const resolved = target.resolvedRecipients && typeof target.resolvedRecipients === "object"
    ? target.resolvedRecipients
    : null;
  const details = {
    messageId: typeof target.messageId === "string" ? target.messageId : null,
    to: asArray(resolved?.to ?? target.to).filter((item) => typeof item === "string"),
    resolvedCc: asArray(resolved?.cc).filter((item) => typeof item === "string"),
    additionalCc: asArray(target.cc).filter((item) => typeof item === "string"),
    bcc: asArray(target.bcc).filter((item) => typeof item === "string"),
  };
  return details.messageId
    || details.to.length
    || details.resolvedCc.length
    || details.additionalCc.length
    || details.bcc.length
    ? details
    : null;
}

export function normalizeDeliveryProposal(proposal, draft) {
  if (!proposal?.id) return null;
  const status = proposalDeliveryStatus(proposal);
  const preview = proposal.preview && typeof proposal.preview === "object"
    ? proposal.preview
    : {};
  const after = preview.after ?? null;
  const beforeContent = stringifyPreview(preview.before);
  const afterContent = stringifyPreview(after);
  const fullBeforeContent = stringifyPreview(preview.fullBefore);
  const fullAfterContent = stringifyPreview(preview.fullAfter);
  const exactOperationDiff = normalizeExactOperationDiff(preview.exactOperationDiff);
  const previewComplete = proposal.workerId === WORKER_IDS.LARK_DOCUMENT
    ? larkPreviewComplete(proposal, preview, exactOperationDiff)
    : proposal.workerId === WORKER_IDS.AGENT_MAIL
      ? mailPreviewComplete(proposal, preview)
      : false;
  const parameters = proposal.parameters ?? {};
  const recipientDetails = proposal.workerId === WORKER_IDS.AGENT_MAIL
    ? normalizeMailRecipientDetails(preview.target)
    : null;
  const includedOriginalAttachments = asArray(
    after && typeof after === "object" ? after.includedOriginalAttachments : null,
  ).map((attachment) => ({
    id: typeof attachment?.id === "string" ? attachment.id : null,
    name: compactText(attachment?.name, "原邮件附件"),
    byteLength: Number.isSafeInteger(attachment?.size) ? attachment.size : null,
  }));
  const attachments = asArray(proposal.attachmentBindings).map((attachment) => ({
    id: attachment.id,
    name: compactText(attachment.fileName, "邮件附件"),
    mimeType: attachment.mimeType ?? null,
    byteLength: attachment.byteLength ?? null,
    contentHash: attachment.sha256 ?? null,
  }));
  const confirmationPrepared = proposal.status === "pending_confirmation";
  const nativeConfirmationPrepared = proposal.workerId !== WORKER_IDS.AGENT_MAIL
    || proposal.preparation?.confirmationRequired === true;
  const explicitAffectedBlockCount = Number(
    proposal.preview?.impact?.affectedBlockCount ?? parameters.affectedBlockCount,
  );
  const inferredAffectedBlockCount = asArray(
    parameters.affectedBlockIds
      ?? parameters.sourceBlockIds
      ?? parameters.blockIds,
  ).length;
  return {
    id: proposal.id,
    workerId: proposal.workerId,
    operation: proposal.operation,
    operationLabel: compactText(
      proposal.preview?.operationLabel,
      operationLabel(proposal.workerId, proposal.operation),
    ),
    risk: proposal.risk ?? "medium",
    riskLabel: proposal.risk === "high" ? "高风险外部操作" : "外部交付",
    targetLabel: proposalTarget(proposal),
    recipientDetails,
    targetFingerprint: proposal.proposalHash || proposal.id,
    subject: after && typeof after === "object" ? after.subject ?? null : null,
    beforeContent,
    afterContent,
    fullBefore: hasOwn(preview, "fullBefore") ? structuredClone(preview.fullBefore) : null,
    fullAfter: hasOwn(preview, "fullAfter") ? structuredClone(preview.fullAfter) : null,
    fullBeforeContent,
    fullAfterContent,
    contentContract: typeof preview.contentContract === "string"
      ? preview.contentContract
      : null,
    exactOperationDiff,
    previewComplete,
    destructiveDelete: proposal.operation === "block_delete" || proposal.operation === "trash",
    exactContent: afterContent ?? draft?.content ?? "",
    attachments,
    includeOriginalAttachments: after?.includeOriginalAttachments === true,
    includedOriginalAttachments,
    baseRevision: proposal.baseRevisionId ? `版本 ${proposal.baseRevisionId}` : null,
    baseRevisionId: proposal.baseRevisionId ?? null,
    affectedBlockCount: Number.isSafeInteger(explicitAffectedBlockCount)
      && explicitAffectedBlockCount > 0
      ? explicitAffectedBlockCount
      : inferredAffectedBlockCount || null,
    confirmationHint: proposal.preparation?.confirmationExpiresAt
      ? `确认令牌有效至 ${createdAtLabel(proposal.preparation.confirmationExpiresAt)}`
      : asArray(proposal.preview?.warnings).join(" ") || "内容变化后必须重新生成预览。",
    expiresAt: proposal.preparation?.confirmationExpiresAt ?? null,
    preparation: proposal.preparation ?? null,
    nativeConfirmationSummary: proposal.preparation?.summary
      && typeof proposal.preparation.summary === "object"
      && !Array.isArray(proposal.preparation.summary)
      ? structuredClone(proposal.preparation.summary)
      : null,
    proposalHash: proposal.proposalHash ?? null,
    draftRevisionId: proposal.draftRevisionId ?? null,
    draftHash: proposal.draftSha256 ?? null,
    status,
    serverStatus: proposal.status,
    confirmationPrepared,
    nativeConfirmationPrepared,
    retryable: proposal.status === "retryable_failed"
      || proposal.lastError?.retryable === true,
    providerPending: status === DELIVERY_STATUS.PROVIDER_PENDING,
    staleReason: proposal.invalidatedReason === "draft_revised"
      ? "草稿已经保存为新版本，请重新准备交付。"
      : proposal.invalidatedReason ?? null,
    error: proposal.lastError ?? null,
  };
}

export function normalizeDeliveryReceipt(receipt) {
  if (!receipt?.id) return null;
  const unknown = receipt.status === "unknown";
  const queued = receipt.status === "queued";
  const verification = receipt.verification ?? {};
  const manualCheckCompleted = verification.manualCheckCompleted === true;
  const providerPending = queued && (
    receipt.workerId === WORKER_IDS.LARK_DOCUMENT
    || verification.status === "pending_provider_completion"
  );
  const verificationLabels = {
    verified: "已读取验证",
    readback_verified: "已回读验证",
    result_verified: "结果已验证",
    readback_failed: "回读验证失败",
    pending_provider_completion: "等待外部服务完成",
    queued_only: "仅确认进入发送队列",
    manual_check_required: "需要人工检查",
    not_reported: "外部服务未报告读取验证",
  };
  return {
    ...receipt,
    status: manualCheckCompleted
      ? "manual_resolved"
      : unknown
      ? "unknown"
      : providerPending
        ? "provider_pending"
        : queued
          ? "queued"
          : "completed",
    statusLabel: manualCheckCompleted
      ? "人工核对已记录"
      : unknown
      ? "需要人工核对"
      : providerPending
        ? "外部服务处理中"
        : queued
          ? "已进入发送队列"
          : "外部操作已完成",
    summary: manualCheckCompleted
      ? "人工核对已记录"
      : unknown
      ? "交付结果需要人工核对"
      : providerPending
        ? "版本恢复仍在外部服务处理中"
        : queued
        ? "已进入发送队列"
        : "外部交付已完成",
    detail: manualCheckCompleted
      ? "Pi Agent 未判断外部操作成功或失败；本次提案已结束，可以准备新的交付。"
      : unknown
      ? "系统无法确认外部结果，不会自动重试。"
      : providerPending
        ? "尚未完成；续查只会查询现有外部任务，不会重复执行版本恢复。"
        : queued
        ? "队列回执不能证明收件人已经收到。"
        : `外部服务状态：${receipt.providerState || "completed"}`,
    createdAtLabel: createdAtLabel(receipt.createdAt),
    readbackLabel: manualCheckCompleted
      ? "人工核对已记录"
      : verificationLabels[verification.status]
        ?? "外部服务未报告读取验证",
    manualCheckCompleted,
    manualCheckCompletedAt: verification.manualCheckCompletedAt ?? null,
    manualCheckNote: verification.manualCheckNote ?? null,
  };
}

function normalizeMessage(message, index) {
  return {
    id: message?.id ?? `worker-message-${index + 1}`,
    role: message?.role === "user" ? "user" : "assistant",
    content: typeof message?.text === "string"
      ? message.text
      : typeof message?.content === "string"
        ? message.content
        : "",
    status: message?.status ?? null,
    attachments: asArray(message?.attachments),
  };
}

function messageAttachmentSources(messages) {
  const seen = new Set();
  return asArray(messages).flatMap((message) => asArray(message?.attachments).flatMap((attachment) => {
    const id = attachment?.id;
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [{
      id: `message-attachment:${id}`,
      kind: "attachment",
      label: compactText(attachment.fileName, "任务附件"),
      detail: "任务附件 · Agent 可只读使用",
      attachment: {
        id,
        revision: attachment.revision ?? attachment.contentHash,
        contentHash: attachment.contentHash ?? attachment.revision,
        fileName: compactText(attachment.fileName, "任务附件"),
      },
    }];
  }));
}

function externalSources(sources) {
  return asArray(sources).map((source) => ({
    id: source.id,
    kind: source.kind === "mail"
      ? "mail"
      : ["ima_note", "note"].includes(source.kind)
        ? "note"
        : "document",
    operation: source.operation ?? null,
    label: compactText(source.title, "外部资料"),
    detail: `${source.operation || "读取"} · 外部只读资料${source.truncated ? " · 已截断" : ""}`,
    contentPreview: typeof source.content === "string"
      ? source.content.slice(0, 8_000)
      : "",
    untrustedExternalContent: source.untrustedExternalContent !== false,
    truncated: source.truncated === true,
    contentHash: source.contentSha256 ?? null,
    binding: source.binding && typeof source.binding === "object"
      ? structuredClone(source.binding)
      : null,
    exact: source.binding?.exact === true && source.truncated !== true,
    byteLength: source.byteLength ?? null,
    createdAt: source.createdAt ?? null,
  }));
}

function deliveryFiles(files) {
  return asArray(files).map((file) => ({
    id: file.id,
    name: compactText(file.fileName, "邮件附件"),
    mimeType: file.mimeType ?? "application/octet-stream",
    byteLength: file.byteLength ?? null,
    contentHash: file.sha256 ?? null,
    status: file.status ?? "unknown",
    createdAt: file.createdAt ?? null,
    uploadedAt: file.uploadedAt ?? null,
  }));
}

function uniqueSources(sources) {
  const seen = new Set();
  return sources.filter((source) => {
    const key = source?.attachment?.id
      ? `attachment:${source.attachment.id}`
      : `source:${source?.id}`;
    if (!source?.id || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function workerStatus(conversation, proposal, receipt, draft) {
  if (isWorkerConversationBusy(conversation)) return WORKER_STATUS.DRAFTING;
  if (proposal?.status === DELIVERY_STATUS.PREPARED) return WORKER_STATUS.AWAITING_CONFIRMATION;
  if (proposal?.status === DELIVERY_STATUS.CONFIRMING) return WORKER_STATUS.DELIVERING;
  if (proposal?.status === DELIVERY_STATUS.PROVIDER_PENDING) return WORKER_STATUS.DELIVERING;
  if (proposal?.status === DELIVERY_STATUS.UNKNOWN || receipt?.status === "unknown") {
    return WORKER_STATUS.UNKNOWN;
  }
  if (proposal?.status === DELIVERY_STATUS.FAILED) return WORKER_STATUS.BLOCKED;
  if (receipt?.status === "provider_pending") return WORKER_STATUS.DELIVERING;
  if (receipt?.status === "manual_resolved") return WORKER_STATUS.READY;
  if (receipt) return WORKER_STATUS.COMPLETED;
  if (draft) return WORKER_STATUS.DRAFTING;
  return WORKER_STATUS.READY;
}

function fallbackDraft(workerId) {
  return {
    id: null,
    version: 0,
    content: "",
    format: workerId === WORKER_IDS.AGENT_MAIL
      ? "plain"
      : workerId === WORKER_IDS.IMA_NOTE
        ? "markdown"
        : "xml",
    source: "user",
    contentHash: null,
    createdAtLabel: "尚未保存",
  };
}

export function adaptWorkerBundle(bundle, {
  definitions = BUILT_IN_WORKERS,
  connections = {},
  projectOptions = [],
  importedSources = [],
  pendingAttachments = [],
  previousState = null,
  defaultProviderId = "",
  defaultModelId = "",
} = {}) {
  const task = bundle?.task;
  if (!task?.id) return null;
  const unwrappedConversation = unwrapWorkerConversation(bundle.conversation) ?? {};
  const conversation = {
    ...unwrappedConversation,
    events: asArray(bundle.conversation?.events ?? unwrappedConversation.events),
  };
  const worker = definitions.find((item) => item.id === task.workerId)
    ?? BUILT_IN_WORKERS.find((item) => item.id === task.workerId)
    ?? BUILT_IN_WORKERS[0];
  const serverDraft = bundle.draft;
  const draftRevision = serverDraft?.id ? {
    id: serverDraft.id,
    version: serverDraft.version ?? 1,
    content: serverDraft.content ?? "",
    format: serverDraft.format ?? (task.workerId === WORKER_IDS.AGENT_MAIL
      ? "plain"
      : task.workerId === WORKER_IDS.IMA_NOTE
        ? "markdown"
        : "xml"),
    source: serverDraft.source ?? "user",
    contentHash: serverDraft.sha256 ?? null,
    createdAtLabel: createdAtLabel(serverDraft.createdAt),
  } : fallbackDraft(task.workerId);
  const actions = asArray(bundle.actions);
  const proposal = normalizeDeliveryProposal(actions[0], serverDraft);
  const receipts = asArray(bundle.receipts);
  const receipt = normalizeDeliveryReceipt(
    (proposal?.id
      ? receipts.find((item) => item.proposalId === proposal.id)
      : null) ?? receipts[0],
  );
  const sameTask = previousState?.task?.id === task.id;
  const preserveDirtyDraft = sameTask && previousState.draftDirty
    && previousState.draftRevision?.id === draftRevision.id;
  const projectContext = projectOptions.find((item) => item.id === task.sourceProjectId)
    ?? (task.sourceProjectId
      ? { id: task.sourceProjectId, label: conversation.sourceProjectLabel || task.sourceProjectId }
      : null);
  const messages = asArray(conversation.messages).map(normalizeMessage);
  const connection = connections[worker.id]
    ?? connections[worker.connectorId]
    ?? { status: "disconnected", label: "尚未检查连接" };
  return {
    schemaVersion: 1,
    workType: "worker",
    workspaceKind: "scratch",
    projectId: null,
    worker,
    task,
    status: workerStatus(conversation, proposal, receipt, serverDraft),
    activeArtifactId: sameTask
      ? previousState.activeArtifactId
      : WORKER_ARTIFACTS.SOURCES,
    providerId: conversation.providerId || (sameTask ? previousState.providerId : "") || defaultProviderId,
    modelId: conversation.modelId || (sameTask ? previousState.modelId : "") || defaultModelId,
    thinkingLevel: conversation.thinkingLevel ?? null,
    connection,
    projectContext,
    projectOptions,
    messages,
    nextMessageSeq: messages.length + 1,
    composerDraft: sameTask ? previousState.composerDraft : "",
    sources: uniqueSources([
      ...messageAttachmentSources(messages),
      ...externalSources(bundle.sources),
      ...asArray(importedSources),
    ]),
    pendingAttachments: asArray(pendingAttachments),
    deliveryFiles: deliveryFiles(bundle.files),
    draftRevision,
    draftBuffer: preserveDirtyDraft ? previousState.draftBuffer : draftRevision.content,
    draftDirty: preserveDirtyDraft,
    deliveryProposal: preserveDirtyDraft && proposal
      ? { ...proposal, status: DELIVERY_STATUS.STALE, staleReason: "草稿内容尚未保存" }
      : proposal,
    receipt,
    conversation,
    lastError: conversation.lastError ?? null,
  };
}

export function normalizeWorkerTasks(tasks, activeState = null) {
  return asArray(tasks).map((task) => {
    const active = activeState?.task?.id === task.id;
    const subtitle = active
      ? {
          [WORKER_STATUS.READY]: "等待任务",
          [WORKER_STATUS.DRAFTING]: "草稿处理中",
          [WORKER_STATUS.AWAITING_CONFIRMATION]: "交付待确认",
          [WORKER_STATUS.DELIVERING]: "正在交付",
          [WORKER_STATUS.COMPLETED]: "已有交付回执",
          [WORKER_STATUS.BLOCKED]: "需要处理",
          [WORKER_STATUS.UNKNOWN]: "结果待人工核对",
        }[activeState.status]
      : "持久任务";
    return {
      ...task,
      subtitle,
      updatedLabel: createdAtLabel(task.updatedAt),
      unreadCount: active ? activeState.conversation?.unreadCount ?? 0 : 0,
    };
  });
}

function splitList(value) {
  return String(value ?? "")
    .split(/[\n,，;]/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function boundedInteger(value, { fallback, min, max }) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

export function buildWorkerReadInput(workerId, operation, values = {}) {
  if (workerId === WORKER_IDS.LARK_DOCUMENT) {
    if (operation === "search") {
      return {
        operation,
        parameters: {
          query: values.query?.trim() || values.q?.trim(),
          pageSize: boundedInteger(values.pageSize, { fallback: 20, min: 1, max: 20 }),
          ...(values.pageToken?.trim() ? { pageToken: values.pageToken.trim() } : {}),
        },
      };
    }
    return {
      operation,
      parameters: {
        document: values.document?.trim(),
        ...(operation === "fetch" ? {
          detail: values.detail || "simple",
          ...(values.revisionId?.trim() ? { revisionId: Number(values.revisionId) } : {}),
        } : {}),
        ...(operation === "history_list" ? {
          pageSize: boundedInteger(values.pageSize, { fallback: 20, min: 1, max: 20 }),
          ...(values.pageToken?.trim() ? { pageToken: values.pageToken.trim() } : {}),
        } : {}),
      },
    };
  }
  if (workerId === WORKER_IDS.IMA_NOTE) {
    if (operation === "list_notebook") {
      return {
        operation,
        parameters: {
          cursor: values.cursor?.trim() || "0",
          limit: boundedInteger(values.limit, { fallback: 20, min: 1, max: 20 }),
        },
      };
    }
    if (operation === "list_note") {
      return {
        operation,
        parameters: {
          ...(values.folderId?.trim() ? { folderId: values.folderId.trim() } : {}),
          cursor: values.cursor?.trim() || "",
          sortType: boundedInteger(values.sortType, { fallback: 0, min: 0, max: 2 }),
          limit: boundedInteger(values.limit, { fallback: 20, min: 1, max: 20 }),
        },
      };
    }
    if (operation === "search_note") {
      const start = boundedInteger(values.start, { fallback: 0, min: 0, max: 9_999 });
      return {
        operation,
        parameters: {
          query: values.query?.trim(),
          searchType: boundedInteger(values.searchType, { fallback: 0, min: 0, max: 1 }),
          start,
          end: boundedInteger(values.end, {
            fallback: start + 20,
            min: start + 1,
            max: start + 20,
          }),
        },
      };
    }
    if (operation === "get_doc_content") {
      return {
        operation,
        parameters: {
          noteId: values.noteId?.trim(),
          targetContentFormat: 0,
        },
      };
    }
    throw new TypeError("IMA Worker 不支持这项读取操作");
  }
  if (workerId !== WORKER_IDS.AGENT_MAIL) {
    throw new TypeError("未知 Worker 不能读取外部资料");
  }
  if (operation === "read") {
    return { operation, parameters: { messageId: values.messageId?.trim() } };
  }
  if (operation === "attachment_download") {
    return {
      operation,
      parameters: {
        messageId: values.messageId?.trim(),
        attachmentId: values.attachmentId?.trim(),
      },
    };
  }
  return {
    operation,
    parameters: {
      ...(operation === "search" ? { q: values.q?.trim() } : {}),
      ...(values.dir?.trim() ? { dir: values.dir.trim() } : {}),
      ...(values.limit ? {
        limit: boundedInteger(values.limit, { fallback: 20, min: 1, max: 50 }),
      } : {}),
      ...(values.cursor?.trim() ? { cursor: values.cursor.trim() } : {}),
      ...(values.searchIn?.trim() ? { searchIn: values.searchIn.trim() } : {}),
      ...(values.from?.trim() ? { from: values.from.trim() } : {}),
      ...(values.to?.trim() ? { to: values.to.trim() } : {}),
      ...(values.after?.trim() ? { after: values.after.trim() } : {}),
      ...(values.before?.trim() ? { before: values.before.trim() } : {}),
      ...(values.hasAttachments ? { hasAttachments: true } : {}),
      ...(values.isUnread ? { isUnread: true } : {}),
    },
  };
}

function sourceById(sources, sourceId) {
  return asArray(sources).find((source) => source.id === sourceId) ?? null;
}

function selectedAttachmentIds(value) {
  return (Array.isArray(value) ? value : splitList(value)).slice(0, 3);
}

export function buildWorkerActionInput(workerId, operation, values = {}, sources = []) {
  if (workerId === WORKER_IDS.IMA_NOTE) {
    throw new TypeError("IMA Worker 当前仅支持读取资料与整理草稿");
  }
  if (workerId === WORKER_IDS.AGENT_MAIL) {
    const beforeSource = sourceById(sources, values.beforeSourceId);
    if (operation === "trash") {
      return {
        operation,
        parameters: { messageId: beforeSource?.binding?.messageId },
        beforeSourceId: beforeSource?.id,
      };
    }
    const parameters = {
      cc: splitList(values.cc),
      bcc: splitList(values.bcc),
      attachments: selectedAttachmentIds(values.attachments),
    };
    if (operation === "send") {
      parameters.to = splitList(values.to);
      parameters.subject = values.subject?.trim();
    } else {
      parameters.messageId = beforeSource?.binding?.messageId;
      if (operation === "forward") {
        parameters.to = splitList(values.to);
        parameters.includeAttachments = values.includeAttachments === true;
      }
    }
    return {
      operation,
      parameters,
      ...(operation === "send" ? {} : { beforeSourceId: beforeSource?.id }),
    };
  }

  if (workerId !== WORKER_IDS.LARK_DOCUMENT) {
    throw new TypeError("未知 Worker 不能准备外部交付");
  }

  if (operation === "create") {
    return {
      operation,
      parameters: {
        ...(values.title?.trim() ? { title: values.title.trim() } : {}),
        ...(values.parentToken?.trim() ? { parentToken: values.parentToken.trim() } : {}),
        ...(values.parentPosition?.trim() ? { parentPosition: values.parentPosition.trim() } : {}),
      },
    };
  }
  const beforeSource = sourceById(sources, values.beforeSourceId);
  const parameters = {
    document: beforeSource?.binding?.requestedDocument,
    baseRevisionId: beforeSource?.binding?.revisionId,
  };
  if (operation === "str_replace") parameters.pattern = values.pattern;
  if (["block_insert_after", "block_replace"].includes(operation)) {
    parameters.blockId = values.blockId?.trim();
  }
  if (operation === "block_delete") parameters.blockIds = splitList(values.blockIds);
  if (operation === "block_move_after") {
    parameters.anchorBlockId = values.anchorBlockId?.trim();
    parameters.sourceBlockIds = splitList(values.sourceBlockIds);
  }
  if (operation === "history_revert") {
    parameters.historyVersionId = values.historyVersionId?.trim();
  }
  return {
    operation,
    parameters,
    beforeSourceId: beforeSource?.id,
    ...(operation === "history_revert" ? {
      afterSourceId: values.afterSourceId,
      historySourceId: values.historySourceId,
    } : {}),
  };
}

export const __test = Object.freeze({
  splitList,
  selectedAttachmentIds,
  stringifyPreview,
});
