import { createHash } from "node:crypto";
import { createChromiumCdpBrowserQaAdapter } from "./chromiumCdpBrowserQaAdapter.js";
import { projectWorkError, ProjectWorkError } from "./errors.js";

export const BROWSER_QA_POLICY_VERSION = "preview-browser-qa.v1";

const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
const MAX_CONSOLE_ENTRIES = 100;
const MAX_FAILED_REQUESTS = 100;
const MAX_SECURITY_EVENTS = 100;
const MAX_ACCESSIBILITY_ISSUES = 50;
const MAX_TEXT_LENGTH = 600;
const SAFE_HTTP_METHODS = new Set(["GET"]);
const PNG_SIGNATURE = Buffer.from([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
]);

export const BROWSER_QA_PROFILES = Object.freeze([
  Object.freeze({
    id: "desktop",
    label: "桌面",
    width: 1_440,
    height: 1_024,
    deviceScaleFactor: 1,
    isMobile: false,
  }),
  Object.freeze({
    id: "mobile",
    label: "移动",
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    isMobile: true,
  }),
]);

function browserQaError(code, message, status = 409, retryable = false) {
  return projectWorkError(code, message, status, retryable);
}

function cleanText(value, maxLength = MAX_TEXT_LENGTH) {
  return String(value ?? "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .slice(0, maxLength);
}

function safeUrlDetails(rawUrl, allowedOrigin) {
  try {
    const url = new URL(rawUrl);
    if (url.username || url.password) {
      return { scope: "blocked", origin: null, path: null };
    }
    if (url.origin === allowedOrigin) {
      return {
        scope: "preview",
        origin: allowedOrigin,
        path: url.pathname.slice(0, MAX_TEXT_LENGTH),
      };
    }
    return {
      scope: "external",
      origin: url.origin.slice(0, 200),
      path: null,
    };
  } catch {
    return { scope: "invalid", origin: null, path: null };
  }
}

function normalizeOwnedPreview(preview) {
  if (
    !preview
    || typeof preview !== "object"
    || preview.ownershipToken == null
    || typeof preview.url !== "string"
  ) {
    throw browserQaError(
      "PROJECT_BROWSER_QA_PREVIEW_NOT_OWNED",
      "当前没有可验收的受管本地预览",
    );
  }
  let url;
  try {
    url = new URL(preview.url);
  } catch {
    throw browserQaError(
      "PROJECT_BROWSER_QA_PREVIEW_INVALID",
      "受管预览地址无效",
    );
  }
  if (
    url.protocol !== "http:"
    || url.hostname !== "127.0.0.1"
    || !url.port
    || url.username
    || url.password
    || url.hash
    || (preview.origin != null && preview.origin !== url.origin)
  ) {
    throw browserQaError(
      "PROJECT_BROWSER_QA_PREVIEW_INVALID",
      "浏览器验收只允许当前受管的 loopback 预览",
    );
  }
  return Object.freeze({
    ownershipToken: preview.ownershipToken,
    url: url.href,
    origin: url.origin,
    path: `${url.pathname}${url.search}`,
  });
}

function decision(allowed, reason) {
  return Object.freeze({ allowed, reason });
}

export function createPreviewBrowserQaPolicy(ownedOrigin) {
  let parsedOrigin;
  try {
    parsedOrigin = new URL(ownedOrigin);
  } catch {
    throw browserQaError(
      "PROJECT_BROWSER_QA_PREVIEW_INVALID",
      "受管预览来源无效",
    );
  }
  if (
    parsedOrigin.protocol !== "http:"
    || parsedOrigin.hostname !== "127.0.0.1"
    || !parsedOrigin.port
    || parsedOrigin.origin !== ownedOrigin
  ) {
    throw browserQaError(
      "PROJECT_BROWSER_QA_PREVIEW_INVALID",
      "浏览器验收只允许当前受管的 loopback 来源",
    );
  }

  const events = [];
  let truncated = false;
  const counts = {
    allowedRequests: 0,
    blockedRequests: 0,
    allowedNavigations: 0,
    blockedNavigations: 0,
    blockedInteractions: 0,
    blockedDownloads: 0,
    blockedPopups: 0,
  };

  const record = (kind, allowed, reason, rawUrl = null) => {
    if (events.length >= MAX_SECURITY_EVENTS) {
      truncated = true;
      return;
    }
    events.push(Object.freeze({
      kind,
      allowed,
      reason,
      ...(rawUrl == null ? {} : safeUrlDetails(rawUrl, ownedOrigin)),
    }));
  };

  const authorizeNavigation = (rawUrl) => {
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      counts.blockedNavigations += 1;
      record("navigation", false, "invalid_url", rawUrl);
      return decision(false, "invalid_url");
    }
    const allowed = (
      url.origin === ownedOrigin
      && url.protocol === "http:"
      && !url.username
      && !url.password
    );
    const reason = allowed ? "owned_preview_origin" : "external_navigation";
    counts[allowed ? "allowedNavigations" : "blockedNavigations"] += 1;
    record("navigation", allowed, reason, rawUrl);
    return decision(allowed, reason);
  };

  const authorizeRequest = ({
    url: rawUrl,
    method = "GET",
  } = {}) => {
    const normalizedMethod = String(method).trim().toUpperCase();
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      counts.blockedRequests += 1;
      record("request", false, "invalid_url", rawUrl);
      return decision(false, "invalid_url");
    }
    const sameHttpOrigin = (
      url.protocol === "http:"
      && url.origin === ownedOrigin
    );
    const websocketDisabled = url.protocol === "ws:" || url.protocol === "wss:";
    const safeMethod = SAFE_HTTP_METHODS.has(normalizedMethod);
    const allowed = (
      !url.username
      && !url.password
      && safeMethod
      && sameHttpOrigin
    );
    let reason = "owned_preview_origin";
    if (websocketDisabled) reason = "websocket_disabled";
    else if (!safeMethod) reason = "non_read_request";
    else if (!sameHttpOrigin) reason = "external_resource";
    else if (url.username || url.password) reason = "embedded_credentials";
    counts[allowed ? "allowedRequests" : "blockedRequests"] += 1;
    record("request", allowed, reason, rawUrl);
    return decision(allowed, reason);
  };

  const block = (kind, counter, reason, rawUrl = null) => {
    counts[counter] += 1;
    record(kind, false, reason, rawUrl);
    return decision(false, reason);
  };

  return Object.freeze({
    version: BROWSER_QA_POLICY_VERSION,
    origin: ownedOrigin,
    authorizeNavigation,
    authorizeRequest,
    authorizeInteraction: (action) => block(
      "interaction",
      "blockedInteractions",
      `passive_audit_only:${cleanText(action, 80) || "unknown"}`,
    ),
    authorizeDownload: (rawUrl) => block(
      "download",
      "blockedDownloads",
      "downloads_disabled",
      rawUrl,
    ),
    authorizePopup: (rawUrl) => block(
      "popup",
      "blockedPopups",
      "popups_disabled",
      rawUrl,
    ),
    snapshot: () => Object.freeze({
      version: BROWSER_QA_POLICY_VERSION,
      ...counts,
      events: Object.freeze([...events]),
      truncated,
    }),
  });
}

