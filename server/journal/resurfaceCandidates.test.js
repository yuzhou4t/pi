import test from "node:test";
import assert from "node:assert/strict";
import {
  RESURFACE_LABEL,
  selectResurfaceCandidates,
} from "./resurfaceCandidates.js";

function paper(id, overrides = {}) {
  return {
    paper_id: id,
    dedupe_key: `key-${id}`,
    title: `Paper ${id}`,
    rank: 1,
    candidate_origin: "weekly_scan",
    ...overrides,
  };
}

function run(runId, createdAt, candidates, decisions = {}) {
  return {
    run_id: runId,
    created_at: createdAt,
    candidates,
    paper_decisions: decisions,
  };
}

test("resurfaces unread past candidates newest run first with stable labels", () => {
  const result = selectResurfaceCandidates({
    previousRuns: [
      run("run-old", "2026-07-10T00:00:00Z", [paper("a", { rank: 1 })]),
      run("run-new", "2026-07-20T00:00:00Z", [paper("b", { rank: 2 }), paper("c", { rank: 1 })]),
    ],
    currentCandidates: [],
    limit: 2,
    observedAt: "2026-07-30T00:00:00Z",
  });
  assert.equal(result.length, 2);
  assert.equal(result[0].paper_id, "c");
  assert.equal(result[1].paper_id, "b");
  assert.equal(result[0].candidate_origin, "resurfaced_unread");
  assert.equal(result[0].display_label, RESURFACE_LABEL);
  assert.equal(result[0].is_new, false);
  assert.equal(result[0].published_this_week, false);
  assert.equal(result[0].resurfaced_from_run_id, "run-new");
  assert.equal(result[0].observed_at, "2026-07-30T00:00:00Z");
});

test("read or collected papers never resurface", () => {
  const result = selectResurfaceCandidates({
    previousRuns: [
      run("run-1", "2026-07-20T00:00:00Z", [
        paper("read-me"),
        paper("collect-me"),
        paper("unread"),
      ], { "read-me": "read", "collect-me": "collect" }),
    ],
    currentCandidates: [],
    limit: 5,
  });
  assert.deepEqual(result.map((item) => item.paper_id), ["unread"]);
});

test("dedupes by stable identity against current candidates and across runs", () => {
  const result = selectResurfaceCandidates({
    previousRuns: [
      run("run-2", "2026-07-20T00:00:00Z", [
        paper("dup", { dedupe_key: "shared-key" }),
        paper("fresh"),
      ]),
      run("run-1", "2026-07-13T00:00:00Z", [
        paper("dup-older-id", { dedupe_key: "shared-key" }),
      ]),
    ],
    currentCandidates: [paper("current", { dedupe_key: "shared-key" })],
    limit: 5,
  });
  assert.deepEqual(result.map((item) => item.paper_id), ["fresh"]);
});

test("classics and already-resurfaced candidates are excluded, current run skipped", () => {
  const result = selectResurfaceCandidates({
    previousRuns: [
      run("run-current", "2026-07-27T00:00:00Z", [paper("mine")]),
      run("run-prev", "2026-07-20T00:00:00Z", [
        paper("classic", { candidate_origin: "classic_review" }),
        paper("resurfaced", { candidate_origin: "resurfaced_unread" }),
        paper("venue", { candidate_origin: "venue_search" }),
      ]),
    ],
    currentCandidates: [],
    currentRunId: "run-current",
    limit: 5,
  });
  assert.deepEqual(result.map((item) => item.paper_id), ["venue"]);
});

test("empty history or non-positive limit yields no candidates", () => {
  assert.deepEqual(selectResurfaceCandidates({ previousRuns: [], limit: 3 }), []);
  assert.deepEqual(selectResurfaceCandidates({
    previousRuns: [run("run-1", "2026-07-20T00:00:00Z", [paper("a")])],
    limit: 0,
  }), []);
});
