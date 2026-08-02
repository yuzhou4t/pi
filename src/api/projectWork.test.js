import assert from "node:assert/strict";
import test from "node:test";
import {
  abandonProjectWorkLegacyMigrationChanges,
  answerProjectWorkAskUserRequest,
  cancelProjectWorkAskUserRequest,
  clearProjectWorkFollowUps,
  confirmProjectWorkGitCloseout,
  configureProjectWorkConversation,
  configureProjectWorkExecutionPolicy,
  createProjectWorkConversation,
  createStandaloneProjectWorkConversation,
  deleteProjectWorkConversation,
  enqueueProjectWorkFollowUp,
  fetchProjectWorkFile,
  fetchProjectWorkGitEvidence,
  fetchProjectWorkGitCloseouts,
  fetchLegacyWorkspaceArchives,
  fetchProjectWorkConversation,
  fetchProjectWorkModels,
  fetchProjectWorkProviderConnections,
  fetchProjectWorkSkillCatalog,
  fetchProjectWorkTree,
  fetchProjectWorkConversationTurns,
  fetchModelUsage,
  fetchProjectWorkUsage,
  fetchProjectWorkWorkspace,
  forkProjectWorkCheckpoint,
  listProjectWorkAskUserRequests,
  listProjectWorkApplyJournal,
  listProjectWorkFollowUps,
  listStandaloneProjectWorkConversations,
  markProjectWorkConversationRead,
  mapProjectWorkConversation,
  mapProjectWorkUsage,
  projectWorkGeneratedImageUrl,
  projectWorkGeneratedOfficeDownloadUrl,
  projectWorkBrowserQaScreenshotUrl,
  projectWorkImageUrl,
  projectWorkLegacyMigrationPatchUrl,
  removeProjectWorkFollowUp,
  removeProjectWorkPdf,
  removeProjectWorkProviderCredential,
  renameProjectWorkConversation,
  registerProjectWorkProject,
  resumeProjectWorkVerificationRepair,
  retryProjectWorkLastTurn,
  retryProjectWorkCheckpoint,
  retryProjectWorkPdf,
  runProjectWorkBrowserQa,
  sendProjectWorkMessage,
  saveProjectWorkProviderApiKey,
  projectWorkDroppedFileKind,
  serializeProjectWorkAttachmentReference,
  serializeProjectWorkImage,
  setProjectWorkSkillEnabled,
  startProjectWorkPreview,
  subscribeProjectWorkConversation,
  undoProjectWorkApply,
  uploadProjectWorkPdf,
  uploadProjectWorkAttachment,
  fetchInstalledProjectWorkSkills,
  inspectProjectWorkSkillPackage,
  installProjectWorkSkillPackage,
  cleanupLegacyWorkspaceArchives,
} from "./projectWork.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("project registration omits the UI workspace selector", async () => {
  let request = null;
  const project = await registerProjectWorkProject({
    rootToken: "root-token-1",
    name: "  Existing project  ",
    newFolderName: "  New folder  ",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse({
        project: {
          id: "project-1",
          name: "Existing project",
          root_label: "Existing project",
        },
      }, 201);
    },
  });

  assert.equal(request.url, "/api/v1/project-work/projects");
  assert.equal(request.options.method, "POST");
  assert.deepEqual(JSON.parse(request.options.body), {
    schema_version: 1,
    root_token: "root-token-1",
    name: "Existing project",
    new_folder_name: "New folder",
  });
  assert.equal(project.id, "project-1");
});

test("provider credential API sends the key only in the save request", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    return jsonResponse({
      providers: [{
        id: "deepseek",
        name: "DeepSeek",
        api_key_supported: true,
        api_key_label: "DeepSeek API Key",
        configured: options.method !== "DELETE",
        configured_type: options.method !== "DELETE" ? "api_key" : null,
        configured_source: options.method !== "DELETE" ? "credential_store" : null,
        stored: options.method !== "DELETE",
        available_model_count: options.method !== "DELETE" ? 2 : 0,
      }],
    });
  };

  const initial = await fetchProjectWorkProviderConnections({ fetchImpl });
  assert.equal(initial[0].apiKeySupported, true);
  assert.equal(initial[0].availableModelCount, 2);

  const saved = await saveProjectWorkProviderApiKey({
    providerId: "deepseek/provider",
    apiKey: "secret-api-key",
    fetchImpl,
  });
  assert.equal(
    calls[1].url,
    "/api/v1/project-work/provider-connections/deepseek%2Fprovider",
  );
  assert.equal(calls[1].options.method, "PUT");
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    schema_version: 1,
    api_key: "secret-api-key",
  });
  assert.doesNotMatch(JSON.stringify(saved), /secret-api-key/);

  const removed = await removeProjectWorkProviderCredential({
    providerId: "deepseek/provider",
    fetchImpl,
  });
  assert.equal(calls[2].options.method, "DELETE");
  assert.equal(removed[0].stored, false);
  assert.doesNotMatch(JSON.stringify(removed), /secret-api-key/);
});

test("Skill catalog API preserves the inspect, confirm, and enable boundaries", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (String(url).includes("/skill-previews")) {
      return jsonResponse({
        preview_id: "skill-preview-1",
        preview_hash: `sha256:${"a".repeat(64)}`,
        name: "@scope/demo-skill",
        version: "1.2.3",
        source: "npm:@scope/demo-skill@1.2.3",
        integrity: "sha512-integrity",
        skill_files: ["skills/demo/SKILL.md"],
        skill_count: 1,
        archive_file_count: 2,
        archive_bytes: 2048,
        default_enabled: false,
        expires_at: "2026-07-28T08:10:00.000Z",
      });
    }
    if (String(url).endsWith("/skills/installed")) {
      return jsonResponse({
        revision: 2,
        packages: [{
          name: "@scope/demo-skill",
          version: "1.2.3",
          enabled: false,
          skill_count: 1,
          skill_files: ["skills/demo/SKILL.md"],
        }],
      });
    }
    if (options.method === "POST") {
      return jsonResponse({
        name: "@scope/demo-skill",
        version: "1.2.3",
        enabled: false,
        skill_count: 1,
      });
    }
    if (options.method === "PATCH") {
      return jsonResponse({
        name: "@scope/demo-skill",
        version: "1.2.3",
        enabled: true,
        skill_count: 1,
      });
    }
    return jsonResponse({
      source: "pi.dev",
      query: "paper reader",
      sort: "recent",
      packages: [{
        name: "@scope/demo-skill",
        version: "1.2.3",
        description: "Demo",
        types: ["skill"],
        install_supported: true,
        installed: false,
        enabled: false,
      }],
    });
  };

  const catalog = await fetchProjectWorkSkillCatalog({
    query: "paper reader",
    sort: "recent",
    fetchImpl,
  });
  assert.equal(
    calls[0].url,
    "/api/v1/project-work/skills?query=paper+reader&sort=recent",
  );
  assert.equal(catalog.packages[0].installSupported, true);

  const preview = await inspectProjectWorkSkillPackage({
    name: "@scope/demo-skill",
    version: "1.2.3",
    fetchImpl,
  });
  assert.equal(preview.defaultEnabled, false);
  assert.deepEqual(preview.skillFiles, ["skills/demo/SKILL.md"]);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    schema_version: 1,
    name: "@scope/demo-skill",
    version: "1.2.3",
  });

  const installed = await installProjectWorkSkillPackage({
    previewId: preview.previewId,
    previewHash: preview.previewHash,
    fetchImpl,
  });
  assert.equal(installed.enabled, false);
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    schema_version: 1,
    preview_id: "skill-preview-1",
    preview_hash: `sha256:${"a".repeat(64)}`,
  });

  const local = await fetchInstalledProjectWorkSkills({ fetchImpl });
  assert.equal(local.revision, 2);
  assert.equal(local.packages[0].enabled, false);

  const enabled = await setProjectWorkSkillEnabled({
    name: "@scope/demo-skill",
    enabled: true,
    fetchImpl,
  });
  assert.equal(
    calls[4].url,
    "/api/v1/project-work/skills/%40scope%2Fdemo-skill",
  );
  assert.equal(enabled.enabled, true);
});

test("conversation mapping preserves a ready, hash-bound change set", () => {
  const mapped = mapProjectWorkConversation({
    conversation: {
      id: "conversation-1",
      project_id: "project-1",
      runtime_schema_version: 1,
      lifecycle: "awaiting_review",
      title: "修复设置页",
      status: "awaiting_confirmation",
      has_more_turns: true,
      next_before_turn_seq: 21,
      execution_policy: {
        mode: "auto_review",
        revision: 3,
        policy_version: 1,
      },
      workspace_snapshot: {
        mode: "sparse_overlay",
        included_files: 7938,
        included_bytes: 100663296,
        truncated: true,
      },
      workspace: {
        id: "workspace-conversation-1",
        kind: "sparse_overlay",
        isolation: "review_overlay",
        recoverable_isolation: true,
        automatic_apply_allowed: false,
        status: "ready",
        revision: 3,
        created_at: "2026-07-27T10:00:00.000Z",
        updated_at: "2026-07-27T10:03:00.000Z",
      },
      apply_journal: [{
        id: "apply-1",
        status: "applied",
        change_set_id: "change-set-1",
        change_set_hash: "sha256:proposal",
        files: [{
          file_id: "change-file-1",
          path: "src/settings.css",
          base_hash: "sha256:before",
          after_hash: "sha256:after",
        }],
        finalized_at: "2026-07-27T10:03:00.000Z",
        undo: {
          status: "available",
          hash: "sha256:undo",
        },
      }],
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
      preview: {
        id: "preview-1",
        status: "ready",
        url: "http://127.0.0.1:48080/reader/",
        title: "读者端",
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
    }, {
      seq: 3,
      type: "preview.opened",
      data: {
        status: "ready",
        artifactId: "preview",
        detail: "已在系统默认浏览器打开本机预览",
      },
    }],
  });

  assert.equal(mapped.pendingChangeSet.status, "ready");
  assert.equal(mapped.runtimeSchemaVersion, 1);
  assert.equal(mapped.lifecycle, "awaiting_review");
  assert.equal(mapped.hasMoreTurns, true);
  assert.equal(mapped.nextBeforeTurnSeq, 21);
  assert.equal(mapped.pendingChangeSet.proposalHash, "sha256:proposal");
  assert.equal(mapped.pendingChangeFileCount, 1);
  assert.equal(mapped.pendingChangeSet.files[0].baseHash, "sha256:before");
  assert.equal(mapped.pendingChangeSet.files[0].afterHash, "sha256:after");
  assert.deepEqual(mapped.pendingChangeSet.files[0].diff.slice(-2), [
    "-position: fixed;",
    "+position: sticky;",
  ]);
  assert.equal(mapped.plan[0].title, "检查设置页布局");
  assert.deepEqual(mapped.events.map((event) => event.seq), [1, 2, 3]);
  assert.equal(mapped.events[1].toolName, "read");
  assert.equal(mapped.events[1].path, "src/settings.css");
  assert.equal(mapped.events[2].artifactId, "preview");
  assert.equal(
    mapped.events[2].detail,
    "已在系统默认浏览器打开本机预览",
  );
  assert.equal(mapped.preview.url, "http://127.0.0.1:48080/reader/");
  assert.deepEqual(mapped.workspaceSnapshot, {
    mode: "sparse_overlay",
    includedFiles: 7938,
    includedBytes: 100663296,
    truncated: true,
  });
  assert.deepEqual(mapped.workspace, {
    id: "workspace-conversation-1",
    kind: "sparse_overlay",
    isolation: "review_overlay",
    recoverableIsolation: true,
    automaticApplyAllowed: false,
    status: "ready",
    isMain: true,
    isGit: false,
    branch: null,
    head: null,
    dirty: false,
    revision: 3,
    createdAt: "2026-07-27T10:00:00.000Z",
    updatedAt: "2026-07-27T10:03:00.000Z",
  });
  assert.equal(mapped.applyJournal[0].status, "applied");
  assert.equal(mapped.applyJournal[0].files[0].path, "src/settings.css");
  assert.equal(mapped.applyJournal[0].undo.status, "available");
  assert.equal(mapped.applyJournal[0].undo.hash, "sha256:undo");
  assert.deepEqual(mapped.executionPolicy, {
    mode: "auto_review",
    revision: 3,
    policyVersion: 1,
  });
});

