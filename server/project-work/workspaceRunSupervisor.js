import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { projectWorkError } from "./errors.js";

const RUN_RECORD_SCHEMA_VERSION = 1;
const RUN_EVENT_SCHEMA_VERSION = 1;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u;
const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/u;
const TERMINAL_STATUSES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);
const RECOVERABLE_STATUSES = new Set(["queued", "running"]);
const STREAMS = new Set(["stdout", "stderr"]);
const DEFAULT_EVENT_LIMIT = 500;
const MAX_EVENT_LIMIT = 1_000;
const DEFAULT_MAX_EVENT_BYTES = 32 * 1024;
const DEFAULT_MAX_STREAM_BYTES = 8 * 1024 * 1024;
const DEFAULT_PARTIAL_LINE_BYTES = 1_024;
const DEFAULT_REDACTION_TAIL_BYTES = 512;
const DEFAULT_INTERRUPT_GRACE_MS = 500;
const DEFAULT_TERMINATE_GRACE_MS = 1_000;
const DEFAULT_KILL_GRACE_MS = 1_000;
const OUTPUT_TRUNCATION_MARKER = "\n… 运行日志达到持久化上限，后续输出已省略 …\n";

const BLOCKED_EXECUTABLES = new Set([
  "bash",
  "bunx",
  "cmd",
  "cmd.exe",
  "csh",
  "dash",
  "env",
  "fish",
  "ksh",
  "npx",
  "nu",
  "pnpx",
  "powershell",
  "pwsh",
  "sh",
  "tcsh",
  "xargs",
  "zsh",
]);

const PACKAGE_MANAGER_EXECUTABLES = new Set([
  "apt",
  "apt-get",
  "brew",
  "dnf",
  "pacman",
  "yum",
]);
const NETWORK_EXECUTABLES = new Set([
  "curl",
  "ftp",
  "nc",
  "netcat",
  "rsync",
  "scp",
  "sftp",
  "ssh",
  "telnet",
  "wget",
]);
const MUTATING_EXECUTABLES = new Set([
  "chmod",
  "chown",
  "cp",
  "dd",
  "git",
  "install",
  "ln",
  "mv",
  "rm",
  "rmdir",
  "tee",
  "truncate",
]);
const PROJECT_SCRIPT_RUNNERS = new Set(["bun", "npm", "pnpm", "yarn"]);

const SAFE_ENVIRONMENT_OVERRIDES = Object.freeze({
  CARGO_NET_OFFLINE: new Set(["true"]),
  CI: new Set(["1", "true"]),
  FORCE_COLOR: new Set(["0"]),
  GOPROXY: new Set(["off"]),
  GOSUMDB: new Set(["off"]),
  GOTOOLCHAIN: new Set(["local"]),
  GRADLE_OPTS: new Set(["-Dorg.gradle.offline=true"]),
  NO_COLOR: new Set(["1"]),
  PIP_DISABLE_PIP_VERSION_CHECK: new Set(["1"]),
  PIP_NO_INDEX: new Set(["1"]),
});

const DANGEROUS_ENVIRONMENT_NAMES = new Set([
  "BASH_ENV",
  "CDPATH",
  "DOCKER_CONFIG",
  "ENV",
  "GIT_ASKPASS",
  "GIT_SSH_COMMAND",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "KUBECONFIG",
  "NODE_OPTIONS",
  "PERL5OPT",
  "PYTHONPATH",
  "RUBYOPT",
  "SSH_AGENT_PID",
  "SSH_AUTH_SOCK",
]);

const PROVIDER_ENVIRONMENT_PATTERN = /^(?:PI_|ANTHROPIC_|ARK_|AZURE_OPENAI_|DEEPSEEK_|FEISHU_|GEMINI_|GOOGLE_AI_|LARK_|MISTRAL_|NOTIFICATION_|OPENAI_|SLACK_|TAVILY_|TEAMS_|VOLCENGINE_)/iu;
const SECRET_ENVIRONMENT_PATTERN = /(?:^|_)(?:API_?KEY|AUTH(?:ORIZATION)?|CREDENTIALS?|PASSWORD|SECRET|TOKEN|WEBHOOK)(?:_|$)/iu;
const DYNAMIC_LOADER_ENVIRONMENT_PATTERN = /^(?:DYLD_|LD_PRELOAD$)/u;

function runError(code, message, status = 409, retryable = false) {
  return projectWorkError(code, message, status, retryable);
}

function nowIso(now) {
  return new Date(now()).toISOString();
}

function assertRunId(value) {
  if (typeof value !== "string" || !RUN_ID_PATTERN.test(value)) {
    throw runError("PROJECT_WORK_RUN_ID_INVALID", "运行记录标识无效", 400);
  }
  return value;
}

