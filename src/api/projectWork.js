const PROJECT_WORK_API_ROOT = "/api/v1/project-work";
const PROJECT_WORK_CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
export const MAX_PROJECT_WORK_IMAGE_BYTES = 5 * 1024 * 1024;
export const PROJECT_WORK_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function pick(value, snakeKey, camelKey, fallback = null) {
  if (!value || typeof value !== "object") return fallback;
  if (value[snakeKey] !== undefined) return value[snakeKey];
  if (camelKey && value[camelKey] !== undefined) return value[camelKey];
  return fallback;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function requiredId(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} 必须是非空字符串`);
  }
  return value;
}

function createRequestId(prefix) {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `${prefix}:${uuid ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 32 * 1024;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return globalThis.btoa(binary);
}

export function validateProjectWorkImageFile(file) {
  if (
    !file
    || typeof file.name !== "string"
    || typeof file.type !== "string"
    || !PROJECT_WORK_IMAGE_TYPES.has(file.type)
    || !Number.isSafeInteger(file.size)
    || file.size < 1
  ) {
    throw new TypeError("请选择 PNG、JPEG 或 WebP 图片");
  }
  if (file.size > MAX_PROJECT_WORK_IMAGE_BYTES) {
    throw new TypeError("图片不能超过 5 MB");
  }
  return file;
}

export async function serializeProjectWorkImage(file) {
  validateProjectWorkImageFile(file);
  if (typeof file.arrayBuffer !== "function") {
    throw new TypeError("当前环境无法读取所选图片");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length !== file.size) {
    throw new TypeError("图片读取不完整，请重新选择");
  }
  return {
    file_name: file.name,
    mime_type: file.type,
    byte_length: file.size,
    data: bytesToBase64(bytes),
  };
}

function mapApiError(response, body, fallback) {
  const error = new Error(body?.error?.message || fallback);
  error.name = "ProjectWorkApiError";
  error.code = body?.error?.code || "PROJECT_WORK_REQUEST_FAILED";
  error.retryable = Boolean(body?.error?.retryable);
  error.status = response.status;
  error.details = body?.error?.details ?? null;
  return error;
}

async function requestJson(path, {
  method = "GET",
  body,
  signal,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("当前环境不支持 fetch");
  }
  const response = await fetchImpl(path, {
    method,
    signal,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let payload = null;
  if (response.status !== 204) {
    try {
      payload = await response.json();
    } catch {
      if (!response.ok) throw mapApiError(response, null, "项目工作请求失败");
      const error = new Error("项目工作服务返回了无效 JSON");
      error.name = "ProjectWorkApiError";
      error.code = "PROJECT_WORK_RESPONSE_INVALID";
      error.retryable = true;
      error.status = response.status;
      throw error;
    }
  }
  if (!response.ok) throw mapApiError(response, payload, "项目工作请求失败");
  return payload;
}

async function requestPdfContent(path, file, {
  signal,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("当前环境不支持 fetch");
  }
  const response = await fetchImpl(path, {
    method: "PUT",
    signal,
    headers: { "content-type": "application/pdf" },
    body: file,
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    if (!response.ok) throw mapApiError(response, null, "论文资料上传失败");
    const error = new Error("项目工作服务返回了无效 JSON");
    error.name = "ProjectWorkApiError";
    error.code = "PROJECT_WORK_RESPONSE_INVALID";
    error.retryable = true;
    error.status = response.status;
    throw error;
  }
  if (!response.ok) throw mapApiError(response, payload, "论文资料上传失败");
  return payload;
}

function mapProject(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = pick(raw, "project_id", "projectId", raw.id);
  if (typeof id !== "string" || !id) return null;
  return {
    id,
    name: pick(raw, "name", "name", "未命名项目"),
    rootId: pick(raw, "root_id", "rootId"),
    rootLabel: pick(raw, "root_label", "rootLabel", "本地项目"),
    workspaceKinds: asArray(pick(raw, "workspace_kinds", "workspaceKinds", [])),
    capabilities: pick(raw, "capabilities", "capabilities", {}),
    availability: pick(raw, "availability", "availability", "available"),
    conversationCount: Number(pick(raw, "conversation_count", "conversationCount", 0)) || 0,
    updatedAt: pick(raw, "updated_at", "updatedAt"),
  };
}

function mapModel(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = pick(raw, "model_id", "modelId", raw.id);
  if (typeof id !== "string" || !id) return null;
  const contextWindow = Number(pick(raw, "context_window", "contextWindow"));
  return {
    id,
    name: pick(raw, "name", "name", id),
    contextWindow: Number.isFinite(contextWindow) && contextWindow > 0
      ? contextWindow
      : null,
    supportsThinking: Boolean(
      pick(raw, "supports_thinking", "supportsThinking", false),
    ),
    supportsImages: Boolean(
      pick(raw, "supports_images", "supportsImages", false),
    ),
    thinkingLevels: asArray(
      pick(raw, "thinking_levels", "thinkingLevels", []),
    ).filter((level) => typeof level === "string" && level),
    defaultThinkingLevel: pick(
      raw,
      "default_thinking_level",
      "defaultThinkingLevel",
    ),
  };
}

function mapProvider(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = pick(raw, "provider_id", "providerId", raw.id);
  if (typeof id !== "string" || !id) return null;
  return {
    id,
    name: pick(raw, "name", "name", id),
    models: asArray(raw.models).map(mapModel).filter(Boolean),
    available: pick(raw, "available", "available", true) !== false,
    status: pick(raw, "status", "status", "available"),
    reasonCode: pick(raw, "reason_code", "reasonCode"),
    hint: pick(raw, "hint", "hint", ""),
  };
}

function mapTurnUsage(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const inputTokens = nullableNumber(raw, "input_tokens", "inputTokens");
  const outputTokens = nullableNumber(raw, "output_tokens", "outputTokens");
  const cacheReadTokens = nullableNumber(
    raw,
    "cache_read_tokens",
    "cacheReadTokens",
  );
  const cacheWriteTokens = nullableNumber(
    raw,
    "cache_write_tokens",
    "cacheWriteTokens",
  );
  const totalTokens = nullableNumber(raw, "total_tokens", "totalTokens");
  const costUsd = nullableNumber(raw, "cost_usd", "costUsd")
    ?? (typeof raw.cost === "number" && Number.isFinite(raw.cost)
      ? raw.cost
      : nullableNumber(raw?.cost, "total", "total"));
  if (totalTokens === null && costUsd === null) return null;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    costUsd,
  };
}

function mapTurnEvidence(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const providerId = pick(raw, "provider_id", "providerId");
  const modelId = pick(raw, "model_id", "modelId");
  const thinkingLevel = pick(raw, "thinking_level", "thinkingLevel");
  const usage = mapTurnUsage(raw.usage);
  const contextUsage = mapContextUsage(
    pick(raw, "context_usage", "contextUsage"),
  );
  if (!providerId && !modelId && !thinkingLevel && !usage && !contextUsage) {
    return null;
  }
  return {
    providerId,
    modelId,
    thinkingLevel,
    usage,
    contextUsage,
    capturedAt: pick(raw, "captured_at", "capturedAt"),
  };
}

function mapConversationOperation(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = pick(raw, "operation_id", "operationId", raw.id);
  if (typeof id !== "string" || !id) return null;
  return {
    id,
    clientRequestId: pick(raw, "client_request_id", "clientRequestId"),
    type: pick(raw, "type", "type", "settlement"),
    status: pick(raw, "status", "status", "failed"),
    turnId: pick(raw, "turn_id", "turnId"),
    targetAssistantMessageId: pick(
      raw,
      "target_assistant_message_id",
      "targetAssistantMessageId",
    ),
    resultAssistantMessageId: pick(
      raw,
      "result_assistant_message_id",
      "resultAssistantMessageId",
    ),
    phase: pick(raw, "phase", "phase"),
    commandId: pick(raw, "command_id", "commandId"),
    commandBindingHash: pick(
      raw,
      "command_binding_hash",
      "commandBindingHash",
    ),
    repairAttemptCount: Number(
      pick(raw, "repair_attempt_count", "repairAttemptCount", 0),
    ) || 0,
    maxRepairAttempts: nullableNumber(
      raw,
      "max_repair_attempts",
      "maxRepairAttempts",
    ),
    validationAttemptIds: asArray(
      pick(raw, "validation_attempt_ids", "validationAttemptIds", []),
    ).filter((id) => typeof id === "string" && id),
    lastFailedAttemptId: pick(
      raw,
      "last_failed_attempt_id",
      "lastFailedAttemptId",
    ),
    resumeStatus: pick(raw, "resume_status", "resumeStatus", "idle"),
    error: pick(raw, "error", "error"),
    startedAt: pick(raw, "started_at", "startedAt"),
    completedAt: pick(raw, "completed_at", "completedAt"),
  };
}

function mapMessage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = pick(raw, "message_id", "messageId", raw.id);
  if (typeof id !== "string" || !id) return null;
  return {
    id,
    role: raw.role === "user" ? "user" : "assistant",
    kind: pick(raw, "kind", "kind", "message"),
    content: raw.content ?? raw.text ?? "",
    images: asArray(raw.images).map((image) => ({
      id: pick(image, "image_id", "imageId", image?.id),
      fileName: pick(image, "file_name", "fileName", "图片"),
      mimeType: pick(image, "mime_type", "mimeType"),
      byteLength: Number(pick(image, "byte_length", "byteLength", 0)) || 0,
    })),
    workflowId: pick(raw, "workflow_id", "workflowId"),
    capabilities: asArray(raw.capabilities).filter(
      (capability) => typeof capability === "string" && capability,
    ),
    providerId: pick(raw, "provider_id", "providerId"),
    modelId: pick(raw, "model_id", "modelId"),
    thinkingLevel: pick(raw, "thinking_level", "thinkingLevel"),
    messageSeq: nullableNumber(raw, "message_seq", "messageSeq"),
    turnId: pick(raw, "turn_id", "turnId"),
    turnSeq: nullableNumber(raw, "turn_seq", "turnSeq"),
    attempt: nullableNumber(raw, "attempt", "attempt"),
    isFinal: pick(raw, "is_final", "isFinal", true) !== false,
    retryOperationId: pick(
      raw,
      "retry_operation_id",
      "retryOperationId",
    ),
    verificationRepairOperationId: pick(
      raw,
      "verification_repair_operation_id",
      "verificationRepairOperationId",
    ),
    repairAttempt: nullableNumber(raw, "repair_attempt", "repairAttempt"),
    turnEvidence: mapTurnEvidence(
      pick(raw, "turn_evidence", "turnEvidence"),
    ),
    createdAt: pick(raw, "created_at", "createdAt"),
    status: pick(raw, "status", "status", "completed"),
  };
}

function mapConversationTurn(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = pick(raw, "turn_id", "turnId", raw.id);
  const turnSeq = Number(pick(raw, "turn_seq", "turnSeq"));
  if (typeof id !== "string" || !id || !Number.isSafeInteger(turnSeq)) {
    return null;
  }
  return {
    id,
    turnSeq,
    status: pick(raw, "status", "status", "completed"),
    messages: asArray(raw.messages).map(mapMessage).filter(Boolean),
    assistantAttemptCount: Number(
      pick(raw, "assistant_attempt_count", "assistantAttemptCount", 0),
    ) || 0,
    latestAssistantMessageId: pick(
      raw,
      "latest_assistant_message_id",
      "latestAssistantMessageId",
    ),
    turnEvidence: mapTurnEvidence(
      pick(raw, "turn_evidence", "turnEvidence"),
    ),
    operations: asArray(raw.operations)
      .map(mapConversationOperation)
      .filter(Boolean),
    createdAt: pick(raw, "created_at", "createdAt"),
    updatedAt: pick(raw, "updated_at", "updatedAt"),
  };
}

function mapFollowUpItem(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = pick(raw, "follow_up_id", "followUpId", raw.id);
  if (typeof id !== "string" || !id) return null;
  return {
    id,
    messageId: pick(raw, "message_id", "messageId"),
    text: typeof raw.text === "string" ? raw.text : "",
    status: pick(raw, "status", "status", "queued"),
    createdAt: pick(raw, "created_at", "createdAt"),
    deliveredAt: pick(raw, "delivered_at", "deliveredAt"),
    cancelledAt: pick(raw, "cancelled_at", "cancelledAt"),
    failedAt: pick(raw, "failed_at", "failedAt"),
  };
}

function mapAskUserQuestion(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = pick(raw, "question_id", "questionId", raw.id);
  if (typeof id !== "string" || !id) return null;
  const kind = pick(raw, "kind", "kind", "text");
  return {
    id,
    label: pick(raw, "label", "label", ""),
    prompt: pick(raw, "prompt", "prompt", ""),
    kind: ["single_choice", "multiple_choice"].includes(kind) ? kind : "text",
    required: pick(raw, "required", "required", true) !== false,
    options: asArray(raw.options).flatMap((option) => {
      if (!option || typeof option !== "object" || Array.isArray(option)) return [];
      const optionId = pick(option, "option_id", "optionId", option.id);
      if (typeof optionId !== "string" || !optionId) return [];
      return [{
        id: optionId,
        label: pick(option, "label", "label", optionId),
        description: pick(option, "description", "description", ""),
      }];
    }),
  };
}

function mapAskUserRequest(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = pick(raw, "request_id", "requestId", raw.id);
  if (typeof id !== "string" || !id) return null;
  return {
    id,
    status: pick(raw, "status", "status", "pending"),
    questions: asArray(raw.questions).map(mapAskUserQuestion).filter(Boolean),
    answers: asArray(raw.answers).flatMap((answer) => {
      if (!answer || typeof answer !== "object" || Array.isArray(answer)) return [];
      const questionId = pick(answer, "question_id", "questionId");
      if (typeof questionId !== "string" || !questionId) return [];
      return [{
        questionId,
        value: Array.isArray(answer.value)
          ? answer.value.map(String)
          : String(answer.value ?? ""),
      }];
    }),
    source: pick(raw, "source", "source", "project_api"),
    resumeStatus: pick(raw, "resume_status", "resumeStatus", "idle"),
    createdAt: pick(raw, "created_at", "createdAt"),
    answeredAt: pick(raw, "answered_at", "answeredAt"),
    cancelledAt: pick(raw, "cancelled_at", "cancelledAt"),
  };
}

function mapPlanStep(raw, index) {
  if (!raw || typeof raw !== "object") return null;
  return {
    id: pick(raw, "step_id", "stepId", raw.id ?? `step-${index + 1}`),
    title: pick(raw, "title", "title", `步骤 ${index + 1}`),
    detail: pick(raw, "detail", "detail", ""),
    status: pick(raw, "status", "status", "pending"),
  };
}

function mapEvent(raw) {
  if (!raw || typeof raw !== "object") return null;
  const seq = Number(raw.seq);
  if (!Number.isSafeInteger(seq) || seq < 1) return null;
  const data = raw.data && typeof raw.data === "object" && !Array.isArray(raw.data)
    ? raw.data
    : {};
  return {
    ...raw,
    seq,
    type: pick(raw, "type", "type", pick(raw, "kind", "kind", "activity")),
    eventId: pick(raw, "event_id", "eventId", data.id ?? null),
    title: pick(raw, "title", "title", data.title ?? null),
    detail: pick(
      raw,
      "detail",
      "detail",
      pick(
        raw,
        "summary",
        "summary",
        data.detail ?? data.summary ?? data.delta ?? "",
      ),
    ),
    status: pick(raw, "status", "status", data.status ?? null),
    toolName: pick(raw, "tool_name", "toolName", data.name ?? null),
    toolCallId: pick(
      raw,
      "tool_call_id",
      "toolCallId",
      data.callId ?? data.toolCallId ?? data.id ?? null,
    ),
    artifactId: pick(raw, "artifact_id", "artifactId", data.artifactId ?? null),
    path: pick(raw, "path", "path", data.path ?? null),
    providerId: pick(
      raw,
      "provider_id",
      "providerId",
      pick(data, "provider_id", "providerId"),
    ),
    modelId: pick(
      raw,
      "model_id",
      "modelId",
      pick(data, "model_id", "modelId"),
    ),
    thinkingLevel: pick(
      raw,
      "thinking_level",
      "thinkingLevel",
      pick(data, "thinking_level", "thinkingLevel"),
    ),
    workflowId: pick(
      raw,
      "workflow_id",
      "workflowId",
      pick(data, "workflow_id", "workflowId"),
    ),
    capabilities: asArray(
      pick(raw, "capabilities", "capabilities", data.capabilities),
    ).filter((capability) => typeof capability === "string" && capability),
    decision: pick(raw, "decision", "decision", data.decision ?? null),
    reasonCode: pick(
      raw,
      "reason_code",
      "reasonCode",
      pick(data, "reason_code", "reasonCode"),
    ),
    createdAt: pick(raw, "created_at", "createdAt", pick(raw, "at", "at")),
  };
}

function mapWorkspaceSnapshot(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const includedFiles = Number(pick(raw, "included_files", "includedFiles"));
  const includedBytes = Number(pick(raw, "included_bytes", "includedBytes"));
  return {
    mode: pick(raw, "mode", "mode", null),
    includedFiles: Number.isSafeInteger(includedFiles) && includedFiles >= 0
      ? includedFiles
      : null,
    includedBytes: Number.isSafeInteger(includedBytes) && includedBytes >= 0
      ? includedBytes
      : null,
    truncated: pick(raw, "truncated", "truncated", false) === true,
  };
}

function safeProjectRelativePath(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = value.trim().replaceAll("\\", "/");
  if (
    normalized.startsWith("/")
    || /^[a-zA-Z]:\//.test(normalized)
    || normalized.split("/").some((segment) => segment === "..")
  ) {
    return null;
  }
  return normalized.split("/").filter((segment) => segment && segment !== ".").join("/") || null;
}

export function mapProjectWorkWorkspace(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const revision = Number(pick(raw, "revision", "revision", 1));
  return {
    id: pick(raw, "workspace_id", "workspaceId", raw.id ?? null),
    kind: pick(raw, "kind", "kind", "sparse_overlay"),
    isolation: pick(raw, "isolation", "isolation", "review_overlay"),
    recoverableIsolation: pick(
      raw,
      "recoverable_isolation",
      "recoverableIsolation",
      false,
    ) === true,
    automaticApplyAllowed: pick(
      raw,
      "automatic_apply_allowed",
      "automaticApplyAllowed",
      false,
    ) === true,
    status: pick(raw, "status", "status", "ready"),
    revision: Number.isSafeInteger(revision) && revision > 0 ? revision : 1,
    createdAt: pick(raw, "created_at", "createdAt"),
    updatedAt: pick(raw, "updated_at", "updatedAt"),
  };
}

function mapApplyJournalFile(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const path = safeProjectRelativePath(pick(raw, "path", "path"));
  if (!path) return null;
  return {
    id: pick(raw, "file_id", "fileId", path),
    path,
    baseHash: pick(raw, "base_hash", "baseHash"),
    afterHash: pick(raw, "after_hash", "afterHash"),
  };
}

export function mapProjectWorkApplyJournal(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = pick(raw, "apply_id", "applyId", raw.id);
  if (typeof id !== "string" || !id) return null;
  const undo = raw.undo && typeof raw.undo === "object" && !Array.isArray(raw.undo)
    ? raw.undo
    : {};
  return {
    id,
    status: pick(raw, "status", "status", "recovery_blocked"),
    changeSetId: pick(raw, "change_set_id", "changeSetId"),
    changeSetHash: pick(raw, "change_set_hash", "changeSetHash"),
    files: asArray(raw.files).map(mapApplyJournalFile).filter(Boolean),
    createdAt: pick(raw, "created_at", "createdAt"),
    appliedAt: pick(raw, "applied_at", "appliedAt"),
    finalizedAt: pick(raw, "finalized_at", "finalizedAt"),
    recoveredAt: pick(raw, "recovered_at", "recoveredAt"),
    undoneAt: pick(raw, "undone_at", "undoneAt"),
    error: pick(raw, "error", "error"),
    undo: {
      status: pick(undo, "status", "status", "unavailable"),
      hash: pick(undo, "hash", "hash"),
      usedAt: pick(undo, "used_at", "usedAt"),
    },
  };
}

export function mapProjectWorkGitEvidence(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      available: false,
      branch: null,
      head: null,
      staged: [],
      unstaged: [],
      untracked: [],
      truncated: false,
      reason: "unavailable",
    };
  }
  const paths = (key) => asArray(raw[key]).map(safeProjectRelativePath).filter(Boolean);
  return {
    available: raw.available === true,
    branch: typeof raw.branch === "string" && raw.branch ? raw.branch : null,
    head: typeof raw.head === "string" && raw.head ? raw.head : null,
    staged: paths("staged"),
    unstaged: paths("unstaged"),
    untracked: paths("untracked"),
    truncated: raw.truncated === true,
    reason: typeof raw.reason === "string" ? raw.reason : null,
  };
}

