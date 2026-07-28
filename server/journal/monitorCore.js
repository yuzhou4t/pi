import { createHash } from "node:crypto";

export const DEFAULT_TOPIC_RULES = Object.freeze([
  {
    label: "LLM Agent",
    patterns: [/\bllm(?:-based)? agents?\b/i, /\blanguage agents?\b/i, /\bagentic\b/i, /智能体/u],
  },
  {
    label: "规划与工具使用",
    patterns: [
      /\b(?:agent|agentic|LLM|language model)[- \w]{0,40}\bplanning\b/i,
      /\bplanning[- \w]{0,40}\b(?:agent|LLM|language model)\b/i,
      /\btool(?: use| calling| augmented|former)?\b/i,
      /\bfunction calling\b/i,
      /智能体规划|工具调用/u,
    ],
  },
  {
    label: "记忆与上下文工程",
    patterns: [
      /\b(?:agent|LLM|language model)[- \w]{0,50}\b(?:episodic|long[- ]term) memory\b/i,
      /\b(?:episodic|long[- ]term) memory[- \w]{0,50}\b(?:agent|LLM|language model)\b/i,
      /\bcontext engineering\b/i,
      /\blong context\b/i,
      /智能体.{0,20}长期记忆|上下文工程/u,
    ],
  },
  {
    label: "RAG 与知识工作流",
    patterns: [/\bretrieval[- ]augmented\b/i, /\bRAG\b/, /\bknowledge workflow\b/i, /检索增强|知识工作流/u],
  },
  {
    label: "人机协作与人工确认",
    patterns: [/\bhuman[- ]in[- ]the[- ]loop\b/i, /\bhuman[- ]AI collaboration\b/i, /\bhuman approval\b/i, /人机协作|人工确认/u],
  },
  {
    label: "Agent 评估、可靠性与可追溯性",
    patterns: [
      /\b(?:agent|agentic|LLM|large language model|language model)[- \w]{0,50}\b(?:evaluation|benchmark(?:ing)?|reliab(?:le|ility)|traceab(?:le|ility)|verifi(?:able|cation))\b/i,
      /\b(?:evaluation|benchmark(?:ing)?|reliab(?:le|ility)|traceab(?:le|ility)|verifi(?:able|cation))[- \w]{0,50}\b(?:agent|agentic|LLM|large language model|language model)\b/i,
      /智能体.{0,20}(?:可靠性|可追溯|评估基准)/u,
    ],
  },
]);

