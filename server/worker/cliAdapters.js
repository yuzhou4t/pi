import { execFile as nodeExecFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { workerError } from "./errors.js";
import { sha256 } from "./hash.js";

const MAIL_TOKEN_LIFETIME_MS = 5 * 60 * 1_000;
const MAX_ARG_BYTES = 1024 * 1024 + 8_192;
const SAFE_MESSAGE_ID_PATTERN = /^msg_[A-Za-z0-9._-]{1,240}$/;
const SAFE_ATTACHMENT_ID_PATTERN = /^att_[A-Za-z0-9._-]{1,240}$/;
const LARK_FETCH_DETAILS = new Set(["simple", "with-ids", "full"]);
const IMA_NOTE_OPERATIONS = new Set([
  "list_notebook",
  "list_note",
  "search_note",
  "get_doc_content",
]);
const IMA_AUTH_ERROR_CODES = new Set([200002, 20004]);

function defaultImaWrapperPath() {
  const codexHome = typeof process.env.CODEX_HOME === "string"
    && process.env.CODEX_HOME.trim()
    ? process.env.CODEX_HOME.trim()
    : path.join(homedir(), ".codex");
  return path.resolve(codexHome, "skills", "ima-skill", "ima_api.cjs");
}

function appendRepeated(args, flag, values = []) {
  for (const value of values) args.push(flag, value);
}

function assertInvocationArgs(args) {
  if (!Array.isArray(args) || args.length === 0 || args.length > 256) {
    throw workerError("WORKER_CLI_INVOCATION_INVALID", "CLI 参数无效", 500);
  }
  for (const value of args) {
    if (
      typeof value !== "string"
      || value.includes("\u0000")
      || Buffer.byteLength(value, "utf8") > MAX_ARG_BYTES
    ) {
      throw workerError("WORKER_CLI_INVOCATION_INVALID", "CLI 参数无效", 500);
    }
  }
  return args;
}

function safeScalar(value, label, { required = false, maxBytes = 8_192 } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) throw workerError("WORKER_READ_INPUT_INVALID", `${label}不能为空`, 400);
    return null;
  }
  const normalized = String(value);
  if (
    /[\u0000\r\n]/.test(normalized)
    || Buffer.byteLength(normalized, "utf8") > maxBytes
  ) {
    throw workerError("WORKER_READ_INPUT_INVALID", `${label}无效`, 400);
  }
  return normalized;
}

function safeStrictString(value, label, {
  required = false,
  maxBytes = 8_192,
} = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) throw workerError("WORKER_READ_INPUT_INVALID", `${label}不能为空`, 400);
    return null;
  }
  if (typeof value !== "string") {
    throw workerError("WORKER_READ_INPUT_INVALID", `${label}无效`, 400);
  }
  return safeScalar(value, label, { required, maxBytes });
}

function safeCliScalar(value, label, options = {}) {
  const normalized = safeStrictString(value, label, options);
  if (normalized?.startsWith("-")) {
    throw workerError("WORKER_READ_INPUT_INVALID", `${label}不能是 CLI 选项`, 400);
  }
  return normalized;
}

function enumScalar(value, label, allowed, { required = false } = {}) {
  const normalized = safeCliScalar(value, label, { required, maxBytes: 128 });
  if (normalized === null) return null;
  if (!allowed.has(normalized)) {
    throw workerError("WORKER_READ_INPUT_INVALID", `${label}不在允许范围内`, 400);
  }
  return normalized;
}

function isoDate(value, label) {
  const normalized = safeCliScalar(value, label, { maxBytes: 10 });
  if (normalized === null) return null;
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (!match) {
    throw workerError("WORKER_READ_INPUT_INVALID", `${label}必须为 YYYY-MM-DD`, 400);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    throw workerError("WORKER_READ_INPUT_INVALID", `${label}不是有效日期`, 400);
  }
  return normalized;
}

function optionalBoolean(parameters, key, label) {
  if (!Object.prototype.hasOwnProperty.call(parameters, key)) return false;
  if (typeof parameters[key] !== "boolean") {
    throw workerError("WORKER_READ_INPUT_INVALID", `${label}必须是布尔值`, 400);
  }
  return parameters[key];
}

function boundedInteger(value, label, {
  defaultValue,
  min,
  max,
} = {}) {
  if (value === undefined || value === null || value === "") return defaultValue;
  const normalized = typeof value === "number"
    ? value
    : (typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : NaN);
  if (!Number.isSafeInteger(normalized) || normalized < min || normalized > max) {
    throw workerError("WORKER_READ_INPUT_INVALID", `${label}必须为 ${min}–${max} 的整数`, 400);
  }
  return normalized;
}

function assertParameterKeys(parameters, allowedKeys) {
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    throw workerError("WORKER_READ_INPUT_INVALID", "读取参数无效", 400);
  }
  for (const key of Object.keys(parameters)) {
    if (!allowedKeys.has(key)) {
      throw workerError("WORKER_READ_INPUT_INVALID", `不支持的读取参数：${key}`, 400);
    }
  }
}

function normalizedJsonObject(value, label, { maxBytes = 8_192 } = {}) {
  if (value === undefined || value === null || value === "") return null;
  let parsed = value;
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > maxBytes) {
      throw workerError("WORKER_READ_INPUT_INVALID", `${label}无效`, 400);
    }
    try {
      parsed = JSON.parse(value);
    } catch {
      throw workerError("WORKER_READ_INPUT_INVALID", `${label}必须是 JSON 对象`, 400);
    }
  }
  if (
    !parsed
    || typeof parsed !== "object"
    || Array.isArray(parsed)
    || Object.getPrototypeOf(parsed) !== Object.prototype
  ) {
    throw workerError("WORKER_READ_INPUT_INVALID", `${label}必须是 JSON 对象`, 400);
  }
  let normalized;
  try {
    normalized = JSON.stringify(parsed);
  } catch {
    throw workerError("WORKER_READ_INPUT_INVALID", `${label}无效`, 400);
  }
  if (Buffer.byteLength(normalized, "utf8") > maxBytes) {
    throw workerError("WORKER_READ_INPUT_INVALID", `${label}无效`, 400);
  }
  return normalized;
}

