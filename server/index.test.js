import assert from "node:assert/strict";
import test from "node:test";
import { createApiServer, publicRun } from "./index.js";

const candidateSummaryService = {
  config: {
    mode: "fixture",
    defaultProviderId: "codex-subscription",
  },
  listProviders: async () => ({ providers: [] }),
  summarize: async () => ({ schema_version: 1, summaries: [] }),
};

function proposalArtifact() {
  return {
    schema_version: 1,
    run_id: "journal-test",
    proposal_id: "zotero-preview-1",
    proposal_hash: "sha256:preview",
    target: {
      id: "C2",
      name: "AI前沿论文",
      libraryId: 1,
      libraryName: "我的文库",
      level: 2,
      path: ["我的文库", "研究", "AI前沿论文"],
      editable: true,
      filesEditable: true,
      connectorSession: "must-not-leak",
    },
    decisions: { "paper-1": "collect" },
    proposals: [{
      proposal_id: "zotero-paper-1",
      run_id: "journal-test",
      paper_id: "paper-1",
      target: "zotero",
      operation: "create",
      write_mode: "create_with_assets",
      operation_label: "新建题录并附加全文与导读",
      target_locator: "我的文库 / 研究 / AI前沿论文",
      target_id: "C2",
      preview_or_diff: ["动作：新建题录", "原版 PDF：paper-1.pdf"],
      content_hash: "sha256:content",
      target_version_or_hash: "sha256:target",
      selected: true,
      status: "draft",
      item: { title: "private connector payload" },
      note_html: "<p>private connector note</p>",
      connectorItemId: "must-not-leak",
      metadata: {
        item_type: "conferencePaper",
        title: "Paper 1",
        authors: ["Ada"],
        venue: "AAAI",
        date: "2026-07-23",
        doi: "10.1234/test",
        url: "https://example.com/paper",
        abstract: "A bounded abstract.",
        tags: ["Pi Agent"],
        extra: "Pi-Agent-Paper-ID: paper-1",
      },
      pdf: {
        file_name: "paper-1.pdf",
        sha256: "pdf-hash",
        byte_length: 123,
        source_url: "https://example.com/paper.pdf",
        file_path: "/private/cache/paper-1.pdf",
      },
      guide: {
        document_revision: "sha256:document",
        prompt_version: "five-minute-guide.v1",
        note_sha256: "sha256:note",
        sections: {
          problem: "问题",
          why_read: "价值",
          intuition: "直觉",
          evidence: "证据",
          limitations: "局限",
          questions: ["问题一？"],
          artifact_path: "/private/guide.md",
        },
        references: [{
          block_id: "block-1",
          path: ["Method", "Planning"],
          excerpt: "A bounded evidence excerpt.",
          file_path: "/private/evidence.md",
        }],
      },
    }],
    artifact_path: "/private/proposal.json",
    generated_at: "2026-07-23T12:00:00.000Z",
  };
}

function obsidianArtifact() {
  return {
    schema_version: 1,
    run_id: "journal-test",
    target_type: "obsidian",
    write_capability: "preview_only",
    external_write_performed: false,
    status: "preview_ready",
    configured_directory: "/private/configured-vault",
    target_directory: "/Users/demo/Obsidian/论文精读",
    source_hash: "sha256:source",
    proposal_hash: "sha256:obsidian-preview",
    proposals: [{
      proposal_id: "obsidian-preview-paper-1",
      run_id: "journal-test",
      paper_id: "paper-1",
      decision: "read",
      target: "obsidian",
      operation: "create",
      write_mode: "create_only",
      target_locator: "/Users/demo/Obsidian/论文精读/2026-Ada-Paper--abcd1234.md",
      target_details: {
        directory: "/Users/demo/Obsidian/论文精读",
        file_name: "2026-Ada-Paper--abcd1234.md",
        exists: false,
        kind: null,
        byte_length: 0,
        current_content_hash: null,
      },
      target_hash: "sha256:target",
      target_version_or_hash: "sha256:target",
      content_hash: "sha256:markdown",
      markdown: "# Paper\n\n## 1. 研究问题\n\n内容\n",
      markdown_artifact_path: "/private/preview.md",
      actionable: true,
      selected: true,
      status: "draft",
      preview_or_diff: ["新建文件：2026-Ada-Paper--abcd1234.md"],
      diff: {
        mode: "create",
        before: null,
        after: "# Paper\n\n## 1. 研究问题\n\n内容\n",
      },
    }],
    artifact_path: "/private/obsidian-preview.json",
    generated_at: "2026-07-23T12:00:00.000Z",
  };
}

function projectStateArtifact() {
  return {
    schema_version: 1,
    run_id: "journal-test",
    target_type: "project_state",
    write_capability: "preview_only",
    external_write_performed: false,
    status: "preview_ready",
    source_hash: "sha256:project-source",
    proposal_hash: "sha256:project-preview",
    proposal: {
      proposal_id: "project-state-preview-1",
      run_id: "journal-test",
      target: "project_state",
      operation: "append",
      write_mode: "append_after_approval",
      target_locator: "/Users/demo/project/PRODUCT_MEETING.md",
      target_details: {
        project_root: "/private/project-root",
        source_path: "PRODUCT_MEETING.md",
        byte_length: 321,
        current_content_hash: "sha256:before",
      },
      content_hash: "sha256:append",
      target_hash: "sha256:target",
      target_version_or_hash: "sha256:target",
      marker: "<!-- pi-agent:project-state-run:journal-test -->",
      markdown: [
        "<!-- pi-agent:project-state-run:journal-test -->",
        "## Pi Agent · 本周项目状态更新建议",
        "",
        "- 建议：继续验证这条方法路线。",
      ].join("\n"),
      actionable: true,
      selected: true,
      status: "draft",
      preview_or_diff: ["追加到 PRODUCT_MEETING.md 末尾"],
      diff: {
        mode: "append",
        append_offset_chars: 321,
        append_offset_bytes: 321,
        append_text: "\n\n<!-- pi-agent:project-state-run:journal-test -->\n## Pi Agent · 本周项目状态更新建议\n",
        before_hash: "sha256:before",
        after_hash: "sha256:after",
        before_byte_length: 321,
        after_byte_length: 421,
      },
      paper_references: [{
        paper_id: "paper-1",
        title: "Paper 1",
        obsidian_note: "2026-Ada-Paper--abcd1234.md",
      }],
      markdown_artifact_path: "/private/project-state.md",
    },
    artifact_path: "/private/project-state-preview.json",
    generated_at: "2026-07-23T12:00:00.000Z",
  };
}

