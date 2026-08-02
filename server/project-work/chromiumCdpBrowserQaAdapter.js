import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { projectWorkError, ProjectWorkError } from "./errors.js";

export const FIXED_CHROMIUM_BINARY_PATHS = Object.freeze([
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
]);

const DEVTOOLS_FILE = "DevToolsActivePort";
const DEVTOOLS_PATH_PATTERN = /^\/devtools\/browser\/[A-Za-z0-9._-]+$/;
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
const DEFAULT_PAGE_TIMEOUT_MS = 15_000;
const DEFAULT_NETWORK_IDLE_MS = 200;
const DEFAULT_NETWORK_SETTLE_TIMEOUT_MS = 3_000;
const DEFAULT_STOP_TIMEOUT_MS = 1_000;
const MAX_BROWSER_LOG_BYTES = 8 * 1024;
const MAX_CAPTURED_EVENTS = 200;
const MAX_CDP_MESSAGE_BYTES = 12 * 1024 * 1024;
const MAX_EVENT_TEXT_LENGTH = 1_000;
const MAX_EVENT_URL_LENGTH = 2_048;

const INTERACTIVE_AX_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "menuitem",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
]);

function adapterError(code, message, status = 502, retryable = true) {
  return projectWorkError(code, message, status, retryable);
}

function safeBrowserEnvironment() {
  return Object.fromEntries(
    ["LANG", "LC_ALL", "TMPDIR", "TZ"].flatMap((name) => (
      typeof process.env[name] === "string" ? [[name, process.env[name]]] : []
    )),
  );
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function appendBounded(buffer, chunk, maximum) {
  if (buffer.length >= maximum) return buffer;
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  return Buffer.concat([buffer, bytes.subarray(0, maximum - buffer.length)]);
}

function killOwnedProcess(child, signal) {
  if (
    process.platform !== "win32"
    && Number.isInteger(child?.pid)
    && child.pid > 0
  ) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (error?.code === "ESRCH") return;
    }
  }
  child?.kill?.(signal);
}

async function findFixedChromiumBinary({
  paths = FIXED_CHROMIUM_BINARY_PATHS,
  lstatImpl = lstat,
  accessImpl = access,
  realpathImpl = realpath,
} = {}) {
  for (const candidate of paths) {
    try {
      const metadata = await lstatImpl(candidate);
      if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
      await accessImpl(candidate, fsConstants.X_OK);
      if (await realpathImpl(candidate) !== candidate) continue;
      return candidate;
    } catch {
      // Only fixed, executable, non-symlink browser binaries are eligible.
    }
  }
  throw adapterError(
    "PROJECT_BROWSER_QA_ADAPTER_UNAVAILABLE",
    "未找到受支持的本机 Chrome 或 Chromium",
    503,
    true,
  );
}

function fixedChromiumArguments(profileRoot) {
  return [
    "--headless=new",
    "--disable-background-networking",
    "--disable-breakpad",
    "--disable-client-side-phishing-detection",
    "--disable-component-update",
    "--disable-crash-reporter",
    "--disable-default-apps",
    "--disable-domain-reliability",
    "--disable-extensions",
    "--disable-features=AutofillServerCommunication,OptimizationHints,MediaRouter,Translate",
    "--disable-gpu",
    "--disable-sync",
    "--metrics-recording-only",
    "--no-default-browser-check",
    "--no-first-run",
    "--password-store=basic",
    "--safebrowsing-disable-auto-update",
    "--use-mock-keychain",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileRoot}`,
    "--window-size=1440,1024",
    "about:blank",
  ];
}

function parseDevToolsFile(content) {
  const lines = String(content).trim().split(/\r?\n/);
  if (lines.length !== 2) return null;
  const [rawPort, websocketPath] = lines;
  const port = Number(rawPort);
  if (
    !Number.isInteger(port)
    || port < 1_024
    || port > 65_535
    || !DEVTOOLS_PATH_PATTERN.test(websocketPath ?? "")
  ) {
    return null;
  }
  return `ws://127.0.0.1:${port}${websocketPath}`;
}

