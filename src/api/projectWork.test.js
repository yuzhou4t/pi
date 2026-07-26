import assert from "node:assert/strict";
import test from "node:test";
import {
  createStandaloneProjectWorkConversation,
  deleteProjectWorkConversation,
  fetchProjectWorkFile,
  fetchProjectWorkModels,
  fetchProjectWorkTree,
  listStandaloneProjectWorkConversations,
  mapProjectWorkConversation,
  renameProjectWorkConversation,
} from "./projectWork.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("conversation mapping preserves a ready, hash-bound change set", () => {
  const mapped = mapProjectWorkConversation({
    conversation: {
      id: "conversation-1",
      project_id: "project-1",
      title: "修复设置页",
      status: "awaiting_confirmation",
      workspace_snapshot: {
        mode: "sparse_overlay",
        included_files: 7938,
        included_bytes: 100663296,
        truncated: true,
      },
      activeChangeSet: {
        id: "change-set-1",
        status: "ready",
        proposal_hash: "sha256:proposal",
        files: [{
          id: "change-file-1",
          path: "src/settings.css",
          operation: "modify",
          additions: 2,
          deletions: 1,
          diff: [
            "--- a/src/settings.css",
            "+++ b/src/settings.css",
            "@@ -1 +1,2 @@",
            "-position: fixed;",
            "+position: sticky;",
          ].join("\n"),
          base_hash: "sha256:before",
          after_hash: "sha256:after",
        }],
      },
      plan: {
        steps: [{ id: "step-1", text: "检查设置页布局", status: "completed" }],
      },
    },
    events: [{
      seq: 2,
      type: "tool_result",
      data: { name: "read", status: "completed", path: "src/settings.css" },
    }, {
      seq: 1,
      type: "plan_updated",
      data: { title: "计划已更新" },
    }],
  });

  assert.equal(mapped.pendingChangeSet.status, "ready");
  assert.equal(mapped.pendingChangeSet.proposalHash, "sha256:proposal");
  assert.equal(mapped.pendingChangeFileCount, 1);
  assert.equal(mapped.pendingChangeSet.files[0].baseHash, "sha256:before");
  assert.equal(mapped.pendingChangeSet.files[0].afterHash, "sha256:after");
  assert.deepEqual(mapped.pendingChangeSet.files[0].diff.slice(-2), [
    "-position: fixed;",
    "+position: sticky;",
  ]);
  assert.equal(mapped.plan[0].title, "检查设置页布局");
  assert.deepEqual(mapped.events.map((event) => event.seq), [1, 2]);
  assert.equal(mapped.events[1].toolName, "read");
  assert.equal(mapped.events[1].path, "src/settings.css");
  assert.deepEqual(mapped.workspaceSnapshot, {
    mode: "sparse_overlay",
    includedFiles: 7938,
    includedBytes: 100663296,
    truncated: true,
  });
});

test("standalone conversation mapping preserves its explicit scratch scope", () => {
  const mapped = mapProjectWorkConversation({
    conversation: {
      id: "standalone-1",
      project_id: null,
      workspace_kind: "scratch",
      scope: "standalone",
      root_label: "未连接文件夹",
      title: "新工作会话",
      status: "idle",
    },
  });

  assert.equal(mapped.projectId, null);
  assert.equal(mapped.workspaceKind, "scratch");
  assert.equal(mapped.scope, "standalone");
  assert.equal(mapped.rootLabel, "未连接文件夹");
});