test("manual preview start client binds the preview id, request hash, and stable request id", async () => {
  const calls = [];
  const requestHash = `sha256:${"a".repeat(64)}`;
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return jsonResponse({
      conversation: {
        id: "conversation/preview",
        project_id: "project-1",
        status: "awaiting_confirmation",
        preview: {
          id: "preview/item",
          request_hash: requestHash,
          status: "ready",
          url: "http://127.0.0.1:48080/",
        },
      },
      events: [],
    });
  };

  const started = await startProjectWorkPreview({
    conversationId: "conversation/preview",
    previewId: "preview/item",
    requestHash,
    clientRequestId: "project-preview:confirm-1",
    fetchImpl,
  });

  assert.equal(
    calls[0].url,
    "/api/v1/project-work/conversations/conversation%2Fpreview/previews/preview%2Fitem/start",
  );
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    schema_version: 1,
    client_request_id: "project-preview:confirm-1",
    request_hash: requestHash,
  });
  assert.equal(started.preview.status, "ready");
  assert.equal(started.preview.url, "http://127.0.0.1:48080/");

  await assert.rejects(
    startProjectWorkPreview({
      conversationId: "conversation/preview",
      previewId: "preview/item",
      requestHash: "sha256:short",
      fetchImpl,
    }),
    /完整的 SHA-256/,
  );
  await assert.rejects(
    startProjectWorkPreview({
      conversationId: "conversation/preview",
      previewId: "preview/item",
      requestHash,
      clientRequestId: "invalid request id",
      fetchImpl,
    }),
    /clientRequestId 格式无效/,
  );
  assert.equal(calls.length, 1);
});

test("manual preview start client preserves server error codes and retry metadata", async () => {
  const requestHash = `sha256:${"b".repeat(64)}`;
  await assert.rejects(
    startProjectWorkPreview({
      conversationId: "conversation-1",
      previewId: "preview-1",
      requestHash,
      clientRequestId: "project-preview:stale-1",
      fetchImpl: async () => jsonResponse({
        error: {
          code: "PROJECT_WORK_PREVIEW_STALE",
          message: "本机预览请求已变化，请重新核对后确认",
          retryable: true,
          details: {
            expected_hash: requestHash,
          },
        },
      }, 409),
    }),
    (error) => {
      assert.equal(error.name, "ProjectWorkApiError");
      assert.equal(error.code, "PROJECT_WORK_PREVIEW_STALE");
      assert.equal(error.status, 409);
      assert.equal(error.retryable, true);
      assert.deepEqual(error.details, {
        expected_hash: requestHash,
      });
      return true;
    },
  );
});

test("workspace, Git evidence, apply history, and undo use safe scoped routes", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/workspace")) {
      return jsonResponse({
        workspace: {
          id: "workspace-1",
          kind: "sparse_overlay",
          isolation: "review_overlay",
          status: "recovering",
          revision: 2,
        },
      });
    }
    if (url.endsWith("/git-evidence")) {
      return jsonResponse({
        git: {
          available: true,
          branch: "codex/runtime",
          head: "abcdef123456",
          staged: ["src/a.js", "/Users/example/private.txt"],
          unstaged: ["src/b.js"],
          untracked: ["notes/new.md", "../outside.txt"],
          truncated: false,
        },
      });
    }
    if (url.endsWith("/applies")) {
      return jsonResponse({
        applies: [{
          id: "apply-1",
          status: "applied",
          files: [{ fileId: "file-1", path: "src/a.js" }],
          undo: { status: "available", hash: "sha256:undo" },
        }],
      });
    }
    return jsonResponse({
      conversation: {
        id: "conversation/1",
        project_id: "project-1",
        workspace: {
          id: "workspace-1",
          kind: "sparse_overlay",
          isolation: "review_overlay",
          status: "ready",
        },
        applyJournal: [{
          id: "apply-1",
          status: "undone",
          files: [{ fileId: "file-1", path: "src/a.js" }],
          undo: { status: "used", hash: "sha256:undo" },
        }],
      },
      events: [],
    });
  };

  const workspace = await fetchProjectWorkWorkspace({
    conversationId: "conversation/1",
    fetchImpl,
  });
  const git = await fetchProjectWorkGitEvidence({
    conversationId: "conversation/1",
    fetchImpl,
  });
  const applies = await listProjectWorkApplyJournal({
    conversationId: "conversation/1",
    fetchImpl,
  });
  const undone = await undoProjectWorkApply({
    conversationId: "conversation/1",
    applyId: "apply/1",
    undoHash: "sha256:undo",
    fetchImpl,
  });

  assert.equal(workspace.status, "recovering");
  assert.deepEqual(git.staged, ["src/a.js"]);
  assert.deepEqual(git.untracked, ["notes/new.md"]);
  assert.equal(applies[0].undo.status, "available");
  assert.equal(undone.applyJournal[0].status, "undone");
  assert.deepEqual(calls.map((call) => call.url), [
    "/api/v1/project-work/conversations/conversation%2F1/workspace",
    "/api/v1/project-work/conversations/conversation%2F1/git-evidence",
    "/api/v1/project-work/conversations/conversation%2F1/applies",
    "/api/v1/project-work/conversations/conversation%2F1/applies/apply%2F1/undo",
  ]);
  assert.equal(calls[3].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[3].options.body), {
    schema_version: 1,
    undo_hash: "sha256:undo",
  });
});

