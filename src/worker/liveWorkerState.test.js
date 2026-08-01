import assert from "node:assert/strict";
import test from "node:test";
import {
  adaptWorkerBundle,
  buildWorkerActionInput,
  buildWorkerReadInput,
  normalizeDeliveryProposal,
  normalizeDeliveryReceipt,
} from "./liveWorkerState.js";
import {
  BUILT_IN_WORKERS,
  createDeliveryConfirmationInput,
  createInitialWorkerState,
  DELIVERY_STATUS,
  WORKER_IDS,
} from "./workerState.js";

function bundle(overrides = {}) {
  return {
    task: {
      id: "worker-task-1",
      workerId: WORKER_IDS.LARK_DOCUMENT,
      title: "整理周报",
      sourceProjectId: "project-1",
    },
    conversation: {
      conversation: {
        id: "conversation-1",
        workType: "worker",
        workspaceKind: "scratch",
        status: "idle",
        providerId: "openai-codex",
        modelId: "gpt-5.6",
        sourceProjectLabel: "Pi Agent",
        messages: [],
      },
      events: [],
    },
    draft: {
      id: "draft-1",
      version: 1,
      content: "<doc><p>新内容</p></doc>",
      format: "xml",
      sha256: "sha256:draft",
      source: "user",
    },
    sources: [],
    actions: [],
    receipts: [],
    ...overrides,
  };
}

test("live Worker bundle keeps persisted external sources and read-only project context", () => {
  const state = adaptWorkerBundle(bundle({
    sources: [{
      id: "source-1",
      kind: "document",
      operation: "fetch",
      title: "项目周报",
      content: "{\"document\":\"safe\"}",
      contentSha256: "sha256:source",
      byteLength: 20,
      truncated: false,
      untrustedExternalContent: true,
      binding: {
        exact: true,
        requestedDocument: "doc-token",
        requestedRevisionId: null,
        revisionId: 18,
        detail: "full",
      },
      createdAt: "2026-08-01T08:00:00.000Z",
    }],
    files: [{
      id: "worker-file-1",
      fileName: "report.pdf",
      mimeType: "application/pdf",
      byteLength: 4096,
      sha256: "sha256:file",
      status: "ready",
    }],
  }), {
    definitions: BUILT_IN_WORKERS,
    projectOptions: [{ id: "project-1", label: "Pi Agent" }],
  });

  assert.equal(state.workType, "worker");
  assert.equal(state.workspaceKind, "scratch");
  assert.deepEqual(state.projectContext, { id: "project-1", label: "Pi Agent" });
  assert.equal(state.sources.length, 1);
  assert.equal(state.sources[0].label, "项目周报");
  assert.equal(state.sources[0].untrustedExternalContent, true);
  assert.equal(state.sources[0].contentHash, "sha256:source");
  assert.equal(state.sources[0].binding.revisionId, 18);
  assert.equal(state.sources[0].exact, true);
  assert.equal(state.deliveryFiles[0].id, "worker-file-1");
  assert.equal(state.deliveryFiles[0].contentHash, "sha256:file");
});

