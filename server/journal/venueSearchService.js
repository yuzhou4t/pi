import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createWebSearchRunner } from "../project-work/externalRetrieval.js";
import { resolveProjectWorkDoubaoQuotaFilePath } from "../project-work/projectWorkPaths.js";
import { promptRegistry } from "../promptRegistry.js";
import { searchRegisteredVenues } from "./venueSearch.js";

const CONVERSATION_ID = "topic-search";
const MAX_TURNS = 30;
const MAX_QUESTION_CHARS = 500;
const MAX_RECOMMEND_INPUTS = 12;
const MAX_ABSTRACT_CHARS = 500;
const SEARCH_RESULT_LIMIT = 12;
const MAX_WEB_RESULTS = 6;
const MAX_WEB_EXCERPT_CHARS = 400;
const MAX_CONVERSATIONS = 50;
const MAX_TITLE_CHARS = 60;
const DEFAULT_CONVERSATION_TITLE = "新的检索";
// 英文标题/摘要统一用 Codex 5.3 Spark 翻译，不受当前会话所选模型影响。
const TRANSLATION_PROVIDER_ID = "codex-subscription";
const TRANSLATION_MODEL_ID = "gpt-5.3-codex-spark";
const MAX_TRANSLATION_ITEMS = 40;
const MAX_PLAN_QUERIES = 4;

// 含连续英文字母才需要翻译；纯中文/纯数字不消耗翻译额度。
function looksTranslatable(text) {
  return typeof text === "string" && /[A-Za-z]{4,}/.test(text);
}

export class VenueSearchServiceError extends Error {
  constructor(code, message, status = 409, retryable = false) {
    super(message);
    this.name = "VenueSearchServiceError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function compact(value, maxLength = Infinity) {
  if (typeof value !== "string") return "";
  return value.trim().replaceAll(/\s+/g, " ").slice(0, maxLength);
}

function publicError(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "VENUE_SEARCH_TURN_FAILED",
    message: typeof error?.message === "string" ? error.message.slice(0, 200) : "检索失败",
    retryable: Boolean(error?.retryable),
  };
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  await rename(temporaryPath, filePath);
}

function deriveConversationTitle(question) {
  const text = compact(question, MAX_TITLE_CHARS);
  return text || DEFAULT_CONVERSATION_TITLE;
}

// 学术索引对整段中文提问几乎必然零命中；规划失败时只用问题里可检索的英文术语兜底。
export function deterministicSearchQuery(question) {
  const text = typeof question === "string" ? question : "";
  const asciiRuns = text.match(/[A-Za-z][A-Za-z0-9+._-]{1,40}/g) ?? [];
  const seen = new Set();
  const terms = [];
  for (const run of asciiRuns) {
    const term = run.toLowerCase();
    if (seen.has(term)) continue;
    seen.add(term);
    terms.push(run);
    if (terms.length >= 12) break;
  }
  const extracted = compact(terms.join(" "), 200);
  if (extracted.length >= 3) return extracted;
  return compact(text, 200);
}

function recommendInput(question, projectContext, papers, webResults = []) {
  return {
    question: compact(question, MAX_QUESTION_CHARS),
    project: projectContext
      ? {
          goal: compact(projectContext.goal, 400),
          open_questions: (projectContext.open_questions ?? projectContext.openQuestions ?? [])
            .slice(0, 4)
            .map((item) => compact(item, 200)),
          next_action: compact(projectContext.next_action ?? projectContext.nextAction, 200),
        }
      : null,
    papers: papers.map((paper) => ({
      paper_id: paper.paper_id,
      title: compact(paper.title, 400),
      venue: compact(paper.venue, 160),
      published_at: compact(paper.published_at, 40),
      cited_by_count: Number.isInteger(paper.cited_by_count) ? paper.cited_by_count : null,
      abstract: compact(paper.abstract, MAX_ABSTRACT_CHARS)
        || "当前来源未提供摘要，仅可依据题录判断。",
    })),
    web_references: webResults.map((item) => ({
      title: compact(item.title, 300),
      url: item.url,
      excerpt: compact(item.excerpt, MAX_WEB_EXCERPT_CHARS)
        || "未提供摘要，仅可依据标题与链接判断。",
      published_date: item.published_date ?? null,
    })),
  };
}

