import { buildCandidateBatch } from "./classicFallback.js";
import { selectResurfaceCandidates } from "./resurfaceCandidates.js";
import {
  buildSourceScan,
  deduplicatePapers,
  filterTopicCandidates,
  normalizePaper,
} from "./monitorCore.js";
import { enrichPapersWithOpenAlex } from "./openAlexEnricher.js";
import { fetchRegisteredSource } from "./sourceDispatcher.js";
import { SOURCE_REGISTRY } from "./sourceRegistry.js";

const MAX_PAPERS_PER_SOURCE = 80;
const MAX_ENRICHMENT_PAPERS = 40;
const WEEK_WINDOW_MS = 8 * 24 * 60 * 60 * 1000;
const SOURCE_FETCH_TIMEOUT_MS = 4 * 60 * 1000;

function fetchSourceWithWatchdog(fetchSource, source, options, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(`Source ${source.source_id} timed out after ${timeoutMs}ms`);
      error.code = "SOURCE_SCAN_TIMEOUT";
      error.retryable = true;
      reject(error);
    }, timeoutMs);
    Promise.resolve()
      .then(() => fetchSource(source, options))
      .then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
  });
}

export function publicationDiscovery(
  publishedAt,
  observedAt,
  publicationDatePrecision,
) {
  const inferredPrecision = publicationDatePrecision
    || (/^\d{4}-\d{2}-\d{2}(?:[T\s].*)?$/.test(String(publishedAt ?? ""))
      ? "day"
      : "unknown");
  const published = Date.parse(publishedAt);
  const observed = Date.parse(observedAt);
  const age = observed - published;
  const publishedThisWeek = inferredPrecision === "day"
    && Number.isFinite(age)
    && age >= -24 * 60 * 60 * 1000
    && age <= WEEK_WINDOW_MS;
  return {
    published_this_week: publishedThisWeek,
    display_label: publishedThisWeek ? "本周新论文" : "本周补发现 · 非本周新论文",
  };
}

function errorRecord(error) {
  return {
    code: typeof error?.code === "string"
      ? error.code
      : typeof error?.message === "string"
        ? error.message.slice(0, 160)
        : "SOURCE_SCAN_FAILED",
    retryable: Boolean(
      error?.retryable
      || error?.name === "AbortError"
      || /^(?:DBLP|CROSSREF)_HTTP_(429|5\d\d)$/.test(error?.message ?? ""),
    ),
    ...(Array.isArray(error?.attempts) ? { attempts: structuredClone(error.attempts) } : {}),
  };
}

function committedSourceScans(sourceScans) {
  return sourceScans.map((scan) => scan.status === "success"
    ? {
        ...scan,
        cursor_after: structuredClone(scan.next_cursor),
        cursor_committed: true,
        cursor_commit_status: "committed",
      }
    : {
        ...scan,
        cursor_commit_status: "not_applicable",
      });
}

