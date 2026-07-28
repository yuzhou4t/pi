import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CandidateSummaryError,
  createCandidateSummaryService,
  validateCandidateSummaryRequest,
} from "./candidateSummaries.js";

const validModelItems = [{
  paper_id: "paper-1",
  selection_summary: "这篇论文研究如何构建可核验的智能体工作流。",
  project_impact: "可以直接检验 Pi Agent 的运行状态、证据与恢复边界。",
}];

function createPayload(overrides = {}) {
  return {
    schema_version: 2,
    provider_id: "codex-subscription",
    model_id: "account-default",
    run_id: "run-test",
    project_context: {
      goal: "验证论文候选与当前项目的关系",
      decisions: ["先建立强模型基线"],
      open_questions: ["哪些步骤可以降本？"],
      next_action: "审阅本周候选",
    },
    papers: [{
      paper_id: "paper-1",
      title: "A Verifiable Agent Workflow",
      authors: ["A. Author"],
      venue: "TestConf",
      published_at: "2026-07-20",
      abstract: "This paper studies verifiable agent workflows.",
      topic_matches: ["Agent 可靠性"],
      evidence_scope: "摘要级证据",
      selection_summary: "演示候选说明",
      project_impact: "可用于检验当前工作流状态设计。",
    }],
    ...overrides,
  };
}

function providerResult(items = validModelItems, overrides = {}) {
  return {
    text: JSON.stringify({ items }),
    operationId: "operation-test",
    usage: { input_tokens: 120, cached_input_tokens: 0, output_tokens: 35, total_tokens: 155 },
    upstreamRequestId: null,
    ...overrides,
  };
}

test("fixture mode returns the explicit fallback without a provider call", async () => {
  let callCount = 0;
  const service = createCandidateSummaryService({
    env: { PI_MODEL_MODE: "fixture" },
    dataDir: null,
    codexRunner: async () => { callCount += 1; },
  });
  const result = await service.summarize(createPayload());
  assert.equal(result.schema_version, 2);
  assert.equal(result.provider_id, "codex-subscription");
  assert.equal(result.source, "fixture");
  assert.equal(result.items[0].selection_summary, "演示候选说明");
  assert.equal(callCount, 0);
});

test("omitting PI_MODEL_MODE defaults to live and never enables fixtures", () => {
  const service = createCandidateSummaryService({
    env: {},
    dataDir: null,
  });
  assert.equal(service.config.mode, "live");
});

test("request validation requires schema v2, an allowed provider/model, and no extra command fields", () => {
  for (const payload of [
    createPayload({ schema_version: 1 }),
    createPayload({ provider_id: "unknown" }),
    createPayload({ model_id: "gpt-injected" }),
    createPayload({ api_key: "must-not-be-accepted" }),
    createPayload({ cli_path: "/tmp/untrusted" }),
  ]) {
    assert.throws(
      () => validateCandidateSummaryRequest(payload),
      (error) => error instanceof CandidateSummaryError && ["INVALID_REQUEST", "MODEL_NOT_ALLOWED"].includes(error.code),
    );
  }
});

test("request validation rejects duplicate ids and oversized abstracts", () => {
  const paper = createPayload().papers[0];
  assert.throws(
    () => validateCandidateSummaryRequest(createPayload({ papers: [paper, { ...paper }] })),
    (error) => error instanceof CandidateSummaryError && error.code === "INVALID_REQUEST",
  );
  assert.throws(
    () => validateCandidateSummaryRequest(createPayload({ papers: [{ ...paper, abstract: "x".repeat(20001) }] })),
    (error) => error instanceof CandidateSummaryError && error.code === "INVALID_REQUEST",
  );
});

