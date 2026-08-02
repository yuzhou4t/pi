import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  connectChromiumCdp,
  createChromiumCdpBrowserQaAdapter,
  createFixedChromiumLauncher,
} from "./chromiumCdpBrowserQaAdapter.js";
import {
  BROWSER_QA_PROFILES,
  createPreviewBrowserQaPolicy,
} from "./browserQaService.js";

function fakeChild(pid = 60_001) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stderr = new PassThrough();
  child.kill = () => true;
  return child;
}

function png(width, height) {
  const bytes = Buffer.alloc(24);
  Buffer.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
  ]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

test("fixed Chromium launcher uses only server-owned argv and cleans its exact temp profile", async () => {
  const binary = "/Applications/Chromium.app/Contents/MacOS/Chromium";
  const profileRoot = path.join(os.tmpdir(), "pi-agent-browser-qa-test");
  const child = fakeChild();
  const spawns = [];
  const removals = [];
  const signals = [];
  const launcher = createFixedChromiumLauncher({
    resolveBinary: async () => binary,
    mkdtempImpl: async (prefix) => {
      assert.equal(prefix, path.join(os.tmpdir(), "pi-agent-browser-qa-"));
      return profileRoot;
    },
    readFileImpl: async (filePath, encoding) => {
      assert.equal(filePath, path.join(profileRoot, "DevToolsActivePort"));
      assert.equal(encoding, "utf8");
      return "49123\n/devtools/browser/fixed-test-id\n";
    },
    spawnImpl: (file, args, options) => {
      spawns.push({ file, args, options });
      return child;
    },
    killImpl: (ownedChild, signal) => {
      signals.push({ pid: ownedChild.pid, signal });
      queueMicrotask(() => ownedChild.emit("close", null, signal));
    },
    rmImpl: async (...args) => removals.push(args),
  });

  const launched = await launcher.launch();

  assert.equal(launched.binary, binary);
  assert.equal(
    launched.websocketUrl,
    "ws://127.0.0.1:49123/devtools/browser/fixed-test-id",
  );
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].file, binary);
  assert.equal(spawns[0].options.shell, false);
  assert.equal(spawns[0].options.detached, true);
  assert.deepEqual(spawns[0].options.stdio, ["ignore", "ignore", "pipe"]);
  assert.equal(spawns[0].options.env.HOME, undefined);
  assert.equal(spawns[0].options.env.OPENAI_API_KEY, undefined);
  assert.equal(
    spawns[0].args.includes("--remote-debugging-address=127.0.0.1"),
    true,
  );
  assert.equal(spawns[0].args.includes("--remote-debugging-port=0"), true);
  assert.equal(
    spawns[0].args.includes(`--user-data-dir=${profileRoot}`),
    true,
  );
  assert.equal(spawns[0].args.at(-1), "about:blank");
  assert.equal(spawns[0].args.some((arg) => /no-sandbox/.test(arg)), false);
  assert.equal(
    spawns[0].args.some((arg) => /ignore-certificate-errors/.test(arg)),
    false,
  );
  assert.equal(
    spawns[0].args.some((arg) => /disable-web-security/.test(arg)),
    false,
  );
  assert.equal(
    spawns[0].args.some(
      (arg) => arg.includes("http://") || arg.includes("https://"),
    ),
    false,
  );

  await launched.dispose();
  assert.deepEqual(signals, [{ pid: child.pid, signal: "SIGTERM" }]);
  assert.deepEqual(removals, [[
    profileRoot,
    { recursive: true, force: true },
  ]]);
});

test("fixed Chromium launcher rejects an injected project browser path", async () => {
  let spawned = false;
  const launcher = createFixedChromiumLauncher({
    resolveBinary: async () => "/tmp/project/chromium",
    spawnImpl: () => {
      spawned = true;
      return fakeChild();
    },
  });
  await assert.rejects(
    launcher.launch(),
    { code: "PROJECT_BROWSER_QA_ADAPTER_UNAVAILABLE" },
  );
  assert.equal(spawned, false);
});

