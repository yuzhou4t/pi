import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promptRegistry } from "../promptRegistry.js";
import { searchRegisteredVenues } from "./venueSearch.js";

const CONVERSATION_ID = "topic-search";
const MAX_TURNS = 30;
const MAX_QUESTION_CHARS = 500;
const MAX_RECOMMEND_INPUTS = 12;
const MAX_ABSTRACT_CHARS = 500;
const SEARCH_RESULT_LIMIT = 12;

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

function emptyConversation() {
  return {
    schema_version: 1,
    conversation_id: CONVERSATION_ID,
    turns: [],
    updated_at: null,
  };
}

function recommendInput(question, projectContext, papers) {
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
    const reason = compact(item?.reason);
    const projectImpact = compact(item?.project_impact);
    if (
      !known.has(paperId)
      || seen.has(paperId)
      || reason.length < 12
      || reason.length > 300
      || projectImpact.length < 4
      || projectImpact.length > 260
    ) {
      throw new Error("VENUE_SEARCH_RECOMMENDATIONS_INVALID");
    }
    seen.add(paperId);
    return { paper_id: paperId, reason, project_impact: projectImpact };
  });
  return { answer, recommendations };
}

export function deterministicRecommendation(question, papers) {
  const top = papers.slice(0, 5);
  const answer = top.length > 0
    ? `按「${compact(question, 60)}」在注册刊物范围内检索到 ${papers.length} 篇相关论文，`
      + "已按检索相关度与引用记录列出最值得关注的几篇；推荐理由基于题录与摘要，具体结论待全文核验。"
    : `按「${compact(question, 60)}」在注册刊物范围内没有检索到足够相关的论文，可尝试更具体的英文关键词。`;
  return {
    answer,
    recommendations: top.map((paper) => ({
      paper_id: paper.paper_id,
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
  fetchImpl = globalThis.fetch,
  modelProviders = null,
  modelMode = "fixture",
  projectContextReader = null,
  venueSearcher = searchRegisteredVenues,
  mailto = "",
  now = () => new Date(),
  idFactory = randomUUID,
} = {}) {
  if (typeof dataDir !== "string" || !dataDir.trim()) {
    throw new TypeError("dataDir is required");
  }
  const statePath = path.resolve(dataDir, "venue-search", "conversation.json");
  let inFlight = null;

  async function readConversation() {
    try {
      const state = JSON.parse(await readFile(statePath, "utf8"));
      if (state?.schema_version === 1 && Array.isArray(state.turns)) return state;
      return emptyConversation();
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) {
        return emptyConversation();
      }
      throw error;
    }
  }

  async function getConversation() {
    return readConversation();
  }

  async function planQuery(question, projectContext, { providerId, modelId, reasoningEffort }) {
    const fallback = {
      search_query: compact(question, 200),
      from_year: null,
      source: "deterministic",
      usage: null,
    };
    if (modelMode !== "live" || !modelProviders?.completeStructured) return fallback;
    const prompt = promptRegistry.loadPrompt("venue-search-plan");
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
      });
      const searchQuery = compact(generated.value?.search_query, 200);
      if (searchQuery.length < 3) throw new Error("VENUE_SEARCH_PLAN_INVALID");
      return {
        search_query: searchQuery,
        from_year: Number.isInteger(generated.value?.from_year)
          ? generated.value.from_year
          : null,
        source: "model",
        provider_id: generated.provider_id,
        model_id: generated.model_id,
        usage: generated.usage ?? null,
      };
    } catch (error) {
      return { ...fallback, source: "deterministic_fallback", error: publicError(error) };
    }
  }

  async function recommend(question, projectContext, papers, { providerId, modelId, reasoningEffort }) {
    const pool = papers.slice(0, MAX_RECOMMEND_INPUTS);
    if (modelMode !== "live" || !modelProviders?.completeStructured || pool.length === 0) {
      return {
        ...deterministicRecommendation(question, pool),
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
        input: recommendInput(question, projectContext, pool),
        schema: prompt.schema,
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
        ...deterministicRecommendation(question, pool),
        source: "deterministic_fallback",
        usage: null,
        error: publicError(error),
      };
    }
  }

  async function submitTurn({
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
    const existing = await readConversation();
    const replay = existing.turns.find(
      (turn) => turn.client_request_id === clientRequestId,
    );
    if (replay) return existing;
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
      const plan = await planQuery(normalizedQuestion, projectContext, {
        providerId,
        modelId,
        reasoningEffort,
      });
      const search = await venueSearcher({
        query: plan.search_query,
        fromYear: plan.from_year ?? null,
        limit: SEARCH_RESULT_LIMIT,
        fetchImpl,
        mailto,
      });
      const recommendation = await recommend(
        normalizedQuestion,
        projectContext,
        search.papers,
        { providerId, modelId, reasoningEffort },
      );
      const turn = {
        turn_id: `vs-${idFactory().slice(0, 12)}`,
        client_request_id: clientRequestId,
        question: normalizedQuestion,
        status: "complete",
        created_at: startedAt,
        completed_at: now().toISOString(),
        plan: {
          search_query: plan.search_query,
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
        papers: search.papers,
        answer: recommendation.answer,
        recommendations: recommendation.recommendations,
        recommendation_source: recommendation.source,
        provider_id: recommendation.provider_id ?? null,
        model_id: recommendation.model_id ?? null,
        usage: recommendation.usage ?? null,
        recommendation_error: recommendation.error ?? null,
        added_paper_ids: [],
      };
      const current = await readConversation();
      const next = {
        ...current,
        turns: [...current.turns, turn].slice(-MAX_TURNS),
        updated_at: turn.completed_at,
      };
      await writeJsonAtomic(statePath, next);
      return next;
    })();
    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  }

  async function markPapersAdded(turnId, paperIds) {
    const current = await readConversation();
    const next = {
      ...current,
      turns: current.turns.map((turn) => turn.turn_id === turnId
        ? {
            ...turn,
            added_paper_ids: [...new Set([...(turn.added_paper_ids ?? []), ...paperIds])],
          }
        : turn),
      updated_at: now().toISOString(),
    };
    await writeJsonAtomic(statePath, next);
    return next;
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
    getConversation,
    submitTurn,
    markPapersAdded,
    getTurn,
  });
}
