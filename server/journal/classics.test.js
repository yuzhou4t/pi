import assert from "node:assert/strict";
import test from "node:test";
import { SOURCE_REGISTRY } from "./sourceRegistry.js";
import { CLASSIC_PAPERS, CLASSIC_REVIEW_LABEL } from "./classics.js";

test("classic pool contains five distinct, citable papers from monitored venues", () => {
  const sourceIds = new Set(SOURCE_REGISTRY.map((source) => source.source_id));
  assert.equal(CLASSIC_PAPERS.length, 5);
  assert.equal(new Set(CLASSIC_PAPERS.map((paper) => paper.paper_id)).size, 5);

  for (const paper of CLASSIC_PAPERS) {
    assert.ok(paper.title);
    assert.ok(paper.authors.length > 0);
    assert.match(paper.published_at, /^\d{4}$/);
    assert.ok(sourceIds.has(paper.source_id));
    assert.match(paper.official_url, /^https:\/\//);
    assert.match(paper.pdf_url, /^https:\/\//);
    assert.equal(paper.candidate_origin, "classic_review");
    assert.equal(paper.is_new, false);
    assert.equal(paper.display_label, CLASSIC_REVIEW_LABEL);
  }
});

test("classic pool uses known stable identifiers for its canonical records", () => {
  const byId = new Map(CLASSIC_PAPERS.map((paper) => [paper.paper_id, paper]));
  assert.equal(byId.get("classic-react-2023").openreview_id, "WE_vluYUL-X");
  assert.equal(byId.get("classic-toolformer-2023").arxiv_id, "2302.04761");
  assert.equal(byId.get("classic-rag-2020").arxiv_id, "2005.11401");
  assert.equal(byId.get("classic-reflexion-2023").arxiv_id, "2303.11366");
  assert.equal(byId.get("classic-chain-of-thought-2022").openreview_id, "_VjQlMeSB_J");
});
