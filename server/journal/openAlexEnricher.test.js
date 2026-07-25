import assert from "node:assert/strict";
import test from "node:test";
import {
  enrichPaperWithOpenAlex,
  restoreOpenAlexAbstract,
} from "./openAlexEnricher.js";

test("abstract inverted indexes are restored in source order", () => {
  assert.equal(restoreOpenAlexAbstract({
    verifiable: [2],
    "Agent": [0],
    memory: [1],
  }), "Agent memory verifiable");
});

test("OpenAlex enrichment adds abstract, citation signal, and an OA PDF without replacing DBLP identity", async () => {
  const paper = {
    paper_id: "conf/test/Test26",
    doi: "10.1000/test",
    title: "Original title",
    abstract: "",
    published_at: "2026-01-01",
    pdf_url: null,
    pdf_candidates: [],
    evidence_scope: "DBLP 题录",
  };
  const enriched = await enrichPaperWithOpenAlex(paper, {
    fetchImpl: async (url) => {
      assert.match(url.toString(), /filter=doi/);
      return new Response(JSON.stringify({
        results: [{
          title: "Untrusted replacement",
          publication_date: "2026-03-04",
          cited_by_count: 42,
          abstract_inverted_index: { Useful: [0], evidence: [1] },
          best_oa_location: { pdf_url: "https://papers.example/test.pdf" },
          primary_location: null,
          locations: [],
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  assert.equal(enriched.paper_id, paper.paper_id);
  assert.equal(enriched.title, "Original title");
  assert.equal(enriched.abstract, "Useful evidence");
  assert.equal(enriched.pdf_url, "https://papers.example/test.pdf");
  assert.deepEqual(enriched.heat_signals, ["OpenAlex 引用记录：42"]);
});

test("papers without DOI do not cause a network request", async () => {
  let called = false;
  const paper = { paper_id: "paper-1", doi: null };
  assert.equal(await enrichPaperWithOpenAlex(paper, {
    fetchImpl: async () => {
      called = true;
      return new Response();
    },
  }), paper);
  assert.equal(called, false);
});
