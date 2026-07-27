import { open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { unzipSync } from "fflate";

export const MINERU_API_BASE_URL = "https://mineru.net/api/v4";

const MAX_BATCH_FILES = 5;
const MAX_PDF_BYTES = 200 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 512;
const MAX_ARCHIVE_ENTRY_BYTES = 40 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 160 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30 * 1000;
const DEFAULT_UPLOAD_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 2 * 60 * 1000;
const DATA_ID_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;
const BATCH_ID_PATTERN = /^[A-Za-z0-9_.-]{1,200}$/;
const RESULT_STATES = new Set([
  "waiting-file",
  "pending",
  "running",
  "converting",
  "done",
  "failed",
]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const IMAGE_MIME_TYPES = Object.freeze({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
});
const TOKEN_CODES = new Set(["A0202", "A0211"]);
const QUOTA_CODES = new Set(["-60018", "-60019"]);
const RETRYABLE_CODES = new Set([
  "-10001",
  "-60001",
  "-60007",
  "-60008",
  "-60009",
  "-60010",
  "-60020",
  "-60021",
  "-60022",
]);

export class MineruCloudError extends Error {
  constructor(code, message, {
    category = "upstream",
    status = 502,
    retryable = false,
    upstreamCode = null,
    traceId = null,
  } = {}) {
    super(message);
    this.name = "MineruCloudError";
    this.code = code;
    this.category = category;
    this.status = status;
    this.retryable = retryable;
    this.upstreamCode = upstreamCode;
    this.traceId = traceId;
  }
}

function invalidRequest(message) {
  return new MineruCloudError("INVALID_REQUEST", message, {
    category: "request",
    status: 400,
  });
}

function requiredString(value, field, maxLength) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidRequest(`${field} 必须是非空字符串`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw invalidRequest(`${field} 不能超过 ${maxLength} 个字符`);
  }
  return normalized;
}

function positiveTimeout(value, fallback, field) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > 30 * 60 * 1000) {
    throw invalidRequest(`${field} 必须是有效的正整数毫秒值`);
  }
  return resolved;
}

function timedSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}

function safeFileName(value, field) {
  const name = requiredString(value, field, 255);
  if (
    name === "."
    || name === ".."
    || name.includes("/")
    || name.includes("\\")
    || name.includes("\0")
    || path.basename(name) !== name
  ) {
    throw invalidRequest(`${field} 必须是安全的文件名`);
  }
  return name;
}