function assertWorkspaceId(value) {
  if (typeof value !== "string" || !WORKSPACE_ID_PATTERN.test(value)) {
    throw runError("PROJECT_WORK_WORKSPACE_ID_INVALID", "Workspace 标识无效", 400);
  }
  return value;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function isSensitiveEnvironmentName(name) {
  return (
    DANGEROUS_ENVIRONMENT_NAMES.has(name)
    || PROVIDER_ENVIRONMENT_PATTERN.test(name)
    || SECRET_ENVIRONMENT_PATTERN.test(name)
    || DYNAMIC_LOADER_ENVIRONMENT_PATTERN.test(name)
  );
}

function normalizeEnvironmentOverrides(value) {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw runError(
      "PROJECT_WORK_RUN_ENVIRONMENT_INVALID",
      "运行环境必须来自服务端注册配方",
      400,
    );
  }
  const normalized = {};
  for (const [name, setting] of Object.entries(value)) {
    const allowed = SAFE_ENVIRONMENT_OVERRIDES[name];
    if (!allowed || typeof setting !== "string" || !allowed.has(setting)) {
      throw runError(
        "PROJECT_WORK_RUN_ENVIRONMENT_BLOCKED",
        "运行环境包含未注册的设置",
        400,
      );
    }
    normalized[name] = setting;
  }
  return normalized;
}

export function createWorkspaceRunEnvironment({
  baseEnvironment = process.env,
  environment,
} = {}) {
  const result = {};
  for (const [name, value] of Object.entries(baseEnvironment ?? {})) {
    if (
      typeof value !== "string"
      || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)
      || isSensitiveEnvironmentName(name)
    ) {
      continue;
    }
    result[name] = value;
  }
  return {
    ...result,
    ...normalizeEnvironmentOverrides(environment),
  };
}

function normalizedExecutable(file) {
  if (
    typeof file !== "string"
    || file.length < 1
    || file.length > 2_048
    || /[\u0000-\u001f\u007f]/u.test(file)
  ) {
    throw runError("PROJECT_WORK_RUN_COMMAND_INVALID", "运行命令无效", 400);
  }
  const basename = path.basename(file).toLowerCase();
  if (BLOCKED_EXECUTABLES.has(basename)) {
    throw runError(
      "PROJECT_WORK_RUN_SHELL_BLOCKED",
      "运行不支持 Shell、命令解释器或命令转发器",
      400,
    );
  }
  if (
    !path.isAbsolute(file)
    && path.basename(file) !== file
    && !file.startsWith(`.${path.sep}`)
    && !file.startsWith("./")
  ) {
    throw runError(
      "PROJECT_WORK_RUN_COMMAND_INVALID",
      "运行命令必须是已解析工具或 Workspace 内可执行文件",
      400,
    );
  }
  return { basename, file };
}

function normalizedArgs(args) {
  if (!Array.isArray(args) || args.length > 256) {
    throw runError("PROJECT_WORK_RUN_COMMAND_INVALID", "运行参数无效", 400);
  }
  let totalBytes = 0;
  const result = args.map((value) => {
    if (
      typeof value !== "string"
      || /\0/u.test(value)
      || Buffer.byteLength(value, "utf8") > 16 * 1024
    ) {
      throw runError("PROJECT_WORK_RUN_COMMAND_INVALID", "运行参数无效", 400);
    }
    totalBytes += Buffer.byteLength(value, "utf8");
    return value;
  });
  if (totalBytes > 128 * 1024) {
    throw runError("PROJECT_WORK_RUN_COMMAND_INVALID", "运行参数过长", 400);
  }
  return result;
}

function firstCommandArg(args) {
  return args.find((value) => !value.startsWith("-"))?.toLowerCase() ?? "";
}

function rejectsInlineCode(executable, args) {
  if (["node", "python", "python3", "ruby", "perl", "swift"].includes(executable)) {
    return args.some((value) => (
      ["-c", "-e", "--eval", "--print"].includes(value)
      || /^--(?:eval|print)=/u.test(value)
      || (/^-[ce].+/u.test(value) && !value.startsWith("--"))
    ));
  }
  return false;
}

function rejectsInstall(executable, args) {
  if (PACKAGE_MANAGER_EXECUTABLES.has(executable)) return true;
  const first = firstCommandArg(args);
  if (["npm", "pnpm", "yarn", "bun"].includes(executable)) {
    const words = args.map((value) => value.toLowerCase());
    return words.some((value) => (
      ["add", "ci", "install", "link", "update", "upgrade"].includes(value)
    ))
      || (executable === "npm" && words.includes("exec"))
      || (["pnpm", "yarn"].includes(executable) && words.includes("dlx"));
  }
  if (["pip", "pip3", "gem"].includes(executable)) {
    return first === "install";
  }
  if (["python", "python3"].includes(executable)) {
    const moduleIndex = args.findIndex((value) => value === "-m");
    return moduleIndex >= 0
      && ["pip", "ensurepip"].includes(args[moduleIndex + 1]?.toLowerCase())
      && args.slice(moduleIndex + 2).some((value) => value.toLowerCase() === "install");
  }
  if (executable === "cargo") return args.some((value) => value.toLowerCase() === "install");
  if (executable === "go") {
    return args.some((value) => ["get", "install"].includes(value.toLowerCase()));
  }
  return false;
}