test("pending_confirmation is confirmable only with exact server proposal and draft bindings", () => {
  const state = adaptWorkerBundle(bundle({
    actions: [{
      id: "delivery-1",
      workerId: WORKER_IDS.LARK_DOCUMENT,
      operation: "overwrite",
      risk: "high",
      status: "pending_confirmation",
      proposalHash: "sha256:proposal",
      draftRevisionId: "draft-1",
      draftSha256: "sha256:draft",
      baseRevisionId: 18,
      parameters: { document: "doc-token", affectedBlockCount: 12 },
      preview: {
        operationLabel: "覆盖飞书文档全文",
        contentContract: "full_before_and_after",
        target: { document: "doc-token", baseRevisionId: 18 },
        before: "旧内容",
        after: "新内容",
        fullBefore: "旧内容",
        fullAfter: "新内容",
        impact: { affectedBlockCount: 12 },
        warnings: [],
      },
      preparation: { transport: "lark-cli" },
    }],
  }), { definitions: BUILT_IN_WORKERS });

  assert.equal(state.deliveryProposal.status, DELIVERY_STATUS.PREPARED);
  assert.equal(state.deliveryProposal.previewComplete, true);
  assert.equal(state.deliveryProposal.contentContract, "full_before_and_after");
  assert.equal(state.deliveryProposal.fullBefore, "旧内容");
  assert.equal(state.deliveryProposal.fullAfter, "新内容");
  assert.equal(state.deliveryProposal.confirmationPrepared, true);
  assert.equal(state.deliveryProposal.affectedBlockCount, 12);
  assert.deepEqual(createDeliveryConfirmationInput(state), {
    taskId: "worker-task-1",
    actionId: "delivery-1",
    workerId: WORKER_IDS.LARK_DOCUMENT,
    operation: "overwrite",
    proposalHash: "sha256:proposal",
    draftRevisionId: "draft-1",
    draftHash: "sha256:draft",
    baseRevisionId: 18,
    targetFingerprint: "sha256:proposal",
  });
});

test("no-draft destructive actions bind proposal/base revision without inventing a draft binding", () => {
  const initial = createInitialWorkerState({
    workerId: WORKER_IDS.LARK_DOCUMENT,
    task: { id: "worker-task-delete", workerId: WORKER_IDS.LARK_DOCUMENT },
  });
  const state = {
    ...initial,
    draftDirty: false,
    deliveryProposal: {
      id: "delivery-delete",
      workerId: WORKER_IDS.LARK_DOCUMENT,
      operation: "block_delete",
      status: DELIVERY_STATUS.PREPARED,
      proposalHash: "sha256:delete",
      targetFingerprint: "sha256:delete",
      draftRevisionId: null,
      draftHash: null,
      baseRevision: "版本 9",
      baseRevisionId: 9,
      confirmationPrepared: true,
      nativeConfirmationPrepared: true,
      previewComplete: true,
    },
  };

  assert.deepEqual(createDeliveryConfirmationInput(state), {
    taskId: "worker-task-delete",
    actionId: "delivery-delete",
    workerId: WORKER_IDS.LARK_DOCUMENT,
    operation: "block_delete",
    proposalHash: "sha256:delete",
    draftRevisionId: null,
    draftHash: null,
    baseRevisionId: 9,
    targetFingerprint: "sha256:delete",
  });
});

test("mail queued receipt never claims delivery and maps provider verification states", () => {
  const queued = normalizeDeliveryReceipt({
    id: "receipt-1",
    status: "queued",
    providerState: "queued",
    proposalHash: "sha256:proposal",
    draftSha256: "sha256:draft",
    verification: { status: "queued_only" },
  });
  assert.equal(queued.summary, "已进入发送队列");
  assert.match(queued.detail, /不能证明收件人已经收到/);
  assert.equal(queued.readbackLabel, "仅确认进入发送队列");

  const lark = normalizeDeliveryReceipt({
    id: "receipt-2",
    status: "completed",
    verification: { status: "readback_verified" },
  });
  assert.equal(lark.readbackLabel, "已回读验证");

  const pendingLark = normalizeDeliveryReceipt({
    id: "receipt-lark-pending",
    workerId: WORKER_IDS.LARK_DOCUMENT,
    status: "queued",
    providerState: "running",
    verification: { status: "pending_provider_completion" },
  });
  assert.equal(pendingLark.status, "provider_pending");
  assert.match(pendingLark.summary, /版本恢复仍在外部服务处理中/);
  assert.match(pendingLark.detail, /不会重复执行版本恢复/);
});

