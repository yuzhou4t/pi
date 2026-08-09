import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeSearchQuery,
  searchRegisteredVenues,
} from "./venueSearch.js";

const journal = {
  source_id: "journal-ai",
  short_name: "AI",
  venue: "Artificial Intelligence",
  source_type: "journal",
  type: "journal",
  dblp_path: "journals/ai",
  openalex_source_id: "S196139623",
};

const conference = {
  source_id: "conference-iclr",
  short_name: "ICLR",
  venue: "International Conference on Learning Representations",
  source_type: "conference",
  type: "conference",
  dblp_path: "conf/iclr",
};

function openAlexResponse(results) {
  return new Response(JSON.stringify({ meta: { count: results.length }, results }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function dblpResponse(hits) {
  return new Response(JSON.stringify({
    result: { hits: { "@total": String(hits.length), hit: hits } },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

test("empty query is rejected before any network call", () => {
  assert.throws(() => normalizeSearchQuery("   "), /检索问题不能为空/);
  assert.equal(normalizeSearchQuery("  llm   agent  "), "llm agent");
});

test("registered venue search batches DBLP history once and classifies hits by venue key", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    const target = new URL(url);
    calls.push(target);
    if (target.hostname === "api.openalex.org") {
      return openAlexResponse([{
        id: "https://openalex.org/W1",
        title: "Reliable Language Agents",
        publication_date: "2026-02-01",
        doi: "https://doi.org/10.1000/agent",
        cited_by_count: 12,
        relevance_score: 40.5,
        abstract_inverted_index: { Reliable: [0], agents: [1] },
        authorships: [{ author: { display_name: "A. Author" } }],
        primary_location: {
          source: { id: "https://openalex.org/S196139623", display_name: "Artificial Intelligence" },
          landing_page_url: "https://example.org/ai/agent",
        },
      }]);
    }
    return dblpResponse([{
      info: {
        title: "AgentOccam: A Strong Baseline for LLM Web Agents.",
        year: "2025",
        venue: "ICLR",
        key: "conf/iclr/agentoccam25",
        doi: "10.1000/iclr-agent",
        ee: "https://openreview.net/forum?id=abc",
        authors: { author: [{ text: "B. Writer" }, { text: "C. Coder" }] },
      },
    }]);
  };

  const result = await searchRegisteredVenues({
    query: "llm agent",
    sources: [journal, conference],
    fetchImpl,
    enrich: false,
    observedAt: "2026-07-29T08:00:00.000Z",
  });

  const openAlexCall = calls.find((call) => call.hostname === "api.openalex.org");
  assert.ok(openAlexCall.searchParams.get("filter").includes("primary_location.source.id:S196139623"));
  assert.equal(openAlexCall.searchParams.get("search"), "llm agent");
  const dblpCall = calls.find((call) => call.hostname === "dblp.org");
  assert.equal(dblpCall.searchParams.get("q"), "llm agent");
  assert.equal(calls.filter((call) => call.pathname === "/search/publ/api").length, 1);

  assert.equal(result.papers.length, 2);
  assert.equal(result.venue_success_count, 2);
  assert.equal(result.venue_reached_count, 2);
  assert.equal(result.venue_matched_count, 2);
  assert.deepEqual(result.venue_failed_ids, []);
  // OpenAlex relevance ranks the journal hit ahead of the zero-relevance DBLP hit.
  assert.equal(result.papers[0].discovery_channel, "openalex-search");
  assert.equal(result.papers[0].abstract, "Reliable agents");
  assert.equal(result.papers[0].search_rank, 1);
  const iclr = result.papers.find((paper) => paper.discovery_channel === "dblp-search");
  assert.equal(iclr.source_id, "conference-iclr");
  assert.equal(iclr.pdf_url, "https://openreview.net/pdf?id=abc");
});

test("a successful shared DBLP query marks unmatched venues reachable", async () => {
  const fetchImpl = async (url) => {
    const target = new URL(url);
    if (target.hostname === "api.openalex.org") {
      return new Response("upstream down", { status: 503 });
    }
    return dblpResponse([{
      info: {
        title: "Agentic Planning at ICLR.",
        year: "2026",
        venue: "ICLR",
        key: "conf/iclr/plan26",
        ee: "https://openreview.net/forum?id=xyz",
        authors: { author: { text: "Solo Author" } },
      },
    }]);
  };

  const result = await searchRegisteredVenues({
    query: "planning",
    sources: [journal, conference],
    fetchImpl,
    enrich: false,
    observedAt: "2026-07-29T08:00:00.000Z",
  });

  const journalStatus = result.venues.find((venue) => venue.source_id === "journal-ai");
  assert.equal(journalStatus.status, "empty");
  assert.equal(journalStatus.error, null);
  assert.deepEqual(result.venue_failed_ids, []);
  assert.equal(result.venue_reached_count, 2);
  assert.equal(result.papers.length, 1);
  assert.equal(result.papers[0].source_id, "conference-iclr");
});

test("a failed OpenAlex journal search falls back to its historical DBLP stream", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    const target = new URL(url);
    calls.push(target);
    if (target.hostname === "api.openalex.org") {
      return new Response("rate limited", { status: 429 });
    }
    return dblpResponse([{
      info: {
        title: "Architectures for Tool-Using Agents.",
        year: "2022",
        venue: "Artificial Intelligence",
        key: "journals/ai/tool-agents22",
        doi: "10.1000/tool-agents",
        ee: "https://doi.org/10.1000/tool-agents",
        authors: { author: { text: "Historical Author" } },
      },
    }]);
  };

  const result = await searchRegisteredVenues({
    query: "agent scaffold",
    sources: [journal],
    fetchImpl,
    enrich: false,
    observedAt: "2026-08-04T08:00:00.000Z",
  });

  const dblpCalls = calls.filter((call) => call.pathname === "/search/publ/api");
  assert.equal(dblpCalls.length, 1);
  assert.equal(dblpCalls[0].searchParams.get("q"), "agent scaffold");
  assert.equal(result.venue_reached_count, 1);
  assert.equal(result.venue_matched_count, 1);
  assert.deepEqual(result.venue_failed_ids, []);
  assert.equal(result.papers[0].published_at, "2022");
  assert.equal(result.papers[0].discovery_channel, "dblp-search");
  assert.equal(result.papers[0].paper_type, "journal-article");
});

test("a reachable source with no historical match is not reported as failed", async () => {
  const fetchImpl = async (url) => {
    const target = new URL(url);
    if (target.hostname === "api.openalex.org") return openAlexResponse([]);
    return dblpResponse([]);
  };

  const result = await searchRegisteredVenues({
    query: "no matching topic",
    sources: [journal],
    fetchImpl,
    enrich: false,
    observedAt: "2026-08-04T08:00:00.000Z",
  });

  assert.equal(result.venues[0].status, "empty");
  assert.equal(result.venue_reached_count, 1);
  assert.equal(result.venue_matched_count, 0);
  assert.deepEqual(result.venue_failed_ids, []);
});

test("multi-query expansion merges hits, dedupes by identity, and unions venue success", async () => {
  const openAlexByQuery = {
    "llm agent memory": [{
      id: "https://openalex.org/W1",
      title: "Memory Mechanisms for Language Agents",
      publication_date: "2026-02-01",
      doi: "https://doi.org/10.1000/mem",
      cited_by_count: 20,
      relevance_score: 50,
      authorships: [{ author: { display_name: "A. Author" } }],
      primary_location: {
        source: { id: "https://openalex.org/S196139623", display_name: "Artificial Intelligence" },
      },
    }],
    "retrieval augmented agents": [
      {
        // 与第一个查询命中同一篇（相同 DOI），应被去重。
        id: "https://openalex.org/W1",
        title: "Memory Mechanisms for Language Agents",
        publication_date: "2026-02-01",
        doi: "https://doi.org/10.1000/mem",
        cited_by_count: 20,
        relevance_score: 50,
        authorships: [{ author: { display_name: "A. Author" } }],
        primary_location: {
          source: { id: "https://openalex.org/S196139623", display_name: "Artificial Intelligence" },
        },
      },
      {
        id: "https://openalex.org/W2",
        title: "Retrieval-Augmented Planning",
        publication_date: "2026-03-01",
        doi: "https://doi.org/10.1000/rag",
        cited_by_count: 8,
        relevance_score: 30,
        authorships: [{ author: { display_name: "D. Researcher" } }],
        primary_location: {
          source: { id: "https://openalex.org/S196139623", display_name: "Artificial Intelligence" },
        },
      },
    ],
  };
  const fetchImpl = async (url) => {
    const target = new URL(url);
    if (target.hostname === "api.openalex.org") {
      const search = target.searchParams.get("search");
      return openAlexResponse(openAlexByQuery[search] ?? []);
    }
    return dblpResponse([]);
  };

  const result = await searchRegisteredVenues({
    queries: ["llm agent memory", "retrieval augmented agents", "llm agent memory"],
    sources: [journal],
    fetchImpl,
    enrich: false,
    observedAt: "2026-07-31T08:00:00.000Z",
  });

  // 两个去重后的唯一论文；同 DOI 命中不重复计入。
  assert.equal(result.papers.length, 2);
  assert.deepEqual(result.queries, ["llm agent memory", "retrieval augmented agents"]);
  const journalStatus = result.venues.find((venue) => venue.source_id === "journal-ai");
  assert.equal(journalStatus.status, "success");
});
