import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createProjectWorkService } from "./projectWorkService.js";

function incrementalId(prefix = "test") {
  let sequence = 0;
  return () => `${prefix}-${++sequence}`;
}

function modelCatalog() {
  return {
    defaultProviderId: "deepseek",
    defaultModelId: "deepseek-v4-flash",
    providers: [{
      id: "deepseek",
      label: "DeepSeek",
      models: [{
        id: "deepseek-v4-flash",
        label: "DeepSeek V4 Flash",
      }],
    }],
  };
}

function createFakeSessionFactory({
  changedContent = "export const version = 2;\n",
  additionalChanges = [],
} = {}) {
  const sessions = [];
  const factory = async (options) => {
    let subscriber = null;
    const record = {
      options,
      prompts: [],
      aborts: 0,
    };
    const host = {
      subscribe(listener) {
        subscriber = listener;
        return () => {
          subscriber = null;
        };
      },
      async prompt(prompt) {
        record.prompts.push(prompt);
        await options.onPlan({
          explanation: "先检查，再修改，最后验证。",
          steps: [
            { id: "inspect", text: "检查文件", status: "completed" },
            { id: "change", text: "准备修改", status: "completed" },
            { id: "verify", text: "等待验证", status: "pending" },
          ],
        });
        const baseFile = path.join(options.baseRoot, "app.js");
        try {
          await access(baseFile);
        } catch {
          await writeFile(
            baseFile,
            await readFile(path.join(options.projectRoot, "app.js")),
          );
        }
        await writeFile(path.join(options.workspaceRoot, "app.js"), changedContent, "utf8");
        for (const change of additionalChanges) {
          const basePath = path.join(options.baseRoot, change.path);
          try {
            await access(basePath);
          } catch {
            await writeFile(
              basePath,
              await readFile(path.join(options.projectRoot, change.path)),
            );
          }
          await writeFile(
            path.join(options.workspaceRoot, change.path),
            change.content,
            "utf8",
          );
        }
        await options.onVerificationRequest({
          file: "node",
          args: ["--test"],
          checks: ["项目测试应通过"],
        });
        subscriber?.({ type: "agent_settled" });
      },
      async steer() {},
      async abort() {
        record.aborts += 1;
      },
      async compact() {},
      async setModel() {},
      dispose() {},
    };
    record.host = host;
    sessions.push(record);
    return host;
  };
  factory.listModels = async () => modelCatalog();
  factory.dispose = async () => {};
  factory.sessions = sessions;
  return factory;
}

function createBlockingSessionFactory() {
  const sessions = [];
  const factory = async () => {
    let releasePrompt;
    const record = {
      aborts: 0,
      prompts: [],
      activeToolCalls: [],
      release() {
        releasePrompt?.();
      },
    };
    const host = {
      subscribe() {
        return () => {};
      },
      setActiveToolsByName(names) {
        record.activeToolCalls.push([...names]);
        return [...names];
      },
      prompt(prompt) {
        record.prompts.push(prompt);
        return new Promise((resolve) => {
          releasePrompt = resolve;
        });
      },
      async steer() {},
      async abort() {
        record.aborts += 1;
        record.release();
      },
      async compact() {},
      async setModel() {},
      dispose() {},
    };
    sessions.push(record);
    return host;
  };
  factory.listModels = async () => modelCatalog();
  factory.dispose = async () => {};
  factory.sessions = sessions;
  return factory;
}

function createScratchSessionFactory() {
  const sessions = [];
  const factory = async (options) => {
    let subscriber = null;
    const record = {
      options,
      prompts: [],
    };
    const host = {
      subscribe(listener) {
        subscriber = listener;
        return () => {
          subscriber = null;
        };
      },
      async prompt(prompt) {
        record.prompts.push(prompt);
        await options.onPlan({
          explanation: "先整理需求，再生成草稿。",
          steps: [
            { id: "plan", text: "整理需求", status: "completed" },
            { id: "draft", text: "生成草稿", status: "completed" },
          ],
        });
        await writeFile(
          path.join(options.workspaceRoot, "draft.md"),
          "# 独立对话草稿\n",
          "utf8",
        );
        subscriber?.({ type: "agent_settled" });
      },
      async steer() {},
      async abort() {},
      async compact() {},
      async setModel() {},
      dispose() {},
    };
    record.host = host;
    sessions.push(record);
    return host;
  };
  factory.listModelsCalls = 0;
  factory.listModels = async () => {
    factory.listModelsCalls += 1;
    return modelCatalog();
  };
  factory.dispose = async () => {};
  factory.sessions = sessions;
  return factory;
}

function createThinkingSessionFactory() {
  const sessions = [];
  const factory = async () => {
    let subscriber = null;
    const record = { prompts: [] };
    const host = {
      subscribe(listener) {
        subscriber = listener;
        return () => {
          subscriber = null;
        };
      },
      async prompt(prompt) {
        record.prompts.push(prompt);
        subscriber?.({ type: "agent_start" });
        subscriber?.({ type: "turn_start" });
        subscriber?.({
          type: "message_start",
          message: { role: "assistant" },
        });
        subscriber?.({
          type: "message_update",
          assistantMessageEvent: {
            type: "thinking_start",
            contentIndex: 0,
          },
        });
        for (let index = 0; index < 30; index += 1) {
          subscriber?.({
            type: "message_update",
            assistantMessageEvent: {
              type: "thinking_delta",
              contentIndex: 0,
              delta: `private-${index}`,
            },
          });
        }
        subscriber?.({
          type: "message_update",
          assistantMessageEvent: {
            type: "thinking_end",
            contentIndex: 0,
            content: "private reasoning must not be persisted",
          },
        });
        subscriber?.({
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 1,
            delta: "最终答案",
          },
        });
        subscriber?.({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "最终答案" }],
            stopReason: "stop",
          },
        });
        subscriber?.({ type: "turn_end" });
        subscriber?.({ type: "agent_end", willRetry: false });
        subscriber?.({ type: "agent_settled" });
      },
      async steer() {},
      async abort() {},
      async compact() {},
      async setModel() {},
      dispose() {},
    };
    record.host = host;
    sessions.push(record);
    return host;
  };
  factory.listModels = async () => modelCatalog();
  factory.dispose = async () => {};
  factory.sessions = sessions;
  return factory;
}

function createContextSessionFactory() {
  const sessions = [];
  const factory = async () => {
    let subscriber = null;
    const record = {
      prompts: [],
      contextUsage: {
        tokens: 42_000,
        contextWindow: 200_000,
        percent: 21,
      },
      emit(event) {
        subscriber?.(event);
      },
    };
    const host = {
      get autoCompactionEnabled() {
        return true;
      },
      getContextUsage() {
        return structuredClone(record.contextUsage);
      },
      subscribe(listener) {
        subscriber = listener;
        return () => {
          subscriber = null;
        };
      },
      async prompt(prompt) {
        record.prompts.push(prompt);
        if (record.prompts.length > 1) {
          record.contextUsage = {
            tokens: 28_000,
            contextWindow: 200_000,
            percent: 14,
          };
        }
        record.emit({ type: "agent_settled" });
      },
      async steer() {},
      async abort() {},
      async compact() {
        const result = {
          summary: "private summary containing /Users/private/project",
          firstKeptEntryId: "private-entry-id",
          tokensBefore: 42_000,
          estimatedTokensAfter: 18_500,
          details: {
            readFiles: ["/Users/private/project/secret.txt"],
          },
        };
        record.emit({ type: "compaction_start", reason: "manual" });
        record.contextUsage = {
          tokens: null,
          contextWindow: 200_000,
          percent: null,
        };
        record.emit({
          type: "compaction_end",
          reason: "manual",
          result,
          aborted: false,
          willRetry: false,
        });
        return result;
      },
      async setModel() {},
      dispose() {},
    };
    record.host = host;
    sessions.push(record);
    return host;
  };
  factory.listModels = async () => modelCatalog();
  factory.dispose = async () => {};
  factory.sessions = sessions;
  return factory;
}

function createThinkingLevelSessionFactory() {
  const sessions = [];
  const catalog = {
    defaultProviderId: "openai-codex",
    defaultModelId: "gpt-5.3-codex",
    defaultThinkingLevel: "medium",
    providers: [{
      id: "openai-codex",
      name: "OpenAI Codex",
      models: [{
        id: "gpt-5.3-codex",
        name: "GPT-5.3 Codex",
        supportsThinking: true,
        thinkingLevels: ["low", "medium", "high"],
        defaultThinkingLevel: "medium",
      }, {
        id: "gpt-5.3-fixed",
        name: "GPT-5.3 Fixed",
        supportsThinking: true,
        thinkingLevels: ["high", "max"],
        defaultThinkingLevel: "high",
      }],
    }],
  };
  const factory = async (options) => {
    let subscriber = null;
    const record = {
      options,
      thinkingLevel: options.thinkingLevel,
      thinkingLevelCalls: [],
      modelCalls: [],
      prompts: [],
    };
    const host = {
      subscribe(listener) {
        subscriber = listener;
        return () => {
          subscriber = null;
        };
      },
      setThinkingLevel(level) {
        record.thinkingLevelCalls.push(level);
        record.thinkingLevel = level;
        return level;
      },
      async setModel(modelRef) {
        record.modelCalls.push(modelRef);
      },
      async prompt(prompt) {
        record.prompts.push(prompt);
        subscriber?.({ type: "agent_start" });
        subscriber?.({ type: "turn_start" });
        subscriber?.({
          type: "message_start",
          message: { role: "assistant" },
        });
        subscriber?.({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "已完成" }],
            stopReason: "stop",
          },
        });
        subscriber?.({ type: "turn_end" });
        subscriber?.({ type: "agent_end", willRetry: false });
        subscriber?.({ type: "agent_settled" });
      },
      async steer() {},
      async abort() {},
      async compact() {},
      dispose() {},
    };
    record.host = host;
    sessions.push(record);
    return host;
  };
  factory.listModels = async () => structuredClone(catalog);
  factory.dispose = async () => {};
  factory.sessions = sessions;
  return factory;
}

