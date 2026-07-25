export const DEEPSEEK_PROVIDER_ID = "deepseek";
export const DEEPSEEK_MODELS = Object.freeze(["deepseek-v4-pro", "deepseek-v4-flash"]);

const DEEPSEEK_CHAT_COMPLETIONS_URL = "https://api.deepseek.com/chat/completions";
const DEFAULT_TIMEOUT_MS = 45_000;

export class DeepSeekProviderError extends Error {
  constructor(code, message, { status = 502, retryable = false, upstream = {} } = {}) {
    super(message);
    this.name = "DeepSeekProviderError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.upstream = {
      provider: DEEPSEEK_PROVIDER_ID,
      status: upstream.status ?? null,
      requestId: upstream.requestId ?? null,
      finishReason: upstream.finishReason ?? null,
    };
  }
}

function upstreamFor(response, finishReason = null) {
  return {
    status: response?.status ?? null,
    requestId: response?.headers?.get?.("x-request-id") || null,
    finishReason,
  };
}

function lifecycleError(finishReason, response) {
  const upstream = upstreamFor(response, finishReason);
  if (finishReason === "length") {
    return new DeepSeekProviderError("MODEL_INCOMPLETE", "DeepSeek 输出达到长度限制", {
      retryable: false,
      upstream,
    });
  }
  if (finishReason === "insufficient_system_resource") {
    return new DeepSeekProviderError("MODEL_UPSTREAM_BUSY", "DeepSeek 推理资源不足", {
      retryable: true,
      upstream,
    });
  }
  if (finishReason === "content_filter") {
    return new DeepSeekProviderError("MODEL_CONTENT_FILTERED", "DeepSeek 输出被内容策略过滤", {
      retryable: false,
      upstream,
    });
  }
  return new DeepSeekProviderError("MODEL_OUTPUT_INVALID", "DeepSeek 未正常完成输出", {
    retryable: false,
    upstream,
  });
}

function httpError(response) {
  const upstream = upstreamFor(response);
  const retryable = response.status === 429 || response.status === 500 || response.status === 503;
  const code = {
    400: "MODEL_UPSTREAM_BAD_REQUEST",
    401: "MODEL_UPSTREAM_AUTH_FAILED",
    402: "MODEL_UPSTREAM_BALANCE_EXHAUSTED",
    422: "MODEL_UPSTREAM_BAD_REQUEST",
    429: "MODEL_RATE_LIMITED",
    500: "MODEL_UPSTREAM_ERROR",
    503: "MODEL_UPSTREAM_BUSY",
  }[response.status] || "MODEL_UPSTREAM_ERROR";

  return new DeepSeekProviderError(code, `DeepSeek 返回 HTTP ${response.status}`, {
    retryable,
    upstream,
  });
}

function normalizeUsage(usage) {
  return {
    input_tokens: usage?.prompt_tokens ?? 0,
    cached_input_tokens: usage?.prompt_cache_hit_tokens ?? 0,
    output_tokens: usage?.completion_tokens ?? 0,
    total_tokens: usage?.total_tokens ?? 0,
  };
}

export async function runDeepSeek({
  messages,
  modelId,
  apiKey,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (!DEEPSEEK_MODELS.includes(modelId)) {
    throw new DeepSeekProviderError("MODEL_NOT_ALLOWED", "不支持的 DeepSeek 模型", {
      status: 400,
    });
  }
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    throw new DeepSeekProviderError("MODEL_NOT_CONFIGURED", "DeepSeek API Key 尚未配置", {
      status: 503,
    });
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new DeepSeekProviderError("INVALID_REQUEST", "messages 必须是非空数组", {
      status: 400,
    });
  }

  const controller = new AbortController();
  const resolvedTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), resolvedTimeoutMs);
  let response;
  try {
    response = await fetchImpl(DEEPSEEK_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: modelId,
        messages,
        thinking: { type: "disabled" },
        response_format: { type: "json_object" },
        max_tokens: 2200,
        stream: false,
      }),
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new DeepSeekProviderError("MODEL_TIMEOUT", "DeepSeek 调用超时", {
        status: 504,
        retryable: true,
      });
    }
    throw new DeepSeekProviderError("MODEL_UPSTREAM_ERROR", "无法连接 DeepSeek", {
      retryable: true,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) throw httpError(response);

  let body;
  try {
    body = await response.json();
  } catch {
    throw new DeepSeekProviderError("MODEL_OUTPUT_INVALID", "DeepSeek 返回了无效 JSON", {
      retryable: true,
      upstream: upstreamFor(response),
    });
  }

  const choice = body?.choices?.[0];
  if (choice?.finish_reason !== "stop") {
    throw lifecycleError(choice?.finish_reason ?? "missing", response);
  }

  const text = typeof choice?.message?.content === "string"
    ? choice.message.content.trim()
    : "";
  if (!text) {
    throw new DeepSeekProviderError("MODEL_EMPTY_OUTPUT", "DeepSeek 没有返回可用内容", {
      retryable: true,
      upstream: upstreamFor(response, "stop"),
    });
  }

  if (typeof body.id !== "string" || body.id.length === 0) {
    throw new DeepSeekProviderError("MODEL_OUTPUT_INVALID", "DeepSeek 响应缺少操作 ID", {
      retryable: true,
      upstream: upstreamFor(response, "stop"),
    });
  }

  return {
    text,
    operationId: body.id,
    usage: normalizeUsage(body.usage),
    upstreamRequestId: response.headers?.get?.("x-request-id") || null,
  };
}