async function readTransaction(runStore, runId) {
  try {
    return await runStore.readArtifact(
      runId,
      "inputs/source-scan-transaction.json",
    );
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function candidateBatchFromTransaction(transaction, candidates) {
  return {
    mode: transaction.candidate_mode,
    fallback_reason: transaction.fallback_reason ?? null,
    candidates,
  };
}

async function finalizeTransaction({
  runId,
  runStore,
  sourceStateStore,
  transaction,
  sourceScans,
  summary,
  candidates,
}) {
  const commit = await sourceStateStore.commitScanTransaction({
    transactionId: transaction.transaction_id,
    expectedRevision: transaction.expected_source_state_revision,
    sourceScans,
    observedAt: transaction.observed_at,
  });
  const committedScans = committedSourceScans(sourceScans);
  await runStore.writeArtifact(runId, "inputs/source-scans.json", committedScans);
  await runStore.writeArtifact(runId, "inputs/source-scan-transaction.json", {
    ...transaction,
    status: "committed",
    committed_source_state_revision: commit.revision,
    committed_at: transaction.committed_at ?? new Date().toISOString(),
  });
  if (transaction.status !== "committed") {
    await runStore.appendEvent(runId, {
      type: "source_scan_completed",
      at: transaction.observed_at,
      source_state_revision: commit.revision,
      ...summary,
    });
  }
  return {
    sourceScans: committedScans,
    summary,
    candidateBatch: candidateBatchFromTransaction(transaction, candidates),
    cursor_commit_pending: false,
  };
}

function stagedTransactionResult(transaction, sourceScans, summary, candidates) {
  return {
    sourceScans,
    summary,
    candidateBatch: candidateBatchFromTransaction(transaction, candidates),
    cursor_commit_pending: true,
  };
}

export async function commitJournalSourceScan({
  runId,
  runStore,
  sourceStateStore,
  requiredArtifacts = [],
} = {}) {
  if (!runId || !runStore || !sourceStateStore) {
    throw new Error("runId, runStore, and sourceStateStore are required");
  }
  const transaction = await readTransaction(runStore, runId);
  if (
    transaction?.schema_version !== 1
    || transaction.transaction_id !== `source-scan:${runId}`
    || !["staged", "committed"].includes(transaction.status)
  ) {
    throw new Error("SOURCE_SCAN_TRANSACTION_NOT_READY");
  }
  const [sourceScans, summary, candidates] = await Promise.all([
    runStore.readArtifact(runId, "inputs/source-scans.json"),
    runStore.readArtifact(runId, "inputs/scan-summary.json"),
    runStore.readArtifact(runId, "inputs/ranking-pool.json"),
    ...requiredArtifacts.map((artifact) => runStore.readArtifact(runId, artifact)),
  ]);
  if (transaction.status === "committed") {
    return {
      sourceScans,
      summary,
      candidateBatch: candidateBatchFromTransaction(transaction, candidates),
      cursor_commit_pending: false,
    };
  }
  return finalizeTransaction({
    runId,
    runStore,
    sourceStateStore,
    transaction,
    sourceScans,
    summary,
    candidates,
  });
}

async function mapWithConcurrency(items, concurrency, task) {
  const output = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      output[index] = await task(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return output;
}

export async function scanJournalSources({
  runId,
  runStore,
  sourceStateStore,
  sources = SOURCE_REGISTRY,
  fetchSource = fetchRegisteredSource,
  fetchImpl = globalThis.fetch,
  observedAt = new Date().toISOString(),
  maxPapersPerSource = MAX_PAPERS_PER_SOURCE,
  concurrency = 1,
  sourceDelayMs = 0,
  sourceTimeoutMs = SOURCE_FETCH_TIMEOUT_MS,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  openAlexMailto = "",
  deferCursorCommit = false,
} = {}) {
  if (!runId || !runStore || !sourceStateStore) {
    throw new Error("runId, runStore, and sourceStateStore are required");
  }
  const transactionId = `source-scan:${runId}`;
  const existingTransaction = await readTransaction(runStore, runId);
  if (
    existingTransaction?.schema_version === 1
    && existingTransaction.transaction_id === transactionId
    && ["staged", "committed"].includes(existingTransaction.status)
  ) {
    const [persistedScans, summary, candidates] = await Promise.all([
      runStore.readArtifact(runId, "inputs/source-scans.json"),
      runStore.readArtifact(runId, "inputs/scan-summary.json"),
      runStore.readArtifact(runId, "inputs/ranking-pool.json"),
    ]);
    if (existingTransaction.status === "committed") return {
      sourceScans: persistedScans,
      summary,
      candidateBatch: candidateBatchFromTransaction(
        existingTransaction,
        candidates,
      ),
      cursor_commit_pending: false,
    };
    if (deferCursorCommit) {
      return stagedTransactionResult(
        existingTransaction,
        persistedScans,
        summary,
        candidates,
      );
    }
    return finalizeTransaction({
      runId,
      runStore,
      sourceStateStore,
      transaction: existingTransaction,
      sourceScans: persistedScans,
      summary,
      candidates,
    });
  }
  const stateBeforeScan = await sourceStateStore.load();

  async function recordSourceProgress(scan) {
    await runStore.updateRun(runId, (current) => {
      const previous = current.source_progress ?? {
        total_count: sources.length,
        completed_source_ids: [],
        successful_source_ids: [],
        failed_source_ids: [],
      };
      const completedSourceIds = [...new Set([...previous.completed_source_ids, scan.source_id])];
      const successfulSourceIds = scan.status === "success"
        ? [...new Set([...previous.successful_source_ids, scan.source_id])]
        : previous.successful_source_ids.filter((sourceId) => sourceId !== scan.source_id);
      const failedSourceIds = scan.status === "success"
        ? previous.failed_source_ids.filter((sourceId) => sourceId !== scan.source_id)
        : [...new Set([...previous.failed_source_ids, scan.source_id])];
      return {
        source_progress: {
          total_count: sources.length,
          completed_source_ids: completedSourceIds,
          successful_source_ids: successfulSourceIds,
          failed_source_ids: failedSourceIds,
        },
      };
    });
  }

  const sourceScans = await mapWithConcurrency(sources, concurrency, async (source, index) => {
    const cursorBefore = stateBeforeScan.sources[source.source_id]?.cursor ?? null;
    try {
      const fetched = await fetchSourceWithWatchdog(
        fetchSource,
        source,
        { fetchImpl },
        sourceTimeoutMs,
      );
      const normalizedAll = fetched.papers
        .map((paper) => normalizePaper(paper, {
          sourceId: source.source_id,
          observedAt,
        }));
      const normalized = [
        ...normalizedAll.filter((paper) => paper.topic_matches.length > 0),
        ...normalizedAll.filter((paper) => paper.topic_matches.length === 0),
      ].slice(0, maxPapersPerSource);
      const classified = sourceStateStore.classifyPapers(
        stateBeforeScan,
        source.source_id,
        normalized,
        observedAt,
      );
      const artifact = {
        schema_version: 1,
        source_id: source.source_id,
        fetched_at: fetched.fetched_at,
        index_url: fetched.index_url,
        target_urls: fetched.target_urls,
        dispatch: fetched.dispatch ?? null,
        papers: classified,
      };
      await runStore.writeArtifact(runId, `sources/${source.source_id}.json`, artifact);
      const nextCursor = {
        fetched_at: fetched.fetched_at,
        targets: fetched.target_urls,
      };
      const scan = {
        ...buildSourceScan({
          sourceId: source.source_id,
          status: "success",
          cursorBefore,
          nextCursor,
          outputPersisted: false,
          papers: classified,
        }),
        output_persisted: true,
        cursor_commit_status: "staged",
        dispatch: fetched.dispatch ?? null,
        fetched_record_count: normalizedAll.length,
      };
      await recordSourceProgress(scan);
      return scan;
    } catch (error) {
      const failure = errorRecord(error);
      const scan = buildSourceScan({
        sourceId: source.source_id,
        status: "failed",
        cursorBefore,
        nextCursor: null,
        outputPersisted: false,
        papers: [],
        error: failure,
      });
      scan.cursor_commit_status = "not_applicable";
      await recordSourceProgress(scan);
      return scan;
    } finally {
      if (sourceDelayMs > 0 && index < sources.length - 1) {
        await sleep(sourceDelayMs);
      }
    }
  });
  const newRecords = deduplicatePapers(
    sourceScans
      .filter((scan) => scan.status === "success" && scan.output_persisted)
      .flatMap((scan) => scan.papers.filter((paper) => paper.is_new)),
  );
  const likelyRelevant = filterTopicCandidates(newRecords);
  const enrichmentPool = (
    likelyRelevant.length >= MAX_ENRICHMENT_PAPERS
      ? likelyRelevant
      : [...likelyRelevant, ...newRecords.filter((paper) => !likelyRelevant.includes(paper))]
  ).slice(0, MAX_ENRICHMENT_PAPERS);
  const enriched = await enrichPapersWithOpenAlex(enrichmentPool, {
    fetchImpl,
    mailto: openAlexMailto,
  });
  const topicCandidates = deduplicatePapers(filterTopicCandidates(enriched.map((paper) => ({
    ...paper,
    ...publicationDiscovery(
      paper.published_at,
      observedAt,
      paper.publication_date_precision,
    ),
  }))));
  const recentTopicCandidates = topicCandidates.filter((paper) => paper.published_this_week);
  // 本周新论文不足时的回补顺序：本周补发现（本次扫描首次发现但非本周发表，
  // 按发表时间降序）→ 往周未读回补 → 经典池。之前本周补发现被整体丢弃，
  // 导致候选里全是多年前的经典论文。
  const historicalDiscoveries = topicCandidates
    .filter((paper) => !paper.published_this_week)
    .sort((left, right) => String(right.published_at ?? "").localeCompare(String(left.published_at ?? "")))
    .slice(0, Math.max(0, 5 - recentTopicCandidates.length));
  let resurfacedCandidates = [];
  const filledCount = recentTopicCandidates.length + historicalDiscoveries.length;
  if (filledCount < 5 && typeof runStore.listRuns === "function") {
    try {
      const previousRuns = await runStore.listRuns();
      resurfacedCandidates = selectResurfaceCandidates({
        previousRuns,
        currentCandidates: [...recentTopicCandidates, ...topicCandidates],
        currentRunId: runId,
        limit: 5 - filledCount,
        observedAt,
      });
    } catch {
      // 回补是锦上添花；历史 Run 读取失败不影响本周扫描。
      resurfacedCandidates = [];
    }
  }
  const candidateBatch = buildCandidateBatch({
    newCandidates: [
      ...recentTopicCandidates,
      ...historicalDiscoveries,
      ...resurfacedCandidates,
    ],
    observedAt,
    limit: 5,
  });
  const summary = {
    schema_version: 1,
    observed_at: observedAt,
    source_count: sources.length,
    successful_source_count: sourceScans.filter((scan) => scan.status === "success").length,
    failed_source_ids: sourceScans.filter((scan) => scan.status !== "success").map((scan) => scan.source_id),
    raw_record_count: sourceScans.reduce(
      (total, scan) => total + (scan.fetched_record_count ?? scan.papers.length),
      0,
    ),
    new_record_count: newRecords.length,
    topic_candidate_count: topicCandidates.length,
    recent_topic_candidate_count: recentTopicCandidates.length,
    historical_backfill_count: historicalDiscoveries.length,
    resurfaced_candidate_count: resurfacedCandidates.length,
    historical_discovery_count: topicCandidates.filter((paper) => !paper.published_this_week).length,
    candidate_mode: candidateBatch.mode,
    fallback_reason: candidateBatch.fallback_reason,
  };
  await runStore.writeArtifact(runId, "inputs/source-scans.json", sourceScans);
  await runStore.writeArtifact(runId, "inputs/scan-summary.json", summary);
  await runStore.writeArtifact(runId, "inputs/ranking-pool.json", candidateBatch.candidates);
  const transaction = {
    schema_version: 1,
    transaction_id: transactionId,
    run_id: runId,
    status: "staged",
    observed_at: observedAt,
    expected_source_state_revision: stateBeforeScan.revision,
    candidate_mode: candidateBatch.mode,
    fallback_reason: candidateBatch.fallback_reason,
  };
  await runStore.writeArtifact(
    runId,
    "inputs/source-scan-transaction.json",
    transaction,
  );
  if (deferCursorCommit) {
    return stagedTransactionResult(
      transaction,
      sourceScans,
      summary,
      candidateBatch.candidates,
    );
  }
  return finalizeTransaction({
    runId,
    runStore,
    sourceStateStore,
    transaction,
    sourceScans,
    summary,
    candidates: candidateBatch.candidates,
  });
}