async function eventually(read, predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await read();
    if (predicate(value)) return value;
    await delay(10);
  }
  assert.fail(message);
}

test("thinking strength is model-aware, persisted, and applied to each Pi turn", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-thinking-level-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  const storageRoot = path.join(temporaryRoot, "private-state");
  await mkdir(projectRoot);
  await writeFile(path.join(projectRoot, "app.js"), "export const value = 1;\n");
  const sessionFactory = createThinkingLevelSessionFactory();
  const service = createProjectWorkService({
    storageRoot,
    sessionFactory,
    picker: async () => ({ rootPath: projectRoot }),
    idFactory: incrementalId("thinking"),
  });
  t.after(() => service.dispose());

  const selection = await service.pickProjectRoot({ mode: "existing" });
  const project = await service.registerProject({
    selectionId: selection.selectionId,
  });
  const conversation = await service.createConversation(project.id, {
    providerId: "openai-codex",
    modelId: "gpt-5.3-codex",
  });
  assert.equal(conversation.thinkingLevel, "medium");

  const configured = await service.configureConversation(conversation.id, {
    providerId: "openai-codex",
    modelId: "gpt-5.3-codex",
    thinkingLevel: "high",
  });
  assert.equal(configured.conversation.thinkingLevel, "high");
  assert.equal(sessionFactory.sessions.length, 0);

  await service.sendMessage(conversation.id, {
    text: "检查项目",
    providerId: "openai-codex",
    modelId: "gpt-5.3-codex",
    thinkingLevel: "high",
  });
  const settled = await eventually(
    () => service.getConversation(conversation.id),
    (snapshot) => (
      snapshot.conversation.status !== "running"
      && snapshot.conversation.messages.some(
        (message) => message.role === "assistant",
      )
    ),
    "thinking-level turn did not settle",
  );
  assert.deepEqual(sessionFactory.sessions[0].thinkingLevelCalls, ["high"]);
  assert.equal(sessionFactory.sessions[0].options.thinkingLevel, "high");
  assert.deepEqual(
    settled.conversation.messages.map((message) => ({
      role: message.role,
      providerId: message.providerId,
      modelId: message.modelId,
      thinkingLevel: message.thinkingLevel,
    })),
    [{
      role: "user",
      providerId: "openai-codex",
      modelId: "gpt-5.3-codex",
      thinkingLevel: "high",
    }, {
      role: "assistant",
      providerId: "openai-codex",
      modelId: "gpt-5.3-codex",
      thinkingLevel: "high",
    }],
  );
  assert.ok(settled.events.some((event) => (
    event.type === "turn.started"
    && event.data.thinkingLevel === "high"
  )));

  await assert.rejects(
    service.configureConversation(conversation.id, {
      providerId: "openai-codex",
      modelId: "gpt-5.3-codex",
      thinkingLevel: "max",
    }),
    (error) => error?.code === "PROJECT_WORK_THINKING_LEVEL_UNSUPPORTED",
  );

  const fixed = await service.createConversation(project.id, {
    providerId: "openai-codex",
    modelId: "gpt-5.3-fixed",
  });
  assert.equal(fixed.thinkingLevel, "high");
});

test("standalone conversation creation stays lightweight when Pi has no available model", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-empty-catalog-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const factory = async () => {
    throw new Error("a lightweight empty conversation must not start Pi");
  };
  factory.listModels = async () => ({
    defaultProviderId: null,
    defaultModelId: null,
    providers: [],
  });
  factory.dispose = async () => {};
  const service = createProjectWorkService({
    storageRoot: path.join(temporaryRoot, "private-state"),
    sessionFactory: factory,
    idFactory: incrementalId("empty-catalog"),
  });
  t.after(() => service.dispose());

  const conversation = await service.createStandaloneConversation();
  assert.equal(conversation.projectId, null);
  assert.equal(conversation.providerId, null);
  assert.equal(conversation.modelId, null);
  assert.equal(conversation.thinkingLevel, "medium");
});

test("context usage stays read-only until a turn and compaction persists only safe metrics", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-context-usage-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const sessionFactory = createContextSessionFactory();
  const service = createProjectWorkService({
    storageRoot: path.join(temporaryRoot, "private-state"),
    sessionFactory,
    idFactory: incrementalId("context"),
  });
  t.after(() => service.dispose());

  const conversation = await service.createStandaloneConversation();
  const untouched = await service.getConversation(conversation.id);
  assert.equal(sessionFactory.sessions.length, 0);
  assert.deepEqual(untouched.conversation.contextUsage, {
    tokens: null,
    contextWindow: null,
    percent: null,
    status: "awaiting_measurement",
    updatedAt: null,
  });
  assert.deepEqual(untouched.conversation.compaction, {
    autoEnabled: true,
    status: "idle",
    reason: null,
    tokensBefore: null,
    estimatedTokensAfter: null,
    willRetry: false,
    completedAt: null,
  });

  await service.sendMessage(conversation.id, { text: "检查当前上下文" });
  const measured = await eventually(
    () => service.getConversation(conversation.id),
    (snapshot) => (
      snapshot.conversation.status === "idle"
      && snapshot.conversation.contextUsage.status === "estimated"
    ),
    "context usage was not refreshed after agent_settled",
  );
  assert.deepEqual(
    {
      tokens: measured.conversation.contextUsage.tokens,
      contextWindow: measured.conversation.contextUsage.contextWindow,
      percent: measured.conversation.contextUsage.percent,
      status: measured.conversation.contextUsage.status,
    },
    {
      tokens: 42_000,
      contextWindow: 200_000,
      percent: 21,
      status: "estimated",
    },
  );
  assert.equal(measured.conversation.compaction.autoEnabled, true);

  const compacted = await service.compactConversation(conversation.id);
  assert.deepEqual(
    {
      tokens: compacted.conversation.contextUsage.tokens,
      contextWindow: compacted.conversation.contextUsage.contextWindow,
      percent: compacted.conversation.contextUsage.percent,
      status: compacted.conversation.contextUsage.status,
    },
    {
      tokens: null,
      contextWindow: 200_000,
      percent: null,
      status: "awaiting_measurement",
    },
  );
  assert.equal(compacted.conversation.compaction.status, "completed");
  assert.equal(compacted.conversation.compaction.reason, "manual");
  assert.equal(compacted.conversation.compaction.tokensBefore, 42_000);
  assert.equal(compacted.conversation.compaction.estimatedTokensAfter, 18_500);
  assert.equal(compacted.conversation.compaction.willRetry, false);
  assert.ok(compacted.conversation.compaction.completedAt);

  const publicPayload = JSON.stringify(compacted);
  assert.doesNotMatch(publicPayload, /private summary|private-entry-id|secret\.txt/);

  await service.sendMessage(conversation.id, { text: "继续下一轮" });
  const remeasured = await eventually(
    () => service.getConversation(conversation.id),
    (snapshot) => (
      snapshot.conversation.status === "idle"
      && snapshot.conversation.contextUsage.status === "estimated"
    ),
    "context usage was not remeasured after the post-compaction turn",
  );
  assert.equal(remeasured.conversation.contextUsage.tokens, 28_000);
  assert.equal(remeasured.conversation.contextUsage.percent, 14);
});

test("automatic compaction failure records a safe terminal state", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-auto-compaction-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const sessionFactory = createContextSessionFactory();
  const service = createProjectWorkService({
    storageRoot: path.join(temporaryRoot, "private-state"),
    sessionFactory,
    idFactory: incrementalId("auto-context"),
  });
  t.after(() => service.dispose());

  const conversation = await service.createStandaloneConversation();
  await service.sendMessage(conversation.id, { text: "建立会话" });
  await eventually(
    () => service.getConversation(conversation.id),
    (snapshot) => snapshot.conversation.status === "idle",
    "initial turn did not settle",
  );

  const session = sessionFactory.sessions[0];
  session.emit({ type: "compaction_start", reason: "threshold" });
  session.emit({
    type: "compaction_end",
    reason: "threshold",
    result: undefined,
    aborted: false,
    willRetry: false,
    errorMessage: "private provider error at /Users/private/project",
  });
  const failed = await eventually(
    () => service.getConversation(conversation.id),
    (snapshot) => snapshot.conversation.compaction.status === "failed",
    "automatic compaction failure was not persisted",
  );

  assert.equal(failed.conversation.status, "idle");
  assert.equal(failed.conversation.compaction.autoEnabled, true);
  assert.equal(failed.conversation.compaction.reason, "threshold");
  assert.equal(failed.conversation.compaction.tokensBefore, null);
  assert.equal(failed.conversation.compaction.estimatedTokensAfter, null);
  assert.ok(failed.conversation.compaction.completedAt);
  assert.doesNotMatch(JSON.stringify(failed), /private provider error|Users\/private/);
  assert.deepEqual(
    failed.events
      .filter((event) => event.type.startsWith("compaction."))
      .map((event) => ({
        type: event.type,
        reason: event.data.reason,
        status: event.data.status,
      })),
    [{
      type: "compaction.started",
      reason: "threshold",
      status: undefined,
    }, {
      type: "compaction.completed",
      reason: "threshold",
      status: "failed",
    }],
  );
});