function safeRelativeDirectory(value) {
  const normalized = safeScalar(value ?? "./downloads", "附件保存目录", {
    required: true,
    maxBytes: 2_048,
  });
  if (
    path.isAbsolute(normalized)
    || normalized.split(/[\\/]/).includes("..")
    || normalized.startsWith("-")
  ) {
    throw workerError(
      "WORKER_ATTACHMENT_PATH_UNSAFE",
      "附件保存目录必须是工作目录内的安全相对路径",
      400,
    );
  }
  return normalized;
}

function parseJsonCandidate(value) {
  const source = String(value ?? "").trim();
  if (!source) return null;
  try {
    return JSON.parse(source);
  } catch {
    const lines = source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        return JSON.parse(lines[index]);
      } catch {
        // Continue looking for a final structured envelope.
      }
    }
    return null;
  }
}

function resultEnvelope(result) {
  return parseJsonCandidate(result.stdout) ?? parseJsonCandidate(result.stderr);
}

function validSuccessEnvelope(envelope) {
  return Boolean(
    envelope
    && typeof envelope === "object"
    && !Array.isArray(envelope)
    && envelope.ok === true
    && Object.prototype.hasOwnProperty.call(envelope, "data"),
  );
}

function requireSuccessEnvelope(result, {
  connector,
  phase,
  writeAttempted = false,
} = {}) {
  const envelope = resultEnvelope(result);
  if (result.exitCode !== 0 || !validSuccessEnvelope(envelope)) {
    if (result.exitCode === 0 && writeAttempted) {
      throw workerError(
        connector === "agent_mail"
          ? "WORKER_MAIL_OUTCOME_UNKNOWN"
          : "WORKER_LARK_OUTCOME_UNKNOWN",
        "外部 CLI 在写入后未返回可验证的结构化结果，必须人工检查",
        409,
        { retryable: false, unknownOutcome: true },
      );
    }
    if (result.exitCode === 0) {
      throw workerError(
        connector === "agent_mail"
          ? "WORKER_MAIL_RESPONSE_INVALID"
          : "WORKER_LARK_RESPONSE_INVALID",
        "外部 CLI 未返回有效的结构化结果",
        502,
        { retryable: phase === "prepare" },
      );
    }
    throw cliFailure(result, { connector, phase, writeAttempted });
  }
  return envelope;
}

function requireImaSuccessEnvelope(result, { phase = "prepare" } = {}) {
  const envelope = resultEnvelope(result);
  const businessCode = Number(envelope?.code);
  if (
    result.exitCode === 0
    && envelope
    && typeof envelope === "object"
    && !Array.isArray(envelope)
    && businessCode === 0
    && Object.prototype.hasOwnProperty.call(envelope, "data")
  ) {
    return envelope;
  }
  const updateRequired = result.exitCode === -200
    || Number(envelope?.error?.code) === -200;
  const authFailed = IMA_AUTH_ERROR_CODES.has(businessCode);
  const message = envelope?.msg
    ?? envelope?.message
    ?? envelope?.error?.message
    ?? "IMA OpenAPI 调用失败";
  throw workerError(
    updateRequired
      ? "WORKER_IMA_UPDATE_REQUIRED"
      : authFailed
        ? "WORKER_IMA_AUTH_FAILED"
        : "WORKER_IMA_API_FAILED",
    String(message).slice(0, 500),
    authFailed ? 401 : updateRequired ? 409 : 502,
    { retryable: phase === "prepare" && !authFailed && !updateRequired },
  );
}

function currentMilliseconds(now) {
  const value = now();
  const milliseconds = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(milliseconds)) throw new TypeError("now must return a valid date");
  return milliseconds;
}

function cliFailure(result, {
  connector,
  phase,
  writeAttempted = false,
} = {}) {
  const envelope = resultEnvelope(result);
  const message = envelope?.error?.message
    ?? envelope?.message
    ?? `${connector === "agent_mail" ? "Agent 邮箱" : "飞书"} CLI 调用失败`;
  if (connector === "agent_mail") {
    const exitCode = Number(result.exitCode);
    const retryable = [1, 4, 7].includes(exitCode);
    const unknownOutcome = writeAttempted && [1, 4].includes(exitCode);
    return workerError(
      unknownOutcome ? "WORKER_MAIL_OUTCOME_UNKNOWN" : "WORKER_MAIL_CLI_FAILED",
      String(message).slice(0, 500),
      exitCode === 3 ? 401 : 502,
      { retryable: retryable && !unknownOutcome, unknownOutcome },
    );
  }
  const type = envelope?.error?.type;
  const subtype = envelope?.error?.subtype;
  const knownRejected = ["authorization", "validation", "permission", "confirmation"]
    .includes(type);
  const unknownOutcome = writeAttempted && !knownRejected;
  return workerError(
    unknownOutcome ? "WORKER_LARK_OUTCOME_UNKNOWN" : "WORKER_LARK_CLI_FAILED",
    String(message).slice(0, 500),
    type === "authorization" ? 401 : 502,
    {
      retryable: !unknownOutcome && phase === "prepare" && type !== "authorization",
      unknownOutcome,
      details: { type, subtype },
    },
  );
}

