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
import {
  aggregateProjectWorkUsage,
  createProjectWorkService,
} from "./projectWorkService.js";

function incrementalId(prefix = "test") {
  let sequence = 0;
  return () => `${prefix}-${++sequence}`;
}

async function enableRecoverableWorkspaceForTest(storageRoot, conversationId) {
  const statePath = path.join(
    storageRoot,
    "conversations",
    conversationId,
    "conversation.json",
  );
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.workspace = {
    ...state.workspace,
    recoverableIsolation: true,
    automaticApplyAllowed: true,
    revision: (state.workspace?.revision ?? 1) + 1,
  };
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
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

test("project-work usage aggregates durable model calls without double counting projections", () => {
  const usage = aggregateProjectWorkUsage({
    period: "30d",
    now: new Date("2026-07-28T12:00:00.000Z"),
    catalog: {
      providers: [{
        id: "openai-codex",
        name: "GPT · ChatGPT 订阅",
        models: [{
          id: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          billingKind: "chatgpt_subscription",
          pricing: {
            currency: "USD",
            unit: "per_million_tokens",
            input: 5,
            output: 30,
            cacheRead: 0.5,
            cacheWrite: 6.25,
            tiers: [],
          },
        }],
      }, {
        id: "deepseek",
        name: "DeepSeek",
        models: [{
          id: "deepseek-v4-flash",
          name: "DeepSeek V4 Flash",
          billingKind: "api",
          pricing: null,
        }],
      }],
    },
    conversations: [{
      id: "conversation-bound",
      projectId: "project-1",
      messages: [{
        id: "assistant-tool",
        role: "assistant",
        turnId: "turn-1",
        text: "工具调用",
        turnEvidence: {
          providerId: "openai-codex",
          modelId: "gpt-5.6-sol",
          capturedAt: "2026-07-28T09:00:00.000Z",
          usage: {
            inputTokens: 10,
            outputTokens: 2,
            cacheReadTokens: 3,
            cacheWriteTokens: 0,
            totalTokens: 15,
            costUsd: 0.001,
          },
        },
      }, {
        id: "assistant-tool",
        role: "assistant",
        turnId: "turn-1",
        text: "同一消息的重复投影",
        turnEvidence: {
          providerId: "openai-codex",
          modelId: "gpt-5.6-sol",
          capturedAt: "2026-07-28T09:00:00.000Z",
          usage: {
            inputTokens: 999,
            outputTokens: 999,
            totalTokens: 1998,
            costUsd: 10,
          },
        },
      }, {
        id: "assistant-final",
        role: "assistant",
        turnId: "turn-1",
        text: "最终回答",
        turnEvidence: {
          providerId: "openai-codex",
          modelId: "gpt-5.6-sol",
          capturedAt: "2026-07-28T09:01:00.000Z",
          usage: {
            inputTokens: 20,
            outputTokens: 4,
            totalTokens: 24,
            costUsd: 0.002,
          },
        },
      }, {
        id: "legacy-answer",
        role: "assistant",
        turnId: "turn-legacy",
        text: "旧回复",
        createdAt: "2026-07-28T09:02:00.000Z",
      }, {
        id: "old-answer",
        role: "assistant",
        turnId: "turn-old",
        text: "范围外回复",
        turnEvidence: {
          providerId: "openai-codex",
          modelId: "gpt-5.6-sol",
          capturedAt: "2026-06-01T09:00:00.000Z",
          usage: {
            inputTokens: 100,
            outputTokens: 20,
            totalTokens: 120,
            costUsd: 1,
          },
        },
      }],
    }, {
      id: "conversation-standalone",
      projectId: null,
      messages: [{
        id: "assistant-tool",
        role: "assistant",
        turnId: "turn-2",
        text: "独立会话中的同名消息",
        turnEvidence: {
          providerId: "deepseek",
          modelId: "deepseek-v4-flash",
          capturedAt: "2026-07-28T10:00:00.000Z",
          usage: {
            inputTokens: 30,
            outputTokens: 5,
            cacheReadTokens: 2,
            cacheWriteTokens: 1,
            totalTokens: 38,
            costUsd: 0.003,
          },
        },
      }, {
        id: "assistant-final",
        role: "assistant",
        turnId: "turn-2",
        text: "费用未知的最终回复",
        turnEvidence: {
          providerId: "deepseek",
          modelId: "deepseek-v4-flash",
          capturedAt: "2026-07-28T10:01:00.000Z",
          usage: {
            inputTokens: 40,
            outputTokens: 6,
            totalTokens: 46,
          },
        },
      }],
    }],
  });

  assert.equal(usage.scope, "retained_conversations");
  assert.equal(usage.costSemantics, "api_equivalent_estimate");
  assert.deepEqual(usage.totals, {
    calls: 4,
    tasks: 2,
    conversations: 2,
    inputTokens: 100,
    outputTokens: 17,
    cacheReadTokens: 5,
    cacheWriteTokens: 1,
    totalTokens: 123,
    apiEquivalentCostUsd: 0.006,
    pricedCallCount: 3,
    unpricedCallCount: 1,
  });
  assert.equal(usage.coverage.legacyMessagesWithoutUsage, 1);
  assert.deepEqual(usage.coverage.excludedKinds, [
    "compaction",
    "branch_summary",
    "tool_summary",
  ]);
  assert.equal(usage.models.length, 2);
  assert.deepEqual(
    usage.models.map((model) => ({
      key: `${model.providerId}/${model.modelId}`,
      calls: model.calls,
      tasks: model.tasks,
      cost: model.apiEquivalentCostUsd,
      unpriced: model.unpricedCallCount,
    })),
    [{
      key: "deepseek/deepseek-v4-flash",
      calls: 2,
      tasks: 1,
      cost: 0.003,
      unpriced: 1,
    }, {
      key: "openai-codex/gpt-5.6-sol",
      calls: 2,
      tasks: 1,
      cost: 0.003,
      unpriced: 0,
    }],
  );
  assert.equal(usage.models[1].billingKind, "chatgpt_subscription");
  assert.equal(usage.models[1].currentPricing.input, 5);
  assert.equal(usage.quota.available, false);
  assert.doesNotMatch(JSON.stringify(usage), /最终回答|project-1/);
});

test("project-work usage rejects unknown time ranges", () => {
  assert.throws(
    () => aggregateProjectWorkUsage({ period: "quarter" }),
    (error) => error?.code === "PROJECT_WORK_USAGE_PERIOD_INVALID",
  );
});

function createFakePreviewSupervisor({ startError = null } = {}) {
  const active = new Set();
  const starts = [];
  const stops = [];
  return {
    starts,
    stops,
    async start(input) {
      starts.push(structuredClone(input));
      if (startError) throw startError;
      active.add(input.key);
      return {
        status: "ready",
        url: `http://127.0.0.1:48080${input.request.route}`,
        title: input.request.title,
        runtime: input.request.runtime,
        cwd: input.request.cwd,
        app: input.request.app,
        route: input.request.route,
        startedAt: "2026-07-27T02:00:00.000Z",
        openedAt: "2026-07-27T02:00:01.000Z",
      };
    },
    has(key) {
      return active.has(key);
    },
    async stop(key) {
      stops.push(key);
      return active.delete(key);
    },
    async dispose() {
      active.clear();
    },
  };
}

function createFakeSessionFactory({
  changedContent = "export const version = 2;\n",
  additionalChanges = [],
  verificationRequest = {
    file: "node",
    args: ["--test"],
    checks: ["项目测试应通过"],
  },
  previewRequest = null,
} = {}) {
  const sessions = [];
  const factory = async (options) => {
    let subscriber = null;
    const record = {
      options,
      prompts: [],
      aborts: 0,
      activeToolCalls: [],
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
        if (verificationRequest) {
          await options.onVerificationRequest(verificationRequest);
        }
        if (previewRequest) {
          await options.onPreviewRequest(previewRequest);
        }
        subscriber?.({ type: "agent_settled" });
      },
      setActiveToolsByName(names) {
        record.activeToolCalls.push([...names]);
        return [...names];
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

function createVerificationRepairSessionFactory({
  command = {
    file: "node",
    args: ["--test"],
    checks: ["项目测试应通过"],
  },
  repairMode = "pass",
} = {}) {
  const sessions = [];
  const factory = async (options) => {
    let subscriber = null;
    const record = {
      activeToolCalls: [],
      prompts: [],
      repairCalls: [],
    };
    const ensureBaseFile = async (filePath) => {
      const basePath = path.join(options.baseRoot, filePath);
      try {
        await access(basePath);
      } catch {
        await mkdir(path.dirname(basePath), { recursive: true });
        await writeFile(
          basePath,
          await readFile(path.join(options.projectRoot, filePath)),
        );
      }
    };
    const emitAssistantTurn = (text) => {
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
          content: [{ type: "text", text }],
          stopReason: "stop",
        },
      });
      subscriber?.({ type: "turn_end" });
      subscriber?.({ type: "agent_end", willRetry: false });
      subscriber?.({ type: "agent_settled" });
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
        await ensureBaseFile("app.js");
        await writeFile(
          path.join(options.workspaceRoot, "app.js"),
          "export const verificationState = \"broken\";\n",
          "utf8",
        );
        await options.onVerificationRequest(command);
        emitAssistantTurn("初步修改已完成，等待验证。");
      },
      async repairVerification(payload) {
        record.repairCalls.push(structuredClone(payload));
        if (repairMode === "pass") {
          await writeFile(
            path.join(options.workspaceRoot, "app.js"),
            "export const verificationState = \"fixed\";\n",
            "utf8",
          );
        } else if (repairMode === "change_binding") {
          await ensureBaseFile("package.json");
          const packageJson = JSON.parse(
            await readFile(path.join(options.projectRoot, "package.json"), "utf8"),
          );
          packageJson.scripts.verify = "node --test changed";
          await writeFile(
            path.join(options.workspaceRoot, "package.json"),
            `${JSON.stringify(packageJson, null, 2)}\n`,
            "utf8",
          );
        }
        emitAssistantTurn(`第 ${payload.repairAttempt} 次验证修复已完成。`);
      },
      setActiveToolsByName(names) {
        record.activeToolCalls.push([...names]);
        return [...names];
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

function createAskUserSessionFactory() {
  const sessions = [];
  const factory = async (options) => {
    let subscriber = null;
    let turn = 0;
    const record = {
      outcomes: [],
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
        turn += 1;
        const outcome = await options.onAskUserRequest({
          questions: [{
            id: `scope-${turn}`,
            prompt: "选择本轮实现范围",
            kind: "single_choice",
            options: [{
              id: "backend",
              label: "后端",
            }, {
              id: "frontend",
              label: "前端",
            }],
          }],
        });
        record.outcomes.push(outcome);
        subscriber?.({ type: "agent_settled" });
      },
      setActiveToolsByName(names) {
        return [...names];
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

function createFollowUpSessionFactory() {
  const sessions = [];
  const factory = async () => {
    let subscriber = null;
    let releasePrompt;
    const record = {
      prompts: [],
      followUps: [],
      steering: [],
      clearCalls: 0,
      emit(event) {
        subscriber?.(event);
      },
      deliver(text) {
        const index = record.followUps.indexOf(text);
        if (index >= 0) record.followUps.splice(index, 1);
        record.emit({
          type: "queue_update",
          steering: [...record.steering],
          followUp: [...record.followUps],
        });
        record.emit({
          type: "message_start",
          message: {
            role: "user",
            content: [{ type: "text", text }],
          },
        });
      },
      release() {
        releasePrompt?.();
      },
    };
    const host = {
      subscribe(listener) {
        subscriber = listener;
        return () => {
          subscriber = null;
        };
      },
      prompt(prompt) {
        record.prompts.push(prompt);
        record.emit({ type: "agent_start" });
        return new Promise((resolve) => {
          releasePrompt = resolve;
        });
      },
      async steer(text) {
        record.steering.push(text);
      },
      async followUp(text) {
        record.followUps.push(text);
        record.emit({
          type: "queue_update",
          steering: [...record.steering],
          followUp: [...record.followUps],
        });
      },
      async replaceFollowUps(messages) {
        record.followUps = [...messages];
        record.emit({
          type: "queue_update",
          steering: [...record.steering],
          followUp: [...record.followUps],
        });
      },
      clearQueue() {
        record.clearCalls += 1;
        const cleared = {
          steering: [...record.steering],
          followUp: [...record.followUps],
        };
        record.steering = [];
        record.followUps = [];
        record.emit({
          type: "queue_update",
          steering: [],
          followUp: [],
        });
        return cleared;
      },
      async abort() {
        record.release();
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
        for (let blockIndex = 0; blockIndex < 2; blockIndex += 1) {
          subscriber?.({
            type: "message_update",
            assistantMessageEvent: {
              type: "thinking_start",
              contentIndex: blockIndex,
            },
          });
          for (let index = 0; index < 15; index += 1) {
            subscriber?.({
              type: "message_update",
              assistantMessageEvent: {
                type: "thinking_delta",
                contentIndex: blockIndex,
                delta: `private-${blockIndex}-${index}`,
              },
            });
          }
          subscriber?.({
            type: "message_update",
            assistantMessageEvent: {
              type: "thinking_end",
              contentIndex: blockIndex,
              content: `private reasoning block ${blockIndex} must not be persisted`,
            },
          });
        }
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

function createStreamingSessionFactory({
  firstDelta = "首段",
  repeatedDelta = "x",
  repeatedCount = 520,
  finalDelta = "尾声",
} = {}) {
  const sessions = [];
  const factory = async () => {
    let subscriber = null;
    let releaseAfterFirst;
    const record = {
      prompts: [],
      release() {
        releaseAfterFirst?.();
        releaseAfterFirst = null;
      },
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
        subscriber?.({ type: "agent_start" });
        subscriber?.({ type: "turn_start" });
        subscriber?.({
          type: "message_start",
          message: { role: "assistant" },
        });
        subscriber?.({
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 0,
            delta: firstDelta,
          },
        });
        await new Promise((resolve) => {
          releaseAfterFirst = resolve;
        });
        for (let index = 0; index < repeatedCount; index += 1) {
          subscriber?.({
            type: "message_update",
            assistantMessageEvent: {
              type: "text_delta",
              contentIndex: 0,
              delta: repeatedDelta,
            },
          });
        }
        subscriber?.({
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 0,
            delta: finalDelta,
          },
        });
        const text = `${firstDelta}${repeatedDelta.repeat(repeatedCount)}${finalDelta}`;
        subscriber?.({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text }],
            stopReason: "stop",
          },
        });
        subscriber?.({ type: "turn_end" });
        subscriber?.({ type: "agent_end", willRetry: false });
        subscriber?.({ type: "agent_settled" });
      },
      async steer() {},
      async abort() {
        record.release();
      },
      async compact() {},
      async setModel() {},
      dispose() {
        record.release();
      },
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

function createTurnControlSessionFactory({ retryError = null } = {}) {
  const sessions = [];
  const factory = async () => {
    let subscriber = null;
    let answerSequence = 0;
    const record = {
      prompts: [],
      retries: 0,
      contextUsage: {
        tokens: 1_000,
        contextWindow: 10_000,
        percent: 10,
      },
    };
    async function emitAnswer(prefix) {
      answerSequence += 1;
      const message = {
        role: "assistant",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        content: [{
          type: "text",
          text: `${prefix}-${answerSequence}`,
        }],
        usage: {
          input: 100 * answerSequence,
          output: 20 * answerSequence,
          cacheRead: 5,
          cacheWrite: 0,
          totalTokens: (120 * answerSequence) + 5,
          cost: {
            total: 0.001 * answerSequence,
          },
        },
        stopReason: "stop",
      };
      record.contextUsage = {
        tokens: 1_000 + (answerSequence * 100),
        contextWindow: 10_000,
        percent: 10 + answerSequence,
      };
      subscriber?.({ type: "agent_start" });
      subscriber?.({ type: "turn_start" });
      subscriber?.({ type: "message_start", message });
      subscriber?.({ type: "message_end", message });
      subscriber?.({ type: "turn_end", message, toolResults: [] });
      subscriber?.({ type: "agent_end", messages: [message], willRetry: false });
      subscriber?.({ type: "agent_settled" });
    }
    const host = {
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
        await emitAnswer("回答");
      },
      async retryLastTurn() {
        record.retries += 1;
        if (retryError) throw retryError;
        await emitAnswer("重试回答");
      },
      setActiveToolsByName(names) {
        return [...names];
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
  const harnessSnapshot = settled.events.find(
    (event) => event.type === "harness.snapshot",
  );
  assert.equal(harnessSnapshot.data.providerId, "openai-codex");
  assert.equal(harnessSnapshot.data.modelId, "gpt-5.3-codex");
  assert.equal(harnessSnapshot.data.thinkingLevel, "high");
  assert.equal(harnessSnapshot.data.disclosure.privateReasoning, false);
  assert.ok(Array.isArray(harnessSnapshot.data.activeTools));

  const configurationError = await eventually(
    async () => {
      try {
        await service.configureConversation(conversation.id, {
          providerId: "openai-codex",
          modelId: "gpt-5.3-codex",
          thinkingLevel: "max",
        });
        return null;
      } catch (error) {
        return error;
      }
    },
    (error) => error?.code === "PROJECT_WORK_THINKING_LEVEL_UNSUPPORTED",
    "configuration did not become available after the turn settled",
  );
  assert.equal(
    configurationError.code,
    "PROJECT_WORK_THINKING_LEVEL_UNSUPPORTED",
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
    resumeStatus: null,
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

test("turn history paginates durably and final answers carry unread and usage evidence", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-turn-history-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const sessionFactory = createTurnControlSessionFactory();
  const service = createProjectWorkService({
    storageRoot: path.join(temporaryRoot, "private-state"),
    sessionFactory,
    idFactory: incrementalId("turn-history"),
  });
  t.after(() => service.dispose());

  const conversation = await service.createStandaloneConversation();
  await service.sendMessage(conversation.id, { text: "第一轮" });
  const first = await eventually(
    () => service.getConversation(conversation.id),
    (snapshot) => (
      snapshot.conversation.status === "idle"
      && snapshot.conversation.messages.length === 2
    ),
    "first turn did not settle",
  );
  const firstAssistant = first.conversation.messages.at(-1);
  assert.equal(first.conversation.unreadCount, 1);
  assert.equal(first.conversation.readState.latestAssistantMessageSeq, 2);
  assert.deepEqual(firstAssistant.turnEvidence, {
    schemaVersion: 1,
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
    thinkingLevel: "medium",
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 5,
      cacheWriteTokens: 0,
      totalTokens: 125,
      costUsd: 0.001,
    },
    contextUsage: {
      tokens: 1_100,
      contextWindow: 10_000,
      percent: 11,
      status: "estimated",
      updatedAt: firstAssistant.turnEvidence.contextUsage.updatedAt,
    },
    capturedAt: firstAssistant.turnEvidence.capturedAt,
  });

  const markedFirst = await service.markConversationRead(conversation.id, {
    clientRequestId: "read:first-turn",
  });
  assert.equal(markedFirst.conversation.unreadCount, 0);
  assert.equal(markedFirst.conversation.readState.lastReadMessageSeq, 2);
  const replayedRead = await service.markConversationRead(conversation.id, {
    clientRequestId: "read:first-turn",
  });
  assert.equal(replayedRead.conversation.readState.lastReadMessageSeq, 2);
  await assert.rejects(
    () => service.markConversationRead(conversation.id, {
      clientRequestId: "read:first-turn",
      throughMessageSeq: 0,
    }),
    (error) => error.code === "PROJECT_WORK_CLIENT_REQUEST_CONFLICT",
  );

  await service.sendMessage(conversation.id, { text: "第二轮" });
  const second = await eventually(
    () => service.getConversation(conversation.id),
    (snapshot) => (
      snapshot.conversation.status === "idle"
      && snapshot.conversation.messages.length === 4
    ),
    "second turn did not settle",
  );
  assert.equal(second.conversation.unreadCount, 1);
  assert.deepEqual(
    second.conversation.messages.map((message) => message.messageSeq),
    [1, 2, 3, 4],
  );

  const newestPage = await service.getConversationTurns(conversation.id, {
    limit: 1,
  });
  assert.equal(newestPage.turns.length, 1);
  assert.equal(newestPage.turns[0].turnSeq, 2);
  assert.equal(newestPage.turns[0].assistantAttemptCount, 1);
  assert.equal(newestPage.hasMore, true);
  assert.equal(newestPage.nextBeforeTurnSeq, 2);
  const olderPage = await service.getConversationTurns(conversation.id, {
    beforeTurnSeq: newestPage.nextBeforeTurnSeq,
    limit: 1,
  });
  assert.equal(olderPage.turns[0].turnSeq, 1);
  assert.equal(olderPage.hasMore, false);

  await service.markConversationRead(conversation.id, {
    clientRequestId: "read:second-turn",
  });
  await service.retryLastTurn(conversation.id, {
    clientRequestId: "retry:second-turn",
  });
  await service.retryLastTurn(conversation.id, {
    clientRequestId: "retry:second-turn",
  });
  const retried = await eventually(
    () => service.getConversation(conversation.id),
    (snapshot) => (
      snapshot.conversation.operations.some(
        (operation) => (
          operation.type === "retry_last_turn"
          && operation.status === "completed"
        ),
      )
    ),
    "retry-last-turn operation did not complete",
  );
  assert.equal(retried.conversation.status, "idle");
  assert.equal(sessionFactory.sessions[0].retries, 1);
  assert.equal(retried.conversation.unreadCount, 1);
  assert.equal(
    retried.conversation.messages.filter(
      (message) => message.role === "assistant",
    ).length,
    3,
  );
  const retriedPage = await service.getConversationTurns(conversation.id, {
    limit: 1,
  });
  assert.equal(retriedPage.turns[0].turnSeq, 2);
  assert.equal(retriedPage.turns[0].assistantAttemptCount, 2);
  assert.match(
    retriedPage.turns[0].messages.at(-1).text,
    /^重试回答-/,
  );
  assert.equal(retriedPage.turns[0].turnEvidence.usage.costUsd, 0.003);
});

test("conversation snapshots keep only the latest twenty turns while older pages remain complete", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-turn-window-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const storageRoot = path.join(temporaryRoot, "private-state");
  const service = createProjectWorkService({
    storageRoot,
    sessionFactory: createTurnControlSessionFactory(),
    idFactory: incrementalId("turn-window"),
  });
  t.after(() => service.dispose());
  const conversation = await service.createStandaloneConversation();
  const statePath = path.join(
    storageRoot,
    "conversations",
    conversation.id,
    "conversation.json",
  );
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.messages = Array.from({ length: 30 }, (_, index) => {
    const turnSeq = index + 1;
    const turnId = `turn-${turnSeq}`;
    return [{
      id: `message-${turnSeq}-user`,
      messageSeq: (index * 2) + 1,
      turnId,
      turnSeq,
      role: "user",
      text: `问题 ${turnSeq}`,
      status: "accepted",
      createdAt: `2026-07-27T00:${String(index).padStart(2, "0")}:00.000Z`,
    }, {
      id: `message-${turnSeq}-assistant`,
      messageSeq: (index * 2) + 2,
      turnId,
      turnSeq,
      attempt: 1,
      role: "assistant",
      text: `回答 ${turnSeq}`,
      status: "completed",
      isFinal: true,
      createdAt: `2026-07-27T00:${String(index).padStart(2, "0")}:01.000Z`,
    }];
  }).flat();
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  const snapshot = await service.getConversation(conversation.id);
  assert.equal(snapshot.conversation.messages.length, 40);
  assert.equal(snapshot.conversation.messages[0].turnSeq, 11);
  assert.equal(snapshot.conversation.hasMoreTurns, true);
  assert.equal(snapshot.conversation.nextBeforeTurnSeq, 11);
  assert.equal(snapshot.conversation.latestMessageSeq, 60);

  const older = await service.getConversationTurns(conversation.id, {
    beforeTurnSeq: snapshot.conversation.nextBeforeTurnSeq,
    limit: 20,
  });
  assert.deepEqual(
    older.turns.map((turn) => turn.turnSeq),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  );
  assert.equal(older.hasMore, false);
});

test("retry operation failure preserves the last successful answer and conversation state", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-turn-retry-fail-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const sessionFactory = createTurnControlSessionFactory({
    retryError: new Error("provider retry failed"),
  });
  const service = createProjectWorkService({
    storageRoot: path.join(temporaryRoot, "private-state"),
    sessionFactory,
    idFactory: incrementalId("turn-retry-fail"),
  });
  t.after(() => service.dispose());

  const conversation = await service.createStandaloneConversation();
  await service.sendMessage(conversation.id, { text: "保留这次回答" });
  const answered = await eventually(
    () => service.getConversation(conversation.id),
    (snapshot) => snapshot.conversation.status === "idle",
    "initial answer did not settle",
  );
  const originalAnswer = answered.conversation.messages.at(-1);
  await service.markConversationRead(conversation.id);

  await service.retryLastTurn(conversation.id);
  const failed = await eventually(
    () => service.getConversation(conversation.id),
    (snapshot) => snapshot.conversation.operations.some(
      (operation) => (
        operation.type === "retry_last_turn"
        && operation.status === "failed"
      ),
    ),
    "retry failure was not persisted",
  );
  assert.equal(failed.conversation.status, "idle");
  assert.equal(failed.conversation.lastError, null);
  assert.equal(failed.conversation.unreadCount, 0);
  assert.equal(failed.conversation.messages.length, 2);
  assert.equal(failed.conversation.messages.at(-1).id, originalAnswer.id);
  assert.equal(failed.conversation.messages.at(-1).text, originalAnswer.text);
  const failedOperation = failed.conversation.operations.find(
    (operation) => operation.type === "retry_last_turn",
  );
  assert.equal(failedOperation.status, "failed");
  assert.equal(failedOperation.error.code, "PROJECT_WORK_FAILED");
  assert.equal(failedOperation.error.message, "项目工作操作失败");
});

test("a running retry operation recovers as interrupted without replacing its durable answer", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-turn-retry-recover-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const storageRoot = path.join(temporaryRoot, "private-state");
  const sessionFactory = createTurnControlSessionFactory();
  const service = createProjectWorkService({
    storageRoot,
    sessionFactory,
    idFactory: incrementalId("turn-retry-recover"),
  });
  const conversation = await service.createStandaloneConversation();
  await service.sendMessage(conversation.id, { text: "先生成持久回答" });
  const answered = await eventually(
    () => service.getConversation(conversation.id),
    (snapshot) => snapshot.conversation.status === "idle",
    "answer did not settle before recovery fixture",
  );
  const originalAnswer = answered.conversation.messages.at(-1);
  await service.dispose();

  const statePath = path.join(
    storageRoot,
    "conversations",
    conversation.id,
    "conversation.json",
  );
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.status = "running";
  state.operations = [{
    id: "operation-recover",
    type: "retry_last_turn",
    status: "running",
    turnId: originalAnswer.turnId,
    targetAssistantMessageId: originalAnswer.id,
    resultAssistantMessageId: null,
    resumeStatus: "idle",
    startedAt: "2026-07-27T00:00:00.000Z",
    completedAt: null,
    error: null,
  }];
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  const recoveredService = createProjectWorkService({
    storageRoot,
    sessionFactory: createTurnControlSessionFactory(),
    idFactory: incrementalId("turn-retry-recovered"),
  });
  t.after(() => recoveredService.dispose());
  const recovered = await recoveredService.getConversation(conversation.id);
  assert.equal(recovered.conversation.status, "idle");
  assert.equal(recovered.conversation.lastError, null);
  assert.equal(recovered.conversation.messages.at(-1).id, originalAnswer.id);
  assert.equal(recovered.conversation.messages.at(-1).text, originalAnswer.text);
  assert.equal(recovered.conversation.operations[0].status, "interrupted");
  assert.equal(
    recovered.conversation.operations[0].error.code,
    "PROJECT_WORK_OPERATION_INTERRUPTED",
  );
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

test("manual compaction failure stays operation-scoped and restores conversation status", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-manual-compaction-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const sessionFactory = async () => {
    let subscriber = null;
    return {
      get autoCompactionEnabled() {
        return true;
      },
      getContextUsage() {
        return {
          tokens: 20_000,
          contextWindow: 100_000,
          percent: 20,
        };
      },
      subscribe(listener) {
        subscriber = listener;
        return () => {
          subscriber = null;
        };
      },
      async compact() {
        subscriber?.({ type: "compaction_start", reason: "manual" });
        throw new Error("private failure at /Users/private/project");
      },
      async steer() {},
      async abort() {},
      async setModel() {},
      dispose() {},
    };
  };
  sessionFactory.listModels = async () => modelCatalog();
  sessionFactory.dispose = async () => {};
  const service = createProjectWorkService({
    storageRoot: path.join(temporaryRoot, "private-state"),
    sessionFactory,
    idFactory: incrementalId("manual-compaction"),
  });
  t.after(() => service.dispose());

  const conversation = await service.createStandaloneConversation();
  await assert.rejects(
    service.compactConversation(conversation.id),
    /private failure/,
  );
  const failed = await service.getConversation(conversation.id);

  assert.equal(failed.conversation.status, "idle");
  assert.equal(failed.conversation.lastError, null);
  assert.equal(failed.conversation.compaction.status, "failed");
  assert.equal(failed.conversation.compaction.resumeStatus, "idle");
  assert.equal(
    failed.events.some((event) => event.type === "error"),
    false,
  );
  assert.ok(
    failed.events.some((event) => event.type === "compaction.failed"),
  );
  assert.doesNotMatch(JSON.stringify(failed), /Users\/private\/project/);
});

test("follow-up queue is durable, independently editable, and stop clears pending items", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-follow-ups-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const sessionFactory = createFollowUpSessionFactory();
  const service = createProjectWorkService({
    storageRoot: path.join(temporaryRoot, "private-state"),
    sessionFactory,
    idFactory: incrementalId("follow-up"),
  });
  t.after(() => service.dispose());

  const conversation = await service.createStandaloneConversation();
  await service.sendMessage(conversation.id, { text: "先检查项目" });
  const first = await service.enqueueFollowUp(conversation.id, {
    text: "完成后补充测试",
  });
  const second = await service.enqueueFollowUp(conversation.id, {
    text: "最后总结风险",
  });

  assert.deepEqual(
    (await service.listFollowUps(conversation.id)).map((item) => item.text),
    ["完成后补充测试", "最后总结风险"],
  );
  assert.deepEqual(
    sessionFactory.sessions[0].followUps,
    ["完成后补充测试", "最后总结风险"],
  );

  sessionFactory.sessions[0].deliver(first.item.text);
  await eventually(
    () => service.getConversation(conversation.id),
    (snapshot) => snapshot.conversation.followUpQueue.some(
      (item) => item.id === first.item.id && item.status === "delivered",
    ),
    "delivered follow-up was not persisted",
  );

  const removed = await service.removeFollowUp(
    conversation.id,
    second.item.id,
  );
  assert.equal(removed.cancelled[0].status, "cancelled");
  assert.deepEqual(sessionFactory.sessions[0].followUps, []);

  await service.enqueueFollowUp(conversation.id, {
    text: "停止时应清理",
  });
  await service.abortConversation(conversation.id);
  const stopped = await service.getConversation(conversation.id);
  assert.equal(
    stopped.conversation.followUpQueue.find(
      (item) => item.text === "停止时应清理",
    ).status,
    "cancelled",
  );
  assert.ok(sessionFactory.sessions[0].clearCalls > 0);
  assert.equal(
    stopped.events.some((event) => (
      event.type === "message.queued"
      && event.data.text === "完成后补充测试"
    )),
    false,
  );
});

test("queued follow-ups survive a service restart even when the active turn cannot resume", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-follow-up-restore-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const storageRoot = path.join(temporaryRoot, "private-state");
  const firstFactory = createFollowUpSessionFactory();
  const firstService = createProjectWorkService({
    storageRoot,
    sessionFactory: firstFactory,
    idFactory: incrementalId("follow-up-restore-first"),
  });
  const conversation = await firstService.createStandaloneConversation();
  await firstService.sendMessage(conversation.id, { text: "执行长任务" });
  const queued = await firstService.enqueueFollowUp(conversation.id, {
    text: "服务恢复后仍需可见",
  });
  await firstService.dispose();

  const secondService = createProjectWorkService({
    storageRoot,
    sessionFactory: createFakeSessionFactory(),
    idFactory: incrementalId("follow-up-restore-second"),
  });
  t.after(() => secondService.dispose());
  const restored = await secondService.getConversation(conversation.id);
  assert.notEqual(restored.conversation.status, "running");
  assert.equal(
    restored.conversation.followUpQueue.find(
      (item) => item.id === queued.item.id,
    ).status,
    "queued",
  );
  assert.deepEqual(
    (await secondService.listFollowUps(conversation.id)).map(
      (item) => item.text,
    ),
    ["服务恢复后仍需可见"],
  );
  const removed = await secondService.removeFollowUp(
    conversation.id,
    queued.item.id,
  );
  assert.equal(removed.cancelled[0].status, "cancelled");
});

test("project-owned ask-user state persists across service restart without impersonating a model tool", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-ask-user-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const storageRoot = path.join(temporaryRoot, "private-state");
  const firstService = createProjectWorkService({
    storageRoot,
    sessionFactory: createFakeSessionFactory(),
    idFactory: incrementalId("ask-user-first"),
  });
  const conversation = await firstService.createStandaloneConversation();
  const created = await firstService.createAskUserRequest(conversation.id, {
    questions: [{
      id: "scope",
      label: "范围",
      prompt: "这次需要检查哪些部分？",
      kind: "multiple_choice",
      options: [{
        id: "backend",
        label: "后端",
      }, {
        id: "frontend",
        label: "前端",
      }],
    }, {
      id: "note",
      label: "补充",
      prompt: "还有什么约束？",
      kind: "text",
      required: false,
    }],
  });
  assert.equal(created.request.source, "project_api");
  assert.equal(created.snapshot.conversation.status, "awaiting_user");
  await assert.rejects(
    firstService.sendMessage(conversation.id, { text: "绕过问题继续" }),
    (error) => error.code === "PROJECT_WORK_CONVERSATION_BUSY",
  );
  await firstService.dispose();

  const secondService = createProjectWorkService({
    storageRoot,
    sessionFactory: createFakeSessionFactory(),
    idFactory: incrementalId("ask-user-second"),
  });
  t.after(() => secondService.dispose());
  const restored = await secondService.getConversation(conversation.id);
  assert.equal(restored.conversation.status, "awaiting_user");
  assert.equal(restored.conversation.askUserRequests[0].status, "pending");
  assert.equal(restored.conversation.askUserRequests[0].source, "project_api");

  const answered = await secondService.answerAskUserRequest(
    conversation.id,
    created.request.id,
    {
      answers: [{
        questionId: "scope",
        value: ["backend"],
      }],
    },
  );
  assert.equal(answered.request.status, "answered");
  assert.equal(answered.snapshot.conversation.status, "idle");
  assert.deepEqual(answered.request.answers, [{
    questionId: "scope",
    value: ["backend"],
  }]);

  const secondRequest = await secondService.createAskUserRequest(
    conversation.id,
    {
      questions: [{
        id: "continue",
        prompt: "是否继续？",
        kind: "single_choice",
        options: [{
          id: "yes",
          label: "继续",
        }, {
          id: "no",
          label: "停止",
        }],
      }],
    },
  );
  const cancelled = await secondService.cancelAskUserRequest(
    conversation.id,
    secondRequest.request.id,
  );
  assert.equal(cancelled.request.status, "cancelled");
  assert.equal(cancelled.snapshot.conversation.status, "idle");
});

test("agent ask_user pauses durably and resumes with answered or cancelled input", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-agent-ask-user-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const sessionFactory = createAskUserSessionFactory();
  const service = createProjectWorkService({
    storageRoot: path.join(temporaryRoot, "private-state"),
    sessionFactory,
    idFactory: incrementalId("agent-ask-user"),
  });
  t.after(() => service.dispose());
  const conversation = await service.createStandaloneConversation();

  await service.sendMessage(conversation.id, { text: "先确认范围" });
  const awaitingAnswer = await eventually(
    () => service.getConversation(conversation.id),
    (snapshot) => (
      snapshot.conversation.status === "awaiting_user"
      && snapshot.conversation.askUserRequests.some(
        (request) => request.status === "pending",
      )
    ),
    "agent question did not become durable",
  );
  const firstRequest = awaitingAnswer.conversation.askUserRequests.find(
    (request) => request.status === "pending",
  );
  assert.equal(firstRequest.source, "agent_tool");
  await service.answerAskUserRequest(conversation.id, firstRequest.id, {
    answers: [{
      questionId: "scope-1",
      value: "backend",
    }],
  });
  await eventually(
    () => service.getConversation(conversation.id),
    (snapshot) => snapshot.conversation.status === "idle",
    "answered agent question did not resume",
  );
  assert.deepEqual(sessionFactory.sessions[0].outcomes[0].answers, [{
    questionId: "scope-1",
    value: "backend",
  }]);

  await service.sendMessage(conversation.id, { text: "再确认一次" });
  const awaitingCancel = await eventually(
    () => service.getConversation(conversation.id),
    (snapshot) => snapshot.conversation.askUserRequests.some(
      (request) => request.status === "pending",
    ),
    "second agent question did not become durable",
  );
  const secondRequest = awaitingCancel.conversation.askUserRequests.find(
    (request) => request.status === "pending",
  );
  await service.cancelAskUserRequest(conversation.id, secondRequest.id);
  await eventually(
    () => service.getConversation(conversation.id),
    (snapshot) => snapshot.conversation.status === "idle",
    "cancelled agent question did not resume",
  );
  assert.equal(sessionFactory.sessions[0].outcomes[1].status, "cancelled");
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
      resumeStatus: null,
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
    resumeStatus: null,
  });
  assert.equal(restored.conversation.lastError.code, "PROJECT_WORK_SESSION_INTERRUPTED");
});

test("assistant text persists throttled cumulative partials before completion", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-message-partials-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const sessionFactory = createStreamingSessionFactory();
  const fixedNow = new Date("2026-07-28T06:00:00.000Z");
  const service = createProjectWorkService({
    storageRoot: path.join(temporaryRoot, "private-state"),
    sessionFactory,
    now: () => fixedNow,
    idFactory: incrementalId("partial"),
  });
  t.after(() => service.dispose());

  const conversation = await service.createStandaloneConversation();
  await service.sendMessage(conversation.id, { text: "流式回答" });
  const streaming = await eventually(
    () => service.getConversation(conversation.id),
    (snapshot) => (
      snapshot.events.some((event) => event.type === "message.partial")
      && !snapshot.events.some((event) => event.type === "message.completed")
    ),
    "first assistant partial did not arrive before completion",
  );
  const firstPartial = streaming.events.find(
    (event) => event.type === "message.partial",
  );
  assert.equal(firstPartial.data.text, "首段");
  assert.equal(firstPartial.data.status, "streaming");
  assert.equal(firstPartial.data.isFinal, false);

  sessionFactory.sessions[0].release();
  const settled = await eventually(
    () => service.getConversation(conversation.id),
    (snapshot) => (
      snapshot.conversation.status === "idle"
      && snapshot.conversation.messages.length === 2
    ),
    "streaming assistant turn did not settle",
  );
  const partials = settled.events.filter(
    (event) => event.type === "message.partial",
  );
  const completed = settled.events.find(
    (event) => event.type === "message.completed",
  );
  const finalText = `首段${"x".repeat(520)}尾声`;
  assert.equal(partials.length, 3);
  assert.deepEqual(
    partials.map((event) => event.data.text),
    [
      "首段",
      `首段${"x".repeat(512)}`,
      finalText,
    ],
  );
  assert.deepEqual(
    partials.map((event) => event.data.revision),
    [1, 2, 3],
  );
  assert.ok(partials.every((event) => (
    event.data.id === completed.data.id
    && event.data.turnId === completed.data.turnId
    && event.data.turnSeq === completed.data.turnSeq
    && event.data.attempt === completed.data.attempt
    && event.data.status === "streaming"
  )));
  assert.ok(partials.at(-1).seq < completed.seq);
  assert.equal(completed.data.text, finalText);
});

test("thinking blocks persist lifecycle pairs without private reasoning", async (t) => {
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
    [
      "active",
      "finished",
      "active",
      "finished",
      "active",
      "finished",
      "active",
      "finished",
    ],
  );
  const persistedEvents = JSON.stringify(settled.events);
  assert.equal(persistedEvents.includes("private reasoning"), false);
  assert.equal(persistedEvents.includes("private-0-0"), false);
  assert.equal(persistedEvents.includes("private-1-0"), false);
  const completedEvents = settled.events.filter(
    (event) => event.type === "message.completed",
  );
  assert.equal(completedEvents.length, 2);
  assert.ok(thinkingEvents[3].seq < completedEvents[0].seq);
  assert.ok(thinkingEvents[7].seq < completedEvents[1].seq);
});