test("restoring an interrupted automatic compaction terminates its running state", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-compaction-restore-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const storageRoot = path.join(temporaryRoot, "private-state");
  const interruptedAt = new Date("2026-07-26T10:00:00.000Z");
  const service = createProjectWorkService({
    storageRoot,
    sessionFactory: createContextSessionFactory(),
    now: () => interruptedAt,
    idFactory: incrementalId("restore-context"),
  });
  t.after(() => service.dispose());

  const conversation = await service.createStandaloneConversation();
  const statePath = path.join(
    storageRoot,
    "conversations",
    conversation.id,
    "conversation.json",
  );
  const persisted = JSON.parse(await readFile(statePath, "utf8"));
  await writeFile(statePath, `${JSON.stringify({
    ...persisted,
    status: "running",
    compaction: {
      autoEnabled: true,
      status: "running",
      reason: "threshold",
      tokensBefore: 61_000,
      estimatedTokensAfter: 22_000,
      willRetry: false,
      completedAt: null,
    },
  }, null, 2)}\n`);

  const restored = await service.getConversation(conversation.id);
  assert.equal(restored.conversation.status, "interrupted");
  assert.deepEqual(restored.conversation.compaction, {
    autoEnabled: true,
    status: "aborted",
    reason: "threshold",
    tokensBefore: 61_000,
    estimatedTokensAfter: 22_000,
    willRetry: false,
    completedAt: interruptedAt.toISOString(),
  });
  assert.equal(restored.conversation.lastError.code, "PROJECT_WORK_SESSION_INTERRUPTED");
});

test("thinking deltas persist only one lifecycle pair per agent run", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-thinking-events-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const service = createProjectWorkService({
    storageRoot: path.join(temporaryRoot, "private-state"),
    sessionFactory: createThinkingSessionFactory(),
    idFactory: incrementalId("thinking"),
  });
  t.after(() => service.dispose());

  const conversation = await service.createStandaloneConversation();
  await service.sendMessage(conversation.id, { text: "第一轮" });
  await eventually(
    () => service.getConversation(conversation.id),
    (snapshot) => (
      snapshot.conversation.status === "idle"
      && snapshot.conversation.messages.length === 2
    ),
    "first thinking turn did not settle",
  );
  await service.sendMessage(conversation.id, { text: "第二轮" });
  const settled = await eventually(
    () => service.getConversation(conversation.id),
    (snapshot) => (
      snapshot.conversation.status === "idle"
      && snapshot.conversation.messages.length === 4
    ),
    "second thinking turn did not settle",
  );

  const thinkingEvents = settled.events.filter(
    (event) => event.type === "agent.thinking",
  );
  assert.deepEqual(
    thinkingEvents.map((event) => event.data.status),
    ["active", "finished", "active", "finished"],
  );
  assert.equal(
    JSON.stringify(thinkingEvents).includes("private reasoning"),
    false,
  );
  assert.equal(JSON.stringify(thinkingEvents).includes("private-0"), false);
  const completedEvents = settled.events.filter(
    (event) => event.type === "message.completed",
  );
  assert.equal(completedEvents.length, 2);
  assert.ok(thinkingEvents[1].seq < completedEvents[0].seq);
  assert.ok(thinkingEvents[3].seq < completedEvents[1].seq);
});

test("create-mode picking accepts no name and public project data never leaks its path", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-project-create-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const parentRoot = path.join(temporaryRoot, "selected-parent");
  await mkdir(parentRoot);
  const service = createProjectWorkService({
    storageRoot: path.join(temporaryRoot, "private-state"),
    sessionFactory: createFakeSessionFactory(),
    picker: async ({ mode, name }) => {
      assert.equal(mode, "create");
      assert.equal(name, undefined);
      return { parentPath: parentRoot };
    },
    idFactory: incrementalId("create"),
  });
  t.after(() => service.dispose());

  const selection = await service.pickProjectRoot({ mode: "create" });
  assert.equal(selection.mode, "create");
  assert.equal(Object.hasOwn(selection, "parentPath"), false);
  assert.equal(JSON.stringify(selection).includes(parentRoot), false);

  const project = await service.registerProject({
    selectionId: selection.selectionId,
    name: "Fresh Project",
  });

  assert.equal(project.name, "Fresh Project");
  assert.equal(project.rootLabel, "Fresh Project");
  assert.equal(Object.hasOwn(project, "rootPath"), false);
  assert.equal(JSON.stringify(project).includes(parentRoot), false);
  assert.equal(await readFile(
    path.join(temporaryRoot, "private-state", "projects.json"),
    "utf8",
  ).then((value) => value.includes(parentRoot)), true);
});

test("creating empty conversations performs no project snapshot or copy", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-project-empty-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  const storageRoot = path.join(temporaryRoot, "private-state");
  await mkdir(projectRoot);
  await writeFile(path.join(projectRoot, "app.js"), "export const ready = true;\n");
  let snapshotCalls = 0;
  const service = createProjectWorkService({
    storageRoot,
    sessionFactory: createFakeSessionFactory(),
    snapshotter: async () => {
      snapshotCalls += 1;
      throw new Error("empty conversations must not create a snapshot");
    },
    picker: async () => ({ rootPath: projectRoot }),
    idFactory: incrementalId("empty"),
  });
  t.after(() => service.dispose());

  const selection = await service.pickProjectRoot({ mode: "existing" });
  const project = await service.registerProject({
    selectionId: selection.selectionId,
  });
  const conversations = await Promise.all([
    service.createConversation(project.id),
    service.createConversation(project.id),
  ]);

  assert.equal(snapshotCalls, 0);
  for (const conversation of conversations) {
    const directory = path.join(storageRoot, "conversations", conversation.id);
    assert.deepEqual(await readdir(path.join(directory, "base")), []);
    assert.deepEqual(await readdir(path.join(directory, "workspace")), []);
    const current = await service.getConversation(conversation.id);
    assert.equal(current.conversation.workspaceSnapshot.mode, "sparse_overlay");
    assert.equal(current.conversation.workspaceSnapshot.includedFiles, 0);
  }
  const legacyStatePath = path.join(
    storageRoot,
    "conversations",
    conversations[0].id,
    "conversation.json",
  );
  const legacyState = JSON.parse(await readFile(legacyStatePath, "utf8"));
  delete legacyState.workspaceKind;
  delete legacyState.rootLabel;
  await writeFile(legacyStatePath, `${JSON.stringify(legacyState, null, 2)}\n`, "utf8");
  const restoredLegacy = await service.getConversation(conversations[0].id);
  assert.equal(restoredLegacy.conversation.workspaceKind, "bound_project");
  assert.equal(restoredLegacy.conversation.scope, "project");
});

