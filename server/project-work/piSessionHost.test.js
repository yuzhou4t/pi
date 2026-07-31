import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  createPublicHarnessSnapshot,
  createProjectWorkSubagentPolicyExtension,
  createProjectWorkTurnGuidanceExtension,
  createPiSessionFactory,
  createProjectWorkTools,
  getProjectWorkDefaultThinkingLevel,
  getProjectWorkThinkingLevels,
  PROJECT_WORK_DEFAULT_TOOL_NAMES,
  PROJECT_WORK_IMAGE_TOOL_NAME,
  PROJECT_WORK_PREVIEW_TOOL_NAME,
  PROJECT_WORK_REPAIR_TOOL_NAMES,
  PROJECT_WORK_SUBAGENT_TOOL_NAME,
  PROJECT_WORK_ULTRA_THINKING_LEVEL,
  readProjectWorkOverlayTextFile,
} from "./piSessionHost.js";

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
    imageGenerationProbe: async () => ({
      available: true,
      status: "ready",
      reasonCode: "CHATGPT_SUBSCRIPTION",
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
  });
  assert.doesNotMatch(JSON.stringify(catalog), /must-not-appear-in-catalog/);
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
  });

  const catalog = await factory.listModels();
  const model = catalog.providers[0].models[0];
  assert.equal(model.billingKind, "chatgpt_subscription");
  assert.deepEqual(model.pricing, {
    currency: "USD",
    unit: "per_million_tokens",
    source: "pi_model_catalog",
    version: "0.82.0",
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
  assert.match(source, /session\.navigateTree\(target\.entryId,\s*\{\s*summarize: false/);
  assert.match(source, /session\.sendUserMessage\(content\)/);
  assert.doesNotMatch(source, /child_process.*retryLastTurn/s);
});

test("verification repair exposes only contained overlay tools and a hidden bound failure turn", async () => {
  assert.deepEqual(PROJECT_WORK_REPAIR_TOOL_NAMES, [
    "read",
    "edit",
    "write",
    "grep",
    "find",
    "ls",
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
  assert.doesNotMatch(source, /child_process.*repairVerification/s);
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

test("Ultra subagents stay foreground, read-only, and capped at three per turn", async () => {
  const handlers = new Map();
  createProjectWorkSubagentPolicyExtension().factory({
    on(event, handler) {
      handlers.set(event, handler);
    },
  });
  const agentStart = handlers.get("agent_start");
  const toolCall = handlers.get("tool_call");
  assert.equal(typeof agentStart, "function");
  assert.equal(typeof toolCall, "function");

  await agentStart();
  const allowedInput = {
    tasks: [
      { agent: "delegate", task: "检查入口" },
      { agent: "delegate", task: "检查测试" },
      { agent: "delegate", task: "检查边界" },
    ],
    async: true,
    context: "fork",
    artifacts: true,
  };
  assert.equal(
    await toolCall({
      toolName: PROJECT_WORK_SUBAGENT_TOOL_NAME,
      input: allowedInput,
    }),
    undefined,
  );
  assert.equal(allowedInput.async, false);
  assert.equal(allowedInput.context, "fresh");
  assert.equal(allowedInput.artifacts, false);
  assert.equal(allowedInput.concurrency, 3);
  assert.equal(allowedInput.agentScope, "user");

  const fourth = await toolCall({
    toolName: PROJECT_WORK_SUBAGENT_TOOL_NAME,
    input: { agent: "delegate", task: "第四个任务" },
  });
  assert.equal(fourth.block, true);
  assert.match(fourth.reason, /最多启动 3 个/);

  await agentStart();
  const unsafe = await toolCall({
    toolName: PROJECT_WORK_SUBAGENT_TOOL_NAME,
    input: {
      agent: "delegate",
      task: "修改项目",
      output: "result.md",
    },
  });
  assert.equal(unsafe.block, true);
  assert.match(unsafe.reason, /只允许前台只读/);

  const unknownAgent = await toolCall({
    toolName: PROJECT_WORK_SUBAGENT_TOOL_NAME,
    input: { agent: "worker", task: "检查项目" },
  });
  assert.equal(unknownAgent.block, true);
  assert.match(unknownAgent.reason, /内置 delegate/);
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
    true,
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