test("Git closeout client preserves conversation, turn, and change-set bindings", async () => {
  const calls = [];
  const proposal = {
    id: "git-closeout-1",
    conversationId: "conversation-1",
    turnId: "turn-1",
    changeSetId: "changes-1",
    changeSetHash: `sha256:${"c".repeat(64)}`,
    status: "ready",
    proposalHash: `sha256:${"a".repeat(64)}`,
    branch: "main",
    head: "b".repeat(40),
    commitMessage: "fix: exact",
    files: [{
      path: "src/app.js",
      hash: `sha256:${"f".repeat(64)}`,
      exists: true,
      mode: 0o644,
      baseHash: `sha256:${"0".repeat(64)}`,
      baseExists: true,
      baseMode: 0o644,
    }],
    verificationEvidence: [{
      id: "verification-1",
      commandId: "command-1",
      status: "passed",
      exitCode: 0,
      changeSetId: "changes-1",
      changeSetHash: `sha256:${"c".repeat(64)}`,
      commandBindingHash: `sha256:${"d".repeat(64)}`,
      completedAt: "2026-07-30T08:00:00.000Z",
    }],
  };
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if ((options.method ?? "GET") === "GET") {
      return jsonResponse({
        git_closeouts: [{
          proposal_id: proposal.id,
          conversation_id: proposal.conversationId,
          turn_id: proposal.turnId,
          change_set_id: proposal.changeSetId,
          change_set_hash: proposal.changeSetHash,
          status: proposal.status,
          proposal_hash: proposal.proposalHash,
          branch: proposal.branch,
          head: proposal.head,
          commit_message: proposal.commitMessage,
          files: proposal.files.map((file) => ({
            path: file.path,
            hash: file.hash,
            exists: file.exists,
            mode: file.mode,
            base_hash: file.baseHash,
            base_exists: file.baseExists,
            base_mode: file.baseMode,
          })),
          verification_evidence: proposal.verificationEvidence,
        }],
      });
    }
    return jsonResponse({
      conversation: {
        id: "conversation-1",
        project_id: "project-1",
        git_closeouts: [],
      },
      events: [],
    });
  };

  const [mapped] = await fetchProjectWorkGitCloseouts({
    conversationId: "conversation-1",
    fetchImpl,
  });
  assert.equal(mapped.conversationId, "conversation-1");
  assert.equal(mapped.turnId, "turn-1");
  assert.equal(mapped.changeSetId, "changes-1");
  assert.equal(mapped.changeSetHash, proposal.changeSetHash);
  assert.equal(mapped.files[0].baseHash, proposal.files[0].baseHash);
  await confirmProjectWorkGitCloseout({
    conversationId: "conversation-1",
    proposal,
    fetchImpl,
  });
  const body = JSON.parse(calls[1].options.body);
  assert.deepEqual({
    conversationId: body.conversation_id,
    turnId: body.turn_id,
    changeSetId: body.change_set_id,
    changeSetHash: body.change_set_hash,
  }, {
    conversationId: "conversation-1",
    turnId: "turn-1",
    changeSetId: "changes-1",
    changeSetHash: proposal.changeSetHash,
  });
  assert.deepEqual(body.files[0], {
    path: "src/app.js",
    hash: proposal.files[0].hash,
    exists: true,
    mode: 0o644,
    base_hash: proposal.files[0].baseHash,
    base_exists: true,
    base_mode: 0o644,
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
  assert.deepEqual(mapped.plan, []);
  assert.deepEqual(mapped.executionPolicy, {
    mode: "manual_review",
    revision: 0,
    policyVersion: 1,
  });
});

test("conversation mapping preserves durable questions and follow-up queue state", () => {
  const mapped = mapProjectWorkConversation({
    conversation: {
      id: "conversation-control-plane",
      project_id: "project-1",
      status: "awaiting_user",
      follow_up_queue: [{
        id: "follow-up-1",
        message_id: "message-2",
        text: "当前检查结束后再运行类型检查",
        status: "queued",
        created_at: "2026-07-27T10:00:00.000Z",
      }],
      ask_user_requests: [{
        id: "ask-user-1",
        status: "pending",
        source: "model_tool",
        resume_status: "running",
        questions: [{
          id: "scope",
          label: "修改范围",
          prompt: "需要同时处理测试文件吗？",
          kind: "single_choice",
          required: true,
          options: [{
            id: "yes",
            label: "同时处理",
            description: "代码和测试一起修改",
          }, {
            id: "no",
            label: "只改代码",
          }],
        }, {
          id: "notes",
          prompt: "还有什么限制？",
          kind: "text",
          required: false,
        }],
      }],
    },
  });

  assert.equal(mapped.followUpQueue.length, 1);
  assert.deepEqual(mapped.followUpQueue[0], {
    id: "follow-up-1",
    messageId: "message-2",
    text: "当前检查结束后再运行类型检查",
    status: "queued",
    createdAt: "2026-07-27T10:00:00.000Z",
    deliveredAt: null,
    cancelledAt: null,
    failedAt: null,
  });
  assert.equal(mapped.askUserRequests[0].source, "model_tool");
  assert.equal(mapped.askUserRequests[0].questions[0].kind, "single_choice");
  assert.equal(mapped.askUserRequests[0].questions[0].options[0].id, "yes");
  assert.equal(mapped.askUserRequests[0].questions[1].required, false);
});

test("project-work subscription resumes after seq and maps incremental snapshots", () => {
  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      this.closed = false;
    }

    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }

    removeEventListener(type) {
      this.listeners.delete(type);
    }

    close() {
      this.closed = true;
    }

    emit(type, payload) {
      this.listeners.get(type)?.(payload);
    }
  }

  let source;
  const snapshots = [];
  const errors = [];
  const unsubscribe = subscribeProjectWorkConversation({
    conversationId: "conversation/control",
    afterSeq: 4,
    eventSourceFactory: class extends FakeEventSource {
      constructor(url) {
        super(url);
        source = this;
      }
    },
    onConversation: (conversation, metadata) => {
      snapshots.push({ conversation, metadata });
    },
    onError: (error) => errors.push(error),
  });

  assert.equal(
    source.url,
    "/api/v1/project-work/conversations/conversation%2Fcontrol/events?after_seq=4",
  );
  source.emit("snapshot", {
    data: JSON.stringify({
      schema_version: 1,
      snapshot_watermark: 10,
      last_seq: 10,
      conversation: {
        id: "conversation/control",
        project_id: "project-1",
        status: "awaiting_user",
        last_event_seq: 10,
        ask_user_requests: [{
          id: "ask-user-1",
          status: "pending",
          questions: [],
        }],
      },
      events: [{
        seq: 7,
        type: "message.partial",
        data: {
          id: "message-stream-1",
          turn_id: "turn-1",
          text: "正在检查",
          revision: 1,
          replace: false,
        },
      }, {
        seq: 8,
        type: "message.partial",
        data: {
          messageId: "message-stream-1",
          turnId: "turn-1",
          text: "正在检查项目文件",
          revision: 2,
        },
      }, {
        seq: 9,
        type: "message.partial",
        data: {
          id: "message-stream-1",
          turn_id: "turn-1",
          text: { unsafe: true },
          revision: 3,
        },
      }, {
        seq: 10,
        type: "ask_user.requested",
        data: { id: "ask-user-1" },
      }],
    }),
  });
  assert.equal(snapshots[0].conversation.lastEventSeq, 10);
  assert.equal(snapshots[0].conversation.deliveredEventSeq, 10);
  assert.equal(snapshots[0].conversation.askUserRequests[0].status, "pending");
  assert.equal(snapshots[0].metadata.events[0].seq, 7);
  assert.equal(snapshots[0].metadata.snapshotWatermark, 10);
  assert.deepEqual(
    snapshots[0].conversation.events
      .filter((event) => event.type === "message.partial")
      .map((event) => ({
        seq: event.seq,
        messageId: event.messageId,
        turnId: event.turnId,
        text: event.text,
        revision: event.revision,
        replace: event.replace,
      })),
    [{
      seq: 7,
      messageId: "message-stream-1",
      turnId: "turn-1",
      text: "正在检查",
      revision: 1,
      replace: true,
    }, {
      seq: 8,
      messageId: "message-stream-1",
      turnId: "turn-1",
      text: "正在检查项目文件",
      revision: 2,
      replace: true,
    }, {
      seq: 9,
      messageId: "message-stream-1",
      turnId: "turn-1",
      text: "",
      revision: 3,
      replace: true,
    }],
  );

  source.emit("stream_error", {
    data: JSON.stringify({
      code: "PROJECT_WORK_EVENT_STREAM_FAILED",
      message: "事件流暂时中断",
    }),
  });
  assert.equal(errors[0].code, "PROJECT_WORK_EVENT_STREAM_FAILED");
  unsubscribe();
  assert.equal(source.closed, true);
  assert.equal(source.listeners.size, 0);
});

test("conversation fetch keeps a bounded recent event window and resumes with deltas", async () => {
  const totalEvents = 10_501;
  const pageSize = 500;
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const afterSeq = totalEvents - pageSize;
    const events = Array.from(
      { length: pageSize },
      (_, index) => ({
        seq: afterSeq + index + 1,
        type: "agent.progress",
        data: { summary: `公开进展 ${afterSeq + index + 1}` },
      }),
    );
    return jsonResponse({
      conversation: {
        id: "conversation-long-history",
        project_id: "project-1",
        status: "completed",
        last_event_seq: totalEvents,
      },
      events,
      has_earlier_events: true,
      has_more_events: false,
    });
  };

  const fetched = await fetchProjectWorkConversation({
    conversationId: "conversation-long-history",
    fetchImpl,
  });

  assert.equal(calls.length, 1);
  assert.equal(fetched.lastEventSeq, totalEvents);
  assert.equal(fetched.deliveredEventSeq, totalEvents);
  assert.equal(fetched.hasEarlierEvents, true);
  assert.equal(fetched.hasMoreEvents, false);
  assert.equal(fetched.events.length, pageSize);

  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
    }

    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }

    removeEventListener(type) {
      this.listeners.delete(type);
    }

    close() {}

    emit(type, payload) {
      this.listeners.get(type)?.(payload);
    }
  }

  let source;
  const resumedEvents = [];
  const connectionStates = [];
  const resyncs = [];
  const errors = [];
  const unsubscribe = subscribeProjectWorkConversation({
    conversationId: fetched.id,
    afterSeq: fetched.deliveredEventSeq,
    eventSourceFactory: class extends FakeEventSource {
      constructor(url) {
        super(url);
        source = this;
      }
    },
    onEvent: (event) => resumedEvents.push(event),
    onConnectionState: (state) => connectionStates.push(state),
    onResync: (value) => resyncs.push(value),
    onError: (error) => errors.push(error),
  });

  assert.match(source.url, /after_seq=10501$/);
  source.emit("snapshot", {
    data: JSON.stringify({
      snapshot_watermark: totalEvents,
      last_seq: totalEvents,
      has_more: false,
      conversation: {
        id: fetched.id,
        project_id: "project-1",
        status: "completed",
        last_event_seq: totalEvents,
      },
      events: [],
    }),
  });
  source.emit("delta", {
    data: JSON.stringify({
      seq: totalEvents + 1,
      sessionId: fetched.id,
      type: "agent.progress",
      data: { summary: "继续工作" },
    }),
  });
  source.emit("delta", {
    data: JSON.stringify({
      seq: totalEvents + 2,
      sessionId: fetched.id,
      turnId: "turn-live",
      type: "message.delta",
      data: {
        id: "assistant-live",
        delta: "正在形成最终回答",
        revision: 3,
        contentIndex: 2,
        phase: "final_answer",
      },
    }),
  });
  source.emit("error", {});
  source.emit("resync_required", {
    data: JSON.stringify({
      reason: "event_gap",
      lastAvailableSeq: totalEvents + 3,
    }),
  });

  assert.deepEqual(
    resumedEvents.map((event) => event.seq),
    [totalEvents + 1, totalEvents + 2],
  );
  assert.equal(resumedEvents[1].messageId, "assistant-live");
  assert.equal(resumedEvents[1].turnId, "turn-live");
  assert.equal(resumedEvents[1].delta, "正在形成最终回答");
  assert.equal(resumedEvents[1].revision, 3);
  assert.equal(resumedEvents[1].contentIndex, 2);
  assert.equal(resumedEvents[1].phase, "final_answer");
  assert.equal(resumedEvents[1].replace, false);
  assert.deepEqual(
    connectionStates,
    ["connected", "connected", "connected", "reconnecting"],
  );
  assert.deepEqual(resyncs, [{
    reason: "event_gap",
    lastAvailableSeq: totalEvents + 3,
  }]);
  assert.equal(errors.length, 0);
  unsubscribe();
});

test("state-only conversation refresh skips historical activity", async () => {
  let requestedUrl = null;
  const conversation = await fetchProjectWorkConversation({
    conversationId: "conversation-refresh",
    includeActivity: false,
    fetchImpl: async (url) => {
      requestedUrl = url;
      return jsonResponse({
        conversation: {
          id: "conversation-refresh",
          project_id: "project-1",
          status: "running",
          last_event_seq: 42,
        },
        events: [],
        has_more_events: false,
      });
    },
  });

  assert.equal(
    requestedUrl,
    "/api/v1/project-work/conversations/conversation-refresh?activity=none",
  );
  assert.equal(conversation.deliveredEventSeq, 42);
  assert.deepEqual(conversation.events, []);
});