test("a new turn clears the previous plan until it publishes its own", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-turn-plan-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  let releaseSecondPlan;
  let promptCount = 0;
  const sessionFactory = async (options) => {
    let subscriber = null;
    return {
      subscribe(listener) {
        subscriber = listener;
        return () => {
          subscriber = null;
        };
      },
      async prompt() {
        promptCount += 1;
        if (promptCount === 2) {
          await new Promise((resolve) => {
            releaseSecondPlan = resolve;
          });
        }
        await options.onPlan({
          explanation: promptCount === 1 ? "上一轮计划" : "当前轮计划",
          steps: [{
            id: promptCount === 1 ? "previous" : "current",
            text: promptCount === 1 ? "上一轮步骤" : "当前轮步骤",
            status: "completed",
          }],
        });
        subscriber?.({ type: "agent_settled" });
      },
      async steer() {},
      async abort() {},
      async compact() {},
      async setModel() {},
      dispose() {},
    };
  };
  sessionFactory.listModels = async () => modelCatalog();
  sessionFactory.dispose = async () => {};

  const service = createProjectWorkService({
    storageRoot: path.join(temporaryRoot, "private-state"),
    sessionFactory,
    idFactory: incrementalId("turn-plan"),
  });
  t.after(() => service.dispose());

  const conversation = await service.createStandaloneConversation();
  await service.sendMessage(conversation.id, { text: "第一轮" });
  await eventually(
    () => service.getConversation(conversation.id),
    (snapshot) => (
      snapshot.conversation.status === "idle"
      && snapshot.conversation.plan?.steps?.[0]?.id === "previous"
    ),
    "first turn plan did not settle",
  );

  const admitted = await eventually(
    async () => {
      try {
        return await service.sendMessage(conversation.id, {
          text: "第二轮",
          clientRequestId: "turn-plan-second",
        });
      } catch (error) {
        if (error?.code === "PROJECT_WORK_CONVERSATION_BUSY") return null;
        throw error;
      }
    },
    Boolean,
    "second turn was not admitted after the first turn settled",
  );
  assert.equal(admitted.conversation.status, "running");
  assert.equal(admitted.conversation.plan, null);
  assert.equal(
    (await service.getConversation(conversation.id)).conversation.plan,
    null,
  );

  await eventually(
    async () => releaseSecondPlan,
    (release) => typeof release === "function",
    "second turn did not start",
  );
  releaseSecondPlan();
  const settled = await eventually(
    () => service.getConversation(conversation.id),
    (snapshot) => (
      snapshot.conversation.status === "idle"
      && snapshot.conversation.plan?.steps?.[0]?.id === "current"
    ),
    "second turn plan did not settle",
  );
  assert.equal(settled.conversation.plan.explanation, "当前轮计划");
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
  const pngHeader = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  await writeFile(path.join(projectRoot, "preview.png"), pngHeader);
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
  await writeFile(path.join(overlayRoot, "src", "generated.png"), pngHeader);

  const modified = await service.readConversationFile(conversation.id, {
    filePath: "app.js",
  });
  const created = await service.readConversationFile(conversation.id, {
    filePath: "src/generated.js",
  });
  const live = await service.readProjectFile(project.id, {
    filePath: "app.js",
  });
  const rootTree = await service.getConversationTree(conversation.id, {
    limit: 20,
  });
  const nestedTree = await service.getConversationTree(conversation.id, {
    directory: "src",
    query: "generated",
    limit: 20,
  });
  const image = await service.readConversationImage(conversation.id, {
    filePath: "src/generated.png",
  });

  assert.match(modified.content, /source = 'overlay'/);
  assert.match(created.content, /generated = true/);
  assert.notEqual(modified.hash, live.hash);
  assert.equal(
    rootTree.entries.find((entry) => entry.path === "app.js")?.overlay,
    "modified",
  );
  assert.deepEqual(
    nestedTree.entries.map((entry) => [entry.path, entry.overlay]),
    [
      ["src/generated.js", "created"],
      ["src/generated.png", "created"],
    ],
  );
  assert.equal(image.mimeType, "image/png");
  assert.equal(image.bytes.equals(pngHeader), true);
  assert.equal(JSON.stringify({ modified, created }).includes(projectRoot), false);
  assert.equal(JSON.stringify({ modified, created }).includes(storageRoot), false);
  assert.equal(JSON.stringify({ rootTree, nestedTree, image }).includes(projectRoot), false);
  assert.equal(JSON.stringify({ rootTree, nestedTree, image }).includes(storageRoot), false);
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
    (snapshot) => (
      snapshot.conversation.status === "awaiting_confirmation"
      && snapshot.events.some((event) => (
        event.type === "agent.status"
        && event.data.status === "awaiting_confirmation"
      ))
    ),
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
  const afterFailedVerification = await service.getConversation(conversation.id);
  assert.equal(afterFailedVerification.conversation.status, "applied");
  assert.equal(afterFailedVerification.conversation.lastError, null);
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

test("a confirmed failed verification is repaired once and rerun against the same isolated command", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-verification-repair-pass-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  const storageRoot = path.join(temporaryRoot, "private-state");
  await mkdir(projectRoot);
  await writeFile(
    path.join(projectRoot, "app.js"),
    "export const verificationState = \"original\";\n",
    "utf8",
  );
  const sessionFactory = createVerificationRepairSessionFactory();
  const runnerCalls = [];
  const service = createProjectWorkService({
    storageRoot,
    sessionFactory,
    picker: async () => ({ rootPath: projectRoot }),
    runner: async (request) => {
      runnerCalls.push(structuredClone(request));
      const content = await readFile(path.join(request.cwd, "app.js"), "utf8");
      const passed = content.includes("\"fixed\"");
      return {
        exitCode: passed ? 0 : 1,
        durationMs: 4,
        stdout: passed ? "verification passed" : "",
        stderr: passed ? "" : `verification failed in ${request.cwd}/app.js`,
        truncated: false,
        timedOut: false,
        aborted: false,
      };
    },
    idFactory: incrementalId("repair-pass"),
  });
  t.after(() => service.dispose());

  const selection = await service.pickProjectRoot({ mode: "existing" });
  const project = await service.registerProject({
    selectionId: selection.selectionId,
  });
  const conversation = await service.createConversation(project.id);
  await service.sendMessage(conversation.id, {
    text: "修复实现并准备验证",
  });
  const pending = await eventually(
    () => service.getConversation(conversation.id),
    (snapshot) => (
      snapshot.conversation.status === "awaiting_confirmation"
      && snapshot.conversation.verifications.some(
        (verification) => verification.status === "requested",
      )
    ),
    "manual verification request was not ready",
  );
  const request = pending.conversation.verifications.find(
    (verification) => verification.status === "requested",
  );

  assert.equal(runnerCalls.length, 0);
  assert.equal(
    await readFile(path.join(projectRoot, "app.js"), "utf8"),
    "export const verificationState = \"original\";\n",
  );
  const completed = await service.runVerification(conversation.id, {
    requestId: request.id,
  });

  assert.equal(completed.status, "passed");
  assert.equal(completed.repairAttempt, 1);
  assert.equal(runnerCalls.length, 2);
  assert.equal(sessionFactory.sessions[0].repairCalls.length, 1);
  const [repairPayload] = sessionFactory.sessions[0].repairCalls;
  assert.equal(repairPayload.commandBindingHash, request.bindingHash);
  assert.equal(repairPayload.repairAttempt, 1);
  assert.equal(repairPayload.maxRepairAttempts, 2);
  assert.equal(repairPayload.failure.output.includes(storageRoot), false);
  assert.match(repairPayload.failure.output, /<workspace>/);
  assert.ok(sessionFactory.sessions[0].activeToolCalls.some((names) => (
    names.join(",") === "read,edit,write,grep,find,ls,update_plan"
  )));

  const settled = await service.getConversation(conversation.id);
  const operation = settled.conversation.operations.find(
    (item) => item.type === "verification_repair",
  );
  assert.equal(operation.status, "completed");
  assert.equal(operation.phase, "completed");
  assert.equal(operation.repairAttemptCount, 1);
  assert.equal(operation.validationAttemptIds.length, 2);
  assert.equal(settled.conversation.status, "awaiting_confirmation");
  assert.equal(settled.conversation.activeChangeSet.status, "ready");
  assert.ok(settled.conversation.messages.some(
    (message) => message.text === "初步修改已完成，等待验证。",
  ));
  assert.ok(settled.conversation.messages.some((message) => (
    message.verificationRepairOperationId === operation.id
    && message.repairAttempt === 1
  )));
  assert.equal(
    await readFile(path.join(projectRoot, "app.js"), "utf8"),
    "export const verificationState = \"original\";\n",
  );
});

