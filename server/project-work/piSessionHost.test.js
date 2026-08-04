import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  createPublicHarnessSnapshot,
  createNativeProjectBashTool,
  createNativeProjectMutationTools,
  createNativeProjectShellEnvironment,
  createProjectWorkSubagentPolicyExtension,
  createProjectWorkTurnGuidanceExtension,
  createPiSessionFactory,
  createProjectWorkTools,
  forkProjectWorkSessionFromCheckpoint,
  getProjectWorkDefaultThinkingLevel,
  getSessionMessageEntryId,
  getProjectWorkThinkingLevels,
  PROJECT_WORK_DEFAULT_TOOL_NAMES,
  PROJECT_WORK_IMAGE_TOOL_NAME,
  PROJECT_WORK_PREVIEW_TOOL_NAME,
  PROJECT_WORK_PROGRESS_TOOL_NAME,
  PROJECT_WORK_REPAIR_TOOL_NAMES,
  PROJECT_WORK_SUBAGENT_TOOL_NAME,
  PROJECT_WORK_ULTRA_THINKING_LEVEL,
  readProjectWorkOverlayTextFile,
  restoreProjectWorkSessionEntry,
} from "./piSessionHost.js";
import { GITHUB_READ_TOOL_NAMES } from "./githubReadConnector.js";
import { VERCEL_READ_TOOL_NAMES } from "./vercelReadConnector.js";

const unavailableVercelReadProbe = async () => ({
  available: false,
  reasonCode: "CLI_MISSING",
});
const unavailableGitHubReadProbe = async () => ({
  available: false,
  reasonCode: "CLI_MISSING",
});

function toolByName(tools, name) {
  const tool = tools.find((item) => item.name === name);
  assert.ok(tool, `missing ${name} tool`);
  return tool;
}

test("project-work model catalog exposes safe external capability status", async () => {
  const factory = createPiSessionFactory({
    modelRuntime: {
      async getAvailable() {
        return [];
      },
      getProvider() {
        return null;
      },
    },
    externalRetrievalOptions: {
      env: {
        PI_TAVILY_API_KEY: "must-not-appear-in-catalog",
      },
    },
    githubReadOptions: {
      env: {
        PI_GITHUB_TOKEN: "github-token-must-not-appear-in-catalog",
      },
    },
    vercelReadProbe: async () => ({
      available: true,
      reasonCode: "READY",
      identity: "must-not-appear-in-catalog",
      token: "must-not-appear-in-catalog",
    }),
    imageGenerationProbe: async () => ({
      available: true,
      status: "ready",
      reasonCode: "CHATGPT_SUBSCRIPTION",
    }),
    officeArtifactProbe: async () => ({
      available: true,
      reason: "Word / Excel 本机生成与校验运行时可用",
      runtimePath: "must-not-appear-in-catalog",
    }),
  });
  const catalog = await factory.listModels();
  assert.deepEqual(catalog.capabilities, {
    web_search: {
      available: true,
      reason: "Tavily 网页检索已配置",
    },
    docs_search: {
      available: false,
      reason: "Context7 尚未配置",
    },
    image_generation: {
      available: true,
      reason: "GPT Image 2 · ChatGPT 订阅已连接",
    },
    office_generation: {
      available: true,
      reason: "Word / Excel 本机生成与校验运行时可用",
    },
    github_read: {
      id: "github_read",
      label: "GitHub 只读",
      available: true,
      enabledForTurn: false,
      defaultEnabled: false,
      activation: "per_turn",
      access: "read_only",
      effects: ["network_read"],
      toolNames: [
        "github_read_issue",
        "github_read_pull_request",
        "github_read_check_runs",
        "github_read_review_comments",
      ],
      reason: "GitHub 只读连接已配置，需逐回合启用",
    },
    vercel_read: {
      id: "vercel_read",
      label: "Vercel 只读",
      available: true,
      enabledForTurn: false,
      defaultEnabled: false,
      activation: "per_turn",
      access: "read_only",
      effects: ["network_read"],
      toolNames: VERCEL_READ_TOOL_NAMES,
      reason: "Vercel CLI 已连接，需逐回合启用",
    },
  });
  assert.doesNotMatch(JSON.stringify(catalog), /must-not-appear-in-catalog/);
});

test("project-work model catalog exposes only sanitized Vercel health", async () => {
  const factory = createPiSessionFactory({
    modelRuntime: {
      async getAvailable() {
        return [];
      },
      getProvider() {
        return null;
      },
    },
    githubReadProbe: unavailableGitHubReadProbe,
    vercelReadProbe: async () => ({
      available: true,
      reasonCode: "READY",
      username: "vercel-private-user",
      token: "vercel-private-token",
    }),
  });
  const catalog = await factory.listModels();
  assert.deepEqual(catalog.capabilities.vercel_read, {
    id: "vercel_read",
    label: "Vercel 只读",
    available: true,
    enabledForTurn: false,
    defaultEnabled: false,
    activation: "per_turn",
    access: "read_only",
    effects: ["network_read"],
    toolNames: VERCEL_READ_TOOL_NAMES,
    reason: "Vercel CLI 已连接，需逐回合启用",
  });
  assert.doesNotMatch(JSON.stringify(catalog), /vercel-private/u);
});

test("project-work model catalog exposes sanitized GitHub Keychain health", async () => {
  const factory = createPiSessionFactory({
    modelRuntime: {
      async getAvailable() {
        return [];
      },
      getProvider() {
        return null;
      },
    },
    githubReadOptions: { env: {} },
    githubReadProbe: async () => ({
      available: true,
      reasonCode: "READY",
      source: "gh_keychain",
      identity: "github-private-user",
      token: "github-private-token",
    }),
    vercelReadProbe: unavailableVercelReadProbe,
  });
  const catalog = await factory.listModels();
  assert.deepEqual(catalog.capabilities.github_read, {
    id: "github_read",
    label: "GitHub 只读",
    available: true,
    enabledForTurn: false,
    defaultEnabled: false,
    activation: "per_turn",
    access: "read_only",
    effects: ["network_read"],
    toolNames: GITHUB_READ_TOOL_NAMES,
    reason: "GitHub CLI 已连接，需逐回合启用",
  });
  assert.doesNotMatch(JSON.stringify(catalog), /github-private/u);
});

test("project-work model catalog reports Image2 unavailable without exposing auth details", async () => {
  const factory = createPiSessionFactory({
    modelRuntime: {
      async getAvailable() {
        return [];
      },
      getProvider() {
        return null;
      },
    },
    imageGenerationProbe: async () => ({
      available: false,
      status: "unavailable",
      reasonCode: "CODEX_AUTH_NOT_CHATGPT",
      token: "must-not-appear",
    }),
    githubReadProbe: unavailableGitHubReadProbe,
    vercelReadProbe: unavailableVercelReadProbe,
  });
  const catalog = await factory.listModels();
  assert.deepEqual(catalog.capabilities.image_generation, {
    available: false,
    reason: "Codex 尚未使用 ChatGPT 订阅登录",
  });
  assert.doesNotMatch(JSON.stringify(catalog), /must-not-appear/);
});

test("project-work model catalog derives image support from Pi model input modalities", async () => {
  const factory = createPiSessionFactory({
    modelRuntime: {
      async getAvailable() {
        return [{
          id: "vision-model",
          name: "Vision Model",
          provider: "provider-one",
          input: ["text", "image"],
          reasoning: true,
          contextWindow: 128_000,
        }, {
          id: "text-model",
          name: "Text Model",
          provider: "provider-one",
          input: ["text"],
          reasoning: false,
          contextWindow: 64_000,
        }];
      },
      getProvider(providerId) {
        return providerId === "provider-one"
          ? { name: "Provider One" }
          : null;
      },
    },
    githubReadProbe: unavailableGitHubReadProbe,
    vercelReadProbe: unavailableVercelReadProbe,
  });
  const catalog = await factory.listModels();
  const models = catalog.providers[0].models;

  assert.equal(
    models.find((model) => model.id === "vision-model").supportsImages,
    true,
  );
  assert.equal(
    models.find((model) => model.id === "text-model").supportsImages,
    false,
  );
  assert.equal(
    models.find((model) => model.id === "vision-model").billingKind,
    "unknown",
  );
});