test("follow-up API distinguishes queue mutations from steer and keeps exact routes", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (options.method === "POST") {
      return jsonResponse({
        item: {
          id: "follow-up-1",
          message_id: "message-2",
          text: "完成当前检查后再跑测试",
          status: "queued",
        },
        snapshot: {
          id: "conversation/control",
          project_id: "project-1",
          status: "running",
          follow_up_queue: [{
            id: "follow-up-1",
            text: "完成当前检查后再跑测试",
            status: "queued",
          }],
        },
      }, 202);
    }
    if (options.method === "DELETE") {
      return jsonResponse({
        cancelled: [{
          id: url.endsWith("/follow-ups") ? "follow-up-all" : "follow-up/1",
          text: "已取消",
          status: "cancelled",
        }],
      });
    }
    return jsonResponse({
      items: [{
        id: "follow-up-history",
        text: "历史消息",
        status: "delivered",
      }],
    });
  };

  const listed = await listProjectWorkFollowUps({
    conversationId: "conversation/control",
    includeHistory: true,
    fetchImpl,
  });
  const enqueued = await enqueueProjectWorkFollowUp({
    conversationId: "conversation/control",
    text: "  完成当前检查后再跑测试  ",
    fetchImpl,
  });
  const removed = await removeProjectWorkFollowUp({
    conversationId: "conversation/control",
    itemId: "follow-up/1",
    fetchImpl,
  });
  const cleared = await clearProjectWorkFollowUps({
    conversationId: "conversation/control",
    fetchImpl,
  });

  assert.equal(
    calls[0].url,
    "/api/v1/project-work/conversations/conversation%2Fcontrol/follow-ups?include_history=true",
  );
  assert.equal(listed[0].status, "delivered");
  assert.equal(calls[1].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    schema_version: 1,
    text: "完成当前检查后再跑测试",
  });
  assert.equal(enqueued.item.id, "follow-up-1");
  assert.equal(enqueued.snapshot.followUpQueue[0].status, "queued");
  assert.equal(
    calls[2].url,
    "/api/v1/project-work/conversations/conversation%2Fcontrol/follow-ups/follow-up%2F1",
  );
  assert.equal(calls[2].options.method, "DELETE");
  assert.equal(removed[0].status, "cancelled");
  assert.equal(
    calls[3].url,
    "/api/v1/project-work/conversations/conversation%2Fcontrol/follow-ups",
  );
  assert.equal(cleared[0].id, "follow-up-all");
});

test("ask-user API maps choices and answers without treating them as approval", async () => {
  const calls = [];
  const pendingRequest = {
    id: "ask-user/1",
    status: "pending",
    source: "project_api",
    questions: [{
      id: "target",
      prompt: "选择目标",
      kind: "multiple_choice",
      required: true,
      options: [
        { id: "code", label: "代码" },
        { id: "tests", label: "测试" },
      ],
    }, {
      id: "note",
      prompt: "补充说明",
      kind: "text",
      required: false,
    }],
  };
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/questions?include_history=true")) {
      return jsonResponse({ requests: [pendingRequest] });
    }
    const cancelled = url.endsWith("/cancel");
    return jsonResponse({
      request: {
        ...pendingRequest,
        status: cancelled ? "cancelled" : "answered",
      },
      snapshot: {
        id: "conversation/control",
        project_id: "project-1",
        status: "idle",
        ask_user_requests: [{
          ...pendingRequest,
          status: cancelled ? "cancelled" : "answered",
        }],
      },
    });
  };

  const listed = await listProjectWorkAskUserRequests({
    conversationId: "conversation/control",
    includeHistory: true,
    fetchImpl,
  });
  const answered = await answerProjectWorkAskUserRequest({
    conversationId: "conversation/control",
    requestId: "ask-user/1",
    answers: [{
      questionId: "target",
      value: ["code", "tests"],
    }, {
      questionId: "note",
      value: "保持改动克制",
    }],
    fetchImpl,
  });
  const cancelled = await cancelProjectWorkAskUserRequest({
    conversationId: "conversation/control",
    requestId: "ask-user/1",
    fetchImpl,
  });

  assert.equal(listed[0].questions[0].kind, "multiple_choice");
  assert.equal(
    calls[0].url,
    "/api/v1/project-work/conversations/conversation%2Fcontrol/questions?include_history=true",
  );
  assert.equal(
    calls[1].url,
    "/api/v1/project-work/conversations/conversation%2Fcontrol/questions/ask-user%2F1/answer",
  );
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    schema_version: 1,
    answers: [{
      question_id: "target",
      value: ["code", "tests"],
    }, {
      question_id: "note",
      value: "保持改动克制",
    }],
  });
  assert.equal(answered.request.status, "answered");
  assert.equal(answered.snapshot.status, "idle");
  assert.equal(
    calls[2].url,
    "/api/v1/project-work/conversations/conversation%2Fcontrol/questions/ask-user%2F1/cancel",
  );
  assert.deepEqual(JSON.parse(calls[2].options.body), { schema_version: 1 });
  assert.equal(cancelled.request.status, "cancelled");
});

test("conversation mapping preserves blocked auto-review evidence", () => {
  const mapped = mapProjectWorkConversation({
    conversation: {
      id: "conversation-blocked",
      project_id: "project-1",
      activeChangeSet: {
        id: "change-set-blocked",
        status: "blocked",
        blocked_reason: "change_set_line_limit",
        blocked_at: "2026-07-27T10:00:00.000Z",
        files: [{
          id: "change-file-blocked",
          path: "src/app.js",
          operation: "modify",
          actionable: false,
        }],
      },
      verifications: [{
        id: "verification-blocked",
        status: "blocked",
        blocked_reason: "verification_isolation_unavailable",
        command: { file: "node", args: ["--test"], cwd: "" },
      }],
    },
  });

  assert.equal(mapped.pendingChangeSet.status, "blocked");
  assert.equal(mapped.pendingChangeSet.blockedReason, "change_set_line_limit");
  assert.equal(
    mapped.pendingChangeSet.blockedAt,
    "2026-07-27T10:00:00.000Z",
  );
  assert.equal(mapped.pendingChangeSet.files[0].actionable, false);
  assert.equal(
    mapped.verificationRuns[0].blockedReason,
    "verification_isolation_unavailable",
  );
  assert.equal(mapped.verificationCommand, null);
});

test("conversation mapping preserves retired verification provenance", () => {
  const mapped = mapProjectWorkConversation({
    id: "conversation-legacy-verification",
    project_id: "project-1",
    verifications: [{
      id: "legacy-attempt",
      command_id: "legacy-request",
      status: "legacy_superseded",
      legacy_status: "failed",
      error_code: "PROJECT_WORK_VERIFICATION_WORKSPACE_TOO_LARGE",
      superseded_at: "2026-08-03T00:00:00.000Z",
      command: "swift test",
    }],
  });

  assert.equal(mapped.verificationRuns[0].status, "legacy_superseded");
  assert.equal(mapped.verificationRuns[0].legacyStatus, "failed");
  assert.equal(
    mapped.verificationRuns[0].errorCode,
    "PROJECT_WORK_VERIFICATION_WORKSPACE_TOO_LARGE",
  );
  assert.equal(
    mapped.verificationRuns[0].supersededAt,
    "2026-08-03T00:00:00.000Z",
  );
  assert.equal(mapped.verificationCommand, null);
});

test("execution policy mutation is revision-bound and maps the returned policy", async () => {
  const nativeConversation = mapProjectWorkConversation({
    conversation: {
      id: "conversation-native-policy",
      project_id: "project-1",
      execution_policy: {
        mode: "native",
        revision: 1,
        policy_version: 1,
      },
      workspace_runs: [{
        id: "pi-shell-1",
        kind: "pi_shell",
        status: "succeeded",
        git_before: {
          available: true,
          branch: "main",
          head: "a".repeat(40),
          staged: [],
          unstaged: [],
          untracked: [],
          truncated: false,
        },
        git_after: {
          available: true,
          branch: "main",
          head: "a".repeat(40),
          staged: [],
          unstaged: ["src/app.js"],
          untracked: [],
          truncated: false,
        },
      }],
    },
  });
  assert.equal(nativeConversation.executionPolicy.mode, "native");
  assert.deepEqual(nativeConversation.workspaceRuns[0].gitBefore.unstaged, []);
  assert.deepEqual(
    nativeConversation.workspaceRuns[0].gitAfter.unstaged,
    ["src/app.js"],
  );
  const mappedEvent = mapProjectWorkConversation({
    conversation: {
      id: "conversation-policy-event",
      project_id: "project-1",
    },
    events: [{
      seq: 1,
      type: "auto_review.decision",
      data: {
        decision: "deny",
        reasonCode: "verification_command_not_auto_safe",
      },
    }],
  }).events[0];
  assert.equal(mappedEvent.decision, "deny");
  assert.equal(
    mappedEvent.reasonCode,
    "verification_command_not_auto_safe",
  );

  const calls = [];
  const snapshot = await configureProjectWorkExecutionPolicy({
    conversationId: "conversation/permissions",
    mode: "auto_review",
    expectedRevision: 4,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        conversation: {
          id: "conversation/permissions",
          project_id: "project-1",
          execution_policy: {
            mode: "auto_review",
            revision: 5,
            policy_version: 1,
          },
        },
      });
    },
  });

  assert.equal(
    calls[0].url,
    "/api/v1/project-work/conversations/conversation%2Fpermissions/execution-policy",
  );
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    schema_version: 1,
    mode: "auto_review",
    expected_revision: 4,
  });
  assert.deepEqual(snapshot.executionPolicy, {
    mode: "auto_review",
    revision: 5,
    policyVersion: 1,
  });

  await assert.rejects(
    configureProjectWorkExecutionPolicy({
      conversationId: "conversation-1",
      mode: "full_access",
      expectedRevision: 5,
    }),
    /manual_review 或 auto_review/,
  );
  await assert.rejects(
    configureProjectWorkExecutionPolicy({
      conversationId: "conversation-1",
      mode: "auto_review",
      expectedRevision: 0,
    }),
    /expectedRevision 必须是正整数/,
  );
});

test("conversation mapping keeps only safe PDF document state", () => {
  const mapped = mapProjectWorkConversation({
    conversation: {
      id: "conversation-documents",
      project_id: "project-1",
      documents: [{
        id: "document-1",
        file_name: "开发手册.pdf",
        byte_length: 1024,
        status: "parsing",
        parser: "MinerU Cloud v4",
        parser_state: "running",
        batch_id: "private-batch",
        source_path: "/private/source.pdf",
        error: {
          code: "MINERU_POLL_TIMEOUT",
          message: "MinerU 解析 PDF 等待超时，可以重试",
          retryable: true,
        },
      }],
    },
  });

  assert.deepEqual(mapped.documents, [{
    id: "document-1",
    fileName: "开发手册.pdf",
    byteLength: 1024,
    status: "parsing",
    parser: "MinerU Cloud v4",
    parserState: "running",
    sha256: null,
    revision: null,
    title: null,
    blockCount: null,
    imageCount: null,
    error: {
      code: "MINERU_POLL_TIMEOUT",
      message: "资料解析 等待超时，可以重试",
      retryable: true,
    },
    createdAt: null,
    updatedAt: null,
    readyAt: null,
  }]);
  assert.equal("batchId" in mapped.documents[0], false);
  assert.equal("sourcePath" in mapped.documents[0], false);
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
          supports_thinking: true,
          supports_images: true,
          thinking_levels: ["low", "medium", "high"],
          default_thinking_level: "medium",
          billing_kind: "api",
          pricing: {
            currency: "USD",
            unit: "per_million_tokens",
            source: "pi_model_catalog",
            version: "0.82.1",
            input: 0.5,
            output: 2,
            cache_read: 0.05,
            cache_write: 0.6,
            tiers: [],
          },
        }],
      }],
      default_provider_id: "deepseek",
      default_model_id: "deepseek-v4-flash",
      default_thinking_level: "medium",
      capabilities: {
        web_search: { available: false, reason: "Tavily 尚未配置" },
      },
    }),
  });

  assert.equal(catalog.providers[0].models[0].contextWindow, 131_072);
  assert.equal(catalog.providers[0].models[0].supportsImages, true);
  assert.deepEqual(catalog.providers[0].models[0].thinkingLevels, [
    "low",
    "medium",
    "high",
  ]);
  assert.equal(catalog.providers[0].models[0].defaultThinkingLevel, "medium");
  assert.equal(catalog.providers[0].models[0].billingKind, "api");
  assert.equal(catalog.providers[0].models[0].pricing.cacheRead, 0.05);
  assert.equal(catalog.defaultThinkingLevel, "medium");
  assert.equal(catalog.capabilities.web_search.available, false);
});