function nullableNumber(raw, snakeKey, camelKey) {
  const value = pick(raw, snakeKey, camelKey);
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function mapContextUsage(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const contextWindow = nullableNumber(raw, "context_window", "contextWindow");
  return {
    tokens: nullableNumber(raw, "tokens", "tokens"),
    contextWindow: contextWindow > 0 ? contextWindow : null,
    percent: nullableNumber(raw, "percent", "percent"),
    status: pick(raw, "status", "status", "awaiting_measurement"),
    updatedAt: pick(raw, "updated_at", "updatedAt"),
  };
}

function mapExecutionPolicy(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw
    : {};
  const revision = Number(pick(source, "revision", "revision", 0));
  const policyVersion = Number(
    pick(source, "policy_version", "policyVersion", 1),
  );
  return {
    mode: pick(source, "mode", "mode") === "auto_review"
      ? "auto_review"
      : "manual_review",
    revision: Number.isSafeInteger(revision) && revision >= 0 ? revision : 0,
    policyVersion: Number.isSafeInteger(policyVersion) && policyVersion >= 1
      ? policyVersion
      : 1,
  };
}

function mapCompaction(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return {
    autoEnabled: pick(raw, "auto_enabled", "autoEnabled", true) !== false,
    status: pick(raw, "status", "status", "idle"),
    reason: pick(raw, "reason", "reason", pick(raw, "trigger", "trigger")),
    tokensBefore: nullableNumber(raw, "tokens_before", "tokensBefore"),
    estimatedTokensAfter: nullableNumber(
      raw,
      "estimated_tokens_after",
      "estimatedTokensAfter",
    ),
    willRetry: pick(raw, "will_retry", "willRetry", false) === true,
    completedAt: pick(
      raw,
      "completed_at",
      "completedAt",
      pick(raw, "last_completed_at", "lastCompletedAt"),
    ),
  };
}

function mapChangeFile(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = pick(raw, "file_id", "fileId", raw.id);
  if (typeof id !== "string" || !id) return null;
  const rawDiff = pick(raw, "diff", "diff", []);
  return {
    id,
    path: pick(raw, "path", "path", id),
    operation: pick(raw, "operation", "operation", "update"),
    additions: Number(pick(raw, "additions", "additions", 0)) || 0,
    deletions: Number(pick(raw, "deletions", "deletions", 0)) || 0,
    diff: Array.isArray(rawDiff)
      ? rawDiff.map(String)
      : typeof rawDiff === "string"
        ? rawDiff.split("\n")
        : [],
    baseHash: pick(raw, "base_hash", "baseHash"),
    afterHash: pick(raw, "after_hash", "afterHash"),
    selected: pick(raw, "selected", "selected", true) !== false,
    actionable: pick(raw, "actionable", "actionable", true) !== false,
    status: pick(raw, "status", "status", "pending"),
  };
}

function mapChangeSet(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = pick(raw, "change_set_id", "changeSetId", raw.id);
  if (typeof id !== "string" || !id) return null;
  return {
    id,
    title: pick(raw, "title", "title", "项目修改"),
    status: pick(raw, "status", "status", "pending"),
    proposalHash: pick(raw, "proposal_hash", "proposalHash", raw.hash ?? null),
    baseHash: pick(raw, "base_hash", "baseHash"),
    afterHash: pick(raw, "after_hash", "afterHash"),
    files: asArray(raw.files).map(mapChangeFile).filter(Boolean),
    receipt: pick(raw, "receipt", "receipt"),
    error: pick(raw, "last_error", "lastError"),
    blockedReason: pick(raw, "blocked_reason", "blockedReason"),
    blockedAt: pick(raw, "blocked_at", "blockedAt"),
    appliedAt: pick(raw, "applied_at", "appliedAt"),
    createdAt: pick(raw, "created_at", "createdAt"),
    updatedAt: pick(raw, "updated_at", "updatedAt"),
  };
}

function mapVerificationCommand(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = pick(raw, "command_id", "commandId", raw.id);
  if (typeof id !== "string" || !id) return null;
  const argv = asArray(pick(raw, "argv", "argv", raw.args)).map(String);
  return {
    id,
    label: pick(raw, "label", "label", "运行验证"),
    executable: pick(raw, "executable", "executable", argv[0] ?? ""),
    args: asArray(pick(raw, "args", "args", argv.slice(1))).map(String),
    displayCommand: pick(
      raw,
      "display_command",
      "displayCommand",
      [pick(raw, "executable", "executable", argv[0]), ...asArray(raw.args ?? argv.slice(1))]
        .filter(Boolean)
        .join(" "),
    ),
    cwdLabel: pick(raw, "cwd_label", "cwdLabel", "."),
    resolvedScript: pick(raw, "resolved_script", "resolvedScript"),
    status: pick(raw, "status", "status", "saved"),
  };
}

function mapVerificationRun(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = pick(raw, "run_id", "runId", raw.id);
  if (typeof id !== "string" || !id) return null;
  const command = raw.command && typeof raw.command === "object" ? raw.command : null;
  const output = raw.output;
  return {
    id,
    commandId: pick(raw, "command_id", "commandId"),
    command: pick(
      raw,
      "display_command",
      "displayCommand",
      command
        ? [command.file, ...asArray(command.args)].filter(Boolean).join(" ")
        : typeof raw.command === "string"
          ? raw.command
          : "",
    ),
    commandSpec: command
      ? {
          file: command.file ?? "",
          args: asArray(command.args).map(String),
          cwd: command.cwd ?? ".",
        }
      : null,
    resolvedScript: pick(raw, "resolved_script", "resolvedScript"),
    status: pick(raw, "status", "status", "unknown"),
    blockedReason: pick(raw, "blocked_reason", "blockedReason"),
    exitCode: pick(raw, "exit_code", "exitCode"),
    signal: pick(raw, "signal", "signal"),
    durationMs: pick(raw, "duration_ms", "durationMs"),
    summary: pick(raw, "summary", "summary", ""),
    checks: asArray(raw.checks).map((check, index) => (
      typeof check === "string"
        ? {
            id: `check-${index + 1}`,
            label: check,
            status: ["passed", "succeeded", "completed"].includes(raw.status)
              ? "passed"
              : ["failed", "timed_out", "aborted", "interrupted"].includes(raw.status)
                ? "failed"
                : "pending",
          }
        : {
            id: pick(check, "check_id", "checkId", check?.id ?? `check-${index + 1}`),
            label: pick(check, "label", "label", `检查 ${index + 1}`),
            status: pick(check, "status", "status", "unknown"),
          }
    )),
    logs: Array.isArray(raw.logs)
      ? raw.logs.map(String)
      : Array.isArray(output)
        ? output.map(String)
        : typeof output === "string"
          ? output.split(/\r?\n/)
          : [],
    stdout: typeof raw.stdout === "string" ? raw.stdout : "",
    stderr: typeof raw.stderr === "string" ? raw.stderr : "",
    truncated: Boolean(raw.truncated),
    startedAt: pick(raw, "started_at", "startedAt"),
    completedAt: pick(raw, "completed_at", "completedAt"),
  };
}

function mapTreeEntries(entries, parentPath = "", inferredDepth = 0) {
  return asArray(entries).flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const name = pick(entry, "name", "name", "");
    const explicitPath = pick(entry, "path", "path", "");
    const entryPath = safeProjectRelativePath(
      explicitPath || [parentPath, name].filter(Boolean).join("/"),
    );
    if (!entryPath) return [];
    const rawKind = pick(entry, "kind", "kind", pick(entry, "type", "type", "file"));
    const normalizedKind = String(rawKind).toLowerCase();
    const kind = ["directory", "dir", "folder"].includes(normalizedKind)
      ? "directory"
      : normalizedKind === "file"
        ? "file"
        : "unsupported";
    if (kind === "unsupported") return [];
    const rawDepth = pick(entry, "depth", "depth");
    const explicitDepth = rawDepth === null || rawDepth === undefined || rawDepth === ""
      ? null
      : Number(rawDepth);
    const depth = Number.isFinite(explicitDepth) && explicitDepth >= 0
      ? explicitDepth
      : inferredDepth;
    const previewKind = pick(entry, "preview_kind", "previewKind");
    const mimeType = pick(entry, "mime_type", "mimeType");
    const overlay = pick(entry, "overlay", "overlay");
    const mapped = {
      id: entryPath,
      path: entryPath,
      name: name || entryPath.split("/").at(-1),
      kind,
      size: pick(entry, "size", "size", entry.byteLength ?? null),
      contentHash: pick(entry, "content_hash", "contentHash", entry.hash ?? null),
      depth,
      ...(previewKind ? { previewKind } : {}),
      ...(mimeType ? { mimeType } : {}),
      ...(overlay ? { overlay } : {}),
    };
    const children = mapTreeEntries(entry.children, entryPath, depth + 1);
    return [mapped, ...children];
  });
}

