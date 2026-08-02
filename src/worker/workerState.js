export const WORKER_STATE_VERSION = 1;

export const WORKER_IDS = Object.freeze({
  LARK_DOCUMENT: "lark_doc",
  AGENT_MAIL: "agent_mail",
  IMA_NOTE: "ima_note",
});

export const WORKER_ARTIFACTS = Object.freeze({
  SOURCES: "sources",
  DRAFT: "draft",
  DELIVERY: "delivery",
  RECEIPT: "receipt",
});

export const WORKER_STATUS = Object.freeze({
  READY: "ready",
  DRAFTING: "drafting",
  AWAITING_CONFIRMATION: "awaiting_confirmation",
  DELIVERING: "delivering",
  COMPLETED: "completed",
  BLOCKED: "blocked",
  UNKNOWN: "unknown",
});

export const DELIVERY_STATUS = Object.freeze({
  PREPARED: "prepared",
  STALE: "stale",
  CONFIRMING: "confirming",
  PROVIDER_PENDING: "provider_pending",
  ABANDONED: "abandoned",
  FAILED: "failed",
  UNKNOWN: "unknown",
  COMPLETED: "completed",
});

export const WORKER_ACTIONS = Object.freeze({
  SET_ACTIVE_ARTIFACT: "SET_ACTIVE_ARTIFACT",
  SET_MODEL: "SET_MODEL",
  SET_PROJECT_CONTEXT: "SET_PROJECT_CONTEXT",
  SET_COMPOSER_DRAFT: "SET_COMPOSER_DRAFT",
  SEND_MESSAGE: "SEND_MESSAGE",
  START_DRAFT_EDIT: "START_DRAFT_EDIT",
  SET_DRAFT_BUFFER: "SET_DRAFT_BUFFER",
  SAVE_DRAFT: "SAVE_DRAFT",
  REPLACE_DRAFT_REVISION: "REPLACE_DRAFT_REVISION",
  SET_DELIVERY_PROPOSAL: "SET_DELIVERY_PROPOSAL",
  CONFIRM_DELIVERY: "CONFIRM_DELIVERY",
  ABANDON_DELIVERY: "ABANDON_DELIVERY",
  SET_RECEIPT: "SET_RECEIPT",
});

export const BUILT_IN_WORKERS = Object.freeze([
  Object.freeze({
    id: WORKER_IDS.LARK_DOCUMENT,
    name: "飞书文档 Worker",
    shortName: "飞书文档",
    description: "读取、起草并审阅飞书文档交付",
    connectorId: "lark",
    connectionLabel: "飞书工作身份",
  }),
  Object.freeze({
    id: WORKER_IDS.AGENT_MAIL,
    name: "Agent 邮箱 Worker",
    shortName: "Agent 邮箱",
    description: "处理邮件草稿、回复与安全发送",
    connectorId: "agent_mail",
    connectionLabel: "Agent 邮箱",
  }),
  Object.freeze({
    id: WORKER_IDS.IMA_NOTE,
    name: "IMA 笔记 Worker",
    shortName: "IMA 笔记",
    description: "搜索、读取并整理 IMA 笔记草稿",
    connectorId: "ima",
    connectionLabel: "IMA 工作身份",
  }),
]);

