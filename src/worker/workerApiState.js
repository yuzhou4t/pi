import {
  BUILT_IN_WORKERS,
  createInitialWorkerState,
  DELIVERY_STATUS,
  WORKER_ARTIFACTS,
  WORKER_STATUS,
} from "./workerState.js";

function conversationRecord(bundle) {
  return bundle?.conversation?.conversation
    ?? bundle?.conversation
    ?? null;
}

function displayTarget(preview) {
  const target = preview?.target;
  if (!target || typeof target !== "object") return "外部目标";
  if (Array.isArray(target.to) && target.to.length > 0) return target.to.join("、");
  if (target.document) return String(target.document);
  if (target.messageId) return String(target.messageId);
  return "外部目标";
}

function uiActionStatus(status) {
  return {
    preparing: DELIVERY_STATUS.PREPARED,
    pending_confirmation: DELIVERY_STATUS.PREPARED,
    invalidated: DELIVERY_STATUS.STALE,
    retryable_failed: DELIVERY_STATUS.FAILED,
    executing: DELIVERY_STATUS.CONFIRMING,
    abandoned: DELIVERY_STATUS.ABANDONED,
    failed: DELIVERY_STATUS.FAILED,
    unknown_outcome: DELIVERY_STATUS.UNKNOWN,
    succeeded: DELIVERY_STATUS.COMPLETED,
  }[status] ?? DELIVERY_STATUS.FAILED;
}

function uiProposal(action, draft) {
  if (!action) return null;
  const preview = action.preview ?? {};
  const parameters = action.parameters ?? {};
  const prepared = action.status === "pending_confirmation";
  const after = preview.after;
  const afterContent = typeof after === "string"
    ? after
    : typeof after?.content === "string"
      ? after.content
      : null;
  const beforeContent = typeof preview.before === "string"
    ? preview.before
    : preview.before?.content ?? (preview.before ? JSON.stringify(preview.before, null, 2) : null);
  return {
    id: action.id,
    workerId: action.workerId,
    operation: action.operation,
    operationLabel: preview.operationLabel ?? action.operation,
    risk: action.risk,
    riskLabel: action.risk === "high" ? "高风险操作" : "外部交付",
    targetLabel: displayTarget(preview),
    targetFingerprint: `target:${action.proposalHash}`,
    subject: parameters.subject ?? null,
    beforeContent,
    afterContent,
    exactContent: afterContent ?? draft?.content ?? "",
    attachments: (parameters.attachments ?? []).map((name) => ({ name })),
    baseRevision: action.baseRevisionId ? `版本 ${action.baseRevisionId}` : null,
    baseRevisionId: action.baseRevisionId ?? null,
    affectedBlockCount: parameters.affectedBlockIds?.length
      ?? parameters.sourceBlockIds?.length
      ?? null,
    confirmationHint: action.preparation?.confirmationExpiresAt
      ? `原生确认令牌有效至 ${new Date(action.preparation.confirmationExpiresAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`
      : "执行前会再次校验目标版本",
    status: uiActionStatus(action.status),
    staleReason: action.invalidatedReason === "draft_revised"
      ? "草稿已保存为新版本"
      : action.lastError?.message ?? null,
    draftRevisionId: action.draftRevisionId,
    draftHash: action.draftSha256,
    proposalHash: action.proposalHash,
    nativeConfirmationPrepared: prepared,
    expiresAt: action.preparation?.confirmationExpiresAt ?? null,
  };
}

function uiReceipt(receipt) {
  if (!receipt) return null;
  const unknown = receipt.status === "unknown";
  const queued = receipt.status === "queued";
  return {
    id: receipt.id,
    status: unknown ? "unknown" : "completed",
    statusLabel: unknown ? "需要人工核对" : queued ? "已进入发送队列" : "交付已完成",
    summary: unknown
      ? "外部结果不确定"
      : queued
        ? "已进入发送队列"
        : "外部交付已完成",
    detail: unknown
      ? "系统已停止自动重试，请在对应服务中人工核对。"
      : queued
        ? "该回执不能证明收件人已经收到邮件。"
        : "服务端已记录外部回执和读取验证。",
    externalId: receipt.externalId,
    externalUrl: receipt.externalUrl,
    proposalHash: receipt.proposalHash,
    readbackLabel: receipt.verification?.status ?? "未报告",
    createdAtLabel: receipt.createdAt
      ? new Date(receipt.createdAt).toLocaleString("zh-CN")
      : "刚刚",
  };
}