test("a manually checked unknown outcome is recorded without inferring external success", () => {
  const receipt = normalizeDeliveryReceipt({
    id: "receipt-manual",
    status: "unknown",
    providerState: "manual_check_required",
    verification: {
      status: "manual_check_required",
      manualCheckCompleted: true,
      manualCheckCompletedAt: "2026-08-01T09:00:00.000Z",
      manualCheckNote: "已在外部服务中核对",
    },
  });
  assert.equal(receipt.status, "manual_resolved");
  assert.equal(receipt.statusLabel, "人工核对已记录");
  assert.match(receipt.detail, /未判断外部操作成功或失败/);
  assert.equal(receipt.readbackLabel, "人工核对已记录");
  assert.doesNotMatch(receipt.detail, /外部交付已完成|操作已成功|已送达/);

  const state = adaptWorkerBundle(bundle({
    task: {
      id: "worker-task-1",
      workerId: WORKER_IDS.AGENT_MAIL,
      title: "核对邮件",
      sourceProjectId: null,
    },
    actions: [{
      id: "delivery-manual",
      workerId: WORKER_IDS.AGENT_MAIL,
      operation: "send",
      status: "abandoned",
      proposalHash: "sha256:manual",
      draftRevisionId: "draft-1",
      draftSha256: "sha256:draft",
      parameters: { attachments: [] },
      preview: {
        operationLabel: "发送新邮件",
        target: { to: ["teacher@example.com"] },
        before: null,
        after: { subject: "周报", body: "正文" },
        warnings: [],
      },
    }],
    receipts: [{
      id: "receipt-manual",
      proposalId: "delivery-manual",
      status: "unknown",
      verification: {
        status: "manual_check_required",
        manualCheckCompleted: true,
      },
    }],
  }));
  assert.equal(state.status, "ready");
  assert.equal(state.deliveryProposal.status, DELIVERY_STATUS.ABANDONED);
  assert.equal(state.receipt.status, "manual_resolved");
});

test("Lark document search uses the CLI query field", () => {
  assert.deepEqual(
    buildWorkerReadInput(WORKER_IDS.LARK_DOCUMENT, "search", {
      query: "项目周报",
      pageSize: "20",
      pageToken: "next-page",
    }),
    {
      operation: "search",
      parameters: {
        query: "项目周报",
        pageSize: 20,
        pageToken: "next-page",
      },
    },
  );
});

test("read inputs enforce connector limits and never accept a browser download path", () => {
  const larkSearch = buildWorkerReadInput(WORKER_IDS.LARK_DOCUMENT, "search", {
    query: "周报",
    pageSize: "100",
  });
  assert.equal(larkSearch.parameters.pageSize, 20);

  const history = buildWorkerReadInput(WORKER_IDS.LARK_DOCUMENT, "history_list", {
    document: "doc-token",
    pageSize: "0",
  });
  assert.equal(history.parameters.pageSize, 1);

  const mail = buildWorkerReadInput(WORKER_IDS.AGENT_MAIL, "list", {
    limit: "500",
  });
  assert.equal(mail.parameters.limit, 50);

  const attachment = buildWorkerReadInput(WORKER_IDS.AGENT_MAIL, "attachment_download", {
    messageId: "msg_1",
    attachmentId: "att_1",
    output: "../../unsafe",
  });
  assert.deepEqual(attachment.parameters, {
    messageId: "msg_1",
    attachmentId: "att_1",
  });
  assert.equal("output" in attachment.parameters, false);
});