test("project-work usage maps safe aggregates and requests the selected period", async () => {
  const calls = [];
  const payload = {
    scope: "retained_conversations",
    workflow_scope: "project_work",
    cost_semantics: "api_equivalent_estimate",
    period: "7d",
    period_start: "2026-07-22T00:00:00.000Z",
    period_end: "2026-07-28T12:00:00.000Z",
    quota: {
      available: false,
      detail: "账户剩余额度不可获取",
    },
    totals: {
      calls: 3,
      tasks: 2,
      conversations: 1,
      input_tokens: 100,
      output_tokens: 20,
      cache_read_tokens: 30,
      cache_write_tokens: 0,
      total_tokens: 150,
      api_equivalent_cost_usd: 0.25,
      priced_call_count: 2,
      unpriced_call_count: 1,
    },
    coverage: {
      conversations_scanned: 2,
      legacy_messages_without_usage: 1,
      undated_assistant_messages: 0,
      included_kinds: ["assistant_model_response"],
      excluded_kinds: ["compaction"],
    },
    models: [{
      provider_id: "openai-codex",
      provider_name: "GPT · ChatGPT 订阅",
      model_id: "gpt-5.6-sol",
      model_name: "GPT-5.6 Sol",
      billing_kind: "chatgpt_subscription",
      calls: 3,
      tasks: 2,
      conversations: 1,
      input_tokens: 100,
      output_tokens: 20,
      cache_read_tokens: 30,
      cache_write_tokens: 0,
      total_tokens: 150,
      api_equivalent_cost_usd: 0.25,
      priced_call_count: 2,
      unpriced_call_count: 1,
      current_pricing: {
        currency: "USD",
        unit: "per_million_tokens",
        input: 5,
        output: 30,
        cache_read: 0.5,
        cache_write: 6.25,
        tiers: [{
          input_tokens_above: 272_000,
          input: 10,
          output: 45,
          cache_read: 1,
          cache_write: 12.5,
        }],
      },
    }],
  };
  const fetchImpl = async (url) => {
    calls.push(url);
    return jsonResponse(payload);
  };

  const usage = await fetchProjectWorkUsage({ period: "7d", fetchImpl });
  assert.equal(calls[0], "/api/v1/project-work/usage?period=7d");
  assert.equal(usage.totals.totalTokens, 150);
  assert.equal(usage.totals.apiEquivalentCostUsd, 0.25);
  assert.equal(usage.models[0].billingKind, "chatgpt_subscription");
  assert.equal(usage.models[0].currentPricing.tiers[0].inputTokensAbove, 272_000);
  assert.equal(usage.quota.available, false);
  assert.deepEqual(usage.coverage.excludedKinds, ["compaction"]);
  assert.deepEqual(mapProjectWorkUsage(null).models, []);

  await assert.rejects(
    fetchProjectWorkUsage({ period: "quarter", fetchImpl }),
    /时间范围无效/,
  );
});

test("unified model usage requests the selected workflow and maps paper coverage", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return jsonResponse({
      scope: "local_model_usage",
      workflow_scope: "paper_reading",
      period: "all",
      totals: {
        calls: 97,
        tasks: 6,
        total_tokens: 660_108,
        api_equivalent_cost_usd: 0.07809,
        priced_call_count: 63,
        unpriced_call_count: 34,
        historical_backfilled_call_count: 63,
      },
      coverage: {
        historical_lower_bound: true,
        historical_backfilled_call_count: 63,
        historical_test_call_count: 4,
        legacy_translation_artifacts_without_usage: 2,
        access_issues: [{
          workflow_scope: "project_work",
          code: "PROJECT_USAGE_UNAVAILABLE",
          message: "正常工作用量暂时无法读取",
        }],
      },
      models: [{
        workflow_scope: "paper_reading",
        provider_id: "deepseek",
        provider_name: "DeepSeek API",
        model_id: "deepseek-v4-pro",
        model_name: "DeepSeek V4 Pro",
        billing_kind: "api",
        calls: 62,
        total_tokens: 241_690,
        historical_backfilled_call_count: 62,
        step_breakdown: [
          { step: "paper_agent", calls: 58 },
          { step: "candidate_summaries", calls: 4 },
        ],
      }],
    });
  };

  const usage = await fetchModelUsage({
    period: "all",
    workflow: "paper_reading",
    fetchImpl,
  });

  assert.equal(
    calls[0],
    "/api/v1/model-usage?period=all&workflow=paper_reading",
  );
  assert.equal(usage.workflowScope, "paper_reading");
  assert.equal(usage.coverage.historicalLowerBound, true);
  assert.equal(usage.coverage.historicalTestCallCount, 4);
  assert.equal(usage.coverage.legacyTranslationArtifactsWithoutUsage, 2);
  assert.equal(usage.coverage.accessIssues[0].workflowScope, "project_work");
  assert.equal(usage.models[0].workflowScope, "paper_reading");
  assert.deepEqual(usage.models[0].stepBreakdown, [
    { step: "paper_agent", calls: 58 },
    { step: "candidate_summaries", calls: 4 },
  ]);

  await assert.rejects(
    fetchModelUsage({ workflow: "invalid", fetchImpl }),
    /工作类型无效/,
  );
});

test("thinking level maps in conversation messages and uses snake-case mutation payloads", async () => {
  const mapped = mapProjectWorkConversation({
    conversation: {
      id: "conversation-thinking",
      project_id: "project-1",
      provider_id: "openai-codex",
      model_id: "gpt-5.3-codex",
      thinking_level: "high",
      messages: [{
        id: "message-1",
        role: "assistant",
        text: "完成",
        provider_id: "openai-codex",
        model_id: "gpt-5.3-codex",
        thinking_level: "high",
      }],
    },
    events: [{
      seq: 1,
      type: "turn.started",
      data: {
        providerId: "openai-codex",
        modelId: "gpt-5.3-codex",
        thinkingLevel: "high",
        turnId: "turn-1",
        turnSeq: 1,
        attempt: 2,
      },
    }],
  });
  assert.equal(mapped.thinkingLevel, "high");
  assert.equal(mapped.messages[0].thinkingLevel, "high");
  assert.equal(mapped.events[0].thinkingLevel, "high");
  assert.equal(mapped.events[0].turnId, "turn-1");
  assert.equal(mapped.events[0].turnSeq, 1);
  assert.equal(mapped.events[0].attempt, 2);

  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return jsonResponse({
      conversation: {
        id: "conversation-thinking",
        project_id: "project-1",
        thinking_level: "high",
      },
    });
  };
  await configureProjectWorkConversation({
    conversationId: "conversation-thinking",
    providerId: "openai-codex",
    modelId: "gpt-5.3-codex",
    thinkingLevel: "high",
    fetchImpl,
  });
  await sendProjectWorkMessage({
    conversationId: "conversation-thinking",
    text: "检查项目",
    checkpointId: "checkpoint-parent-1",
    clientRequestId: "project-message:test-thinking",
    workflowId: "code_review",
    capabilities: ["web_search"],
    images: [new File(
      [new Uint8Array([0x89, 0x50, 0x4e, 0x47])],
      "界面.png",
      { type: "image/png" },
    )],
    attachments: [{
      id: "attachment-review",
      revision: `sha256:${"a".repeat(64)}`,
    }],
    providerId: "openai-codex",
    modelId: "gpt-5.3-codex",
    thinkingLevel: "high",
    fetchImpl,
  });

  assert.equal(
    calls[0].url,
    "/api/v1/project-work/conversations/conversation-thinking/configuration",
  );
  assert.equal(JSON.parse(calls[0].options.body).thinking_level, "high");
  assert.equal(
    calls[1].url,
    "/api/v1/project-work/conversations/conversation-thinking/messages",
  );
  const messagePayload = JSON.parse(calls[1].options.body);
  assert.deepEqual(messagePayload, {
    schema_version: 1,
    client_request_id: "project-message:test-thinking",
    text: "检查项目",
    checkpoint_message_id: "checkpoint-parent-1",
    images: [{
      file_name: "界面.png",
      mime_type: "image/png",
      byte_length: 4,
      data: "iVBORw==",
    }],
    attachments: [{
      attachment_id: "attachment-review",
      attachment_revision: `sha256:${"a".repeat(64)}`,
    }],
    capabilities: ["web_search"],
    workflow_id: "code_review",
    contexts: [],
    provider_id: "openai-codex",
    model_id: "gpt-5.3-codex",
    thinking_level: "high",
  });
});