test("conversation mapping preserves known and recalculating context usage", () => {
  const known = mapProjectWorkConversation({
    conversation: {
      id: "conversation-context-known",
      project_id: "project-1",
      context_usage: {
        tokens: 30_720,
        context_window: 128_000,
        percent: 24,
        status: "estimated",
        updated_at: "2026-07-26T00:00:00.000Z",
      },
      compaction: {
        auto_enabled: true,
        status: "idle",
      },
    },
  });
  assert.deepEqual(known.contextUsage, {
    tokens: 30_720,
    contextWindow: 128_000,
    percent: 24,
    status: "estimated",
    updatedAt: "2026-07-26T00:00:00.000Z",
  });
  assert.deepEqual(known.compaction, {
    autoEnabled: true,
    status: "idle",
    reason: null,
    tokensBefore: null,
    estimatedTokensAfter: null,
    willRetry: false,
    completedAt: null,
  });

  const recalculating = mapProjectWorkConversation({
    conversation: {
      id: "conversation-context-recalculating",
      project_id: "project-1",
      context_usage: {
        tokens: null,
        context_window: 128_000,
        percent: null,
        status: "awaiting_measurement",
      },
      compaction: {
        auto_enabled: true,
        status: "completed",
        reason: "manual",
        tokens_before: 30_720,
        estimated_tokens_after: 9_400,
        will_retry: false,
        completed_at: "2026-07-26T00:01:00.000Z",
      },
    },
  });
  assert.equal(recalculating.contextUsage.tokens, null);
  assert.equal(recalculating.contextUsage.percent, null);
  assert.equal(recalculating.contextUsage.contextWindow, 128_000);
  assert.equal(recalculating.compaction.status, "completed");
  assert.equal(recalculating.compaction.reason, "manual");
  assert.equal(recalculating.compaction.tokensBefore, 30_720);
  assert.equal(recalculating.compaction.estimatedTokensAfter, 9_400);
  assert.equal(recalculating.compaction.completedAt, "2026-07-26T00:01:00.000Z");
});

test("project-work model catalog keeps the real context window metadata", async () => {
  const catalog = await fetchProjectWorkModels({
    fetchImpl: async () => jsonResponse({
      providers: [{
        id: "deepseek",
        name: "DeepSeek",
        models: [{
          id: "deepseek-v4-flash",
          name: "DeepSeek V4 Flash",
          context_window: 131_072,
        }],
      }],
      default_provider_id: "deepseek",
      default_model_id: "deepseek-v4-flash",
    }),
  });

  assert.equal(catalog.providers[0].models[0].contextWindow, 131_072);
});

test("standalone conversations use global list and create routes", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return jsonResponse({
      conversations: [{
        id: "standalone-1",
        project_id: null,
        workspace_kind: "scratch",
        scope: "standalone",
        root_label: "未连接文件夹",
        title: "独立工作",
        status: "idle",
      }],
    });
  };

  const listed = await listStandaloneProjectWorkConversations({ fetchImpl });
  assert.equal(calls[0].url, "/api/v1/project-work/conversations");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(listed[0].projectId, null);

  calls.length = 0;
  const created = await createStandaloneProjectWorkConversation({
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        conversation: {
          id: "standalone-2",
          project_id: null,
          workspace_kind: "scratch",
          scope: "standalone",
          root_label: "未连接文件夹",
          title: "新工作会话",
          status: "idle",
        },
      });
    },
  });

  assert.equal(calls[0].url, "/api/v1/project-work/conversations");
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    schema_version: 1,
    provider_id: "deepseek",
    model_id: "deepseek-v4-flash",
  });
  assert.equal(created.scope, "standalone");
});