export function buildImaReadInvocation(operation, parameters = {}, {
  wrapperPath = defaultImaWrapperPath(),
} = {}) {
  if (!IMA_NOTE_OPERATIONS.has(operation)) {
    throw workerError("WORKER_IMA_OPERATION_NOT_ALLOWED", "不支持的 IMA 笔记读取操作", 400);
  }
  const resolvedWrapperPath = path.resolve(wrapperPath);
  let payload;
  if (operation === "list_notebook") {
    assertParameterKeys(parameters, new Set(["cursor", "limit"]));
    payload = {
      cursor: safeCliScalar(parameters.cursor ?? "0", "IMA 分页游标", {
        required: true,
        maxBytes: 8_192,
      }),
      limit: boundedInteger(parameters.limit, "IMA 笔记本数量", {
        defaultValue: 20,
        min: 1,
        max: 20,
      }),
    };
  } else if (operation === "list_note") {
    assertParameterKeys(parameters, new Set(["folderId", "sortType", "cursor", "limit"]));
    payload = {
      folder_id: safeCliScalar(parameters.folderId, "IMA 笔记本标识", {
        maxBytes: 512,
      }) ?? "",
      sort_type: boundedInteger(parameters.sortType, "IMA 排序方式", {
        defaultValue: 0,
        min: 0,
        max: 3,
      }),
      cursor: safeCliScalar(parameters.cursor, "IMA 分页游标", {
        maxBytes: 8_192,
      }) ?? "",
      limit: boundedInteger(parameters.limit, "IMA 笔记数量", {
        defaultValue: 20,
        min: 1,
        max: 20,
      }),
    };
  } else if (operation === "search_note") {
    assertParameterKeys(parameters, new Set(["query", "searchType", "start", "end", "limit"]));
    const query = safeScalar(parameters.query, "IMA 搜索词", {
      required: true,
      maxBytes: 16_384,
    });
    const searchType = parameters.searchType === "content"
      ? 1
      : parameters.searchType === "title"
        ? 0
        : boundedInteger(parameters.searchType, "IMA 搜索范围", {
            defaultValue: 0,
            min: 0,
            max: 1,
          });
    const start = boundedInteger(parameters.start, "IMA 搜索起点", {
      defaultValue: 0,
      min: 0,
      max: 10_000,
    });
    const defaultEnd = start + boundedInteger(parameters.limit, "IMA 搜索数量", {
      defaultValue: 20,
      min: 1,
      max: 20,
    });
    const end = boundedInteger(parameters.end, "IMA 搜索结束位置", {
      defaultValue: defaultEnd,
      min: start + 1,
      max: start + 20,
    });
    payload = {
      search_type: searchType,
      query_info: searchType === 1 ? { content: query } : { title: query },
      start,
      end,
    };
  } else {
    assertParameterKeys(parameters, new Set(["noteId", "targetContentFormat"]));
    const targetContentFormat = boundedInteger(
      parameters.targetContentFormat,
      "IMA 正文格式",
      { defaultValue: 0, min: 0, max: 0 },
    );
    payload = {
      note_id: safeCliScalar(parameters.noteId, "IMA 笔记标识", {
        required: true,
        maxBytes: 512,
      }),
      target_content_format: targetContentFormat,
    };
  }
  return {
    connector: "ima",
    args: assertInvocationArgs([
      resolvedWrapperPath,
      `openapi/note/v1/${operation}`,
      JSON.stringify(payload),
    ]),
  };
}

export function createControlledCliRunner({
  execFileImpl = nodeExecFile,
  binaries = {},
  cwd = process.cwd(),
  timeoutMs = 30_000,
  maxBuffer = 2 * 1024 * 1024,
} = {}) {
  const resolvedBinaries = {
    lark: binaries.lark ?? "lark-cli",
    agent_mail: binaries.agent_mail ?? "agently-cli",
    ima: binaries.ima ?? process.execPath,
  };
  return Object.freeze({
    async run(invocation) {
      const command = resolvedBinaries[invocation?.connector];
      if (!command) {
        throw workerError("WORKER_CONNECTOR_NOT_ALLOWED", "未允许的 CLI 连接器", 500);
      }
      const args = assertInvocationArgs(invocation.args);
      await mkdir(cwd, { recursive: true, mode: 0o700 });
      return new Promise((resolve) => {
        execFileImpl(command, args, {
          cwd,
          env: {
            ...process.env,
            LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
            LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
          },
          timeout: timeoutMs,
          maxBuffer,
          windowsHide: true,
          shell: false,
        }, (error, stdout = "", stderr = "") => {
          resolve({
            exitCode: error ? (Number.isInteger(error.code) ? error.code : 1) : 0,
            stdout: String(stdout),
            stderr: String(stderr),
            timedOut: error?.killed === true,
          });
        });
      });
    },
  });
}

export function buildAgentMailReadInvocation(operation, parameters = {}) {
  if (operation === "attachment_download") {
    assertParameterKeys(parameters, new Set(["messageId", "attachmentId", "output"]));
    const messageId = safeCliScalar(parameters.messageId, "邮件标识", { required: true });
    const attachmentId = safeCliScalar(parameters.attachmentId, "附件标识", { required: true });
    if (!SAFE_MESSAGE_ID_PATTERN.test(messageId)) {
      throw workerError("WORKER_MAIL_MESSAGE_ID_INVALID", "邮件标识无效", 400);
    }
    if (!SAFE_ATTACHMENT_ID_PATTERN.test(attachmentId)) {
      throw workerError("WORKER_MAIL_ATTACHMENT_ID_INVALID", "附件标识无效", 400);
    }
    return {
      connector: "agent_mail",
      args: assertInvocationArgs([
        "attachment", "+download",
        "--msg", messageId,
        "--att", attachmentId,
        "--output", safeRelativeDirectory(parameters.output),
      ]),
    };
  }
  const args = ["message"];
  if (operation === "list") {
    assertParameterKeys(parameters, new Set([
      "dir", "limit", "cursor", "after", "before", "hasAttachments", "isUnread",
    ]));
    args.push("+list");
    const directory = enumScalar(
      parameters.dir,
      "邮件目录",
      new Set(["inbox", "sent", "trash", "spam"]),
    );
    const cursor = safeCliScalar(parameters.cursor, "分页游标", { maxBytes: 8_192 });
    const after = isoDate(parameters.after, "起始日期");
    const before = isoDate(parameters.before, "截止日期");
    if (directory) args.push("--dir", directory);
    if (parameters.limit !== undefined && parameters.limit !== null) {
      if (parameters.limit === "") {
        throw workerError("WORKER_READ_INPUT_INVALID", "邮件数量必须为 1–50 的整数", 400);
      }
      args.push("--limit", String(boundedInteger(parameters.limit, "邮件数量", {
        min: 1,
        max: 50,
      })));
    }
    if (cursor) args.push("--cursor", cursor);
    if (after) args.push("--after", after);
    if (before) args.push("--before", before);
  } else if (operation === "search") {
    assertParameterKeys(parameters, new Set([
      "q", "searchIn", "from", "to", "dir", "after", "before", "cursor",
      "limit", "hasAttachments", "isUnread",
    ]));
    args.push("+search", "--q", safeCliScalar(parameters.q, "搜索词", {
      required: true,
      maxBytes: 32_768,
    }));
    const searchIn = enumScalar(
      parameters.searchIn,
      "搜索范围",
      new Set(["SEARCH_IN_ALL", "SEARCH_IN_SUBJECT", "SEARCH_IN_CONTENT"]),
    );
    const from = safeCliScalar(parameters.from, "发件人", { maxBytes: 320 });
    const to = safeCliScalar(parameters.to, "收件人", { maxBytes: 320 });
    const directory = enumScalar(
      parameters.dir,
      "邮件目录",
      new Set(["inbox", "sent", "trash", "spam"]),
    );
    const after = isoDate(parameters.after, "起始日期");
    const before = isoDate(parameters.before, "截止日期");
    const cursor = safeCliScalar(parameters.cursor, "分页游标", { maxBytes: 8_192 });
    for (const [flag, value] of [
      ["--search-in", searchIn],
      ["--from", from],
      ["--to", to],
      ["--dir", directory],
      ["--after", after],
      ["--before", before],
      ["--cursor", cursor],
    ]) {
      if (value) args.push(flag, value);
    }
    if (parameters.limit !== undefined && parameters.limit !== null) {
      if (parameters.limit === "") {
        throw workerError("WORKER_READ_INPUT_INVALID", "邮件数量必须为 1–50 的整数", 400);
      }
      args.push("--limit", String(boundedInteger(parameters.limit, "邮件数量", {
        min: 1,
        max: 50,
      })));
    }
  } else if (operation === "read") {
    assertParameterKeys(parameters, new Set(["messageId"]));
    const id = String(parameters.messageId ?? "");
    if (!SAFE_MESSAGE_ID_PATTERN.test(id)) {
      throw workerError("WORKER_MAIL_MESSAGE_ID_INVALID", "邮件标识无效", 400);
    }
    args.push("+read", "--id", id);
  } else {
    throw workerError("WORKER_READ_ACTION_NOT_ALLOWED", "不支持的邮箱读取操作", 400);
  }
  if (["list", "search"].includes(operation)) {
    if (optionalBoolean(parameters, "hasAttachments", "仅含附件")) {
      args.push("--has-attachments");
    }
    if (optionalBoolean(parameters, "isUnread", "仅未读")) args.push("--is-unread");
  }
  return { connector: "agent_mail", args: assertInvocationArgs(args) };
}