test("session branch metadata maps through the public contract without Pi entry ids", () => {
  const mapped = mapProjectWorkConversation({
    conversation: {
      id: "conversation-branch",
      project_id: "project-1",
      active_branch_id: "branch-deepseek",
      active_branch_label: "DeepSeek 方案",
      piEntryId: "private-conversation-entry",
      messages: [{
        id: "message-branch-answer",
        role: "assistant",
        text: "分支回答",
        checkpoint_id: "checkpoint-2",
        parent_checkpoint_id: "checkpoint-1",
        branch_id: "branch-deepseek",
        branch_label: "DeepSeek 方案",
        branch_from_checkpoint_id: "checkpoint-1",
        inherited: true,
        pi_entry_id: "private-message-entry",
      }],
      session_path: {
        active_leaf_checkpoint_id: "checkpoint-2",
        checkpoints: [{
          id: "checkpoint-2",
          parent_id: "checkpoint-1",
          turn_id: "turn-2",
          turn_seq: 2,
          user_message_id: "message-user-2",
          assistant_message_id: "message-branch-answer",
          attempt: 2,
          provider_id: "deepseek",
          model_id: "deepseek-v4-pro",
          thinking_level: "high",
          status: "completed",
          title: "DeepSeek 方案",
          branchable: true,
          blocked_reason: null,
          created_at: "2026-08-01T00:00:00.000Z",
          piEntryId: "private-checkpoint-entry",
        }],
        piEntryId: "private-path-entry",
      },
      fork: {
        source_conversation_id: "conversation-source",
        source_checkpoint_id: "checkpoint-1",
        source_assistant_message_id: "message-source-answer",
        status: "ready",
        context_mode: "pi_native_path",
        project_files: "current",
        created_at: "2026-08-01T00:01:00.000Z",
        piEntryId: "private-fork-entry",
      },
    },
  });

  assert.deepEqual(mapped.messages[0], {
    id: "message-branch-answer",
    role: "assistant",
    kind: "message",
    content: "分支回答",
    images: [],
    attachments: [],
    workflowId: null,
    capabilities: [],
    codeEvidence: [],
    providerId: null,
    modelId: null,
    thinkingLevel: null,
    messageSeq: null,
    turnId: null,
    turnSeq: null,
    attempt: null,
    checkpointId: "checkpoint-2",
    parentCheckpointId: "checkpoint-1",
    branchId: "branch-deepseek",
    branchLabel: "DeepSeek 方案",
    branchFromCheckpointId: "checkpoint-1",
    inherited: true,
    isFinal: true,
    retryOperationId: null,
    verificationRepairOperationId: null,
    repairAttempt: null,
    turnEvidence: null,
    createdAt: null,
    status: "completed",
  });
  assert.equal(mapped.activeBranchId, "branch-deepseek");
  assert.equal(mapped.activeBranchLabel, "DeepSeek 方案");
  assert.deepEqual(mapped.sessionPath, {
    activeLeafCheckpointId: "checkpoint-2",
    checkpoints: [{
      id: "checkpoint-2",
      parentId: "checkpoint-1",
      turnId: "turn-2",
      turnSeq: 2,
      userMessageId: "message-user-2",
      assistantMessageId: "message-branch-answer",
      attempt: 2,
      providerId: "deepseek",
      modelId: "deepseek-v4-pro",
      thinkingLevel: "high",
      status: "completed",
      title: "DeepSeek 方案",
      branchable: true,
      blockedReason: null,
      createdAt: "2026-08-01T00:00:00.000Z",
    }],
  });
  assert.deepEqual(mapped.fork, {
    sourceConversationId: "conversation-source",
    sourceCheckpointId: "checkpoint-1",
    sourceAssistantMessageId: "message-source-answer",
    status: "ready",
    contextMode: "pi_native_path",
    projectFiles: "current",
    createdAt: "2026-08-01T00:01:00.000Z",
  });
  assert.equal("piEntryId" in mapped, false);
  assert.equal("piEntryId" in mapped.messages[0], false);
  assert.equal("piEntryId" in mapped.sessionPath, false);
  assert.equal("piEntryId" in mapped.sessionPath.checkpoints[0], false);
  assert.equal("piEntryId" in mapped.fork, false);
});

test("project-work image serialization keeps only bounded image data", async () => {
  const serialized = await serializeProjectWorkImage(new File(
    [new Uint8Array([0xff, 0xd8, 0xff, 0xd9])],
    "screenshot.jpg",
    { type: "image/jpeg" },
  ));
  assert.deepEqual(serialized, {
    file_name: "screenshot.jpg",
    mime_type: "image/jpeg",
    byte_length: 4,
    data: "/9j/2Q==",
  });
  const finderPng = await serializeProjectWorkImage(new File(
    [new Uint8Array([0x89, 0x50, 0x4e, 0x47])],
    "finder-screen.png",
  ));
  assert.equal(finderPng.mime_type, "image/png");
  await assert.rejects(
    serializeProjectWorkImage(new File(["<svg/>"], "unsafe.svg", {
      type: "image/svg+xml",
    })),
    /PNG、JPEG 或 WebP/,
  );
});

test("project-work dropped files route PDF, image, and content-sniffed text safely", async () => {
  const markdown = new File(["# Notes"], "notes.md", { type: "text/markdown" });
  assert.equal(projectWorkDroppedFileKind(markdown), "text");
  assert.equal(
    projectWorkDroppedFileKind(new File([
      '<?xml version="1.0"?><mxfile compressed="false"></mxfile>',
    ], "机制图.drawio")),
    "text",
  );
  assert.equal(
    projectWorkDroppedFileKind(new File(["pdf"], "paper.pdf", {
      type: "application/pdf",
    })),
    "pdf",
  );
  assert.equal(
    projectWorkDroppedFileKind(new File(["png"], "screen.png", {
      type: "image/png",
    })),
    "image",
  );
  assert.equal(
    projectWorkDroppedFileKind(new File(["png"], "finder-screen.png")),
    "image",
  );
  assert.equal(
    projectWorkDroppedFileKind(new File(["zip"], "archive.zip", {
      type: "application/zip",
    })),
    "text",
  );
  assert.equal(
    projectWorkDroppedFileKind(new File(["PK"], "report.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    })),
    "text",
  );
  assert.equal(
    projectWorkDroppedFileKind(new File(["PK"], "data.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    })),
    "text",
  );
  assert.equal(
    projectWorkDroppedFileKind(new File(["TOKEN=secret"], ".env.local", {
      type: "text/plain",
    })),
    "unsupported",
  );
  assert.deepEqual(serializeProjectWorkAttachmentReference({
    id: "attachment-notes",
    revision: `sha256:${"b".repeat(64)}`,
  }), {
    attachment_id: "attachment-notes",
    attachment_revision: `sha256:${"b".repeat(64)}`,
  });
});

test("ordinary attachment upload keeps bytes out of JSON and returns a safe reference", async () => {
  const calls = [];
  const revision = `sha256:${"c".repeat(64)}`;
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (options.method === "POST") {
      return jsonResponse({
        attachment: {
          id: "attachment-upload",
          file_name: "notes.md",
          mime_type: "text/markdown",
          byte_length: 7,
          status: "awaiting_upload",
        },
      }, 201);
    }
    assert.equal(options.method, "PUT");
    assert.equal(options.body instanceof File, true);
    return jsonResponse({
      attachment: {
        id: "attachment-upload",
        file_name: "notes.md",
        mime_type: "text/markdown",
        detected_mime_type: "text/markdown",
        content_kind: "markdown",
        reading_hint: "按 Markdown 标题与段落读取。",
        representation: "source",
        byte_length: 7,
        status: "ready",
        revision,
      },
    }, 201);
  };

  const attachment = await uploadProjectWorkAttachment({
    conversationId: "conversation-upload",
    file: new File(["# Notes"], "notes.md", { type: "text/markdown" }),
    fetchImpl,
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    schema_version: 1,
    file_name: "notes.md",
    mime_type: "text/markdown",
    byte_length: 7,
  });
  assert.doesNotMatch(calls[0].options.body, /# Notes/);
  assert.equal(
    calls[1].url,
    "/api/v1/project-work/conversations/conversation-upload/attachments/attachment-upload/content",
  );
  assert.equal(attachment.id, "attachment-upload");
  assert.equal(attachment.revision, revision);
  assert.equal(attachment.detectedMimeType, "text/markdown");
  assert.equal(attachment.contentKind, "markdown");
  assert.equal(attachment.readingHint, "按 Markdown 标题与段落读取。");
  assert.equal(attachment.representation, "source");
});

test("unknown-suffix Draw.io upload stays byte-only and exposes detected structure", async () => {
  const calls = [];
  const revision = `sha256:${"d".repeat(64)}`;
  const source = '<?xml version="1.0"?><mxfile compressed="false"><diagram name="机制图"/></mxfile>';
  const file = new File([source], "机制图.drawio");
  const attachment = await uploadProjectWorkAttachment({
    conversationId: "conversation-drawio",
    file,
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (options.method === "POST") {
        return jsonResponse({
          attachment: {
            id: "attachment-drawio",
            file_name: file.name,
            mime_type: "text/plain",
            byte_length: file.size,
            status: "awaiting_upload",
          },
        }, 201);
      }
      return jsonResponse({
        attachment: {
          id: "attachment-drawio",
          file_name: file.name,
          mime_type: "text/plain",
          detected_mime_type: "application/xml",
          content_kind: "drawio_xml",
          reading_hint: "按图名、节点、连线与几何信息读取。",
          representation: "drawio_projection",
          projection_line_count: 3,
          byte_length: file.size,
          status: "ready",
          revision,
        },
      }, 201);
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.method, "POST");
  assert.doesNotMatch(calls[0].options.body, /mxfile|compressed/);
  assert.equal(JSON.parse(calls[0].options.body).file_name, "机制图.drawio");
  assert.equal(calls[1].options.body, file);
  assert.equal(attachment.contentKind, "drawio_xml");
  assert.equal(attachment.detectedMimeType, "application/xml");
  assert.equal(attachment.representation, "drawio_projection");
  assert.equal(attachment.projectionLineCount, 3);
  assert.equal(attachment.revision, revision);
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
    executionPolicyMode: "auto_review",
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
    execution_policy_mode: "auto_review",
  });
  assert.equal(created.scope, "standalone");
});

test("bound conversation creation explicitly requests auto review", async () => {
  const calls = [];
  await createProjectWorkConversation({
    projectId: "project/preferences",
    providerId: "deepseek",
    modelId: "deepseek-v4-pro",
    executionPolicyMode: "auto_review",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        conversation: {
          id: "conversation-preferences",
          project_id: "project/preferences",
          provider_id: "deepseek",
          model_id: "deepseek-v4-pro",
          execution_policy: {
            mode: "auto_review",
            revision: 2,
            policy_version: 1,
          },
        },
      });
    },
  });
  assert.equal(
    calls[0].url,
    "/api/v1/project-work/projects/project%2Fpreferences/conversations",
  );
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    schema_version: 1,
    provider_id: "deepseek",
    model_id: "deepseek-v4-pro",
    execution_policy_mode: "auto_review",
  });
  await assert.rejects(
    createProjectWorkConversation({
      projectId: "project/preferences",
      executionPolicyMode: "full_access",
    }),
    /manual_review 或 auto_review/,
  );
});

test("model configuration can persist provider and model without a model call", async () => {
  const calls = [];
  await configureProjectWorkConversation({
    conversationId: "conversation-model-choice",
    providerId: "deepseek",
    modelId: "deepseek-v4-pro",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        conversation: {
          id: "conversation-model-choice",
          provider_id: "deepseek",
          model_id: "deepseek-v4-pro",
        },
      });
    },
  });
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    schema_version: 1,
    provider_id: "deepseek",
    model_id: "deepseek-v4-pro",
  });
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

