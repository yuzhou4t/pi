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
    conversationId: body.conversation_id ?? null,
    title: body.title ?? null,
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
        titleZh: item.title_zh ?? null,
        reason: item.reason,
        projectImpact: item.project_impact,
      })),
      papers: (turn.papers ?? []).map((paper) => ({
        id: paper.paper_id,
        title: paper.title,
        titleZh: paper.title_zh ?? null,
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
      web: {
        status: turn.web?.status ?? "success",
        provider: turn.web?.provider ?? null,
        results: (turn.web?.results ?? []).map((item) => ({
          title: item.title,
          titleZh: item.title_zh ?? null,
          url: item.url,
          excerpt: item.excerpt || "",
          excerptZh: item.excerpt_zh ?? null,
          publishedDate: item.published_date ?? null,
        })),
      },
    })),
  };
}

export function mapVenueSearchList(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.conversations)) {
    throw new Error("主题检索会话列表格式无效");
  }
  return {
    activeConversationId: body.active_conversation_id ?? null,
    conversations: body.conversations.map((item) => ({
      id: item.conversation_id,
      title: item.title || "新的检索",
      turnCount: item.turn_count ?? 0,
      updatedAt: item.updated_at ?? null,
    })),
  };
}

export async function fetchVenueSearchConversation({ conversationId, signal } = {}) {
  const query = conversationId
    ? `?conversation_id=${encodeURIComponent(conversationId)}`
    : "";
  const response = await fetch(`/api/v1/venue-search${query}`, { signal });
  const body = await jsonResponse(response, "本地服务返回了无法解析的主题检索记录");
  if (!response.ok) throw requestError(response, body, "无法读取主题检索记录");
  return mapVenueSearchConversation(body);
}

export async function fetchVenueSearchConversations({ signal } = {}) {
  const response = await fetch("/api/v1/venue-search/conversations", { signal });
  const body = await jsonResponse(response, "本地服务返回了无法解析的会话列表");
  if (!response.ok) throw requestError(response, body, "无法读取主题检索会话列表");
  return mapVenueSearchList(body);
}

export async function createVenueSearchConversation({ title, signal } = {}) {
  const response = await fetch("/api/v1/venue-search/conversations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schema_version: 1,
      ...(title ? { title } : {}),
    }),
    signal,
  });
  const body = await jsonResponse(response, "本地服务返回了无法解析的新建结果");
  if (!response.ok) throw requestError(response, body, "无法新建主题检索会话");
  return mapVenueSearchConversation(body);
}

export async function deleteVenueSearchConversation({ conversationId, signal } = {}) {
  const response = await fetch(
    `/api/v1/venue-search/conversations/${encodeURIComponent(conversationId)}`,
    { method: "DELETE", signal },
  );
  const body = await jsonResponse(response, "本地服务返回了无法解析的删除结果");
  if (!response.ok) throw requestError(response, body, "无法删除主题检索会话");
  return mapVenueSearchList(body);
}

export async function submitVenueSearchTurn({
  conversationId,
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
      ...(conversationId ? { conversation_id: conversationId } : {}),
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

export async function fetchVenueSearchTurnProgress({ clientRequestId, signal } = {}) {
  if (typeof clientRequestId !== "string" || !clientRequestId.trim()) return null;
  const response = await fetch(
    `/api/v1/venue-search/turn-progress?client_request_id=${encodeURIComponent(clientRequestId)}`,
    { signal },
  );
  if (!response.ok) return null;
  const body = await response.json().catch(() => null);
  if (!body || typeof body !== "object") return null;
  return {
    phase: typeof body.phase === "string" ? body.phase : "unknown",
    thinking: typeof body.thinking === "string" ? body.thinking : null,
    query: typeof body.query === "string" ? body.query : null,
    status: typeof body.status === "string" ? body.status : "unknown",
  };
}

export async function addVenueSearchPapersToWeekly({
  conversationId,
  turnId,
  paperIds,
  signal,
} = {}) {
  const response = await fetch("/api/v1/venue-search/add-to-weekly", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schema_version: 1,
      ...(conversationId ? { conversation_id: conversationId } : {}),
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