export const WORKER_ACTION_CATALOG = Object.freeze({
  [WORKER_IDS.LARK_DOCUMENT]: Object.freeze([
    Object.freeze({ id: "search", label: "查询文档", mode: "read" }),
    Object.freeze({ id: "fetch", label: "查询与读取", mode: "read" }),
    Object.freeze({ id: "create", label: "新建文档", mode: "write", risk: "low" }),
    Object.freeze({ id: "append", label: "追加内容", mode: "write", risk: "low" }),
    Object.freeze({ id: "overwrite", label: "全文覆盖", mode: "write", risk: "high" }),
    Object.freeze({ id: "str_replace", label: "精确替换", mode: "write", risk: "medium" }),
    Object.freeze({ id: "block_insert_after", label: "插入内容块", mode: "write", risk: "low" }),
    Object.freeze({ id: "block_replace", label: "替换内容块", mode: "write", risk: "medium" }),
    Object.freeze({ id: "block_delete", label: "删除内容块", mode: "write", risk: "high" }),
    Object.freeze({ id: "block_move_after", label: "移动内容块", mode: "write", risk: "medium" }),
    Object.freeze({ id: "history_list", label: "查询历史版本", mode: "read" }),
    Object.freeze({ id: "history_revert", label: "恢复历史版本", mode: "write", risk: "high" }),
  ]),
  [WORKER_IDS.AGENT_MAIL]: Object.freeze([
    Object.freeze({ id: "list", label: "列出邮件", mode: "read" }),
    Object.freeze({ id: "search", label: "搜索邮件", mode: "read" }),
    Object.freeze({ id: "read", label: "阅读邮件", mode: "read" }),
    Object.freeze({ id: "attachment_download", label: "下载附件", mode: "read" }),
    Object.freeze({ id: "send", label: "发送新邮件", mode: "write", risk: "medium" }),
    Object.freeze({ id: "reply", label: "回复", mode: "write", risk: "medium" }),
    Object.freeze({ id: "reply_all", label: "回复全部", mode: "write", risk: "medium" }),
    Object.freeze({ id: "forward", label: "转发", mode: "write", risk: "medium" }),
    Object.freeze({ id: "trash", label: "移入回收站", mode: "write", risk: "high" }),
  ]),
  [WORKER_IDS.IMA_NOTE]: Object.freeze([
    Object.freeze({ id: "list_notebook", label: "列出笔记本", mode: "read" }),
    Object.freeze({ id: "list_note", label: "列出笔记", mode: "read" }),
    Object.freeze({ id: "search_note", label: "搜索笔记", mode: "read" }),
    Object.freeze({ id: "get_doc_content", label: "读取笔记正文", mode: "read" }),
  ]),
});

export const DEFAULT_WORKER_TASKS = Object.freeze([
  Object.freeze({
    id: "worker-task-lark-weekly",
    workerId: WORKER_IDS.LARK_DOCUMENT,
    title: "整理本周项目进展",
    subtitle: "草稿已保存",
    updatedLabel: "今天",
    unreadCount: 0,
  }),
  Object.freeze({
    id: "worker-task-mail-mentor",
    workerId: WORKER_IDS.AGENT_MAIL,
    title: "给导师发送本周进展",
    subtitle: "交付待确认",
    updatedLabel: "刚刚",
    unreadCount: 1,
  }),
  Object.freeze({
    id: "worker-task-ima-notes",
    workerId: WORKER_IDS.IMA_NOTE,
    title: "整理 IMA 笔记",
    subtitle: "只读资料与草稿",
    updatedLabel: "今天",
    unreadCount: 0,
  }),
]);

const DEFAULT_MAIL_DRAFT = `王老师您好：

本周已完成 Worker 工作区的信息架构和安全交付流程梳理，并明确了飞书文档与邮件任务的确认边界。下一步将完成连接状态校验和端到端验收，重点检查草稿版本、交付哈希与回执是否一致。

如您方便，我想在本周例会上用五分钟汇报当前结果，并确认下一阶段的优先级。

祝好`;

const DEFAULT_LARK_DRAFT = `本周已完成

- 明确 Worker 工作区与正常工作的产品边界
- 完成飞书文档和 Agent 邮箱的交付确认设计
- 建立草稿版本、提案哈希和回执的关联规则

下一步

- 校验连接身份与授权范围
- 完成端到端验收并记录失败恢复结果`;

const DEFAULT_IMA_DRAFT = `# IMA 笔记草稿

在左侧 IMA 笔记 Worker 下创建任务后，可以读取已有笔记或笔记本资料，并在这里继续整理 Markdown 草稿。

当前阶段不会创建或追加 IMA 笔记。`;