function rejectsLongRunningOrNetwork(executable, args) {
  if (NETWORK_EXECUTABLES.has(executable)) return true;
  const lowered = args.map((value) => value.toLowerCase());
  if (lowered.some((value) => [
    "--detach",
    "--watch",
    "--watch-all",
    "--watchall",
    "daemon",
    "dev",
    "serve",
    "start",
    "watch",
  ].includes(value))) {
    return true;
  }
  return lowered.some((value) => /^(?:https?|ftp):\/\//u.test(value));
}

export function validateWorkspaceRunCommand({
  file,
  args = [],
  registeredRecipe = false,
} = {}) {
  const executable = normalizedExecutable(file);
  const normalized = normalizedArgs(args);
  if (MUTATING_EXECUTABLES.has(executable.basename)) {
    throw runError(
      "PROJECT_WORK_RUN_MUTATION_BLOCKED",
      "运行命令不能绕过文件或 Git 的专用审批流程",
      400,
    );
  }
  if (rejectsInlineCode(executable.basename, normalized)) {
    throw runError(
      "PROJECT_WORK_RUN_INLINE_CODE_BLOCKED",
      "运行不支持内联代码",
      400,
    );
  }
  if (rejectsInstall(executable.basename, normalized)) {
    throw runError(
      "PROJECT_WORK_RUN_INSTALL_BLOCKED",
      "运行不支持安装或下载依赖",
      400,
    );
  }
  if (!registeredRecipe && PROJECT_SCRIPT_RUNNERS.has(executable.basename)) {
    throw runError(
      "PROJECT_WORK_RUN_UNREGISTERED_SCRIPT_BLOCKED",
      "项目脚本只能通过已注册并重新解析的验证配方运行",
      400,
    );
  }
  if (rejectsLongRunningOrNetwork(executable.basename, normalized)) {
    throw runError(
      "PROJECT_WORK_RUN_BACKGROUND_OR_NETWORK_BLOCKED",
      "运行不支持后台、监听或隐式网络操作",
      400,
    );
  }
  return {
    file: executable.file,
    args: normalized,
  };
}

function cloneMetadata(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw runError("PROJECT_WORK_RUN_METADATA_INVALID", "运行元数据无效", 400);
  }
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw runError("PROJECT_WORK_RUN_METADATA_INVALID", "运行元数据无效", 400);
  }
  if (!serialized || Buffer.byteLength(serialized, "utf8") > 16 * 1024) {
    throw runError("PROJECT_WORK_RUN_METADATA_INVALID", "运行元数据过大", 400);
  }
  const cloned = JSON.parse(serialized);
  const inspect = (candidate, depth = 0) => {
    if (typeof candidate === "string") {
      if (
        path.isAbsolute(candidate)
        || defaultRedact(candidate) !== candidate
      ) {
        throw runError(
          "PROJECT_WORK_RUN_METADATA_UNSAFE",
          "运行元数据只能包含安全公开字段",
          400,
        );
      }
      return;
    }
    if (depth > 8) {
      throw runError("PROJECT_WORK_RUN_METADATA_INVALID", "运行元数据层级过深", 400);
    }
    if (!candidate || typeof candidate !== "object") return;
    for (const [key, nested] of Object.entries(candidate)) {
      if (/(?:absolutePath|apiKey|credential|password|secret|token|workspaceRoot)/iu.test(key)) {
        throw runError(
          "PROJECT_WORK_RUN_METADATA_UNSAFE",
          "运行元数据只能包含安全公开字段",
          400,
        );
      }
      inspect(nested, depth + 1);
    }
  };
  inspect(cloned);
  return cloned;
}

function replaceKnownPath(value, target, replacement) {
  if (typeof target !== "string" || !target || target === path.parse(target).root) {
    return value;
  }
  return value.split(target).join(replacement);
}

function defaultRedact(value, { workspaceRoot, workspaceRoots } = {}) {
  let result = String(value ?? "");
  const roots = [workspaceRoot, ...(workspaceRoots ?? [])]
    .filter((candidate, index, values) => (
      typeof candidate === "string" && values.indexOf(candidate) === index
    ))
    .sort((left, right) => right.length - left.length);
  for (const root of roots) {
    result = replaceKnownPath(result, root, "<workspace>");
  }
  result = replaceKnownPath(result, homedir(), "<home>");
  result = replaceKnownPath(result, tmpdir(), "<tmp>");
  result = replaceKnownPath(result, "/private/tmp", "<tmp>");
  return result
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^@\s/]+@/giu, "$1<redacted>@")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu, "Bearer <redacted>")
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_-]{8,}|npm_[A-Za-z0-9]{20,}|xox[a-z]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[A-Z0-9]{16})\b/giu,
      "<redacted>",
    )
    .replace(
      /\b((?:api[_-]?key|access[_-]?token|auth(?:orization)?|password|secret|token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
      "$1<redacted>",
    );
}

function createPublicSanitizer(redactOutput) {
  return (value, context) => {
    const initiallyRedacted = defaultRedact(value, context);
    if (typeof redactOutput !== "function") return initiallyRedacted;
    try {
      const custom = redactOutput(initiallyRedacted, context);
      if (typeof custom !== "string") return "<redacted>";
      return defaultRedact(custom, context);
    } catch {
      return "<redacted>";
    }
  };
}

function publicRun(record, sanitize) {
  const context = {
    kind: "command",
    runId: record.id,
    workspaceId: record.workspaceId,
    workspaceRoot: record.workspaceRoot,
    workspaceRoots: record.workspaceAliases,
  };
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    status: record.status,
    file: sanitize(record.command.file, context),
    args: record.command.args.map((value) => sanitize(value, context)),
    cwd: record.command.cwd,
    metadata: record.metadata === null ? null : structuredClone(record.metadata),
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    updatedAt: record.updatedAt,
    cancelRequestedAt: record.cancelRequestedAt,
    exitCode: record.exitCode,
    signal: record.signal,
    durationMs: record.durationMs,
    error: record.error ? sanitize(record.error, { ...context, kind: "error" }) : null,
    lastSeq: record.lastSeq,
    output: {
      stdoutBytes: record.output.stdoutBytes,
      stderrBytes: record.output.stderrBytes,
      truncated: record.output.truncated === true,
    },
  };
}