test("project-work model catalog exposes only safe rate-card metadata", async () => {
  const factory = createPiSessionFactory({
    modelRuntime: {
      async getAvailable() {
        return [{
          id: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          provider: "openai-codex",
          baseUrl: "https://must-not-appear.example",
          headers: { authorization: "must-not-appear" },
          input: ["text", "image"],
          reasoning: true,
          contextWindow: 272_000,
          cost: {
            input: 5,
            output: 30,
            cacheRead: 0.5,
            cacheWrite: 6.25,
            tiers: [{
              inputTokensAbove: 272_000,
              input: 10,
              output: 45,
              cacheRead: 1,
              cacheWrite: 12.5,
            }],
          },
        }];
      },
      getProvider() {
        return { name: "GPT · ChatGPT 订阅" };
      },
    },
    githubReadProbe: unavailableGitHubReadProbe,
    vercelReadProbe: unavailableVercelReadProbe,
  });

  const catalog = await factory.listModels();
  const model = catalog.providers[0].models[0];
  assert.equal(model.billingKind, "chatgpt_subscription");
  assert.deepEqual(model.pricing, {
    currency: "USD",
    unit: "per_million_tokens",
    source: "pi_model_catalog",
    version: "0.82.1",
    input: 5,
    output: 30,
    cacheRead: 0.5,
    cacheWrite: 6.25,
    tiers: [{
      inputTokensAbove: 272_000,
      input: 10,
      output: 45,
      cacheRead: 1,
      cacheWrite: 12.5,
    }],
  });
  assert.doesNotMatch(JSON.stringify(catalog), /must-not-appear/);
});

test("project-work provider connections save through Pi without returning API keys", async () => {
  const stored = new Map([["deepseek", "api_key"]]);
  const receivedKeys = [];
  const runtime = {
    getProviders() {
      return [{
        id: "deepseek",
        name: "DeepSeek",
        auth: {
          apiKey: {
            name: "DeepSeek API Key",
            login() {},
          },
        },
      }, {
        id: "openai-codex",
        name: "GPT · ChatGPT 订阅",
        auth: {
          oauth: {
            name: "ChatGPT 登录",
            login() {},
          },
        },
      }];
    },
    getProvider(providerId) {
      return this.getProviders().find((provider) => provider.id === providerId);
    },
    async listCredentials() {
      return [...stored].map(([providerId, type]) => ({ providerId, type }));
    },
    async getAvailable() {
      return stored.has("deepseek")
        ? [{ provider: "deepseek", id: "deepseek-v4-pro" }]
        : [];
    },
    async checkAuth(providerId) {
      return stored.has(providerId)
        ? { type: stored.get(providerId), source: "credential_store" }
        : undefined;
    },
    async login(providerId, type, callbacks) {
      assert.equal(providerId, "deepseek");
      assert.equal(type, "api_key");
      receivedKeys.push(await callbacks.prompt());
      stored.set(providerId, type);
    },
    async logout(providerId) {
      stored.delete(providerId);
    },
  };
  const factory = createPiSessionFactory({ modelRuntime: runtime });

  const initial = await factory.listProviderConnections();
  assert.equal(initial.providers.find((item) => item.id === "deepseek").stored, true);
  assert.equal(
    initial.providers.find((item) => item.id === "openai-codex").apiKeySupported,
    false,
  );
  assert.doesNotMatch(JSON.stringify(initial), /secret-api-key/);

  const saved = await factory.saveProviderApiKey({
    providerId: "deepseek",
    apiKey: "secret-api-key",
  });
  assert.deepEqual(receivedKeys, ["secret-api-key"]);
  assert.doesNotMatch(JSON.stringify(saved), /secret-api-key/);
  assert.equal(saved.providers[0].configured, true);

  const removed = await factory.removeProviderCredential("deepseek");
  assert.equal(removed.providers.find((item) => item.id === "deepseek").stored, false);
  assert.doesNotMatch(JSON.stringify(removed), /secret-api-key/);
});

test("project-work provider connection failures never relay provider secret text", async () => {
  const factory = createPiSessionFactory({
    modelRuntime: {
      getProviders() {
        return [{
          id: "deepseek",
          name: "DeepSeek",
          auth: { apiKey: { login() {} } },
        }];
      },
      getProvider() {
        return this.getProviders()[0];
      },
      async login() {
        throw new Error("upstream rejected secret-api-key");
      },
    },
  });

  await assert.rejects(
    factory.saveProviderApiKey({
      providerId: "deepseek",
      apiKey: "secret-api-key",
    }),
    (error) => {
      assert.match(error.message, /未能保存/);
      assert.doesNotMatch(error.message, /secret-api-key/);
      return true;
    },
  );
});

test("project-work session host forwards image attachments to Pi steer", async () => {
  const source = await readFile(new URL("./piSessionHost.js", import.meta.url), "utf8");
  assert.match(
    source,
    /steer\(text,\s*images\)\s*\{\s*return session\.steer\(text,\s*images\);\s*\}/,
  );
});

test("project-work session host exposes Pi follow-up queue primitives without a shell bridge", async () => {
  const source = await readFile(new URL("./piSessionHost.js", import.meta.url), "utf8");
  assert.match(
    source,
    /followUp\(text,\s*images\)\s*\{\s*return session\.followUp\(text,\s*images\);\s*\}/,
  );
  assert.match(source, /replaceFollowUps\(messages\)/);
  assert.match(
    source,
    /clearQueue\(\)\s*\{\s*return session\.clearQueue\(\);\s*\}/,
  );
  assert.doesNotMatch(source, /child_process.*followUp/s);
});