function validateRecommendation(value, papers) {
  const answer = compact(value?.answer);
  if (answer.length < 20) throw new Error("VENUE_SEARCH_ANSWER_INVALID");
  if (!Array.isArray(value?.recommendations) || value.recommendations.length > 5) {
    throw new Error("VENUE_SEARCH_RECOMMENDATIONS_INVALID");
  }
  const known = new Set(papers.map((paper) => paper.paper_id));
  const seen = new Set();
  const recommendations = value.recommendations.map((item) => {
    const paperId = compact(item?.paper_id);
    const titleZh = compact(item?.title_zh, 160);
    const reason = compact(item?.reason);
    const projectImpact = compact(item?.project_impact);
    if (
      !known.has(paperId)
      || seen.has(paperId)
      || titleZh.length < 2
      || reason.length < 12
      || reason.length > 300
      || projectImpact.length < 4
      || projectImpact.length > 260
    ) {
      throw new Error("VENUE_SEARCH_RECOMMENDATIONS_INVALID");
    }
    seen.add(paperId);
    return { paper_id: paperId, title_zh: titleZh, reason, project_impact: projectImpact };
  });
  return { answer, recommendations };
}

export function deterministicRecommendation(question, papers, webResults = []) {
  const top = papers.slice(0, 5);
  const webNote = webResults.length > 0
    ? `另有 ${webResults.length} 条联网发现可作参考。`
    : "";
  const answer = top.length > 0
    ? `按「${compact(question, 60)}」在注册刊物范围内检索到 ${papers.length} 篇相关论文，`
      + "已按检索相关度与引用记录列出最值得关注的几篇；推荐理由基于题录与摘要，具体结论待全文核验。"
      + webNote
    : (webResults.length > 0
      ? `按「${compact(question, 60)}」在注册刊物范围内未检索到相关论文，但联网发现了 ${webResults.length} 条参考资料，可在下方查看来源链接。`
      : `按「${compact(question, 60)}」在注册刊物与联网范围内都没有检索到足够相关的内容，可尝试更具体的英文关键词。`);
  return {
    answer,
    recommendations: top.map((paper) => ({
      paper_id: paper.paper_id,
      title_zh: paper.title_zh ?? null,
      reason: compact(
        paper.abstract
          ? `${paper.title}：${paper.abstract}`
          : `${paper.title}：当前只有题录信息，价值需要全文核验。`,
        300,
      ),
      project_impact: "与检索主题直接相关；对项目的具体作用待全文核验。",
    })),
  };
}