test("Codex subscription returns the shared candidate summary contract", async () => {
  let received;
  const service = createCandidateSummaryService({
    env: { PI_MODEL_MODE: "live" },
    dataDir: null,
    codexRunner: async (input) => { received = input; return providerResult(); },
  });
  const result = await service.summarize(createPayload());
  assert.equal(received.schema.type, "object");
  assert.match(received.prompt, /不得调用工具/);
  assert.equal(result.source, "model");
  assert.equal(result.provider_id, "codex-subscription");
  assert.equal(result.model_id, "account-default");
  assert.equal(result.operation_id, "operation-test");
  assert.equal(result.usage.total_tokens, 155);
});

test("DeepSeek uses its dedicated server key and the same output contract", async () => {
  let received;
  const service = createCandidateSummaryService({
    env: { PI_MODEL_MODE: "live", PI_DEEPSEEK_API_KEY: "deepseek-test-key" },
    dataDir: null,
    deepseekRunner: async (input) => { received = input; return providerResult(); },
  });
  const result = await service.summarize(createPayload({
    provider_id: "deepseek",
    model_id: "deepseek-v4-pro",
  }));
  assert.equal(received.apiKey, "deepseek-test-key");
  assert.equal(received.modelId, "deepseek-v4-pro");
  assert.match(received.messages[0].content, /JSON/);
  assert.equal(result.provider_id, "deepseek");
  assert.equal(result.items[0].paper_id, "paper-1");
});

test("DeepSeek is unavailable without its dedicated key", async () => {
  let callCount = 0;
  const service = createCandidateSummaryService({
    env: { PI_MODEL_MODE: "live", DEEPSEEK_API_KEY: "ambient-key-must-not-be-used" },
    dataDir: null,
    deepseekRunner: async () => { callCount += 1; return providerResult(); },
  });
  await assert.rejects(
    service.summarize(createPayload({ provider_id: "deepseek", model_id: "deepseek-v4-pro" })),
    (error) => error instanceof CandidateSummaryError && error.code === "MODEL_NOT_CONFIGURED",
  );
  assert.equal(callCount, 0);
});

test("identical concurrent requests share one operation but keep distinct request ids", async () => {
  let callCount = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const service = createCandidateSummaryService({
    env: { PI_MODEL_MODE: "live" },
    dataDir: null,
    codexRunner: async () => { callCount += 1; await gate; return providerResult(); },
  });
  const first = service.summarize(createPayload());
  const second = service.summarize(createPayload({ run_id: "run-test-2" }));
  release();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(callCount, 1);
  assert.notEqual(firstResult.request_id, secondResult.request_id);
  assert.equal(firstResult.operation_id, secondResult.operation_id);
  assert.equal(firstResult.source, "model");
  assert.equal(secondResult.source, "coalesced");
  assert.equal(secondResult.usage, null);
});

test("provider and model are part of the cache namespace", async () => {
  let codexCalls = 0;
  let deepseekCalls = 0;
  const service = createCandidateSummaryService({
    env: { PI_MODEL_MODE: "live", PI_DEEPSEEK_API_KEY: "test-key" },
    dataDir: null,
    codexRunner: async () => { codexCalls += 1; return providerResult(); },
    deepseekRunner: async () => { deepseekCalls += 1; return providerResult(); },
  });
  await service.summarize(createPayload());
  await service.summarize(createPayload({ provider_id: "deepseek", model_id: "deepseek-v4-pro" }));
  assert.equal(codexCalls, 1);
  assert.equal(deepseekCalls, 1);
});

