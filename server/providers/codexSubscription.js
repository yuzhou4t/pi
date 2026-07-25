import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const CODEX_PROVIDER_ID = "codex-subscription";
export const CODEX_ACCOUNT_MODEL_ID = "account-default";

const CHATGPT_LOGIN_STATUS = "Logged in using ChatGPT";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 256 * 1024;
const MAX_SCHEMA_BYTES = 256 * 1024;

const ENV_ALLOWLIST = [
  "HOME",
  "PATH",
  "TMPDIR",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "CODEX_HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
];

class CodexSubscriptionError extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.name = "CodexSubscriptionError";
    this.code = code;
    this.retryable = retryable;
  }
}

function safeEnvironment(env) {
  const result = {};
  for (const key of ENV_ALLOWLIST) {
    if (typeof env?.[key] === "string") result[key] = env[key];
  }

  // Keep this guard even though the allowlist currently contains no credential
  // fields, so a future allowlist edit cannot accidentally pass a key through.
  for (const key of Object.keys(result)) {
    if (/(?:api[_-]?key|access[_-]?token|secret|password|credential)/i.test(key)) {
      delete result[key];
    }
  }
  return result;
}

function positiveTimeout(timeoutMs) {
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
}

function commandError(code, message, retryable = false) {
  return new CodexSubscriptionError(code, message, retryable);
}

function runProcess({ args, env, spawnImpl, timeoutMs, stdin = null }) {
  return new Promise((resolve, reject) => {
    const command = typeof env?.PI_CODEX_CLI_PATH === "string" && env.PI_CODEX_CLI_PATH.trim()
      ? env.PI_CODEX_CLI_PATH.trim()
      : "codex";
    let child;
    try {
      child = spawnImpl(command, args, {
        env: safeEnvironment(env),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      reject(commandError(
        error?.code === "ENOENT" ? "CODEX_CLI_MISSING" : "CODEX_SPAWN_FAILED",
        "无法启动 Codex CLI",
        false,
      ));
      return;
    }

    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timer = null;

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };

    const stopWithError = (error) => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The process may already have exited.
      }
      finish(reject, error);
    };

    const append = (chunks, chunk, currentBytes, limit, streamName) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const nextBytes = currentBytes + buffer.length;
      if (nextBytes > limit) {
        stopWithError(commandError(
          "CODEX_OUTPUT_LIMIT_EXCEEDED",
          `Codex ${streamName} 超过安全上限`,
          false,
        ));
        return currentBytes;
      }
      chunks.push(buffer);
      return nextBytes;
    };

    child.stdout.on("data", (chunk) => {
      stdoutBytes = append(stdout, chunk, stdoutBytes, MAX_STDOUT_BYTES, "stdout");
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes = append(stderr, chunk, stderrBytes, MAX_STDERR_BYTES, "stderr");
    });
    child.once("error", (error) => {
      finish(reject, commandError(
        error?.code === "ENOENT" ? "CODEX_CLI_MISSING" : "CODEX_SPAWN_FAILED",
        "无法启动 Codex CLI",
        false,
      ));
    });
    child.once("close", (exitCode, signal) => {
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = Buffer.concat(stderr).toString("utf8");
      if (exitCode !== 0) {
        const detail = stderrText.trim().slice(0, 500);
        const incompatible = /(?:unexpected argument|unknown option|unrecognized option|usage:)/i.test(detail);
        finish(reject, commandError(
          incompatible ? "CODEX_CLI_INCOMPATIBLE" : "MODEL_FAILED",
          incompatible ? "当前 Codex CLI 与本地模型适配器不兼容" : "Codex 模型执行失败",
          !incompatible,
        ));
        return;
      }
      finish(resolve, { stdout: stdoutText, stderr: stderrText });
    });

    timer = setTimeout(() => {
      stopWithError(commandError("MODEL_TIMEOUT", "Codex CLI 执行超时", true));
    }, positiveTimeout(timeoutMs));

    child.stdin.once("error", () => {
      stopWithError(commandError("CODEX_STDIN_FAILED", "无法向 Codex CLI 写入请求", true));
    });
    child.stdin.end(stdin ?? undefined);
  });
}

function unavailable(reasonCode) {
  return { available: false, status: "unavailable", reasonCode };
}

