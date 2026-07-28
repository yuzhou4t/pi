import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  normalizePaperProviderUsage,
  paperBillingKind,
  paperModelPricing,
  pricePaperUsage,
} from "../modelUsageLedger.js";

const USAGE_PERIODS = new Set(["today", "7d", "30d", "all"]);
const RUN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/;
const MAX_JSON_BYTES = 5 * 1024 * 1024;
const MODEL_NAMES = Object.freeze({
  "account-default": "账户默认模型",
  "gpt-5.3-codex-spark": "GPT-5.3 Codex Spark",
  "deepseek-v4-pro": "DeepSeek V4 Pro",
  "deepseek-v4-flash": "DeepSeek V4 Flash",
});

function usageError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.retryable = false;
  return error;
}

function safeText(value, maxLength = 240) {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, maxLength)
    : null;
}

function safeDate(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function providerName(providerId) {
  if (providerId === "codex-subscription") return "GPT · Codex 订阅";
  if (providerId === "deepseek") return "DeepSeek API";
  return providerId;
}

function modelName(modelId) {
  return MODEL_NAMES[modelId] ?? modelId;
}

function periodStart(period, now) {
  if (period === "all") return null;
  const start = new Date(now);
  if (period === "today") {
    start.setHours(0, 0, 0, 0);
    return start;
  }
  start.setDate(start.getDate() - (period === "7d" ? 7 : 30));
  return start;
}

async function readText(filePath, maxBytes = MAX_JSON_BYTES) {
  try {
    const contents = await readFile(filePath, "utf8");
    return Buffer.byteLength(contents) <= maxBytes ? contents : null;
  } catch {
    return null;
  }
}

async function readJson(filePath) {
  const contents = await readText(filePath);
  if (!contents) return null;
  try {
    const value = JSON.parse(contents);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
}

async function jsonLines(filePath) {
  const contents = await readText(filePath);
  if (!contents) return { records: [], corruptLines: 0 };
  const records = [];
  let corruptLines = 0;
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        records.push(value);
      } else {
        corruptLines += 1;
      }
    } catch {
      corruptLines += 1;
    }
  }
  return { records, corruptLines };
}

async function childDirectories(directory) {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        name: entry.name,
        path: path.join(directory, entry.name),
      }));
  } catch {
    return [];
  }
}

async function jsonFilesRecursive(directory) {
  const files = [];
  const queue = [directory];
  while (queue.length) {
    const current = queue.shift();
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        files.push(entryPath);
      }
    }
  }
  return files;
}

function usageRecord({
  providerId,
  modelId,
  operationId,
  usage,
  occurredAt,
  step,
  runId = null,
  paperId = null,
  origin = "historical_artifact",
  evidenceSource = "historical_artifact",
} = {}) {
  const normalizedProviderId = safeText(providerId, 120);
  const normalizedModelId = safeText(modelId, 200);
  const normalizedOperationId = safeText(operationId, 240);
  const normalizedUsage = normalizePaperProviderUsage(usage);
  if (
    !normalizedProviderId
    || !normalizedModelId
    || !normalizedOperationId
    || !normalizedUsage
  ) {
    return null;
  }
  const capturedBilling = usage?.billing
    && typeof usage.billing === "object"
    && !Array.isArray(usage.billing)
    ? usage.billing
    : null;
  const capturedCostValue = capturedBilling?.api_equivalent_cost_usd;
  const capturedCost = Number(capturedCostValue);
  const historicalPricing = pricePaperUsage({
    providerId: normalizedProviderId,
    modelId: normalizedModelId,
    usage,
    costSource: "current_rate_backfill",
  });
  const hasCapturedCost = (
    capturedCostValue !== null
    && capturedCostValue !== undefined
    && Number.isFinite(capturedCost)
    && capturedCost >= 0
  );
  const costUsd = hasCapturedCost
    ? capturedCost
    : historicalPricing.costUsd;
  const costSource = hasCapturedCost
    ? safeText(capturedBilling.cost_source, 100) ?? "captured_rate_card"
    : historicalPricing.costUsd === null
      ? "unpriced"
      : "current_rate_backfill";
  const pricing = capturedBilling?.pricing_snapshot
    ?? historicalPricing.pricing
    ?? paperModelPricing(normalizedProviderId, normalizedModelId);
  return {
    identity: `${normalizedProviderId}:${normalizedOperationId}`,
    workflowScope: "paper_reading",
    providerId: normalizedProviderId,
    providerName: providerName(normalizedProviderId),
    modelId: normalizedModelId,
    modelName: modelName(normalizedModelId),
    operationId: normalizedOperationId,
    occurredAt: safeDate(occurredAt),
    step: safeText(step, 100) ?? "paper_model_call",
    runId: safeText(runId, 180),
    paperId: safeText(paperId, 180),
    origin: safeText(origin, 80) ?? "historical_artifact",
    evidenceSource,
    billingKind: capturedBilling?.kind
      ?? historicalPricing.billingKind
      ?? paperBillingKind(normalizedProviderId),
    costUsd,
    costSource,
    pricing,
    ...normalizedUsage,
  };
}