function mapProjectWorkDocumentError(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const message = String(
    pick(raw, "message", "message", "资料解析失败"),
  )
    .replaceAll(
      /MinerU(?: Cloud)?\s*解析\s*(?:这份\s*)?PDF/gi,
      "资料解析",
    )
    .replaceAll(/MinerU(?: Cloud)?/gi, "资料解析服务")
    .replaceAll(/PDF/gi, "资料文件")
    .replaceAll(/Markdown/gi, "正文");
  return {
    code: pick(raw, "code", "code", "PROJECT_WORK_DOCUMENT_FAILED"),
    message,
    retryable: pick(raw, "retryable", "retryable", false) === true,
  };
}

function mapProjectWorkDocument(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = pick(raw, "document_id", "documentId", raw.id);
  const fileName = pick(raw, "file_name", "fileName");
  if (typeof id !== "string" || !id || typeof fileName !== "string" || !fileName) {
    return null;
  }
  const byteLength = Number(pick(raw, "byte_length", "byteLength", 0));
  const rawBlockCount = pick(raw, "block_count", "blockCount");
  const rawImageCount = pick(raw, "image_count", "imageCount");
  const blockCount = rawBlockCount === null ? null : Number(rawBlockCount);
  const imageCount = rawImageCount === null ? null : Number(rawImageCount);
  return {
    id,
    fileName,
    byteLength: Number.isSafeInteger(byteLength) && byteLength >= 0
      ? byteLength
      : 0,
    status: pick(raw, "status", "status", "awaiting_upload"),
    parser: pick(raw, "parser", "parser", "MinerU Cloud v4"),
    parserState: pick(raw, "parser_state", "parserState"),
    sha256: pick(raw, "sha256", "sha256"),
    revision: pick(raw, "revision", "revision"),
    title: pick(raw, "title", "title"),
    blockCount: Number.isSafeInteger(blockCount) ? blockCount : null,
    imageCount: Number.isSafeInteger(imageCount) ? imageCount : null,
    error: mapProjectWorkDocumentError(pick(raw, "error", "error")),
    createdAt: pick(raw, "created_at", "createdAt"),
    updatedAt: pick(raw, "updated_at", "updatedAt"),
    readyAt: pick(raw, "ready_at", "readyAt"),
  };
}