export async function probeCodexSubscription({
  env = process.env,
  spawnImpl = spawn,
  timeoutMs = 10_000,
} = {}) {
  try {
    const { stdout, stderr } = await runProcess({
      args: ["login", "status"],
      env,
      spawnImpl,
      timeoutMs,
    });
    const stdoutStatus = stdout.trim();
    const stderrStatus = stderr.trim();
    const exactChatGptStatus = (stdoutStatus === CHATGPT_LOGIN_STATUS && stderrStatus === "")
      || (stderrStatus === CHATGPT_LOGIN_STATUS && stdoutStatus === "");
    if (!exactChatGptStatus) {
      return unavailable("CODEX_AUTH_NOT_CHATGPT");
    }
    return {
      available: true,
      status: "ready",
      reasonCode: "CHATGPT_SUBSCRIPTION",
    };
  } catch (error) {
    if (error?.code === "CODEX_CLI_MISSING") return unavailable("CODEX_CLI_MISSING");
    if (error?.code === "MODEL_TIMEOUT") return unavailable("CODEX_STATUS_TIMEOUT");
    return unavailable("CODEX_STATUS_FAILED");
  }
}

function parseJsonLines(stdout) {
  const events = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      throw commandError("CODEX_OUTPUT_INVALID", "Codex CLI 返回了无效 JSONL", true);
    }
  }
  return events;
}

function parseExecution(stdout) {
  const events = parseJsonLines(stdout);
  let operationId = null;
  let text = null;
  let usage = null;
  let completed = false;

  for (const event of events) {
    if (event?.type === "turn.failed" || event?.type === "error") {
      throw commandError("MODEL_FAILED", "Codex 回合未成功完成", true);
    }
    if (event?.type === "thread.started" && typeof event.thread_id === "string") {
      if (operationId || completed) {
        throw commandError("CODEX_OUTPUT_INVALID", "Codex CLI 返回了矛盾的线程生命周期", true);
      }
      operationId = event.thread_id;
    }
    if ((event?.type === "item.started" || event?.type === "item.completed")
      && event?.item?.type
      && !["reasoning", "agent_message", "error"].includes(event.item.type)) {
      throw commandError("CODEX_TOOL_USE_REJECTED", "Codex 尝试执行候选说明之外的工具", false);
    }
    if (event?.type === "item.completed" && event?.item?.type === "agent_message") {
      if (!operationId || completed) {
        throw commandError("CODEX_OUTPUT_INVALID", "Codex CLI 返回了乱序的消息生命周期", true);
      }
      if (typeof event.item.text === "string" && event.item.text.trim()) text = event.item.text.trim();
    }
    if (event?.type === "agent_message" && typeof event.text === "string" && event.text.trim()) {
      if (!operationId || completed) {
        throw commandError("CODEX_OUTPUT_INVALID", "Codex CLI 返回了乱序的消息生命周期", true);
      }
      text = event.text.trim();
    }
    if (event?.type === "turn.completed") {
      if (completed || !operationId || !text) {
        throw commandError("CODEX_OUTPUT_INVALID", "Codex CLI 返回了乱序的完成生命周期", true);
      }
      completed = true;
      if (typeof event.thread_id === "string" && event.thread_id !== operationId) {
        throw commandError("CODEX_OUTPUT_INVALID", "Codex CLI 返回的线程 ID 不一致", true);
      }
      const rawUsage = event.usage;
      if (rawUsage && typeof rawUsage === "object") {
        const inputTokens = Number(rawUsage.input_tokens) || 0;
        const cachedInputTokens = Number(rawUsage.cached_input_tokens) || 0;
        const outputTokens = Number(rawUsage.output_tokens) || 0;
        usage = {
          input_tokens: inputTokens,
          cached_input_tokens: cachedInputTokens,
          output_tokens: outputTokens,
          total_tokens: Number(rawUsage.total_tokens) || inputTokens + outputTokens,
        };
      }
    }
  }

  if (!completed || !operationId || !text || !usage) {
    throw commandError("CODEX_OUTPUT_INVALID", "Codex CLI 响应缺少完成事件、线程、消息或用量", true);
  }
  return { text, operationId, usage };
}