function committingRun() {
  const artifact = proposalArtifact();
  return {
    schema_version: 1,
    run_id: "journal-test",
    status: "committing",
    phase: "zotero_commit",
    candidates: [],
    guides: {
      status: "ready",
      requested_paper_ids: ["paper-1"],
      papers: {
        "paper-1": {
          status: "ready",
          revision: "sha256:document",
          prompt_version: "five-minute-guide.v3",
          input_hash: "sha256:guide-input",
        },
      },
    },
    paper_decisions: { "paper-1": "read" },
    readings: {
      schema_version: 1,
      status: "reading",
      paper_ids: ["paper-1"],
      provider_id: "codex-subscription",
      model_id: "account-default",
      artifact_path: "/private/readings.json",
      papers: {
        "paper-1": {
          status: "reading",
          document_revision: "sha256:document",
          current_stage: "research-question",
          artifact_path: "/private/paper-reading.json",
          position: {
            mode: "focused",
            block_id: "block-1",
            updated_at: "2026-07-23T12:00:00.000Z",
          },
          stages: {
            "research-question": {
              status: "ready",
              artifact_json: "readings/paper-1/research-question.json",
              artifact_markdown: "readings/paper-1/research-question.md",
              content_hash: "sha256:stage",
              input_hash: "sha256:input",
              prompt_id: "research-question",
              prompt_version: "research-question.v2",
              provider_id: "codex-subscription",
              model_id: "account-default",
              error: null,
              updated_at: "2026-07-23T12:00:00.000Z",
            },
          },
          questions: [{
            id: "question-1",
            client_request_id: "client-1",
            stage: "research-question",
            block_id: "block-1",
            text: "问题是什么？",
            status: "answered",
            artifact_path: "/private/question.json",
            error: null,
            created_at: "2026-07-23T12:00:00.000Z",
            answered_at: "2026-07-23T12:00:01.000Z",
          }],
          chat: {
            id: "reading-conversation-current",
            title: "论文主研读",
            status: "ready",
            turns: [{
              id: "chat-turn-1",
              client_request_id: "client-chat-1",
              question: "这段是什么意思？",
              status: "answered",
              reference: {
                block_id: "block-1",
                path: ["Introduction"],
                ordinal: 1,
                start_offset: 0,
                end_offset: 4,
                quote: "这段",
                source_hash: "sha256:quote",
                artifact_path: "/private/chat-reference.json",
              },
              input_hash: "sha256:chat",
              artifact_json: "/private/chat.json",
              provider_id: "deepseek",
              model_id: "deepseek-v4-flash",
              cache_hit: false,
              cache_write_failed: true,
              request_fingerprint: "sha256:private-request-fingerprint",
              inline_artifact: {
                source_path: "/private/inline-chat-artifact.json",
              },
              project_context_requested: false,
              project_context_status: "not_requested",
              project_context_source_path: null,
              error: null,
              created_at: "2026-07-23T12:00:00.000Z",
              answered_at: "2026-07-23T12:00:01.000Z",
            }],
            updated_at: "2026-07-23T12:00:01.000Z",
          },
          archived_conversations: [{
            id: "reading-conversation-branch",
            title: "方法分支",
            turns: [{ id: "branch-turn-1" }],
            updated_at: "2026-07-23T11:00:00.000Z",
          }],
          agent_actions: {
            schema_version: 1,
            status: "committed",
            proposals: [{
              proposal_id: "reading-note-1",
              turn_id: "chat-turn-1",
              status: "committed",
              content_hash: "sha256:agent-note",
              target_version_or_hash: "sha256:agent-target",
              target_locator: "/private/obsidian/Paper.md",
              diff: { after: "must-not-leak" },
              committed_at: "2026-07-23T12:02:00.000Z",
              updated_at: "2026-07-23T12:02:00.000Z",
            }],
            updated_at: "2026-07-23T12:02:00.000Z",
          },
        },
      },
      last_error: null,
    },
    obsidian: {
      status: "preview_ready",
      proposal_hash: "sha256:obsidian-preview",
      artifact_path: "/private/obsidian-preview.json",
      proposals: obsidianArtifact().proposals,
      approval: null,
      last_error: null,
      updated_at: "2026-07-23T12:00:00.000Z",
    },
    project_state: {
      status: "preview_ready",
      proposal_id: "project-state-preview-1",
      proposal_hash: "sha256:project-preview",
      artifact_path: "/private/project-state-preview.json",
      markdown_artifact_path: "/private/project-state.md",
      target_locator: "/Users/demo/project/PRODUCT_MEETING.md",
      target_hash: "sha256:target",
      content_hash: "sha256:append",
      actionable: true,
      approval: null,
      last_error: null,
      updated_at: "2026-07-23T12:00:00.000Z",
    },
    zotero: {
      status: "committing",
      target: artifact.target,
      decisions: artifact.decisions,
      proposal_id: artifact.proposal_id,
      proposal_hash: artifact.proposal_hash,
      artifact_path: "/private/proposal.json",
      connectorSession: "must-not-leak",
      proposals: artifact.proposals,
      approval: {
        approval_id: "approval-1",
        proposal_id: artifact.proposal_id,
        proposal_hash: artifact.proposal_hash,
        operations: [{
          proposal_id: "zotero-paper-1",
          content_hash: "sha256:content",
          target_version_or_hash: "sha256:target",
          connectorItemId: "must-not-leak",
        }],
        approved_at: "2026-07-23T12:01:00.000Z",
      },
      last_error: null,
    },
  };
}