test("project-work session host retries by branching before the last durable user message", async () => {
  const source = await readFile(new URL("./piSessionHost.js", import.meta.url), "utf8");
  assert.match(source, /retryLastTurn\(options = \{\}\)/);
  assert.match(source, /session\.getUserMessagesForForking\(\)\.at\(-1\)/);
  assert.match(
    source,
    /hasRetryableTurn\(\)\s*\{\s*return session\.getUserMessagesForForking\(\)\.length > 0;/,
  );
  assert.match(source, /return retryFromEntry\(target\.entryId, options\)/);
  assert.match(source, /session\.navigateTree\(entryId,\s*\{\s*summarize: false/);
  assert.match(source, /session\.sendUserMessage\(content\)/);
  assert.match(source, /getActiveEntryId\(\)\s*\{\s*return sessionManager\.getLeafId\(\)/);
  assert.match(source, /restoreSessionEntry\(piEntryId\)/);
  assert.doesNotMatch(source, /child_process.*retryLastTurn/s);
});

test("Pi message entry lookup binds only the exact persisted message object", () => {
  const manager = SessionManager.inMemory("/private/pi-entry-lookup");
  const message = {
    role: "user",
    content: [{ type: "text", text: "检查当前项目" }],
    timestamp: Date.now(),
  };
  const entryId = manager.appendMessage(message);

  assert.equal(getSessionMessageEntryId(manager, message), entryId);
  assert.equal(
    getSessionMessageEntryId(manager, structuredClone(message)),
    null,
    "structurally similar messages must not guess a Pi entry",
  );
});

test("checkpoint restore keeps the exact assistant, user, and custom-message leaf", () => {
  const manager = SessionManager.inMemory("/private/pi-exact-entry-restore");
  const userMessage = {
    role: "user",
    content: [{ type: "text", text: "检查当前项目" }],
    timestamp: 1,
  };
  const assistantMessage = {
    role: "assistant",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    content: [{ type: "text", text: "检查完成" }],
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 2,
  };
  const userEntryId = manager.appendMessage(userMessage);
  const assistantEntryId = manager.appendMessage(assistantMessage);
  const customEntryId = manager.appendCustomMessageEntry(
    "pi_agent_current_files_notice",
    "重新检查当前项目文件",
    false,
  );
  const session = {
    agent: {
      state: {
        messages: [],
      },
    },
  };

  for (const entryId of [assistantEntryId, userEntryId, customEntryId]) {
    restoreProjectWorkSessionEntry({
      sessionManager: manager,
      session,
      piEntryId: entryId,
    });
    assert.equal(manager.getLeafId(), entryId);
    assert.deepEqual(
      session.agent.state.messages,
      manager.buildSessionContext().messages,
    );
  }
});

test("checkpoint session fork keeps the source tree unchanged and resumes only the selected path", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-session-fork-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const sourceWorkspace = path.join(temporaryRoot, "source-workspace");
  const sourceSessions = path.join(temporaryRoot, "source-sessions");
  const targetWorkspace = path.join(temporaryRoot, "target-workspace");
  const targetSessions = path.join(temporaryRoot, "target-sessions");
  await Promise.all([
    mkdir(sourceWorkspace),
    mkdir(sourceSessions),
    mkdir(targetWorkspace),
    mkdir(targetSessions),
  ]);

  const manager = SessionManager.create(sourceWorkspace, sourceSessions);
  const userMessage = (text, timestamp) => ({
    role: "user",
    content: [{ type: "text", text }],
    timestamp,
  });
  const assistantMessage = (text, timestamp) => ({
    role: "assistant",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    content: [{ type: "text", text }],
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  });
  const rootUserId = manager.appendMessage(userMessage("共同起点", 1));
  const rootAssistantId = manager.appendMessage(
    assistantMessage("共同回答", 2),
  );
  const selectedUserId = manager.appendMessage(userMessage("方案甲", 3));
  const selectedAssistantId = manager.appendMessage(
    assistantMessage("方案甲回答", 4),
  );
  manager.branch(rootAssistantId);
  const siblingUserId = manager.appendMessage(userMessage("方案乙", 5));
  const siblingAssistantId = manager.appendMessage(
    assistantMessage("方案乙回答", 6),
  );
  const sourceLeafBefore = manager.getLeafId();
  const sourceFile = manager.getSessionFile();
  const sourceBytesBefore = await readFile(sourceFile);

  const forked = await forkProjectWorkSessionFromCheckpoint({
    sessionManager: manager,
    piAssistantEntryId: selectedAssistantId,
    targetWorkspaceRoot: targetWorkspace,
    targetSessionDir: targetSessions,
  });

  assert.equal(manager.getLeafId(), sourceLeafBefore);
  assert.equal(manager.getLeafId(), siblingAssistantId);
  assert.deepEqual(await readFile(sourceFile), sourceBytesBefore);
  assert.deepEqual(forked.entryPathIds, [
    rootUserId,
    rootAssistantId,
    selectedUserId,
    selectedAssistantId,
  ]);

  const canonicalTargetWorkspace = await realpath(targetWorkspace);
  const restored = SessionManager.continueRecent(
    canonicalTargetWorkspace,
    targetSessions,
  );
  assert.equal(restored.getSessionId(), forked.sessionId);
  assert.equal(restored.getCwd(), canonicalTargetWorkspace);
  assert.ok(restored.getEntry(rootUserId));
  assert.ok(restored.getEntry(rootAssistantId));
  assert.ok(restored.getEntry(selectedUserId));
  assert.ok(restored.getEntry(selectedAssistantId));
  assert.equal(restored.getEntry(siblingUserId), undefined);
  assert.equal(restored.getEntry(siblingAssistantId), undefined);
  const notice = restored.getLeafEntry();
  assert.equal(notice.type, "custom_message");
  assert.equal(notice.customType, "pi_agent_current_files_notice");
  assert.equal(notice.display, false);
  assert.match(String(notice.content), /did not rewind or copy project files/);
  assert.deepEqual(
    restored.getBranch().map((entry) => entry.id),
    [
      rootUserId,
      rootAssistantId,
      selectedUserId,
      selectedAssistantId,
      notice.id,
    ],
  );
});

test("legacy verification repair uses bounded tools in the real Workspace and a hidden failure turn", async () => {
  assert.deepEqual(PROJECT_WORK_REPAIR_TOOL_NAMES, [
    "read",
    "edit",
    "write",
    "grep",
    "find",
    "ls",
    PROJECT_WORK_PROGRESS_TOOL_NAME,
    "update_plan",
  ]);
  for (const blockedName of [
    "ask_user",
    "request_verification",
    "request_preview",
  ]) {
    assert.equal(PROJECT_WORK_REPAIR_TOOL_NAMES.includes(blockedName), false);
  }
  const source = await readFile(new URL("./piSessionHost.js", import.meta.url), "utf8");
  assert.match(source, /repairVerification\(\{/);
  assert.match(source, /customType: "pi_agent_verification_failure"/);
  assert.match(source, /display: false/);
  assert.match(source, /triggerTurn: true/);
  assert.match(source, /real persistent Workspace/);
  assert.match(source, /native mutation evidence/);
  assert.doesNotMatch(source, /failed inside the isolated verification workspace/);
  assert.doesNotMatch(source, /Fix only the project files available through the contained overlay tools/);
  assert.doesNotMatch(source, /child_process.*repairVerification/s);
});

test("public progress is a bounded non-mutating tool available to normal and repair turns", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-progress-tool-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  const baseRoot = path.join(temporaryRoot, "base");
  const workspaceRoot = path.join(temporaryRoot, "workspace");
  await Promise.all([
    mkdir(projectRoot),
    mkdir(baseRoot),
    mkdir(workspaceRoot),
  ]);
  const reports = [];
  const tools = await createProjectWorkTools({
    projectRoot,
    baseRoot,
    workspaceRoot,
    onProgress: async (progress) => {
      reports.push(progress);
      return {
        recorded: true,
        status: "recorded",
        index: reports.length,
      };
    },
  });
  assert.deepEqual(
    VERCEL_READ_TOOL_NAMES.filter((name) => tools.some((tool) => tool.name === name)),
    VERCEL_READ_TOOL_NAMES,
  );
  const reportProgress = toolByName(tools, PROJECT_WORK_PROGRESS_TOOL_NAME);
  const result = await reportProgress.execute("progress-1", {
    summary: "正在检查事件链",
    detail: "已定位安全公开进展的接入点",
  });

  assert.deepEqual(reports, [{
    summary: "正在检查事件链",
    detail: "已定位安全公开进展的接入点",
  }]);
  assert.equal(result.details.recorded, true);
  assert.equal(result.details.index, 1);
  assert.equal(reportProgress.parameters.additionalProperties, false);
  assert.deepEqual(
    Object.keys(reportProgress.parameters.properties).sort(),
    ["detail", "summary"],
  );
  assert.equal(
    PROJECT_WORK_DEFAULT_TOOL_NAMES.includes(PROJECT_WORK_PROGRESS_TOOL_NAME),
    true,
  );
  assert.equal(
    PROJECT_WORK_REPAIR_TOOL_NAMES.includes(PROJECT_WORK_PROGRESS_TOOL_NAME),
    true,
  );
  const source = await readFile(new URL("./piSessionHost.js", import.meta.url), "utf8");
  assert.match(source, /never expose private reasoning, hidden chain-of-thought, secrets/);
  assert.match(source, /Use Pi's native read, bash, edit, write/);
  assert.match(source, /Every contained file-tool path must be relative/);
  assert.match(source, /for the root directory; never pass an absolute/);
});

test("project-work turn creates and executes GitHub Keychain read tools without a dedicated token", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-github-keychain-tool-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  const baseRoot = path.join(temporaryRoot, "base");
  const workspaceRoot = path.join(temporaryRoot, "workspace");
  await Promise.all([
    mkdir(projectRoot),
    mkdir(baseRoot),
    mkdir(workspaceRoot),
  ]);
  const requests = [];
  const tools = await createProjectWorkTools({
    projectRoot,
    baseRoot,
    workspaceRoot,
    githubReadOptions: {
      env: {},
      runner: {
        async request(url) {
          requests.push(url.toString());
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              number: 21,
              title: "Keychain-backed turn",
              state: "open",
            }),
            stderr: "",
          };
        },
      },
    },
  });
  assert.deepEqual(
    GITHUB_READ_TOOL_NAMES.filter((name) => tools.some((tool) => tool.name === name)),
    GITHUB_READ_TOOL_NAMES,
  );
  const result = await toolByName(tools, "github_read_issue").execute(
    "github-keychain-call",
    { owner: "openai", repo: "codex", number: 21 },
  );
  assert.deepEqual(requests, [
    "https://api.github.com/repos/openai/codex/issues/21",
  ]);
  assert.equal(result.details.issue.title, "Keychain-backed turn");
});

test("verification tool exposes recipe ids without arbitrary command arguments", async () => {
  const source = await readFile(new URL("./piSessionHost.js", import.meta.url), "utf8");
  const toolSource = source.slice(
    source.indexOf('name: "request_verification"'),
    source.indexOf("const generateImage"),
  );
  assert.match(toolSource, /recipeId:\s*Type\.Union/);
  assert.match(toolSource, /additionalProperties:\s*false/);
  assert.doesNotMatch(toolSource, /\bfile:\s*Type\.String/);
  assert.doesNotMatch(toolSource, /\bargs:\s*Type\./);
});

test("project-work turn guidance modifies only the current system prompt", async () => {
  let guidance = "Review only for this turn.";
  let beforeAgentStart = null;
  const extension = createProjectWorkTurnGuidanceExtension(() => guidance);
  assert.equal(extension.hidden, true);
  extension.factory({
    on(event, handler) {
      if (event === "before_agent_start") beforeAgentStart = handler;
    },
  });
  assert.equal(typeof beforeAgentStart, "function");

  const result = await beforeAgentStart({
    systemPrompt: "Base prompt",
  });
  assert.equal(
    result.systemPrompt,
    "Base prompt\n\n## Current-turn instructions\n\nReview only for this turn.",
  );

  guidance = "";
  assert.equal(
    await beforeAgentStart({ systemPrompt: "Base prompt" }),
    undefined,
  );
});

test("Ultra child sessions use real Workspaces, preserve per-child models, and never request temporary worktrees", async () => {
  const handlers = new Map();
  const allocations = [];
  const ceilings = [];
  let writesAllowed = true;
  createProjectWorkSubagentPolicyExtension({
    async prepareNativeChildWorkspaces(request) {
      allocations.push(structuredClone(request));
      return request.tasks.map((task, index) => ({
        cwd: task.mode === "write"
          ? `/private/persistent-worktree-${index + 1}`
          : "/private/project",
        persistent: true,
      }));
    },
    getWritesAllowed: () => writesAllowed,
    setCapabilityCeiling: (ceiling) => ceilings.push(structuredClone(ceiling)),
  }).factory({
    on(event, handler) {
      handlers.set(event, handler);
    },
  });
  const agentStart = handlers.get("agent_start");
  const toolCall = handlers.get("tool_call");
  const toolResult = handlers.get("tool_result");
  assert.equal(typeof agentStart, "function");
  assert.equal(typeof toolCall, "function");
  assert.equal(typeof toolResult, "function");

  await agentStart();
  const readInput = {
    tasks: [
      {
        agent: "delegate",
        task: "检查入口",
        model: "deepseek/deepseek-v4-flash",
      },
      { agent: "delegate", task: "检查测试", model: "openai-codex/gpt-5.6-sol" },
    ],
    async: true,
    context: "fork",
    artifacts: true,
  };
  assert.equal(
    await toolCall({
      toolName: PROJECT_WORK_SUBAGENT_TOOL_NAME,
      input: readInput,
    }),
    undefined,
  );
  assert.equal(readInput.async, false);
  assert.equal(readInput.context, "fresh");
  assert.equal(readInput.artifacts, false);
  assert.equal(readInput.concurrency, 2);
  assert.equal(readInput.agentScope, "both");
  assert.equal(readInput.worktree, false);
  assert.deepEqual(readInput.tasks, [
    {
      agent: "delegate",
      task: "检查入口",
      model: "deepseek/deepseek-v4-flash",
      cwd: "/private/project",
      acceptance: false,
    },
    {
      agent: "delegate",
      task: "检查测试",
      model: "openai-codex/gpt-5.6-sol",
      cwd: "/private/project",
      acceptance: false,
    },
  ]);
  assert.deepEqual(allocations[0], { tasks: [{
    mode: "read",
    model: "deepseek/deepseek-v4-flash",
  }, {
    mode: "read",
    model: "openai-codex/gpt-5.6-sol",
  }] });
  await toolResult({ toolName: PROJECT_WORK_SUBAGENT_TOOL_NAME });
  assert.deepEqual(ceilings.at(-1), {
    allowedTools: ["read", "grep", "find", "ls"],
    denyExtensions: true,
  });

  const writeInput = {
    tasks: [{ agent: "worker", task: "实现 A" }, {
      agent: "worker",
      task: "实现 B",
      model: "deepseek/deepseek-v4-pro",
    }],
  };
  assert.equal(await toolCall({
    toolName: PROJECT_WORK_SUBAGENT_TOOL_NAME,
    input: writeInput,
  }), undefined);
  assert.deepEqual(writeInput.tasks.map((task) => ({
    cwd: task.cwd,
    model: task.model ?? null,
  })), [{
    cwd: "/private/persistent-worktree-1",
    model: null,
  }, {
    cwd: "/private/persistent-worktree-2",
    model: "deepseek/deepseek-v4-pro",
  }]);
  assert.equal(writeInput.worktree, false);
  assert.deepEqual(ceilings.at(-1), {
    allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    denyExtensions: true,
  });

  writesAllowed = false;
  const planningWrite = await toolCall({
    toolName: PROJECT_WORK_SUBAGENT_TOOL_NAME,
    input: { agent: "worker", task: "规划时修改项目" },
  });
  assert.equal(planningWrite.block, true);
  assert.match(planningWrite.reason, /只读工作流/);

  const control = await toolCall({
    toolName: PROJECT_WORK_SUBAGENT_TOOL_NAME,
    input: { action: "status", id: "existing-run" },
  });
  assert.equal(control, undefined);
});

test("project-work host loads the pinned subagent tool only for an active Ultra turn", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-ultra-host-"));
  let host = null;
  t.after(async () => {
    host?.dispose();
    await rm(temporaryRoot, { recursive: true, force: true });
  });
  const directories = Object.fromEntries(
    ["agent", "project", "base", "workspace", "sessions"].map(
      (name) => [name, path.join(temporaryRoot, name)],
    ),
  );
  await Promise.all(Object.values(directories).map((directory) => mkdir(directory)));
  const runtime = await ModelRuntime.create({ allowModelNetwork: false });
  const model = runtime.getModel("openai-codex", "gpt-5.6-sol");
  assert.ok(model);
  const modelRuntime = new Proxy(runtime, {
    get(target, property, receiver) {
      if (property === "getAvailable") return async () => [model];
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const factory = createPiSessionFactory({
    agentDir: directories.agent,
    modelRuntime,
  });
  host = await factory({
    projectRoot: directories.project,
    baseRoot: directories.base,
    workspaceRoot: directories.workspace,
    sessionDir: directories.sessions,
    modelRef: "openai-codex/gpt-5.6-sol",
    thinkingLevel: PROJECT_WORK_ULTRA_THINKING_LEVEL,
    workspaceSnapshot: { truncated: false },
  });

  assert.equal(host.thinkingLevel, PROJECT_WORK_ULTRA_THINKING_LEVEL);
  assert.equal(
    host.getHarnessSnapshot().activeTools.includes(
      PROJECT_WORK_SUBAGENT_TOOL_NAME,
    ),
    false,
  );
  host.setActiveToolsByName(["read", "grep"], { allowSubagents: true });
  assert.deepEqual(host.getHarnessSnapshot().activeTools, [
    "read",
    "grep",
    PROJECT_WORK_SUBAGENT_TOOL_NAME,
  ]);
  host.setThinkingLevel("high");
  assert.deepEqual(host.getHarnessSnapshot().activeTools, ["read", "grep"]);
});

test("trusted Workspace sessions use Pi native tools and discover project resources", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-native-host-"));
  let host = null;
  t.after(async () => {
    await host?.dispose();
    await rm(temporaryRoot, { recursive: true, force: true });
  });
  const agentDir = path.join(temporaryRoot, "agent");
  const workspaceRoot = path.join(temporaryRoot, "workspace");
  const sessionDir = path.join(temporaryRoot, "sessions");
  const baseRoot = path.join(temporaryRoot, "base");
  const extensionRoot = path.join(workspaceRoot, ".pi", "extensions");
  const skillRoot = path.join(
    workspaceRoot,
    ".pi",
    "skills",
    "native-probe",
  );
  const promptRoot = path.join(workspaceRoot, ".pi", "prompts");
  await Promise.all([
    mkdir(agentDir),
    mkdir(sessionDir),
    mkdir(baseRoot),
    mkdir(extensionRoot, { recursive: true }),
    mkdir(skillRoot, { recursive: true }),
    mkdir(promptRoot, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      path.join(workspaceRoot, "AGENTS.md"),
      "# Native project rules\nUse the project Runtime.\n",
    ),
    writeFile(
      path.join(extensionRoot, "native-probe.js"),
      [
        "export default function nativeProbe(pi) {",
        "  pi.registerTool({",
        "    name: 'native_probe',",
        "    label: 'native_probe',",
        "    description: 'Native project extension probe',",
        "    parameters: { type: 'object', properties: {}, additionalProperties: false },",
        "    async execute() {",
        "      return { content: [{ type: 'text', text: 'native' }], details: {} };",
        "    },",
        "  });",
        "}",
        "",
      ].join("\n"),
    ),
    writeFile(
      path.join(skillRoot, "SKILL.md"),
      [
        "---",
        "name: native-probe",
        "description: Confirms native project Skill discovery.",
        "---",
        "# Native probe",
        "",
      ].join("\n"),
    ),
    writeFile(
      path.join(promptRoot, "native-review.md"),
      [
        "---",
        "description: Native project prompt probe",
        "---",
        "Review the current Workspace.",
        "",
      ].join("\n"),
    ),
  ]);

  const runtime = await ModelRuntime.create({ allowModelNetwork: false });
  const model = runtime.getModel("openai-codex", "gpt-5.6-sol");
  assert.ok(model);
  const modelRuntime = new Proxy(runtime, {
    get(target, property, receiver) {
      if (property === "getAvailable") return async () => [model];
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const factory = createPiSessionFactory({ agentDir, modelRuntime });
  host = await factory({
    projectRoot: workspaceRoot,
    baseRoot,
    workspaceRoot,
    sessionDir,
    modelRef: "openai-codex/gpt-5.6-sol",
    thinkingLevel: "high",
    workspaceSnapshot: { truncated: false },
    directWorkspace: true,
  });

  const snapshot = host.getHarnessSnapshot();
  assert.equal(snapshot.harnessVersion, "pi-native-v1");
  assert.ok(snapshot.prompt.layers.includes("真实 Workspace 原生规则"));
  assert.equal(snapshot.prompt.layers.includes("项目审阅工作区规则"), false);
  assert.equal(snapshot.resources.settings, "project_and_global");
  assert.equal(snapshot.resources.prompts, 1);
  assert.equal(snapshot.context.projectRules, 1);
  assert.ok(snapshot.skills.includes("native-probe"));
  assert.ok(snapshot.activeTools.includes("bash"));
  assert.ok(snapshot.activeTools.includes("native_probe"));
  assert.equal(host.getToolSources().read, "builtin");
  assert.notEqual(host.getToolSources().native_probe, "sdk");
  assert.equal(host.modelRef, "openai-codex/gpt-5.6-sol");
  assert.equal(host.thinkingLevel, host.getHarnessSnapshot().thinkingLevel);

  const source = await readFile(new URL("./piSessionHost.js", import.meta.url), "utf8");
  const nativeGuidance = source.slice(
    source.indexOf("const APP_GUIDANCE"),
    source.indexOf("const STANDALONE_GUIDANCE"),
  );
  assert.match(nativeGuidance, /Historical request_verification calls/);
  assert.match(nativeGuidance, /use native Bash to collect fresh test or build evidence/);

  host.setActiveToolsByName(["read", "grep", "update_plan"]);
  assert.deepEqual(host.getHarnessSnapshot().activeTools, [
    "read",
    "grep",
    "update_plan",
  ]);
  assert.equal(host.getHarnessSnapshot().activeTools.includes("bash"), false);
  assert.equal(host.getHarnessSnapshot().activeTools.includes("native_probe"), false);
});

test("native Pi Bash returns streamed output in the same tool call without host secrets", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-native-bash-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const secretName = "PI_NATIVE_TEST_API_KEY";
  const previousSecret = process.env[secretName];
  process.env[secretName] = "must-not-reach-project-shell";
  try {
    assert.deepEqual(createNativeProjectShellEnvironment({
      HOME: "/Users/native",
      SSH_AUTH_SOCK: "/tmp/pi-native-test-agent.sock",
      PI_NATIVE_TEST_API_KEY: "must-not-reach-project-shell",
      PROJECT_CACHE_DIR: "/tmp/project-cache",
    }), {
      HOME: "/Users/native",
      SSH_AUTH_SOCK: "/tmp/pi-native-test-agent.sock",
      PROJECT_CACHE_DIR: "/tmp/project-cache",
    });
    const events = [];
    const bash = createNativeProjectBashTool(temporaryRoot, {
      onNativeBashEvent: async (event) => events.push(event),
    });
    const updates = [];
    const result = await bash.execute(
      "native-bash-call",
      {
        command: [
          `if [ -z "\${${secretName}:-}" ] && [ -n "$HOME" ]; then`,
          "  printf 'sanitized-and-native'",
          "else",
          "  printf 'leaked'",
          "fi",
        ].join("\n"),
      },
      undefined,
      (update) => updates.push(update),
    );
    assert.match(result.content[0].text, /sanitized-and-native/);
    assert.doesNotMatch(result.content[0].text, /leaked|must-not-reach/);
    assert.ok(updates.length > 0);
    assert.equal(events[0].phase, "started");
    assert.equal(events.at(-1).phase, "completed");
    assert.equal(events.at(-1).result, result);
    assert.ok(events.some((event) => event.phase === "update"));
    assert.ok(events.every((event) => event.toolCallId === "native-bash-call"));
  } finally {
    if (previousSecret === undefined) delete process.env[secretName];
    else process.env[secretName] = previousSecret;
  }
});

test("native edit and write report hash-bound diffs after the real mutation", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-native-files-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const existingPath = path.join(temporaryRoot, "existing.txt");
  await writeFile(existingPath, "before\n");
  await chmod(existingPath, 0o640);
  const events = [];
  const tools = createNativeProjectMutationTools(temporaryRoot, {
    onNativeFileChange: async (event) => events.push(event),
  });
  const edit = toolByName(tools, "edit");
  const write = toolByName(tools, "write");

  const editResult = await edit.execute("native-edit-call", {
    path: "existing.txt",
    edits: [{ oldText: "before", newText: "after" }],
  });
  assert.match(editResult.details.patch, /-before\n\+after/);
  assert.equal(await readFile(existingPath, "utf8"), "after\n");
  assert.equal(events[0].toolCallId, "native-edit-call");
  assert.equal(events[0].toolName, "edit");
  assert.equal(events[0].workspacePath, "existing.txt");
  assert.equal(events[0].beforeContent, "before\n");
  assert.equal(events[0].afterContent, "after\n");
  assert.match(events[0].beforeHash, /^sha256:[a-f0-9]{64}$/);
  assert.match(events[0].afterHash, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(events[0].beforeHash, events[0].afterHash);
  assert.equal(events[0].beforeMode, 0o640);
  assert.equal(events[0].afterMode, 0o640);
  assert.match(events[0].diff, /-before\n\+after/);

  const writeResult = await write.execute("native-write-call", {
    path: "created.txt",
    content: "created\n",
  });
  assert.equal(await readFile(path.join(temporaryRoot, "created.txt"), "utf8"), "created\n");
  assert.equal(writeResult.content[0].text, "Successfully wrote 8 bytes to created.txt");
  assert.equal(events[1].toolCallId, "native-write-call");
  assert.equal(events[1].operation, "create");
  assert.equal(events[1].beforeHash, null);
  assert.equal(events[1].beforeMode, null);
  assert.match(events[1].afterHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(events[1].afterMode, 0o644);
  assert.match(events[1].diff, /\+created/);
});

test("continued native sessions expose Pi's actual model fallback and thinking level", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-native-resume-"));
  let host = null;
  t.after(async () => {
    await host?.dispose();
    await rm(temporaryRoot, { recursive: true, force: true });
  });
  const agentDir = path.join(temporaryRoot, "agent");
  const workspaceRoot = path.join(temporaryRoot, "workspace");
  const sessionDir = path.join(temporaryRoot, "sessions");
  const baseRoot = path.join(temporaryRoot, "base");
  await Promise.all([
    mkdir(agentDir),
    mkdir(workspaceRoot),
    mkdir(sessionDir),
    mkdir(baseRoot),
  ]);
  const canonicalWorkspaceRoot = await realpath(workspaceRoot);
  await writeFile(
    path.join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "openai-codex",
      defaultModel: "gpt-5.6-sol",
      defaultThinkingLevel: "medium",
    }),
  );
  const persisted = SessionManager.create(canonicalWorkspaceRoot, sessionDir);
  persisted.appendModelChange("removed-provider", "removed-model");
  persisted.appendThinkingLevelChange("high");
  persisted.appendMessage({
    role: "user",
    content: [{ type: "text", text: "continue" }],
    timestamp: 1,
  });
  persisted.appendMessage({
    role: "assistant",
    provider: "removed-provider",
    model: "removed-model",
    content: [{ type: "text", text: "previous" }],
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 2,
  });
  assert.equal(persisted.buildSessionContext().thinkingLevel, "high");
  assert.equal(persisted.buildSessionContext().messages.length, 2);
  assert.equal(
    SessionManager.continueRecent(canonicalWorkspaceRoot, sessionDir)
      .buildSessionContext().thinkingLevel,
    "high",
  );

  const runtime = await ModelRuntime.create({ allowModelNetwork: false });
  const model = runtime.getModel("openai-codex", "gpt-5.6-sol");
  assert.ok(model);
  const modelRuntime = new Proxy(runtime, {
    get(target, property, receiver) {
      if (property === "getAvailable") return async () => [model];
      if (property === "hasConfiguredAuth") return () => true;
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const factory = createPiSessionFactory({ agentDir, modelRuntime });
  host = await factory({
    projectRoot: canonicalWorkspaceRoot,
    baseRoot,
    workspaceRoot: canonicalWorkspaceRoot,
    sessionDir,
    modelRef: "openai-codex/gpt-5.6-sol",
    thinkingLevel: "off",
    workspaceSnapshot: { truncated: false },
    directWorkspace: true,
  });

  assert.equal(host.modelRef, "openai-codex/gpt-5.6-sol");
  const resumed = SessionManager.continueRecent(canonicalWorkspaceRoot, sessionDir);
  assert.equal(host.thinkingLevel, "high", JSON.stringify({
    context: resumed.buildSessionContext(),
    entries: resumed.getEntries().map((entry) => ({
      type: entry.type,
      thinkingLevel: entry.thinkingLevel,
      provider: entry.provider,
      modelId: entry.modelId,
    })),
  }));
  assert.match(host.modelFallbackMessage, /removed-provider\/removed-model/);
  assert.equal(host.getHarnessSnapshot().modelId, "gpt-5.6-sol");
  assert.equal(host.getHarnessSnapshot().thinkingLevel, "high");
});

test("public harness snapshots expose structure without paths or private reasoning", () => {
  const snapshot = createPublicHarnessSnapshot({
    model: {
      provider: "openai-codex",
      id: "gpt-5.3-codex",
    },
    thinkingLevel: "high",
    activeTools: ["read", "grep", "read", "unknown-tool"],
    enabledSkillPaths: [
      "/private/skills/pi/SKILL.md",
      "/private/skills/html-report/SKILL.md",
    ],
    workspaceKind: "bound_project",
    workspaceSnapshot: {
      truncated: true,
      includedFiles: 42,
    },
    agentsFiles: [
      { path: "/private/project/AGENTS.md", content: "secret project rule" },
    ],
  });

  assert.equal(snapshot.runtime, "@earendil-works/pi-coding-agent");
  assert.equal(snapshot.providerId, "openai-codex");
  assert.equal(snapshot.modelId, "gpt-5.3-codex");
  assert.equal(snapshot.thinkingLevel, "high");
  assert.deepEqual(snapshot.activeTools, ["read", "grep"]);
  assert.deepEqual(snapshot.skills, ["pi", "html-report"]);
  assert.deepEqual(snapshot.context, {
    workspace: "bound_project",
    snapshot: "bounded",
    projectRules: 1,
    conversationDocuments: "on_demand",
    conversationAttachments: "on_demand",
  });
  assert.equal(snapshot.disclosure.privateReasoning, false);
  assert.match(snapshot.prompt.policyHash, /^sha256:[a-f0-9]{64}$/);
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /\/private\/|secret project rule/);
});

test("project-work thinking levels follow each Pi model's runtime capability map", () => {
  assert.deepEqual(getProjectWorkThinkingLevels({
    reasoning: false,
  }), ["off"]);
  assert.deepEqual(getProjectWorkThinkingLevels({
    reasoning: true,
  }), ["off", "minimal", "low", "medium", "high"]);
  const mappedModel = {
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
      max: "max",
    },
  };
  assert.deepEqual(getProjectWorkThinkingLevels(mappedModel), [
    "low",
    "medium",
    "high",
    "max",
  ]);
  assert.equal(getProjectWorkDefaultThinkingLevel(mappedModel), "medium");
  assert.equal(
    getProjectWorkDefaultThinkingLevel(mappedModel, "max"),
    "max",
  );
  assert.deepEqual(getProjectWorkThinkingLevels({
    ...mappedModel,
    provider: "openai-codex",
    id: "gpt-5.6-sol",
  }), [
    "low",
    "medium",
    "high",
    "max",
    PROJECT_WORK_ULTRA_THINKING_LEVEL,
  ]);
});

test("controlled Uvicorn, Vite, and static previews use closed schemas and stay inactive by default", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-preview-tool-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  const baseRoot = path.join(temporaryRoot, "base");
  const workspaceRoot = path.join(temporaryRoot, "workspace");
  await Promise.all([
    mkdir(projectRoot),
    mkdir(baseRoot),
    mkdir(workspaceRoot),
  ]);
  const requests = [];
  const tools = await createProjectWorkTools({
    projectRoot,
    baseRoot,
    workspaceRoot,
    onPlan: async () => {},
    onVerificationRequest: async () => ({ id: "verification-1" }),
    onPreviewRequest: async (request) => {
      requests.push(request);
      return {
        id: `preview-${requests.length}`,
        requestHash: `sha256:${String(requests.length).repeat(64)}`,
        executionPolicyMode: requests.length === 2
          ? "manual_review"
          : "auto_review",
      };
    },
  });
  const requestPreview = toolByName(
    tools,
    PROJECT_WORK_PREVIEW_TOOL_NAME,
  );
  const uvicornRequest = {
    runtime: "python_uvicorn",
    cwd: "backend",
    app: "app.main:app",
    route: "/reader/",
    title: "读者端",
  };
  const viteRequest = {
    runtime: "vite",
    cwd: ".",
    route: "/",
    title: "Vite 端",
  };
  const staticRequest = {
    runtime: "static",
    cwd: "dist",
    route: "/index.html",
    title: "静态端",
  };

  const autoResult = await requestPreview.execute(
    "request-preview-uvicorn",
    uvicornRequest,
  );
  const manualResult = await requestPreview.execute(
    "request-preview-vite",
    viteRequest,
  );
  await requestPreview.execute("request-preview-static", staticRequest);

  assert.deepEqual(requests, [
    uvicornRequest,
    viteRequest,
    staticRequest,
  ]);
  assert.match(
    autoResult.content[0].text,
    /preview-1.*automatically open.*do not give.*manual start commands/i,
  );
  assert.match(
    manualResult.content[0].text,
    /preview-2.*has not started.*exact in-app confirmation/i,
  );
  assert.deepEqual(autoResult.details, {
    id: "preview-1",
    requestHash: `sha256:${"1".repeat(64)}`,
  });
  assert.deepEqual(
    tools.filter((tool) => tool.parameters?.type !== "object").map((tool) => tool.name),
    [],
    "every project-work tool must expose an object-root JSON Schema",
  );
  assert.equal(requestPreview.parameters.type, "object");
  assert.deepEqual(
    requestPreview.parameters.anyOf.map((variant) => ({
      runtime: variant.properties.runtime.const,
      additionalProperties: variant.additionalProperties,
      acceptsApp: Object.hasOwn(variant.properties, "app"),
    })),
    [
      {
        runtime: "python_uvicorn",
        additionalProperties: false,
        acceptsApp: true,
      },
      {
        runtime: "vite",
        additionalProperties: false,
        acceptsApp: false,
      },
      {
        runtime: "static",
        additionalProperties: false,
        acceptsApp: false,
      },
    ],
  );
  assert.equal(
    PROJECT_WORK_DEFAULT_TOOL_NAMES.includes(PROJECT_WORK_PREVIEW_TOOL_NAME),
    false,
  );
});

test("Git closeout tool can only request one exact reviewed proposal", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-git-closeout-tool-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  const baseRoot = path.join(temporaryRoot, "base");
  const workspaceRoot = path.join(temporaryRoot, "workspace");
  await Promise.all([
    mkdir(projectRoot),
    mkdir(baseRoot),
    mkdir(workspaceRoot),
  ]);
  const requests = [];
  const tools = await createProjectWorkTools({
    projectRoot,
    baseRoot,
    workspaceRoot,
    onPlan: async () => {},
    onVerificationRequest: async () => ({ id: "verification-1" }),
    onGitCloseoutRequest: async (request) => {
      requests.push(request);
      return {
        id: "git-closeout-1",
        proposalHash: `sha256:${"a".repeat(64)}`,
        branch: "main",
        head: "1".repeat(40),
        files: request.paths.map((filePath) => ({ path: filePath })),
      };
    },
  });
  const requestGitCloseout = toolByName(tools, "request_git_closeout");
  const result = await requestGitCloseout.execute("git-closeout-call", {
    commitMessage: "fix: exact task",
    paths: ["src/task.js"],
  });
  assert.deepEqual(requests, [{
    commitMessage: "fix: exact task",
    paths: ["src/task.js"],
  }]);
  assert.match(result.content[0].text, /No commit or push has occurred/);
  assert.equal(
    requestGitCloseout.parameters.additionalProperties,
    false,
  );
  assert.deepEqual(
    Object.keys(requestGitCloseout.parameters.properties).sort(),
    ["commitMessage", "paths"],
  );
  assert.equal(
    PROJECT_WORK_DEFAULT_TOOL_NAMES.includes("request_git_closeout"),
    false,
  );
});

test("ask_user returns durable answered and cancelled outcomes without implying approval", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-ask-user-tool-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  const baseRoot = path.join(temporaryRoot, "base");
  const workspaceRoot = path.join(temporaryRoot, "workspace");
  await Promise.all([
    mkdir(projectRoot),
    mkdir(baseRoot),
    mkdir(workspaceRoot),
  ]);
  const outcomes = [{
    id: "ask-user-1",
    status: "answered",
    answers: [{ questionId: "scope", value: "backend" }],
  }, {
    id: "ask-user-2",
    status: "cancelled",
    answers: [],
  }];
  const requests = [];
  const tools = await createProjectWorkTools({
    projectRoot,
    baseRoot,
    workspaceRoot,
    onPlan: async () => {},
    onVerificationRequest: async () => ({ id: "verification-1" }),
    onAskUserRequest: async (request) => {
      requests.push(request);
      return outcomes.shift();
    },
  });
  const askUser = toolByName(tools, "ask_user");
  const question = {
    questions: [{
      id: "scope",
      prompt: "选择实现范围",
      kind: "single_choice",
      options: [{
        id: "backend",
        label: "后端",
      }, {
        id: "frontend",
        label: "前端",
      }],
    }],
  };

  const answered = await askUser.execute("ask-answered", question);
  const cancelled = await askUser.execute("ask-cancelled", question);

  assert.deepEqual(requests, [question, question]);
  assert.deepEqual(answered.details, {
    id: "ask-user-1",
    status: "answered",
    answers: [{ questionId: "scope", value: "backend" }],
  });
  assert.deepEqual(cancelled.details, {
    id: "ask-user-2",
    status: "cancelled",
    answers: [],
  });
  assert.equal(PROJECT_WORK_DEFAULT_TOOL_NAMES.includes("ask_user"), true);
});

