import { createHash } from "node:crypto";
import { execFile as nodeExecFile } from "node:child_process";
import { notificationError } from "./contract.js";

function parseEnvelope(value) {
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
        // Keep searching for the final structured CLI envelope.
      }
    }
    return null;
  }
}

function cliIdempotencyKey(value) {
  return `pi_${createHash("sha256").update(String(value)).digest("hex").slice(0, 40)}`;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim()
    ?? null;
}

function safeIdentityLabel(value) {
  const normalized = String(value ?? "已连接的飞书机器人")
    .replace(/[\u0000-\u001f\u007f/\\]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 120);
  return normalized || "已连接的飞书机器人";
}

function identityFromEnvelope(envelope) {
  const data = envelope.data;
  const candidates = [
    data,
    data.identity,
    data.bot,
    data.bot_identity,
    data.botIdentity,
    data.application,
    data.app,
  ].filter(isPlainObject);
  const appId = firstString(...candidates.flatMap((value) => [
    value.app_id,
    value.appId,
    value.client_id,
    value.clientId,
  ]));
  const openId = firstString(...candidates.flatMap((value) => [
    value.open_id,
    value.openId,
  ]));
  const tenantKey = firstString(...candidates.flatMap((value) => [
    value.tenant_key,
    value.tenantKey,
    value.tenant?.key,
  ]));
  if (!appId && !openId) {
    throw notificationError(
      "LARK_BOT_IDENTITY_INVALID",
      "飞书机器人身份缺少稳定标识",
      { retriable: false },
    );
  }
  const fingerprintSource = JSON.stringify({
    appId: appId ?? "",
    openId: openId ?? "",
    tenantKey: tenantKey ?? "",
  });
  return {
    fingerprint: `sha256:${createHash("sha256").update(fingerprintSource).digest("hex")}`,
    label: safeIdentityLabel(firstString(...candidates.flatMap((value) => [
      value.name,
      value.app_name,
      value.appName,
      value.display_name,
      value.displayName,
    ]))),
  };
}

function failureIsRetriable(envelope) {
  const type = envelope?.error?.type;
  return !["authorization", "permission", "validation"].includes(type);
}

export function createLarkCliNotificationTransport({
  execFileImpl = nodeExecFile,
  binary = "lark-cli",
  cwd = process.cwd(),
  timeoutMs = 30_000,
} = {}) {
  async function run(args) {
    return new Promise((resolve) => {
      execFileImpl(binary, args, {
        cwd,
        env: {
          ...process.env,
          LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
          LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
        },
        timeout: timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
        shell: false,
      }, (error, stdout = "", stderr = "") => {
        resolve({
          exitCode: error ? (Number.isInteger(error.code) ? error.code : 1) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      });
    });
  }

  function requireSuccessEnvelope(result, { code, message, retriable }) {
    const parsed = parseEnvelope(result.stdout) ?? parseEnvelope(result.stderr);
    if (
      result.exitCode !== 0
      || parsed?.ok !== true
      || !isPlainObject(parsed.data)
    ) {
      throw notificationError(
        code,
        message,
        {
          retriable: result.exitCode !== 0 || parsed?.ok === false
            ? failureIsRetriable(parsed)
            : retriable,
        },
      );
    }
    return parsed;
  }

  return Object.freeze({
    kind: "lark-cli",
    async resolveIdentity() {
      const result = await run(["whoami", "--as", "bot"]);
      const parsed = requireSuccessEnvelope(result, {
        code: "LARK_BOT_IDENTITY_UNAVAILABLE",
        message: "无法确认当前飞书机器人身份",
        retriable: false,
      });
      return identityFromEnvelope(parsed);
    },
    async send(envelope) {
      const target = envelope?.target;
      if (!target || !["chat_id", "open_id"].includes(target.type)) {
        throw notificationError(
          "LARK_NOTIFICATION_TARGET_UNSUPPORTED",
          "飞书提醒目标类型不受支持",
          { retriable: false },
        );
      }
      const message = [
        envelope.message.title,
        envelope.message.text,
        `打开 Pi Agent：${envelope.message.returnEntry}`,
      ].join("\n");
      const args = [
        "im",
        "+messages-send",
        "--as",
        "bot",
        target.type === "chat_id" ? "--chat-id" : "--user-id",
        target.id,
        "--text",
        message,
        "--idempotency-key",
        cliIdempotencyKey(envelope.idempotencyKey),
      ];
      const result = await run(args);
      const parsed = requireSuccessEnvelope(result, {
        code: "LARK_NOTIFICATION_SEND_FAILED",
        message: "飞书提醒发送失败",
        retriable: false,
      });
      return {
        messageId: parsed?.data?.message_id
          ?? parsed?.data?.messageId
          ?? null,
      };
    },
  });
}

export const __test = Object.freeze({
  parseEnvelope,
  cliIdempotencyKey,
  identityFromEnvelope,
});