test("string checks map across failed then passing runs while the command remains retryable", () => {
  const mapped = mapProjectWorkConversation({
    id: "conversation-verify",
    project_id: "project-1",
    verifications: [{
      id: "verification-command",
      command_id: "command-1",
      status: "ready",
      command: {
        file: "npm",
        args: ["test"],
        cwd: ".",
      },
      resolved_script: "node --test",
      checks: ["等待用户运行"],
    }, {
      id: "verification-failed",
      command_id: "command-1",
      status: "failed",
      command: "npm test",
      checks: ["设置页布局", "回归测试"],
      output: "AssertionError: footer overlaps content",
      exit_code: 1,
    }, {
      id: "verification-passed",
      command_id: "command-1",
      status: "passed",
      command: "npm test",
      checks: ["设置页布局", "回归测试"],
      output: ["2 tests passed"],
      exit_code: 0,
    }],
  });

  assert.deepEqual(mapped.verificationRuns[1].checks, [{
    id: "check-1",
    label: "设置页布局",
    status: "failed",
  }, {
    id: "check-2",
    label: "回归测试",
    status: "failed",
  }]);
  assert.deepEqual(
    mapped.verificationRuns[2].checks.map((check) => check.status),
    ["passed", "passed"],
  );
  assert.deepEqual(mapped.verificationRuns[1].logs, [
    "AssertionError: footer overlaps content",
  ]);
  assert.deepEqual(mapped.verificationRuns[2].logs, ["2 tests passed"]);
  assert.equal(mapped.verificationRuns[1].exitCode, 1);
  assert.equal(mapped.verificationRuns[2].exitCode, 0);

  assert.deepEqual(mapped.verificationCommand, {
    id: "command-1",
    label: "运行验证",
    executable: "npm",
    args: ["test"],
    displayCommand: "npm test",
    cwdLabel: ".",
    resolvedScript: "node --test",
    status: "ready",
  });
});

test("tree mapping flattens nested folders with stable paths and depths", async () => {
  const calls = [];
  const tree = await fetchProjectWorkTree({
    projectId: "project/with spaces",
    path: "src",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        path: "src",
        revision: "sha256:tree",
        next_cursor: "cursor-2",
        entries: [{
          name: "components",
          type: "directory",
          children: [{
            name: "Settings.jsx",
            type: "file",
            size: 512,
            hash: "sha256:file",
          }],
        }, {
          path: "src/index.js",
          kind: "file",
          depth: 1,
        }],
      });
    },
  });

  assert.equal(
    calls[0].url,
    "/api/v1/project-work/projects/project%2Fwith%20spaces/tree?path=src",
  );
  assert.equal(calls[0].options.method, "GET");
  assert.deepEqual(tree, {
    path: "src",
    revision: "sha256:tree",
    cursor: "cursor-2",
    entries: [{
      id: "src/components",
      path: "src/components",
      name: "components",
      kind: "directory",
      size: null,
      contentHash: null,
      depth: 1,
    }, {
      id: "src/components/Settings.jsx",
      path: "src/components/Settings.jsx",
      name: "Settings.jsx",
      kind: "file",
      size: 512,
      contentHash: "sha256:file",
      depth: 2,
    }, {
      id: "src/index.js",
      path: "src/index.js",
      name: "index.js",
      kind: "file",
      size: null,
      contentHash: null,
      depth: 1,
    }],
  });
});

test("standalone file tree uses the conversation-scoped endpoint", async () => {
  const calls = [];
  await fetchProjectWorkTree({
    conversationId: "standalone/with spaces",
    path: "drafts",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ path: "drafts", entries: [] });
    },
  });

  assert.equal(
    calls[0].url,
    "/api/v1/project-work/conversations/standalone%2Fwith%20spaces/tree?path=drafts",
  );
  assert.equal(calls[0].options.method, "GET");
});

test("file mapping preserves bounded line coordinates and content hash", async () => {
  const calls = [];
  const file = await fetchProjectWorkFile({
    projectId: "project-1",
    path: "src/settings page.css",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        path: "src/settings page.css",
        language: "css",
        mime_type: "text/css",
        content: ".actions {\n  position: sticky;\n}",
        content_hash: "sha256:settings",
        start_line: 8,
        end_line: 10,
        total_lines: 24,
        byte_length: 34,
        truncated: false,
        binary: false,
      });
    },
  });

  assert.equal(
    calls[0].url,
    "/api/v1/project-work/projects/project-1/file?path=src%2Fsettings+page.css",
  );
  assert.equal(calls[0].options.method, "GET");
  assert.deepEqual(file.lines, [".actions {", "  position: sticky;", "}"]);
  assert.equal(file.contentHash, "sha256:settings");
  assert.equal(file.startLine, 8);
  assert.equal(file.endLine, 10);
  assert.equal(file.totalLines, 24);
  assert.equal(file.truncated, true);
  assert.equal(file.binary, false);
});