test("generate_image is an explicit conversation-owned tool with no project write", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-image-tool-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  const baseRoot = path.join(temporaryRoot, "base");
  const workspaceRoot = path.join(temporaryRoot, "workspace");
  await Promise.all([
    mkdir(projectRoot),
    mkdir(baseRoot),
    mkdir(workspaceRoot),
  ]);
  const requests = [];
  const tools = await createProjectWorkTools({
    projectRoot,
    baseRoot,
    workspaceRoot,
    onPlan: async () => {},
    onVerificationRequest: async () => ({ id: "verification-1" }),
    onImageGenerationRequest: async (request) => {
      requests.push(request);
      return {
        id: "image-1",
        modelId: "gpt-image-2",
        width: 1254,
        height: 1254,
      };
    },
  });
  const generateImage = toolByName(tools, PROJECT_WORK_IMAGE_TOOL_NAME);
  const controller = new AbortController();
  const generated = await generateImage.execute(
    "tool-call-1",
    { prompt: "暖象牙背景上的深青色球体" },
    controller.signal,
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0].prompt, "暖象牙背景上的深青色球体");
  assert.equal(requests[0].toolCallId, "tool-call-1");
  assert.equal(requests[0].signal, controller.signal);
  assert.equal(generated.details.id, "image-1");
  assert.match(generated.content[0].text, /has not been written to the project/i);
  assert.equal(
    PROJECT_WORK_DEFAULT_TOOL_NAMES.includes(PROJECT_WORK_IMAGE_TOOL_NAME),
    false,
  );
});

