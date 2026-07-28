import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildPaperUsageReceipt,
  createModelUsageLedger,
  normalizePaperProviderUsage,
  paperModelPricing,
  pricePaperUsage,
} from "./modelUsageLedger.js";

test("paper usage treats cached input as a subset instead of double counting", () => {
  assert.deepEqual(normalizePaperProviderUsage({
    input_tokens: 100,
    cached_input_tokens: 60,
    output_tokens: 20,
    total_tokens: 120,
  }), {
    providerInputTokens: 100,
    inputTokens: 40,
    outputTokens: 20,
    cacheReadTokens: 60,
    cacheWriteTokens: 0,
    totalTokens: 120,
  });
});

test("DeepSeek usage freezes the official rate card and exact estimate", () => {
  const priced = pricePaperUsage({
    providerId: "deepseek",
    modelId: "deepseek-v4-pro",
    usage: {
      input_tokens: 1_000_000,
      cached_input_tokens: 200_000,
      output_tokens: 100_000,
      total_tokens: 1_100_000,
    },
  });
  assert.equal(priced.billingKind, "api");
  assert.ok(Math.abs(priced.costUsd - 0.435725) < 1e-12);
  assert.equal(priced.pricing.source, "deepseek_official");
  assert.equal(priced.pricing.cacheWrite, null);
  assert.match(priced.pricing.sourceUrl, /^https:\/\/api-docs\.deepseek\.com\//);
});

test("Codex subscription keeps tokens but never invents API cost", () => {
  const receipt = buildPaperUsageReceipt({
    providerId: "codex-subscription",
    modelId: "account-default",
    operationId: "operation-1",
    usage: {
      input_tokens: 100,
      cached_input_tokens: 20,
      output_tokens: 5,
      total_tokens: 105,
    },
  });
  assert.equal(receipt.usage.billing.kind, "chatgpt_subscription");
  assert.equal(receipt.usage.billing.api_equivalent_cost_usd, null);
  assert.equal(receipt.usage.billing.cost_source, "unpriced");
  assert.equal(paperModelPricing("codex-subscription", "account-default"), null);
});

test("ledger appends only safe receipt evidence and returns enriched usage", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-usage-ledger-"));
  const ledger = createModelUsageLedger({
    dataDir,
    now: () => new Date("2026-07-28T10:00:00.000Z"),
  });
  const usage = await ledger.capture({
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
    operationId: "operation-2",
    upstreamRequestId: "upstream-2",
    step: "reading_chat",
    runId: "run-1",
    paperId: "paper-1",
    inputHash: "sha256:safe",
    usage: {
      input_tokens: 1_000,
      cached_input_tokens: 200,
      output_tokens: 100,
      total_tokens: 1_100,
    },
  });
  assert.equal(usage.billing.cost_source, "captured_rate_card");
  const raw = await readFile(ledger.path, "utf8");
  const record = JSON.parse(raw.trim());
  assert.equal(record.step, "reading_chat");
  assert.equal(record.operation_id, "operation-2");
  assert.equal(record.usage.total_tokens, 1_100);
  assert.doesNotMatch(raw, /prompt|answer|api[_-]?key/i);
});

test("ledger failures preserve paid usage for the business artifact", async () => {
  const ledger = createModelUsageLedger({
    dataDir: "/tmp/pi-usage-ledger-failure",
    appendFileImpl: async () => {
      const error = new Error("failed");
      error.code = "EIO";
      throw error;
    },
  });
  const usage = await ledger.capture({
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
    operationId: "operation-3",
    usage: {
      input_tokens: 10,
      output_tokens: 2,
      total_tokens: 12,
    },
  });
  assert.equal(usage.total_tokens, 12);
  assert.equal(usage.billing.ledger_write_failed, true);
});