export function createFixedChromiumLauncher({
  resolveBinary = () => findFixedChromiumBinary(),
  spawnImpl = spawn,
  mkdtempImpl = mkdtemp,
  readFileImpl = readFile,
  rmImpl = rm,
  killImpl = killOwnedProcess,
  delayImpl = delay,
  startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
  stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
  now = () => Date.now(),
} = {}) {
  const launch = async () => {
    const binary = await resolveBinary();
    if (!FIXED_CHROMIUM_BINARY_PATHS.includes(binary)) {
      throw adapterError(
        "PROJECT_BROWSER_QA_ADAPTER_UNAVAILABLE",
        "受控浏览器不在固定允许列表中",
        503,
        true,
      );
    }
    const profileRoot = await mkdtempImpl(
      path.join(os.tmpdir(), "pi-agent-browser-qa-"),
    );
    if (
      path.dirname(profileRoot) !== os.tmpdir()
      || !path.basename(profileRoot).startsWith("pi-agent-browser-qa-")
    ) {
      throw adapterError(
        "PROJECT_BROWSER_QA_ADAPTER_UNAVAILABLE",
        "受控浏览器临时目录无效",
        503,
        true,
      );
    }
    let child;
    let stderr = Buffer.alloc(0);
    let exited = false;
    const exitWaiters = new Set();

    const cleanupProfile = async () => {
      await rmImpl(profileRoot, { recursive: true, force: true }).catch(() => {});
    };
    try {
      child = spawnImpl(binary, fixedChromiumArguments(profileRoot), {
        detached: true,
        shell: false,
        stdio: ["ignore", "ignore", "pipe"],
        env: safeBrowserEnvironment(),
      });
    } catch {
      await cleanupProfile();
      throw adapterError(
        "PROJECT_BROWSER_QA_ADAPTER_UNAVAILABLE",
        "无法启动受控本机浏览器",
        503,
        true,
      );
    }

    const markExited = () => {
      if (exited) return;
      exited = true;
      for (const notify of [...exitWaiters]) notify();
    };
    child.stderr?.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk, MAX_BROWSER_LOG_BYTES);
    });
    child.once?.("error", markExited);
    child.once?.("close", markExited);

    const waitForExit = async (timeoutMs) => {
      if (exited) return true;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          exitWaiters.delete(onExit);
          resolve(false);
        }, timeoutMs);
        timer.unref?.();
        const onExit = () => {
          clearTimeout(timer);
          exitWaiters.delete(onExit);
          resolve(true);
        };
        exitWaiters.add(onExit);
      });
    };

    let disposed = false;
    const dispose = async () => {
      if (disposed) return;
      disposed = true;
      if (!exited) {
        killImpl(child, "SIGTERM");
        if (!(await waitForExit(stopTimeoutMs))) {
          killImpl(child, "SIGKILL");
          await waitForExit(stopTimeoutMs);
        }
      }
      await cleanupProfile();
    };

    try {
      const activePortPath = path.join(profileRoot, DEVTOOLS_FILE);
      const deadline = now() + startupTimeoutMs;
      while (!exited && now() <= deadline) {
        const content = await readFileImpl(activePortPath, "utf8").catch(() => null);
        const websocketUrl = content == null ? null : parseDevToolsFile(content);
        if (websocketUrl) {
          return Object.freeze({
            binary,
            websocketUrl,
            dispose,
          });
        }
        await delayImpl(50);
      }
      throw adapterError(
        "PROJECT_BROWSER_QA_ADAPTER_UNAVAILABLE",
        exited
          ? "受控本机浏览器在启动期间退出"
          : "等待受控本机浏览器启动超时",
        503,
        true,
      );
    } catch (error) {
      await dispose();
      if (error instanceof ProjectWorkError) throw error;
      throw adapterError(
        "PROJECT_BROWSER_QA_ADAPTER_UNAVAILABLE",
        "无法建立受控本机浏览器会话",
        503,
        true,
      );
    }
  };

  return Object.freeze({ launch });
}

function webSocketText(data) {
  if (typeof data === "string") return Promise.resolve(data);
  if (data instanceof ArrayBuffer) {
    return Promise.resolve(Buffer.from(data).toString("utf8"));
  }
  if (ArrayBuffer.isView(data)) {
    return Promise.resolve(
      Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8"),
    );
  }
  if (typeof data?.text === "function") return data.text();
  return Promise.resolve(String(data));
}

