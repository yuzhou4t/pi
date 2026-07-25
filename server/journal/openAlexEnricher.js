const OPENALEX_BASE_URL = "https://api.openalex.org/works";

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
    return {
      ...paper,
      abstract: abstract || paper.abstract,
      published_at: work.publication_date || paper.published_at,
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
