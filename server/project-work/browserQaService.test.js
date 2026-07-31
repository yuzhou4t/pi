import assert from "node:assert/strict";
import test from "node:test";
import {
  BROWSER_QA_POLICY_VERSION,
  BROWSER_QA_PROFILES,
  createPreviewBrowserQaPolicy,
  createPreviewBrowserQaService,
  createUnavailableBrowserQaAdapter,
} from "./browserQaService.js";

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

const DESKTOP_PNG = png(1_440, 1_024);
const MOBILE_PNG = png(390, 844);

function capture(profileId, overrides = {}) {
  return {
    profileId,
    screenshot: {
      bytes: profileId === "desktop" ? DESKTOP_PNG : MOBILE_PNG,
    },
    dom: {
      title: `${profileId} title`,
      language: "zh-CN",
      nodeCount: 50,
      landmarkCount: 3,
      headingCount: 4,
      interactiveCount: 8,
      imageCount: 2,
      tableCount: 1,
      formCount: 0,
      credentialInputCount: 0,
      fileInputCount: 0,
    },
    accessibility: {
      checkedNodeCount: 40,
      issues: [{
        id: "button-name",
        severity: "serious",
        count: 1,
        message: "一个按钮缺少名称",
      }],
    },
    ...overrides,
  };
}

function successfulResult() {
  return {
    captures: [
      capture("desktop"),
      capture("mobile"),
    ],
    console: [],
    failedRequests: [],
  };
}

function ownedPreview(overrides = {}) {
  return {
    ownershipToken: "lease-1",
    url: "http://127.0.0.1:48080/reader/?mode=qa",
    origin: "http://127.0.0.1:48080",
    ...overrides,
  };
}

function supervisor(preview = ownedPreview()) {
  return {
    getOwnedPreview(key) {
      return key === "conversation-1" ? preview : null;
    },
  };
}

test("browser QA accepts only a current supervisor-owned preview key", async () => {
  const adapter = {
    id: "fake",
    available: true,
    inspect: async () => {
      const result = successfulResult();
      return {
        ...result,
        captures: result.captures.map((item) => ({
          ...item,
          accessibility: {
            checkedNodeCount: 40,
            issues: [],
          },
        })),
      };
    },
  };
  const service = createPreviewBrowserQaService({
    previewSupervisor: supervisor(),
    browserAdapter: adapter,
  });

  await assert.rejects(
    service.run({
      key: "conversation-1",
      url: "http://127.0.0.1:48080/",
    }),
    { code: "PROJECT_BROWSER_QA_INPUT_INVALID" },
  );
  await assert.rejects(
    service.run({ key: "unknown" }),
    { code: "PROJECT_BROWSER_QA_PREVIEW_NOT_OWNED" },
  );

  for (const preview of [
    ownedPreview({ url: "https://127.0.0.1:48080/" }),
    ownedPreview({
      url: "http://localhost:48080/",
      origin: "http://localhost:48080",
    }),
    ownedPreview({
      url: "http://127.0.0.1:48080/#secret",
    }),
    ownedPreview({
      url: "http://user:secret@127.0.0.1:48080/",
    }),
    ownedPreview({
      url: "http://127.0.0.1:48080/",
      origin: "http://127.0.0.1:48081",
    }),
  ]) {
    const invalidService = createPreviewBrowserQaService({
      previewSupervisor: supervisor(preview),
      browserAdapter: adapter,
    });
    await assert.rejects(
      invalidService.run({ key: "conversation-1" }),
      { code: "PROJECT_BROWSER_QA_PREVIEW_INVALID" },
    );
  }

  const clean = await service.run({ key: "conversation-1" });
  assert.equal(clean.verdict, "passed");
  assert.deepEqual(clean.issueSummary, {
    consoleErrorCount: 0,
    failedRequestCount: 0,
    accessibilityIssueCount: 0,
    blockedRequestCount: 0,
    blockedNavigationCount: 0,
    blockedActionCount: 0,
  });
});

test("browser QA rejects an explicitly unavailable adapter", async () => {
  const service = createPreviewBrowserQaService({
    previewSupervisor: supervisor(),
    browserAdapter: createUnavailableBrowserQaAdapter(),
  });
  await assert.rejects(
    service.run({ key: "conversation-1" }),
    (error) => {
      assert.equal(error.code, "PROJECT_BROWSER_QA_ADAPTER_UNAVAILABLE");
      assert.equal(error.status, 503);
      assert.equal(error.retryable, true);
      return true;
    },
  );
});

