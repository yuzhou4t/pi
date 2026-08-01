export const NOTIFICATION_SCHEMA_VERSION = 1;

export const ATTENTION_EVENT_STATES = Object.freeze([
  "awaiting_user",
  "awaiting_review",
  "verification_failed",
  "recovery_blocked",
]);

export const OPTIONAL_EVENT_STATES = Object.freeze(["completed"]);

export const NOTIFICATION_EVENT_STATES = Object.freeze([
  ...ATTENTION_EVENT_STATES,
  ...OPTIONAL_EVENT_STATES,
]);

export const DEFAULT_TEMPLATE = Object.freeze({
  id: "pi_project_attention",
  version: 1,
});

export const DEFAULT_RETURN_ENTRY_BASE_URL = "http://127.0.0.1:4173/";

const EVENT_COPY = Object.freeze({
  awaiting_user: Object.freeze({
    title: "Pi Agent 等待你的回答",
    detail: "回到当前任务继续；通知不会代替任何确认。",
  }),
  awaiting_review: Object.freeze({
    title: "Pi Agent 有内容等待审阅",
    detail: "回到当前任务核对内容后再决定是否继续。",
  }),
  verification_failed: Object.freeze({
    title: "Pi Agent 的验证未通过",
    detail: "回到当前任务查看受控结果和恢复选项。",
  }),
  recovery_blocked: Object.freeze({
    title: "Pi Agent 需要你检查恢复状态",
    detail: "自动恢复已停止；回到当前任务检查后再继续。",
  }),
  completed: Object.freeze({
    title: "Pi Agent 已完成本轮工作",
    detail: "结果和验证证据已保存在当前任务中。",
  }),
});

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const BOT_FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const TARGET_TYPES = new Set(["chat_id", "open_id"]);
const RECURSIVE_ORIGINS = new Set([
  "notification",
  "notification_dispatcher",
  "notification_transport",
]);

export class NotificationError extends Error {
  constructor(code, message, { retriable = false } = {}) {
    super(message);
    this.name = "NotificationError";
    this.code = code;
    this.retriable = retriable;
  }
}

export function notificationError(code, message, options) {
  return new NotificationError(code, message, options);
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw notificationError("NOTIFICATION_INPUT_INVALID", `${label} 必须是对象`);
  }
  return value;
}

export function assertOnlyKeys(value, allowedKeys, label = "输入") {
  assertPlainObject(value, label);
  const unknown = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unknown.length > 0) {
    throw notificationError(
      "NOTIFICATION_UNSAFE_FIELD",
      `${label} 包含不允许的字段: ${unknown.join(", ")}`,
    );
  }
}

export function normalizeIdentifier(value, label) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw notificationError("NOTIFICATION_INPUT_INVALID", `${label} 无效`);
  }
  return value;
}

export function normalizeSafeLabel(value, label = "项目名称") {
  if (typeof value !== "string") {
    throw notificationError("NOTIFICATION_INPUT_INVALID", `${label} 无效`);
  }
  const normalized = value.trim();
  if (
    !normalized
    || normalized.length > 120
    || /[\u0000-\u001f\u007f]/u.test(normalized)
    || normalized.includes("/")
    || normalized.includes("\\")
  ) {
    throw notificationError("NOTIFICATION_INPUT_INVALID", `${label} 无效`);
  }
  return normalized;
}

export function normalizeEventState(value) {
  if (!NOTIFICATION_EVENT_STATES.includes(value)) {
    throw notificationError("NOTIFICATION_EVENT_UNSUPPORTED", "提醒事件类型不受支持");
  }
  return value;
}

export function normalizeEventStates(
  value,
  { fallback = ATTENTION_EVENT_STATES, allowEmpty = true } = {},
) {
  const source = value === undefined ? fallback : value;
  if (!Array.isArray(source) || (!allowEmpty && source.length === 0)) {
    throw notificationError("NOTIFICATION_INPUT_INVALID", "提醒事件范围无效");
  }
  return [...new Set(source.map(normalizeEventState))];
}