test("verification repair stops after two failed repair attempts", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-verification-repair-limit-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  await mkdir(projectRoot);
  await writeFile(
    path.join(projectRoot, "app.js"),
    "export const verificationState = \"original\";\n",
    "utf8",
  );
  const sessionFactory = createVerificationRepairSessionFactory({
    repairMode: "fail",
  });
  let runnerCalls = 0;
  const service = createProjectWorkService({
    storageRoot: path.join(temporaryRoot, "private-state"),
    sessionFactory,
    picker: async () => ({ rootPath: projectRoot }),
    runner: async () => {
      runnerCalls += 1;
      return {
        exitCode: 1,
        durationMs: 3,
        stdout: "",
        stderr: "the assertion still fails",
        truncated: false,
        timedOut: false,
        aborted: false,
      };
    },
    idFactory: incrementalId("repair-limit"),
  });
  t.after(() => service.dispose());

  const selection = await service.pickProjectRoot({ mode: "existing" });
  const project = await service.registerProject({
    selectionId: selection.selectionId,
  });
  const conversation = await service.createConversation(project.id);
  await service.sendMessage(conversation.id, { text: "修复并验证" });
  const pending = await eventually(
    () => service.getConversation(conversation.id),
    (snapshot) => snapshot.conversation.status === "awaiting_confirmation",
    "change set was not ready",
  );
  const request = pending.conversation.verifications.find(
    (verification) => verification.status === "requested",
  );
  const completed = await service.runVerification(conversation.id, {
    requestId: request.id,
  });

  assert.equal(completed.status, "failed");
  assert.equal(completed.repairAttempt, 2);
  assert.equal(runnerCalls, 3);
  assert.equal(sessionFactory.sessions[0].repairCalls.length, 2);
  const settled = await service.getConversation(conversation.id);
  const operation = settled.conversation.operations.find(
    (item) => item.type === "verification_repair",
  );
  assert.equal(operation.status, "failed");
  assert.equal(operation.repairAttemptCount, 2);
  assert.equal(operation.maxRepairAttempts, 2);
  assert.equal(operation.validationAttemptIds.length, 3);
  assert.equal(
    operation.error.code,
    "PROJECT_WORK_VERIFICATION_REPAIR_LIMIT",
  );
  assert.equal(settled.conversation.status, "awaiting_confirmation");
  assert.equal(settled.conversation.lastError, null);
});

