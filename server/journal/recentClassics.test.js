import assert from "node:assert/strict";
import test from "node:test";
import {
  RECENT_CLASSIC_LABEL,
  collectExclusionKeys,
  fetchRecentClassics,
} from "./recentClassics.js";

const SOURCES = [
  {
    source_id: "conference-neurips",
    venue: "Conference on Neural Information Processing Systems",
    source_type: "conference",
    openalex_source_id: "S4306420609",
  },
  {
    source_id: "conference-cvpr",
    venue: "IEEE/CVF Conference on Computer Vision and Pattern Recognition",
    source_type: "conference",
  },
];

function work({
  id,
  title,
  cites,
  sourceId = "S4306420609",
  date = "2024-05-01",
  abstractTerms = ["LLM", "agent", "planning"],
}) {
  return {
    id: `https://openalex.org/${id}`,
    title,
    publication_date: date,
    doi: `https://doi.org/10.1000/${id}`,
    cited_by_count: cites,
    abstract_inverted_index: Object.fromEntries(
      abstractTerms.map((term, index) => [term, [index]]),
    ),
    authorships: [{ author: { display_name: "A. Author" } }],
    primary_location: {
      source: { id: `https://openalex.org/sources/${sourceId}` },
      landing_page_url: `https://example.org/${id}`,
    },
    best_oa_location: { pdf_url: `https://example.org/${id}.pdf` },
  };
}

test("fetchRecentClassics returns topic-relevant high-citation papers with honest coverage", async () => {
  let requestedUrl = null;
  const result = await fetchRecentClassics({
    sources: SOURCES,
    observedAt: "2026-07-30T08:00:00.000Z",
    limit: 2,
    fetchImpl: async (url) => {
      requestedUrl = new URL(url);
      return {
        ok: true,
        json: async () => ({
          results: [
            work({ id: "W1", title: "LLM Agent Planning Benchmarks", cites: 900 }),
            work({ id: "W2", title: "Tool-Augmented LLM Agents", cites: 500 }),
            work({ id: "W3", title: "Language Agent Memory Systems", cites: 300 }),
          ],
        }),
      };
    },
  });
  assert.equal(result.status, "success");
  assert.equal(result.from_year, 2022);
  assert.ok(requestedUrl.searchParams.get("filter").includes("S4306420609"));
  assert.ok(requestedUrl.searchParams.get("filter").includes("from_publication_date:2022-01-01"));
  assert.equal(requestedUrl.searchParams.get("sort"), "cited_by_count:desc");
  assert.equal(requestedUrl.searchParams.get("cursor"), "*");
  assert.equal(result.papers.length, 2);
  assert.equal(result.papers[0].cited_by_count, 900);
  assert.equal(result.papers[0].display_label, RECENT_CLASSIC_LABEL);
  assert.equal(result.papers[0].candidate_origin, "recent_classic");
  assert.equal(result.papers[0].published_this_month, false);
  assert.deepEqual(result.covered_source_ids, ["conference-neurips"]);
  assert.deepEqual(result.uncovered_source_ids, ["conference-cvpr"]);
});

test("fetchRecentClassics follows the cursor and fills with broader AI/ML papers", async () => {
  const requestedCursors = [];
  const result = await fetchRecentClassics({
    sources: SOURCES,
    observedAt: "2026-07-30T08:00:00.000Z",
    limit: 3,
    fetchImpl: async (url) => {
      const cursor = new URL(url).searchParams.get("cursor");
      requestedCursors.push(cursor);
      return {
        ok: true,
        json: async () => cursor === "*"
          ? {
              results: [work({
                id: "W1",
                title: "LLM Agent Planning Benchmarks",
                cites: 900,
              })],
              meta: { next_cursor: "cursor-2" },
            }
          : {
              results: [
                work({
                  id: "W2",
                  title: "Robust Reinforcement Learning",
                  cites: 800,
                  abstractTerms: ["reinforcement learning", "robustness"],
                }),
                work({
                  id: "W3",
                  title: "Multimodal Representation Learning",
                  cites: 700,
                  abstractTerms: ["multimodal", "representation learning"],
                }),
              ],
              meta: { next_cursor: null },
            },
      };
    },
  });
  assert.deepEqual(requestedCursors, ["*", "cursor-2"]);
  assert.equal(result.papers.length, 3);
  assert.equal(result.papers[0].title, "LLM Agent Planning Benchmarks");
  assert.equal(result.papers[0].candidate_scope, undefined);
  assert.equal(result.papers[1].candidate_scope, "field");
  assert.equal(result.next_cursor, null);
  assert.equal(result.pages_fetched, 2);
});

test("fetchRecentClassics excludes read, collected, and dismissed identities", async () => {
  const first = await fetchRecentClassics({
    sources: SOURCES,
    observedAt: "2026-07-30T08:00:00.000Z",
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        results: [work({ id: "W1", title: "LLM Agent Planning Benchmarks", cites: 900 })],
      }),
    }),
  });
  const paper = first.papers[0];
  const excludeKeys = collectExclusionKeys({
    previousRuns: [{
      run_id: "run-1",
      candidates: [paper],
      paper_decisions: { [paper.paper_id]: "read" },
    }],
  });
  const second = await fetchRecentClassics({
    sources: SOURCES,
    observedAt: "2026-07-30T08:00:00.000Z",
    excludeKeys,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        results: [work({ id: "W1", title: "LLM Agent Planning Benchmarks", cites: 900 })],
      }),
    }),
  });
  assert.equal(second.papers.length, 0);

  const dismissedKeys = collectExclusionKeys({ dismissedKeys: [paper.dedupe_key] });
  const third = await fetchRecentClassics({
    sources: SOURCES,
    observedAt: "2026-07-30T08:00:00.000Z",
    excludeKeys: dismissedKeys,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        results: [work({ id: "W1", title: "LLM Agent Planning Benchmarks", cites: 900 })],
      }),
    }),
  });
  assert.equal(third.papers.length, 0);
});

test("collectExclusionKeys keeps unhandled past candidates eligible", () => {
  const keys = collectExclusionKeys({
    previousRuns: [{
      run_id: "run-1",
      candidates: [
        { paper_id: "a", dedupe_key: "key-a" },
        { paper_id: "b", dedupe_key: "key-b" },
      ],
      paper_decisions: { a: "collect" },
    }],
  });
  assert.equal(keys.has("key:key-a"), true);
  assert.equal(keys.has("key:key-b"), false);
});

test("fetchRecentClassics fails soft on HTTP errors", async () => {
  const result = await fetchRecentClassics({
    sources: SOURCES,
    observedAt: "2026-07-30T08:00:00.000Z",
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "OPENALEX_HTTP_503");
  assert.deepEqual(result.papers, []);
});
