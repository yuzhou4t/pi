import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRunStore } from "./runStore.js";
import { createSourceStateStore } from "./sourceStateStore.js";
import {
  createVenueSearchService,
  deterministicRecommendation,
} from "./venueSearchService.js";
import { createJournalWorkflowService } from "./workflowService.js";

function searchResult(papers) {
  return {
    schema_version: 1,
    query: "llm agent",
    observed_at: "2026-07-29T08:00:00.000Z",
    from_year: null,
    venues: [
      { source_id: "journal-ai", short_name: "AI", channel: "openalex-search", status: "success", count: papers.length, error: null },
      { source_id: "journal-jmlr", short_name: "JMLR", channel: "openalex-search", status: "failed", count: 0, error: { code: "OPENALEX_HTTP_503", retryable: true } },
    ],
    venue_success_count: 1,
    venue_failed_ids: ["journal-jmlr"],
    total_found: papers.length,
    truncated: false,
    papers,
  };
}

function searchPaper(id, title) {
  return {
    paper_id: id,
    dedupe_key: `doi:10.1000/${id}`,
    title,
    authors: ["A. Author"],
    venue: "Artificial Intelligence",
    published_at: "2026-05-01",
    abstract: "A study of reliable language agents with verifiable evaluation.",
    doi: `10.1000/${id}`,
    pdf_url: `https://papers.example/${id}.pdf`,
    topic_matches: ["LLM Agent"],
    heat_signals: [],
    evidence_scope: "OpenAlex 检索题录与摘要；全文尚待核验",
    candidate_origin: "venue_search",
    is_new: false,
    search_rank: 1,
    cited_by_count: 12,
  };
}

test("a fixture-mode search turn is durable, idempotent, and keeps failed venues visible", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-venue-search-svc-"));
  const papers = [searchPaper("p1", "Reliable Agents"), searchPaper("p2", "Agent Memory")];
  let searchCalls = 0;
  const service = createVenueSearchService({
    dataDir,
    modelMode: "fixture",
    venueSearcher: async ({ query }) => {
      searchCalls += 1;
      assert.equal(query, "帮我找 LLM Agent 评估的论文");
      return searchResult(papers);
    },
  });

  const conversation = await service.submitTurn({
    question: " 帮我找 LLM Agent 评估的论文 ",
    clientRequestId: "vs-req-1",
  });
  assert.equal(conversation.turns.length, 1);
  const [turn] = conversation.turns;
  assert.equal(turn.status, "complete");
  assert.equal(turn.plan.source, "deterministic");
  assert.equal(turn.recommendation_source, "deterministic");
  assert.equal(turn.recommendations.length, 2);
  assert.deepEqual(turn.search.venue_failed_ids, ["journal-jmlr"]);
  assert.ok(turn.answer.includes("注册刊物"));

  // Replaying the same client request must not search or spend again.
  const replay = await service.submitTurn({
    question: "帮我找 LLM Agent 评估的论文",
    clientRequestId: "vs-req-1",
  });
  assert.equal(replay.turns.length, 1);
  assert.equal(searchCalls, 1);

  const reloaded = await createVenueSearchService({
    dataDir,
    modelMode: "fixture",
    venueSearcher: async () => searchResult([]),
  }).getConversation();
  assert.equal(reloaded.turns.length, 1);
});