function mergeRecord(existing, incoming) {
  if (!existing) return incoming;
  const preferIncomingUsage = (
    existing.evidenceSource !== "ledger"
    && incoming.evidenceSource === "ledger"
  );
  const primary = preferIncomingUsage ? incoming : existing;
  const context = preferIncomingUsage ? existing : incoming;
  return {
    ...primary,
    occurredAt: primary.occurredAt ?? context.occurredAt,
    step: primary.step === "paper_model_call"
      ? context.step
      : primary.step,
    runId: primary.runId ?? context.runId,
    paperId: primary.paperId ?? context.paperId,
    origin: primary.origin === "live" ? primary.origin : context.origin ?? primary.origin,
  };
}

function addRecord(records, record, coverage) {
  if (!record) {
    coverage.invalidEvidence += 1;
    return;
  }
  const existing = records.get(record.identity);
  if (existing) coverage.duplicateEvidence += 1;
  records.set(record.identity, mergeRecord(existing, record));
}

function recordFromArtifact(artifact, context = {}) {
  if (
    artifact?.provenance?.source !== "model"
    || !artifact.provenance.usage
  ) return null;
  return usageRecord({
    providerId: artifact.provenance.provider_id,
    modelId: artifact.provenance.model_id,
    operationId: artifact.provenance.operation_id,
    usage: artifact.provenance.usage,
    occurredAt: artifact.generated_at ?? context.occurredAt,
    step: context.step,
    runId: artifact.run_id ?? context.runId,
    paperId: artifact.paper_id ?? context.paperId,
    origin: context.origin,
    evidenceSource: context.evidenceSource,
  });
}

function inlineArtifacts(run) {
  const result = [];
  for (const [paperId, paper] of Object.entries(run?.readings?.papers ?? {})) {
    for (const turn of paper?.chat?.turns ?? []) {
      if (turn?.inline_artifact) {
        result.push({
          artifact: turn.inline_artifact,
          paperId,
          occurredAt: turn.answered_at ?? turn.created_at,
        });
      }
    }
  }
  return result;
}

async function rankingCompletedAt(runDirectory) {
  const { records } = await jsonLines(path.join(runDirectory, "events.jsonl"));
  return records.find((event) => event.type === "candidate_ranking_completed")?.at
    ?? null;
}