export async function runCodexSubscription({
  prompt,
  schema,
  env = process.env,
  spawnImpl = spawn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw commandError("CODEX_INVALID_REQUEST", "prompt 必须是非空字符串", false);
  }
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw commandError("CODEX_INVALID_REQUEST", "schema 必须是 JSON Schema 对象", false);
  }

  let serializedSchema;
  try {
    serializedSchema = JSON.stringify(schema);
  } catch {
    throw commandError("CODEX_INVALID_REQUEST", "schema 必须可以序列化为 JSON", false);
  }
  if (!serializedSchema || Buffer.byteLength(serializedSchema) > MAX_SCHEMA_BYTES) {
    throw commandError("CODEX_INVALID_REQUEST", "schema 超过安全上限", false);
  }

  const resolvedTimeoutMs = positiveTimeout(timeoutMs);
  const startedAt = Date.now();
  const probe = await probeCodexSubscription({
    env,
    spawnImpl,
    timeoutMs: Math.min(10_000, resolvedTimeoutMs),
  });
  if (!probe.available) {
    const retryable = probe.reasonCode === "CODEX_STATUS_TIMEOUT" || probe.reasonCode === "CODEX_STATUS_FAILED";
    throw commandError(probe.reasonCode, "Codex 未使用可用的 ChatGPT 订阅登录", retryable);
  }
  const remainingTimeoutMs = resolvedTimeoutMs - (Date.now() - startedAt);
  if (remainingTimeoutMs <= 0) {
    throw commandError("MODEL_TIMEOUT", "Codex CLI 执行超时", true);
  }

  let workDir = null;
  let schemaDir = null;

  try {
    workDir = await mkdtemp(path.join(os.tmpdir(), "pi-codex-work-"));
    schemaDir = await mkdtemp(path.join(os.tmpdir(), "pi-codex-schema-"));
    const schemaPath = path.join(schemaDir, "output-schema.json");
    await writeFile(schemaPath, serializedSchema, { encoding: "utf8", mode: 0o600 });
    const executionTimeoutMs = resolvedTimeoutMs - (Date.now() - startedAt);
    if (executionTimeoutMs <= 0) {
      throw commandError("MODEL_TIMEOUT", "Codex CLI 执行超时", true);
    }
    const { stdout } = await runProcess({
      args: [
        "-a", "never",
        "exec",
        "--ephemeral",
        "--sandbox", "read-only",
        "--ignore-user-config",
        "--ignore-rules",
        "--skip-git-repo-check",
        "--json",
        "--disable", "shell_tool",
        "--disable", "unified_exec",
        "--disable", "apps",
        "--disable", "multi_agent",
        "--disable", "remote_plugin",
        "--disable", "plugins",
        "--disable", "hooks",
        "--disable", "goals",
        "--disable", "auth_elicitation",
        "--disable", "tool_call_mcp_elicitation",
        "--disable", "browser_use",
        "--disable", "browser_use_external",
        "--disable", "browser_use_full_cdp_access",
        "--disable", "computer_use",
        "--disable", "image_generation",
        "--disable", "in_app_browser",
        "--disable", "workspace_dependencies",
        "--disable", "skill_search",
        "--disable", "skill_mcp_dependency_install",
        "--disable", "tool_suggest",
        "--disable", "enable_mcp_apps",
        "--disable", "code_mode_host",
        "--disable", "chronicle",
        "--disable", "memories",
        "--disable", "shell_snapshot",
        "-c", "web_search=\"disabled\"",
        "-c", "skills.include_instructions=false",
        "--output-schema", schemaPath,
        "-C", workDir,
        "-",
      ],
      env,
      spawnImpl,
      timeoutMs: executionTimeoutMs,
      stdin: prompt,
    });
    return parseExecution(stdout);
  } catch (error) {
    if (error instanceof CodexSubscriptionError) throw error;
    throw commandError("CODEX_LOCAL_IO_FAILED", "Codex 临时执行环境准备失败", true);
  } finally {
    await Promise.allSettled([
      workDir ? rm(workDir, { recursive: true, force: true }) : Promise.resolve(),
      schemaDir ? rm(schemaDir, { recursive: true, force: true }) : Promise.resolve(),
    ]);
  }
}