test("Office tools create conversation artifacts while generated Office reads stay revision-bound", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-office-tools-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  const baseRoot = path.join(temporaryRoot, "base");
  const workspaceRoot = path.join(temporaryRoot, "workspace");
  await Promise.all([
    mkdir(projectRoot),
    mkdir(baseRoot),
    mkdir(workspaceRoot),
  ]);
  const requests = [];
  const tools = await createProjectWorkTools({
    projectRoot,
    baseRoot,
    workspaceRoot,
    officeArtifactAccess: {
      list: async () => [{
        artifact_id: "office-1",
        artifact_revision: `sha256:${"a".repeat(64)}`,
        kind: "word",
      }],
      read: async (request) => ({
        artifact_id: request.artifactId,
        artifact_revision: request.revision,
        offset: request.offset ?? 0,
        end_offset: 8,
        has_more: false,
        content: "标题\n正文",
      }),
    },
    onWordArtifactRequest: async (request) => {
      requests.push({ kind: "word", ...request });
      return { id: "office-word-1", fileName: "报告.docx" };
    },
    onExcelArtifactRequest: async (request) => {
      requests.push({ kind: "excel", ...request });
      return { id: "office-excel-1", fileName: "数据.xlsx" };
    },
  });
  const word = toolByName(tools, "write_word_document");
  const excel = toolByName(tools, "write_excel_workbook");
  const list = toolByName(tools, "list_office_artifacts");
  const read = toolByName(tools, "read_office_artifact");
  const controller = new AbortController();
  const wordRequest = {
    fileName: "报告.docx",
    title: "项目报告",
    sections: [{ heading: "结论", paragraphs: ["已完成。"] }],
  };
  const excelRequest = {
    fileName: "数据.xlsx",
    title: "项目数据",
    sheets: [{ name: "汇总", rows: [["项目", "数量"], ["A", 2]] }],
  };

  const wordResult = await word.execute("word-call", wordRequest, controller.signal);
  const excelResult = await excel.execute("excel-call", excelRequest, controller.signal);
  const listed = await list.execute("office-list", {});
  const revision = `sha256:${"a".repeat(64)}`;
  const readResult = await read.execute("office-read", {
    artifact_id: "office-1",
    artifact_revision: revision,
  });

  assert.deepEqual(requests.map(({ kind, request, toolCallId, signal }) => ({
    kind,
    request,
    toolCallId,
    signal,
  })), [{
    kind: "word",
    request: wordRequest,
    toolCallId: "word-call",
    signal: controller.signal,
  }, {
    kind: "excel",
    request: excelRequest,
    toolCallId: "excel-call",
    signal: controller.signal,
  }]);
  assert.match(wordResult.content[0].text, /no project file was written/i);
  assert.match(excelResult.content[0].text, /no project file was written/i);
  assert.equal(listed.details.artifacts[0].artifact_id, "office-1");
  assert.deepEqual(readResult.details, {
    artifactId: "office-1",
    artifactRevision: revision,
    offset: 0,
    endOffset: 8,
    hasMore: false,
  });
  assert.equal(PROJECT_WORK_DEFAULT_TOOL_NAMES.includes("write_word_document"), true);
  assert.equal(PROJECT_WORK_DEFAULT_TOOL_NAMES.includes("write_excel_workbook"), true);
  assert.equal(word.parameters.properties.sections.maxItems, 40);
  assert.equal(excel.parameters.properties.sheets.maxItems, 8);
});

