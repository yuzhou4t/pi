import { mapJournalRun } from "./journalRuns.js";

async function jsonResponse(response, fallback) {
  try {
    return await response.json();
  } catch {
    throw new Error(fallback);
  }
}

function requestError(response, body, fallback) {
  const error = new Error(body?.error?.message || fallback);
  error.code = body?.error?.code || "VENUE_SEARCH_REQUEST_FAILED";
  error.retryable = Boolean(body?.error?.retryable);
  error.status = response.status;
  return error;
}

export function mapVenueSearchConversation(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.turns)) {
    throw new Error("主题检索记录格式无效");
  }
  return {
    conversationId: body.conversation_id ?? "topic-search",
    updatedAt: body.updated_at ?? null,
    turns: body.turns.map((turn) => ({
      turnId: turn.turn_id,
      question: turn.question,
      status: turn.status,
      createdAt: turn.created_at ?? null,
      completedAt: turn.completed_at ?? null,
      searchQuery: turn.plan?.search_query ?? null,
      fromYear: turn.plan?.from_year ?? null,
      venues: (turn.search?.venues ?? []).map((venue) => ({
        sourceId: venue.source_id,
        shortName: venue.short_name,
        status: venue.status,
        count: venue.count ?? 0,
      })),
      venueSuccessCount: turn.search?.venue_success_count ?? 0,
      venueFailedIds: turn.search?.venue_failed_ids ?? [],
      totalFound: turn.search?.total_found ?? 0,
      answer: turn.answer ?? "",
      recommendationSource: turn.recommendation_source ?? "deterministic",
      recommendations: (turn.recommendations ?? []).map((item) => ({
        paperId: item.paper_id,
        reason: item.reason,
        projectImpact: item.project_impact,
      })),
      papers: (turn.papers ?? []).map((paper) => ({
        id: paper.paper_id,
        title: paper.title,
        authors: paper.authors ?? [],
        venue: paper.venue,
        publishedAt: paper.published_at ?? null,
        abstract: paper.abstract || "",
        citedByCount: Number.isInteger(paper.cited_by_count) ? paper.cited_by_count : null,
        pdfUrl: paper.pdf_url ?? null,
        officialUrl: paper.official_url ?? null,
        searchRank: paper.search_rank ?? null,
      })),
      addedPaperIds: turn.added_paper_ids ?? [],
    })),
  };
}

export async function fetchVenueSearchConversation({ signal } = {}) {
  const response = await fetch("/api/v1/venue-search", { signal });
  const body = await jsonResponse(response, "本地服务返回了无法解析的主题检索记录");
  if (!response.ok) throw requestError(response, body, "无法读取主题检索记录");
  return mapVenueSearchConversation(body);
}

export async function submitVenueSearchTurn({
  question,
  providerId,
  modelId,
  thinkingLevel,
  clientRequestId,
  signal,
} = {}) {
  const suffix = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const response = await fetch("/api/v1/venue-search/turns", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schema_version: 1,
      question,
      ...(providerId ? { provider_id: providerId } : {}),
      ...(modelId ? { model_id: modelId } : {}),
      ...(thinkingLevel ? { thinking_level: thinkingLevel } : {}),
      client_request_id: clientRequestId ?? `venue-search-${suffix}`,
    }),
    signal,
  });
  const body = await jsonResponse(response, "本地服务返回了无法解析的检索结果");
  if (!response.ok) throw requestError(response, body, "主题检索失败");
  return mapVenueSearchConversation(body);
}

export async function addVenueSearchPapersToWeekly({
  turnId,
  paperIds,
  signal,
} = {}) {
  const response = await fetch("/api/v1/venue-search/add-to-weekly", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schema_version: 1,
      turn_id: turnId,
      paper_ids: paperIds,
    }),
    signal,
  });
  const body = await jsonResponse(response, "本地服务返回了无法解析的加入结果");
  if (!response.ok) throw requestError(response, body, "无法加入本周推荐");
  return {
    run: mapJournalRun(body.run),
    conversation: mapVenueSearchConversation(body.conversation),
  };
}
