import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSourceScan,
  combineSourceScans,
  deduplicatePapers,
  filterTopicCandidates,
  normalizePaper,
  stablePaperIdentity,
} from "./monitorCore.js";

function paper(overrides = {}) {
  return normalizePaper({
    title: "A Verifiable LLM Agent Workflow",
    authors: ["A. Author"],
    venue: "TestConf",
    published_at: "2026-07-20",
    abstract: "We evaluate a reliable LLM agent with tool use and traceable evidence.",
    ...overrides,
  }, {
    sourceId: overrides.source_id || "conference-acl",
    observedAt: overrides.observed_at || "2026-07-23T08:00:00.000Z",
  });
}

test("normalization keeps publication time separate from first discovery", () => {
  const normalized = normalizePaper({
    title: "  Memory-Augmented   Agent  ",
    authors: [{ given: "Ada", family: "Lovelace" }],
    doi: "https://doi.org/10.1000/ABC",
    abstract: "An LLM agent with long-term memory.",
  }, {
    sourceId: "journal-jmlr",
    observedAt: "2026-07-23T08:00:00.000Z",
  });

  assert.equal(normalized.title, "Memory-Augmented Agent");
  assert.deepEqual(normalized.authors, ["Ada Lovelace"]);
  assert.equal(normalized.doi, "10.1000/abc");
  assert.equal(normalized.published_at, null);
  assert.equal(normalized.first_seen_at, "2026-07-23T08:00:00.000Z");
  assert.equal(normalized.observed_at, "2026-07-23T08:00:00.000Z");
  assert.ok(normalized.topic_matches.includes("记忆与上下文工程"));
  assert.match(normalized.paper_id, /^paper-[a-f0-9]{20}$/);
});

test("stable identity prefers DOI over source-specific metadata", () => {
  const left = paper({ doi: "10.1000/SAME", source_id: "conference-acl" });
  const right = paper({ doi: "doi:10.1000/same", source_id: "conference-neurips" });
  assert.equal(stablePaperIdentity(left), "doi:10.1000/same");
  assert.equal(stablePaperIdentity(right), "doi:10.1000/same");
  assert.equal(left.paper_id, right.paper_id);
});

test("cross-source duplicates merge deterministically and preserve all sources", () => {
  const acl = paper({
    doi: "10.1000/workflow",
    source_id: "conference-acl",
    first_seen_at: "2026-07-23T08:00:00.000Z",
    abstract: "A short LLM agent abstract.",
  });
  const neurips = paper({
    doi: null,
    arxiv_id: "2607.12345v2",
    source_id: "conference-neurips",
    first_seen_at: "2026-07-22T08:00:00.000Z",
    abstract: "A longer abstract about a reliable LLM agent with tools, evaluation, and traceable evidence.",
  });

  const forward = deduplicatePapers([acl, neurips]);
  const reverse = deduplicatePapers([neurips, acl]);
  assert.deepEqual(forward, reverse);
  assert.equal(forward.length, 1);
  assert.deepEqual(forward[0].source_ids, ["conference-acl", "conference-neurips"]);
  assert.equal(forward[0].first_seen_at, "2026-07-22T08:00:00.000Z");
  assert.equal(forward[0].published_at, "2026-07-20");
  assert.equal(forward[0].doi, "10.1000/workflow");
  assert.equal(forward[0].arxiv_id, "2607.12345");
});

test("topic filtering is deterministic and does not send unrelated papers onward", () => {
  const candidates = filterTopicCandidates([
    paper(),
    paper({
      title: "A Taxonomy of Garden Plants",
      abstract: "This article catalogs garden plants.",
      source_id: "journal-ai",
      doi: "10.1000/garden",
      topic_matches: [],
    }),
  ]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].title, "A Verifiable LLM Agent Workflow");
  assert.ok(candidates[0].topic_matches.includes("LLM Agent"));
  assert.ok(candidates[0].topic_matches.includes("规划与工具使用"));
});

test("a failed source never advances its cursor or contributes candidates", () => {
  const failed = buildSourceScan({
    sourceId: "conference-iclr",
    status: "failed",
    cursorBefore: { last_seen: "2026-07-01" },
    nextCursor: { last_seen: "2026-07-23" },
    outputPersisted: true,
    papers: [paper({ source_id: "conference-iclr" })],
    error: { kind: "network" },
  });
  const successful = buildSourceScan({
    sourceId: "conference-acl",
    status: "success",
    cursorBefore: { last_seen: "2026-07-01" },
    nextCursor: { last_seen: "2026-07-23" },
    outputPersisted: true,
    papers: [paper()],
  });

  assert.equal(failed.cursor_committed, false);
  assert.deepEqual(failed.cursor_after, { last_seen: "2026-07-01" });
  assert.equal(successful.cursor_committed, true);
  assert.deepEqual(successful.cursor_after, { last_seen: "2026-07-23" });

  const result = combineSourceScans([failed, successful]);
  assert.deepEqual(result.failed_sources, ["conference-iclr"]);
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.cursor_updates, [{
    source_id: "conference-acl",
    cursor_after: { last_seen: "2026-07-23" },
  }]);
});

test("successful fetch still waits for durable output before cursor commit", () => {
  const scan = buildSourceScan({
    sourceId: "journal-jmlr",
    status: "success",
    cursorBefore: "page-1",
    nextCursor: "page-2",
    outputPersisted: false,
  });
  assert.equal(scan.cursor_committed, false);
  assert.equal(scan.cursor_after, "page-1");
});