function integerField(value, field, maximum = 1_000_000) {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw browserQaError(
      "PROJECT_BROWSER_QA_RESULT_INVALID",
      `浏览器验收结果中的 ${field} 无效`,
      502,
    );
  }
  return value;
}

function normalizeDomSummary(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw browserQaError(
      "PROJECT_BROWSER_QA_RESULT_INVALID",
      "浏览器验收缺少 DOM 摘要",
      502,
    );
  }
  return {
    title: cleanText(raw.title, 300),
    language: cleanText(raw.language, 40),
    nodeCount: integerField(raw.nodeCount, "DOM nodeCount"),
    landmarkCount: integerField(raw.landmarkCount, "DOM landmarkCount"),
    headingCount: integerField(raw.headingCount, "DOM headingCount"),
    interactiveCount: integerField(raw.interactiveCount, "DOM interactiveCount"),
    imageCount: integerField(raw.imageCount, "DOM imageCount"),
    tableCount: integerField(raw.tableCount, "DOM tableCount"),
    formCount: integerField(raw.formCount, "DOM formCount"),
    credentialInputCount: integerField(
      raw.credentialInputCount,
      "DOM credentialInputCount",
    ),
    fileInputCount: integerField(raw.fileInputCount, "DOM fileInputCount"),
  };
}