export function mapProjectWorkConversation(raw) {
  const source = raw?.conversation && typeof raw.conversation === "object"
    ? raw.conversation
    : raw;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("项目工作会话格式无效");
  }
  const id = pick(source, "conversation_id", "conversationId", source.id);
  if (typeof id !== "string" || !id) throw new Error("项目工作会话缺少 ID");
  const events = asArray(raw?.events ?? source.events).map(mapEvent).filter(Boolean)
    .sort((left, right) => left.seq - right.seq);
  const changeSet = mapChangeSet(
    pick(
      source,
      "pending_change_set",
      "pendingChangeSet",
      source.activeChangeSet ?? source.change_set ?? source.changeSet,
    ),
  );
  const rawPendingChangeFileCount = pick(
    source,
    "pending_change_file_count",
    "pendingChangeFileCount",
  );
  const parsedPendingChangeFileCount = Number(rawPendingChangeFileCount);
  const pendingChangeFileCount = rawPendingChangeFileCount !== null
    && Number.isSafeInteger(parsedPendingChangeFileCount)
    && parsedPendingChangeFileCount >= 0
    ? parsedPendingChangeFileCount
    : changeSet?.files?.length ?? 0;
  const verificationRuns = asArray(
    pick(
      source,
      "verification_runs",
      "verificationRuns",
      source.verifications ?? source.test_runs ?? source.testRuns,
    ),
  ).map(mapVerificationRun).filter(Boolean);
  const explicitVerificationCommand = mapVerificationCommand(
    pick(
      source,
      "verification_command",
      "verificationCommand",
      source.saved_verification_command ?? source.savedVerificationCommand,
    ),
  );
  const savedVerification = verificationRuns.find((run) => (
    ["saved", "ready", "requested", "pending_approval", "proposed"].includes(run.status)
    && run.commandSpec?.file
  ));
  const verificationCommand = explicitVerificationCommand ?? (savedVerification
    ? {
        id: savedVerification.commandId ?? savedVerification.id,
        label: "运行验证",
        executable: savedVerification.commandSpec.file,
        args: savedVerification.commandSpec.args,
        displayCommand: savedVerification.command,
        cwdLabel: savedVerification.commandSpec.cwd,
        resolvedScript: savedVerification.resolvedScript,
        status: savedVerification.status,
      }
    : null);
  const rawPlan = pick(source, "plan", "plan");
  const planSteps = Array.isArray(rawPlan)
    ? rawPlan
    : asArray(rawPlan?.steps);
  const projectId = pick(source, "project_id", "projectId");
  const standalone = projectId === null;
  const lifecycle = pick(source, "lifecycle", "lifecycle", "idle");
  const unreadCount = Number(
    pick(source, "unread_count", "unreadCount", 0),
  );
  const latestMessageSeq = Number(
    pick(source, "latest_message_seq", "latestMessageSeq", 0),
  );
  const lastReadMessageSeq = Number(
    pick(source, "last_read_message_seq", "lastReadMessageSeq", 0),
  );
  const rawReadState = pick(source, "read_state", "readState", {});
  return {
    id,
    projectId,
    runtimeSchemaVersion: Number(
      pick(source, "runtime_schema_version", "runtimeSchemaVersion", 1),
    ) || 1,
    lifecycle: [
      "idle",
      "running",
      "awaiting_user",
      "awaiting_review",
      "verifying",
      "recovering",
      "stopped",
    ].includes(lifecycle)
      ? lifecycle
      : "idle",
    kind: pick(source, "kind", "kind", "project_work"),
    title: pick(source, "title", "title", "新会话"),
    rootLabel: pick(
      source,
      "root_label",
      "rootLabel",
      standalone ? "未连接文件夹" : "本地项目",
    ),
    workspaceKind: pick(
      source,
      "workspace_kind",
      "workspaceKind",
      standalone ? "scratch" : "bound_project",
    ),
    scope: pick(source, "scope", "scope", standalone ? "standalone" : "project"),
    providerId: pick(source, "provider_id", "providerId"),
    modelId: pick(source, "model_id", "modelId"),
    thinkingLevel: pick(source, "thinking_level", "thinkingLevel"),
    status: pick(source, "status", "status", "idle"),
    turnStatus: pick(source, "turn_status", "turnStatus"),
    activeTurnId: pick(source, "active_turn_id", "activeTurnId"),
    activeArtifactId: pick(source, "active_artifact_id", "activeArtifactId", "files"),
    messages: asArray(source.messages).map(mapMessage).filter(Boolean),
    hasMoreTurns: Boolean(
      pick(source, "has_more_turns", "hasMoreTurns", false),
    ),
    nextBeforeTurnSeq: (() => {
      const value = Number(
        pick(source, "next_before_turn_seq", "nextBeforeTurnSeq"),
      );
      return Number.isSafeInteger(value) && value > 0 ? value : null;
    })(),
    operations: asArray(source.operations)
      .map(mapConversationOperation)
      .filter(Boolean),
    unreadCount: Number.isSafeInteger(unreadCount) && unreadCount >= 0
      ? unreadCount
      : 0,
    latestMessageSeq: Number.isSafeInteger(latestMessageSeq)
      && latestMessageSeq >= 0
      ? latestMessageSeq
      : 0,
    lastReadMessageSeq: Number.isSafeInteger(lastReadMessageSeq)
      && lastReadMessageSeq >= 0
      ? lastReadMessageSeq
      : Number(
          pick(rawReadState, "last_read_message_seq", "lastReadMessageSeq", 0),
        ) || 0,
    readState: {
      lastReadMessageSeq: Number(
        pick(
          rawReadState,
          "last_read_message_seq",
          "lastReadMessageSeq",
          lastReadMessageSeq,
        ),
      ) || 0,
      latestMessageSeq: Number(
        pick(
          rawReadState,
          "latest_message_seq",
          "latestMessageSeq",
          latestMessageSeq,
        ),
      ) || 0,
      latestAssistantMessageSeq: Number(
        pick(
          rawReadState,
          "latest_assistant_message_seq",
          "latestAssistantMessageSeq",
          0,
        ),
      ) || 0,
      unreadCount: Number(
        pick(rawReadState, "unread_count", "unreadCount", unreadCount),
      ) || 0,
      readAt: pick(rawReadState, "read_at", "readAt"),
    },
    events,
    lastEventSeq: Number(
      pick(source, "last_event_seq", "lastEventSeq", events.at(-1)?.seq ?? 0),
    ) || 0,
    plan: planSteps.map((step, index) => mapPlanStep({
      ...step,
      title: step?.title ?? step?.text,
    }, index)).filter(Boolean),
    pendingChangeSet: changeSet,
    pendingChangeFileCount,
    verificationCommand,
    verificationRuns,
    workspaceSnapshot: mapWorkspaceSnapshot(
      pick(source, "workspace_snapshot", "workspaceSnapshot"),
    ),
    workspace: mapProjectWorkWorkspace(
      pick(source, "workspace", "workspace"),
    ),
    applyJournal: asArray(
      pick(source, "apply_journal", "applyJournal", []),
    ).map(mapProjectWorkApplyJournal).filter(Boolean),
    contextUsage: mapContextUsage(
      pick(source, "context_usage", "contextUsage"),
    ),
    executionPolicy: mapExecutionPolicy(
      pick(source, "execution_policy", "executionPolicy"),
    ),
    preview: pick(source, "preview", "preview"),
    compaction: mapCompaction(pick(source, "compaction", "compaction")),
    documents: asArray(source.documents).map(mapProjectWorkDocument).filter(Boolean),
    followUpQueue: asArray(
      pick(source, "follow_up_queue", "followUpQueue", []),
    ).map(mapFollowUpItem).filter(Boolean),
    askUserRequests: asArray(
      pick(source, "ask_user_requests", "askUserRequests", []),
    ).map(mapAskUserRequest).filter(Boolean),
    error: pick(source, "last_error", "lastError"),
    hasMoreEvents: Boolean(raw?.hasMoreEvents ?? raw?.has_more_events ?? source.hasMoreEvents),
    createdAt: pick(source, "created_at", "createdAt"),
    updatedAt: pick(source, "updated_at", "updatedAt"),
  };
}