test("verification repair blocks when a package script changes the confirmed command binding", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-verification-repair-binding-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  await mkdir(projectRoot);
  await Promise.all([
    writeFile(
      path.join(projectRoot, "app.js"),
      "export const verificationState = \"original\";\n",
      "utf8",
    ),
    writeFile(
      path.join(projectRoot, "package.json"),
      `${JSON.stringify({
        scripts: {
          verify: "node --test",
        },
      }, null, 2)}\n`,
      "utf8",
    ),
  ]);
  const sessionFactory = createVerificationRepairSessionFactory({
    command: {
      file: "npm",
      args: ["run", "verify"],
      checks: ["项目测试应通过"],
    },
    repairMode: "change_binding",
  });
  let runnerCalls = 0;
  const service = createProjectWorkService({
    storageRoot: path.join(temporaryRoot, "private-state"),
    sessionFactory,
    picker: async () => ({ rootPath: projectRoot }),
    runner: async () => {
      runnerCalls += 1;
      return {
        exitCode: 1,
        durationMs: 3,
        stdout: "",
        stderr: "initial verification failed",
        truncated: false,
        timedOut: false,
        aborted: false,
      };
    },
    idFactory: incrementalId("repair-binding"),
  });
  t.after(() => service.dispose());

  const selection = await service.pickProjectRoot({ mode: "existing" });
  const project = await service.registerProject({
    selectionId: selection.selectionId,
  });
  const conversation = await service.createConversation(project.id);
  await service.sendMessage(conversation.id, { text: "修复并验证脚本" });
  const pending = await eventually(
    () => service.getConversation(conversation.id),
    (snapshot) => snapshot.conversation.status === "awaiting_confirmation",
    "change set was not ready",
  );
  const request = pending.conversation.verifications.find(
    (verification) => verification.status === "requested",
  );
  const completed = await service.runVerification(conversation.id, {
    requestId: request.id,
  });

  assert.equal(
    completed.errorCode,
    "PROJECT_WORK_VERIFICATION_BINDING_CHANGED",
  );
  assert.equal(runnerCalls, 1);
  assert.equal(sessionFactory.sessions[0].repairCalls.length, 1);
  const settled = await service.getConversation(conversation.id);
  const operation = settled.conversation.operations.find(
    (item) => item.type === "verification_repair",
  );
  assert.equal(operation.status, "failed");
  assert.equal(
    operation.error.code,
    "PROJECT_WORK_VERIFICATION_BINDING_CHANGED",
  );
  assert.equal(settled.conversation.status, "awaiting_confirmation");
  assert.deepEqual(
    JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8")),
    {
      scripts: {
        verify: "node --test",
      },
    },
  );
});