export function buildAgentMailWriteInvocation({ proposal, draft, confirmationToken = null }) {
  const operation = proposal.operation;
  const parameters = proposal.parameters;
  const args = ["message"];
  if (operation === "send") {
    args.push("+send");
    appendRepeated(args, "--to", parameters.to);
    args.push("--subject", parameters.subject);
  } else if (["reply", "reply_all"].includes(operation)) {
    args.push("+reply", "--id", parameters.messageId);
    if (operation === "reply_all") args.push("--reply-all");
  } else if (operation === "forward") {
    args.push("+forward", "--id", parameters.messageId);
    appendRepeated(args, "--to", parameters.to);
    if (parameters.includeAttachments) args.push("--include-attachments");
  } else if (operation === "trash") {
    args.push("+trash", "--id", parameters.messageId);
  } else {
    throw workerError("WORKER_ACTION_NOT_ALLOWED", "不支持的邮箱写操作", 400);
  }
  if (operation !== "trash") {
    args.push("--body", draft.content);
    if (draft.format === "plain") args.push("--body-format", "plain");
    appendRepeated(args, "--cc", parameters.cc);
    appendRepeated(args, "--bcc", parameters.bcc);
    const attachmentPaths = (proposal.attachmentBindings ?? []).map((binding) => {
      const privateBinding = (proposal.privateAttachmentPaths ?? []).find(
        (item) => item.id === binding.id,
      );
      if (!privateBinding || typeof privateBinding.relativePath !== "string") {
        throw workerError("WORKER_FILE_BINDING_MISMATCH", "附件路径绑定不完整", 409);
      }
      return safeRelativeDirectory(privateBinding.relativePath);
    });
    if (attachmentPaths.length !== (parameters.attachments ?? []).length) {
      throw workerError("WORKER_FILE_BINDING_MISMATCH", "附件绑定不完整", 409);
    }
    appendRepeated(args, "--attachment", attachmentPaths);
  }
  if (confirmationToken) args.push("--confirmation-token", confirmationToken);
  return { connector: "agent_mail", args: assertInvocationArgs(args) };
}

export function buildLarkReadInvocation(operation, parameters = {}) {
  if (operation === "fetch") {
    assertParameterKeys(parameters, new Set(["document", "detail", "revisionId"]));
    const document = safeStrictString(parameters.document, "飞书文档地址或 token", {
      required: true,
      maxBytes: 8_192,
    });
    const detail = parameters.detail ?? "simple";
    if (!LARK_FETCH_DETAILS.has(detail)) {
      throw workerError(
        "WORKER_READ_INPUT_INVALID",
        "飞书读取详细度必须为 simple、with-ids 或 full",
        400,
      );
    }
    const args = [
      "docs", "+fetch", "--as", "user", "--doc", document,
      "--detail", detail,
    ];
    if (parameters.revisionId !== undefined && parameters.revisionId !== null) {
      args.push("--revision-id", String(boundedInteger(
        parameters.revisionId,
        "飞书历史 revisionId",
        { min: 1, max: Number.MAX_SAFE_INTEGER },
      )));
    }
    return {
      connector: "lark",
      args: assertInvocationArgs(args),
    };
  }
  if (operation === "history_list") {
    assertParameterKeys(parameters, new Set(["document", "pageSize", "pageToken"]));
    const document = safeStrictString(parameters.document, "飞书文档地址或 token", {
      required: true,
      maxBytes: 8_192,
    });
    const args = [
      "docs", "+history-list", "--as", "user", "--doc", document,
      "--page-size", String(boundedInteger(parameters.pageSize, "分页条数", {
        defaultValue: 20,
        min: 1,
        max: 20,
      })),
    ];
    const pageToken = safeStrictString(parameters.pageToken, "分页游标", {
      maxBytes: 8_192,
    });
    if (pageToken) args.push("--page-token", pageToken);
    return { connector: "lark", args: assertInvocationArgs(args) };
  }
  if (operation === "search") {
    assertParameterKeys(parameters, new Set(["query", "filter", "pageSize", "pageToken"]));
    const query = safeStrictString(parameters.query, "飞书文档查询词", {
      required: true,
      maxBytes: 4_096,
    });
    const args = [
      "docs", "+search", "--as", "user", "--query", query,
      "--page-size", String(boundedInteger(parameters.pageSize, "分页条数", {
        defaultValue: 20,
        min: 1,
        max: 20,
      })),
    ];
    const filter = normalizedJsonObject(parameters.filter, "查询过滤条件");
    const pageToken = safeStrictString(parameters.pageToken, "分页游标", {
      maxBytes: 8_192,
    });
    if (filter) args.push("--filter", filter);
    if (pageToken) args.push("--page-token", pageToken);
    return { connector: "lark", args: assertInvocationArgs(args) };
  }
  throw workerError("WORKER_READ_ACTION_NOT_ALLOWED", "不支持的飞书读取操作", 400);
}