export async function listProjectWorkProjects({ signal, fetchImpl } = {}) {
  const payload = await requestJson(`${PROJECT_WORK_API_ROOT}/projects`, { signal, fetchImpl });
  return asArray(payload?.projects).map(mapProject).filter(Boolean);
}

export async function fetchProjectWorkModels({ signal, fetchImpl } = {}) {
  const payload = await requestJson(`${PROJECT_WORK_API_ROOT}/models`, { signal, fetchImpl });
  return {
    providers: asArray(payload?.providers).map(mapProvider).filter(Boolean),
    defaultProviderId: pick(payload, "default_provider_id", "defaultProviderId"),
    defaultModelId: pick(payload, "default_model_id", "defaultModelId"),
    defaultThinkingLevel: pick(
      payload,
      "default_thinking_level",
      "defaultThinkingLevel",
    ),
    capabilities: pick(payload, "capabilities", "capabilities", {}),
  };
}

export async function pickProjectWorkRoot({
  purpose = "existing",
  signal,
  fetchImpl,
} = {}) {
  return requestJson(`${PROJECT_WORK_API_ROOT}/project-roots/pick`, {
    method: "POST",
    body: { schema_version: 1, purpose },
    signal,
    fetchImpl,
  });
}

export async function registerProjectWorkProject({
  rootToken,
  workspaceKind = "project_work",
  name,
  newFolderName,
  signal,
  fetchImpl,
} = {}) {
  requiredId(rootToken, "rootToken");
  const payload = await requestJson(`${PROJECT_WORK_API_ROOT}/projects`, {
    method: "POST",
    body: {
      schema_version: 1,
      root_token: rootToken,
      workspace_kind: workspaceKind,
      ...(typeof name === "string" && name.trim() ? { name: name.trim() } : {}),
      ...(typeof newFolderName === "string" && newFolderName.trim()
        ? { new_folder_name: newFolderName.trim() }
        : {}),
    },
    signal,
    fetchImpl,
  });
  return mapProject(payload?.project ?? payload);
}

export async function createProjectWorkConversation({
  projectId,
  providerId,
  modelId,
  thinkingLevel,
  signal,
  fetchImpl,
} = {}) {
  requiredId(projectId, "projectId");
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/projects/${encodeURIComponent(projectId)}/conversations`,
    {
      method: "POST",
      body: {
        schema_version: 1,
        ...(providerId ? { provider_id: providerId } : {}),
        ...(modelId ? { model_id: modelId } : {}),
        ...(thinkingLevel ? { thinking_level: thinkingLevel } : {}),
      },
      signal,
      fetchImpl,
    },
  );
  return mapProjectWorkConversation(payload);
}

export async function createStandaloneProjectWorkConversation({
  providerId,
  modelId,
  thinkingLevel,
  signal,
  fetchImpl,
} = {}) {
  const payload = await requestJson(`${PROJECT_WORK_API_ROOT}/conversations`, {
    method: "POST",
    body: {
      schema_version: 1,
      ...(providerId ? { provider_id: providerId } : {}),
      ...(modelId ? { model_id: modelId } : {}),
      ...(thinkingLevel ? { thinking_level: thinkingLevel } : {}),
    },
    signal,
    fetchImpl,
  });
  return mapProjectWorkConversation(payload);
}

export async function listProjectWorkConversations({
  projectId,
  signal,
  fetchImpl,
} = {}) {
  requiredId(projectId, "projectId");
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/projects/${encodeURIComponent(projectId)}/conversations`,
    { signal, fetchImpl },
  );
  return asArray(payload?.conversations).map((conversation) => (
    mapProjectWorkConversation({ conversation })
  ));
}

export async function listStandaloneProjectWorkConversations({
  signal,
  fetchImpl,
} = {}) {
  const payload = await requestJson(`${PROJECT_WORK_API_ROOT}/conversations`, {
    signal,
    fetchImpl,
  });
  return asArray(payload?.conversations).map((conversation) => (
    mapProjectWorkConversation({ conversation })
  ));
}

export async function deleteProjectWorkConversation({
  projectId,
  conversationId,
  signal,
  fetchImpl,
} = {}) {
  const standalone = projectId === null;
  if (!standalone) requiredId(projectId, "projectId");
  requiredId(conversationId, "conversationId");
  const path = standalone
    ? `${PROJECT_WORK_API_ROOT}/conversations/${encodeURIComponent(conversationId)}`
    : `${PROJECT_WORK_API_ROOT}/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}`;
  const payload = await requestJson(
    path,
    { method: "DELETE", signal, fetchImpl },
  );
  const count = Number(payload?.conversationCount ?? payload?.conversation_count);
  return {
    projectId: payload?.projectId ?? payload?.project_id ?? projectId,
    conversationId: payload?.conversationId ?? payload?.conversation_id ?? conversationId,
    removed: payload?.removed === true,
    conversationCount: Number.isSafeInteger(count) && count >= 0 ? count : null,
  };
}

export async function renameProjectWorkConversation({
  projectId,
  conversationId,
  title,
  signal,
  fetchImpl,
} = {}) {
  const standalone = projectId === null;
  if (!standalone) requiredId(projectId, "projectId");
  requiredId(conversationId, "conversationId");
  const normalizedTitle = typeof title === "string"
    ? title.trim().replace(/\s+/g, " ")
    : "";
  if (!normalizedTitle || normalizedTitle.length > 80) {
    throw new TypeError("title 必须是 1–80 个字符");
  }
  const path = standalone
    ? `${PROJECT_WORK_API_ROOT}/conversations/${encodeURIComponent(conversationId)}`
    : `${PROJECT_WORK_API_ROOT}/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}`;
  const payload = await requestJson(
    path,
    {
      method: "PATCH",
      body: {
        schema_version: 1,
        title: normalizedTitle,
      },
      signal,
      fetchImpl,
    },
  );
  return mapProjectWorkConversation(payload);
}

export async function removeProjectWorkProject({
  projectId,
  signal,
  fetchImpl,
} = {}) {
  requiredId(projectId, "projectId");
  await requestJson(
    `${PROJECT_WORK_API_ROOT}/projects/${encodeURIComponent(projectId)}`,
    { method: "DELETE", signal, fetchImpl },
  );
  return { projectId, removed: true, localFilesDeleted: false };
}

export async function fetchProjectWorkConversation({
  conversationId,
  signal,
  fetchImpl,
} = {}) {
  requiredId(conversationId, "conversationId");
  const basePath = `${PROJECT_WORK_API_ROOT}/conversations/${encodeURIComponent(conversationId)}`;
  let payload = await requestJson(basePath, { signal, fetchImpl });
  const events = [...asArray(payload?.events)];
  let afterSeq = Number(events.at(-1)?.seq) || 0;
  let pages = 1;
  while (
    (payload?.hasMoreEvents ?? payload?.has_more_events)
    && afterSeq > 0
    && pages < 20
  ) {
    const nextPayload = await requestJson(
      `${basePath}?after_seq=${encodeURIComponent(afterSeq)}&event_limit=500`,
      { signal, fetchImpl },
    );
    const nextEvents = asArray(nextPayload?.events);
    if (nextEvents.length === 0) break;
    events.push(...nextEvents);
    afterSeq = Number(nextEvents.at(-1)?.seq) || afterSeq;
    payload = nextPayload;
    pages += 1;
  }
  return mapProjectWorkConversation({
    ...payload,
    events,
    hasMoreEvents: Boolean(
      (payload?.hasMoreEvents ?? payload?.has_more_events) && pages >= 20,
    ),
  });
}

