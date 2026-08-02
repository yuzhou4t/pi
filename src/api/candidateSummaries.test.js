import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchCandidateSummaries,
  fetchModelProviders,
  mergeCandidateSummaries,
} from "./candidateSummaries.js";

function mockFetch(handler) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

test("mergeCandidateSummaries only replaces model-owned display fields", () => {
  const papers = [{
    id: "paper-1",
    title: "Original title",
    abstract: "Original abstract",
    relevance: "Original relevance",
  }];

  const merged = mergeCandidateSummaries(papers, [{
    paper_id: "paper-1",
    selection_summary: "Generated selection summary",
    project_impact: "Generated project impact",
    title: "Untrusted replacement title",
  }]);

  assert.notEqual(merged, papers);
  assert.equal(merged[0].title, "Original title");
  assert.equal(merged[0].abstract, "Original abstract");
  assert.equal(merged[0].relevance, "Original relevance");
  assert.equal(merged[0].selectionSummary, "Generated selection summary");
  assert.equal(merged[0].projectImpact, "Generated project impact");
});

test("fetchModelProviders maps the server catalog without exposing configuration", async () => {
  const restore = mockFetch(async (url, options) => {
    assert.equal(url, "/api/v1/model-providers");
    assert.equal(options.signal, "signal");
    return new Response(JSON.stringify({
      schema_version: 1,
      mode: "live",
      default_provider_id: "codex-subscription",
      providers: [{
        id: "codex-subscription",
        name: "GPT · Codex 订阅",
        available: true,
        status: "available",
        reason_code: null,
        models: ["account-default"],
        api_key: "must-not-reach-browser-state",
        base_url: "https://must-not-reach-browser-state.example",
        cli_args: ["--must-not-reach-browser-state"],
      }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  });

  try {
    const catalog = await fetchModelProviders({ signal: "signal" });
    assert.equal(catalog.mode, "live");
    assert.equal(catalog.defaultProviderId, "codex-subscription");
    assert.deepEqual(catalog.providers, [{
      id: "codex-subscription",
      name: "GPT · Codex 订阅",
      available: true,
      status: "available",
      reasonCode: null,
      models: ["account-default"],
    }]);
  } finally {
    restore();
  }
});

test("fetchCandidateSummaries sends provider and model with schema version 2", async () => {
  const restore = mockFetch(async (url, options) => {
    assert.equal(url, "/api/v1/candidate-summaries");
    const body = JSON.parse(options.body);
    assert.equal(body.schema_version, 2);
    assert.equal(body.provider_id, "deepseek");
    assert.equal(body.model_id, "deepseek-v4-flash");
    assert.equal(Object.hasOwn(body, "project_context"), false);
    return new Response(JSON.stringify({
      schema_version: 2,
      source: "model",
      provider_id: "deepseek",
      model_id: "deepseek-v4-flash",
      request_id: "request-1",
      operation_id: "operation-1",
      usage: { input_tokens: 10, output_tokens: 5 },
      items: [],
    }), { status: 200, headers: { "content-type": "application/json" } });
  });

  try {
    const result = await fetchCandidateSummaries({
      runId: "run-1",
      papers: [],
      providerId: "deepseek",
      modelId: "deepseek-v4-flash",
    });
    assert.equal(result.providerId, "deepseek");
    assert.equal(result.modelId, "deepseek-v4-flash");
  } finally {
    restore();
  }
});