function httpsUrl(value, field) {
  const raw = requiredString(value, field, 4096);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw invalidRequest(`${field} 必须是有效的 HTTPS URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw invalidRequest(`${field} 必须是无凭据的 HTTPS URL`);
  }
  return parsed.toString();
}

function responseTraceId(body) {
  return typeof body?.trace_id === "string" && body.trace_id.trim()
    ? body.trace_id.trim()
    : null;
}

function classifyUpstreamError({ status = 502, upstreamCode = null, message = "", traceId = null }) {
  const normalizedCode = upstreamCode === null || upstreamCode === undefined
    ? null
    : String(upstreamCode);
  if (status === 401 || status === 403 || TOKEN_CODES.has(normalizedCode)) {
    return new MineruCloudError("MINERU_TOKEN_INVALID", "MinerU API Token 无效或已过期", {
      category: "token",
      status: 503,
      upstreamCode: normalizedCode,
      traceId,
    });
  }
  if (QUOTA_CODES.has(normalizedCode)) {
    return new MineruCloudError("MINERU_QUOTA_EXHAUSTED", "MinerU 今日解析额度已用尽", {
      category: "quota",
      status: 429,
      upstreamCode: normalizedCode,
      traceId,
    });
  }
  const retryable = status === 408
    || status === 425
    || status === 429
    || status >= 500
    || RETRYABLE_CODES.has(normalizedCode);
  if (retryable) {
    return new MineruCloudError("MINERU_UPSTREAM_RETRYABLE", "MinerU 服务暂时不可用", {
      category: "retryable",
      status: 502,
      retryable: true,
      upstreamCode: normalizedCode,
      traceId,
    });
  }
  return new MineruCloudError("MINERU_UPSTREAM_REJECTED", message || "MinerU 拒绝了请求", {
    category: "upstream",
    status: 502,
    upstreamCode: normalizedCode,
    traceId,
  });
}

function invalidResponse(message, traceId = null) {
  return new MineruCloudError("MINERU_RESPONSE_INVALID", message, {
    category: "invalid_response",
    status: 502,
    retryable: true,
    traceId,
  });
}

function responseString(value, field, maxLength, traceId = null) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidResponse(`${field} 必须是非空字符串`, traceId);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw invalidResponse(`${field} 长度无效`, traceId);
  }
  return normalized;
}

function responseFileName(value, field, traceId = null) {
  const name = responseString(value, field, 255, traceId);
  if (
    name === "."
    || name === ".."
    || name.includes("/")
    || name.includes("\\")
    || name.includes("\0")
    || path.basename(name) !== name
  ) {
    throw invalidResponse(`${field} 不是安全文件名`, traceId);
  }
  return name;
}

function responseHttpsUrl(value, field, traceId = null) {
  const raw = responseString(value, field, 4096, traceId);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw invalidResponse(`${field} 不是有效 URL`, traceId);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw invalidResponse(`${field} 必须是无凭据的 HTTPS URL`, traceId);
  }
  return parsed.toString();
}

function publicFailure(error) {
  const normalized = error instanceof MineruCloudError
    ? error
    : new MineruCloudError("MINERU_UPLOAD_FAILED", "上传 PDF 时发生未知错误", {
      category: "retryable",
      retryable: true,
    });
  return {
    code: normalized.code,
    category: normalized.category,
    retryable: normalized.retryable,
    status: normalized.status,
    upstream_code: normalized.upstreamCode,
    trace_id: normalized.traceId,
    message: normalized.message,
  };
}

async function validatePdf(file, index) {
  if (!file || typeof file !== "object" || Array.isArray(file)) {
    throw invalidRequest(`files[${index}] 必须是对象`);
  }
  const allowedFields = new Set(["filePath", "fileName", "dataId"]);
  const unknownField = Object.keys(file).find((field) => !allowedFields.has(field));
  if (unknownField) {
    throw invalidRequest(`files[${index}] 不支持字段 ${unknownField}`);
  }
  const filePath = requiredString(file.filePath, `files[${index}].filePath`, 4096);
  if (!path.isAbsolute(filePath)) {
    throw invalidRequest(`files[${index}].filePath 必须是绝对路径`);
  }
  const fileName = safeFileName(
    file.fileName || path.basename(filePath),
    `files[${index}].fileName`,
  );
  if (path.extname(fileName).toLowerCase() !== ".pdf") {
    throw invalidRequest(`files[${index}].fileName 必须以 .pdf 结尾`);
  }
  const dataId = requiredString(file.dataId, `files[${index}].dataId`, 128);
  if (!DATA_ID_PATTERN.test(dataId)) {
    throw invalidRequest(`files[${index}].dataId 格式无效`);
  }

  let fileStat;
  let handle;
  try {
    fileStat = await stat(filePath);
    if (!fileStat.isFile() || fileStat.size < 5 || fileStat.size > MAX_PDF_BYTES) {
      throw invalidRequest(`files[${index}] 不是有效大小的 PDF 文件`);
    }
    handle = await open(filePath, "r");
    const signature = Buffer.alloc(5);
    const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
    if (bytesRead !== 5 || signature.toString("ascii") !== "%PDF-") {
      throw invalidRequest(`files[${index}] 缺少 PDF 文件头`);
    }
  } catch (error) {
    if (error instanceof MineruCloudError) throw error;
    throw invalidRequest(`无法读取 files[${index}].filePath`);
  } finally {
    await handle?.close();
  }
  return { filePath, fileName, dataId, size: fileStat.size };
}

async function validateBatchFiles(files) {
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_BATCH_FILES) {
    throw invalidRequest(`每个 MinerU 批次必须包含 1 至 ${MAX_BATCH_FILES} 个 PDF`);
  }
  const validated = [];
  const names = new Set();
  const dataIds = new Set();
  for (let index = 0; index < files.length; index += 1) {
    const file = await validatePdf(files[index], index);
    if (names.has(file.fileName)) {
      throw invalidRequest(`PDF 文件名重复：${file.fileName}`);
    }
    if (dataIds.has(file.dataId)) {
      throw invalidRequest(`PDF dataId 重复：${file.dataId}`);
    }
    names.add(file.fileName);
    dataIds.add(file.dataId);
    validated.push(file);
  }
  return validated;
}

function validateBatchId(value) {
  const batchId = requiredString(value, "batchId", 200);
  if (!BATCH_ID_PATTERN.test(batchId)) {
    throw invalidRequest("batchId 格式无效");
  }
  return batchId;
}

function validateArchivePath(name) {
  if (typeof name !== "string" || !name || name.includes("\0")) {
    throw new MineruCloudError("MINERU_ARCHIVE_UNSAFE", "MinerU ZIP 包含无效路径", {
      category: "archive",
      status: 502,
    });
  }
  const normalized = name.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    normalized.startsWith("/")
    || /^[A-Za-z]:/.test(normalized)
    || segments.some((segment, index) => (
      segment === ".."
      || segment === "."
      || (segment === "" && index !== segments.length - 1)
    ))
  ) {
    throw new MineruCloudError("MINERU_ARCHIVE_UNSAFE", "MinerU ZIP 包含路径穿越条目", {
      category: "archive",
      status: 502,
    });
  }
  return normalized;
}

function validateProgress(value, field) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalidResponse(`${field} 必须是非负整数`);
  }
  return value;
}

function normalizeResultItem(item, index, traceId) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw invalidResponse(`extract_result[${index}] 必须是对象`, traceId);
  }
  const fileName = responseFileName(item.file_name, `extract_result[${index}].file_name`, traceId);
  const state = responseString(item.state, `extract_result[${index}].state`, 50, traceId);
  if (!RESULT_STATES.has(state)) {
    throw invalidResponse(`extract_result[${index}].state 无效`, traceId);
  }
  const dataId = item.data_id === undefined || item.data_id === null || item.data_id === ""
    ? null
    : responseString(item.data_id, `extract_result[${index}].data_id`, 128, traceId);
  if (dataId !== null && !DATA_ID_PATTERN.test(dataId)) {
    throw invalidResponse(`extract_result[${index}].data_id 格式无效`, traceId);
  }
  const fullZipUrl = item.full_zip_url === undefined || item.full_zip_url === null || item.full_zip_url === ""
    ? null
    : responseHttpsUrl(item.full_zip_url, `extract_result[${index}].full_zip_url`, traceId);
  if (state === "done" && !fullZipUrl) {
    throw invalidResponse(`extract_result[${index}] 已完成但缺少 ZIP URL`, traceId);
  }
  const progress = item.extract_progress && typeof item.extract_progress === "object"
    ? {
        extracted_pages: validateProgress(
          item.extract_progress.extracted_pages,
          `extract_result[${index}].extract_progress.extracted_pages`,
        ),
        total_pages: validateProgress(
          item.extract_progress.total_pages,
          `extract_result[${index}].extract_progress.total_pages`,
        ),
        start_time: typeof item.extract_progress.start_time === "string"
          ? item.extract_progress.start_time.trim()
          : null,
      }
    : null;
  return {
    fileName,
    dataId,
    state,
    error: typeof item.err_msg === "string" && item.err_msg.trim() ? item.err_msg.trim() : null,
    fullZipUrl,
    progress,
  };
}

function summarizeBatchState(items) {
  const done = items.filter((item) => item.state === "done").length;
  const failed = items.filter((item) => item.state === "failed").length;
  if (items.length > 0 && done === items.length) return "done";
  if (items.length > 0 && failed === items.length) return "failed";
  if (done > 0 || failed > 0) return "partial";
  return "running";
}

export function createMineruCloudAdapter({
  apiToken,
  fetchImpl = globalThis.fetch,
  baseUrl = MINERU_API_BASE_URL,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  uploadTimeoutMs = DEFAULT_UPLOAD_TIMEOUT_MS,
  downloadTimeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS,
} = {}) {
  const token = requiredString(apiToken, "apiToken", 4096);
  if (typeof fetchImpl !== "function") {
    throw invalidRequest("fetchImpl 必须是函数");
  }
  const normalizedBaseUrl = httpsUrl(baseUrl, "baseUrl").replace(/\/+$/, "");
  const apiTimeoutMs = positiveTimeout(requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, "requestTimeoutMs");
  const pdfUploadTimeoutMs = positiveTimeout(uploadTimeoutMs, DEFAULT_UPLOAD_TIMEOUT_MS, "uploadTimeoutMs");
  const resultDownloadTimeoutMs = positiveTimeout(
    downloadTimeoutMs,
    DEFAULT_DOWNLOAD_TIMEOUT_MS,
    "downloadTimeoutMs",
  );

  async function requestApi(endpoint, init) {
    const timeout = timedSignal(apiTimeoutMs);
    try {
      const response = await fetchImpl(`${normalizedBaseUrl}${endpoint}`, {
        ...init,
        signal: timeout.signal,
      });
      if (!response || typeof response.status !== "number" || typeof response.ok !== "boolean") {
        throw invalidResponse("MinerU 返回了无效的 HTTP 响应");
      }
      if (!response.ok) {
        throw classifyUpstreamError({ status: response.status });
      }
      let body;
      try {
        body = await response.json();
      } catch {
        throw invalidResponse("MinerU 返回了无效 JSON");
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw invalidResponse("MinerU JSON 响应必须是对象");
      }
      if (
        body.code !== 0
        && typeof body.code !== "number"
        && typeof body.code !== "string"
      ) {
        throw invalidResponse("MinerU 响应缺少有效 code", responseTraceId(body));
      }
      if (body.code !== 0) {
        throw classifyUpstreamError({
          status: response.status,
          upstreamCode: body.code,
          message: typeof body.msg === "string" ? body.msg : "",
          traceId: responseTraceId(body),
        });
      }
      if (!body.data || typeof body.data !== "object" || Array.isArray(body.data)) {
        throw invalidResponse("MinerU 响应缺少 data", responseTraceId(body));
      }
      return body;
    } catch (error) {
      if (error instanceof MineruCloudError) throw error;
      throw classifyUpstreamError({ status: 503 });
    } finally {
      timeout.clear();
    }
  }

  async function submitBatch(files, {
    onBatchAllocated,
    onUploadCompleted,
  } = {}) {
    if (onBatchAllocated !== undefined && typeof onBatchAllocated !== "function") {
      throw invalidRequest("onBatchAllocated 必须是函数");
    }
    if (onUploadCompleted !== undefined && typeof onUploadCompleted !== "function") {
      throw invalidRequest("onUploadCompleted 必须是函数");
    }
    const validatedFiles = await validateBatchFiles(files);
    const body = await requestApi("/file-urls/batch", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        files: validatedFiles.map((file) => ({
          name: file.fileName,
          data_id: file.dataId,
        })),
        model_version: "vlm",
      }),
    });
    const traceId = responseTraceId(body);
    const batchId = responseString(body.data.batch_id, "data.batch_id", 200, traceId);
    if (!BATCH_ID_PATTERN.test(batchId)) {
      throw invalidResponse("MinerU data.batch_id 格式无效", traceId);
    }
    if (
      !Array.isArray(body.data.file_urls)
      || body.data.file_urls.length !== validatedFiles.length
    ) {
      throw invalidResponse("MinerU 上传 URL 数量与 PDF 数量不一致", responseTraceId(body));
    }
    const uploadUrls = body.data.file_urls.map((url, index) => (
      responseHttpsUrl(url, `data.file_urls[${index}]`, traceId)
    ));
    if (new Set(uploadUrls).size !== uploadUrls.length) {
      throw invalidResponse("MinerU 返回了重复的上传 URL", traceId);
    }
    await onBatchAllocated?.({
      batchId,
      traceId,
      files: validatedFiles.map((file) => ({
        fileName: file.fileName,
        dataId: file.dataId,
        size: file.size,
      })),
    });

    const uploads = await Promise.all(validatedFiles.map(async (file, index) => {
      try {
        const pdf = await readFile(file.filePath);
        if (pdf.length !== file.size || pdf.subarray(0, 5).toString("ascii") !== "%PDF-") {
          throw invalidRequest(`PDF 在提交后发生变化：${file.fileName}`);
        }
        let response;
        const timeout = timedSignal(pdfUploadTimeoutMs);
        try {
          response = await fetchImpl(uploadUrls[index], {
            method: "PUT",
            body: pdf,
            signal: timeout.signal,
          });
        } catch {
          throw classifyUpstreamError({ status: 503 });
        } finally {
          timeout.clear();
        }
        if (!response || typeof response.status !== "number" || typeof response.ok !== "boolean") {
          throw invalidResponse("MinerU 上传返回了无效 HTTP 响应");
        }
        if (!response.ok) {
          throw classifyUpstreamError({ status: response.status });
        }
        await onUploadCompleted?.({
          batchId,
          traceId,
          fileName: file.fileName,
          dataId: file.dataId,
          size: file.size,
        });
        return {
          fileName: file.fileName,
          dataId: file.dataId,
          state: "uploaded",
          error: null,
        };
      } catch (error) {
        return {
          fileName: file.fileName,
          dataId: file.dataId,
          state: "failed",
          error: publicFailure(error),
        };
      }
    }));

    const uploadedCount = uploads.filter((upload) => upload.state === "uploaded").length;
    return {
      batchId,
      state: uploadedCount === uploads.length
        ? "uploaded"
        : uploadedCount === 0 ? "failed" : "partial",
      uploads,
      traceId,
    };
  }

  async function getBatch(batchIdValue) {
    const batchId = validateBatchId(batchIdValue);
    const body = await requestApi(`/extract-results/batch/${encodeURIComponent(batchId)}`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
      },
    });
    if (body.data.batch_id !== batchId) {
      throw invalidResponse("MinerU 返回了不匹配的 batch_id", responseTraceId(body));
    }
    if (!Array.isArray(body.data.extract_result) || body.data.extract_result.length > MAX_BATCH_FILES) {
      throw invalidResponse("MinerU extract_result 数量无效", responseTraceId(body));
    }
    const traceId = responseTraceId(body);
    const items = body.data.extract_result.map((item, index) => (
      normalizeResultItem(item, index, traceId)
    ));
    const keys = new Set();
    for (const item of items) {
      const key = item.dataId || item.fileName;
      if (keys.has(key)) {
        throw invalidResponse("MinerU 返回了重复的解析结果", responseTraceId(body));
      }
      keys.add(key);
    }
    return {
      batchId,
      state: summarizeBatchState(items),
      items,
      traceId,
    };
  }

  async function downloadResult(fullZipUrlValue) {
    const fullZipUrl = httpsUrl(fullZipUrlValue, "fullZipUrl");
    const timeout = timedSignal(resultDownloadTimeoutMs);
    let response;
    let archive;
    try {
      response = await fetchImpl(fullZipUrl, {
        method: "GET",
        signal: timeout.signal,
      });
      if (!response || typeof response.status !== "number" || typeof response.ok !== "boolean") {
        throw invalidResponse("MinerU ZIP 下载返回了无效 HTTP 响应");
      }
      if (!response.ok) {
        throw classifyUpstreamError({ status: response.status });
      }
      const contentLength = Number(response.headers?.get?.("content-length"));
      if (Number.isFinite(contentLength) && contentLength > MAX_ARCHIVE_BYTES) {
        throw new MineruCloudError("MINERU_ARCHIVE_TOO_LARGE", "MinerU ZIP 超过大小限制", {
          category: "archive",
          status: 502,
        });
      }
      archive = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      if (error instanceof MineruCloudError) throw error;
      throw classifyUpstreamError({ status: 503 });
    } finally {
      timeout.clear();
    }
    if (
      archive.byteLength === 0
      || archive.byteLength > MAX_ARCHIVE_BYTES
      || archive[0] !== 0x50
      || archive[1] !== 0x4b
    ) {
      throw new MineruCloudError("MINERU_ARCHIVE_INVALID", "MinerU 返回的不是有效 ZIP", {
        category: "archive",
        status: 502,
      });
    }

    let entryCount = 0;
    let uncompressedBytes = 0;
    let unpacked;
    try {
      unpacked = unzipSync(archive, {
        filter(entry) {
          entryCount += 1;
          if (entryCount > MAX_ARCHIVE_ENTRIES) {
            throw new MineruCloudError("MINERU_ARCHIVE_UNSAFE", "MinerU ZIP 条目过多", {
              category: "archive",
              status: 502,
            });
          }
          const normalizedName = validateArchivePath(entry.name);
          if (
            !Number.isSafeInteger(entry.originalSize)
            || entry.originalSize < 0
            || entry.originalSize > MAX_ARCHIVE_ENTRY_BYTES
          ) {
            throw new MineruCloudError("MINERU_ARCHIVE_UNSAFE", "MinerU ZIP 条目大小无效", {
              category: "archive",
              status: 502,
            });
          }
          uncompressedBytes += entry.originalSize;
          if (uncompressedBytes > MAX_UNCOMPRESSED_BYTES) {
            throw new MineruCloudError("MINERU_ARCHIVE_UNSAFE", "MinerU ZIP 解压后过大", {
              category: "archive",
              status: 502,
            });
          }
          if (normalizedName.endsWith("/")) return false;
          const extension = path.extname(normalizedName).toLowerCase();
          return extension === ".md" || IMAGE_EXTENSIONS.has(extension);
        },
      });
    } catch (error) {
      if (error instanceof MineruCloudError) throw error;
      throw new MineruCloudError("MINERU_ARCHIVE_INVALID", "MinerU ZIP 无法安全解压", {
        category: "archive",
        status: 502,
      });
    }

    const markdownEntries = Object.entries(unpacked)
      .filter(([name]) => path.extname(name).toLowerCase() === ".md");
    const preferredMarkdown = markdownEntries.filter(([name]) => (
      path.basename(name).toLowerCase() === "full.md"
    ));
    const selected = preferredMarkdown.length === 1
      ? preferredMarkdown[0]
      : preferredMarkdown.length === 0 && markdownEntries.length === 1
        ? markdownEntries[0]
        : null;
    if (!selected) {
      throw new MineruCloudError("MINERU_MARKDOWN_INVALID", "MinerU ZIP 缺少唯一的主 Markdown", {
        category: "archive",
        status: 502,
      });
    }
    let markdown;
    try {
      markdown = new TextDecoder("utf-8", { fatal: true }).decode(selected[1]).trim();
    } catch {
      throw new MineruCloudError("MINERU_MARKDOWN_INVALID", "MinerU Markdown 不是有效 UTF-8", {
        category: "archive",
        status: 502,
      });
    }
    if (!markdown) {
      throw new MineruCloudError("MINERU_MARKDOWN_EMPTY", "MinerU Markdown 为空", {
        category: "archive",
        status: 502,
      });
    }

    const images = [];
    const imageNames = new Set();
    for (const [entryName, bytes] of Object.entries(unpacked)) {
      const extension = path.extname(entryName).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(extension)) continue;
      const name = safeFileName(path.basename(entryName), "ZIP 图片文件名");
      if (imageNames.has(name)) {
        throw new MineruCloudError("MINERU_ARCHIVE_UNSAFE", "MinerU ZIP 包含重名图片", {
          category: "archive",
          status: 502,
        });
      }
      imageNames.add(name);
      images.push({
        name,
        mimeType: IMAGE_MIME_TYPES[extension],
        bytes,
      });
    }
    return {
      markdown,
      markdownFileName: path.basename(selected[0]),
      images,
    };
  }

  return Object.freeze({ submitBatch, getBatch, downloadResult });
}