const DEFAULT_WORKER_FIXTURES = Object.freeze({
  [WORKER_IDS.AGENT_MAIL]: Object.freeze({
    draft: DEFAULT_MAIL_DRAFT,
    draftRevisionId: "draft-revision-mail-3",
    draftHash: "sha256:9e2a8f7d52b92b2c20b11886e3d9a0a18541267f89e58390f822709e2de63a8f",
    proposalHash: "sha256:af4a511413644348df34320a87f5f197e1f3068f9c7c277d53c204c0776f2f91",
    messages: Object.freeze([
      Object.freeze({
        id: "worker-message-1",
        role: "user",
        content: "根据本周项目进展，帮我整理一封发给导师的邮件。语气直接，正文控制在 300 字以内。",
      }),
      Object.freeze({
        id: "worker-message-2",
        role: "assistant",
        content: "邮件草稿已经整理好。右侧可以直接编辑；保存后会按最新版本重新生成交付预览。发送前会显示收件人、主题、正文和附件，并等待你确认。",
      }),
    ]),
    sources: Object.freeze([
      Object.freeze({
        id: "source-project-weekly",
        kind: "project_context",
        label: "本周项目进展",
        detail: "只读摘要 · 8 条记录",
      }),
      Object.freeze({
        id: "source-communication-style",
        kind: "note",
        label: "沟通偏好",
        detail: "简洁、先结论、不使用夸张措辞",
      }),
    ]),
    proposal: Object.freeze({
      id: "delivery-proposal-mail-1",
      operation: "send",
      operationLabel: "发送新邮件",
      risk: "medium",
      riskLabel: "外部发送",
      targetLabel: "导师邮箱 · 已验证联系人",
      targetFingerprint: "contact:mentor:7a91",
      subject: "本周项目进展与下一步计划",
      beforeContent: null,
      afterContent: null,
      contentContract: null,
      exactOperationDiff: null,
      previewComplete: true,
      attachments: Object.freeze([]),
      baseRevision: null,
      affectedBlockCount: null,
      confirmationHint: "确认令牌将在准备后 5 分钟失效",
    }),
  }),
  [WORKER_IDS.LARK_DOCUMENT]: Object.freeze({
    draft: DEFAULT_LARK_DRAFT,
    draftRevisionId: "draft-revision-lark-2",
    draftHash: "sha256:40392d4bc8aaf9dd617acc792029af4d77502e67e53986a83cc5457d5e57494d",
    proposalHash: "sha256:0155fae1bb8f54d1a289298ea5aee7d8d8cf68ed97f7ad75d991c6c30dad86af",
    messages: Object.freeze([
      Object.freeze({
        id: "worker-message-1",
        role: "user",
        content: "把本周工作记录整理到飞书周报的“项目进展”部分，保留现有标题。",
      }),
      Object.freeze({
        id: "worker-message-2",
        role: "assistant",
        content: "文档草稿已经按“本周已完成”和“下一步”整理好。右侧可以继续编辑；真正修改飞书前会读取当前版本，并展示精确前后内容。",
      }),
    ]),
    sources: Object.freeze([
      Object.freeze({
        id: "source-lark-weekly",
        kind: "document",
        label: "项目周报 · 项目进展",
        detail: "飞书文档 · 当前版本 128",
      }),
      Object.freeze({
        id: "source-work-records",
        kind: "attachment",
        label: "本周工作记录.md",
        detail: "任务附件 · 只读",
      }),
    ]),
    proposal: Object.freeze({
      id: "delivery-proposal-lark-1",
      operation: "str_replace",
      operationLabel: "精确替换文档内容",
      risk: "medium",
      riskLabel: "文档修改",
      targetLabel: "项目周报 · 飞书文档",
      targetFingerprint: "lark-doc:weekly-report:12b6",
      subject: null,
      beforeContent: "本周暂无更新。",
      afterContent: DEFAULT_LARK_DRAFT,
      fullBeforeContent: "本周暂无更新。",
      fullAfterContent: null,
      contentContract: "full_before_with_exact_operation_diff",
      exactOperationDiff: Object.freeze({
        kind: "str_replace",
        pattern: "本周暂无更新。",
        replacement: DEFAULT_LARK_DRAFT,
        format: "xml",
      }),
      previewComplete: true,
      attachments: Object.freeze([]),
      baseRevision: "版本 128",
      affectedBlockCount: 2,
      confirmationHint: "写入前会再次校验文档版本与内容块标识",
    }),
  }),
  [WORKER_IDS.IMA_NOTE]: Object.freeze({
    draft: DEFAULT_IMA_DRAFT,
    draftRevisionId: "draft-revision-ima-1",
    draftHash: null,
    proposalHash: null,
    messages: Object.freeze([
      Object.freeze({
        id: "worker-message-1",
        role: "assistant",
        content: "IMA 笔记资料可以在右侧按需读取并加入当前任务。草稿使用 Markdown；创建或追加笔记尚未开放。",
      }),
    ]),
    sources: Object.freeze([]),
    proposal: null,
  }),
});

const ARTIFACT_IDS = new Set(Object.values(WORKER_ARTIFACTS));
const STATUS_VALUES = new Set(Object.values(WORKER_STATUS));
const DELIVERY_STATUS_VALUES = new Set(Object.values(DELIVERY_STATUS));

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function findWorker(workerId) {
  return BUILT_IN_WORKERS.find((worker) => worker.id === workerId) ?? BUILT_IN_WORKERS[1];
}