async function startTestServer(
  journalWorkflowService,
  summaryService = candidateSummaryService,
  projectWorkService,
) {
  const server = createApiServer({
    candidateSummaryService: summaryService,
    journalWorkflowService,
    projectWorkService,
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

test("project-work PDF routes use raw bytes and conversation-owned retry/remove actions", async (t) => {
  const calls = [];
  const snapshot = (status, documents = [{
    id: "document-route-1",
    fileName: "开发手册.pdf",
    byteLength: 18,
    status,
    parser: "MinerU Cloud v4",
  }]) => ({
    schemaVersion: 1,
    conversation: {
      id: "conversation-route-1",
      projectId: "project-route-1",
      workspaceKind: "bound_project",
      scope: "project",
      rootLabel: "项目",
      title: "接口测试",
      status: "idle",
      messages: [],
      documents,
      lastEventSeq: 0,
      createdAt: "2026-07-27T00:00:00.000Z",
      updatedAt: "2026-07-27T00:00:00.000Z",
    },
    events: [],
    hasMoreEvents: false,
  });
  const projectWorkService = {
    async createConversationDocument(conversationId, options) {
      calls.push({ action: "create", conversationId, options });
      return {
        document: snapshot("awaiting_upload").conversation.documents[0],
        snapshot: snapshot("awaiting_upload"),
      };
    },
    async uploadConversationDocument(
      conversationId,
      documentId,
      request,
      options,
    ) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      calls.push({
        action: "upload",
        conversationId,
        documentId,
        options,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      return snapshot("local_ready");
    },
    async retryConversationDocument(conversationId, documentId) {
      calls.push({ action: "retry", conversationId, documentId });
      return snapshot("local_ready");
    },
    async removeConversationDocument(conversationId, documentId) {
      calls.push({ action: "remove", conversationId, documentId });
      return snapshot("idle", []);
    },
  };
  const server = await startTestServer(
    {},
    candidateSummaryService,
    projectWorkService,
  );
  t.after(() => server.close());
  const headers = {
    origin: "http://127.0.0.1:4173",
    "content-type": "application/json",
  };

  const createdResponse = await fetch(
    `${server.baseUrl}/api/v1/project-work/conversations/conversation-route-1/documents`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        schema_version: 1,
        file_name: "开发手册.pdf",
        byte_length: 18,
      }),
    },
  );
  assert.equal(createdResponse.status, 201);
  assert.equal((await createdResponse.json()).document.status, "awaiting_upload");

  const pdf = Buffer.from("%PDF-1.7\nroute\n", "utf8");
  const uploadedResponse = await fetch(
    `${server.baseUrl}/api/v1/project-work/conversations/conversation-route-1/documents/document-route-1/content`,
    {
      method: "PUT",
      headers: {
        origin: "http://127.0.0.1:4173",
        "content-type": "application/pdf",
      },
      body: pdf,
    },
  );
  assert.equal(uploadedResponse.status, 202);
  assert.equal(
    (await uploadedResponse.json()).conversation.documents[0].status,
    "local_ready",
  );

  const retriedResponse = await fetch(
    `${server.baseUrl}/api/v1/project-work/conversations/conversation-route-1/documents/document-route-1/retry`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ schema_version: 1 }),
    },
  );
  assert.equal(retriedResponse.status, 202);

  const removedResponse = await fetch(
    `${server.baseUrl}/api/v1/project-work/conversations/conversation-route-1/documents/document-route-1`,
    {
      method: "DELETE",
      headers: { origin: "http://127.0.0.1:4173" },
    },
  );
  assert.equal(removedResponse.status, 200);
  assert.deepEqual((await removedResponse.json()).conversation.documents, []);
  assert.deepEqual(calls, [{
    action: "create",
    conversationId: "conversation-route-1",
    options: {
      fileName: "开发手册.pdf",
      byteLength: 18,
    },
  }, {
    action: "upload",
    conversationId: "conversation-route-1",
    documentId: "document-route-1",
    options: {
      contentType: "application/pdf",
      declaredLength: String(pdf.length),
    },
    body: pdf.toString("utf8"),
  }, {
    action: "retry",
    conversationId: "conversation-route-1",
    documentId: "document-route-1",
  }, {
    action: "remove",
    conversationId: "conversation-route-1",
    documentId: "document-route-1",
  }]);
});

test("project-work conversation menu routes stay project-scoped and return safe data", async (t) => {
  const calls = [];
  const projectWorkService = {
    renameConversation: async (projectId, conversationId, { title }) => {
      calls.push({ action: "rename", projectId, conversationId, title });
      return {
        id: conversationId,
        projectId,
        title,
        status: "idle",
        providerId: "deepseek",
        modelId: "deepseek-v4-flash",
        thinkingLevel: "medium",
        pendingChangeFileCount: 2,
        lastEventSeq: 0,
        createdAt: "2026-07-25T00:00:00.000Z",
        updatedAt: "2026-07-25T00:01:00.000Z",
      };
    },
    removeConversation: async (projectId, conversationId) => {
      calls.push({ action: "delete", projectId, conversationId });
      return {
        id: conversationId,
        projectId,
        removed: true,
        conversationCount: 2,
        rootPath: "/private/project/must-not-leak",
      };
    },
  };
  const server = await startTestServer({}, candidateSummaryService, projectWorkService);
  t.after(server.close);

  const endpoint = `${server.baseUrl}/api/v1/project-work/projects/project-one/conversations/conversation-two`;
  const renameResponse = await fetch(endpoint, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      origin: "http://127.0.0.1:4173",
    },
    body: JSON.stringify({ title: "新的会话名称" }),
  });
  const renamePayload = await renameResponse.json();
  assert.equal(renameResponse.status, 200);
  assert.equal(renamePayload.conversation.title, "新的会话名称");
  assert.equal(renamePayload.conversation.pendingChangeFileCount, 2);
  assert.equal(Object.hasOwn(renamePayload.conversation, "rootPath"), false);

  const response = await fetch(
    endpoint,
    {
      method: "DELETE",
      headers: {
        origin: "http://127.0.0.1:4173",
      },
    },
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [{
    action: "rename",
    projectId: "project-one",
    conversationId: "conversation-two",
    title: "新的会话名称",
  }, {
    action: "delete",
    projectId: "project-one",
    conversationId: "conversation-two",
  }]);
  assert.deepEqual(payload, {
    schemaVersion: 1,
    projectId: "project-one",
    conversationId: "conversation-two",
    removed: true,
    conversationCount: 2,
  });
  assert.equal(JSON.stringify(payload).includes("must-not-leak"), false);

  const preflight = await fetch(endpoint, {
    method: "OPTIONS",
    headers: {
      origin: "http://127.0.0.1:4173",
    },
  });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get("access-control-allow-methods"), /\bPATCH\b/);
});

