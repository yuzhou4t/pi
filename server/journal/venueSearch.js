import { DBLP_MIRROR_BASE_URLS, pdfCandidatesForUrl } from "./dblpAdapter.js";
import { deduplicatePapers, normalizePaper } from "./monitorCore.js";
import { enrichPapersWithOpenAlex, restoreOpenAlexAbstract } from "./openAlexEnricher.js";
import { SOURCE_REGISTRY } from "./sourceRegistry.js";

const OPENALEX_WORKS_URL = "https://api.openalex.org/works";
const DBLP_PUBL_SEARCH_PATH = "search/publ/api";
const OPENALEX_SELECT = [
  "id",
  "title",
  "publication_date",
  "doi",
  "cited_by_count",
  "relevance_score",
  "abstract_inverted_index",
  "authorships",
  "primary_location",
  "best_oa_location",
  "locations",
].join(",");

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_PER_VENUE = 25;
const DEFAULT_LIMIT = 20;
const MAX_JOURNAL_ROWS = 50;
const MAX_QUERY_CHARS = 300;
const MAX_ENRICHMENT = 20;

export class VenueSearchError extends Error {
  constructor(code, message, { retryable = false } = {}) {
    super(message);
    this.name = "VenueSearchError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function normalizeSearchQuery(query) {
  const text = typeof query === "string" ? query.trim().replace(/\s+/g, " ") : "";
  if (!text) {
    throw new VenueSearchError("VENUE_SEARCH_QUERY_EMPTY", "检索问题不能为空");
  }
  return text.slice(0, MAX_QUERY_CHARS);
}

function compact(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function openAlexShortId(value) {
  return compact(value).replace(/^https?:\/\/openalex\.org\//i, "");
}

function normalizeDoi(value) {
  const text = compact(value);
  if (!text) return null;
  return text.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").toLowerCase();
}

async function fetchJsonWithTimeout(fetchImpl, url, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  headers = {},
  errorPrefix = "VENUE_SEARCH",
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: {
        accept: "application/json",
        "user-agent": "Pi-Agent-Journal-Monitor/0.1",
        ...headers,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new VenueSearchError(
        `${errorPrefix}_HTTP_${response.status}`,
        `检索请求返回 HTTP ${response.status}`,
        { retryable: response.status === 429 || response.status >= 500 },
      );
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function openAlexPdfUrl(work) {
  const candidates = [
    work?.best_oa_location?.pdf_url,
    work?.primary_location?.pdf_url,
    ...(Array.isArray(work?.locations) ? work.locations.map((location) => location?.pdf_url) : []),
  ];
  return candidates.map(compact).find((value) => value.startsWith("https://")) ?? null;
}

function mapOpenAlexWork(work, fallbackVenue) {
  const title = compact(work?.title);
  if (!title) return null;
  const doi = normalizeDoi(work?.doi);
  const authors = (Array.isArray(work?.authorships) ? work.authorships : [])
    .map((authorship) => compact(authorship?.author?.display_name))
    .filter(Boolean);
  const abstract = restoreOpenAlexAbstract(work?.abstract_inverted_index);
  const landingUrl = compact(work?.primary_location?.landing_page_url);
  const doiUrl = doi ? `https://doi.org/${encodeURI(doi)}` : null;
  const citedByCount = Number.isInteger(work?.cited_by_count) ? work.cited_by_count : null;
  const relevance = Number.isFinite(work?.relevance_score) ? work.relevance_score : 0;
  return {
    raw: {
      title,
      authors,
      venue: compact(work?.primary_location?.source?.display_name) || fallbackVenue,
      paper_type: "journal-article",
      published_at: compact(work?.publication_date) || null,
      publication_date_precision: work?.publication_date ? "day" : "unknown",
      doi,
      official_id: doi || compact(work?.id) || title,
      official_url: landingUrl || doiUrl || compact(work?.id),
      canonical_url: doiUrl || landingUrl || null,
      pdf_url: openAlexPdfUrl(work),
      abstract,
      evidence_scope: abstract
        ? "OpenAlex 检索题录与摘要；全文尚待核验"
        : "OpenAlex 检索题录；摘要与全文尚待核验",
      heat_signals: citedByCount === null ? [] : [`OpenAlex 引用记录：${citedByCount}`],
    },
    relevance,
    citedByCount,
    channel: "openalex-search",
  };
}

async function searchJournalsViaOpenAlex(journals, {
  query,
  fetchImpl,
  perVenue,
  fromYear,
  mailto,
  timeoutMs,
}) {
  const statuses = new Map(journals.map((source) => [
    openAlexShortId(source.openalex_source_id),
    {
      source_id: source.source_id,
      short_name: source.short_name,
      channel: "openalex-search",
      status: "empty",
      count: 0,
      error: null,
    },
  ]));
  const idToSource = new Map(journals.map((source) => [
    openAlexShortId(source.openalex_source_id),
    source,
  ]));
  const filters = [
    `primary_location.source.id:${journals.map((source) => openAlexShortId(source.openalex_source_id)).join("|")}`,
  ];
  if (Number.isInteger(fromYear)) {
    filters.push(`from_publication_date:${fromYear}-01-01`);
  }
  const url = new URL(OPENALEX_WORKS_URL);
  url.searchParams.set("search", query);
  url.searchParams.set("filter", filters.join(","));
  url.searchParams.set("select", OPENALEX_SELECT);
  url.searchParams.set(
    "per-page",
    String(Math.min(MAX_JOURNAL_ROWS, Math.max(perVenue, perVenue * journals.length))),
  );
  if (mailto) url.searchParams.set("mailto", mailto);

  const records = [];
  try {
    const body = await fetchJsonWithTimeout(fetchImpl, url, {
      timeoutMs,
      headers: mailto
        ? { "user-agent": `Pi-Agent-Journal-Monitor/0.1 (mailto:${mailto})` }
        : {},
      errorPrefix: "OPENALEX",
    });
    const results = Array.isArray(body?.results) ? body.results : [];
    for (const work of results) {
      const shortId = openAlexShortId(work?.primary_location?.source?.id);
      const source = idToSource.get(shortId);
      if (!source) continue;
      const mapped = mapOpenAlexWork(work, source.venue);
      if (!mapped) continue;
      const status = statuses.get(shortId);
      status.status = "success";
      status.count += 1;
      records.push({ ...mapped, sourceId: source.source_id });
    }
  } catch (error) {
    for (const status of statuses.values()) {
      status.status = "failed";
      status.error = {
        code: error?.code ?? "OPENALEX_SEARCH_FAILED",
        retryable: Boolean(error?.retryable),
      };
    }
  }
  return { records, statuses: [...statuses.values()] };
}

function dblpAuthors(info) {
  const author = info?.authors?.author;
  const list = Array.isArray(author) ? author : author ? [author] : [];
  return list.map((entry) => compact(entry?.text ?? entry)).filter(Boolean);
}

function mapDblpHit(hit, source) {
  const info = hit?.info;
  const title = compact(info?.title).replace(/\.$/, "");
  if (!title) return null;
  const doi = normalizeDoi(info?.doi);
  const eeValues = Array.isArray(info?.ee) ? info.ee : info?.ee ? [info.ee] : [];
  const officialUrl = eeValues.map(compact).find(Boolean) || compact(info?.url);
  const pdfCandidates = [...new Set(eeValues.flatMap((value) => pdfCandidatesForUrl(compact(value))))];
  const year = compact(info?.year);
  return {
    raw: {
      title,
      authors: dblpAuthors(info),
      venue: compact(info?.venue) || source.short_name,
      paper_type: "conference-paper",
      published_at: /^\d{4}$/.test(year) ? year : null,
      publication_date_precision: /^\d{4}$/.test(year) ? "year" : "unknown",
      doi,
      official_id: compact(info?.key) || doi || title,
      official_url: officialUrl || (doi ? `https://doi.org/${encodeURI(doi)}` : null),
      canonical_url: doi ? `https://doi.org/${encodeURI(doi)}` : officialUrl || null,
      pdf_url: pdfCandidates[0] ?? null,
      abstract: "",
      evidence_scope: "DBLP 检索题录；摘要与全文尚待获取",
    },
    relevance: 0,
    citedByCount: null,
    channel: "dblp-search",
  };
}

async function searchConferenceViaDblp(source, {
  query,
  fetchImpl,
  perVenue,
  timeoutMs,
}) {
  const status = {
    source_id: source.source_id,
    short_name: source.short_name,
    channel: "dblp-search",
    status: "empty",
    count: 0,
    error: null,
  };
  const search = new URLSearchParams({
    q: `${query} streamid:${source.dblp_path}:`,
    format: "json",
    h: String(perVenue),
  });
  const records = [];
  let lastError = null;
  // DBLP throttles a single host aggressively; rotate through its official
  // mirrors before giving up so one hot mirror does not blank a venue.
  for (const base of DBLP_MIRROR_BASE_URLS) {
    const url = new URL(`${DBLP_PUBL_SEARCH_PATH}?${search.toString()}`, base);
    try {
      const body = await fetchJsonWithTimeout(fetchImpl, url, {
        timeoutMs,
        errorPrefix: "DBLP",
      });
      const hits = body?.result?.hits?.hit;
      const list = Array.isArray(hits) ? hits : hits ? [hits] : [];
      for (const hit of list) {
        const mapped = mapDblpHit(hit, source);
        if (!mapped) continue;
        status.status = "success";
        status.count += 1;
        records.push({ ...mapped, sourceId: source.source_id });
      }
      return { records, status };
    } catch (error) {
      lastError = error;
    }
  }
  status.status = "failed";
  status.error = {
    code: lastError?.code ?? "DBLP_SEARCH_FAILED",
    retryable: Boolean(lastError?.retryable),
  };
  return { records, status };
}

async function searchConferencesViaDblp(conferences, {
  query,
  fetchImpl,
  perVenue,
  timeoutMs,
  requestDelayMs,
  sleep,
}) {
  // DBLP rate-limits bursts (HTTP 429), so conference streams are searched
  // sequentially with a short pause between requests, mirroring the paced
  // weekly scan rather than firing every stream at once.
  const results = [];
  for (const [index, source] of conferences.entries()) {
    if (index > 0 && requestDelayMs > 0) await sleep(requestDelayMs);
    results.push(await searchConferenceViaDblp(source, {
      query,
      fetchImpl,
      perVenue,
      timeoutMs,
    }));
  }
  return results;
}

function rankScore(paper) {
  const relevance = Number.isFinite(paper.search_relevance) ? paper.search_relevance : 0;
  const cites = Number.isInteger(paper.cited_by_count) ? paper.cited_by_count : 0;
  const year = Number.parseInt(compact(paper.published_at).slice(0, 4), 10);
  const recency = Number.isInteger(year) ? year : 0;
  return relevance * 1000 + Math.min(cites, 500) + recency / 10000;
}

export async function searchRegisteredVenues({
  query,
  sources = SOURCE_REGISTRY,
  fetchImpl = globalThis.fetch,
  limit = DEFAULT_LIMIT,
  perVenue = DEFAULT_PER_VENUE,
  fromYear = null,
  mailto = "",
  enrich = true,
  observedAt = new Date().toISOString(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  requestDelayMs = 700,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const normalizedQuery = normalizeSearchQuery(query);
  const journals = sources.filter((source) => compact(source.openalex_source_id));
  const conferences = sources.filter(
    (source) => source.source_type === "conference" && compact(source.dblp_path),
  );

  const [journalResult, conferenceResults] = await Promise.all([
    journals.length > 0
      ? searchJournalsViaOpenAlex(journals, {
          query: normalizedQuery,
          fetchImpl,
          perVenue,
          fromYear,
          mailto,
          timeoutMs,
        })
      : Promise.resolve({ records: [], statuses: [] }),
    searchConferencesViaDblp(conferences, {
      query: normalizedQuery,
      fetchImpl,
      perVenue,
      timeoutMs,
      requestDelayMs,
      sleep,
    }),
  ]);

  const venueStatuses = [
    ...journalResult.statuses,
    ...conferenceResults.map((result) => result.status),
  ];
  const rawRecords = [
    ...journalResult.records,
    ...conferenceResults.flatMap((result) => result.records),
  ];

  const normalized = [];
  for (const record of rawRecords) {
    try {
      const paper = normalizePaper(
        { ...record.raw, candidate_origin: "venue_search", is_new: false },
        { sourceId: record.sourceId, observedAt },
      );
      normalized.push({
        ...paper,
        discovery_channel: record.channel,
        search_relevance: record.relevance,
        cited_by_count: record.citedByCount,
      });
    } catch {
      // 无法建立稳定身份的记录跳过，不阻断整批检索结果。
    }
  }

  let deduped = deduplicatePapers(normalized);

  if (enrich) {
    const missingAbstract = deduped
      .filter((paper) => !compact(paper.abstract) && compact(paper.doi))
      .slice(0, MAX_ENRICHMENT);
    if (missingAbstract.length > 0) {
      const enrichedById = new Map(
        (await enrichPapersWithOpenAlex(missingAbstract, { fetchImpl, mailto }))
          .map((paper) => [paper.paper_id, paper]),
      );
      deduped = deduped.map((paper) => enrichedById.get(paper.paper_id) ?? paper);
    }
  }

  const ranked = deduped
    .map((paper) => ({ ...paper, search_rank_score: rankScore(paper) }))
    .sort((left, right) => right.search_rank_score - left.search_rank_score);
  const papers = ranked.slice(0, limit).map((paper, index) => ({
    ...paper,
    search_rank: index + 1,
  }));

  return {
    schema_version: 1,
    query: normalizedQuery,
    observed_at: observedAt,
    from_year: Number.isInteger(fromYear) ? fromYear : null,
    venues: venueStatuses,
    venue_success_count: venueStatuses.filter((status) => status.status === "success").length,
    venue_failed_ids: venueStatuses
      .filter((status) => status.status === "failed")
      .map((status) => status.source_id),
    total_found: deduped.length,
    truncated: deduped.length > papers.length,
    papers,
  };
}