test("restart interrupts verification repair without a paid repeat and explicit resume reverifies first", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-verification-repair-restart-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  const storageRoot = path.join(temporaryRoot, "private-state");
  await mkdir(projectRoot);
  await writeFile(
    path.join(projectRoot, "app.js"),
    "export const verificationState = \"original\";\n",
    "utf8",
  );
  const firstFactory = createVerificationRepairSessionFactory();
  const firstService = createProjectWorkService({
    storageRoot,
    sessionFactory: firstFactory,
    picker: async () => ({ rootPath: projectRoot }),
    runner: async (request) => {
      const content = await readFile(path.join(request.cwd, "app.js"), "utf8");
      return {
        exitCode: content.includes("\"fixed\"") ? 0 : 1,
        durationMs: 2,
        stdout: "",
        stderr: content.includes("\"fixed\"") ? "" : "failed",
        truncated: false,
        timedOut: false,
        aborted: false,
      };
    },
    idFactory: incrementalId("repair-restart-first"),
  });
  const selection = await firstService.pickProjectRoot({ mode: "existing" });
  const project = await firstService.registerProject({
    selectionId: selection.selectionId,
  });
  const conversation = await firstService.createConversation(project.id);
  await firstService.sendMessage(conversation.id, { text: "修复并验证" });
  const pending = await eventually(
    () => firstService.getConversation(conversation.id),
    (snapshot) => snapshot.conversation.status === "awaiting_confirmation",
    "change set was not ready",
  );
  const request = pending.conversation.verifications.find(
    (verification) => verification.status === "requested",
  );
  await firstService.runVerification(conversation.id, {
    requestId: request.id,
  });
  await firstService.dispose();

  const statePath = path.join(
    storageRoot,
    "conversations",
    conversation.id,
    "conversation.json",
  );
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const operation = state.operations.find(
    (item) => item.type === "verification_repair",
  );
  const initialFailure = state.verifications.find(
    (verification) => (
      verification.status === "failed"
      && !verification.repairOperationId
    ),
  );
  const passedRepair = state.verifications.find(
    (verification) => (
      verification.status === "passed"
      && verification.repairOperationId === operation.id
    ),
  );
  state.status = "verifying";
  Object.assign(operation, {
    status: "running",
    phase: "verifying",
    repairAttemptCount: 1,
    lastFailedAttemptId: initialFailure.id,
    completedAt: null,
    error: null,
  });
  state.verifications.push({
    ...passedRepair,
    id: "verification-run-crash",
    status: "running",
    exitCode: null,
    durationMs: null,
    output: "",
    resumeStatus: "awaiting_confirmation",
    completedAt: null,
  });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  const resumedFactory = createVerificationRepairSessionFactory();
  let resumedRunnerCalls = 0;
  const resumedService = createProjectWorkService({
    storageRoot,
    sessionFactory: resumedFactory,
    picker: async () => ({ rootPath: projectRoot }),
    runner: async (request) => {
      resumedRunnerCalls += 1;
      const content = await readFile(path.join(request.cwd, "app.js"), "utf8");
      return {
        exitCode: content.includes("\"fixed\"") ? 0 : 1,
        durationMs: 2,
        stdout: "reverified",
        stderr: "",
        truncated: false,
        timedOut: false,
        aborted: false,
      };
    },
    idFactory: incrementalId("repair-restart-resumed"),
  });
  t.after(() => resumedService.dispose());

  const recovered = await resumedService.getConversation(conversation.id);
  const interrupted = recovered.conversation.operations.find(
    (item) => item.id === operation.id,
  );
  assert.equal(interrupted.status, "interrupted");
  assert.equal(
    interrupted.error.code,
    "PROJECT_WORK_VERIFICATION_REPAIR_INTERRUPTED",
  );
  assert.equal(resumedFactory.sessions.length, 0);
  assert.equal(resumedRunnerCalls, 0);

  const completed = await resumedService.resumeVerificationRepair(
    conversation.id,
    {
      operationId: operation.id,
      clientRequestId: "repair:resume-once",
    },
  );
  assert.equal(completed.status, "passed");
  await resumedService.resumeVerificationRepair(conversation.id, {
    operationId: operation.id,
    clientRequestId: "repair:resume-once",
  });
  assert.equal(resumedFactory.sessions.length, 1);
  assert.equal(resumedFactory.sessions[0].repairCalls.length, 0);
  assert.equal(resumedRunnerCalls, 1);
  const finalSnapshot = await resumedService.getConversation(conversation.id);
  const completedOperation = finalSnapshot.conversation.operations.find(
    (item) => item.id === operation.id,
  );
  assert.equal(completedOperation.status, "completed");
  assert.equal(completedOperation.repairAttemptCount, 1);
});

