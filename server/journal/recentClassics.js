import { restoreOpenAlexAbstract } from "./openAlexEnricher.js";
import {
  deduplicatePapers,
  filterTopicCandidates,
  normalizePaper,
} from "./monitorCore.js";
import { SOURCE_REGISTRY } from "./sourceRegistry.js";

export const RECENT_CLASSIC_LABEL = "近年高引 · 未读经典";

const DEFAULT_YEARS_BACK = 4;
const DEFAULT_LIMIT = 8;
const MIN_CITED_BY = 25;
const PER_PAGE = 60;
const OPENALEX_TIMEOUT_MS = 20_000;
const SELECT_FIELDS = [
  "id",
  "title",
  "publication_date",
  "doi",
  "cited_by_count",
  "abstract_inverted_index",
  "authorships",
  "primary_location",
  "best_oa_location",
].join(",");

function compact(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeDoi(value) {
  const text = compact(value);
  if (!text) return null;
  return text.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").toLowerCase() || null;
}

function openAlexShortId(value) {
  const text = compact(value);
  const match = text.match(/S\d+$/);
  return match ? match[0] : null;
}

function openAlexPdfUrl(work) {
  const candidates = [
    work?.best_oa_location?.pdf_url,
    work?.primary_location?.pdf_url,
  ];
  for (const candidate of candidates) {
    const url = compact(candidate);
    if (url.startsWith("http")) return url;
  }
  return null;
}

function identityKeys(paper) {
  const keys = [];
  if (paper?.paper_id) keys.push(`id:${paper.paper_id}`);
  if (paper?.dedupe_key) keys.push(`key:${paper.dedupe_key}`);
  return keys;
}

// 收集需要排除的稳定身份：当前候选、往期已读/已收藏/进过候选的论文、已标记不感兴趣的论文。
export function collectExclusionKeys({
  previousRuns = [],
  currentCandidates = [],
  dismissedKeys = [],
} = {}) {
  const keys = new Set();
  for (const paper of currentCandidates) {
    for (const key of identityKeys(paper)) keys.add(key);
  }
  for (const run of previousRuns) {
    const decisions = run?.paper_decisions ?? {};
    for (const paper of Array.isArray(run?.candidates) ? run.candidates : []) {
      const decision = decisions[paper.paper_id];
      // 已读/已收藏的永久排除；只是出现过但未处理的不排除（还有机会再见到）。
      if (decision === "read" || decision === "collect") {
        for (const key of identityKeys(paper)) keys.add(key);
      }
    }
  }
  for (const key of dismissedKeys) {
    if (typeof key === "string" && key) keys.add(`key:${key}`);
  }
  return keys;
}

/**
 * 从注册刊物里确定性拉取近几年的高引论文，作为「近年高引 · 未读经典」栏目。
 * 只用 OpenAlex 题录（不调模型、不下载全文）；覆盖范围限于有可靠
 * openalex_source_id 的注册来源，并在结果中如实标注覆盖了哪些来源。
 */
export async function fetchRecentClassics({
  sources = SOURCE_REGISTRY,
  fetchImpl = globalThis.fetch,
  yearsBack = DEFAULT_YEARS_BACK,
  limit = DEFAULT_LIMIT,
  mailto = "",
  observedAt = new Date().toISOString(),
  excludeKeys = new Set(),
  timeoutMs = OPENALEX_TIMEOUT_MS,
} = {}) {
  const covered = sources.filter((source) => compact(source.openalex_source_id));
  const uncovered = sources
    .filter((source) => !compact(source.openalex_source_id))
    .map((source) => source.source_id);
  if (covered.length === 0) {
    return {
      schema_version: 1,
      status: "failed",
      papers: [],
      covered_source_ids: [],
      uncovered_source_ids: uncovered,
      from_year: null,
      observed_at: observedAt,
      error: { code: "NO_OPENALEX_SOURCES", message: "没有可用的 OpenAlex 来源标识" },
    };
  }
  const fromYear = new Date(observedAt).getUTCFullYear() - yearsBack;
  const sourceById = new Map(
    covered.map((source) => [source.openalex_source_id, source]),
  );
  const filter = [
    `primary_location.source.id:${covered.map((source) => source.openalex_source_id).join("|")}`,
    `from_publication_date:${fromYear}-01-01`,
    `cited_by_count:>${MIN_CITED_BY}`,
  ].join(",");
  const url = new URL("https://api.openalex.org/works");
  url.searchParams.set("filter", filter);
  url.searchParams.set("sort", "cited_by_count:desc");
  url.searchParams.set("per-page", String(PER_PAGE));
  url.searchParams.set("select", SELECT_FIELDS);
  if (compact(mailto)) url.searchParams.set("mailto", compact(mailto));

  let works;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url.toString(), {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw Object.assign(
          new Error(`OpenAlex 返回 HTTP ${response.status}`),
          { code: `OPENALEX_HTTP_${response.status}` },
        );
      }
      const body = await response.json();
      works = Array.isArray(body?.results) ? body.results : [];
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return {
      schema_version: 1,
      status: "failed",
      papers: [],
      covered_source_ids: covered.map((source) => source.source_id),
      uncovered_source_ids: uncovered,
      from_year: fromYear,
      observed_at: observedAt,
      error: {
        code: typeof error?.code === "string" ? error.code : "OPENALEX_FETCH_FAILED",
        message: compact(error?.message).slice(0, 200) || "OpenAlex 请求失败",
      },
    };
  }

  const normalized = [];
  for (const work of works) {
    const title = compact(work?.title);
    if (!title) continue;
    const shortId = openAlexShortId(work?.primary_location?.source?.id);
    const registered = shortId ? sourceById.get(shortId) : null;
    if (!registered) continue;
    const doi = normalizeDoi(work?.doi);
    const doiUrl = doi ? `https://doi.org/${encodeURI(doi)}` : null;
    const landingUrl = compact(work?.primary_location?.landing_page_url) || null;
    const citedByCount = Number.isInteger(work?.cited_by_count) ? work.cited_by_count : 0;
    try {
      const paper = normalizePaper({
        title,
        authors: (Array.isArray(work?.authorships) ? work.authorships : [])
          .map((authorship) => compact(authorship?.author?.display_name))
          .filter(Boolean),
        venue: registered.venue,
        paper_type: registered.source_type === "journal" ? "journal-article" : "conference-paper",
        published_at: compact(work?.publication_date) || null,
        doi,
        official_id: doi || compact(work?.id) || title,
        official_url: landingUrl || doiUrl || compact(work?.id),
        canonical_url: doiUrl || landingUrl || null,
        pdf_url: openAlexPdfUrl(work),
        abstract: restoreOpenAlexAbstract(work?.abstract_inverted_index),
        evidence_scope: "OpenAlex 高引题录；摘要与全文尚待核验",
        heat_signals: [`OpenAlex 引用记录：${citedByCount}`],
        candidate_origin: "recent_classic",
        is_new: false,
      }, { sourceId: registered.source_id, observedAt });
      normalized.push({ ...paper, cited_by_count: citedByCount });
    } catch {
      // 无法建立稳定身份的记录跳过，不阻断整批结果。
    }
  }

  const topicRelevant = filterTopicCandidates(deduplicatePapers(normalized));
  const papers = topicRelevant
    .filter((paper) => !identityKeys(paper).some((key) => excludeKeys.has(key)))
    .sort((left, right) => (right.cited_by_count ?? 0) - (left.cited_by_count ?? 0))
    .slice(0, limit)
    .map((paper) => ({
      ...paper,
      published_this_month: false,
      display_label: RECENT_CLASSIC_LABEL,
    }));

  return {
    schema_version: 1,
    status: "success",
    papers,
    covered_source_ids: covered.map((source) => source.source_id),
    uncovered_source_ids: uncovered,
    from_year: fromYear,
    observed_at: observedAt,
    error: null,
  };
}
