import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { buildDocumentIndex } from "../journal/documentIndex.js";
import { MineruCloudError } from "../mineruCloud.js";
import { projectWorkError } from "./errors.js";

export const PROJECT_WORK_PDF_MAX_BYTES = 50 * 1024 * 1024;

const MAX_DOCUMENTS_PER_CONVERSATION = 20;
const MAX_SEARCH_QUERY_CHARS = 500;
const MAX_SEARCH_RESULTS = 20;
const MAX_READ_BLOCKS = 12;
const MAX_READ_CHARS = 48_000;
const MAX_DOCUMENT_TOOL_JSON_CHARS = 60_000;
const DEFAULT_MAX_POLL_ATTEMPTS = 900;
const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const BLOCK_ID_PATTERN = /^block-[A-Za-z0-9_-]{1,80}$/;
const ACTIVE_DOCUMENT_STATUSES = new Set([
  "receiving",
  "local_ready",
  "submitting",
  "parsing",
  "preparing",
  "indexing",
  "removing",
]);
const RETRYABLE_DOCUMENT_STATUSES = new Set([
  "not_configured",
  "quota_deferred",
  "upload_interrupted",
  "failed",
  "indexing_failed",
]);

function compactText(value, maxLength, fallback = "") {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replaceAll(/\s+/g, " ")
    .slice(0, maxLength) || fallback;
}

function assertDocumentId(value) {
  if (typeof value !== "string" || !DOCUMENT_ID_PATTERN.test(value)) {
    throw projectWorkError(
      "PROJECT_WORK_DOCUMENT_ID_INVALID",
      "会话资料标识无效",
      400,
    );
  }
  return value;
}

function safePdfFileName(value) {
  const fileName = String(value ?? "").normalize("NFC").trim();
  if (
    !fileName
    || fileName.length > 255
    || fileName === "."
    || fileName === ".."
    || fileName.includes("/")
    || fileName.includes("\\")
    || /[\0\r\n]/.test(fileName)
    || path.basename(fileName) !== fileName
    || path.extname(fileName).toLowerCase() !== ".pdf"
  ) {
    throw projectWorkError(
      "PROJECT_WORK_DOCUMENT_NAME_INVALID",
      "请选择名称有效的 PDF 文件",
      400,
    );
  }
  return fileName;
}

function pdfByteLength(value) {
  const byteLength = Number(value);
  if (
    !Number.isSafeInteger(byteLength)
    || byteLength < 5
    || byteLength > PROJECT_WORK_PDF_MAX_BYTES
  ) {
    throw projectWorkError(
      "PROJECT_WORK_DOCUMENT_SIZE_INVALID",
      "PDF 必须大于 5 字节且不超过 50 MB",
      413,
    );
  }
  return byteLength;
}

function contentLength(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw projectWorkError(
      "PROJECT_WORK_DOCUMENT_LENGTH_INVALID",
      "PDF 请求长度无效",
      400,
    );
  }
  return parsed;
}

function documentError(error, fallback = "PDF 解析失败，可以重试") {
  if (error instanceof MineruCloudError) {
    if (error.category === "quota") {
      return {
        status: "quota_deferred",
        error: {
          code: error.code,
          message: "MinerU 今日解析额度已用完，可以稍后重试",
          retryable: true,
        },
      };
    }
    if (error.category === "token") {
      return {
        status: "not_configured",
        error: {
          code: error.code,
          message: "MinerU 凭据当前不可用，请检查本机服务配置",
          retryable: true,
        },
      };
    }
    return {
      status: error.code === "MINERU_MARKDOWN_INVALID"
        || error.code === "MINERU_MARKDOWN_EMPTY"
        || error.category === "archive"
        ? "indexing_failed"
        : "failed",
      error: {
        code: error.code,
        message: error.category === "archive"
          ? "MinerU 解析结果无法安全读取，可以重试"
          : compactText(error.message, 500, fallback),
        retryable: error.retryable === true || error.category === "archive",
      },
    };
  }
  if (error instanceof RangeError) {
    return {
      status: "indexing_failed",
      error: {
        code: "PROJECT_WORK_DOCUMENT_INDEX_TOO_LARGE",
        message: "解析正文超过当前可读索引上限，原始 PDF 已保留",
        retryable: false,
      },
    };
  }
  return {
    status: "failed",
    error: {
      code: "PROJECT_WORK_DOCUMENT_PROCESSING_FAILED",
      message: fallback,
      retryable: true,
    },
  };
}