test("file search and pagination keep only safe browser paths and image metadata", async () => {
  const calls = [];
  const tree = await fetchProjectWorkTree({
    conversationId: "conversation/one",
    query: "settings panel",
    limit: 25,
    cursor: "next/page",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        path: "",
        query: "settings panel",
        revision: "sha256:tree",
        nextCursor: "page-3",
        truncated: true,
        scanTruncated: false,
        scannedEntries: 42,
        entries: [{
          path: "assets/settings panel.png",
          name: "settings panel.png",
          type: "file",
          byteLength: 128,
          previewKind: "image",
          mimeType: "image/png",
          overlay: "created",
        }, {
          path: "../.env",
          name: ".env",
          type: "file",
        }, {
          path: "/Users/private/secret.png",
          name: "secret.png",
          type: "file",
        }, {
          path: "linked-secret",
          name: "linked-secret",
          type: "symlink",
        }],
      });
    },
  });

  assert.equal(
    calls[0].url,
    "/api/v1/project-work/conversations/conversation%2Fone/tree?query=settings+panel&limit=25&cursor=next%2Fpage",
  );
  assert.deepEqual(tree.entries, [{
    id: "assets/settings panel.png",
    path: "assets/settings panel.png",
    name: "settings panel.png",
    kind: "file",
    size: 128,
    contentHash: null,
    depth: 0,
    previewKind: "image",
    mimeType: "image/png",
    overlay: "created",
  }]);
  assert.equal(tree.cursor, "page-3");
  assert.equal(tree.truncated, true);
  assert.equal(tree.scannedEntries, 42);

  await assert.rejects(
    fetchProjectWorkTree({
      conversationId: "conversation-one",
      path: "../private",
      fetchImpl: async () => jsonResponse({}),
    }),
    /安全的项目内相对路径/,
  );
});

test("project image URLs remain conversation-scoped and reject unsafe paths", () => {
  assert.equal(
    projectWorkImageUrl({
      conversationId: "conversation/one",
      path: "assets/settings panel.png",
    }),
    "/api/v1/project-work/conversations/conversation%2Fone/image?path=assets%2Fsettings+panel.png",
  );
  assert.equal(
    projectWorkImageUrl({
      projectId: "project one",
      path: "preview.webp",
    }),
    "/api/v1/project-work/projects/project%20one/image?path=preview.webp",
  );
  assert.throws(
    () => projectWorkImageUrl({
      conversationId: "conversation-one",
      path: "/Users/private/secret.png",
    }),
    /安全的项目内相对路径/,
  );
});

test("generated Image2 metadata and content URLs stay conversation-scoped", () => {
  const mapped = mapProjectWorkConversation({
    conversation: {
      id: "conversation/image",
      project_id: "project-1",
      generated_images: [{
        id: "image-1",
        turn_id: "turn-1",
        status: "completed",
        prompt: "暖象牙背景上的深青色球体",
        file_name: "image-1.png",
        mime_type: "image/png",
        byte_length: 1885527,
        width: 1254,
        height: 1254,
        sha256: `sha256:${"a".repeat(64)}`,
        requested_size: "1024x1024",
        requested_quality: "low",
        provider_id: "codex-subscription",
        model_id: "gpt-image-2",
        billing_kind: "chatgpt_subscription",
        pricing_status: "unpriced",
        usage: {
          input_tokens: 8944,
          cache_read_tokens: 26112,
          output_tokens: 202,
          total_tokens: 35258,
        },
      }],
    },
  });

  assert.equal(mapped.generatedImages[0].modelId, "gpt-image-2");
  assert.equal(mapped.generatedImages[0].width, 1254);
  assert.equal(mapped.generatedImages[0].usage.totalTokens, 35258);
  assert.equal(
    projectWorkGeneratedImageUrl({
      conversationId: "conversation/image",
      imageId: "image 1",
    }),
    "/api/v1/project-work/conversations/conversation%2Fimage/generated-images/image%201/content",
  );
});

test("generated Office metadata and download URLs stay conversation-scoped", () => {
  const revision = `sha256:${"b".repeat(64)}`;
  const mapped = mapProjectWorkConversation({
    conversation: {
      id: "conversation/office",
      project_id: "project-1",
      generated_office_artifacts: [{
        id: "office-1",
        turn_id: "turn-1",
        kind: "excel",
        status: "completed",
        title: "项目数据",
        summary: "结构化项目数据",
        file_name: "项目数据.xlsx",
        mime_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        byte_length: 2048,
        sha256: revision,
        revision,
        preview_text: "sheet=汇总\nA1=项目",
        structure_verified: true,
        render_verified: true,
        sheet_count: 1,
      }],
    },
  });

  assert.equal(mapped.generatedOfficeArtifacts[0].kind, "excel");
  assert.equal(mapped.generatedOfficeArtifacts[0].fileName, "项目数据.xlsx");
  assert.equal(mapped.generatedOfficeArtifacts[0].revision, revision);
  assert.equal(mapped.generatedOfficeArtifacts[0].renderVerified, true);
  assert.equal(
    projectWorkGeneratedOfficeDownloadUrl({
      conversationId: "conversation/office",
      artifactId: "office 1",
    }),
    "/api/v1/project-work/conversations/conversation%2Foffice/generated-office/office%201/download",
  );
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
    expectedContentHash: `sha256:${"a".repeat(64)}`,
    startLine: 7,
    endLine: 9,
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
    `/api/v1/project-work/conversations/conversation%2Fwith%20spaces/file?path=src%2Fgenerated+file.js&content_hash=sha256%3A${"a".repeat(64)}&start_line=7&end_line=9`,
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

test("turn history maps stable sequence, attempts, evidence, and operations", async () => {
  const calls = [];
  const page = await fetchProjectWorkConversationTurns({
    conversationId: "conversation-history-1",
    beforeTurnSeq: 8,
    limit: 5,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        schemaVersion: 1,
        turns: [{
          id: "turn-7",
          turnSeq: 7,
          status: "completed",
          assistantAttemptCount: 2,
          latestAssistantMessageId: "message-assistant-2",
          messages: [{
            id: "message-user-1",
            messageSeq: 12,
            turnId: "turn-7",
            turnSeq: 7,
            role: "user",
            text: "请修复并复测",
            status: "completed",
          }, {
            id: "message-assistant-2",
            messageSeq: 14,
            turnId: "turn-7",
            turnSeq: 7,
            role: "assistant",
            text: "已经修复并通过验证。",
            status: "completed",
            attempt: 2,
            isFinal: true,
            retryOperationId: "operation-retry-1",
            turnEvidence: {
              providerId: "openai-codex",
              modelId: "gpt-5.3-codex",
              thinkingLevel: "high",
              usage: {
                inputTokens: 1200,
                outputTokens: 300,
                totalTokens: 1500,
                costUsd: 0.0123,
              },
            },
          }],
          operations: [{
            id: "operation-retry-1",
            clientRequestId: "retry:test",
            type: "retry",
            status: "completed",
            turnId: "turn-7",
          }],
          events: [{
            seq: 71,
            type: "message.created",
            data: { id: "message-user-1", turnId: "turn-7", turnSeq: 7 },
          }, {
            seq: 72,
            type: "agent.progress",
            data: { turnId: "turn-7", summary: "已经定位问题，正在复测。" },
          }],
        }],
        hasMore: true,
        nextBeforeTurnSeq: 7,
      });
    },
  });

  assert.equal(
    calls[0].url,
    "/api/v1/project-work/conversations/conversation-history-1/turns?limit=5&before_turn_seq=8",
  );
  assert.equal(calls[0].options.method, "GET");
  assert.equal(page.hasMore, true);
  assert.equal(page.nextBeforeTurnSeq, 7);
  assert.equal(page.turns[0].turnSeq, 7);
  assert.equal(page.turns[0].assistantAttemptCount, 2);
  assert.equal(page.turns[0].messages[1].messageSeq, 14);
  assert.equal(page.turns[0].messages[1].attempt, 2);
  assert.equal(page.turns[0].messages[1].turnEvidence.usage.totalTokens, 1500);
  assert.equal(page.turns[0].messages[1].turnEvidence.usage.costUsd, 0.0123);
  assert.equal(page.turns[0].operations[0].clientRequestId, "retry:test");
  assert.deepEqual(
    page.turns[0].events.map((event) => event.seq),
    [71, 72],
  );
  assert.equal(
    page.turns[0].events[1].data.summary,
    "已经定位问题，正在复测。",
  );
});

test("read, retry, and interrupted-repair resume use distinct idempotent mutations", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return jsonResponse({
      id: "conversation-control-1",
      projectId: "project-1",
      title: "检查控制面",
      status: "idle",
      unreadCount: 0,
      latestMessageSeq: 6,
      lastReadMessageSeq: 6,
    });
  };

  await markProjectWorkConversationRead({
    conversationId: "conversation-control-1",
    throughMessageSeq: 6,
    clientRequestId: "project-read:test",
    fetchImpl,
  });
  await retryProjectWorkLastTurn({
    conversationId: "conversation-control-1",
    clientRequestId: "project-retry:test",
    fetchImpl,
  });
  await retryProjectWorkCheckpoint({
    conversationId: "conversation-control-1",
    checkpointId: "checkpoint-control-1",
    clientRequestId: "project-retry-checkpoint:test",
    fetchImpl,
  });
  await forkProjectWorkCheckpoint({
    conversationId: "conversation-control-1",
    checkpointId: "checkpoint-control-1",
    clientRequestId: "project-fork:test",
    fetchImpl,
  });
  await resumeProjectWorkVerificationRepair({
    conversationId: "conversation-control-1",
    operationId: "operation-repair-1",
    clientRequestId: "project-repair-resume:test",
    fetchImpl,
  });

  assert.deepEqual(calls.map((call) => call.url), [
    "/api/v1/project-work/conversations/conversation-control-1/read",
    "/api/v1/project-work/conversations/conversation-control-1/retry-last-turn",
    "/api/v1/project-work/conversations/conversation-control-1/retry-last-turn",
    "/api/v1/project-work/conversations/conversation-control-1/forks",
    "/api/v1/project-work/conversations/conversation-control-1/verification-repairs/operation-repair-1/resume",
  ]);
  assert.deepEqual(calls.map((call) => JSON.parse(call.options.body)), [{
    schema_version: 1,
    client_request_id: "project-read:test",
    through_message_seq: 6,
  }, {
    schema_version: 1,
    client_request_id: "project-retry:test",
  }, {
    schema_version: 1,
    client_request_id: "project-retry-checkpoint:test",
    checkpoint_id: "checkpoint-control-1",
  }, {
    schema_version: 1,
    client_request_id: "project-fork:test",
    checkpoint_id: "checkpoint-control-1",
  }, {
    schema_version: 1,
    client_request_id: "project-repair-resume:test",
  }]);
});