test("live mode uses the model for plan and recommendation and falls back on model failure", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-venue-search-live-"));
  const papers = [searchPaper("p1", "Reliable Agents")];
  const calls = [];
  const service = createVenueSearchService({
    dataDir,
    modelMode: "live",
    projectContextReader: {
      read: async () => ({ state: { goal: "构建可靠的个人论文工作流" } }),
    },
    modelProviders: {
      completeStructured: async ({ input, schema }) => {
        calls.push(schema);
        if (Object.hasOwn(schema.properties, "search_query")) {
          return {
            value: { search_query: "llm agent evaluation" },
            provider_id: "deepseek",
            model_id: "deepseek-v4-flash",
            operation_id: "op-plan",
            usage: { input_tokens: 10, output_tokens: 4 },
          };
        }
        assert.equal(input.papers.length, 1);
        return {
          value: {
            answer: "这批命中论文覆盖了 Agent 评估的核心问题，建议优先读第一篇。",
            recommendations: [{
              paper_id: "p1",
              reason: "系统化提出了可验证的 Agent 评估协议，与你的问题直接对应。",
              project_impact: "可作为项目评估阶段的方法参照。",
            }],
          },
          provider_id: "deepseek",
          model_id: "deepseek-v4-flash",
          operation_id: "op-rec",
          usage: { input_tokens: 50, output_tokens: 30 },
        };
      },
    },
    venueSearcher: async ({ query }) => {
      assert.equal(query, "llm agent evaluation");
      return searchResult(papers);
    },
  });

  const conversation = await service.submitTurn({
    question: "有什么帮助我做 Agent 评估的论文？",
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
    clientRequestId: "vs-live-1",
  });
  const [turn] = conversation.turns;
  assert.equal(turn.plan.source, "model");
  assert.equal(turn.recommendation_source, "model");
  assert.equal(turn.recommendations[0].paper_id, "p1");
  assert.equal(calls.length, 2);

  const failing = createVenueSearchService({
    dataDir: await mkdtemp(path.join(os.tmpdir(), "pi-agent-venue-search-fb-")),
    modelMode: "live",
    modelProviders: {
      completeStructured: async () => {
        throw new Error("MODEL_DOWN");
      },
    },
    venueSearcher: async () => searchResult(papers),
  });
  const fallback = await failing.submitTurn({
    question: "有什么帮助我做 Agent 评估的论文？",
    clientRequestId: "vs-live-2",
  });
  const [fallbackTurn] = fallback.turns;
  assert.equal(fallbackTurn.plan.source, "deterministic_fallback");
  assert.equal(fallbackTurn.recommendation_source, "deterministic_fallback");
  assert.equal(fallbackTurn.recommendations.length, 1);
});

test("deterministic recommendation is honest about empty hits", () => {
  const empty = deterministicRecommendation("agent planning", []);
  assert.deepEqual(empty.recommendations, []);
  assert.ok(empty.answer.includes("没有检索到"));
});

test("accepted search papers join the current weekly run once with retrieval labels", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-venue-add-weekly-"));
  const runStore = createRunStore({ dataDir });
  const run = await runStore.createRun();
  await runStore.updateRun(run.run_id, {
    status: "review_ready",
    phase: "candidate_review",
    candidates: [{
      paper_id: "weekly-1",
      dedupe_key: "doi:10.1000/weekly-1",
      title: "Weekly Paper",
      rank: 1,
      candidate_origin: "weekly_scan",
      display_label: "本周新论文",
    }],
    mineru: { status: "ready", batch_id: null, papers: { "weekly-1": { status: "ready" } } },
  });
  const service = createJournalWorkflowService({
    env: { PI_DATA_DIR: dataDir, PI_MODEL_MODE: "fixture" },
    dataDir,
    runStore,
    sourceStateStore: createSourceStateStore({ dataDir }),
    mineruAdapter: null,
    venueSearchService: createVenueSearchService({
      dataDir,
      modelMode: "fixture",
      venueSearcher: async () => searchResult([
        searchPaper("search-1", "Found Paper"),
        { ...searchPaper("weekly-1", "Weekly Paper"), dedupe_key: "doi:10.1000/weekly-1" },
      ]),
    }),
  });
  await service.submitVenueSearchTurn({
    question: "agent evaluation papers",
    clientRequestId: "vs-add-1",
  });
  const conversation = await service.getVenueSearchConversation();
  const target = conversation.turns.at(-1);
  const result = await service.addVenueSearchPapersToWeekly({
    turnId: target.turn_id,
    paperIds: target.papers.map((paper) => paper.paper_id),
  });
  const added = result.run.candidates.filter(
    (paper) => paper.candidate_origin === "venue_search",
  );
  assert.equal(added.length, 1);
  assert.equal(added[0].paper_id, "search-1");
  assert.equal(added[0].display_label, "主题检索推荐 · 非本周新论文");
  assert.equal(added[0].rank, 2);
  assert.equal(
    result.run.mineru.papers["search-1"].status,
    "pdf_not_prepared",
  );
  // The weekly-origin duplicate must not be re-added or relabeled.
  const weekly = result.run.candidates.find((paper) => paper.paper_id === "weekly-1");
  assert.equal(weekly.candidate_origin, "weekly_scan");
  assert.equal(result.run.candidates.length, 2);

  // Replaying the same accept adds nothing more.
  const replay = await service.addVenueSearchPapersToWeekly({
    turnId: target.turn_id,
    paperIds: target.papers.map((paper) => paper.paper_id),
  });
  assert.equal(replay.run.candidates.length, 2);
  assert.deepEqual(
    replay.conversation.turns.at(-1).added_paper_ids.sort(),
    target.papers.map((paper) => paper.paper_id).sort(),
  );
});