export function buildLarkWriteInvocation({ proposal, draft }) {
  const { operation, parameters } = proposal;
  if (operation === "create") {
    const args = [
      "docs", "+create", "--as", "user",
      "--doc-format", draft.format,
      "--content", draft.content,
    ];
    if (parameters.title) args.push("--title", parameters.title);
    if (parameters.parentToken) args.push("--parent-token", parameters.parentToken);
    if (parameters.parentPosition) args.push("--parent-position", parameters.parentPosition);
    return { connector: "lark", args: assertInvocationArgs(args) };
  }
  if (operation === "history_revert") {
    return {
      connector: "lark",
      args: assertInvocationArgs([
        "docs", "+history-revert", "--as", "user",
        "--doc", parameters.document,
        "--history-version-id", parameters.historyVersionId,
      ]),
    };
  }
  const args = [
    "docs", "+update", "--as", "user",
    "--doc", parameters.document,
    "--command", operation,
    "--revision-id", String(proposal.baseRevisionId),
  ];
  if (["append", "overwrite", "str_replace", "block_insert_after", "block_replace"]
    .includes(operation)) {
    args.push("--doc-format", draft.format, "--content", draft.content);
  }
  if (operation === "str_replace") args.push("--pattern", parameters.pattern);
  if (["block_insert_after", "block_replace"].includes(operation)) {
    args.push("--block-id", parameters.blockId);
  }
  if (operation === "block_delete") {
    args.push("--block-id", parameters.affectedBlockIds.join(","));
  }
  if (operation === "block_move_after") {
    args.push(
      "--block-id", parameters.anchorBlockId,
      "--src-block-ids", parameters.sourceBlockIds.join(","),
    );
  }
  return { connector: "lark", args: assertInvocationArgs(args) };
}

export function buildLarkHistoryRevertStatusInvocation({ document, taskId }) {
  return {
    connector: "lark",
    args: assertInvocationArgs([
      "docs", "+history-revert-status", "--as", "user",
      "--doc", safeStrictString(document, "飞书文档地址或 token", {
        required: true,
        maxBytes: 8_192,
      }),
      "--task-id", safeStrictString(taskId, "飞书版本恢复任务标识", {
        required: true,
        maxBytes: 512,
      }),
    ]),
  };
}

function extractMailConfirmation(envelope) {
  const data = envelope?.data ?? {};
  const details = envelope?.error?.details ?? {};
  const token = data.confirmation_token
    ?? data.confirmationToken
    ?? data.ctk
    ?? details.confirmation_token
    ?? details.confirmationToken
    ?? details.ctk
    ?? envelope?.error?.confirmation_token;
  const summary = data.summary
    ?? details.summary
    ?? envelope?.error?.summary
    ?? null;
  if (
    typeof token !== "string"
    || !/^ctk_[A-Za-z0-9._-]+$/.test(token)
    || !summary
    || typeof summary !== "object"
    || Array.isArray(summary)
  ) return null;
  return {
    token,
    summary,
  };
}

function safeMailConfirmationSummary(summary) {
  const safe = {};
  const safeSummaryText = (value, max) => String(value)
    .replaceAll(/ctk_[A-Za-z0-9._-]+/gu, "[确认令牌已隐藏]")
    .slice(0, max);
  for (const key of [
    "operation",
    "to",
    "cc",
    "bcc",
    "subject",
    "message_id",
    "messageId",
    "reply_all",
    "include_attachments",
    "body_preview",
  ]) {
    const value = summary?.[key];
    if (typeof value === "string") safe[key] = safeSummaryText(value, 4_096);
    else if (typeof value === "boolean" || Number.isFinite(value)) safe[key] = value;
    else if (Array.isArray(value)) {
      safe[key] = value
        .filter((item) => typeof item === "string")
        .slice(0, 100)
        .map((item) => safeSummaryText(item, 2_048));
    }
  }
  if (Array.isArray(summary?.attachments)) {
    safe.attachments = summary.attachments.slice(0, 3).map((item) => {
      if (typeof item === "string") return { name: safeSummaryText(item, 512) };
      if (!item || typeof item !== "object") return { name: "附件" };
      return {
        name: safeSummaryText(item.name ?? item.file_name ?? "附件", 512),
        ...(Number.isSafeInteger(item.size) && item.size >= 0 ? { size: item.size } : {}),
      };
    });
  }
  return safe;
}

function larkRevision(envelope) {
  const value = envelope?.data?.document?.revision_id
    ?? envelope?.data?.revision_id
    ?? envelope?.document?.revision_id;
  return Number.isSafeInteger(value) ? value : Number.parseInt(value, 10);
}

export function createDisabledDeliveryExecutor() {
  return Object.freeze({
    externalWritesEnabled: false,
    async prepare() {
      return {
        publicState: { transport: "disabled" },
        privateState: null,
      };
    },
    async execute() {
      throw workerError(
        "WORKER_EXTERNAL_WRITES_DISABLED",
        "真实外部写入尚未启用",
        403,
      );
    },
  });
}

export function createDisabledConnectionAdapter() {
  return Object.freeze({
    async health({ workerId }) {
      return {
        workerId,
        status: "unavailable",
        verified: false,
        identity: null,
        aliases: [],
        reason: "connection_adapter_disabled",
      };
    },
    async read() {
      throw workerError(
        "WORKER_CONNECTION_READ_DISABLED",
        "Worker 外部读取连接尚未启用",
        403,
      );
    },
  });
}

function safeMailAliasRecords(envelope) {
  const values = envelope?.data?.aliases;
  if (!Array.isArray(values) || values.length === 0) return null;
  const records = [];
  for (const value of values) {
    const email = typeof value === "string"
      ? value
      : value && typeof value === "object" && !Array.isArray(value)
        ? value.email
        : null;
    if (
      typeof email !== "string"
      || !/^[^\s@]+@[^\s@]+$/u.test(email)
      || email.length > 320
    ) return null;
    records.push({
      email: email.toLowerCase(),
      isPrimary: value && typeof value === "object"
        ? value.is_primary === true || value.isPrimary === true
        : false,
    });
  }
  return records;
}

