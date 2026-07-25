import { randomUUID } from "node:crypto";
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
import { createConversationStore } from "./conversationStore.js";
import {
  ProjectWorkError,
  projectWorkError,
  safeProjectWorkError,
} from "./errors.js";
import {
  createPiSessionFactory,
  readProjectWorkOverlayTextFile,
} from "./piSessionHost.js";
import { createMacOSProjectPicker } from "./macosProjectPicker.js";
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
const THINKING_LEVELS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const SAFE_VERIFICATION_FILES = new Set(["npm", "pnpm", "yarn", "bun", "node"]);
const PACKAGE_COMMANDS = new Set(["test", "run", "lint", "check", "typecheck"]);
const DEFAULT_CONVERSATION_TITLE = "新工作会话";
const STANDALONE_ROOT_LABEL = "未连接文件夹";
const BUSY_CONVERSATION_STATUSES = new Set([
  "running",
  "compacting",
  "verifying",
]);

function compactText(value, maxLength, fallback = "") {
  const normalized = String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replaceAll(/\s+/g, " ");
  return normalized.slice(0, maxLength) || fallback;
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
      status: message.status,
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
  return {
    providerId: provider.id,
    modelId: model.id,
    modelRef: `${provider.id}/${model.id}`,
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

export function createProjectWorkService({
  storageRoot = defaultStorageRoot(),
  sessionFactory,
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
  const verificationControllers = new Map();
  const applyQueues = new Map();
  const deletingConversations = new Set();
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
      || (conversation.verifications ?? []).some(
        (verification) => verification.status === "running",
      )
    ) {
      throw projectWorkError(
        "PROJECT_WORK_CONVERSATION_DELETE_BUSY",
        "工作会话仍有正在运行的 Agent、验证或修改应用操作",
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
    switch (event?.type) {
      case "agent_start":
        await updateConversation(conversationId, {
          status: "running",
          lastError: null,
        });
        await appendEvent(conversationId, "agent.status", { status: "running" });
        break;
      case "agent_end":
        await appendEvent(conversationId, "agent.turn_finished", {
          willRetry: event.willRetry === true,
        });
        break;
      case "agent_settled":
        try {
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
        });
        break;
      case "turn_end":
        await appendEvent(conversationId, "turn.completed", {
          turnIndex: runtime.turnIndex,
        });
        break;
      case "message_start":
        if (event.message?.role === "assistant") {
          runtime.activeAssistantId = `message-${idFactory()}`;
          runtime.assistantText = "";
          await appendEvent(conversationId, "message.started", {
            id: runtime.activeAssistantId,
            role: "assistant",
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
        } else if (assistantEvent?.type?.startsWith("thinking_")) {
          await appendEvent(conversationId, "agent.thinking", {
            status: assistantEvent.type.endsWith("_end") ? "finished" : "active",
          });
        }
        break;
      }
      case "message_end":
        if (event.message?.role === "assistant" && runtime.activeAssistantId) {
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
        await appendEvent(conversationId, "compaction.started", {
          reason: event.reason ?? "manual",
        });
        break;
      case "compaction_end":
        await appendEvent(conversationId, "compaction.completed", {
          reason: event.reason ?? "manual",
          aborted: event.aborted === true,
          status: event.errorMessage ? "failed" : "completed",
        });
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
      completion: null,
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
    return runtime;
  }

  async function snapshot(conversationId, options = {}) {
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
    if (
      ["running", "compacting"].includes(conversation.status)
      && !runtimes.has(conversationId)
    ) {
      conversation = await updateConversation(conversationId, {
        status: "interrupted",
        lastError: {
          code: "PROJECT_WORK_SESSION_INTERRUPTED",
          message: "上一次 Agent 操作未正常结束，可以重新发送任务继续",
          retryable: true,
        },
      });
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

  async function listModels() {
    assertActive();
    if (typeof effectiveSessionFactory.listModels !== "function") {
      throw projectWorkError(
        "PROJECT_WORK_MODELS_UNAVAILABLE",
        "Pi 模型目录当前不可用",
        503,
        true,
      );
    }
    return effectiveSessionFactory.listModels();
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
    thinkingLevel = "medium",
  } = {}) {
    assertActive();
    if (!THINKING_LEVELS.has(thinkingLevel)) {
      throw projectWorkError(
        "PROJECT_WORK_THINKING_LEVEL_INVALID",
        "思考强度无效",
        400,
      );
    }
    const requestedProviderId = compactText(providerId, 120) || null;
    const requestedModelId = compactText(modelId, 200) || null;
    const catalog = validateModel && typeof effectiveSessionFactory.listModels === "function"
      ? await effectiveSessionFactory.listModels()
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
        };
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
        thinkingLevel,
        messages: [],
        plan: null,
        activeChangeSet: null,
        verifications: [],
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
    const project = await registry.get(projectId);
    return createConversationRecord({
      projectId: project.id,
      workspaceKind: "bound_project",
      rootLabel: project.rootLabel,
    }, options);
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

  async function sendMessage(conversationId, {
    text,
    context = [],
    providerId,
    modelId,
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
    const conversation = await conversationStore.get(conversationId);
    if (BUSY_CONVERSATION_STATUSES.has(conversation.status)) {
      throw projectWorkError(
        "PROJECT_WORK_CONVERSATION_BUSY",
        "Agent 正在工作，请使用调整任务或等待当前操作完成",
        409,
      );
    }
    const runtime = await getRuntime(conversationId);
    if (providerId || modelId) {
      const catalog = await listModels();
      const selectedModel = selectModel(catalog, {
        providerId: providerId || conversation.providerId,
        modelId: modelId || conversation.modelId,
      });
      if (selectedModel.modelRef !== conversation.modelRef) {
        if (typeof runtime.host.setModel !== "function") {
          throw projectWorkError(
            "PROJECT_WORK_MODEL_SWITCH_UNAVAILABLE",
            "当前 Pi 会话不能切换模型",
            409,
          );
        }
        await runtime.host.setModel(selectedModel.modelRef);
        await updateConversation(conversationId, selectedModel);
        await appendEvent(conversationId, "model.changed", {
          providerId: selectedModel.providerId,
          modelId: selectedModel.modelId,
        });
      }
    }
    const promptContext = await buildPromptContext(conversationId, context);
    const createdAt = timestamp();
    const userMessage = {
      id: `message-${idFactory()}`,
      role: "user",
      text: messageText,
      status: "accepted",
      createdAt,
    };
    await updateConversation(conversationId, (current) => ({
      title: (
        current.title === DEFAULT_CONVERSATION_TITLE
        && (current.messages ?? []).length === 0
      )
        ? conversationTitleFromMessage(messageText)
        : current.title,
      status: "running",
      messages: [...(current.messages ?? []), userMessage],
      lastError: null,
    }));
    await appendEvent(conversationId, "message.created", userMessage);
    const completion = Promise.resolve()
      .then(() => runtime.host.prompt(`${messageText}${promptContext}`))
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
        const latest = await conversationStore.get(conversationId);
        if (latest.status === "running") {
          await updateConversation(conversationId, { status: "idle" });
          await appendEvent(conversationId, "agent.status", { status: "idle" });
        }
        runtime.completion = null;
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
    await updateConversation(conversationId, { status: "compacting" });
    try {
      await runtime.host.compact(
        instructions ? String(instructions).slice(0, 2_000) : undefined,
      );
      await runtime.eventQueue;
      await updateConversation(conversationId, { status: "idle" });
    } catch (error) {
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
    const project = await registry.get(projectId);
    const conversations = await conversationStore.list(projectId);
    if (conversations.some((conversation) => (
      BUSY_CONVERSATION_STATUSES.has(conversation.status)
      || (conversation.verifications ?? []).some(
        (verification) => verification.status === "running",
      )
    ))) {
      throw projectWorkError(
        "PROJECT_WORK_PROJECT_BUSY",
        "项目仍有正在运行的 Agent 或验证任务",
        409,
      );
    }
    for (const conversation of conversations) {
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
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
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
    await Promise.allSettled(closing);
    await effectiveSessionFactory.dispose?.();
  }

  return Object.freeze({
    abortConversation,
    applyChangeSet,
    compactConversation,
    createConversation,
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
    removeProject,
    removeStandaloneConversation,
    renameConversation,
    renameStandaloneConversation,
    runVerification,
    sendMessage,
    steerConversation,
  });
}

export { ProjectWorkError };
