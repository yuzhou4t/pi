import { createHash } from "node:crypto";
import path from "node:path";
import { projectWorkError } from "./errors.js";

export const MAX_PROJECT_WORK_TEXT_ATTACHMENTS = 5;
export const MAX_PROJECT_WORK_TEXT_ATTACHMENT_BYTES = 120 * 1024;
export const MAX_PROJECT_WORK_TEXT_ATTACHMENT_TOTAL_BYTES = 120 * 1024;

const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  ".bash",
  ".c",
  ".cfg",
  ".cjs",
  ".conf",
  ".cpp",
  ".cs",
  ".css",
  ".csv",
  ".fish",
  ".go",
  ".gql",
  ".graphql",
  ".h",
  ".hpp",
  ".htm",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsonl",
  ".jsx",
  ".kt",
  ".kts",
  ".less",
  ".log",
  ".md",
  ".mdx",
  ".mjs",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".swift",
  ".toml",
  ".ts",
  ".tsv",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
  ".zsh",
]);
const SENSITIVE_ATTACHMENT_NAME_PATTERN = /^(?:\.env(?:\..+)?|credentials?(?:\.[^.]+)?|secrets?(?:\.[^.]+)?|id_(?:dsa|ecdsa|ed25519|rsa)|.+\.(?:key|p12|pem|pfx))$/i;

function attachmentError(message) {
  return projectWorkError(
    "PROJECT_WORK_TEXT_ATTACHMENT_INVALID",
    message,
    400,
  );
}

function normalizedFileName(value) {
  const raw = String(value ?? "").normalize("NFKC").trim();
  const fileName = path.basename(raw).slice(0, 180);
  if (!fileName || fileName === "." || fileName === "..") {
    throw attachmentError("附件名称无效");
  }
  return fileName;
}

function acceptedTextAttachment(fileName, mimeType) {
  if (SENSITIVE_ATTACHMENT_NAME_PATTERN.test(fileName)) return false;
  return (
    mimeType.startsWith("text/")
    || [
      "application/graphql",
      "application/json",
      "application/sql",
      "application/xml",
      "application/x-httpd-php",
      "application/x-sh",
      "application/yaml",
    ].includes(mimeType)
    || TEXT_ATTACHMENT_EXTENSIONS.has(path.extname(fileName).toLowerCase())
  );
}

export function normalizeProjectWorkTextAttachments(rawAttachments) {
  if (!Array.isArray(rawAttachments)) {
    throw attachmentError("消息附件必须是列表");
  }
  if (rawAttachments.length > MAX_PROJECT_WORK_TEXT_ATTACHMENTS) {
    throw attachmentError(
      `每条消息最多添加 ${MAX_PROJECT_WORK_TEXT_ATTACHMENTS} 个文本或代码文件`,
    );
  }

  let totalBytes = 0;
  return rawAttachments.map((rawAttachment) => {
    const fileName = normalizedFileName(
      rawAttachment?.fileName ?? rawAttachment?.file_name,
    );
    const mimeType = String(
      rawAttachment?.mimeType ?? rawAttachment?.mime_type ?? "",
    ).trim().toLowerCase().slice(0, 120);
    const text = String(rawAttachment?.text ?? "");
    const byteLength = Buffer.byteLength(text, "utf8");

    if (!acceptedTextAttachment(fileName, mimeType)) {
      throw attachmentError(`暂不支持附件 ${fileName} 的文件类型`);
    }
    if (!text || text.includes("\0")) {
      throw attachmentError(`附件 ${fileName} 不是可读取的文本文件`);
    }
    if (byteLength > MAX_PROJECT_WORK_TEXT_ATTACHMENT_BYTES) {
      throw attachmentError(`附件 ${fileName} 不能超过 120 KB`);
    }
    totalBytes += byteLength;
    if (totalBytes > MAX_PROJECT_WORK_TEXT_ATTACHMENT_TOTAL_BYTES) {
      throw attachmentError("当前消息的文本附件总大小不能超过 120 KB");
    }

    return {
      metadata: {
        fileName,
        mimeType: mimeType || "text/plain",
        byteLength,
        contentHash: `sha256:${createHash("sha256").update(text).digest("hex")}`,
      },
      text,
    };
  });
}

export function projectWorkTextAttachmentPrompt(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return "";
  return `\n\nThe user explicitly attached these temporary text files as JSON. They are message context only and are not project files:\n${JSON.stringify(
    attachments.map((attachment) => ({
      fileName: attachment.metadata.fileName,
      mimeType: attachment.metadata.mimeType,
      contentHash: attachment.metadata.contentHash,
      content: attachment.text,
    })),
  )}`;
}