test("contained read loads only enabled Skill text resources outside the project", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-skill-read-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  const baseRoot = path.join(temporaryRoot, "base");
  const workspaceRoot = path.join(temporaryRoot, "workspace");
  const skillRoot = path.join(temporaryRoot, "skills", "project-orientation");
  const outsidePath = path.join(temporaryRoot, "outside.md");
  await Promise.all([
    mkdir(projectRoot),
    mkdir(baseRoot),
    mkdir(workspaceRoot),
    mkdir(path.join(skillRoot, "references"), { recursive: true }),
  ]);
  const skillPath = path.join(skillRoot, "SKILL.md");
  const referencePath = path.join(skillRoot, "references", "guide.md");
  await Promise.all([
    writeFile(path.join(projectRoot, "README.md"), "# Project\n"),
    writeFile(skillPath, "# Orientation\nRead references/guide.md.\n"),
    writeFile(referencePath, "# Guide\nInspect the live project.\n"),
    writeFile(outsidePath, "outside\n"),
  ]);
  await symlink(outsidePath, path.join(skillRoot, "references", "escape.md"));
  const tools = await createProjectWorkTools({
    projectRoot,
    baseRoot,
    workspaceRoot,
    enabledSkillPaths: [
      path.join(temporaryRoot, "skills", "stale", "SKILL.md"),
      skillPath,
    ],
  });
  const read = toolByName(tools, "read");

  const skill = await read.execute("read-skill", { path: skillPath });
  assert.match(skill.content[0].text, /Orientation/);
  assert.deepEqual(skill.details, {
    resourceKind: "skill",
    skillName: "project-orientation",
    resourcePath: "SKILL.md",
    contentHash: skill.details.contentHash,
    startLine: 1,
    endLine: 3,
    totalLines: 3,
  });
  assert.equal(Object.hasOwn(skill.details, "path"), false);
  assert.equal(Object.hasOwn(skill.details, "evidence"), false);

  const reference = await read.execute("read-skill-reference", {
    path: referencePath,
  });
  assert.match(reference.content[0].text, /Inspect the live project/);
  assert.equal(reference.details.resourcePath, "references/guide.md");
  await assert.rejects(
    read.execute("read-outside", { path: outsidePath }),
    /项目内路径无效/,
  );
  await assert.rejects(
    read.execute("read-skill-symlink", {
      path: path.join(skillRoot, "references", "escape.md"),
    }),
    /Symbolic links/,
  );
  const project = await read.execute("read-project", { path: "README.md" });
  assert.equal(project.details.path, "README.md");
  assert.equal(Array.isArray(project.details.evidence), true);
});