async function scanRunDirectory(runDirectory, records, coverage, {
  origin = "historical_artifact",
  evidenceSource = "historical_artifact",
} = {}) {
  const runId = path.basename(runDirectory);
  if (!RUN_ID_PATTERN.test(runId)) return;
  const run = await readJson(path.join(runDirectory, "run.json"));
  const ranking = await readJson(
    path.join(runDirectory, "audit", "candidate-ranking.json"),
  );
  if (ranking?.source === "model" && ranking.usage) {
    addRecord(records, usageRecord({
      providerId: ranking.provider_id,
      modelId: ranking.model_id,
      operationId: ranking.operation_id,
      usage: ranking.usage,
      occurredAt: await rankingCompletedAt(runDirectory),
      step: "candidate_ranking",
      runId,
      origin,
      evidenceSource,
    }), coverage);
  }

  for (const filePath of await jsonFilesRecursive(
    path.join(runDirectory, "guides"),
  )) {
    const artifact = await readJson(filePath);
    if (!artifact) continue;
    addRecord(records, recordFromArtifact(artifact, {
      step: "five_minute_guide",
      runId,
      origin,
      evidenceSource,
    }), coverage);
  }

  for (const filePath of await jsonFilesRecursive(
    path.join(runDirectory, "readings"),
  )) {
    const relative = path.relative(runDirectory, filePath);
    const artifact = await readJson(filePath);
    if (!artifact) continue;
    const step = relative.includes(`${path.sep}chat${path.sep}`)
      ? "paper_agent"
      : relative.includes(`${path.sep}questions${path.sep}`)
        ? "reading_question"
        : "reading_stage";
    addRecord(records, recordFromArtifact(artifact, {
      step,
      runId,
      origin,
      evidenceSource,
    }), coverage);
  }

  for (const item of inlineArtifacts(run)) {
    addRecord(records, recordFromArtifact(item.artifact, {
      step: "paper_agent",
      runId,
      paperId: item.paperId,
      occurredAt: item.occurredAt,
      origin,
      evidenceSource,
    }), coverage);
  }

  for (const filePath of await jsonFilesRecursive(
    path.join(runDirectory, "translation"),
  )) {
    const artifact = await readJson(filePath);
    const receipts = Array.isArray(artifact?.usage_receipts)
      ? artifact.usage_receipts
      : [];
    for (const receipt of receipts) {
      addRecord(records, usageRecord({
        providerId: receipt.provider_id ?? artifact.provider_id,
        modelId: receipt.model_id ?? artifact.model_id,
        operationId: receipt.operation_id,
        usage: receipt.usage,
        occurredAt: receipt.occurred_at ?? receipt.completed_at,
        step: "translation",
        runId: receipt.run_id ?? runId,
        paperId: receipt.paper_id ?? artifact.paper_id,
        origin,
        evidenceSource,
      }), coverage);
    }
    if (
      Object.keys(artifact?.blocks ?? {}).length > 0
      && receipts.length === 0
    ) {
      coverage.legacyTranslationArtifactsWithoutUsage += 1;
    }
  }
}

export async function collectPaperUsageRecords({ dataDir } = {}) {
  if (typeof dataDir !== "string" || !dataDir.trim()) {
    throw new TypeError("dataDir is required");
  }
  const root = path.resolve(dataDir);
  const records = new Map();
  const coverage = {
    ledgerRecords: 0,
    historicalRecordsRecovered: 0,
    historicalTestRecords: 0,
    duplicateEvidence: 0,
    invalidEvidence: 0,
    fixtureRecordsIgnored: 0,
    corruptAuditLines: 0,
    legacyTranslationArtifactsWithoutUsage: 0,
  };

  const ledger = await jsonLines(path.join(root, "audit", "model-usage.jsonl"));
  coverage.corruptAuditLines += ledger.corruptLines;
  for (const receipt of ledger.records) {
    const before = records.size;
    addRecord(records, usageRecord({
      providerId: receipt.provider_id,
      modelId: receipt.model_id,
      operationId: receipt.operation_id,
      usage: receipt.usage,
      occurredAt: receipt.occurred_at,
      step: receipt.step,
      runId: receipt.run_id,
      paperId: receipt.paper_id,
      origin: receipt.origin ?? "live",
      evidenceSource: "ledger",
    }), coverage);
    if (records.size > before) coverage.ledgerRecords += 1;
  }

  const candidateAudit = await jsonLines(
    path.join(root, "audit", "model-calls.jsonl"),
  );
  coverage.corruptAuditLines += candidateAudit.corruptLines;
  for (const item of candidateAudit.records) {
    if (
      item.status !== "ok"
      || item.source !== "model"
      || !item.usage
    ) {
      if (item.source === "fixture") coverage.fixtureRecordsIgnored += 1;
      continue;
    }
    const before = records.size;
    addRecord(records, usageRecord({
      providerId: item.provider_id,
      modelId: item.model_id,
      operationId: item.operation_id,
      usage: item.usage,
      occurredAt: item.ts,
      step: "candidate_summaries",
      runId: item.run_id,
      origin: "historical_test",
      evidenceSource: "candidate_audit",
    }), coverage);
    if (records.size > before) {
      coverage.historicalRecordsRecovered += 1;
      coverage.historicalTestRecords += 1;
    }
  }

  const canonicalRuns = await childDirectories(path.join(root, "runs"));
  const canonicalRunIds = new Set(canonicalRuns.map((entry) => entry.name));
  for (const entry of canonicalRuns) {
    const before = records.size;
    await scanRunDirectory(entry.path, records, coverage);
    coverage.historicalRecordsRecovered += records.size - before;
  }

  for (const checkpoint of await childDirectories(path.join(root, "checkpoints"))) {
    for (const entry of await childDirectories(checkpoint.path)) {
      if (canonicalRunIds.has(entry.name)) continue;
      const before = records.size;
      await scanRunDirectory(entry.path, records, coverage, {
        origin: "checkpoint_recovery",
        evidenceSource: "checkpoint",
      });
      coverage.historicalRecordsRecovered += records.size - before;
    }
  }

  return {
    records: [...records.values()],
    coverage,
  };
}

