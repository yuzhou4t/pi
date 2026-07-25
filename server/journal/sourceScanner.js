import { buildCandidateBatch } from "./classicFallback.js";
import { fetchDblpSource } from "./dblpAdapter.js";
import {
  buildSourceScan,
  deduplicatePapers,
  filterTopicCandidates,
  normalizePaper,
} from "./monitorCore.js";
import { enrichPapersWithOpenAlex } from "./openAlexEnricher.js";
import { SOURCE_REGISTRY } from "./sourceRegistry.js";

const MAX_PAPERS_PER_SOURCE = 80;
const MAX_ENRICHMENT_PAPERS = 40;
const WEEK_WINDOW_MS = 8 * 24 * 60 * 60 * 1000;

export function publicationDiscovery(publishedAt, observedAt) {
  const published = Date.parse(publishedAt);
  const observed = Date.parse(observedAt);
  const age = observed - published;
  const publishedThisWeek = Number.isFinite(age) && age >= -24 * 60 * 60 * 1000 && age <= WEEK_WINDOW_MS;
  return {
    published_this_week: publishedThisWeek,
    display_label: publishedThisWeek ? "本周新论文" : "本周补发现 · 非本周新论文",
  };
}

function errorRecord(error) {
  return {
    code: typeof error?.message === "string" ? error.message.slice(0, 160) : "SOURCE_SCAN_FAILED",
    retryable: error?.name === "AbortError" || /^DBLP_HTTP_(429|5\d\d)$/.test(error?.message ?? ""),
  };
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
  fetchSource = fetchDblpSource,
  fetchImpl = globalThis.fetch,
  observedAt = new Date().toISOString(),
  maxPapersPerSource = MAX_PAPERS_PER_SOURCE,
  concurrency = 1,
  sourceDelayMs = fetchSource === fetchDblpSource ? 1500 : 0,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  openAlexMailto = "",
} = {}) {
  if (!runId || !runStore || !sourceStateStore) {
    throw new Error("runId, runStore, and sourceStateStore are required");
  }
  let sourceState = await sourceStateStore.load();
  const stateBeforeScan = sourceState;

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
      const fetched = await fetchSource(source, { fetchImpl });
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
          outputPersisted: true,
          papers: classified,
        }),
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
      await recordSourceProgress(scan);
      return scan;
    } finally {
      if (sourceDelayMs > 0 && index < sources.length - 1) {
        await sleep(sourceDelayMs);
      }
    }
  });
  for (const scan of sourceScans) {
    sourceState = scan.status === "success" && scan.cursor_committed
      ? sourceStateStore.applySuccessfulScan(sourceState, {
          sourceId: scan.source_id,
          papers: scan.papers,
          cursorAfter: scan.cursor_after,
          observedAt,
        })
      : sourceStateStore.applyFailedScan(sourceState, {
          sourceId: scan.source_id,
          error: scan.error?.code ?? "SOURCE_SCAN_FAILED",
          observedAt,
        });
  }
  await sourceStateStore.save(sourceState);

  const newRecords = deduplicatePapers(
    sourceScans
      .filter((scan) => scan.status === "success" && scan.cursor_committed)
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
  const topicCandidates = filterTopicCandidates(enriched.map((paper) => ({
    ...paper,
    ...publicationDiscovery(paper.published_at, observedAt),
  })));
  const recentTopicCandidates = topicCandidates.filter((paper) => paper.published_this_week);
  const candidateBatch = buildCandidateBatch({
    newCandidates: recentTopicCandidates,
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
    historical_discovery_count: topicCandidates.filter((paper) => !paper.published_this_week).length,
    candidate_mode: candidateBatch.mode,
    fallback_reason: candidateBatch.fallback_reason,
  };
  await runStore.writeArtifact(runId, "inputs/source-scans.json", sourceScans);
  await runStore.writeArtifact(runId, "inputs/scan-summary.json", summary);
  await runStore.writeArtifact(runId, "inputs/ranking-pool.json", candidateBatch.candidates);
  await runStore.appendEvent(runId, {
    type: "source_scan_completed",
    at: observedAt,
    ...summary,
  });

  return {
    sourceScans,
    summary,
    candidateBatch,
  };
}