function invalidateProposal(proposal, reason = "草稿内容已更改") {
  if (!proposal || proposal.status === DELIVERY_STATUS.ABANDONED) return proposal;
  return {
    ...proposal,
    status: DELIVERY_STATUS.STALE,
    staleReason: reason,
    confirmationPrepared: false,
    nativeConfirmationPrepared: false,
  };
}

function createLocalRevision(currentRevision, content, action) {
  const version = currentRevision.version + 1;
  return {
    id: action.revisionId || `draft-revision-local-${version}`,
    version,
    content,
    format: typeof action.format === "string" && action.format
      ? action.format
      : currentRevision.format,
    source: action.source === "agent" ? "agent" : "user",
    contentHash: typeof action.contentHash === "string" && action.contentHash
      ? action.contentHash
      : null,
    createdAtLabel: action.createdAtLabel || "刚刚保存",
  };
}

export function createInitialWorkerState(overrides = {}) {
  const taskOverride = overrides.task ?? {};
  const workerId = taskOverride.workerId ?? overrides.workerId ?? WORKER_IDS.AGENT_MAIL;
  const worker = findWorker(workerId);
  const fixture = DEFAULT_WORKER_FIXTURES[worker.id] ?? DEFAULT_WORKER_FIXTURES[WORKER_IDS.AGENT_MAIL];
  const defaultTask = DEFAULT_WORKER_TASKS.find((task) => task.workerId === worker.id)
    ?? DEFAULT_WORKER_TASKS[1];
  const task = { ...defaultTask, ...taskOverride, workerId: worker.id };
  const defaultDraftFormat = workerId === WORKER_IDS.AGENT_MAIL
    ? "plain"
    : workerId === WORKER_IDS.IMA_NOTE
      ? "markdown"
      : "xml";
  const draftRevision = {
    id: fixture.draftRevisionId,
    version: workerId === WORKER_IDS.AGENT_MAIL
      ? 3
      : workerId === WORKER_IDS.IMA_NOTE
        ? 1
        : 2,
    content: fixture.draft,
    format: defaultDraftFormat,
    source: "agent",
    contentHash: fixture.draftHash,
    createdAtLabel: "刚刚保存",
    ...(overrides.draftRevision ?? {}),
  };
  const defaultProposal = fixture.proposal ? {
    ...fixture.proposal,
    status: DELIVERY_STATUS.PREPARED,
    workerId: worker.id,
    exactContent: draftRevision.content,
    afterContent: fixture.proposal.afterContent !== null ? draftRevision.content : null,
    exactOperationDiff: fixture.proposal.exactOperationDiff
      ? {
          ...fixture.proposal.exactOperationDiff,
          ...(fixture.proposal.exactOperationDiff.kind === "str_replace"
            ? { replacement: draftRevision.content, format: draftRevision.format }
            : {}),
        }
      : null,
    draftRevisionId: draftRevision.id,
    draftHash: draftRevision.contentHash,
    proposalHash: fixture.proposalHash,
    confirmationPrepared: true,
    nativeConfirmationPrepared: worker.id === WORKER_IDS.AGENT_MAIL,
  } : null;
  const deliveryProposal = hasOwn(overrides, "deliveryProposal")
    ? overrides.deliveryProposal
    : defaultProposal;
  const projectContext = hasOwn(overrides, "projectContext")
    ? overrides.projectContext
    : null;

  return {
    schemaVersion: WORKER_STATE_VERSION,
    workType: "worker",
    workspaceKind: "scratch",
    projectId: null,
    worker,
    task,
    status: deliveryProposal
      ? WORKER_STATUS.AWAITING_CONFIRMATION
      : WORKER_STATUS.DRAFTING,
    activeArtifactId: WORKER_ARTIFACTS.DRAFT,
    providerId: "",
    modelId: "跟随 Worker 默认模型",
    connection: {
      status: "connected",
      label: `${worker.connectionLabel}已连接`,
      accountLabel: worker.connectionLabel,
    },
    projectContext,
    projectOptions: [],
    messages: fixture.messages.map((message) => ({ ...message })),
    nextMessageSeq: fixture.messages.length + 1,
    composerDraft: "",
    sources: fixture.sources.map((source) => ({ ...source })),
    deliveryFiles: [],
    draftRevision,
    draftBuffer: draftRevision.content,
    draftDirty: false,
    deliveryProposal,
    receipt: hasOwn(overrides, "receipt") ? overrides.receipt : null,
    ...overrides,
    schemaVersion: WORKER_STATE_VERSION,
    workType: "worker",
    workspaceKind: "scratch",
    worker,
    task,
    projectContext,
    projectId: null,
    draftRevision,
    draftBuffer: hasOwn(overrides, "draftBuffer")
      ? overrides.draftBuffer
      : draftRevision.content,
    deliveryProposal,
  };
}