test("apply journal exposes one hash-bound undo and blocks stale external changes", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-apply-undo-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  const storageRoot = path.join(temporaryRoot, "private-state");
  await mkdir(projectRoot);
  await writeFile(path.join(projectRoot, "app.js"), "export const version = 1;\n");
  const service = createProjectWorkService({
    storageRoot,
    sessionFactory: createFakeSessionFactory({ verificationRequest: null }),
    picker: async () => ({ rootPath: projectRoot }),
    idFactory: incrementalId("apply-undo"),
  });
  t.after(() => service.dispose());
  const selection = await service.pickProjectRoot({ mode: "existing" });
  const project = await service.registerProject({
    selectionId: selection.selectionId,
  });
  const conversation = await service.createConversation(project.id);

  async function prepareAndApply(message) {
    await service.sendMessage(conversation.id, { text: message });
    const settled = await eventually(
      () => service.getConversation(conversation.id),
      (snapshot) => snapshot.conversation.activeChangeSet?.status === "ready",
      "change set did not become reviewable",
    );
    const changeSet = settled.conversation.activeChangeSet;
    await service.applyChangeSet(conversation.id, {
      changeSetId: changeSet.id,
      changeSetHash: changeSet.hash,
      files: changeSet.files.map((file) => ({
        fileId: file.id,
        baseHash: file.baseHash,
        afterHash: file.afterHash,
      })),
    });
    return (await service.listApplyJournal(conversation.id)).at(-1);
  }

  const firstJournal = await prepareAndApply("升级版本");
  assert.equal(firstJournal.status, "applied");
  assert.equal(firstJournal.undo.status, "available");
  assert.equal(JSON.stringify(firstJournal).includes(projectRoot), false);
  const undone = await service.undoApply(conversation.id, firstJournal.id, {
    undoHash: firstJournal.undo.hash,
  });
  assert.equal(
    await readFile(path.join(projectRoot, "app.js"), "utf8"),
    "export const version = 1;\n",
  );
  assert.equal(undone.conversation.applyJournal[0].status, "undone");
  assert.equal(undone.conversation.applyJournal[0].undo.status, "used");
  await assert.rejects(
    service.undoApply(conversation.id, firstJournal.id, {
      undoHash: firstJournal.undo.hash,
    }),
    (error) => error.code === "PROJECT_WORK_UNDO_UNAVAILABLE",
  );

  const secondJournal = await prepareAndApply("再次升级版本");
  await writeFile(
    path.join(projectRoot, "app.js"),
    "export const version = 3;\n",
  );
  await assert.rejects(
    service.undoApply(conversation.id, secondJournal.id, {
      undoHash: secondJournal.undo.hash,
    }),
    (error) => error.code === "PROJECT_WORK_CHANGE_STALE",
  );
  assert.equal(
    await readFile(path.join(projectRoot, "app.js"), "utf8"),
    "export const version = 3;\n",
  );
  const journals = await service.listApplyJournal(conversation.id);
  assert.equal(journals.at(-1).undo.status, "blocked");
});

test("a prepared apply journal rolls back deterministically after service restart", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-apply-recovery-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  const storageRoot = path.join(temporaryRoot, "private-state");
  await mkdir(projectRoot);
  await Promise.all([
    writeFile(path.join(projectRoot, "app.js"), "export const version = 1;\n"),
    writeFile(path.join(projectRoot, "other.js"), "export const other = 1;\n"),
  ]);
  const firstService = createProjectWorkService({
    storageRoot,
    sessionFactory: createFakeSessionFactory({
      verificationRequest: null,
      additionalChanges: [{
        path: "other.js",
        content: "export const other = 2;\n",
      }],
    }),
    picker: async () => ({ rootPath: projectRoot }),
    idFactory: incrementalId("apply-recovery-first"),
  });
  const selection = await firstService.pickProjectRoot({ mode: "existing" });
  const project = await firstService.registerProject({
    selectionId: selection.selectionId,
  });
  const conversation = await firstService.createConversation(project.id);
  await firstService.sendMessage(conversation.id, { text: "准备可恢复修改" });
  const ready = await eventually(
    () => firstService.getConversation(conversation.id),
    (snapshot) => snapshot.conversation.activeChangeSet?.status === "ready",
    "recovery change did not become reviewable",
  );
  const changeSet = ready.conversation.activeChangeSet;
  await firstService.applyChangeSet(conversation.id, {
    changeSetId: changeSet.id,
    changeSetHash: changeSet.hash,
    files: changeSet.files.map((file) => ({
      fileId: file.id,
      baseHash: file.baseHash,
      afterHash: file.afterHash,
    })),
  });
  await firstService.dispose();

  const conversationRoot = path.join(
    storageRoot,
    "conversations",
    conversation.id,
  );
  const statePath = path.join(conversationRoot, "conversation.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const interruptedJournal = state.applyJournal[0];
  assert.equal(interruptedJournal.files.length, 2);
  interruptedJournal.status = "prepared";
  interruptedJournal.appliedAt = null;
  interruptedJournal.finalizedAt = null;
  interruptedJournal.undo.status = "unavailable";
  state.status = "awaiting_confirmation";
  state.activeChangeSet = {
    ...interruptedJournal.changeSet,
    status: "ready",
  };
  await Promise.all([
    writeFile(
      path.join(conversationRoot, "base", "app.js"),
      "export const version = 2;\n",
    ),
    writeFile(
      path.join(conversationRoot, "workspace", "app.js"),
      "export const version = 2;\n",
    ),
    writeFile(
      path.join(projectRoot, "other.js"),
      "export const other = 1;\n",
    ),
    writeFile(
      path.join(conversationRoot, "base", "other.js"),
      "export const other = 1;\n",
    ),
    writeFile(
      path.join(conversationRoot, "workspace", "other.js"),
      "export const other = 2;\n",
    ),
    writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8"),
  ]);

  const secondService = createProjectWorkService({
    storageRoot,
    sessionFactory: createFakeSessionFactory({ verificationRequest: null }),
    idFactory: incrementalId("apply-recovery-second"),
  });
  t.after(() => secondService.dispose());
  const recovered = await secondService.getConversation(conversation.id);

  assert.equal(
    await readFile(path.join(projectRoot, "app.js"), "utf8"),
    "export const version = 1;\n",
  );
  assert.equal(
    await readFile(path.join(conversationRoot, "base", "app.js"), "utf8"),
    "export const version = 1;\n",
  );
  assert.equal(
    await readFile(path.join(projectRoot, "other.js"), "utf8"),
    "export const other = 1;\n",
  );
  assert.equal(
    await readFile(path.join(conversationRoot, "base", "other.js"), "utf8"),
    "export const other = 1;\n",
  );
  assert.equal(recovered.conversation.workspace.status, "ready");
  assert.equal(recovered.conversation.applyJournal[0].status, "rolled_back");
  assert.equal(recovered.conversation.activeChangeSet.status, "ready");
});

test("execution policy defaults to manual review and configures with revision CAS", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-execution-policy-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const service = createProjectWorkService({
    storageRoot: path.join(temporaryRoot, "private-state"),
    sessionFactory: createFakeSessionFactory(),
    idFactory: incrementalId("execution-policy"),
  });
  t.after(() => service.dispose());

  const conversation = await service.createStandaloneConversation();
  assert.deepEqual(conversation.executionPolicy, {
    mode: "manual_review",
    revision: 1,
    policyVersion: 1,
  });

  const configured = await service.configureExecutionPolicy(conversation.id, {
    mode: "auto_review",
    expectedRevision: 1,
  });
  assert.deepEqual(configured.conversation.executionPolicy, {
    mode: "auto_review",
    revision: 2,
    policyVersion: 1,
  });
  assert.deepEqual(
    (await service.listStandaloneConversations())[0].executionPolicy,
    configured.conversation.executionPolicy,
  );
  await assert.rejects(
    service.configureExecutionPolicy(conversation.id, {
      mode: "manual_review",
      expectedRevision: 1,
    }),
    (error) => {
      assert.equal(error.code, "PROJECT_WORK_EXECUTION_POLICY_STALE");
      assert.equal(error.status, 409);
      return true;
    },
  );
  assert.ok(configured.events.some((event) => (
    event.type === "execution_policy.changed"
    && event.data.mode === "auto_review"
    && event.data.revision === 2
  )));
});