test("browser policy allows only passive reads from the owned origin", () => {
  const policy = createPreviewBrowserQaPolicy("http://127.0.0.1:48080");

  assert.deepEqual(
    policy.authorizeNavigation("http://127.0.0.1:48080/next"),
    { allowed: true, reason: "owned_preview_origin" },
  );
  assert.deepEqual(
    policy.authorizeNavigation("https://example.com/login"),
    { allowed: false, reason: "external_navigation" },
  );
  assert.equal(policy.authorizeRequest({
    url: "http://127.0.0.1:48080/assets/app.js",
    method: "GET",
    resourceType: "script",
  }).allowed, true);
  assert.deepEqual(policy.authorizeRequest({
    url: "ws://127.0.0.1:48080/",
    method: "GET",
    resourceType: "websocket",
  }), {
    allowed: false,
    reason: "websocket_disabled",
  });
  assert.equal(policy.authorizeRequest({
    url: "http://127.0.0.1:48080/assets/app.js",
    method: "HEAD",
    resourceType: "script",
  }).allowed, false);
  assert.deepEqual(policy.authorizeRequest({
    url: "http://127.0.0.1:48080/api/save",
    method: "POST",
    resourceType: "fetch",
  }), {
    allowed: false,
    reason: "non_read_request",
  });
  assert.deepEqual(policy.authorizeRequest({
    url: "https://cdn.example.com/app.js",
    method: "GET",
    resourceType: "script",
  }), {
    allowed: false,
    reason: "external_resource",
  });
  assert.equal(policy.authorizeRequest({
    url: "http://user:secret@127.0.0.1:48080/private",
    method: "GET",
  }).allowed, false);
  assert.equal(policy.authorizeInteraction("credential_input").allowed, false);
  assert.equal(policy.authorizeInteraction("file_upload").allowed, false);
  assert.equal(
    policy.authorizeDownload("http://127.0.0.1:48080/export.zip").allowed,
    false,
  );
  assert.equal(
    policy.authorizePopup("http://127.0.0.1:48080/popup").allowed,
    false,
  );

  const audit = policy.snapshot();
  assert.equal(audit.version, BROWSER_QA_POLICY_VERSION);
  assert.equal(audit.allowedNavigations, 1);
  assert.equal(audit.blockedNavigations, 1);
  assert.equal(audit.allowedRequests, 1);
  assert.equal(audit.blockedRequests, 5);
  assert.equal(audit.blockedInteractions, 2);
  assert.equal(audit.blockedDownloads, 1);
  assert.equal(audit.blockedPopups, 1);
  assert.equal(
    audit.events.some((event) => (
      event.reason === "embedded_credentials"
      && event.origin == null
      && event.path == null
    )),
    true,
  );
});

