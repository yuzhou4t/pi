import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { projectWorkError } from "./errors.js";

const ARCHIVE_PARTS = Object.freeze(["base", "workspace"]);
const RUNNING_STATUSES = new Set([
  "queued",
  "working",
  "running",
  "applying",
  "verifying",
  "stopping",
]);
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

function archiveError(code, message, status = 409, retryable = true) {
  return projectWorkError(code, message, status, retryable);
}

function safeConversationId(value) {
  const id = String(value ?? "").trim();
  if (!CONVERSATION_ID_PATTERN.test(id)) {
    throw archiveError(
      "PROJECT_WORK_LEGACY_ARCHIVE_ID_INVALID",
      "旧工作副本标识无效",
      400,
      false,
    );
  }
  return id;
}

function safeTitle(value) {
  const text = String(value ?? "").replaceAll(/[\u0000-\u001f\u007f]/gu, " ").trim();
  return text.slice(0, 160) || "未命名会话";
}

function updateHash(hash, ...values) {
  for (const value of values) {
    hash.update(String(value));
    hash.update("\0");
  }
}

async function hashFile(filePath, hash, before) {
  const stream = createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  const after = await lstat(filePath, { bigint: true });
  if (
    !after.isFile()
    || after.dev !== before.dev
    || after.ino !== before.ino
    || after.size !== before.size
    || after.mtimeNs !== before.mtimeNs
  ) {
    throw archiveError(
      "PROJECT_WORK_LEGACY_ARCHIVE_DRIFT",
      "旧工作副本在检查时发生变化，请刷新后重试",
    );
  }
}

async function scanEntry({ root, relativePath, part, hash, aggregate }) {
  const target = relativePath ? path.join(root, relativePath) : root;
  const stat = await lstat(target, { bigint: true });
  const logicalPath = relativePath
    ? `${part}/${relativePath.split(path.sep).join("/")}`
    : part;
  if (stat.isSymbolicLink()) {
    throw archiveError(
      "PROJECT_WORK_LEGACY_ARCHIVE_SYMLINK",
      "旧工作副本包含符号链接，不能由 Pi Agent 清理",
    );
  }
  if (stat.isDirectory()) {
    updateHash(hash, "directory", logicalPath, stat.mode);
    const names = (await readdir(target)).sort((left, right) => left.localeCompare(right));
    for (const name of names) {
      await scanEntry({
        root,
        relativePath: relativePath ? path.join(relativePath, name) : name,
        part,
        hash,
        aggregate,
      });
    }
    return;
  }
  if (!stat.isFile()) {
    throw archiveError(
      "PROJECT_WORK_LEGACY_ARCHIVE_UNSUPPORTED_ENTRY",
      "旧工作副本包含无法安全清理的文件类型",
    );
  }
  updateHash(hash, "file", logicalPath, stat.mode, stat.size);
  await hashFile(target, hash, stat);
  hash.update("\0");
  aggregate.bytes += Number(stat.size);
  aggregate.fileCount += 1;
}