const ACCESSIBILITY_SEVERITIES = new Set([
  "info",
  "minor",
  "moderate",
  "serious",
  "critical",
]);

function normalizeAccessibilitySummary(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.issues)) {
    throw browserQaError(
      "PROJECT_BROWSER_QA_RESULT_INVALID",
      "浏览器验收缺少可访问性摘要",
      502,
    );
  }
  if (raw.issues.length > MAX_ACCESSIBILITY_ISSUES) {
    throw browserQaError(
      "PROJECT_BROWSER_QA_RESULT_INVALID",
      "可访问性问题数量超过验收上限",
      502,
    );
  }
  const issues = raw.issues.map((issue) => {
    if (!issue || typeof issue !== "object") {
      throw browserQaError(
        "PROJECT_BROWSER_QA_RESULT_INVALID",
        "可访问性问题格式无效",
        502,
      );
    }
    const severity = ACCESSIBILITY_SEVERITIES.has(issue.severity)
      ? issue.severity
      : "moderate";
    return {
      id: cleanText(issue.id, 120),
      severity,
      count: integerField(issue.count, "accessibility issue count", 100_000),
      message: cleanText(issue.message),
    };
  });
  return {
    checkedNodeCount: integerField(
      raw.checkedNodeCount,
      "accessibility checkedNodeCount",
    ),
    issueCount: issues.reduce((sum, issue) => sum + issue.count, 0),
    issues,
  };
}

function normalizeScreenshot(raw, profile) {
  const source = raw?.bytes ?? raw;
  if (!(Buffer.isBuffer(source) || source instanceof Uint8Array)) {
    throw browserQaError(
      "PROJECT_BROWSER_QA_RESULT_INVALID",
      "浏览器验收缺少 PNG 截图",
      502,
    );
  }
  const bytes = Buffer.from(source);
  if (
    !bytes.length
    || bytes.length > MAX_SCREENSHOT_BYTES
    || bytes.length < 24
    || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    || bytes.readUInt32BE(8) !== 13
    || bytes.toString("ascii", 12, 16) !== "IHDR"
    || bytes.readUInt32BE(16) !== profile.width
    || bytes.readUInt32BE(20) !== profile.height
  ) {
    throw browserQaError(
      "PROJECT_BROWSER_QA_RESULT_INVALID",
      "浏览器验收截图无效或超过 5 MiB",
      502,
    );
  }
  return {
    mimeType: "image/png",
    byteLength: bytes.length,
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    bytes,
  };
}

function normalizeCaptures(rawCaptures) {
  if (
    !Array.isArray(rawCaptures)
    || rawCaptures.length !== BROWSER_QA_PROFILES.length
  ) {
    throw browserQaError(
      "PROJECT_BROWSER_QA_RESULT_INVALID",
      "浏览器验收必须同时返回桌面与移动结果",
      502,
    );
  }
  const byId = new Map(rawCaptures.map((capture) => [capture?.profileId, capture]));
  if (byId.size !== BROWSER_QA_PROFILES.length) {
    throw browserQaError(
      "PROJECT_BROWSER_QA_RESULT_INVALID",
      "浏览器验收视口结果重复或缺失",
      502,
    );
  }
  return BROWSER_QA_PROFILES.map((profile) => {
    const capture = byId.get(profile.id);
    if (!capture) {
      throw browserQaError(
        "PROJECT_BROWSER_QA_RESULT_INVALID",
        `浏览器验收缺少${profile.label}结果`,
        502,
      );
    }
    return {
      profile,
      screenshot: normalizeScreenshot(capture.screenshot, profile),
      dom: normalizeDomSummary(capture.dom),
      accessibility: normalizeAccessibilitySummary(capture.accessibility),
    };
  });
}

