const WORKER_API_ROOT = "/api/v1/worker";

function requestId(prefix) {
  return `${prefix}:${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

function apiError(response, payload, fallback) {
  const error = new Error(payload?.error?.message || fallback);
  error.name = "WorkerApiError";
  error.code = payload?.error?.code || "WORKER_REQUEST_FAILED";
  error.status = response.status;
  error.retryable = payload?.error?.retryable === true;
  error.unknownOutcome = payload?.error?.unknown_outcome === true;
  return error;
}

async function requestJson(path, { method = "GET", body, signal } = {}) {
  const response = await fetch(path, {
    method,
    signal,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    if (!response.ok) throw apiError(response, null, "Worker 请求失败");
    throw new Error("Worker 服务返回了无效 JSON");
  }
  if (!response.ok) throw apiError(response, payload, "Worker 请求失败");
  return payload;
}

export const workerApi = Object.freeze({
  async listDefinitions(options = {}) {
    return (await requestJson(`${WORKER_API_ROOT}/definitions`, options)).definitions ?? [];
  },
  async listTasks(options = {}) {
    return (await requestJson(`${WORKER_API_ROOT}/tasks`, options)).tasks ?? [];
  },
  async getTask(taskId, options = {}) {
    return requestJson(`${WORKER_API_ROOT}/tasks/${encodeURIComponent(taskId)}`, options);
  },
  async createTask({ workerId, title, sourceProjectId = null } = {}, options = {}) {
    return requestJson(`${WORKER_API_ROOT}/tasks`, {
      ...options,
      method: "POST",
      body: {
        schema_version: 1,
        worker_id: workerId,
        ...(typeof title === "string" && title.trim() ? { title: title.trim() } : {}),
        source_project_id: sourceProjectId,
      },
    });
  },
  async updateTaskContext(taskId, sourceProjectId, options = {}) {
    return requestJson(`${WORKER_API_ROOT}/tasks/${encodeURIComponent(taskId)}`, {
      ...options,
      method: "PATCH",
      body: { schema_version: 1, source_project_id: sourceProjectId || null },
    });
  },
  async deleteTask(taskId, options = {}) {
    return requestJson(`${WORKER_API_ROOT}/tasks/${encodeURIComponent(taskId)}`, {
      ...options,
      method: "DELETE",
    });
  },
  async sendMessage(taskId, { text, providerId, modelId, thinkingLevel } = {}, options = {}) {
    return requestJson(`${WORKER_API_ROOT}/tasks/${encodeURIComponent(taskId)}/messages`, {
      ...options,
      method: "POST",
      body: {
        schema_version: 1,
        client_request_id: requestId("worker-message"),
        text,
        provider_id: providerId,
        model_id: modelId,
        thinking_level: thinkingLevel,
      },
    });
  },
  async answerQuestion(taskId, requestIdValue, answers, options = {}) {
    return requestJson(`${WORKER_API_ROOT}/tasks/${encodeURIComponent(taskId)}/questions/${encodeURIComponent(requestIdValue)}/answer`, {
      ...options,
      method: "POST",
      body: {
        schema_version: 1,
        answers: (Array.isArray(answers) ? answers : []).map((answer) => ({
          question_id: answer.questionId,
          value: answer.value,
        })),
      },
    });
  },
  async cancelQuestion(taskId, requestIdValue, options = {}) {
    return requestJson(`${WORKER_API_ROOT}/tasks/${encodeURIComponent(taskId)}/questions/${encodeURIComponent(requestIdValue)}/cancel`, {
      ...options,
      method: "POST",
      body: { schema_version: 1 },
    });
  },
  async saveDraft(taskId, { content, format, source = "user" } = {}, options = {}) {
    return requestJson(`${WORKER_API_ROOT}/tasks/${encodeURIComponent(taskId)}/drafts`, {
      ...options,
      method: "POST",
      body: { schema_version: 1, content, format, source },
    });
  },
  async invalidateDraft(taskId, draftRevisionId, options = {}) {
    return requestJson(`${WORKER_API_ROOT}/tasks/${encodeURIComponent(taskId)}/drafts/invalidate`, {
      ...options,
      method: "POST",
      body: {
        schema_version: 1,
        draft_revision_id: draftRevisionId,
      },
    });
  },
  async proposeAction(taskId, input = {}, options = {}) {
    return requestJson(`${WORKER_API_ROOT}/tasks/${encodeURIComponent(taskId)}/actions`, {
      ...options,
      method: "POST",
      body: {
        schema_version: 1,
        client_request_id: requestId("worker-action"),
        operation: input.operation,
        parameters: input.parameters,
        before_source_id: input.beforeSourceId,
        after_source_id: input.afterSourceId,
        history_source_id: input.historySourceId,
      },
    });
  },
  async listTaskFiles(taskId, options = {}) {
    return (await requestJson(
      `${WORKER_API_ROOT}/tasks/${encodeURIComponent(taskId)}/files`,
      options,
    )).files ?? [];
  },
  async uploadTaskFile(taskId, file, options = {}) {
    if (!file || typeof file.name !== "string" || !Number.isSafeInteger(file.size)) {
      throw new TypeError("Worker 附件无效");
    }
    const created = await requestJson(
      `${WORKER_API_ROOT}/tasks/${encodeURIComponent(taskId)}/files`,
      {
        ...options,
        method: "POST",
        body: {
          schema_version: 1,
          file_name: file.name,
          mime_type: file.type || "application/octet-stream",
          byte_length: file.size,
        },
      },
    );
    const fileId = created.file?.id;
    if (!fileId) throw new Error("Worker 服务没有返回附件标识");
    try {
      const response = await fetch(
        `${WORKER_API_ROOT}/tasks/${encodeURIComponent(taskId)}/files/${encodeURIComponent(fileId)}/content`,
        {
          method: "PUT",
          signal: options.signal,
          headers: { "content-type": "application/octet-stream" },
          body: file,
        },
      );
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        throw apiError(response, null, "Worker 附件上传失败");
      }
      if (!response.ok) throw apiError(response, payload, "Worker 附件上传失败");
      return payload.file;
    } catch (error) {
      await requestJson(
        `${WORKER_API_ROOT}/tasks/${encodeURIComponent(taskId)}/files/${encodeURIComponent(fileId)}`,
        { method: "DELETE" },
      ).catch(() => undefined);
      throw error;
    }
  },
  async removeTaskFile(taskId, fileId, options = {}) {
    return requestJson(
      `${WORKER_API_ROOT}/tasks/${encodeURIComponent(taskId)}/files/${encodeURIComponent(fileId)}`,
      { ...options, method: "DELETE" },
    );
  },
  async confirmAction(taskId, actionId, binding, options = {}) {
    return requestJson(`${WORKER_API_ROOT}/tasks/${encodeURIComponent(taskId)}/actions/${encodeURIComponent(actionId)}/confirm`, {
      ...options,
      method: "POST",
      body: {
        schema_version: 1,
        client_request_id: requestId("worker-confirm"),
        proposal_hash: binding.proposalHash,
        draft_sha256: binding.draftSha256 ?? binding.draftHash,
        base_revision_id: binding.baseRevisionId ?? null,
      },
    });
  },
  async abandonAction(taskId, actionId, input = {}, options = {}) {
    return requestJson(`${WORKER_API_ROOT}/tasks/${encodeURIComponent(taskId)}/actions/${encodeURIComponent(actionId)}/abandon`, {
      ...options,
      method: "POST",
      body: {
        schema_version: 1,
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.manualCheckCompleted === true ? { manual_check_completed: true } : {}),
      },
    });
  },
  async retryAction(taskId, actionId, options = {}) {
    return requestJson(`${WORKER_API_ROOT}/tasks/${encodeURIComponent(taskId)}/actions/${encodeURIComponent(actionId)}/retry`, {
      ...options,
      method: "POST",
      body: { schema_version: 1 },
    });
  },
  async listConnections(options = {}) {
    return (await requestJson("/api/v1/connections", options)).connections ?? [];
  },
  async checkConnection(workerId, options = {}) {
    return (await requestJson(`/api/v1/connections/${encodeURIComponent(workerId)}/check`, {
      ...options,
      method: "POST",
      body: { schema_version: 1 },
    })).connection;
  },
});
