import {
  safeWorkerErrorMessage,
  WorkerServiceError,
  workerError,
} from "./errors.js";

const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const DEFAULT_WORKER_TASK_TITLE = "新工作会话";

function segment(value, label) {
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw workerError("WORKER_ROUTE_INVALID", `${label}无效`, 400);
  }
  if (!SEGMENT_PATTERN.test(decoded)) {
    throw workerError("WORKER_ROUTE_INVALID", `${label}无效`, 400);
  }
  return decoded;
}

function requireSchema(payload) {
  if (!payload || payload.schema_version !== 1) {
    throw workerError("WORKER_REQUEST_INVALID", "Worker 请求版本无效", 400);
  }
  return payload;
}

function workerFormat(workerId, format) {
  if (format) return format;
  if (workerId === "agent_mail") return "plain";
  if (workerId === "lark_doc") return "xml";
  return "markdown";
}

function taskWithConversationTitle(task, conversationValue) {
  const conversation = conversationValue?.conversation ?? conversationValue;
  const conversationTitle = typeof conversation?.title === "string"
    ? conversation.title.trim()
    : "";
  return {
    ...task,
    title: conversationTitle && conversationTitle !== DEFAULT_WORKER_TASK_TITLE
      ? conversationTitle
      : task.title || DEFAULT_WORKER_TASK_TITLE,
  };
}

async function taskBundle(workerService, projectWorkService, taskId) {
  const task = await workerService.getTask(taskId);
  const [conversation, draft, sources, files, actions, receipts] = await Promise.all([
    projectWorkService.getConversation(task.conversationId),
    workerService.getDraft(task.id),
    workerService.listSources(task.id),
    workerService.listTaskFiles(task.id),
    workerService.listActions(task.id),
    workerService.listReceipts(task.id),
  ]);
  return {
    task: taskWithConversationTitle(task, conversation),
    conversation,
    draft,
    sources,
    files,
    actions,
    receipts,
  };
}