test("IMA note reads use explicit bounded inputs and can never fall through to Lark or mail delivery", () => {
  assert.deepEqual(
    buildWorkerReadInput(WORKER_IDS.IMA_NOTE, "list_notebook", {
      cursor: "",
      limit: "500",
    }),
    {
      operation: "list_notebook",
      parameters: { cursor: "0", limit: 20 },
    },
  );
  assert.deepEqual(
    buildWorkerReadInput(WORKER_IDS.IMA_NOTE, "list_note", {
      folderId: "folder_1",
      cursor: "next",
      sortType: "2",
      limit: "10",
    }),
    {
      operation: "list_note",
      parameters: {
        folderId: "folder_1",
        cursor: "next",
        sortType: 2,
        limit: 10,
      },
    },
  );
  assert.deepEqual(
    buildWorkerReadInput(WORKER_IDS.IMA_NOTE, "search_note", {
      query: "项目排期",
      searchType: "1",
      start: "20",
      end: "40",
    }),
    {
      operation: "search_note",
      parameters: {
        query: "项目排期",
        searchType: 1,
        start: 20,
        end: 40,
      },
    },
  );
  assert.deepEqual(
    buildWorkerReadInput(WORKER_IDS.IMA_NOTE, "get_doc_content", {
      noteId: "note_1",
    }),
    {
      operation: "get_doc_content",
      parameters: { noteId: "note_1", targetContentFormat: 0 },
    },
  );
  assert.throws(
    () => buildWorkerReadInput(WORKER_IDS.IMA_NOTE, "read", { messageId: "msg_1" }),
    /IMA Worker 不支持/u,
  );
  assert.throws(
    () => buildWorkerActionInput(WORKER_IDS.IMA_NOTE, "create", {}),
    /仅支持读取资料与整理草稿/u,
  );
});

test("queued mail proposals map to completed UI state without claiming recipient delivery", () => {
  const proposal = normalizeDeliveryProposal({
    id: "delivery-mail-queued",
    workerId: WORKER_IDS.AGENT_MAIL,
    operation: "send",
    status: "queued",
    proposalHash: "sha256:proposal",
    draftRevisionId: "draft-1",
    draftSha256: "sha256:draft",
    parameters: { attachments: [] },
    preview: {
      operationLabel: "发送新邮件",
      target: { to: ["teacher@example.com"] },
      after: { subject: "周报", body: "正文" },
      warnings: ["只能证明进入发送队列。"],
    },
  }, { id: "draft-1", content: "正文" });

  assert.equal(proposal.status, DELIVERY_STATUS.COMPLETED);
  assert.equal(proposal.serverStatus, "queued");
  assert.match(proposal.confirmationHint, /进入发送队列/);
});

test("queued Lark history restore remains provider-pending and is not a completed delivery", () => {
  const proposal = normalizeDeliveryProposal({
    id: "delivery-lark-queued",
    workerId: WORKER_IDS.LARK_DOCUMENT,
    operation: "history_revert",
    status: "queued",
    proposalHash: "sha256:proposal",
    baseRevisionId: 18,
    parameters: { document: "doc-token", historyVersionId: "history-4" },
    preview: {
      operationLabel: "恢复飞书历史版本",
      contentContract: "full_before_and_after",
      target: { document: "doc-token", baseRevisionId: 18 },
      before: "当前全文",
      after: "历史全文",
      fullBefore: "当前全文",
      fullAfter: "历史全文",
      warnings: [],
    },
  });

  assert.equal(proposal.status, DELIVERY_STATUS.PROVIDER_PENDING);
  assert.equal(proposal.providerPending, true);
  assert.equal(proposal.previewComplete, true);
  assert.equal(proposal.serverStatus, "queued");
});