test("standalone project-work conversation routes use the global scope and return safe data", async (t) => {
  const calls = [];
  const summary = {
    id: "conversation-standalone",
    projectId: null,
    workspaceKind: "scratch",
    scope: "standalone",
    rootLabel: "未连接文件夹",
    title: "独立任务",
    status: "idle",
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
    thinkingLevel: "medium",
    pendingChangeFileCount: 0,
    lastEventSeq: 0,
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
  };
  const projectWorkService = {
    listStandaloneConversations: async () => {
      calls.push({ action: "list" });
      return [{ ...summary, rootPath: "/private/must-not-leak" }];
    },
    createStandaloneConversation: async ({ title }) => {
      calls.push({ action: "create", title });
      return { ...summary, title };
    },
    renameStandaloneConversation: async (conversationId, { title }) => {
      calls.push({ action: "rename", conversationId, title });
      return { ...summary, id: conversationId, title };
    },
    removeStandaloneConversation: async (conversationId) => {
      calls.push({ action: "delete", conversationId });
      return {
        id: conversationId,
        projectId: null,
        removed: true,
        conversationCount: 0,
        rootPath: "/private/must-not-leak",
      };
    },
    getConversationTree: async (conversationId, options) => {
      calls.push({ action: "tree", conversationId, options });
      return {
        schemaVersion: 1,
        directory: options.directory,
        entries: [{ name: "draft.md", path: "draft.md", type: "file" }],
      };
    },
  };
  const server = await startTestServer({}, candidateSummaryService, projectWorkService);
  t.after(server.close);
  const collection = `${server.baseUrl}/api/v1/project-work/conversations`;
  const headers = {
    "content-type": "application/json",
    origin: "http://127.0.0.1:4173",
  };

  const listResponse = await fetch(collection);
  const listPayload = await listResponse.json();
  assert.equal(listResponse.status, 200);
  assert.deepEqual(listPayload.conversations, [summary]);
  assert.equal(JSON.stringify(listPayload).includes("must-not-leak"), false);

  const createResponse = await fetch(collection, {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "马上开始" }),
  });
  assert.equal(createResponse.status, 201);
  assert.equal((await createResponse.json()).title, "马上开始");

  const item = `${collection}/conversation-standalone`;
  const renameResponse = await fetch(item, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ title: "新的独立任务" }),
  });
  assert.equal(renameResponse.status, 200);
  assert.equal((await renameResponse.json()).conversation.title, "新的独立任务");

  const treeResponse = await fetch(`${item}/tree?path=notes&depth=2`);
  const treePayload = await treeResponse.json();
  assert.equal(treeResponse.status, 200);
  assert.equal(treePayload.entries[0].path, "draft.md");

  const deleteResponse = await fetch(item, {
    method: "DELETE",
    headers: { origin: "http://127.0.0.1:4173" },
  });
  const deletePayload = await deleteResponse.json();
  assert.equal(deleteResponse.status, 200);
  assert.deepEqual(deletePayload, {
    schemaVersion: 1,
    projectId: null,
    conversationId: "conversation-standalone",
    removed: true,
    conversationCount: 0,
  });
  assert.equal(JSON.stringify(deletePayload).includes("must-not-leak"), false);
  assert.deepEqual(calls, [
    { action: "list" },
    { action: "create", title: "马上开始" },
    {
      action: "rename",
      conversationId: "conversation-standalone",
      title: "新的独立任务",
    },
    {
      action: "tree",
      conversationId: "conversation-standalone",
      options: { directory: "notes", depth: 2 },
    },
    { action: "delete", conversationId: "conversation-standalone" },
  ]);
});

test("project-work message routes accept bounded images and forward one-turn settings", async (t) => {
  const calls = [];
  const projectWorkService = {
    sendMessage: async (conversationId, options) => {
      calls.push({ conversationId, options });
      return {
        conversation: {
          id: conversationId,
          projectId: "project-one",
          status: "running",
          messages: [],
        },
        events: [],
      };
    },
    configureConversation: async () => {
      throw new Error("oversized configuration must not reach the service");
    },
    steerConversation: async () => {
      throw new Error("oversized steer must not reach the service");
    },
  };
  const server = await startTestServer({}, candidateSummaryService, projectWorkService);
  t.after(server.close);
  const endpoint = `${server.baseUrl}/api/v1/project-work/conversations/conversation-image/messages`;
  const largeBoundedData = "A".repeat(300_000);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://127.0.0.1:4173",
    },
    body: JSON.stringify({
      schema_version: 1,
      client_request_id: "project-message:image-route",
      text: "检查截图",
      workflow_id: "screenshot_review",
      capabilities: ["web_search"],
      images: [{
        file_name: "设置页.png",
        mime_type: "image/png",
        byte_length: 225_000,
        data: largeBoundedData,
      }],
      contexts: [{
        path: "src/App.jsx",
        content_hash: "sha256:source",
        start_line: 10,
        end_line: 20,
      }],
      provider_id: "test",
      model_id: "vision",
      thinking_level: "medium",
    }),
  });
  assert.equal(response.status, 202);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    conversationId: "conversation-image",
    options: {
      text: "检查截图",
      context: [{
        path: "src/App.jsx",
        contentHash: "sha256:source",
        startLine: 10,
        endLine: 20,
      }],
      providerId: "test",
      modelId: "vision",
      thinkingLevel: "medium",
      workflowId: "screenshot_review",
      capabilities: ["web_search"],
      images: [{
        file_name: "设置页.png",
        mime_type: "image/png",
        byte_length: 225_000,
        data: largeBoundedData,
      }],
      clientRequestId: "project-message:image-route",
    },
  });

  const oversizedConfiguration = await fetch(
    `${server.baseUrl}/api/v1/project-work/conversations/conversation-image/configuration`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://127.0.0.1:4173",
      },
      body: JSON.stringify({
        schema_version: 1,
        thinking_level: "medium",
        padding: "x".repeat(300_000),
      }),
    },
  );
  assert.equal(oversizedConfiguration.status, 413);
  assert.match(
    (await oversizedConfiguration.json()).error.message,
    /256 KB/,
  );

  const oversizedSteer = await fetch(
    `${server.baseUrl}/api/v1/project-work/conversations/conversation-image/steer`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://127.0.0.1:4173",
      },
      body: JSON.stringify({
        schema_version: 1,
        text: "x".repeat(300_000),
      }),
    },
  );
  assert.equal(oversizedSteer.status, 413);
  assert.match(
    (await oversizedSteer.json()).error.message,
    /256 KB/,
  );
});