function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  return mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
    .then(() => writeFile(
      temporaryPath,
      `${JSON.stringify(value, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    ))
    .then(() => rename(temporaryPath, filePath))
    .catch(async (error) => {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    });
}

function revisionFor(markdown) {
  return `sha256:${createHash("sha256").update(markdown, "utf8").digest("hex")}`;
}

function normalizedDocument(conversation, documentId) {
  const id = assertDocumentId(documentId);
  const document = (conversation.documents ?? []).find((entry) => entry.id === id);
  if (!document) {
    throw projectWorkError(
      "PROJECT_WORK_DOCUMENT_NOT_FOUND",
      "当前会话中没有这份资料",
      404,
    );
  }
  return document;
}

function publicError(value) {
  if (!value || typeof value !== "object") return null;
  return {
    code: compactText(value.code, 160, "PROJECT_WORK_DOCUMENT_FAILED"),
    message: compactText(value.message, 500, "PDF 解析失败"),
    retryable: value.retryable === true,
  };
}

export function publicConversationDocument(document) {
  if (!document || typeof document !== "object") return null;
  return {
    id: document.id,
    fileName: document.fileName,
    byteLength: document.byteLength,
    status: document.status,
    parser: "MinerU Cloud v4",
    sha256: document.sha256 ?? null,
    revision: document.revision ?? null,
    title: document.title ?? null,
    blockCount: Number.isSafeInteger(document.blockCount)
      ? document.blockCount
      : null,
    imageCount: Number.isSafeInteger(document.imageCount)
      ? document.imageCount
      : null,
    parserState: document.parserState ?? null,
    error: publicError(document.error),
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    readyAt: document.readyAt ?? null,
  };
}

export function hasActiveConversationDocuments(conversation) {
  return (conversation?.documents ?? []).some(
    (document) => ACTIVE_DOCUMENT_STATUSES.has(document.status),
  );
}

function normalizeSearchText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replaceAll(/\s+/g, " ")
    .trim();
}

function searchExcerpt(value, needle) {
  const text = String(value ?? "").replaceAll(/\s+/g, " ").trim();
  if (text.length <= 520) return text;
  const normalized = normalizeSearchText(text);
  const index = normalized.indexOf(needle);
  const start = index < 0 ? 0 : Math.max(0, index - 180);
  return `${start > 0 ? "…" : ""}${text.slice(start, start + 500)}${
    start + 500 < text.length ? "…" : ""
  }`;
}

function safeSectionPath(value) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(-8)
    .map((segment) => compactText(segment, 200))
    .filter(Boolean);
}

function boundReadResult(result) {
  const bounded = structuredClone(result);
  while (
    JSON.stringify(bounded).length > MAX_DOCUMENT_TOOL_JSON_CHARS
    && bounded.blocks.length > 0
  ) {
    const longest = bounded.blocks.reduce((selected, block) => (
      block.content.length > selected.content.length ? block : selected
    ), bounded.blocks[0]);
    if (longest.content.length <= 256 && bounded.blocks.length > 1) {
      bounded.blocks.pop();
    } else {
      const nextLength = Math.max(
        0,
        longest.content.length - Math.max(256, Math.ceil(longest.content.length / 4)),
      );
      longest.content = longest.content.slice(0, nextLength);
      longest.truncated = true;
    }
    bounded.truncated = true;
  }
  if (JSON.stringify(bounded).length > MAX_DOCUMENT_TOOL_JSON_CHARS) {
    bounded.blocks = [];
    bounded.truncated = true;
    bounded.notice = "所选内容块超出单次读取上限，请减少内容块后重试";
  }
  return bounded;
}

export function createConversationDocumentService({
  getConversation,
  updateConversation,
  appendEvent,
  directoryForConversation,
  parser = null,
  now = () => new Date(),
  idFactory = randomUUID,
  pollIntervalMs = 2_000,
  maxPollAttempts = DEFAULT_MAX_POLL_ATTEMPTS,
  processingConcurrency = 2,
} = {}) {
  if (
    typeof getConversation !== "function"
    || typeof updateConversation !== "function"
    || typeof appendEvent !== "function"
    || typeof directoryForConversation !== "function"
  ) {
    throw new TypeError("conversation document storage callbacks are required");
  }
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 0) {
    throw new TypeError("pollIntervalMs must be a non-negative integer");
  }
  if (!Number.isSafeInteger(maxPollAttempts) || maxPollAttempts < 1) {
    throw new TypeError("maxPollAttempts must be a positive integer");
  }
  if (
    !Number.isSafeInteger(processingConcurrency)
    || processingConcurrency < 1
    || processingConcurrency > 4
  ) {
    throw new TypeError("processingConcurrency must be an integer from 1 to 4");
  }

  const jobs = new Map();
  const timers = new Map();
  const activeUploads = new Set();
  const processingWaiters = [];
  let activeProcessingJobs = 0;
  let disposed = false;

  function timestamp() {
    return now().toISOString();
  }

  function documentDirectory(conversationId, documentId) {
    const id = assertDocumentId(documentId);
    return path.join(directoryForConversation(conversationId), "documents", id);
  }

  function sourcePath(conversationId, documentId) {
    return path.join(documentDirectory(conversationId, documentId), "source.pdf");
  }

  function extractionDirectory(conversationId, documentId) {
    return path.join(documentDirectory(conversationId, documentId), "extraction");
  }

  async function updateDocument(conversationId, documentId, updater) {
    const id = assertDocumentId(documentId);
    const updated = await updateConversation(conversationId, (conversation) => {
      let found = false;
      const documents = (conversation.documents ?? []).map((document) => {
        if (document.id !== id) return document;
        found = true;
        const patch = typeof updater === "function"
          ? updater(structuredClone(document))
          : updater;
        return {
          ...document,
          ...patch,
          id: document.id,
          fileName: document.fileName,
          byteLength: document.byteLength,
          createdAt: document.createdAt,
          updatedAt: timestamp(),
        };
      });
      if (!found) {
        throw projectWorkError(
          "PROJECT_WORK_DOCUMENT_NOT_FOUND",
          "当前会话中没有这份资料",
          404,
        );
      }
      return { documents };
    });
    return normalizedDocument(updated, id);
  }

  async function recordFailure(conversationId, documentId, error) {
    const failure = documentError(error);
    const document = await updateDocument(conversationId, documentId, (current) => ({
      status: failure.status,
      error: failure.error,
      batchTerminal: error?.batchTerminal === true
        ? true
        : current.batchTerminal === true,
    }));
    await appendEvent(conversationId, "document.failed", {
      documentId,
      status: document.status,
      error: publicError(document.error),
    });
    return document;
  }

  function jobKey(conversationId, documentId) {
    return `${conversationId}\0${documentId}`;
  }

  async function acquireProcessingSlot() {
    if (disposed) return false;
    if (activeProcessingJobs < processingConcurrency) {
      activeProcessingJobs += 1;
      return true;
    }
    return new Promise((resolve) => processingWaiters.push(resolve));
  }

  function releaseProcessingSlot() {
    const next = processingWaiters.shift();
    if (next) {
      next(true);
      return;
    }
    activeProcessingJobs -= 1;
  }

  async function withProcessingSlot(operation) {
    const acquired = await acquireProcessingSlot();
    if (!acquired) return undefined;
    try {
      if (disposed) return undefined;
      return await operation();
    } finally {
      releaseProcessingSlot();
    }
  }

  function schedule(conversationId, documentId, delayMs = 0) {
    if (disposed) return;
    const key = jobKey(conversationId, documentId);
    if (timers.has(key)) return;
    if (delayMs > 0) {
      const timer = setTimeout(() => {
        timers.delete(key);
        schedule(conversationId, documentId);
      }, delayMs);
      timer.unref?.();
      timers.set(key, timer);
      return;
    }
    if (jobs.has(key)) return;
    const job = Promise.resolve()
      .then(() => processDocument(conversationId, documentId))
      .catch(async (error) => {
        try {
          await recordFailure(conversationId, documentId, error);
        } catch {
          // The conversation may have been removed after the job reached a terminal state.
        }
      })
      .finally(() => {
        if (jobs.get(key) === job) jobs.delete(key);
      });
    jobs.set(key, job);
  }

  async function persistExtraction(conversationId, document, result) {
    const target = extractionDirectory(conversationId, document.id);
    const temporary = `${target}.${randomUUID()}.tmp`;
    const imagesDirectory = path.join(temporary, "images");
    await mkdir(imagesDirectory, { recursive: true, mode: 0o700 });
    try {
      const index = buildDocumentIndex(result.markdown);
      await Promise.all([
        writeFile(
          path.join(temporary, "document.md"),
          `${result.markdown.trim()}\n`,
          { encoding: "utf8", flag: "wx", mode: 0o600 },
        ),
        ...result.images.map((image) => writeFile(
          path.join(imagesDirectory, image.name),
          image.bytes,
          { flag: "wx", mode: 0o600 },
        )),
      ]);
      await writeJsonAtomic(path.join(temporary, "index.json"), index);
      await rm(target, { recursive: true, force: true });
      await rename(temporary, target);
      return {
        index,
        revision: revisionFor(result.markdown),
      };
    } catch (error) {
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async function submitDocument(conversationId, document) {
    if (!parser) {
      await updateDocument(conversationId, document.id, {
        status: "not_configured",
        error: {
          code: "PROJECT_WORK_MINERU_NOT_CONFIGURED",
          message: "本机服务尚未配置 MinerU，PDF 已安全保存在当前会话",
          retryable: true,
        },
      });
      await appendEvent(conversationId, "document.failed", {
        documentId: document.id,
        status: "not_configured",
      });
      return;
    }
    await updateDocument(conversationId, document.id, {
      status: "submitting",
      error: null,
      parserState: "allocating",
      pollAttempts: 0,
    });
    const submission = await parser.submitBatch([{
      filePath: sourcePath(conversationId, document.id),
      fileName: document.fileName,
      dataId: document.id,
    }], {
      onBatchAllocated: async ({ batchId, traceId }) => {
        await updateDocument(conversationId, document.id, {
          batchId,
          traceId: traceId ?? null,
          status: "submitting",
          parserState: "uploading",
          batchUploadConfirmed: false,
        });
      },
      onUploadCompleted: async ({ batchId }) => {
        await updateDocument(conversationId, document.id, {
          batchId,
          status: "submitting",
          parserState: "uploaded",
          batchUploadConfirmed: true,
        });
      },
    });
    const upload = submission.uploads?.find((entry) => entry.dataId === document.id)
      ?? submission.uploads?.[0];
    if (submission.state !== "uploaded" || upload?.state !== "uploaded") {
      const failure = upload?.error;
      const error = new MineruCloudError(
        failure?.code ?? "MINERU_UPLOAD_FAILED",
        failure?.message ?? "MinerU 没有接收 PDF",
        {
          category: failure?.category ?? "retryable",
          status: failure?.status ?? 502,
          retryable: failure?.retryable !== false,
        },
      );
      error.batchTerminal = true;
      throw error;
    }
    await updateDocument(conversationId, document.id, {
      batchId: submission.batchId,
      traceId: submission.traceId ?? null,
      status: "parsing",
      parserState: "pending",
      batchTerminal: false,
      batchUploadConfirmed: true,
      pollAttempts: 0,
      error: null,
    });
    await appendEvent(conversationId, "document.parsing_started", {
      documentId: document.id,
      fileName: document.fileName,
    });
    schedule(conversationId, document.id, Math.max(pollIntervalMs, 1));
  }

  async function pollDocument(conversationId, document) {
    if (!parser || !document.batchId) {
      throw projectWorkError(
        "PROJECT_WORK_DOCUMENT_UPLOAD_INTERRUPTED",
        "PDF 提交未完整保存，请重试",
        409,
        true,
      );
    }
    const pollAttempts = Number.isSafeInteger(document.pollAttempts)
      ? document.pollAttempts + 1
      : 1;
    if (pollAttempts > maxPollAttempts) {
      throw new MineruCloudError(
        "MINERU_POLL_TIMEOUT",
        "MinerU 解析等待超时，可以稍后继续",
        { category: "retryable", status: 504, retryable: true },
      );
    }
    await updateDocument(conversationId, document.id, { pollAttempts });
    const batch = await withProcessingSlot(
      () => parser.getBatch(document.batchId),
    );
    if (!batch) return;
    const item = batch.items?.find((entry) => entry.dataId === document.id)
      ?? batch.items?.find((entry) => entry.fileName === document.fileName);
    if (!item) {
      await updateDocument(conversationId, document.id, {
        status: "parsing",
        parserState: "pending",
      });
      schedule(conversationId, document.id, Math.max(pollIntervalMs, 1));
      return;
    }
    if (item.state === "failed") {
      const error = new MineruCloudError(
        "MINERU_DOCUMENT_FAILED",
        compactText(item.error, 500, "MinerU 无法解析这份 PDF"),
        { category: "upstream", status: 502, retryable: true },
      );
      error.batchTerminal = true;
      throw error;
    }
    if (item.state !== "done") {
      await updateDocument(conversationId, document.id, {
        status: "parsing",
        parserState: item.state,
      });
      if (document.parserState !== item.state) {
        await appendEvent(conversationId, "document.parsing_progress", {
          documentId: document.id,
          state: item.state,
        });
      }
      schedule(conversationId, document.id, Math.max(pollIntervalMs, 1));
      return;
    }
    await withProcessingSlot(async () => {
      await updateDocument(conversationId, document.id, {
        status: "preparing",
        parserState: "downloading_result",
      });
      const result = await parser.downloadResult(item.fullZipUrl);
      await updateDocument(conversationId, document.id, {
        status: "indexing",
        parserState: "indexing",
      });
      const persisted = await persistExtraction(conversationId, document, result);
      const readyAt = timestamp();
      const ready = await updateDocument(conversationId, document.id, {
        status: "ready",
        parserState: "done",
        revision: persisted.revision,
        title: compactText(persisted.index.title, 300) || null,
        blockCount: persisted.index.blocks.length,
        imageCount: result.images.length,
        readyAt,
        error: null,
      });
      await appendEvent(conversationId, "document.ready", {
        documentId: document.id,
        fileName: document.fileName,
        revision: ready.revision,
        blockCount: ready.blockCount,
        imageCount: ready.imageCount,
      });
    });
  }

  async function processDocument(conversationId, documentId) {
    if (disposed) return;
    const conversation = await getConversation(conversationId);
    const document = normalizedDocument(conversation, documentId);
    if (document.status === "local_ready") {
      await withProcessingSlot(() => submitDocument(conversationId, document));
      return;
    }
    if (document.status === "submitting") {
      if (!document.batchId || document.batchUploadConfirmed !== true) {
        await updateDocument(conversationId, document.id, {
          status: "local_ready",
          batchId: null,
          traceId: null,
          batchTerminal: false,
          batchUploadConfirmed: false,
          parserState: "queued",
          error: null,
        });
        schedule(conversationId, document.id, 1);
        return;
      }
      await updateDocument(conversationId, document.id, {
        status: "parsing",
        parserState: "pending",
      });
      schedule(conversationId, document.id, Math.max(pollIntervalMs, 1));
      return;
    }
    if (document.status === "preparing" || document.status === "indexing") {
      await updateDocument(conversationId, document.id, {
        status: "parsing",
        parserState: "resuming",
      });
      schedule(conversationId, document.id, 1);
      return;
    }
    if (document.status === "parsing") {
      await pollDocument(conversationId, document);
    }
  }

  async function createDocument(conversationId, {
    fileName,
    byteLength,
  } = {}) {
    const normalizedFileName = safePdfFileName(fileName);
    const normalizedByteLength = pdfByteLength(byteLength);
    const id = `document-${idFactory()}`;
    assertDocumentId(id);
    const createdAt = timestamp();
    const document = {
      schemaVersion: 1,
      id,
      fileName: normalizedFileName,
      byteLength: normalizedByteLength,
      status: "awaiting_upload",
      parserState: null,
      sha256: null,
      batchId: null,
      traceId: null,
      batchTerminal: false,
      batchUploadConfirmed: false,
      pollAttempts: 0,
      revision: null,
      title: null,
      blockCount: null,
      imageCount: null,
      error: null,
      readyAt: null,
      createdAt,
      updatedAt: createdAt,
    };
    await mkdir(documentDirectory(conversationId, id), {
      recursive: true,
      mode: 0o700,
    });
    try {
      await updateConversation(conversationId, (conversation) => {
        const documents = conversation.documents ?? [];
        if (documents.length >= MAX_DOCUMENTS_PER_CONVERSATION) {
          throw projectWorkError(
            "PROJECT_WORK_DOCUMENT_LIMIT_REACHED",
            `每个会话最多保留 ${MAX_DOCUMENTS_PER_CONVERSATION} 份 PDF 资料`,
            409,
          );
        }
        return { documents: [...documents, document] };
      });
      await appendEvent(conversationId, "document.created", {
        documentId: id,
        fileName: normalizedFileName,
        byteLength: normalizedByteLength,
      });
      return publicConversationDocument(document);
    } catch (error) {
      await rm(documentDirectory(conversationId, id), {
        recursive: true,
        force: true,
      }).catch(() => undefined);
      throw error;
    }
  }

  async function uploadContent(conversationId, documentId, stream, {
    contentType,
    declaredLength,
  } = {}) {
    const id = assertDocumentId(documentId);
    const mediaType = String(contentType ?? "").split(";", 1)[0].trim().toLowerCase();
    if (mediaType !== "application/pdf") {
      throw projectWorkError(
        "PROJECT_WORK_DOCUMENT_MEDIA_TYPE_INVALID",
        "PDF 上传必须使用 application/pdf",
        415,
      );
    }
    if (!stream || typeof stream[Symbol.asyncIterator] !== "function") {
      throw projectWorkError(
        "PROJECT_WORK_DOCUMENT_STREAM_INVALID",
        "PDF 上传正文无效",
        400,
      );
    }
    const conversation = await getConversation(conversationId);
    const document = normalizedDocument(conversation, id);
    if (!["awaiting_upload", "upload_interrupted"].includes(document.status)) {
      throw projectWorkError(
        "PROJECT_WORK_DOCUMENT_UPLOAD_STATE_INVALID",
        "这份 PDF 当前不能重复上传",
        409,
      );
    }
    const headerLength = contentLength(declaredLength);
    if (headerLength !== null && headerLength !== document.byteLength) {
      throw projectWorkError(
        "PROJECT_WORK_DOCUMENT_LENGTH_MISMATCH",
        "PDF 实际大小与创建记录不一致",
        400,
      );
    }

    const key = jobKey(conversationId, id);
    if (activeUploads.has(key)) {
      throw projectWorkError(
        "PROJECT_WORK_DOCUMENT_UPLOAD_BUSY",
        "这份 PDF 正在上传",
        409,
        true,
      );
    }
    activeUploads.add(key);
    const directory = documentDirectory(conversationId, id);
    const temporaryPath = path.join(directory, `source.${randomUUID()}.tmp`);
    const targetPath = sourcePath(conversationId, id);
    let handle;
    let total = 0;
    let prefix = Buffer.alloc(0);
    const hash = createHash("sha256");
    try {
      await updateDocument(conversationId, id, {
        status: "receiving",
        error: null,
      });
      handle = await open(temporaryPath, "wx", 0o600);
      for await (const rawChunk of stream) {
        const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
        total += chunk.length;
        if (total > PROJECT_WORK_PDF_MAX_BYTES || total > document.byteLength) {
          throw projectWorkError(
            "PROJECT_WORK_DOCUMENT_TOO_LARGE",
            "PDF 上传超过声明大小或 50 MB 上限",
            413,
          );
        }
        if (prefix.length < 5) {
          prefix = Buffer.concat([prefix, chunk.subarray(0, 5 - prefix.length)]);
        }
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await handle.write(
            chunk,
            offset,
            chunk.length - offset,
          );
          if (!bytesWritten) {
            throw projectWorkError(
              "PROJECT_WORK_DOCUMENT_WRITE_FAILED",
              "PDF 无法安全保存到当前会话",
              500,
              true,
            );
          }
          offset += bytesWritten;
        }
      }
      await handle.close();
      handle = null;
      if (
        total !== document.byteLength
        || (headerLength !== null && total !== headerLength)
      ) {
        throw projectWorkError(
          "PROJECT_WORK_DOCUMENT_LENGTH_MISMATCH",
          "PDF 上传未完整完成",
          400,
        );
      }
      if (prefix.length !== 5 || prefix.toString("ascii") !== "%PDF-") {
        throw projectWorkError(
          "PROJECT_WORK_DOCUMENT_SIGNATURE_INVALID",
          "上传内容不是有效的 PDF 文件",
          415,
        );
      }
      await rename(temporaryPath, targetPath);
      const uploaded = await updateDocument(conversationId, id, {
        status: "local_ready",
        sha256: hash.digest("hex"),
        parserState: "queued",
        error: null,
      });
      await appendEvent(conversationId, "document.uploaded", {
        documentId: id,
        fileName: uploaded.fileName,
        byteLength: uploaded.byteLength,
        sha256: uploaded.sha256,
      });
      schedule(conversationId, id);
      return publicConversationDocument(uploaded);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      await updateDocument(conversationId, id, {
        status: "upload_interrupted",
        error: {
          code: error?.code ?? "PROJECT_WORK_DOCUMENT_UPLOAD_INTERRUPTED",
          message: compactText(error?.message, 500, "PDF 上传未完整完成"),
          retryable: true,
        },
      }).catch(() => undefined);
      throw error;
    } finally {
      activeUploads.delete(key);
    }
  }

  async function retryDocument(conversationId, documentId) {
    const conversation = await getConversation(conversationId);
    const document = normalizedDocument(conversation, documentId);
    if (!RETRYABLE_DOCUMENT_STATUSES.has(document.status)) {
      throw projectWorkError(
        "PROJECT_WORK_DOCUMENT_RETRY_INVALID",
        "这份资料当前不需要重试",
        409,
      );
    }
    if (document.status === "upload_interrupted") {
      throw projectWorkError(
        "PROJECT_WORK_DOCUMENT_REUPLOAD_REQUIRED",
        "PDF 上传不完整，请重新选择原文件上传",
        409,
      );
    }
    const resumeBatch = Boolean(document.batchId)
      && document.batchUploadConfirmed === true
      && document.batchTerminal !== true;
    const updated = await updateDocument(conversationId, document.id, {
      status: resumeBatch ? "parsing" : "local_ready",
      parserState: resumeBatch ? "resuming" : "queued",
      pollAttempts: 0,
      ...(resumeBatch ? {} : {
        batchId: null,
        traceId: null,
        batchTerminal: false,
        batchUploadConfirmed: false,
      }),
      error: null,
    });
    await appendEvent(conversationId, "document.retry_requested", {
      documentId: document.id,
      resumedBatch: resumeBatch,
    });
    schedule(conversationId, document.id);
    return publicConversationDocument(updated);
  }

  async function resumeConversation(conversationId) {
    const conversation = await getConversation(conversationId);
    for (const document of conversation.documents ?? []) {
      const key = jobKey(conversationId, document.id);
      if (document.status === "receiving" && !activeUploads.has(key)) {
        await updateDocument(conversationId, document.id, {
          status: "upload_interrupted",
          error: {
            code: "PROJECT_WORK_DOCUMENT_UPLOAD_INTERRUPTED",
            message: "PDF 上传在完成前中断，请重新选择原文件",
            retryable: true,
          },
        });
        continue;
      }
      if ([
        "local_ready",
        "submitting",
        "parsing",
        "preparing",
        "indexing",
      ].includes(document.status)) {
        schedule(conversationId, document.id);
      }
    }
  }

  async function loadReadyIndex(conversationId, documentId, revision) {
    const conversation = await getConversation(conversationId);
    const document = normalizedDocument(conversation, documentId);
    if (document.status !== "ready" || !document.revision) {
      throw projectWorkError(
        "PROJECT_WORK_DOCUMENT_NOT_READY",
        "这份会话资料尚未完成解析",
        409,
        true,
      );
    }
    if (revision && revision !== document.revision) {
      throw projectWorkError(
        "PROJECT_WORK_DOCUMENT_REVISION_STALE",
        "资料版本已经变化，请重新检索后再读取",
        409,
        true,
      );
    }
    let index;
    try {
      index = JSON.parse(await readFile(
        path.join(extractionDirectory(conversationId, document.id), "index.json"),
        "utf8",
      ));
      if (
        !index
        || typeof index !== "object"
        || !Array.isArray(index.blocks)
        || !Array.isArray(index.sections)
        || index.blocks.some((block) => (
          !block
          || typeof block !== "object"
          || typeof block.block_id !== "string"
          || !BLOCK_ID_PATTERN.test(block.block_id)
          || !Array.isArray(block.path)
          || typeof block.kind !== "string"
          || typeof block.markdown !== "string"
        ))
      ) {
        throw new Error("invalid document index");
      }
    } catch {
      await updateDocument(conversationId, document.id, {
        status: "indexing_failed",
        error: {
          code: "PROJECT_WORK_DOCUMENT_INDEX_UNAVAILABLE",
          message: "资料索引已损坏或缺失，可以重试解析",
          retryable: true,
        },
      }).catch(() => undefined);
      await appendEvent(conversationId, "document.failed", {
        documentId: document.id,
        status: "indexing_failed",
        error: {
          code: "PROJECT_WORK_DOCUMENT_INDEX_UNAVAILABLE",
          message: "资料索引已损坏或缺失，可以重试解析",
          retryable: true,
        },
      }).catch(() => undefined);
      throw projectWorkError(
        "PROJECT_WORK_DOCUMENT_INDEX_UNAVAILABLE",
        "资料索引当前不可用，可以重试解析",
        409,
        true,
      );
    }
    return { document, index };
  }

  async function listForAgent(conversationId) {
    const conversation = await getConversation(conversationId);
    return (conversation.documents ?? []).map((document) => ({
      document_id: document.id,
      file_name: document.fileName,
      status: document.status,
      document_revision: document.revision ?? null,
      title: document.title ?? null,
      block_count: document.blockCount ?? null,
    }));
  }

  async function searchForAgent(conversationId, {
    query,
    documentIds,
    limit = 8,
  } = {}) {
    const normalizedQuery = normalizeSearchText(query);
    if (!normalizedQuery || normalizedQuery.length > MAX_SEARCH_QUERY_CHARS) {
      throw projectWorkError(
        "PROJECT_WORK_DOCUMENT_QUERY_INVALID",
        `资料检索词必须包含 1 到 ${MAX_SEARCH_QUERY_CHARS} 个字符`,
        400,
      );
    }
    const normalizedLimit = Number.isSafeInteger(limit)
      ? Math.min(Math.max(limit, 1), MAX_SEARCH_RESULTS)
      : 8;
    const requestedIds = Array.isArray(documentIds) && documentIds.length > 0
      ? [...new Set(documentIds.map(assertDocumentId))]
      : null;
    const conversation = await getConversation(conversationId);
    const candidates = (conversation.documents ?? []).filter((document) => (
      document.status === "ready"
      && (!requestedIds || requestedIds.includes(document.id))
    ));
    if (requestedIds) {
      for (const id of requestedIds) normalizedDocument(conversation, id);
    }
    const terms = normalizedQuery.split(" ").filter(Boolean);
    const matches = [];
    for (const candidate of candidates) {
      const { document, index } = await loadReadyIndex(
        conversationId,
        candidate.id,
        candidate.revision,
      );
      for (const block of index.blocks ?? []) {
        const searchable = normalizeSearchText([
          ...(block.path ?? []),
          block.text,
          block.markdown,
        ].join("\n"));
        if (!searchable) continue;
        const exact = searchable.includes(normalizedQuery);
        const matchedTerms = terms.filter((term) => searchable.includes(term));
        if (!exact && matchedTerms.length !== terms.length) continue;
        matches.push({
          score: (exact ? 100 : 0) + matchedTerms.length,
          document_id: document.id,
          document_revision: document.revision,
          file_name: document.fileName,
          block_id: block.block_id,
          section_path: safeSectionPath(block.path),
          kind: block.kind,
          excerpt: searchExcerpt(block.text || block.markdown, normalizedQuery),
        });
      }
    }
    return matches
      .sort((left, right) => (
        right.score - left.score
        || left.document_id.localeCompare(right.document_id)
        || left.block_id.localeCompare(right.block_id)
      ))
      .slice(0, normalizedLimit)
      .map(({ score: _score, ...match }) => match);
  }

  async function readForAgent(conversationId, {
    documentId,
    revision,
    blockIds,
  } = {}) {
    const id = assertDocumentId(documentId);
    if (
      typeof revision !== "string"
      || !revision.startsWith("sha256:")
      || !Array.isArray(blockIds)
      || blockIds.length === 0
      || blockIds.length > MAX_READ_BLOCKS
      || blockIds.some((blockId) => (
        typeof blockId !== "string" || !BLOCK_ID_PATTERN.test(blockId)
      ))
    ) {
      throw projectWorkError(
        "PROJECT_WORK_DOCUMENT_READ_INVALID",
        `读取资料时必须提供当前版本和 1 至 ${MAX_READ_BLOCKS} 个有效内容块`,
        400,
      );
    }
    const { document, index } = await loadReadyIndex(conversationId, id, revision);
    const byId = new Map((index.blocks ?? []).map((block) => [block.block_id, block]));
    const uniqueBlockIds = [...new Set(blockIds)];
    const missing = uniqueBlockIds.find((blockId) => !byId.has(blockId));
    if (missing) {
      throw projectWorkError(
        "PROJECT_WORK_DOCUMENT_BLOCK_NOT_FOUND",
        "所选资料内容块不存在，请重新检索",
        404,
      );
    }
    let remaining = MAX_READ_CHARS;
    const blocks = [];
    for (const blockId of uniqueBlockIds) {
      const block = byId.get(blockId);
      const rawContent = String(block.markdown || block.text || "").trim();
      const content = rawContent.slice(0, remaining);
      if (!content) continue;
      blocks.push({
        block_id: block.block_id,
        section_path: safeSectionPath(block.path),
        kind: block.kind,
        content,
        truncated: content.length < rawContent.length,
      });
      remaining -= content.length;
      if (remaining <= 0) break;
    }
    return boundReadResult({
      document_id: document.id,
      document_revision: document.revision,
      file_name: document.fileName,
      title: document.title ?? null,
      blocks,
      truncated: blocks.length < uniqueBlockIds.length || remaining <= 0,
      trust: "untrusted_reference",
    });
  }

  async function removeDocument(conversationId, documentId) {
    const id = assertDocumentId(documentId);
    const key = jobKey(conversationId, id);
    if (activeUploads.has(key) || jobs.has(key) || timers.has(key)) {
      throw projectWorkError(
        "PROJECT_WORK_DOCUMENT_REMOVE_BUSY",
        "这份资料仍在处理，暂时不能移除",
        409,
        true,
      );
    }
    const conversation = await getConversation(conversationId);
    const originalDocument = structuredClone(
      normalizedDocument(conversation, id),
    );
    const originalIndex = (conversation.documents ?? []).findIndex(
      (document) => document.id === id,
    );
    const removing = await updateDocument(conversationId, id, (current) => {
      if (ACTIVE_DOCUMENT_STATUSES.has(current.status)) {
        throw projectWorkError(
          "PROJECT_WORK_DOCUMENT_REMOVE_BUSY",
          "这份资料仍在处理，暂时不能移除",
          409,
          true,
        );
      }
      return { status: "removing" };
    });
    const directory = documentDirectory(conversationId, id);
    const tombstone = path.join(
      path.dirname(directory),
      `.${id}.${randomUUID()}.removing`,
    );
    let directoryMoved = false;
    try {
      await rename(directory, tombstone);
      directoryMoved = true;
      await updateConversation(conversationId, (conversation) => ({
        documents: (conversation.documents ?? []).filter(
          (document) => document.id !== id,
        ),
      }));
      try {
        await rm(tombstone, { recursive: true, force: true });
        directoryMoved = false;
      } catch (error) {
        await rename(tombstone, directory);
        directoryMoved = false;
        await updateConversation(conversationId, (current) => {
          const documents = [...(current.documents ?? [])];
          if (!documents.some((document) => document.id === id)) {
            documents.splice(
              Math.min(Math.max(originalIndex, 0), documents.length),
              0,
              originalDocument,
            );
          }
          return { documents };
        });
        throw error;
      }
      await appendEvent(conversationId, "document.removed", {
        documentId: id,
        fileName: removing.fileName,
        localAssetsRemoved: true,
        remoteDeletionClaimed: false,
      }).catch(() => undefined);
      return {
        id,
        removed: true,
        localAssetsRemoved: true,
        remoteDeletionClaimed: false,
      };
    } catch (error) {
      if (directoryMoved) {
        await rename(tombstone, directory).catch(() => undefined);
      }
      const current = await getConversation(conversationId).catch(() => null);
      if ((current?.documents ?? []).some((document) => document.id === id)) {
        await updateDocument(conversationId, id, {
          status: originalDocument.status,
          error: originalDocument.error ?? null,
        }).catch(() => undefined);
      }
      throw error;
    }
  }

  async function dispose() {
    disposed = true;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    while (processingWaiters.length > 0) {
      processingWaiters.shift()?.(false);
    }
    await Promise.allSettled([...jobs.values()]);
  }

  return Object.freeze({
    createDocument,
    dispose,
    listForAgent,
    publicDocument: publicConversationDocument,
    readForAgent,
    removeDocument,
    resumeConversation,
    retryDocument,
    searchForAgent,
    uploadContent,
  });
}
