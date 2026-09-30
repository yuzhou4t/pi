import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRunStore } from "./runStore.js";
import { createSourceStateStore } from "./sourceStateStore.js";
import {
  createVenueSearchService,
  deterministicRecommendation,
  deterministicSearchQuery,
  deterministicSearchQueries,
} from "./venueSearchService.js";
import { createWebSearchRunner } from "../project-work/externalRetrieval.js";
import { resolveProjectWorkDoubaoQuotaFilePath } from "../project-work/projectWorkPaths.js";
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
      // 兜底时只提取问题里可检索的英文术语，不把整段中文发给学术索引。
      assert.equal(query, "LLM Agent");
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

test("web discovery results are stored, deduped by url, and never become recommendable", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-venue-web-"));
  const papers = [searchPaper("p1", "Reliable Agents")];
  let webCalls = 0;
  const service = createVenueSearchService({
    dataDir,
    modelMode: "fixture",
    venueSearcher: async () => searchResult(papers),
    webSearcher: async (query, options) => {
      webCalls += 1;
      assert.equal(typeof query, "string");
      assert.equal(options.maxResults, 6);
      return {
        provider: "doubao",
        results: [
          {
            title: "LLM Agent 长期记忆综述",
            url: "https://example.com/memory",
            excerpt: "综述了 Agent 长期记忆机制。",
            published_date: "2026-06-01",
          },
          { title: "无链接项应被过滤", url: null, excerpt: "drop me" },
        ],
      };
    },
  });

  const conversation = await service.submitTurn({
    question: "LLM Agent 长期记忆有什么值得读的？",
    clientRequestId: "vs-web-1",
  });
  const [turn] = conversation.turns;
  assert.equal(webCalls, 1);
  assert.equal(turn.web.status, "success");
  assert.equal(turn.web.provider, "doubao");
  assert.equal(turn.web.results.length, 1);
  assert.equal(turn.web.results[0].url, "https://example.com/memory");
  assert.ok(turn.recommendations.every((rec) => rec.paper_id === "p1"));
});

test("project work and venue search share one 500-request Doubao ledger", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-shared-doubao-"));
  const storageRoot = path.join(dataDir, "project-work");
  const env = {
    PI_PROJECT_WORK_STORAGE_ROOT: storageRoot,
    PI_DOUBAO_API_KEY: "doubao-key",
    PI_TAVILY_API_KEY: "tavily-key",
  };
  const quotaFilePath = resolveProjectWorkDoubaoQuotaFilePath({ env });
  const now = () => new Date("2026-07-29T08:00:00+08:00");
  await mkdir(path.dirname(quotaFilePath), { recursive: true });
  await writeFile(quotaFilePath, JSON.stringify({
    version: 1,
    period: "2026-07",
    used: 499,
  }));
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes("volces.com")) {
      return new Response(JSON.stringify({
        output: [{
          type: "web_search_call",
          action: {
            sources: [{
              title: "Doubao result",
              url: "https://example.com/doubao",
            }],
          },
        }],
      }), { headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      results: [{
        title: "Tavily result",
        url: "https://example.com/tavily",
        content: "Fallback",
      }],
    }), { headers: { "content-type": "application/json" } });
  };

  const projectWorkSearch = createWebSearchRunner({
    env,
    fetchImpl,
    doubaoQuotaFilePath: quotaFilePath,
    now,
  });
  const projectResult = await projectWorkSearch.runWebSearch("project query");
  assert.equal(projectResult.provider, "doubao");

  const venueSearch = createVenueSearchService({
    dataDir,
    env,
    fetchImpl,
    now,
    modelMode: "fixture",
    venueSearcher: async () => searchResult([]),
  });
  const conversation = await venueSearch.submitTurn({
    question: "venue query",
    clientRequestId: "shared-quota-1",
  });

  assert.equal(conversation.turns[0].web.provider, "tavily");
  assert.equal(calls.filter((url) => url.includes("volces.com")).length, 1);
  assert.equal(calls.filter((url) => url.includes("tavily.com")).length, 1);
  assert.equal(JSON.parse(await readFile(quotaFilePath, "utf8")).used, 500);
  await assert.rejects(
    () => readFile(path.join(dataDir, "venue-search", "web-usage.json"), "utf8"),
    { code: "ENOENT" },
  );
});

test("a failing web lane never breaks the turn and empty academic hits still stay honest", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-venue-web-fail-"));
  const service = createVenueSearchService({
    dataDir,
    modelMode: "fixture",
    venueSearcher: async () => searchResult([]),
    webSearcher: async () => {
      throw new Error("web lane down");
    },
  });
  const conversation = await service.submitTurn({
    question: "niche topic with no hits",
    clientRequestId: "vs-web-2",
  });
  const [turn] = conversation.turns;
  assert.equal(turn.status, "complete");
  assert.equal(turn.web.status, "failed");
  assert.equal(turn.papers.length, 0);
  assert.equal(turn.recommendations.length, 0);
  assert.ok(turn.answer.includes("没有检索到"));
});