test("standalone conversations stay projectless, start lazily, and commit only to their private scratch root", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-standalone-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "bound-project");
  const storageRoot = path.join(temporaryRoot, "private-state");
  await mkdir(projectRoot);
  await writeFile(path.join(projectRoot, "keep.txt"), "bound project\n", "utf8");
  let pickerCalls = 0;
  let snapshotCalls = 0;
  const sessionFactory = createScratchSessionFactory();
  const service = createProjectWorkService({
    storageRoot,
    sessionFactory,
    snapshotter: async () => {
      snapshotCalls += 1;
      throw new Error("standalone creation must not materialize a snapshot");
    },
    picker: async () => {
      pickerCalls += 1;
      return { rootPath: projectRoot };
    },
    idFactory: incrementalId("standalone"),
  });
  t.after(() => service.dispose());

  const selection = await service.pickProjectRoot({ mode: "existing" });
  const project = await service.registerProject({ selectionId: selection.selectionId });
  const bound = await service.createConversation(project.id);
  const modelListCallsBeforeStandalone = sessionFactory.listModelsCalls;
  const standalone = await service.createStandaloneConversation({
    title: "无文件夹任务",
  });

  assert.equal(pickerCalls, 1);
  assert.equal(snapshotCalls, 0);
  assert.equal(sessionFactory.sessions.length, 0);
  assert.equal(sessionFactory.listModelsCalls, modelListCallsBeforeStandalone);
  assert.equal(standalone.projectId, null);
  assert.equal(standalone.workspaceKind, "scratch");
  assert.equal(standalone.scope, "standalone");
  assert.equal(standalone.rootLabel, "未连接文件夹");
  assert.equal(JSON.stringify(standalone).includes(storageRoot), false);
  assert.deepEqual(
    (await service.listStandaloneConversations()).map((item) => item.id),
    [standalone.id],
  );
  assert.deepEqual(
    (await service.listConversations(project.id)).map((item) => item.id),
    [bound.id],
  );

  const conversationDirectory = path.join(
    storageRoot,
    "conversations",
    standalone.id,
  );
  const scratchRoot = path.join(conversationDirectory, "scratch");
  assert.deepEqual(await readdir(scratchRoot), []);
  assert.deepEqual(await readdir(path.join(conversationDirectory, "base")), []);
  assert.deepEqual(await readdir(path.join(conversationDirectory, "workspace")), []);

  await service.sendMessage(standalone.id, { text: "生成一个草稿文件" });
  const settled = await eventually(
    () => service.getConversation(standalone.id),
    (snapshot) => snapshot.conversation.status === "awaiting_confirmation",
    "standalone scratch change did not become reviewable",
  );
  assert.equal(sessionFactory.sessions.length, 1);
  assert.equal(sessionFactory.sessions[0].options.workspaceKind, "scratch");
  assert.equal(sessionFactory.sessions[0].options.projectRoot, await realpath(scratchRoot));
  assert.equal(settled.conversation.workspaceSnapshot.mode, "scratch");
  assert.equal(settled.conversation.activeChangeSet.files.length, 1);
  assert.equal(settled.conversation.activeChangeSet.files[0].path, "draft.md");
  await assert.rejects(access(path.join(scratchRoot, "draft.md")), { code: "ENOENT" });
  assert.equal(await readFile(path.join(projectRoot, "keep.txt"), "utf8"), "bound project\n");

  const changeSet = settled.conversation.activeChangeSet;
  const changedFile = changeSet.files[0];
  await service.applyChangeSet(standalone.id, {
    changeSetId: changeSet.id,
    changeSetHash: changeSet.hash,
    files: [{
      fileId: changedFile.id,
      baseHash: changedFile.baseHash,
      afterHash: changedFile.afterHash,
    }],
  });
  assert.equal(
    await readFile(path.join(scratchRoot, "draft.md"), "utf8"),
    "# 独立对话草稿\n",
  );
  assert.equal(await readFile(path.join(projectRoot, "keep.txt"), "utf8"), "bound project\n");
  const tree = await service.getConversationTree(standalone.id);
  assert.equal(JSON.stringify(tree).includes("draft.md"), true);
  assert.equal(JSON.stringify(tree).includes(storageRoot), false);
  const boundTree = await service.getConversationTree(bound.id);
  assert.equal(JSON.stringify(boundTree).includes("keep.txt"), true);

  await assert.rejects(
    service.removeConversation(project.id, standalone.id),
    (error) => error?.code === "PROJECT_WORK_CONVERSATION_NOT_FOUND",
  );
  await assert.rejects(
    service.removeStandaloneConversation(bound.id),
    (error) => error?.code === "PROJECT_WORK_CONVERSATION_NOT_FOUND",
  );
  await assert.rejects(
    service.renameConversation(project.id, standalone.id, { title: "不应成功" }),
    (error) => error?.code === "PROJECT_WORK_CONVERSATION_NOT_FOUND",
  );
  await assert.rejects(
    service.renameStandaloneConversation(bound.id, { title: "不应成功" }),
    (error) => error?.code === "PROJECT_WORK_CONVERSATION_NOT_FOUND",
  );
  const renamed = await service.renameStandaloneConversation(standalone.id, {
    title: "独立任务草稿",
  });
  assert.equal(renamed.title, "独立任务草稿");
  const removed = await service.removeStandaloneConversation(standalone.id);
  assert.deepEqual(removed, {
    id: standalone.id,
    projectId: null,
    removed: true,
    conversationCount: 0,
  });
  await assert.rejects(access(conversationDirectory), { code: "ENOENT" });
});

test("conversation file reads prefer overlay content and can open overlay-only files", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-conversation-file-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "private-project");
  const storageRoot = path.join(temporaryRoot, "private-state");
  await mkdir(projectRoot);
  await writeFile(path.join(projectRoot, "app.js"), "export const source = 'live';\n");
  const service = createProjectWorkService({
    storageRoot,
    sessionFactory: createFakeSessionFactory(),
    picker: async () => ({ rootPath: projectRoot }),
    idFactory: incrementalId("conversation-file"),
  });
  t.after(() => service.dispose());

  const selection = await service.pickProjectRoot({ mode: "existing" });
  const project = await service.registerProject({
    selectionId: selection.selectionId,
  });
  const conversation = await service.createConversation(project.id);
  const overlayRoot = path.join(
    storageRoot,
    "conversations",
    conversation.id,
    "workspace",
  );
  await mkdir(path.join(overlayRoot, "src"));
  await writeFile(path.join(overlayRoot, "app.js"), "export const source = 'overlay';\n");
  await writeFile(
    path.join(overlayRoot, "src", "generated.js"),
    "export const generated = true;\n",
  );

  const modified = await service.readConversationFile(conversation.id, {
    filePath: "app.js",
  });
  const created = await service.readConversationFile(conversation.id, {
    filePath: "src/generated.js",
  });
  const live = await service.readProjectFile(project.id, {
    filePath: "app.js",
  });

  assert.match(modified.content, /source = 'overlay'/);
  assert.match(created.content, /generated = true/);
  assert.notEqual(modified.hash, live.hash);
  assert.equal(JSON.stringify({ modified, created }).includes(projectRoot), false);
  assert.equal(JSON.stringify({ modified, created }).includes(storageRoot), false);
});

test("a replaced bound root is rejected before a live-overlay conversation starts", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-project-replaced-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  const movedRoot = path.join(temporaryRoot, "project-original");
  await mkdir(projectRoot);
  const service = createProjectWorkService({
    storageRoot: path.join(temporaryRoot, "private-state"),
    sessionFactory: createFakeSessionFactory(),
    picker: async () => ({ rootPath: projectRoot }),
    idFactory: incrementalId("replaced"),
  });
  t.after(() => service.dispose());

  const selection = await service.pickProjectRoot({ mode: "existing" });
  const project = await service.registerProject({
    selectionId: selection.selectionId,
  });
  await rename(projectRoot, movedRoot);
  await mkdir(projectRoot);

  await assert.rejects(
    service.createConversation(project.id),
    (error) => {
      assert.equal(error.code, "PROJECT_WORK_ROOT_CHANGED");
      assert.equal(error.status, 409);
      return true;
    },
  );
});

test("empty review overlays still filter unsafe project paths", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-project-venv-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "private-project-root");
  const storageRoot = path.join(temporaryRoot, "private-state");
  const virtualEnvironment = path.join(
    projectRoot,
    "benchmark-baselines",
    "DeepScientist",
    ".venv",
    "lib",
  );
  const assetDirectory = path.join(
    projectRoot,
    "benchmark-baselines",
    "DeepScientist",
    "assets",
    "readme",
  );
  await mkdir(virtualEnvironment, { recursive: true });
  await mkdir(assetDirectory, { recursive: true });
  await writeFile(path.join(projectRoot, "app.py"), "print('ready')\n", "utf8");
  await writeFile(
    path.join(virtualEnvironment, "_rust.abi3.so"),
    Buffer.alloc((4 * 1024 * 1024) + 1),
  );
  await writeFile(
    path.join(assetDirectory, "paper-output-1.png"),
    Buffer.alloc((4 * 1024 * 1024) + 1),
  );

  const service = createProjectWorkService({
    storageRoot,
    sessionFactory: createFakeSessionFactory(),
    picker: async () => ({ rootPath: projectRoot }),
    idFactory: incrementalId("venv"),
  });
  t.after(() => service.dispose());

  const selection = await service.pickProjectRoot({ mode: "existing" });
  const project = await service.registerProject({
    selectionId: selection.selectionId,
  });
  const conversation = await service.createConversation(project.id);
  const tree = await service.getProjectTree(project.id, { depth: 5 });
  const snapshot = await service.getConversation(conversation.id);

  assert.equal(conversation.status, "idle");
  assert.equal(snapshot.conversation.workspaceSnapshot.truncated, false);
  assert.equal(snapshot.conversation.workspaceSnapshot.includedFiles, 0);
  assert.equal(snapshot.conversation.workspaceSnapshot.mode, "sparse_overlay");
  assert.equal(JSON.stringify(tree).includes(".venv"), false);
});

test("verification never runs from a truncated or skipped project materialization", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-verification-incomplete-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  const storageRoot = path.join(temporaryRoot, "private-state");
  await mkdir(projectRoot);
  const source = "export const version = 1;\n";
  await writeFile(path.join(projectRoot, "app.js"), source);
  const reports = [
    {
      files: 1,
      bytes: source.length,
      truncated: true,
      skippedBinaryFiles: 0,
      skippedOversizedFiles: 0,
    },
    {
      files: 1,
      bytes: source.length,
      truncated: false,
      skippedBinaryFiles: 1,
      skippedOversizedFiles: 0,
    },
    {
      files: 1,
      bytes: source.length,
      truncated: false,
      skippedBinaryFiles: 0,
      skippedOversizedFiles: 1,
    },
  ];
  let runnerCalls = 0;
  const service = createProjectWorkService({
    storageRoot,
    sessionFactory: createFakeSessionFactory({ changedContent: source }),
    snapshotter: async ({ baseRoot, workspaceRoot }) => {
      await Promise.all([
        mkdir(baseRoot, { recursive: true }),
        mkdir(workspaceRoot, { recursive: true }),
      ]);
      return reports.shift();
    },
    picker: async () => ({ rootPath: projectRoot }),
    runner: async () => {
      runnerCalls += 1;
      return {
        exitCode: 0,
        durationMs: 1,
        stdout: "must not run",
        stderr: "",
        truncated: false,
        timedOut: false,
        aborted: false,
      };
    },
    idFactory: incrementalId("incomplete"),
  });
  t.after(() => service.dispose());

  const selection = await service.pickProjectRoot({ mode: "existing" });
  const project = await service.registerProject({
    selectionId: selection.selectionId,
  });
  const conversation = await service.createConversation(project.id);
  await service.sendMessage(conversation.id, {
    text: "Prepare a verification request without changing the file.",
  });
  const settled = await eventually(
    () => service.getConversation(conversation.id),
    (snapshot) => (
      snapshot.conversation.status === "idle"
      && snapshot.conversation.verifications.some((item) => item.status === "requested")
    ),
    "verification request was not prepared",
  );
  const request = settled.conversation.verifications.find(
    (item) => item.status === "requested",
  );

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const completed = await service.runVerification(conversation.id, {
      requestId: request.id,
    });
    assert.equal(completed.status, "failed");
    assert.equal(completed.exitCode, null);
    assert.match(completed.output, /无法完整物化项目，未运行验证/);
  }
  assert.equal(runnerCalls, 0);
  assert.equal(reports.length, 0);
});

