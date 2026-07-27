import { createHash, randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  rmdir,
} from "node:fs/promises";
import path from "node:path";
import { createMineruCloudAdapter } from "../mineruCloud.js";
import {
  createConversationDocumentService,
  hasActiveConversationDocuments,
  publicConversationDocument,
} from "./conversationDocuments.js";
import { createConversationStore } from "./conversationStore.js";
import {
  ProjectWorkError,
  projectWorkError,
  safeProjectWorkError,
} from "./errors.js";
import {
  createPiSessionFactory,
  PROJECT_WORK_DEFAULT_TOOL_NAMES,
  readProjectWorkOverlayTextFile,
} from "./piSessionHost.js";
import { resolveProjectWorkTurn } from "./projectWorkWorkflows.js";
import { createMacOSProjectPicker } from "./macosProjectPicker.js";
import { normalizeProjectWorkImages } from "./projectWorkImages.js";
import { createProjectRegistry, publicProject } from "./projectRegistry.js";
import { createVerificationRunner } from "./verificationRunner.js";
import {
  applySelectedChangeSet,
  createFilteredProjectSnapshot,
  getProjectFileTree,
  normalizeProjectPath,
  readProjectTextFile,
  recomputeChangeSet,
} from "./workspace.js";

const SELECTION_TTL_MS = 10 * 60 * 1_000;
const LEGACY_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
];
const SAFE_VERIFICATION_FILES = new Set(["npm", "pnpm", "yarn", "bun", "node"]);
const PACKAGE_COMMANDS = new Set(["test", "run", "lint", "check", "typecheck"]);
const DEFAULT_CONVERSATION_TITLE = "新工作会话";
const STANDALONE_ROOT_LABEL = "未连接文件夹";
const BUSY_CONVERSATION_STATUSES = new Set([
  "running",
  "compacting",
  "verifying",
]);
const COMPACTION_STATUSES = new Set([
  "idle",
  "running",
  "completed",
  "failed",
  "aborted",
]);
const COMPACTION_REASONS = new Set([
  "manual",
  "threshold",
  "overflow",
]);
const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

function nullableNonNegativeNumber(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function defaultContextUsage(updatedAt = null) {
  return {
    tokens: null,
    contextWindow: null,
    percent: null,
    status: "awaiting_measurement",
    updatedAt,
  };
}

function normalizedContextUsage(value, updatedAt = null, {
  awaitingMeasurement = false,
} = {}) {
  const rawContextWindow = nullableNonNegativeNumber(value?.contextWindow);
  const contextWindow = rawContextWindow > 0 ? rawContextWindow : null;
  const tokens = awaitingMeasurement
    ? null
    : nullableNonNegativeNumber(value?.tokens);
  const percent = awaitingMeasurement
    ? null
    : nullableNonNegativeNumber(value?.percent);
  const status = awaitingMeasurement || tokens === null || percent === null
    ? "awaiting_measurement"
    : "estimated";
  return {
    tokens,
    contextWindow,
    percent,
    status,
    updatedAt: updatedAt ?? value?.updatedAt ?? null,
  };
}

function defaultCompactionState(autoEnabled = true) {
  return {
    autoEnabled,
    status: "idle",
    reason: null,
    tokensBefore: null,
    estimatedTokensAfter: null,
    willRetry: false,
    completedAt: null,
  };
}

function normalizedCompactionState(value, {
  autoEnabled = true,
} = {}) {
  return {
    autoEnabled: typeof value?.autoEnabled === "boolean"
      ? value.autoEnabled
      : autoEnabled,
    status: COMPACTION_STATUSES.has(value?.status) ? value.status : "idle",
    reason: COMPACTION_REASONS.has(value?.reason) ? value.reason : null,
    tokensBefore: nullableNonNegativeNumber(value?.tokensBefore),
    estimatedTokensAfter: nullableNonNegativeNumber(value?.estimatedTokensAfter),
    willRetry: value?.willRetry === true,
    completedAt: typeof value?.completedAt === "string"
      ? value.completedAt
      : null,
  };
}

function compactText(value, maxLength, fallback = "") {
  const normalized = String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replaceAll(/\s+/g, " ");
  return normalized.slice(0, maxLength) || fallback;
}

function normalizeClientRequestId(value, idFactory) {
  const requestId = value === undefined || value === null
    ? `project-message:${idFactory()}`
    : String(value).trim();
  if (!CLIENT_REQUEST_ID_PATTERN.test(requestId)) {
    throw projectWorkError(
      "PROJECT_WORK_CLIENT_REQUEST_ID_INVALID",
      "客户端请求标识无效",
      400,
    );
  }
  return requestId;
}

function messageRequestFingerprint({
  text,
  context,
  images,
  capabilities,
  workflowId,
  providerId,
  modelId,
  thinkingLevel,
}) {
  const imageSignatures = images.map((image) => ({
    fileName: image?.fileName ?? image?.file_name ?? null,
    mimeType: image?.mimeType ?? image?.mime_type ?? null,
    byteLength: image?.byteLength ?? image?.byte_length ?? null,
    sha256: createHash("sha256")
      .update(String(image?.data ?? ""))
      .digest("hex"),
  }));
  const payload = {
    text,
    context: context.map((item) => ({
      path: item?.path ?? null,
      contentHash: item?.contentHash ?? null,
      startLine: item?.startLine ?? null,
      endLine: item?.endLine ?? null,
    })),
    images: imageSignatures,
    capabilities: [...capabilities],
    workflowId: workflowId ?? null,
    providerId: providerId ?? null,
    modelId: modelId ?? null,
    thinkingLevel: thinkingLevel ?? null,
  };
  return createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
}

function conversationTitle(value) {
  const normalized = String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replaceAll(/\s+/g, " ");
  if (!normalized || normalized.length > 80) {
    throw projectWorkError(
      "PROJECT_WORK_CONVERSATION_TITLE_INVALID",
      "工作会话名称必须包含 1 到 80 个字符",
      400,
    );
  }
  return normalized;
}

function conversationTitleFromMessage(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replaceAll(/\s+/g, " ")
    .slice(0, 48) || DEFAULT_CONVERSATION_TITLE;
}

function conversationWorkspaceKind(conversation) {
  if (
    conversation?.workspaceKind === "scratch"
    && conversation.projectId === null
  ) {
    return "scratch";
  }
  if (
    (conversation?.workspaceKind === "bound_project" || !conversation?.workspaceKind)
    && typeof conversation?.projectId === "string"
    && conversation.projectId
  ) {
    return "bound_project";
  }
  throw projectWorkError(
    "PROJECT_WORK_CONVERSATION_SCOPE_INVALID",
    "工作会话的工作区范围无效",
    500,
  );
}

function publicConversationSummary(conversation) {
  const workspaceKind = conversationWorkspaceKind(conversation);
  return {
    id: conversation.id,
    projectId: conversation.projectId,
    workspaceKind,
    scope: workspaceKind === "scratch" ? "standalone" : "project",
    rootLabel: workspaceKind === "scratch"
      ? STANDALONE_ROOT_LABEL
      : conversation.rootLabel ?? null,
    title: conversation.title,
    status: conversation.status,
    providerId: conversation.providerId ?? null,
    modelId: conversation.modelId,
    thinkingLevel: conversation.thinkingLevel,
    pendingChangeFileCount: (
      conversation.activeChangeSet?.status === "ready"
      && Array.isArray(conversation.activeChangeSet.files)
    )
      ? conversation.activeChangeSet.files.length
      : 0,
    lastEventSeq: conversation.lastEventSeq ?? 0,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  };
}

function publicConversationState(conversation, lastEventSeq) {
  return {
    ...publicConversationSummary({
      ...conversation,
      lastEventSeq,
    }),
    messages: (conversation.messages ?? []).map((message) => ({
      id: message.id,
      role: message.role,
      text: message.text,
      images: Array.isArray(message.images)
        ? message.images.map((image) => ({
            fileName: compactText(image?.fileName, 160, "图片"),
            mimeType: compactText(image?.mimeType, 80),
            byteLength: Number.isSafeInteger(image?.byteLength)
              ? image.byteLength
              : 0,
          }))
        : [],
      status: message.status,
      providerId: message.providerId ?? null,
      modelId: message.modelId ?? null,
      thinkingLevel: message.thinkingLevel ?? null,
      workflowId: message.workflowId ?? null,
      capabilities: Array.isArray(message.capabilities)
        ? [...message.capabilities]
        : [],
      createdAt: message.createdAt,
    })),
    plan: conversation.plan ? structuredClone(conversation.plan) : null,
    activeChangeSet: conversation.activeChangeSet
      ? structuredClone(conversation.activeChangeSet)
      : null,
    verifications: (conversation.verifications ?? []).map((verification) => (
      structuredClone(verification)
    )),
    workspaceSnapshot: conversation.workspaceSnapshot
      ? structuredClone(conversation.workspaceSnapshot)
      : null,
    contextUsage: normalizedContextUsage(conversation.contextUsage),
    compaction: normalizedCompactionState(conversation.compaction),
    documents: (conversation.documents ?? [])
      .map(publicConversationDocument)
      .filter(Boolean),
    lastError: conversation.lastError ? structuredClone(conversation.lastError) : null,
  };
}

function selectModel(catalog, { providerId, modelId } = {}) {
  let requestedProvider = compactText(providerId, 120);
  let requestedModel = compactText(modelId, 200);
  if (!requestedProvider && requestedModel.includes("/")) {
    const separator = requestedModel.indexOf("/");
    requestedProvider = requestedModel.slice(0, separator);
    requestedModel = requestedModel.slice(separator + 1);
  }
  requestedProvider ||= catalog.defaultProviderId ?? "";
  requestedModel ||= catalog.defaultModelId ?? "";
  const provider = (catalog.providers ?? []).find((item) => item.id === requestedProvider);
  const model = provider?.models?.find((item) => item.id === requestedModel);
  if (!provider || !model) {
    throw projectWorkError(
      "PROJECT_WORK_MODEL_UNAVAILABLE",
      "所选 Pi 模型当前不可用",
      409,
      true,
    );
  }
  const thinkingLevels = Array.isArray(model.thinkingLevels)
    && model.thinkingLevels.length > 0
    ? [...new Set(model.thinkingLevels.filter(
        (level) => typeof level === "string" && level,
      ))]
    : model.supportsThinking === false
      ? ["off"]
      : [...LEGACY_THINKING_LEVELS];
  const defaultThinkingLevel = thinkingLevels.includes(model.defaultThinkingLevel)
    ? model.defaultThinkingLevel
    : thinkingLevels.includes(catalog.defaultThinkingLevel)
      ? catalog.defaultThinkingLevel
      : [
          "medium",
          "low",
          "high",
          "minimal",
          "off",
          ...thinkingLevels,
        ].find((level) => thinkingLevels.includes(level)) ?? "off";
  return {
    providerId: provider.id,
    modelId: model.id,
    modelRef: `${provider.id}/${model.id}`,
    supportsImages: model.supportsImages === true,
    thinkingLevels,
    defaultThinkingLevel,
  };
}

function selectThinkingLevel(selectedModel, requestedLevel, {
  strict = false,
} = {}) {
  const requested = compactText(requestedLevel, 40);
  if (requested && selectedModel.thinkingLevels.includes(requested)) {
    return requested;
  }
  if (requested && strict) {
    throw projectWorkError(
      "PROJECT_WORK_THINKING_LEVEL_UNSUPPORTED",
      "所选模型不支持该思考强度",
      400,
    );
  }
  return selectedModel.defaultThinkingLevel;
}

function publicModelSelection(selectedModel, thinkingLevel) {
  return {
    providerId: selectedModel.providerId,
    modelId: selectedModel.modelId,
    modelRef: selectedModel.modelRef,
    thinkingLevel,
  };
}

function extractMessageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("");
}

