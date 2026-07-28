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
import {
  createPublicHarnessSnapshot,
  createProjectWorkTurnGuidanceExtension,
  createPiSessionFactory,
  createProjectWorkTools,
  getProjectWorkDefaultThinkingLevel,
  getProjectWorkThinkingLevels,
  PROJECT_WORK_DEFAULT_TOOL_NAMES,
  PROJECT_WORK_PREVIEW_TOOL_NAME,
  PROJECT_WORK_REPAIR_TOOL_NAMES,
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
  });
  assert.doesNotMatch(JSON.stringify(catalog), /must-not-appear-in-catalog/);
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
  assert.match(
    (await grep.execute("grep-overlay", {
      pattern: "value = 2",
      path: "",
      literal: true,
    })).content[0].text,
    /app\.js:1/,
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