test("candidate summaries use the server project-state source", async (t) => {
  let receivedPayload = null;
  const summaryService = {
    config: {
      mode: "fixture",
      defaultProviderId: "codex-subscription",
    },
    listProviders: async () => ({ providers: [] }),
    summarize: async (payload) => {
      receivedPayload = payload;
      return {
        schema_version: 2,
        source: "fixture",
        provider_id: payload.provider_id,
        model_id: payload.model_id,
        items: [],
      };
    },
  };
  const workflow = {
    getProjectContext: async () => ({
      source_path: "project_state.md",
      revision: "sha256:current-project-state",
      state: {
        goal: "验证真实工作流",
        decisions: ["项目状态只有一个事实源"],
        open_questions: ["真实试跑质量如何？"],
        next_action: "完成用户测试",
      },
    }),
  };
  const server = await startTestServer(workflow, summaryService);
  t.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/v1/candidate-summaries`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schema_version: 2,
      run_id: "journal-test",
      provider_id: "deepseek",
      model_id: "deepseek-v4-flash",
      project_context: {
        goal: "浏览器里的过期目标",
        decisions: [],
        open_questions: [],
        next_action: "",
      },
      papers: [],
    }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(receivedPayload.project_context, {
    goal: "验证真实工作流",
    decisions: ["项目状态只有一个事实源"],
    open_questions: ["真实试跑质量如何？"],
    next_action: "完成用户测试",
  });
});

test("Zotero HTTP routes map request fields and return only safe previews", async (t) => {
  const calls = {
    proposal: null,
    commit: null,
  };
  const artifact = proposalArtifact();
  const workflow = {
    getZoteroStatus: async () => ({
      available: true,
      apiVersion: 3,
      connectorAvailable: true,
    }),
    getZoteroTargets: async () => ({
      selectedTargetId: "C2",
      targets: [artifact.target, {
        ...artifact.target,
        id: "C3",
        path: ["我的文库", "产品", "AI前沿论文"],
      }],
    }),
    createZoteroProposal: async (runId, options) => {
      calls.proposal = { runId, options };
      return artifact;
    },
    getZoteroProposal: async () => artifact,
    startZoteroCommit: async (runId, approval) => {
      calls.commit = { runId, approval };
      return committingRun();
    },
  };
  const server = await startTestServer(workflow);
  t.after(server.close);

  const statusResponse = await fetch(`${server.baseUrl}/api/v1/zotero/status`);
  assert.equal(statusResponse.status, 200);
  assert.deepEqual(await statusResponse.json(), {
    schema_version: 1,
    available: true,
    api_version: 3,
    connector_available: true,
  });

  const targetsResponse = await fetch(`${server.baseUrl}/api/v1/zotero/targets`);
  assert.equal(targetsResponse.status, 200);
  assert.deepEqual(await targetsResponse.json(), {
    schema_version: 1,
    selected_target_id: "C2",
    targets: [{
      id: "C2",
      name: "AI前沿论文",
      library_id: 1,
      library_name: "我的文库",
      level: 2,
      path: ["我的文库", "研究", "AI前沿论文"],
      editable: true,
      files_editable: true,
    }, {
      id: "C3",
      name: "AI前沿论文",
      library_id: 1,
      library_name: "我的文库",
      level: 2,
      path: ["我的文库", "产品", "AI前沿论文"],
      editable: true,
      files_editable: true,
    }],
  });

  const proposalResponse = await fetch(
    `${server.baseUrl}/api/v1/journal-runs/journal-test/zotero/proposals`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: 1,
        decisions: [{ paper_id: "paper-1", decision: "collect" }],
        target_id: "C2",
      }),
    },
  );
  assert.equal(proposalResponse.status, 201);
  assert.deepEqual({ ...calls.proposal.options.decisions }, { "paper-1": "collect" });
  assert.equal(calls.proposal.options.targetId, "C2");
  const preview = await proposalResponse.json();
  assert.equal(preview.proposal_hash, "sha256:preview");
  assert.deepEqual(preview.target.path, ["我的文库", "研究", "AI前沿论文"]);
  assert.deepEqual(preview.proposals[0].preview_or_diff, artifact.proposals[0].preview_or_diff);
  assert.deepEqual(preview.proposals[0].guide.references, [{
    block_id: "block-1",
    path: ["Method", "Planning"],
    excerpt: "A bounded evidence excerpt.",
  }]);
  assert.deepEqual(preview.proposals[0].metadata, {
    item_type: "conferencePaper",
    title: "Paper 1",
    authors: ["Ada"],
    venue: "AAAI",
    date: "2026-07-23",
    published_at: "2026-07-23",
    doi: "10.1234/test",
    url: "https://example.com/paper",
    abstract: "A bounded abstract.",
    tags: ["Pi Agent"],
    extra: "Pi-Agent-Paper-ID: paper-1",
  });
  const previewJson = JSON.stringify(preview);
  assert.equal(previewJson.includes("artifact_path"), false);
  assert.equal(previewJson.includes("note_html"), false);
  assert.equal(previewJson.includes("connectorItemId"), false);
  assert.equal(previewJson.includes("/private/"), false);

  const restoredResponse = await fetch(
    `${server.baseUrl}/api/v1/journal-runs/journal-test/zotero/proposals`,
  );
  assert.equal(restoredResponse.status, 200);
  assert.equal((await restoredResponse.json()).proposal_id, "zotero-preview-1");

  const commitResponse = await fetch(
    `${server.baseUrl}/api/v1/journal-runs/journal-test/zotero/commit`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: 1,
        proposal_hash: "sha256:preview",
        operations: [{
          proposal_id: "zotero-paper-1",
          content_hash: "sha256:content",
          target_version_or_hash: "sha256:target",
        }],
      }),
    },
  );
  assert.equal(commitResponse.status, 202);
  assert.equal(calls.commit.approval.proposalHash, "sha256:preview");
  assert.deepEqual(calls.commit.approval.operations, [{
    proposal_id: "zotero-paper-1",
    content_hash: "sha256:content",
    target_version_or_hash: "sha256:target",
  }]);
  const committed = await commitResponse.json();
  const committedJson = JSON.stringify(committed);
  assert.equal(committed.zotero.status, "committing");
  assert.equal(committedJson.includes("artifact_path"), false);
  assert.equal(committedJson.includes("connectorSession"), false);
  assert.equal(committedJson.includes("connectorItemId"), false);
  assert.equal(committedJson.includes("/private/"), false);
});

test("Zotero HTTP failures use the workflow error envelope", async (t) => {
  const unavailable = Object.assign(new Error("无法连接本机 Zotero"), {
    code: "ZOTERO_UNAVAILABLE",
    status: 503,
    retryable: true,
  });
  const server = await startTestServer({
    getZoteroStatus: async () => {
      throw unavailable;
    },
  });
  t.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/v1/zotero/status`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: {
      code: "ZOTERO_UNAVAILABLE",
      message: "无法连接本机 Zotero",
      retryable: true,
    },
  });
});