export function createVenueSearchService({
  dataDir,
  env = {},
  doubaoQuotaFilePath = resolveProjectWorkDoubaoQuotaFilePath({ env }),
  fetchImpl = globalThis.fetch,
  modelProviders = null,
  modelMode = "fixture",
  projectContextReader = null,
  venueSearcher = searchRegisteredVenues,
  webSearcher = null,
  mailto = "",
  now = () => new Date(),
  idFactory = randomUUID,
} = {}) {
  if (typeof dataDir !== "string" || !dataDir.trim()) {
    throw new TypeError("dataDir is required");
  }
  const legacyPath = path.resolve(dataDir, "venue-search", "conversation.json");
  const storePath = path.resolve(dataDir, "venue-search", "conversations.json");
  // 联网发现与普通项目工作共用同一份豆包月度额度台账。
  const runWebSearch = typeof webSearcher === "function"
    ? webSearcher
    : createWebSearchRunner({
        env,
        fetchImpl,
        doubaoQuotaFilePath,
        now,
      }).runWebSearch;
  let inFlight = null;
  // 运行中检索回合的实时进度（仅内存，供前端轮询）。
  const turnProgress = new Map();
  const TURN_PROGRESS_TTL_MS = 5 * 60 * 1000;

  function pruneTurnProgress() {
    const cutoff = Date.now() - TURN_PROGRESS_TTL_MS;
    for (const [key, value] of turnProgress) {
      if (value.updated_at_ms < cutoff) turnProgress.delete(key);
    }
  }

  function setTurnProgress(clientRequestId, patch) {
    if (!clientRequestId) return;
    pruneTurnProgress();
    const previous = turnProgress.get(clientRequestId) ?? {};
    turnProgress.set(clientRequestId, {
      phase: patch.phase ?? previous.phase ?? "preparing",
      thinking: patch.thinking !== undefined ? patch.thinking : previous.thinking ?? null,
      query: patch.query ?? previous.query ?? null,
      status: patch.status ?? previous.status ?? "running",
      updated_at_ms: Date.now(),
    });
  }

  function getTurnProgress(clientRequestId) {
    pruneTurnProgress();
    const value = turnProgress.get(clientRequestId);
    if (!value) return { phase: "unknown", thinking: null, query: null, status: "unknown" };
    return {
      phase: value.phase,
      thinking: value.thinking,
      query: value.query,
      status: value.status,
    };
  }

  // 模型通道公开事件 → 面向人的阶段（不改变当前业务阶段，只补思考摘要）。
  function progressFromModelEvent(event, phase) {
    if (event?.type === "thinking_summary") {
      return { phase, thinking: event.text ?? null };
    }
    return null;
  }

  function newConversation(title) {
    const timestamp = now().toISOString();
    return {
      conversation_id: `vsc-${idFactory().slice(0, 12)}`,
      title: title || DEFAULT_CONVERSATION_TITLE,
      created_at: timestamp,
      updated_at: timestamp,
      turns: [],
    };
  }

  function emptyStore() {
    return { schema_version: 2, active_conversation_id: null, conversations: [] };
  }

  async function readLegacyConversation() {
    try {
      const state = JSON.parse(await readFile(legacyPath, "utf8"));
      if (state?.schema_version === 1 && Array.isArray(state.turns) && state.turns.length > 0) {
        return state;
      }
      return null;
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  async function readStore() {
    try {
      const state = JSON.parse(await readFile(storePath, "utf8"));
      if (state?.schema_version === 2 && Array.isArray(state.conversations)) return state;
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    // 迁移旧的单一 topic-search 对话，避免丢历史记录。
    const legacy = await readLegacyConversation();
    if (legacy) {
      const conv = {
        conversation_id: CONVERSATION_ID,
        title: deriveConversationTitle(legacy.turns[0]?.question),
        created_at: legacy.turns[0]?.created_at ?? legacy.updated_at ?? now().toISOString(),
        updated_at: legacy.updated_at ?? now().toISOString(),
        turns: legacy.turns,
      };
      return { schema_version: 2, active_conversation_id: conv.conversation_id, conversations: [conv] };
    }
    return emptyStore();
  }

  function writeStore(store) {
    return writeJsonAtomic(storePath, store);
  }

  function conversationView(conv) {
    if (!conv) {
      return {
        schema_version: 1,
        conversation_id: null,
        title: null,
        turns: [],
        created_at: null,
        updated_at: null,
      };
    }
    return {
      schema_version: 1,
      conversation_id: conv.conversation_id,
      title: conv.title,
      turns: conv.turns,
      created_at: conv.created_at ?? null,
      updated_at: conv.updated_at ?? null,
    };
  }

  function conversationMeta(conv) {
    return {
      conversation_id: conv.conversation_id,
      title: conv.title,
      turn_count: conv.turns.length,
      created_at: conv.created_at ?? null,
      updated_at: conv.updated_at ?? null,
    };
  }

  function sortedConversations(conversations) {
    return conversations.slice().sort(
      (a, b) => (b.updated_at ?? b.created_at ?? "").localeCompare(a.updated_at ?? a.created_at ?? ""),
    );
  }

  function resolveTarget(store, conversationId) {
    if (conversationId) {
      return store.conversations.find((item) => item.conversation_id === conversationId) ?? null;
    }
    return store.conversations.find((item) => item.conversation_id === store.active_conversation_id)
      ?? sortedConversations(store.conversations)[0]
      ?? null;
  }

  async function listConversations() {
    const store = await readStore();
    return {
      schema_version: 2,
      active_conversation_id: store.active_conversation_id,
      conversations: sortedConversations(store.conversations).map(conversationMeta),
    };
  }

  async function getConversation(conversationId = null) {
    const store = await readStore();
    const conv = resolveTarget(store, conversationId);
    if (conversationId && !conv) {
      throw new VenueSearchServiceError(
        "VENUE_SEARCH_CONVERSATION_NOT_FOUND",
        "检索会话不存在",
        404,
      );
    }
    return conversationView(conv);
  }

  async function createConversation({ title } = {}) {
    const store = await readStore();
    const conv = newConversation(title ? deriveConversationTitle(title) : null);
    const conversations = [conv, ...store.conversations].slice(0, MAX_CONVERSATIONS);
    await writeStore({
      schema_version: 2,
      active_conversation_id: conv.conversation_id,
      conversations,
    });
    return conversationView(conv);
  }

  async function deleteConversation(conversationId) {
    const store = await readStore();
    const remaining = store.conversations.filter(
      (item) => item.conversation_id !== conversationId,
    );
    if (remaining.length === store.conversations.length) {
      throw new VenueSearchServiceError(
        "VENUE_SEARCH_CONVERSATION_NOT_FOUND",
        "检索会话不存在",
        404,
      );
    }
    const activeId = store.active_conversation_id === conversationId
      ? (sortedConversations(remaining)[0]?.conversation_id ?? null)
      : store.active_conversation_id;
    await writeStore({
      schema_version: 2,
      active_conversation_id: activeId,
      conversations: remaining,
    });
    return {
      schema_version: 2,
      active_conversation_id: activeId,
      conversations: sortedConversations(remaining).map(conversationMeta),
    };
  }

  async function planQuery(question, projectContext, { providerId, modelId, reasoningEffort, onEvent = null }) {
    const fallbackQuery = deterministicSearchQuery(question);
    const fallback = {
      search_query: fallbackQuery,
      search_queries: [fallbackQuery],
      from_year: null,
      source: "deterministic",
      usage: null,
    };
    if (modelMode !== "live" || !modelProviders?.completeStructured) return fallback;
    const prompt = promptRegistry.loadPrompt("venue-search-plan");
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const generated = await modelProviders.completeStructured({
          providerId,
          modelId,
          ...(reasoningEffort ? { reasoningEffort } : {}),
          system: prompt.system,
          prompt: prompt.body,
          input: {
            question: compact(question, MAX_QUESTION_CHARS),
            project_goal: compact(projectContext?.goal, 300) || null,
          },
          schema: prompt.schema,
          ...(typeof onEvent === "function" ? { onEvent } : {}),
        });
        // 兼容新版多查询 search_queries 与旧版单查询 search_query。
        const rawQueries = Array.isArray(generated.value?.search_queries)
          ? generated.value.search_queries
          : [generated.value?.search_query];
        const seen = new Set();
        const searchQueries = [];
        for (const candidate of rawQueries) {
          const normalized = compact(candidate, 200);
          const key = normalized.toLowerCase();
          if (normalized.length < 3 || seen.has(key)) continue;
          seen.add(key);
          searchQueries.push(normalized);
          if (searchQueries.length >= MAX_PLAN_QUERIES) break;
        }
        if (searchQueries.length === 0) throw new Error("VENUE_SEARCH_PLAN_INVALID");
        return {
          search_query: searchQueries[0],
          search_queries: searchQueries,
          from_year: Number.isInteger(generated.value?.from_year)
            ? generated.value.from_year
            : null,
          source: "model",
          provider_id: generated.provider_id,
          model_id: generated.model_id,
          usage: generated.usage ?? null,
        };
      } catch (error) {
        lastError = error;
        // 可重试的模型失败先重试一次，避免偶发抖动直接降级兜底。
        if (attempt === 0 && error?.retryable === true) continue;
        break;
      }
    }
    return { ...fallback, source: "deterministic_fallback", error: publicError(lastError) };
  }

  async function webDiscovery(query) {
    try {
      const result = await runWebSearch(query, { maxResults: MAX_WEB_RESULTS });
      const results = (Array.isArray(result?.results) ? result.results : [])
        .map((item) => ({
          title: compact(item?.title, 300),
          url: typeof item?.url === "string" ? item.url : null,
          excerpt: compact(item?.excerpt, MAX_WEB_EXCERPT_CHARS),
          published_date: compact(item?.published_date, 40) || null,
        }))
        .filter((item) => item.url && item.title);
      return { status: "success", provider: result?.provider ?? null, results, error: null };
    } catch (error) {
      return { status: "failed", provider: null, results: [], error: publicError(error) };
    }
  }

  // 用 Codex Spark 把标题/摘要里的英文批量翻成中文；尽力而为，失败就保留原文。
  async function translateDiscoveries({ papers, webResults, onEvent = null }) {
    const empty = { titles: new Map(), webTitles: new Map(), webExcerpts: new Map() };
    if (modelMode !== "live" || !modelProviders?.completeStructured) return empty;
    const items = [];
    papers.forEach((paper, index) => {
      if (looksTranslatable(paper.title)) {
        items.push({ id: `p${index}`, text: compact(paper.title, 300) });
      }
    });
    webResults.forEach((item, index) => {
      if (looksTranslatable(item.title)) {
        items.push({ id: `wt${index}`, text: compact(item.title, 300) });
      }
      if (looksTranslatable(item.excerpt)) {
        items.push({ id: `we${index}`, text: compact(item.excerpt, MAX_WEB_EXCERPT_CHARS) });
      }
    });
    if (items.length === 0) return empty;
    const bounded = items.slice(0, MAX_TRANSLATION_ITEMS);
    try {
      const prompt = promptRegistry.loadPrompt("venue-search-translate");
      const generated = await modelProviders.completeStructured({
        providerId: TRANSLATION_PROVIDER_ID,
        modelId: TRANSLATION_MODEL_ID,
        reasoningEffort: "low",
        system: prompt.system,
        prompt: prompt.body,
        input: { items: bounded },
        schema: prompt.schema,
        ...(typeof onEvent === "function" ? { onEvent } : {}),
      });
      const byId = new Map();
      for (const entry of generated.value?.translations ?? []) {
        const id = typeof entry?.id === "string" ? entry.id : "";
        const zh = compact(entry?.zh, 600);
        if (id && zh) byId.set(id, zh);
      }
      const titles = new Map();
      const webTitles = new Map();
      const webExcerpts = new Map();
      papers.forEach((_, index) => {
        const zh = byId.get(`p${index}`);
        if (zh) titles.set(index, zh);
      });
      webResults.forEach((_, index) => {
        const zhTitle = byId.get(`wt${index}`);
        const zhExcerpt = byId.get(`we${index}`);
        if (zhTitle) webTitles.set(index, zhTitle);
        if (zhExcerpt) webExcerpts.set(index, zhExcerpt);
      });
      return { titles, webTitles, webExcerpts };
    } catch {
      // 翻译是锦上添花；失败时保留英文原文，不影响检索结果。
      return empty;
    }
  }

  async function recommend(question, projectContext, papers, webResults, { providerId, modelId, reasoningEffort, onEvent = null }) {
    const pool = papers.slice(0, MAX_RECOMMEND_INPUTS);
    if (
      modelMode !== "live"
      || !modelProviders?.completeStructured
      || (pool.length === 0 && webResults.length === 0)
    ) {
      return {
        ...deterministicRecommendation(question, pool, webResults),
        source: "deterministic",
        usage: null,
      };
    }
    const prompt = promptRegistry.loadPrompt("venue-search-recommend");
    try {
      const generated = await modelProviders.completeStructured({
        providerId,
        modelId,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        system: prompt.system,
        prompt: prompt.body,
        input: recommendInput(question, projectContext, pool, webResults),
        schema: prompt.schema,
        ...(typeof onEvent === "function" ? { onEvent } : {}),
      });
      return {
        ...validateRecommendation(generated.value, pool),
        source: "model",
        provider_id: generated.provider_id,
        model_id: generated.model_id,
        prompt_id: prompt.id,
        prompt_version: prompt.version,
        usage: generated.usage ?? null,
      };
    } catch (error) {
      return {
        ...deterministicRecommendation(question, pool, webResults),
        source: "deterministic_fallback",
        usage: null,
        error: publicError(error),
      };
    }
  }

  async function submitTurn({
    conversationId = null,
    question,
    providerId,
    modelId,
    reasoningEffort = null,
    clientRequestId,
  } = {}) {
    const normalizedQuestion = compact(question, MAX_QUESTION_CHARS);
    if (!normalizedQuestion) {
      throw new VenueSearchServiceError(
        "VENUE_SEARCH_QUESTION_REQUIRED",
        "检索问题不能为空",
        400,
      );
    }
    if (typeof clientRequestId !== "string" || !clientRequestId.trim()) {
      throw new VenueSearchServiceError(
        "VENUE_SEARCH_REQUEST_ID_REQUIRED",
        "检索请求必须提供稳定的请求标识",
        400,
      );
    }
    const existing = await readStore();
    const existingTarget = resolveTarget(existing, conversationId);
    if (conversationId && !existingTarget) {
      throw new VenueSearchServiceError(
        "VENUE_SEARCH_CONVERSATION_NOT_FOUND",
        "检索会话不存在",
        404,
      );
    }
    const replay = existingTarget?.turns.find(
      (turn) => turn.client_request_id === clientRequestId,
    );
    if (replay) return conversationView(existingTarget);
    if (inFlight) {
      throw new VenueSearchServiceError(
        "VENUE_SEARCH_BUSY",
        "已有一次检索正在进行，请等待完成",
        409,
        true,
      );
    }
    inFlight = (async () => {
      let projectContext = null;
      try {
        projectContext = (await projectContextReader?.read())?.state ?? null;
      } catch {
        // 项目状态不可读时检索仍可进行，推荐将只依据问题与题录。
      }
      const startedAt = now().toISOString();
      setTurnProgress(clientRequestId, { phase: "planning", status: "running" });
      const plan = await planQuery(normalizedQuestion, projectContext, {
        providerId,
        modelId,
        reasoningEffort,
        onEvent: (event) => {
          const patch = progressFromModelEvent(event, "planning");
          if (patch) setTurnProgress(clientRequestId, patch);
        },
      });
      setTurnProgress(clientRequestId, {
        phase: "searching",
        query: plan.search_query,
        thinking: null,
      });
      const [search, web] = await Promise.all([
        venueSearcher({
          query: plan.search_query,
          queries: plan.search_queries ?? [plan.search_query],
          fromYear: plan.from_year ?? null,
          limit: SEARCH_RESULT_LIMIT,
          fetchImpl,
          mailto,
        }),
        webDiscovery(plan.search_query),
      ]);
      setTurnProgress(clientRequestId, { phase: "recommending" });
      const recommendation = await recommend(
        normalizedQuestion,
        projectContext,
        search.papers,
        web.results,
        {
          providerId,
          modelId,
          reasoningEffort,
          onEvent: (event) => {
            const patch = progressFromModelEvent(event, "recommending");
            if (patch) setTurnProgress(clientRequestId, patch);
          },
        },
      );
      // 把标题/摘要里的英文翻成中文（尽力而为）。
      setTurnProgress(clientRequestId, { phase: "translating" });
      const recommendedTitleZh = new Map(
        (recommendation.recommendations ?? [])
          .filter((item) => item.title_zh)
          .map((item) => [item.paper_id, item.title_zh]),
      );
      const translations = await translateDiscoveries({
        papers: search.papers,
        webResults: web.results,
        onEvent: (event) => {
          const patch = progressFromModelEvent(event, "translating");
          if (patch) setTurnProgress(clientRequestId, patch);
        },
      });
      const translatedPapers = search.papers.map((paper, index) => {
        const titleZh = recommendedTitleZh.get(paper.paper_id)
          ?? translations.titles.get(index)
          ?? paper.title_zh
          ?? null;
        return titleZh ? { ...paper, title_zh: titleZh } : paper;
      });
      const translatedWeb = web.results.map((item, index) => {
        const next = { ...item };
        const titleZh = translations.webTitles.get(index);
        const excerptZh = translations.webExcerpts.get(index);
        if (titleZh) next.title_zh = titleZh;
        if (excerptZh) next.excerpt_zh = excerptZh;
        return next;
      });
      const turn = {
        turn_id: `vs-${idFactory().slice(0, 12)}`,
        client_request_id: clientRequestId,
        question: normalizedQuestion,
        status: "complete",
        created_at: startedAt,
        completed_at: now().toISOString(),
        plan: {
          search_query: plan.search_query,
          search_queries: plan.search_queries ?? [plan.search_query],
          from_year: plan.from_year ?? null,
          source: plan.source,
          provider_id: plan.provider_id ?? null,
          model_id: plan.model_id ?? null,
          usage: plan.usage ?? null,
          error: plan.error ?? null,
        },
        search: {
          venues: search.venues,
          venue_success_count: search.venue_success_count,
          venue_failed_ids: search.venue_failed_ids,
          total_found: search.total_found,
          truncated: search.truncated,
        },
        papers: translatedPapers,
        web: {
          status: web.status,
          provider: web.provider,
          results: translatedWeb,
          error: web.error,
        },
        answer: recommendation.answer,
        recommendations: recommendation.recommendations,
        recommendation_source: recommendation.source,
        provider_id: recommendation.provider_id ?? null,
        model_id: recommendation.model_id ?? null,
        usage: recommendation.usage ?? null,
        recommendation_error: recommendation.error ?? null,
        added_paper_ids: [],
      };
      const current = await readStore();
      let conv = resolveTarget(current, conversationId);
      const created = !conv;
      if (!conv) conv = newConversation(deriveConversationTitle(normalizedQuestion));
      const updatedConv = {
        ...conv,
        title: conv.turns.length === 0
          ? deriveConversationTitle(normalizedQuestion)
          : conv.title,
        turns: [...conv.turns, turn].slice(-MAX_TURNS),
        updated_at: turn.completed_at,
      };
      const conversations = created
        ? [updatedConv, ...current.conversations].slice(0, MAX_CONVERSATIONS)
        : current.conversations.map(
            (item) => item.conversation_id === updatedConv.conversation_id ? updatedConv : item,
          );
      await writeStore({
        schema_version: 2,
        active_conversation_id: updatedConv.conversation_id,
        conversations,
      });
      return conversationView(updatedConv);
    })();
    try {
      const result = await inFlight;
      setTurnProgress(clientRequestId, { phase: "done", status: "complete" });
      return result;
    } catch (error) {
      setTurnProgress(clientRequestId, { phase: "failed", status: "failed" });
      throw error;
    } finally {
      inFlight = null;
    }
  }

  async function markPapersAdded(conversationId, turnId, paperIds) {
    const store = await readStore();
    const conv = resolveTarget(store, conversationId);
    if (!conv) {
      throw new VenueSearchServiceError(
        "VENUE_SEARCH_CONVERSATION_NOT_FOUND",
        "检索会话不存在",
        404,
      );
    }
    const updatedConv = {
      ...conv,
      turns: conv.turns.map((turn) => turn.turn_id === turnId
        ? {
            ...turn,
            added_paper_ids: [...new Set([...(turn.added_paper_ids ?? []), ...paperIds])],
          }
        : turn),
      updated_at: now().toISOString(),
    };
    const conversations = store.conversations.map(
      (item) => item.conversation_id === updatedConv.conversation_id ? updatedConv : item,
    );
    await writeStore({
      schema_version: 2,
      active_conversation_id: store.active_conversation_id,
      conversations,
    });
    return conversationView(updatedConv);
  }

  function getTurn(conversation, turnId) {
    const turn = conversation.turns.find((item) => item.turn_id === turnId);
    if (!turn) {
      throw new VenueSearchServiceError(
        "VENUE_SEARCH_TURN_NOT_FOUND",
        "检索记录不存在",
        404,
      );
    }
    return turn;
  }

  return Object.freeze({
    listConversations,
    getConversation,
    createConversation,
    deleteConversation,
    submitTurn,
    getTurnProgress,
    markPapersAdded,
    getTurn,
  });
}
