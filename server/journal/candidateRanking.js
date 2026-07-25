import { promptRegistry } from "../promptRegistry.js";

const MAX_RANKING_INPUTS = 8;
const MAX_ABSTRACT_CHARS = 500;

function compact(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.trim().replaceAll(/\s+/g, " ").slice(0, maxLength);
}

function scorePaper(paper) {
  const topicScore = Math.min(Array.isArray(paper.topic_matches) ? paper.topic_matches.length : 0, 5) * 20;
  const citationScore = Number.isFinite(paper.cited_by_count)
    ? Math.min(35, Math.log10(Math.max(1, paper.cited_by_count)) * 12)
    : 0;
  const evidenceScore = (paper.abstract ? 10 : 0) + (paper.pdf_url ? 40 : 0);
  const originScore = paper.candidate_origin === "weekly_scan" ? 30 : 0;
  return topicScore + citationScore + evidenceScore + originScore;
}

export function prepareRankingPool(papers, limit = MAX_RANKING_INPUTS) {
  if (!Array.isArray(papers) || papers.length === 0) return [];
  return papers
    .map((paper, index) => ({ paper, index, score: scorePaper(paper) }))
    .sort((left, right) => (
      right.score - left.score
      || left.index - right.index
      || String(left.paper.paper_id).localeCompare(String(right.paper.paper_id))
    ))
    .slice(0, limit)
    .map(({ paper }) => paper);
}

function rankingInput(papers, projectContext) {
  return {
    project: {
      goal: compact(projectContext?.goal, 400),
      decisions: (projectContext?.decisions ?? []).slice(0, 4).map((item) => compact(item, 200)),
      open_questions: (projectContext?.open_questions ?? projectContext?.openQuestions ?? [])
        .slice(0, 4)
        .map((item) => compact(item, 200)),
      next_action: compact(projectContext?.next_action ?? projectContext?.nextAction, 200),
    },
    papers: papers.map((paper) => ({
      paper_id: paper.paper_id,
      origin: paper.candidate_origin,
      title: compact(paper.title, 500),
      authors: (paper.authors ?? []).slice(0, 5),
      venue: compact(paper.venue, 200),
      published_at: compact(paper.published_at, 40),
      abstract: compact(paper.abstract, MAX_ABSTRACT_CHARS) || "当前来源未提供摘要，仅可依据题录初筛。",
      topic_matches: (paper.topic_matches ?? []).slice(0, 8),
      heat_signals: (paper.heat_signals ?? []).slice(0, 3),
      evidence_scope: compact(paper.evidence_scope, 160),
      pdf_available: Boolean(paper.pdf_url),
    })),
  };
}

function validateRanking(value, papers) {
  const expectedCount = Math.min(5, papers.length);
  if (!Array.isArray(value?.items) || value.items.length !== expectedCount) {
    throw new Error(`RANKING_OUTPUT_COUNT_${expectedCount}`);
  }
  const byId = new Map(papers.map((paper) => [paper.paper_id, paper]));
  const ids = new Set();
  const ranks = new Set();
  const normalized = value.items.map((item) => {
    const paperId = typeof item?.paper_id === "string" ? item.paper_id.trim() : "";
    const selectionSummary = typeof item?.selection_summary === "string" ? item.selection_summary.trim() : "";
    const projectImpact = typeof item?.project_impact === "string" ? item.project_impact.trim() : "";
    if (
      !byId.has(paperId)
      || ids.has(paperId)
      || !Number.isInteger(item?.rank)
      || item.rank < 1
      || item.rank > expectedCount
      || ranks.has(item.rank)
      || selectionSummary.length < 12
      || selectionSummary.length > 220
      || projectImpact.length < 4
      || projectImpact.length > 260
    ) {
      throw new Error("RANKING_OUTPUT_INVALID");
    }
    ids.add(paperId);
    ranks.add(item.rank);
    return {
      ...byId.get(paperId),
      rank: item.rank,
      selection_summary: selectionSummary,
      project_impact: projectImpact,
    };
  });
  return normalized.sort((left, right) => left.rank - right.rank);
}

export function deterministicCandidateRanking(papers) {
  return prepareRankingPool(papers, 5).map((paper, index) => ({
    ...paper,
    rank: index + 1,
    selection_summary: compact(
      paper.selection_summary
        || paper.abstract
        || `${paper.title}：当前只有题录信息，仍需全文核验。`,
      220,
    ),
    project_impact: compact(
      paper.project_impact
        || paper.relevance_reason
        || "与当前项目主题相关；具体作用需要在全文解析后核验。",
      260,
    ),
  }));
}

export async function rankCandidates({
  papers,
  projectContext,
  providerId,
  modelId,
  modelProviders,
  modelMode = "live",
} = {}) {
  const pool = prepareRankingPool(papers);
  if (pool.length === 0) throw new Error("RANKING_INPUT_EMPTY");
  const prompt = promptRegistry.loadPrompt("candidate-ranking");
  const input = rankingInput(pool, projectContext);
  const inputChars = JSON.stringify(input).length;
  const inputHash = promptRegistry.createInputHash({
    promptId: "candidate-ranking",
    input,
    modelSettings: { provider_id: providerId, model_id: modelId },
  });
  if (modelMode !== "live") {
    return {
      candidates: deterministicCandidateRanking(pool),
      source: "deterministic",
      prompt_id: prompt.id,
      prompt_version: prompt.version,
      prompt_hash: prompt.prompt_hash,
      input_hash: inputHash,
      input_paper_count: pool.length,
      input_chars: inputChars,
      usage: null,
    };
  }
  if (!modelProviders?.completeStructured) throw new Error("MODEL_PROVIDER_REQUIRED");
  const generated = await modelProviders.completeStructured({
    providerId,
    modelId,
    system: prompt.system,
    prompt: prompt.body,
    input,
    schema: prompt.schema,
  });
  return {
    candidates: validateRanking(generated.value, pool),
    source: "model",
    prompt_id: prompt.id,
    prompt_version: prompt.version,
    prompt_hash: prompt.prompt_hash,
    input_hash: inputHash,
    input_paper_count: pool.length,
    input_chars: inputChars,
    provider_id: generated.provider_id,
    model_id: generated.model_id,
    operation_id: generated.operation_id,
    usage: generated.usage,
  };
}