export function workerTaskListItem(task) {
  return {
    id: task.id,
    workerId: task.workerId,
    title: task.title,
    subtitle: task.status === "active" ? "任务已保存" : task.status,
    updatedLabel: task.updatedAt ? new Date(task.updatedAt).toLocaleDateString("zh-CN") : "刚刚",
    unreadCount: 0,
  };
}

export function createWorkerUiState(bundle, {
  connections = [],
  projects = [],
} = {}) {
  const task = bundle.task;
  const worker = BUILT_IN_WORKERS.find((item) => item.id === task.workerId)
    ?? BUILT_IN_WORKERS[0];
  const conversation = conversationRecord(bundle);
  const draft = bundle.draft;
  const action = (bundle.actions ?? [])[0] ?? null;
  const receipt = (bundle.receipts ?? [])[0] ?? null;
  const connection = connections.find((item) => item.workerId === task.workerId);
  const project = projects.find((item) => item.id === task.sourceProjectId) ?? null;
  const draftRevision = draft
    ? {
        id: draft.id,
        version: draft.version,
        content: draft.content,
        format: draft.format,
        source: draft.source,
        contentHash: draft.sha256,
        createdAtLabel: draft.createdAt
          ? new Date(draft.createdAt).toLocaleString("zh-CN")
          : "刚刚保存",
      }
    : {
        id: "draft-empty",
        version: 0,
        content: "",
        format: task.workerId === "agent_mail" ? "plain" : "markdown",
        source: "user",
        contentHash: null,
        createdAtLabel: "尚未保存",
      };
  const uiReceiptValue = uiReceipt(receipt);
  const deliveryProposal = uiProposal(action, draft);
  return createInitialWorkerState({
    workerId: task.workerId,
    task: workerTaskListItem(task),
    status: uiReceiptValue
      ? uiReceiptValue.status === "unknown" ? WORKER_STATUS.UNKNOWN : WORKER_STATUS.COMPLETED
      : deliveryProposal?.status === DELIVERY_STATUS.PREPARED
        ? WORKER_STATUS.AWAITING_CONFIRMATION
        : conversation?.status === "running"
          ? WORKER_STATUS.DRAFTING
          : WORKER_STATUS.READY,
    activeArtifactId: deliveryProposal?.status === DELIVERY_STATUS.PREPARED
      ? WORKER_ARTIFACTS.DELIVERY
      : WORKER_ARTIFACTS.DRAFT,
    providerId: conversation?.providerId ?? "",
    modelId: conversation?.modelId ?? "跟随 Worker 默认模型",
    connection: {
      status: connection?.status === "connected" ? "connected" : "disconnected",
      label: connection?.status === "connected"
        ? `${connection.identity || worker.connectionLabel}已连接`
        : connection?.status === "unchecked"
          ? "连接尚未检查"
          : "连接需要检查",
      accountLabel: connection?.identity ?? worker.connectionLabel,
    },
    projectContext: project ? { id: project.id, label: project.name } : null,
    projectOptions: projects.map((item) => ({ id: item.id, label: item.name })),
    messages: (conversation?.messages ?? []).map((message) => ({
      id: message.id,
      role: message.role,
      content: message.text ?? "",
    })),
    nextMessageSeq: (conversation?.messages?.length ?? 0) + 1,
    sources: project ? [{
      id: `project:${project.id}`,
      kind: "project_context",
      label: project.name,
      detail: "项目背景 · 只读",
    }] : [],
    draftRevision,
    draftBuffer: draftRevision.content,
    draftDirty: false,
    deliveryProposal,
    receipt: uiReceiptValue,
  });
}
