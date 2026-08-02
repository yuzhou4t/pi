import assert from "node:assert/strict";
import test from "node:test";
import { buildPaperReadingLibrary } from "./paperLibrary.js";

function run({
  id,
  createdAt,
  paperId = "paper-stable",
  title = "Stable Paper",
  decision = "read",
  reading = null,
  archived = false,
  projectId = "pi-agent-product",
}) {
  return {
    id,
    projectId,
    createdAt,
    updatedAt: createdAt,
    paperDecisions: { [paperId]: decision },
    candidates: [{ id: paperId, title, mineruStatus: "ready", isDemo: false }],
    readings: {
      papers: reading ? { [paperId]: reading } : {},
    },
    obsidian: {
      proposals: archived
        ? [{ paperId, status: "committed" }]
        : [],
    },
  };
}

test("paper library lists only explicit read decisions and deduplicates stable paper ids", () => {
  const library = buildPaperReadingLibrary([
    run({
      id: "week-2",
      createdAt: "2026-07-26T08:00:00.000Z",
      reading: {
        status: "reading",
        position: { blockId: "block-8" },
        chat: { id: "conversation-latest", turns: [{ id: "turn-1" }] },
        updatedAt: "2026-07-26T09:00:00.000Z",
      },
    }),
    run({
      id: "week-1",
      createdAt: "2026-07-19T08:00:00.000Z",
      reading: {
        status: "not_started",
        position: null,
        chat: { id: "current", turns: [] },
      },
    }),
    run({
      id: "collect-only",
      createdAt: "2026-07-25T08:00:00.000Z",
      paperId: "paper-collect",
      decision: "collect",
    }),
  ]);

  assert.equal(library.length, 1);
  assert.equal(library[0].paperId, "paper-stable");
  assert.equal(library[0].runId, "week-2");
  assert.equal(library[0].position.blockId, "block-8");
  assert.equal(library[0].activeConversationId, "conversation-latest");
  assert.deepEqual(
    library[0].sourceRuns.map((source) => source.runId),
    ["week-2", "week-1"],
  );
});

test("paper library prefers the archived canonical reading and stays project scoped", () => {
  const library = buildPaperReadingLibrary([
    run({
      id: "new-week",
      createdAt: "2026-07-26T08:00:00.000Z",
      reading: { status: "reading", chat: { turns: [{ id: "new-turn" }] } },
    }),
    run({
      id: "archived-week",
      createdAt: "2026-07-19T08:00:00.000Z",
      reading: { status: "complete", chat: { id: "canonical", turns: [] } },
      archived: true,
    }),
    run({
      id: "other-project",
      createdAt: "2026-07-27T08:00:00.000Z",
      projectId: "another-project",
    }),
  ]);

  assert.equal(library.length, 1);
  assert.equal(library[0].runId, "archived-week");
  assert.equal(library[0].activeConversationId, "canonical");
  assert.equal(library[0].statusLabel, "已归档");
});