export async function connectChromiumCdp(websocketUrl, {
  WebSocketImpl = globalThis.WebSocket,
  commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
} = {}) {
  let endpoint;
  try {
    endpoint = new URL(websocketUrl);
  } catch {
    endpoint = null;
  }
  if (
    !endpoint
    || endpoint.protocol !== "ws:"
    || endpoint.hostname !== "127.0.0.1"
    || !endpoint.port
    || endpoint.username
    || endpoint.password
    || endpoint.search
    || endpoint.hash
    || !DEVTOOLS_PATH_PATTERN.test(endpoint.pathname)
  ) {
    throw adapterError(
      "PROJECT_BROWSER_QA_ADAPTER_UNAVAILABLE",
      "受控浏览器协议地址无效",
      503,
      true,
    );
  }
  if (typeof WebSocketImpl !== "function") {
    throw adapterError(
      "PROJECT_BROWSER_QA_ADAPTER_UNAVAILABLE",
      "当前 Node.js 运行时不支持受控浏览器协议",
      503,
      true,
    );
  }
  let socket;
  try {
    socket = new WebSocketImpl(websocketUrl);
  } catch {
    throw adapterError(
      "PROJECT_BROWSER_QA_ADAPTER_UNAVAILABLE",
      "无法连接受控本机浏览器",
      503,
      true,
    );
  }

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(adapterError(
        "PROJECT_BROWSER_QA_ADAPTER_UNAVAILABLE",
        "连接受控本机浏览器超时",
        503,
        true,
      ));
    }, commandTimeoutMs);
    timer.unref?.();
    const settle = (callback) => (event) => {
      clearTimeout(timer);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
      callback(event);
    };
    const onOpen = settle(resolve);
    const onError = settle(() => reject(adapterError(
      "PROJECT_BROWSER_QA_ADAPTER_UNAVAILABLE",
      "无法连接受控本机浏览器",
      503,
      true,
    )));
    const onClose = settle(() => reject(adapterError(
      "PROJECT_BROWSER_QA_ADAPTER_UNAVAILABLE",
      "受控本机浏览器连接已关闭",
      503,
      true,
    )));
    socket.addEventListener("open", onOpen, { once: true });
    socket.addEventListener("error", onError, { once: true });
    socket.addEventListener("close", onClose, { once: true });
  });

  let nextId = 0;
  let closed = false;
  const pending = new Map();
  const listeners = new Map();
  const listenerKey = (method, sessionId) => `${sessionId ?? ""}\n${method}`;

  const rejectPending = () => {
    if (closed) return;
    closed = true;
    const error = adapterError(
      "PROJECT_BROWSER_QA_PROTOCOL_CLOSED",
      "受控浏览器协议连接已关闭",
    );
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };

  socket.addEventListener("close", rejectPending);
  socket.addEventListener("error", rejectPending);
  socket.addEventListener("message", (event) => {
    void webSocketText(event.data).then((text) => {
      if (Buffer.byteLength(text, "utf8") > MAX_CDP_MESSAGE_BYTES) {
        rejectPending();
        socket.close();
        return;
      }
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        return;
      }
      if (Number.isInteger(message.id)) {
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) {
          request.reject(adapterError(
            "PROJECT_BROWSER_QA_PROTOCOL_FAILED",
            `受控浏览器命令失败：${request.method}`,
          ));
        } else {
          request.resolve(message.result ?? {});
        }
        return;
      }
      if (typeof message.method !== "string") return;
      const callbacks = listeners.get(
        listenerKey(message.method, message.sessionId),
      );
      for (const callback of [...(callbacks ?? [])]) {
        queueMicrotask(() => {
          try {
            Promise.resolve(callback(message.params ?? {})).catch(() => {});
          } catch {
            // Adapter handlers surface their own bounded failure state.
          }
        });
      }
    }).catch(() => {});
  });

  const send = (method, params = {}, sessionId = null) => {
    if (closed) {
      return Promise.reject(adapterError(
        "PROJECT_BROWSER_QA_PROTOCOL_CLOSED",
        "受控浏览器协议连接已关闭",
      ));
    }
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(adapterError(
          "PROJECT_BROWSER_QA_PROTOCOL_TIMEOUT",
          `等待受控浏览器命令超时：${method}`,
        ));
      }, commandTimeoutMs);
      timer.unref?.();
      pending.set(id, { method, resolve, reject, timer });
      try {
        socket.send(JSON.stringify({
          id,
          method,
          params,
          ...(sessionId == null ? {} : { sessionId }),
        }));
      } catch {
        pending.delete(id);
        clearTimeout(timer);
        reject(adapterError(
          "PROJECT_BROWSER_QA_PROTOCOL_CLOSED",
          "无法发送受控浏览器命令",
        ));
      }
    });
  };

  const on = (method, callback, sessionId = null) => {
    const key = listenerKey(method, sessionId);
    const callbacks = listeners.get(key) ?? new Set();
    callbacks.add(callback);
    listeners.set(key, callbacks);
    return () => {
      callbacks.delete(callback);
      if (!callbacks.size) listeners.delete(key);
    };
  };

  const waitForEvent = (
    method,
    { sessionId = null, timeoutMs = commandTimeoutMs, predicate } = {},
  ) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(adapterError(
        "PROJECT_BROWSER_QA_PROTOCOL_TIMEOUT",
        `等待受控浏览器事件超时：${method}`,
      ));
    }, timeoutMs);
    timer.unref?.();
    const unsubscribe = on(method, (params) => {
      if (typeof predicate === "function" && !predicate(params)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(params);
    }, sessionId);
  });

  const close = () => {
    if (!closed) socket.close();
    rejectPending();
    listeners.clear();
  };

  return Object.freeze({ send, on, waitForEvent, close });
}