test("real project-work chain binds context and changes, applies by hash, and preserves verification attempts", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-project-chain-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "private-project-root");
  const storageRoot = path.join(temporaryRoot, "private-state");
  await mkdir(projectRoot);
  await writeFile(
    path.join(projectRoot, "app.js"),
    "export const version = 1;\n",
    "utf8",
  );

  const sessionFactory = createFakeSessionFactory();
  const runnerCalls = [];
  let verificationAttempt = 0;
  const service = createProjectWorkService({
    storageRoot,
    sessionFactory,
    picker: async ({ mode }) => {
      assert.equal(mode, "existing");
      return { rootPath: projectRoot };
    },
    runner: async (request) => {
      runnerCalls.push(request);
      verificationAttempt += 1;
      return verificationAttempt === 1
        ? {
            exitCode: 0,
            durationMs: 12,
            stdout: `passed in ${request.cwd}`,
            stderr: "",
            truncated: false,
            timedOut: false,
            aborted: false,
          }
        : {
            exitCode: 1,
            durationMs: 7,
            stdout: "",
            stderr: "one assertion failed",
            truncated: false,
            timedOut: false,
            aborted: false,
          };
    },
    idFactory: incrementalId("chain"),
  });
  t.after(() => service.dispose());

  const selection = await service.pickProjectRoot({ mode: "existing" });
  const project = await service.registerProject({
    selectionId: selection.selectionId,
    name: "Bound project",
  });
  const conversation = await service.createConversation(project.id, {
    title: "Make a safe change",
  });

  for (const value of [selection, project, conversation]) {
    assert.equal(JSON.stringify(value).includes(projectRoot), false);
    assert.equal(JSON.stringify(value).includes(storageRoot), false);
  }

  const file = await service.readProjectFile(project.id, {
    filePath: "app.js",
  });
  await assert.rejects(
    service.sendMessage(conversation.id, {
      text: "Use the attached file.",
      context: [{
        path: "app.js",
        startLine: 1,
        endLine: 1,
        contentHash: `${file.hash}-stale`,
      }],
    }),
    (error) => {
      assert.equal(error.code, "PROJECT_WORK_CONTEXT_STALE");
      assert.equal(error.status, 409);
      assert.equal(error.retryable, true);
      return true;
    },
  );
  assert.equal(sessionFactory.sessions.length, 0);

  await writeFile(path.join(projectRoot, "created-after-snapshot.js"), "late\n");
  const liveContextFile = await service.readProjectFile(project.id, {
    filePath: "created-after-snapshot.js",
  });
  await service.sendMessage(conversation.id, {
    text: "Update the implementation and prepare its verification.",
    context: [{
      path: "created-after-snapshot.js",
      startLine: 1,
      endLine: 1,
      contentHash: liveContextFile.hash,
    }],
  });
  assert.match(sessionFactory.sessions[0].prompts[0], /created-after-snapshot\.js/);
  assert.match(sessionFactory.sessions[0].prompts[0], /late/);
  assert.equal(
    sessionFactory.sessions[0].options.workspaceSnapshot.truncated,
    false,
  );
  assert.equal(
    sessionFactory.sessions[0].options.workspaceSnapshot.mode,
    "sparse_overlay",
  );
  const settled = await eventually(
    () => service.getConversation(conversation.id),
    (snapshot) => snapshot.conversation.status === "awaiting_confirmation",
    "agent_settled did not produce a reviewable change set",
  );

  assert.equal(settled.conversation.plan.steps.length, 3);
  assert.equal(settled.conversation.activeChangeSet.status, "ready");
  assert.equal(settled.conversation.activeChangeSet.files.length, 1);
  assert.equal(settled.conversation.pendingChangeFileCount, 1);
  const listedWhilePending = await service.listConversations(project.id);
  assert.equal(listedWhilePending[0].pendingChangeFileCount, 1);
  const renamedWhilePending = await service.renameConversation(
    project.id,
    conversation.id,
    { title: "Review the safe change" },
  );
  assert.equal(renamedWhilePending.pendingChangeFileCount, 1);
  const changeReady = settled.events.find(
    (event) => event.type === "change_set.ready",
  );
  const awaitingConfirmation = settled.events.find(
    (event) => (
      event.type === "agent.status"
      && event.data.status === "awaiting_confirmation"
    ),
  );
  assert.ok(changeReady);
  assert.ok(awaitingConfirmation);
  assert.ok(changeReady.seq < awaitingConfirmation.seq);

  const changeSet = settled.conversation.activeChangeSet;
  const changedFile = changeSet.files[0];
  const bindings = [{
    fileId: changedFile.id,
    baseHash: changedFile.baseHash,
    afterHash: changedFile.afterHash,
  }];
  await assert.rejects(
    service.applyChangeSet(conversation.id, {
      changeSetId: changeSet.id,
      changeSetHash: "sha256:wrong",
      files: bindings,
    }),
    (error) => {
      assert.equal(error.code, "PROJECT_WORK_CHANGE_BINDING_MISMATCH");
      return true;
    },
  );
  assert.equal(
    await readFile(path.join(projectRoot, "app.js"), "utf8"),
    "export const version = 1;\n",
  );

  const applied = await service.applyChangeSet(conversation.id, {
    changeSetId: changeSet.id,
    changeSetHash: changeSet.hash,
    files: bindings,
  });
  assert.equal(applied.appliedChangeSet.status, "applied");
  assert.equal(applied.remainingChangeSet.status, "clean");
  assert.equal(
    (await service.listConversations(project.id))[0].pendingChangeFileCount,
    0,
  );
  assert.equal(
    await readFile(path.join(projectRoot, "app.js"), "utf8"),
    "export const version = 2;\n",
  );
  const privateConversationRoot = path.join(
    storageRoot,
    "conversations",
    conversation.id,
  );
  await assert.rejects(access(path.join(privateConversationRoot, "base", "app.js")));
  await assert.rejects(access(path.join(privateConversationRoot, "workspace", "app.js")));

  const requestedVerification = settled.conversation.verifications.find(
    (item) => item.status === "requested",
  );
  assert.ok(requestedVerification);
  const passed = await service.runVerification(conversation.id, {
    requestId: requestedVerification.id,
  });
  const failed = await service.runVerification(conversation.id, {
    requestId: requestedVerification.id,
  });

  assert.equal(passed.status, "passed");
  assert.equal(passed.exitCode, 0);
  assert.equal(passed.output.includes(storageRoot), false);
  assert.match(passed.output, /<workspace>/);
  assert.equal(failed.status, "failed");
  assert.equal(failed.exitCode, 1);
  assert.equal(runnerCalls.length, 2);
  const canonicalStorageRoot = await realpath(storageRoot);
  assert.equal(
    runnerCalls.every((call) => {
      const relative = path.relative(canonicalStorageRoot, call.cwd);
      return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
    }),
    true,
  );
  assert.equal(runnerCalls.every((call) => call.cwd !== projectRoot), true);

  const history = await service.listVerifications(conversation.id);
  assert.deepEqual(
    history.map((item) => item.status),
    ["requested", "passed", "failed"],
  );
});

test("partial apply keeps unselected files reviewable and blocks verification", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-project-partial-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  await mkdir(projectRoot);
  await writeFile(path.join(projectRoot, "app.js"), "app v1\n", "utf8");
  await writeFile(path.join(projectRoot, "other.js"), "other v1\n", "utf8");

  const service = createProjectWorkService({
    storageRoot: path.join(temporaryRoot, "private-state"),
    sessionFactory: createFakeSessionFactory({
      changedContent: "app v2\n",
      additionalChanges: [{
        path: "other.js",
        content: "other v2\n",
      }],
    }),
    picker: async () => ({ rootPath: projectRoot }),
    idFactory: incrementalId("partial"),
  });
  t.after(() => service.dispose());

  const selection = await service.pickProjectRoot({ mode: "existing" });
  const project = await service.registerProject({ selectionId: selection.selectionId });
  const conversation = await service.createConversation(project.id);
  await service.sendMessage(conversation.id, { text: "修改两个文件" });
  const settled = await eventually(
    () => service.getConversation(conversation.id),
    (snapshot) => snapshot.conversation.status === "awaiting_confirmation",
    "two-file change set did not become reviewable",
  );
  const initial = settled.conversation.activeChangeSet;
  assert.equal(initial.files.length, 2);
  const appFile = initial.files.find((file) => file.path === "app.js");

  const partial = await service.applyChangeSet(conversation.id, {
    changeSetId: initial.id,
    changeSetHash: initial.hash,
    files: [{
      fileId: appFile.id,
      baseHash: appFile.baseHash,
      afterHash: appFile.afterHash,
    }],
  });
  assert.equal(partial.appliedChangeSet.status, "partially_applied");
  assert.equal(partial.remainingChangeSet.status, "ready");
  assert.deepEqual(
    partial.remainingChangeSet.files.map((file) => file.path),
    ["other.js"],
  );
  assert.equal(await readFile(path.join(projectRoot, "app.js"), "utf8"), "app v2\n");
  assert.equal(await readFile(path.join(projectRoot, "other.js"), "utf8"), "other v1\n");

  const afterPartial = await service.getConversation(conversation.id);
  assert.equal(afterPartial.conversation.status, "awaiting_confirmation");
  assert.equal(afterPartial.conversation.activeChangeSet.status, "ready");
  assert.deepEqual(
    afterPartial.conversation.activeChangeSet.files.map((file) => file.path),
    ["other.js"],
  );
  const verification = afterPartial.conversation.verifications.find(
    (item) => item.status === "requested",
  );
  await assert.rejects(
    service.runVerification(conversation.id, { requestId: verification.id }),
    (error) => {
      assert.equal(error.code, "PROJECT_WORK_CHANGES_NOT_APPLIED");
      return true;
    },
  );

  const remaining = afterPartial.conversation.activeChangeSet;
  const otherFile = remaining.files[0];
  const completed = await service.applyChangeSet(conversation.id, {
    changeSetId: remaining.id,
    changeSetHash: remaining.hash,
    files: [{
      fileId: otherFile.id,
      baseHash: otherFile.baseHash,
      afterHash: otherFile.afterHash,
    }],
  });
  assert.equal(completed.remainingChangeSet.status, "clean");
  assert.equal(await readFile(path.join(projectRoot, "other.js"), "utf8"), "other v2\n");
});