test("mail previews preserve resolved recipients, original forward attachments, and native confirmation summary", () => {
  const proposal = normalizeDeliveryProposal({
    id: "delivery-mail-preview",
    workerId: WORKER_IDS.AGENT_MAIL,
    operation: "reply_all",
    status: "pending_confirmation",
    proposalHash: "sha256:mail-preview",
    draftRevisionId: "draft-1",
    draftSha256: "sha256:draft",
    attachmentBindings: [],
    preview: {
      operationLabel: "回复全部",
      target: {
        messageId: "msg_source",
        resolvedRecipients: {
          to: ["sender@example.com"],
          cc: ["team@example.com"],
        },
        cc: ["added@example.com"],
        bcc: ["audit@example.com"],
      },
      before: { subject: "原邮件", body: "原正文" },
      after: { body: "回复正文", bodyFormat: "plain", attachments: [] },
      warnings: [],
    },
    preparation: {
      confirmationRequired: true,
      confirmationExpiresAt: "2099-01-01T00:00:00.000Z",
      summary: {
        operation: "reply_all",
        to: ["sender@example.com"],
        cc: ["team@example.com", "added@example.com"],
        body_preview: "回复正文",
      },
    },
  }, { id: "draft-1", content: "回复正文" });

  assert.equal(proposal.previewComplete, true);
  assert.equal(proposal.targetLabel, "sender@example.com");
  assert.deepEqual(proposal.recipientDetails, {
    messageId: "msg_source",
    to: ["sender@example.com"],
    resolvedCc: ["team@example.com"],
    additionalCc: ["added@example.com"],
    bcc: ["audit@example.com"],
  });
  assert.deepEqual(proposal.nativeConfirmationSummary, {
    operation: "reply_all",
    to: ["sender@example.com"],
    cc: ["team@example.com", "added@example.com"],
    body_preview: "回复正文",
  });

  const forward = normalizeDeliveryProposal({
    id: "delivery-forward-preview",
    workerId: WORKER_IDS.AGENT_MAIL,
    operation: "forward",
    status: "pending_confirmation",
    proposalHash: "sha256:forward-preview",
    draftRevisionId: "draft-1",
    draftSha256: "sha256:draft",
    preview: {
      operationLabel: "转发邮件",
      target: { messageId: "msg_source", to: ["reviewer@example.com"], cc: [], bcc: [] },
      before: { subject: "原邮件", body: "原正文" },
      after: {
        body: "转发说明",
        bodyFormat: "plain",
        attachments: [],
        includeOriginalAttachments: true,
        includedOriginalAttachments: [{ id: "att_1", name: "原报告.pdf", size: 4096 }],
      },
      warnings: [],
    },
    preparation: { confirmationRequired: true, summary: { operation: "forward" } },
  }, { id: "draft-1", content: "转发说明" });
  assert.equal(forward.previewComplete, true);
  assert.equal(forward.targetLabel, "reviewer@example.com");
  assert.equal(forward.includeOriginalAttachments, true);
  assert.deepEqual(forward.includedOriginalAttachments, [{
    id: "att_1",
    name: "原报告.pdf",
    byteLength: 4096,
  }]);
});