export function subscribeProjectWorkConversation({
  conversationId,
  afterSeq = 0,
  onConversation,
  onError,
  eventSourceFactory,
} = {}) {
  requiredId(conversationId, "conversationId");
  const EventSourceFactory = eventSourceFactory ?? globalThis.EventSource;
  if (typeof EventSourceFactory !== "function") return null;
  const normalizedAfter = Number.isSafeInteger(afterSeq) && afterSeq >= 0
    ? afterSeq
    : 0;
  const source = new EventSourceFactory(
    `${PROJECT_WORK_API_ROOT}/conversations/${encodeURIComponent(conversationId)}/events`
      + `?after_seq=${encodeURIComponent(normalizedAfter)}`,
  );
  const handleSnapshot = (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (!payload?.conversation) {
        throw new Error("项目工作事件缺少会话快照");
      }
      onConversation?.(mapProjectWorkConversation({
        conversation: payload.conversation,
        events: asArray(payload.events),
        hasMoreEvents: Boolean(payload.has_more ?? payload.hasMoreEvents),
      }), {
        events: asArray(payload.events),
        snapshotWatermark: Number(
          payload.snapshot_watermark ?? payload.snapshotWatermark ?? 0,
        ) || 0,
        lastSeq: Number(payload.last_seq ?? payload.lastSeq ?? 0) || 0,
      });
    } catch (error) {
      onError?.(error);
    }
  };
  const handleStreamError = (event) => {
    try {
      const payload = JSON.parse(event.data);
      const error = new Error(payload?.message || "项目工作事件流暂时中断");
      error.code = payload?.code || "PROJECT_WORK_EVENT_STREAM_FAILED";
      onError?.(error);
    } catch (error) {
      onError?.(error);
    }
  };
  const handleConnectionError = (event) => {
    onError?.(event instanceof Error
      ? event
      : new Error("项目工作事件流正在重新连接"));
  };
  source.addEventListener("snapshot", handleSnapshot);
  source.addEventListener("stream_error", handleStreamError);
  source.addEventListener("error", handleConnectionError);
  return () => {
    source.removeEventListener?.("snapshot", handleSnapshot);
    source.removeEventListener?.("stream_error", handleStreamError);
    source.removeEventListener?.("error", handleConnectionError);
    source.close();
  };
}

export async function sendProjectWorkMessage({
  conversationId,
  text,
  contexts = [],
  images = [],
  capabilities = [],
  workflowId,
  providerId,
  modelId,
  thinkingLevel,
  clientRequestId = createRequestId("project-message"),
  signal,
  fetchImpl,
} = {}) {
  requiredId(conversationId, "conversationId");
  const requestId = requiredId(clientRequestId, "clientRequestId").trim();
  if (typeof text !== "string" || !text.trim()) throw new TypeError("text 必须是非空字符串");
  if (!Array.isArray(images) || images.length > 1) {
    throw new TypeError("每条消息最多添加一张图片");
  }
  const serializedImages = await Promise.all(images.map(serializeProjectWorkImage));
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/conversations/${encodeURIComponent(conversationId)}/messages`,
    {
      method: "POST",
      body: {
        schema_version: 1,
        client_request_id: requestId,
        text: text.trim(),
        images: serializedImages,
        capabilities: asArray(capabilities).filter(
          (capability) => typeof capability === "string" && capability,
        ),
        ...(workflowId ? { workflow_id: workflowId } : {}),
        contexts: asArray(contexts).map((context) => ({
          context_id: context.id,
          path: context.path,
          ...(context.contentHash ? { content_hash: context.contentHash } : {}),
          ...(Number.isInteger(context.startLine) ? { start_line: context.startLine } : {}),
          ...(Number.isInteger(context.endLine) ? { end_line: context.endLine } : {}),
        })),
        ...(providerId ? { provider_id: providerId } : {}),
        ...(modelId ? { model_id: modelId } : {}),
        ...(thinkingLevel ? { thinking_level: thinkingLevel } : {}),
      },
      signal,
      fetchImpl,
    },
  );
  return mapProjectWorkConversation(payload);
}

export async function uploadProjectWorkPdf({
  conversationId,
  file,
  signal,
  fetchImpl,
} = {}) {
  requiredId(conversationId, "conversationId");
  if (
    !file
    || typeof file.name !== "string"
    || !file.name.toLowerCase().endsWith(".pdf")
    || !Number.isSafeInteger(file.size)
    || file.size < 5
  ) {
    throw new TypeError("请选择有效的论文资料");
  }
  const created = await requestJson(
    `${PROJECT_WORK_API_ROOT}/conversations/${encodeURIComponent(conversationId)}/documents`,
    {
      method: "POST",
      body: {
        schema_version: 1,
        file_name: file.name,
        byte_length: file.size,
      },
      signal,
      fetchImpl,
    },
  );
  const document = mapProjectWorkDocument(created?.document);
  if (!document) {
    throw new Error("项目工作服务没有返回有效的论文资料记录");
  }
  try {
    const payload = await requestPdfContent(
      `${PROJECT_WORK_API_ROOT}/conversations/${encodeURIComponent(conversationId)}/documents/${encodeURIComponent(document.id)}/content`,
      file,
      { signal, fetchImpl },
    );
    return mapProjectWorkConversation(payload);
  } catch (error) {
    await removeProjectWorkPdf({
      conversationId,
      documentId: document.id,
      fetchImpl,
    }).catch(() => undefined);
    throw error;
  }
}

export async function retryProjectWorkPdf({
  conversationId,
  documentId,
  signal,
  fetchImpl,
} = {}) {
  requiredId(conversationId, "conversationId");
  requiredId(documentId, "documentId");
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/conversations/${encodeURIComponent(conversationId)}/documents/${encodeURIComponent(documentId)}/retry`,
    {
      method: "POST",
      body: { schema_version: 1 },
      signal,
      fetchImpl,
    },
  );
  return mapProjectWorkConversation(payload);
}

export async function removeProjectWorkPdf({
  conversationId,
  documentId,
  signal,
  fetchImpl,
} = {}) {
  requiredId(conversationId, "conversationId");
  requiredId(documentId, "documentId");
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/conversations/${encodeURIComponent(conversationId)}/documents/${encodeURIComponent(documentId)}`,
    {
      method: "DELETE",
      signal,
      fetchImpl,
    },
  );
  return mapProjectWorkConversation(payload);
}

export async function configureProjectWorkConversation({
  conversationId,
  providerId,
  modelId,
  thinkingLevel,
  signal,
  fetchImpl,
} = {}) {
  requiredId(conversationId, "conversationId");
  if (typeof thinkingLevel !== "string" || !thinkingLevel.trim()) {
    throw new TypeError("thinkingLevel 必须是非空字符串");
  }
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/conversations/${encodeURIComponent(conversationId)}/configuration`,
    {
      method: "POST",
      body: {
        schema_version: 1,
        ...(providerId ? { provider_id: providerId } : {}),
        ...(modelId ? { model_id: modelId } : {}),
        thinking_level: thinkingLevel.trim(),
      },
      signal,
      fetchImpl,
    },
  );
  return mapProjectWorkConversation(payload);
}

export async function configureProjectWorkExecutionPolicy({
  conversationId,
  mode,
  expectedRevision,
  signal,
  fetchImpl,
} = {}) {
  requiredId(conversationId, "conversationId");
  if (!["manual_review", "auto_review"].includes(mode)) {
    throw new TypeError("mode 必须是 manual_review 或 auto_review");
  }
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new TypeError("expectedRevision 必须是正整数");
  }
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/conversations/${encodeURIComponent(conversationId)}/execution-policy`,
    {
      method: "POST",
      body: {
        schema_version: 1,
        mode,
        expected_revision: expectedRevision,
      },
      signal,
      fetchImpl,
    },
  );
  return mapProjectWorkConversation(payload);
}

export async function listProjectWorkFollowUps({
  conversationId,
  includeHistory = false,
  signal,
  fetchImpl,
} = {}) {
  requiredId(conversationId, "conversationId");
  const query = includeHistory ? "?include_history=true" : "";
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/conversations/${encodeURIComponent(conversationId)}/follow-ups${query}`,
    { signal, fetchImpl },
  );
  return asArray(payload?.items).map(mapFollowUpItem).filter(Boolean);
}

export async function enqueueProjectWorkFollowUp({
  conversationId,
  text,
  signal,
  fetchImpl,
} = {}) {
  requiredId(conversationId, "conversationId");
  if (typeof text !== "string" || !text.trim()) {
    throw new TypeError("text 必须是非空字符串");
  }
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/conversations/${encodeURIComponent(conversationId)}/follow-ups`,
    {
      method: "POST",
      body: {
        schema_version: 1,
        text: text.trim(),
      },
      signal,
      fetchImpl,
    },
  );
  return {
    item: mapFollowUpItem(payload?.item),
    snapshot: mapProjectWorkConversation(payload?.snapshot),
  };
}

export async function removeProjectWorkFollowUp({
  conversationId,
  itemId,
  signal,
  fetchImpl,
} = {}) {
  requiredId(conversationId, "conversationId");
  requiredId(itemId, "itemId");
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/conversations/${encodeURIComponent(conversationId)}/follow-ups/${encodeURIComponent(itemId)}`,
    {
      method: "DELETE",
      signal,
      fetchImpl,
    },
  );
  return asArray(payload?.cancelled).map(mapFollowUpItem).filter(Boolean);
}

