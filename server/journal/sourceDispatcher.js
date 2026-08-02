import { fetchDblpSource } from "./dblpAdapter.js";
import {
  OFFICIAL_SOURCE_ADAPTERS,
} from "./officialSourceAdapters.js";

const MAX_CROSSREF_ROWS = 80;
const MAX_CROSSREF_BODY_CHARS = 12 * 1024 * 1024;

export class SourceDispatchError extends Error {
  constructor(code, message, { attempts = [], retryable = false } = {}) {
    super(message);
    this.name = "SourceDispatchError";
    this.code = code;
    this.attempts = attempts;
    this.retryable = retryable;
  }
}

function compact(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function dateParts(value) {
  const parts = value?.["date-parts"]?.[0];
  if (!Array.isArray(parts) || !Number.isInteger(parts[0])) {
    return { value: null, precision: "unknown" };
  }
  if (Number.isInteger(parts[1]) && Number.isInteger(parts[2])) {
    return {
      value: `${String(parts[0]).padStart(4, "0")}-${String(parts[1]).padStart(2, "0")}-${String(parts[2]).padStart(2, "0")}`,
      precision: "day",
    };
  }
  if (Number.isInteger(parts[1])) {
    return {
      value: `${String(parts[0]).padStart(4, "0")}-${String(parts[1]).padStart(2, "0")}`,
      precision: "month",
    };
  }
  return { value: String(parts[0]), precision: "year" };
}

function crossrefPublicationDate(item) {
  for (const candidate of [item?.["published-online"], item?.["published-print"], item?.issued]) {
    const normalized = dateParts(candidate);
    if (normalized.value) return normalized;
  }
  return { value: null, precision: "unknown" };
}

function crossrefPdfUrl(item) {
  const links = Array.isArray(item?.link) ? item.link : [];
  return links
    .filter((link) => compact(link?.URL).startsWith("https://"))
    .find((link) => /application\/pdf/i.test(compact(link?.["content-type"])))?.URL ?? null;
}

function crossrefAuthors(item) {
  return (Array.isArray(item?.author) ? item.author : [])
    .map((author) => compact([author?.given, author?.family].filter(Boolean).join(" ")))
    .filter(Boolean);
}

function normalizeCrossrefItem(item, source) {
  const title = compact(Array.isArray(item?.title) ? item.title[0] : item?.title);
  const doi = compact(item?.DOI);
  if (!title || !doi) return null;
  const publication = crossrefPublicationDate(item);
  const doiUrl = `https://doi.org/${encodeURI(doi)}`;
  return {
    title,
    authors: crossrefAuthors(item),
    venue: compact(Array.isArray(item?.["container-title"])
      ? item["container-title"][0]
      : item?.["container-title"]) || source.venue,
    paper_type: compact(item?.type) || "journal-article",
    published_at: publication.value,
    publication_date_precision: publication.precision,
    doi,
    official_id: doi,
    official_url: compact(item?.URL) || doiUrl,
    canonical_url: doiUrl,
    discovery_url: source.fallback.url,
    pdf_url: crossrefPdfUrl(item),
    abstract: compact(item?.abstract).replaceAll(/<[^>]+>/g, " "),
    evidence_scope: "Crossref 题录；摘要与全文尚待核验",
    metadata_source: "crossref",
  };
}

export async function fetchCrossrefSource(source, {
  fetchImpl = globalThis.fetch,
  route = source?.fallback,
  timeoutMs = 15_000,
  rows = MAX_CROSSREF_ROWS,
} = {}) {
  if (!route?.url || route.kind !== "crossref-api") {
    throw new SourceDispatchError(
      "CROSSREF_ROUTE_INVALID",
      `Source ${source?.source_id ?? "unknown"} has no Crossref route`,
    );
  }
  const url = new URL(route.url);
  url.searchParams.set("rows", String(rows));
  url.searchParams.set("sort", "published");
  url.searchParams.set("order", "desc");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: {
        accept: "application/json",
        "user-agent": "Pi-Agent-Journal-Monitor/0.1",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`CROSSREF_HTTP_${response.status}`);
    const text = await response.text();
    if (!text || text.length > MAX_CROSSREF_BODY_CHARS) {
      throw new Error("CROSSREF_BODY_INVALID");
    }
    const body = JSON.parse(text);
    const items = Array.isArray(body?.message?.items) ? body.message.items : null;
    if (!items) throw new Error("CROSSREF_RESPONSE_INVALID");
    return {
      source_id: source.source_id,
      fetched_at: new Date().toISOString(),
      index_url: url.toString(),
      target_urls: [url.toString()],
      papers: items.map((item) => normalizeCrossrefItem(item, source)).filter(Boolean),
    };
  } finally {
    clearTimeout(timer);
  }
}