function executableName(value) {
  const file = String(value ?? "").trim();
  if (
    !/^[A-Za-z0-9._-]+$/.test(file)
    || !SAFE_VERIFICATION_FILES.has(file)
  ) {
    throw projectWorkError(
      "PROJECT_WORK_VERIFICATION_COMMAND_BLOCKED",
      "该验证程序不在允许范围内",
      400,
    );
  }
  return file;
}

function safeArgument(value) {
  const result = String(value ?? "");
  if (
    !result
    || result.length > 400
    || /[\0\r\n]/.test(result)
  ) {
    throw projectWorkError(
      "PROJECT_WORK_VERIFICATION_COMMAND_INVALID",
      "验证命令参数无效",
      400,
    );
  }
  return result;
}

function assertPackageCommand(file, args) {
  const command = args[0] ?? "test";
  if (!PACKAGE_COMMANDS.has(command)) {
    throw projectWorkError(
      "PROJECT_WORK_VERIFICATION_COMMAND_BLOCKED",
      `${file} 验证只允许 test、run、lint、check 或 typecheck`,
      400,
    );
  }
  if (command === "run") {
    const script = args[1];
    if (!script || !/^[A-Za-z0-9:._-]{1,120}$/.test(script)) {
      throw projectWorkError(
        "PROJECT_WORK_VERIFICATION_COMMAND_INVALID",
        "run 验证必须指定安全的脚本名称",
        400,
      );
    }
  }
  const blocked = args.some((argument) => (
    /^(?:--?(?:cwd|dir|prefix|global|shell|script-shell))(?:=|$)/.test(argument)
    || ["exec", "install", "add", "remove", "uninstall", "publish", "link"].includes(argument)
  ));
  if (blocked) {
    throw projectWorkError(
      "PROJECT_WORK_VERIFICATION_COMMAND_BLOCKED",
      "验证命令包含不允许的参数",
      400,
    );
  }
}

function assertNodeCommand(args) {
  if (args.some((argument) => (
    ["-e", "--eval", "-p", "--print", "-r", "--require", "--import"].includes(argument)
    || argument.startsWith("--eval=")
    || argument.startsWith("--require=")
    || argument.startsWith("--import=")
  ))) {
    throw projectWorkError(
      "PROJECT_WORK_VERIFICATION_COMMAND_BLOCKED",
      "node 验证不允许执行内联代码或预加载模块",
      400,
    );
  }
  for (const argument of args) {
    if (argument.startsWith("-")) continue;
    normalizeProjectPath(argument);
  }
  if (args.length === 0 || (args.every((argument) => argument.startsWith("-")) && !args.includes("--test"))) {
    throw projectWorkError(
      "PROJECT_WORK_VERIFICATION_COMMAND_INVALID",
      "node 验证必须指定 --test 或项目内脚本",
      400,
    );
  }
}

function normalizeVerificationRequest(request) {
  const file = executableName(request?.file);
  const args = Array.isArray(request?.args)
    ? request.args.map(safeArgument)
    : file === "node"
      ? ["--test"]
      : ["test"];
  if (args.length > 32 || args.join("").length > 8_000) {
    throw projectWorkError(
      "PROJECT_WORK_VERIFICATION_COMMAND_INVALID",
      "验证命令参数过多",
      400,
    );
  }
  if (file === "node") assertNodeCommand(args);
  else assertPackageCommand(file, args);
  const cwd = request?.cwd
    ? normalizeProjectPath(request.cwd)
    : "";
  const checks = Array.isArray(request?.checks)
    ? request.checks
      .map((check) => compactText(check, 200))
      .filter(Boolean)
      .slice(0, 20)
    : [];
  return {
    command: { file, args, cwd },
    checks,
  };
}

async function resolvePackageScript({
  projectRoot,
  baseRoot,
  workspaceRoot,
}, command) {
  if (!["npm", "pnpm", "yarn"].includes(command.file)) return null;
  const scriptName = command.args[0] === "run"
    ? command.args[1]
    : command.args[0] === "test"
      ? "test"
      : null;
  if (!scriptName) return null;
  const packagePath = [
    command.cwd,
    "package.json",
  ].filter(Boolean).join("/");
  try {
    const packageJson = JSON.parse(
      (await readProjectWorkOverlayTextFile({
        projectRoot,
        baseRoot,
        workspaceRoot,
        filePath: packagePath,
        endLine: Number.MAX_SAFE_INTEGER,
      })).content,
    );
    const script = packageJson?.scripts?.[scriptName];
    return typeof script === "string" ? script.slice(0, 2_000) : null;
  } catch {
    return null;
  }
}

async function resolveVerificationCwd(workspaceRoot, relativePath) {
  const target = relativePath
    ? path.resolve(workspaceRoot, ...relativePath.split("/"))
    : workspaceRoot;
  const relative = path.relative(workspaceRoot, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw projectWorkError(
      "PROJECT_WORK_VERIFICATION_CWD_INVALID",
      "验证目录必须位于隔离工作区内",
      400,
    );
  }
  let targetStat;
  let canonicalTarget;
  try {
    [targetStat, canonicalTarget] = await Promise.all([lstat(target), realpath(target)]);
  } catch {
    throw projectWorkError(
      "PROJECT_WORK_VERIFICATION_CWD_INVALID",
      "验证目录不存在",
      400,
    );
  }
  const canonicalRelative = path.relative(await realpath(workspaceRoot), canonicalTarget);
  if (
    targetStat.isSymbolicLink()
    || !targetStat.isDirectory()
    || canonicalRelative.startsWith("..")
    || path.isAbsolute(canonicalRelative)
  ) {
    throw projectWorkError(
      "PROJECT_WORK_VERIFICATION_CWD_INVALID",
      "验证目录必须是隔离工作区内的普通文件夹",
      400,
    );
  }
  return canonicalTarget;
}

function safeFolderName(value) {
  const name = compactText(value, 100);
  if (
    !name
    || name === "."
    || name === ".."
    || name.includes("/")
    || name.includes("\\")
    || name.includes("\0")
  ) {
    throw projectWorkError(
      "PROJECT_WORK_FOLDER_NAME_INVALID",
      "新项目文件夹名称无效",
      400,
    );
  }
  return name;
}

function defaultStorageRoot() {
  if (process.env.PI_PROJECT_WORK_STORAGE_ROOT) {
    return path.resolve(process.env.PI_PROJECT_WORK_STORAGE_ROOT);
  }
  return process.platform === "darwin"
    ? path.join(homedir(), "Library", "Application Support", "Pi Agent", "project-work")
    : path.join(homedir(), ".local", "share", "pi-agent", "project-work");
}

function defaultDocumentParser() {
  const token = String(process.env.PI_MINERU_API_TOKEN ?? "").trim();
  return token
    ? createMineruCloudAdapter({
        apiToken: token,
        baseUrl: process.env.PI_MINERU_BASE_URL || undefined,
      })
    : null;
}

function positiveEnvironmentInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function defaultDocumentPollInterval() {
  return positiveEnvironmentInteger(
    process.env.PI_MINERU_POLL_INTERVAL_MS,
    10_000,
  );
}

function defaultDocumentMaxPollAttempts(pollIntervalMs) {
  const timeoutMs = positiveEnvironmentInteger(
    process.env.PI_MINERU_TIMEOUT_MS,
    30 * 60 * 1_000,
  );
  return Math.max(1, Math.ceil(timeoutMs / Math.max(pollIntervalMs, 1)));
}