test("PDF upload uses JSON metadata followed by a raw application/pdf body", async () => {
  const calls = [];
  const file = {
    name: "开发 手册.pdf",
    size: 18,
  };
  const snapshot = await uploadProjectWorkPdf({
    conversationId: "conversation-pdf-1",
    file,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1) {
        return jsonResponse({
          schema_version: 1,
          document: {
            id: "document-pdf-1",
            file_name: file.name,
            byte_length: file.size,
            status: "awaiting_upload",
          },
        }, 201);
      }
      return jsonResponse({
        schema_version: 1,
        conversation: {
          id: "conversation-pdf-1",
          project_id: "project-1",
          status: "idle",
          documents: [{
            id: "document-pdf-1",
            file_name: file.name,
            byte_length: file.size,
            status: "local_ready",
          }],
        },
      }, 202);
    },
  });

  assert.equal(
    calls[0].url,
    "/api/v1/project-work/conversations/conversation-pdf-1/documents",
  );
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    schema_version: 1,
    file_name: file.name,
    byte_length: file.size,
  });
  assert.equal(
    calls[1].url,
    "/api/v1/project-work/conversations/conversation-pdf-1/documents/document-pdf-1/content",
  );
  assert.equal(calls[1].options.method, "PUT");
  assert.equal(calls[1].options.headers["content-type"], "application/pdf");
  assert.equal(calls[1].options.body, file);
  assert.equal(snapshot.documents[0].status, "local_ready");
});

test("failed PDF content upload makes a best-effort cleanup request", async () => {
  const calls = [];
  const file = { name: "失败.pdf", size: 12 };
  await assert.rejects(
    uploadProjectWorkPdf({
      conversationId: "conversation-pdf-failed",
      file,
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        if (calls.length === 1) {
          return jsonResponse({
            document: {
              id: "document-failed",
              file_name: file.name,
              byte_length: file.size,
              status: "awaiting_upload",
            },
          }, 201);
        }
        if (calls.length === 2) {
          return jsonResponse({
            error: {
              code: "PROJECT_WORK_DOCUMENT_SIGNATURE_INVALID",
              message: "上传内容不是有效的 PDF 文件",
            },
          }, 415);
        }
        return jsonResponse({
          conversation: {
            id: "conversation-pdf-failed",
            project_id: "project-1",
            documents: [],
          },
        });
      },
    }),
    (error) => error.code === "PROJECT_WORK_DOCUMENT_SIGNATURE_INVALID",
  );
  assert.equal(calls.length, 3);
  assert.equal(calls[2].options.method, "DELETE");
  assert.match(calls[2].url, /documents\/document-failed$/);
});

test("PDF retry uses the exact conversation and document route", async () => {
  const calls = [];
  const snapshot = await retryProjectWorkPdf({
    conversationId: "conversation-pdf-1",
    documentId: "document-pdf-1",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        schema_version: 1,
        conversation: {
          id: "conversation-pdf-1",
          project_id: "project-1",
          status: "idle",
          documents: [{
            id: "document-pdf-1",
            file_name: "开发手册.pdf",
            byte_length: 18,
            status: "local_ready",
          }],
        },
      }, 202);
    },
  });

  assert.equal(
    calls[0].url,
    "/api/v1/project-work/conversations/conversation-pdf-1/documents/document-pdf-1/retry",
  );
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    schema_version: 1,
  });
  assert.equal(snapshot.documents[0].status, "local_ready");
});

test("removing a PDF uses a bodyless conversation-owned delete", async () => {
  const calls = [];
  const snapshot = await removeProjectWorkPdf({
    conversationId: "conversation-pdf-1",
    documentId: "document-pdf-1",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        schema_version: 1,
        conversation: {
          id: "conversation-pdf-1",
          project_id: "project-1",
          status: "idle",
          documents: [],
        },
      });
    },
  });

  assert.equal(
    calls[0].url,
    "/api/v1/project-work/conversations/conversation-pdf-1/documents/document-pdf-1",
  );
  assert.equal(calls[0].options.method, "DELETE");
  assert.equal(calls[0].options.body, undefined);
  assert.deepEqual(snapshot.documents, []);
});

test("browser QA maps bounded captures and uses the conversation-owned route", async () => {
  const calls = [];
  const snapshot = await runProjectWorkBrowserQa({
    conversationId: "conversation-browser-1",
    clientRequestId: "project-browser-qa:test-1",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        conversation: {
          id: "conversation-browser-1",
          project_id: "project-1",
          browserQaRuns: [{
            id: "browser-qa-1",
            clientRequestId: "project-browser-qa:test-1",
            status: "completed",
            verdict: "issues",
            issueSummary: {
              consoleErrorCount: 1,
              failedRequestCount: 1,
              accessibilityIssueCount: 1,
            },
            adapterId: "controlled-chromium",
            captures: [{
              profile: {
                id: "desktop",
                label: "桌面",
                width: 1440,
                height: 1024,
                isMobile: false,
              },
              screenshot: {
                mimeType: "image/png",
                byteLength: 123,
                sha256: `sha256:${"a".repeat(64)}`,
              },
              dom: {
                title: "Pi Agent",
                language: "zh-CN",
                nodeCount: 20,
                landmarkCount: 3,
                headingCount: 2,
                interactiveCount: 5,
                imageCount: 1,
                tableCount: 0,
                formCount: 1,
              },
              accessibility: {
                checkedNodeCount: 20,
                issueCount: 1,
                issues: [{
                  id: "image-alt",
                  severity: "serious",
                  count: 1,
                  message: "图片缺少替代文本",
                }],
              },
            }],
            console: {
              entries: [{ level: "error", text: "boom" }],
              truncated: false,
            },
            failedRequests: {
              entries: [{
                method: "GET",
                resourceType: "image",
                reason: "net::ERR_FAILED",
              }],
              truncated: false,
            },
          }],
        },
      });
    },
  });

  assert.equal(
    calls[0].url,
    "/api/v1/project-work/conversations/conversation-browser-1/browser-qa",
  );
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    schema_version: 1,
    client_request_id: "project-browser-qa:test-1",
  });
  assert.equal(
    snapshot.browserQaRuns[0].clientRequestId,
    "project-browser-qa:test-1",
  );
  assert.equal(snapshot.browserQaRuns[0].verdict, "issues");
  assert.equal(
    snapshot.browserQaRuns[0].issueSummary.consoleErrorCount,
    1,
  );
  assert.equal(snapshot.browserQaRuns[0].captures[0].profile.width, 1440);
  assert.equal(snapshot.browserQaRuns[0].captures[0].accessibility.issueCount, 1);
  assert.equal(snapshot.browserQaRuns[0].console.entries[0].level, "error");
  await assert.rejects(
    runProjectWorkBrowserQa({
      conversationId: "conversation-browser-1",
      clientRequestId: "invalid request id",
      fetchImpl: async () => {
        throw new Error("must not fetch");
      },
    }),
    /clientRequestId 格式无效/,
  );
});

test("browser QA screenshot URL accepts only registered profiles", () => {
  assert.equal(
    projectWorkBrowserQaScreenshotUrl({
      conversationId: "conversation browser",
      runId: "run/1",
      profileId: "mobile",
    }),
    "/api/v1/project-work/conversations/conversation%20browser/browser-qa/run%2F1/mobile/screenshot",
  );
  assert.throws(
    () => projectWorkBrowserQaScreenshotUrl({
      conversationId: "conversation-1",
      runId: "run-1",
      profileId: "tablet",
    }),
    /desktop 或 mobile/,
  );
});

test("legacy migration exposes exact patch export and hash-bound abandon", async () => {
  const changeSetHash = `sha256:${"a".repeat(64)}`;
  assert.equal(
    projectWorkLegacyMigrationPatchUrl({
      conversationId: "conversation legacy",
      changeSetId: "changes/1",
      changeSetHash,
    }),
    `/api/v1/project-work/conversations/conversation%20legacy/legacy-migration/change-sets/changes%2F1/export?change_set_hash=${encodeURIComponent(changeSetHash)}`,
  );
  let request;
  const result = await abandonProjectWorkLegacyMigrationChanges({
    conversationId: "conversation-legacy",
    changeSetId: "changes-1",
    changeSetHash,
    clientRequestId: "legacy-migration-abandon:test",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse({
        conversation: {
          id: "conversation-legacy",
          project_id: "project-1",
          runtime_profile: "pi-native-v1",
          legacy_migration: {
            status: "completed",
            resolution: "abandoned",
          },
        },
      });
    },
  });
  assert.equal(
    request.url,
    "/api/v1/project-work/conversations/conversation-legacy/legacy-migration/change-sets/changes-1/abandon",
  );
  assert.deepEqual(JSON.parse(request.options.body), {
    schema_version: 1,
    client_request_id: "legacy-migration-abandon:test",
    change_set_hash: changeSetHash,
  });
  assert.equal(result.runtimeProfile, "pi-native-v1");
  assert.equal(result.legacyMigration.resolution, "abandoned");
});

test("legacy archive API maps safe summaries and sends an exact cleanup binding", async () => {
  const archiveHash = `sha256:${"a".repeat(64)}`;
  const mutationOrigin = `sha256:${"b".repeat(64)}`;
  const calls = [];
  const responseBody = {
    schema_version: 1,
    total_bytes: 2048,
    total_file_count: 7,
    item_count: 1,
    cleanup_eligible_count: 1,
    mutation_origin: mutationOrigin,
    items: [{
      conversation_id: "conversation-archive",
      title: "旧 Swift 验证",
      parts: ["base", "workspace"],
      archive_hash: archiveHash,
      bytes: 2048,
      file_count: 7,
      cleanup_eligible: true,
      blocked_reason: null,
    }],
  };
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    return jsonResponse(responseBody);
  };

  const listed = await fetchLegacyWorkspaceArchives({ fetchImpl });
  assert.equal(listed.totalBytes, 2048);
  assert.equal(listed.items[0].conversationId, "conversation-archive");
  assert.equal(listed.items[0].archiveHash, archiveHash);
  await cleanupLegacyWorkspaceArchives({
    mutationOrigin,
    items: [{
      conversationId: "conversation-archive",
      archiveHash,
      bytes: 2048,
    }],
    fetchImpl,
  });
  assert.equal(calls[0].url, "/api/v1/project-work/legacy-workspace-archives");
  assert.equal(calls[1].url, "/api/v1/project-work/legacy-workspace-archives/cleanup");
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    schema_version: 1,
    mutation_origin: mutationOrigin,
    items: [{
      conversation_id: "conversation-archive",
      archive_hash: archiveHash,
      bytes: 2048,
    }],
  });
});