test("publicRun excludes internal artifact paths and connector internals", () => {
  const result = publicRun(committingRun());
  const serialized = JSON.stringify(result);
  assert.equal(result.zotero.proposal_hash, "sha256:preview");
  assert.equal(result.zotero.proposals[0].content_hash, "sha256:content");
  assert.deepEqual(result.paper_decisions, { "paper-1": "read" });
  assert.equal(result.readings.papers["paper-1"].stages["research-question"].status, "ready");
  assert.equal(result.readings.papers["paper-1"].chat.turns[0].question, "这段是什么意思？");
  assert.equal(
    result.readings.papers["paper-1"].active_conversation_id,
    "reading-conversation-current",
  );
  assert.deepEqual(
    result.readings.papers["paper-1"].conversations.map((conversation) => conversation.id),
    ["reading-conversation-current", "reading-conversation-branch"],
  );
  assert.equal(result.readings.papers["paper-1"].chat.turns[0].cache_write_failed, true);
  assert.deepEqual(
    result.readings.papers["paper-1"].agent_actions.proposals[0],
    {
      proposal_id: "reading-note-1",
      turn_id: "chat-turn-1",
      status: "committed",
      content_hash: "sha256:agent-note",
      target_version_or_hash: "sha256:agent-target",
      committed_at: "2026-07-23T12:02:00.000Z",
      updated_at: "2026-07-23T12:02:00.000Z",
    },
  );
  assert.equal(result.obsidian.proposal_hash, "sha256:obsidian-preview");
  assert.equal(result.obsidian.proposals[0].target, "obsidian");
  assert.equal(result.project_state.proposal_hash, "sha256:project-preview");
  assert.equal(result.project_state.target_locator, "/Users/demo/project/PRODUCT_MEETING.md");
  assert.equal(result.guides.papers["paper-1"].input_hash, "sha256:guide-input");
  assert.equal(serialized.includes("artifact_path"), false);
  assert.equal(serialized.includes("artifact_json"), false);
  assert.equal(serialized.includes("artifact_markdown"), false);
  assert.equal(serialized.includes("connectorSession"), false);
  assert.equal(serialized.includes("connectorItemId"), false);
  assert.equal(serialized.includes("/private/"), false);
});

test("Obsidian HTTP preview returns exact Markdown without exposing Run artifact paths", async (t) => {
  let requestedRunId = null;
  const artifact = obsidianArtifact();
  const server = await startTestServer({
    createObsidianPreview: async (runId) => {
      requestedRunId = runId;
      return artifact;
    },
    getObsidianPreview: async (runId) => {
      requestedRunId = runId;
      return artifact;
    },
  });
  t.after(server.close);

  const response = await fetch(
    `${server.baseUrl}/api/v1/journal-runs/journal-test/obsidian/proposals`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: 1,
        target_path: "/tmp/caller-must-not-control.md",
      }),
    },
  );
  assert.equal(response.status, 201);
  assert.equal(requestedRunId, "journal-test");
  const preview = await response.json();
  assert.equal(preview.write_capability, "preview_only");
  assert.equal(preview.external_write_performed, false);
  assert.equal(preview.proposals[0].markdown, artifact.proposals[0].markdown);
  assert.equal(preview.proposals[0].target_details.file_name, "2026-Ada-Paper--abcd1234.md");
  const serialized = JSON.stringify(preview);
  assert.equal(serialized.includes("artifact_path"), false);
  assert.equal(serialized.includes("markdown_artifact_path"), false);
  assert.equal(serialized.includes("configured_directory"), false);
  assert.equal(serialized.includes("/private/"), false);
  assert.equal(serialized.includes("/tmp/caller-must-not-control.md"), false);

  requestedRunId = null;
  const restoredResponse = await fetch(
    `${server.baseUrl}/api/v1/journal-runs/journal-test/obsidian/proposals`,
  );
  assert.equal(restoredResponse.status, 200);
  assert.equal(requestedRunId, "journal-test");
  const restored = await restoredResponse.json();
  assert.equal(restored.proposal_hash, artifact.proposal_hash);
  assert.equal(restored.proposals[0].markdown, artifact.proposals[0].markdown);
});

test("project-state HTTP preview returns exact append content without exposing Run artifact paths", async (t) => {
  let requestedRunId = null;
  const artifact = projectStateArtifact();
  const server = await startTestServer({
    createProjectStatePreview: async (runId) => {
      requestedRunId = runId;
      return artifact;
    },
    getProjectStatePreview: async (runId) => {
      requestedRunId = runId;
      return artifact;
    },
  });
  t.after(server.close);

  const response = await fetch(
    `${server.baseUrl}/api/v1/journal-runs/journal-test/project-state/proposals`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: 1,
        target_path: "/tmp/caller-must-not-control.md",
      }),
    },
  );
  assert.equal(response.status, 201);
  assert.equal(requestedRunId, "journal-test");
  const preview = await response.json();
  assert.equal(preview.write_capability, "preview_only");
  assert.equal(preview.external_write_performed, false);
  assert.equal(preview.proposal.markdown, artifact.proposal.markdown);
  assert.equal(preview.proposal.diff.append_text, artifact.proposal.diff.append_text);
  assert.equal(preview.proposal.target_details.source_path, "PRODUCT_MEETING.md");
  const serialized = JSON.stringify(preview);
  assert.equal(serialized.includes("artifact_path"), false);
  assert.equal(serialized.includes("markdown_artifact_path"), false);
  assert.equal(serialized.includes("project_root"), false);
  assert.equal(serialized.includes("/private/"), false);
  assert.equal(serialized.includes("/tmp/caller-must-not-control.md"), false);

  requestedRunId = null;
  const restoredResponse = await fetch(
    `${server.baseUrl}/api/v1/journal-runs/journal-test/project-state/proposals`,
  );
  assert.equal(restoredResponse.status, 200);
  assert.equal(requestedRunId, "journal-test");
  const restored = await restoredResponse.json();
  assert.equal(restored.proposal_hash, artifact.proposal_hash);
  assert.equal(restored.proposal.markdown, artifact.proposal.markdown);
  assert.equal(restored.proposal.diff.append_text, artifact.proposal.diff.append_text);
});

