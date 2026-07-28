import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

const DEEPSEEK_PRICING_SOURCE =
  "https://api-docs.deepseek.com/quick_start/pricing/";
const DEEPSEEK_PRICING_VERSION = "deepseek-v4-usd-2026-07-28";

const DEEPSEEK_RATE_CARDS = Object.freeze({
  "deepseek-v4-flash": Object.freeze({
    input: 0.14,
    output: 0.28,
    cacheRead: 0.0028,
  }),
  "deepseek-v4-pro": Object.freeze({
    input: 0.435,
    output: 0.87,
    cacheRead: 0.003625,
  }),
});

function safeNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}
function compactString(value, maxLength = 240) {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, maxLength)
    : null;
}

export function paperBillingKind(providerId) {
  if (providerId === "codex-subscription") return "chatgpt_subscription";
  if (providerId === "deepseek") return "api";
  return "unknown";
}

export function normalizePaperProviderUsage(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const providerInputTokens = safeNonNegative(
    usage.input_tokens ?? usage.inputTokens,
  );
  const cacheReadTokens = Math.min(
    providerInputTokens,
    safeNonNegative(
      usage.cached_input_tokens
        ?? usage.cache_read_tokens
        ?? usage.cacheReadTokens,
    ),
  );
  const inputTokens = Math.max(0, providerInputTokens - cacheReadTokens);
  const outputTokens = safeNonNegative(
    usage.output_tokens ?? usage.outputTokens,
  );
  const cacheWriteTokens = safeNonNegative(
    usage.cache_write_tokens ?? usage.cacheWriteTokens,
  );
  const providerTotal = Number(usage.total_tokens ?? usage.totalTokens);
  const totalTokens = Number.isFinite(providerTotal) && providerTotal >= 0
    ? providerTotal
    : providerInputTokens + outputTokens;
  return {
    providerInputTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
  };
}

export function paperModelPricing(providerId, modelId) {
  if (providerId !== "deepseek") return null;
  const rates = DEEPSEEK_RATE_CARDS[modelId];
  if (!rates) return null;
  return {
    currency: "USD",
    unit: "per_million_tokens",
    source: "deepseek_official",
    sourceUrl: DEEPSEEK_PRICING_SOURCE,
    version: DEEPSEEK_PRICING_VERSION,
    verifiedAt: "2026-07-28",
    input: rates.input,
    output: rates.output,
    cacheRead: rates.cacheRead,
    cacheWrite: null,
    tiers: [],
  };
}

export function pricePaperUsage({
  providerId,
  modelId,
  usage,
  costSource = "captured_rate_card",
} = {}) {
  const normalized = normalizePaperProviderUsage(usage);
  const pricing = paperModelPricing(providerId, modelId);
  if (!normalized || !pricing) {
    return {
      billingKind: paperBillingKind(providerId),
      costUsd: null,
      costSource: "unpriced",
      pricing: null,
      normalized,
    };
  }
  const costUsd = (
    normalized.inputTokens * pricing.input
    + normalized.cacheReadTokens * pricing.cacheRead
    + normalized.outputTokens * pricing.output
  ) / 1_000_000;
  return {
    billingKind: paperBillingKind(providerId),
    costUsd,
    costSource,
    pricing,
    normalized,
  };
}

export function buildPaperUsageReceipt({
  providerId,
  modelId,
  operationId,
  upstreamRequestId = null,
  usage,
  occurredAt = new Date().toISOString(),
  step = "paper_model_call",
  runId = null,
  paperId = null,
  inputHash = null,
  origin = "live",
} = {}) {
  const normalizedProviderId = compactString(providerId, 120);
  const normalizedModelId = compactString(modelId, 200);
  const normalizedOperationId = compactString(operationId, 240);
  const normalized = normalizePaperProviderUsage(usage);
  if (
    !normalizedProviderId
    || !normalizedModelId
    || !normalizedOperationId
    || !normalized
  ) {
    return null;
  }
  const pricing = pricePaperUsage({
    providerId: normalizedProviderId,
    modelId: normalizedModelId,
    usage,
  });
  const usageEvidence = {
    input_tokens: normalized.providerInputTokens,
    cached_input_tokens: normalized.cacheReadTokens,
    output_tokens: normalized.outputTokens,
    total_tokens: normalized.totalTokens,
    billing: {
      kind: pricing.billingKind,
      cost_semantics: "api_equivalent_estimate",
      api_equivalent_cost_usd: pricing.costUsd,
      cost_source: pricing.costSource,
      pricing_snapshot: pricing.pricing,
    },
  };
  return {
    schema_version: 1,
    workflow_scope: "paper_reading",
    occurred_at: new Date(occurredAt).toISOString(),
    step: compactString(step, 100) ?? "paper_model_call",
    origin: compactString(origin, 80) ?? "live",
    run_id: compactString(runId, 180),
    paper_id: compactString(paperId, 180),
    provider_id: normalizedProviderId,
    model_id: normalizedModelId,
    operation_id: normalizedOperationId,
    upstream_request_id: compactString(upstreamRequestId, 240),
    input_hash: compactString(inputHash, 180),
    usage: usageEvidence,
  };
}

export function createModelUsageLedger({
  dataDir,
  now = () => new Date(),
  appendFileImpl = appendFile,
} = {}) {
  if (typeof dataDir !== "string" || !dataDir.trim()) {
    throw new TypeError("dataDir is required");
  }
  const auditDir = path.resolve(dataDir, "audit");
  const ledgerPath = path.join(auditDir, "model-usage.jsonl");

  async function capture(input) {
    const receipt = buildPaperUsageReceipt({
      ...input,
      occurredAt: input?.occurredAt ?? now().toISOString(),
    });
    if (!receipt) return input?.usage ?? null;
    try {
      await mkdir(auditDir, { recursive: true });
      await appendFileImpl(
        ledgerPath,
        `${JSON.stringify(receipt)}\n`,
        "utf8",
      );
      return receipt.usage;
    } catch (error) {
      console.warn(
        `Pi Agent model usage ledger write failed (${error?.code || "unknown"})`,
      );
      return {
        ...receipt.usage,
        billing: {
          ...receipt.usage.billing,
          ledger_write_failed: true,
        },
      };
    }
  }

  return Object.freeze({
    capture,
    path: ledgerPath,
  });
}