export function createWorkerHttpApi({
  workerService,
  projectWorkService,
  readJson,
  readBytes = null,
  sendJson,
  requireMutationOrigin,
} = {}) {
  if (!workerService || !projectWorkService) {
    throw new TypeError("workerService and projectWorkService are required");
  }
  const connectionHealth = new Map();

  async function handle(request, response, url, origin) {
    if (request.method === "GET" && url.pathname === "/api/v1/worker/definitions") {
      sendJson(response, 200, {
        schema_version: 1,
        definitions: await workerService.listDefinitions(),
      }, origin);
      return true;
    }

    if (request.method === "GET" && url.pathname === "/api/v1/worker/tasks") {
      const [tasks, conversations] = await Promise.all([
        workerService.listTasks({
          workerId: url.searchParams.get("worker_id") || null,
        }),
        projectWorkService.listWorkerConversations(),
      ]);
      const conversationsById = new Map(
        conversations.map((conversation) => [conversation.id, conversation]),
      );
      sendJson(response, 200, {
        schema_version: 1,
        tasks: tasks.map((task) => taskWithConversationTitle(
          task,
          conversationsById.get(task.conversationId),
        )),
      }, origin);
      return true;
    }

    if (request.method === "POST" && url.pathname === "/api/v1/worker/tasks") {
      requireMutationOrigin(origin);
      const payload = requireSchema(await readJson(request));
      const requestedTitle = typeof payload.title === "string" && payload.title.trim()
        ? payload.title.trim()
        : null;
      const conversation = await projectWorkService.createWorkerConversation({
        workerId: payload.worker_id,
        title: requestedTitle ?? undefined,
        sourceProjectId: payload.source_project_id ?? null,
        providerId: payload.provider_id,
        modelId: payload.model_id,
        thinkingLevel: payload.thinking_level,
      });
      try {
        const task = await workerService.createTask({
          workerId: payload.worker_id,
          conversationId: conversation.id,
          title: requestedTitle ?? DEFAULT_WORKER_TASK_TITLE,
          sourceProjectId: payload.source_project_id ?? null,
        });
        sendJson(response, 201, {
          schema_version: 1,
          task: taskWithConversationTitle(task, conversation),
          conversation,
        }, origin);
      } catch (error) {
        await projectWorkService.removeWorkerConversation(conversation.id)
          .catch(() => undefined);
        throw error;
      }
      return true;
    }

    const taskMatch = url.pathname.match(/^\/api\/v1\/worker\/tasks\/([^/]+)$/u);
    if (taskMatch && request.method === "GET") {
      const taskId = segment(taskMatch[1], "Worker 任务标识");
      sendJson(response, 200, {
        schema_version: 1,
        ...(await taskBundle(workerService, projectWorkService, taskId)),
      }, origin);
      return true;
    }
    if (taskMatch && request.method === "DELETE") {
      requireMutationOrigin(origin);
      const taskId = segment(taskMatch[1], "Worker 任务标识");
      const task = await workerService.getTask(taskId);
      await projectWorkService.removeWorkerConversation(task.conversationId);
      let result;
      try {
        result = await workerService.removeTask(task.id);
      } catch {
        throw workerError(
          "WORKER_TASK_DELETE_INCONSISTENT",
          "会话已删除，但 Worker 任务索引清理失败；请刷新后重试",
          500,
          { retryable: true },
        );
      }
      sendJson(response, 200, { schema_version: 1, result }, origin);
      return true;
    }
    if (taskMatch && request.method === "PATCH") {
      requireMutationOrigin(origin);
      const taskId = segment(taskMatch[1], "Worker 任务标识");
      const payload = requireSchema(await readJson(request));
      const task = await workerService.getTask(taskId);
      const conversation = await projectWorkService.updateWorkerConversationContext(
        task.conversationId,
        { sourceProjectId: payload.source_project_id ?? null },
      );
      let updatedTask;
      try {
        updatedTask = await workerService.updateTaskContext(task.id, {
          sourceProjectId: payload.source_project_id ?? null,
        });
      } catch (error) {
        try {
          await projectWorkService.updateWorkerConversationContext(
            task.conversationId,
            { sourceProjectId: task.sourceProjectId ?? null },
          );
        } catch {
          throw workerError(
            "WORKER_TASK_CONTEXT_INCONSISTENT",
            "项目背景更新未能完整提交，需要刷新并人工检查任务状态",
            500,
            { retryable: true },
          );
        }
        throw error;
      }
      sendJson(response, 200, {
        schema_version: 1,
        task: updatedTask,
        conversation,
      }, origin);
      return true;
    }

    const messagesMatch = url.pathname.match(
      /^\/api\/v1\/worker\/tasks\/([^/]+)\/messages$/u,
    );
    if (messagesMatch && request.method === "POST") {
      requireMutationOrigin(origin);
      const taskId = segment(messagesMatch[1], "Worker 任务标识");
      const payload = requireSchema(await readJson(request, { maxBytes: 4 * 1024 * 1024 }));
      const task = await workerService.getTask(taskId);
      const workerReferenceContext = await workerService.getAgentReferenceContext(task.id);
      const conversation = await projectWorkService.sendMessage(task.conversationId, {
        text: payload.text,
        attachments: payload.attachments ?? [],
        images: payload.images ?? [],
        providerId: payload.provider_id,
        modelId: payload.model_id,
        thinkingLevel: payload.thinking_level,
        clientRequestId: payload.client_request_id,
        workerReferenceContext,
      });
      sendJson(response, 202, { schema_version: 1, conversation }, origin);
      return true;
    }

    const questionsMatch = url.pathname.match(
      /^\/api\/v1\/worker\/tasks\/([^/]+)\/questions$/u,
    );
    if (questionsMatch && request.method === "GET") {
      const taskId = segment(questionsMatch[1], "Worker 任务标识");
      const task = await workerService.getTask(taskId);
      sendJson(response, 200, {
        schema_version: 1,
        requests: await projectWorkService.listAskUserRequests(
          task.conversationId,
          { includeHistory: url.searchParams.get("include_history") === "true" },
        ),
      }, origin);
      return true;
    }

    const questionActionMatch = url.pathname.match(
      /^\/api\/v1\/worker\/tasks\/([^/]+)\/questions\/([^/]+)\/(answer|cancel)$/u,
    );
    if (questionActionMatch && request.method === "POST") {
      requireMutationOrigin(origin);
      const taskId = segment(questionActionMatch[1], "Worker 任务标识");
      const requestId = segment(questionActionMatch[2], "问题请求标识");
      const action = questionActionMatch[3];
      const payload = requireSchema(await readJson(request));
      const task = await workerService.getTask(taskId);
      const result = action === "answer"
        ? await projectWorkService.answerAskUserRequest(
            task.conversationId,
            requestId,
            {
              answers: Array.isArray(payload.answers)
                ? payload.answers.map((answer) => ({
                    questionId: answer?.question_id ?? answer?.questionId,
                    value: answer?.value,
                  }))
                : payload.answers,
            },
          )
        : await projectWorkService.cancelAskUserRequest(
            task.conversationId,
            requestId,
          );
      sendJson(response, 200, { schema_version: 1, result }, origin);
      return true;
    }

    const runtimeActionMatch = url.pathname.match(
      /^\/api\/v1\/worker\/tasks\/([^/]+)\/(retry-last-turn|abort|compact|configuration)$/u,
    );
    if (runtimeActionMatch && request.method === "POST") {
      requireMutationOrigin(origin);
      const taskId = segment(runtimeActionMatch[1], "Worker 任务标识");
      const operation = runtimeActionMatch[2];
      const payload = requireSchema(await readJson(request));
      const task = await workerService.getTask(taskId);
      let conversation;
      if (operation === "retry-last-turn") {
        conversation = await projectWorkService.retryLastTurn(task.conversationId, {
          clientRequestId: payload.client_request_id,
        });
      } else if (operation === "abort") {
        conversation = await projectWorkService.abortConversation(task.conversationId);
      } else if (operation === "compact") {
        conversation = await projectWorkService.compactConversation(
          task.conversationId,
          { instructions: payload.instructions },
        );
      } else {
        conversation = await projectWorkService.configureConversation(
          task.conversationId,
          {
            providerId: payload.provider_id,
            modelId: payload.model_id,
            thinkingLevel: payload.thinking_level,
          },
        );
      }
      sendJson(response, 200, { schema_version: 1, conversation }, origin);
      return true;
    }

    const draftsMatch = url.pathname.match(
      /^\/api\/v1\/worker\/tasks\/([^/]+)\/drafts$/u,
    );
    const draftInvalidateMatch = url.pathname.match(
      /^\/api\/v1\/worker\/tasks\/([^/]+)\/drafts\/invalidate$/u,
    );
    if (draftInvalidateMatch && request.method === "POST") {
      requireMutationOrigin(origin);
      const taskId = segment(draftInvalidateMatch[1], "Worker 任务标识");
      const payload = requireSchema(await readJson(request));
      sendJson(response, 200, {
        schema_version: 1,
        result: await workerService.invalidateDraftActions(taskId, {
          draftRevisionId: payload.draft_revision_id,
        }),
      }, origin);
      return true;
    }
    if (draftsMatch && request.method === "GET") {
      const taskId = segment(draftsMatch[1], "Worker 任务标识");
      sendJson(response, 200, {
        schema_version: 1,
        drafts: await workerService.listDrafts(taskId),
      }, origin);
      return true;
    }

    const filesMatch = url.pathname.match(
      /^\/api\/v1\/worker\/tasks\/([^/]+)\/files$/u,
    );
    if (filesMatch && request.method === "GET") {
      const taskId = segment(filesMatch[1], "Worker 任务标识");
      sendJson(response, 200, {
        schema_version: 1,
        files: await workerService.listTaskFiles(taskId),
      }, origin);
      return true;
    }
    if (filesMatch && request.method === "POST") {
      requireMutationOrigin(origin);
      const taskId = segment(filesMatch[1], "Worker 任务标识");
      const payload = requireSchema(await readJson(request));
      const file = await workerService.createTaskFile(taskId, {
        fileName: payload.file_name,
        mimeType: payload.mime_type,
        byteLength: payload.byte_length,
      });
      sendJson(response, 201, { schema_version: 1, file }, origin);
      return true;
    }

    const fileMatch = url.pathname.match(
      /^\/api\/v1\/worker\/tasks\/([^/]+)\/files\/([^/]+)$/u,
    );
    if (fileMatch && request.method === "DELETE") {
      requireMutationOrigin(origin);
      const taskId = segment(fileMatch[1], "Worker 任务标识");
      const fileId = segment(fileMatch[2], "Worker 附件标识");
      sendJson(response, 200, {
        schema_version: 1,
        result: await workerService.removeTaskFile(taskId, fileId),
      }, origin);
      return true;
    }

    const fileContentMatch = url.pathname.match(
      /^\/api\/v1\/worker\/tasks\/([^/]+)\/files\/([^/]+)\/content$/u,
    );
    if (fileContentMatch && request.method === "PUT") {
      requireMutationOrigin(origin);
      if (typeof readBytes !== "function") {
        throw workerError("WORKER_FILE_UPLOAD_UNAVAILABLE", "附件上传暂不可用", 503);
      }
      const taskId = segment(fileContentMatch[1], "Worker 任务标识");
      const fileId = segment(fileContentMatch[2], "Worker 附件标识");
      const bytes = await readBytes(request, { maxBytes: 25 * 1024 * 1024 });
      const file = await workerService.stageTaskFile(taskId, fileId, bytes);
      sendJson(response, 201, { schema_version: 1, file }, origin);
      return true;
    }
    if (draftsMatch && request.method === "POST") {
      requireMutationOrigin(origin);
      const taskId = segment(draftsMatch[1], "Worker 任务标识");
      const payload = requireSchema(await readJson(request, { maxBytes: 4 * 1024 * 1024 }));
      const task = await workerService.getTask(taskId);
      const draft = await workerService.saveDraft(task.id, {
        content: payload.content,
        format: workerFormat(task.workerId, payload.format),
        source: payload.source,
      });
      sendJson(response, 201, {
        schema_version: 1,
        draft,
        actions: await workerService.listActions(task.id),
      }, origin);
      return true;
    }

    const readMatch = url.pathname.match(
      /^\/api\/v1\/worker\/tasks\/([^/]+)\/read$/u,
    );
    if (readMatch && request.method === "POST") {
      requireMutationOrigin(origin);
      const taskId = segment(readMatch[1], "Worker 任务标识");
      const payload = requireSchema(await readJson(request));
      sendJson(response, 200, {
        schema_version: 1,
        result: await workerService.readExternal(taskId, {
          operation: payload.operation,
          parameters: payload.parameters,
        }),
      }, origin);
      return true;
    }

    const actionsMatch = url.pathname.match(
      /^\/api\/v1\/worker\/tasks\/([^/]+)\/actions$/u,
    );
    if (actionsMatch && request.method === "GET") {
      const taskId = segment(actionsMatch[1], "Worker 任务标识");
      sendJson(response, 200, {
        schema_version: 1,
        actions: await workerService.listActions(taskId),
      }, origin);
      return true;
    }
    if (actionsMatch && request.method === "POST") {
      requireMutationOrigin(origin);
      const taskId = segment(actionsMatch[1], "Worker 任务标识");
      const payload = requireSchema(await readJson(request, { maxBytes: 4 * 1024 * 1024 }));
      const action = await workerService.proposeAction(taskId, {
        operation: payload.operation,
        parameters: payload.parameters,
        beforeSourceId: payload.before_source_id,
        afterSourceId: payload.after_source_id,
        historySourceId: payload.history_source_id,
        clientRequestId: payload.client_request_id,
      });
      sendJson(response, 201, { schema_version: 1, action }, origin);
      return true;
    }

    const actionMatch = url.pathname.match(
      /^\/api\/v1\/worker\/tasks\/([^/]+)\/actions\/([^/]+)$/u,
    );
    if (actionMatch && request.method === "GET") {
      const taskId = segment(actionMatch[1], "Worker 任务标识");
      const actionId = segment(actionMatch[2], "交付提案标识");
      sendJson(response, 200, {
        schema_version: 1,
        action: await workerService.getAction(taskId, actionId),
      }, origin);
      return true;
    }

    const actionTransitionMatch = url.pathname.match(
      /^\/api\/v1\/worker\/tasks\/([^/]+)\/actions\/([^/]+)\/(confirm|abandon|retry)$/u,
    );
    if (actionTransitionMatch && request.method === "POST") {
      requireMutationOrigin(origin);
      const taskId = segment(actionTransitionMatch[1], "Worker 任务标识");
      const actionId = segment(actionTransitionMatch[2], "交付提案标识");
      const transition = actionTransitionMatch[3];
      const payload = requireSchema(await readJson(request));
      let result;
      if (transition === "confirm") {
        result = await workerService.confirmAction(taskId, actionId, {
          proposalHash: payload.proposal_hash,
          draftSha256: payload.draft_sha256,
          baseRevisionId: payload.base_revision_id ?? null,
          clientRequestId: payload.client_request_id,
        });
      } else if (transition === "abandon") {
        result = await workerService.abandonAction(taskId, actionId, {
          reason: payload.reason,
          manualCheckCompleted: payload.manual_check_completed === true,
        });
      } else {
        result = await workerService.retryAction(taskId, actionId);
      }
      sendJson(response, transition === "confirm" ? 202 : 200, {
        schema_version: 1,
        result,
      }, origin);
      return true;
    }

    const receiptsMatch = url.pathname.match(
      /^\/api\/v1\/worker\/tasks\/([^/]+)\/receipts$/u,
    );
    if (receiptsMatch && request.method === "GET") {
      const taskId = segment(receiptsMatch[1], "Worker 任务标识");
      sendJson(response, 200, {
        schema_version: 1,
        receipts: await workerService.listReceipts(taskId),
      }, origin);
      return true;
    }

    if (request.method === "GET" && url.pathname === "/api/v1/connections") {
      const definitions = await workerService.listDefinitions();
      sendJson(response, 200, {
        schema_version: 1,
        connections: definitions.map((definition) => connectionHealth.get(definition.id) ?? {
          workerId: definition.id,
          connectorId: definition.connectorId,
          status: "unchecked",
          verified: false,
          identity: null,
          reason: null,
        }),
      }, origin);
      return true;
    }

    const connectionCheckMatch = url.pathname.match(
      /^\/api\/v1\/connections\/([^/]+)\/check$/u,
    );
    if (connectionCheckMatch && request.method === "POST") {
      requireMutationOrigin(origin);
      requireSchema(await readJson(request));
      const workerId = segment(connectionCheckMatch[1], "Worker 标识");
      const health = await workerService.getConnectionHealth(workerId);
      connectionHealth.set(workerId, health);
      sendJson(response, 200, { schema_version: 1, connection: health }, origin);
      return true;
    }

    return false;
  }

  return Object.freeze({ handle });
}

export function sendWorkerHttpError(response, error, origin, sendJson) {
  const status = error instanceof WorkerServiceError
    ? error.status
    : Number.isInteger(error?.status)
      ? error.status
      : 500;
  sendJson(response, status, {
    error: {
      code: typeof error?.code === "string" ? error.code : "WORKER_INTERNAL_ERROR",
      message: safeWorkerErrorMessage(error?.message),
      retryable: error?.retryable === true,
      unknown_outcome: error?.unknownOutcome === true,
    },
  }, origin);
}