test("contained project tools read live files and keep writes in the sparse review overlay", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-overlay-tools-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  const baseRoot = path.join(temporaryRoot, "base");
  const workspaceRoot = path.join(temporaryRoot, "workspace");
  await Promise.all([
    mkdir(projectRoot),
    mkdir(baseRoot),
    mkdir(workspaceRoot),
  ]);
  await writeFile(path.join(projectRoot, "app.js"), "export const value = 1;\n");
  await writeFile(path.join(projectRoot, "race.js"), "export const value = 'A';\n");
  await writeFile(
    path.join(projectRoot, "discrete-evidence.js"),
    "MATCH\none\ntwo\nthree\nfour\nMATCH\n",
  );

  const tools = await createProjectWorkTools({
    projectRoot,
    baseRoot,
    workspaceRoot,
    onPlan: async () => {},
    onVerificationRequest: async () => ({ id: "verification-1" }),
  });
  const read = toolByName(tools, "read");
  const edit = toolByName(tools, "edit");
  const write = toolByName(tools, "write");
  const grep = toolByName(tools, "grep");
  const find = toolByName(tools, "find");
  const ls = toolByName(tools, "ls");

  await writeFile(path.join(projectRoot, "created-after-session.js"), "export const late = true;\n");
  await writeFile(path.join(projectRoot, "capture-interrupted.js"), "live remains visible\n");
  await writeFile(path.join(baseRoot, "capture-interrupted.js"), "captured before interruption\n");
  const liveRead = await read.execute("read-live", {
    path: "created-after-session.js",
  });
  assert.match(liveRead.content[0].text, /late = true/);
  assert.match(liveRead.details.contentHash, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(liveRead.details.evidence, [{
    path: "created-after-session.js",
    contentHash: liveRead.details.contentHash,
    startLine: 1,
    endLine: 2,
  }]);
  assert.match(
    (await read.execute("read-interrupted-capture", {
      path: "capture-interrupted.js",
    })).content[0].text,
    /live remains visible/,
  );
  await edit.execute("resume-interrupted-capture", {
    path: "capture-interrupted.js",
    edits: [{
      oldText: "live remains visible",
      newText: "proposal after retry",
    }],
  });
  assert.equal(
    await readFile(path.join(baseRoot, "capture-interrupted.js"), "utf8"),
    "live remains visible\n",
  );
  assert.equal(
    await readFile(path.join(workspaceRoot, "capture-interrupted.js"), "utf8"),
    "proposal after retry\n",
  );
  assert.match((await ls.execute("ls-root", {})).content[0].text, /created-after-session\.js/);
  assert.match(
    (await find.execute("find-js", { pattern: "*.js" })).content[0].text,
    /created-after-session\.js/,
  );

  let changedDuringEdit = false;
  await assert.rejects(
    edit.execute("edit-race", {
      path: "race.js",
      edits: [{
        oldText: "value = 'A'",
        get newText() {
          if (!changedDuringEdit) {
            changedDuringEdit = true;
            writeFileSync(
              path.join(projectRoot, "race.js"),
              "export const value = 'B';\n",
            );
          }
          return "value = 'A-prime'";
        },
      }],
    }),
    /Project file changed while the review edit was being prepared/,
  );
  assert.equal(
    await readFile(path.join(projectRoot, "race.js"), "utf8"),
    "export const value = 'B';\n",
  );
  await assert.rejects(access(path.join(baseRoot, "race.js")));
  await assert.rejects(access(path.join(workspaceRoot, "race.js")));

  await edit.execute("edit-app", {
    path: "app.js",
    edits: [{
      oldText: "value = 1",
      newText: "value = 2",
    }],
  });
  assert.equal(await readFile(path.join(projectRoot, "app.js"), "utf8"), "export const value = 1;\n");
  assert.equal(await readFile(path.join(baseRoot, "app.js"), "utf8"), "export const value = 1;\n");
  assert.equal(
    await readFile(path.join(workspaceRoot, "app.js"), "utf8"),
    "export const value = 2;\n",
  );
  assert.match((await read.execute("read-overlay", { path: "app.js" })).content[0].text, /value = 2/);
  const grepOverlay = await grep.execute("grep-overlay", {
    pattern: "value = 2",
    path: "",
    literal: true,
  });
  assert.match(grepOverlay.content[0].text, /app\.js:1/);
  assert.deepEqual(grepOverlay.details.evidence, [{
    path: "app.js",
    contentHash: (await read.execute(
      "read-overlay-evidence",
      { path: "app.js" },
    )).details.contentHash,
    startLine: 1,
    endLine: 1,
  }]);
  const discreteEvidence = await grep.execute("grep-discrete-evidence", {
    pattern: "MATCH",
    path: "discrete-evidence.js",
    literal: true,
  });
  assert.deepEqual(
    discreteEvidence.details.evidence.map(({ startLine, endLine }) => ({
      startLine,
      endLine,
    })),
    [
      { startLine: 1, endLine: 1 },
      { startLine: 6, endLine: 6 },
    ],
  );

  await write.execute("write-new", {
    path: "src/new.js",
    content: "export const created = true;\n",
  });
  assert.equal(
    await readFile(path.join(workspaceRoot, "src", "new.js"), "utf8"),
    "export const created = true;\n",
  );
  await assert.rejects(access(path.join(baseRoot, "src", "new.js")));
  await assert.rejects(access(path.join(projectRoot, "src", "new.js")));

  await assert.rejects(
    write.execute("write-filtered", {
      path: ".env",
      content: "SECRET=no\n",
    }),
    /outside the filtered project workspace/,
  );
  await symlink(path.join(projectRoot, "app.js"), path.join(projectRoot, "linked.js"));
  await assert.rejects(
    read.execute("read-symlink", { path: "linked.js" }),
    /Symbolic links are not available/,
  );

  const attached = await readProjectWorkOverlayTextFile({
    projectRoot,
    baseRoot,
    workspaceRoot,
    filePath: "created-after-session.js",
  });
  assert.equal(attached.content, "export const late = true;\n");
  assert.match(attached.hash, /^sha256:/);
});