test("conversations can be created, switched, and deleted with isolated turns", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-venue-multi-"));
  const service = createVenueSearchService({
    dataDir,
    modelMode: "fixture",
    venueSearcher: async () => searchResult([searchPaper("p1", "Paper")]),
    webSearcher: async () => ({ provider: null, results: [] }),
  });

  const list0 = await service.listConversations();
  assert.equal(list0.conversations.length, 0);
  assert.equal(list0.active_conversation_id, null);

  const conv1 = await service.submitTurn({ question: "topic one", clientRequestId: "c1" });
  assert.ok(conv1.conversation_id);
  assert.equal(conv1.turns.length, 1);
  assert.equal(conv1.title, "topic one");

  const conv2 = await service.createConversation({ title: "第二个检索" });
  assert.equal(conv2.title, "第二个检索");
  assert.equal(conv2.turns.length, 0);

  const list1 = await service.listConversations();
  assert.equal(list1.conversations.length, 2);
  assert.equal(list1.active_conversation_id, conv2.conversation_id);

  const conv2b = await service.submitTurn({
    conversationId: conv2.conversation_id,
    question: "topic two",
    clientRequestId: "c2",
  });
  assert.equal(conv2b.conversation_id, conv2.conversation_id);
  assert.equal(conv2b.turns.length, 1);

  const conv1again = await service.getConversation(conv1.conversation_id);
  assert.equal(conv1again.turns.length, 1);

  const afterDelete = await service.deleteConversation(conv2.conversation_id);
  assert.equal(afterDelete.conversations.length, 1);
  assert.equal(afterDelete.active_conversation_id, conv1.conversation_id);
  await assert.rejects(
    () => service.getConversation(conv2.conversation_id),
    /会话不存在/,
  );
});

