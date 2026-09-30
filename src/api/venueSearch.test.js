import assert from "node:assert/strict";
import test from "node:test";
import { mapVenueSearchConversation } from "./venueSearch.js";

test("venue search maps translated title, abstract, and project explanation fields", () => {
  const conversation = mapVenueSearchConversation({
    conversation_id: "search-1",
    title: "Agent memory",
    turns: [{
      turn_id: "turn-1",
      question: "最近有什么 Agent memory 论文？",
      status: "complete",
      answer: "找到一篇相关论文。",
      search: {
        venues: [
          { source_id: "journal-ai", short_name: "AI", status: "empty", count: 0 },
          { source_id: "journal-jmlr", short_name: "JMLR", status: "failed", count: 0 },
        ],
        venue_success_count: 0,
        venue_reached_count: 1,
        venue_matched_count: 0,
        venue_failed_ids: ["journal-jmlr"],
        total_found: 1,
      },
      recommendations: [{
        paper_id: "paper-1",
        title_zh: "可恢复的 Agent 记忆",
        reason: "论文讨论可恢复记忆。",
        project_impact: "可用于检验项目的状态设计。",
      }],
      papers: [{
        paper_id: "paper-1",
        title: "Recoverable Agent Memory",
        title_zh: "可恢复的 Agent 记忆",
        abstract: "A study of recoverable memory.",
        abstract_zh: "一项关于可恢复记忆的研究。",
        authors: ["Researcher"],
        venue: "ACL",
        published_at: "2026-06-12",
        publication_date_precision: "day",
      }],
      added_paper_ids: [],
      web: { status: "success", results: [] },
    }],
  });

  assert.equal(conversation.turns[0].papers[0].titleZh, "可恢复的 Agent 记忆");
  assert.equal(conversation.turns[0].papers[0].abstractZh, "一项关于可恢复记忆的研究。");
  assert.equal(conversation.turns[0].papers[0].publicationDatePrecision, "day");
  assert.equal(conversation.turns[0].venueReachedCount, 1);
  assert.equal(conversation.turns[0].venueMatchedCount, 0);
  assert.deepEqual(conversation.turns[0].venueFailedIds, ["journal-jmlr"]);
  assert.equal(conversation.turns[0].recommendations[0].projectImpact, "可用于检验项目的状态设计。");
});