export function normalizeTarget(value) {
  assertOnlyKeys(value, ["type", "id", "label"], "飞书接收目标");
  if (!TARGET_TYPES.has(value.type)) {
    throw notificationError("NOTIFICATION_TARGET_INVALID", "飞书接收目标类型无效");
  }
  const id = normalizeIdentifier(value.id, "飞书接收目标标识");
  const label = normalizeSafeLabel(value.label, "飞书接收目标名称");
  return { type: value.type, id, label };
}

export function normalizeBotIdentity(value) {
  assertOnlyKeys(value, ["fingerprint", "label"], "飞书机器人身份");
  if (
    typeof value.fingerprint !== "string"
    || !BOT_FINGERPRINT_PATTERN.test(value.fingerprint)
  ) {
    throw notificationError(
      "LARK_BOT_IDENTITY_INVALID",
      "飞书机器人身份校验失败",
    );
  }
  return {
    fingerprint: value.fingerprint,
    label: normalizeSafeLabel(value.label, "飞书机器人名称"),
  };
}

function assertControlledReturnUrl(url) {
  const isLoopbackHttp = ["http:", "https:"].includes(url.protocol)
    && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  const isAppEntry = url.protocol === "pi-agent:" && url.hostname === "app";
  if (
    (!isLoopbackHttp && !isAppEntry)
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.hash
  ) {
    throw notificationError(
      "NOTIFICATION_RETURN_ENTRY_INVALID",
      "提醒返回入口不在允许范围内",
    );
  }
}

export function normalizeReturnEntryBaseUrl(
  value = DEFAULT_RETURN_ENTRY_BASE_URL,
) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw notificationError(
      "NOTIFICATION_RETURN_ENTRY_INVALID",
      "提醒返回入口无效",
    );
  }
  assertControlledReturnUrl(url);
  if ([...url.searchParams.keys()].length > 0) {
    throw notificationError(
      "NOTIFICATION_RETURN_ENTRY_INVALID",
      "提醒返回入口不能预置参数",
    );
  }
  return url.toString();
}

export function buildReturnEntry({ baseUrl, conversationId }) {
  const url = new URL(normalizeReturnEntryBaseUrl(baseUrl));
  url.searchParams.set("work_type", "project_work");
  url.searchParams.set(
    "conversation_id",
    normalizeIdentifier(conversationId, "工作会话标识"),
  );
  return url.toString();
}

export function normalizeReturnEntry(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw notificationError(
      "NOTIFICATION_RETURN_ENTRY_INVALID",
      "提醒返回入口无效",
    );
  }
  assertControlledReturnUrl(url);
  const keys = [...url.searchParams.keys()];
  if (
    keys.length !== 2
    || !keys.includes("work_type")
    || !keys.includes("conversation_id")
    || url.searchParams.get("work_type") !== "project_work"
  ) {
    throw notificationError(
      "NOTIFICATION_RETURN_ENTRY_INVALID",
      "提醒返回入口参数无效",
    );
  }
  normalizeIdentifier(url.searchParams.get("conversation_id"), "工作会话标识");
  return url.toString();
}

export function normalizeTemplate(value = DEFAULT_TEMPLATE) {
  assertOnlyKeys(value, ["id", "version"], "提醒模板");
  if (
    value.id !== DEFAULT_TEMPLATE.id
    || value.version !== DEFAULT_TEMPLATE.version
  ) {
    throw notificationError("NOTIFICATION_TEMPLATE_UNSUPPORTED", "提醒模板不受支持");
  }
  return { ...DEFAULT_TEMPLATE };
}

export function isNotificationOrigin(value) {
  return typeof value === "string"
    && (
      RECURSIVE_ORIGINS.has(value)
      || value.startsWith("notification.")
    );
}

export function buildSafeMessage({ state, projectLabel, returnEntry }) {
  const normalizedState = normalizeEventState(state);
  const normalizedProjectLabel = normalizeSafeLabel(projectLabel);
  const copy = EVENT_COPY[normalizedState];
  return Object.freeze({
    title: copy.title,
    text: `${normalizedProjectLabel} · ${copy.detail}`,
    returnEntry: normalizeReturnEntry(returnEntry),
  });
}

export function sanitizeTransportReceipt(value, acceptedAt) {
  const messageId = typeof value?.messageId === "string"
    && ID_PATTERN.test(value.messageId)
    ? value.messageId
    : null;
  return {
    messageId,
    acceptedAt,
  };
}