export async function clearProjectWorkFollowUps({
  conversationId,
  signal,
  fetchImpl,
} = {}) {
  requiredId(conversationId, "conversationId");
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/conversations/${encodeURIComponent(conversationId)}/follow-ups`,
    {
      method: "DELETE",
      signal,
      fetchImpl,
    },
  );
  return asArray(payload?.cancelled).map(mapFollowUpItem).filter(Boolean);
}

export async function listProjectWorkAskUserRequests({
  conversationId,
  includeHistory = false,
  signal,
  fetchImpl,
} = {}) {
  requiredId(conversationId, "conversationId");
  const query = includeHistory ? "?include_history=true" : "";
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/conversations/${encodeURIComponent(conversationId)}/questions${query}`,
    { signal, fetchImpl },
  );
  return asArray(payload?.requests).map(mapAskUserRequest).filter(Boolean);
}

export async function answerProjectWorkAskUserRequest({
  conversationId,
  requestId,
  answers,
  signal,
  fetchImpl,
} = {}) {
  requiredId(conversationId, "conversationId");
  requiredId(requestId, "requestId");
  if (!Array.isArray(answers)) {
    throw new TypeError("answers 必须是数组");
  }
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/conversations/${encodeURIComponent(conversationId)}/questions/${encodeURIComponent(requestId)}/answer`,
    {
      method: "POST",
      body: {
        schema_version: 1,
        answers: answers.map((answer) => ({
          question_id: requiredId(answer?.questionId, "answer.questionId"),
          value: Array.isArray(answer?.value)
            ? answer.value.map(String)
            : String(answer?.value ?? ""),
        })),
      },
      signal,
      fetchImpl,
    },
  );
  return {
    request: mapAskUserRequest(payload?.request),
    snapshot: mapProjectWorkConversation(payload?.snapshot),
  };
}

export async function cancelProjectWorkAskUserRequest({
  conversationId,
  requestId,
  signal,
  fetchImpl,
} = {}) {
  requiredId(conversationId, "conversationId");
  requiredId(requestId, "requestId");
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/conversations/${encodeURIComponent(conversationId)}/questions/${encodeURIComponent(requestId)}/cancel`,
    {
      method: "POST",
      body: { schema_version: 1 },
      signal,
      fetchImpl,
    },
  );
  return {
    request: mapAskUserRequest(payload?.request),
    snapshot: mapProjectWorkConversation(payload?.snapshot),
  };
}

export async function steerProjectWorkConversation({
  conversationId,
  text,
  clientRequestId = createRequestId("project-steer"),
  signal,
  fetchImpl,
} = {}) {
  requiredId(conversationId, "conversationId");
  if (typeof text !== "string" || !text.trim()) throw new TypeError("text 必须是非空字符串");
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/conversations/${encodeURIComponent(conversationId)}/steer`,
    {
      method: "POST",
      body: {
        schema_version: 1,
        client_request_id: clientRequestId,
        text: text.trim(),
      },
      signal,
      fetchImpl,
    },
  );
  return mapProjectWorkConversation(payload);
}

export async function abortProjectWorkConversation({
  conversationId,
  clientRequestId = createRequestId("project-abort"),
  signal,
  fetchImpl,
} = {}) {
  requiredId(conversationId, "conversationId");
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/conversations/${encodeURIComponent(conversationId)}/abort`,
    {
      method: "POST",
      body: { schema_version: 1, client_request_id: clientRequestId },
      signal,
      fetchImpl,
    },
  );
  return mapProjectWorkConversation(payload);
}

export async function compactProjectWorkConversation({
  conversationId,
  clientRequestId = createRequestId("project-compact"),
  signal,
  fetchImpl,
} = {}) {
  requiredId(conversationId, "conversationId");
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/conversations/${encodeURIComponent(conversationId)}/compact`,
    {
      method: "POST",
      body: { schema_version: 1, client_request_id: clientRequestId },
      signal,
      fetchImpl,
    },
  );
  return mapProjectWorkConversation(payload);
}

export async function fetchProjectWorkConversationTurns({
  conversationId,
  beforeTurnSeq,
  limit = 20,
  signal,
  fetchImpl,
} = {}) {
  requiredId(conversationId, "conversationId");
  if (
    beforeTurnSeq !== undefined
    && (!Number.isSafeInteger(beforeTurnSeq) || beforeTurnSeq < 1)
  ) {
    throw new TypeError("beforeTurnSeq 必须是正整数");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError("limit 必须是 1–100 的整数");
  }
  const query = new URLSearchParams({ limit: String(limit) });
  if (beforeTurnSeq !== undefined) {
    query.set("before_turn_seq", String(beforeTurnSeq));
  }
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/conversations/${encodeURIComponent(conversationId)}/turns?${query.toString()}`,
    { signal, fetchImpl },
  );
  const nextBeforeTurnSeq = Number(
    pick(payload, "next_before_turn_seq", "nextBeforeTurnSeq"),
  );
  return {
    turns: asArray(payload?.turns).map(mapConversationTurn).filter(Boolean),
    hasMore: pick(payload, "has_more", "hasMore", false) === true,
    nextBeforeTurnSeq: Number.isSafeInteger(nextBeforeTurnSeq)
      && nextBeforeTurnSeq > 0
      ? nextBeforeTurnSeq
      : null,
  };
}

export async function markProjectWorkConversationRead({
  conversationId,
  throughMessageSeq,
  clientRequestId = createRequestId("project-read"),
  signal,
  fetchImpl,
} = {}) {
  requiredId(conversationId, "conversationId");
  if (
    throughMessageSeq !== undefined
    && (!Number.isSafeInteger(throughMessageSeq) || throughMessageSeq < 0)
  ) {
    throw new TypeError("throughMessageSeq 必须是非负整数");
  }
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/conversations/${encodeURIComponent(conversationId)}/read`,
    {
      method: "POST",
      body: {
        schema_version: 1,
        client_request_id: clientRequestId,
        ...(throughMessageSeq === undefined
          ? {}
          : { through_message_seq: throughMessageSeq }),
      },
      signal,
      fetchImpl,
    },
  );
  return mapProjectWorkConversation(payload);
}

export async function retryProjectWorkLastTurn({
  conversationId,
  clientRequestId = createRequestId("project-retry"),
  signal,
  fetchImpl,
} = {}) {
  requiredId(conversationId, "conversationId");
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/conversations/${encodeURIComponent(conversationId)}/retry-last-turn`,
    {
      method: "POST",
      body: {
        schema_version: 1,
        client_request_id: clientRequestId,
      },
      signal,
      fetchImpl,
    },
  );
  return mapProjectWorkConversation(payload);
}

export async function resumeProjectWorkVerificationRepair({
  conversationId,
  operationId,
  clientRequestId = createRequestId("project-repair-resume"),
  signal,
  fetchImpl,
} = {}) {
  requiredId(conversationId, "conversationId");
  requiredId(operationId, "operationId");
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/conversations/${encodeURIComponent(conversationId)}/verification-repairs/${encodeURIComponent(operationId)}/resume`,
    {
      method: "POST",
      body: {
        schema_version: 1,
        client_request_id: clientRequestId,
      },
      signal,
      fetchImpl,
    },
  );
  return mapProjectWorkConversation(payload);
}

export async function fetchProjectWorkTree({
  projectId,
  conversationId,
  path = "",
  query: searchQuery = "",
  limit,
  cursor,
  signal,
  fetchImpl,
} = {}) {
  if (conversationId) {
    requiredId(conversationId, "conversationId");
  } else {
    requiredId(projectId, "projectId");
  }
  const query = new URLSearchParams();
  if (path) {
    const safePath = safeProjectRelativePath(path);
    if (!safePath) throw new TypeError("path 必须是安全的项目内相对路径");
    query.set("path", safePath);
  }
  if (searchQuery) {
    if (typeof searchQuery !== "string" || searchQuery.trim().length > 120) {
      throw new TypeError("query 必须是不超过 120 个字符的字符串");
    }
    query.set("query", searchQuery.trim());
  }
  if (limit !== undefined) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new TypeError("limit 必须是 1–500 的整数");
    }
    query.set("limit", String(limit));
  }
  if (cursor) query.set("cursor", cursor);
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  const scope = conversationId
    ? `conversations/${encodeURIComponent(conversationId)}`
    : `projects/${encodeURIComponent(projectId)}`;
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/${scope}/tree${suffix}`,
    { signal, fetchImpl },
  );
  const rawReturnedPath = pick(payload, "path", "path", path);
  const returnedPath = rawReturnedPath
    ? safeProjectRelativePath(rawReturnedPath)
    : "";
  if (rawReturnedPath && !returnedPath) {
    throw new Error("项目文件列表返回了不安全的路径");
  }
  const baseDepth = String(returnedPath ?? "").split("/").filter(Boolean).length;
  const result = {
    path: returnedPath,
    revision: pick(payload, "revision", "revision"),
    cursor: pick(payload, "next_cursor", "nextCursor"),
    entries: mapTreeEntries(payload?.entries, returnedPath, baseDepth),
  };
  if (payload?.query !== undefined) {
    result.query = pick(payload, "query", "query", searchQuery || null);
  }
  if (payload?.truncated !== undefined) {
    result.truncated = Boolean(payload.truncated);
  }
  if (
    payload?.scan_truncated !== undefined
    || payload?.scanTruncated !== undefined
  ) {
    result.scanTruncated = Boolean(
      pick(payload, "scan_truncated", "scanTruncated", false),
    );
  }
  if (
    payload?.scanned_entries !== undefined
    || payload?.scannedEntries !== undefined
  ) {
    result.scannedEntries = pick(
      payload,
      "scanned_entries",
      "scannedEntries",
      null,
    );
  }
  return result;
}

