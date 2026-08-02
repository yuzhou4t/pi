import { buildCandidateBatch } from "./classicFallback.js";
import { selectResurfaceCandidates } from "./resurfaceCandidates.js";
import {
  buildSourceScan,
  deduplicatePapers,
  filterFieldCandidates,
  filterTopicCandidates,
  normalizePaper,
} from "./monitorCore.js";
import { enrichPapersWithOpenAlex } from "./openAlexEnricher.js";
import { fetchRegisteredSource } from "./sourceDispatcher.js";
import { SOURCE_REGISTRY } from "./sourceRegistry.js";

const MAX_PAPERS_PER_SOURCE = 80;
const MAX_ENRICHMENT_PAPERS = 40;
// 默认为本月的 5 篇保留最多 2 篇“领域视野”名额，让候选不只是窄主题。
const DEFAULT_FIELD_SLOTS = 2;
// 本月新论文的发现窗口：近 30 天 + 1 天容差（时区/索引延迟）。
const MONTH_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;
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
  const publishedThisMonth = inferredPrecision === "day"
    && Number.isFinite(age)
    && age >= -24 * 60 * 60 * 1000
    && age <= MONTH_WINDOW_MS;
  return {
    published_this_month: publishedThisMonth,
    display_label: publishedThisMonth ? "本月新论文" : "本月补发现 · 非本月新论文",
  };
}

function candidateExclusions(previousRuns, dismissedKeys) {
  const paperIds = new Set();
  const dedupeKeys = new Set(
    dismissedKeys.filter((key) => typeof key === "string" && key),
  );
  for (const run of previousRuns) {
    const decisions = run?.paper_decisions;
    if (!decisions || typeof decisions !== "object" || Array.isArray(decisions)) continue;
    for (const paper of Array.isArray(run.candidates) ? run.candidates : []) {
      if (!["read", "collect"].includes(decisions[paper.paper_id])) continue;
      if (paper.paper_id) paperIds.add(paper.paper_id);
      if (paper.dedupe_key) dedupeKeys.add(paper.dedupe_key);
    }
  }
  return { paperIds, dedupeKeys };
}

