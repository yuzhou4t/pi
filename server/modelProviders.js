import {
  CODEX_ACCOUNT_MODEL_ID,
  CODEX_PROVIDER_ID,
  CODEX_SPARK_MODEL_ID,
  runCodexSubscription,
} from "./providers/codexSubscription.js";
import {
  DEEPSEEK_MODELS,
  DEEPSEEK_PROVIDER_ID,
  runDeepSeek,
} from "./providers/deepseek.js";

export class ModelProviderRegistryError extends Error {
  constructor(code, message, status = 500, retryable = false) {
    super(message);
    this.name = "ModelProviderRegistryError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function parseStructuredText(text) {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("not an object");
    }
    return value;
  } catch {
    throw new ModelProviderRegistryError(
      "MODEL_OUTPUT_INVALID",
      "模型返回内容不符合结构化输出合同",
      502,
      true,
    );
  }
}

function validateRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new ModelProviderRegistryError("INVALID_REQUEST", "模型任务必须是对象", 400);
  }
  if (typeof request.system !== "string" || !request.system.trim()) {
    throw new ModelProviderRegistryError("INVALID_REQUEST", "system 不能为空", 400);
  }
  if (typeof request.prompt !== "string" || !request.prompt.trim()) {
    throw new ModelProviderRegistryError("INVALID_REQUEST", "prompt 不能为空", 400);
  }
  if (!request.schema || typeof request.schema !== "object" || Array.isArray(request.schema)) {
    throw new ModelProviderRegistryError("INVALID_REQUEST", "schema 必须是对象", 400);
  }
  return request;
}

function structuredOutputContract(schema) {
  return [
    "只返回一个严格匹配以下 JSON Schema 的 JSON 根对象。",
    "不得添加外层包装、解释文字或 schema 未声明的字段。",
    `JSON Schema：${JSON.stringify(schema)}`,
  ].join("\n");
}

export function createModelProviderRegistry({
  env = process.env,
  fetchImpl = globalThis.fetch,
  codexRunner = runCodexSubscription,
  deepseekRunner = runDeepSeek,
  usageRecorder = null,
} = {}) {
  let codexQueue = Promise.resolve();

  function enqueueCodex(task) {
    const pending = codexQueue.then(task, task);
    codexQueue = pending.catch(() => undefined);
    return pending;
  }

  function supports(providerId, modelId) {
    return (
      (
        providerId === CODEX_PROVIDER_ID
        && [CODEX_ACCOUNT_MODEL_ID, CODEX_SPARK_MODEL_ID].includes(modelId)
      )
      || (providerId === DEEPSEEK_PROVIDER_ID && DEEPSEEK_MODELS.includes(modelId))
    );
  }

  async function completeStructured(requestValue) {
    const request = validateRequest(requestValue);
    if (!supports(request.providerId, request.modelId)) {
      throw new ModelProviderRegistryError(
        "MODEL_NOT_ALLOWED",
        "服务商或模型不在允许列表中",
        400,
      );
    }
    const input = JSON.stringify(request.input);
    const combinedSystem = `${request.system.trim()}\n\n${request.prompt.trim()}`;
    let result;
    if (request.providerId === CODEX_PROVIDER_ID) {
      result = await enqueueCodex(() => codexRunner({
        prompt: `${combinedSystem}\n\n输入 JSON：\n${input}\n\n只返回符合 schema 的 JSON。`,
        schema: request.schema,
        modelId: request.modelId,
        reasoningEffort: request.reasoningEffort ?? null,
        env,
        timeoutMs: Number.parseInt(env.PI_CODEX_TIMEOUT_MS || "90000", 10),
      }));
    } else {
      result = await deepseekRunner({
        messages: [
          {
            role: "system",
            content: `${combinedSystem}\n\n${structuredOutputContract(request.schema)}`,
          },
          { role: "user", content: `输入 JSON：\n${input}` },
        ],
        modelId: request.modelId,
        apiKey: env.PI_DEEPSEEK_API_KEY || "",
        fetchImpl,
        timeoutMs: Number.parseInt(env.PI_DEEPSEEK_TIMEOUT_MS || "45000", 10),
      });
    }
    let usage = result.usage;
    if (
      typeof usageRecorder === "function"
      && result.operationId
      && result.usage
    ) {
      try {
        usage = await usageRecorder({
          providerId: request.providerId,
          modelId: request.modelId,
          operationId: result.operationId,
          upstreamRequestId: result.upstreamRequestId ?? null,
          usage: result.usage,
        });
      } catch (error) {
        console.warn(
          `Pi Agent model usage capture failed (${error?.code || "unknown"})`,
        );
      }
    }
    return {
      value: parseStructuredText(result.text),
      provider_id: request.providerId,
      model_id: request.modelId,
      reasoning_effort: request.reasoningEffort ?? null,
      operation_id: result.operationId,
      upstream_request_id: result.upstreamRequestId ?? null,
      usage,
    };
  }

  return Object.freeze({ completeStructured, supports });
}