function emptyUsageTotals() {
  return {
    calls: 0,
    tasks: 0,
    conversations: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    apiEquivalentCostUsd: null,
    pricedCallCount: 0,
    unpricedCallCount: 0,
    historicalBackfilledCallCount: 0,
  };
}

function addUsage(target, record) {
  target.calls += 1;
  target.inputTokens += record.inputTokens;
  target.outputTokens += record.outputTokens;
  target.cacheReadTokens += record.cacheReadTokens;
  target.cacheWriteTokens += record.cacheWriteTokens;
  target.totalTokens += record.totalTokens;
  if (record.costUsd === null) {
    target.unpricedCallCount += 1;
  } else {
    target.pricedCallCount += 1;
    target.apiEquivalentCostUsd = (
      target.apiEquivalentCostUsd ?? 0
    ) + record.costUsd;
  }
  if (record.costSource === "current_rate_backfill") {
    target.historicalBackfilledCallCount += 1;
  }
}

export function aggregatePaperUsage({
  records = [],
  coverage = {},
  period = "30d",
  now = new Date(),
} = {}) {
  if (!USAGE_PERIODS.has(period)) {
    throw usageError(
      "MODEL_USAGE_PERIOD_INVALID",
      "模型用量时间范围无效",
    );
  }
  const current = now instanceof Date ? new Date(now) : new Date(now);
  if (Number.isNaN(current.getTime())) throw new TypeError("now must be valid");
  const start = periodStart(period, current);
  const filtered = [];
  let undatedRecords = 0;
  for (const record of records) {
    if (!record.occurredAt) {
      undatedRecords += 1;
      if (period !== "all") continue;
    } else {
      const occurredAt = new Date(record.occurredAt);
      if (occurredAt > current || (start && occurredAt < start)) continue;
    }
    filtered.push(record);
  }

  const totals = emptyUsageTotals();
  const taskKeys = new Set();
  const conversationKeys = new Set();
  const models = new Map();
  for (const record of filtered) {
    addUsage(totals, record);
    taskKeys.add(record.runId ?? record.operationId);
    if (record.paperId) conversationKeys.add(record.paperId);
    const key = `${record.providerId}/${record.modelId}`;
    const model = models.get(key) ?? {
      workflowScope: "paper_reading",
      providerId: record.providerId,
      providerName: record.providerName,
      modelId: record.modelId,
      modelName: record.modelName,
      billingKind: record.billingKind,
      ...emptyUsageTotals(),
      lastUsedAt: null,
      currentPricing: record.pricing
        ?? paperModelPricing(record.providerId, record.modelId),
      taskKeys: new Set(),
      conversationKeys: new Set(),
      steps: new Map(),
    };
    addUsage(model, record);
    model.taskKeys.add(record.runId ?? record.operationId);
    if (record.paperId) model.conversationKeys.add(record.paperId);
    model.steps.set(record.step, (model.steps.get(record.step) ?? 0) + 1);
    if (
      record.occurredAt
      && (!model.lastUsedAt || record.occurredAt > model.lastUsedAt)
    ) {
      model.lastUsedAt = record.occurredAt;
    }
    models.set(key, model);
  }
  totals.tasks = taskKeys.size;
  totals.conversations = conversationKeys.size;
  const historicalTestCallCount = filtered.filter(
    (record) => record.origin === "historical_test",
  ).length;

  return {
    schemaVersion: 1,
    scope: "durable_paper_usage_evidence",
    workflowScope: "paper_reading",
    source: "paper_usage_ledger_and_historical_artifacts",
    costSemantics: "api_equivalent_estimate",
    period,
    periodStart: start?.toISOString() ?? null,
    periodEnd: current.toISOString(),
    generatedAt: current.toISOString(),
    quota: {
      available: false,
      detail: "论文模型服务商未统一提供可核验的套餐剩余额度",
    },
    totals,
    coverage: {
      ...coverage,
      knownCallCount: records.length,
      includedCallCount: filtered.length,
      historicalTestCallCount,
      undatedRecords,
      historicalLowerBound: true,
      excludedKinds: ["fixture", "cache", "coalesced", "deterministic"],
      includedKinds: [
        "candidate_summaries",
        "candidate_ranking",
        "five_minute_guide",
        "reading_stage",
        "reading_question",
        "paper_agent",
        "translation",
      ],
    },
    models: [...models.values()].map((model) => {
      const {
        taskKeys: modelTaskKeys,
        conversationKeys: modelConversationKeys,
        steps,
        ...publicModel
      } = model;
      return {
        ...publicModel,
        tasks: modelTaskKeys.size,
        conversations: modelConversationKeys.size,
        stepBreakdown: [...steps.entries()]
          .map(([step, calls]) => ({ step, calls }))
          .sort((left, right) => right.calls - left.calls),
      };
    }).sort((left, right) => (
      right.totalTokens - left.totalTokens
      || right.calls - left.calls
      || left.modelName.localeCompare(right.modelName)
    )),
  };
}