test("deleting conversations removes only their private state and updates project counts", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-conversation-delete-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const firstProjectRoot = path.join(temporaryRoot, "first-project");
  const secondProjectRoot = path.join(temporaryRoot, "second-project");
  const storageRoot = path.join(temporaryRoot, "private-state");
  await Promise.all([
    mkdir(firstProjectRoot),
    mkdir(secondProjectRoot),
  ]);
  await Promise.all([
    writeFile(path.join(firstProjectRoot, "app.js"), "first project\n", "utf8"),
    writeFile(path.join(secondProjectRoot, "app.js"), "second project\n", "utf8"),
  ]);
  const pickedRoots = [firstProjectRoot, secondProjectRoot];
  const service = createProjectWorkService({
    storageRoot,
    sessionFactory: createFakeSessionFactory(),
    picker: async () => ({ rootPath: pickedRoots.shift() }),
    idFactory: incrementalId("delete"),
  });
  t.after(() => service.dispose());

  const firstSelection = await service.pickProjectRoot({ mode: "existing" });
  const firstProject = await service.registerProject({
    selectionId: firstSelection.selectionId,
  });
  const secondSelection = await service.pickProjectRoot({ mode: "existing" });
  const secondProject = await service.registerProject({
    selectionId: secondSelection.selectionId,
  });
  const firstConversation = await service.createConversation(firstProject.id);
  const remainingConversation = await service.createConversation(firstProject.id);
  const otherProjectConversation = await service.createConversation(secondProject.id);
  const firstConversationDirectory = path.join(
    storageRoot,
    "conversations",
    firstConversation.id,
  );

  await assert.rejects(
    service.removeConversation(secondProject.id, firstConversation.id),
    (error) => {
      assert.equal(error.code, "PROJECT_WORK_CONVERSATION_NOT_FOUND");
      assert.equal(error.status, 404);
      return true;
    },
  );
  await assert.rejects(
    service.removeConversation(firstProject.id, "conversation-missing"),
    (error) => {
      assert.equal(error.code, "PROJECT_WORK_CONVERSATION_NOT_FOUND");
      assert.equal(error.status, 404);
      return true;
    },
  );
  await access(firstConversationDirectory);

  const firstRemoval = await service.removeConversation(
    firstProject.id,
    firstConversation.id,
  );
  assert.deepEqual(firstRemoval, {
    id: firstConversation.id,
    projectId: firstProject.id,
    removed: true,
    conversationCount: 1,
  });
  assert.equal(JSON.stringify(firstRemoval).includes(storageRoot), false);
  await assert.rejects(access(firstConversationDirectory), { code: "ENOENT" });
  assert.equal(
    (await service.getConversation(remainingConversation.id)).conversation.id,
    remainingConversation.id,
  );
  assert.equal(
    (await service.getConversation(otherProjectConversation.id)).conversation.id,
    otherProjectConversation.id,
  );
  let projects = await service.listProjects();
  assert.equal(
    projects.find((project) => project.id === firstProject.id).conversationCount,
    1,
  );
  assert.equal(
    projects.find((project) => project.id === secondProject.id).conversationCount,
    1,
  );

  const lastRemoval = await service.removeConversation(
    firstProject.id,
    remainingConversation.id,
  );
  assert.equal(lastRemoval.conversationCount, 0);
  assert.deepEqual(await service.listConversations(firstProject.id), []);
  projects = await service.listProjects();
  assert.equal(
    projects.find((project) => project.id === firstProject.id).conversationCount,
    0,
  );
  assert.equal(
    await readFile(path.join(firstProjectRoot, "app.js"), "utf8"),
    "first project\n",
  );
  assert.equal(
    (await service.getConversation(otherProjectConversation.id)).conversation.id,
    otherProjectConversation.id,
  );
});

test("project deletion cannot overtake an in-flight conversation creation", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(
    os.tmpdir(),
    "pi-project-create-delete-race-",
  ));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  await mkdir(projectRoot);
  await writeFile(path.join(projectRoot, "app.js"), "project\n", "utf8");
  const sessionFactory = createFakeSessionFactory();
  let releaseCatalog;
  let markCatalogStarted;
  const catalogStarted = new Promise((resolve) => {
    markCatalogStarted = resolve;
  });
  sessionFactory.listModels = async () => {
    markCatalogStarted();
    await new Promise((resolve) => {
      releaseCatalog = resolve;
    });
    return modelCatalog();
  };
  const service = createProjectWorkService({
    storageRoot: path.join(temporaryRoot, "private-state"),
    sessionFactory,
    picker: async () => ({ rootPath: projectRoot }),
    idFactory: incrementalId("create-delete"),
  });
  t.after(() => service.dispose());

  const selection = await service.pickProjectRoot({ mode: "existing" });
  const project = await service.registerProject({
    selectionId: selection.selectionId,
  });
  const creation = service.createConversation(project.id);
  await catalogStarted;

  await assert.rejects(
    service.removeProject(project.id),
    (error) => (
      error.code === "PROJECT_WORK_PROJECT_BUSY"
      && error.status === 409
    ),
  );
  releaseCatalog();
  const conversation = await creation;
  assert.equal(conversation.projectId, project.id);
  assert.equal((await service.listProjects())[0].id, project.id);
  assert.equal(
    (await service.listConversations(project.id))[0].id,
    conversation.id,
  );
});

test("renaming a conversation updates only safe scoped metadata", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-conversation-rename-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const firstProjectRoot = path.join(temporaryRoot, "first-project");
  const secondProjectRoot = path.join(temporaryRoot, "second-project");
  await Promise.all([
    mkdir(firstProjectRoot),
    mkdir(secondProjectRoot),
  ]);
  await writeFile(path.join(firstProjectRoot, "app.js"), "unchanged\n", "utf8");
  const pickedRoots = [firstProjectRoot, secondProjectRoot];
  const sessionFactory = createFakeSessionFactory();
  const service = createProjectWorkService({
    storageRoot: path.join(temporaryRoot, "private-state"),
    sessionFactory,
    picker: async () => ({ rootPath: pickedRoots.shift() }),
    idFactory: incrementalId("rename"),
  });
  t.after(() => service.dispose());

  const firstSelection = await service.pickProjectRoot({ mode: "existing" });
  const firstProject = await service.registerProject({
    selectionId: firstSelection.selectionId,
  });
  const secondSelection = await service.pickProjectRoot({ mode: "existing" });
  const secondProject = await service.registerProject({
    selectionId: secondSelection.selectionId,
  });
  const conversation = await service.createConversation(firstProject.id);

  await assert.rejects(
    service.renameConversation(secondProject.id, conversation.id, {
      title: "不应成功",
    }),
    (error) => {
      assert.equal(error.code, "PROJECT_WORK_CONVERSATION_NOT_FOUND");
      assert.equal(error.status, 404);
      return true;
    },
  );
  for (const title of ["   ", "x".repeat(81)]) {
    await assert.rejects(
      service.renameConversation(firstProject.id, conversation.id, { title }),
      (error) => {
        assert.equal(error.code, "PROJECT_WORK_CONVERSATION_TITLE_INVALID");
        assert.equal(error.status, 400);
        return true;
      },
    );
  }

  const renamed = await service.renameConversation(
    firstProject.id,
    conversation.id,
    { title: "  修复   登录流程  " },
  );
  assert.equal(renamed.title, "修复 登录流程");
  assert.equal(renamed.projectId, firstProject.id);
  assert.equal(Object.hasOwn(renamed, "messages"), false);
  assert.equal(Object.hasOwn(renamed, "rootPath"), false);
  assert.equal(
    (await service.getConversation(conversation.id)).conversation.title,
    "修复 登录流程",
  );
  assert.equal(sessionFactory.sessions.length, 0);
  assert.equal(
    await readFile(path.join(firstProjectRoot, "app.js"), "utf8"),
    "unchanged\n",
  );

  const movedProjectRoot = path.join(temporaryRoot, "moved-first-project");
  await rename(firstProjectRoot, movedProjectRoot);
  const renamedAfterMove = await service.renameConversation(
    firstProject.id,
    conversation.id,
    { title: "项目已移动后的会话" },
  );
  assert.equal(renamedAfterMove.title, "项目已移动后的会话");
  const removedAfterMove = await service.removeConversation(
    firstProject.id,
    conversation.id,
  );
  assert.equal(removedAfterMove.removed, true);
  assert.equal(removedAfterMove.conversationCount, 0);
});

