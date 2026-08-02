import assert from "node:assert/strict";
import test from "node:test";
import {
  DEEPSEEK_MODELS,
  DeepSeekProviderError,
  runDeepSeek,
} from "./deepseek.js";

const messages = [
  { role: "system", content: "只返回 JSON。" },
  { role: "user", content: "总结论文。" },
];

function completionResponse(overrides = {}, responseInit = {}) {
  return new Response(JSON.stringify({
    id: "chatcmpl-deepseek-test",
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: '{"items":[]}' },
    }],
    usage: {
      prompt_tokens: 120,
      prompt_cache_hit_tokens: 20,
      prompt_cache_miss_tokens: 100,
      completion_tokens: 35,
      total_tokens: 155,
    },
    ...overrides,
  }), {
    status: 200,
    headers: { "content-type": "application/json", "x-request-id": "deepseek-request-test" },
    ...responseInit,
  });
}

test("sends the fixed non-thinking JSON request and normalizes usage", async () => {
  const result = await runDeepSeek({
    messages,
    modelId: "deepseek-v4-pro",
    apiKey: "server-only-key",
    fetchImpl: async (url, init) => {
      assert.equal(url, "https://api.deepseek.com/chat/completions");
      assert.equal(init.method, "POST");
      assert.equal(init.headers.authorization, "Bearer server-only-key");
      assert.equal(init.headers["content-type"], "application/json");
      assert.ok(init.signal instanceof AbortSignal);
      assert.deepEqual(JSON.parse(init.body), {
        model: "deepseek-v4-pro",
        messages,
        thinking: { type: "disabled" },
        response_format: { type: "json_object" },
        max_tokens: 2200,
        stream: false,
      });
      return completionResponse();
    },
  });

  assert.deepEqual(result, {
    text: '{"items":[]}',
    operationId: "chatcmpl-deepseek-test",
    usage: {
      input_tokens: 120,
      cached_input_tokens: 20,
      output_tokens: 35,
      total_tokens: 155,
    },
    upstreamRequestId: "deepseek-request-test",
  });
});

test("accepts each allowlisted DeepSeek model", async () => {
  for (const modelId of DEEPSEEK_MODELS) {
    const result = await runDeepSeek({
      messages,
      modelId,
      apiKey: "test-key",
      fetchImpl: async () => completionResponse(),
    });
    assert.equal(result.operationId, "chatcmpl-deepseek-test");
  }
});

test("rejects an unknown model before making a request", async () => {
  let fetchCount = 0;
  await assert.rejects(
    runDeepSeek({
      messages,
      modelId: "deepseek-chat",
      apiKey: "test-key",
      fetchImpl: async () => {
        fetchCount += 1;
        return completionResponse();
      },
    }),
    (error) => error instanceof DeepSeekProviderError
      && error.code === "MODEL_NOT_ALLOWED"
      && error.status === 400
      && error.retryable === false
      && error.upstream.provider === "deepseek",
  );
  assert.equal(fetchCount, 0);
});

for (const [finishReason, code, retryable] of [
  ["length", "MODEL_INCOMPLETE", false],
  ["insufficient_system_resource", "MODEL_UPSTREAM_BUSY", true],
  ["content_filter", "MODEL_CONTENT_FILTERED", false],
  ["tool_calls", "MODEL_OUTPUT_INVALID", false],
]) {
  test(`classifies ${finishReason} lifecycle failures`, async () => {
    await assert.rejects(
      runDeepSeek({
        messages,
        modelId: "deepseek-v4-flash",
        apiKey: "test-key",
        fetchImpl: async () => completionResponse({
          choices: [{ finish_reason: finishReason, message: { content: "partial" } }],
        }),
      }),
      (error) => error instanceof DeepSeekProviderError
        && error.code === code
        && error.status === 502
        && error.retryable === retryable
        && error.upstream.finishReason === finishReason
        && error.upstream.requestId === "deepseek-request-test",
    );
  });
}

test("rejects empty content after a stop as a retryable invalid result", async () => {
  await assert.rejects(
    runDeepSeek({
      messages,
      modelId: "deepseek-v4-pro",
      apiKey: "test-key",
      fetchImpl: async () => completionResponse({
        choices: [{ finish_reason: "stop", message: { content: "   " } }],
      }),
    }),
    (error) => error instanceof DeepSeekProviderError
      && error.code === "MODEL_EMPTY_OUTPUT"
      && error.retryable === true
      && error.upstream.finishReason === "stop",
  );
});

for (const [status, code, retryable] of [
  [400, "MODEL_UPSTREAM_BAD_REQUEST", false],
  [401, "MODEL_UPSTREAM_AUTH_FAILED", false],
  [402, "MODEL_UPSTREAM_BALANCE_EXHAUSTED", false],
  [422, "MODEL_UPSTREAM_BAD_REQUEST", false],
  [429, "MODEL_RATE_LIMITED", true],
  [500, "MODEL_UPSTREAM_ERROR", true],
  [503, "MODEL_UPSTREAM_BUSY", true],
]) {
  test(`classifies HTTP ${status} without reading its error body`, async () => {
    let bodyRead = false;
    const response = {
      ok: false,
      status,
      headers: { get: (name) => name === "x-request-id" ? `request-${status}` : null },
      json: async () => {
        bodyRead = true;
        throw new Error("error body must not be read");
      },
    };
    await assert.rejects(
      runDeepSeek({
        messages,
        modelId: "deepseek-v4-pro",
        apiKey: "test-key",
        fetchImpl: async () => response,
      }),
      (error) => error instanceof DeepSeekProviderError
        && error.code === code
        && error.retryable === retryable
        && error.upstream.status === status
        && error.upstream.requestId === `request-${status}`,
    );
    assert.equal(bodyRead, false);
  });
}

test("classifies timeouts as retryable", async () => {
  await assert.rejects(
    runDeepSeek({
      messages,
      modelId: "deepseek-v4-pro",
      apiKey: "test-key",
      timeoutMs: 5,
      fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      }),
    }),
    (error) => error instanceof DeepSeekProviderError
      && error.code === "MODEL_TIMEOUT"
      && error.status === 504
      && error.retryable === true,
  );
});