function pushBounded(collection, value) {
  if (collection.length < MAX_CAPTURED_EVENTS) collection.push(value);
}

function boundedString(value, maximum = MAX_EVENT_TEXT_LENGTH) {
  return String(value ?? "").slice(0, maximum);
}

function remoteValueText(value) {
  if (value == null) return "";
  if (Object.hasOwn(value, "value")) {
    if (typeof value.value === "string") return boundedString(value.value);
    try {
      return boundedString(JSON.stringify(value.value));
    } catch {
      return boundedString(value.value);
    }
  }
  return boundedString(value.description ?? value.type ?? "");
}

function axValue(node, field) {
  const value = node?.[field]?.value;
  return typeof value === "string" ? value.trim() : "";
}

function summarizeAccessibility(nodes) {
  const counts = new Map();
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (node?.ignored === true) continue;
    const role = axValue(node, "role").toLowerCase();
    const name = axValue(node, "name");
    let issueId = null;
    if (INTERACTIVE_AX_ROLES.has(role) && !name) issueId = "interactive-name";
    else if (role === "img" && !name) issueId = "image-name";
    else if (role === "heading" && !name) issueId = "heading-name";
    if (issueId) counts.set(issueId, (counts.get(issueId) ?? 0) + 1);
  }
  const definitions = {
    "interactive-name": {
      severity: "serious",
      message: "交互控件缺少可访问名称",
    },
    "image-name": {
      severity: "moderate",
      message: "图片缺少可访问名称",
    },
    "heading-name": {
      severity: "moderate",
      message: "标题缺少可访问名称",
    },
  };
  return {
    checkedNodeCount: Array.isArray(nodes) ? nodes.length : 0,
    issues: [...counts].map(([id, count]) => ({
      id,
      count,
      ...definitions[id],
    })),
  };
}

function indexedString(strings, index) {
  return Number.isInteger(index) && typeof strings[index] === "string"
    ? strings[index]
    : "";
}

function attributesForNode(strings, indexes) {
  const result = new Map();
  if (!Array.isArray(indexes)) return result;
  for (let offset = 0; offset + 1 < indexes.length; offset += 2) {
    result.set(
      indexedString(strings, indexes[offset]).toLowerCase(),
      indexedString(strings, indexes[offset + 1]).toLowerCase(),
    );
  }
  return result;
}

function summarizeDomSnapshot(snapshot) {
  const strings = Array.isArray(snapshot?.strings) ? snapshot.strings : [];
  const documents = Array.isArray(snapshot?.documents) ? snapshot.documents : [];
  if (!documents.length || !strings.length) {
    throw adapterError(
      "PROJECT_BROWSER_QA_CAPTURE_FAILED",
      "无法读取受管预览的 DOM 摘要",
    );
  }
  const summary = {
    title: indexedString(strings, documents[0]?.title),
    language: indexedString(strings, documents[0]?.contentLanguage),
    nodeCount: 0,
    landmarkCount: 0,
    headingCount: 0,
    interactiveCount: 0,
    imageCount: 0,
    tableCount: 0,
    formCount: 0,
    credentialInputCount: 0,
    fileInputCount: 0,
  };
  const landmarkTags = new Set(["MAIN", "NAV", "HEADER", "FOOTER", "ASIDE"]);
  const landmarkRoles = new Set([
    "main",
    "navigation",
    "banner",
    "contentinfo",
    "complementary",
  ]);
  for (const document of documents) {
    const names = document?.nodes?.nodeName ?? [];
    const attributeIndexes = document?.nodes?.attributes ?? [];
    for (let index = 0; index < names.length; index += 1) {
      const tag = indexedString(strings, names[index]).toUpperCase();
      if (!tag || tag.startsWith("#")) continue;
      summary.nodeCount += 1;
      const attributes = attributesForNode(strings, attributeIndexes[index]);
      const role = attributes.get("role") ?? "";
      const type = attributes.get("type") ?? "";
      const autocomplete = attributes.get("autocomplete") ?? "";
      if (landmarkTags.has(tag) || landmarkRoles.has(role)) {
        summary.landmarkCount += 1;
      }
      if (/^H[1-6]$/.test(tag) || role === "heading") {
        summary.headingCount += 1;
      }
      if (
        ["BUTTON", "INPUT", "SELECT", "TEXTAREA"].includes(tag)
        || (tag === "A" && attributes.has("href"))
        || INTERACTIVE_AX_ROLES.has(role)
      ) {
        summary.interactiveCount += 1;
      }
      if (tag === "IMG" || tag === "SVG" || role === "img") {
        summary.imageCount += 1;
      }
      if (tag === "TABLE" || role === "table" || role === "grid") {
        summary.tableCount += 1;
      }
      if (tag === "FORM") summary.formCount += 1;
      if (
        tag === "INPUT"
        && (
          type === "password"
          || ["current-password", "new-password", "username"].includes(
            autocomplete,
          )
        )
      ) {
        summary.credentialInputCount += 1;
      }
      if (tag === "INPUT" && type === "file") summary.fileInputCount += 1;
      if (!summary.language && tag === "HTML") {
        summary.language = attributes.get("lang") ?? "";
      }
    }
  }
  return summary;
}