function attemptError(error) {
  return {
    code: typeof error?.code === "string"
      ? error.code
      : typeof error?.message === "string"
        ? error.message.slice(0, 160)
        : "SOURCE_ROUTE_FAILED",
    retryable: Boolean(
      error?.retryable
      || error?.name === "AbortError"
      || /_HTTP_(429|5\d\d)$/.test(error?.message ?? ""),
    ),
  };
}

export function createSourceDispatcher({
  primaryAdapters = OFFICIAL_SOURCE_ADAPTERS,
  fallbackAdapters = {
    "crossref-api": fetchCrossrefSource,
    "dblp-index": fetchDblpSource,
  },
} = {}) {
  return async function dispatchSource(source, options = {}) {
    if (!source?.source_id || !source?.adapter || !source?.primary || !source?.fallback) {
      throw new SourceDispatchError(
        "SOURCE_REGISTRY_ENTRY_INVALID",
        "Source registry entry is incomplete",
      );
    }
    const attempts = [];
    const routes = [
      {
        role: "primary",
        key: source.adapter,
        route: source.primary,
        adapter: primaryAdapters[source.adapter],
      },
      {
        role: "fallback",
        key: source.fallback.kind,
        route: source.fallback,
        adapter: fallbackAdapters[source.fallback.kind],
      },
    ];

    for (const candidate of routes) {
      if (typeof candidate.adapter !== "function") {
        attempts.push({
          role: candidate.role,
          adapter: candidate.key,
          status: "unavailable",
          error: {
            code: "SOURCE_ADAPTER_NOT_IMPLEMENTED",
            retryable: false,
          },
        });
        continue;
      }
      try {
        const result = await candidate.adapter(source, {
          ...options,
          route: candidate.route,
        });
        // 抓到 0 条不算成功：空结果说明该路由失效或解析失败，
        // 记为路由级失败并继续尝试下一条路由，保持覆盖缺口可见。
        if (!Array.isArray(result?.papers) || result.papers.length === 0) {
          attempts.push({
            role: candidate.role,
            adapter: candidate.key,
            status: "failed",
            error: { code: "SOURCE_ROUTE_EMPTY", retryable: true },
          });
          continue;
        }
        attempts.push({
          role: candidate.role,
          adapter: candidate.key,
          status: "success",
          error: null,
        });
        return {
          ...result,
          dispatch: {
            status: candidate.role === "primary" ? "primary" : "degraded",
            selected_route: candidate.role,
            selected_adapter: candidate.key,
            attempts,
          },
        };
      } catch (error) {
        attempts.push({
          role: candidate.role,
          adapter: candidate.key,
          status: "failed",
          error: attemptError(error),
        });
      }
    }

    throw new SourceDispatchError(
      "SOURCE_ROUTES_EXHAUSTED",
      `No usable source route for ${source.source_id}`,
      {
        attempts,
        retryable: attempts.some((attempt) => attempt.error?.retryable),
      },
    );
  };
}

export const fetchRegisteredSource = createSourceDispatcher();
export { OFFICIAL_SOURCE_ADAPTERS };
