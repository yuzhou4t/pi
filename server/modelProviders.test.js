import assert from "node:assert/strict";
import test from "node:test";
import { createModelProviderRegistry, ModelProviderRegistryError } from "./modelProviders.js";

const schema = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
};

test("Pi-style provider registry routes a bounded structured task to DeepSeek", async () => {
  let received;
  const registry = createModelProviderRegistry({
    env: {
      PI_DEEPSEEK_API_KEY: "server-secret",
      PI_DEEPSEEK_TIMEOUT_MS: "1200",
    },
    deepseekRunner: async (request) => {
      received = request;
      return {
        text: JSON.stringify({ answer: "ok" }),
        operationId: "deepseek-operation",
        upstreamRequestId: "upstream-1",
        usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
      };
    },
  });
  const result = await registry.completeStructured({
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
    system: "Short system.",
    prompt: "One bounded task.",
    input: { paper_id: "paper-1" },
    schema,
  });
  assert.equal(result.value.answer, "ok");
  assert.equal(received.messages.length, 2);
  assert.match(received.messages[0].content, /严格匹配以下 JSON Schema/);
  assert.match(received.messages[0].content, /"required":\["answer"\]/);
  assert.match(received.messages[0].content, /"additionalProperties":false/);
  assert.match(received.messages[1].content, /输入 JSON/);
  assert.match(received.messages[1].content, /"paper_id":"paper-1"/);
  assert.equal(received.apiKey, "server-secret");
  assert.equal(received.timeoutMs, 1200);
});

test("Pi-style provider registry keeps the existing Codex subscription adapter", async () => {
  let received;
  const registry = createModelProviderRegistry({
    env: { PI_CODEX_TIMEOUT_MS: "2400" },
    codexRunner: async (request) => {
      received = request;
      return {
        text: JSON.stringify({ answer: "ok" }),
        operationId: "codex-operation",
        usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
      };
    },
  });
  const result = await registry.completeStructured({
    providerId: "codex-subscription",
    modelId: "account-default",
    system: "Short system.",
    prompt: "One bounded task.",
    input: { paper_id: "paper-1" },
    schema,
  });
  assert.equal(result.value.answer, "ok");
  assert.equal(received.timeoutMs, 2400);
  assert.match(received.prompt, /One bounded task/);
  assert.deepEqual(received.schema, schema);
});

test("unknown providers and malformed JSON outputs are rejected", async () => {
  const registry = createModelProviderRegistry({
    deepseekRunner: async () => ({
      text: "not json",
      operationId: "operation",
      usage: {},
    }),
  });
  await assert.rejects(registry.completeStructured({
    providerId: "unknown",
    modelId: "unknown",
    system: "system",
    prompt: "prompt",
    input: {},
    schema,
  }), (error) => error instanceof ModelProviderRegistryError && error.code === "MODEL_NOT_ALLOWED");
  await assert.rejects(registry.completeStructured({
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
    system: "system",
    prompt: "prompt",
    input: {},
    schema,
  }), (error) => error instanceof ModelProviderRegistryError && error.code === "MODEL_OUTPUT_INVALID");
});