function compactString(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function cloneValue(value) {
  return value === undefined ? null : structuredClone(value);
}

function uniqueStrings(values) {
  return [...new Set(values.map(compactString).filter(Boolean))];
}

function normalizeTitle(title) {
  return compactString(title)
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function normalizeDoi(value) {
  return compactString(value)
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .toLocaleLowerCase("en");
}

function normalizeArxivId(value) {
  return compactString(value)
    .replace(/^https?:\/\/arxiv\.org\/(?:abs|pdf)\//i, "")
    .replace(/^arxiv:\s*/i, "")
    .replace(/\.pdf$/i, "")
    .replace(/v\d+$/i, "");
}

function normalizeOpenReviewId(value) {
  const text = compactString(value);
  if (!text) return "";
  try {
    const url = new URL(text);
    return compactString(url.searchParams.get("id"));
  } catch {
    return text;
  }
}

function yearOf(value) {
  const match = compactString(value).match(/\b(19|20)\d{2}\b/);
  return match?.[0] ?? "";
}

function publicationDatePrecision(value, explicitPrecision) {
  const explicit = compactString(explicitPrecision).toLowerCase();
  if (["day", "month", "year", "unknown"].includes(explicit)) return explicit;
  const date = compactString(value);
  if (/^\d{4}-\d{2}-\d{2}(?:[T\s].*)?$/.test(date)) return "day";
  if (/^\d{4}-\d{2}$/.test(date)) return "month";
  if (/^\d{4}$/.test(date)) return "year";
  return "unknown";
}

function minTemporal(values) {
  const filtered = uniqueStrings(values);
  return filtered.sort()[0] ?? null;
}

function maxTemporal(values) {
  const filtered = uniqueStrings(values);
  return filtered.sort().at(-1) ?? null;
}

function normalizeAuthors(value) {
  if (Array.isArray(value)) {
    return uniqueStrings(value.map((author) => {
      if (typeof author === "string") return author;
      return compactString(author?.name || [author?.given, author?.family].filter(Boolean).join(" "));
    }));
  }
  const author = compactString(value);
  return author ? [author] : [];
}

function normalizeKeywords(value) {
  if (Array.isArray(value)) return uniqueStrings(value);
  const text = compactString(value);
  return text ? text.split(/[;,]/).map(compactString).filter(Boolean) : [];
}

function hashIdentity(identity) {
  return createHash("sha256").update(identity).digest("hex").slice(0, 20);
}

export function matchTopics(paper, rules = DEFAULT_TOPIC_RULES) {
  const explicit = Array.isArray(paper?.topic_matches) ? paper.topic_matches : [];
  const text = [
    paper?.title,
    paper?.abstract,
    ...(Array.isArray(paper?.keywords) ? paper.keywords : []),
  ].map(compactString).filter(Boolean).join("\n");
  const detected = rules
    .filter((rule) => Array.isArray(rule.patterns) && rule.patterns.some((pattern) => pattern.test(text)))
    .map((rule) => rule.label);
  return uniqueStrings([...explicit, ...detected]);
}

export function paperIdentityKeys(paper) {
  const keys = [];
  const doi = normalizeDoi(paper?.doi);
  const openreviewId = normalizeOpenReviewId(paper?.openreview_id);
  const arxivId = normalizeArxivId(paper?.arxiv_id);
  const officialId = compactString(paper?.official_id);
  const title = normalizeTitle(paper?.title);
  const year = yearOf(paper?.published_at || paper?.issue_date);

  if (doi) keys.push(`doi:${doi}`);
  if (openreviewId) keys.push(`openreview:${openreviewId}`);
  if (arxivId) keys.push(`arxiv:${arxivId}`);
  if (officialId) keys.push(`official:${compactString(paper?.source_id)}:${officialId}`);
  if (title) keys.push(`title:${title}:${year || "unknown"}`);
  return keys;
}

export function stablePaperIdentity(paper) {
  const keys = paperIdentityKeys(paper);
  return keys.find((key) => key.startsWith("doi:"))
    || keys.find((key) => key.startsWith("openreview:"))
    || keys.find((key) => key.startsWith("arxiv:"))
    || keys.find((key) => key.startsWith("official:"))
    || keys.find((key) => key.startsWith("title:"))
    || null;
}

export function normalizePaper(rawPaper, {
  sourceId = rawPaper?.source_id,
  observedAt,
} = {}) {
  const title = compactString(rawPaper?.title);
  const normalizedSourceId = compactString(sourceId);
  const normalizedObservedAt = compactString(observedAt || rawPaper?.observed_at);
  if (!title) throw new TypeError("论文标题不能为空");
  if (!normalizedSourceId) throw new TypeError("source_id 不能为空");
  if (!normalizedObservedAt) throw new TypeError("observedAt 不能为空");

  const keywords = normalizeKeywords(rawPaper?.keywords);
  const paper = {
    title,
    authors: normalizeAuthors(rawPaper?.authors),
    venue: compactString(rawPaper?.venue),
    paper_type: compactString(rawPaper?.paper_type) || "paper",
    published_at: compactString(rawPaper?.published_at) || null,
    publication_date_precision: publicationDatePrecision(
      rawPaper?.published_at,
      rawPaper?.publication_date_precision,
    ),
    issue_date: compactString(rawPaper?.issue_date) || null,
    first_seen_at: compactString(rawPaper?.first_seen_at) || normalizedObservedAt,
    observed_at: normalizedObservedAt,
    doi: normalizeDoi(rawPaper?.doi) || null,
    official_id: compactString(rawPaper?.official_id) || null,
    openreview_id: normalizeOpenReviewId(rawPaper?.openreview_id) || null,
    arxiv_id: normalizeArxivId(rawPaper?.arxiv_id) || null,
    canonical_url: compactString(rawPaper?.canonical_url) || null,
    official_url: compactString(rawPaper?.official_url) || null,
    pdf_url: compactString(rawPaper?.pdf_url) || null,
    discovery_url: compactString(rawPaper?.discovery_url) || null,
    link_status: compactString(rawPaper?.link_status) || "unverified",
    abstract: compactString(rawPaper?.abstract),
    keywords,
    source_id: normalizedSourceId,
    source_ids: [normalizedSourceId],
    heat_signals: Array.isArray(rawPaper?.heat_signals) ? cloneValue(rawPaper.heat_signals) : [],
    topic_matches: [],
    relevance_reason: compactString(rawPaper?.relevance_reason),
    evidence_scope: compactString(rawPaper?.evidence_scope) || "标题与摘要",
    raw_metadata: cloneValue(rawPaper?.raw_metadata ?? rawPaper),
    candidate_origin: compactString(rawPaper?.candidate_origin) || "weekly_scan",
    is_new: rawPaper?.is_new !== false,
  };
  paper.topic_matches = matchTopics({ ...paper, topic_matches: rawPaper?.topic_matches });

  const identity = stablePaperIdentity(paper);
  if (!identity) throw new TypeError("论文缺少可建立身份的字段");
  return {
    paper_id: `paper-${hashIdentity(identity)}`,
    dedupe_key: identity,
    ...paper,
  };
}

function papersMatch(left, right) {
  const leftKeys = paperIdentityKeys(left).filter((key) => !key.startsWith("title:"));
  const rightKeys = new Set(paperIdentityKeys(right).filter((key) => !key.startsWith("title:")));
  if (leftKeys.some((key) => rightKeys.has(key))) return true;

  const leftTitle = normalizeTitle(left.title);
  const rightTitle = normalizeTitle(right.title);
  if (!leftTitle || leftTitle !== rightTitle) return false;
  const leftYear = yearOf(left.published_at || left.issue_date);
  const rightYear = yearOf(right.published_at || right.issue_date);
  return !leftYear || !rightYear || leftYear === rightYear;
}

function qualityScore(paper) {
  return [
    paper.doi,
    paper.openreview_id,
    paper.arxiv_id,
    paper.official_url,
    paper.pdf_url,
    paper.abstract,
  ].filter(Boolean).length + Math.min(paper.abstract?.length || 0, 1000) / 1000;
}

function pickMembers(members) {
  return [...members].sort((left, right) => (
    qualityScore(right) - qualityScore(left)
    || left.source_id.localeCompare(right.source_id)
    || stableStringify(left).localeCompare(stableStringify(right))
  ));
}

function longestArray(members, field) {
  return members
    .map((paper) => paper[field])
    .filter(Array.isArray)
    .sort((left, right) => right.length - left.length || stableStringify(left).localeCompare(stableStringify(right)))[0] ?? [];
}

function mergeGroup(group) {
  const members = pickMembers(group);
  const best = members[0];
  const pick = (field) => members.map((paper) => paper[field]).find((value) => value !== null && value !== "");
  const publishedAt = minTemporal(members.map((paper) => paper.published_at));
  const publishedMember = members.find((paper) => paper.published_at === publishedAt);
  const merged = {
    ...best,
    authors: [...longestArray(members, "authors")],
    published_at: publishedAt,
    publication_date_precision: publishedMember?.publication_date_precision ?? "unknown",
    issue_date: minTemporal(members.map((paper) => paper.issue_date)),
    first_seen_at: minTemporal(members.map((paper) => paper.first_seen_at)),
    observed_at: maxTemporal(members.map((paper) => paper.observed_at)),
    doi: pick("doi") ?? null,
    official_id: pick("official_id") ?? null,
    openreview_id: pick("openreview_id") ?? null,
    arxiv_id: pick("arxiv_id") ?? null,
    canonical_url: pick("canonical_url") ?? null,
    official_url: pick("official_url") ?? null,
    pdf_url: pick("pdf_url") ?? null,
    discovery_url: pick("discovery_url") ?? null,
    abstract: members.map((paper) => paper.abstract).sort((left, right) => right.length - left.length)[0] ?? "",
    keywords: uniqueStrings(members.flatMap((paper) => paper.keywords)),
    source_ids: uniqueStrings(members.map((paper) => paper.source_id)).sort(),
    heat_signals: [...new Map(
      members.flatMap((paper) => paper.heat_signals).map((signal) => [stableStringify(signal), cloneValue(signal)]),
    ).values()],
    topic_matches: uniqueStrings(members.flatMap((paper) => paper.topic_matches)),
    raw_metadata: members.map((paper) => cloneValue(paper.raw_metadata)),
    is_new: members.some((paper) => paper.is_new),
  };
  const identity = stablePaperIdentity(merged);
  return {
    ...merged,
    paper_id: `paper-${hashIdentity(identity)}`,
    dedupe_key: identity,
  };
}

export function deduplicatePapers(papers) {
  if (!Array.isArray(papers)) throw new TypeError("papers 必须是数组");
  const parent = papers.map((_, index) => index);
  const find = (index) => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    while (parent[index] !== index) {
      const next = parent[index];
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const union = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot);
  };

  for (let left = 0; left < papers.length; left += 1) {
    for (let right = left + 1; right < papers.length; right += 1) {
      if (papersMatch(papers[left], papers[right])) union(left, right);
    }
  }

  const groups = new Map();
  papers.forEach((paper, index) => {
    const root = find(index);
    groups.set(root, [...(groups.get(root) ?? []), paper]);
  });
  return [...groups.values()]
    .map(mergeGroup)
    .sort((left, right) => left.dedupe_key.localeCompare(right.dedupe_key));
}

export function filterTopicCandidates(papers, rules = DEFAULT_TOPIC_RULES) {
  return papers
    .map((paper) => ({ ...paper, topic_matches: matchTopics(paper, rules) }))
    .filter((paper) => paper.topic_matches.length > 0);
}

export function decideCursorCommit({
  status,
  cursorBefore = null,
  nextCursor = null,
  outputPersisted = false,
}) {
  const cursorCommitted = status === "success" && outputPersisted === true;
  return {
    cursor_before: cloneValue(cursorBefore),
    next_cursor: cloneValue(nextCursor),
    cursor_after: cloneValue(cursorCommitted ? nextCursor : cursorBefore),
    cursor_committed: cursorCommitted,
  };
}

export function buildSourceScan({
  sourceId,
  status,
  cursorBefore = null,
  nextCursor = null,
  outputPersisted = false,
  papers = [],
  error = null,
}) {
  const cursor = decideCursorCommit({
    status,
    cursorBefore,
    nextCursor,
    outputPersisted,
  });
  return {
    source_id: compactString(sourceId),
    status,
    ...cursor,
    papers: papers.map((paper) => ({ ...paper })),
    error: error ? cloneValue(error) : null,
  };
}

export function combineSourceScans(sourceScans, rules = DEFAULT_TOPIC_RULES) {
  if (!Array.isArray(sourceScans)) throw new TypeError("sourceScans 必须是数组");
  const reliablePapers = sourceScans
    .filter((scan) => scan.status === "success" && scan.cursor_committed)
    .flatMap((scan) => scan.papers);
  const candidates = filterTopicCandidates(deduplicatePapers(reliablePapers), rules);
  return {
    candidates,
    failed_sources: sourceScans
      .filter((scan) => scan.status !== "success")
      .map((scan) => scan.source_id),
    cursor_updates: sourceScans
      .filter((scan) => scan.cursor_committed)
      .map((scan) => ({ source_id: scan.source_id, cursor_after: cloneValue(scan.cursor_after) })),
  };
}