test("contained PDF tools expose only bounded conversation document access", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-document-tools-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  const baseRoot = path.join(temporaryRoot, "base");
  const workspaceRoot = path.join(temporaryRoot, "workspace");
  await Promise.all([
    mkdir(projectRoot),
    mkdir(baseRoot),
    mkdir(workspaceRoot),
  ]);
  const calls = [];
  const tools = await createProjectWorkTools({
    projectRoot,
    baseRoot,
    workspaceRoot,
    documentAccess: {
      async list() {
        calls.push({ type: "list" });
        return [{
          document_id: "document-1",
          file_name: "manual.pdf",
          status: "ready",
          document_revision: "sha256:current",
        }];
      },
      async search(request) {
        calls.push({ type: "search", request });
        return [{
          document_id: "document-1",
          document_revision: "sha256:current",
          block_id: "block-auth",
          excerpt: "认证令牌",
        }];
      },
      async read(request) {
        calls.push({ type: "read", request });
        return {
          document_id: "document-1",
          document_revision: "sha256:current",
          blocks: [{
            block_id: "block-auth",
            content: "认证令牌只能通过安全通道发送。",
          }],
          trust: "untrusted_reference",
        };
      },
    },
    onPlan: async () => {},
    onVerificationRequest: async () => ({ id: "verification-1" }),
  });

  const listed = await toolByName(tools, "list_documents").execute("list-docs", {});
  assert.match(listed.content[0].text, /manual\.pdf/);
  const searched = await toolByName(tools, "search_documents").execute(
    "search-docs",
    {
      query: "认证",
      document_ids: ["document-1"],
      limit: 3,
    },
  );
  assert.match(searched.content[0].text, /block-auth/);
  const read = await toolByName(tools, "read_document").execute("read-doc", {
    document_id: "document-1",
    document_revision: "sha256:current",
    block_ids: ["block-auth"],
  });
  assert.match(read.content[0].text, /untrusted_reference/);
  assert.deepEqual(calls, [{
    type: "list",
  }, {
    type: "search",
    request: {
      query: "认证",
      documentIds: ["document-1"],
      limit: 3,
    },
  }, {
    type: "read",
    request: {
      documentId: "document-1",
      revision: "sha256:current",
      blockIds: ["block-auth"],
    },
  }]);
});

test("ordinary attachment tools list, search, and read only bounded private content", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-attachment-tools-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  const baseRoot = path.join(temporaryRoot, "base");
  const workspaceRoot = path.join(temporaryRoot, "workspace");
  await Promise.all([
    mkdir(projectRoot),
    mkdir(baseRoot),
    mkdir(workspaceRoot),
  ]);
  const calls = [];
  const revision = `sha256:${"a".repeat(64)}`;
  const tools = await createProjectWorkTools({
    projectRoot,
    baseRoot,
    workspaceRoot,
    attachmentAccess: {
      async list() {
        calls.push({ type: "list" });
        return [{
          attachment_id: "attachment-1",
          attachment_revision: revision,
          file_name: "review.md",
          byte_length: 72,
        }];
      },
      async search(request) {
        calls.push({ type: "search", request });
        return [{
          attachment_id: "attachment-1",
          line: 2,
          excerpt: "primary button",
        }];
      },
      async read(request) {
        calls.push({ type: "read", request });
        return {
          attachment_id: "attachment-1",
          attachment_revision: revision,
          offset: 0,
          end_offset: 16,
          content: "# Review\nprimary",
          has_more: true,
          next_offset: 16,
          trust: "untrusted_reference",
        };
      },
    },
    onPlan: async () => {},
    onVerificationRequest: async () => ({ id: "verification-1" }),
  });

  const listed = await toolByName(tools, "list_attachments").execute(
    "list-attachments",
    {},
  );
  assert.match(listed.content[0].text, /review\.md/);
  const searched = await toolByName(tools, "search_attachments").execute(
    "search-attachments",
    {
      query: "primary",
      attachment_ids: ["attachment-1"],
      limit: 4,
    },
  );
  assert.match(searched.content[0].text, /primary button/);
  const read = await toolByName(tools, "read_attachment").execute(
    "read-attachment",
    {
      attachment_id: "attachment-1",
      attachment_revision: revision,
      offset: 0,
      limit: 16,
    },
  );
  assert.match(read.content[0].text, /untrusted_reference/);
  assert.match(read.content[0].text, /"next_offset":\s*16/);
  assert.deepEqual(calls, [{
    type: "list",
  }, {
    type: "search",
    request: {
      query: "primary",
      attachmentIds: ["attachment-1"],
      limit: 4,
    },
  }, {
    type: "read",
    request: {
      attachmentId: "attachment-1",
      revision,
      offset: 0,
      limit: 16,
    },
  }]);
});