test("the first explicit message derives a short title without overriding a user rename", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-conversation-title-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  await mkdir(projectRoot);
  await writeFile(path.join(projectRoot, "app.js"), "project\n", "utf8");
  const sessionFactory = createFakeSessionFactory();
  const service = createProjectWorkService({
    storageRoot: path.join(temporaryRoot, "private-state"),
    sessionFactory,
    picker: async () => ({ rootPath: projectRoot }),
    idFactory: incrementalId("title"),
  });
  t.after(() => service.dispose());

  const selection = await service.pickProjectRoot({ mode: "existing" });
  const project = await service.registerProject({ selectionId: selection.selectionId });
  const automatic = await service.createConversation(project.id);
  const task = "  请   检查这个项目中的登录流程，并修复所有会导致用户无法保存设置的问题，同时补充相关测试和验证说明  ";
  await service.sendMessage(automatic.id, { text: task });
  const automaticSettled = await eventually(
    () => service.getConversation(automatic.id),
    (snapshot) => snapshot.conversation.status === "awaiting_confirmation",
    "automatic-title conversation did not settle",
  );
  const expectedTitle = task
    .normalize("NFKC")
    .trim()
    .replaceAll(/\s+/g, " ")
    .slice(0, 48);
  assert.equal(automaticSettled.conversation.title, expectedTitle);
  assert.ok(automaticSettled.conversation.title.length <= 48);

  const userNamed = await service.createConversation(project.id);
  await service.renameConversation(project.id, userNamed.id, {
    title: "我的自定义会话",
  });
  await service.sendMessage(userNamed.id, { text: "这条消息不能覆盖名称" });
  const userNamedSettled = await eventually(
    () => service.getConversation(userNamed.id),
    (snapshot) => snapshot.conversation.status === "awaiting_confirmation",
    "user-named conversation did not settle",
  );
  assert.equal(userNamedSettled.conversation.title, "我的自定义会话");
  assert.equal(sessionFactory.sessions.length, 2);
  assert.deepEqual(
    sessionFactory.sessions.map((session) => session.prompts.length),
    [1, 1],
  );
});

test("deleting a running conversation is rejected without aborting it", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-conversation-delete-busy-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  const storageRoot = path.join(temporaryRoot, "private-state");
  await mkdir(projectRoot);
  await writeFile(path.join(projectRoot, "app.js"), "project\n", "utf8");
  const sessionFactory = createBlockingSessionFactory();
  const service = createProjectWorkService({
    storageRoot,
    sessionFactory,
    picker: async () => ({ rootPath: projectRoot }),
    idFactory: incrementalId("delete-busy"),
  });
  t.after(() => service.dispose());

  const selection = await service.pickProjectRoot({ mode: "existing" });
  const project = await service.registerProject({ selectionId: selection.selectionId });
  const conversation = await service.createConversation(project.id);
  await service.sendMessage(conversation.id, { text: "继续运行" });
  await eventually(
    () => service.getConversation(conversation.id),
    (snapshot) => snapshot.conversation.status === "running",
    "conversation did not enter running state",
  );

  await assert.rejects(
    service.removeConversation(project.id, conversation.id),
    (error) => {
      assert.equal(error.code, "PROJECT_WORK_CONVERSATION_DELETE_BUSY");
      assert.equal(error.status, 409);
      return true;
    },
  );
  assert.equal(sessionFactory.sessions[0].aborts, 0);
  await access(path.join(storageRoot, "conversations", conversation.id));

  sessionFactory.sessions[0].release();
  await eventually(
    () => service.getConversation(conversation.id),
    (snapshot) => snapshot.conversation.status === "idle",
    "conversation did not settle after release",
  );
});

test("message admission is atomic and client request ids are idempotent", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-message-admission-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  const storageRoot = path.join(temporaryRoot, "private-state");
  await mkdir(projectRoot);
  await writeFile(path.join(projectRoot, "app.js"), "project\n", "utf8");
  const sessionFactory = createBlockingSessionFactory();
  const service = createProjectWorkService({
    storageRoot,
    sessionFactory,
    picker: async () => ({ rootPath: projectRoot }),
    idFactory: incrementalId("message-admission"),
  });
  t.after(() => service.dispose());

  const selection = await service.pickProjectRoot({ mode: "existing" });
  const project = await service.registerProject({ selectionId: selection.selectionId });
  const competingConversation = await service.createConversation(project.id);
  const competing = await Promise.allSettled([
    service.sendMessage(competingConversation.id, {
      text: "先做代码审查",
      workflowId: "code_review",
      clientRequestId: "message-request:one",
    }),
    service.sendMessage(competingConversation.id, {
      text: "同时开始另一个任务",
      clientRequestId: "message-request:two",
    }),
  ]);
  assert.equal(
    competing.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const busy = competing.find((result) => result.status === "rejected");
  assert.equal(busy?.reason?.code, "PROJECT_WORK_CONVERSATION_BUSY");
  assert.equal(busy?.reason?.status, 409);
  await eventually(
    async () => sessionFactory.sessions[0],
    (session) => session?.prompts.length === 1,
    "exactly one competing prompt was not started",
  );
  const competingSnapshot = await service.getConversation(competingConversation.id);
  assert.equal(competingSnapshot.conversation.status, "running");
  assert.equal(competingSnapshot.conversation.messages.length, 1);
  assert.equal(sessionFactory.sessions[0].activeToolCalls.length, 1);
  sessionFactory.sessions[0].release();
  await eventually(
    () => service.getConversation(competingConversation.id),
    (snapshot) => snapshot.conversation.status === "idle",
    "competing message did not settle",
  );

  const duplicateConversation = await service.createConversation(project.id);
  const duplicateRequest = {
    text: "只执行一次",
    workflowId: "bug_diagnosis",
    clientRequestId: "message-request:duplicate",
  };
  const duplicates = await Promise.all([
    service.sendMessage(duplicateConversation.id, duplicateRequest),
    service.sendMessage(duplicateConversation.id, duplicateRequest),
  ]);
  assert.equal(duplicates.length, 2);
  await eventually(
    async () => sessionFactory.sessions[1],
    (session) => session?.prompts.length === 1,
    "duplicate request started more than one prompt",
  );
  const duplicateSnapshot = await service.getConversation(duplicateConversation.id);
  assert.equal(duplicateSnapshot.conversation.status, "running");
  assert.equal(duplicateSnapshot.conversation.messages.length, 1);
  assert.equal(sessionFactory.sessions[1].activeToolCalls.length, 1);

  await assert.rejects(
    service.sendMessage(duplicateConversation.id, {
      ...duplicateRequest,
      text: "复用标识但改变消息",
    }),
    (error) => (
      error.code === "PROJECT_WORK_CLIENT_REQUEST_CONFLICT"
      && error.status === 409
    ),
  );
  assert.equal(sessionFactory.sessions[1].prompts.length, 1);
  sessionFactory.sessions[1].release();
  await eventually(
    () => service.getConversation(duplicateConversation.id),
    (snapshot) => snapshot.conversation.status === "idle",
    "duplicate request did not settle",
  );

  await service.sendMessage(duplicateConversation.id, duplicateRequest);
  const replayedSnapshot = await service.getConversation(duplicateConversation.id);
  assert.equal(replayedSnapshot.conversation.messages.length, 1);
  assert.equal(sessionFactory.sessions[1].prompts.length, 1);
});