function boundedEntries(rawEntries, limit, normalize) {
  const entries = Array.isArray(rawEntries) ? rawEntries : [];
  return {
    entries: entries.slice(0, limit).map(normalize),
    truncated: entries.length > limit,
  };
}

function normalizeConsoleEntry(entry, allowedOrigin) {
  const level = ["debug", "info", "log", "warn", "error"].includes(entry?.level)
    ? entry.level
    : "log";
  return {
    level,
    text: cleanText(entry?.text),
    source: safeUrlDetails(entry?.url, allowedOrigin),
  };
}

function normalizeFailedRequest(entry, allowedOrigin) {
  return {
    method: cleanText(entry?.method, 20).toUpperCase() || "GET",
    resourceType: cleanText(entry?.resourceType, 60) || "other",
    reason: cleanText(entry?.reason, 300),
    source: safeUrlDetails(entry?.url, allowedOrigin),
  };
}

function validateRunInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw browserQaError(
      "PROJECT_BROWSER_QA_INPUT_INVALID",
      "浏览器验收请求无效",
      400,
    );
  }
  const keys = Object.keys(input);
  if (keys.length !== 1 || keys[0] !== "key") {
    throw browserQaError(
      "PROJECT_BROWSER_QA_INPUT_INVALID",
      "浏览器验收只接受受管预览标识，不能指定 URL 或命令",
      400,
    );
  }
  if (typeof input.key !== "string" || !input.key.trim()) {
    throw browserQaError(
      "PROJECT_BROWSER_QA_INPUT_INVALID",
      "受管预览标识无效",
      400,
    );
  }
  return input.key.trim();
}

export function assessBrowserQaEvidence({
  captures = [],
  console: consoleEvidence,
  failedRequests,
  security,
} = {}) {
  const consoleErrorCount = Array.isArray(consoleEvidence?.entries)
    ? consoleEvidence.entries.filter((entry) => entry?.level === "error").length
    : 0;
  const failedRequestCount = Array.isArray(failedRequests?.entries)
    ? failedRequests.entries.length
    : 0;
  const accessibilityIssueCount = Array.isArray(captures)
    ? captures.reduce((total, capture) => {
        const explicit = capture?.accessibility?.issueCount;
        if (Number.isSafeInteger(explicit) && explicit >= 0) {
          return total + explicit;
        }
        return total + (
          Array.isArray(capture?.accessibility?.issues)
            ? capture.accessibility.issues.reduce((sum, issue) => (
                sum + (
                  Number.isSafeInteger(issue?.count) && issue.count > 0
                    ? issue.count
                    : 0
                )
              ), 0)
            : 0
        );
      }, 0)
    : 0;
  const safeSecurityCount = (field) => (
    Number.isSafeInteger(security?.[field]) && security[field] > 0
      ? security[field]
      : 0
  );
  const blockedRequestCount = safeSecurityCount("blockedRequests");
  const blockedNavigationCount = safeSecurityCount("blockedNavigations");
  const blockedActionCount = (
    safeSecurityCount("blockedInteractions")
    + safeSecurityCount("blockedDownloads")
    + safeSecurityCount("blockedPopups")
  );
  const hasIssues = (
    consoleErrorCount > 0
    || failedRequestCount > 0
    || accessibilityIssueCount > 0
    || blockedRequestCount > 0
    || blockedNavigationCount > 0
    || blockedActionCount > 0
  );
  return Object.freeze({
    verdict: hasIssues ? "issues" : "passed",
    issueSummary: Object.freeze({
      consoleErrorCount,
      failedRequestCount,
      accessibilityIssueCount,
      blockedRequestCount,
      blockedNavigationCount,
      blockedActionCount,
    }),
  });
}

