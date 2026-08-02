const PROJECT_WORK_API_ROOT = "/api/v1/project-work";
const PROJECT_WORK_CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
export const MAX_PROJECT_WORK_IMAGE_BYTES = 5 * 1024 * 1024;
export const PROJECT_WORK_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const PROJECT_WORK_IMAGE_EXTENSION_PATTERN = /\.(?:jpe?g|png|webp)$/i;
export const MAX_PROJECT_WORK_TEXT_ATTACHMENTS = 5;
export const MAX_PROJECT_WORK_TEXT_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const PROJECT_WORK_SENSITIVE_ATTACHMENT_PATTERN = /^(?:\.env(?:\..+)?|credentials?(?:\.[^.]+)?|secrets?(?:\.[^.]+)?|id_(?:dsa|ecdsa|ed25519|rsa)|.+\.(?:key|p12|pem|pfx))$/i;

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

function projectWorkImageMimeType(file) {
  const type = typeof file?.type === "string" ? file.type.toLowerCase() : "";
  if (PROJECT_WORK_IMAGE_TYPES.has(type)) return type;
  const name = typeof file?.name === "string" ? file.name.toLowerCase() : "";
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  return type;
}

export function validateProjectWorkImageFile(file) {
  const fileName = typeof file?.name === "string" ? file.name : "";
  const mimeType = typeof file?.type === "string" ? file.type.toLowerCase() : "";
  const hasSupportedType = PROJECT_WORK_IMAGE_TYPES.has(mimeType);
  const mayUseExtensionFallback = !mimeType || mimeType === "application/octet-stream";
  if (
    !file
    || !fileName
    || (!hasSupportedType && !(
      mayUseExtensionFallback && PROJECT_WORK_IMAGE_EXTENSION_PATTERN.test(fileName)
    ))
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

export function projectWorkDroppedFileKind(file) {
  const name = typeof file?.name === "string" ? file.name : "";
  const type = typeof file?.type === "string" ? file.type.toLowerCase() : "";
  if (!name.trim() || PROJECT_WORK_SENSITIVE_ATTACHMENT_PATTERN.test(name)) {
    return "unsupported";
  }
  if (type === "application/pdf" || name.toLowerCase().endsWith(".pdf")) {
    return "pdf";
  }
  if (
    PROJECT_WORK_IMAGE_TYPES.has(type)
    || (!type && PROJECT_WORK_IMAGE_EXTENSION_PATTERN.test(name))
    || (type === "application/octet-stream" && PROJECT_WORK_IMAGE_EXTENSION_PATTERN.test(name))
  ) {
    return "image";
  }
  // Browsers often report an empty or generic MIME type for readable formats
  // such as .drawio. The service verifies the actual bytes as safe UTF-8 text
  // before the attachment becomes available to the Agent.
  return "text";
}

export function validateProjectWorkTextAttachmentFile(file) {
  if (
    !file
    || typeof file.name !== "string"
    || !file.name.trim()
    || !Number.isSafeInteger(file.size)
    || file.size < 1
    || projectWorkDroppedFileKind(file) !== "text"
  ) {
    throw new TypeError("请选择不含敏感文件名的本地资料");
  }
  if (file.size > MAX_PROJECT_WORK_TEXT_ATTACHMENT_BYTES) {
    throw new TypeError(`文件 ${file.name} 不能超过 5 MB`);
  }
  return file;
}

export function serializeProjectWorkAttachmentReference(attachment) {
  const id = requiredId(attachment?.id, "attachment.id");
  const revision = requiredId(
    attachment?.revision ?? attachment?.contentHash,
    "attachment.revision",
  );
  if (!SHA256_PATTERN.test(revision)) {
    throw new TypeError("附件版本无效，请重新添加文件");
  }
  return {
    attachment_id: id,
    attachment_revision: revision,
  };
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
    mime_type: projectWorkImageMimeType(file),
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

async function requestAttachmentContent(path, file, {
  signal,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("当前环境不支持 fetch");
  }
  const response = await fetchImpl(path, {
    method: "PUT",
    signal,
    headers: {
      "content-type": file.type || "application/octet-stream",
    },
    body: file,
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    if (!response.ok) throw mapApiError(response, null, "普通附件上传失败");
    const error = new Error("项目工作服务返回了无效 JSON");
    error.name = "ProjectWorkApiError";
    error.code = "PROJECT_WORK_RESPONSE_INVALID";
    error.retryable = true;
    error.status = response.status;
    throw error;
  }
  if (!response.ok) throw mapApiError(response, payload, "普通附件上传失败");
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

function mapModelPricing(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const tiers = asArray(raw.tiers).flatMap((tier) => {
    const inputTokensAbove = nullableNumber(
      tier,
      "input_tokens_above",
      "inputTokensAbove",
    );
    if (inputTokensAbove === null) return [];
    return [{
      inputTokensAbove,
      input: nullableNumber(tier, "input", "input"),
      output: nullableNumber(tier, "output", "output"),
      cacheRead: nullableNumber(tier, "cache_read", "cacheRead"),
      cacheWrite: nullableNumber(tier, "cache_write", "cacheWrite"),
    }];
  });
  const pricing = {
    currency: pick(raw, "currency", "currency", "USD"),
    unit: pick(raw, "unit", "unit", "per_million_tokens"),
    source: pick(raw, "source", "source"),
    version: pick(raw, "version", "version"),
    input: nullableNumber(raw, "input", "input"),
    output: nullableNumber(raw, "output", "output"),
    cacheRead: nullableNumber(raw, "cache_read", "cacheRead"),
    cacheWrite: nullableNumber(raw, "cache_write", "cacheWrite"),
    tiers,
  };
  return [
    pricing.input,
    pricing.output,
    pricing.cacheRead,
    pricing.cacheWrite,
  ].some((value) => value !== null)
    ? pricing
    : null;
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
    billingKind: pick(raw, "billing_kind", "billingKind", "unknown"),
    pricing: mapModelPricing(raw.pricing),
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
    attachments: asArray(raw.attachments).map((attachment) => ({
      id: pick(attachment, "attachment_id", "attachmentId", attachment.id),
      fileName: pick(attachment, "file_name", "fileName", "文件"),
      mimeType: pick(attachment, "mime_type", "mimeType"),
      byteLength: Number(
        pick(attachment, "byte_length", "byteLength", 0),
      ) || 0,
      contentHash: pick(attachment, "content_hash", "contentHash"),
      revision: pick(
        attachment,
        "attachment_revision",
        "attachmentRevision",
        attachment.revision ?? attachment.contentHash,
      ),
    })),
    workflowId: pick(raw, "workflow_id", "workflowId"),
    capabilities: asArray(raw.capabilities).filter(
      (capability) => typeof capability === "string" && capability,
    ),
    codeEvidence: asArray(
      pick(raw, "code_evidence", "codeEvidence", []),
    ).flatMap((evidence) => {
      if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
        return [];
      }
      const path = pick(evidence, "path", "path");
      const contentHash = pick(
        evidence,
        "content_hash",
        "contentHash",
      );
      const startLine = Number(
        pick(evidence, "start_line", "startLine"),
      );
      const endLine = Number(
        pick(evidence, "end_line", "endLine"),
      );
      return typeof path === "string"
        && path
        && typeof contentHash === "string"
        && contentHash
        && Number.isSafeInteger(startLine)
        && startLine > 0
        && Number.isSafeInteger(endLine)
        && endLine >= startLine
        ? [{
            path,
            contentHash,
            startLine,
            endLine,
          }]
        : [];
    }),
    providerId: pick(raw, "provider_id", "providerId"),
    modelId: pick(raw, "model_id", "modelId"),
    thinkingLevel: pick(raw, "thinking_level", "thinkingLevel"),
    messageSeq: nullableNumber(raw, "message_seq", "messageSeq"),
    turnId: pick(raw, "turn_id", "turnId"),
    turnSeq: nullableNumber(raw, "turn_seq", "turnSeq"),
    attempt: nullableNumber(raw, "attempt", "attempt"),
    checkpointId: pick(raw, "checkpoint_id", "checkpointId"),
    parentCheckpointId: pick(
      raw,
      "parent_checkpoint_id",
      "parentCheckpointId",
    ),
    branchId: pick(raw, "branch_id", "branchId"),
    branchLabel: pick(raw, "branch_label", "branchLabel"),
    branchFromCheckpointId: pick(
      raw,
      "branch_from_checkpoint_id",
      "branchFromCheckpointId",
    ),
    inherited: Boolean(pick(raw, "inherited", "inherited", false)),
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

function mapSessionCheckpoint(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = pick(raw, "checkpoint_id", "checkpointId", raw.id);
  if (typeof id !== "string" || !id) return null;
  return {
    id,
    parentId: pick(raw, "parent_id", "parentId"),
    turnId: pick(raw, "turn_id", "turnId"),
    turnSeq: nullableNumber(raw, "turn_seq", "turnSeq"),
    userMessageId: pick(raw, "user_message_id", "userMessageId"),
    assistantMessageId: pick(
      raw,
      "assistant_message_id",
      "assistantMessageId",
    ),
    attempt: nullableNumber(raw, "attempt", "attempt"),
    providerId: pick(raw, "provider_id", "providerId"),
    modelId: pick(raw, "model_id", "modelId"),
    thinkingLevel: pick(raw, "thinking_level", "thinkingLevel"),
    status: pick(raw, "status", "status", "completed"),
    title: pick(raw, "title", "title", ""),
    branchable: Boolean(pick(raw, "branchable", "branchable", false)),
    blockedReason: pick(raw, "blocked_reason", "blockedReason"),
    createdAt: pick(raw, "created_at", "createdAt"),
  };
}

function mapSessionPath(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      activeLeafCheckpointId: null,
      checkpoints: [],
    };
  }
  return {
    activeLeafCheckpointId: pick(
      raw,
      "active_leaf_checkpoint_id",
      "activeLeafCheckpointId",
    ),
    checkpoints: asArray(raw.checkpoints)
      .map(mapSessionCheckpoint)
      .filter(Boolean),
  };
}

function mapConversationFork(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const sourceConversationId = pick(
    raw,
    "source_conversation_id",
    "sourceConversationId",
  );
  const sourceCheckpointId = pick(
    raw,
    "source_checkpoint_id",
    "sourceCheckpointId",
  );
  if (
    typeof sourceConversationId !== "string"
    || !sourceConversationId
    || typeof sourceCheckpointId !== "string"
    || !sourceCheckpointId
  ) {
    return null;
  }
  return {
    sourceConversationId,
    sourceCheckpointId,
    sourceAssistantMessageId: pick(
      raw,
      "source_assistant_message_id",
      "sourceAssistantMessageId",
    ),
    status: pick(raw, "status", "status", "ready"),
    contextMode: pick(raw, "context_mode", "contextMode", "pi_native_path"),
    projectFiles: pick(raw, "project_files", "projectFiles", "current"),
    createdAt: pick(raw, "created_at", "createdAt"),
  };
}

function mapGeneratedImage(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = pick(raw, "image_id", "imageId", raw.id);
  if (typeof id !== "string" || !id) return null;
  return {
    id,
    turnId: pick(raw, "turn_id", "turnId"),
    status: pick(raw, "status", "status", "failed"),
    prompt: typeof raw.prompt === "string" ? raw.prompt : "",
    fileName: pick(raw, "file_name", "fileName"),
    mimeType: pick(raw, "mime_type", "mimeType"),
    byteLength: nullableNumber(raw, "byte_length", "byteLength"),
    width: nullableNumber(raw, "width", "width"),
    height: nullableNumber(raw, "height", "height"),
    sha256: pick(raw, "sha256", "sha256"),
    requestedSize: pick(raw, "requested_size", "requestedSize"),
    requestedQuality: pick(raw, "requested_quality", "requestedQuality"),
    providerId: pick(raw, "provider_id", "providerId"),
    modelId: pick(raw, "model_id", "modelId"),
    operationId: pick(raw, "operation_id", "operationId"),
    billingKind: pick(raw, "billing_kind", "billingKind"),
    pricingStatus: pick(raw, "pricing_status", "pricingStatus"),
    usageStatus: pick(raw, "usage_status", "usageStatus", "unknown"),
    usage: mapTurnUsage(raw.usage),
    error: pick(raw, "error", "error"),
    createdAt: pick(raw, "created_at", "createdAt"),
    completedAt: pick(raw, "completed_at", "completedAt"),
  };
}

function mapGeneratedOfficeArtifact(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = pick(raw, "artifact_id", "artifactId", raw.id);
  if (typeof id !== "string" || !id) return null;
  const kind = pick(raw, "kind", "kind", "word");
  return {
    id,
    turnId: pick(raw, "turn_id", "turnId"),
    kind: kind === "excel" ? "excel" : "word",
    status: pick(raw, "status", "status", "failed"),
    title: pick(raw, "title", "title", ""),
    summary: pick(raw, "summary", "summary", ""),
    fileName: pick(raw, "file_name", "fileName"),
    mimeType: pick(raw, "mime_type", "mimeType"),
    byteLength: nullableNumber(raw, "byte_length", "byteLength"),
    sha256: pick(raw, "sha256", "sha256"),
    revision: pick(raw, "revision", "revision"),
    previewText: pick(raw, "preview_text", "previewText", ""),
    previewTruncated: Boolean(
      pick(raw, "preview_truncated", "previewTruncated", false),
    ),
    structureVerified: Boolean(
      pick(raw, "structure_verified", "structureVerified", false),
    ),
    renderVerified: Boolean(
      pick(raw, "render_verified", "renderVerified", false),
    ),
    pageCount: nullableNumber(raw, "page_count", "pageCount"),
    sheetCount: nullableNumber(raw, "sheet_count", "sheetCount"),
    sourceArtifactId: pick(raw, "source_artifact_id", "sourceArtifactId"),
    sourceArtifactRevision: pick(
      raw,
      "source_artifact_revision",
      "sourceArtifactRevision",
    ),
    error: pick(raw, "error", "error"),
    createdAt: pick(raw, "created_at", "createdAt"),
    completedAt: pick(raw, "completed_at", "completedAt"),
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
    events: asArray(raw.events).map(mapEvent).filter(Boolean),
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
  const type = pick(
    raw,
    "type",
    "type",
    pick(raw, "kind", "kind", "activity"),
  );
  const event = {
    ...raw,
    seq,
    type,
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
    turnId: pick(
      raw,
      "turn_id",
      "turnId",
      pick(data, "turn_id", "turnId"),
    ),
    turnSeq: nullableNumber(data, "turn_seq", "turnSeq")
      ?? nullableNumber(raw, "turn_seq", "turnSeq"),
    attempt: nullableNumber(data, "attempt", "attempt")
      ?? nullableNumber(raw, "attempt", "attempt"),
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
    lifecycleState: pick(
      raw,
      "lifecycle_state",
      "lifecycleState",
      data.state ?? null,
    ),
    sourceEventSeq: nullableNumber(
      data,
      "source_event_seq",
      "sourceEventSeq",
    ),
    dedupeKey: pick(
      raw,
      "dedupe_key",
      "dedupeKey",
      data.dedupeKey ?? null,
    ),
    createdAt: pick(raw, "created_at", "createdAt", pick(raw, "at", "at")),
  };
  if (!["message.delta", "message.partial"].includes(type)) return event;

  const messageId = data.id
    ?? pick(data, "message_id", "messageId", pick(raw, "message_id", "messageId"));
  const turnId = pick(
    data,
    "turn_id",
    "turnId",
    pick(raw, "turn_id", "turnId"),
  );
  const revision = Number(
    pick(data, "revision", "revision", pick(raw, "revision", "revision")),
  );
  if (type === "message.delta") {
    const delta = pick(data, "delta", "delta", pick(raw, "delta", "delta", ""));
    const contentIndex = Number(
      pick(
        data,
        "content_index",
        "contentIndex",
        pick(raw, "content_index", "contentIndex"),
      ),
    );
    const phase = pick(data, "phase", "phase", pick(raw, "phase", "phase"));
    return {
      ...event,
      messageId: typeof messageId === "string" ? messageId : null,
      turnId: typeof turnId === "string" ? turnId : null,
      delta: typeof delta === "string" ? delta : "",
      revision: Number.isSafeInteger(revision) && revision > 0 ? revision : null,
      contentIndex: Number.isSafeInteger(contentIndex) && contentIndex >= 0
        ? contentIndex
        : null,
      phase: ["commentary", "final_answer"].includes(phase) ? phase : null,
      replace: false,
    };
  }

  const text = pick(data, "text", "text", pick(raw, "text", "text", ""));
  return {
    ...event,
    messageId: typeof messageId === "string" ? messageId : null,
    turnId: typeof turnId === "string" ? turnId : null,
    text: typeof text === "string" ? text : "",
    revision: Number.isSafeInteger(revision) && revision > 0 ? revision : null,
    replace: true,
  };
}

export function mapProjectWorkEvent(raw) {
  return mapEvent(raw);
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
    isMain: pick(raw, "is_main", "isMain", true) !== false,
    isGit: pick(raw, "is_git", "isGit", false) === true,
    branch: pick(raw, "branch", "branch"),
    head: pick(raw, "head", "head"),
    dirty: pick(raw, "dirty", "dirty", false) === true,
    revision: Number.isSafeInteger(revision) && revision > 0 ? revision : 1,
    createdAt: pick(raw, "created_at", "createdAt"),
    updatedAt: pick(raw, "updated_at", "updatedAt"),
  };
}

export function mapProjectWorkWorkspaceSummary(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = pick(raw, "workspace_id", "workspaceId", raw.id ?? null);
  const projectId = pick(raw, "project_id", "projectId");
  if (typeof id !== "string" || !id || typeof projectId !== "string" || !projectId) {
    return null;
  }
  const conversationCount = Number(
    pick(raw, "conversation_count", "conversationCount", 0),
  );
  return {
    id,
    projectId,
    label: pick(raw, "label", "label", "Workspace"),
    kind: pick(raw, "kind", "kind", "project_root"),
    isMain: pick(raw, "is_main", "isMain", false) === true,
    isGit: pick(raw, "is_git", "isGit", false) === true,
    branch: pick(raw, "branch", "branch"),
    head: pick(raw, "head", "head"),
    dirty: pick(raw, "dirty", "dirty", false) === true,
    status: pick(raw, "status", "status", "available"),
    conversationCount: Number.isSafeInteger(conversationCount)
      && conversationCount >= 0
      ? conversationCount
      : 0,
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

export function mapProjectWorkGitCloseout(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = pick(raw, "proposal_id", "proposalId", raw.id);
  if (typeof id !== "string" || !id) return null;
  return {
    id,
    conversationId: pick(raw, "conversation_id", "conversationId"),
    turnId: pick(raw, "turn_id", "turnId"),
    changeSetId: pick(raw, "change_set_id", "changeSetId"),
    changeSetHash: pick(raw, "change_set_hash", "changeSetHash"),
    status: pick(raw, "status", "status", "failed"),
    proposalHash: pick(raw, "proposal_hash", "proposalHash"),
    branch: pick(raw, "branch", "branch"),
    head: pick(raw, "head", "head"),
    commitMessage: pick(raw, "commit_message", "commitMessage", ""),
    files: asArray(raw.files).flatMap((file) => {
      const filePath = safeProjectRelativePath(file?.path);
      const hash = pick(file, "hash", "hash");
      const exists = file?.exists === true;
      const mode = pick(file, "mode", "mode");
      const baseHash = pick(file, "base_hash", "baseHash", null);
      const baseExists = pick(file, "base_exists", "baseExists", false) === true;
      const baseMode = pick(file, "base_mode", "baseMode", null);
      return (
        filePath
        && (
          (exists && typeof hash === "string" && hash && Number.isInteger(mode))
          || (!exists && hash === null && mode === null)
        )
        && (
          (
            baseExists
            && typeof baseHash === "string"
            && baseHash
            && Number.isInteger(baseMode)
          )
          || (!baseExists && baseHash === null && baseMode === null)
        )
      )
        ? [{
            path: filePath,
            hash,
            exists,
            mode,
            baseHash,
            baseExists,
            baseMode,
          }]
        : [];
    }),
    verificationEvidence: asArray(
      pick(raw, "verification_evidence", "verificationEvidence", []),
    ).map((evidence) => ({
      id: pick(evidence, "id", "id"),
      commandId: pick(evidence, "command_id", "commandId"),
      status: pick(evidence, "status", "status"),
      exitCode: pick(evidence, "exit_code", "exitCode"),
      changeSetId: pick(evidence, "change_set_id", "changeSetId"),
      changeSetHash: pick(evidence, "change_set_hash", "changeSetHash"),
      commandBindingHash: pick(
        evidence,
        "command_binding_hash",
        "commandBindingHash",
      ),
      completedAt: pick(evidence, "completed_at", "completedAt"),
    })),
    commitHash: pick(raw, "commit_hash", "commitHash"),
    error: pick(raw, "error", "error"),
    createdAt: pick(raw, "created_at", "createdAt"),
    updatedAt: pick(raw, "updated_at", "updatedAt"),
    committedAt: pick(raw, "committed_at", "committedAt"),
    recoveredAt: pick(raw, "recovered_at", "recoveredAt"),
  };
}

function mapProjectWorkBrowserQaCapture(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const profile = raw.profile && typeof raw.profile === "object"
    ? raw.profile
    : {};
  const profileId = pick(profile, "id", "id");
  if (!["desktop", "mobile"].includes(profileId)) return null;
  const screenshot = raw.screenshot && typeof raw.screenshot === "object"
    ? raw.screenshot
    : {};
  const dom = raw.dom && typeof raw.dom === "object" ? raw.dom : {};
  const accessibility = raw.accessibility
    && typeof raw.accessibility === "object"
    ? raw.accessibility
    : {};
  return {
    profile: {
      id: profileId,
      label: pick(profile, "label", "label", profileId === "desktop" ? "桌面" : "移动"),
      width: Number(pick(profile, "width", "width")) || null,
      height: Number(pick(profile, "height", "height")) || null,
      isMobile: pick(profile, "is_mobile", "isMobile", false) === true,
    },
    screenshot: {
      mimeType: pick(screenshot, "mime_type", "mimeType"),
      byteLength: Number(
        pick(screenshot, "byte_length", "byteLength"),
      ) || null,
      sha256: pick(screenshot, "sha256", "sha256"),
    },
    dom: {
      title: pick(dom, "title", "title", ""),
      language: pick(dom, "language", "language", ""),
      nodeCount: Number(pick(dom, "node_count", "nodeCount", 0)) || 0,
      landmarkCount: Number(
        pick(dom, "landmark_count", "landmarkCount", 0),
      ) || 0,
      headingCount: Number(
        pick(dom, "heading_count", "headingCount", 0),
      ) || 0,
      interactiveCount: Number(
        pick(dom, "interactive_count", "interactiveCount", 0),
      ) || 0,
      imageCount: Number(pick(dom, "image_count", "imageCount", 0)) || 0,
      tableCount: Number(pick(dom, "table_count", "tableCount", 0)) || 0,
      formCount: Number(pick(dom, "form_count", "formCount", 0)) || 0,
    },
    accessibility: {
      checkedNodeCount: Number(
        pick(accessibility, "checked_node_count", "checkedNodeCount", 0),
      ) || 0,
      issueCount: Number(
        pick(accessibility, "issue_count", "issueCount", 0),
      ) || 0,
      issues: asArray(accessibility.issues).map((issue) => ({
        id: pick(issue, "id", "id"),
        severity: pick(issue, "severity", "severity", "moderate"),
        count: Number(pick(issue, "count", "count", 0)) || 0,
        message: pick(issue, "message", "message", ""),
      })),
    },
  };
}

function mapProjectWorkBrowserQaEntryCollection(raw, mapEntry) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw
    : {};
  return {
    entries: asArray(source.entries).map(mapEntry),
    truncated: source.truncated === true,
  };
}

export function mapProjectWorkBrowserQaRun(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = pick(raw, "id", "id");
  if (typeof id !== "string" || !id) return null;
  const issueSummary = pick(raw, "issue_summary", "issueSummary");
  return {
    id,
    clientRequestId: pick(raw, "client_request_id", "clientRequestId"),
    status: pick(raw, "status", "status", "failed"),
    verdict: pick(raw, "verdict", "verdict"),
    issueSummary: issueSummary && typeof issueSummary === "object"
      ? {
          consoleErrorCount: Number(pick(
            issueSummary,
            "console_error_count",
            "consoleErrorCount",
            0,
          )) || 0,
          failedRequestCount: Number(pick(
            issueSummary,
            "failed_request_count",
            "failedRequestCount",
            0,
          )) || 0,
          accessibilityIssueCount: Number(pick(
            issueSummary,
            "accessibility_issue_count",
            "accessibilityIssueCount",
            0,
          )) || 0,
          blockedRequestCount: Number(pick(
            issueSummary,
            "blocked_request_count",
            "blockedRequestCount",
            0,
          )) || 0,
          blockedNavigationCount: Number(pick(
            issueSummary,
            "blocked_navigation_count",
            "blockedNavigationCount",
            0,
          )) || 0,
          blockedActionCount: Number(pick(
            issueSummary,
            "blocked_action_count",
            "blockedActionCount",
            0,
          )) || 0,
        }
      : null,
    adapterId: pick(raw, "adapter_id", "adapterId"),
    preview: raw.preview && typeof raw.preview === "object"
      ? {
          origin: pick(raw.preview, "origin", "origin"),
          path: pick(raw.preview, "path", "path", "/"),
        }
      : null,
    captures: asArray(raw.captures)
      .map(mapProjectWorkBrowserQaCapture)
      .filter(Boolean),
    console: mapProjectWorkBrowserQaEntryCollection(
      raw.console,
      (entry) => ({
        level: pick(entry, "level", "level", "log"),
        text: pick(entry, "text", "text", ""),
        source: pick(entry, "source", "source"),
      }),
    ),
    failedRequests: mapProjectWorkBrowserQaEntryCollection(
      pick(raw, "failed_requests", "failedRequests", {}),
      (entry) => ({
        method: pick(entry, "method", "method", "GET"),
        resourceType: pick(entry, "resource_type", "resourceType", "other"),
        reason: pick(entry, "reason", "reason", ""),
        source: pick(entry, "source", "source"),
      }),
    ),
    security: raw.security && typeof raw.security === "object"
      ? raw.security
      : null,
    error: raw.error && typeof raw.error === "object"
      ? {
          code: pick(raw.error, "code", "code"),
          message: pick(raw.error, "message", "message"),
          retryable: pick(raw.error, "retryable", "retryable", false) === true,
        }
      : null,
    createdAt: pick(raw, "created_at", "createdAt"),
    completedAt: pick(raw, "completed_at", "completedAt"),
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
  const mode = pick(source, "mode", "mode");
  return {
    mode: ["manual_review", "auto_review", "native"].includes(mode)
      ? mode
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
  const rawCompression = pick(
    raw,
    "output_compression",
    "outputCompression",
    {},
  );
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
    outputCompression: rawCompression
      && typeof rawCompression === "object"
      && !Array.isArray(rawCompression)
      ? {
          applied: pick(
            rawCompression,
            "applied",
            "applied",
            false,
          ) === true,
          rawBytes: nullableNumber(
            rawCompression,
            "raw_bytes",
            "rawBytes",
          ),
          compactBytes: nullableNumber(
            rawCompression,
            "compact_bytes",
            "compactBytes",
          ),
          ratio: nullableNumber(rawCompression, "ratio", "ratio"),
          command: asArray(
            pick(rawCompression, "command", "command", []),
          ).map(String),
          version: pick(rawCompression, "version", "version"),
          reason: pick(rawCompression, "reason", "reason"),
        }
      : null,
    truncated: Boolean(raw.truncated),
    isolation: pick(raw, "isolation", "isolation"),
    errorCode: pick(raw, "error_code", "errorCode"),
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

function mapProjectWorkAttachment(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = pick(raw, "attachment_id", "attachmentId", raw.id);
  const fileName = pick(raw, "file_name", "fileName");
  const revision = pick(
    raw,
    "attachment_revision",
    "attachmentRevision",
    raw.revision ?? raw.contentHash,
  );
  if (
    typeof id !== "string"
    || !id
    || typeof fileName !== "string"
    || !fileName
  ) {
    return null;
  }
  return {
    id,
    fileName,
    mimeType: pick(raw, "mime_type", "mimeType", "text/plain"),
    detectedMimeType: pick(raw, "detected_mime_type", "detectedMimeType"),
    contentKind: pick(raw, "content_kind", "contentKind", "plain_text"),
    readingHint: pick(raw, "reading_hint", "readingHint"),
    representation: pick(raw, "representation", "representation", "source"),
    byteLength: Number(pick(raw, "byte_length", "byteLength", 0)) || 0,
    status: pick(raw, "status", "status", "awaiting_upload"),
    contentHash: pick(raw, "content_hash", "contentHash", revision),
    revision,
    lineCount: nullableNumber(raw, "line_count", "lineCount"),
    projectionLineCount: nullableNumber(
      raw,
      "projection_line_count",
      "projectionLineCount",
    ),
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
  const rawDeliveredEventSeq = pick(
    raw,
    "delivered_event_seq",
    "deliveredEventSeq",
    pick(
      source,
      "delivered_event_seq",
      "deliveredEventSeq",
      events.at(-1)?.seq,
    ),
  );
  const deliveredEventSeq = Number(rawDeliveredEventSeq);
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
    runtimeProfile: pick(source, "runtime_profile", "runtimeProfile"),
    legacyMigration: pick(
      source,
      "legacy_migration",
      "legacyMigration",
      null,
    ),
    scope: pick(source, "scope", "scope", standalone ? "standalone" : "project"),
    providerId: pick(source, "provider_id", "providerId"),
    modelId: pick(source, "model_id", "modelId"),
    thinkingLevel: pick(source, "thinking_level", "thinkingLevel"),
    status: pick(source, "status", "status", "idle"),
    turnStatus: pick(source, "turn_status", "turnStatus"),
    activeTurnId: pick(source, "active_turn_id", "activeTurnId"),
    sessionPath: mapSessionPath(
      pick(source, "session_path", "sessionPath"),
    ),
    activeBranchId: pick(source, "active_branch_id", "activeBranchId"),
    activeBranchLabel: pick(
      source,
      "active_branch_label",
      "activeBranchLabel",
    ),
    fork: mapConversationFork(pick(source, "fork", "fork")),
    activeArtifactId: pick(source, "active_artifact_id", "activeArtifactId", "files"),
    messages: asArray(source.messages).map(mapMessage).filter(Boolean),
    hasMoreTurns: Boolean(
      pick(source, "has_more_turns", "hasMoreTurns", false),
    ),
    hasEarlierEvents: Boolean(
      pick(raw, "has_earlier_events", "hasEarlierEvents", false),
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
    deliveredEventSeq: Number.isSafeInteger(deliveredEventSeq)
      && deliveredEventSeq >= 0
      ? deliveredEventSeq
      : null,
    plan: planSteps.map((step, index) => mapPlanStep({
      ...step,
      title: step?.title ?? step?.text,
    }, index)).filter(Boolean),
    pendingChangeSet: changeSet,
    workspaceWrites: asArray(
      pick(source, "workspace_writes", "workspaceWrites", []),
    ).map((write) => ({
      id: pick(write, "write_id", "writeId", write?.id),
      turnId: pick(write, "turn_id", "turnId"),
      toolCallId: pick(write, "tool_call_id", "toolCallId"),
      path: safeProjectRelativePath(pick(write, "path", "path")),
      operation: pick(write, "operation", "operation", "update"),
      status: pick(write, "status", "status", "failed"),
      approvalMode: pick(write, "approval_mode", "approvalMode", "manual_review"),
      baseHash: pick(write, "base_hash", "baseHash"),
      afterHash: pick(write, "after_hash", "afterHash"),
      patch: pick(write, "patch", "patch", ""),
      createdAt: pick(write, "created_at", "createdAt"),
      completedAt: pick(write, "completed_at", "completedAt"),
      undo: pick(write, "undo", "undo"),
      error: pick(write, "error", "error"),
    })).filter((write) => typeof write.id === "string" && write.path),
    workspaceRuns: asArray(
      pick(source, "workspace_runs", "workspaceRuns", []),
    ).map((run) => ({
      id: pick(run, "request_id", "requestId", run?.id),
      runId: pick(run, "run_id", "runId"),
      turnId: pick(run, "turn_id", "turnId"),
      kind: pick(run, "kind", "kind", "custom"),
      status: pick(run, "status", "status", "failed"),
      executable: pick(run, "executable", "executable", ""),
      argv: asArray(pick(run, "argv", "argv", [])),
      relativeCwd: pick(run, "relative_cwd", "relativeCwd", "."),
      purpose: pick(run, "purpose", "purpose"),
      requestHash: pick(run, "request_hash", "requestHash"),
      exitCode: pick(run, "exit_code", "exitCode"),
      durationMs: pick(run, "duration_ms", "durationMs"),
      output: pick(run, "output", "output", ""),
      truncated: pick(run, "truncated", "truncated", false) === true,
      gitBefore: (() => {
        const evidence = pick(run, "git_before", "gitBefore");
        return evidence && typeof evidence === "object"
          ? mapProjectWorkGitEvidence(evidence)
          : null;
      })(),
      gitAfter: (() => {
        const evidence = pick(run, "git_after", "gitAfter");
        return evidence && typeof evidence === "object"
          ? mapProjectWorkGitEvidence(evidence)
          : null;
      })(),
      createdAt: pick(run, "created_at", "createdAt"),
      startedAt: pick(run, "started_at", "startedAt"),
      completedAt: pick(run, "completed_at", "completedAt"),
      error: pick(run, "error", "error"),
    })).filter((run) => typeof run.id === "string"),
    pendingChangeFileCount,
    verificationCommand,
    verificationRuns,
    gitCloseouts: asArray(
      pick(source, "git_closeouts", "gitCloseouts", []),
    ).map(mapProjectWorkGitCloseout).filter(Boolean),
    browserQaRuns: asArray(
      pick(source, "browser_qa_runs", "browserQaRuns", []),
    ).map(mapProjectWorkBrowserQaRun).filter(Boolean),
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
    generatedImages: asArray(
      pick(source, "generated_images", "generatedImages", []),
    ).map(mapGeneratedImage).filter(Boolean),
    generatedOfficeArtifacts: asArray(
      pick(
        source,
        "generated_office_artifacts",
        "generatedOfficeArtifacts",
        [],
      ),
    ).map(mapGeneratedOfficeArtifact).filter(Boolean),
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

export async function listProjectWorkWorkspaces({
  projectId,
  signal,
  fetchImpl,
} = {}) {
  requiredId(projectId, "projectId");
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/projects/${encodeURIComponent(projectId)}/workspaces`,
    { signal, fetchImpl },
  );
  return asArray(payload?.workspaces)
    .map(mapProjectWorkWorkspaceSummary)
    .filter(Boolean);
}

export async function createProjectWorkWorkspace({
  projectId,
  sourceWorkspaceId,
  expectedHead,
  branchName,
  title,
  label,
  signal,
  fetchImpl,
} = {}) {
  requiredId(projectId, "projectId");
  requiredId(sourceWorkspaceId, "sourceWorkspaceId");
  requiredId(expectedHead, "expectedHead");
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/projects/${encodeURIComponent(projectId)}/workspaces`,
    {
      method: "POST",
      body: {
        schema_version: 1,
        source_workspace_id: sourceWorkspaceId,
        expected_head: expectedHead,
        ...(typeof branchName === "string" && branchName.trim()
          ? { branch_name: branchName.trim() }
          : {}),
        ...(typeof title === "string" && title.trim()
          ? { title: title.trim() }
          : {}),
        ...(typeof label === "string" && label.trim()
          ? { label: label.trim() }
          : {}),
      },
      signal,
      fetchImpl,
    },
  );
  return mapProjectWorkWorkspaceSummary(payload?.workspace ?? payload);
}

export async function removeProjectWorkWorkspace({
  projectId,
  workspaceId,
  expectedHead,
  signal,
  fetchImpl,
} = {}) {
  requiredId(projectId, "projectId");
  requiredId(workspaceId, "workspaceId");
  requiredId(expectedHead, "expectedHead");
  await requestJson(
    `${PROJECT_WORK_API_ROOT}/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}`,
    {
      method: "DELETE",
      body: {
        schema_version: 1,
        expected_head: expectedHead,
      },
      signal,
      fetchImpl,
    },
  );
  return { projectId, workspaceId, removed: true };
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

function mapProviderConnection(raw) {
  const id = pick(raw, "id", "id");
  if (typeof id !== "string" || !id) return null;
  return {
    id,
    name: pick(raw, "name", "name", id),
    apiKeySupported: Boolean(
      pick(raw, "api_key_supported", "apiKeySupported", false),
    ),
    apiKeyLabel: pick(raw, "api_key_label", "apiKeyLabel"),
    oauthSupported: Boolean(
      pick(raw, "oauth_supported", "oauthSupported", false),
    ),
    oauthLabel: pick(raw, "oauth_label", "oauthLabel"),
    configured: Boolean(pick(raw, "configured", "configured", false)),
    configuredType: pick(raw, "configured_type", "configuredType"),
    configuredSource: pick(raw, "configured_source", "configuredSource"),
    stored: Boolean(pick(raw, "stored", "stored", false)),
    availableModelCount: Number(
      pick(raw, "available_model_count", "availableModelCount", 0),
    ) || 0,
  };
}

export async function fetchProjectWorkProviderConnections({
  signal,
  fetchImpl,
} = {}) {
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/provider-connections`,
    { signal, fetchImpl },
  );
  return asArray(payload?.providers).map(mapProviderConnection).filter(Boolean);
}

export async function saveProjectWorkProviderApiKey({
  providerId,
  apiKey,
  signal,
  fetchImpl,
} = {}) {
  requiredId(providerId, "providerId");
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    throw new TypeError("apiKey 必须是非空字符串");
  }
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/provider-connections/${encodeURIComponent(providerId)}`,
    {
      method: "PUT",
      body: {
        schema_version: 1,
        api_key: apiKey,
      },
      signal,
      fetchImpl,
    },
  );
  return asArray(payload?.providers).map(mapProviderConnection).filter(Boolean);
}

export async function removeProjectWorkProviderCredential({
  providerId,
  signal,
  fetchImpl,
} = {}) {
  requiredId(providerId, "providerId");
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/provider-connections/${encodeURIComponent(providerId)}`,
    {
      method: "DELETE",
      signal,
      fetchImpl,
    },
  );
  return asArray(payload?.providers).map(mapProviderConnection).filter(Boolean);
}

function mapSkillPackage(raw) {
  const name = pick(raw, "name", "name", pick(raw, "id", "id"));
  if (typeof name !== "string" || !name) return null;
  return {
    id: name,
    name,
    version: pick(raw, "version", "version"),
    description: pick(raw, "description", "description", ""),
    author: pick(raw, "author", "author", ""),
    types: asArray(pick(raw, "types", "types", [])),
    downloads: Number(pick(raw, "downloads", "downloads", 0)) || 0,
    publishedAt: pick(raw, "published_at", "publishedAt"),
    source: pick(raw, "source", "source"),
    catalogUrl: pick(raw, "catalog_url", "catalogUrl"),
    npmUrl: pick(raw, "npm_url", "npmUrl"),
    repoUrl: pick(raw, "repo_url", "repoUrl"),
    installSupported: Boolean(
      pick(raw, "install_supported", "installSupported", true),
    ),
    unsupportedReason: pick(raw, "unsupported_reason", "unsupportedReason"),
    installed: Boolean(pick(raw, "installed", "installed", false)),
    enabled: Boolean(pick(raw, "enabled", "enabled", false)),
    enabledPreference: Boolean(
      pick(
        raw,
        "enabled_preference",
        "enabledPreference",
        pick(raw, "enabled", "enabled", false),
      ),
    ),
    active: Boolean(
      pick(raw, "active", "active", pick(raw, "enabled", "enabled", false)),
    ),
    installedVersion: pick(raw, "installed_version", "installedVersion"),
    installedAt: pick(raw, "installed_at", "installedAt"),
    skillCount: Number(pick(raw, "skill_count", "skillCount", 0)) || 0,
    skillFiles: asArray(pick(raw, "skill_files", "skillFiles", [])),
    reviewed: Boolean(pick(raw, "reviewed", "reviewed", false)),
    runtimeCompatible: Boolean(
      pick(raw, "runtime_compatible", "runtimeCompatible", false),
    ),
    compatibilityStatus: pick(
      raw,
      "compatibility_status",
      "compatibilityStatus",
      "unreviewed",
    ),
    compatibilityReason: pick(
      raw,
      "compatibility_reason",
      "compatibilityReason",
      "",
    ),
    requiredRuntimeCapabilities: asArray(
      pick(
        raw,
        "required_runtime_capabilities",
        "requiredRuntimeCapabilities",
        [],
      ),
    ),
    missingRuntimeCapabilities: asArray(
      pick(
        raw,
        "missing_runtime_capabilities",
        "missingRuntimeCapabilities",
        [],
      ),
    ),
    effectScopes: asArray(pick(raw, "effect_scopes", "effectScopes", [])),
  };
}

export async function fetchProjectWorkSkillCatalog({
  query = "",
  sort = "downloads",
  signal,
  fetchImpl,
} = {}) {
  const search = new URLSearchParams();
  if (query.trim()) search.set("query", query.trim());
  search.set("sort", sort);
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/skills?${search.toString()}`,
    { signal, fetchImpl },
  );
  return {
    source: pick(payload, "source", "source"),
    query: pick(payload, "query", "query", ""),
    sort: pick(payload, "sort", "sort", sort),
    packages: asArray(payload?.packages).map(mapSkillPackage).filter(Boolean),
  };
}

export async function fetchInstalledProjectWorkSkills({ signal, fetchImpl } = {}) {
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/skills/installed`,
    { signal, fetchImpl },
  );
  return {
    revision: Number(pick(payload, "revision", "revision", 0)) || 0,
    packages: asArray(payload?.packages).map(mapSkillPackage).filter(Boolean),
  };
}

export async function inspectProjectWorkSkillPackage({
  name,
  version,
  signal,
  fetchImpl,
} = {}) {
  requiredId(name, "name");
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/skill-previews`,
    {
      method: "POST",
      body: {
        schema_version: 1,
        name,
        version,
      },
      signal,
      fetchImpl,
    },
  );
  return {
    previewId: pick(payload, "preview_id", "previewId"),
    previewHash: pick(payload, "preview_hash", "previewHash"),
    name: pick(payload, "name", "name"),
    version: pick(payload, "version", "version"),
    source: pick(payload, "source", "source"),
    description: pick(payload, "description", "description", ""),
    integrity: pick(payload, "integrity", "integrity"),
    skillFiles: asArray(pick(payload, "skill_files", "skillFiles", [])),
    skillCount: Number(pick(payload, "skill_count", "skillCount", 0)) || 0,
    archiveFileCount: Number(
      pick(payload, "archive_file_count", "archiveFileCount", 0),
    ) || 0,
    archiveBytes: Number(pick(payload, "archive_bytes", "archiveBytes", 0)) || 0,
    defaultEnabled: Boolean(
      pick(payload, "default_enabled", "defaultEnabled", false),
    ),
    reviewMode: pick(payload, "review_mode", "reviewMode", "install"),
    installedVersion: pick(payload, "installed_version", "installedVersion"),
    skillDocuments: asArray(
      pick(payload, "skill_documents", "skillDocuments", []),
    ),
    skillDiffs: asArray(pick(payload, "skill_diffs", "skillDiffs", [])),
    reviewed: Boolean(pick(payload, "reviewed", "reviewed", false)),
    runtimeCompatible: Boolean(
      pick(payload, "runtime_compatible", "runtimeCompatible", false),
    ),
    compatibilityStatus: pick(
      payload,
      "compatibility_status",
      "compatibilityStatus",
      "unreviewed",
    ),
    compatibilityReason: pick(
      payload,
      "compatibility_reason",
      "compatibilityReason",
      "",
    ),
    requiredRuntimeCapabilities: asArray(
      pick(
        payload,
        "required_runtime_capabilities",
        "requiredRuntimeCapabilities",
        [],
      ),
    ),
    missingRuntimeCapabilities: asArray(
      pick(
        payload,
        "missing_runtime_capabilities",
        "missingRuntimeCapabilities",
        [],
      ),
    ),
    effectScopes: asArray(pick(payload, "effect_scopes", "effectScopes", [])),
    expiresAt: pick(payload, "expires_at", "expiresAt"),
  };
}

export async function installProjectWorkSkillPackage({
  previewId,
  previewHash,
  signal,
  fetchImpl,
} = {}) {
  requiredId(previewId, "previewId");
  requiredId(previewHash, "previewHash");
  const payload = await requestJson(`${PROJECT_WORK_API_ROOT}/skills`, {
    method: "POST",
    body: {
      schema_version: 1,
      preview_id: previewId,
      preview_hash: previewHash,
    },
    signal,
    fetchImpl,
  });
  return mapSkillPackage(payload);
}

export async function setProjectWorkSkillEnabled({
  name,
  enabled,
  signal,
  fetchImpl,
} = {}) {
  requiredId(name, "name");
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/skills/${encodeURIComponent(name)}`,
    {
      method: "PATCH",
      body: {
        schema_version: 1,
        enabled: enabled === true,
      },
      signal,
      fetchImpl,
    },
  );
  return mapSkillPackage(payload);
}

function mapUsageValues(raw) {
  return {
    calls: nullableNumber(raw, "calls", "calls") ?? 0,
    tasks: nullableNumber(raw, "tasks", "tasks") ?? 0,
    conversations: nullableNumber(raw, "conversations", "conversations") ?? 0,
    inputTokens: nullableNumber(raw, "input_tokens", "inputTokens") ?? 0,
    outputTokens: nullableNumber(raw, "output_tokens", "outputTokens") ?? 0,
    cacheReadTokens: nullableNumber(
      raw,
      "cache_read_tokens",
      "cacheReadTokens",
    ) ?? 0,
    cacheWriteTokens: nullableNumber(
      raw,
      "cache_write_tokens",
      "cacheWriteTokens",
    ) ?? 0,
    totalTokens: nullableNumber(raw, "total_tokens", "totalTokens") ?? 0,
    apiEquivalentCostUsd: nullableNumber(
      raw,
      "api_equivalent_cost_usd",
      "apiEquivalentCostUsd",
    ),
    pricedCallCount: nullableNumber(
      raw,
      "priced_call_count",
      "pricedCallCount",
    ) ?? 0,
    unpricedCallCount: nullableNumber(
      raw,
      "unpriced_call_count",
      "unpricedCallCount",
    ) ?? 0,
    historicalBackfilledCallCount: nullableNumber(
      raw,
      "historical_backfilled_call_count",
      "historicalBackfilledCallCount",
    ) ?? 0,
  };
}

export function mapProjectWorkUsage(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw
    : {};
  const coverage = source.coverage
    && typeof source.coverage === "object"
    && !Array.isArray(source.coverage)
    ? source.coverage
    : {};
  return {
    scope: pick(source, "scope", "scope", "retained_conversations"),
    workflowScope: pick(
      source,
      "workflow_scope",
      "workflowScope",
      "project_work",
    ),
    source: pick(source, "source", "source", "durable_pi_turn_evidence"),
    costSemantics: pick(
      source,
      "cost_semantics",
      "costSemantics",
      "api_equivalent_estimate",
    ),
    period: pick(source, "period", "period", "30d"),
    periodStart: pick(source, "period_start", "periodStart"),
    periodEnd: pick(source, "period_end", "periodEnd"),
    generatedAt: pick(source, "generated_at", "generatedAt"),
    quota: {
      available: pick(source.quota, "available", "available", false) === true,
      detail: pick(source.quota, "detail", "detail", "账户剩余额度不可获取"),
    },
    totals: mapUsageValues(source.totals),
    coverage: {
      conversationsScanned: nullableNumber(
        coverage,
        "conversations_scanned",
        "conversationsScanned",
      ) ?? 0,
      legacyMessagesWithoutUsage: nullableNumber(
        coverage,
        "legacy_messages_without_usage",
        "legacyMessagesWithoutUsage",
      ) ?? 0,
      undatedAssistantMessages: nullableNumber(
        coverage,
        "undated_assistant_messages",
        "undatedAssistantMessages",
      ) ?? 0,
      includedKinds: asArray(
        pick(coverage, "included_kinds", "includedKinds", []),
      ),
      excludedKinds: asArray(
        pick(coverage, "excluded_kinds", "excludedKinds", []),
      ),
      accessIssues: asArray(
        pick(coverage, "access_issues", "accessIssues", []),
      ).map((issue) => ({
        workflowScope: pick(
          issue,
          "workflow_scope",
          "workflowScope",
          "unknown",
        ),
        code: pick(issue, "code", "code", "USAGE_UNAVAILABLE"),
        message: pick(
          issue,
          "message",
          "message",
          "部分模型用量暂时无法读取",
        ),
      })),
      historicalLowerBound: pick(
        coverage,
        "historical_lower_bound",
        "historicalLowerBound",
        false,
      ) === true,
      historicalBackfilledCallCount: nullableNumber(
        coverage,
        "historical_backfilled_call_count",
        "historicalBackfilledCallCount",
      ) ?? 0,
      historicalTestCallCount: nullableNumber(
        coverage,
        "historical_test_call_count",
        "historicalTestCallCount",
      ) ?? 0,
      legacyTranslationArtifactsWithoutUsage: nullableNumber(
        coverage,
        "legacy_translation_artifacts_without_usage",
        "legacyTranslationArtifactsWithoutUsage",
      ) ?? 0,
    },
    workflows: asArray(source.workflows).flatMap((workflow) => {
      const workflowScope = pick(
        workflow,
        "workflow_scope",
        "workflowScope",
      );
      if (!workflowScope) return [];
      return [{
        workflowScope,
        totals: mapUsageValues(workflow.totals),
        coverage: pick(workflow, "coverage", "coverage", {}),
      }];
    }),
    models: asArray(source.models).flatMap((model) => {
      const providerId = pick(model, "provider_id", "providerId");
      const modelId = pick(model, "model_id", "modelId");
      if (!providerId || !modelId) return [];
      return [{
        providerId,
        providerName: pick(
          model,
          "provider_name",
          "providerName",
          providerId,
        ),
        modelId,
        modelName: pick(model, "model_name", "modelName", modelId),
        billingKind: pick(model, "billing_kind", "billingKind", "unknown"),
        workflowScope: pick(
          model,
          "workflow_scope",
          "workflowScope",
          pick(
            source,
            "workflow_scope",
            "workflowScope",
            "project_work",
          ),
        ),
        ...mapUsageValues(model),
        lastUsedAt: pick(model, "last_used_at", "lastUsedAt"),
        stepBreakdown: asArray(
          pick(model, "step_breakdown", "stepBreakdown", []),
        ).flatMap((item) => {
          const step = pick(item, "step", "step");
          if (!step) return [];
          return [{
            step,
            calls: nullableNumber(item, "calls", "calls") ?? 0,
          }];
        }),
        currentPricing: mapModelPricing(
          pick(model, "current_pricing", "currentPricing"),
        ),
      }];
    }),
  };
}

export async function fetchModelUsage({
  period = "30d",
  workflow = "all",
  signal,
  fetchImpl,
} = {}) {
  if (!["today", "7d", "30d", "all"].includes(period)) {
    throw new TypeError("模型用量时间范围无效");
  }
  if (!["all", "project_work", "paper_reading"].includes(workflow)) {
    throw new TypeError("模型用量工作类型无效");
  }
  const params = new URLSearchParams({ period, workflow });
  const payload = await requestJson(
    `/api/v1/model-usage?${params.toString()}`,
    { signal, fetchImpl },
  );
  return mapProjectWorkUsage(payload);
}

export async function fetchProjectWorkUsage({
  period = "30d",
  signal,
  fetchImpl,
} = {}) {
  if (!["today", "7d", "30d", "all"].includes(period)) {
    throw new TypeError("模型用量时间范围无效");
  }
  const params = new URLSearchParams({ period });
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/usage?${params.toString()}`,
    { signal, fetchImpl },
  );
  return mapProjectWorkUsage(payload);
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
  workspaceId,
  title,
  providerId,
  modelId,
  thinkingLevel,
  executionPolicyMode,
  signal,
  fetchImpl,
} = {}) {
  requiredId(projectId, "projectId");
  if (
    executionPolicyMode !== undefined
    && !["manual_review", "auto_review"].includes(executionPolicyMode)
  ) {
    throw new TypeError("executionPolicyMode 必须是 manual_review 或 auto_review");
  }
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/projects/${encodeURIComponent(projectId)}/conversations`,
    {
      method: "POST",
      body: {
        schema_version: 1,
        ...(workspaceId ? { workspace_id: workspaceId } : {}),
        ...(typeof title === "string" && title.trim()
          ? { title: title.trim() }
          : {}),
        ...(providerId ? { provider_id: providerId } : {}),
        ...(modelId ? { model_id: modelId } : {}),
        ...(thinkingLevel ? { thinking_level: thinkingLevel } : {}),
        ...(executionPolicyMode
          ? { execution_policy_mode: executionPolicyMode }
          : {}),
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
  executionPolicyMode,
  signal,
  fetchImpl,
} = {}) {
  if (
    executionPolicyMode !== undefined
    && !["manual_review", "auto_review"].includes(executionPolicyMode)
  ) {
    throw new TypeError("executionPolicyMode 必须是 manual_review 或 auto_review");
  }
  const payload = await requestJson(`${PROJECT_WORK_API_ROOT}/conversations`, {
    method: "POST",
    body: {
      schema_version: 1,
      ...(providerId ? { provider_id: providerId } : {}),
      ...(modelId ? { model_id: modelId } : {}),
      ...(thinkingLevel ? { thinking_level: thinkingLevel } : {}),
      ...(executionPolicyMode
        ? { execution_policy_mode: executionPolicyMode }
        : {}),
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
  includeActivity = true,
  signal,
  fetchImpl,
} = {}) {
  requiredId(conversationId, "conversationId");
  const basePath = `${PROJECT_WORK_API_ROOT}/conversations/${encodeURIComponent(conversationId)}`
    + (includeActivity ? "" : "?activity=none");
  const payload = await requestJson(basePath, { signal, fetchImpl });
  const events = asArray(payload?.events);
  const afterSeq = Number(events.at(-1)?.seq) || Number(
    payload?.conversation?.last_event_seq
      ?? payload?.conversation?.lastEventSeq
      ?? 0,
  );
  return mapProjectWorkConversation({
    ...payload,
    events,
    deliveredEventSeq: afterSeq,
    hasMoreEvents: Boolean(payload?.hasMoreEvents ?? payload?.has_more_events),
  });
}

export function subscribeProjectWorkConversation({
  conversationId,
  afterSeq = 0,
  onConversation,
  onEvent,
  onResync,
  onConnectionState,
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
        deliveredEventSeq: Number(
          payload.last_seq ?? payload.lastSeq ?? payload.events?.at(-1)?.seq,
        ),
        hasMoreEvents: Boolean(payload.has_more ?? payload.hasMoreEvents),
      }), {
        events: asArray(payload.events),
        snapshotWatermark: Number(
          payload.snapshot_watermark ?? payload.snapshotWatermark ?? 0,
        ) || 0,
        lastSeq: Number(payload.last_seq ?? payload.lastSeq ?? 0) || 0,
      });
      onConnectionState?.("connected");
    } catch (error) {
      onError?.(error);
    }
  };
  const handleDelta = (event) => {
    try {
      const payload = JSON.parse(event.data);
      const mapped = mapEvent(payload);
      if (!mapped) throw new Error("项目工作事件增量格式无效");
      onEvent?.(mapped, {
        lastSeq: mapped.seq,
        sessionId: pick(payload, "session_id", "sessionId"),
      });
      onConnectionState?.("connected");
    } catch (error) {
      onError?.(error);
    }
  };
  const handleResync = (event) => {
    try {
      const payload = JSON.parse(event.data);
      onResync?.({
        reason: payload?.reason ?? "event_gap",
        lastAvailableSeq: Number(
          payload?.last_available_seq ?? payload?.lastAvailableSeq ?? 0,
        ) || 0,
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
    onConnectionState?.("reconnecting", event);
  };
  const handleOpen = () => onConnectionState?.("connected");
  source.addEventListener("snapshot", handleSnapshot);
  source.addEventListener("delta", handleDelta);
  source.addEventListener("resync_required", handleResync);
  source.addEventListener("stream_error", handleStreamError);
  source.addEventListener("open", handleOpen);
  source.addEventListener("error", handleConnectionError);
  return () => {
    source.removeEventListener?.("snapshot", handleSnapshot);
    source.removeEventListener?.("delta", handleDelta);
    source.removeEventListener?.("resync_required", handleResync);
    source.removeEventListener?.("stream_error", handleStreamError);
    source.removeEventListener?.("open", handleOpen);
    source.removeEventListener?.("error", handleConnectionError);
    source.close();
  };
}

export async function sendProjectWorkMessage({
  conversationId,
  text,
  checkpointId,
  contexts = [],
  images = [],
  attachments = [],
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
  const normalizedCheckpointId = checkpointId === undefined
    ? null
    : requiredId(checkpointId, "checkpointId").trim();
  if (typeof text !== "string" || !text.trim()) throw new TypeError("text 必须是非空字符串");
  if (!Array.isArray(images) || images.length > 1) {
    throw new TypeError("每条消息最多添加一张图片");
  }
  if (
    !Array.isArray(attachments)
    || attachments.length > MAX_PROJECT_WORK_TEXT_ATTACHMENTS
  ) {
    throw new TypeError(
      `每条消息最多添加 ${MAX_PROJECT_WORK_TEXT_ATTACHMENTS} 个文本或代码文件`,
    );
  }
  const serializedImages = await Promise.all(images.map(serializeProjectWorkImage));
  const serializedAttachments = attachments.map(
    serializeProjectWorkAttachmentReference,
  );
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/conversations/${encodeURIComponent(conversationId)}/messages`,
    {
      method: "POST",
      body: {
        schema_version: 1,
        client_request_id: requestId,
        text: text.trim(),
        ...(normalizedCheckpointId
          ? { checkpoint_message_id: normalizedCheckpointId }
          : {}),
        images: serializedImages,
        attachments: serializedAttachments,
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

export async function uploadProjectWorkAttachment({
  conversationId,
  file,
  signal,
  fetchImpl,
} = {}) {
  requiredId(conversationId, "conversationId");
  validateProjectWorkTextAttachmentFile(file);
  const created = await requestJson(
    `${PROJECT_WORK_API_ROOT}/conversations/${encodeURIComponent(conversationId)}/attachments`,
    {
      method: "POST",
      body: {
        schema_version: 1,
        file_name: file.name,
        mime_type: file.type || "text/plain",
        byte_length: file.size,
      },
      signal,
      fetchImpl,
    },
  );
  const attachment = mapProjectWorkAttachment(created?.attachment);
  if (!attachment) {
    throw new Error("项目工作服务没有返回有效的普通附件记录");
  }
  try {
    const uploaded = await requestAttachmentContent(
      `${PROJECT_WORK_API_ROOT}/conversations/${encodeURIComponent(conversationId)}/attachments/${encodeURIComponent(attachment.id)}/content`,
      file,
      { signal, fetchImpl },
    );
    const ready = mapProjectWorkAttachment(uploaded?.attachment);
    if (!ready || ready.status !== "ready" || !ready.revision) {
      throw new Error("普通附件上传完成后缺少可读取版本");
    }
    return ready;
  } catch (error) {
    await removeProjectWorkAttachment({
      conversationId,
      attachmentId: attachment.id,
      fetchImpl,
    }).catch(() => undefined);
    throw error;
  }
}

export async function removeProjectWorkAttachment({
  conversationId,
  attachmentId,
  signal,
  fetchImpl,
} = {}) {
  requiredId(conversationId, "conversationId");
  requiredId(attachmentId, "attachmentId");
  return requestJson(
    `${PROJECT_WORK_API_ROOT}/conversations/${encodeURIComponent(conversationId)}/attachments/${encodeURIComponent(attachmentId)}`,
    {
      method: "DELETE",
      signal,
      fetchImpl,
    },
  );
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
  if (
    thinkingLevel !== undefined
    && (typeof thinkingLevel !== "string" || !thinkingLevel.trim())
  ) {
    throw new TypeError("thinkingLevel 必须是非空字符串");
  }
  const normalizedThinkingLevel = typeof thinkingLevel === "string"
    ? thinkingLevel.trim()
    : "";
  if (!providerId && !modelId && !normalizedThinkingLevel) {
    throw new TypeError("至少需要 providerId、modelId 或 thinkingLevel 之一");
  }
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/conversations/${encodeURIComponent(conversationId)}/configuration`,
    {
      method: "POST",
      body: {
        schema_version: 1,
        ...(providerId ? { provider_id: providerId } : {}),
        ...(modelId ? { model_id: modelId } : {}),
        ...(normalizedThinkingLevel
          ? { thinking_level: normalizedThinkingLevel }
          : {}),
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
  checkpointId,
  clientRequestId = createRequestId("project-retry"),
  signal,
  fetchImpl,
} = {}) {
  requiredId(conversationId, "conversationId");
  const normalizedCheckpointId = checkpointId === undefined
    ? null
    : requiredId(checkpointId, "checkpointId").trim();
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/conversations/${encodeURIComponent(conversationId)}/retry-last-turn`,
    {
      method: "POST",
      body: {
        schema_version: 1,
        client_request_id: clientRequestId,
        ...(normalizedCheckpointId
          ? { checkpoint_id: normalizedCheckpointId }
          : {}),
      },
      signal,
      fetchImpl,
    },
  );
  return mapProjectWorkConversation(payload);
}

export function retryProjectWorkCheckpoint(options = {}) {
  requiredId(options.checkpointId, "checkpointId");
  return retryProjectWorkLastTurn(options);
}

export async function forkProjectWorkCheckpoint({
  conversationId,
  checkpointId,
  clientRequestId = createRequestId("project-fork"),
  signal,
  fetchImpl,
} = {}) {
  requiredId(conversationId, "conversationId");
  const normalizedCheckpointId = requiredId(
    checkpointId,
    "checkpointId",
  ).trim();
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/conversations/${encodeURIComponent(conversationId)}/forks`,
    {
      method: "POST",
      body: {
        schema_version: 1,
        client_request_id: clientRequestId,
        checkpoint_id: normalizedCheckpointId,
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

export function projectWorkGeneratedImageUrl({
  conversationId,
  imageId,
} = {}) {
  requiredId(conversationId, "conversationId");
  requiredId(imageId, "imageId");
  return `${PROJECT_WORK_API_ROOT}/conversations/${
    encodeURIComponent(conversationId)
  }/generated-images/${encodeURIComponent(imageId)}/content`;
}

export function projectWorkGeneratedOfficeDownloadUrl({
  conversationId,
  artifactId,
} = {}) {
  requiredId(conversationId, "conversationId");
  requiredId(artifactId, "artifactId");
  return `${PROJECT_WORK_API_ROOT}/conversations/${
    encodeURIComponent(conversationId)
  }/generated-office/${encodeURIComponent(artifactId)}/download`;
}

export async function fetchProjectWorkFile({
  projectId,
  conversationId,
  path,
  startLine: requestedStartLine,
  endLine: requestedEndLine,
  expectedContentHash,
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
  if (expectedContentHash !== undefined && expectedContentHash !== null) {
    if (
      typeof expectedContentHash !== "string"
      || !SHA256_PATTERN.test(expectedContentHash)
    ) {
      throw new TypeError("expectedContentHash 必须是有效的内容哈希");
    }
    query.set("content_hash", expectedContentHash);
  }
  if (Number.isSafeInteger(requestedStartLine) && requestedStartLine > 0) {
    query.set("start_line", String(requestedStartLine));
  }
  if (
    Number.isSafeInteger(requestedEndLine)
    && requestedEndLine >= (
      Number.isSafeInteger(requestedStartLine) ? requestedStartLine : 1
    )
  ) {
    query.set("end_line", String(requestedEndLine));
  }
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

export function projectWorkLegacyMigrationPatchUrl({
  conversationId,
  changeSetId,
  changeSetHash,
} = {}) {
  requiredId(conversationId, "conversationId");
  requiredId(changeSetId, "changeSetId");
  const normalizedHash = requiredId(changeSetHash, "changeSetHash");
  if (!SHA256_PATTERN.test(normalizedHash)) {
    throw new TypeError("changeSetHash 必须是完整的 SHA-256 哈希");
  }
  const query = new URLSearchParams({ change_set_hash: normalizedHash });
  return `${PROJECT_WORK_API_ROOT}/conversations/${encodeURIComponent(conversationId)}/legacy-migration/change-sets/${encodeURIComponent(changeSetId)}/export?${query.toString()}`;
}

export async function abandonProjectWorkLegacyMigrationChanges({
  conversationId,
  changeSetId,
  changeSetHash,
  clientRequestId = createRequestId("legacy-migration-abandon"),
  signal,
  fetchImpl,
} = {}) {
  requiredId(conversationId, "conversationId");
  requiredId(changeSetId, "changeSetId");
  const normalizedHash = requiredId(changeSetHash, "changeSetHash");
  if (!SHA256_PATTERN.test(normalizedHash)) {
    throw new TypeError("changeSetHash 必须是完整的 SHA-256 哈希");
  }
  if (!PROJECT_WORK_CLIENT_REQUEST_ID_PATTERN.test(clientRequestId)) {
    throw new TypeError("clientRequestId 格式无效");
  }
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/conversations/${encodeURIComponent(conversationId)}/legacy-migration/change-sets/${encodeURIComponent(changeSetId)}/abandon`,
    {
      method: "POST",
      body: {
        schema_version: 1,
        client_request_id: clientRequestId,
        change_set_hash: normalizedHash,
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

export async function fetchProjectWorkGitCloseouts({
  conversationId,
  signal,
  fetchImpl,
} = {}) {
  requiredId(conversationId, "conversationId");
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/conversations/${encodeURIComponent(conversationId)}/git-closeouts`,
    { signal, fetchImpl },
  );
  return asArray(
    pick(payload, "git_closeouts", "gitCloseouts", []),
  ).map(mapProjectWorkGitCloseout).filter(Boolean);
}

export async function confirmProjectWorkGitCloseout({
  conversationId,
  proposal,
  signal,
  fetchImpl,
} = {}) {
  requiredId(conversationId, "conversationId");
  const proposalId = requiredId(proposal?.id, "proposal.id");
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/conversations/${
      encodeURIComponent(conversationId)
    }/git-closeouts/${encodeURIComponent(proposalId)}/confirm`,
    {
      method: "POST",
      body: {
        schema_version: 1,
        proposal_id: proposalId,
        proposal_hash: proposal.proposalHash,
        conversation_id: proposal.conversationId,
        turn_id: proposal.turnId,
        change_set_id: proposal.changeSetId,
        change_set_hash: proposal.changeSetHash,
        branch: proposal.branch,
        head: proposal.head,
        commit_message: proposal.commitMessage,
        files: asArray(proposal.files).map((file) => ({
          path: file.path,
          hash: file.hash,
          exists: file.exists === true,
          mode: file.mode,
          base_hash: file.baseHash,
          base_exists: file.baseExists === true,
          base_mode: file.baseMode,
        })),
        verification_evidence: asArray(
          proposal.verificationEvidence,
        ).map((evidence) => ({
          id: evidence.id,
          command_id: evidence.commandId,
          status: evidence.status,
          exit_code: evidence.exitCode,
          change_set_id: evidence.changeSetId,
          change_set_hash: evidence.changeSetHash,
          command_binding_hash: evidence.commandBindingHash,
          completed_at: evidence.completedAt,
        })),
      },
      signal,
      fetchImpl,
    },
  );
  return mapProjectWorkConversation(payload);
}

export async function runProjectWorkBrowserQa({
  conversationId,
  clientRequestId = createRequestId("project-browser-qa"),
  signal,
  fetchImpl,
} = {}) {
  requiredId(conversationId, "conversationId");
  const normalizedClientRequestId = requiredId(
    clientRequestId,
    "clientRequestId",
  ).trim();
  if (!PROJECT_WORK_CLIENT_REQUEST_ID_PATTERN.test(normalizedClientRequestId)) {
    throw new TypeError("clientRequestId 格式无效");
  }
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/conversations/${
      encodeURIComponent(conversationId)
    }/browser-qa`,
    {
      method: "POST",
      body: {
        schema_version: 1,
        client_request_id: normalizedClientRequestId,
      },
      signal,
      fetchImpl,
    },
  );
  return mapProjectWorkConversation(payload);
}

export function projectWorkBrowserQaScreenshotUrl({
  conversationId,
  runId,
  profileId,
} = {}) {
  requiredId(conversationId, "conversationId");
  requiredId(runId, "runId");
  if (!["desktop", "mobile"].includes(profileId)) {
    throw new TypeError("profileId 必须是 desktop 或 mobile");
  }
  return `${PROJECT_WORK_API_ROOT}/conversations/${
    encodeURIComponent(conversationId)
  }/browser-qa/${encodeURIComponent(runId)}/${
    encodeURIComponent(profileId)
  }/screenshot`;
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

export async function confirmProjectWorkWorkspaceWrite({
  conversationId,
  writeId,
  clientRequestId = createRequestId("project-workspace-write"),
  signal,
  fetchImpl,
} = {}) {
  requiredId(conversationId, "conversationId");
  requiredId(writeId, "writeId");
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/conversations/${encodeURIComponent(conversationId)}/workspace-writes/${encodeURIComponent(writeId)}/confirm`,
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

export async function confirmProjectWorkWorkspaceRun({
  conversationId,
  requestId,
  requestHash,
  clientRequestId = createRequestId("project-workspace-run"),
  signal,
  fetchImpl,
} = {}) {
  requiredId(conversationId, "conversationId");
  requiredId(requestId, "requestId");
  requiredId(requestHash, "requestHash");
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/conversations/${encodeURIComponent(conversationId)}/workspace-runs/${encodeURIComponent(requestId)}/confirm`,
    {
      method: "POST",
      body: {
        schema_version: 1,
        client_request_id: clientRequestId,
        request_hash: requestHash,
      },
      signal,
      fetchImpl,
    },
  );
  return mapProjectWorkConversation(payload);
}

export async function cancelProjectWorkWorkspaceRun({
  conversationId,
  requestId,
  clientRequestId = createRequestId("project-workspace-run"),
  signal,
  fetchImpl,
} = {}) {
  requiredId(conversationId, "conversationId");
  requiredId(requestId, "requestId");
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/conversations/${encodeURIComponent(conversationId)}/workspace-runs/${encodeURIComponent(requestId)}/cancel`,
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

export async function getProjectWorkWorkspaceRun({
  conversationId,
  runId,
  afterSeq = 0,
  limit = 500,
  signal,
  fetchImpl,
} = {}) {
  requiredId(conversationId, "conversationId");
  requiredId(runId, "runId");
  const query = new URLSearchParams({
    after_seq: String(Math.max(0, Number(afterSeq) || 0)),
    limit: String(Math.max(1, Math.min(1_000, Number(limit) || 500))),
  });
  return requestJson(
    `${PROJECT_WORK_API_ROOT}/conversations/${encodeURIComponent(conversationId)}/workspace-runs/${encodeURIComponent(runId)}?${query}`,
    { signal, fetchImpl },
  );
}

export async function cancelProjectWorkWorkspaceWrite({
  conversationId,
  writeId,
  clientRequestId = createRequestId("project-workspace-write"),
  signal,
  fetchImpl,
} = {}) {
  requiredId(conversationId, "conversationId");
  requiredId(writeId, "writeId");
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/conversations/${encodeURIComponent(conversationId)}/workspace-writes/${encodeURIComponent(writeId)}/cancel`,
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

function mapLegacyWorkspaceArchiveItem(value) {
  if (!value || typeof value !== "object") return null;
  const conversationId = pick(value, "conversation_id", "conversationId", "");
  if (!conversationId) return null;
  const rawBytes = pick(value, "bytes", "bytes", null);
  const rawFileCount = pick(value, "file_count", "fileCount", null);
  return {
    conversationId,
    title: String(pick(value, "title", "title", "未命名会话")),
    parts: asArray(pick(value, "parts", "parts", [])),
    archiveHash: pick(value, "archive_hash", "archiveHash", null),
    bytes: rawBytes !== null && Number.isSafeInteger(Number(rawBytes))
      ? Number(rawBytes)
      : null,
    fileCount: rawFileCount !== null && Number.isSafeInteger(Number(rawFileCount))
      ? Number(rawFileCount)
      : null,
    cleanupEligible: Boolean(pick(value, "cleanup_eligible", "cleanupEligible", false)),
    blockedReason: pick(value, "blocked_reason", "blockedReason", null),
  };
}

export function mapLegacyWorkspaceArchiveSummary(value) {
  const items = asArray(pick(value, "items", "items", []))
    .map(mapLegacyWorkspaceArchiveItem)
    .filter(Boolean);
  return {
    schemaVersion: Number(pick(value, "schema_version", "schemaVersion", 1)) || 1,
    totalBytes: Math.max(0, Number(pick(value, "total_bytes", "totalBytes", 0)) || 0),
    totalFileCount: Math.max(
      0,
      Number(pick(value, "total_file_count", "totalFileCount", 0)) || 0,
    ),
    itemCount: Math.max(0, Number(pick(value, "item_count", "itemCount", items.length)) || 0),
    cleanupEligibleCount: Math.max(
      0,
      Number(pick(value, "cleanup_eligible_count", "cleanupEligibleCount", 0)) || 0,
    ),
    mutationOrigin: String(pick(value, "mutation_origin", "mutationOrigin", "")),
    items,
  };
}

export async function fetchLegacyWorkspaceArchives({ signal, fetchImpl } = {}) {
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/legacy-workspace-archives`,
    { signal, fetchImpl },
  );
  return mapLegacyWorkspaceArchiveSummary(payload);
}

export async function cleanupLegacyWorkspaceArchives({
  mutationOrigin,
  items,
  signal,
  fetchImpl,
} = {}) {
  requiredId(mutationOrigin, "mutationOrigin");
  if (!SHA256_PATTERN.test(mutationOrigin) || !Array.isArray(items) || items.length < 1) {
    throw new TypeError("旧工作副本清理绑定无效");
  }
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/legacy-workspace-archives/cleanup`,
    {
      method: "POST",
      body: {
        schema_version: 1,
        mutation_origin: mutationOrigin,
        items: items.map((item) => ({
          conversation_id: requiredId(item?.conversationId, "conversationId"),
          archive_hash: requiredId(item?.archiveHash, "archiveHash"),
          bytes: Number(item?.bytes),
        })),
      },
      signal,
      fetchImpl,
    },
  );
  return mapLegacyWorkspaceArchiveSummary(payload);
}

export const projectWorkApi = {
  listProjects: listProjectWorkProjects,
  listWorkspaces: listProjectWorkWorkspaces,
  listModels: fetchProjectWorkModels,
  listProviderConnections: fetchProjectWorkProviderConnections,
  saveProviderApiKey: saveProjectWorkProviderApiKey,
  removeProviderCredential: removeProjectWorkProviderCredential,
  listSkillCatalog: fetchProjectWorkSkillCatalog,
  listInstalledSkills: fetchInstalledProjectWorkSkills,
  inspectSkillPackage: inspectProjectWorkSkillPackage,
  installSkillPackage: installProjectWorkSkillPackage,
  setSkillEnabled: setProjectWorkSkillEnabled,
  getUsage: fetchModelUsage,
  getProjectUsage: fetchProjectWorkUsage,
  fetchLegacyWorkspaceArchives,
  cleanupLegacyWorkspaceArchives,
  pickRoot: pickProjectWorkRoot,
  registerProject: registerProjectWorkProject,
  createWorkspace: createProjectWorkWorkspace,
  removeWorkspace: removeProjectWorkWorkspace,
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
  retryCheckpoint: retryProjectWorkCheckpoint,
  forkCheckpoint: forkProjectWorkCheckpoint,
  resumeVerificationRepair: resumeProjectWorkVerificationRepair,
  fetchTree: fetchProjectWorkTree,
  fetchFile: fetchProjectWorkFile,
  imageUrl: projectWorkImageUrl,
  generatedImageUrl: projectWorkGeneratedImageUrl,
  generatedOfficeDownloadUrl: projectWorkGeneratedOfficeDownloadUrl,
  uploadAttachment: uploadProjectWorkAttachment,
  removeAttachment: removeProjectWorkAttachment,
  uploadPdf: uploadProjectWorkPdf,
  retryPdf: retryProjectWorkPdf,
  removePdf: removeProjectWorkPdf,
  applyChangeSet: applyProjectWorkChangeSet,
  legacyMigrationPatchUrl: projectWorkLegacyMigrationPatchUrl,
  abandonLegacyMigrationChanges: abandonProjectWorkLegacyMigrationChanges,
  confirmWorkspaceRun: confirmProjectWorkWorkspaceRun,
  cancelWorkspaceRun: cancelProjectWorkWorkspaceRun,
  fetchWorkspaceRun: getProjectWorkWorkspaceRun,
  confirmWorkspaceWrite: confirmProjectWorkWorkspaceWrite,
  cancelWorkspaceWrite: cancelProjectWorkWorkspaceWrite,
  startPreview: startProjectWorkPreview,
  fetchWorkspace: fetchProjectWorkWorkspace,
  fetchGitEvidence: fetchProjectWorkGitEvidence,
  fetchGitCloseouts: fetchProjectWorkGitCloseouts,
  confirmGitCloseout: confirmProjectWorkGitCloseout,
  runBrowserQa: runProjectWorkBrowserQa,
  browserQaScreenshotUrl: projectWorkBrowserQaScreenshotUrl,
  listApplyJournal: listProjectWorkApplyJournal,
  undoApply: undoProjectWorkApply,
  runVerification: runProjectWorkVerification,
};
