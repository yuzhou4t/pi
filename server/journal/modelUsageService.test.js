import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  aggregatePaperUsage,
  collectPaperUsageRecords,
  combineModelUsageReports,
} from "./modelUsageService.js";

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value), "utf8");
}

function artifact({
  operationId,
  providerId = "deepseek",
  modelId = "deepseek-v4-pro",
  generatedAt = "2026-07-27T10:00:00.000Z",
  total = 120,
} = {}) {
  return {
    schema_version: 1,
    run_id: "run-1",
    paper_id: "paper-1",
    provenance: {
      source: "model",
      provider_id: providerId,
      model_id: modelId,
      operation_id: operationId,
      usage: {
        input_tokens: total - 20,
        cached_input_tokens: 40,
        output_tokens: 20,
        total_tokens: total,
      },
    },
    generated_at: generatedAt,
  };
}

test("historical scan recovers real model artifacts and deduplicates projections", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-paper-usage-"));
  const runDir = path.join(dataDir, "runs", "run-1");
  await writeJson(path.join(runDir, "run.json"), {
    run_id: "run-1",
    readings: { papers: {} },
  });
  await writeJson(
    path.join(runDir, "guides", "paper-1.json"),
    artifact({ operationId: "operation-guide" }),
  );
  await writeJson(
    path.join(runDir, "readings", "paper-1", "chat", "cache", "hash.json"),
    artifact({ operationId: "operation-chat", total: 150 }),
  );
  await mkdir(path.join(dataDir, "audit"), { recursive: true });
  await writeFile(
    path.join(dataDir, "audit", "model-usage.jsonl"),
    `${JSON.stringify({
      schema_version: 1,
      occurred_at: "2026-07-27T10:00:00.000Z",
      step: "paper_model_call",
      provider_id: "deepseek",
      model_id: "deepseek-v4-pro",
      operation_id: "operation-chat",
      usage: artifact({ operationId: "ignored", total: 150 }).provenance.usage,
    })}\n`,
    "utf8",
  );
  const collected = await collectPaperUsageRecords({ dataDir });
  assert.equal(collected.records.length, 2);
  assert.equal(
    collected.records.find((item) => item.operationId === "operation-chat").step,
    "paper_agent",
  );
  assert.equal(collected.coverage.duplicateEvidence, 1);
});

test("historical scan ignores null JSON artifacts without reporting invalid usage evidence", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-paper-null-artifact-"));
  const runDir = path.join(dataDir, "runs", "run-1");
  await writeJson(path.join(runDir, "run.json"), {
    run_id: "run-1",
    readings: { papers: {} },
  });
  await writeJson(path.join(runDir, "guides", "empty.json"), null);
  await writeJson(
    path.join(runDir, "readings", "paper-1", "chat", "cache", "empty.json"),
    null,
  );

  const collected = await collectPaperUsageRecords({ dataDir });
  assert.equal(collected.records.length, 0);
  assert.equal(collected.coverage.invalidEvidence, 0);
});

test("ledger keeps a subscription call unpriced when its captured cost is null", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-paper-unpriced-"));
  await mkdir(path.join(dataDir, "audit"), { recursive: true });
  await writeFile(
    path.join(dataDir, "audit", "model-usage.jsonl"),
    `${JSON.stringify({
      schema_version: 1,
      occurred_at: "2026-07-27T10:00:00.000Z",
      provider_id: "codex-subscription",
      model_id: "account-default",
      operation_id: "operation-subscription",
      usage: {
        input_tokens: 100,
        cached_input_tokens: 10,
        output_tokens: 5,
        total_tokens: 105,
        billing: {
          kind: "chatgpt_subscription",
          api_equivalent_cost_usd: null,
          cost_source: "unpriced",
          pricing_snapshot: null,
        },
      },
    })}\n`,
    "utf8",
  );

  const collected = await collectPaperUsageRecords({ dataDir });
  const report = aggregatePaperUsage({
    ...collected,
    period: "all",
    now: new Date("2026-07-28T10:00:00.000Z"),
  });
  assert.equal(report.totals.apiEquivalentCostUsd, null);
  assert.equal(report.totals.pricedCallCount, 0);
  assert.equal(report.totals.unpricedCallCount, 1);
});