test("PDF upload stays outside the project overlay and becomes a dynamic Pi read tool", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-conversation-pdf-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  const storageRoot = path.join(temporaryRoot, "private-state");
  await mkdir(projectRoot);
  await writeFile(path.join(projectRoot, "app.js"), "export const version = 1;\n");
  const sessionFactory = createFakeSessionFactory();
  let submittedDataId = null;
  const documentParser = {
    async submitBatch(files, { onBatchAllocated }) {
      submittedDataId = files[0].dataId;
      await onBatchAllocated({
        batchId: "batch-project-work-pdf",
        traceId: "trace-project-work-pdf",
      });
      return {
        batchId: "batch-project-work-pdf",
        state: "uploaded",
        uploads: [{
          fileName: files[0].fileName,
          dataId: files[0].dataId,
          state: "uploaded",
          error: null,
        }],
      };
    },
    async getBatch(batchId) {
      return {
        batchId,
        state: "done",
        items: [{
          dataId: submittedDataId,
          fileName: "开发手册.pdf",
          state: "done",
          fullZipUrl: "https://downloads.example.test/manual.zip",
        }],
      };
    },
    async downloadResult() {
      return {
        markdown: [
          "# 开发手册",
          "",
          "## 缓存",
          "",
          "缓存键必须包含项目版本与输入哈希。",
        ].join("\n"),
        markdownFileName: "full.md",
        images: [],
      };
    },
  };
  const service = createProjectWorkService({
    storageRoot,
    sessionFactory,
    documentParser,
    documentPollIntervalMs: 1,
    picker: async () => ({ rootPath: projectRoot }),
    idFactory: incrementalId("conversation-pdf"),
  });
  t.after(() => service.dispose());

  const selection = await service.pickProjectRoot({ mode: "existing" });
  const project = await service.registerProject({ selectionId: selection.selectionId });
  const conversation = await service.createConversation(project.id);
  const pdf = Buffer.from("%PDF-1.7\nmanual\n", "utf8");
  const created = await service.createConversationDocument(conversation.id, {
    fileName: "开发手册.pdf",
    byteLength: pdf.length,
  });
  await service.uploadConversationDocument(
    conversation.id,
    created.document.id,
    Readable.from([pdf]),
    {
      contentType: "application/pdf",
      declaredLength: String(pdf.length),
    },
  );

  assert.equal(sessionFactory.sessions.length, 0);
  const ready = await eventually(
    () => service.getConversation(conversation.id),
    (snapshot) => snapshot.conversation.documents[0]?.status === "ready",
    "conversation PDF did not become ready",
  );
  assert.equal(ready.conversation.messages.length, 0);
  assert.equal(ready.conversation.documents[0].parser, "MinerU Cloud v4");
  assert.equal(
    "batchId" in ready.conversation.documents[0],
    false,
  );
  await assert.rejects(
    access(path.join(projectRoot, "开发手册.pdf")),
    (error) => error.code === "ENOENT",
  );

  await service.sendMessage(conversation.id, {
    text: "根据刚上传的开发手册检查缓存实现",
  });
  const documentAccess = sessionFactory.sessions[0].options.documentAccess;
  const listed = await documentAccess.list();
  assert.equal(listed[0].file_name, "开发手册.pdf");
  const matches = await documentAccess.search({ query: "输入哈希" });
  assert.equal(matches.length, 1);
  const read = await documentAccess.read({
    documentId: listed[0].document_id,
    revision: listed[0].document_revision,
    blockIds: [matches[0].block_id],
  });
  assert.match(read.blocks[0].content, /项目版本与输入哈希/);
  await eventually(
    () => service.getConversation(conversation.id),
    (snapshot) => snapshot.conversation.status !== "running",
    "conversation did not settle after document-tool access check",
  );
});

test("a conversation with an active MinerU parse cannot be deleted", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-conversation-pdf-busy-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  const storageRoot = path.join(temporaryRoot, "private-state");
  await mkdir(projectRoot);
  await writeFile(path.join(projectRoot, "app.js"), "project\n", "utf8");
  let submittedDataId = null;
  const documentParser = {
    async submitBatch(files, { onBatchAllocated }) {
      submittedDataId = files[0].dataId;
      await onBatchAllocated({ batchId: "batch-pending" });
      return {
        batchId: "batch-pending",
        state: "uploaded",
        uploads: [{
          fileName: files[0].fileName,
          dataId: files[0].dataId,
          state: "uploaded",
          error: null,
        }],
      };
    },
    async getBatch(batchId) {
      return {
        batchId,
        state: "running",
        items: [{
          dataId: submittedDataId,
          fileName: "解析中.pdf",
          state: "running",
          fullZipUrl: null,
        }],
      };
    },
    async downloadResult() {
      throw new Error("not reached");
    },
  };
  const service = createProjectWorkService({
    storageRoot,
    sessionFactory: createFakeSessionFactory(),
    documentParser,
    documentPollIntervalMs: 20,
    picker: async () => ({ rootPath: projectRoot }),
    idFactory: incrementalId("conversation-pdf-busy"),
  });
  t.after(() => service.dispose());

  const selection = await service.pickProjectRoot({ mode: "existing" });
  const project = await service.registerProject({ selectionId: selection.selectionId });
  const conversation = await service.createConversation(project.id);
  const pdf = Buffer.from("%PDF-1.7\npending\n", "utf8");
  const created = await service.createConversationDocument(conversation.id, {
    fileName: "解析中.pdf",
    byteLength: pdf.length,
  });
  await service.uploadConversationDocument(
    conversation.id,
    created.document.id,
    Readable.from([pdf]),
    {
      contentType: "application/pdf",
      declaredLength: String(pdf.length),
    },
  );
  await eventually(
    () => service.getConversation(conversation.id),
    (snapshot) => snapshot.conversation.documents[0]?.status === "parsing",
    "conversation PDF did not enter parsing",
  );

  await assert.rejects(
    service.removeConversation(project.id, conversation.id),
    (error) => (
      error.code === "PROJECT_WORK_CONVERSATION_DELETE_BUSY"
      && error.status === 409
    ),
  );
});

test("one-turn screenshot review passes a bounded image to Pi without persisting base64", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-project-image-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  const storageRoot = path.join(temporaryRoot, "private-state");
  await mkdir(projectRoot);
  await writeFile(path.join(projectRoot, "app.js"), "export const value = 1;\n");

  const sessions = [];
  const catalog = {
    defaultProviderId: "test",
    defaultModelId: "vision",
    capabilities: {
      web_search: { available: true, reason: "Tavily 已配置" },
      docs_search: { available: true, reason: "Context7 已配置" },
    },
    providers: [{
      id: "test",
      models: [{
        id: "vision",
        supportsImages: true,
        supportsThinking: false,
        thinkingLevels: ["off"],
        defaultThinkingLevel: "off",
      }, {
        id: "text-only",
        supportsImages: false,
        supportsThinking: false,
        thinkingLevels: ["off"],
        defaultThinkingLevel: "off",
      }],
    }],
  };
  const sessionFactory = async (options) => {
    let subscriber = null;
    const record = {
      options,
      prompts: [],
      activeToolCalls: [],
    };
    const host = {
      subscribe(listener) {
        subscriber = listener;
        return () => {
          subscriber = null;
        };
      },
      setActiveToolsByName(names) {
        record.activeToolCalls.push([...names]);
        return [...names];
      },
      async prompt(prompt, promptOptions) {
        record.prompts.push({ prompt, promptOptions });
        subscriber?.({ type: "agent_start" });
        subscriber?.({ type: "turn_start" });
        subscriber?.({
          type: "message_start",
          message: { role: "assistant" },
        });
        subscriber?.({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "截图验收完成" }],
            stopReason: "stop",
          },
        });
        subscriber?.({ type: "turn_end" });
        subscriber?.({ type: "agent_end", willRetry: false });
        subscriber?.({ type: "agent_settled" });
      },
      async steer() {},
      async abort() {},
      async compact() {},
      async setModel() {},
      dispose() {},
    };
    record.host = host;
    sessions.push(record);
    return host;
  };
  sessionFactory.listModels = async () => structuredClone(catalog);
  sessionFactory.dispose = async () => {};

  const service = createProjectWorkService({
    storageRoot,
    sessionFactory,
    picker: async () => ({ rootPath: projectRoot }),
    idFactory: incrementalId("image"),
  });
  t.after(() => service.dispose());
  const selection = await service.pickProjectRoot({ mode: "existing" });
  const project = await service.registerProject({
    selectionId: selection.selectionId,
  });
  const conversation = await service.createConversation(project.id, {
    providerId: "test",
    modelId: "vision",
  });
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );

  await service.sendMessage(conversation.id, {
    text: "检查这张设置页截图",
    workflowId: "screenshot_review",
    images: [{
      fileName: "设置页.png",
      mimeType: "image/png",
      byteLength: bytes.length,
      data: bytes.toString("base64"),
    }],
  });
  const settled = await eventually(
    () => service.getConversation(conversation.id),
    (snapshot) => (
      snapshot.conversation.status !== "running"
      && snapshot.conversation.messages.some(
        (message) => message.role === "assistant",
      )
    ),
    "image turn did not settle",
  );

  assert.equal(sessions.length, 1);
  assert.equal(
    sessions[0].prompts[0].prompt,
    "检查这张设置页截图",
  );
  assert.match(
    sessions[0].prompts[0].promptOptions.turnGuidance,
    /Review the attached screenshot/,
  );
  assert.deepEqual(sessions[0].prompts[0].promptOptions.images, [{
    type: "image",
    data: bytes.toString("base64"),
    mimeType: "image/png",
  }]);
  assert.equal(sessions[0].activeToolCalls[0].includes("edit"), false);
  assert.ok(sessions[0].activeToolCalls.at(-1).includes("edit"));
  const userMessage = settled.conversation.messages.find(
    (message) => message.role === "user",
  );
  assert.equal(userMessage.text, "检查这张设置页截图");
  assert.equal(userMessage.workflowId, "screenshot_review");
  assert.deepEqual(userMessage.capabilities, []);
  assert.deepEqual(userMessage.images, [{
    fileName: "设置页.png",
    mimeType: "image/png",
    byteLength: bytes.length,
  }]);
  assert.doesNotMatch(
    JSON.stringify(settled.conversation),
    new RegExp(bytes.toString("base64")),
  );

  const textConversation = await service.createConversation(project.id, {
    providerId: "test",
    modelId: "text-only",
  });
  const sessionsBeforeRejectedImage = sessions.length;
  await assert.rejects(
    service.sendMessage(textConversation.id, {
      text: "检查图片",
      images: [{
        fileName: "设置页.png",
        mimeType: "image/png",
        byteLength: bytes.length,
        data: bytes.toString("base64"),
      }],
    }),
    { code: "PROJECT_WORK_MODEL_VISION_UNSUPPORTED" },
  );
  assert.equal(sessions.length, sessionsBeforeRejectedImage);
  const rejectedSnapshot = await service.getConversation(textConversation.id);
  assert.equal(rejectedSnapshot.conversation.messages.length, 0);
});
