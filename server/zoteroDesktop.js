import { createHash, randomUUID } from "node:crypto";

const DEFAULT_BASE_URL = "http://127.0.0.1:23119";
const API_VERSION = "3";
const MAX_PDF_BYTES = 200 * 1024 * 1024;
const OPERATION_PREFIX = "Pi-Agent-Operation-ID: ";
const TARGET_ID_PATTERN = /^[LC][1-9]\d*$/;
const CONNECTOR_ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;
const ITEM_KEY_PATTERN = /^[A-Z0-9]{8}$/;
const PERSONAL_LIBRARY_ID = 1;
const writeLocks = new Map();

export class ZoteroDesktopError extends Error {
  constructor(code, message, {
    status = 500,
    retryable = false,
  } = {}) {
    super(message);
    this.name = "ZoteroDesktopError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function invalidRequest(message) {
  return new ZoteroDesktopError("ZOTERO_INVALID_REQUEST", message, {
    status: 400,
  });
}

function requiredString(value, field, maxLength = 4096) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidRequest(`${field} 必须是非空字符串`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength || normalized.includes("\0")) {
    throw invalidRequest(`${field} 格式无效`);
  }
  return normalized;
}

function optionalString(value, field, maxLength = 4096) {
  if (value === undefined || value === null || value === "") return null;
  return requiredString(value, field, maxLength);
}

function normalizeDoi(value) {
  const raw = optionalString(value, "doi", 512);
  if (!raw) return null;
  return raw
    .replace(/^doi:\s*/i, "")
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .trim()
    .toLowerCase();
}

function normalizeTitle(value) {
  const raw = optionalString(value, "title", 2048);
  return raw
    ? raw.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US")
    : null;
}

function operationMarker(operationId) {
  const id = requiredString(operationId, "operationId", 160);
  if (/[\r\n]/.test(id)) throw invalidRequest("operationId 格式无效");
  return `${OPERATION_PREFIX}${id}`;
}

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw invalidRequest("baseUrl 必须是本机 Zotero 地址");
  }
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
  if (
    url.protocol !== "http:"
    || !loopbackHosts.has(url.hostname.toLowerCase())
    || url.username
    || url.password
    || (url.pathname !== "/" && url.pathname !== "")
    || url.search
    || url.hash
  ) {
    throw invalidRequest("baseUrl 必须是本机 Zotero 地址");
  }
  return url.toString().replace(/\/$/, "");
}

function normalizeConnectorId(value, field) {
  const id = requiredString(value, field, 160);
  if (!CONNECTOR_ID_PATTERN.test(id)) throw invalidRequest(`${field} 格式无效`);
  return id;
}

function normalizeTargetId(value) {
  const targetId = requiredString(value, "targetId", 32);
  if (!TARGET_ID_PATTERN.test(targetId)) throw invalidRequest("targetId 格式无效");
  return targetId;
}

function normalizeTags(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) {
    throw invalidRequest("item.tags 必须是标签数组");
  }
  const result = [];
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const raw = typeof value[index] === "string" ? value[index] : value[index]?.tag;
    const tag = requiredString(raw, `item.tags[${index}]`, 255);
    if (!seen.has(tag)) {
      seen.add(tag);
      result.push(tag);
    }
  }
  return result;
}

function normalizeSourceUri(value) {
  if (!value) return "https://example.invalid/pi-agent";
  let url;
  try {
    url = new URL(value);
  } catch {
    throw invalidRequest("item.url 必须是有效的 HTTP 或 HTTPS URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol)
    || url.username
    || url.password
  ) {
    throw invalidRequest("item.url 必须是有效的 HTTP 或 HTTPS URL");
  }
  return url.toString();
}

function normalizeItem(item, marker, connectorItemId) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw invalidRequest("item 必须是对象");
  }
  const itemType = requiredString(item.itemType, "item.itemType", 64);
  const title = requiredString(item.title, "item.title", 2048);
  if (Object.hasOwn(item, "id")) {
    throw invalidRequest("item.id 由 Zotero 适配器生成");
  }
  if (Object.hasOwn(item, "attachments") || Object.hasOwn(item, "notes")) {
    throw invalidRequest("附件和笔记必须通过独立确认字段提交");
  }
  const extra = item.extra === undefined || item.extra === null ? "" : item.extra;
  if (
    typeof extra !== "string"
    || extra.length > 100_000
    || extra.includes("\0")
  ) {
    throw invalidRequest("item.extra 格式无效");
  }
  const markerLines = extra
    .split(/\r?\n/)
    .filter((line) => line.startsWith(OPERATION_PREFIX));
  if (markerLines.length !== 1 || markerLines[0] !== marker) {
    throw invalidRequest("item.extra 必须包含且仅包含准确的 operation marker");
  }
  const tags = normalizeTags(item.tags);
  return {
    connectorItem: {
      ...item,
      id: connectorItemId,
      itemType,
      title,
      tags: [],
      extra,
    },
    tags,
    sourceUri: normalizeSourceUri(item.url),
  };
}

