import assert from "node:assert/strict";
import test from "node:test";
import {
  deterministicCandidateRanking,
  prepareRankingPool,
  rankCandidates,
} from "./candidateRanking.js";

function papers(count = 6) {
  return Array.from({ length: count }, (_, index) => ({
    paper_id: `paper-${index + 1}`,
    title: `Agent paper ${index + 1}`,
    authors: ["A. Author"],
    venue: "ACL",
    published_at: "2026-07-01",
    abstract: `A verifiable agent workflow study ${index + 1}.`,
    topic_matches: index === 5 ? [] : ["LLM Agent"],
    heat_signals: [],
    evidence_scope: "摘要",
    candidate_origin: index === 4 ? "classic_review" : "weekly_scan",
    is_new: index !== 4,
    pdf_url: `https://papers.example/${index + 1}.pdf`,
  }));
}

test("deterministic ranking keeps five papers and never rewrites origin", () => {
  const result = deterministicCandidateRanking(papers());
  assert.equal(result.length, 5);
  assert.equal(result.every((paper) => paper.candidate_origin), true);
  assert.deepEqual(result.map((paper) => paper.rank), [1, 2, 3, 4, 5]);
});

test("ranking pool favors topic-matched new papers", () => {
  const pool = prepareRankingPool(papers(), 2);
  assert.deepEqual(pool.map((paper) => paper.paper_id), ["paper-1", "paper-2"]);
});

test("model ranking sends one bounded prompt and merges only generated display fields", async () => {
  const inputPapers = papers(5);
  let request;
  const result = await rankCandidates({
    papers: inputPapers,
    projectContext: { goal: "Build a small workflow player" },
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
    modelProviders: {
      completeStructured: async (value) => {
        request = value;
        return {
          value: {
            items: inputPapers.map((paper, index) => ({
              paper_id: paper.paper_id,
              rank: index + 1,
              title_zh: `论文 ${index + 1} 的中文标题`,
              selection_summary: `这是论文 ${index + 1} 的简短选择说明，需要全文继续核验。`,
              project_impact: "用于检验工作流设计。",
            })),
          },
          provider_id: "deepseek",
          model_id: "deepseek-v4-flash",
          operation_id: "operation-1",
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      },
    },
  });
  assert.equal(result.candidates.length, 5);
  assert.equal(result.candidates[0].title_zh, "论文 1 的中文标题");
  assert.equal(result.candidates[4].candidate_origin, "classic_review");
  assert.equal(request.input.papers.length, 5);
  assert.equal(request.input.papers[0].abstract.length <= 500, true);
  assert.equal(request.input.papers[0].pdf_available, true);
  assert.equal(result.input_paper_count, 5);
  assert.ok(result.input_chars < 5000);
  assert.match(result.prompt_hash, /^sha256:/);
});

test("model ranking rejects duplicate or unknown paper ids", async () => {
  const inputPapers = papers(5);
  await assert.rejects(rankCandidates({
    papers: inputPapers,
    projectContext: {},
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
    modelProviders: {
      completeStructured: async () => ({
        value: {
          items: Array.from({ length: 5 }, (_, index) => ({
            paper_id: "paper-1",
            rank: index + 1,
            title_zh: "重复论文的中文标题",
            selection_summary: "这是一条足够长的论文选择摘要，需要进一步核验。",
            project_impact: "用于检验工作流设计。",
          })),
        },
      }),
    },
  }), /RANKING_OUTPUT_INVALID/);
});