export function createDeliveryConfirmationInput(state) {
  const proposal = state?.deliveryProposal;
  const revision = state?.draftRevision;
  if (!proposal || state.draftDirty) return null;
  if (proposal.status !== DELIVERY_STATUS.PREPARED) return null;
  if (proposal.previewComplete !== true) return null;
  if (proposal.workerId !== state.worker?.id) return null;
  if (proposal.confirmationPrepared !== true) return null;
  if (typeof proposal.targetFingerprint !== "string" || !proposal.targetFingerprint) return null;
  if (state.worker.id === WORKER_IDS.AGENT_MAIL) {
    if (proposal.nativeConfirmationPrepared !== true) return null;
    if (Array.isArray(proposal.attachments) && proposal.attachments.length > 3) return null;
  }
  if (
    state.worker.id === WORKER_IDS.LARK_DOCUMENT
    && proposal.operation !== "create"
    && !proposal.baseRevision
  ) return null;
  if (!proposal.proposalHash) return null;
  const draftBound = proposal.draftRevisionId !== null
    && proposal.draftRevisionId !== undefined;
  if (draftBound) {
    if (!revision || !proposal.draftHash || !revision.contentHash) return null;
    if (proposal.draftRevisionId !== revision.id) return null;
    if (proposal.draftHash !== revision.contentHash) return null;
  } else if (proposal.draftHash !== null && proposal.draftHash !== undefined) {
    return null;
  }
  if (proposal.expiresAt) {
    const expiresAt = new Date(proposal.expiresAt).getTime();
    if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) return null;
  }
  return {
    taskId: state.task.id,
    actionId: proposal.id,
    workerId: state.worker.id,
    operation: proposal.operation,
    proposalHash: proposal.proposalHash,
    draftRevisionId: draftBound ? revision.id : null,
    draftHash: draftBound ? revision.contentHash : null,
    baseRevisionId: proposal.baseRevisionId ?? null,
    targetFingerprint: proposal.targetFingerprint,
  };
}