test("browser QA fixes the desktop/mobile profiles and returns bounded evidence", async () => {
  let inspected;
  const longEntries = Array.from({ length: 105 }, (_, index) => ({
    level: index === 0 ? "error" : "log",
    text: `console-${index}`,
    url: index === 0
      ? "http://127.0.0.1:48080/app.js?token=private"
      : "https://external.example/path?secret=value",
  }));
  const service = createPreviewBrowserQaService({
    previewSupervisor: supervisor(),
    browserAdapter: {
      id: "fake-controlled-browser",
      available: true,
      async inspect(options) {
        inspected = options;
        assert.deepEqual(
          Object.keys(options).sort(),
          ["limits", "policy", "profiles", "target"],
        );
        assert.equal(Object.isFrozen(options), true);
        assert.equal(Object.isFrozen(options.target), true);
        assert.equal(Object.isFrozen(options.profiles), true);
        assert.equal(options.target.url, ownedPreview().url);
        assert.equal(options.target.origin, ownedPreview().origin);
        assert.deepEqual(options.profiles, BROWSER_QA_PROFILES);
        options.policy.authorizeNavigation(options.target.url);
        options.policy.authorizeRequest({
          url: "https://external.example/tracker.js",
          method: "GET",
          resourceType: "script",
        });
        options.policy.authorizeInteraction("credential_input");
        options.policy.authorizeDownload(
          "http://127.0.0.1:48080/export.zip",
        );
        return {
          ...successfulResult(),
          console: longEntries,
          failedRequests: longEntries.map((entry) => ({
            method: "GET",
            resourceType: "script",
            reason: "blocked",
            url: entry.url,
          })),
        };
      },
    },
    now: () => new Date("2026-07-30T08:09:10.000Z"),
  });

  const result = await service.run({ key: "conversation-1" });

  assert.ok(inspected);
  assert.equal(result.status, "completed");
  assert.equal(result.adapterId, "fake-controlled-browser");
  assert.deepEqual(result.preview, {
    origin: "http://127.0.0.1:48080",
    path: "/reader/?mode=qa",
  });
  assert.deepEqual(
    result.captures.map((item) => item.profile.id),
    ["desktop", "mobile"],
  );
  assert.equal(result.captures[0].profile.width, 1_440);
  assert.equal(result.captures[1].profile.width, 390);
  assert.equal(result.captures[0].screenshot.mimeType, "image/png");
  assert.match(
    result.captures[0].screenshot.sha256,
    /^sha256:[a-f0-9]{64}$/,
  );
  assert.equal(
    result.captures[0].screenshot.bytes.equals(DESKTOP_PNG),
    true,
  );
  assert.equal(result.captures[0].dom.headingCount, 4);
  assert.equal(result.captures[0].accessibility.issueCount, 1);
  assert.equal(result.console.entries.length, 100);
  assert.equal(result.console.truncated, true);
  assert.deepEqual(result.console.entries[0].source, {
    scope: "preview",
    origin: "http://127.0.0.1:48080",
    path: "/app.js",
  });
  assert.deepEqual(result.console.entries[1].source, {
    scope: "external",
    origin: "https://external.example",
    path: null,
  });
  assert.equal(result.failedRequests.entries.length, 100);
  assert.equal(result.failedRequests.truncated, true);
  assert.equal(result.security.blockedRequests, 1);
  assert.equal(result.security.blockedInteractions, 1);
  assert.equal(result.security.blockedDownloads, 1);
  assert.equal(result.verdict, "issues");
  assert.deepEqual(result.issueSummary, {
    consoleErrorCount: 1,
    failedRequestCount: 100,
    accessibilityIssueCount: 2,
    blockedRequestCount: 1,
    blockedNavigationCount: 0,
    blockedActionCount: 2,
  });
  assert.equal(result.completedAt, "2026-07-30T08:09:10.000Z");
});

test("browser QA rejects stale ownership and malformed adapter evidence", async () => {
  let reads = 0;
  const staleService = createPreviewBrowserQaService({
    previewSupervisor: {
      getOwnedPreview() {
        reads += 1;
        return ownedPreview({
          ownershipToken: reads === 1 ? "lease-1" : "lease-2",
        });
      },
    },
    browserAdapter: {
      id: "fake",
      available: true,
      inspect: async () => successfulResult(),
    },
  });
  await assert.rejects(
    staleService.run({ key: "conversation-1" }),
    { code: "PROJECT_BROWSER_QA_PREVIEW_REPLACED" },
  );

  const malformedResults = [
    { captures: [capture("desktop")], console: [], failedRequests: [] },
    {
      ...successfulResult(),
      captures: [
        capture("desktop"),
        capture("desktop"),
      ],
    },
    {
      ...successfulResult(),
      captures: [
        capture("desktop", { screenshot: Buffer.from("not png") }),
        capture("mobile"),
      ],
    },
    {
      ...successfulResult(),
      captures: [
        capture("desktop", {
          dom: {
            ...capture("desktop").dom,
            nodeCount: -1,
          },
        }),
        capture("mobile"),
      ],
    },
  ];
  for (const rawResult of malformedResults) {
    const service = createPreviewBrowserQaService({
      previewSupervisor: supervisor(),
      browserAdapter: {
        id: "fake",
        available: true,
        inspect: async () => rawResult,
      },
    });
    await assert.rejects(
      service.run({ key: "conversation-1" }),
      { code: "PROJECT_BROWSER_QA_RESULT_INVALID" },
    );
  }
});

test("browser QA wraps unexpected adapter failures without leaking details", async () => {
  const service = createPreviewBrowserQaService({
    previewSupervisor: supervisor(),
    browserAdapter: {
      id: "fake",
      available: true,
      async inspect() {
        throw new Error("secret token from browser");
      },
    },
  });
  await assert.rejects(
    service.run({ key: "conversation-1" }),
    (error) => {
      assert.equal(error.code, "PROJECT_BROWSER_QA_FAILED");
      assert.equal(error.message, "受控浏览器验收失败");
      assert.doesNotMatch(error.message, /secret|token/);
      return true;
    },
  );
});