function frameUrls(frameTree, urls = []) {
  const url = frameTree?.frame?.url;
  if (typeof url === "string") urls.push(url);
  for (const child of frameTree?.childFrames ?? []) frameUrls(child, urls);
  return urls;
}

async function waitForNetworkIdle({
  inflight,
  delayImpl,
  now,
  idleMs,
  timeoutMs,
}) {
  const deadline = now() + timeoutMs;
  let idleSince = null;
  while (now() <= deadline) {
    if (inflight.size === 0) {
      idleSince ??= now();
      if (now() - idleSince >= idleMs) return;
    } else {
      idleSince = null;
    }
    await delayImpl(Math.min(50, Math.max(1, idleMs)));
  }
}

export function createChromiumCdpBrowserQaAdapter({
  launcher = createFixedChromiumLauncher(),
  connect = connectChromiumCdp,
  delayImpl = delay,
  now = () => Date.now(),
  pageTimeoutMs = DEFAULT_PAGE_TIMEOUT_MS,
  networkIdleMs = DEFAULT_NETWORK_IDLE_MS,
  networkSettleTimeoutMs = DEFAULT_NETWORK_SETTLE_TIMEOUT_MS,
} = {}) {
  const inspect = async ({ target, profiles, policy }) => {
    let launched;
    let connection;
    let browserContextId = null;
    let mainTargetId = null;
    let mainSessionId = null;
    const unsubscribers = [];
    const consoleEntries = [];
    const failedRequests = [];
    const requestMetadata = new Map();
    const recordedWebsocketRequestIds = new Set();
    const inflight = new Set();
    const handlerTasks = new Set();
    let handlerError = null;

    const guardHandler = (handler) => (params) => {
      const task = Promise.resolve()
        .then(() => handler(params))
        .catch((error) => {
          handlerError ??= error;
        });
      handlerTasks.add(task);
      void task.finally(() => handlerTasks.delete(task));
    };
    const throwIfHandlerFailed = () => {
      if (!handlerError) return;
      if (handlerError instanceof ProjectWorkError) throw handlerError;
      throw adapterError(
        "PROJECT_BROWSER_QA_PROTOCOL_FAILED",
        "受控浏览器安全策略执行失败",
      );
    };
    const drainHandlers = async () => {
      while (handlerTasks.size) {
        await Promise.allSettled([...handlerTasks]);
      }
      throwIfHandlerFailed();
    };

    try {
      launched = await launcher.launch();
      connection = await connect(launched.websocketUrl);

      await connection.send("Browser.getVersion");
      const browserContext = await connection.send(
        "Target.createBrowserContext",
        { disposeOnDetach: true },
      );
      if (
        typeof browserContext.browserContextId !== "string"
        || !browserContext.browserContextId
      ) {
        throw adapterError(
          "PROJECT_BROWSER_QA_PROTOCOL_FAILED",
          "受控浏览器未返回隔离上下文",
        );
      }
      browserContextId = browserContext.browserContextId;
      await connection.send("Browser.setDownloadBehavior", {
        behavior: "deny",
        browserContextId,
        eventsEnabled: true,
      });
      const created = await connection.send("Target.createTarget", {
        url: "about:blank",
        browserContextId,
      });
      if (typeof created.targetId !== "string" || !created.targetId) {
        throw adapterError(
          "PROJECT_BROWSER_QA_PROTOCOL_FAILED",
          "受控浏览器未返回页面标识",
        );
      }
      mainTargetId = created.targetId;
      const attached = await connection.send("Target.attachToTarget", {
        targetId: mainTargetId,
        flatten: true,
      });
      if (typeof attached.sessionId !== "string" || !attached.sessionId) {
        throw adapterError(
          "PROJECT_BROWSER_QA_PROTOCOL_FAILED",
          "受控浏览器未返回页面会话",
        );
      }
      mainSessionId = attached.sessionId;
      const sendPage = (method, params = {}) => (
        connection.send(method, params, mainSessionId)
      );
      const existingTargets = await connection.send("Target.getTargets");
      for (const targetInfo of existingTargets.targetInfos ?? []) {
        if (
          targetInfo?.type === "page"
          && targetInfo.targetId !== mainTargetId
        ) {
          await connection.send("Target.closeTarget", {
            targetId: targetInfo.targetId,
          });
        }
      }

      unsubscribers.push(connection.on(
        "Target.attachedToTarget",
        guardHandler(async ({ sessionId, targetInfo }) => {
          if (targetInfo?.targetId === mainTargetId) return;
          if (targetInfo?.type === "page") {
            policy.authorizePopup(targetInfo.url ?? "");
          }
          if (typeof targetInfo?.targetId === "string") {
            await connection.send("Target.closeTarget", {
              targetId: targetInfo.targetId,
            });
          }
          if (typeof sessionId === "string") {
            await connection.send("Target.detachFromTarget", { sessionId });
          }
        }),
        mainSessionId,
      ));
      unsubscribers.push(connection.on(
        "Browser.downloadWillBegin",
        guardHandler(async ({ guid, url }) => {
          policy.authorizeDownload(url ?? "");
          if (typeof guid === "string") {
            await connection.send("Browser.cancelDownload", { guid });
          }
        }),
      ));

      unsubscribers.push(connection.on(
        "Fetch.requestPaused",
        guardHandler(async (event) => {
          const request = event.request ?? {};
          const navigation = event.resourceType === "Document"
            ? policy.authorizeNavigation(request.url)
            : { allowed: true };
          const resource = policy.authorizeRequest({
            url: request.url,
            method: request.method,
            resourceType: String(event.resourceType ?? "").toLowerCase(),
          });
          if (navigation.allowed && resource.allowed) {
            await sendPage("Fetch.continueRequest", {
              requestId: event.requestId,
            });
            return;
          }
          pushBounded(failedRequests, {
            url: boundedString(request.url, MAX_EVENT_URL_LENGTH),
            method: boundedString(request.method, 20),
            resourceType: boundedString(event.resourceType, 60),
            reason: boundedString(
              navigation.allowed ? resource.reason : navigation.reason,
              300,
            ),
          });
          await sendPage("Fetch.failRequest", {
            requestId: event.requestId,
            errorReason: "BlockedByClient",
          });
        }),
        mainSessionId,
      ));
      unsubscribers.push(connection.on(
        "Fetch.authRequired",
        guardHandler(async (event) => {
          policy.authorizeInteraction("credential_input");
          await sendPage("Fetch.continueWithAuth", {
            requestId: event.requestId,
            authChallengeResponse: { response: "CancelAuth" },
          });
        }),
        mainSessionId,
      ));
      unsubscribers.push(connection.on(
        "Page.fileChooserOpened",
        () => {
          policy.authorizeInteraction("file_upload");
        },
        mainSessionId,
      ));
      unsubscribers.push(connection.on(
        "Page.javascriptDialogOpening",
        guardHandler(async () => {
          policy.authorizeInteraction("javascript_dialog");
          await sendPage("Page.handleJavaScriptDialog", {
            accept: false,
          });
        }),
        mainSessionId,
      ));
      unsubscribers.push(connection.on(
        "Page.windowOpen",
        ({ url }) => {
          policy.authorizePopup(url ?? "");
        },
        mainSessionId,
      ));

      unsubscribers.push(connection.on(
        "Network.requestWillBeSent",
        (event) => {
          if (typeof event.requestId !== "string") return;
          requestMetadata.set(event.requestId, {
            url: boundedString(event.request?.url, MAX_EVENT_URL_LENGTH),
            method: boundedString(event.request?.method, 20),
            resourceType: boundedString(event.type, 60),
          });
          if (event.type !== "WebSocket") inflight.add(event.requestId);
        },
        mainSessionId,
      ));
      unsubscribers.push(connection.on(
        "Network.loadingFinished",
        ({ requestId }) => {
          inflight.delete(requestId);
          requestMetadata.delete(requestId);
          recordedWebsocketRequestIds.delete(requestId);
        },
        mainSessionId,
      ));
      unsubscribers.push(connection.on(
        "Network.loadingFailed",
        (event) => {
          inflight.delete(event.requestId);
          const metadata = requestMetadata.get(event.requestId) ?? {};
          requestMetadata.delete(event.requestId);
          const websocketFailure = String(
            event.type ?? metadata.resourceType ?? "",
          ).toLowerCase() === "websocket";
          if (
            websocketFailure
            && recordedWebsocketRequestIds.has(event.requestId)
          ) {
            recordedWebsocketRequestIds.delete(event.requestId);
            return;
          }
          const authorization = websocketFailure && metadata.url
            ? policy.authorizeRequest({
                url: metadata.url,
                method: metadata.method ?? "GET",
                resourceType: "websocket",
              })
            : null;
          pushBounded(failedRequests, {
            ...metadata,
            resourceType: boundedString(
              event.type ?? metadata.resourceType,
              60,
            ),
            reason: boundedString(
              authorization?.reason
                ?? (websocketFailure ? "websocket_disabled" : null)
                ?? event.blockedReason
                ?? event.errorText
                ?? "request_failed",
              300,
            ),
          });
        },
        mainSessionId,
      ));
      unsubscribers.push(connection.on(
        "Network.responseReceived",
        (event) => {
          if ((event.response?.status ?? 0) < 400) return;
          const metadata = requestMetadata.get(event.requestId) ?? {};
          pushBounded(failedRequests, {
            ...metadata,
            url: boundedString(
              event.response?.url ?? metadata.url,
              MAX_EVENT_URL_LENGTH,
            ),
            resourceType: boundedString(
              event.type ?? metadata.resourceType,
              60,
            ),
            reason: `http_${event.response.status}`,
          });
        },
        mainSessionId,
      ));
      unsubscribers.push(connection.on(
        "Network.webSocketCreated",
        ({ requestId, url }) => {
          const authorization = policy.authorizeRequest({
            url,
            method: "GET",
            resourceType: "websocket",
          });
          pushBounded(failedRequests, {
            url: boundedString(url, MAX_EVENT_URL_LENGTH),
            method: "GET",
            resourceType: "websocket",
            reason: boundedString(
              authorization.reason ?? "websocket_disabled",
              300,
            ),
          });
          if (typeof requestId === "string") {
            recordedWebsocketRequestIds.add(requestId);
          }
          if (authorization.allowed) {
            handlerError ??= adapterError(
              "PROJECT_BROWSER_QA_POLICY_FAILED",
              "受控浏览器的 WebSocket 禁用策略未生效",
            );
          }
        },
        mainSessionId,
      ));
      const rejectWebsocketHandshake = () => {
        handlerError ??= adapterError(
          "PROJECT_BROWSER_QA_WEBSOCKET_HANDSHAKE",
          "受控浏览器检测到被禁止的 WebSocket 握手",
        );
      };
      unsubscribers.push(connection.on(
        "Network.webSocketWillSendHandshakeRequest",
        rejectWebsocketHandshake,
        mainSessionId,
      ));
      unsubscribers.push(connection.on(
        "Network.webSocketHandshakeResponseReceived",
        rejectWebsocketHandshake,
        mainSessionId,
      ));
      unsubscribers.push(connection.on(
        "Page.frameNavigated",
        ({ frame }) => {
          if (
            typeof frame?.url !== "string"
            || frame.url === "about:blank"
            || frame.url === "about:srcdoc"
          ) {
            return;
          }
          const authorization = policy.authorizeNavigation(frame.url);
          if (!authorization.allowed) {
            handlerError ??= adapterError(
              "PROJECT_BROWSER_QA_EXTERNAL_NAVIGATION",
              "受管预览发生了越界导航",
            );
          }
        },
        mainSessionId,
      ));
      unsubscribers.push(connection.on(
        "Inspector.detached",
        () => {
          handlerError ??= adapterError(
            "PROJECT_BROWSER_QA_PROTOCOL_CLOSED",
            "受控浏览器页面会话已断开",
          );
        },
        mainSessionId,
      ));
      unsubscribers.push(connection.on(
        "Target.targetCrashed",
        ({ targetId }) => {
          if (targetId !== mainTargetId) return;
          handlerError ??= adapterError(
            "PROJECT_BROWSER_QA_CAPTURE_FAILED",
            "受控浏览器页面已崩溃",
          );
        },
      ));
      unsubscribers.push(connection.on(
        "Runtime.consoleAPICalled",
        (event) => {
          const frame = event.stackTrace?.callFrames?.[0];
          pushBounded(consoleEntries, {
            level: event.type,
            text: boundedString(
              (event.args ?? []).map(remoteValueText).join(" "),
            ),
            url: boundedString(
              frame?.url ?? target.url,
              MAX_EVENT_URL_LENGTH,
            ),
          });
        },
        mainSessionId,
      ));
      unsubscribers.push(connection.on(
        "Runtime.exceptionThrown",
        ({ exceptionDetails }) => {
          pushBounded(consoleEntries, {
            level: "error",
            text: boundedString(
              exceptionDetails?.exception?.description
                ?? exceptionDetails?.text
                ?? "Uncaught exception",
            ),
            url: boundedString(
              exceptionDetails?.url ?? target.url,
              MAX_EVENT_URL_LENGTH,
            ),
          });
        },
        mainSessionId,
      ));
      unsubscribers.push(connection.on(
        "Log.entryAdded",
        ({ entry }) => {
          pushBounded(consoleEntries, {
            level: entry?.level,
            text: boundedString(entry?.text),
            url: boundedString(
              entry?.url ?? target.url,
              MAX_EVENT_URL_LENGTH,
            ),
          });
        },
        mainSessionId,
      ));

      await sendPage("Page.enable");
      await sendPage("Runtime.enable");
      await sendPage("Network.enable");
      await sendPage("Network.setBlockedURLs", {
        urls: ["ws://*", "wss://*"],
      });
      await sendPage("Network.setCacheDisabled", { cacheDisabled: true });
      await sendPage("Network.setBypassServiceWorker", { bypass: true });
      await sendPage("Log.enable");
      await sendPage("Accessibility.enable");
      await sendPage("Page.setLifecycleEventsEnabled", { enabled: true });
      await sendPage("Page.setInterceptFileChooserDialog", { enabled: true });
      await sendPage("Fetch.enable", {
        patterns: [{ urlPattern: "*", requestStage: "Request" }],
        handleAuthRequests: true,
      });
      await sendPage("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
      });

      const captures = [];
      for (const profile of profiles) {
        await sendPage("Emulation.setDeviceMetricsOverride", {
          width: profile.width,
          height: profile.height,
          deviceScaleFactor: profile.deviceScaleFactor,
          mobile: profile.isMobile,
          screenWidth: profile.width,
          screenHeight: profile.height,
        });
        await sendPage("Emulation.setTouchEmulationEnabled", {
          enabled: profile.isMobile,
          ...(profile.isMobile ? { maxTouchPoints: 5 } : {}),
        });
        await sendPage("Emulation.setEmulatedMedia", {
          features: [{
            name: "prefers-reduced-motion",
            value: "reduce",
          }],
        });
        const loadEvent = connection.waitForEvent("Page.loadEventFired", {
          sessionId: mainSessionId,
          timeoutMs: pageTimeoutMs,
        });
        const navigation = await sendPage("Page.navigate", {
          url: target.url,
          transitionType: "reload",
        });
        if (navigation.errorText) {
          throw adapterError(
            "PROJECT_BROWSER_QA_NAVIGATION_FAILED",
            "受管本地预览无法加载",
          );
        }
        await loadEvent;
        await waitForNetworkIdle({
          inflight,
          delayImpl,
          now,
          idleMs: networkIdleMs,
          timeoutMs: networkSettleTimeoutMs,
        });
        await drainHandlers();
        const frameTree = await sendPage("Page.getFrameTree");
        const urls = frameUrls(frameTree.frameTree);
        if (!urls.length) {
          throw adapterError(
            "PROJECT_BROWSER_QA_PROTOCOL_FAILED",
            "受控浏览器未返回页面结构",
          );
        }
        for (const frameUrl of urls) {
          if (frameUrl === "about:blank" || frameUrl === "about:srcdoc") continue;
          if (!policy.authorizeNavigation(frameUrl).allowed) {
            throw adapterError(
              "PROJECT_BROWSER_QA_EXTERNAL_NAVIGATION",
              "受管预览发生了越界导航",
            );
          }
        }

        const [screenshot, domSnapshot, accessibility] = await Promise.all([
          sendPage("Page.captureScreenshot", {
            format: "png",
            fromSurface: true,
            captureBeyondViewport: false,
          }),
          sendPage("DOMSnapshot.captureSnapshot", {
            computedStyles: [],
            includePaintOrder: false,
            includeDOMRects: false,
          }),
          sendPage("Accessibility.getFullAXTree"),
        ]);
        if (
          typeof screenshot.data !== "string"
        ) {
          throw adapterError(
            "PROJECT_BROWSER_QA_CAPTURE_FAILED",
            "无法采集受管预览证据",
          );
        }
        captures.push({
          profileId: profile.id,
          screenshot: { bytes: Buffer.from(screenshot.data, "base64") },
          dom: summarizeDomSnapshot(domSnapshot),
          accessibility: summarizeAccessibility(accessibility.nodes),
        });
      }
      await drainHandlers();

      return {
        captures,
        console: consoleEntries,
        failedRequests,
      };
    } finally {
      for (const unsubscribe of unsubscribers.reverse()) unsubscribe();
      if (connection && mainTargetId) {
        await connection.send("Target.closeTarget", {
          targetId: mainTargetId,
        }).catch(() => {});
      }
      if (connection && browserContextId) {
        await connection.send("Target.disposeBrowserContext", {
          browserContextId,
        }).catch(() => {});
      }
      connection?.close();
      await launched?.dispose?.();
    }
  };

  return Object.freeze({
    id: "chromium-cdp",
    available: true,
    inspect,
  });
}