test("candidate audit includes real historical smoke usage and excludes fixtures", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-paper-audit-"));
  await mkdir(path.join(dataDir, "audit"), { recursive: true });
  await writeFile(
    path.join(dataDir, "audit", "model-calls.jsonl"),
    [
      {
        ts: "2026-07-22T10:00:00.000Z",
        status: "ok",
        source: "model",
        step: "candidate_summaries",
        run_id: "run-smoke",
        provider_id: "codex-subscription",
        model_id: "account-default",
        operation_id: "operation-smoke",
        usage: {
          input_tokens: 100,
          cached_input_tokens: 10,
          output_tokens: 5,
          total_tokens: 105,
        },
      },
      {
        ts: "2026-07-22T10:01:00.000Z",
        status: "ok",
        source: "fixture",
        operation_id: "fixture",
        usage: { total_tokens: 999 },
      },
    ].map(JSON.stringify).join("\n"),
    "utf8",
  );
  const collected = await collectPaperUsageRecords({ dataDir });
  assert.equal(collected.records.length, 1);
  assert.equal(collected.records[0].origin, "historical_test");
  assert.equal(collected.coverage.fixtureRecordsIgnored, 1);
  const report = aggregatePaperUsage({
    ...collected,
    period: "all",
    now: new Date("2026-07-28T10:00:00.000Z"),
  });
  assert.equal(report.coverage.historicalTestCallCount, 1);
});

test("paper aggregation separates cache input and labels historical cost backfill", () => {
  const report = aggregatePaperUsage({
    records: [{
      identity: "deepseek:operation-1",
      workflowScope: "paper_reading",
      providerId: "deepseek",
      providerName: "DeepSeek API",
      modelId: "deepseek-v4-pro",
      modelName: "DeepSeek V4 Pro",
      operationId: "operation-1",
      occurredAt: "2026-07-27T10:00:00.000Z",
      step: "paper_agent",
      runId: "run-1",
      paperId: "paper-1",
      origin: "historical_artifact",
      evidenceSource: "historical_artifact",
      billingKind: "api",
      costUsd: 0.01,
      costSource: "current_rate_backfill",
      pricing: null,
      providerInputTokens: 100,
      inputTokens: 60,
      outputTokens: 20,
      cacheReadTokens: 40,
      cacheWriteTokens: 0,
      totalTokens: 120,
    }],
    coverage: { legacyTranslationArtifactsWithoutUsage: 2 },
    period: "all",
    now: new Date("2026-07-28T10:00:00.000Z"),
  });
  assert.equal(report.totals.totalTokens, 120);
  assert.equal(report.totals.inputTokens, 60);
  assert.equal(report.totals.cacheReadTokens, 40);
  assert.equal(report.totals.historicalBackfilledCallCount, 1);
  assert.equal(report.coverage.historicalLowerBound, true);
  assert.deepEqual(report.models[0].stepBreakdown, [{
    step: "paper_agent",
    calls: 1,
  }]);
});

test("combined report keeps workflow rows and partial coverage explicit", () => {
  const report = combineModelUsageReports({
    period: "30d",
    workflow: "all",
    reports: [{
      workflowScope: "project_work",
      periodStart: "2026-06-28T00:00:00.000Z",
      periodEnd: "2026-07-28T00:00:00.000Z",
      totals: {
        calls: 1,
        tasks: 1,
        conversations: 1,
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 15,
        apiEquivalentCostUsd: 0.1,
        pricedCallCount: 1,
        unpricedCallCount: 0,
      },
      coverage: {
        includedKinds: ["assistant_model_response"],
        historicalTestCallCount: 4,
      },
      models: [{
        providerId: "openai-codex",
        modelId: "gpt",
        totalTokens: 15,
      }],
    }],
    accessIssues: [{ workflowScope: "paper_reading", code: "UNAVAILABLE" }],
  });
  assert.equal(report.status, "partial");
  assert.equal(report.totals.totalTokens, 15);
  assert.equal(report.models[0].workflowScope, "project_work");
  assert.equal(report.coverage.accessIssues.length, 1);
  assert.equal(report.coverage.historicalTestCallCount, 4);
});