test("model output for an unknown paper is rejected and not cached", async () => {
  let callCount = 0;
  const service = createCandidateSummaryService({
    env: { PI_MODEL_MODE: "live" },
    dataDir: null,
    codexRunner: async () => {
      callCount += 1;
      return providerResult([{ ...validModelItems[0], paper_id: "unknown" }]);
    },
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(
      service.summarize(createPayload({ run_id: `run-${attempt}` })),
      (error) => error instanceof CandidateSummaryError && error.code === "MODEL_OUTPUT_INVALID",
    );
  }
  assert.equal(callCount, 2);
});

test("candidate usage is recorded before malformed provider output is rejected", async () => {
  const captured = [];
  const service = createCandidateSummaryService({
    env: { PI_MODEL_MODE: "live" },
    dataDir: null,
    codexRunner: async () => providerResult(validModelItems, {
      text: "not json",
      operationId: "candidate-invalid-output",
      upstreamRequestId: "upstream-invalid-output",
    }),
    usageRecorder: async (receipt) => {
      captured.push(receipt);
      return receipt.usage;
    },
  });

  await assert.rejects(
    service.summarize(createPayload()),
    (error) => (
      error instanceof CandidateSummaryError
      && error.code === "MODEL_OUTPUT_INVALID"
    ),
  );
  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0], {
    providerId: "codex-subscription",
    modelId: "account-default",
    operationId: "candidate-invalid-output",
    upstreamRequestId: "upstream-invalid-output",
    usage: {
      input_tokens: 120,
      cached_input_tokens: 0,
      output_tokens: 35,
      total_tokens: 155,
    },
    step: "candidate_summaries",
    runId: "run-test",
    inputHash: captured[0].inputHash,
  });
  assert.match(captured[0].inputHash, /^sha256:[a-f0-9]{64}$/);
});

test("cache write failure preserves the paid result and memory cache prevents a repeat call", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-cache-write-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await writeFile(path.join(dataDir, "cache"), "blocks cache directory creation", "utf8");
  let callCount = 0;
  const service = createCandidateSummaryService({
    env: { PI_MODEL_MODE: "live" },
    dataDir,
    codexRunner: async () => { callCount += 1; return providerResult(); },
  });
  const first = await service.summarize(createPayload());
  const second = await service.summarize(createPayload({ run_id: "run-test-2" }));
  assert.equal(first.source, "model");
  assert.equal(first.cache_write_failed, true);
  assert.equal(second.source, "cache");
  assert.equal(second.usage, null);
  assert.equal(callCount, 1);
});

test("an invalid disk cache fails open and refreshes from the selected provider", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-cache-read-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const env = { PI_MODEL_MODE: "live" };
  const firstService = createCandidateSummaryService({
    env,
    dataDir,
    codexRunner: async () => providerResult(),
  });
  await firstService.summarize(createPayload());
  const cacheDir = path.join(dataDir, "cache", "candidate-summaries");
  const [cacheFile] = await readdir(cacheDir);
  await writeFile(path.join(cacheDir, cacheFile), "not valid JSON", "utf8");
  let refreshCount = 0;
  const secondService = createCandidateSummaryService({
    env,
    dataDir,
    codexRunner: async () => { refreshCount += 1; return providerResult(); },
  });
  const result = await secondService.summarize(createPayload({ run_id: "run-test-2" }));
  assert.equal(result.source, "model");
  assert.equal(refreshCount, 1);
});

test("provider catalog reports ChatGPT login and DeepSeek key status without credentials", async () => {
  const service = createCandidateSummaryService({
    env: { PI_MODEL_MODE: "live" },
    dataDir: null,
    codexProbe: async () => ({ available: true, status: "ready", reasonCode: "CHATGPT_SUBSCRIPTION" }),
  });
  const catalog = await service.listProviders();
  assert.equal(catalog.default_provider_id, "codex-subscription");
  assert.equal(catalog.providers[0].available, true);
  assert.equal(catalog.providers[1].available, false);
  assert.equal(JSON.stringify(catalog).includes("api_key"), false);
});

test("Codex provider failures retain a safe machine-readable code", async () => {
  const service = createCandidateSummaryService({
    env: { PI_MODEL_MODE: "live" },
    dataDir: null,
    codexRunner: async () => {
      throw Object.assign(new Error("private stderr must not escape"), {
        code: "CODEX_AUTH_NOT_CHATGPT",
        retryable: false,
      });
    },
  });
  await assert.rejects(
    service.summarize(createPayload()),
    (error) => error instanceof CandidateSummaryError
      && error.code === "CODEX_AUTH_NOT_CHATGPT"
      && !error.message.includes("private stderr"),
  );
});
