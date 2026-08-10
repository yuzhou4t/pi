import assert from "node:assert/strict";
import test from "node:test";
import { createApiServer, publicRun, shutdownApiServer } from "./index.js";
import { projectWorkError } from "./project-work/errors.js";

const candidateSummaryService = {
  config: {
    mode: "fixture",
    defaultProviderId: "codex-subscription",
  },
  listProviders: async () => ({ providers: [] }),
  summarize: async () => ({ schema_version: 1, summaries: [] }),
};

test("API shutdown waits for disposal but bounds long-lived connections", async () => {
  let closeCallback;
  let idleClosed = 0;
  let forcedClosed = 0;
  let exits = 0;
  const done = shutdownApiServer({
    server: {
      close(callback) {
        closeCallback = callback;
      },
      closeIdleConnections() {
        idleClosed += 1;
      },
      closeAllConnections() {
        forcedClosed += 1;
      },
    },
    dispose: async () => undefined,
    timeoutMs: 5,
    unrefTimeout: false,
    onExit() {
      exits += 1;
    },
  });

  await done;
  assert.equal(typeof closeCallback, "function");
  assert.equal(idleClosed, 1);
  assert.equal(forcedClosed, 1);
  assert.equal(exits, 1);
});

test("API shutdown exits normally after server close and disposal", async () => {
  let forcedClosed = 0;
  let disposed = 0;
  let exits = 0;
  await shutdownApiServer({
    server: {
      close(callback) {
        callback();
      },
      closeIdleConnections() {},
      closeAllConnections() {
        forcedClosed += 1;
      },
    },
    dispose: async () => {
      disposed += 1;
    },
    timeoutMs: 50,
    unrefTimeout: false,
    onExit() {
      exits += 1;
    },
  });

  assert.equal(disposed, 1);
  assert.equal(forcedClosed, 0);
  assert.equal(exits, 1);
});

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
    write_capability: "hash_bound_commit",
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
    write_capability: "hash_bound_commit",
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
  {
    allowMissingJournalMutationOrigin = true,
    projectWorkRuntimeUrl,
    projectWorkRuntimeHealthProbe,
    legacyWorkspaceArchiveService,
    searchUsageService,
  } = {},
) {
  const server = createApiServer({
    candidateSummaryService: summaryService,
    journalWorkflowService,
    projectWorkService,
    allowMissingJournalMutationOrigin,
    projectWorkRuntimeUrl,
    projectWorkRuntimeHealthProbe,
    legacyWorkspaceArchiveService,
    searchUsageService,
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

function modelUsageReport(workflowScope, {
  totalTokens,
  apiEquivalentCostUsd,
} = {}) {
  const paperReading = workflowScope === "paper_reading";
  return {
    workflowScope,
    periodStart: "2026-06-28T00:00:00.000Z",
    periodEnd: "2026-07-28T00:00:00.000Z",
    totals: {
      calls: 1,
      tasks: 1,
      conversations: 1,
      inputTokens: totalTokens - 5,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens,
      apiEquivalentCostUsd,
      pricedCallCount: 1,
      unpricedCallCount: 0,
      historicalBackfilledCallCount: paperReading ? 1 : 0,
    },
    coverage: {
      includedKinds: [paperReading ? "paper_agent" : "assistant_model_response"],
      excludedKinds: [],
      historicalLowerBound: paperReading,
    },
    models: [{
      providerId: paperReading ? "deepseek" : "openai-codex",
      modelId: paperReading ? "deepseek-v4-pro" : "gpt-5.6-sol",
      totalTokens,
    }],
  };
}

test("gateway health exposes worker reachability and recovery state", async (t) => {
  let reachable = false;
  const server = await startTestServer(
    {},
    candidateSummaryService,
    null,
    {
      projectWorkRuntimeUrl: "http://127.0.0.1:47920",
      projectWorkRuntimeHealthProbe: async () => (
        reachable
          ? {
              reachable: true,
              runtimeRole: "worker",
              runtimeSchemaVersion: 1,
            }
          : {
              reachable: false,
              runtimeRole: null,
              runtimeSchemaVersion: null,
            }
      ),
    },
  );
  t.after(server.close);

  const recovering = await (
    await fetch(`${server.baseUrl}/api/v1/health`)
  ).json();
  assert.equal(recovering.status, "degraded");
  assert.equal(recovering.project_work, "recovering");
  assert.equal(recovering.runtime_reachable, false);
  assert.equal(recovering.runtime_worker_schema_version, null);

  reachable = true;
  const available = await (
    await fetch(`${server.baseUrl}/api/v1/health`)
  ).json();
  assert.equal(available.status, "ok");
  assert.equal(available.project_work, "available");
  assert.equal(available.runtime_reachable, true);
  assert.equal(available.runtime_worker_role, "worker");
  assert.equal(available.runtime_worker_schema_version, 1);
});

test("model usage all merges normal work and paper reading", async (t) => {
  const calls = [];
  const projectWorkService = {
    async getUsage(options) {
      calls.push({ workflow: "project_work", options });
      return modelUsageReport("project_work", {
        totalTokens: 15,
        apiEquivalentCostUsd: 0.125,
      });
    },
  };
  const journalWorkflowService = {
    async getUsage(options) {
      calls.push({ workflow: "paper_reading", options });
      return modelUsageReport("paper_reading", {
        totalTokens: 25,
        apiEquivalentCostUsd: 0.25,
      });
    },
  };
  const server = await startTestServer(
    journalWorkflowService,
    candidateSummaryService,
    projectWorkService,
  );
  t.after(server.close);

  const response = await fetch(
    `${server.baseUrl}/api/v1/model-usage?period=7d&workflow=all`,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "ready");
  assert.equal(body.workflowScope, "all");
  assert.equal(body.period, "7d");
  assert.equal(body.totals.calls, 2);
  assert.equal(body.totals.tasks, 2);
  assert.equal(body.totals.totalTokens, 40);
  assert.equal(body.totals.apiEquivalentCostUsd, 0.375);
  assert.deepEqual(
    body.workflows.map((item) => item.workflowScope),
    ["project_work", "paper_reading"],
  );
  assert.deepEqual(
    body.models.map((item) => item.workflowScope),
    ["project_work", "paper_reading"],
  );
  assert.deepEqual(calls, [
    { workflow: "project_work", options: { period: "7d" } },
    { workflow: "paper_reading", options: { period: "7d" } },
  ]);
});

test("search usage route returns provider hard-limit evidence", async (t) => {
  const server = await startTestServer(
    {},
    candidateSummaryService,
    {},
    {
      searchUsageService: {
        async getUsage() {
          return {
            schema_version: 1,
            period: "2026-08",
            generated_at: "2026-08-11T00:00:00.000Z",
            providers: [{
              provider_id: "doubao",
              provider_name: "豆包",
              configured: true,
              hard_limit: true,
              source: "local_hard_ledger",
              period: "2026-08",
              limit: 500,
              used: 8,
              remaining: 492,
            }],
          };
        },
      },
    },
  );
  t.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/v1/search-usage`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.providers[0].used, 8);
  assert.equal(body.providers[0].remaining, 492);
  assert.equal(body.providers[0].hard_limit, true);
});

test("legacy workspace archive routes expose safe totals and require a local exact cleanup", async (t) => {
  const archiveHash = `sha256:${"a".repeat(64)}`;
  const mutationOrigin = `sha256:${"b".repeat(64)}`;
  const calls = [];
  const summary = {
    schemaVersion: 1,
    totalBytes: 1024,
    totalFileCount: 2,
    itemCount: 1,
    cleanupEligibleCount: 1,
    mutationOrigin,
    items: [{
      conversationId: "conversation-archive",
      title: "旧验证",
      parts: ["base", "workspace"],
      archiveHash,
      bytes: 1024,
      fileCount: 2,
      cleanupEligible: true,
      blockedReason: null,
    }],
  };
  const legacyWorkspaceArchiveService = {
    async getSummary() {
      return summary;
    },
    async cleanup(value) {
      calls.push(value);
      return { ...summary, totalBytes: 0, itemCount: 0, items: [] };
    },
  };
  const server = await startTestServer(
    {},
    candidateSummaryService,
    {},
    { legacyWorkspaceArchiveService },
  );
  t.after(server.close);

  const listed = await fetch(
    `${server.baseUrl}/api/v1/project-work/legacy-workspace-archives`,
  );
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).items[0].conversationId, "conversation-archive");

  const rejected = await fetch(
    `${server.baseUrl}/api/v1/project-work/legacy-workspace-archives/cleanup`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schema_version: 1, mutation_origin: mutationOrigin, items: [] }),
    },
  );
  assert.equal(rejected.status, 403);
  assert.equal(calls.length, 0);

  const cleaned = await fetch(
    `${server.baseUrl}/api/v1/project-work/legacy-workspace-archives/cleanup`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://127.0.0.1:4173",
      },
      body: JSON.stringify({
        schema_version: 1,
        mutation_origin: mutationOrigin,
        items: [{
          conversation_id: "conversation-archive",
          archive_hash: archiveHash,
          bytes: 1024,
        }],
      }),
    },
  );
  assert.equal(cleaned.status, 200);
  assert.equal((await cleaned.json()).itemCount, 0);
  assert.deepEqual(calls, [{
    mutationOrigin,
    items: [{
      conversationId: "conversation-archive",
      archiveHash,
      bytes: 1024,
    }],
  }]);
});

test("model usage workflow filter calls only the selected workflow", async (t) => {
  const calls = [];
  const projectWorkService = {
    async getUsage(options) {
      calls.push({ workflow: "project_work", options });
      return modelUsageReport("project_work", {
        totalTokens: 15,
        apiEquivalentCostUsd: 0.125,
      });
    },
  };
  const journalWorkflowService = {
    async getUsage(options) {
      calls.push({ workflow: "paper_reading", options });
      return modelUsageReport("paper_reading", {
        totalTokens: 25,
        apiEquivalentCostUsd: 0.25,
      });
    },
  };
  const server = await startTestServer(
    journalWorkflowService,
    candidateSummaryService,
    projectWorkService,
  );
  t.after(server.close);

  const projectResponse = await fetch(
    `${server.baseUrl}/api/v1/model-usage?period=today&workflow=project_work`,
  );
  assert.equal(projectResponse.status, 200);
  const projectBody = await projectResponse.json();
  assert.equal(projectBody.status, "ready");
  assert.equal(projectBody.workflowScope, "project_work");
  assert.equal(projectBody.totals.totalTokens, 15);
  assert.deepEqual(
    projectBody.models.map((item) => item.workflowScope),
    ["project_work"],
  );

  const paperResponse = await fetch(
    `${server.baseUrl}/api/v1/model-usage?period=all&workflow=paper_reading`,
  );
  assert.equal(paperResponse.status, 200);
  const paperBody = await paperResponse.json();
  assert.equal(paperBody.status, "ready");
  assert.equal(paperBody.workflowScope, "paper_reading");
  assert.equal(paperBody.totals.totalTokens, 25);
  assert.deepEqual(
    paperBody.models.map((item) => item.workflowScope),
    ["paper_reading"],
  );

  assert.deepEqual(calls, [
    { workflow: "project_work", options: { period: "today" } },
    { workflow: "paper_reading", options: { period: "all" } },
  ]);
});

test("model usage returns partial data when one workflow is unavailable", async (t) => {
  const projectWorkService = {
    async getUsage() {
      throw new Error("project usage unavailable");
    },
  };
  const journalWorkflowService = {
    async getUsage() {
      return modelUsageReport("paper_reading", {
        totalTokens: 25,
        apiEquivalentCostUsd: 0.25,
      });
    },
  };
  const server = await startTestServer(
    journalWorkflowService,
    candidateSummaryService,
    projectWorkService,
  );
  t.after(server.close);

  const response = await fetch(
    `${server.baseUrl}/api/v1/model-usage?period=30d&workflow=all`,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "partial");
  assert.equal(body.totals.calls, 1);
  assert.equal(body.totals.totalTokens, 25);
  assert.deepEqual(
    body.workflows.map((item) => item.workflowScope),
    ["paper_reading"],
  );
  assert.deepEqual(body.coverage.accessIssues, [{
    workflowScope: "project_work",
    code: "PROJECT_WORK_USAGE_UNAVAILABLE",
    message: "正常工作用量暂时无法读取",
  }]);
});

test("settings routes preserve provider-secret and Skill review boundaries", async (t) => {
  const calls = [];
  const projectWorkService = {
    async listProviderConnections() {
      calls.push({ action: "listProviders" });
      return {
        schemaVersion: 1,
        providers: [{
          id: "deepseek",
          name: "DeepSeek",
          apiKeySupported: true,
          configured: true,
          stored: true,
          availableModelCount: 2,
        }],
      };
    },
    async saveProviderApiKey(payload) {
      calls.push({ action: "saveProvider", ...payload });
      return this.listProviderConnections();
    },
    async removeProviderCredential(providerId) {
      calls.push({ action: "removeProvider", providerId });
      return {
        schemaVersion: 1,
        providers: [{
          id: providerId,
          name: "DeepSeek",
          apiKeySupported: true,
          configured: false,
          stored: false,
          availableModelCount: 0,
        }],
      };
    },
    async listSkillCatalog(options) {
      calls.push({ action: "listSkills", options });
      return {
        schemaVersion: 1,
        source: "pi.dev",
        packages: [{
          name: "demo-skill",
          version: "1.2.3",
          types: ["skill"],
          installSupported: true,
        }],
      };
    },
    async listInstalledSkills() {
      calls.push({ action: "listInstalled" });
      return { schemaVersion: 1, revision: 0, packages: [] };
    },
    async inspectSkillPackage(payload) {
      calls.push({ action: "inspectSkill", ...payload });
      return {
        schemaVersion: 1,
        previewId: "skill-preview-1",
        previewHash: `sha256:${"a".repeat(64)}`,
        name: payload.name,
        version: payload.version,
        defaultEnabled: false,
      };
    },
    async installSkillPackage(payload) {
      calls.push({ action: "installSkill", ...payload });
      return {
        name: "demo-skill",
        version: "1.2.3",
        enabled: false,
      };
    },
    async setSkillPackageEnabled(payload) {
      calls.push({ action: "enableSkill", ...payload });
      return {
        name: payload.name,
        version: "1.2.3",
        enabled: payload.enabled,
      };
    },
  };
  const server = await startTestServer(
    {},
    candidateSummaryService,
    projectWorkService,
  );
  t.after(server.close);
  const mutationHeaders = {
    origin: "http://127.0.0.1:4173",
    "content-type": "application/json",
  };

  const saved = await fetch(
    `${server.baseUrl}/api/v1/project-work/provider-connections/deepseek`,
    {
      method: "PUT",
      headers: mutationHeaders,
      body: JSON.stringify({ api_key: "secret-api-key" }),
    },
  );
  assert.equal(saved.status, 200);
  assert.doesNotMatch(await saved.text(), /secret-api-key/);

  const removed = await fetch(
    `${server.baseUrl}/api/v1/project-work/provider-connections/deepseek`,
    { method: "DELETE", headers: mutationHeaders },
  );
  assert.equal(removed.status, 200);

  const catalog = await fetch(
    `${server.baseUrl}/api/v1/project-work/skills?query=demo&sort=recent`,
  );
  assert.equal(catalog.status, 200);
  assert.equal((await catalog.json()).source, "pi.dev");

  const preview = await fetch(
    `${server.baseUrl}/api/v1/project-work/skill-previews`,
    {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({ name: "demo-skill", version: "1.2.3" }),
    },
  );
  const previewPayload = await preview.json();
  assert.equal(previewPayload.defaultEnabled, false);

  const installed = await fetch(
    `${server.baseUrl}/api/v1/project-work/skills`,
    {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({
        preview_id: previewPayload.previewId,
        preview_hash: previewPayload.previewHash,
      }),
    },
  );
  assert.equal(installed.status, 201);
  assert.equal((await installed.json()).enabled, false);

  const enabled = await fetch(
    `${server.baseUrl}/api/v1/project-work/skills/demo-skill`,
    {
      method: "PATCH",
      headers: mutationHeaders,
      body: JSON.stringify({ enabled: true }),
    },
  );
  assert.equal(enabled.status, 200);
  assert.equal((await enabled.json()).enabled, true);

  assert.deepEqual(
    calls.find((call) => call.action === "saveProvider"),
    {
      action: "saveProvider",
      providerId: "deepseek",
      apiKey: "secret-api-key",
    },
  );
  assert.deepEqual(
    calls.find((call) => call.action === "listSkills").options,
    { query: "demo", sort: "recent" },
  );
  assert.equal(
    calls.find((call) => call.action === "installSkill").previewHash,
    `sha256:${"a".repeat(64)}`,
  );
});

test("project-work Workspace routes bind HEAD and conversation selection", async (t) => {
  const calls = [];
  const workspace = {
    id: "workspace-secondary",
    projectId: "project-route",
    label: "pi/route-test",
    kind: "git_worktree",
    isMain: false,
    isGit: true,
    branch: "pi/route-test",
    head: "b".repeat(40),
    dirty: false,
    status: "available",
    conversationCount: 0,
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
  const projectWorkService = {
    async listWorkspaces(projectId) {
      calls.push({ action: "list", projectId });
      return [workspace];
    },
    async createWorkspace(projectId, options) {
      calls.push({ action: "create", projectId, options });
      return workspace;
    },
    async removeWorkspace(projectId, workspaceId, options) {
      calls.push({ action: "remove", projectId, workspaceId, options });
      return { ...workspace, removed: true };
    },
    async createConversation(projectId, options) {
      calls.push({ action: "conversation", projectId, options });
      return {
        id: "conversation-route",
        projectId,
        workspaceKind: "bound_project",
        workspace,
        title: "新工作会话",
        status: "idle",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      };
    },
  };
  const server = await startTestServer(
    {},
    candidateSummaryService,
    projectWorkService,
  );
  t.after(server.close);
  const endpoint = `${server.baseUrl}/api/v1/project-work/projects/project-route/workspaces`;
  const headers = {
    origin: "http://127.0.0.1:4173",
    "content-type": "application/json",
  };

  const listed = await fetch(endpoint);
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).workspaces[0].id, workspace.id);

  const created = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      schema_version: 1,
      source_workspace_id: "workspace-main",
      expected_head: "a".repeat(40),
      title: "Route test",
    }),
  });
  assert.equal(created.status, 201);

  const removed = await fetch(`${endpoint}/${workspace.id}`, {
    method: "DELETE",
    headers,
    body: JSON.stringify({
      schema_version: 1,
      expected_head: workspace.head,
    }),
  });
  assert.equal(removed.status, 200);
  assert.equal((await removed.json()).removed, true);

  const conversation = await fetch(
    `${server.baseUrl}/api/v1/project-work/projects/project-route/conversations`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        schema_version: 1,
        workspace_id: workspace.id,
      }),
    },
  );
  assert.equal(conversation.status, 201);
  assert.equal((await conversation.json()).workspace.id, workspace.id);
  assert.deepEqual(calls, [{
    action: "list",
    projectId: "project-route",
  }, {
    action: "create",
    projectId: "project-route",
    options: {
      sourceWorkspaceId: "workspace-main",
      expectedHead: "a".repeat(40),
      branchName: null,
      title: "Route test",
      label: null,
    },
  }, {
    action: "remove",
    projectId: "project-route",
    workspaceId: workspace.id,
    options: { expectedHead: workspace.head },
  }, {
    action: "conversation",
    projectId: "project-route",
    options: {
      title: undefined,
      providerId: undefined,
      modelId: undefined,
      thinkingLevel: undefined,
      executionPolicyMode: undefined,
      workspaceId: workspace.id,
    },
  }]);
});

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
    runtime_schema_version: 1,
    lifecycle: "idle",
    id: "conversation-standalone",
    projectId: null,
    workType: "project_work",
    workerId: null,
    sourceProjectId: null,
    sourceProjectLabel: null,
    workspaceKind: "scratch",
    runtimeProfile: null,
    legacyMigration: null,
    scope: "standalone",
    rootLabel: "未连接文件夹",
    title: "独立任务",
    status: "idle",
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
    thinkingLevel: "medium",
    pendingChangeFileCount: 0,
    unreadCount: 0,
    latestMessageSeq: 0,
    lastReadMessageSeq: 0,
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
      options: {
        directory: "notes",
        depth: 2,
        query: "",
        cursor: undefined,
        limit: undefined,
      },
    },
    { action: "delete", conversationId: "conversation-standalone" },
  ]);
});

test("project-work creation applies only an explicit valid auto-review default", async (t) => {
  const calls = [];
  const conversation = (id, projectId, mode = "manual_review") => ({
    id,
    projectId,
    workspaceKind: projectId === null ? "scratch" : "bound_project",
    scope: projectId === null ? "standalone" : "project",
    rootLabel: projectId === null ? "未连接文件夹" : "测试项目",
    title: "新工作会话",
    status: "idle",
    providerId: "deepseek",
    modelId: "deepseek-v4-pro",
    thinkingLevel: "medium",
    executionPolicy: {
      mode,
      revision: 1,
      policyVersion: 1,
    },
    pendingChangeFileCount: 0,
    unreadCount: 0,
    latestMessageSeq: 0,
    lastReadMessageSeq: 0,
    lastEventSeq: 0,
  });
  const projectWorkService = {
    createStandaloneConversation: async (options) => {
      calls.push({ action: "create-standalone", options });
      return conversation(
        "conversation-auto-standalone",
        null,
        options.executionPolicyMode,
      );
    },
    createConversation: async (projectId, options) => {
      calls.push({ action: "create-bound", projectId, options });
      return conversation(
        "conversation-auto-bound",
        projectId,
        options.executionPolicyMode,
      );
    },
  };
  const server = await startTestServer({}, candidateSummaryService, projectWorkService);
  t.after(server.close);
  const headers = {
    "content-type": "application/json",
    origin: "http://127.0.0.1:4173",
  };

  const standaloneResponse = await fetch(
    `${server.baseUrl}/api/v1/project-work/conversations`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        schema_version: 1,
        provider_id: "deepseek",
        model_id: "deepseek-v4-pro",
        execution_policy_mode: "auto_review",
      }),
    },
  );
  assert.equal(standaloneResponse.status, 201);
  assert.equal(
    (await standaloneResponse.json()).executionPolicy.mode,
    "auto_review",
  );

  const boundResponse = await fetch(
    `${server.baseUrl}/api/v1/project-work/projects/project-auto/conversations`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        schema_version: 1,
        provider_id: "deepseek",
        model_id: "deepseek-v4-pro",
        execution_policy_mode: "auto_review",
      }),
    },
  );
  assert.equal(boundResponse.status, 201);
  assert.equal((await boundResponse.json()).executionPolicy.mode, "auto_review");
  const invalidResponse = await fetch(
    `${server.baseUrl}/api/v1/project-work/conversations`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        schema_version: 1,
        execution_policy_mode: "full_access",
      }),
    },
  );
  assert.equal(invalidResponse.status, 400);
  assert.equal(
    (await invalidResponse.json()).error.code,
    "PROJECT_WORK_EXECUTION_POLICY_INVALID",
  );
  assert.deepEqual(calls, [{
    action: "create-standalone",
    options: {
      title: undefined,
      providerId: "deepseek",
      modelId: "deepseek-v4-pro",
      thinkingLevel: undefined,
      executionPolicyMode: "auto_review",
    },
  }, {
    action: "create-bound",
    projectId: "project-auto",
    options: {
      title: undefined,
      providerId: "deepseek",
      modelId: "deepseek-v4-pro",
      thinkingLevel: undefined,
      executionPolicyMode: "auto_review",
    },
  }]);
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
      checkpoint_message_id: "checkpoint-message-1",
      workflow_id: "screenshot_review",
      capabilities: ["web_search"],
      images: [{
        file_name: "设置页.png",
        mime_type: "image/png",
        byte_length: 225_000,
        data: largeBoundedData,
      }],
      attachments: [{
        attachment_id: "attachment-check",
        attachment_revision: `sha256:${"a".repeat(64)}`,
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
      checkpointId: "checkpoint-message-1",
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
      attachments: [{
        attachment_id: "attachment-check",
        attachment_revision: `sha256:${"a".repeat(64)}`,
      }],
      clientRequestId: "project-message:image-route",
    },
  });

  const invalidCheckpoint = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://127.0.0.1:4173",
    },
    body: JSON.stringify({
      schema_version: 1,
      client_request_id: "project-message:invalid-checkpoint",
      text: "继续",
      checkpoint_message_id: "",
    }),
  });
  assert.equal(invalidCheckpoint.status, 400);
  assert.equal(
    (await invalidCheckpoint.json()).error.code,
    "PROJECT_WORK_MESSAGE_REQUEST_INVALID",
  );
  assert.equal(calls.length, 1);

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

test("ordinary attachment routes create, stream, and remove private conversation files", async (t) => {
  const calls = [];
  const revision = `sha256:${"b".repeat(64)}`;
  const projectWorkService = {
    async createConversationAttachment(conversationId, options) {
      calls.push({ action: "create", conversationId, options });
      return {
        id: "attachment-route",
        fileName: options.fileName,
        mimeType: options.mimeType,
        byteLength: options.byteLength,
        status: "awaiting_upload",
      };
    },
    async uploadConversationAttachment(
      conversationId,
      attachmentId,
      stream,
      options,
    ) {
      let content = "";
      for await (const chunk of stream) content += chunk.toString("utf8");
      calls.push({
        action: "upload",
        conversationId,
        attachmentId,
        content,
        options,
      });
      return {
        id: attachmentId,
        fileName: "review.md",
        mimeType: "text/markdown",
        byteLength: Buffer.byteLength(content),
        status: "ready",
        revision,
      };
    },
    async removeConversationAttachment(conversationId, attachmentId) {
      calls.push({ action: "remove", conversationId, attachmentId });
      return { attachmentId, removed: true };
    },
  };
  const server = await startTestServer(
    {},
    candidateSummaryService,
    projectWorkService,
  );
  t.after(server.close);
  const root = `${server.baseUrl}/api/v1/project-work/conversations/conversation-attachments/attachments`;
  const headers = {
    "content-type": "application/json",
    origin: "http://127.0.0.1:4173",
  };
  const created = await fetch(root, {
    method: "POST",
    headers,
    body: JSON.stringify({
      schema_version: 1,
      file_name: "review.md",
      mime_type: "text/markdown",
      byte_length: 8,
    }),
  });
  assert.equal(created.status, 201);
  const uploaded = await fetch(`${root}/attachment-route/content`, {
    method: "PUT",
    headers: {
      "content-type": "text/markdown",
      origin: "http://127.0.0.1:4173",
    },
    body: "# Review",
  });
  assert.equal(uploaded.status, 201);
  assert.equal((await uploaded.json()).attachment.revision, revision);
  const removed = await fetch(`${root}/attachment-route`, {
    method: "DELETE",
    headers: { origin: "http://127.0.0.1:4173" },
  });
  assert.equal(removed.status, 200);
  assert.deepEqual(calls, [{
    action: "create",
    conversationId: "conversation-attachments",
    options: {
      fileName: "review.md",
      mimeType: "text/markdown",
      byteLength: 8,
    },
  }, {
    action: "upload",
    conversationId: "conversation-attachments",
    attachmentId: "attachment-route",
    content: "# Review",
    options: {
      contentType: "text/markdown",
      declaredLength: "8",
    },
  }, {
    action: "remove",
    conversationId: "conversation-attachments",
    attachmentId: "attachment-route",
  }]);
});

test("project-work execution policy route forwards the CAS revision", async (t) => {
  const calls = [];
  const projectWorkService = {
    configureExecutionPolicy: async (conversationId, options) => {
      calls.push({ conversationId, options });
      return {
        conversation: {
          id: conversationId,
          executionPolicy: {
            mode: options.mode,
            revision: options.expectedRevision + 1,
            policyVersion: 1,
          },
        },
        events: [],
      };
    },
  };
  const server = await startTestServer({}, candidateSummaryService, projectWorkService);
  t.after(server.close);

  const response = await fetch(
    `${server.baseUrl}/api/v1/project-work/conversations/conversation-policy/execution-policy`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://127.0.0.1:4173",
      },
      body: JSON.stringify({
        schema_version: 1,
        mode: "auto_review",
        expected_revision: 3,
      }),
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [{
    conversationId: "conversation-policy",
    options: {
      mode: "auto_review",
      expectedRevision: 3,
    },
  }]);
  assert.deepEqual((await response.json()).conversation.executionPolicy, {
    mode: "auto_review",
    revision: 4,
    policyVersion: 1,
  });
});

test("project-work preview start route requires loopback origin and exact hash-bound request fields", async (t) => {
  const calls = [];
  const acceptedHash = `sha256:${"a".repeat(64)}`;
  const staleHash = `sha256:${"b".repeat(64)}`;
  const projectWorkService = {
    startPreview: async (conversationId, options) => {
      calls.push({ conversationId, options });
      if (options.requestHash === staleHash) {
        throw projectWorkError(
          "PROJECT_WORK_PREVIEW_STALE",
          "本机预览请求已变化，请重新核对后确认",
          409,
          true,
        );
      }
      return {
        schemaVersion: 1,
        conversation: {
          id: conversationId,
          projectId: "project-one",
          status: "awaiting_confirmation",
          preview: {
            id: options.previewId,
            requestHash: options.requestHash,
            status: "ready",
            url: "http://127.0.0.1:48080/",
          },
        },
        events: [],
      };
    },
  };
  const server = await startTestServer(
    {},
    candidateSummaryService,
    projectWorkService,
  );
  t.after(server.close);
  const endpoint = `${server.baseUrl}/api/v1/project-work/conversations/conversation%2Fpreview/previews/preview%2Fmanual/start`;
  const headers = {
    "content-type": "application/json",
    origin: "http://127.0.0.1:4173",
  };
  const requestBody = (requestHash = acceptedHash) => JSON.stringify({
    schema_version: 1,
    client_request_id: "project-preview:confirm-1",
    request_hash: requestHash,
  });

  const accepted = await fetch(endpoint, {
    method: "POST",
    headers,
    body: requestBody(),
  });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).conversation.preview.status, "ready");
  assert.deepEqual(calls[0], {
    conversationId: "conversation/preview",
    options: {
      previewId: "preview/manual",
      requestHash: acceptedHash,
    },
  });

  const missingOrigin = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: requestBody(),
  });
  assert.equal(missingOrigin.status, 403);
  assert.equal(
    (await missingOrigin.json()).error.code,
    "PROJECT_WORK_ORIGIN_REQUIRED",
  );

  const remoteOrigin = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://remote.example",
    },
    body: requestBody(),
  });
  assert.equal(remoteOrigin.status, 403);
  assert.equal(
    (await remoteOrigin.json()).error.code,
    "ORIGIN_NOT_ALLOWED",
  );

  const missingRequestId = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      schema_version: 1,
      request_hash: acceptedHash,
    }),
  });
  assert.equal(missingRequestId.status, 400);
  assert.equal(
    (await missingRequestId.json()).error.code,
    "PROJECT_WORK_CLIENT_REQUEST_ID_INVALID",
  );

  const extraField = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      schema_version: 1,
      client_request_id: "project-preview:confirm-extra",
      request_hash: acceptedHash,
      command: "npm run dev",
    }),
  });
  assert.equal(extraField.status, 400);
  assert.equal(
    (await extraField.json()).error.code,
    "PROJECT_WORK_PREVIEW_START_REQUEST_INVALID",
  );

  const stale = await fetch(endpoint, {
    method: "POST",
    headers,
    body: requestBody(staleHash),
  });
  assert.equal(stale.status, 409);
  const staleBody = await stale.json();
  assert.deepEqual(staleBody.error, {
    code: "PROJECT_WORK_PREVIEW_STALE",
    message: "本机预览请求已变化，请重新核对后确认",
    retryable: true,
  });
  assert.equal(calls.length, 2);
});

test("project-work follow-up and ask-user routes keep queueing separate from answers", async (t) => {
  const calls = [];
  const projectWorkService = {
    listFollowUps: async (conversationId, options) => {
      calls.push({ method: "listFollowUps", conversationId, options });
      return [{ id: "follow-up-1", status: "queued" }];
    },
    enqueueFollowUp: async (conversationId, options) => {
      calls.push({ method: "enqueueFollowUp", conversationId, options });
      return {
        schemaVersion: 1,
        item: { id: "follow-up-1", status: "queued", text: options.text },
      };
    },
    removeFollowUp: async (conversationId, itemId) => {
      calls.push({ method: "removeFollowUp", conversationId, itemId });
      return { schemaVersion: 1, cancelled: [{ id: itemId }] };
    },
    clearFollowUps: async (conversationId) => {
      calls.push({ method: "clearFollowUps", conversationId });
      return { schemaVersion: 1, cancelled: [] };
    },
    listAskUserRequests: async (conversationId, options) => {
      calls.push({ method: "listAskUserRequests", conversationId, options });
      return [{ id: "ask-user-1", status: "pending" }];
    },
    createAskUserRequest: async (conversationId, options) => {
      calls.push({ method: "createAskUserRequest", conversationId, options });
      return {
        schemaVersion: 1,
        request: { id: "ask-user-1", status: "pending" },
      };
    },
    answerAskUserRequest: async (conversationId, requestId, options) => {
      calls.push({
        method: "answerAskUserRequest",
        conversationId,
        requestId,
        options,
      });
      return {
        schemaVersion: 1,
        request: { id: requestId, status: "answered" },
      };
    },
    cancelAskUserRequest: async (conversationId, requestId) => {
      calls.push({
        method: "cancelAskUserRequest",
        conversationId,
        requestId,
      });
      return {
        schemaVersion: 1,
        request: { id: requestId, status: "cancelled" },
      };
    },
  };
  const server = await startTestServer({}, candidateSummaryService, projectWorkService);
  t.after(server.close);
  const base = `${server.baseUrl}/api/v1/project-work/conversations/conversation-control`;
  const mutationHeaders = {
    "content-type": "application/json",
    origin: "http://127.0.0.1:4173",
  };

  assert.equal((await fetch(`${base}/follow-ups?include_history=true`)).status, 200);
  assert.equal((await fetch(`${base}/follow-ups`, {
    method: "POST",
    headers: mutationHeaders,
    body: JSON.stringify({ schema_version: 1, text: "完成后继续" }),
  })).status, 202);
  assert.equal((await fetch(`${base}/follow-ups/follow-up-1`, {
    method: "DELETE",
    headers: { origin: "http://127.0.0.1:4173" },
  })).status, 200);
  assert.equal((await fetch(`${base}/follow-ups`, {
    method: "DELETE",
    headers: { origin: "http://127.0.0.1:4173" },
  })).status, 200);

  assert.equal((await fetch(`${base}/questions?include_history=true`)).status, 200);
  assert.equal((await fetch(`${base}/questions`, {
    method: "POST",
    headers: mutationHeaders,
    body: JSON.stringify({
      schema_version: 1,
      questions: [{
        id: "scope",
        prompt: "选择范围",
        kind: "single_choice",
        options: [{
          id: "backend",
          label: "后端",
        }, {
          id: "frontend",
          label: "前端",
        }],
      }],
    }),
  })).status, 201);
  assert.equal((await fetch(`${base}/questions/ask-user-1/answer`, {
    method: "POST",
    headers: mutationHeaders,
    body: JSON.stringify({
      schema_version: 1,
      answers: [{
        question_id: "scope",
        value: "backend",
      }],
    }),
  })).status, 200);
  assert.equal((await fetch(`${base}/questions/ask-user-2/cancel`, {
    method: "POST",
    headers: mutationHeaders,
    body: JSON.stringify({ schema_version: 1 }),
  })).status, 200);

  assert.deepEqual(calls, [{
    method: "listFollowUps",
    conversationId: "conversation-control",
    options: { includeHistory: true },
  }, {
    method: "enqueueFollowUp",
    conversationId: "conversation-control",
    options: { text: "完成后继续" },
  }, {
    method: "removeFollowUp",
    conversationId: "conversation-control",
    itemId: "follow-up-1",
  }, {
    method: "clearFollowUps",
    conversationId: "conversation-control",
  }, {
    method: "listAskUserRequests",
    conversationId: "conversation-control",
    options: { includeHistory: true },
  }, {
    method: "createAskUserRequest",
    conversationId: "conversation-control",
    options: {
      questions: [{
        id: "scope",
        label: undefined,
        prompt: "选择范围",
        kind: "single_choice",
        required: undefined,
        options: [{
          id: "backend",
          label: "后端",
          description: undefined,
        }, {
          id: "frontend",
          label: "前端",
          description: undefined,
        }],
      }],
    },
  }, {
    method: "answerAskUserRequest",
    conversationId: "conversation-control",
    requestId: "ask-user-1",
    options: {
      answers: [{
        questionId: "scope",
        value: "backend",
      }],
    },
  }, {
    method: "cancelAskUserRequest",
    conversationId: "conversation-control",
    requestId: "ask-user-2",
  }]);
});

test("project-work turn, read, retry, fork, and repair-resume routes preserve durable request ids", async (t) => {
  const calls = [];
  const state = {
    schemaVersion: 1,
    conversation: {
      id: "conversation-history",
      projectId: null,
      workspaceKind: "scratch",
      scope: "standalone",
      rootLabel: "未连接文件夹",
      title: "历史会话",
      status: "idle",
      messages: [],
      lastEventSeq: 4,
    },
    events: [],
    hasMoreEvents: false,
  };
  const projectWorkService = {
    getConversationTurns: async (conversationId, options) => {
      calls.push({ method: "getConversationTurns", conversationId, options });
      return {
        schemaVersion: 1,
        turns: [{ id: "turn-11", turnSeq: 11 }],
        hasMore: true,
        nextBeforeTurnSeq: 11,
      };
    },
    markConversationRead: async (conversationId, options) => {
      calls.push({ method: "markConversationRead", conversationId, options });
      return state;
    },
    retryLastTurn: async (conversationId, options) => {
      calls.push({ method: "retryLastTurn", conversationId, options });
      return state;
    },
    forkConversationFromCheckpoint: async (conversationId, options) => {
      calls.push({
        method: "forkConversationFromCheckpoint",
        conversationId,
        options,
      });
      return {
        ...state,
        conversation: {
          ...state.conversation,
          id: "conversation-history-fork",
        },
      };
    },
    resumeVerificationRepair: async (conversationId, options) => {
      calls.push({
        method: "resumeVerificationRepair",
        conversationId,
        options,
      });
      return state;
    },
    getConversation: async (conversationId) => {
      calls.push({ method: "getConversation", conversationId });
      return state;
    },
  };
  const server = await startTestServer(
    {},
    candidateSummaryService,
    projectWorkService,
  );
  t.after(server.close);
  const base =
    `${server.baseUrl}/api/v1/project-work/conversations/conversation-history`;
  const headers = {
    "content-type": "application/json",
    origin: "http://127.0.0.1:4173",
  };

  const turns = await fetch(`${base}/turns?before_turn_seq=12&limit=5`);
  assert.equal(turns.status, 200);
  assert.equal((await turns.json()).turns[0].turnSeq, 11);

  const read = await fetch(`${base}/read`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      schema_version: 1,
      client_request_id: "read:history-1",
      through_message_seq: 19,
    }),
  });
  assert.equal(read.status, 200);

  const retry = await fetch(`${base}/retry-last-turn`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      schema_version: 1,
      client_request_id: "retry:history-1",
      checkpoint_id: "checkpoint-history-1",
    }),
  });
  assert.equal(retry.status, 202);

  const fork = await fetch(`${base}/forks`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      schema_version: 1,
      client_request_id: "fork:history-1",
      checkpoint_id: "checkpoint-history-1",
    }),
  });
  assert.equal(fork.status, 201);
  assert.equal((await fork.json()).conversation.id, "conversation-history-fork");

  const invalidFork = await fetch(`${base}/forks`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      schema_version: 1,
      client_request_id: "fork:history-invalid",
      checkpoint_id: "checkpoint-history-1",
      pi_entry_id: "must-not-cross-http",
    }),
  });
  assert.equal(invalidFork.status, 400);
  assert.equal(
    (await invalidFork.json()).error.code,
    "PROJECT_WORK_FORK_REQUEST_INVALID",
  );

  const invalidRetry = await fetch(`${base}/retry-last-turn`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      schema_version: 1,
      client_request_id: "retry:history-invalid",
      checkpoint_id: "",
    }),
  });
  assert.equal(invalidRetry.status, 400);
  assert.equal(
    (await invalidRetry.json()).error.code,
    "PROJECT_WORK_RETRY_REQUEST_INVALID",
  );

  const resume = await fetch(
    `${base}/verification-repairs/operation%2Frepair-1/resume`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        schema_version: 1,
        client_request_id: "repair:resume-1",
      }),
    },
  );
  assert.equal(resume.status, 202);
  assert.deepEqual(calls, [{
    method: "getConversationTurns",
    conversationId: "conversation-history",
    options: { beforeTurnSeq: 12, limit: 5 },
  }, {
    method: "markConversationRead",
    conversationId: "conversation-history",
    options: {
      throughMessageSeq: 19,
      clientRequestId: "read:history-1",
    },
  }, {
    method: "retryLastTurn",
    conversationId: "conversation-history",
    options: {
      clientRequestId: "retry:history-1",
      checkpointId: "checkpoint-history-1",
    },
  }, {
    method: "forkConversationFromCheckpoint",
    conversationId: "conversation-history",
    options: {
      clientRequestId: "fork:history-1",
      checkpointId: "checkpoint-history-1",
    },
  }, {
    method: "resumeVerificationRepair",
    conversationId: "conversation-history",
    options: {
      operationId: "operation/repair-1",
      clientRequestId: "repair:resume-1",
    },
  }, {
    method: "getConversation",
    conversationId: "conversation-history",
  }]);
});

test("project-work apply journal routes expose safe history and hash-bound undo", async (t) => {
  const calls = [];
  const projectWorkService = {
    getWorkspace: async (conversationId) => {
      calls.push({ method: "getWorkspace", conversationId });
      return {
        schemaVersion: 1,
        id: "workspace-conversation-apply",
        kind: "sparse_overlay",
        isolation: "review_overlay",
        automaticApplyAllowed: false,
        status: "ready",
      };
    },
    getGitEvidence: async (conversationId) => {
      calls.push({ method: "getGitEvidence", conversationId });
      return {
        available: true,
        branch: "codex/runtime",
        head: "abcdef",
        staged: ["src/a.js"],
        unstaged: [],
        untracked: [],
        truncated: false,
      };
    },
    listApplyJournal: async (conversationId) => {
      calls.push({ method: "listApplyJournal", conversationId });
      return [{
        id: "apply-1",
        status: "applied",
        undo: {
          status: "available",
          hash: "sha256:undo",
        },
      }];
    },
    undoApply: async (conversationId, applyId, options) => {
      calls.push({
        method: "undoApply",
        conversationId,
        applyId,
        options,
      });
      return {
        schemaVersion: 1,
        conversation: {
          id: conversationId,
          applyJournal: [{
            id: applyId,
            status: "undone",
          }],
        },
        events: [],
      };
    },
  };
  const server = await startTestServer(
    {},
    candidateSummaryService,
    projectWorkService,
  );
  t.after(server.close);
  const conversationBase = `${server.baseUrl}/api/v1/project-work/conversations/conversation-apply`;
  const base = `${conversationBase}/applies`;

  const workspaceResponse = await fetch(`${conversationBase}/workspace`);
  assert.equal(workspaceResponse.status, 200);
  assert.equal(
    (await workspaceResponse.json()).workspace.automaticApplyAllowed,
    false,
  );
  const gitResponse = await fetch(`${conversationBase}/git-evidence`);
  assert.equal(gitResponse.status, 200);
  assert.equal((await gitResponse.json()).git.branch, "codex/runtime");
  const listResponse = await fetch(base);
  assert.equal(listResponse.status, 200);
  assert.deepEqual(await listResponse.json(), {
    schemaVersion: 1,
    applies: [{
      id: "apply-1",
      status: "applied",
      undo: {
        status: "available",
        hash: "sha256:undo",
      },
    }],
  });
  const undoResponse = await fetch(`${base}/apply-1/undo`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://127.0.0.1:4173",
    },
    body: JSON.stringify({
      schema_version: 1,
      undo_hash: "sha256:undo",
    }),
  });
  assert.equal(undoResponse.status, 200);
  assert.deepEqual(calls, [{
    method: "getWorkspace",
    conversationId: "conversation-apply",
  }, {
    method: "getGitEvidence",
    conversationId: "conversation-apply",
  }, {
    method: "listApplyJournal",
    conversationId: "conversation-apply",
  }, {
    method: "undoApply",
    conversationId: "conversation-apply",
    applyId: "apply-1",
    options: {
      undoHash: "sha256:undo",
    },
  }]);
});

test("project-work conversation snapshot carries exactly the latest 20 turns of activity", async (t) => {
  const calls = [];
  const projectWorkService = {
    async getConversation(conversationId, options) {
      calls.push({ method: "getConversation", conversationId, options });
      return {
        schemaVersion: 1,
        conversation: {
          id: conversationId,
          projectId: "project-1",
          title: "最近工作",
          status: "completed",
          messages: [],
          lastEventSeq: 90,
        },
        events: [{ seq: 1, type: "conversation.created", data: {} }],
        hasMoreEvents: true,
      };
    },
    async getConversationTurns(conversationId, options) {
      calls.push({ method: "getConversationTurns", conversationId, options });
      return {
        turns: Array.from({ length: 20 }, (_, index) => ({
          id: `turn-${index + 11}`,
          turnSeq: index + 11,
          events: [{
            seq: 71 + index,
            type: "agent.progress",
            data: { summary: `进展 ${index + 11}` },
          }],
        })),
        hasMore: true,
      };
    },
  };
  const server = await startTestServer(
    {},
    candidateSummaryService,
    projectWorkService,
  );
  t.after(server.close);

  const response = await fetch(
    `${server.baseUrl}/api/v1/project-work/conversations/conversation-recent`,
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.events.map((event) => event.seq), Array.from(
    { length: 20 },
    (_, index) => 71 + index,
  ));
  assert.equal(payload.hasEarlierEvents, true);
  assert.equal(payload.hasMoreEvents, false);
  const refreshResponse = await fetch(
    `${server.baseUrl}/api/v1/project-work/conversations/conversation-recent?activity=none`,
  );
  const refreshPayload = await refreshResponse.json();
  assert.deepEqual(refreshPayload.events, []);
  assert.deepEqual(calls, [{
    method: "getConversation",
    conversationId: "conversation-recent",
    options: { afterSeq: 0, eventLimit: 1 },
  }, {
    method: "getConversationTurns",
    conversationId: "conversation-recent",
    options: { limit: 20 },
  }, {
    method: "getConversation",
    conversationId: "conversation-recent",
    options: { afterSeq: 0, eventLimit: 1 },
  }]);
});

test("project-work event endpoint sends one snapshot then incremental deltas", async (t) => {
  const afterSequences = [];
  let subscriptions = 0;
  let unsubscriptions = 0;
  let streamListener = null;
  const event = {
    seq: 7,
    type: "ask_user.requested",
    at: "2026-07-27T10:00:00.000Z",
    data: {
      id: "ask-user-1",
      questionCount: 1,
    },
  };
  const gapEvent = {
    seq: 8,
    type: "agent.status",
    at: "2026-07-27T10:00:01.000Z",
    data: { status: "idle" },
  };
  const projectWorkService = {
    async getConversation(conversationId, { afterSeq }) {
      afterSequences.push(afterSeq);
      const latestSeq = afterSequences.length >= 4 ? 8 : 7;
      return {
        schemaVersion: 1,
        conversation: {
          id: conversationId,
          projectId: "project-1",
          title: "控制面",
          status: "awaiting_user",
          messages: [],
          askUserRequests: [{
            id: "ask-user-1",
            status: "pending",
            questions: [{
              id: "scope",
              prompt: "选择范围",
              kind: "single_choice",
              required: true,
              options: [
                { id: "code", label: "代码" },
                { id: "tests", label: "测试" },
              ],
            }],
          }],
          followUpQueue: [],
          lastEventSeq: latestSeq,
        },
        events: [event, gapEvent].filter(
          (item) => item.seq > afterSeq && item.seq <= latestSeq,
        ),
        hasMoreEvents: false,
      };
    },
    subscribeEvents(conversationId, listener) {
      assert.equal(conversationId, "conversation-events");
      assert.equal(typeof listener, "function");
      subscriptions += 1;
      streamListener = listener;
      return () => {
        unsubscriptions += 1;
      };
    },
  };
  const server = await startTestServer(
    {},
    candidateSummaryService,
    projectWorkService,
  );
  t.after(server.close);
  const endpoint = `${server.baseUrl}/api/v1/project-work/conversations/conversation-events/events`;

  const pageResponse = await fetch(`${endpoint}?after_seq=6`);
  assert.equal(pageResponse.status, 200);
  const page = await pageResponse.json();
  assert.equal(page.snapshot_watermark, 7);
  assert.equal(page.last_seq, 7);
  assert.equal(page.events[0].seq, 7);
  assert.equal(page.conversation.askUserRequests[0].status, "pending");

  const resumedResponse = await fetch(`${endpoint}?after_seq=1`, {
    headers: { "last-event-id": "7" },
  });
  assert.equal(resumedResponse.status, 200);
  assert.deepEqual((await resumedResponse.json()).events, []);

  const controller = new AbortController();
  const stream = await fetch(`${endpoint}?after_seq=6`, {
    headers: { accept: "text/event-stream" },
    signal: controller.signal,
  });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (
    !text.includes("event: snapshot")
    || !text.includes("\"seq\":7")
  ) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  assert.match(text, /id: 7/);
  assert.match(text, /event: snapshot/);
  assert.match(text, /"snapshotWatermark":7/);
  assert.match(text, /"lastEventSeq":7/);
  assert.match(text, /"lastSeq":6/);
  assert.match(text, /event: delta/);
  assert.equal(typeof streamListener, "function");
  streamListener(gapEvent);
  while ((text.match(/event: delta/g) ?? []).length < 2) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  assert.match(text, /id: 8/);
  assert.match(text, /event: delta/);
  assert.match(text, /"sessionId":"conversation-events"/);
  assert.match(text, /"seq":8/);
  assert.equal((text.match(/event: snapshot/g) ?? []).length, 1);
  controller.abort();
  await reader.cancel().catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(afterSequences, [6, 7, 6]);
  assert.equal(subscriptions, 1);
  assert.equal(unsubscriptions, 1);
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
  assert.equal(commitResponse.status, 410);
  assert.equal(calls.commit, null);
  assert.deepEqual(await commitResponse.json(), {
    error: {
      code: "ZOTERO_COMMIT_DEPRECATED",
      message: "旧版 Zotero 单独确认入口已停用，请通过联合归档预览确认写入",
      retryable: false,
    },
  });
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

test("ArchiveBatch HTTP route requires a loopback origin and preserves exact bindings", async (t) => {
  let received = null;
  const workflow = {
    startArchiveCommit: async (runId, request) => {
      received = { runId, request };
      return {
        ...committingRun(),
        archive_batch: {
          schema_version: 1,
          batch_id: "archive-safe-1",
          client_request_id: request.clientRequestId,
          request_fingerprint: "sha256:must-not-leak",
          selected_targets: ["obsidian", "zotero", "project_state"],
          status: "committing",
          artifact_path: "archive-batches/must-not-leak.json",
          approved_at: "2026-07-23T12:03:00.000Z",
          completed_at: null,
          updated_at: "2026-07-23T12:03:00.000Z",
        },
      };
    },
  };
  const server = await startTestServer(
    workflow,
    candidateSummaryService,
    undefined,
    { allowMissingJournalMutationOrigin: false },
  );
  t.after(server.close);
  const endpoint =
    `${server.baseUrl}/api/v1/journal-runs/journal-test/archive/commit`;
  const body = {
    schema_version: 1,
    client_request_id: "archive-request-1",
    obsidian: {
      proposal_hash: "sha256:obsidian-preview",
      operations: [{
        proposal_id: "obsidian-preview-paper-1",
        content_hash: "sha256:obsidian-content",
        target_version_or_hash: "sha256:obsidian-target",
      }],
    },
    zotero: {
      proposal_hash: "sha256:zotero-preview",
      operations: [{
        proposal_id: "zotero-paper-1",
        content_hash: "sha256:zotero-content",
        target_version_or_hash: "sha256:zotero-target",
      }],
    },
    project_state: {
      proposal_hash: "sha256:project-preview",
      operation: {
        proposal_id: "project-state-preview-1",
        content_hash: "sha256:project-content",
        target_version_or_hash: "sha256:project-target",
      },
    },
  };

  const rejected = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(rejected.status, 403);
  assert.equal(received, null);

  const malformedRequestId = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://127.0.0.1:4173",
    },
    body: JSON.stringify({
      ...body,
      client_request_id: "archive request with spaces",
    }),
  });
  assert.equal(malformedRequestId.status, 400);
  assert.equal(received, null);

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://127.0.0.1:4173",
    },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 202);
  assert.equal(received.runId, "journal-test");
  assert.deepEqual(received.request, {
    clientRequestId: "archive-request-1",
    obsidian: {
      proposalHash: "sha256:obsidian-preview",
      operations: body.obsidian.operations,
    },
    zotero: {
      proposalHash: "sha256:zotero-preview",
      operations: body.zotero.operations,
    },
    projectState: {
      proposalHash: "sha256:project-preview",
      operation: body.project_state.operation,
    },
    simulateObsidianFailure: false,
  });
  const publicBody = await response.json();
  assert.equal(publicBody.archive_batch.batch_id, "archive-safe-1");
  const serialized = JSON.stringify(publicBody);
  assert.equal(serialized.includes("request_fingerprint"), false);
  assert.equal(serialized.includes("archive-batches/"), false);
});

test("Journal mutation entry routes require a versioned JSON envelope before dispatch", async (t) => {
  const calls = [];
  const workflow = {
    startRun: async (options) => {
      calls.push({ action: "start", options });
      return committingRun();
    },
    resumeRun: async (runId) => {
      calls.push({ action: "resume", runId });
      return committingRun();
    },
    createReadingConversation: async (runId, paperId, options) => {
      calls.push({ action: "conversation", runId, paperId, options });
      return {
        schema_version: 1,
        run_id: runId,
        paper_id: paperId,
        status: "idle",
      };
    },
    resetPaperReading: async (runId, paperId, options) => {
      calls.push({ action: "reset", runId, paperId, options });
      return committingRun();
    },
  };
  const server = await startTestServer(
    workflow,
    candidateSummaryService,
    undefined,
    { allowMissingJournalMutationOrigin: false },
  );
  t.after(server.close);
  const headers = {
    origin: "http://127.0.0.1:4173",
    "content-type": "application/json",
  };

  const invalidStart = await fetch(`${server.baseUrl}/api/v1/journal-runs`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      provider_id: "deepseek",
      model_id: "deepseek-v4-flash",
    }),
  });
  assert.equal(invalidStart.status, 400);

  const start = await fetch(`${server.baseUrl}/api/v1/journal-runs`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      schema_version: 1,
      provider_id: "deepseek",
      model_id: "deepseek-v4-flash",
    }),
  });
  assert.equal(start.status, 202);

  const resumeWithoutJson = await fetch(
    `${server.baseUrl}/api/v1/journal-runs/journal-test/resume`,
    {
      method: "POST",
      headers: { origin: "http://127.0.0.1:4173" },
    },
  );
  assert.equal(resumeWithoutJson.status, 415);

  const resume = await fetch(
    `${server.baseUrl}/api/v1/journal-runs/journal-test/resume`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ schema_version: 1 }),
    },
  );
  assert.equal(resume.status, 202);

  const invalidConversation = await fetch(
    `${server.baseUrl}/api/v1/journal-runs/journal-test/papers/paper-1/reading/conversations`,
    {
      method: "POST",
      headers,
      body: "{}",
    },
  );
  assert.equal(invalidConversation.status, 400);

  const conversation = await fetch(
    `${server.baseUrl}/api/v1/journal-runs/journal-test/papers/paper-1/reading/conversations`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        schema_version: 1,
        client_request_id: "create-reading-conversation-1",
      }),
    },
  );
  assert.equal(conversation.status, 201);

  const reset = await fetch(
    `${server.baseUrl}/api/v1/journal-runs/journal-test/papers/paper-1/reading/reset`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        schema_version: 1,
        client_request_id: "reset-reading-1",
      }),
    },
  );
  assert.equal(reset.status, 200);
  assert.deepEqual(calls, [{
    action: "start",
    options: {
      trigger: "manual",
      providerId: "deepseek",
      modelId: "deepseek-v4-flash",
      thinkingLevel: null,
    },
  }, {
    action: "resume",
    runId: "journal-test",
  }, {
    action: "conversation",
    runId: "journal-test",
    paperId: "paper-1",
    options: {
      clientRequestId: "create-reading-conversation-1",
    },
  }, {
    action: "reset",
    runId: "journal-test",
    paperId: "paper-1",
    options: {
      clientRequestId: "reset-reading-1",
    },
  }]);
});

test("journal event endpoint resumes after a stable sequence and streams snapshot watermarks", async (t) => {
  const run = {
    ...committingRun(),
    snapshot_watermark: 7,
    last_event_seq: 7,
  };
  let subscriptions = 0;
  let unsubscriptions = 0;
  const workflow = {
    getRun: async () => run,
    readEvents: async (_runId, { afterSeq }) => ({
      events: afterSeq < 7
        ? [{
            seq: 7,
            type: "archive_batch_completed",
            status: "partial",
            at: "2026-07-23T12:04:00.000Z",
            artifact_path: "/private/must-not-leak.json",
          }]
        : [],
      hasMore: false,
      lastSeq: 7,
    }),
    subscribeEvents: (_runId, _listener) => {
      subscriptions += 1;
      return () => {
        unsubscriptions += 1;
      };
    },
  };
  const server = await startTestServer(workflow);
  t.after(server.close);
  const endpoint =
    `${server.baseUrl}/api/v1/journal-runs/journal-test/events?after_seq=6`;
  const response = await fetch(endpoint);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.snapshot_watermark, 7);
  assert.equal(body.events[0].seq, 7);
  assert.equal(JSON.stringify(body).includes("artifact_path"), false);

  const controller = new AbortController();
  const stream = await fetch(endpoint, {
    headers: { accept: "text/event-stream" },
    signal: controller.signal,
  });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  const firstChunk = await reader.read();
  const text = new TextDecoder().decode(firstChunk.value);
  assert.match(text, /event: snapshot/);
  assert.match(text, /"snapshot_watermark":7/);
  controller.abort();
  const unsubscribeDeadline = Date.now() + 1_000;
  while (unsubscriptions === 0 && Date.now() < unsubscribeDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(subscriptions, 1);
  assert.equal(unsubscriptions, 1);
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
  assert.equal(preview.write_capability, "hash_bound_commit");
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
  assert.equal(preview.write_capability, "hash_bound_commit");
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
    getReadingChatProgress: (runId, paperId, clientRequestId) => {
      calls.chatProgress = { runId, paperId, clientRequestId };
      return { phase: "thinking", thinking: "正在对照证据。", status: "running" };
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
    restartReadingFromGuide: async (runId, options) => {
      calls.restart = { runId, options };
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
        client_request_id: "restart-reading-1",
      }),
    },
  );
  assert.equal(restartResponse.status, 200);
  assert.deepEqual(calls.restart, {
    runId: "journal-test",
    options: { clientRequestId: "restart-reading-1" },
  });

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

  calls.question = null;
  const missingQuestionRequestId = await fetch(
    `${server.baseUrl}/api/v1/journal-runs/journal-test/papers/paper-1/reading/questions`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: 1,
        stage: "research-question",
        text: "缺少稳定请求标识",
        block_id: "block-1",
      }),
    },
  );
  assert.equal(missingQuestionRequestId.status, 400);
  assert.equal(calls.question, null);

  const chatResponse = await fetch(
    `${server.baseUrl}/api/v1/journal-runs/journal-test/papers/paper-1/reading/chat/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: 1,
        client_request_id: "client-chat-1",
        text: "这部分是什么意思？",
        round_id: "orientation",
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
      roundId: "orientation",
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
      thinkingLevel: null,
    },
  });

  calls.chat = null;
  const chatProgressResponse = await fetch(
    `${server.baseUrl}/api/v1/journal-runs/journal-test/papers/paper-1/reading/chat/progress?client_request_id=client-chat-1`,
  );
  assert.equal(chatProgressResponse.status, 200);
  const chatProgressBody = await chatProgressResponse.json();
  assert.equal(chatProgressBody.phase, "thinking");
  assert.equal(chatProgressBody.status, "running");
  assert.deepEqual(calls.chatProgress, {
    runId: "journal-test",
    paperId: "paper-1",
    clientRequestId: "client-chat-1",
  });

  const missingProgressRequestId = await fetch(
    `${server.baseUrl}/api/v1/journal-runs/journal-test/papers/paper-1/reading/chat/progress`,
  );
  assert.equal(missingProgressRequestId.status, 400);

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

test("project-work file routes forward bounded paging and serve validated image bytes", async (t) => {
  const calls = [];
  const imageBytes = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  const officeBytes = Buffer.from("PK validated office package");
  const projectWorkService = {
    async getConversationTree(conversationId, options) {
      calls.push({ action: "tree", conversationId, options });
      return {
        path: "",
        query: "settings",
        revision: "sha256:tree",
        entries: [{
          path: "assets/settings.png",
          name: "settings.png",
          type: "file",
          previewKind: "image",
          mimeType: "image/png",
          overlay: "created",
        }],
        nextCursor: "page-2",
        truncated: true,
      };
    },
    async readConversationImage(conversationId, options) {
      calls.push({ action: "image", conversationId, options });
      return {
        path: "assets/settings.png",
        mimeType: "image/png",
        byteLength: imageBytes.length,
        hash: "sha256:image",
        bytes: imageBytes,
      };
    },
    async readGeneratedImage(conversationId, imageId) {
      calls.push({ action: "generated-image", conversationId, imageId });
      return {
        path: "image-1.png",
        mimeType: "image/png",
        byteLength: imageBytes.length,
        hash: "sha256:generated-image",
        bytes: imageBytes,
      };
    },
    async readGeneratedOfficeArtifact(conversationId, artifactId) {
      calls.push({ action: "generated-office", conversationId, artifactId });
      return {
        fileName: "项目报告.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        byteLength: officeBytes.length,
        hash: "sha256:generated-office",
        bytes: officeBytes,
      };
    },
  };
  const server = await startTestServer(
    {},
    candidateSummaryService,
    projectWorkService,
  );
  t.after(server.close);

  const treeResponse = await fetch(
    `${server.baseUrl}/api/v1/project-work/conversations/conversation-files/tree?query=settings&limit=25&cursor=page-1`,
  );
  assert.equal(treeResponse.status, 200);
  assert.deepEqual(await treeResponse.json(), {
    path: "",
    query: "settings",
    revision: "sha256:tree",
    entries: [{
      path: "assets/settings.png",
      name: "settings.png",
      type: "file",
      previewKind: "image",
      mimeType: "image/png",
      overlay: "created",
    }],
    nextCursor: "page-2",
    truncated: true,
  });

  const imageResponse = await fetch(
    `${server.baseUrl}/api/v1/project-work/conversations/conversation-files/image?path=assets%2Fsettings.png`,
  );
  assert.equal(imageResponse.status, 200);
  assert.equal(imageResponse.headers.get("content-type"), "image/png");
  assert.equal(imageResponse.headers.get("cache-control"), "private, no-store");
  assert.equal(imageResponse.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), imageBytes);
  const generatedImageResponse = await fetch(
    `${server.baseUrl}/api/v1/project-work/conversations/conversation-files/generated-images/image-1/content`,
  );
  assert.equal(generatedImageResponse.status, 200);
  assert.equal(generatedImageResponse.headers.get("content-type"), "image/png");
  assert.equal(
    generatedImageResponse.headers.get("cache-control"),
    "private, no-store",
  );
  assert.deepEqual(
    Buffer.from(await generatedImageResponse.arrayBuffer()),
    imageBytes,
  );
  const officeResponse = await fetch(
    `${server.baseUrl}/api/v1/project-work/conversations/conversation-files/generated-office/office-1/download`,
  );
  assert.equal(officeResponse.status, 200);
  assert.equal(
    officeResponse.headers.get("content-type"),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  assert.equal(officeResponse.headers.get("cache-control"), "private, no-store");
  assert.equal(officeResponse.headers.get("x-content-type-options"), "nosniff");
  assert.match(
    officeResponse.headers.get("content-disposition"),
    /^attachment; filename="____\.docx"; filename\*=UTF-8''/u,
  );
  assert.deepEqual(Buffer.from(await officeResponse.arrayBuffer()), officeBytes);
  assert.deepEqual(calls, [{
    action: "tree",
    conversationId: "conversation-files",
    options: {
      directory: "",
      depth: 3,
      query: "settings",
      limit: 25,
      cursor: "page-1",
    },
  }, {
    action: "image",
    conversationId: "conversation-files",
    options: {
      filePath: "assets/settings.png",
    },
  }, {
    action: "generated-image",
    conversationId: "conversation-files",
    imageId: "image-1",
  }, {
    action: "generated-office",
    conversationId: "conversation-files",
    artifactId: "office-1",
  }]);
});