export function createUnavailableBrowserQaAdapter() {
  return Object.freeze({
    id: "unavailable",
    available: false,
    async inspect() {
      throw browserQaError(
        "PROJECT_BROWSER_QA_ADAPTER_UNAVAILABLE",
        "当前没有可用的受控浏览器验收适配器",
        503,
        true,
      );
    },
  });
}

/**
 * A browser adapter is server-owned and passive. Its inspect method must install
 * the supplied policy before the first navigation and use it to abort blocked
 * requests, navigations, popups, downloads, and all page interactions.
 */
export function createPreviewBrowserQaService({
  previewSupervisor,
  browserAdapter = createChromiumCdpBrowserQaAdapter(),
  now = () => new Date(),
} = {}) {
  if (typeof previewSupervisor?.getOwnedPreview !== "function") {
    throw browserQaError(
      "PROJECT_BROWSER_QA_SUPERVISOR_INVALID",
      "浏览器验收需要受管预览所有权接口",
      500,
    );
  }

  const run = async (input) => {
    const key = validateRunInput(input);
    const owned = normalizeOwnedPreview(previewSupervisor.getOwnedPreview(key));
    if (
      browserAdapter?.available !== true
      || typeof browserAdapter.inspect !== "function"
    ) {
      throw browserQaError(
        "PROJECT_BROWSER_QA_ADAPTER_UNAVAILABLE",
        "当前没有可用的受控浏览器验收适配器",
        503,
        true,
      );
    }

    const policy = createPreviewBrowserQaPolicy(owned.origin);
    const target = Object.freeze({
      url: owned.url,
      origin: owned.origin,
      path: owned.path,
    });
    let rawResult;
    try {
      rawResult = await browserAdapter.inspect(Object.freeze({
        target,
        profiles: BROWSER_QA_PROFILES,
        policy,
        limits: Object.freeze({
          maxScreenshotBytes: MAX_SCREENSHOT_BYTES,
          maxConsoleEntries: MAX_CONSOLE_ENTRIES,
          maxFailedRequests: MAX_FAILED_REQUESTS,
        }),
      }));
    } catch (error) {
      if (error instanceof ProjectWorkError) throw error;
      throw browserQaError(
        "PROJECT_BROWSER_QA_FAILED",
        "受控浏览器验收失败",
        502,
        true,
      );
    }

    const current = previewSupervisor.getOwnedPreview(key);
    if (
      !current
      || current.ownershipToken !== owned.ownershipToken
      || current.url !== owned.url
    ) {
      throw browserQaError(
        "PROJECT_BROWSER_QA_PREVIEW_REPLACED",
        "验收期间本地预览已停止或被替换，请重新运行",
        409,
        true,
      );
    }
    if (!rawResult || typeof rawResult !== "object") {
      throw browserQaError(
        "PROJECT_BROWSER_QA_RESULT_INVALID",
        "浏览器验收结果无效",
        502,
      );
    }

    const captures = normalizeCaptures(rawResult.captures);
    const consoleEvidence = boundedEntries(
      rawResult.console,
      MAX_CONSOLE_ENTRIES,
      (entry) => normalizeConsoleEntry(entry, owned.origin),
    );
    const failedRequests = boundedEntries(
      rawResult.failedRequests,
      MAX_FAILED_REQUESTS,
      (entry) => normalizeFailedRequest(entry, owned.origin),
    );
    const security = policy.snapshot();
    const assessment = assessBrowserQaEvidence({
      captures,
      console: consoleEvidence,
      failedRequests,
      security,
    });
    return {
      status: "completed",
      adapterId: cleanText(browserAdapter.id, 120) || "controlled-browser",
      preview: {
        origin: owned.origin,
        path: owned.path,
      },
      captures,
      console: consoleEvidence,
      failedRequests,
      security,
      ...assessment,
      completedAt: now().toISOString(),
    };
  };

  return Object.freeze({ run });
}