export function projectWorkImageUrl({
  projectId,
  conversationId,
  path,
} = {}) {
  if (conversationId) {
    requiredId(conversationId, "conversationId");
  } else {
    requiredId(projectId, "projectId");
  }
  const safePath = safeProjectRelativePath(path);
  if (!safePath) throw new TypeError("path 必须是安全的项目内相对路径");
  const scope = conversationId
    ? `conversations/${encodeURIComponent(conversationId)}`
    : `projects/${encodeURIComponent(projectId)}`;
  const query = new URLSearchParams({ path: safePath });
  return `${PROJECT_WORK_API_ROOT}/${scope}/image?${query.toString()}`;
}

export async function fetchProjectWorkFile({
  projectId,
  conversationId,
  path,
  signal,
  fetchImpl,
} = {}) {
  if (conversationId) {
    requiredId(conversationId, "conversationId");
  } else {
    requiredId(projectId, "projectId");
  }
  requiredId(path, "path");
  const query = new URLSearchParams({ path });
  const scope = conversationId
    ? `conversations/${encodeURIComponent(conversationId)}`
    : `projects/${encodeURIComponent(projectId)}`;
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/${scope}/file?${query.toString()}`,
    { signal, fetchImpl },
  );
  const content = typeof payload?.content === "string" ? payload.content : "";
  const lines = Array.isArray(payload?.lines)
    ? payload.lines.map(String)
    : content.split(/\r?\n/);
  const rawStartLine = Number(pick(payload, "start_line", "startLine", 1));
  const startLine = Number.isFinite(rawStartLine) && rawStartLine > 0 ? rawStartLine : 1;
  const rawEndLine = Number(pick(payload, "end_line", "endLine"));
  const endLine = Number.isFinite(rawEndLine) && rawEndLine >= startLine
    ? rawEndLine
    : Math.max(startLine, startLine + lines.length - 1);
  const rawTotalLines = Number(pick(payload, "total_lines", "totalLines"));
  const totalLines = Number.isFinite(rawTotalLines) && rawTotalLines >= endLine
    ? rawTotalLines
    : endLine;
  return {
    path: pick(payload, "path", "path", path),
    language: pick(payload, "language", "language", "text"),
    mimeType: pick(payload, "mime_type", "mimeType", "text/plain"),
    content,
    lines,
    contentHash: pick(payload, "content_hash", "contentHash", payload?.hash ?? null),
    startLine,
    endLine,
    totalLines,
    byteLength: pick(payload, "byte_length", "byteLength"),
    truncated: Boolean(payload?.truncated) || startLine > 1 || endLine < totalLines,
    binary: Boolean(payload?.binary),
  };
}

export async function applyProjectWorkChangeSet({
  conversationId,
  changeSetId,
  proposalHash,
  selectedFiles,
  clientRequestId = createRequestId("project-apply"),
  signal,
  fetchImpl,
} = {}) {
  requiredId(conversationId, "conversationId");
  requiredId(changeSetId, "changeSetId");
  if (!Array.isArray(selectedFiles) || selectedFiles.length === 0) {
    throw new TypeError("selectedFiles 不能为空");
  }
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/conversations/${encodeURIComponent(conversationId)}/change-sets/${encodeURIComponent(changeSetId)}/apply`,
    {
      method: "POST",
      body: {
        schema_version: 1,
        client_request_id: clientRequestId,
        proposal_hash: proposalHash,
        selected_files: selectedFiles.map((file) => ({
          file_id: file.id,
          base_hash: file.baseHash,
          after_hash: file.afterHash,
        })),
      },
      signal,
      fetchImpl,
    },
  );
  return mapProjectWorkConversation(payload);
}

export async function startProjectWorkPreview({
  conversationId,
  previewId,
  requestHash,
  clientRequestId = createRequestId("project-preview"),
  signal,
  fetchImpl,
} = {}) {
  requiredId(conversationId, "conversationId");
  requiredId(previewId, "previewId");
  const normalizedRequestHash = requiredId(requestHash, "requestHash").trim();
  const normalizedClientRequestId = requiredId(
    clientRequestId,
    "clientRequestId",
  ).trim();
  if (!SHA256_PATTERN.test(normalizedRequestHash)) {
    throw new TypeError("requestHash 必须是完整的 SHA-256 哈希");
  }
  if (!PROJECT_WORK_CLIENT_REQUEST_ID_PATTERN.test(normalizedClientRequestId)) {
    throw new TypeError("clientRequestId 格式无效");
  }
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/conversations/${encodeURIComponent(conversationId)}/previews/${encodeURIComponent(previewId)}/start`,
    {
      method: "POST",
      body: {
        schema_version: 1,
        client_request_id: normalizedClientRequestId,
        request_hash: normalizedRequestHash,
      },
      signal,
      fetchImpl,
    },
  );
  return mapProjectWorkConversation(payload);
}

export async function fetchProjectWorkWorkspace({
  conversationId,
  signal,
  fetchImpl,
} = {}) {
  requiredId(conversationId, "conversationId");
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/conversations/${encodeURIComponent(conversationId)}/workspace`,
    { signal, fetchImpl },
  );
  return mapProjectWorkWorkspace(payload?.workspace);
}

export async function fetchProjectWorkGitEvidence({
  conversationId,
  signal,
  fetchImpl,
} = {}) {
  requiredId(conversationId, "conversationId");
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/conversations/${encodeURIComponent(conversationId)}/git-evidence`,
    { signal, fetchImpl },
  );
  return mapProjectWorkGitEvidence(payload?.git);
}

export async function listProjectWorkApplyJournal({
  conversationId,
  signal,
  fetchImpl,
} = {}) {
  requiredId(conversationId, "conversationId");
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/conversations/${encodeURIComponent(conversationId)}/applies`,
    { signal, fetchImpl },
  );
  return asArray(payload?.applies).map(mapProjectWorkApplyJournal).filter(Boolean);
}

export async function undoProjectWorkApply({
  conversationId,
  applyId,
  undoHash,
  signal,
  fetchImpl,
} = {}) {
  requiredId(conversationId, "conversationId");
  requiredId(applyId, "applyId");
  requiredId(undoHash, "undoHash");
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/conversations/${encodeURIComponent(conversationId)}/applies/${encodeURIComponent(applyId)}/undo`,
    {
      method: "POST",
      body: {
        schema_version: 1,
        undo_hash: undoHash,
      },
      signal,
      fetchImpl,
    },
  );
  return mapProjectWorkConversation(payload);
}

export async function runProjectWorkVerification({
  conversationId,
  commandId,
  clientRequestId = createRequestId("project-verification"),
  signal,
  fetchImpl,
} = {}) {
  requiredId(conversationId, "conversationId");
  requiredId(commandId, "commandId");
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/conversations/${encodeURIComponent(conversationId)}/verifications`,
    {
      method: "POST",
      body: {
        schema_version: 1,
        client_request_id: clientRequestId,
        command_id: commandId,
      },
      signal,
      fetchImpl,
    },
  );
  return mapProjectWorkConversation(payload);
}

export const projectWorkApi = {
  listProjects: listProjectWorkProjects,
  listModels: fetchProjectWorkModels,
  pickRoot: pickProjectWorkRoot,
  registerProject: registerProjectWorkProject,
  removeProject: removeProjectWorkProject,
  createConversation: createProjectWorkConversation,
  createStandaloneConversation: createStandaloneProjectWorkConversation,
  deleteConversation: deleteProjectWorkConversation,
  renameConversation: renameProjectWorkConversation,
  listConversations: listProjectWorkConversations,
  listStandaloneConversations: listStandaloneProjectWorkConversations,
  fetchConversation: fetchProjectWorkConversation,
  subscribeConversation: subscribeProjectWorkConversation,
  configureConversation: configureProjectWorkConversation,
  configureExecutionPolicy: configureProjectWorkExecutionPolicy,
  sendMessage: sendProjectWorkMessage,
  steerConversation: steerProjectWorkConversation,
  listFollowUps: listProjectWorkFollowUps,
  enqueueFollowUp: enqueueProjectWorkFollowUp,
  removeFollowUp: removeProjectWorkFollowUp,
  clearFollowUps: clearProjectWorkFollowUps,
  listAskUserRequests: listProjectWorkAskUserRequests,
  answerAskUserRequest: answerProjectWorkAskUserRequest,
  cancelAskUserRequest: cancelProjectWorkAskUserRequest,
  abortConversation: abortProjectWorkConversation,
  compactConversation: compactProjectWorkConversation,
  fetchTurns: fetchProjectWorkConversationTurns,
  markRead: markProjectWorkConversationRead,
  retryLastTurn: retryProjectWorkLastTurn,
  resumeVerificationRepair: resumeProjectWorkVerificationRepair,
  fetchTree: fetchProjectWorkTree,
  fetchFile: fetchProjectWorkFile,
  imageUrl: projectWorkImageUrl,
  uploadPdf: uploadProjectWorkPdf,
  retryPdf: retryProjectWorkPdf,
  removePdf: removeProjectWorkPdf,
  applyChangeSet: applyProjectWorkChangeSet,
  startPreview: startProjectWorkPreview,
  fetchWorkspace: fetchProjectWorkWorkspace,
  fetchGitEvidence: fetchProjectWorkGitEvidence,
  listApplyJournal: listProjectWorkApplyJournal,
  undoApply: undoProjectWorkApply,
  runVerification: runProjectWorkVerification,
};