function utf8Prefix(value, maxBytes) {
  if (maxBytes <= 0 || !value) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    bytes += size;
    result += character;
  }
  return result;
}

function splitUtf8(value, maxBytes) {
  const chunks = [];
  let remaining = value;
  while (remaining) {
    const chunk = utf8Prefix(remaining, maxBytes);
    if (!chunk) break;
    chunks.push(chunk);
    remaining = remaining.slice(chunk.length);
  }
  return chunks;
}

function safeRelativeCwd(value) {
  const cwd = value ?? ".";
  if (
    typeof cwd !== "string"
    || !cwd.trim()
    || cwd.length > 2_048
    || path.isAbsolute(cwd)
    || /[\u0000-\u001f\u007f]/u.test(cwd)
  ) {
    throw runError("PROJECT_WORK_RUN_CWD_INVALID", "运行工作目录无效", 400);
  }
  const normalized = path.normalize(cwd);
  if (
    normalized === ".."
    || normalized.startsWith(`..${path.sep}`)
    || path.isAbsolute(normalized)
  ) {
    throw runError(
      "PROJECT_WORK_RUN_CWD_OUTSIDE_WORKSPACE",
      "运行工作目录必须位于 Workspace 内",
      400,
    );
  }
  return normalized === "" ? "." : normalized;
}

async function resolveCommandLayout({
  workspaceRoot,
  cwd,
  file,
  realpathImpl,
}) {
  if (typeof workspaceRoot !== "string" || !path.isAbsolute(workspaceRoot)) {
    throw runError("PROJECT_WORK_RUN_WORKSPACE_INVALID", "Workspace 目录无效", 400);
  }
  const canonicalRoot = await realpathImpl(workspaceRoot).catch(() => {
    throw runError("PROJECT_WORK_RUN_WORKSPACE_INVALID", "Workspace 目录不存在", 404);
  });
  if (canonicalRoot === path.parse(canonicalRoot).root) {
    throw runError("PROJECT_WORK_RUN_WORKSPACE_INVALID", "Workspace 范围过大", 400);
  }
  const relativeCwd = safeRelativeCwd(cwd);
  const requestedCwd = path.resolve(canonicalRoot, relativeCwd);
  const canonicalCwd = await realpathImpl(requestedCwd).catch(() => {
    throw runError("PROJECT_WORK_RUN_CWD_INVALID", "运行工作目录不存在", 404);
  });
  if (!isInside(canonicalRoot, canonicalCwd)) {
    throw runError(
      "PROJECT_WORK_RUN_CWD_OUTSIDE_WORKSPACE",
      "运行工作目录必须位于 Workspace 内",
      400,
    );
  }
  let spawnFile = file;
  if (!path.isAbsolute(file) && path.basename(file) !== file) {
    const requestedFile = path.resolve(canonicalCwd, file);
    const canonicalFile = await realpathImpl(requestedFile).catch(() => {
      throw runError(
        "PROJECT_WORK_RUN_COMMAND_INVALID",
        "Workspace 内可执行文件不存在",
        404,
      );
    });
    if (!isInside(canonicalRoot, canonicalFile)) {
      throw runError(
        "PROJECT_WORK_RUN_COMMAND_OUTSIDE_WORKSPACE",
        "Workspace 内命令不能指向外部文件",
        400,
      );
    }
    spawnFile = canonicalFile;
  }
  return {
    canonicalRoot,
    requestedRoot: path.resolve(workspaceRoot),
    canonicalCwd,
    relativeCwd: path.relative(canonicalRoot, canonicalCwd) || ".",
    spawnFile,
  };
}

function defaultKill(child, signal) {
  if (
    process.platform !== "win32"
    && Number.isInteger(child?.pid)
    && child.pid > 0
  ) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") return false;
    }
  }
  return child?.kill?.(signal) !== false;
}

function durationFrom(record, finishedAtMs) {
  const started = Date.parse(record.startedAt ?? record.createdAt);
  return Number.isFinite(started) ? Math.max(0, finishedAtMs - started) : 0;
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporaryPath, filePath);
}

function validatePersistedRecord(value, expectedId) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || value.schemaVersion !== RUN_RECORD_SCHEMA_VERSION
    || value.id !== expectedId
    || !RUN_ID_PATTERN.test(value.id)
    || !WORKSPACE_ID_PATTERN.test(value.workspaceId)
    || ![...RECOVERABLE_STATUSES, ...TERMINAL_STATUSES].includes(value.status)
    || typeof value.workspaceRoot !== "string"
    || !path.isAbsolute(value.workspaceRoot)
    || (
      value.workspaceAliases !== undefined
      && (
        !Array.isArray(value.workspaceAliases)
        || value.workspaceAliases.some((entry) => (
          typeof entry !== "string" || !path.isAbsolute(entry)
        ))
      )
    )
    || !value.command
    || typeof value.command.file !== "string"
    || !Array.isArray(value.command.args)
    || typeof value.command.cwd !== "string"
    || !value.output
  ) {
    throw runError(
      "PROJECT_WORK_RUN_RECORD_CORRUPT",
      "运行记录损坏，需要恢复后继续",
      500,
    );
  }
  return value;
}

