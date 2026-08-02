import assert from "node:assert/strict";
import test from "node:test";
import {
  PAPER_LANGUAGE_PROFILE,
  PROJECT_IMPACT_FALLBACK,
  createPaperLanguageService,
} from "./paperLanguageService.js";

test("field translation uses the fixed Spark profile and returns auditable provenance", async () => {
  const calls = [];
  const service = createPaperLanguageService({
    modelMode: "live",
    modelProviders: {
      completeStructured: async (request) => {
        calls.push(request);
        return {
          value: {
            translations: request.input.items.map((item) => ({
              id: item.id,
              zh: `中文：${item.text}`,
            })),
          },
          provider_id: request.providerId,
          model_id: request.modelId,
          reasoning_effort: request.reasoningEffort,
          operation_id: "op-language-1",
          upstream_request_id: "req-language-1",
          usage: { total_tokens: 42 },
        };
      },
    },
  });

  const result = await service.translateFields([
    { requestId: "p1-title", field: "title", text: "Reliable Language Agents" },
    { requestId: "p1-abstract", field: "abstract", text: "We evaluate reliable agents." },
    { requestId: "p1-summary", field: "selection_summary", text: "A bounded evidence summary." },
    { requestId: "p1-impact", field: "project_impact", text: "Useful for workflow verification." },
    { requestId: "p1-cn", field: "summary", text: "已经是中文，不需要翻译。" },
  ]);

  assert.equal(calls.length, 1);
  assert.deepEqual(
    {
      providerId: calls[0].providerId,
      modelId: calls[0].modelId,
      reasoningEffort: calls[0].reasoningEffort,
    },
    PAPER_LANGUAGE_PROFILE,
  );
  assert.equal(result.status, "ready");
  assert.equal(result.translations.length, 4);
  assert.equal(result.byRequestId.get("p1-abstract").field, "abstract");
  assert.equal(result.provenance.prompt_id, "venue-search-translate");
  assert.equal(result.provenance.model_id, "gpt-5.3-codex-spark");
  assert.equal(result.provenance.reasoning_effort, "low");
  assert.match(result.provenance.input_hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.provenance.batches[0].operation_id, "op-language-1");
  assert.deepEqual(result.provenance.batches[0].usage, { total_tokens: 42 });
});

test("field translation splits more than forty requests into bounded batches", async () => {
  const batchSizes = [];
  const service = createPaperLanguageService({
    modelMode: "live",
    modelProviders: {
      completeStructured: async (request) => {
        batchSizes.push(request.input.items.length);
        return {
          value: {
            translations: request.input.items.map((item) => ({ id: item.id, zh: `译文 ${item.id}` })),
          },
          provider_id: request.providerId,
          model_id: request.modelId,
          reasoning_effort: request.reasoningEffort,
        };
      },
    },
  });
  const items = Array.from({ length: 41 }, (_, index) => ({
    requestId: `r${index}`,
    field: "title",
    text: `English paper title ${index}`,
  }));

  const result = await service.translateFields(items);

  assert.deepEqual(batchSizes, [40, 1]);
  assert.equal(result.status, "ready");
  assert.equal(result.translations.length, 41);
  assert.equal(result.provenance.batch_count, 2);
});

test("project impacts call Spark only when bounded project context exists", async () => {
  let calls = 0;
  const service = createPaperLanguageService({
    modelMode: "live",
    modelProviders: {
      completeStructured: async (request) => {
        calls += 1;
        assert.equal(request.providerId, "codex-subscription");
        assert.equal(request.modelId, "gpt-5.3-codex-spark");
        assert.equal(request.reasoningEffort, "low");
        assert.equal(request.input.project.goal, "建立可核验的论文工作流");
        return {
          value: {
            impacts: request.input.papers.map((paper) => ({
              request_id: paper.request_id,
              project_impact: "可用于验证论文工作流的证据追踪设计，具体结论待全文核验。",
            })),
          },
          provider_id: request.providerId,
          model_id: request.modelId,
          reasoning_effort: request.reasoningEffort,
          operation_id: "op-impact-1",
          usage: { total_tokens: 21 },
        };
      },
    },
  });
  const papers = [{
    requestId: "classic-1",
    title: "Evidence-Aware Agents",
    abstract: "We study evidence-aware agent workflows.",
    topicMatches: ["LLM Agent"],
  }];

  const withoutContext = await service.generateProjectImpacts({ papers, projectContext: null });
  assert.equal(withoutContext.status, "context_unavailable");
  assert.equal(withoutContext.impacts[0].project_impact, PROJECT_IMPACT_FALLBACK);
  assert.equal(calls, 0);

  const generated = await service.generateProjectImpacts({
    papers,
    projectContext: { goal: "建立可核验的论文工作流" },
  });
  assert.equal(calls, 1);
  assert.equal(generated.status, "ready");
  assert.match(generated.impacts[0].project_impact, /证据追踪/);
  assert.equal(generated.provenance.prompt_id, "paper-project-impact");
  assert.equal(generated.provenance.operation_id, "op-impact-1");
});

test("configured translation model changes one centralized profile only", () => {
  const service = createPaperLanguageService({
    env: { PI_JOURNAL_TRANSLATION_MODEL: "gpt-5.6-sol" },
  });
  assert.equal(service.profile.providerId, "codex-subscription");
  assert.equal(service.profile.modelId, "gpt-5.6-sol");
  assert.equal(service.profile.reasoningEffort, "low");
});

test("incomplete project-impact output is visible as a failed artifact", async () => {
  const service = createPaperLanguageService({
    modelMode: "live",
    modelProviders: {
      completeStructured: async () => ({ value: { impacts: [] } }),
    },
  });

  const result = await service.generateProjectImpacts({
    papers: [{ requestId: "paper-1", title: "Reliable Agents" }],
    projectContext: { goal: "构建可核验的论文工作流" },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "PAPER_PROJECT_IMPACT_OUTPUT_INCOMPLETE");
  assert.equal(result.impacts[0].project_impact, PROJECT_IMPACT_FALLBACK);
});
