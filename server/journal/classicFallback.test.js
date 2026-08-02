import assert from "node:assert/strict";
import test from "node:test";
import { buildCandidateBatch } from "./classicFallback.js";
import { CLASSIC_REVIEW_LABEL } from "./classics.js";

test("zero new papers yields five explicitly labeled classic reviews", () => {
  const result = buildCandidateBatch({
    newCandidates: [],
    observedAt: "2026-07-23T08:00:00.000Z",
  });
  assert.equal(result.mode, "classic_review");
  assert.equal(result.fallback_reason, "no_new_papers");
  assert.equal(result.display_label, CLASSIC_REVIEW_LABEL);
  assert.equal(result.candidates.length, 5);
  for (const paper of result.candidates) {
    assert.equal(paper.candidate_origin, "classic_review");
    assert.equal(paper.is_new, false);
    assert.equal(paper.display_label, "经典回顾 · 非本月新论文");
    assert.equal(paper.observed_at, "2026-07-23T08:00:00.000Z");
  }
});

test("fewer than five new papers are completed with labeled classics", () => {
  const candidate = {
    paper_id: "paper-new",
    candidate_origin: "weekly_scan",
    is_new: true,
  };
  const result = buildCandidateBatch({ newCandidates: [candidate] });
  assert.equal(result.mode, "mixed_review");
  assert.equal(result.fallback_reason, "insufficient_new_papers");
  assert.equal(result.candidates.length, 5);
  assert.deepEqual(result.candidates[0], candidate);
  assert.notEqual(result.candidates[0], candidate);
  assert.equal(result.candidates.slice(1).every((paper) => paper.display_label === CLASSIC_REVIEW_LABEL), true);
});

test("five or more new papers bypass the classic pool without relabeling", () => {
  const newCandidates = Array.from({ length: 6 }, (_, index) => ({
    paper_id: `paper-new-${index}`,
    candidate_origin: "weekly_scan",
    is_new: true,
  }));
  const result = buildCandidateBatch({ newCandidates });
  assert.equal(result.mode, "new_papers");
  assert.equal(result.fallback_reason, null);
  assert.equal(result.candidates.length, 6);
  assert.equal(result.candidates.every((paper) => paper.candidate_origin === "weekly_scan"), true);
});

test("fallback validates its bounded five-paper contract", () => {
  assert.throws(
    () => buildCandidateBatch({ newCandidates: [], limit: 6 }),
    /1 到 5/,
  );
  assert.throws(
    () => buildCandidateBatch({ newCandidates: [], classicPool: [], limit: 5 }),
    /不足 5 篇/,
  );
});
