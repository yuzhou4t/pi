import assert from "node:assert/strict";
import test from "node:test";
import { buildWeeklyRecommendation } from "./weeklyRecommendation.js";

function paper(id, overrides = {}) {
  return {
    paper_id: id,
    title: `Paper ${id}`,
    abstract: "Evidence",
    pdf_url: `https://example.com/${id}.pdf`,
    topic_matches: ["LLM Agent"],
    recent_pool_eligible: true,
    published_this_month: true,
    ...overrides,
  };
}

test("weekly recommendations mix current, unread, and field papers", () => {
  const result = buildWeeklyRecommendation({
    candidates: [
      paper("new-1"), paper("new-2"), paper("new-3"), paper("new-4"),
      paper("unread", { published_this_month: false }),
      paper("field", { candidate_scope: "field" }),
    ],
    weekKey: "2026-08-03",
    observedAt: "2026-08-03T00:00:00Z",
  });
  assert.equal(result.paper_ids.length, 5);
  assert.ok(result.paper_ids.includes("unread"));
  assert.ok(result.paper_ids.includes("field"));
  assert.equal(result.paper_ids.filter((id) => id.startsWith("new-")).length, 3);
});

test("a paper may repeat next week, then cools down, and never exceeds three exposures", () => {
  const candidate = paper("repeat");
  const weekOne = buildWeeklyRecommendation({
    candidates: [candidate],
    weekKey: "2026-08-03",
    observedAt: "2026-08-03T00:00:00Z",
  });
  const weekTwo = buildWeeklyRecommendation({
    candidates: [candidate],
    previousSelections: weekOne.selections,
    weekKey: "2026-08-10",
    observedAt: "2026-08-10T00:00:00Z",
  });
  const weekThree = buildWeeklyRecommendation({
    candidates: [candidate],
    previousSelections: weekTwo.selections,
    weekKey: "2026-08-17",
    observedAt: "2026-08-17T00:00:00Z",
  });
  const weekFour = buildWeeklyRecommendation({
    candidates: [candidate],
    previousSelections: weekThree.selections,
    weekKey: "2026-08-24",
    observedAt: "2026-08-24T00:00:00Z",
  });
  const weekFive = buildWeeklyRecommendation({
    candidates: [candidate],
    previousSelections: weekFour.selections,
    weekKey: "2026-08-31",
    observedAt: "2026-08-31T00:00:00Z",
  });
  assert.deepEqual(weekOne.paper_ids, ["repeat"]);
  assert.deepEqual(weekTwo.paper_ids, ["repeat"]);
  assert.deepEqual(weekThree.paper_ids, []);
  assert.deepEqual(weekFour.paper_ids, ["repeat"]);
  assert.deepEqual(weekFive.paper_ids, []);
});

test("read and collected papers are excluded", () => {
  const result = buildWeeklyRecommendation({
    candidates: [paper("read"), paper("collect"), paper("open")],
    paperDecisions: { read: "read", collect: "collect" },
    weekKey: "2026-08-03",
    observedAt: "2026-08-03T00:00:00Z",
  });
  assert.deepEqual(result.paper_ids, ["open"]);
});