test("reading HTTP routes preserve request fields and return durable stage state", async (t) => {
  let chatFailure = null;
  const calls = {
    decisions: null,
    stage: null,
    question: null,
    chat: null,
    noteCreate: null,
    noteCommit: null,
    noteAbandon: null,
    noteGet: null,
    position: null,
    restart: null,
  };
  const reading = {
    schema_version: 1,
    run_id: "journal-test",
    paper_id: "paper-1",
    status: "reading",
    document_revision: "sha256:document",
    current_stage: "research-question",
    position: { mode: "focused", block_id: "block-1", updated_at: null },
    stage_order: ["research-question", "method", "evidence", "project-relation"],
    stages: {
      "research-question": {
        status: "ready",
        result: {
          answer: "阶段解释",
          evidence: [{
            block_id: "block-1",
            path: ["Introduction"],
            ordinal: 1,
            excerpt: "Evidence.",
            support: "支持问题判断。",
          }],
          open_questions: [],
        },
      },
    },
    questions: [],
    chat: {
      status: "ready",
      turns: [{
        id: "chat-turn-1",
        client_request_id: "client-chat-1",
        question: "这部分是什么意思？",
        status: "answered",
        reference: {
          block_id: "block-1",
          path: ["Introduction"],
          ordinal: 1,
          start_offset: 0,
          end_offset: 8,
          quote: "Evidence",
          source_hash: "sha256:quote",
        },
        answer: "这是证据。",
        citations: [],
        provider_id: "codex-subscription",
        model_id: "account-default",
        prompt_version: "reading-chat.v1",
        input_hash: "sha256:chat",
        usage: null,
        cache_hit: false,
        project_context_revision: null,
        error: null,
        created_at: "2026-07-23T09:00:00.000Z",
        answered_at: "2026-07-23T09:00:01.000Z",
      }],
      updated_at: "2026-07-23T09:00:01.000Z",
    },
  };
  const workflow = {
    getProjectContext: async () => ({
      source_path: "project_state.md",
      revision: "sha256:project-context",
      byte_length: 512,
      content: "must-not-leak",
      state: {
        title: "Pi Agent 项目状态",
        goal: "验证首个真实工作流",
        decisions: ["工作流推进项目"],
        open_questions: ["真实质量如何？"],
        next_action: "完成真实试跑",
        next_actions: ["完成真实试跑"],
        missing_sections: [],
      },
    }),
    savePaperDecisions: async (runId, decisions) => {
      calls.decisions = { runId, decisions: { ...decisions } };
      return committingRun();
    },
    getPaperReading: async () => reading,
    generateReadingStage: async (runId, paperId, stage, options) => {
      calls.stage = { runId, paperId, stage, options };
      return reading;
    },
    askReadingQuestion: async (runId, paperId, options) => {
      calls.question = { runId, paperId, options };
      return reading;
    },
    sendReadingChatMessage: async (runId, paperId, options) => {
      if (chatFailure) throw chatFailure;
      calls.chat = { runId, paperId, options };
      return reading;
    },
    createReadingNoteProposal: async (runId, paperId, turnId, options) => {
      calls.noteCreate = { runId, paperId, turnId, options };
      return reading;
    },
    commitReadingNoteProposal: async (runId, paperId, proposalId, options) => {
      calls.noteCommit = { runId, paperId, proposalId, options };
      return reading;
    },
    abandonReadingNoteProposal: async (runId, paperId, proposalId, options) => {
      calls.noteAbandon = { runId, paperId, proposalId, options };
      return reading;
    },
    getReadingNoteProposal: async (runId, paperId, proposalId) => {
      calls.noteGet = { runId, paperId, proposalId };
      return {
        proposal: {
          schema_version: 1,
          proposal_id: proposalId,
          target_locator: "/Vault/Paper.md",
          status: "draft",
        },
        reading,
      };
    },
    saveReadingPosition: async (runId, paperId, options) => {
      calls.position = { runId, paperId, options };
      return committingRun();
    },
    restartReadingFromGuide: async (runId) => {
      calls.restart = { runId };
      return committingRun();
    },
  };
  const server = await startTestServer(workflow);
  t.after(server.close);

  const projectContextResponse = await fetch(`${server.baseUrl}/api/v1/project-context`);
  assert.equal(projectContextResponse.status, 200);
  const projectContext = await projectContextResponse.json();
  assert.equal(projectContext.source_path, "project_state.md");
  assert.equal(projectContext.state.goal, "验证首个真实工作流");
  assert.equal(JSON.stringify(projectContext).includes("must-not-leak"), false);

  const decisionResponse = await fetch(
    `${server.baseUrl}/api/v1/journal-runs/journal-test/paper-decisions`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: 1,
        decisions: [{ paper_id: "paper-1", decision: "read" }],
      }),
    },
  );
  assert.equal(decisionResponse.status, 200);
  assert.deepEqual(calls.decisions.decisions, { "paper-1": "read" });

  const restartResponse = await fetch(
    `${server.baseUrl}/api/v1/journal-runs/journal-test/reading/restart`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: 1,
        from_step: "guide",
      }),
    },
  );
  assert.equal(restartResponse.status, 200);
  assert.deepEqual(calls.restart, { runId: "journal-test" });

  const readingResponse = await fetch(
    `${server.baseUrl}/api/v1/journal-runs/journal-test/papers/paper-1/reading`,
  );
  assert.equal(readingResponse.status, 200);
  assert.equal((await readingResponse.json()).stages["research-question"].status, "ready");

  const stageResponse = await fetch(
    `${server.baseUrl}/api/v1/journal-runs/journal-test/papers/paper-1/reading/stages/research-question`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: 1,
        provider_id: "codex-subscription",
        model_id: "account-default",
      }),
    },
  );
  assert.equal(stageResponse.status, 201);
  assert.deepEqual(calls.stage, {
    runId: "journal-test",
    paperId: "paper-1",
    stage: "research-question",
    options: {
      providerId: "codex-subscription",
      modelId: "account-default",
    },
  });

  const questionResponse = await fetch(
    `${server.baseUrl}/api/v1/journal-runs/journal-test/papers/paper-1/reading/questions`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: 1,
        stage: "research-question",
        text: "核心矛盾是什么？",
        block_id: "block-1",
        client_request_id: "client-1",
        provider_id: "codex-subscription",
        model_id: "account-default",
      }),
    },
  );
  assert.equal(questionResponse.status, 201);
  assert.equal(calls.question.options.blockId, "block-1");
  assert.equal(calls.question.options.clientRequestId, "client-1");

  const chatResponse = await fetch(
    `${server.baseUrl}/api/v1/journal-runs/journal-test/papers/paper-1/reading/chat/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: 1,
        client_request_id: "client-chat-1",
        text: "这部分是什么意思？",
        reference: {
          document_revision: "sha256:document",
          block_id: "block-1",
          start_offset: 0,
          end_offset: 8,
        },
        include_project_context: true,
        provider_id: "deepseek",
        model_id: "deepseek-v4-flash",
      }),
    },
  );
  assert.equal(chatResponse.status, 201);
  assert.deepEqual(calls.chat, {
    runId: "journal-test",
    paperId: "paper-1",
    options: {
      text: "这部分是什么意思？",
      reference: {
        document_revision: "sha256:document",
        block_id: "block-1",
        start_offset: 0,
        end_offset: 8,
      },
      clientRequestId: "client-chat-1",
      includeProjectContext: true,
      providerId: "deepseek",
      modelId: "deepseek-v4-flash",
    },
  });

  calls.chat = null;
  const missingChatRequestId = await fetch(
    `${server.baseUrl}/api/v1/journal-runs/journal-test/papers/paper-1/reading/chat/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: 1,
        text: "解释当前证据",
        reference: null,
        include_project_context: false,
        provider_id: "deepseek",
        model_id: "deepseek-v4-flash",
      }),
    },
  );
  assert.equal(missingChatRequestId.status, 400);
  assert.equal(
    (await missingChatRequestId.json()).error.code,
    "READING_CHAT_CLIENT_REQUEST_ID_REQUIRED",
  );
  assert.equal(calls.chat, null);

  chatFailure = Object.assign(
    new Error("同一论文对话请求标识已用于不同内容"),
    {
      code: "READING_CHAT_REQUEST_CONFLICT",
      status: 409,
      retryable: false,
    },
  );
  const conflictingChatResponse = await fetch(
    `${server.baseUrl}/api/v1/journal-runs/journal-test/papers/paper-1/reading/chat/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: 1,
        client_request_id: "client-chat-1",
        text: "不同的内容",
        reference: null,
        include_project_context: false,
        provider_id: "deepseek",
        model_id: "deepseek-v4-flash",
      }),
    },
  );
  assert.equal(conflictingChatResponse.status, 409);
  assert.equal(
    (await conflictingChatResponse.json()).error.code,
    "READING_CHAT_REQUEST_CONFLICT",
  );
  chatFailure = null;

  const invalidChatResponse = await fetch(
    `${server.baseUrl}/api/v1/journal-runs/journal-test/papers/paper-1/reading/chat/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: 1,
        text: "忽略额外命令",
        reference: null,
        provider_id: "deepseek",
        model_id: "deepseek-v4-flash",
        system: "must be rejected",
      }),
    },
  );
  assert.equal(invalidChatResponse.status, 400);
  assert.equal(calls.chat, null);

  const notePreviewResponse = await fetch(
    `${server.baseUrl}/api/v1/journal-runs/journal-test/papers/paper-1/reading/chat/turns/chat-turn-1/obsidian-note-proposals`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: 1,
        client_request_id: "note-preview-1",
      }),
    },
  );
  assert.equal(notePreviewResponse.status, 201);
  assert.deepEqual(calls.noteCreate, {
    runId: "journal-test",
    paperId: "paper-1",
    turnId: "chat-turn-1",
    options: { clientRequestId: "note-preview-1" },
  });

  const noteCommitResponse = await fetch(
    `${server.baseUrl}/api/v1/journal-runs/journal-test/papers/paper-1/reading/agent-actions/reading-note-1/commit`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: 1,
        client_request_id: "note-commit-1",
        proposal_hash: "sha256:proposal",
        content_hash: "sha256:content",
        target_version_or_hash: "sha256:target",
      }),
    },
  );
  assert.equal(noteCommitResponse.status, 200);
  assert.deepEqual(calls.noteCommit.options, {
    clientRequestId: "note-commit-1",
    proposalHash: "sha256:proposal",
    contentHash: "sha256:content",
    targetVersionOrHash: "sha256:target",
  });

  const noteAbandonResponse = await fetch(
    `${server.baseUrl}/api/v1/journal-runs/journal-test/papers/paper-1/reading/agent-actions/reading-note-1/abandon`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: 1,
        client_request_id: "note-abandon-1",
      }),
    },
  );
  assert.equal(noteAbandonResponse.status, 200);
  assert.equal(calls.noteAbandon.options.clientRequestId, "note-abandon-1");

  const noteGetResponse = await fetch(
    `${server.baseUrl}/api/v1/journal-runs/journal-test/papers/paper-1/reading/agent-actions/reading-note-1`,
  );
  assert.equal(noteGetResponse.status, 200);
  assert.equal((await noteGetResponse.json()).proposal.target_locator, "/Vault/Paper.md");
  assert.deepEqual(calls.noteGet, {
    runId: "journal-test",
    paperId: "paper-1",
    proposalId: "reading-note-1",
  });

  const invalidNoteCommit = await fetch(
    `${server.baseUrl}/api/v1/journal-runs/journal-test/papers/paper-1/reading/agent-actions/reading-note-1/commit`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: 1,
        client_request_id: "note-commit-invalid",
        proposal_hash: "sha256:proposal",
        content_hash: "sha256:content",
        target_version_or_hash: "sha256:target",
        target_path: "/tmp/must-not-be-accepted.md",
      }),
    },
  );
  assert.equal(invalidNoteCommit.status, 400);

  const positionResponse = await fetch(
    `${server.baseUrl}/api/v1/journal-runs/journal-test/papers/paper-1/reading/position`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: 1,
        mode: "focused",
        block_id: "block-1",
      }),
    },
  );
  assert.equal(positionResponse.status, 200);
  assert.deepEqual(calls.position.options, { mode: "focused", blockId: "block-1" });
});