test("six exact Lark operations preserve their operation diff and fail confirmation closed when incomplete", () => {
  const cases = [{
    operation: "append",
    diff: { kind: "append", content: "<p>追加</p>", format: "xml" },
    missing: "content",
    draftBound: true,
  }, {
    operation: "str_replace",
    diff: { kind: "str_replace", pattern: "旧句", replacement: "新句", format: "xml" },
    missing: "replacement",
    draftBound: true,
  }, {
    operation: "block_insert_after",
    diff: { kind: "block_insert_after", blockId: "blk_anchor", content: "<p>插入</p>", format: "xml" },
    missing: "blockId",
    draftBound: true,
  }, {
    operation: "block_replace",
    diff: { kind: "block_replace", blockId: "blk_target", content: "<p>替换</p>", format: "xml" },
    missing: "content",
    draftBound: true,
  }, {
    operation: "block_delete",
    diff: { kind: "block_delete", blockIds: ["blk_a", "blk_b"] },
    missing: "blockIds",
    draftBound: false,
  }, {
    operation: "block_move_after",
    diff: { kind: "block_move_after", anchorBlockId: "blk_anchor", sourceBlockIds: ["blk_move"] },
    missing: "anchorBlockId",
    draftBound: false,
  }];

  for (const item of cases) {
    const raw = {
      id: `delivery-${item.operation}`,
      workerId: WORKER_IDS.LARK_DOCUMENT,
      operation: item.operation,
      status: "pending_confirmation",
      proposalHash: `sha256:${item.operation}`,
      draftRevisionId: item.draftBound ? "draft-1" : null,
      draftSha256: item.draftBound ? "sha256:draft" : null,
      baseRevisionId: 18,
      parameters: { document: "doc-token" },
      preview: {
        operationLabel: item.operation,
        contentContract: "full_before_with_exact_operation_diff",
        target: { document: "doc-token", baseRevisionId: 18 },
        before: "<doc><p>当前全文</p></doc>",
        after: null,
        fullBefore: "<doc><p>当前全文</p></doc>",
        fullAfter: null,
        exactOperationDiff: item.diff,
        warnings: [],
      },
      preparation: {},
    };
    const draft = item.draftBound
      ? { id: "draft-1", content: "草稿", sha256: "sha256:draft" }
      : null;
    const proposal = normalizeDeliveryProposal(raw, draft);
    assert.equal(proposal.previewComplete, true, item.operation);
    assert.deepEqual(proposal.exactOperationDiff, item.diff, item.operation);
    assert.equal(proposal.contentContract, "full_before_with_exact_operation_diff");
    assert.equal(proposal.fullBefore, "<doc><p>当前全文</p></doc>");
    assert.equal(proposal.fullAfter, null);

    const state = createInitialWorkerState({
      workerId: WORKER_IDS.LARK_DOCUMENT,
      task: { id: "worker-task-1", workerId: WORKER_IDS.LARK_DOCUMENT },
      draftRevision: {
        id: "draft-1",
        version: 1,
        content: "草稿",
        format: "xml",
        contentHash: "sha256:draft",
      },
      deliveryProposal: proposal,
    });
    assert.ok(createDeliveryConfirmationInput(state), item.operation);

    const incompleteDiff = { ...item.diff };
    delete incompleteDiff[item.missing];
    const incomplete = normalizeDeliveryProposal({
      ...raw,
      preview: { ...raw.preview, exactOperationDiff: incompleteDiff },
    }, draft);
    assert.equal(incomplete.previewComplete, false, `${item.operation} incomplete`);
    assert.equal(createDeliveryConfirmationInput({
      ...state,
      deliveryProposal: incomplete,
    }), null, `${item.operation} must fail closed`);

    const missingFullBefore = normalizeDeliveryProposal({
      ...raw,
      preview: { ...raw.preview, fullBefore: undefined },
    }, draft);
    assert.equal(missingFullBefore.previewComplete, false, `${item.operation} full-before`);
    assert.equal(createDeliveryConfirmationInput({
      ...state,
      deliveryProposal: missingFullBefore,
    }), null, `${item.operation} must require full-before`);
  }
});

test("action input binds persisted sources and controlled attachment ids instead of browser previews or paths", () => {
  const sources = [{
    id: "source-current",
    binding: {
      requestedDocument: "doc-token",
      revisionId: 18,
    },
  }, {
    id: "source-mail",
    binding: { messageId: "msg_123" },
  }];
  const lark = buildWorkerActionInput(WORKER_IDS.LARK_DOCUMENT, "history_revert", {
    beforeSourceId: "source-current",
    afterSourceId: "source-history-content",
    historySourceId: "source-history-list",
    historyVersionId: "history-4",
  }, sources);
  assert.deepEqual(lark, {
    operation: "history_revert",
    parameters: {
      document: "doc-token",
      baseRevisionId: 18,
      historyVersionId: "history-4",
    },
    beforeSourceId: "source-current",
    afterSourceId: "source-history-content",
    historySourceId: "source-history-list",
  });
  assert.equal("before" in lark, false);
  assert.equal("after" in lark, false);

  const mail = buildWorkerActionInput(WORKER_IDS.AGENT_MAIL, "send", {
    to: "a@example.com, b@example.com",
    subject: "周报",
    attachments: ["worker-file-1", "worker-file-2", "worker-file-3", "worker-file-4"],
  });
  assert.deepEqual(mail.parameters.to, ["a@example.com", "b@example.com"]);
  assert.deepEqual(mail.parameters.attachments, [
    "worker-file-1",
    "worker-file-2",
    "worker-file-3",
  ]);

  const reply = buildWorkerActionInput(WORKER_IDS.AGENT_MAIL, "reply", {
    beforeSourceId: "source-mail",
  }, sources);
  assert.equal(reply.parameters.messageId, "msg_123");
  assert.equal(reply.beforeSourceId, "source-mail");
  assert.equal("before" in reply, false);
});