async function existingArchiveParts(conversationDirectory) {
  const parts = [];
  for (const part of ARCHIVE_PARTS) {
    try {
      const stat = await lstat(path.join(conversationDirectory, part));
      if (stat.isSymbolicLink()) {
        throw archiveError(
          "PROJECT_WORK_LEGACY_ARCHIVE_SYMLINK",
          "旧工作副本包含符号链接，不能由 Pi Agent 清理",
        );
      }
      if (!stat.isDirectory()) {
        throw archiveError(
          "PROJECT_WORK_LEGACY_ARCHIVE_UNSUPPORTED_ENTRY",
          "旧工作副本包含无法安全清理的文件类型",
        );
      }
      parts.push(part);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return parts;
}

async function scanArchive(conversationDirectory, parts) {
  const hash = createHash("sha256");
  const aggregate = { bytes: 0, fileCount: 0 };
  updateHash(hash, "pi-agent-legacy-workspace-archive-v1");
  for (const part of parts) {
    await scanEntry({
      root: path.join(conversationDirectory, part),
      relativePath: "",
      part,
      hash,
      aggregate,
    });
  }
  return {
    archiveHash: `sha256:${hash.digest("hex")}`,
    bytes: aggregate.bytes,
    fileCount: aggregate.fileCount,
  };
}

function cleanupBlockReason(conversation) {
  const migrationStatus = conversation?.legacyMigration?.status ?? "pending";
  if (migrationStatus !== "completed") {
    return ["needs_review", "blocked"].includes(migrationStatus)
      ? migrationStatus
      : "migration_incomplete";
  }
  if (
    conversation?.runtimeMode !== "workspace-v2"
    || conversation?.runtimeProfile !== "pi-native-v1"
  ) {
    return "migration_incomplete";
  }
  if (RUNNING_STATUSES.has(String(conversation?.status ?? ""))) return "conversation_running";
  return null;
}

async function readConversationRecord(conversationDirectory) {
  const stateFile = path.join(conversationDirectory, "conversation.json");
  const stateStat = await lstat(stateFile);
  if (!stateStat.isFile() || stateStat.isSymbolicLink()) {
    throw archiveError(
      "PROJECT_WORK_LEGACY_ARCHIVE_STATE_INVALID",
      "旧工作副本的会话记录无效",
    );
  }
  const value = JSON.parse(await readFile(stateFile, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("conversation record must be an object");
  }
  return value;
}

function mutationOriginFor(items) {
  const hash = createHash("sha256");
  updateHash(hash, "pi-agent-legacy-workspace-cleanup-v1");
  for (const item of items) {
    updateHash(
      hash,
      item.conversationId,
      item.archiveHash ?? "unavailable",
      item.bytes ?? "unavailable",
      item.cleanupEligible ? "eligible" : item.blockedReason,
    );
  }
  return `sha256:${hash.digest("hex")}`;
}

function publicSummary(items) {
  const sorted = [...items].sort((left, right) => (
    left.title.localeCompare(right.title, "zh-CN")
    || left.conversationId.localeCompare(right.conversationId)
  ));
  return {
    schemaVersion: 1,
    totalBytes: sorted.reduce((sum, item) => sum + (item.bytes ?? 0), 0),
    totalFileCount: sorted.reduce((sum, item) => sum + (item.fileCount ?? 0), 0),
    itemCount: sorted.length,
    cleanupEligibleCount: sorted.filter((item) => item.cleanupEligible).length,
    mutationOrigin: mutationOriginFor(sorted),
    items: sorted,
  };
}

export function createLegacyWorkspaceArchiveService({ storageRoot } = {}) {
  if (typeof storageRoot !== "string" || !storageRoot.trim()) {
    throw new TypeError("storageRoot is required");
  }
  const conversationsRoot = path.resolve(storageRoot, "conversations");

  function conversationDirectory(conversationId) {
    const id = safeConversationId(conversationId);
    const target = path.resolve(conversationsRoot, id);
    if (path.dirname(target) !== conversationsRoot) {
      throw archiveError(
        "PROJECT_WORK_LEGACY_ARCHIVE_ID_INVALID",
        "旧工作副本标识无效",
        400,
        false,
      );
    }
    return target;
  }

  async function inspectOne(conversationId) {
    const directory = conversationDirectory(conversationId);
    const directoryStat = await lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw archiveError(
        "PROJECT_WORK_LEGACY_ARCHIVE_STATE_INVALID",
        "旧工作副本的会话目录无效",
      );
    }
    const conversation = await readConversationRecord(directory);
    if (
      conversation.workType === "worker"
      || conversation.workspaceKind === "scratch"
      || conversation.scope === "standalone"
    ) return null;
    const parts = await existingArchiveParts(directory);
    if (parts.length === 0) return null;
    const common = {
      conversationId,
      title: safeTitle(conversation.title),
      parts,
    };
    try {
      const scanned = await scanArchive(directory, parts);
      const blockedReason = cleanupBlockReason(conversation);
      return {
        ...common,
        ...scanned,
        cleanupEligible: blockedReason === null,
        blockedReason,
      };
    } catch (error) {
      if (![
        "PROJECT_WORK_LEGACY_ARCHIVE_SYMLINK",
        "PROJECT_WORK_LEGACY_ARCHIVE_UNSUPPORTED_ENTRY",
        "EACCES",
        "EPERM",
      ].includes(error?.code)) throw error;
      return {
        ...common,
        archiveHash: null,
        bytes: null,
        fileCount: null,
        cleanupEligible: false,
        blockedReason: error.code === "PROJECT_WORK_LEGACY_ARCHIVE_SYMLINK"
          ? "archive_symlink"
          : error.code === "PROJECT_WORK_LEGACY_ARCHIVE_UNSUPPORTED_ENTRY"
            ? "archive_unsupported_entry"
            : "archive_unreadable",
      };
    }
  }

  async function getSummary() {
    let names;
    try {
      names = await readdir(conversationsRoot);
    } catch (error) {
      if (error?.code === "ENOENT") return publicSummary([]);
      throw error;
    }
    const items = [];
    for (const name of names.sort((left, right) => left.localeCompare(right))) {
      if (!CONVERSATION_ID_PATTERN.test(name)) continue;
      try {
        const item = await inspectOne(name);
        if (item) items.push(item);
      } catch (error) {
        if (error?.code === "ENOENT" || error instanceof SyntaxError) continue;
        throw error;
      }
    }
    return publicSummary(items);
  }

  async function cleanup({ mutationOrigin, items } = {}) {
    if (!SHA256_PATTERN.test(String(mutationOrigin ?? ""))) {
      throw archiveError(
        "PROJECT_WORK_LEGACY_ARCHIVE_REQUEST_INVALID",
        "清理确认已失效，请刷新后重试",
        400,
        false,
      );
    }
    if (!Array.isArray(items) || items.length < 1 || items.length > 100) {
      throw archiveError(
        "PROJECT_WORK_LEGACY_ARCHIVE_REQUEST_INVALID",
        "请选择要清理的旧工作副本",
        400,
        false,
      );
    }
    const requested = items.map((item) => ({
      conversationId: safeConversationId(item?.conversationId),
      archiveHash: String(item?.archiveHash ?? ""),
      bytes: Number(item?.bytes),
    }));
    if (
      new Set(requested.map((item) => item.conversationId)).size !== requested.length
      || requested.some((item) => (
        !SHA256_PATTERN.test(item.archiveHash)
        || !Number.isSafeInteger(item.bytes)
        || item.bytes < 0
      ))
    ) {
      throw archiveError(
        "PROJECT_WORK_LEGACY_ARCHIVE_REQUEST_INVALID",
        "旧工作副本清理绑定无效",
        400,
        false,
      );
    }

    const currentSummary = await getSummary();
    if (currentSummary.mutationOrigin !== mutationOrigin) {
      throw archiveError(
        "PROJECT_WORK_LEGACY_ARCHIVE_DRIFT",
        "旧工作副本列表已经变化，请刷新后重新确认",
      );
    }
    const currentById = new Map(currentSummary.items.map((item) => [item.conversationId, item]));
    for (const request of requested) {
      const current = currentById.get(request.conversationId);
      if (!current || !current.cleanupEligible) {
        throw archiveError(
          "PROJECT_WORK_LEGACY_ARCHIVE_CLEANUP_BLOCKED",
          "所选旧工作副本尚未完成迁移或会话仍在运行",
        );
      }
      if (current.archiveHash !== request.archiveHash || current.bytes !== request.bytes) {
        throw archiveError(
          "PROJECT_WORK_LEGACY_ARCHIVE_DRIFT",
          "旧工作副本已经变化，请刷新后重新确认",
        );
      }
    }

    // Re-scan every selected archive immediately before mutation. Only the exact
    // legacy base/workspace directories are ever removed.
    for (const request of requested) {
      const rescanned = await inspectOne(request.conversationId);
      if (
        !rescanned?.cleanupEligible
        || rescanned.archiveHash !== request.archiveHash
        || rescanned.bytes !== request.bytes
      ) {
        throw archiveError(
          "PROJECT_WORK_LEGACY_ARCHIVE_DRIFT",
          "旧工作副本已经变化，请刷新后重新确认",
        );
      }
    }
    for (const request of requested) {
      const directory = conversationDirectory(request.conversationId);
      for (const part of ARCHIVE_PARTS) {
        const target = path.join(directory, part);
        try {
          const stat = await lstat(target);
          if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw archiveError(
              "PROJECT_WORK_LEGACY_ARCHIVE_DRIFT",
              "旧工作副本已经变化，请刷新后重新确认",
            );
          }
          await rm(target, { recursive: true, force: false, maxRetries: 0 });
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
    }
    return getSummary();
  }

  return Object.freeze({ getSummary, cleanup });
}
