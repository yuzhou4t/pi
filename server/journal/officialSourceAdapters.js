const MAX_OFFICIAL_BODY_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_DETAIL_PAGES = 6;
const MAX_RSS_ITEMS = 80;
const MAX_JSON_LD_NODES = 5_000;
const MAX_URL_CHARS = 2_048;

const MONTHS = Object.freeze({
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
});

export const OFFICIAL_ADAPTER_CONFIGS = Object.freeze({
  "sciencedirect-journal": Object.freeze({
    detail: /\/science\/article\/pii\/[a-z0-9]+/i,
  }),
  "ieee-recent-issue": Object.freeze({
    detail: /\/document\/\d+/i,
  }),
  "springer-journal": Object.freeze({
    detail: /\/article\/10\.\d{4,9}\/[^/?#]+/i,
  }),
  "jmlr-papers-index": Object.freeze({
    detail: /\/papers\/v\d+\/[^/?#]+\.html$/i,
    allowed_hosts: ["jmlr.org", "www.jmlr.org"],
  }),
  "aaai-ojs-archive": Object.freeze({
    navigation: /\/index\.php\/AAAI\/issue\/view\/\d+/i,
    detail: /\/index\.php\/AAAI\/article\/view\/\d+/i,
  }),
  "neurips-proceedings": Object.freeze({
    navigation: /\/(?:paper_files\/paper|paper)\/\d{4}\/?$/i,
    detail: /-(?:Abstract-Conference|Abstract)\.html$/i,
    allowed_hosts: [
      "proceedings.neurips.cc",
      "papers.nips.cc",
    ],
  }),
  "acl-anthology-venue": Object.freeze({
    navigation: /\/volumes\/\d{4}\.acl-long\/?$/i,
    detail: /\/\d{4}\.[a-z0-9-]+\.\d+\/?$/i,
    acl_volume_records: true,
  }),
  "cvf-cvpr": Object.freeze({
    navigation: /\/CVPR\d{4}\/?(?:\?[^#]*)?$/i,
    detail: /\/content\/CVPR\d{4}\/html\/[^/?#]+\.html$/i,
  }),
  "cvf-iccv": Object.freeze({
    navigation: /\/ICCV\d{4}\/?(?:\?[^#]*)?$/i,
    detail: /\/content\/ICCV\d{4}\/html\/[^/?#]+\.html$/i,
  }),
  "pmlr-proceedings": Object.freeze({
    navigation: /\/v\d+\/?$/i,
    navigation_list_items: true,
    navigation_title: /\b(?:Proceedings of ICML \d{4}|ICML \d{4} Proceedings)\b/i,
    navigation_page: /\bInternational Conference on Machine Learning\b/i,
    detail: /\/v\d+\/[^/?#]+\.html$/i,
  }),
  "openreview-iclr": Object.freeze({
    detail: /\/forum\?id=[^&#]+/i,
    allowed_hosts: ["openreview.net", "www.openreview.net"],
  }),
});

export class OfficialSourceError extends Error {
  constructor(code, message, { retryable = false } = {}) {
    super(message);
    this.name = "OfficialSourceError";
    this.code = code;
    this.retryable = retryable;
  }
}

function compact(value) {
  return typeof value === "string"
    ? value.trim().replace(/\s+/g, " ")
    : "";
}

function decodeHtml(value) {
  const named = new Map([
    ["amp", "&"],
    ["apos", "'"],
    ["gt", ">"],
    ["lt", "<"],
    ["nbsp", " "],
    ["quot", "\""],
  ]);
  return String(value ?? "")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_match, entity) => {
      const radix = entity[0].toLowerCase() === "x" ? 16 : 10;
      const codePoint = Number.parseInt(
        radix === 16 ? entity.slice(1) : entity,
        radix,
      );
      return Number.isSafeInteger(codePoint) ? String.fromCodePoint(codePoint) : "";
    })
    .replace(/&([a-z]+);/gi, (match, entity) => (
      named.get(entity.toLowerCase()) ?? match
    ));
}

function cleanHtml(value) {
  return compact(decodeHtml(String(value ?? "").replace(/<[^>]+>/g, " ")));
}

function xmlElement(body, name) {
  const match = String(body ?? "").match(
    new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"),
  );
  return compact(decodeHtml(match?.[1] ?? ""));
}

function secureJmlrUrl(value) {
  return compact(value).replace(/^http:\/\/(?:www\.)?jmlr\.org/i, "https://www.jmlr.org");
}

function attributes(tag) {
  const result = {};
  const expression = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  for (const match of tag.matchAll(expression)) {
    result[match[1].toLowerCase()] = decodeHtml(
      match[2] ?? match[3] ?? match[4] ?? "",
    );
  }
  return result;
}

function metaMap(html) {
  const values = new Map();
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);
    const key = compact(attrs.name || attrs.property || attrs.itemprop).toLowerCase();
    const value = compact(attrs.content);
    if (!key || !value) continue;
    values.set(key, [...(values.get(key) ?? []), value]);
  }
  return values;
}

function firstMeta(map, names) {
  for (const name of names) {
    const value = map.get(name.toLowerCase())?.[0];
    if (value) return value;
  }
  return "";
}

function allMeta(map, names) {
  return names.flatMap((name) => map.get(name.toLowerCase()) ?? []);
}

function validDateParts(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function normalizedPublicationDate(value) {
  const text = compact(value);
  if (!text) return { value: null, precision: "unknown" };
  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/);
  if (!match) match = text.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\s.*)?$/);
  if (match) {
    const [, yearText, monthText, dayText] = match;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    if (validDateParts(year, month, day)) {
      return {
        value: `${yearText.padStart(4, "0")}-${monthText.padStart(2, "0")}-${dayText.padStart(2, "0")}`,
        precision: "day",
      };
    }
    return { value: null, precision: "unknown" };
  }
  match = text.match(
    /^(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),?\s+(\d{4})$/i,
  );
  if (match) {
    const month = MONTHS[match[1].toLowerCase()];
    const day = Number(match[2]);
    const year = Number(match[3]);
    if (month && validDateParts(year, month, day)) {
      return {
        value: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
        precision: "day",
      };
    }
  }
  match = text.match(
    /^(\d{1,2})\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{4})$/i,
  );
  if (match) {
    const day = Number(match[1]);
    const month = MONTHS[match[2].toLowerCase()];
    const year = Number(match[3]);
    if (month && validDateParts(year, month, day)) {
      return {
        value: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
        precision: "day",
      };
    }
  }
  if (/^\d{4}-\d{2}$/.test(text)) {
    return { value: text, precision: "month" };
  }
  match = text.match(/^(\d{4})\/(\d{1,2})$/);
  if (match) {
    const month = Number(match[2]);
    if (month >= 1 && month <= 12) {
      return {
        value: `${match[1]}-${String(month).padStart(2, "0")}`,
        precision: "month",
      };
    }
  }
  if (/^\d{4}$/.test(text)) {
    return { value: text, precision: "year" };
  }
  return { value: null, precision: "unknown" };
}

function privateHostname(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (
    host === "localhost"
    || host.endsWith(".localhost")
    || host === "::1"
    || host === "0.0.0.0"
  ) {
    return true;
  }
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const octets = ipv4.slice(1).map(Number);
  return octets.some((octet) => octet > 255)
    || octets[0] === 10
    || octets[0] === 127
    || octets[0] === 0
    || (octets[0] === 169 && octets[1] === 254)
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

function safeHttpsUrl(value, {
  base,
  allowedHosts,
} = {}) {
  try {
    const url = new URL(value, base);
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || url.toString().length > MAX_URL_CHARS
      || privateHostname(url.hostname)
    ) {
      return null;
    }
    if (
      allowedHosts
      && !allowedHosts.has(url.hostname.toLowerCase())
    ) {
      return null;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function routeHosts(routeUrl, config) {
  const route = new URL(routeUrl);
  return new Set([
    route.hostname.toLowerCase(),
    ...(config.allowed_hosts ?? []).map((host) => host.toLowerCase()),
  ]);
}

async function fetchBoundedHtml(fetchImpl, url, {
  timeoutMs,
  allowedHosts,
} = {}) {
  const safeUrl = safeHttpsUrl(url, { allowedHosts });
  if (!safeUrl) {
    throw new OfficialSourceError(
      "OFFICIAL_URL_REJECTED",
      "Official source URL is not an allowed public HTTPS URL",
    );
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(safeUrl, {
      headers: {
        accept: "text/html,application/xhtml+xml;q=0.9,application/ld+json;q=0.8",
        "user-agent": "Pi-Agent-Journal-Monitor/0.1",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new OfficialSourceError(
        `OFFICIAL_HTTP_${response.status}`,
        `Official source returned HTTP ${response.status}`,
        { retryable: response.status === 429 || response.status >= 500 },
      );
    }
    const redirected = response.url
      ? safeHttpsUrl(response.url, { allowedHosts })
      : safeUrl;
    if (!redirected) {
      throw new OfficialSourceError(
        "OFFICIAL_REDIRECT_REJECTED",
        "Official source redirected outside its allowed HTTPS hosts",
      );
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_OFFICIAL_BODY_BYTES) {
      throw new OfficialSourceError(
        "OFFICIAL_BODY_TOO_LARGE",
        "Official source response is too large",
      );
    }
    const body = await response.text();
    if (!body || Buffer.byteLength(body, "utf8") > MAX_OFFICIAL_BODY_BYTES) {
      throw new OfficialSourceError(
        "OFFICIAL_BODY_INVALID",
        "Official source response is empty or too large",
      );
    }
    return { body, url: redirected };
  } finally {
    clearTimeout(timer);
  }
}

function jsonLdNodes(html) {
  const output = [];
  const visit = (value) => {
    if (output.length >= MAX_JSON_LD_NODES || value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== "object") return;
    output.push(value);
    for (const child of Object.values(value)) {
      if (child && typeof child === "object") visit(child);
    }
  };
  for (const match of html.matchAll(
    /<script\b[^>]*type\s*=\s*(?:"application\/ld\+json"|'application\/ld\+json')[^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      visit(JSON.parse(match[1].trim()));
    } catch {
      // Malformed structured data does not make the whole official page unusable.
    }
  }
  return output;
}

function ldTypes(node) {
  const value = node?.["@type"];
  return (Array.isArray(value) ? value : [value])
    .map((item) => compact(item).toLowerCase())
    .filter(Boolean);
}

function scholarlyNode(node) {
  return ldTypes(node).some((type) => (
    type === "scholarlyarticle"
    || type === "article"
    || type === "report"
    || type === "chapter"
  ));
}

function authorNames(value) {
  return (Array.isArray(value) ? value : [value])
    .map((author) => (
      typeof author === "string"
        ? compact(author)
        : compact(author?.name || [author?.givenName, author?.familyName].filter(Boolean).join(" "))
    ))
    .filter(Boolean);
}

function doiFrom(value) {
  const values = [];
  const collect = (item) => {
    if (Array.isArray(item)) {
      for (const child of item) collect(child);
      return;
    }
    values.push(item);
  };
  collect(value);
  for (const item of values) {
    const text = compact(
      typeof item === "object"
        ? item?.value || item?.["@id"] || item?.url
        : item,
    );
    const match = text.match(/(?:https?:\/\/doi\.org\/|doi:\s*)?(10\.\d{4,9}\/\S+)/i);
    if (match) return match[1].replace(/[.,;)]$/, "").toLowerCase();
  }
  return null;
}

function ldUrl(node, pageUrl) {
  const candidates = [
    node?.url,
    node?.mainEntityOfPage,
    node?.sameAs,
    node?.["@id"],
  ];
  for (const candidate of candidates) {
    const raw = typeof candidate === "object" ? candidate?.["@id"] : candidate;
    const url = safeHttpsUrl(raw, { base: pageUrl });
    if (url) return url;
  }
  return pageUrl;
}

function ldPdfUrl(node, pageUrl) {
  const candidates = [
    node?.contentUrl,
    node?.encoding?.contentUrl,
    node?.associatedMedia?.contentUrl,
  ];
  for (const candidate of candidates) {
    const url = safeHttpsUrl(candidate, { base: pageUrl });
    if (url && /\.pdf(?:$|[?#])/i.test(url)) return url;
  }
  return null;
}

function officialRecord({
  source,
  adapterName,
  routeUrl,
  pageUrl,
  evidenceKind,
  title,
  authors = [],
  publishedAt,
  doi,
  officialUrl,
  pdfUrl,
  abstract = "",
}) {
  const cleanTitle = cleanHtml(title);
  const cleanDoi = doiFrom(doi);
  const safeOfficialUrl = safeHttpsUrl(officialUrl, { base: pageUrl }) ?? pageUrl;
  if (!cleanTitle || cleanTitle.length < 8 || (!cleanDoi && !safeOfficialUrl)) return null;
  const publication = normalizedPublicationDate(publishedAt);
  return {
    title: cleanTitle,
    authors: [...new Set(authors.map(cleanHtml).filter(Boolean))],
    venue: source.venue,
    paper_type: source.source_type === "journal"
      ? "journal-article"
      : "conference-paper",
    published_at: publication.value,
    publication_date_precision: publication.precision,
    doi: cleanDoi,
    official_id: cleanDoi || new URL(safeOfficialUrl).pathname + new URL(safeOfficialUrl).search,
    official_url: safeOfficialUrl,
    canonical_url: cleanDoi ? `https://doi.org/${encodeURI(cleanDoi)}` : safeOfficialUrl,
    discovery_url: routeUrl,
    pdf_url: safeHttpsUrl(pdfUrl, { base: pageUrl }),
    abstract: cleanHtml(abstract),
    evidence_scope: evidenceKind === "official_index_link"
      ? "官方索引链接；日期、摘要与全文尚待核验"
      : "官方页面结构化题录；全文尚待核验",
    metadata_source: `official:${adapterName}`,
    provenance: {
      source: "official_primary",
      adapter: adapterName,
      route_url: routeUrl,
      page_url: pageUrl,
      evidence_kind: evidenceKind,
    },
  };
}

function recordsFromJsonLd(html, context) {
  return jsonLdNodes(html)
    .filter(scholarlyNode)
    .map((node) => officialRecord({
      ...context,
      evidenceKind: "json_ld",
      title: node.headline || node.name,
      authors: authorNames(node.author || node.creator),
      publishedAt: node.datePublished || node.dateCreated,
      doi: doiFrom([node.identifier, node.sameAs, node.url]),
      officialUrl: ldUrl(node, context.pageUrl),
      pdfUrl: ldPdfUrl(node, context.pageUrl),
      abstract: node.abstract || node.description,
    }))
    .filter(Boolean);
}

function recordFromCitationMeta(html, context, { allowPageIdentity }) {
  const meta = metaMap(html);
  const title = firstMeta(meta, [
    "citation_title",
    "dc.title",
    "og:title",
  ]);
  const doi = firstMeta(meta, [
    "citation_doi",
    "dc.identifier",
  ]);
  const pdfUrl = firstMeta(meta, ["citation_pdf_url"]);
  if (!title || (!doi && !pdfUrl && !allowPageIdentity)) return null;
  return officialRecord({
    ...context,
    evidenceKind: "citation_meta",
    title,
    authors: allMeta(meta, ["citation_author", "dc.creator"]),
    publishedAt: firstMeta(meta, [
      "citation_publication_date",
      "citation_date",
      "dc.date",
      "article:published_time",
    ]),
    doi,
    officialUrl: firstMeta(meta, [
      "citation_public_url",
      "og:url",
    ]) || context.pageUrl,
    pdfUrl,
    abstract: firstMeta(meta, [
      "citation_abstract",
      "dc.description",
      "description",
    ]),
  });
}

function extractedLinks(html, pageUrl, allowedHosts) {
  const links = [];
  const seen = new Set();
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = attributes(match[1]);
    const url = safeHttpsUrl(attrs.href, {
      base: pageUrl,
      allowedHosts,
    });
    if (!url || seen.has(url) || /\.pdf(?:$|[?#])/i.test(url)) continue;
    seen.add(url);
    links.push({
      url,
      title: cleanHtml(match[2] || attrs.title || attrs["aria-label"]),
    });
  }
  return links;
}

function pmlrVolumeLinks(html, pageUrl, allowedHosts) {
  const links = [];
  for (const match of html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
    const [link] = extractedLinks(match[0], pageUrl, allowedHosts);
    if (!link) continue;
    links.push({
      ...link,
      title: cleanHtml(match[1]),
    });
  }
  return links;
}

function definitionValue(html, label) {
  const match = html.match(new RegExp(
    `<dt\\b[^>]*>\\s*${label}:?\\s*</dt>\\s*<dd\\b[^>]*>([\\s\\S]*?)</dd>`,
    "i",
  ));
  return cleanHtml(match?.[1]);
}

function monthNumber(value) {
  return MONTHS[compact(value).toLowerCase()] ?? null;
}

function aclVolumePublicationDate(html) {
  const year = definitionValue(html, "Year");
  const month = monthNumber(definitionValue(html, "Month"));
  if (!/^\d{4}$/.test(year)) return null;
  return month ? `${year}-${String(month).padStart(2, "0")}` : year;
}

function anchorTexts(html) {
  return [...html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)]
    .map((match) => cleanHtml(match[1]))
    .filter(Boolean);
}

function recordsFromAclVolume(html, context, allowedHosts, detailPattern) {
  const publishedAt = aclVolumePublicationDate(html);
  const records = [];
  const entries = html.matchAll(
    /<span\b[^>]*>\s*<strong>\s*<a\b([^>]*)>([\s\S]*?)<\/a>\s*<\/strong>\s*<br\s*\/?>([\s\S]*?)<\/span>\s*<\/div>\s*<div\b([^>]*)>\s*<div\b[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi,
  );
  for (const match of entries) {
    const linkAttributes = attributes(match[1]);
    const abstractAttributes = attributes(match[4]);
    if (!compact(abstractAttributes.class).split(/\s+/).includes("abstract-collapse")) continue;
    const officialUrl = safeHttpsUrl(linkAttributes.href, {
      base: context.pageUrl,
      allowedHosts,
    });
    if (!officialUrl || !detailPattern.test(officialUrl)) continue;
    const paperSlug = new URL(officialUrl).pathname.split("/").filter(Boolean)[0];
    if (!/^\d{4}\.[a-z0-9-]+\.\d+$/i.test(paperSlug)) continue;
    records.push(officialRecord({
      ...context,
      evidenceKind: "official_volume_record",
      title: match[2],
      authors: anchorTexts(match[3]),
      publishedAt,
      doi: `10.18653/v1/${paperSlug}`,
      officialUrl,
      pdfUrl: `${officialUrl.replace(/\/$/, "")}.pdf`,
      abstract: match[5],
    }));
  }
  return records.filter(Boolean);
}

function newestNavigationLinks(links, pattern, titlePattern = null) {
  if (!pattern) return [];
  const recency = (url) => {
    const year = Number(url.match(/(?:19|20)\d{2}/)?.[0] ?? 0);
    const volume = Number(url.match(/\/v(\d+)\/?(?:[?#]|$)/i)?.[1] ?? 0);
    const issue = Number(url.match(/\/issue\/view\/(\d+)/i)?.[1] ?? 0);
    return year * 1_000_000_000 + volume * 1_000_000 + issue;
  };
  return links
    .filter((link) => (
      pattern.test(link.url)
      && (!titlePattern || titlePattern.test(link.title))
    ))
    .sort((left, right) => {
      return recency(right.url) - recency(left.url)
        || right.url.localeCompare(left.url);
    })
    .slice(0, 1);
}

function detailLinks(links, pattern) {
  return links
    .filter((link) => pattern.test(link.url))
    .slice(0, MAX_DETAIL_PAGES);
}

function linkedRecord(link, context) {
  return officialRecord({
    ...context,
    pageUrl: link.url,
    evidenceKind: "official_index_link",
    title: link.title,
    authors: [],
    publishedAt: null,
    doi: null,
    officialUrl: link.url,
    pdfUrl: null,
    abstract: "",
  });
}

function deduplicateRecords(records) {
  const seen = new Set();
  const output = [];
  for (const record of records) {
    if (!record) continue;
    const key = record.doi
      ? `doi:${record.doi}`
      : `url:${record.official_url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(record);
  }
  return output;
}

async function detailRecords({
  links,
  source,
  adapterName,
  routeUrl,
  fetchImpl,
  timeoutMs,
  allowedHosts,
  targetUrls,
}) {
  const records = [];
  for (const link of links) {
    try {
      const detail = await fetchBoundedHtml(fetchImpl, link.url, {
        timeoutMs,
        allowedHosts,
      });
      targetUrls.push(detail.url);
      const context = {
        source,
        adapterName,
        routeUrl,
        pageUrl: detail.url,
      };
      const parsed = [
        ...recordsFromJsonLd(detail.body, context),
        recordFromCitationMeta(detail.body, context, { allowPageIdentity: true }),
      ].filter(Boolean);
      records.push(...(parsed.length > 0 ? parsed : [linkedRecord(link, context)]));
    } catch {
      records.push(linkedRecord(link, {
        source,
        adapterName,
        routeUrl,
      }));
    }
  }
  return records.filter(Boolean);
}

export function recordsFromJmlrRss(xml, context) {
  const records = [];
  for (const match of String(xml ?? "").matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    if (records.length >= MAX_RSS_ITEMS) break;
    const item = match[1];
    const officialUrl = secureJmlrUrl(xmlElement(item, "link"));
    if (!/^https:\/\/(?:www\.)?jmlr\.org\/papers\/v\d+\/[^/?#]+\.html$/i.test(officialUrl)) {
      continue;
    }
    const authors = xmlElement(item, "author")
      .split(/\s*,\s*/)
      .map(compact)
      .filter(Boolean);
    records.push(officialRecord({
      ...context,
      pageUrl: officialUrl,
      evidenceKind: "official_rss",
      title: xmlElement(item, "title"),
      authors,
      publishedAt: xmlElement(item, "pubDate"),
      doi: null,
      officialUrl,
      pdfUrl: secureJmlrUrl(xmlElement(item, "pdf")),
      abstract: xmlElement(item, "description"),
    }));
  }
  return records.filter(Boolean);
}

async function fetchJmlrRssSource(source, {
  fetchImpl = globalThis.fetch,
  route = source?.primary,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const config = OFFICIAL_ADAPTER_CONFIGS["jmlr-papers-index"];
  if (
    !route?.url
    || route.url !== source?.primary?.url
    || route.kind !== "official-rss"
  ) {
    throw new OfficialSourceError(
      "OFFICIAL_ROUTE_INVALID",
      `Source ${source?.source_id ?? "unknown"} has no supported official RSS route`,
    );
  }
  const allowedHosts = routeHosts(route.url, config);
  const feed = await fetchBoundedHtml(fetchImpl, route.url, {
    timeoutMs,
    allowedHosts,
  });
  const papers = deduplicateRecords(recordsFromJmlrRss(feed.body, {
    source,
    adapterName: "jmlr-papers-index",
    routeUrl: route.url,
    pageUrl: feed.url,
  }));
  if (papers.length === 0) {
    throw new OfficialSourceError(
      "OFFICIAL_SOURCE_EMPTY",
      `Official source ${source.source_id} exposed no parseable paper records`,
    );
  }
  return {
    source_id: source.source_id,
    fetched_at: new Date().toISOString(),
    index_url: route.url,
    target_urls: [feed.url],
    papers,
  };
}

export async function fetchOfficialSource(source, {
  adapterName = source?.adapter,
  fetchImpl = globalThis.fetch,
  route = source?.primary,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const config = OFFICIAL_ADAPTER_CONFIGS[adapterName];
  if (
    !config
    || !route?.url
    || route.url !== source?.primary?.url
    || route.kind !== source?.primary?.kind
  ) {
    throw new OfficialSourceError(
      "OFFICIAL_ROUTE_INVALID",
      `Source ${source?.source_id ?? "unknown"} has no supported official route`,
    );
  }
  const allowedHosts = routeHosts(route.url, config);
  const index = await fetchBoundedHtml(fetchImpl, route.url, {
    timeoutMs,
    allowedHosts,
  });
  const targetUrls = [index.url];
  const initialContext = {
    source,
    adapterName,
    routeUrl: route.url,
    pageUrl: index.url,
  };
  const records = [
    ...recordsFromJsonLd(index.body, initialContext),
    recordFromCitationMeta(index.body, initialContext, {
      allowPageIdentity: false,
    }),
  ].filter(Boolean);
  const firstLinks = extractedLinks(index.body, index.url, allowedHosts);
  let papers = detailLinks(firstLinks, config.detail);

  if (papers.length === 0) {
    const navigationLinks = config.navigation_list_items
      ? pmlrVolumeLinks(index.body, index.url, allowedHosts)
      : firstLinks;
    const [navigation] = newestNavigationLinks(
      navigationLinks,
      config.navigation,
      config.navigation_title,
    );
    if (navigation) {
      try {
        const nested = await fetchBoundedHtml(fetchImpl, navigation.url, {
          timeoutMs,
          allowedHosts,
        });
        if (config.navigation_page && !config.navigation_page.test(nested.body)) {
          throw new OfficialSourceError(
            "OFFICIAL_NAVIGATION_MISMATCH",
            `Official volume does not belong to ${source.source_id}`,
          );
        }
        targetUrls.push(nested.url);
        const nestedContext = {
          ...initialContext,
          pageUrl: nested.url,
        };
        records.push(
          ...recordsFromJsonLd(nested.body, nestedContext),
          recordFromCitationMeta(nested.body, nestedContext, {
            allowPageIdentity: false,
          }),
        );
        const volumeRecords = config.acl_volume_records
          ? recordsFromAclVolume(
              nested.body,
              nestedContext,
              allowedHosts,
              config.detail,
            )
          : [];
        records.push(...volumeRecords);
        papers = volumeRecords.length > 0
          ? []
          : detailLinks(
              extractedLinks(nested.body, nested.url, allowedHosts),
              config.detail,
            );
      } catch {
        // The fallback route remains available when the official nested index fails.
      }
    }
  }

  records.push(...await detailRecords({
    links: papers,
    source,
    adapterName,
    routeUrl: route.url,
    fetchImpl,
    timeoutMs,
    allowedHosts,
    targetUrls,
  }));
  const normalized = deduplicateRecords(records);
  if (normalized.length === 0) {
    throw new OfficialSourceError(
      "OFFICIAL_SOURCE_EMPTY",
      `Official source ${source.source_id} exposed no parseable paper records`,
    );
  }
  return {
    source_id: source.source_id,
    fetched_at: new Date().toISOString(),
    index_url: route.url,
    target_urls: [...new Set(targetUrls)],
    papers: normalized,
  };
}

export const OFFICIAL_SOURCE_ADAPTERS = Object.freeze(Object.fromEntries(
  Object.keys(OFFICIAL_ADAPTER_CONFIGS).map((adapterName) => [
    adapterName,
    adapterName === "jmlr-papers-index"
      ? fetchJmlrRssSource
      : (source, options = {}) => fetchOfficialSource(source, {
          ...options,
          adapterName,
        }),
  ]),
));
