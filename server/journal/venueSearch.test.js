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

test("registered venue search restricts journals to OpenAlex source filter and conferences to DBLP stream", async () => {
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
  assert.match(dblpCall.searchParams.get("q"), /streamid:conf\/iclr:/);

  assert.equal(result.papers.length, 2);
  assert.equal(result.venue_success_count, 2);
  assert.deepEqual(result.venue_failed_ids, []);
  // OpenAlex relevance ranks the journal hit ahead of the zero-relevance DBLP hit.
  assert.equal(result.papers[0].discovery_channel, "openalex-search");
  assert.equal(result.papers[0].abstract, "Reliable agents");
  assert.equal(result.papers[0].search_rank, 1);
  const iclr = result.papers.find((paper) => paper.discovery_channel === "dblp-search");
  assert.equal(iclr.source_id, "conference-iclr");
  assert.equal(iclr.pdf_url, "https://openreview.net/pdf?id=abc");
});

test("a failed venue stays visible without discarding other venues' results", async () => {
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
  assert.equal(journalStatus.status, "failed");
  assert.equal(journalStatus.error.code, "OPENALEX_HTTP_503");
  assert.equal(journalStatus.error.retryable, true);
  assert.deepEqual(result.venue_failed_ids, ["journal-ai"]);
  assert.equal(result.papers.length, 1);
  assert.equal(result.papers[0].source_id, "conference-iclr");
});
