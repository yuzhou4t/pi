const PROJECT_WORK_API_ROOT = "/api/v1/project-work";

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

function mapMessage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = pick(raw, "message_id", "messageId", raw.id);
  if (typeof id !== "string" || !id) return null;
  return {
    id,
    role: raw.role === "user" ? "user" : "assistant",
    kind: pick(raw, "kind", "kind", "message"),
    content: raw.content ?? raw.text ?? "",
    providerId: pick(raw, "provider_id", "providerId"),
    modelId: pick(raw, "model_id", "modelId"),
    createdAt: pick(raw, "created_at", "createdAt"),
    status: pick(raw, "status", "status", "completed"),
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
      pick(raw, "summary", "summary", data.summary ?? data.delta ?? ""),
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
    const path = explicitPath || [parentPath, name].filter(Boolean).join("/");
    if (!path) return [];
    const rawKind = pick(entry, "kind", "kind", pick(entry, "type", "type", "file"));
    const normalizedKind = String(rawKind).toLowerCase();
    const kind = ["directory", "dir", "folder"].includes(normalizedKind)
      ? "directory"
      : normalizedKind === "file"
        ? "file"
        : "unsupported";
    const rawDepth = pick(entry, "depth", "depth");
    const explicitDepth = rawDepth === null || rawDepth === undefined || rawDepth === ""
      ? null
      : Number(rawDepth);
    const depth = Number.isFinite(explicitDepth) && explicitDepth >= 0
      ? explicitDepth
      : inferredDepth;
    const mapped = {
      id: pick(entry, "entry_id", "entryId", path),
      path,
      name: name || path.split("/").at(-1),
      kind,
      size: pick(entry, "size", "size", entry.byteLength ?? null),
      contentHash: pick(entry, "content_hash", "contentHash", entry.hash ?? null),
      depth,
    };
    const children = mapTreeEntries(entry.children, path, depth + 1);
    return [mapped, ...children];
  });
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
  return {
    id,
    projectId,
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
    contextUsage: mapContextUsage(
      pick(source, "context_usage", "contextUsage"),
    ),
    preview: pick(source, "preview", "preview"),
    compaction: mapCompaction(pick(source, "compaction", "compaction")),
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
  signal,
  fetchImpl,
} = {}) {
  const payload = await requestJson(`${PROJECT_WORK_API_ROOT}/conversations`, {
    method: "POST",
    body: {
      schema_version: 1,
      ...(providerId ? { provider_id: providerId } : {}),
      ...(modelId ? { model_id: modelId } : {}),
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

export async function sendProjectWorkMessage({
  conversationId,
  text,
  contexts = [],
  providerId,
  modelId,
  clientRequestId = createRequestId("project-message"),
  signal,
  fetchImpl,
} = {}) {
  requiredId(conversationId, "conversationId");
  if (typeof text !== "string" || !text.trim()) throw new TypeError("text 必须是非空字符串");
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/conversations/${encodeURIComponent(conversationId)}/messages`,
    {
      method: "POST",
      body: {
        schema_version: 1,
        client_request_id: clientRequestId,
        text: text.trim(),
        contexts: asArray(contexts).map((context) => ({
          context_id: context.id,
          path: context.path,
          ...(context.contentHash ? { content_hash: context.contentHash } : {}),
          ...(Number.isInteger(context.startLine) ? { start_line: context.startLine } : {}),
          ...(Number.isInteger(context.endLine) ? { end_line: context.endLine } : {}),
        })),
        ...(providerId ? { provider_id: providerId } : {}),
        ...(modelId ? { model_id: modelId } : {}),
      },
      signal,
      fetchImpl,
    },
  );
  return mapProjectWorkConversation(payload);
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

export async function fetchProjectWorkTree({
  projectId,
  conversationId,
  path = "",
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
  if (path) query.set("path", path);
  if (cursor) query.set("cursor", cursor);
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  const scope = conversationId
    ? `conversations/${encodeURIComponent(conversationId)}`
    : `projects/${encodeURIComponent(projectId)}`;
  const payload = await requestJson(
    `${PROJECT_WORK_API_ROOT}/${scope}/tree${suffix}`,
    { signal, fetchImpl },
  );
  const returnedPath = pick(payload, "path", "path", path);
  const baseDepth = String(returnedPath ?? "").split("/").filter(Boolean).length;
  return {
    path: returnedPath,
    revision: pick(payload, "revision", "revision"),
    cursor: pick(payload, "next_cursor", "nextCursor"),
    entries: mapTreeEntries(payload?.entries, returnedPath, baseDepth),
  };
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
  sendMessage: sendProjectWorkMessage,
  steerConversation: steerProjectWorkConversation,
  abortConversation: abortProjectWorkConversation,
  compactConversation: compactProjectWorkConversation,
  fetchTree: fetchProjectWorkTree,
  fetchFile: fetchProjectWorkFile,
  applyChangeSet: applyProjectWorkChangeSet,
  runVerification: runProjectWorkVerification,
};
