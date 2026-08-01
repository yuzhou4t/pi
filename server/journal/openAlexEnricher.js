const OPENALEX_BASE_URL = "https://api.openalex.org/works";
const DATE_PRECISION_RANK = Object.freeze({
  unknown: 0,
  year: 1,
  month: 2,
  day: 3,
});

function inferredDatePrecision(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return "day";
  if (/^\d{4}-\d{2}$/.test(text)) return "month";
  if (/^\d{4}$/.test(text)) return "year";
  return "unknown";
}

function sourceDatePrecision(paper) {
  const explicit = paper?.publication_date_precision;
  return DATE_PRECISION_RANK[explicit] === undefined
    ? inferredDatePrecision(paper?.published_at)
    : explicit;
}

function openAlexDateInfo(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(Date.parse(`${text}T00:00:00Z`))) {
    return { value: null, precision: "unknown", placeholder: false };
  }
  const placeholder = /^\d{4}-01-01$/.test(text);
  return {
    value: text,
    // OpenAlex commonly expands year-only conference dates to January 1.
    // Record that signal as year precision instead of inventing an exact day.
    precision: placeholder ? "year" : "day",
    placeholder,
  };
}

function dateAgreesWithSource(sourceValue, sourcePrecision, candidateValue) {
  if (!sourceValue || sourcePrecision === "unknown") return true;
  if (sourcePrecision === "year") return candidateValue.startsWith(`${sourceValue.slice(0, 4)}-`);
  if (sourcePrecision === "month") return candidateValue.startsWith(`${sourceValue.slice(0, 7)}-`);
  return candidateValue === sourceValue;
}

function shouldUpgradePublicationDate(paper, candidate) {
  if (!candidate.value || candidate.placeholder) return false;
  const currentPrecision = sourceDatePrecision(paper);
  return DATE_PRECISION_RANK[candidate.precision] > DATE_PRECISION_RANK[currentPrecision]
    && dateAgreesWithSource(paper?.published_at, currentPrecision, candidate.value);
}

export function restoreOpenAlexAbstract(invertedIndex) {
  if (!invertedIndex || typeof invertedIndex !== "object" || Array.isArray(invertedIndex)) return "";
  const words = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    if (!Array.isArray(positions)) continue;
    for (const position of positions) {
      if (Number.isInteger(position) && position >= 0 && position < 100000) words[position] = word;
    }
  }
  return words.filter(Boolean).join(" ").trim();
}

function httpsUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function findPdfUrl(work) {
  const candidates = [
    work?.best_oa_location?.pdf_url,
    work?.primary_location?.pdf_url,
    ...(Array.isArray(work?.locations) ? work.locations.map((location) => location?.pdf_url) : []),
  ];
  return candidates.map(httpsUrl).find(Boolean) ?? null;
}

export async function enrichPaperWithOpenAlex(paper, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 20000,
  mailto = "",
} = {}) {
  if (!paper?.doi) return paper;
  const query = new URL(OPENALEX_BASE_URL);
  query.searchParams.set("filter", `doi:${paper.doi}`);
  query.searchParams.set(
    "select",
    "id,title,publication_date,cited_by_count,abstract_inverted_index,best_oa_location,primary_location,locations",
  );
  if (mailto) query.searchParams.set("mailto", mailto);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(query, {
      headers: {
        accept: "application/json",
        "user-agent": mailto ? `Pi-Agent-Journal-Monitor/0.1 (mailto:${mailto})` : "Pi-Agent-Journal-Monitor/0.1",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`OPENALEX_HTTP_${response.status}`);
    const body = await response.json();
    const work = Array.isArray(body?.results) ? body.results[0] : null;
    if (!work) return paper;
    const abstract = restoreOpenAlexAbstract(work.abstract_inverted_index);
    const pdfUrl = findPdfUrl(work);
    const citedByCount = Number.isInteger(work.cited_by_count) ? work.cited_by_count : null;
    const publication = openAlexDateInfo(work.publication_date);
    const useOpenAlexDate = shouldUpgradePublicationDate(paper, publication);
    return {
      ...paper,
      abstract: abstract || paper.abstract,
      published_at: useOpenAlexDate ? publication.value : paper.published_at,
      publication_date_precision: useOpenAlexDate
        ? publication.precision
        : sourceDatePrecision(paper),
      openalex_publication_date: publication.value,
      openalex_publication_date_precision: publication.precision,
      ...(useOpenAlexDate ? { publication_date_source: "openalex" } : {}),
      pdf_url: paper.pdf_url || pdfUrl,
      pdf_candidates: [...new Set([...(paper.pdf_candidates ?? []), pdfUrl].filter(Boolean))],
      cited_by_count: citedByCount,
      heat_signals: citedByCount === null ? [] : [`OpenAlex 引用记录：${citedByCount}`],
      enrichment_source: "openalex",
      evidence_scope: abstract
        ? "DBLP 题录与 OpenAlex 摘要；全文尚待 MinerU 核验"
        : paper.evidence_scope,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function enrichPapersWithOpenAlex(papers, options = {}) {
  const results = [];
  for (const paper of papers) {
    try {
      results.push(await enrichPaperWithOpenAlex(paper, options));
    } catch (error) {
      results.push({
        ...paper,
        enrichment_error: error?.name === "AbortError" ? "OPENALEX_TIMEOUT" : error?.message ?? "OPENALEX_FAILED",
      });
    }
  }
  return results;
}