export function workerReducer(state, action) {
  switch (action.type) {
    case WORKER_ACTIONS.SET_ACTIVE_ARTIFACT:
      if (!ARTIFACT_IDS.has(action.artifactId) || action.artifactId === state.activeArtifactId) {
        return state;
      }
      return { ...state, activeArtifactId: action.artifactId };

    case WORKER_ACTIONS.SET_MODEL:
      if (typeof action.providerId !== "string" || typeof action.modelId !== "string") return state;
      return { ...state, providerId: action.providerId, modelId: action.modelId };

    case WORKER_ACTIONS.SET_PROJECT_CONTEXT: {
      const context = action.context && typeof action.context.id === "string"
        ? { id: action.context.id, label: String(action.context.label || action.context.id) }
        : null;
      if (context?.id === state.projectContext?.id || (!context && !state.projectContext)) return state;
      return { ...state, projectContext: context, projectId: null };
    }

    case WORKER_ACTIONS.SET_COMPOSER_DRAFT:
      if (typeof action.value !== "string") return state;
      return { ...state, composerDraft: action.value };

    case WORKER_ACTIONS.SEND_MESSAGE: {
      const content = String(action.content ?? state.composerDraft).trim();
      if (!content) return state;
      return {
        ...state,
        status: state.status === WORKER_STATUS.READY ? WORKER_STATUS.DRAFTING : state.status,
        messages: [
          ...state.messages,
          { id: `worker-message-${state.nextMessageSeq}`, role: "user", content },
        ],
        nextMessageSeq: state.nextMessageSeq + 1,
        composerDraft: "",
      };
    }

    case WORKER_ACTIONS.SET_DRAFT_BUFFER:
      if (typeof action.value !== "string" || action.value === state.draftBuffer) return state;
      return {
        ...state,
        status: WORKER_STATUS.DRAFTING,
        draftBuffer: action.value,
        draftDirty: true,
        deliveryProposal: invalidateProposal(state.deliveryProposal),
      };

    case WORKER_ACTIONS.START_DRAFT_EDIT:
      if (state.draftDirty) return state;
      return {
        ...state,
        status: WORKER_STATUS.DRAFTING,
        draftDirty: true,
        deliveryProposal: invalidateProposal(state.deliveryProposal),
      };

    case WORKER_ACTIONS.SAVE_DRAFT: {
      if ((!state.draftDirty && action.force !== true) || !state.draftBuffer.trim()) return state;
      const revision = action.revision && typeof action.revision.id === "string"
        ? { ...action.revision, content: state.draftBuffer }
        : createLocalRevision(state.draftRevision, state.draftBuffer, action);
      return {
        ...state,
        status: WORKER_STATUS.DRAFTING,
        draftRevision: revision,
        draftBuffer: revision.content,
        draftDirty: false,
        deliveryProposal: invalidateProposal(state.deliveryProposal, "草稿已保存为新版本"),
      };
    }

    case WORKER_ACTIONS.REPLACE_DRAFT_REVISION:
      if (!action.revision || typeof action.revision.id !== "string") return state;
      return {
        ...state,
        status: WORKER_STATUS.DRAFTING,
        draftRevision: { ...action.revision },
        draftBuffer: String(action.revision.content ?? ""),
        draftDirty: false,
        deliveryProposal: invalidateProposal(state.deliveryProposal, "草稿版本已更新"),
      };

    case WORKER_ACTIONS.SET_DELIVERY_PROPOSAL: {
      const proposal = action.proposal;
      if (!proposal || typeof proposal.id !== "string") return state;
      const prepared = proposal.status === DELIVERY_STATUS.PREPARED
        && proposal.draftRevisionId === state.draftRevision.id
        && proposal.draftHash === state.draftRevision.contentHash;
      return {
        ...state,
        status: prepared ? WORKER_STATUS.AWAITING_CONFIRMATION : WORKER_STATUS.DRAFTING,
        activeArtifactId: WORKER_ARTIFACTS.DELIVERY,
        deliveryProposal: prepared
          ? { ...proposal }
          : invalidateProposal(proposal, "交付提案未绑定当前草稿版本"),
      };
    }

    case WORKER_ACTIONS.CONFIRM_DELIVERY: {
      const input = createDeliveryConfirmationInput(state);
      if (!input) return state;
      if (action.proposalHash !== input.proposalHash) return state;
      if (action.draftRevisionId !== input.draftRevisionId) return state;
      return {
        ...state,
        status: WORKER_STATUS.DELIVERING,
        deliveryProposal: {
          ...state.deliveryProposal,
          status: DELIVERY_STATUS.CONFIRMING,
        },
      };
    }

    case WORKER_ACTIONS.ABANDON_DELIVERY:
      if (!state.deliveryProposal || action.actionId !== state.deliveryProposal.id) return state;
      return {
        ...state,
        status: WORKER_STATUS.DRAFTING,
        deliveryProposal: {
          ...state.deliveryProposal,
          status: DELIVERY_STATUS.ABANDONED,
          nativeConfirmationPrepared: false,
        },
      };

    case WORKER_ACTIONS.SET_RECEIPT: {
      if (!action.receipt || typeof action.receipt.id !== "string") return state;
      const receiptStatus = action.receipt.status;
      const status = receiptStatus === "manual_resolved"
        ? WORKER_STATUS.READY
        : receiptStatus === "unknown"
        ? WORKER_STATUS.UNKNOWN
        : receiptStatus === "failed"
          ? WORKER_STATUS.BLOCKED
          : WORKER_STATUS.COMPLETED;
      const proposalStatus = receiptStatus === "manual_resolved"
        ? DELIVERY_STATUS.ABANDONED
        : DELIVERY_STATUS_VALUES.has(action.receipt.proposalStatus)
        ? action.receipt.proposalStatus
        : receiptStatus === "unknown"
          ? DELIVERY_STATUS.UNKNOWN
          : receiptStatus === "failed"
            ? DELIVERY_STATUS.FAILED
            : DELIVERY_STATUS.COMPLETED;
      return {
        ...state,
        status,
        activeArtifactId: WORKER_ARTIFACTS.RECEIPT,
        receipt: { ...action.receipt },
        deliveryProposal: state.deliveryProposal
          ? { ...state.deliveryProposal, status: proposalStatus }
          : null,
      };
    }

    default:
      return STATUS_VALUES.has(state.status) ? state : { ...state, status: WORKER_STATUS.READY };
  }
}
