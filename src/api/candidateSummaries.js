function buildRequest({ runId, papers, providerId, modelId }) {
  return {
    schema_version: 2,
    run_id: runId,
    provider_id: providerId,
    model_id: modelId,
    papers: papers.map((paper) => ({
      paper_id: paper.id,
      title: paper.title,
      authors: Array.isArray(paper.authors) ? paper.authors : [],
      venue: paper.venue ?? "",
      published_at: paper.publishedAt ?? paper.published_at ?? "",
      abstract: paper.rawAbstract ?? paper.raw_abstract ?? paper.abstract,
      topic_matches: paper.topicMatches ?? paper.topic_matches ?? [],
      evidence_scope: paper.evidenceScope ?? paper.evidence_scope ?? "摘要级证据",
      selection_summary: paper.selectionSummary ?? paper.selection_summary ?? paper.abstract,
      project_impact: paper.projectImpact ?? paper.project_impact ?? paper.relevance ?? paper.relevanceReason ?? paper.relevance_reason,
    })),
  };
}

async function readJsonResponse(response, fallbackMessage) {
  try {
    return await response.json();
  } catch {
    throw new Error(fallbackMessage);
  }
}

export async function fetchModelProviders({ signal } = {}) {
  const response = await fetch("/api/v1/model-providers", { signal });
  const body = await readJsonResponse(response, "本地模型服务返回了无法解析的服务商目录");
  if (!response.ok) {
    const error = new Error(body?.error?.message || "无法读取本地模型服务商目录");
    error.code = body?.error?.code ?? "MODEL_PROVIDER_CATALOG_FAILED";
    error.status = response.status;
    throw error;
  }
  if (body?.schema_version !== 1 || !Array.isArray(body.providers)) {
    throw new Error("本地模型服务商目录格式无效");
  }

  return {
    mode: body.mode,
    defaultProviderId: body.default_provider_id,
    providers: body.providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      available: Boolean(provider.available),
      status: provider.status,
      reasonCode: provider.reason_code ?? null,
      models: Array.isArray(provider.models) ? provider.models : [],
    })),
  };
}

export async function fetchCandidateSummaries({ runId, papers, providerId, modelId, signal }) {
  const response = await fetch("/api/v1/candidate-summaries", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(buildRequest({ runId, papers, providerId, modelId })),
    signal,
  });

  const body = await readJsonResponse(response, "本地模型服务返回了无法解析的内容");
  if (!response.ok) {
    const error = new Error(body?.error?.message || "本地模型服务调用失败");
    error.code = body?.error?.code ?? "LOCAL_MODEL_REQUEST_FAILED";
    error.requestId = body?.error?.request_id ?? null;
    error.retryable = Boolean(body?.error?.retryable);
    error.status = response.status;
    throw error;
  }
  if (body?.schema_version !== 2 || !Array.isArray(body.items)) {
    throw new Error("本地模型服务缺少候选说明");
  }
  if (typeof body.provider_id !== "string" || typeof body.model_id !== "string") {
    throw new Error("本地模型服务缺少模型来源");
  }

  return {
    source: body.source,
    providerId: body.provider_id,
    modelId: body.model_id,
    requestId: body.request_id,
    operationId: body.operation_id,
    usage: body.usage,
    cacheWriteFailed: Boolean(body.cache_write_failed),
    items: body.items,
  };
}

export function mergeCandidateSummaries(papers, items) {
  const byPaperId = new Map((items ?? []).map((item) => [item.paper_id, item]));
  return papers.map((paper) => {
    const item = byPaperId.get(paper.id);
    if (!item) return paper;
    return {
      ...paper,
      selectionSummary: item.selection_summary,
      projectImpact: item.project_impact,
    };
  });
}