function parseEventLine(line, previousSeq) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (
    !event
    || typeof event !== "object"
    || Array.isArray(event)
    || event.schemaVersion !== RUN_EVENT_SCHEMA_VERSION
    || !Number.isSafeInteger(event.seq)
    || event.seq <= previousSeq
    || !["status", "chunk"].includes(event.type)
  ) {
    return null;
  }
  if (
    event.type === "chunk"
    && (
      !STREAMS.has(event.stream)
      || !Number.isSafeInteger(event.offset)
      || event.offset < 0
      || typeof event.text !== "string"
    )
  ) {
    return null;
  }
  return event;
}

export function createWorkspaceRunSupervisor({
  storageRoot,
  spawnImpl = spawn,
  realpathImpl = realpath,
  killImpl = defaultKill,
  now = () => Date.now(),
  idFactory = () => `run-${randomUUID()}`,
  baseEnvironment = process.env,
  redactOutput,
  maxEventBytes = DEFAULT_MAX_EVENT_BYTES,
  maxStreamBytes = DEFAULT_MAX_STREAM_BYTES,
  partialLineBytes = DEFAULT_PARTIAL_LINE_BYTES,
  redactionTailBytes = DEFAULT_REDACTION_TAIL_BYTES,
  interruptGraceMs = DEFAULT_INTERRUPT_GRACE_MS,
  terminateGraceMs = DEFAULT_TERMINATE_GRACE_MS,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
} = {}) {
  if (typeof storageRoot !== "string" || !storageRoot.trim()) {
    throw new Error("storageRoot is required");
  }
  if (
    !Number.isInteger(maxEventBytes)
    || maxEventBytes < 256
    || !Number.isInteger(maxStreamBytes)
    || maxStreamBytes < maxEventBytes
  ) {
    throw new Error("workspace run log limits are invalid");
  }
  const runsRoot = path.resolve(storageRoot, "workspace-runs");
  const active = new Map();
  const listeners = new Map();
  const sanitize = createPublicSanitizer(redactOutput);
  let initializationPromise = null;
  let initialized = false;
  let disposed = false;

  const runDirectory = (runId) => path.join(runsRoot, assertRunId(runId));
  const recordPath = (runId) => path.join(runDirectory(runId), "run.json");
  const eventsPath = (runId) => path.join(runDirectory(runId), "events.jsonl");

  const persistRecord = (record) => writeJsonAtomic(recordPath(record.id), record);

  async function readRecord(runId) {
    const id = assertRunId(runId);
    try {
      return validatePersistedRecord(
        JSON.parse(await readFile(recordPath(id), "utf8")),
        id,
      );
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw runError("PROJECT_WORK_RUN_NOT_FOUND", "运行记录不存在", 404);
      }
      if (error?.code === "PROJECT_WORK_RUN_RECORD_CORRUPT") throw error;
      throw runError(
        "PROJECT_WORK_RUN_RECORD_CORRUPT",
        "运行记录损坏，需要恢复后继续",
        500,
      );
    }
  }

  async function parseEvents(runId, { repairTail = false } = {}) {
    let content;
    try {
      content = await readFile(eventsPath(runId), "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const hasNewline = /[\r\n]$/u.test(content);
    const lastNewline = Math.max(content.lastIndexOf("\n"), content.lastIndexOf("\r"));
    const committed = hasNewline
      ? content
      : lastNewline >= 0
        ? content.slice(0, lastNewline + 1)
        : "";
    const tail = hasNewline ? "" : content.slice(lastNewline + 1);
    const events = [];
    let sequence = 0;
    for (const line of committed.split(/\r\n|\n|\r/u).filter(Boolean)) {
      const event = parseEventLine(line, sequence);
      if (!event) {
        throw runError(
          "PROJECT_WORK_RUN_EVENT_LOG_CORRUPT",
          "运行日志损坏，需要恢复后继续",
          500,
        );
      }
      sequence = event.seq;
      events.push(event);
    }
    if (tail) {
      const event = parseEventLine(tail, sequence);
      if (event) {
        events.push(event);
        if (repairTail) await appendFile(eventsPath(runId), "\n", "utf8");
      } else if (!repairTail) {
        // An incomplete final append is invisible until initialization repairs it.
      } else {
        await writeFile(eventsPath(runId), committed, { encoding: "utf8", mode: 0o600 });
      }
    }
    return events;
  }

  function notify(runId, event) {
    for (const listener of listeners.get(runId) ?? []) {
      try {
        Promise.resolve(listener(structuredClone(event))).catch(() => undefined);
      } catch {
        // A disconnected listener cannot make durable logging fail.
      }
    }
  }

  async function appendEvent(record, fields) {
    const event = {
      schemaVersion: RUN_EVENT_SCHEMA_VERSION,
      seq: record.lastSeq + 1,
      at: nowIso(now),
      ...fields,
    };
    await mkdir(runDirectory(record.id), { recursive: true, mode: 0o700 });
    await appendFile(eventsPath(record.id), `${JSON.stringify(event)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    record.lastSeq = event.seq;
    record.updatedAt = event.at;
    notify(record.id, event);
    return event;
  }

  function enqueue(activeRun, operation) {
    const current = activeRun.eventQueue
      .catch(() => undefined)
      .then(operation);
    activeRun.eventQueue = current;
    current.catch((error) => {
      activeRun.persistenceError ??= error;
    });
    return current;
  }

  function appendChunk(activeRun, stream, rawText) {
    if (!rawText) return;
    enqueue(activeRun, async () => {
      const record = activeRun.record;
      const context = {
        kind: "output",
        runId: record.id,
        workspaceId: record.workspaceId,
        workspaceRoot: record.workspaceRoot,
        workspaceRoots: record.workspaceAliases,
        stream,
      };
      const sanitizedText = sanitize(rawText, context);
      let text = sanitizedText;
      const bytesKey = stream === "stdout" ? "stdoutBytes" : "stderrBytes";
      const currentBytes = record.output[bytesKey];
      const remainingBytes = Math.max(0, maxStreamBytes - currentBytes);
      const accepted = utf8Prefix(text, remainingBytes);
      text = accepted;
      for (const chunk of splitUtf8(text, maxEventBytes)) {
        const offset = record.output[bytesKey];
        await appendEvent(record, {
          type: "chunk",
          stream,
          offset,
          text: chunk,
        });
        record.output[bytesKey] += Buffer.byteLength(chunk, "utf8");
      }
      if (accepted.length < sanitizedText.length && !activeRun.streams[stream].truncated) {
        activeRun.streams[stream].truncated = true;
        record.output.truncated = true;
        const offset = record.output[bytesKey];
        await appendEvent(record, {
          type: "chunk",
          stream,
          offset,
          text: OUTPUT_TRUNCATION_MARKER,
        });
        record.output[bytesKey] += Buffer.byteLength(OUTPUT_TRUNCATION_MARKER, "utf8");
      }
    });
  }

  function drainStream(activeRun, stream, final = false) {
    const state = activeRun.streams[stream];
    if (final) state.pending += state.decoder.end();
    if (!state.pending) return;
    let flushLength = state.pending.length;
    if (!final) {
      const lastNewline = Math.max(
        state.pending.lastIndexOf("\n"),
        state.pending.lastIndexOf("\r"),
      );
      if (lastNewline >= 0) {
        flushLength = lastNewline + 1;
      } else if (Buffer.byteLength(state.pending, "utf8") <= partialLineBytes) {
        return;
      } else {
        const totalBytes = Buffer.byteLength(state.pending, "utf8");
        const candidate = utf8Prefix(
          state.pending,
          Math.max(1, totalBytes - redactionTailBytes),
        );
        const lastBoundary = Math.max(
          candidate.lastIndexOf(" "),
          candidate.lastIndexOf("\t"),
        );
        if (lastBoundary < 0) return;
        flushLength = lastBoundary + 1;
      }
    }
    const text = state.pending.slice(0, flushLength);
    state.pending = state.pending.slice(flushLength);
    appendChunk(activeRun, stream, text);
  }

  function acceptOutput(activeRun, stream, chunk) {
    const state = activeRun.streams[stream];
    state.pending += state.decoder.write(
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)),
    );
    drainStream(activeRun, stream, false);
  }

  function signalExit(activeRun) {
    for (const resolve of activeRun.exitWaiters) resolve(true);
    activeRun.exitWaiters.clear();
  }

  async function finalize(activeRun, {
    exitCode = null,
    signal = null,
    status,
    error = null,
  } = {}) {
    if (activeRun.finishingPromise) return activeRun.finishingPromise;
    activeRun.finishingPromise = (async () => {
      drainStream(activeRun, "stdout", true);
      drainStream(activeRun, "stderr", true);
      await activeRun.eventQueue.catch(() => undefined);
      const record = activeRun.record;
      const finishedAtMs = now();
      const terminalStatus = status
        ?? (record.cancelRequestedAt
          ? "cancelled"
          : exitCode === 0
            ? "succeeded"
            : "failed");
      record.status = terminalStatus;
      record.exitCode = Number.isInteger(exitCode) ? exitCode : null;
      record.signal = typeof signal === "string" ? signal : null;
      record.error = error
        ? sanitize(error, {
          kind: "error",
          runId: record.id,
          workspaceId: record.workspaceId,
          workspaceRoot: record.workspaceRoot,
          workspaceRoots: record.workspaceAliases,
        }).slice(0, 2_000)
        : activeRun.persistenceError
          ? "运行日志持久化失败"
          : null;
      record.completedAt = nowIso(() => finishedAtMs);
      record.updatedAt = record.completedAt;
      record.durationMs = durationFrom(record, finishedAtMs);
      await appendEvent(record, {
        type: "status",
        status: terminalStatus,
        exitCode: record.exitCode,
        signal: record.signal,
        error: record.error,
      });
      await persistRecord(record);
      if (active.get(record.id) === activeRun) active.delete(record.id);
      signalExit(activeRun);
      const result = publicRun(record, sanitize);
      activeRun.resolveCompletion(result);
      return result;
    })();
    return activeRun.finishingPromise;
  }

  function attachChild(activeRun) {
    const child = activeRun.child;
    child.stdout?.on("data", (chunk) => acceptOutput(activeRun, "stdout", chunk));
    child.stderr?.on("data", (chunk) => acceptOutput(activeRun, "stderr", chunk));
    child.once("error", (error) => {
      void finalize(activeRun, {
        status: "failed",
        error: `无法启动运行命令：${error?.message ?? "未知错误"}`,
      });
    });
    child.once("close", (exitCode, signal) => {
      void finalize(activeRun, { exitCode, signal });
    });
  }

  async function reconcileRecord(record, { repairTail = false } = {}) {
    const events = await parseEvents(record.id, { repairTail });
    record.lastSeq = Math.max(record.lastSeq ?? 0, events.at(-1)?.seq ?? 0);
    for (const event of events) {
      if (event.type !== "chunk") continue;
      const bytesKey = event.stream === "stdout" ? "stdoutBytes" : "stderrBytes";
      record.output[bytesKey] = Math.max(
        record.output[bytesKey] ?? 0,
        event.offset + Buffer.byteLength(event.text, "utf8"),
      );
      record.output.truncated ||= event.text === OUTPUT_TRUNCATION_MARKER;
    }
    return { events, record };
  }

  async function recoverPersistedRuns() {
    await mkdir(runsRoot, { recursive: true, mode: 0o700 });
    const entries = await readdir(runsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !RUN_ID_PATTERN.test(entry.name)) continue;
      const record = await readRecord(entry.name);
      await reconcileRecord(record, { repairTail: true });
      if (!RECOVERABLE_STATUSES.has(record.status)) continue;
      const finishedAtMs = now();
      record.status = "interrupted";
      record.completedAt = nowIso(() => finishedAtMs);
      record.updatedAt = record.completedAt;
      record.durationMs = durationFrom(record, finishedAtMs);
      record.exitCode = null;
      record.signal = null;
      record.error = "运行服务重启，无法确认原进程状态；本次运行未自动重试";
      await appendEvent(record, {
        type: "status",
        status: "interrupted",
        exitCode: null,
        signal: null,
        error: record.error,
      });
      await persistRecord(record);
    }
  }

  async function initialize() {
    if (initialized) return;
    if (!initializationPromise) {
      initializationPromise = recoverPersistedRuns().then(() => {
        initialized = true;
      });
    }
    return initializationPromise;
  }

  async function start({
    workspaceId,
    workspaceRoot,
    file,
    args = [],
    cwd = ".",
    environment,
    metadata,
    registeredRecipe = false,
  } = {}) {
    if (disposed) {
      throw runError("PROJECT_WORK_RUN_SUPERVISOR_CLOSED", "运行服务已停止", 503);
    }
    await initialize();
    const normalizedWorkspaceId = assertWorkspaceId(workspaceId);
    const command = validateWorkspaceRunCommand({
      file,
      args,
      registeredRecipe,
    });
    const spawnEnvironment = createWorkspaceRunEnvironment({
      baseEnvironment,
      environment,
    });
    const layout = await resolveCommandLayout({
      workspaceRoot,
      cwd,
      file: command.file,
      realpathImpl,
    });
    const runId = assertRunId(idFactory());
    const createdAt = nowIso(now);
    const record = {
      schemaVersion: RUN_RECORD_SCHEMA_VERSION,
      id: runId,
      workspaceId: normalizedWorkspaceId,
      workspaceRoot: layout.canonicalRoot,
      workspaceAliases: [layout.canonicalRoot, layout.requestedRoot]
        .filter((value, index, values) => values.indexOf(value) === index),
      status: "queued",
      command: {
        file: command.file,
        args: command.args,
        cwd: layout.relativeCwd,
      },
      metadata: cloneMetadata(metadata),
      createdAt,
      startedAt: null,
      completedAt: null,
      updatedAt: createdAt,
      cancelRequestedAt: null,
      exitCode: null,
      signal: null,
      durationMs: null,
      error: null,
      lastSeq: 0,
      output: {
        stdoutBytes: 0,
        stderrBytes: 0,
        truncated: false,
      },
      pid: null,
    };
    let resolveCompletion;
    const completion = new Promise((resolve) => {
      resolveCompletion = resolve;
    });
    const activeRun = {
      record,
      child: null,
      completion,
      resolveCompletion,
      eventQueue: Promise.resolve(),
      persistenceError: null,
      finishingPromise: null,
      cancelPromise: null,
      exitWaiters: new Set(),
      streams: {
        stdout: {
          decoder: new StringDecoder("utf8"),
          pending: "",
          truncated: false,
        },
        stderr: {
          decoder: new StringDecoder("utf8"),
          pending: "",
          truncated: false,
        },
      },
    };
    try {
      await mkdir(runDirectory(runId), { recursive: false, mode: 0o700 });
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw runError("PROJECT_WORK_RUN_EXISTS", "运行记录已经存在", 409);
      }
      throw error;
    }
    active.set(runId, activeRun);
    await persistRecord(record);
    await enqueue(activeRun, async () => {
      await appendEvent(record, { type: "status", status: "queued" });
      await persistRecord(record);
    });

    try {
      activeRun.child = spawnImpl(layout.spawnFile, command.args, {
        cwd: layout.canonicalCwd,
        detached: process.platform !== "win32",
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: spawnEnvironment,
      });
      attachChild(activeRun);
      const startedAt = nowIso(now);
      record.status = "running";
      record.startedAt = startedAt;
      record.updatedAt = startedAt;
      record.pid = Number.isInteger(activeRun.child?.pid) ? activeRun.child.pid : null;
      await enqueue(activeRun, async () => {
        await appendEvent(record, { type: "status", status: "running" });
        await persistRecord(record);
      });
    } catch (error) {
      await finalize(activeRun, {
        status: "failed",
        error: `无法启动运行命令：${error?.message ?? "未知错误"}`,
      });
    }

    return {
      run: publicRun(record, sanitize),
      completion,
    };
  }

  async function get(runId) {
    await initialize();
    const id = assertRunId(runId);
    const live = active.get(id);
    if (live) return publicRun(live.record, sanitize);
    const record = await readRecord(id);
    await reconcileRecord(record);
    return publicRun(record, sanitize);
  }

  async function list({ workspaceId, limit = 200 } = {}) {
    await initialize();
    const normalizedWorkspaceId = workspaceId === undefined
      ? null
      : assertWorkspaceId(workspaceId);
    const normalizedLimit = Number.isInteger(limit)
      ? Math.min(Math.max(limit, 1), 1_000)
      : 200;
    const entries = await readdir(runsRoot, { withFileTypes: true });
    const records = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !RUN_ID_PATTERN.test(entry.name)) continue;
      const live = active.get(entry.name);
      const record = live?.record ?? await readRecord(entry.name);
      if (normalizedWorkspaceId && record.workspaceId !== normalizedWorkspaceId) continue;
      records.push(record);
    }
    return records
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
      .slice(0, normalizedLimit)
      .map((record) => publicRun(record, sanitize));
  }

  async function snapshot(runId, {
    afterSeq = 0,
    limit = DEFAULT_EVENT_LIMIT,
  } = {}) {
    await initialize();
    const id = assertRunId(runId);
    const normalizedAfterSeq = Number.isInteger(afterSeq) && afterSeq >= 0
      ? afterSeq
      : 0;
    const normalizedLimit = Number.isInteger(limit)
      ? Math.min(Math.max(limit, 1), MAX_EVENT_LIMIT)
      : DEFAULT_EVENT_LIMIT;
    const record = active.get(id)?.record ?? await readRecord(id);
    const { events } = await reconcileRecord(record);
    const remaining = events.filter((event) => event.seq > normalizedAfterSeq);
    const selected = remaining.slice(0, normalizedLimit);
    return {
      run: publicRun(record, sanitize),
      events: structuredClone(selected),
      hasMore: remaining.length > normalizedLimit,
      lastSeq: events.at(-1)?.seq ?? record.lastSeq,
      nextSeq: selected.at(-1)?.seq ?? normalizedAfterSeq,
    };
  }

  function subscribe(runId, listener) {
    const id = assertRunId(runId);
    if (typeof listener !== "function") {
      throw new TypeError("workspace run listener must be a function");
    }
    const current = listeners.get(id) ?? new Set();
    current.add(listener);
    listeners.set(id, current);
    return () => {
      const existing = listeners.get(id);
      if (!existing) return;
      existing.delete(listener);
      if (existing.size === 0) listeners.delete(id);
    };
  }

  function waitForExit(activeRun, timeoutMs) {
    if (TERMINAL_STATUSES.has(activeRun.record.status)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        activeRun.exitWaiters.delete(onExit);
        resolve(false);
      }, timeoutMs);
      const onExit = () => {
        clearTimeout(timer);
        activeRun.exitWaiters.delete(onExit);
        resolve(true);
      };
      activeRun.exitWaiters.add(onExit);
    });
  }

  async function cancel(runId) {
    await initialize();
    const id = assertRunId(runId);
    const activeRun = active.get(id);
    if (!activeRun) return get(id);
    if (activeRun.finishingPromise) return activeRun.completion;
    if (activeRun.cancelPromise) return activeRun.cancelPromise;
    activeRun.cancelPromise = (async () => {
      const record = activeRun.record;
      record.cancelRequestedAt ??= nowIso(now);
      await enqueue(activeRun, async () => {
        await appendEvent(record, {
          type: "status",
          status: "cancel_requested",
        });
        await persistRecord(record);
      });
      for (const [signal, graceMs] of [
        ["SIGINT", interruptGraceMs],
        ["SIGTERM", terminateGraceMs],
        ["SIGKILL", killGraceMs],
      ]) {
        if (TERMINAL_STATUSES.has(record.status)) return activeRun.completion;
        try {
          await Promise.resolve(killImpl(activeRun.child, signal));
        } catch {
          // Continue through the bounded escalation sequence.
        }
        if (await waitForExit(activeRun, graceMs)) return activeRun.completion;
      }
      await finalize(activeRun, {
        status: "interrupted",
        signal: "SIGKILL",
        error: "停止信号已发送，但未观察到进程退出；请检查 Workspace 后再继续",
      });
      return activeRun.completion;
    })();
    return activeRun.cancelPromise;
  }

  async function dispose({ cancelActive = true } = {}) {
    disposed = true;
    if (cancelActive) {
      await Promise.allSettled([...active.keys()].map((runId) => cancel(runId)));
    }
    listeners.clear();
    if (!cancelActive) active.clear();
  }

  return {
    initialize,
    start,
    get,
    list,
    snapshot,
    subscribe,
    cancel,
    dispose,
  };
}
