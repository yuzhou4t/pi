import assert from "node:assert/strict";
import test from "node:test";
import { WorkerServiceError } from "./errors.js";
import { createWorkerHttpApi, sendWorkerHttpError } from "./httpApi.js";

function harness({ worker = {}, project = {}, payload = {} } = {}) {
  const responses = [];
  const origins = [];
  const api = createWorkerHttpApi({
    workerService: worker,
    projectWorkService: project,
    readJson: async () => payload,
    sendJson: (_response, status, body, origin) => {
      responses.push({ status, body, origin });
    },
    requireMutationOrigin: (origin) => origins.push(origin),
  });
  return { api, responses, origins };
}

function request(method) {
  return { method };
}

test("Worker HTTP errors redact credentials and never expose raw CLI details", () => {
  const responses = [];
  const leakedToken = "ctk_http.must-not-return";
  const leakedBearer = "http-bearer-secret";
  const error = new WorkerServiceError(
    "WORKER_MAIL_OUTCOME_UNKNOWN",
    `CLI 结果不确定；confirmation_token=${leakedToken} Authorization: Bearer ${leakedBearer}`,
    502,
    {
      unknownOutcome: true,
      details: {
        stdout: leakedToken,
        stderr: leakedBearer,
      },
    },
  );
  sendWorkerHttpError(
    {},
    error,
    "http://127.0.0.1:5173",
    (_response, status, body, origin) => responses.push({ status, body, origin }),
  );
  assert.equal(responses.length, 1);
  assert.equal(responses[0].status, 502);
  assert.match(responses[0].body.error.message, /CLI 结果不确定/u);
  assert.doesNotMatch(JSON.stringify(responses[0].body), /ctk_http|http-bearer-secret/u);
  assert.deepEqual(Object.keys(responses[0].body.error).sort(), [
    "code",
    "message",
    "retryable",
    "unknown_outcome",
  ]);
});

test("Worker task bundle exposes imported sources without performing another read", async () => {
  let externalReads = 0;
  const worker = {
    async getTask() {
      return {
        id: "worker_task_1",
        conversationId: "conversation_1",
        workerId: "agent_mail",
      };
    },
    async getDraft() { return null; },
    async listSources() {
      return [{ id: "worker_source_1", title: "周报邮件" }];
    },
    async listTaskFiles() {
      return [];
    },
    async listActions() { return []; },
    async listReceipts() { return []; },
    async readExternal() {
      externalReads += 1;
      return null;
    },
  };
  const project = {
    async getConversation() { return { conversation: { id: "conversation_1" } }; },
  };
  const context = harness({ worker, project });
  const handled = await context.api.handle(
    request("GET"),
    {},
    new URL("http://localhost/api/v1/worker/tasks/worker_task_1"),
    null,
  );
  assert.equal(handled, true);
  assert.equal(context.responses[0].status, 200);
  assert.deepEqual(context.responses[0].body.sources, [{
    id: "worker_source_1",
    title: "周报邮件",
  }]);
  assert.equal(externalReads, 0);
});

test("Worker task titles project from the bound Pi conversation", async () => {
  const worker = {
    async listTasks() {
      return [{
        id: "worker_task_1",
        workerId: "agent_mail",
        conversationId: "conversation_1",
        title: "新工作会话",
      }];
    },
  };
  const project = {
    async listWorkerConversations() {
      return [{ id: "conversation_1", title: "整理导师邮件" }];
    },
  };
  const context = harness({ worker, project });
  await context.api.handle(
    request("GET"),
    {},
    new URL("http://localhost/api/v1/worker/tasks"),
    null,
  );

  assert.equal(context.responses[0].body.tasks[0].title, "整理导师邮件");
});