function normalizePdf(pdf) {
  if (pdf === undefined || pdf === null) return null;
  if (!pdf || typeof pdf !== "object" || Array.isArray(pdf)) {
    throw invalidRequest("pdf 必须是对象");
  }
  if (!Buffer.isBuffer(pdf.bytes)) {
    throw invalidRequest("pdf.bytes 必须是 Buffer");
  }
  if (
    pdf.bytes.length < 5
    || pdf.bytes.length > MAX_PDF_BYTES
    || pdf.bytes.subarray(0, 5).toString("ascii") !== "%PDF-"
  ) {
    throw invalidRequest("pdf.bytes 不是有效大小的 PDF");
  }
  const fileName = requiredString(pdf.fileName, "pdf.fileName", 255);
  if (
    fileName === "."
    || fileName === ".."
    || fileName.includes("/")
    || fileName.includes("\\")
    || fileName.includes("\0")
    || !fileName.toLowerCase().endsWith(".pdf")
  ) {
    throw invalidRequest("pdf.fileName 必须是安全的 PDF 文件名");
  }
  const url = normalizeSourceUri(pdf.url);
  const sha256 = requiredString(pdf.sha256, "pdf.sha256", 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw invalidRequest("pdf.sha256 格式无效");
  }
  const actualHash = createHash("sha256").update(pdf.bytes).digest("hex");
  if (actualHash !== sha256) {
    throw invalidRequest("pdf.sha256 与 PDF 内容不一致");
  }
  return {
    bytes: pdf.bytes,
    fileName,
    url,
  };
}

function publicItem(item) {
  return {
    key: item.key,
    itemType: item.itemType,
    title: item.title,
    doi: item.doi,
  };
}

function parseApiItem(entry) {
  const data = entry?.data;
  const key = typeof entry?.key === "string" ? entry.key : data?.key;
  if (
    !data
    || typeof data !== "object"
    || typeof key !== "string"
    || !ITEM_KEY_PATTERN.test(key)
    || typeof data.itemType !== "string"
    || typeof data.title !== "string"
  ) {
    throw new ZoteroDesktopError(
      "ZOTERO_RESPONSE_INVALID",
      "Zotero 返回了无法识别的条目数据",
      { status: 502, retryable: true },
    );
  }
  return {
    key,
    itemType: data.itemType,
    title: data.title,
    doi: normalizeDoi(data.DOI),
    normalizedTitle: normalizeTitle(data.title),
    extra: typeof data.extra === "string" ? data.extra : "",
  };
}

function parseChild(entry) {
  const data = entry?.data;
  const key = typeof entry?.key === "string" ? entry.key : data?.key;
  if (
    !data
    || typeof data !== "object"
    || typeof key !== "string"
    || !ITEM_KEY_PATTERN.test(key)
    || typeof data.itemType !== "string"
  ) {
    throw new ZoteroDesktopError(
      "ZOTERO_RESPONSE_INVALID",
      "Zotero 返回了无法识别的子条目数据",
      { status: 502, retryable: true },
    );
  }
  return {
    key,
    itemType: data.itemType,
    contentType: typeof data.contentType === "string" ? data.contentType : null,
    title: typeof data.title === "string" ? data.title : null,
    filename: typeof data.filename === "string" ? data.filename : null,
    url: typeof data.url === "string" ? data.url : null,
    note: typeof data.note === "string" ? data.note : null,
  };
}

async function withWriteLock(baseUrl, task) {
  const previous = writeLocks.get(baseUrl) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  writeLocks.set(baseUrl, current);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (writeLocks.get(baseUrl) === current) writeLocks.delete(baseUrl);
  }
}