test("translation routes use the server-owned profile and expose an idempotent pause action", async (t) => {
  const calls = [];
  const translation = {
    schema_version: 1,
    run_id: "journal-test",
    paper_id: "paper-1",
    document_revision: "sha256:document",
    status: "running",
    provider_id: "codex-subscription",
    model_id: "gpt-5.3-codex-spark",
    reasoning_effort: "low",
    prompt_id: "translation",
    prompt_version: "translation.v1",
    total_blocks: 10,
    translated_blocks: 2,
    blocks: {},
    error: null,
    updated_at: "2026-07-26T00:00:00.000Z",
  };
  const workflow = {
    getPaperTranslation: async (runId, paperId) => {
      calls.push({ action: "get", runId, paperId });
      return translation;
    },
    generatePaperTranslation: async (runId, paperId) => {
      calls.push({ action: "start", runId, paperId });
      return translation;
    },
    pausePaperTranslation: async (runId, paperId) => {
      calls.push({ action: "pause", runId, paperId });
      return { ...translation, status: "pausing" };
    },
  };
  const server = await startTestServer(workflow);
  t.after(server.close);
  const endpoint = `${server.baseUrl}/api/v1/journal-runs/journal-test/papers/paper-1/translation`;

  const startResponse = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schema_version: 1,
      provider_id: "deepseek",
      model_id: "deepseek-v4-pro",
    }),
  });
  assert.equal(startResponse.status, 202);
  assert.equal((await startResponse.json()).model_id, "gpt-5.3-codex-spark");
  assert.deepEqual(calls[0], {
    action: "start",
    runId: "journal-test",
    paperId: "paper-1",
  });

  const pauseResponse = await fetch(`${endpoint}/pause`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ schema_version: 1 }),
  });
  assert.equal(pauseResponse.status, 200);
  assert.equal((await pauseResponse.json()).status, "pausing");
  assert.deepEqual(calls[1], {
    action: "pause",
    runId: "journal-test",
    paperId: "paper-1",
  });
});
