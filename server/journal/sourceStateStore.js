import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const MAX_SEEN_PER_SOURCE = 5000;
const MAX_APPLIED_TRANSACTIONS = 100;
const COMMIT_LOCK_RETRY_MS = 5;
const COMMIT_LOCK_ATTEMPTS = 400;
const COMMIT_LOCK_STALE_MS = 30_000;

function emptyState() {
  return {
    schema_version: 1,
    revision: 0,
    sources: {},
    applied_transactions: [],
    updated_at: null,
  };
}

export class SourceStateConflictError extends Error {
  constructor(expectedRevision, actualRevision) {
    super(`Source state changed from revision ${expectedRevision} to ${actualRevision}`);
    this.name = "SourceStateConflictError";
    this.code = "SOURCE_STATE_CONFLICT";
    this.retryable = true;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
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
  const lockPath = path.resolve(dataDir, "journal", "source-state.lock");
  let commitQueue = Promise.resolve();

  async function withCommitLock(task) {
    await mkdir(path.dirname(lockPath), { recursive: true });
    let handle;
    for (let attempt = 0; attempt < COMMIT_LOCK_ATTEMPTS; attempt += 1) {
      try {
        handle = await open(lockPath, "wx");
        break;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        try {
          const lockStat = await stat(lockPath);
          if (Date.now() - lockStat.mtimeMs > COMMIT_LOCK_STALE_MS) {
            await unlink(lockPath);
            continue;
          }
        } catch (lockError) {
          if (lockError?.code === "ENOENT") continue;
          throw lockError;
        }
        await new Promise((resolve) => setTimeout(resolve, COMMIT_LOCK_RETRY_MS));
      }
    }
    if (!handle) {
      const error = new Error("Source state commit lock is busy");
      error.code = "SOURCE_STATE_LOCK_BUSY";
      error.retryable = true;
      throw error;
    }
    try {
      return await task();
    } finally {
      await handle.close();
      await unlink(lockPath).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
  }

  async function load() {
    try {
      const value = JSON.parse(await readFile(filePath, "utf8"));
      if (value?.schema_version !== 1 || !value.sources || typeof value.sources !== "object") {
        throw new Error("SOURCE_STATE_INVALID");
      }
      return {
        ...value,
        revision: Number.isSafeInteger(value.revision) && value.revision >= 0
          ? value.revision
          : 0,
        applied_transactions: Array.isArray(value.applied_transactions)
          ? value.applied_transactions.filter((item) => (
              item
              && typeof item.transaction_id === "string"
              && Number.isSafeInteger(item.revision)
            ))
          : [],
      };
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

  function commitScanTransaction({
    transactionId,
    expectedRevision,
    sourceScans,
    observedAt,
  }) {
    if (typeof transactionId !== "string" || !transactionId.trim()) {
      throw new Error("transactionId is required");
    }
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error("expectedRevision must be a non-negative integer");
    }
    if (!Array.isArray(sourceScans)) throw new Error("sourceScans must be an array");
    const previous = commitQueue;
    const operation = previous
      .catch(() => undefined)
      .then(() => withCommitLock(async () => {
        const current = await load();
        const applied = current.applied_transactions.find(
          (item) => item.transaction_id === transactionId,
        );
        if (applied) {
          return {
            state: current,
            revision: applied.revision,
            already_committed: true,
          };
        }
        if (current.revision !== expectedRevision) {
          throw new SourceStateConflictError(expectedRevision, current.revision);
        }
        let next = current;
        for (const scan of sourceScans) {
          next = scan.status === "success"
            ? applySuccessfulScan(next, {
                sourceId: scan.source_id,
                papers: scan.papers,
                cursorAfter: scan.next_cursor,
                observedAt,
              })
            : applyFailedScan(next, {
                sourceId: scan.source_id,
                error: scan.error?.code ?? "SOURCE_SCAN_FAILED",
                observedAt,
              });
        }
        const revision = current.revision + 1;
        next = {
          ...next,
          revision,
          applied_transactions: [
            ...current.applied_transactions,
            {
              transaction_id: transactionId,
              revision,
              committed_at: now().toISOString(),
            },
          ].slice(-MAX_APPLIED_TRANSACTIONS),
          updated_at: now().toISOString(),
        };
        await atomicJson(filePath, next);
        return {
          state: next,
          revision,
          already_committed: false,
        };
      }));
    commitQueue = operation;
    return operation.finally(() => {
      if (commitQueue === operation) commitQueue = Promise.resolve();
    });
  }

  return Object.freeze({
    applyFailedScan,
    applySuccessfulScan,
    classifyPapers,
    commitScanTransaction,
    filePath,
    load,
    save,
  });
}