function httpError(status, purpose) {
  if (purpose === "api" && status === 403) {
    return new ZoteroDesktopError(
      "ZOTERO_LOCAL_API_DISABLED",
      "Zotero 本地 API 尚未启用",
      { status: 503 },
    );
  }
  if (purpose === "attachment" && status === 200) {
    return new ZoteroDesktopError(
      "ZOTERO_FILES_NOT_EDITABLE",
      "目标 Zotero 资料库不允许写入附件",
      { status: 409 },
    );
  }
  const retryable = status === 408 || status === 425 || status === 429 || status >= 500;
  return new ZoteroDesktopError(
    retryable ? "ZOTERO_TEMPORARILY_UNAVAILABLE" : "ZOTERO_REQUEST_REJECTED",
    retryable ? "Zotero 暂时无法完成请求" : "Zotero 拒绝了请求",
    { status, retryable },
  );
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    throw new ZoteroDesktopError(
      "ZOTERO_RESPONSE_INVALID",
      "Zotero 返回了无法识别的数据",
      { status: 502, retryable: true },
    );
  }
}

export function createZoteroDesktopAdapter({
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = globalThis.fetch,
  idFactory = randomUUID,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  verificationAttempts = 3,
} = {}) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (typeof fetchImpl !== "function") throw invalidRequest("fetchImpl 必须是函数");
  if (typeof idFactory !== "function") throw invalidRequest("idFactory 必须是函数");
  if (typeof sleep !== "function") throw invalidRequest("sleep 必须是函数");
  if (
    !Number.isSafeInteger(verificationAttempts)
    || verificationAttempts < 1
    || verificationAttempts > 10
  ) {
    throw invalidRequest("verificationAttempts 必须是 1 到 10 的整数");
  }

  const apiHeaders = Object.freeze({
    Accept: "application/json",
    "Zotero-API-Version": API_VERSION,
  });
  const connectorHeaders = Object.freeze({
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Zotero-Connector-API-Version": API_VERSION,
  });

  async function request(pathname, init, acceptedStatuses, purpose) {
    let response;
    try {
      response = await fetchImpl(`${normalizedBaseUrl}${pathname}`, init);
    } catch {
      throw new ZoteroDesktopError(
        "ZOTERO_UNAVAILABLE",
        "无法连接本机 Zotero",
        { status: 503, retryable: true },
      );
    }
    if (!response || !Number.isInteger(response.status)) {
      throw new ZoteroDesktopError(
        "ZOTERO_RESPONSE_INVALID",
        "Zotero 返回了无法识别的响应",
        { status: 502, retryable: true },
      );
    }
    if (!acceptedStatuses.includes(response.status)) {
      throw httpError(response.status, purpose);
    }
    return response;
  }

  async function apiJson(pathname) {
    const response = await request(pathname, {
      method: "GET",
      headers: apiHeaders,
    }, [200], "api");
    return readJson(response);
  }

  async function connectorJson(pathname, body, acceptedStatuses = [200]) {
    return request(pathname, {
      method: "POST",
      headers: connectorHeaders,
      body: JSON.stringify(body),
    }, acceptedStatuses, "connector");
  }

  async function searchApi(query) {
    const url = new URL("/api/users/0/items/top", normalizedBaseUrl);
    url.searchParams.set("q", query);
    url.searchParams.set("qmode", "everything");
    const body = await apiJson(`${url.pathname}${url.search}`);
    if (!Array.isArray(body)) {
      throw new ZoteroDesktopError(
        "ZOTERO_RESPONSE_INVALID",
        "Zotero 返回了无法识别的搜索结果",
        { status: 502, retryable: true },
      );
    }
    return body.map(parseApiItem);
  }

  async function readChildren(itemKey) {
    const key = requiredString(itemKey, "itemKey", 8);
    if (!ITEM_KEY_PATTERN.test(key)) {
      throw new ZoteroDesktopError(
        "ZOTERO_RESPONSE_INVALID",
        "Zotero 返回了无效的条目编号",
        { status: 502, retryable: true },
      );
    }
    const body = await apiJson(`/api/users/0/items/${key}/children`);
    if (!Array.isArray(body)) {
      throw new ZoteroDesktopError(
        "ZOTERO_RESPONSE_INVALID",
        "Zotero 返回了无法识别的子条目列表",
        { status: 502, retryable: true },
      );
    }
    return body.map(parseChild);
  }

  async function status() {
    const apiResponse = await request("/api/", {
      method: "GET",
      headers: apiHeaders,
    }, [200], "api");
    const apiVersion = apiResponse.headers?.get?.("zotero-api-version") || API_VERSION;
    if (apiVersion !== API_VERSION) {
      throw new ZoteroDesktopError(
        "ZOTERO_API_VERSION_UNSUPPORTED",
        "Zotero 本地 API 版本不受支持",
        { status: 503 },
      );
    }
    await request("/connector/ping", {
      method: "GET",
      headers: {
        "X-Zotero-Connector-API-Version": API_VERSION,
      },
    }, [200], "connector");
    return {
      available: true,
      apiVersion: Number(API_VERSION),
      connectorAvailable: true,
    };
  }

  async function getTargets() {
    const response = await connectorJson("/connector/getSelectedCollection", {});
    const body = await readJson(response);
    if (!body || typeof body !== "object" || !Array.isArray(body.targets)) {
      throw new ZoteroDesktopError(
        "ZOTERO_RESPONSE_INVALID",
        "Zotero 返回了无法识别的目标列表",
        { status: 502, retryable: true },
      );
    }
    const selectedLibraryId = Number(body.libraryID);
    const requestedTargetId = body.id === null || body.id === undefined
      ? `L${selectedLibraryId}`
      : `C${Number(body.id)}`;
    if (
      !Number.isSafeInteger(selectedLibraryId)
      || selectedLibraryId <= 0
      || !TARGET_ID_PATTERN.test(requestedTargetId)
    ) {
      throw new ZoteroDesktopError(
        "ZOTERO_RESPONSE_INVALID",
        "Zotero 返回了无效的当前目标",
        { status: 502, retryable: true },
      );
    }

    let currentLibraryId = null;
    let currentLibraryName = null;
    let currentLibraryEditable = false;
    let currentLibraryFilesEditable = false;
    let currentPath = [];
    const targets = [];
    for (const target of body.targets) {
      if (
        !target
        || typeof target !== "object"
        || typeof target.id !== "string"
        || !TARGET_ID_PATTERN.test(target.id)
        || typeof target.name !== "string"
        || !Number.isSafeInteger(target.level)
        || target.level < 0
      ) {
        throw new ZoteroDesktopError(
          "ZOTERO_RESPONSE_INVALID",
          "Zotero 返回了无效的写入目标",
          { status: 502, retryable: true },
        );
      }
      if (target.id.startsWith("L")) {
        if (target.level !== 0) {
          throw new ZoteroDesktopError(
            "ZOTERO_RESPONSE_INVALID",
            "Zotero 返回了顺序无效的写入目标",
            { status: 502, retryable: true },
          );
        }
        currentLibraryId = Number(target.id.slice(1));
        currentLibraryName = target.name;
        currentLibraryEditable = typeof target.editable === "boolean"
          ? target.editable
          : currentLibraryId === PERSONAL_LIBRARY_ID;
        currentLibraryFilesEditable = typeof target.filesEditable === "boolean"
          ? target.filesEditable
          : currentLibraryId === PERSONAL_LIBRARY_ID;
        currentPath = [target.name];
      } else {
        if (target.level < 1 || target.level > currentPath.length) {
          throw new ZoteroDesktopError(
            "ZOTERO_RESPONSE_INVALID",
            "Zotero 返回了顺序无效的写入目标",
            { status: 502, retryable: true },
          );
        }
        currentPath = currentPath.slice(0, target.level);
        currentPath.push(target.name);
      }
      if (!currentLibraryId || !currentLibraryName) {
        throw new ZoteroDesktopError(
          "ZOTERO_RESPONSE_INVALID",
          "Zotero 返回了顺序无效的写入目标",
          { status: 502, retryable: true },
        );
      }
      if (currentLibraryId !== PERSONAL_LIBRARY_ID) continue;
      targets.push({
        id: target.id,
        name: target.name,
        libraryId: currentLibraryId,
        libraryName: currentLibraryName,
        level: target.level,
        path: [...currentPath],
        filesEditable: typeof target.filesEditable === "boolean"
          ? target.filesEditable
          : currentLibraryFilesEditable,
        editable: typeof target.editable === "boolean"
          ? target.editable
          : currentLibraryEditable,
      });
    }
    const personalRoot = targets.find((target) => target.id === `L${PERSONAL_LIBRARY_ID}`);
    if (!personalRoot) {
      throw new ZoteroDesktopError(
        "ZOTERO_RESPONSE_INVALID",
        "Zotero 未返回个人资料库",
        { status: 502, retryable: true },
      );
    }
    const selectedTarget = selectedLibraryId === PERSONAL_LIBRARY_ID
      ? targets.find((target) => target.id === requestedTargetId)
      : null;
    const fallbackTarget = [personalRoot, ...targets].find((target, index, all) => (
      all.indexOf(target) === index && target.editable && target.filesEditable
    ));
    const selectedTargetId = selectedTarget?.editable && selectedTarget.filesEditable
      ? selectedTarget.id
      : fallbackTarget?.id;
    if (!selectedTargetId) {
      throw new ZoteroDesktopError(
        "ZOTERO_NO_WRITABLE_TARGET",
        "Zotero 个人资料库没有可写目标",
        { status: 409 },
      );
    }
    return { selectedTargetId, targets };
  }

  async function findDuplicates({
    doi,
    title,
    operationId,
  } = {}) {
    const normalizedDoi = normalizeDoi(doi);
    const normalizedTitle = normalizeTitle(title);
    const marker = operationId === undefined || operationId === null
      ? null
      : operationMarker(operationId);
    if (!normalizedDoi && !normalizedTitle && !marker) {
      throw invalidRequest("findDuplicates 至少需要 doi、title 或 operationId");
    }

    const queries = [...new Set([marker, normalizedDoi, title?.trim()].filter(Boolean))];
    const found = new Map();
    for (const query of queries) {
      const items = await searchApi(query);
      for (const item of items) found.set(item.key, item);
    }
    const items = [...found.values()];
    const operationMatches = marker
      ? items.filter((item) => item.extra.split(/\r?\n/).includes(marker))
      : [];
    if (operationMatches.length > 1) {
      throw new ZoteroDesktopError(
        "ZOTERO_OPERATION_CONFLICT",
        "Zotero 中存在多个相同 operation marker",
        { status: 409 },
      );
    }
    return {
      operationMatch: operationMatches[0] ? publicItem(operationMatches[0]) : null,
      doiMatches: normalizedDoi
        ? items.filter((item) => item.doi === normalizedDoi).map(publicItem)
        : [],
      titleMatches: normalizedTitle
        ? items.filter((item) => item.normalizedTitle === normalizedTitle).map(publicItem)
        : [],
    };
  }

  function previewStale(kind) {
    return new ZoteroDesktopError(
      "ZOTERO_PREVIEW_STALE",
      kind === "doi"
        ? "Zotero 中已出现相同 DOI 的条目，请重新生成写入预览"
        : "Zotero 中已出现同名条目，请重新生成写入预览",
      { status: 409 },
    );
  }

  function manualRepairRequired() {
    return new ZoteroDesktopError(
      "ZOTERO_MANUAL_REPAIR_REQUIRED",
      "Zotero 中存在未完整写入的条目，请先在 Zotero 中检查后再继续",
      { status: 409 },
    );
  }

  function assertOperationIdentity(operationMatch, doi, title) {
    if (
      normalizeTitle(operationMatch.title) !== normalizeTitle(title)
      || (doi && normalizeDoi(operationMatch.doi) !== doi)
    ) {
      throw new ZoteroDesktopError(
        "ZOTERO_OPERATION_CONFLICT",
        "Zotero operation marker 对应的条目已变化，请人工检查后重新生成预览",
        { status: 409 },
      );
    }
  }

  function verificationResult({
    itemKey,
    assets,
    sessionId,
    connectorItemId,
    idempotent,
    doi,
    noteHtml,
    pdf,
  }) {
    const verifiedFields = [
      "item.key",
      "item.operation_marker",
      "bibliographic.normalized_title",
    ];
    const verifiedLabels = ["条目 key", "operation marker", "规范化标题"];
    if (doi) {
      verifiedFields.push("bibliographic.normalized_doi");
      verifiedLabels.push("规范化 DOI");
    }
    if (noteHtml) {
      verifiedFields.push("note.key", "note.html");
      verifiedLabels.push("导读正文与 note key");
    }
    if (pdf) {
      verifiedFields.push(
        "pdf.attachment_key",
        "pdf.attachment_content_type",
        "pdf.attachment_file_name",
      );
      verifiedLabels.push("PDF 子附件的 key、类型与文件名");
      if (assets.attachment?.url) {
        verifiedFields.push("pdf.attachment_source_url");
        verifiedLabels.push("PDF 来源 URL");
      }
    }

    const unverifiedFields = [
      "bibliographic.complete_record",
      "bibliographic.tags",
      "collection.target",
    ];
    const unverifiedLabels = ["完整题录", "标签", "目标集合"];
    if (pdf) {
      if (!assets.attachment?.url) {
        unverifiedFields.push("pdf.attachment_source_url");
        unverifiedLabels.push("PDF 来源 URL");
      }
      unverifiedFields.push("pdf.bytes", "pdf.sha256");
      unverifiedLabels.push("PDF 字节与 SHA-256");
    }

    return {
      itemKey,
      attachmentKey: assets.attachment?.key || null,
      noteKey: assets.note?.key || null,
      sessionId,
      connectorItemId,
      verified: true,
      verification_scope: {
        status: "scoped_read_back",
        basis: "zotero_local_api_read_back",
        verified_fields: verifiedFields,
        unverified_fields: unverifiedFields,
      },
      message: `已从 Zotero 读回核验${verifiedLabels.join("、")}；未从 Zotero 读回核验${unverifiedLabels.join("、")}。`,
      idempotent,
    };
  }

  function matchingAssets(children, noteHtml, pdf) {
    const note = noteHtml
      ? children.find((child) => child.itemType === "note" && child.note === noteHtml) || null
      : children.find((child) => child.itemType === "note") || null;
    const attachment = pdf
      ? children.find((child) => (
        child.itemType === "attachment"
        && child.contentType === "application/pdf"
        && (child.filename === pdf.fileName || child.title === pdf.fileName)
        && (!child.url || child.url === pdf.url)
      )) || null
      : children.find((child) => (
        child.itemType === "attachment" && child.contentType === "application/pdf"
      )) || null;
    return { note, attachment };
  }

  async function observeAssets(itemKey, noteHtml, pdf) {
    let lastState = { note: null, attachment: null };
    let lastError = null;
    let hadSuccessfulRead = false;
    for (let attempt = 0; attempt < verificationAttempts; attempt += 1) {
      try {
        lastState = matchingAssets(await readChildren(itemKey), noteHtml, pdf);
        hadSuccessfulRead = true;
        lastError = null;
        if ((!noteHtml || lastState.note) && (!pdf || lastState.attachment)) {
          return lastState;
        }
      } catch (error) {
        lastError = error;
      }
      if (attempt + 1 < verificationAttempts) await sleep(25);
    }
    const requestedAssetMissing = (
      (Boolean(noteHtml) && !lastState.note)
      || (Boolean(pdf) && !lastState.attachment)
    );
    if (lastError && (!hadSuccessfulRead || requestedAssetMissing)) throw lastError;
    return lastState;
  }

  async function waitForOperation(operationId, doi, title) {
    let duplicates = null;
    for (let attempt = 0; attempt < verificationAttempts; attempt += 1) {
      duplicates = await findDuplicates({ operationId, doi, title });
      if (duplicates.operationMatch) return duplicates;
      if (attempt + 1 < verificationAttempts) await sleep(25);
    }
    return duplicates;
  }

  async function uploadPdf(sessionId, connectorItemId, pdf) {
    await request("/connector/saveAttachment", {
      method: "POST",
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(pdf.bytes.length),
        "X-Metadata": JSON.stringify({
          sessionID: sessionId,
          parentItemID: connectorItemId,
          title: pdf.fileName,
          url: pdf.url,
        }),
        "X-Zotero-Connector-API-Version": API_VERSION,
      },
      body: pdf.bytes,
    }, [201], "attachment");
  }

  async function finishOperation({
    itemKey,
    sessionId,
    connectorItemId,
    targetId,
    tags,
    noteHtml,
    pdf,
    doi,
    idempotent,
    forceUpdateSession,
  }) {
    let assets;
    try {
      assets = await observeAssets(itemKey, noteHtml, pdf);
    } catch {
      throw manualRepairRequired();
    }
    const noteMissing = Boolean(noteHtml) && !assets.note;
    const pdfMissing = Boolean(pdf) && !assets.attachment;
    if (
      (noteMissing || pdfMissing || forceUpdateSession)
      && (!sessionId || !connectorItemId)
    ) {
      throw manualRepairRequired();
    }

    if (forceUpdateSession || noteMissing || pdfMissing) {
      let updateError = null;
      try {
        await connectorJson("/connector/updateSession", {
          sessionID: sessionId,
          target: targetId,
          tags,
          note: noteHtml,
        });
      } catch (error) {
        updateError = error;
      }
      try {
        assets = await observeAssets(itemKey, noteHtml, pdf);
      } catch {
        throw manualRepairRequired();
      }
      if (updateError || (noteHtml && !assets.note)) {
        throw manualRepairRequired();
      }
    }

    if (pdf && !assets.attachment) {
      let uploadError = null;
      try {
        await uploadPdf(sessionId, connectorItemId, pdf);
      } catch (error) {
        uploadError = error;
      }
      try {
        assets = await observeAssets(itemKey, noteHtml, pdf);
      } catch {
        throw manualRepairRequired();
      }
      if (!assets.attachment) {
        void uploadError;
        throw manualRepairRequired();
      }
    }

    return verificationResult({
      itemKey,
      assets,
      sessionId,
      connectorItemId,
      doi,
      noteHtml,
      pdf,
      idempotent,
    });
  }

  async function createItem({
    operationId,
    sessionId,
    connectorItemId,
    targetId,
    item,
    noteHtml = "",
    pdf,
  } = {}) {
    const marker = operationMarker(operationId);
    const resolvedTargetId = normalizeTargetId(targetId);
    const resolvedNote = noteHtml === "" || noteHtml === null
      ? ""
      : requiredString(noteHtml, "noteHtml", 1_000_000);
    const resolvedPdf = normalizePdf(pdf);
    const suppliedSessionId = sessionId === undefined || sessionId === null
      ? null
      : normalizeConnectorId(sessionId, "sessionId");
    const suppliedConnectorItemId = connectorItemId === undefined || connectorItemId === null
      ? null
      : normalizeConnectorId(connectorItemId, "connectorItemId");
    if (Boolean(suppliedSessionId) !== Boolean(suppliedConnectorItemId)) {
      throw invalidRequest("sessionId 与 connectorItemId 必须同时提供");
    }
    const normalized = normalizeItem(
      item,
      marker,
      suppliedConnectorItemId || "pi-item-validation",
    );
    const doi = normalizeDoi(item.DOI);
    const title = normalized.connectorItem.title;

    return withWriteLock(normalizedBaseUrl, async () => {
      const duplicates = await findDuplicates({ operationId, doi, title });
      if (duplicates.operationMatch) {
        assertOperationIdentity(duplicates.operationMatch, doi, title);
        return finishOperation({
          itemKey: duplicates.operationMatch.key,
          sessionId: suppliedSessionId,
          connectorItemId: suppliedConnectorItemId,
          targetId: resolvedTargetId,
          tags: normalized.tags,
          noteHtml: resolvedNote,
          pdf: resolvedPdf,
          doi,
          idempotent: true,
          forceUpdateSession: false,
        });
      }
      if (doi && duplicates.doiMatches.length > 0) throw previewStale("doi");
      if (duplicates.titleMatches.length > 0) throw previewStale("title");

      const resolvedSessionId = suppliedSessionId || normalizeConnectorId(
        `pi-session-${idFactory()}`,
        "sessionId",
      );
      const resolvedConnectorItemId = suppliedConnectorItemId || normalizeConnectorId(
        `pi-item-${idFactory()}`,
        "connectorItemId",
      );
      const connectorItem = {
        ...normalized.connectorItem,
        id: resolvedConnectorItemId,
      };
      let saveError = null;
      try {
        await connectorJson("/connector/saveItems", {
          sessionID: resolvedSessionId,
          uri: normalized.sourceUri,
          items: [connectorItem],
        }, [201]);
      } catch (error) {
        saveError = error;
      }

      if (saveError && !saveError.retryable) throw saveError;
      let verification;
      try {
        verification = await waitForOperation(operationId, doi, title);
      } catch {
        throw manualRepairRequired();
      }
      if (!verification.operationMatch) {
        throw manualRepairRequired();
      }
      assertOperationIdentity(verification.operationMatch, doi, title);
      return finishOperation({
        itemKey: verification.operationMatch.key,
        sessionId: resolvedSessionId,
        connectorItemId: resolvedConnectorItemId,
        targetId: resolvedTargetId,
        tags: normalized.tags,
        noteHtml: resolvedNote,
        pdf: resolvedPdf,
        doi,
        idempotent: false,
        forceUpdateSession: true,
      });
    });
  }

  return {
    status,
    getTargets,
    findDuplicates,
    createItem,
  };
}
