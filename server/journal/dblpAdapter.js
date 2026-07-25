const DBLP_BASE_URL = "https://dblp.org/";
export const DBLP_MIRROR_BASE_URLS = Object.freeze([
  "https://dblp.org/",
  "https://dblp.dagstuhl.de/",
  "https://dblp.uni-trier.de/",
]);
const MAX_XML_CHARS = 12 * 1024 * 1024;

const XML_ENTITIES = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", "\""],
  ["apos", "'"],
]);

function decodeXml(value = "") {
  return value
    .replaceAll(/<[^>]+>/g, "")
    .replaceAll(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
      if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
      if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
      return XML_ENTITIES.get(entity.toLowerCase()) ?? match;
    })
    .replaceAll(/\s+/g, " ")
    .trim();
}

function firstTag(body, name) {
  const match = body.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return decodeXml(match?.[1] ?? "");
}

function allTags(body, name) {
  const values = [];
  const expression = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "gi");
  for (const match of body.matchAll(expression)) {
    const value = decodeXml(match[1]);
    if (value) values.push(value);
  }
  return values;
}

function attribute(attributes, name) {
  return attributes.match(new RegExp(`${name}="([^"]*)"`, "i"))?.[1] ?? "";
}

function asDblpXmlUrl(value) {
  if (!value || !value.startsWith("db/") || !value.endsWith(".html")) return null;
  return new URL(value.replace(/\.html(?:#.*)?$/, ".xml"), DBLP_BASE_URL).toString();
}

export function parseDblpIndexTargets(xml, { type = "conference", maxVolumes = 3 } = {}) {
  if (typeof xml !== "string") throw new TypeError("DBLP index must be XML text");
  const targets = [];
  const seen = new Set();

  if (type === "journal") {
    for (const match of xml.matchAll(/<ref\s+href="([^"]+\.html)">/gi)) {
      const url = asDblpXmlUrl(match[1]);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      targets.push({ url, modified_at: null });
      if (targets.length >= maxVolumes) break;
    }
    return targets;
  }

  for (const match of xml.matchAll(/<proceedings\b([^>]*)>([\s\S]*?)<\/proceedings>/gi)) {
    const url = asDblpXmlUrl(firstTag(match[2], "url"));
    if (!url || seen.has(url)) continue;
    seen.add(url);
    targets.push({
      url,
      modified_at: attribute(match[1], "mdate") || null,
    });
    if (targets.length >= maxVolumes) break;
  }

  if (targets.length === 0) {
    for (const match of xml.matchAll(/<ref\s+href="([^"]+\.html)">/gi)) {
      const url = asDblpXmlUrl(match[1]);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      targets.push({ url, modified_at: null });
      if (targets.length >= maxVolumes) break;
    }
  }
  return targets;
}

function pdfCandidatesForUrl(url) {
  if (!url) return [];
  if (/\.pdf(?:$|[?#])/i.test(url)) return [url];
  if (/^https:\/\/aclanthology\.org\/[^?#]+\/?$/i.test(url)) {
    return [`${url.replace(/\/$/, "")}.pdf`];
  }
  if (/^https?:\/\/(?:www\.)?jmlr\.org\/papers\/.+\.html$/i.test(url)) {
    return [url
      .replace(/^https?:\/\/(?:www\.)?jmlr\.org/i, "https://jmlr.org")
      .replace(/\.html$/i, ".pdf")];
  }
  if (/^https?:\/\/proceedings\.mlr\.press\/.+\.html$/i.test(url)) {
    return [url.replace(/^http:/i, "https:").replace(/\.html$/i, ".pdf")];
  }
  if (/^https?:\/\/(?:proceedings\.neurips\.cc|papers\.nips\.cc)\/paper_files\/paper\/\d{4}\/hash\/.+-Abstract-Conference\.html$/i.test(url)) {
    return [url
      .replace(/^http:/i, "https:")
      .replace(/-Abstract-Conference\.html$/i, "-Paper-Conference.pdf")];
  }
  if (/^https:\/\/proceedings\.neurips\.cc\/paper\/\d{4}\/hash\/.+-Abstract\.html$/i.test(url)) {
    return [url.replace(/-Abstract\.html$/i, "-Paper.pdf")];
  }
  if (/^https:\/\/openreview\.net\/forum\?id=/i.test(url)) {
    return [url.replace("/forum?", "/pdf?")];
  }
  if (/^https:\/\/arxiv\.org\/abs\//i.test(url)) {
    return [url.replace("/abs/", "/pdf/")];
  }
  if (/^https:\/\/openaccess\.thecvf\.com\/content.+\/html\/.+\.html$/i.test(url)) {
    return [url.replace("/html/", "/papers/").replace(/\.html$/i, ".pdf")];
  }
  return [];
}

export function parseDblpPublications(xml, source) {
  if (typeof xml !== "string") throw new TypeError("DBLP volume must be XML text");
  const papers = [];
  const records = xml.matchAll(/<(article|inproceedings)\b([^>]*)>([\s\S]*?)<\/\1>/gi);

  for (const match of records) {
    const [, recordType, attributes, body] = match;
    const title = firstTag(body, "title");
    if (!title || /^frontmatter\.?$/i.test(title) || /^frontfatter\.?$/i.test(title)) continue;
    const ee = allTags(body, "ee");
    const doiUrl = ee.find((url) => /^https?:\/\/doi\.org\//i.test(url)) ?? "";
    const officialUrl = ee.find((url) => !/^https?:\/\/doi\.org\//i.test(url)) ?? doiUrl;
    const paperId = attribute(attributes, "key");
    if (!paperId) continue;
    const year = firstTag(body, "year");
    const modifiedAt = attribute(attributes, "mdate") || null;
    const pdfCandidates = [...new Set(ee.flatMap(pdfCandidatesForUrl))];
    papers.push({
      paper_id: paperId,
      source_id: source.id,
      source_name: source.name,
      source_type: source.type,
      record_type: recordType.toLowerCase(),
      paper_type: recordType.toLowerCase() === "article" ? "journal-article" : "conference-paper",
      title,
      authors: allTags(body, "author"),
      venue: firstTag(body, "journal") || firstTag(body, "booktitle") || source.name,
      year: /^\d{4}$/.test(year) ? Number(year) : null,
      published_at: /^\d{4}$/.test(year) ? `${year}-01-01` : null,
      source_modified_at: modifiedAt,
      first_seen_at: null,
      doi: doiUrl ? decodeURIComponent(doiUrl.replace(/^https?:\/\/doi\.org\//i, "")) : null,
      official_id: paperId,
      official_url: officialUrl || new URL(firstTag(body, "url"), DBLP_BASE_URL).toString(),
      canonical_url: officialUrl || new URL(firstTag(body, "url"), DBLP_BASE_URL).toString(),
      discovery_url: new URL(firstTag(body, "url"), DBLP_BASE_URL).toString(),
      pdf_url: pdfCandidates[0] ?? null,
      pdf_candidates: pdfCandidates,
      abstract: "",
      evidence_scope: "DBLP 题录；摘要与全文尚待获取",
      metadata_source: "dblp",
      candidate_origin: "weekly_scan",
      is_new: true,
    });
  }
  return papers;
}

async function fetchXml(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: {
        accept: "application/xml,text/xml;q=0.9",
        "user-agent": "Pi-Agent-Journal-Monitor/0.1",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`DBLP_HTTP_${response.status}`);
    const xml = await response.text();
    if (!xml || xml.length > MAX_XML_CHARS) throw new Error("DBLP_XML_INVALID");
    return xml;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchDblpXml(fetchImpl, url, {
  timeoutMs,
  retryDelayMs,
  sleep,
} = {}) {
  const parsed = new URL(url);
  let lastError;
  for (let index = 0; index < DBLP_MIRROR_BASE_URLS.length; index += 1) {
    const mirrorUrl = new URL(`${parsed.pathname.replace(/^\/+/, "")}${parsed.search}`, DBLP_MIRROR_BASE_URLS[index]).toString();
    try {
      return await fetchXml(fetchImpl, mirrorUrl, timeoutMs);
    } catch (error) {
      lastError = error;
      if (index < DBLP_MIRROR_BASE_URLS.length - 1 && retryDelayMs > 0) {
        await sleep(retryDelayMs);
      }
    }
  }
  throw lastError;
}

export async function fetchDblpSource(source, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 12000,
  maxVolumes = source.type === "journal" ? 1 : 3,
  requestDelayMs = 1500,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  if (!source?.dblp_path) throw new Error(`Source ${source?.id ?? "unknown"} has no DBLP path`);
  const indexUrl = new URL(`db/${source.dblp_path}/index.xml`, DBLP_BASE_URL).toString();
  const requestOptions = { timeoutMs, retryDelayMs: requestDelayMs, sleep };
  const indexXml = await fetchDblpXml(fetchImpl, indexUrl, requestOptions);
  const targets = parseDblpIndexTargets(indexXml, { type: source.type, maxVolumes });
  if (targets.length === 0) throw new Error("DBLP_INDEX_EMPTY");
  const volumes = [];
  for (const target of targets) {
    if (requestDelayMs > 0) await sleep(requestDelayMs);
    volumes.push(await fetchDblpXml(fetchImpl, target.url, requestOptions));
  }
  return {
    source_id: source.id,
    fetched_at: new Date().toISOString(),
    index_url: indexUrl,
    target_urls: targets.map((target) => target.url),
    papers: volumes.flatMap((xml) => parseDblpPublications(xml, source)),
  };
}