function safeConnectionIdentity(workerId, envelope, mailAliasRecords = null) {
  const data = envelope?.data ?? {};
  if (workerId === "agent_mail") {
    return mailAliasRecords?.find((alias) => alias.isPrimary)?.email
      ?? mailAliasRecords?.[0]?.email
      ?? null;
  }
  return data.identities?.user?.userName
    ?? data.identity?.userName
    ?? data.userName
    ?? null;
}

function parseLarkAuthStatus(result) {
  const envelope = resultEnvelope(result);
  if (
    result.exitCode !== 0
    || !envelope
    || typeof envelope !== "object"
    || Array.isArray(envelope)
  ) return null;
  const payload = validSuccessEnvelope(envelope) ? envelope.data : envelope;
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.error) {
    return null;
  }
  const user = payload.identities?.user;
  if (!user || typeof user !== "object" || Array.isArray(user)) return null;
  const verified = user.verified === true
    || user.status === "ready"
    || user.status === "authenticated"
    || user.tokenStatus === "valid";
  const identity = typeof user.userName === "string" && user.userName.trim()
    ? user.userName.trim()
    : typeof user.openId === "string" && user.openId.trim()
      ? user.openId.trim()
      : null;
  if (!verified || !identity) return null;
  return { identity };
}

function safeMailAliases(records) {
  return [...new Set((records ?? []).map((record) => record.email))].sort();
}

export function createCliConnectionAdapter({
  runner = createControlledCliRunner(),
  imaWrapperPath = defaultImaWrapperPath(),
} = {}) {
  return Object.freeze({
    async health({ workerId }) {
      if (workerId === "ima_note") {
        const result = await runner.run(buildImaReadInvocation(
          "list_notebook",
          { cursor: "0", limit: 1 },
          { wrapperPath: imaWrapperPath },
        ));
        try {
          requireImaSuccessEnvelope(result, { phase: "prepare" });
          return {
            workerId,
            status: "connected",
            verified: true,
            identity: null,
            aliases: [],
            reason: null,
          };
        } catch (error) {
          return {
            workerId,
            status: "unavailable",
            verified: false,
            identity: null,
            aliases: [],
            reason: String(error?.message ?? "IMA 连接检查失败").slice(0, 300),
          };
        }
      }
      if (!["agent_mail", "lark_doc"].includes(workerId)) {
        throw workerError("WORKER_CONNECTOR_NOT_ALLOWED", "未允许的 Worker 连接器", 400);
      }
      const invocation = workerId === "agent_mail"
        ? { connector: "agent_mail", args: ["+me"] }
        : {
          connector: "lark",
          args: ["auth", "status", "--json", "--verify"],
        };
      const result = await runner.run(invocation);
      if (workerId === "lark_doc") {
        const status = parseLarkAuthStatus(result);
        return {
          workerId,
          status: status ? "connected" : "unavailable",
          verified: Boolean(status),
          identity: status?.identity ?? null,
          aliases: [],
          reason: status ? null : "connection_check_failed",
        };
      }
      let envelope = null;
      try {
        envelope = requireSuccessEnvelope(result, {
          connector: "agent_mail",
          phase: "prepare",
          writeAttempted: false,
        });
      } catch {
        // Health checks return an unavailable state rather than executing recovery.
      }
      const mailAliasRecords = safeMailAliasRecords(envelope);
      const identity = safeConnectionIdentity(workerId, envelope, mailAliasRecords);
      const validMailIdentity = typeof identity === "string"
        && /^[^\s@]+@[^\s@]+$/u.test(identity)
        && identity.length <= 320;
      const connected = envelope !== null && validMailIdentity;
      return {
        workerId,
        status: connected ? "connected" : "unavailable",
        verified: connected,
        identity: connected ? identity : null,
        aliases: connected ? safeMailAliases(mailAliasRecords) : [],
        reason: connected
          ? null
          : String(envelope?.error?.message ?? "connection_check_failed").slice(0, 300),
      };
    },
    async read({ workerId, operation, parameters }) {
      if (workerId === "ima_note") {
        const result = await runner.run(buildImaReadInvocation(
          operation,
          parameters,
          { wrapperPath: imaWrapperPath },
        ));
        const envelope = requireImaSuccessEnvelope(result, { phase: "prepare" });
        return {
          workerId,
          operation,
          untrustedExternalContent: true,
          data: structuredClone(envelope?.data ?? null),
        };
      }
      if (!["agent_mail", "lark_doc"].includes(workerId)) {
        throw workerError("WORKER_CONNECTOR_NOT_ALLOWED", "未允许的 Worker 连接器", 400);
      }
      const invocation = workerId === "agent_mail"
        ? buildAgentMailReadInvocation(operation, parameters)
        : buildLarkReadInvocation(operation, parameters);
      const result = await runner.run(invocation);
      const envelope = requireSuccessEnvelope(result, {
        connector: workerId === "agent_mail" ? "agent_mail" : "lark",
        phase: "prepare",
        writeAttempted: false,
      });
      return {
        workerId,
        operation,
        untrustedExternalContent: true,
        data: structuredClone(envelope?.data ?? null),
      };
    },
  });
}