test("a legacy single-conversation file is migrated into the multi-conversation store", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-venue-migrate-"));
  await mkdir(path.join(dataDir, "venue-search"), { recursive: true });
  await writeFile(
    path.join(dataDir, "venue-search", "conversation.json"),
    JSON.stringify({
      schema_version: 1,
      conversation_id: "topic-search",
      updated_at: "2026-07-20T00:00:00.000Z",
      turns: [{
        turn_id: "vs-old",
        client_request_id: "old-1",
        question: "旧的检索问题",
        status: "complete",
        papers: [],
        recommendations: [],
        added_paper_ids: [],
      }],
    }),
  );
  const service = createVenueSearchService({
    dataDir,
    modelMode: "fixture",
    venueSearcher: async () => searchResult([]),
  });
  const list = await service.listConversations();
  assert.equal(list.conversations.length, 1);
  assert.equal(list.conversations[0].turn_count, 1);
  const conv = await service.getConversation();
  assert.equal(conv.turns[0].turn_id, "vs-old");
  assert.equal(conv.title, "旧的检索问题");
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
        if (Object.hasOwn(schema.properties, "search_queries")) {
          return {
            value: { search_queries: ["llm agent evaluation", "agent benchmark reliability"] },
            provider_id: "deepseek",
            model_id: "deepseek-v4-flash",
            operation_id: "op-plan",
            usage: { input_tokens: 10, output_tokens: 4 },
          };
        }
        if (Object.hasOwn(schema.properties, "translations")) {
          return {
            value: {
              translations: input.items.map((item) => ({ id: item.id, zh: `中文：${item.text}` })),
            },
            provider_id: "codex-subscription",
            model_id: "gpt-5.3-codex-spark",
            operation_id: "op-tr",
            usage: { input_tokens: 12, output_tokens: 8 },
          };
        }
        if (Object.hasOwn(schema.properties, "impacts")) {
          return {
            value: {
              impacts: input.papers.map((paper) => ({
                request_id: paper.request_id,
                project_impact: "Spark 判断：可用于核验项目的评估设计。",
              })),
            },
            provider_id: "codex-subscription",
            model_id: "gpt-5.3-codex-spark",
            operation_id: "op-impact",
            usage: { input_tokens: 9, output_tokens: 6 },
          };
        }
        assert.equal(input.papers.length, 1);
        return {
          value: {
            answer: "这批命中论文覆盖了 Agent 评估的核心问题，建议优先读第一篇。",
            recommendations: [{
              paper_id: "p1",
              title_zh: "面向可验证 Agent 评估的系统化协议",
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
  // 规划 + 推荐 + Spark 翻译 + Spark 项目作用，共四次有界调用。
  assert.equal(calls.length, 4);
  assert.equal(turn.papers[0].title_zh, "中文：Reliable Agents");
  assert.equal(turn.recommendations[0].project_impact, "Spark 判断：可用于核验项目的评估设计。");
  assert.equal(turn.language_artifact.project_impact.provenance.model_id, "gpt-5.3-codex-spark");

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

test("Spark translation fills non-recommended paper titles and web references", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-venue-translate-"));
  const papers = [searchPaper("p1", "Agentic Retrieval Benchmarks")];
  let translateModel = null;
  const service = createVenueSearchService({
    dataDir,
    modelMode: "live",
    modelProviders: {
      completeStructured: async ({ input, schema, modelId }) => {
        if (Object.hasOwn(schema.properties, "search_queries")) {
          return { value: { search_queries: ["agentic retrieval"] }, provider_id: "deepseek", model_id: "deepseek-v4-flash", operation_id: "op", usage: null };
        }
        if (Object.hasOwn(schema.properties, "translations")) {
          translateModel = modelId;
          return {
            value: { translations: input.items.map((item) => ({ id: item.id, zh: `译:${item.text}` })) },
            provider_id: "codex-subscription",
            model_id: modelId,
            operation_id: "op-tr",
            usage: null,
          };
        }
        // 无推荐，只依靠翻译填充中文标题。
        return { value: { answer: "本次命中较弱，暂无可推荐论文。", recommendations: [] }, provider_id: "deepseek", model_id: "deepseek-v4-flash", operation_id: "op-rec", usage: null };
      },
    },
    venueSearcher: async () => searchResult(papers),
    webSearcher: async () => ({
      provider: "tavily",
      results: [{ title: "Skills Documentation", url: "https://example.com/skills", excerpt: "Skills are self-contained packages" }],
    }),
  });

  const conversation = await service.submitTurn({
    question: "agentic retrieval",
    clientRequestId: "vs-tr-1",
  });
  const [turn] = conversation.turns;
  // 翻译固定走 Codex 5.3 Spark，不受会话所选模型影响。
  assert.equal(translateModel, "gpt-5.3-codex-spark");
  assert.equal(turn.papers[0].title_zh, "译:Agentic Retrieval Benchmarks");
  assert.equal(
    turn.papers[0].abstract_zh,
    "译:A study of reliable language agents with verifiable evaluation.",
  );
  assert.equal(turn.web.results[0].title_zh, "译:Skills Documentation");
  assert.equal(turn.web.results[0].excerpt_zh, "译:Skills are self-contained packages");
  assert.equal(turn.language_artifact.provenance.provider_id, "codex-subscription");
  assert.equal(turn.language_artifact.provenance.model_id, "gpt-5.3-codex-spark");
  assert.equal(turn.language_artifact.provenance.reasoning_effort, "low");
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
      display_label: "本月新论文",
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
  assert.equal(added[0].display_label, "主题检索推荐 · 非本月新论文");
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

test("deterministicSearchQuery extracts English terms from a Chinese question", () => {
  assert.equal(
    deterministicSearchQuery("帮我找 LLM Agent 长期记忆 memory 机制的论文"),
    "LLM Agent memory",
  );
  // 去重保留首次出现顺序。
  assert.equal(deterministicSearchQuery("RAG rag RAG retrieval"), "RAG retrieval");
  // 没有英文术语时回退到原文。
  assert.equal(deterministicSearchQuery("帮我找一些论文"), "帮我找一些论文");
});

test("deterministicSearchQueries expands Harness into bounded academic terminology", () => {
  assert.deepEqual(
    deterministicSearchQueries("这些期刊有 Harness Agent 相关内容吗？"),
    [
      "Harness Agent",
      "agent orchestration tool use",
      "LLM agent scaffold architecture",
      "agent runtime environment interface",
    ],
  );
  assert.deepEqual(
    deterministicSearchQueries("帮我找 LLM Agent 长期记忆论文"),
    ["LLM Agent"],
  );
});

test("submitTurn records phased progress that finishes complete", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-venue-search-progress-"));
  const service = createVenueSearchService({
    dataDir,
    modelMode: "fixture",
    venueSearcher: async () => searchResult([searchPaper("p1", "Agent Memory")]),
  });
  await service.submitTurn({
    question: "LLM Agent memory",
    clientRequestId: "vs-progress-1",
  });
  const progress = service.getTurnProgress("vs-progress-1");
  assert.equal(progress.phase, "done");
  assert.equal(progress.status, "complete");
  const unknown = service.getTurnProgress("vs-progress-missing");
  assert.equal(unknown.phase, "unknown");
  assert.equal(unknown.status, "unknown");
});