test("bound-project auto review cannot retroactively approve a pending manual change", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-auto-review-pending-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  await mkdir(projectRoot);
  await writeFile(
    path.join(projectRoot, "app.js"),
    "export const version = 1;\n",
    "utf8",
  );
  const service = createProjectWorkService({
    storageRoot: path.join(temporaryRoot, "private-state"),
    sessionFactory: createFakeSessionFactory({ verificationRequest: null }),
    picker: async () => ({ rootPath: projectRoot }),
    idFactory: incrementalId("auto-review-pending"),
  });
  t.after(() => service.dispose());

  const selection = await service.pickProjectRoot({ mode: "existing" });
  const project = await service.registerProject({
    selectionId: selection.selectionId,
  });
  const conversation = await service.createConversation(project.id);
  await service.sendMessage(conversation.id, { text: "先准备修改，不要应用" });
  await eventually(
    () => service.getConversation(conversation.id),
    (snapshot) => (
      snapshot.conversation.activeChangeSet?.status === "ready"
      && snapshot.conversation.status === "awaiting_confirmation"
    ),
    "manual change did not reach review",
  );

  await assert.rejects(
    service.configureExecutionPolicy(conversation.id, {
      mode: "auto_review",
      expectedRevision: 1,
    }),
    (error) => error?.code === "PROJECT_WORK_AUTO_REVIEW_PENDING_CHANGE",
  );
  assert.equal(
    await readFile(path.join(projectRoot, "app.js"), "utf8"),
    "export const version = 1;\n",
  );
});

test("legacy bound workspaces gain recoverable auto-apply capability without trusting stored flags", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-auto-review-migration-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  const storageRoot = path.join(temporaryRoot, "private-state");
  await mkdir(projectRoot);
  await writeFile(path.join(projectRoot, "app.js"), "original\n", "utf8");
  const service = createProjectWorkService({
    storageRoot,
    sessionFactory: createFakeSessionFactory({ verificationRequest: null }),
    picker: async () => ({ rootPath: projectRoot }),
    idFactory: incrementalId("auto-review-migration"),
  });
  t.after(() => service.dispose());

  const selection = await service.pickProjectRoot({ mode: "existing" });
  const project = await service.registerProject({
    selectionId: selection.selectionId,
  });
  const conversation = await service.createConversation(project.id);
  const statePath = path.join(
    storageRoot,
    "conversations",
    conversation.id,
    "conversation.json",
  );
  const legacyState = JSON.parse(await readFile(statePath, "utf8"));
  legacyState.workspace = {
    ...legacyState.workspace,
    recoverableIsolation: false,
    automaticApplyAllowed: false,
  };
  await writeFile(statePath, `${JSON.stringify(legacyState, null, 2)}\n`, "utf8");

  const workspace = await service.getWorkspace(conversation.id);
  assert.equal(workspace.recoverableIsolation, true);
  assert.equal(workspace.automaticApplyAllowed, true);
  const configured = await service.configureExecutionPolicy(conversation.id, {
    mode: "auto_review",
    expectedRevision: 1,
  });
  assert.equal(configured.conversation.executionPolicy.mode, "auto_review");
  assert.equal(
    configured.events.some((event) => event.type === "execution_policy.downgraded"),
    false,
  );
});

test("auto review applies a safe change and runs verification in an isolated snapshot", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-auto-review-safe-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  await mkdir(projectRoot);
  await writeFile(
    path.join(projectRoot, "app.js"),
    "export const version = 1;\n",
    "utf8",
  );
  const runnerCalls = [];
  const service = createProjectWorkService({
    storageRoot: path.join(temporaryRoot, "private-state"),
    sessionFactory: createFakeSessionFactory(),
    picker: async () => ({ rootPath: projectRoot }),
    runner: async (command) => {
      runnerCalls.push(command);
      return {
        exitCode: 0,
        durationMs: 5,
        stdout: "safe verification passed",
        stderr: "",
        truncated: false,
        timedOut: false,
        aborted: false,
      };
    },
    idFactory: incrementalId("auto-review-safe"),
  });
  t.after(() => service.dispose());

  const selection = await service.pickProjectRoot({ mode: "existing" });
  const project = await service.registerProject({
    selectionId: selection.selectionId,
  });
  const conversation = await service.createConversation(project.id);
  await service.configureExecutionPolicy(conversation.id, {
    mode: "auto_review",
    expectedRevision: 1,
  });
  await service.sendMessage(conversation.id, {
    text: "修改并验证",
  });
  const settled = await eventually(
    () => service.getConversation(conversation.id),
    (snapshot) => (
      snapshot.conversation.status === "applied"
      &&
      snapshot.conversation.activeChangeSet?.status === "applied"
      && snapshot.conversation.verifications.some(
        (verification) => verification.status === "passed",
      )
    ),
    "auto review did not apply the safe turn and run its command",
  );

  assert.equal(
    await readFile(path.join(projectRoot, "app.js"), "utf8"),
    "export const version = 2;\n",
  );
  assert.equal(settled.conversation.activeChangeSet.status, "applied");
  assert.equal(runnerCalls.length, 1);
  assert.notEqual(runnerCalls[0].cwd, projectRoot);
  const passed = settled.conversation.verifications.find(
    (verification) => verification.status === "passed",
  );
  assert.ok(passed.turnId);
  assert.equal(passed.executionPolicyRevision, 2);
  assert.equal(passed.exitCode, 0);
  assert.equal(settled.conversation.applyJournal.at(-1).status, "applied");
  assert.equal(
    settled.conversation.applyJournal.at(-1).undo.status,
    "available",
  );
  assert.deepEqual(
    settled.events
      .filter((event) => event.type === "auto_review.decision")
      .map((event) => ({
        actionType: event.data.actionType,
        decision: event.data.decision,
      })),
    [
      { actionType: "change_set", decision: "allow" },
      { actionType: "verification", decision: "allow" },
    ],
  );
});