test("CDP connection sends flat-session commands and routes bounded events", async () => {
  class FakeWebSocket {
    static instance;

    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      this.sent = [];
      FakeWebSocket.instance = this;
      queueMicrotask(() => this.emit("open", {}));
    }

    addEventListener(type, callback) {
      const callbacks = this.listeners.get(type) ?? new Set();
      callbacks.add(callback);
      this.listeners.set(type, callbacks);
    }

    removeEventListener(type, callback) {
      this.listeners.get(type)?.delete(callback);
    }

    emit(type, event) {
      for (const callback of [...(this.listeners.get(type) ?? [])]) {
        callback(event);
      }
    }

    send(raw) {
      const message = JSON.parse(raw);
      this.sent.push(message);
      queueMicrotask(() => {
        this.emit("message", {
          data: JSON.stringify({
            id: message.id,
            sessionId: message.sessionId,
            result: { acknowledged: true },
          }),
        });
      });
    }

    close() {
      queueMicrotask(() => this.emit("close", {}));
    }
  }

  const connection = await connectChromiumCdp(
    "ws://127.0.0.1:49123/devtools/browser/test",
    { WebSocketImpl: FakeWebSocket, commandTimeoutMs: 100 },
  );
  const events = [];
  connection.on(
    "Runtime.consoleAPICalled",
    (event) => events.push(event),
    "session-1",
  );
  const result = await connection.send(
    "Page.enable",
    { enabled: true },
    "session-1",
  );
  FakeWebSocket.instance.emit("message", {
    data: JSON.stringify({
      method: "Runtime.consoleAPICalled",
      sessionId: "session-1",
      params: { type: "log" },
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(result, { acknowledged: true });
  assert.deepEqual(FakeWebSocket.instance.sent, [{
    id: 1,
    method: "Page.enable",
    params: { enabled: true },
    sessionId: "session-1",
  }]);
  assert.deepEqual(events, [{ type: "log" }]);
  connection.close();
});

test("CDP connection rejects non-loopback and credential-bearing endpoints", async () => {
  for (const url of [
    "ws://external.example:49123/devtools/browser/test",
    "wss://127.0.0.1:49123/devtools/browser/test",
    "ws://user:secret@127.0.0.1:49123/devtools/browser/test",
    "ws://127.0.0.1:49123/devtools/page/test",
  ]) {
    await assert.rejects(
      connectChromiumCdp(url, { WebSocketImpl: class {} }),
      { code: "PROJECT_BROWSER_QA_ADAPTER_UNAVAILABLE" },
    );
  }
});

class FakeCdpConnection {
  constructor() {
    this.calls = [];
    this.listeners = new Map();
    this.viewport = { width: 1_440, height: 1_024 };
    this.navigateCount = 0;
    this.closed = false;
  }

  key(method, sessionId) {
    return `${sessionId ?? ""}\n${method}`;
  }

  on(method, callback, sessionId = null) {
    const key = this.key(method, sessionId);
    const callbacks = this.listeners.get(key) ?? new Set();
    callbacks.add(callback);
    this.listeners.set(key, callbacks);
    return () => callbacks.delete(callback);
  }

  async emit(method, params, sessionId = null) {
    for (const callback of [
      ...(this.listeners.get(this.key(method, sessionId)) ?? []),
    ]) {
      callback(params);
    }
    await new Promise((resolve) => setImmediate(resolve));
  }

  waitForEvent(method, options) {
    this.calls.push({
      method: `wait:${method}`,
      params: options,
      sessionId: options?.sessionId ?? null,
    });
    return Promise.resolve({});
  }

  async send(method, params = {}, sessionId = null) {
    this.calls.push({ method, params, sessionId });
    if (method === "Browser.getVersion") {
      return { product: "Chrome/140.0.0.0" };
    }
    if (method === "Target.createBrowserContext") {
      return { browserContextId: "context-1" };
    }
    if (method === "Target.createTarget") return { targetId: "target-main" };
    if (method === "Target.attachToTarget") {
      return { sessionId: "session-main" };
    }
    if (method === "Target.getTargets") {
      return {
        targetInfos: [
          { targetId: "startup-page", type: "page" },
          { targetId: "target-main", type: "page" },
        ],
      };
    }
    if (method === "Emulation.setDeviceMetricsOverride") {
      this.viewport = {
        width: params.width,
        height: params.height,
      };
      return {};
    }
    if (method === "Page.navigate") {
      this.navigateCount += 1;
      await this.emit("Fetch.requestPaused", {
        requestId: `document-${this.navigateCount}`,
        resourceType: "Document",
        request: {
          url: params.url,
          method: "GET",
        },
      }, sessionId);
      await this.emit("Fetch.requestPaused", {
        requestId: `external-${this.navigateCount}`,
        resourceType: "Script",
        request: {
          url: "https://external.example/tracker.js?token=secret",
          method: "GET",
        },
      }, sessionId);
      await this.emit("Fetch.requestPaused", {
        requestId: `post-${this.navigateCount}`,
        resourceType: "Fetch",
        request: {
          url: "http://127.0.0.1:48080/api/save",
          method: "POST",
        },
      }, sessionId);
      await this.emit("Network.requestWillBeSent", {
        requestId: `websocket-${this.navigateCount}`,
        type: "WebSocket",
        request: {
          url: "ws://127.0.0.1:48080/hmr",
          method: "GET",
        },
      }, sessionId);
      await this.emit("Network.loadingFailed", {
        requestId: `websocket-${this.navigateCount}`,
        type: "WebSocket",
        blockedReason: "inspector",
        errorText: "net::ERR_BLOCKED_BY_CLIENT",
      }, sessionId);
      await this.emit("Fetch.authRequired", {
        requestId: `auth-${this.navigateCount}`,
      }, sessionId);
      await this.emit("Page.fileChooserOpened", {}, sessionId);
      await this.emit("Page.javascriptDialogOpening", {}, sessionId);
      await this.emit("Page.windowOpen", {
        url: "https://external.example/popup",
      }, sessionId);
      await this.emit("Runtime.consoleAPICalled", {
        type: "warn",
        args: [{ type: "string", value: "warning" }],
        stackTrace: {
          callFrames: [{
            url: "http://127.0.0.1:48080/app.js?token=secret",
          }],
        },
      }, sessionId);
      await this.emit("Network.requestWillBeSent", {
        requestId: `http-error-${this.navigateCount}`,
        type: "Fetch",
        request: {
          url: "http://127.0.0.1:48080/missing",
          method: "GET",
        },
      }, sessionId);
      await this.emit("Network.responseReceived", {
        requestId: `http-error-${this.navigateCount}`,
        type: "Fetch",
        response: {
          status: 404,
          url: "http://127.0.0.1:48080/missing",
        },
      }, sessionId);
      await this.emit("Network.loadingFinished", {
        requestId: `http-error-${this.navigateCount}`,
      }, sessionId);
      await this.emit("Page.frameNavigated", {
        frame: { url: params.url },
      }, sessionId);
      await this.emit("Browser.downloadWillBegin", {
        guid: `download-${this.navigateCount}`,
        url: "http://127.0.0.1:48080/export.zip",
      });
      await this.emit("Target.attachedToTarget", {
        sessionId: `popup-session-${this.navigateCount}`,
        targetInfo: {
          targetId: `popup-${this.navigateCount}`,
          type: "page",
          url: "https://external.example/popup",
        },
      }, "session-main");
      return { frameId: "frame-main", loaderId: `loader-${this.navigateCount}` };
    }
    if (method === "Page.captureScreenshot") {
      return {
        data: png(
          this.viewport.width,
          this.viewport.height,
        ).toString("base64"),
      };
    }
    if (method === "Page.getFrameTree") {
      return {
        frameTree: {
          frame: {
            id: "frame-main",
            url: "http://127.0.0.1:48080/app/",
          },
        },
      };
    }
    if (method === "DOMSnapshot.captureSnapshot") {
      const strings = [
        "本地预览",
        "zh-CN",
        "HTML",
        "lang",
        "MAIN",
        "H1",
        "BUTTON",
        "IMG",
        "FORM",
        "INPUT",
        "type",
        "password",
        "file",
      ];
      return {
        strings,
        documents: [{
          title: 0,
          contentLanguage: 1,
          nodes: {
            nodeName: [2, 4, 5, 6, 7, 8, 9, 9],
            attributes: [
              [3, 1],
              [],
              [],
              [],
              [],
              [],
              [10, 11],
              [10, 12],
            ],
          },
        }],
      };
    }
    if (method === "Accessibility.getFullAXTree") {
      return {
        nodes: [
          { ignored: false, role: { value: "button" }, name: { value: "" } },
          { ignored: false, role: { value: "link" }, name: { value: "首页" } },
          { ignored: false, role: { value: "img" }, name: { value: "" } },
        ],
      };
    }
    return {};
  }

  close() {
    this.closed = true;
  }
}

test("Chromium adapter installs policy before navigation and captures both fixed views", async () => {
  const connection = new FakeCdpConnection();
  let disposed = false;
  const adapter = createChromiumCdpBrowserQaAdapter({
    launcher: {
      async launch() {
        return {
          websocketUrl: "ws://127.0.0.1:49123/devtools/browser/test",
          async dispose() {
            disposed = true;
          },
        };
      },
    },
    connect: async () => connection,
    networkIdleMs: 0,
    networkSettleTimeoutMs: 0,
  });
  const policy = createPreviewBrowserQaPolicy("http://127.0.0.1:48080");

  const result = await adapter.inspect({
    target: {
      url: "http://127.0.0.1:48080/app/",
      origin: "http://127.0.0.1:48080",
    },
    profiles: BROWSER_QA_PROFILES,
    policy,
  });

  const methods = connection.calls.map((call) => call.method);
  assert.ok(methods.indexOf("Browser.getVersion") >= 0);
  assert.ok(
    methods.indexOf("Target.createBrowserContext")
    < methods.indexOf("Target.createTarget"),
  );
  assert.ok(
    methods.indexOf("Browser.setDownloadBehavior")
    < methods.indexOf("Target.createTarget"),
  );
  assert.ok(methods.indexOf("Fetch.enable") < methods.indexOf("Page.navigate"));
  assert.ok(
    methods.indexOf("Page.setInterceptFileChooserDialog")
    < methods.indexOf("Page.navigate"),
  );
  assert.ok(
    methods.indexOf("Network.setBypassServiceWorker")
    < methods.indexOf("Page.navigate"),
  );
  assert.ok(
    methods.indexOf("Network.enable")
    < methods.indexOf("Network.setBlockedURLs"),
  );
  assert.ok(
    methods.indexOf("Network.setBlockedURLs")
    < methods.indexOf("Page.navigate"),
  );
  assert.deepEqual(
    connection.calls.find(
      (call) => call.method === "Network.setBlockedURLs",
    ).params,
    { urls: ["ws://*", "wss://*"] },
  );
  assert.equal(methods.some((method) => method.startsWith("Input.")), false);
  assert.equal(methods.includes("DOM.setFileInputFiles"), false);
  assert.equal(methods.includes("Runtime.evaluate"), false);
  assert.equal(
    connection.calls.find(
      (call) => call.method === "Browser.setDownloadBehavior",
    ).params.behavior,
    "deny",
  );
  assert.deepEqual(
    connection.calls.filter((call) => call.method === "Page.navigate")
      .map((call) => call.params.url),
    [
      "http://127.0.0.1:48080/app/",
      "http://127.0.0.1:48080/app/",
    ],
  );
  assert.equal(
    connection.calls.some((call) => (
      call.method === "Fetch.continueRequest"
      && call.params.requestId.startsWith("document-")
    )),
    true,
  );
  assert.equal(
    connection.calls.filter((call) => call.method === "Fetch.failRequest").length,
    4,
  );
  assert.equal(
    connection.calls.filter(
      (call) => call.method === "Fetch.continueWithAuth",
    ).length,
    2,
  );
  assert.equal(
    connection.calls.filter(
      (call) => call.method === "Page.handleJavaScriptDialog",
    ).length,
    2,
  );
  assert.equal(
    connection.calls.filter(
      (call) => call.method === "Browser.cancelDownload",
    ).length,
    2,
  );
  assert.equal(
    connection.calls.some((call) => (
      call.method === "Target.closeTarget"
      && call.params.targetId === "startup-page"
    )),
    true,
  );
  assert.deepEqual(
    result.captures.map((capture) => capture.profileId),
    ["desktop", "mobile"],
  );
  assert.equal(result.captures[0].dom.credentialInputCount, 1);
  assert.equal(result.captures[0].accessibility.issues.length, 2);
  assert.equal(result.console.length, 2);
  assert.equal(
    result.failedRequests.some((request) => request.reason === "http_404"),
    true,
  );
  assert.equal(
    result.failedRequests.some(
      (request) => request.reason === "websocket_disabled",
    ),
    true,
  );
  const audit = policy.snapshot();
  assert.ok(audit.blockedRequests >= 4);
  assert.ok(audit.blockedInteractions >= 4);
  assert.ok(audit.blockedDownloads >= 2);
  assert.ok(audit.blockedPopups >= 2);
  assert.equal(connection.closed, true);
  assert.equal(disposed, true);
  assert.equal(
    methods.at(-1),
    "Target.disposeBrowserContext",
  );
});

test("Chromium adapter never navigates when the WebSocket block cannot be installed", async () => {
  const connection = new FakeCdpConnection();
  const originalSend = connection.send.bind(connection);
  connection.send = async (method, params = {}, sessionId = null) => {
    if (method === "Network.setBlockedURLs") {
      connection.calls.push({ method, params, sessionId });
      throw new Error("blocked URL policy unavailable");
    }
    return originalSend(method, params, sessionId);
  };
  let disposed = false;
  const adapter = createChromiumCdpBrowserQaAdapter({
    launcher: {
      async launch() {
        return {
          websocketUrl: "ws://127.0.0.1:49123/devtools/browser/test",
          async dispose() {
            disposed = true;
          },
        };
      },
    },
    connect: async () => connection,
  });

  await assert.rejects(
    adapter.inspect({
      target: {
        url: "http://127.0.0.1:48080/",
        origin: "http://127.0.0.1:48080",
      },
      profiles: BROWSER_QA_PROFILES,
      policy: createPreviewBrowserQaPolicy("http://127.0.0.1:48080"),
    }),
    /blocked URL policy unavailable/,
  );
  assert.equal(
    connection.calls.some((call) => call.method === "Page.navigate"),
    false,
  );
  assert.equal(connection.closed, true);
  assert.equal(disposed, true);
});

test("Chromium adapter fails closed if a WebSocket reaches the handshake stage", async () => {
  const connection = new FakeCdpConnection();
  const originalEmit = connection.emit.bind(connection);
  connection.emit = async (method, params, sessionId = null) => {
    if (method === "Network.loadingFailed" && params.type === "WebSocket") {
      await originalEmit(method, params, sessionId);
      return originalEmit("Network.webSocketWillSendHandshakeRequest", {
        requestId: params.requestId,
        request: {
          url: "ws://127.0.0.1:48080/hmr",
        },
      }, sessionId);
    }
    return originalEmit(method, params, sessionId);
  };
  let disposed = false;
  const adapter = createChromiumCdpBrowserQaAdapter({
    launcher: {
      async launch() {
        return {
          websocketUrl: "ws://127.0.0.1:49123/devtools/browser/test",
          async dispose() {
            disposed = true;
          },
        };
      },
    },
    connect: async () => connection,
    networkIdleMs: 0,
    networkSettleTimeoutMs: 0,
  });

  await assert.rejects(
    adapter.inspect({
      target: {
        url: "http://127.0.0.1:48080/",
        origin: "http://127.0.0.1:48080",
      },
      profiles: BROWSER_QA_PROFILES,
      policy: createPreviewBrowserQaPolicy("http://127.0.0.1:48080"),
    }),
    { code: "PROJECT_BROWSER_QA_WEBSOCKET_HANDSHAKE" },
  );
  assert.equal(connection.closed, true);
  assert.equal(disposed, true);
});