function isExcludedCandidate(paper, exclusions) {
  return exclusions.paperIds.has(paper.paper_id)
    || exclusions.dedupeKeys.has(paper.dedupe_key);
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

async function readTransaction(runStore, runId, artifactPrefix = "") {
  try {
    return await runStore.readArtifact(
      runId,
      `${artifactPrefix}inputs/source-scan-transaction.json`,
    );
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function scanTransactionNamespace(runId, scanKey) {
  if (scanKey === null || scanKey === undefined) {
    return {
      artifactPrefix: "",
      transactionId: `source-scan:${runId}`,
    };
  }
  if (
    typeof scanKey !== "string"
    || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(scanKey)
  ) {
    throw new Error("SOURCE_SCAN_KEY_INVALID");
  }
  return {
    artifactPrefix: `refresh/${scanKey}/`,
    transactionId: `source-scan:${runId}:${scanKey}`,
  };
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
  artifactPrefix = "",
}) {
  const commit = await sourceStateStore.commitScanTransaction({
    transactionId: transaction.transaction_id,
    expectedRevision: transaction.expected_source_state_revision,
    sourceScans,
    observedAt: transaction.observed_at,
  });
  const committedScans = committedSourceScans(sourceScans);
  await runStore.writeArtifact(runId, `${artifactPrefix}inputs/source-scans.json`, committedScans);
  await runStore.writeArtifact(runId, `${artifactPrefix}inputs/source-scan-transaction.json`, {
    ...transaction,
    status: "committed",
    committed_source_state_revision: commit.revision,
    committed_at: transaction.committed_at ?? new Date().toISOString(),
  });
  if (transaction.status !== "committed") {
    await runStore.appendEvent(runId, {
      type: transaction.event_type ?? "source_scan_completed",
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
  scanKey = null,
} = {}) {
  if (!runId || !runStore || !sourceStateStore) {
    throw new Error("runId, runStore, and sourceStateStore are required");
  }
  const { artifactPrefix, transactionId } = scanTransactionNamespace(runId, scanKey);
  const transaction = await readTransaction(runStore, runId, artifactPrefix);
  if (
    transaction?.schema_version !== 1
    || transaction.transaction_id !== transactionId
    || !["staged", "committed"].includes(transaction.status)
  ) {
    throw new Error("SOURCE_SCAN_TRANSACTION_NOT_READY");
  }
  const [sourceScans, summary, candidates] = await Promise.all([
    runStore.readArtifact(runId, `${artifactPrefix}inputs/source-scans.json`),
    runStore.readArtifact(runId, `${artifactPrefix}inputs/scan-summary.json`),
    runStore.readArtifact(runId, `${artifactPrefix}inputs/ranking-pool.json`),
    ...requiredArtifacts.map((artifact) => (
      runStore.readArtifact(runId, `${artifactPrefix}${artifact}`)
    )),
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
    artifactPrefix,
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
  dismissedKeys = [],
  // 本月保留多少个“领域视野”名额（拓宽选题面，仍在 11 个刊物内）。
  fieldSlots = DEFAULT_FIELD_SLOTS,
  // 刷新扫描：用独立的事务与工件命名空间，不覆盖首次扫描的证据。
  scanKey = null,
} = {}) {
  if (!runId || !runStore || !sourceStateStore) {
    throw new Error("runId, runStore, and sourceStateStore are required");
  }
  const { artifactPrefix, transactionId } = scanTransactionNamespace(runId, scanKey);
  const existingTransaction = await readTransaction(runStore, runId, artifactPrefix);
  if (
    existingTransaction?.schema_version === 1
    && existingTransaction.transaction_id === transactionId
    && ["staged", "committed"].includes(existingTransaction.status)
  ) {
    const [persistedScans, summary, candidates] = await Promise.all([
      runStore.readArtifact(runId, `${artifactPrefix}inputs/source-scans.json`),
      runStore.readArtifact(runId, `${artifactPrefix}inputs/scan-summary.json`),
      runStore.readArtifact(runId, `${artifactPrefix}inputs/ranking-pool.json`),
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
      artifactPrefix,
    });
  }
  const stateBeforeScan = await sourceStateStore.load();

  async function recordSourceProgress(scan) {
    // 刷新扫描在后台进行，不覆盖首次扫描的逐来源进度记录。
    if (scanKey) return;
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
      await runStore.writeArtifact(runId, `${artifactPrefix}sources/${source.source_id}.json`, artifact);
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
  const scannedRecords = sourceScans
    .filter((scan) => scan.status === "success" && scan.output_persisted)
    .flatMap((scan) => scan.papers);
  const newRecords = deduplicatePapers(
    scannedRecords.filter((paper) => paper.is_new),
  );
  let previousRuns = [];
  if (typeof runStore.listRuns === "function") {
    try {
      previousRuns = await runStore.listRuns();
    } catch {
      previousRuns = [];
    }
  }
  const exclusions = candidateExclusions(previousRuns, dismissedKeys);
  // Source cursors keep first-discovery semantics, but a paper that is still in the
  // live publication window must not disappear merely because an earlier scan saw it.
  // Read, collected, and explicitly dismissed identities remain excluded.
  const reconsideredRecords = deduplicatePapers(
    scannedRecords
      .filter((paper) => !paper.is_new)
      .filter((paper) => publicationDiscovery(
        paper.published_at,
        observedAt,
        paper.publication_date_precision,
      ).published_this_month)
      .filter((paper) => !isExcludedCandidate(paper, exclusions)),
  );
  const candidateRecords = deduplicatePapers([
    ...newRecords,
    ...reconsideredRecords,
  ]).filter((paper) => !isExcludedCandidate(paper, exclusions));
  const likelyRelevant = filterTopicCandidates(candidateRecords);
  // 丰富选题面：除了窄主题命中，还优先把“领域视野”命中的论文纳入富化池，
  // 让它们有机会成为候选；剩余名额再用其他新记录补齐。
  const fieldRelevant = filterFieldCandidates(candidateRecords)
    .filter((paper) => !likelyRelevant.includes(paper));
  const isInPublicationWindow = (paper) => publicationDiscovery(
    paper.published_at,
    observedAt,
    paper.publication_date_precision,
  ).published_this_month;
  const currentRelevant = deduplicatePapers([
    ...likelyRelevant.filter(isInPublicationWindow),
    ...fieldRelevant.filter(isInPublicationWindow),
  ]);
  const enrichmentPool = deduplicatePapers([
    ...currentRelevant,
    ...likelyRelevant,
    ...fieldRelevant,
    ...candidateRecords.filter(
      (paper) => !likelyRelevant.includes(paper) && !fieldRelevant.includes(paper),
    ),
  ]).slice(0, MAX_ENRICHMENT_PAPERS);
  const enriched = await enrichPapersWithOpenAlex(enrichmentPool, {
    fetchImpl,
    mailto: openAlexMailto,
  });
  const discovered = enriched.map((paper) => ({
    ...paper,
    ...publicationDiscovery(
      paper.published_at,
      observedAt,
      paper.publication_date_precision,
    ),
  }));
  const topicCandidates = deduplicatePapers(filterTopicCandidates(discovered));
  const coreKeys = new Set(topicCandidates.map((paper) => paper.dedupe_key).filter(Boolean));
  // 领域视野候选：命中更宽领域规则、但不属于窄主题核心的论文，标上“领域视野”。
  const boundedFieldSlots = Number.isInteger(fieldSlots)
    ? Math.max(0, Math.min(fieldSlots, 4))
    : DEFAULT_FIELD_SLOTS;
  const fieldCandidates = boundedFieldSlots === 0
    ? []
    : deduplicatePapers(filterFieldCandidates(discovered))
      .filter((paper) => !paper.dedupe_key || !coreKeys.has(paper.dedupe_key))
      .filter((paper) => (paper.topic_matches?.length ?? 0) === 0)
      .map((paper) => ({
        ...paper,
        candidate_scope: "field",
        display_label: `${paper.display_label} · 领域视野`,
      }));
  const recentCore = topicCandidates.filter((paper) => paper.published_this_month);
  const recentField = fieldCandidates.filter((paper) => paper.published_this_month);
  // 为本月的 5 篇预留领域名额：核心优先，但至少留出几个位置给领域视野。
  const fieldReserve = Math.min(boundedFieldSlots, recentField.length, 4);
  const coreCount = Math.min(recentCore.length, Math.max(0, 5 - fieldReserve));
  const recentSelected = [
    ...recentCore.slice(0, coreCount),
    ...recentField.slice(0, fieldReserve),
  ];
  // 本月新论文不足时的回补：核心+领域的历史首次发现（按发表时间降序）
  // → 往期未读回补 → 经典池。之前补发现曾被整体丢弃，导致候选全是多年前经典。
  const historicalDiscoveries = [...topicCandidates, ...fieldCandidates]
    .filter((paper) => !paper.published_this_month)
    .sort((left, right) => String(right.published_at ?? "").localeCompare(String(left.published_at ?? "")))
    .slice(0, Math.max(0, 5 - recentSelected.length));
  let resurfacedCandidates = [];
  const filledCount = recentSelected.length + historicalDiscoveries.length;
  if (filledCount < 5 && previousRuns.length > 0) {
    try {
      resurfacedCandidates = selectResurfaceCandidates({
        previousRuns,
        currentCandidates: [...recentSelected, ...topicCandidates, ...fieldCandidates],
        currentRunId: runId,
        limit: 5 - filledCount,
        observedAt,
        dismissedKeys,
      });
    } catch {
      // 回补是锦上添花；历史 Run 读取失败不影响本月扫描。
      resurfacedCandidates = [];
    }
  }
  const candidateBatch = buildCandidateBatch({
    newCandidates: [
      ...recentSelected,
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
    reconsidered_record_count: reconsideredRecords.length,
    topic_candidate_count: topicCandidates.length,
    recent_topic_candidate_count: recentCore.length,
    field_candidate_count: fieldCandidates.length,
    recent_field_candidate_count: recentField.length,
    field_slots_reserved: fieldReserve,
    historical_backfill_count: historicalDiscoveries.length,
    resurfaced_candidate_count: resurfacedCandidates.length,
    historical_discovery_count: topicCandidates.filter((paper) => !paper.published_this_month).length,
    candidate_mode: candidateBatch.mode,
    fallback_reason: candidateBatch.fallback_reason,
  };
  await runStore.writeArtifact(runId, `${artifactPrefix}inputs/source-scans.json`, sourceScans);
  await runStore.writeArtifact(runId, `${artifactPrefix}inputs/scan-summary.json`, summary);
  await runStore.writeArtifact(runId, `${artifactPrefix}inputs/ranking-pool.json`, candidateBatch.candidates);
  const transaction = {
    schema_version: 1,
    transaction_id: transactionId,
    run_id: runId,
    status: "staged",
    observed_at: observedAt,
    expected_source_state_revision: stateBeforeScan.revision,
    candidate_mode: candidateBatch.mode,
    fallback_reason: candidateBatch.fallback_reason,
    ...(scanKey ? { scan_key: scanKey, event_type: "refresh_scan_completed" } : {}),
  };
  await runStore.writeArtifact(
    runId,
    `${artifactPrefix}inputs/source-scan-transaction.json`,
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
    artifactPrefix,
  });
}