export function createCliDeliveryExecutor({
  runner = createControlledCliRunner(),
  now = () => new Date(),
  historyPollAttempts = 5,
  historyPollIntervalMs = 250,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  if (
    !Number.isSafeInteger(historyPollAttempts)
    || historyPollAttempts < 1
    || historyPollAttempts > 20
    || !Number.isSafeInteger(historyPollIntervalMs)
    || historyPollIntervalMs < 0
    || historyPollIntervalMs > 5_000
    || typeof wait !== "function"
  ) {
    throw new TypeError("invalid Lark history polling configuration");
  }
  async function prepare({ proposal, draft }) {
    if (proposal.workerId !== "agent_mail") {
      return {
        publicState: {
          transport: "lark-cli",
          baseRevisionId: proposal.baseRevisionId,
        },
        privateState: null,
      };
    }
    const result = await runner.run(buildAgentMailWriteInvocation({ proposal, draft }));
    const envelope = resultEnvelope(result);
    const confirmation = extractMailConfirmation(envelope);
    const acceptedConfirmationEnvelope = confirmation
      && result.exitCode === 8
      && envelope?.ok === false;
    if (!acceptedConfirmationEnvelope) {
      if (result.exitCode === 0) {
        throw workerError(
          "WORKER_MAIL_OUTCOME_UNKNOWN",
          "Agent 邮箱首次写操作异常返回成功，无法确认是否已进入发送队列，必须人工检查",
          409,
          { retryable: false, unknownOutcome: true },
        );
      }
      throw cliFailure(result, {
        connector: "agent_mail",
        phase: "prepare",
        writeAttempted: false,
      });
    }
    const expiresAt = new Date(
      currentMilliseconds(now) + MAIL_TOKEN_LIFETIME_MS,
    ).toISOString();
    return {
      publicState: {
        transport: "agently-cli",
        confirmationRequired: true,
        confirmationExpiresAt: expiresAt,
        summary: safeMailConfirmationSummary(confirmation.summary),
      },
      privateState: {
        confirmationToken: confirmation.token,
        confirmationExpiresAt: expiresAt,
      },
    };
  }

  async function executeMail({ proposal, draft, privateState }) {
    const token = privateState?.confirmationToken;
    const expiresAt = Date.parse(privateState?.confirmationExpiresAt ?? "");
    if (!token || !Number.isFinite(expiresAt) || currentMilliseconds(now) >= expiresAt) {
      throw workerError(
        "WORKER_MAIL_CONFIRMATION_EXPIRED",
        "邮箱确认令牌已失效，请重新生成交付预览",
        409,
        { retryable: true },
      );
    }
    const result = await runner.run(buildAgentMailWriteInvocation({
      proposal,
      draft,
      confirmationToken: token,
    }));
    const envelope = requireSuccessEnvelope(result, {
      connector: "agent_mail",
      phase: "execute",
      writeAttempted: true,
    });
    const data = envelope?.data ?? {};
    return {
      deliveryStatus: "queued",
      provider: "agent_mail",
      externalId: data.message_id ?? data.messageId ?? data.id ?? null,
      externalUrl: null,
      providerState: data.status ?? "queued",
      verification: {
        status: "queued_only",
        detail: "邮件已进入发送队列；未验证收件人是否收到。",
      },
    };
  }

  async function executeLark({ proposal, draft }) {
    if (proposal.operation !== "create") {
      const beforeResult = await runner.run(buildLarkReadInvocation("fetch", {
        document: proposal.parameters.document,
        detail: "simple",
      }));
      const beforeEnvelope = requireSuccessEnvelope(beforeResult, {
        connector: "lark",
        phase: "prepare",
        writeAttempted: false,
      });
      const currentRevision = larkRevision(beforeEnvelope);
      if (currentRevision !== proposal.baseRevisionId) {
        throw workerError(
          "WORKER_LARK_BASE_REVISION_STALE",
          "飞书文档版本已变化，请重新读取并生成交付预览",
          409,
        );
      }
    }

    const invocation = buildLarkWriteInvocation({ proposal, draft });
    let result = await runner.run(invocation);
    let envelope = resultEnvelope(result);
    if (
      result.exitCode === 10
      && envelope?.error?.type === "confirmation"
      && envelope?.error?.subtype === "confirmation_required"
    ) {
      result = await runner.run({
        ...invocation,
        args: [...invocation.args, "--yes"],
      });
      envelope = resultEnvelope(result);
    }
    envelope = requireSuccessEnvelope(result, {
      connector: "lark",
      phase: "execute",
      writeAttempted: true,
    });
    let resultState = envelope?.data?.result ?? "success";
    if (["partial_success", "failed"].includes(resultState)) {
      throw workerError(
        "WORKER_LARK_OUTCOME_UNKNOWN",
        "飞书返回部分成功或失败，必须人工检查目标文档",
        409,
        { unknownOutcome: true },
      );
    }
    let providerState = envelope?.data?.status ?? resultState;
    let providerTaskId = envelope?.data?.task_id ?? null;
    if (proposal.operation === "history_revert" && providerState === "running") {
      if (typeof providerTaskId !== "string" || !providerTaskId) {
        throw workerError(
          "WORKER_LARK_OUTCOME_UNKNOWN",
          "飞书版本恢复已启动但未返回任务标识，必须人工检查",
          409,
          { unknownOutcome: true },
        );
      }
      for (let attempt = 0; attempt < historyPollAttempts; attempt += 1) {
        if (historyPollIntervalMs > 0) await wait(historyPollIntervalMs);
        const statusResult = await runner.run(buildLarkHistoryRevertStatusInvocation({
          document: proposal.parameters.document,
          taskId: providerTaskId,
        }));
        try {
          envelope = requireSuccessEnvelope(statusResult, {
            connector: "lark",
            phase: "prepare",
            writeAttempted: false,
          });
        } catch {
          break;
        }
        resultState = envelope?.data?.result ?? resultState;
        providerState = envelope?.data?.status ?? resultState;
        if (["partial_failed", "partial_success", "failed"].includes(providerState)) {
          throw workerError(
            "WORKER_LARK_OUTCOME_UNKNOWN",
            "飞书版本恢复未完整完成，必须人工检查目标文档",
            409,
            { unknownOutcome: true },
          );
        }
        if (providerState !== "running") break;
      }
    }
    if (
      proposal.operation === "history_revert"
      && providerState !== "running"
      && !["done", "success", "completed"].includes(providerState)
    ) {
      throw workerError(
        "WORKER_LARK_OUTCOME_UNKNOWN",
        "飞书版本恢复返回了无法确认的最终状态，必须人工检查",
        409,
        { unknownOutcome: true },
      );
    }
    const document = envelope?.data?.document ?? {};
    const documentLocator = document.url
      ?? document.document_id
      ?? proposal.parameters.document
      ?? null;
    providerTaskId = envelope?.data?.task_id ?? providerTaskId;
    let verification = providerState === "running"
      ? {
          status: "pending_provider_completion",
          taskId: providerTaskId,
          revisionId: null,
        }
      : {
          status: "result_verified",
          revisionId: larkRevision(envelope) || null,
        };
    if (providerState !== "running" && documentLocator) {
      const readback = await runner.run(buildLarkReadInvocation("fetch", {
        document: documentLocator,
        detail: proposal.operation === "history_revert" ? "full" : "simple",
      }));
      let readbackEnvelope = null;
      try {
        readbackEnvelope = requireSuccessEnvelope(readback, {
          connector: "lark",
          phase: "prepare",
          writeAttempted: false,
        });
      } catch {
        // The write already happened; a failed read-back remains visible below.
      }
      if (!readbackEnvelope && proposal.operation === "history_revert") {
        throw workerError(
          "WORKER_LARK_OUTCOME_UNKNOWN",
          "飞书版本恢复完成但读取验证失败，必须人工检查",
          409,
          { unknownOutcome: true },
        );
      }
      if (readbackEnvelope && proposal.operation === "history_revert") {
        const revisionId = larkRevision(readbackEnvelope);
        const content = readbackEnvelope?.data?.document?.content;
        const expectedContentSha256 = proposal.sourceBindings?.after?.exactContentSha256;
        if (
          !Number.isSafeInteger(revisionId)
          || revisionId <= proposal.baseRevisionId
          || typeof content !== "string"
          || typeof expectedContentSha256 !== "string"
          || sha256(content) !== expectedContentSha256
        ) {
          throw workerError(
            "WORKER_LARK_OUTCOME_UNKNOWN",
            "飞书版本恢复后的正文或新版本无法与已确认预览核对，必须人工检查",
            409,
            { unknownOutcome: true },
          );
        }
      }
      verification = readbackEnvelope
        ? {
          status: "readback_verified",
          revisionId: larkRevision(readbackEnvelope) || null,
          ...(proposal.operation === "history_revert"
            ? { contentSha256: proposal.sourceBindings.after.exactContentSha256 }
            : {}),
        }
        : {
          status: "readback_failed",
          revisionId: larkRevision(envelope) || null,
        };
    }
    return {
      deliveryStatus: providerState === "running" ? "queued" : "completed",
      provider: "lark",
      externalId: document.document_id ?? providerTaskId,
      externalUrl: document.url ?? null,
      providerState,
      verification,
    };
  }

  async function resumeLarkHistoryRevert({ proposal, receipt }) {
    if (proposal.operation !== "history_revert") {
      throw workerError("WORKER_ACTION_STATE_INVALID", "该交付操作不支持状态续查", 409);
    }
    const providerTaskId = receipt?.verification?.taskId ?? receipt?.externalId;
    if (typeof providerTaskId !== "string" || !providerTaskId) {
      throw workerError(
        "WORKER_LARK_OUTCOME_UNKNOWN",
        "缺少飞书版本恢复任务标识，必须人工检查",
        409,
        { unknownOutcome: true },
      );
    }
    let providerState = "running";
    let envelope = null;
    for (let attempt = 0; attempt < historyPollAttempts; attempt += 1) {
      if (historyPollIntervalMs > 0) await wait(historyPollIntervalMs);
      const statusResult = await runner.run(buildLarkHistoryRevertStatusInvocation({
        document: proposal.parameters.document,
        taskId: providerTaskId,
      }));
      try {
        envelope = requireSuccessEnvelope(statusResult, {
          connector: "lark",
          phase: "prepare",
          writeAttempted: false,
        });
      } catch {
        break;
      }
      providerState = envelope?.data?.status ?? envelope?.data?.result ?? "running";
      if (["partial_failed", "partial_success", "failed"].includes(providerState)) {
        throw workerError(
          "WORKER_LARK_OUTCOME_UNKNOWN",
          "飞书版本恢复未完整完成，必须人工检查目标文档",
          409,
          { unknownOutcome: true },
        );
      }
      if (providerState !== "running") break;
    }
    if (providerState === "running") {
      return {
        deliveryStatus: "queued",
        provider: "lark",
        externalId: providerTaskId,
        externalUrl: receipt?.externalUrl ?? null,
        providerState: "running",
        verification: {
          status: "pending_provider_completion",
          taskId: providerTaskId,
          revisionId: null,
        },
      };
    }
    if (!["done", "success", "completed"].includes(providerState)) {
      throw workerError(
        "WORKER_LARK_OUTCOME_UNKNOWN",
        "飞书版本恢复返回了无法确认的最终状态，必须人工检查",
        409,
        { unknownOutcome: true },
      );
    }
    const readback = await runner.run(buildLarkReadInvocation("fetch", {
      document: proposal.parameters.document,
      detail: "full",
    }));
    let readbackEnvelope;
    try {
      readbackEnvelope = requireSuccessEnvelope(readback, {
        connector: "lark",
        phase: "prepare",
        writeAttempted: false,
      });
    } catch {
      throw workerError(
        "WORKER_LARK_OUTCOME_UNKNOWN",
        "飞书版本恢复完成但读取验证失败，必须人工检查",
        409,
        { unknownOutcome: true },
      );
    }
    const revisionId = larkRevision(readbackEnvelope);
    const content = readbackEnvelope?.data?.document?.content;
    const expectedContentSha256 = proposal.sourceBindings?.after?.exactContentSha256;
    if (
      !Number.isSafeInteger(revisionId)
      || revisionId <= proposal.baseRevisionId
      || typeof content !== "string"
      || typeof expectedContentSha256 !== "string"
      || sha256(content) !== expectedContentSha256
    ) {
      throw workerError(
        "WORKER_LARK_OUTCOME_UNKNOWN",
        "飞书版本恢复后的正文或新版本无法与已确认预览核对，必须人工检查",
        409,
        { unknownOutcome: true },
      );
    }
    return {
      deliveryStatus: "completed",
      provider: "lark",
      externalId: providerTaskId,
      externalUrl: receipt?.externalUrl ?? null,
      providerState,
      verification: {
        status: "readback_verified",
        taskId: providerTaskId,
        revisionId,
        contentSha256: expectedContentSha256,
      },
    };
  }

  return Object.freeze({
    externalWritesEnabled: true,
    prepare,
    execute(context) {
      return context.proposal.workerId === "agent_mail"
        ? executeMail(context)
        : executeLark(context);
    },
    resume(context) {
      return resumeLarkHistoryRevert(context);
    },
  });
}

export const __test = Object.freeze({
  assertInvocationArgs,
  parseJsonCandidate,
  resultEnvelope,
  extractMailConfirmation,
  larkRevision,
  validSuccessEnvelope,
  safeMailConfirmationSummary,
});