export function combineModelUsageReports({
  reports = [],
  period = "30d",
  workflow = "all",
  accessIssues = [],
} = {}) {
  const totals = emptyUsageTotals();
  const models = [];
  const workflows = [];
  for (const report of reports) {
    for (const field of [
      "calls",
      "tasks",
      "conversations",
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
      "totalTokens",
      "pricedCallCount",
      "unpricedCallCount",
      "historicalBackfilledCallCount",
    ]) {
      totals[field] += Number(report?.totals?.[field]) || 0;
    }
    if (Number.isFinite(report?.totals?.apiEquivalentCostUsd)) {
      totals.apiEquivalentCostUsd = (
        totals.apiEquivalentCostUsd ?? 0
      ) + report.totals.apiEquivalentCostUsd;
    }
    models.push(...(report.models ?? []).map((model) => ({
      ...model,
      workflowScope: model.workflowScope ?? report.workflowScope,
    })));
    workflows.push({
      workflowScope: report.workflowScope,
      totals: report.totals,
      coverage: report.coverage,
    });
  }
  return {
    schemaVersion: 1,
    scope: "local_model_usage",
    workflowScope: workflow,
    source: "durable_local_usage_evidence",
    costSemantics: "api_equivalent_estimate",
    period,
    periodStart: reports.map((item) => item.periodStart).filter(Boolean).sort()[0]
      ?? null,
    periodEnd: reports.map((item) => item.periodEnd).filter(Boolean).sort().at(-1)
      ?? new Date().toISOString(),
    generatedAt: new Date().toISOString(),
    status: accessIssues.length ? "partial" : "ready",
    quota: {
      available: false,
      detail: "不同模型服务商没有统一可核验的剩余额度接口",
    },
    totals,
    workflows,
    models,
    coverage: {
      accessIssues,
      includedKinds: reports.flatMap((item) => item.coverage?.includedKinds ?? []),
      excludedKinds: reports.flatMap((item) => item.coverage?.excludedKinds ?? []),
      historicalLowerBound: reports.some(
        (item) => item.coverage?.historicalLowerBound,
      ),
      legacyMessagesWithoutUsage: reports.reduce(
        (sum, item) => sum + (
          Number(item.coverage?.legacyMessagesWithoutUsage) || 0
        ),
        0,
      ),
      historicalBackfilledCallCount: totals.historicalBackfilledCallCount,
      historicalTestCallCount: reports.reduce(
        (sum, item) => sum + (
          Number(item.coverage?.historicalTestCallCount) || 0
        ),
        0,
      ),
      legacyTranslationArtifactsWithoutUsage: reports.reduce(
        (sum, item) => sum + (
          Number(item.coverage?.legacyTranslationArtifactsWithoutUsage) || 0
        ),
        0,
      ),
    },
  };
}

export function createJournalModelUsageService({
  dataDir,
  now = () => new Date(),
} = {}) {
  return Object.freeze({
    async getUsage({ period = "30d" } = {}) {
      const collected = await collectPaperUsageRecords({ dataDir });
      return aggregatePaperUsage({
        ...collected,
        period,
        now: now(),
      });
    },
  });
}