export function createProjectWorkService({
  storageRoot = defaultStorageRoot(),
  sessionFactory,
  documentParser = defaultDocumentParser(),
  documentPollIntervalMs = defaultDocumentPollInterval(),
  documentMaxPollAttempts = defaultDocumentMaxPollAttempts(
    documentPollIntervalMs,
  ),
  snapshotter = createFilteredProjectSnapshot,
  picker = createMacOSProjectPicker(),
  runner = createVerificationRunner(),
  now = () => new Date(),
  idFactory = randomUUID,
} = {}) {
  const configuredStorageRoot = path.resolve(storageRoot);
  const effectiveSessionFactory = sessionFactory ?? createPiSessionFactory();
  const createSnapshot = snapshotter;
  const registry = createProjectRegistry({
    storageRoot: configuredStorageRoot,
    now,
    idFactory,
  });
  const conversationStore = createConversationStore({
    storageRoot: configuredStorageRoot,
  });
  const selections = new Map();
  const runtimes = new Map();
  const activeMessageClaims = new Map();
  const verificationControllers = new Map();
  const applyQueues = new Map();
  const deletingConversations = new Set();
  const deletingProjects = new Set();
  const documentOperationCounts = new Map();
  const conversationCreationCounts = new Map();
  const documentService = createConversationDocumentService({
    getConversation: (conversationId) => conversationStore.get(conversationId),
    updateConversation: (conversationId, patch) => (
      updateConversation(conversationId, patch)
    ),
    appendEvent: (conversationId, type, data) => (
      appendEvent(conversationId, type, data)
    ),
    directoryForConversation: (conversationId) => (
      conversationStore.directory(conversationId)
    ),
    parser: documentParser,
    pollIntervalMs: documentPollIntervalMs,
    maxPollAttempts: documentMaxPollAttempts,
    now,
    idFactory,
  });
  let modelCatalogCache = null;
  let disposed = false;

  function timestamp() {
    return now().toISOString();
  }

  function assertActive() {
    if (disposed) throw new Error("project work service is disposed");
  }

  function assertConversationNotDeleting(conversationId) {
    if (deletingConversations.has(conversationId)) {
      throw projectWorkError(
        "PROJECT_WORK_CONVERSATION_DELETE_IN_PROGRESS",
        "工作会话正在删除",
        409,
        true,
      );
    }
  }

  async function withDocumentOperation(conversationId, operation) {
    assertConversationNotDeleting(conversationId);
    const conversation = await conversationStore.get(conversationId);
    if (
      conversation.projectId
      && deletingProjects.has(conversation.projectId)
    ) {
      throw projectWorkError(
        "PROJECT_WORK_PROJECT_DELETE_IN_PROGRESS",
        "项目正在删除，暂时不能修改会话资料",
        409,
        true,
      );
    }
    documentOperationCounts.set(
      conversationId,
      (documentOperationCounts.get(conversationId) ?? 0) + 1,
    );
    try {
      assertConversationNotDeleting(conversationId);
      if (
        conversation.projectId
        && deletingProjects.has(conversation.projectId)
      ) {
        throw projectWorkError(
          "PROJECT_WORK_PROJECT_DELETE_IN_PROGRESS",
          "项目正在删除，暂时不能修改会话资料",
          409,
          true,
        );
      }
      return await operation(conversation);
    } finally {
      const remaining = (documentOperationCounts.get(conversationId) ?? 1) - 1;
      if (remaining > 0) documentOperationCounts.set(conversationId, remaining);
      else documentOperationCounts.delete(conversationId);
    }
  }

  function assertConversationProject(conversation, projectId) {
    if (
      conversationWorkspaceKind(conversation) !== "bound_project"
      || conversation.projectId !== projectId
    ) {
      throw projectWorkError(
        "PROJECT_WORK_CONVERSATION_NOT_FOUND",
        "工作会话不存在",
        404,
      );
    }
  }

  function assertStandaloneConversation(conversation) {
    if (conversationWorkspaceKind(conversation) !== "scratch") {
      throw projectWorkError(
        "PROJECT_WORK_CONVERSATION_NOT_FOUND",
        "工作会话不存在",
        404,
      );
    }
  }

  function assertConversationDeletable(conversation) {
    const runtime = runtimes.get(conversation.id);
    if (
      BUSY_CONVERSATION_STATUSES.has(conversation.status)
      || verificationControllers.has(conversation.id)
      || Boolean(runtime?.completion)
      || (documentOperationCounts.get(conversation.id) ?? 0) > 0
      || hasActiveConversationDocuments(conversation)
      || (conversation.verifications ?? []).some(
        (verification) => verification.status === "running",
      )
    ) {
      throw projectWorkError(
        "PROJECT_WORK_CONVERSATION_DELETE_BUSY",
        "工作会话仍有正在运行的 Agent、验证、PDF 解析或修改应用操作",
        409,
        true,
      );
    }
  }

  function conversationPaths(conversationId) {
    const directory = conversationStore.directory(conversationId);
    return {
      directory,
      baseRoot: path.join(directory, "base"),
      workspaceRoot: path.join(directory, "workspace"),
      scratchRoot: path.join(directory, "scratch"),
      sessionDir: path.join(directory, "pi-sessions"),
    };
  }

  async function resolveConversationWorkspace(conversation) {
    const workspaceKind = conversationWorkspaceKind(conversation);
    if (workspaceKind === "bound_project") {
      const project = await registry.get(conversation.projectId);
      return {
        workspaceKind,
        projectRoot: project.rootPath,
        rootLabel: conversation.rootLabel ?? project.rootLabel,
        lockKey: `project:${project.id}`,
      };
    }
    const paths = conversationPaths(conversation.id);
    let canonicalRoot;
    let canonicalDirectory;
    let rootStat;
    try {
      [canonicalRoot, canonicalDirectory, rootStat] = await Promise.all([
        realpath(paths.scratchRoot),
        realpath(paths.directory),
        lstat(paths.scratchRoot),
      ]);
    } catch {
      throw projectWorkError(
        "PROJECT_WORK_SCRATCH_UNAVAILABLE",
        "独立对话的私有工作区不可用",
        500,
      );
    }
    if (
      path.dirname(canonicalRoot) !== canonicalDirectory
      || !rootStat.isDirectory()
      || rootStat.isSymbolicLink()
    ) {
      throw projectWorkError(
        "PROJECT_WORK_SCRATCH_UNAVAILABLE",
        "独立对话的私有工作区不可用",
        500,
      );
    }
    return {
      workspaceKind,
      projectRoot: canonicalRoot,
      rootLabel: STANDALONE_ROOT_LABEL,
      lockKey: `conversation:${conversation.id}`,
    };
  }

  async function appendEvent(conversationId, type, data = {}) {
    const event = await conversationStore.appendEvent(conversationId, {
      type,
      at: timestamp(),
      data,
    });
    await conversationStore.update(conversationId, {
      lastEventSeq: event.seq,
      updatedAt: event.at,
    });
    return event;
  }

  async function sanitizeForConversation(conversationId, value) {
    let text = String(value ?? "");
    const conversation = await conversationStore.get(conversationId);
    const workspace = await resolveConversationWorkspace(conversation);
    const paths = conversationPaths(conversationId);
    for (const [target, replacement] of [
      [paths.workspaceRoot, "<workspace>"],
      [paths.baseRoot, "<workspace>"],
      [paths.scratchRoot, "<workspace>"],
      [paths.directory, "<workspace>"],
      [
        workspace.projectRoot,
        workspace.workspaceKind === "scratch" ? "<workspace>" : "<project>",
      ],
      [configuredStorageRoot, "<workspace>"],
      [process.cwd(), "<app>"],
      [tmpdir(), "<tmp>"],
      ["/private/tmp", "<tmp>"],
      [homedir(), "<home>"],
    ]) {
      text = text.replaceAll(target, replacement);
    }
    return text.slice(0, 64_000);
  }

  async function updateConversation(conversationId, patch) {
    return conversationStore.update(conversationId, (current) => ({
      ...(typeof patch === "function" ? patch(current) : patch),
      updatedAt: timestamp(),
    }));
  }

  function runtimeAutoCompactionEnabled(runtime, currentValue = true) {
    try {
      return typeof runtime?.host?.autoCompactionEnabled === "boolean"
        ? runtime.host.autoCompactionEnabled
        : currentValue;
    } catch {
      return currentValue;
    }
  }

  function runtimeContextUsage(runtime) {
    if (typeof runtime?.host?.getContextUsage !== "function") {
      return { available: false, value: undefined };
    }
    try {
      return {
        available: true,
        value: runtime.host.getContextUsage(),
      };
    } catch {
      return { available: false, value: undefined };
    }
  }

  async function refreshRuntimeContext(runtime, {
    awaitingMeasurement = false,
  } = {}) {
    const measuredAt = timestamp();
    const observedUsage = runtimeContextUsage(runtime);
    return updateConversation(runtime.conversationId, (current) => {
      const currentCompaction = normalizedCompactionState(current.compaction);
      const contextUsage = observedUsage.available
        ? normalizedContextUsage(observedUsage.value, measuredAt, {
            awaitingMeasurement,
          })
        : awaitingMeasurement
          ? normalizedContextUsage(current.contextUsage, measuredAt, {
              awaitingMeasurement: true,
            })
          : normalizedContextUsage(current.contextUsage);
      return {
        contextUsage,
        compaction: {
          ...currentCompaction,
          autoEnabled: runtimeAutoCompactionEnabled(
            runtime,
            currentCompaction.autoEnabled,
          ),
        },
      };
    });
  }

  async function recordCompactionStart(runtime, event) {
    const reason = COMPACTION_REASONS.has(event?.reason) ? event.reason : null;
    let publicCompaction;
    await updateConversation(runtime.conversationId, (current) => {
      const currentCompaction = normalizedCompactionState(current.compaction);
      publicCompaction = {
        ...defaultCompactionState(
          runtimeAutoCompactionEnabled(runtime, currentCompaction.autoEnabled),
        ),
        status: "running",
        reason,
      };
      return { compaction: publicCompaction };
    });
    await appendEvent(runtime.conversationId, "compaction.started", {
      reason,
      autoEnabled: publicCompaction.autoEnabled,
    });
  }

  async function recordCompactionEnd(runtime, event) {
    const completedAt = timestamp();
    const reason = COMPACTION_REASONS.has(event?.reason) ? event.reason : null;
    const status = event?.aborted === true
      ? "aborted"
      : event?.errorMessage
        ? "failed"
        : "completed";
    const tokensBefore = nullableNonNegativeNumber(event?.result?.tokensBefore);
    const estimatedTokensAfter = nullableNonNegativeNumber(
      event?.result?.estimatedTokensAfter,
    );
    const willRetry = event?.willRetry === true;
    const observedUsage = runtimeContextUsage(runtime);
    let publicCompaction;
    await updateConversation(runtime.conversationId, (current) => {
      const currentCompaction = normalizedCompactionState(current.compaction);
      const contextUsage = status === "completed"
        ? normalizedContextUsage(
            observedUsage.available ? observedUsage.value : current.contextUsage,
            completedAt,
            { awaitingMeasurement: true },
          )
        : observedUsage.available
          ? normalizedContextUsage(observedUsage.value, completedAt)
          : normalizedContextUsage(current.contextUsage);
      publicCompaction = {
        autoEnabled: runtimeAutoCompactionEnabled(
          runtime,
          currentCompaction.autoEnabled,
        ),
        status,
        reason,
        tokensBefore,
        estimatedTokensAfter,
        willRetry,
        completedAt,
      };
      return {
        contextUsage,
        compaction: publicCompaction,
      };
    });
    await appendEvent(runtime.conversationId, "compaction.completed", {
      reason,
      status,
      aborted: event?.aborted === true,
      willRetry,
      tokensBefore,
      estimatedTokensAfter,
    });
  }

  async function recordPlan(conversationId, plan) {
    const updatedAt = timestamp();
    const normalized = {
      explanation: await sanitizeForConversation(
        conversationId,
        compactText(plan?.explanation, 500),
      ),
      steps: await Promise.all((plan?.steps ?? []).map(async (step, index) => ({
        id: compactText(step.id, 80, `step-${index + 1}`),
        text: await sanitizeForConversation(
          conversationId,
          compactText(step.text, 240),
        ),
        status: ["pending", "in_progress", "completed"].includes(step.status)
          ? step.status
          : "pending",
      }))),
      updatedAt,
    };
    await updateConversation(conversationId, { plan: normalized });
    await appendEvent(conversationId, "plan.updated", normalized);
    return normalized;
  }

  async function recordVerificationRequest(conversationId, request) {
    const normalized = normalizeVerificationRequest(request);
    normalized.checks = await Promise.all(normalized.checks.map((check) => (
      sanitizeForConversation(conversationId, check)
    )));
    const createdAt = timestamp();
    const conversation = await conversationStore.get(conversationId);
    const workspace = await resolveConversationWorkspace(conversation);
    const paths = conversationPaths(conversationId);
    const resolvedScript = await resolvePackageScript(
      {
        projectRoot: workspace.projectRoot,
        baseRoot: paths.baseRoot,
        workspaceRoot: paths.workspaceRoot,
      },
      normalized.command,
    );
    const verification = {
      id: `verification-${idFactory()}`,
      ...normalized,
      resolvedScript: resolvedScript
        ? await sanitizeForConversation(conversationId, resolvedScript)
        : null,
      status: "requested",
      exitCode: null,
      durationMs: null,
      output: "",
      truncated: false,
      createdAt,
      completedAt: null,
    };
    await updateConversation(conversationId, (current) => ({
      verifications: [...(current.verifications ?? []), verification],
    }));
    await appendEvent(conversationId, "verification.requested", {
      id: verification.id,
      command: verification.command,
      checks: verification.checks,
    });
    return verification;
  }

  async function refreshChangeSet(conversationId) {
    const conversation = await conversationStore.get(conversationId);
    const paths = conversationPaths(conversationId);
    const changeSet = {
      ...await recomputeChangeSet({
        conversationId,
        baseRoot: paths.baseRoot,
        workspaceRoot: paths.workspaceRoot,
        allowDeletes: conversation.workspaceSnapshot?.mode !== "sparse_overlay",
      }),
      createdAt: timestamp(),
      appliedAt: null,
    };
    await updateConversation(conversationId, { activeChangeSet: changeSet });
    await appendEvent(conversationId, "change_set.ready", {
      id: changeSet.id,
      hash: changeSet.hash,
      status: changeSet.status,
      stats: changeSet.stats,
    });
    return changeSet;
  }

  function queueRuntimeEvent(runtime, event) {
    runtime.eventQueue = runtime.eventQueue
      .catch(() => undefined)
      .then(() => handleRuntimeEvent(runtime, event))
      .catch(async (error) => {
        await appendEvent(runtime.conversationId, "error", safeProjectWorkError(error));
      });
  }

  async function beginRuntimeThinking(runtime) {
    if (runtime.thinkingObserved) return;
    runtime.thinkingObserved = true;
    runtime.thinkingActive = true;
    await appendEvent(runtime.conversationId, "agent.thinking", {
      status: "active",
    });
  }

  async function finishRuntimeThinking(runtime) {
    if (!runtime.thinkingActive) return;
    runtime.thinkingActive = false;
    await appendEvent(runtime.conversationId, "agent.thinking", {
      status: "finished",
    });
  }

  async function safeToolData(runtime, event) {
    const data = {
      callId: compactText(event.toolCallId, 160),
      name: compactText(event.toolName, 80),
    };
    const rawPath = event.args?.path;
    if (typeof rawPath === "string") {
      try {
        data.path = normalizeProjectPath(rawPath);
      } catch {
        data.path = null;
      }
    }
    if (event.type === "tool_execution_end") {
      const summary = extractMessageText({
        content: event.result?.content,
      });
      if (summary) {
        data.summary = await sanitizeForConversation(
          runtime.conversationId,
          summary.slice(0, 500),
        );
      }
      data.status = event.isError ? "failed" : "completed";
    }
    return data;
  }

  async function handleRuntimeEvent(runtime, event) {
    const conversationId = runtime.conversationId;
    const turnSettings = runtime.activeTurnSettings ?? {
      providerId: runtime.providerId,
      modelId: runtime.modelId,
      thinkingLevel: runtime.thinkingLevel,
    };
    switch (event?.type) {
      case "agent_start":
        await finishRuntimeThinking(runtime);
        runtime.thinkingObserved = false;
        await updateConversation(conversationId, {
          status: "running",
          lastError: null,
        });
        await appendEvent(conversationId, "agent.status", { status: "running" });
        break;
      case "agent_end":
        await finishRuntimeThinking(runtime);
        await appendEvent(conversationId, "agent.turn_finished", {
          willRetry: event.willRetry === true,
        });
        break;
      case "agent_settled":
        await finishRuntimeThinking(runtime);
        try {
          await refreshRuntimeContext(runtime);
          const changeSet = await refreshChangeSet(conversationId);
          const settledStatus = changeSet.files.length > 0
            ? "awaiting_confirmation"
            : "idle";
          await appendEvent(conversationId, "agent.status", {
            status: settledStatus,
          });
          await updateConversation(conversationId, {
            status: settledStatus,
            lastError: null,
          });
        } catch (error) {
          const safeError = safeProjectWorkError(error);
          await updateConversation(conversationId, {
            status: "error",
            lastError: safeError,
          });
          await appendEvent(conversationId, "error", safeError);
        }
        break;
      case "turn_start":
        runtime.turnIndex += 1;
        await appendEvent(conversationId, "turn.started", {
          turnIndex: runtime.turnIndex,
          ...turnSettings,
        });
        break;
      case "turn_end":
        await appendEvent(conversationId, "turn.completed", {
          turnIndex: runtime.turnIndex,
          ...turnSettings,
        });
        break;
      case "message_start":
        if (event.message?.role === "assistant") {
          runtime.activeAssistantId = `message-${idFactory()}`;
          runtime.assistantText = "";
          await appendEvent(conversationId, "message.started", {
            id: runtime.activeAssistantId,
            role: "assistant",
            ...turnSettings,
          });
        }
        break;
      case "message_update": {
        const assistantEvent = event.assistantMessageEvent;
        if (assistantEvent?.type === "text_delta" && runtime.activeAssistantId) {
          if (runtime.assistantText.length < 256_000) {
            runtime.assistantText += String(assistantEvent.delta ?? "").slice(
              0,
              256_000 - runtime.assistantText.length,
            );
          }
        } else if (
          assistantEvent?.type?.startsWith("thinking_")
          && assistantEvent.type !== "thinking_end"
        ) {
          await beginRuntimeThinking(runtime);
        }
        break;
      }
      case "message_end":
        if (event.message?.role === "assistant" && runtime.activeAssistantId) {
          await finishRuntimeThinking(runtime);
          const fullText = await sanitizeForConversation(
            conversationId,
            extractMessageText(event.message) || runtime.assistantText,
          );
          const status = event.message.stopReason === "error" ? "failed" : "completed";
          const message = {
            id: runtime.activeAssistantId,
            role: "assistant",
            text: fullText,
            status,
            ...turnSettings,
            createdAt: timestamp(),
          };
          await updateConversation(conversationId, (current) => ({
            messages: [...(current.messages ?? []), message],
          }));
          await appendEvent(conversationId, "message.completed", {
            id: message.id,
            role: message.role,
            text: message.text,
            status: message.status,
          });
          runtime.activeAssistantId = null;
          runtime.assistantText = "";
        }
        break;
      case "tool_execution_start":
        await appendEvent(
          conversationId,
          "tool.started",
          await safeToolData(runtime, event),
        );
        break;
      case "tool_execution_update":
        await appendEvent(
          conversationId,
          "tool.progress",
          await safeToolData(runtime, event),
        );
        break;
      case "tool_execution_end":
        await appendEvent(
          conversationId,
          "tool.completed",
          await safeToolData(runtime, event),
        );
        break;
      case "compaction_start":
        await recordCompactionStart(runtime, event);
        break;
      case "compaction_end":
        await recordCompactionEnd(runtime, event);
        break;
      case "auto_retry_start":
        await appendEvent(conversationId, "agent.retry", {
          status: "waiting",
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
        });
        break;
      case "auto_retry_end":
        await appendEvent(conversationId, "agent.retry", {
          status: event.success ? "completed" : "failed",
          attempt: event.attempt,
        });
        break;
      default:
        break;
    }
  }

  async function getRuntime(conversationId) {
    assertConversationNotDeleting(conversationId);
    const current = runtimes.get(conversationId);
    if (current) return current;
    const conversation = await conversationStore.get(conversationId);
    const paths = conversationPaths(conversationId);
    const workspace = await resolveConversationWorkspace(conversation);
    let workspaceSnapshot = conversation.workspaceSnapshot ?? null;
    if (!workspaceSnapshot) {
      const existingEvents = await conversationStore.readEvents(conversationId, {
        afterSeq: 0,
        limit: 1_000,
      });
      if (
        existingEvents.events.some(
          (event) => event.type === "workspace.snapshot_limited",
        )
      ) {
        workspaceSnapshot = { truncated: true };
      }
    }
    const runtime = {
      conversationId,
      projectRoot: workspace.projectRoot,
      workspaceRoot: paths.workspaceRoot,
      eventQueue: Promise.resolve(),
      turnIndex: 0,
      activeAssistantId: null,
      assistantText: "",
      thinkingObserved: false,
      thinkingActive: false,
      completion: null,
      providerId: conversation.providerId,
      modelId: conversation.modelId,
      modelRef: conversation.modelRef,
      thinkingLevel: conversation.thinkingLevel,
      activeTurnSettings: null,
      host: null,
      unsubscribe: null,
    };
    runtime.host = await effectiveSessionFactory({
      conversationId,
      projectRoot: workspace.projectRoot,
      baseRoot: paths.baseRoot,
      workspaceRoot: paths.workspaceRoot,
      sessionDir: paths.sessionDir,
      modelRef: conversation.modelRef,
      thinkingLevel: conversation.thinkingLevel,
      workspaceSnapshot,
      workspaceKind: workspace.workspaceKind,
      documentAccess: {
        list: () => documentService.listForAgent(conversationId),
        search: (request) => documentService.searchForAgent(
          conversationId,
          request,
        ),
        read: (request) => documentService.readForAgent(
          conversationId,
          request,
        ),
      },
      onPlan: (plan) => recordPlan(conversationId, plan),
      onVerificationRequest: (request) => recordVerificationRequest(
        conversationId,
        request,
      ),
    });
    if (!runtime.host || typeof runtime.host.subscribe !== "function") {
      throw new Error("sessionFactory must return a subscribable Pi session host");
    }
    if (deletingConversations.has(conversationId)) {
      runtime.host.dispose?.();
      assertConversationNotDeleting(conversationId);
    }
    runtime.unsubscribe = runtime.host.subscribe((event) => {
      queueRuntimeEvent(runtime, event);
    });
    runtimes.set(conversationId, runtime);
    await refreshRuntimeContext(runtime);
    return runtime;
  }

  async function snapshot(conversationId, options = {}) {
    await documentService.resumeConversation(conversationId);
    let conversation = await conversationStore.get(conversationId);
    if (
      conversation.status === "verifying"
      && !verificationControllers.has(conversationId)
    ) {
      conversation = await updateConversation(conversationId, (current) => ({
        status: "interrupted",
        verifications: (current.verifications ?? []).map((verification) => (
          verification.status === "running"
            ? {
                ...verification,
                status: "interrupted",
                completedAt: timestamp(),
              }
            : verification
        )),
        lastError: {
          code: "PROJECT_WORK_VERIFICATION_INTERRUPTED",
          message: "上一次验证未正常结束，可以重新运行",
          retryable: true,
        },
      }));
      await appendEvent(conversationId, "agent.status", { status: "interrupted" });
    }
    const staleCompaction = conversation.status === "compacting"
      || normalizedCompactionState(conversation.compaction).status === "running";
    if (
      (conversation.status === "running" || staleCompaction)
      && !runtimes.has(conversationId)
      && !activeMessageClaims.has(conversationId)
    ) {
      const interruptedAt = timestamp();
      conversation = await updateConversation(conversationId, (current) => ({
        status: "interrupted",
        ...(current.status === "compacting"
          || normalizedCompactionState(current.compaction).status === "running"
          ? {
              compaction: {
                ...normalizedCompactionState(current.compaction),
                status: "aborted",
                completedAt: interruptedAt,
              },
            }
          : {}),
        lastError: {
          code: "PROJECT_WORK_SESSION_INTERRUPTED",
          message: "上一次 Agent 操作未正常结束，可以重新发送任务继续",
          retryable: true,
        },
      }));
      await appendEvent(conversationId, "agent.status", { status: "interrupted" });
    }
    const eventPage = await conversationStore.readEvents(conversationId, {
      afterSeq: options.afterSeq,
      limit: options.eventLimit,
    });
    return {
      schemaVersion: 1,
      conversation: publicConversationState(conversation, eventPage.lastSeq),
      events: eventPage.events,
      hasMoreEvents: eventPage.hasMore,
    };
  }

  async function loadModelCatalog({ refresh = false } = {}) {
    assertActive();
    if (!refresh && modelCatalogCache) return structuredClone(modelCatalogCache);
    if (typeof effectiveSessionFactory.listModels !== "function") {
      throw projectWorkError(
        "PROJECT_WORK_MODELS_UNAVAILABLE",
        "Pi 模型目录当前不可用",
        503,
        true,
      );
    }
    modelCatalogCache = await effectiveSessionFactory.listModels();
    return structuredClone(modelCatalogCache);
  }

  async function listModels() {
    return loadModelCatalog({ refresh: true });
  }

  async function pickProjectRoot({ mode = "existing", name } = {}) {
    assertActive();
    if (!["existing", "create"].includes(mode)) {
      throw projectWorkError(
        "PROJECT_WORK_PICK_MODE_INVALID",
        "项目文件夹选择方式无效",
        400,
      );
    }
    const proposedName = mode === "create" && name
      ? safeFolderName(name)
      : compactText(name, 100);
    const picked = await picker({ mode, name: proposedName || undefined });
    const pickedPath = mode === "create"
      ? picked?.parentPath ?? picked?.rootPath
      : picked?.rootPath;
    if (typeof pickedPath !== "string" || !path.isAbsolute(pickedPath)) {
      throw projectWorkError(
        "PROJECT_WORK_PICK_RESULT_INVALID",
        "文件夹选择器没有返回有效结果",
        500,
      );
    }
    let canonicalPath;
    let pickedStat;
    try {
      [canonicalPath, pickedStat] = await Promise.all([
        realpath(pickedPath),
        lstat(pickedPath),
      ]);
    } catch {
      throw projectWorkError(
        "PROJECT_WORK_PICK_RESULT_INVALID",
        "所选文件夹当前不可用",
        404,
      );
    }
    if (!pickedStat.isDirectory() || pickedStat.isSymbolicLink()) {
      throw projectWorkError(
        "PROJECT_WORK_PICK_RESULT_INVALID",
        "只能选择普通文件夹",
        400,
      );
    }
    const selectionId = `selection-${idFactory()}`;
    const expiresAt = new Date(now().getTime() + SELECTION_TTL_MS).toISOString();
    const selection = {
      selectionId,
      mode,
      name: proposedName || compactText(picked?.name, 100),
      path: canonicalPath,
      device: pickedStat.dev,
      inode: pickedStat.ino,
      rootLabel: mode === "create"
        ? proposedName || path.basename(canonicalPath) || "新项目位置"
        : path.basename(canonicalPath) || "本地项目",
      expiresAt,
    };
    selections.set(selectionId, selection);
    return {
      selectionId,
      mode,
      name: selection.name || selection.rootLabel,
      rootLabel: selection.rootLabel,
      expiresAt,
    };
  }

  async function registerProject({ selectionId, name } = {}) {
    assertActive();
    const selection = selections.get(selectionId);
    if (!selection || Date.parse(selection.expiresAt) <= now().getTime()) {
      selections.delete(selectionId);
      throw projectWorkError(
        "PROJECT_WORK_SELECTION_EXPIRED",
        "文件夹选择结果已失效，请重新选择",
        410,
      );
    }
    let currentSelectionStat;
    let currentSelectionPath;
    try {
      [currentSelectionStat, currentSelectionPath] = await Promise.all([
        lstat(selection.path),
        realpath(selection.path),
      ]);
    } catch {
      throw projectWorkError(
        "PROJECT_WORK_SELECTION_CHANGED",
        "所选文件夹已不可用，请重新选择",
        409,
        true,
      );
    }
    if (
      currentSelectionPath !== selection.path
      || currentSelectionStat.dev !== selection.device
      || currentSelectionStat.ino !== selection.inode
      || !currentSelectionStat.isDirectory()
      || currentSelectionStat.isSymbolicLink()
    ) {
      throw projectWorkError(
        "PROJECT_WORK_SELECTION_CHANGED",
        "所选文件夹已发生变化，请重新选择",
        409,
        true,
      );
    }
    let rootPath = selection.path;
    let createdRootPath = null;
    let projectName = compactText(name, 120);
    if (selection.mode === "create") {
      const folderName = safeFolderName(name || selection.name);
      const target = path.resolve(selection.path, folderName);
      const relative = path.relative(selection.path, target);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        throw projectWorkError(
          "PROJECT_WORK_FOLDER_NAME_INVALID",
          "新项目文件夹名称无效",
          400,
        );
      }
      try {
        await mkdir(target, { mode: 0o700 });
      } catch (error) {
        if (error?.code === "EEXIST") {
          throw projectWorkError(
            "PROJECT_WORK_FOLDER_EXISTS",
            "同名项目文件夹已经存在",
            409,
          );
        }
        throw error;
      }
      rootPath = target;
      createdRootPath = target;
      projectName ||= folderName;
    }
    let project;
    try {
      project = await registry.register({
        rootPath,
        name: projectName || selection.name,
      });
    } catch (error) {
      if (createdRootPath) await rmdir(createdRootPath).catch(() => undefined);
      throw error;
    }
    selections.delete(selectionId);
    return publicProject(project, 0);
  }

  async function listProjects() {
    assertActive();
    const [projects, conversations] = await Promise.all([
      registry.list(),
      conversationStore.list(),
    ]);
    const counts = new Map();
    for (const conversation of conversations) {
      counts.set(conversation.projectId, (counts.get(conversation.projectId) ?? 0) + 1);
    }
    return projects.map((project) => publicProject(
      project,
      counts.get(project.id) ?? 0,
    ));
  }

  async function createConversationRecord({
    projectId,
    workspaceKind,
    rootLabel,
    validateModel = true,
  }, {
    title,
    providerId,
    modelId,
    thinkingLevel,
  } = {}) {
    assertActive();
    const requestedProviderId = compactText(providerId, 120) || null;
    const requestedModelId = compactText(modelId, 200) || null;
    const catalog = validateModel && typeof effectiveSessionFactory.listModels === "function"
      ? await loadModelCatalog()
      : null;
    const selectedModel = catalog
      ? selectModel(catalog, {
          providerId: requestedProviderId,
          modelId: requestedModelId,
        })
      : {
          providerId: requestedProviderId,
          modelId: requestedModelId,
          modelRef: requestedProviderId && requestedModelId
            ? `${requestedProviderId}/${requestedModelId}`
            : requestedModelId,
          thinkingLevels: [...LEGACY_THINKING_LEVELS],
          defaultThinkingLevel: "medium",
        };
    const selectedThinkingLevel = selectThinkingLevel(
      selectedModel,
      thinkingLevel,
      { strict: thinkingLevel !== undefined && thinkingLevel !== null },
    );
    const conversationId = `conversation-${idFactory()}`;
    const paths = conversationPaths(conversationId);
    try {
      await mkdir(path.dirname(paths.directory), { recursive: true, mode: 0o700 });
      await mkdir(paths.directory, { recursive: false, mode: 0o700 });
      await Promise.all([
        mkdir(paths.baseRoot, { recursive: false, mode: 0o700 }),
        mkdir(paths.workspaceRoot, { recursive: false, mode: 0o700 }),
        mkdir(paths.sessionDir, { recursive: false, mode: 0o700 }),
        ...(workspaceKind === "scratch"
          ? [mkdir(paths.scratchRoot, { recursive: false, mode: 0o700 })]
          : []),
      ]);
      const createdAt = timestamp();
      const conversation = await conversationStore.create({
        schemaVersion: 1,
        id: conversationId,
        projectId,
        workspaceKind,
        rootLabel,
        title: compactText(title, 160, DEFAULT_CONVERSATION_TITLE),
        status: "idle",
        providerId: selectedModel.providerId,
        modelId: selectedModel.modelId,
        modelRef: selectedModel.modelRef,
        thinkingLevel: selectedThinkingLevel,
        messages: [],
        plan: null,
        activeChangeSet: null,
        verifications: [],
        documents: [],
        workspaceSnapshot: {
          schemaVersion: 1,
          rulesVersion: 2,
          mode: workspaceKind === "scratch" ? "scratch" : "sparse_overlay",
          includedFiles: 0,
          includedBytes: 0,
          skippedBinaryFiles: 0,
          skippedOversizedFiles: 0,
          truncated: false,
        },
        contextUsage: defaultContextUsage(),
        compaction: defaultCompactionState(),
        lastError: null,
        lastEventSeq: 0,
        createdAt,
        updatedAt: createdAt,
      });
      await appendEvent(conversationId, "conversation.created", {
        id: conversationId,
        projectId,
        workspaceKind,
      });
      return publicConversationSummary(conversation);
    } catch (error) {
      await rm(paths.directory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async function createConversation(projectId, options = {}) {
    assertActive();
    if (deletingProjects.has(projectId)) {
      throw projectWorkError(
        "PROJECT_WORK_PROJECT_DELETE_IN_PROGRESS",
        "项目正在删除，暂时不能新建会话",
        409,
        true,
      );
    }
    const project = await registry.get(projectId);
    if (deletingProjects.has(project.id)) {
      throw projectWorkError(
        "PROJECT_WORK_PROJECT_DELETE_IN_PROGRESS",
        "项目正在删除，暂时不能新建会话",
        409,
        true,
      );
    }
    conversationCreationCounts.set(
      project.id,
      (conversationCreationCounts.get(project.id) ?? 0) + 1,
    );
    try {
      if (deletingProjects.has(project.id)) {
        throw projectWorkError(
          "PROJECT_WORK_PROJECT_DELETE_IN_PROGRESS",
          "项目正在删除，暂时不能新建会话",
          409,
          true,
        );
      }
      return await createConversationRecord({
        projectId: project.id,
        workspaceKind: "bound_project",
        rootLabel: project.rootLabel,
      }, options);
    } finally {
      const remaining = (conversationCreationCounts.get(project.id) ?? 1) - 1;
      if (remaining > 0) conversationCreationCounts.set(project.id, remaining);
      else conversationCreationCounts.delete(project.id);
    }
  }

  async function createStandaloneConversation(options = {}) {
    assertActive();
    return createConversationRecord({
      projectId: null,
      workspaceKind: "scratch",
      rootLabel: STANDALONE_ROOT_LABEL,
      validateModel: false,
    }, options);
  }

  async function listConversations(projectId) {
    assertActive();
    await registry.get(projectId);
    return (await conversationStore.list(projectId)).map(publicConversationSummary);
  }

  async function listStandaloneConversations() {
    assertActive();
    return (await conversationStore.list(null)).map(publicConversationSummary);
  }

  async function getConversation(conversationId, options = {}) {
    assertActive();
    return snapshot(conversationId, options);
  }

  async function createConversationDocument(conversationId, options = {}) {
    assertActive();
    return withDocumentOperation(conversationId, async () => {
      await conversationStore.get(conversationId);
      const document = await documentService.createDocument(
        conversationId,
        options,
      );
      return {
        document,
        snapshot: await snapshot(conversationId),
      };
    });
  }

  async function uploadConversationDocument(
    conversationId,
    documentId,
    stream,
    options = {},
  ) {
    assertActive();
    return withDocumentOperation(conversationId, async () => {
      await documentService.uploadContent(
        conversationId,
        documentId,
        stream,
        options,
      );
      return snapshot(conversationId);
    });
  }

  async function retryConversationDocument(conversationId, documentId) {
    assertActive();
    return withDocumentOperation(conversationId, async () => {
      await documentService.retryDocument(conversationId, documentId);
      return snapshot(conversationId);
    });
  }

  async function removeConversationDocument(conversationId, documentId) {
    assertActive();
    return withDocumentOperation(conversationId, async () => {
      await documentService.removeDocument(conversationId, documentId);
      return snapshot(conversationId);
    });
  }

  async function buildPromptContext(conversationId, context) {
    if (!Array.isArray(context) || context.length === 0) return "";
    if (context.length > 8) {
      throw projectWorkError(
        "PROJECT_WORK_CONTEXT_TOO_LARGE",
        "一次最多附加八个文件上下文",
        400,
      );
    }
    const conversation = await conversationStore.get(conversationId);
    const workspace = await resolveConversationWorkspace(conversation);
    const paths = conversationPaths(conversationId);
    const sections = [];
    let totalCharacters = 0;
    for (const item of context) {
      if (typeof item?.contentHash !== "string" || !item.contentHash) {
        throw projectWorkError(
          "PROJECT_WORK_CONTEXT_BINDING_REQUIRED",
          "文件上下文缺少内容哈希，请重新选择",
          400,
        );
      }
      const file = await readProjectWorkOverlayTextFile({
        projectRoot: workspace.projectRoot,
        baseRoot: paths.baseRoot,
        workspaceRoot: paths.workspaceRoot,
        filePath: item?.path,
        startLine: item?.startLine,
        endLine: item?.endLine,
      }).catch((error) => {
        if (error?.code !== "PROJECT_WORK_FILE_NOT_FOUND") throw error;
        throw projectWorkError(
          "PROJECT_WORK_CONTEXT_OUTSIDE_SNAPSHOT",
          "所选文件当前不可用，请重新选择文件上下文",
          409,
          true,
        );
      });
      if (item.contentHash !== file.hash) {
        throw projectWorkError(
          "PROJECT_WORK_CONTEXT_STALE",
          `文件 ${file.path} 已发生变化，请重新选择上下文`,
          409,
          true,
        );
      }
      totalCharacters += file.content.length;
      if (totalCharacters > 120_000) {
        throw projectWorkError(
          "PROJECT_WORK_CONTEXT_TOO_LARGE",
          "文件上下文总长度超出当前限制",
          413,
        );
      }
      sections.push({
        path: file.path,
        startLine: file.startLine,
        endLine: file.endLine,
        content: file.content,
      });
    }
    return `\n\nThe user explicitly attached these project excerpts as JSON:\n${JSON.stringify(sections)}`;
  }

  async function configureConversation(conversationId, {
    providerId,
    modelId,
    thinkingLevel,
  } = {}) {
    assertActive();
    assertConversationNotDeleting(conversationId);
    const conversation = await conversationStore.get(conversationId);
    if (BUSY_CONVERSATION_STATUSES.has(conversation.status)) {
      throw projectWorkError(
        "PROJECT_WORK_CONVERSATION_BUSY",
        "Agent 工作期间不能切换模型或思考强度",
        409,
      );
    }
    const catalog = await listModels();
    const selectedModel = selectModel(catalog, {
      providerId: providerId || conversation.providerId,
      modelId: modelId || conversation.modelId,
    });
    const selectedThinkingLevel = selectThinkingLevel(
      selectedModel,
      thinkingLevel ?? conversation.thinkingLevel,
      { strict: thinkingLevel !== undefined && thinkingLevel !== null },
    );
    const selection = publicModelSelection(
      selectedModel,
      selectedThinkingLevel,
    );
    const changed = selection.modelRef !== conversation.modelRef
      || selection.thinkingLevel !== conversation.thinkingLevel;
    if (changed) {
      await updateConversation(conversationId, selection);
      await appendEvent(conversationId, "model.configuration_changed", {
        providerId: selection.providerId,
        modelId: selection.modelId,
        thinkingLevel: selection.thinkingLevel,
      });
    }
    return snapshot(conversationId);
  }

  async function sendMessage(conversationId, {
    text,
    context = [],
    images = [],
    capabilities = [],
    workflowId,
    providerId,
    modelId,
    thinkingLevel,
    clientRequestId,
  } = {}) {
    assertActive();
    assertConversationNotDeleting(conversationId);
    const messageText = String(text ?? "").trim();
    if (!messageText || messageText.length > 32_000) {
      throw projectWorkError(
        "PROJECT_WORK_MESSAGE_INVALID",
        "消息必须包含 1 到 32000 个字符",
        400,
      );
    }
    const requestId = normalizeClientRequestId(clientRequestId, idFactory);
    const messageContext = Array.isArray(context) ? context : [];
    const requestedCapabilities = Array.isArray(capabilities) ? capabilities : [];
    const requestedImages = Array.isArray(images) ? images : [];
    const requestFingerprint = messageRequestFingerprint({
      text: messageText,
      context: messageContext,
      images: requestedImages,
      capabilities: requestedCapabilities,
      workflowId,
      providerId,
      modelId,
      thinkingLevel,
    });
    const existingConversation = await conversationStore.get(conversationId);
    const existingMessage = (existingConversation.messages ?? []).find(
      (message) => message.clientRequestId === requestId,
    );
    if (existingMessage) {
      if (existingMessage.requestFingerprint !== requestFingerprint) {
        throw projectWorkError(
          "PROJECT_WORK_CLIENT_REQUEST_CONFLICT",
          "同一客户端请求标识不能用于不同消息",
          409,
        );
      }
      return snapshot(conversationId);
    }
    const catalog = await listModels();
    const turn = resolveProjectWorkTurn({
      workflowId,
      capabilityIds: requestedCapabilities,
      capabilityStatus: catalog.capabilities,
      hasImages: Array.isArray(images) && images.length > 0,
    });
    const normalizedImages = await normalizeProjectWorkImages(images);
    const promptContext = await buildPromptContext(
      conversationId,
      messageContext,
    );
    const createdAt = timestamp();
    const proposedMessageId = `message-${idFactory()}`;
    let claimKind = "new";
    let claimInstalled = false;
    let selectedModel;
    let selectedThinkingLevel;
    let selection;
    let selectionChanged = false;
    let turnSettings;
    let userMessage;
    try {
      await updateConversation(conversationId, (current) => {
        const existingMessage = (current.messages ?? []).find(
          (message) => message.clientRequestId === requestId,
        );
        if (existingMessage) {
          if (existingMessage.requestFingerprint !== requestFingerprint) {
            throw projectWorkError(
              "PROJECT_WORK_CLIENT_REQUEST_CONFLICT",
              "同一客户端请求标识不能用于不同消息",
              409,
            );
          }
          claimKind = "duplicate";
          userMessage = existingMessage;
          return {};
        }
        if (
          activeMessageClaims.has(conversationId)
          || BUSY_CONVERSATION_STATUSES.has(current.status)
        ) {
          throw projectWorkError(
            "PROJECT_WORK_CONVERSATION_BUSY",
            "Agent 正在工作，请使用调整任务或等待当前操作完成",
            409,
          );
        }
        selectedModel = selectModel(catalog, {
          providerId: providerId || current.providerId,
          modelId: modelId || current.modelId,
        });
        if (
          normalizedImages.length > 0
          && selectedModel.supportsImages !== true
        ) {
          throw projectWorkError(
            "PROJECT_WORK_MODEL_VISION_UNSUPPORTED",
            "当前模型不能读取图片，请切换支持图片的模型",
            400,
          );
        }
        selectedThinkingLevel = selectThinkingLevel(
          selectedModel,
          thinkingLevel ?? current.thinkingLevel,
          { strict: thinkingLevel !== undefined && thinkingLevel !== null },
        );
        selection = publicModelSelection(
          selectedModel,
          selectedThinkingLevel,
        );
        selectionChanged = selection.modelRef !== current.modelRef
          || selection.thinkingLevel !== current.thinkingLevel;
        turnSettings = {
          providerId: selection.providerId,
          modelId: selection.modelId,
          thinkingLevel: selection.thinkingLevel,
          workflowId: turn.workflowId,
          capabilities: turn.capabilityIds,
        };
        userMessage = {
          id: proposedMessageId,
          role: "user",
          text: messageText,
          images: normalizedImages.map(({ metadata }) => metadata),
          status: "accepted",
          ...turnSettings,
          clientRequestId: requestId,
          requestFingerprint,
          createdAt,
        };
        activeMessageClaims.set(conversationId, {
          requestId,
          requestFingerprint,
          messageId: userMessage.id,
        });
        claimInstalled = true;
        return {
          ...selection,
          title: (
            current.title === DEFAULT_CONVERSATION_TITLE
            && (current.messages ?? []).length === 0
          )
            ? conversationTitleFromMessage(messageText)
            : current.title,
          status: "running",
          messages: [...(current.messages ?? []), userMessage],
          lastError: null,
        };
      });
    } catch (error) {
      if (
        claimInstalled
        && activeMessageClaims.get(conversationId)?.messageId
          === proposedMessageId
      ) {
        activeMessageClaims.delete(conversationId);
      }
      throw error;
    }
    if (claimKind === "duplicate") {
      return snapshot(conversationId);
    }

    let runtime = null;
    try {
      runtime = await getRuntime(conversationId);
      if (selectedModel.modelRef !== runtime.modelRef) {
        if (typeof runtime.host.setModel !== "function") {
          throw projectWorkError(
            "PROJECT_WORK_MODEL_SWITCH_UNAVAILABLE",
            "当前 Pi 会话不能切换模型",
            409,
          );
        }
        await runtime.host.setModel(selectedModel.modelRef);
        runtime.providerId = selectedModel.providerId;
        runtime.modelId = selectedModel.modelId;
        runtime.modelRef = selectedModel.modelRef;
        await appendEvent(conversationId, "model.changed", {
          providerId: selectedModel.providerId,
          modelId: selectedModel.modelId,
        });
        await refreshRuntimeContext(runtime);
      }
      if (typeof runtime.host.setActiveToolsByName !== "function") {
        if (turn.workflowId || turn.capabilityIds.length > 0) {
          throw projectWorkError(
            "PROJECT_WORK_TOOL_SELECTION_UNAVAILABLE",
            "当前 Pi 会话不能按本轮切换工具",
            409,
          );
        }
      } else {
        runtime.host.setActiveToolsByName(turn.toolNames);
      }
      if (typeof runtime.host.setThinkingLevel !== "function") {
        if (runtime.thinkingLevel !== selectedThinkingLevel) {
          throw projectWorkError(
            "PROJECT_WORK_THINKING_LEVEL_SWITCH_UNAVAILABLE",
            "当前 Pi 会话不能切换思考强度",
            409,
          );
        }
      } else {
        const effectiveThinkingLevel = runtime.host.setThinkingLevel(
          selectedThinkingLevel,
        );
        if (effectiveThinkingLevel !== selectedThinkingLevel) {
          throw projectWorkError(
            "PROJECT_WORK_THINKING_LEVEL_UNSUPPORTED",
            "所选模型不支持该思考强度",
            400,
          );
        }
        runtime.thinkingLevel = effectiveThinkingLevel;
      }
      if (selectionChanged) {
        await appendEvent(conversationId, "model.configuration_applied", {
          providerId: selection.providerId,
          modelId: selection.modelId,
          thinkingLevel: selection.thinkingLevel,
        });
      }
      runtime.activeTurnSettings = turnSettings;
      const {
        clientRequestId: _clientRequestId,
        requestFingerprint: _requestFingerprint,
        ...publicUserMessage
      } = userMessage;
      await appendEvent(conversationId, "message.created", publicUserMessage);
    } catch (error) {
      const safeError = safeProjectWorkError(error);
      await updateConversation(conversationId, {
        status: "error",
        lastError: safeError,
      }).catch(() => undefined);
      await appendEvent(conversationId, "error", safeError).catch(() => undefined);
      try {
        runtime?.host.setActiveToolsByName?.(PROJECT_WORK_DEFAULT_TOOL_NAMES);
      } catch {
        // The next accepted turn reapplies the default list.
      }
      if (runtime) {
        runtime.completion = null;
        runtime.activeTurnSettings = null;
      }
      if (
        activeMessageClaims.get(conversationId)?.messageId
        === proposedMessageId
      ) {
        activeMessageClaims.delete(conversationId);
      }
      throw error;
    }
    const completion = Promise.resolve()
      .then(() => runtime.host.prompt(
        `${messageText}${promptContext}`,
        {
          turnGuidance: turn.guidance,
          ...(normalizedImages.length > 0 ? {
            images: normalizedImages.map(({ image }) => image),
          } : {}),
        },
      ))
      .then(() => runtime.eventQueue)
      .catch(async (error) => {
        const safeError = safeProjectWorkError(error);
        await updateConversation(conversationId, {
          status: "error",
          lastError: safeError,
        });
        await appendEvent(conversationId, "error", safeError);
      })
      .finally(async () => {
        try {
          const latest = await conversationStore.get(conversationId);
          if (latest.status === "running") {
            await updateConversation(conversationId, { status: "idle" });
            await appendEvent(conversationId, "agent.status", { status: "idle" });
          }
        } finally {
          try {
            runtime.host.setActiveToolsByName?.(PROJECT_WORK_DEFAULT_TOOL_NAMES);
          } catch {
            // A future normal turn sets the default list again before prompting.
          }
          runtime.completion = null;
          runtime.activeTurnSettings = null;
          if (
            activeMessageClaims.get(conversationId)?.messageId
            === proposedMessageId
          ) {
            activeMessageClaims.delete(conversationId);
          }
        }
      });
    runtime.completion = completion;
    return snapshot(conversationId);
  }

  async function steerConversation(conversationId, { text } = {}) {
    assertActive();
    assertConversationNotDeleting(conversationId);
    const messageText = String(text ?? "").trim();
    if (!messageText || messageText.length > 8_000) {
      throw projectWorkError(
        "PROJECT_WORK_STEER_INVALID",
        "调整内容必须包含 1 到 8000 个字符",
        400,
      );
    }
    const conversation = await conversationStore.get(conversationId);
    const runtime = runtimes.get(conversationId);
    if (conversation.status !== "running" || !runtime) {
      throw projectWorkError(
        "PROJECT_WORK_NOT_RUNNING",
        "当前没有可调整的 Agent 操作",
        409,
      );
    }
    await runtime.host.steer(messageText);
    const message = {
      id: `message-${idFactory()}`,
      role: "user",
      text: messageText,
      status: "queued",
      providerId: runtime.activeTurnSettings?.providerId
        ?? conversation.providerId,
      modelId: runtime.activeTurnSettings?.modelId
        ?? conversation.modelId,
      thinkingLevel: runtime.activeTurnSettings?.thinkingLevel
        ?? conversation.thinkingLevel,
      workflowId: runtime.activeTurnSettings?.workflowId ?? null,
      capabilities: Array.isArray(runtime.activeTurnSettings?.capabilities)
        ? [...runtime.activeTurnSettings.capabilities]
        : [],
      createdAt: timestamp(),
    };
    await updateConversation(conversationId, (current) => ({
      messages: [...(current.messages ?? []), message],
    }));
    await appendEvent(conversationId, "message.queued", message);
    return snapshot(conversationId);
  }

  async function abortConversation(conversationId) {
    assertActive();
    assertConversationNotDeleting(conversationId);
    const conversation = await conversationStore.get(conversationId);
    const runtime = runtimes.get(conversationId);
    const verificationController = verificationControllers.get(conversationId);
    verificationController?.abort();
    if (runtime) {
      await runtime.host.abort();
      await runtime.eventQueue;
    }
    if (BUSY_CONVERSATION_STATUSES.has(conversation.status)) {
      await updateConversation(conversationId, { status: "aborted" });
      await appendEvent(conversationId, "agent.status", { status: "aborted" });
    }
    return snapshot(conversationId);
  }

  async function compactConversation(conversationId, { instructions } = {}) {
    assertActive();
    assertConversationNotDeleting(conversationId);
    const conversation = await conversationStore.get(conversationId);
    if (BUSY_CONVERSATION_STATUSES.has(conversation.status)) {
      throw projectWorkError(
        "PROJECT_WORK_CONVERSATION_BUSY",
        "Agent 正在工作，当前不能压缩上下文",
        409,
      );
    }
    const runtime = await getRuntime(conversationId);
    await updateConversation(conversationId, (current) => {
      const currentCompaction = normalizedCompactionState(current.compaction);
      return {
        status: "compacting",
        compaction: {
          ...defaultCompactionState(
            runtimeAutoCompactionEnabled(runtime, currentCompaction.autoEnabled),
          ),
          status: "running",
          reason: "manual",
        },
      };
    });
    try {
      const result = await runtime.host.compact(
        instructions ? String(instructions).slice(0, 2_000) : undefined,
      );
      await runtime.eventQueue;
      const latest = await conversationStore.get(conversationId);
      if (latest.compaction?.status === "running") {
        await recordCompactionEnd(runtime, {
          type: "compaction_end",
          reason: "manual",
          result,
          aborted: false,
          willRetry: false,
        });
      }
      await updateConversation(conversationId, {
        status: "idle",
        lastError: null,
      });
    } catch (error) {
      await runtime.eventQueue;
      const latest = await conversationStore.get(conversationId);
      if (latest.compaction?.status === "running") {
        await recordCompactionEnd(runtime, {
          type: "compaction_end",
          reason: "manual",
          result: undefined,
          aborted: false,
          willRetry: false,
          errorMessage: "failed",
        });
      }
      const safeError = safeProjectWorkError(error);
      await updateConversation(conversationId, {
        status: "error",
        lastError: safeError,
      });
      await appendEvent(conversationId, "error", safeError);
      throw error;
    }
    return snapshot(conversationId);
  }

  async function getProjectTree(projectId, options = {}) {
    assertActive();
    const project = await registry.get(projectId);
    return getProjectFileTree(project.rootPath, options);
  }

  async function readProjectFile(projectId, options = {}) {
    assertActive();
    const project = await registry.get(projectId);
    return readProjectTextFile(project.rootPath, options);
  }

  async function readConversationFile(conversationId, options = {}) {
    assertActive();
    const conversation = await conversationStore.get(conversationId);
    const workspace = await resolveConversationWorkspace(conversation);
    const paths = conversationPaths(conversationId);
    return readProjectWorkOverlayTextFile({
      ...options,
      projectRoot: workspace.projectRoot,
      baseRoot: paths.baseRoot,
      workspaceRoot: paths.workspaceRoot,
    });
  }

  async function getConversationTree(conversationId, options = {}) {
    assertActive();
    const conversation = await conversationStore.get(conversationId);
    const workspace = await resolveConversationWorkspace(conversation);
    return getProjectFileTree(workspace.projectRoot, options);
  }

  async function getChangeSet(conversationId) {
    assertActive();
    const conversation = await conversationStore.get(conversationId);
    if (BUSY_CONVERSATION_STATUSES.has(conversation.status)) {
      throw projectWorkError(
        "PROJECT_WORK_CONVERSATION_BUSY",
        "Agent 正在准备修改，请稍后再审阅更改",
        409,
      );
    }
    return refreshChangeSet(conversationId);
  }

  function withApplyLock(lockKey, operation) {
    const previous = applyQueues.get(lockKey) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    applyQueues.set(lockKey, current);
    return current.finally(() => {
      if (applyQueues.get(lockKey) === current) {
        applyQueues.delete(lockKey);
      }
    });
  }

  async function clearAppliedSparseOverlay(paths, appliedFiles) {
    await Promise.all(appliedFiles.flatMap((file) => (
      [paths.baseRoot, paths.workspaceRoot].map(async (root) => {
        const normalized = normalizeProjectPath(file.path);
        const target = path.resolve(root, ...normalized.split("/"));
        const relative = path.relative(root, target);
        if (relative.startsWith("..") || path.isAbsolute(relative)) {
          throw projectWorkError(
            "PROJECT_WORK_PATH_OUT_OF_SCOPE",
            "路径必须位于项目文件夹内",
            400,
          );
        }
        await rm(target, { force: true });
      })
    )));
  }

  async function applyChangeSet(conversationId, {
    changeSetId,
    changeSetHash,
    files,
  } = {}) {
    assertActive();
    assertConversationNotDeleting(conversationId);
    const initial = await conversationStore.get(conversationId);
    const initialWorkspace = await resolveConversationWorkspace(initial);
    return withApplyLock(initialWorkspace.lockKey, async () => {
      assertConversationNotDeleting(conversationId);
      const conversation = await conversationStore.get(conversationId);
      if (BUSY_CONVERSATION_STATUSES.has(conversation.status)) {
        throw projectWorkError(
          "PROJECT_WORK_CONVERSATION_BUSY",
          "Agent 正在准备修改，请稍后再应用更改",
          409,
        );
      }
      const workspace = await resolveConversationWorkspace(conversation);
      const paths = conversationPaths(conversationId);
      const current = await recomputeChangeSet({
        conversationId,
        baseRoot: paths.baseRoot,
        workspaceRoot: paths.workspaceRoot,
        allowDeletes: conversation.workspaceSnapshot?.mode !== "sparse_overlay",
      });
      if (current.id !== changeSetId || current.hash !== changeSetHash) {
        throw projectWorkError(
          "PROJECT_WORK_CHANGE_BINDING_MISMATCH",
          "更改内容已变化，请重新检查后再确认",
          409,
          true,
        );
      }
      const appliedFiles = await applySelectedChangeSet({
        projectRoot: workspace.projectRoot,
        baseRoot: paths.baseRoot,
        workspaceRoot: paths.workspaceRoot,
        changeSet: current,
        selectedFiles: files,
      });
      if (["sparse_overlay", "scratch"].includes(conversation.workspaceSnapshot?.mode)) {
        await clearAppliedSparseOverlay(paths, appliedFiles);
      }
      const appliedIds = new Set(appliedFiles.map((file) => file.fileId));
      const appliedAt = timestamp();
      const appliedChangeSet = {
        ...current,
        status: appliedIds.size === current.files.length
          ? "applied"
          : "partially_applied",
        files: current.files.map((file) => ({
          ...file,
          status: appliedIds.has(file.id) ? "applied" : "not_selected",
        })),
        appliedAt,
      };
      const remainingChangeSet = {
        ...await recomputeChangeSet({
          conversationId,
          baseRoot: paths.baseRoot,
          workspaceRoot: paths.workspaceRoot,
          allowDeletes: conversation.workspaceSnapshot?.mode !== "sparse_overlay",
        }),
        createdAt: timestamp(),
        appliedAt: null,
      };
      const hasRemainingChanges = remainingChangeSet.status === "ready";
      await updateConversation(conversationId, {
        activeChangeSet: hasRemainingChanges
          ? remainingChangeSet
          : appliedChangeSet,
        status: hasRemainingChanges
          ? "awaiting_confirmation"
          : "applied",
      });
      await appendEvent(conversationId, "change_set.applied", {
        id: current.id,
        hash: current.hash,
        status: appliedChangeSet.status,
        files: appliedFiles,
      });
      return { appliedChangeSet, remainingChangeSet };
    });
  }

  async function listVerifications(conversationId) {
    assertActive();
    const conversation = await conversationStore.get(conversationId);
    return structuredClone(conversation.verifications ?? []);
  }

  async function runVerification(conversationId, { requestId } = {}) {
    assertActive();
    assertConversationNotDeleting(conversationId);
    const conversation = await conversationStore.get(conversationId);
    const verification = (conversation.verifications ?? []).find(
      (item) => item.id === requestId && item.status === "requested",
    );
    if (!verification) {
      throw projectWorkError(
        "PROJECT_WORK_VERIFICATION_NOT_FOUND",
        "可运行的验证请求不存在",
        404,
      );
    }
    if (
      BUSY_CONVERSATION_STATUSES.has(conversation.status)
      || verificationControllers.has(conversationId)
      || (conversation.verifications ?? []).some((item) => item.status === "running")
    ) {
      throw projectWorkError(
        "PROJECT_WORK_VERIFICATION_BUSY",
        "当前会话已有操作正在运行",
        409,
      );
    }
    if (
      conversation.activeChangeSet
      && !["clean", "applied"].includes(
        conversation.activeChangeSet.status,
      )
    ) {
      throw projectWorkError(
        "PROJECT_WORK_CHANGES_NOT_APPLIED",
        "请先确认或取消待审阅修改，再运行验证",
        409,
      );
    }
    const workspace = await resolveConversationWorkspace(conversation);
    assertConversationNotDeleting(conversationId);
    const paths = conversationPaths(conversationId);
    const controller = new AbortController();
    verificationControllers.set(conversationId, controller);
    const attempt = {
      ...verification,
      id: `verification-run-${idFactory()}`,
      commandId: verification.id,
      status: "running",
      exitCode: null,
      durationMs: null,
      output: "",
      truncated: false,
      createdAt: timestamp(),
      completedAt: null,
    };
    const verificationDirectory = path.join(
      paths.directory,
      "verification-runs",
      attempt.id,
    );
    const verificationBaseRoot = path.join(verificationDirectory, "base");
    const verificationWorkspaceRoot = path.join(verificationDirectory, "workspace");
    await updateConversation(conversationId, (current) => ({
      status: "verifying",
      verifications: [...current.verifications, attempt],
    }));
    await appendEvent(conversationId, "verification.started", {
      id: attempt.id,
      commandId: verification.id,
      command: verification.command,
    });
    let result;
    try {
      const materialized = await createSnapshot({
        projectRoot: workspace.projectRoot,
        baseRoot: verificationBaseRoot,
        workspaceRoot: verificationWorkspaceRoot,
        storageRoot: configuredStorageRoot,
      });
      if (
        materialized?.truncated === true
        || (materialized?.skippedBinaryFiles ?? 0) > 0
        || (materialized?.skippedOversizedFiles ?? 0) > 0
      ) {
        throw projectWorkError(
          "PROJECT_WORK_VERIFICATION_SNAPSHOT_INCOMPLETE",
          "无法完整物化项目，未运行验证",
          409,
          true,
        );
      }
      const resolvedScript = await resolvePackageScript(
        {
          projectRoot: verificationWorkspaceRoot,
          baseRoot: verificationBaseRoot,
          workspaceRoot: verificationWorkspaceRoot,
        },
        verification.command,
      );
      if ((resolvedScript ?? null) !== (verification.resolvedScript ?? null)) {
        throw projectWorkError(
          "PROJECT_WORK_VERIFICATION_BINDING_CHANGED",
          "实际项目脚本已变化，请让 Pi 重新保存验证命令",
          409,
          true,
        );
      }
      const cwd = await resolveVerificationCwd(
        verificationWorkspaceRoot,
        verification.command.cwd,
      );
      result = await runner({
        ...verification.command,
        cwd,
        signal: controller.signal,
      });
    } catch (error) {
      result = {
        exitCode: null,
        durationMs: null,
        stdout: "",
        stderr: error instanceof ProjectWorkError
          ? error.message
          : "验证进程无法启动",
        truncated: false,
        timedOut: false,
        aborted: controller.signal.aborted,
      };
    } finally {
      await rm(verificationDirectory, { recursive: true, force: true })
        .catch(() => undefined);
      if (verificationControllers.get(conversationId) === controller) {
        verificationControllers.delete(conversationId);
      }
    }
    const rawOutput = [
      result.stdout ? `stdout:\n${result.stdout}` : "",
      result.stderr ? `stderr:\n${result.stderr}` : "",
    ].filter(Boolean).join("\n\n");
    const output = await sanitizeForConversation(conversationId, rawOutput);
    const status = result.aborted
      ? "aborted"
      : result.exitCode === 0 && !result.timedOut
        ? "passed"
        : "failed";
    const completedAt = timestamp();
    const completed = {
      ...attempt,
      status,
      exitCode: result.exitCode ?? null,
      durationMs: result.durationMs ?? null,
      output,
      truncated: result.truncated === true,
      timedOut: result.timedOut === true,
      completedAt,
    };
    await updateConversation(conversationId, (current) => ({
      status: status === "aborted" ? "aborted" : "idle",
      verifications: current.verifications.map((item) => (
        item.id === attempt.id ? completed : item
      )),
    }));
    await appendEvent(conversationId, "verification.completed", {
      id: attempt.id,
      commandId: verification.id,
      status,
      exitCode: completed.exitCode,
      durationMs: completed.durationMs,
      truncated: completed.truncated,
    });
    return completed;
  }

  async function removeScopedConversation({
    projectId,
    workspaceKind,
  }, conversationId) {
    const conversation = await conversationStore.get(conversationId);
    if (workspaceKind === "scratch") {
      assertStandaloneConversation(conversation);
    } else {
      assertConversationProject(conversation, projectId);
    }
    assertConversationNotDeleting(conversationId);
    assertConversationDeletable(conversation);
    const lockKey = workspaceKind === "scratch"
      ? `conversation:${conversationId}`
      : `project:${projectId}`;
    if (applyQueues.has(lockKey)) {
      throw projectWorkError(
        "PROJECT_WORK_CONVERSATION_DELETE_BUSY",
        "工作会话仍有正在运行的 Agent、验证或修改应用操作",
        409,
        true,
      );
    }

    deletingConversations.add(conversationId);
    try {
      return await withApplyLock(lockKey, async () => {
        const current = await conversationStore.get(conversationId);
        if (workspaceKind === "scratch") {
          assertStandaloneConversation(current);
        } else {
          assertConversationProject(current, projectId);
        }
        assertConversationDeletable(current);
        const runtime = runtimes.get(conversationId);
        if (runtime?.eventQueue) await runtime.eventQueue;
        const latest = await conversationStore.get(conversationId);
        if (workspaceKind === "scratch") {
          assertStandaloneConversation(latest);
        } else {
          assertConversationProject(latest, projectId);
        }
        assertConversationDeletable(latest);
        runtime?.unsubscribe?.();
        runtime?.host?.dispose?.();
        runtimes.delete(conversationId);
        await conversationStore.remove(conversationId);
        const conversationCount = (
          await conversationStore.list(workspaceKind === "scratch" ? null : projectId)
        ).length;
        return {
          id: conversationId,
          projectId: workspaceKind === "scratch" ? null : projectId,
          removed: true,
          conversationCount,
        };
      });
    } finally {
      deletingConversations.delete(conversationId);
    }
  }

  async function removeConversation(projectId, conversationId) {
    assertActive();
    const project = await registry.getMetadata(projectId);
    return removeScopedConversation({
      projectId: project.id,
      workspaceKind: "bound_project",
    }, conversationId);
  }

  async function removeStandaloneConversation(conversationId) {
    assertActive();
    return removeScopedConversation({
      projectId: null,
      workspaceKind: "scratch",
    }, conversationId);
  }

  async function renameConversation(projectId, conversationId, { title } = {}) {
    assertActive();
    assertConversationNotDeleting(conversationId);
    const normalizedTitle = conversationTitle(title);
    const project = await registry.getMetadata(projectId);
    const conversation = await conversationStore.get(conversationId);
    assertConversationProject(conversation, project.id);
    assertConversationNotDeleting(conversationId);
    const updated = await updateConversation(conversationId, {
      title: normalizedTitle,
    });
    return publicConversationSummary(updated);
  }

  async function renameStandaloneConversation(conversationId, { title } = {}) {
    assertActive();
    assertConversationNotDeleting(conversationId);
    const normalizedTitle = conversationTitle(title);
    const conversation = await conversationStore.get(conversationId);
    assertStandaloneConversation(conversation);
    const updated = await updateConversation(conversationId, {
      title: normalizedTitle,
    });
    return publicConversationSummary(updated);
  }

  async function removeProject(projectId) {
    assertActive();
    if (deletingProjects.has(projectId)) {
      throw projectWorkError(
        "PROJECT_WORK_PROJECT_DELETE_IN_PROGRESS",
        "项目正在删除",
        409,
        true,
      );
    }
    const project = await registry.get(projectId);
    deletingProjects.add(project.id);
    let guardedConversationIds = [];
    const hasBusyConversation = (items) => items.some((conversation) => (
      BUSY_CONVERSATION_STATUSES.has(conversation.status)
      || (documentOperationCounts.get(conversation.id) ?? 0) > 0
      || hasActiveConversationDocuments(conversation)
      || (conversation.verifications ?? []).some(
        (verification) => verification.status === "running",
      )
    ));
    try {
      if ((conversationCreationCounts.get(project.id) ?? 0) > 0) {
        throw projectWorkError(
          "PROJECT_WORK_PROJECT_BUSY",
          "项目仍有正在创建的工作会话",
          409,
          true,
        );
      }
      const conversations = await conversationStore.list(project.id);
      if (hasBusyConversation(conversations)) {
        throw projectWorkError(
          "PROJECT_WORK_PROJECT_BUSY",
          "项目仍有正在运行的 Agent、验证或 PDF 解析任务",
          409,
        );
      }
      guardedConversationIds = conversations.map(
        (conversation) => conversation.id,
      );
      for (const conversationId of guardedConversationIds) {
        deletingConversations.add(conversationId);
      }
      const latestConversations = await conversationStore.list(project.id);
      if (hasBusyConversation(latestConversations)) {
        throw projectWorkError(
          "PROJECT_WORK_PROJECT_BUSY",
          "项目仍有正在运行的 Agent、验证或 PDF 解析任务",
          409,
        );
      }
      for (const conversation of latestConversations) {
        const runtime = runtimes.get(conversation.id);
        runtime?.unsubscribe?.();
        runtime?.host?.dispose?.();
        runtimes.delete(conversation.id);
        await conversationStore.remove(conversation.id);
      }
      await registry.remove(projectId);
      return {
        id: project.id,
        removed: true,
      };
    } finally {
      deletingProjects.delete(project.id);
      for (const conversationId of guardedConversationIds) {
        deletingConversations.delete(conversationId);
      }
    }
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    await documentService.dispose();
    for (const controller of verificationControllers.values()) controller.abort();
    verificationControllers.clear();
    const closing = [];
    for (const runtime of runtimes.values()) {
      runtime.unsubscribe?.();
      if (runtime.host?.abort) closing.push(Promise.resolve(runtime.host.abort()));
      if (runtime.completion) closing.push(runtime.completion);
      runtime.host?.dispose?.();
    }
    runtimes.clear();
    activeMessageClaims.clear();
    await Promise.allSettled(closing);
    await effectiveSessionFactory.dispose?.();
  }

  return Object.freeze({
    abortConversation,
    applyChangeSet,
    compactConversation,
    configureConversation,
    createConversation,
    createConversationDocument,
    createStandaloneConversation,
    dispose,
    getChangeSet,
    getConversation,
    getConversationTree,
    getProjectTree,
    listConversations,
    listModels,
    listProjects,
    listStandaloneConversations,
    listVerifications,
    pickProjectRoot,
    readConversationFile,
    readProjectFile,
    registerProject,
    removeConversation,
    removeConversationDocument,
    removeProject,
    removeStandaloneConversation,
    renameConversation,
    renameStandaloneConversation,
    retryConversationDocument,
    runVerification,
    sendMessage,
    steerConversation,
    uploadConversationDocument,
  });
}

export { ProjectWorkError };