test("Worker task creation accepts no title and keeps the conversation prompt-derived", async () => {
  const calls = [];
  const worker = {
    async createTask(input) {
      calls.push(["task", input]);
      return { id: "worker_task_1", ...input };
    },
  };
  const project = {
    async createWorkerConversation(input) {
      calls.push(["conversation", input]);
      return { id: "conversation_1", title: "新工作会话" };
    },
    async removeWorkerConversation() {},
  };
  const context = harness({
    worker,
    project,
    payload: { schema_version: 1, worker_id: "agent_mail" },
  });
  await context.api.handle(
    request("POST"),
    {},
    new URL("http://localhost/api/v1/worker/tasks"),
    "http://127.0.0.1:5173",
  );

  assert.equal(calls[0][0], "conversation");
  assert.equal(calls[0][1].title, undefined);
  assert.equal(calls[1][1].title, "新工作会话");
  assert.equal(context.responses[0].body.task.title, "新工作会话");
});

test("Worker messages receive persisted reference context and Lark drafts default to XML", async () => {
  const sent = [];
  const saved = [];
  const worker = {
    async getTask() {
      return {
        id: "worker_task_1",
        conversationId: "conversation_1",
        workerId: "lark_doc",
      };
    },
    async getAgentReferenceContext() {
      return {
        text: "<worker_external_references trust=\"untrusted\">资料</worker_external_references>",
        sha256: "sha256:reference",
      };
    },
    async saveDraft(_taskId, input) {
      saved.push(input);
      return { id: "draft_1", ...input };
    },
    async listActions() { return []; },
  };
  const project = {
    async sendMessage(_conversationId, input) {
      sent.push(input);
      return { conversation: { id: "conversation_1" } };
    },
  };
  const messageContext = harness({
    worker,
    project,
    payload: {
      schema_version: 1,
      text: "根据资料起草",
      client_request_id: "worker-message-1",
    },
  });
  await messageContext.api.handle(
    request("POST"),
    {},
    new URL("http://localhost/api/v1/worker/tasks/worker_task_1/messages"),
    "http://127.0.0.1:5173",
  );
  assert.equal(sent.length, 1);
  assert.match(sent[0].workerReferenceContext.text, /trust="untrusted"/u);
  assert.equal(messageContext.origins.length, 1);

  const draftContext = harness({
    worker,
    project,
    payload: {
      schema_version: 1,
      content: "<p>草稿</p>",
      source: "user",
    },
  });
  await draftContext.api.handle(
    request("POST"),
    {},
    new URL("http://localhost/api/v1/worker/tasks/worker_task_1/drafts"),
    "http://127.0.0.1:5173",
  );
  assert.equal(saved[0].format, "xml");
});

test("Worker context update rolls the conversation back if task persistence fails", async () => {
  const projectUpdates = [];
  const worker = {
    async getTask() {
      return {
        id: "worker_task_1",
        conversationId: "conversation_1",
        workerId: "lark_doc",
        sourceProjectId: "project_old",
      };
    },
    async updateTaskContext() {
      throw Object.assign(new Error("store unavailable"), { code: "STORE_FAILED" });
    },
  };
  const project = {
    async updateWorkerConversationContext(_conversationId, input) {
      projectUpdates.push(input.sourceProjectId);
      return { conversation: { id: "conversation_1" } };
    },
  };
  const context = harness({
    worker,
    project,
    payload: { schema_version: 1, source_project_id: "project_new" },
  });
  await assert.rejects(
    context.api.handle(
      request("PATCH"),
      {},
      new URL("http://localhost/api/v1/worker/tasks/worker_task_1"),
      "http://127.0.0.1:5173",
    ),
    { code: "STORE_FAILED" },
  );
  assert.deepEqual(projectUpdates, ["project_new", "project_old"]);
});

