import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_SEEN_PER_SOURCE = 5000;

function emptyState() {
  return {
    schema_version: 1,
    sources: {},
    updated_at: null,
  };
}

async function atomicJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

export function createSourceStateStore({ dataDir, now = () => new Date() } = {}) {
  if (typeof dataDir !== "string" || !dataDir.trim()) throw new Error("dataDir is required");
  const filePath = path.resolve(dataDir, "journal", "source-state.json");

  async function load() {
    try {
      const value = JSON.parse(await readFile(filePath, "utf8"));
      if (value?.schema_version !== 1 || !value.sources || typeof value.sources !== "object") {
        throw new Error("SOURCE_STATE_INVALID");
      }
      return value;
    } catch (error) {
      if (error?.code === "ENOENT") return emptyState();
      throw error;
    }
  }

  function classifyPapers(state, sourceId, papers, observedAt) {
    const sourceState = state.sources[sourceId] ?? { seen: {} };
    const seen = sourceState.seen ?? {};
    return papers.map((paper) => {
      const firstSeenAt = seen[paper.dedupe_key] ?? observedAt;
      return {
        ...paper,
        first_seen_at: firstSeenAt,
        observed_at: observedAt,
        is_new: !seen[paper.dedupe_key],
        candidate_origin: !seen[paper.dedupe_key] ? "weekly_scan" : "previously_seen",
      };
    });
  }

  function applySuccessfulScan(state, {
    sourceId,
    papers,
    cursorAfter,
    observedAt,
  }) {
    const previous = state.sources[sourceId] ?? { seen: {} };
    const seenEntries = Object.entries({
      ...(previous.seen ?? {}),
      ...Object.fromEntries(papers.map((paper) => [
        paper.dedupe_key,
        previous.seen?.[paper.dedupe_key] ?? paper.first_seen_at ?? observedAt,
      ])),
    })
      .sort((left, right) => right[1].localeCompare(left[1]))
      .slice(0, MAX_SEEN_PER_SOURCE);
    return {
      ...state,
      sources: {
        ...state.sources,
        [sourceId]: {
          cursor: structuredClone(cursorAfter),
          seen: Object.fromEntries(seenEntries),
          last_success_at: observedAt,
          last_error: null,
        },
      },
      updated_at: now().toISOString(),
    };
  }

  function applyFailedScan(state, { sourceId, error, observedAt }) {
    const previous = state.sources[sourceId] ?? { seen: {}, cursor: null };
    return {
      ...state,
      sources: {
        ...state.sources,
        [sourceId]: {
          ...previous,
          last_attempt_at: observedAt,
          last_error: String(error || "SOURCE_SCAN_FAILED").slice(0, 500),
        },
      },
      updated_at: now().toISOString(),
    };
  }

  async function save(state) {
    await atomicJson(filePath, state);
    return state;
  }

  return Object.freeze({
    applyFailedScan,
    applySuccessfulScan,
    classifyPapers,
    filePath,
    load,
    save,
  });
}