test("conversation file reads use the sparse overlay endpoint", async () => {
  const calls = [];
  const file = await fetchProjectWorkFile({
    projectId: "project-ignored",
    conversationId: "conversation/with spaces",
    path: "src/generated file.js",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        path: "src/generated file.js",
        content: "export const generated = true;\n",
        hash: "sha256:overlay",
        startLine: 1,
        endLine: 2,
        totalLines: 2,
        byteLength: 31,
      });
    },
  });

  assert.equal(
    calls[0].url,
    "/api/v1/project-work/conversations/conversation%2Fwith%20spaces/file?path=src%2Fgenerated+file.js",
  );
  assert.equal(calls[0].options.method, "GET");
  assert.equal(file.contentHash, "sha256:overlay");
  assert.match(file.content, /generated = true/);
});

test("conversation deletion uses the project-scoped endpoint and preserves the returned count", async () => {
  const calls = [];
  const result = await deleteProjectWorkConversation({
    projectId: "project/with spaces",
    conversationId: "conversation/with spaces",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        schema_version: 1,
        project_id: "project/with spaces",
        conversation_id: "conversation/with spaces",
        removed: true,
        conversation_count: 2,
      });
    },
  });

  assert.equal(
    calls[0].url,
    "/api/v1/project-work/projects/project%2Fwith%20spaces/conversations/conversation%2Fwith%20spaces",
  );
  assert.equal(calls[0].options.method, "DELETE");
  assert.equal(calls[0].options.body, undefined);
  assert.deepEqual(result, {
    projectId: "project/with spaces",
    conversationId: "conversation/with spaces",
    removed: true,
    conversationCount: 2,
  });
});

test("standalone conversation rename and deletion use global conversation routes", async () => {
  const calls = [];
  const renamed = await renameProjectWorkConversation({
    projectId: null,
    conversationId: "standalone-1",
    title: " 独立   任务 ",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        conversation: {
          id: "standalone-1",
          project_id: null,
          workspace_kind: "scratch",
          scope: "standalone",
          root_label: "未连接文件夹",
          title: "独立 任务",
        },
      });
    },
  });

  assert.equal(
    calls[0].url,
    "/api/v1/project-work/conversations/standalone-1",
  );
  assert.equal(calls[0].options.method, "PATCH");
  assert.equal(renamed.title, "独立 任务");

  calls.length = 0;
  const deleted = await deleteProjectWorkConversation({
    projectId: null,
    conversationId: "standalone-1",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        conversation_id: "standalone-1",
        project_id: null,
        removed: true,
      });
    },
  });
  assert.equal(
    calls[0].url,
    "/api/v1/project-work/conversations/standalone-1",
  );
  assert.equal(calls[0].options.method, "DELETE");
  assert.equal(deleted.projectId, null);
  assert.equal(deleted.removed, true);
});

test("conversation rename normalizes the title and uses the project-scoped endpoint", async () => {
  const calls = [];
  const result = await renameProjectWorkConversation({
    projectId: "project-1",
    conversationId: "conversation-1",
    title: "  检查   登录页  ",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        schema_version: 1,
        conversation: {
          id: "conversation-1",
          project_id: "project-1",
          title: "检查 登录页",
          status: "idle",
          pending_change_file_count: 3,
        },
      });
    },
  });

  assert.equal(
    calls[0].url,
    "/api/v1/project-work/projects/project-1/conversations/conversation-1",
  );
  assert.equal(calls[0].options.method, "PATCH");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    schema_version: 1,
    title: "检查 登录页",
  });
  assert.equal(result.id, "conversation-1");
  assert.equal(result.title, "检查 登录页");
  assert.equal(result.pendingChangeFileCount, 3);
});