test("Worker question routes list, answer, and cancel the bound Agent request", async () => {
  const calls = [];
  const worker = {
    async getTask() {
      return {
        id: "worker_task_1",
        conversationId: "conversation_1",
        workerId: "agent_mail",
      };
    },
  };
  const project = {
    async listAskUserRequests(conversationId, options) {
      calls.push(["list", conversationId, options]);
      return [{ id: "ask-user-1", status: "pending" }];
    },
    async answerAskUserRequest(conversationId, requestId, input) {
      calls.push(["answer", conversationId, requestId, input]);
      return { request: { id: requestId, status: "answered" } };
    },
    async cancelAskUserRequest(conversationId, requestId) {
      calls.push(["cancel", conversationId, requestId]);
      return { request: { id: requestId, status: "cancelled" } };
    },
  };
  const listContext = harness({ worker, project });
  await listContext.api.handle(
    request("GET"),
    {},
    new URL("http://localhost/api/v1/worker/tasks/worker_task_1/questions?include_history=true"),
    null,
  );
  assert.equal(listContext.responses[0].body.requests[0].status, "pending");

  const answerContext = harness({
    worker,
    project,
    payload: {
      schema_version: 1,
      answers: [{ question_id: "audience", value: "导师" }],
    },
  });
  await answerContext.api.handle(
    request("POST"),
    {},
    new URL("http://localhost/api/v1/worker/tasks/worker_task_1/questions/ask-user-1/answer"),
    "http://127.0.0.1:5173",
  );

  const cancelContext = harness({
    worker,
    project,
    payload: { schema_version: 1 },
  });
  await cancelContext.api.handle(
    request("POST"),
    {},
    new URL("http://localhost/api/v1/worker/tasks/worker_task_1/questions/ask-user-2/cancel"),
    "http://127.0.0.1:5173",
  );
  assert.deepEqual(calls, [
    ["list", "conversation_1", { includeHistory: true }],
    ["answer", "conversation_1", "ask-user-1", {
      answers: [{ questionId: "audience", value: "导师" }],
    }],
    ["cancel", "conversation_1", "ask-user-2"],
  ]);
});

test("draft invalidate route binds the current revision without creating a draft", async () => {
  const calls = [];
  const result = {
    schemaVersion: 1,
    taskId: "worker_task_1",
    draftRevisionId: "draft_1",
    invalidatedProposalIds: ["delivery_1"],
  };
  const context = harness({
    worker: {
      async invalidateDraftActions(taskId, input) {
        calls.push({ taskId, input });
        return result;
      },
    },
    payload: {
      schema_version: 1,
      draft_revision_id: "draft_1",
    },
  });
  const handled = await context.api.handle(
    request("POST"),
    {},
    new URL("http://localhost/api/v1/worker/tasks/worker_task_1/drafts/invalidate"),
    "http://127.0.0.1:5173",
  );
  assert.equal(handled, true);
  assert.deepEqual(calls, [{
    taskId: "worker_task_1",
    input: { draftRevisionId: "draft_1" },
  }]);
  assert.deepEqual(context.responses, [{
    status: 200,
    body: { schema_version: 1, result },
    origin: "http://127.0.0.1:5173",
  }]);
  assert.deepEqual(context.origins, ["http://127.0.0.1:5173"]);
});

test("abandon route forwards explicit manual-check completion", async () => {
  const calls = [];
  const context = harness({
    worker: {
      async abandonAction(taskId, actionId, input) {
        calls.push({ taskId, actionId, input });
        return { id: actionId, status: "abandoned" };
      },
    },
    payload: {
      schema_version: 1,
      manual_check_completed: true,
      reason: "已人工核对",
    },
  });
  await context.api.handle(
    request("POST"),
    {},
    new URL("http://localhost/api/v1/worker/tasks/worker_task_1/actions/delivery_1/abandon"),
    "http://127.0.0.1:5173",
  );
  assert.deepEqual(calls, [{
    taskId: "worker_task_1",
    actionId: "delivery_1",
    input: { reason: "已人工核对", manualCheckCompleted: true },
  }]);
  assert.equal(context.responses[0].status, 200);
});