test("auto review starts and opens a current-turn controlled preview after applying safe changes", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-auto-preview-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  await mkdir(projectRoot);
  await writeFile(
    path.join(projectRoot, "app.js"),
    "export const version = 1;\n",
    "utf8",
  );
  const sessionFactory = createFakeSessionFactory({
    verificationRequest: null,
    previewRequest: {
      runtime: "vite",
      cwd: ".",
      route: "/reader/",
      title: "读者端",
    },
  });
  const previewSupervisor = createFakePreviewSupervisor();
  const storageRoot = path.join(temporaryRoot, "private-state");
  const service = createProjectWorkService({
    storageRoot,
    sessionFactory,
    picker: async () => ({ rootPath: projectRoot }),
    previewSupervisor,
    idFactory: incrementalId("auto-preview"),
  });
  t.after(() => service.dispose());

  const selection = await service.pickProjectRoot({ mode: "existing" });
  const project = await service.registerProject({
    selectionId: selection.selectionId,
  });
  const conversation = await service.createConversation(project.id);
  await enableRecoverableWorkspaceForTest(
    path.join(temporaryRoot, "private-state"),
    conversation.id,
  );
  await service.configureExecutionPolicy(conversation.id, {
    mode: "auto_review",
    expectedRevision: 1,
  });
  await service.sendMessage(conversation.id, {
    text: "应用修改后启动并打开读者端预览",
  });
  const settled = await eventually(
    () => service.getConversation(conversation.id),
    (snapshot) => (
      snapshot.conversation.status === "applied"
      && snapshot.conversation.preview?.status === "ready"
    ),
    "controlled preview did not open after safe settlement",
  );

  assert.equal(previewSupervisor.starts.length, 1);
  assert.equal(previewSupervisor.starts[0].key, conversation.id);
  assert.equal(previewSupervisor.starts[0].projectRoot, await realpath(projectRoot));
  assert.deepEqual(previewSupervisor.starts[0].request, {
    id: previewSupervisor.starts[0].request.id,
    runtime: "vite",
    cwd: ".",
    app: null,
    route: "/reader/",
    title: "读者端",
    requestHash: previewSupervisor.starts[0].request.requestHash,
    turnId: previewSupervisor.starts[0].request.turnId,
    workflowId: null,
    executionPolicyMode: "auto_review",
    executionPolicyRevision: 2,
    status: "requested",
    blockedReason: null,
    createdAt: previewSupervisor.starts[0].request.createdAt,
    completedAt: null,
  });
  assert.equal(settled.conversation.preview.url, "http://127.0.0.1:48080/reader/");
  assert.match(settled.conversation.preview.requestHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(settled.conversation.preview.confirmationRequired, false);
  assert.deepEqual(settled.conversation.preview.recipe, {
    runtime: "vite",
    cwd: ".",
    app: null,
    route: "/reader/",
    command: {
      executable: "node_modules/.bin/vite",
      argv: [
        "--host",
        "127.0.0.1",
        "--port",
        "<assigned-loopback-port>",
        "--strictPort",
      ],
    },
  });
  assert.doesNotMatch(
    JSON.stringify(settled.conversation.preview),
    new RegExp(temporaryRoot.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.equal("cwd" in settled.conversation.preview, false);
  assert.equal("app" in settled.conversation.preview, false);
  assert.ok(sessionFactory.sessions[0].activeToolCalls.some(
    (names) => names.includes("request_preview"),
  ));
  assert.ok(settled.events.some((event) => event.type === "preview.opened"));
  assert.ok(settled.events.some((event) => (
    event.type === "auto_review.decision"
    && event.data.actionType === "preview"
    && event.data.decision === "allow"
  )));
});

test("manual review persists a static preview and starts it only with the exact preview id and request hash", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-manual-preview-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  await mkdir(projectRoot);
  await writeFile(
    path.join(projectRoot, "app.js"),
    "export const version = 1;\n",
    "utf8",
  );
  const sessionFactory = createFakeSessionFactory({
    verificationRequest: null,
    previewRequest: {
      runtime: "static",
      cwd: ".",
      route: "/",
      title: "静态页面",
    },
  });
  const previewSupervisor = createFakePreviewSupervisor();
  const storageRoot = path.join(temporaryRoot, "private-state");
  const service = createProjectWorkService({
    storageRoot,
    sessionFactory,
    picker: async () => ({ rootPath: projectRoot }),
    previewSupervisor,
    idFactory: incrementalId("manual-preview"),
  });
  t.after(() => service.dispose());

  const selection = await service.pickProjectRoot({ mode: "existing" });
  const project = await service.registerProject({
    selectionId: selection.selectionId,
  });
  const conversation = await service.createConversation(project.id);
  await service.sendMessage(conversation.id, {
    text: "准备修改并登记静态预览",
  });
  const pending = await eventually(
    () => service.getConversation(conversation.id),
    (snapshot) => (
      snapshot.conversation.status === "awaiting_confirmation"
      && snapshot.conversation.preview?.status === "requested"
    ),
    "manual preview was not persisted for confirmation",
  );

  assert.equal(previewSupervisor.starts.length, 0);
  assert.ok(sessionFactory.sessions[0].activeToolCalls.some(
    (names) => names.includes("request_preview"),
  ));
  assert.equal(pending.conversation.preview.executionPolicyMode, "manual_review");
  assert.equal(pending.conversation.preview.confirmationRequired, true);
  assert.match(pending.conversation.preview.requestHash, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(pending.conversation.preview.recipe, {
    runtime: "static",
    cwd: ".",
    app: null,
    route: "/",
    command: {
      executable: "pi-agent-bundled-static-server",
      argv: [
        "--host",
        "127.0.0.1",
        "--port",
        "<assigned-loopback-port>",
      ],
    },
  });

  await service.dispose();
  const restoredService = createProjectWorkService({
    storageRoot,
    sessionFactory: createFakeSessionFactory({ verificationRequest: null }),
    previewSupervisor,
    idFactory: incrementalId("manual-preview-restored"),
  });
  t.after(() => restoredService.dispose());
  const restored = await restoredService.getConversation(conversation.id);
  assert.equal(restored.conversation.preview.status, "requested");
  assert.equal(
    restored.conversation.preview.requestHash,
    pending.conversation.preview.requestHash,
  );

  await assert.rejects(
    restoredService.startPreview(conversation.id, {
      previewId: pending.conversation.preview.id,
      requestHash: `sha256:${"f".repeat(64)}`,
    }),
    (error) => {
      assert.equal(error.code, "PROJECT_WORK_PREVIEW_STALE");
      assert.equal(error.status, 409);
      return true;
    },
  );
  assert.equal(previewSupervisor.starts.length, 0);

  const started = await restoredService.startPreview(conversation.id, {
    previewId: pending.conversation.preview.id,
    requestHash: pending.conversation.preview.requestHash,
  });
  assert.equal(previewSupervisor.starts.length, 1);
  assert.equal(previewSupervisor.starts[0].request.runtime, "static");
  assert.equal(previewSupervisor.starts[0].request.app, null);
  assert.equal(previewSupervisor.starts[0].request.status, "starting");
  assert.equal(started.conversation.preview.status, "ready");
  assert.equal(started.conversation.preview.confirmationRequired, false);
  assert.ok(started.conversation.preview.confirmedAt);
  assert.equal(started.conversation.preview.url, "http://127.0.0.1:48080/");
  assert.ok(started.events.some((event) => (
    event.type === "preview.confirmed"
    && event.data.requestHash === pending.conversation.preview.requestHash
  )));

  await assert.rejects(
    restoredService.startPreview(conversation.id, {
      previewId: pending.conversation.preview.id,
      requestHash: pending.conversation.preview.requestHash,
    }),
    (error) => {
      assert.equal(error.code, "PROJECT_WORK_PREVIEW_NOT_FOUND");
      return true;
    },
  );
});

test("auto review blocks a preview when the same turn's changes are denied", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-blocked-preview-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  await mkdir(projectRoot);
  await writeFile(path.join(projectRoot, "app.js"), "original\n", "utf8");
  const previewSupervisor = createFakePreviewSupervisor();
  const service = createProjectWorkService({
    storageRoot: path.join(temporaryRoot, "private-state"),
    sessionFactory: createFakeSessionFactory({
      changedContent: `${"changed\n".repeat(5_001)}`,
      verificationRequest: null,
      previewRequest: {
        runtime: "python_uvicorn",
        cwd: "backend",
        app: "app.main:app",
        route: "/reader/",
      },
    }),
    picker: async () => ({ rootPath: projectRoot }),
    previewSupervisor,
    idFactory: incrementalId("blocked-preview"),
  });
  t.after(() => service.dispose());

  const selection = await service.pickProjectRoot({ mode: "existing" });
  const project = await service.registerProject({
    selectionId: selection.selectionId,
  });
  const conversation = await service.createConversation(project.id);
  await enableRecoverableWorkspaceForTest(
    path.join(temporaryRoot, "private-state"),
    conversation.id,
  );
  await service.configureExecutionPolicy(conversation.id, {
    mode: "auto_review",
    expectedRevision: 1,
  });
  await service.sendMessage(conversation.id, {
    text: "修改后打开预览",
  });
  const settled = await eventually(
    () => service.getConversation(conversation.id),
    (snapshot) => (
      snapshot.conversation.status === "idle"
      && snapshot.conversation.preview?.status === "blocked"
    ),
    "preview did not remain blocked after an unsafe change",
  );

  assert.equal(previewSupervisor.starts.length, 0);
  assert.equal(
    settled.conversation.preview.error.code,
    "PROJECT_WORK_PREVIEW_BLOCKED",
  );
  assert.ok(settled.events.some((event) => (
    event.type === "auto_review.decision"
    && event.data.actionType === "preview"
    && event.data.reasonCode === "change_set_not_auto_applied"
  )));
});

test("auto review makes an out-of-policy change inspectable but permanently non-actionable", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-auto-review-blocked-change-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  await mkdir(projectRoot);
  await writeFile(path.join(projectRoot, "app.js"), "original\n", "utf8");
  const service = createProjectWorkService({
    storageRoot: path.join(temporaryRoot, "private-state"),
    sessionFactory: createFakeSessionFactory({
      changedContent: `${"changed\n".repeat(5_001)}`,
      verificationRequest: null,
    }),
    picker: async () => ({ rootPath: projectRoot }),
    idFactory: incrementalId("auto-review-blocked-change"),
  });
  t.after(() => service.dispose());

  const selection = await service.pickProjectRoot({ mode: "existing" });
  const project = await service.registerProject({
    selectionId: selection.selectionId,
  });
  const conversation = await service.createConversation(project.id);
  await enableRecoverableWorkspaceForTest(
    path.join(temporaryRoot, "private-state"),
    conversation.id,
  );
  await service.configureExecutionPolicy(conversation.id, {
    mode: "auto_review",
    expectedRevision: 1,
  });
  await service.sendMessage(conversation.id, { text: "准备超大修改" });
  const settled = await eventually(
    () => service.getConversation(conversation.id),
    (snapshot) => (
      snapshot.conversation.status === "idle"
      && snapshot.conversation.activeChangeSet?.status === "blocked"
    ),
    "out-of-policy change was not blocked",
  );

  const blocked = settled.conversation.activeChangeSet;
  assert.equal(blocked.blockedReason, "change_set_line_limit");
  assert.equal(blocked.overlayCleared, true);
  assert.equal(blocked.files.every((file) => file.actionable === false), true);
  assert.equal(await readFile(path.join(projectRoot, "app.js"), "utf8"), "original\n");
  await assert.rejects(
    service.applyChangeSet(conversation.id, {
      changeSetId: blocked.id,
      changeSetHash: blocked.hash,
      files: blocked.files.map((file) => ({
        fileId: file.id,
        baseHash: file.baseHash,
        afterHash: file.afterHash,
      })),
    }),
    (error) => {
      assert.equal(error.code, "PROJECT_WORK_CHANGE_SET_BLOCKED");
      return true;
    },
  );
});

test("auto review denies an unsafe verification without starting the runner", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-auto-review-deny-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  await mkdir(projectRoot);
  await Promise.all([
    writeFile(path.join(projectRoot, "app.js"), "export const version = 1;\n"),
    writeFile(path.join(projectRoot, "package.json"), JSON.stringify({
      scripts: { dev: "vite --host 127.0.0.1" },
    })),
  ]);
  let runnerCalls = 0;
  const service = createProjectWorkService({
    storageRoot: path.join(temporaryRoot, "private-state"),
    sessionFactory: createFakeSessionFactory({
      verificationRequest: {
        file: "npm",
        args: ["run", "dev"],
        checks: ["启动长期服务"],
      },
    }),
    picker: async () => ({ rootPath: projectRoot }),
    runner: async () => {
      runnerCalls += 1;
      throw new Error("unsafe verification must not run");
    },
    idFactory: incrementalId("auto-review-deny"),
  });
  t.after(() => service.dispose());

  const selection = await service.pickProjectRoot({ mode: "existing" });
  const project = await service.registerProject({
    selectionId: selection.selectionId,
  });
  const conversation = await service.createConversation(project.id);
  await enableRecoverableWorkspaceForTest(
    path.join(temporaryRoot, "private-state"),
    conversation.id,
  );
  await service.configureExecutionPolicy(conversation.id, {
    mode: "auto_review",
    expectedRevision: 1,
  });
  await service.sendMessage(conversation.id, {
    text: "修改后启动开发服务",
  });
  const settled = await eventually(
    () => service.getConversation(conversation.id),
    (snapshot) => (
      snapshot.conversation.status === "applied"
      && snapshot.conversation.verifications.some(
        (verification) => verification.status === "blocked",
      )
    ),
    "unsafe auto verification was not blocked",
  );

  assert.equal(runnerCalls, 0);
  const blocked = settled.conversation.verifications.find(
    (verification) => verification.status === "blocked",
  );
  assert.equal(blocked.blockedReason, "verification_command_not_auto_safe");
  assert.ok(settled.events.some((event) => (
    event.type === "auto_review.decision"
    && event.data.actionType === "verification"
    && event.data.decision === "deny"
  )));
});

test("partial apply keeps unselected files reviewable and verifies the pending overlay privately", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-project-partial-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  await mkdir(projectRoot);
  await writeFile(path.join(projectRoot, "app.js"), "app v1\n", "utf8");
  await writeFile(path.join(projectRoot, "other.js"), "other v1\n", "utf8");

  const verificationObserved = [];
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
    runner: async (command) => {
      verificationObserved.push(
        await readFile(path.join(command.cwd, "other.js"), "utf8"),
      );
      return {
        exitCode: 0,
        durationMs: 3,
        stdout: "overlay verified",
        stderr: "",
        truncated: false,
        timedOut: false,
        aborted: false,
      };
    },
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
  const verified = await service.runVerification(conversation.id, {
    requestId: verification.id,
  });
  assert.equal(verified.status, "passed");
  assert.deepEqual(verificationObserved, ["other v2\n"]);
  assert.equal(
    await readFile(path.join(projectRoot, "other.js"), "utf8"),
    "other v1\n",
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
    attachments: [{
      fileName: "验收说明.md",
      mimeType: "text/markdown",
      text: "# 重点\n检查按钮遮挡。",
    }],
  });
  const settled = await eventually(
    () => service.getConversation(conversation.id),
    (snapshot) => (
      snapshot.conversation.status !== "running"
      && snapshot.conversation.messages.some(
        (message) => message.role === "assistant",
      )
      && sessions[0]?.activeToolCalls.at(-1)?.includes("edit")
    ),
    "image turn did not settle",
  );

  assert.equal(sessions.length, 1);
  assert.match(
    sessions[0].prompts[0].prompt,
    /^检查这张设置页截图[\s\S]*验收说明\.md[\s\S]*检查按钮遮挡/,
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
  assert.equal(userMessage.attachments.length, 1);
  assert.equal(userMessage.attachments[0].fileName, "验收说明.md");
  assert.equal(userMessage.attachments[0].mimeType, "text/markdown");
  assert.match(userMessage.attachments[0].contentHash, /^sha256:[a-f0-9]{64}$/);
  assert.doesNotMatch(
    JSON.stringify(settled.conversation),
    /检查按钮遮挡/,
  );
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
