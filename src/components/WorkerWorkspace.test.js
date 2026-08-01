import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { adaptWorkerBundle } from "../worker/liveWorkerState.js";
import {
  createDeliveryConfirmationInput,
  createInitialWorkerState,
  DELIVERY_STATUS,
  WORKER_ACTION_CATALOG,
  WORKER_ACTIONS,
  WORKER_ARTIFACTS,
  WORKER_IDS,
  WORKER_STATUS,
  workerReducer,
} from "../worker/workerState.js";

async function withViteModule(path, callback) {
  const vite = await createServer({
    root: process.cwd(),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  try {
    return await callback(await vite.ssrLoadModule(path));
  } finally {
    await vite.close();
  }
}

test("WorkerRail is an embeddable list fragment with three built-in Workers and no duplicated shell", async () => {
  await withViteModule("/src/components/WorkerWorkspace.jsx", ({ WorkerRail }) => {
    const html = renderToStaticMarkup(React.createElement(WorkerRail, {
      activeWorkerId: WORKER_IDS.AGENT_MAIL,
      activeTaskId: "worker-task-mail-mentor",
      connections: {
        lark: { status: "connected", label: "飞书已连接" },
        "agently-mail": { status: "connected", label: "Agent 邮箱已连接" },
      },
    }));

    assert.match(html, /搜索 Worker 和任务/);
    assert.match(html, /aria-label="在“飞书文档 Worker”下新建任务"/);
    assert.match(html, /aria-label="在“Agent 邮箱 Worker”下新建任务"/);
    assert.match(html, /aria-label="在“IMA 笔记 Worker”下新建任务"/);
    assert.match(html, /飞书文档 Worker/);
    assert.match(html, /Agent 邮箱 Worker/);
    assert.match(html, /IMA 笔记 Worker/);
    assert.match(html, /整理本周项目进展/);
    assert.match(html, /给导师发送本周进展/);
    assert.match(html, /aria-label="Worker 任务"/);
    assert.doesNotMatch(html, /选择 Worker 后开始一项文字工作/);
    assert.doesNotMatch(html, /<select/);
    assert.doesNotMatch(html, /<aside/);
    assert.doesNotMatch(html, /工作类型|正常工作|论文精读|设置/);
  });
});

test("WorkerRail search contract filters groups and tasks without changing task data", async () => {
  await withViteModule("/src/components/WorkerWorkspace.jsx", ({ WorkerRail }) => {
    const html = renderToStaticMarkup(React.createElement(WorkerRail, {
      query: "导师",
      onQueryChange() {},
    }));

    assert.match(html, /Agent 邮箱 Worker/);
    assert.match(html, /给导师发送本周进展/);
    assert.match(html, /aria-label="在“Agent 邮箱 Worker”下新建任务"/);
    assert.doesNotMatch(html, /飞书文档 Worker/);
    assert.doesNotMatch(html, /IMA 笔记 Worker/);
    assert.doesNotMatch(html, /整理本周项目进展/);
    assert.doesNotMatch(html, /aria-label="在“飞书文档 Worker”下新建任务"/);
  });
});

test("IMA Worker exposes explicit note reads, Markdown drafts, and no external delivery form", async () => {
  await withViteModule("/src/components/WorkerWorkspace.jsx", ({ WorkerWorkspace }) => {
    const sourcesHtml = renderToStaticMarkup(React.createElement(WorkerWorkspace, {
      state: createInitialWorkerState({
        workerId: WORKER_IDS.IMA_NOTE,
        activeArtifactId: WORKER_ARTIFACTS.SOURCES,
        deliveryProposal: null,
      }),
      dispatch() {},
      initialArtifactOpen: true,
    }));
    assert.match(sourcesHtml, /IMA 笔记 Worker/);
    assert.match(sourcesHtml, /列出笔记本/);
    assert.match(sourcesHtml, /列出笔记/);
    assert.match(sourcesHtml, /搜索笔记/);
    assert.match(sourcesHtml, /读取笔记正文/);
    assert.match(sourcesHtml, /游标（首页为 0）/);

    const draftHtml = renderToStaticMarkup(React.createElement(WorkerWorkspace, {
      state: createInitialWorkerState({
        workerId: WORKER_IDS.IMA_NOTE,
        activeArtifactId: WORKER_ARTIFACTS.DRAFT,
        deliveryProposal: null,
      }),
      dispatch() {},
      initialArtifactOpen: true,
    }));
    assert.match(draftHtml, /<option value="markdown" selected="">Markdown<\/option>/);
    assert.doesNotMatch(draftHtml, /XML（默认）|纯文本|HTML/);

    const deliveryHtml = renderToStaticMarkup(React.createElement(WorkerWorkspace, {
      state: createInitialWorkerState({
        workerId: WORKER_IDS.IMA_NOTE,
        activeArtifactId: WORKER_ARTIFACTS.DELIVERY,
        deliveryProposal: null,
      }),
      dispatch() {},
      initialArtifactOpen: true,
    }));
    assert.match(deliveryHtml, /只读 \/ 草稿阶段/);
    assert.match(deliveryHtml, /IMA 外部写入尚未开放/);
    assert.match(deliveryHtml, /不能创建或追加 IMA 笔记/);
    assert.doesNotMatch(deliveryHtml, /生成精确交付预览|收件人|当前飞书文档/);
  });
});

test("WorkerWorkspace keeps the Agent full width until the artifact is opened", async () => {
  await withViteModule("/src/components/WorkerWorkspace.jsx", ({ WorkerWorkspace }) => {
    const html = renderToStaticMarkup(React.createElement(WorkerWorkspace, {
      projectOptions: [{ id: "project-pi", label: "Pi Agent 产品设计" }],
    }));

    assert.match(html, /Agent 邮箱 Worker/);
    assert.match(html, /给导师发送本周进展/);
    assert.match(html, /打开工件/);
    assert.match(html, /选择只读项目背景/);
    assert.match(html, /打开、切换和编辑草稿不会调用模型/);
    assert.doesNotMatch(html, /aria-label="Worker 工件"/);
    assert.doesNotMatch(html, /直接编辑任务草稿/);
  });
});

test("opened WorkerWorkspace exposes sources, editable draft, delivery, and receipt artifacts", async () => {
  await withViteModule("/src/components/WorkerWorkspace.jsx", ({ WorkerWorkspace }) => {
    const state = createInitialWorkerState({
      projectContext: { id: "project-pi", label: "Pi Agent 产品设计" },
    });
    const html = renderToStaticMarkup(React.createElement(WorkerWorkspace, {
      state,
      dispatch() {},
      projectOptions: [{ id: "project-pi", label: "Pi Agent 产品设计" }],
      initialArtifactOpen: true,
    }));

    assert.match(html, /aria-label="Worker 工件"/);
    assert.match(html, />资料</);
    assert.match(html, />草稿</);
    assert.match(html, />交付/);
    assert.match(html, />回执</);
    assert.match(html, /直接编辑任务草稿/);
    assert.match(html, /版本 3/);
    assert.match(html, /保存新版本/);
    assert.match(html, /直接编辑只形成新草稿版本，不会调用模型或执行外部操作/);
    assert.match(html, /Pi Agent 产品设计 · 只读/);
  });
});

test("delivery preview co-locates exact content, hashes, abandon, and hash-bound confirmation", async () => {
  await withViteModule("/src/components/WorkerWorkspace.jsx", ({ WorkerWorkspace }) => {
    const state = createInitialWorkerState({
      activeArtifactId: WORKER_ARTIFACTS.DELIVERY,
    });
    const html = renderToStaticMarkup(React.createElement(WorkerWorkspace, {
      state,
      dispatch() {},
      initialArtifactOpen: true,
    }));

    assert.match(html, /外部交付预览/);
    assert.match(html, /导师邮箱 · 已验证联系人/);
    assert.match(html, /本周项目进展与下一步计划/);
    assert.match(html, /精确交付内容/);
    assert.match(html, /sha256:9e2a8f7d52b92b2c20b11886e3d9a0a18541267f89e58390f822709e2de63a8f/);
    assert.match(html, /sha256:af4a511413644348df34320a87f5f197e1f3068f9c7c277d53c204c0776f2f91/);
    assert.match(html, /放弃本次交付/);
    assert.match(html, /确认执行本次交付/);
    assert.match(html, /确认只对当前目标、操作、草稿版本和内容哈希有效/);
  });
});

test("editing a draft immediately invalidates the prepared proposal and saving creates a new revision", () => {
  const initial = createInitialWorkerState();
  assert.ok(createDeliveryConfirmationInput(initial));

  const edited = workerReducer(initial, {
    type: WORKER_ACTIONS.SET_DRAFT_BUFFER,
    value: `${initial.draftBuffer}\n\n谢谢老师。`,
  });

  assert.equal(edited.status, WORKER_STATUS.DRAFTING);
  assert.equal(edited.draftDirty, true);
  assert.equal(edited.deliveryProposal.status, DELIVERY_STATUS.STALE);
  assert.equal(edited.deliveryProposal.nativeConfirmationPrepared, false);
  assert.equal(createDeliveryConfirmationInput(edited), null);

  const saved = workerReducer(edited, { type: WORKER_ACTIONS.SAVE_DRAFT });
  assert.equal(saved.draftRevision.version, initial.draftRevision.version + 1);
  assert.equal(saved.draftRevision.content, edited.draftBuffer);
  assert.equal(saved.draftRevision.contentHash, null);
  assert.equal(saved.draftDirty, false);
  assert.equal(saved.deliveryProposal.status, DELIVERY_STATUS.STALE);
  assert.equal(createDeliveryConfirmationInput(saved), null);
});

test("starting a format-only draft edit invalidates once and cannot revive the old proposal", () => {
  const initial = createInitialWorkerState();
  const started = workerReducer(initial, { type: WORKER_ACTIONS.START_DRAFT_EDIT });
  assert.equal(started.draftDirty, true);
  assert.equal(started.deliveryProposal.status, DELIVERY_STATUS.STALE);
  assert.equal(started.deliveryProposal.confirmationPrepared, false);
  assert.equal(createDeliveryConfirmationInput(started), null);
  assert.equal(
    workerReducer(started, { type: WORKER_ACTIONS.START_DRAFT_EDIT }),
    started,
  );
});

test("stale delivery preview distinguishes the current revision from its old binding", async () => {
  await withViteModule("/src/components/WorkerWorkspace.jsx", ({ WorkerWorkspace }) => {
    const initial = createInitialWorkerState();
    const edited = workerReducer(initial, {
      type: WORKER_ACTIONS.SET_DRAFT_BUFFER,
      value: `${initial.draftBuffer}\n\n谢谢老师。`,
    });
    const state = {
      ...workerReducer(edited, { type: WORKER_ACTIONS.SAVE_DRAFT }),
      activeArtifactId: WORKER_ARTIFACTS.DELIVERY,
    };
    const html = renderToStaticMarkup(React.createElement(WorkerWorkspace, {
      state,
      dispatch() {},
      initialArtifactOpen: true,
    }));

    assert.match(html, /当前草稿/);
    assert.match(html, /版本 4 · draft-revision-local-4/);
    assert.match(html, /提案绑定/);
    assert.match(html, /draft-revision-mail-3 · 已失效/);
    assert.match(html, /确认执行本次交付/);
    assert.match(html, /disabled/);
  });
});

test("delivery confirmation advances only with the exact proposal and draft revision hashes", () => {
  const initial = createInitialWorkerState();
  const input = createDeliveryConfirmationInput(initial);
  assert.ok(input);

  const wrongHash = workerReducer(initial, {
    type: WORKER_ACTIONS.CONFIRM_DELIVERY,
    proposalHash: "sha256:wrong",
    draftRevisionId: input.draftRevisionId,
  });
  assert.equal(wrongHash, initial);

  const wrongRevision = workerReducer(initial, {
    type: WORKER_ACTIONS.CONFIRM_DELIVERY,
    proposalHash: input.proposalHash,
    draftRevisionId: "draft-revision-other",
  });
  assert.equal(wrongRevision, initial);

  const confirmed = workerReducer(initial, {
    type: WORKER_ACTIONS.CONFIRM_DELIVERY,
    proposalHash: input.proposalHash,
    draftRevisionId: input.draftRevisionId,
  });
  assert.equal(confirmed.status, WORKER_STATUS.DELIVERING);
  assert.equal(confirmed.deliveryProposal.status, DELIVERY_STATUS.CONFIRMING);
});

test("delivery confirmation fails closed for an expired, unprepared, or cross-Worker proposal", () => {
  const initial = createInitialWorkerState();
  assert.equal(createDeliveryConfirmationInput({
    ...initial,
    deliveryProposal: { ...initial.deliveryProposal, previewComplete: false },
  }), null);
  assert.equal(createDeliveryConfirmationInput({
    ...initial,
    deliveryProposal: {
      ...initial.deliveryProposal,
      confirmationPrepared: false,
      nativeConfirmationPrepared: false,
    },
  }), null);
  assert.equal(createDeliveryConfirmationInput({
    ...initial,
    deliveryProposal: { ...initial.deliveryProposal, expiresAt: "not-a-date" },
  }), null);
  assert.equal(createDeliveryConfirmationInput({
    ...initial,
    deliveryProposal: { ...initial.deliveryProposal, workerId: WORKER_IDS.LARK_DOCUMENT },
  }), null);
  assert.equal(createDeliveryConfirmationInput({
    ...initial,
    deliveryProposal: {
      ...initial.deliveryProposal,
      attachments: [{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }],
    },
  }), null);

  const lark = createInitialWorkerState({ workerId: WORKER_IDS.LARK_DOCUMENT });
  assert.equal(createDeliveryConfirmationInput({
    ...lark,
    deliveryProposal: { ...lark.deliveryProposal, baseRevision: null },
  }), null);
});

test("selecting optional project context is read-only state and does not alter messages or delivery", () => {
  const initial = createInitialWorkerState();
  const context = { id: "project-pi", label: "Pi Agent 产品设计" };
  const initializedWithContext = createInitialWorkerState({ projectContext: context });
  assert.equal(initializedWithContext.projectId, null);
  assert.deepEqual(initializedWithContext.projectContext, context);
  const next = workerReducer(initial, {
    type: WORKER_ACTIONS.SET_PROJECT_CONTEXT,
    context,
  });

  assert.deepEqual(next.projectContext, context);
  assert.equal(next.projectId, null);
  assert.equal(next.messages, initial.messages);
  assert.equal(next.draftRevision, initial.draftRevision);
  assert.equal(next.deliveryProposal, initial.deliveryProposal);
  assert.equal(next.workspaceKind, "scratch");
  assert.equal(next.workType, "worker");
});

test("unknown delivery receipts require manual checking and never promise automatic retry", async () => {
  await withViteModule("/src/components/WorkerWorkspace.jsx", ({ WorkerWorkspace }) => {
    const initial = createInitialWorkerState();
    const state = workerReducer(initial, {
      type: WORKER_ACTIONS.SET_RECEIPT,
      receipt: {
        id: "receipt-unknown-1",
        status: "unknown",
        summary: "发送结果暂时无法确认",
        detail: "邮箱服务没有返回确定结果。",
        externalId: null,
        createdAtLabel: "刚刚",
        proposalHash: initial.deliveryProposal.proposalHash,
        readbackLabel: "等待人工核对",
      },
    });
    const html = renderToStaticMarkup(React.createElement(WorkerWorkspace, {
      state,
      dispatch() {},
      initialArtifactOpen: true,
    }));

    assert.match(html, /发送结果暂时无法确认/);
    assert.match(html, /等待人工核对/);
    assert.match(html, /系统不会自动重试/);
    assert.match(html, /已人工核对并结束提案/);
    assert.doesNotMatch(html, /已送达|对方已收到/);
  });
});

test("manual unknown closure requires a second explicit confirmation", async () => {
  await withViteModule(
    "/src/components/WorkerWorkspace.jsx",
    ({ confirmUnknownDeliveryClosure }) => {
      const prompts = [];
      assert.equal(confirmUnknownDeliveryClosure((message) => {
        prompts.push(message);
        return false;
      }), false);
      assert.equal(confirmUnknownDeliveryClosure(() => true), true);
      assert.match(prompts[0], /已在对应外部服务中人工核对/);
      assert.match(prompts[0], /不会判断它成功或失败/);
    },
  );
});

test("a manually resolved unknown receipt stays non-successful and unlocks the task", async () => {
  await withViteModule("/src/components/WorkerWorkspace.jsx", ({ WorkerWorkspace }) => {
    const initial = createInitialWorkerState();
    const state = workerReducer(initial, {
      type: WORKER_ACTIONS.SET_RECEIPT,
      receipt: {
        id: "receipt-manual-1",
        status: "manual_resolved",
        statusLabel: "人工核对已记录",
        summary: "人工核对已记录",
        detail: "Pi Agent 未判断外部操作成功或失败；本次提案已结束，可以准备新的交付。",
        externalId: null,
        createdAtLabel: "刚刚",
        proposalHash: initial.deliveryProposal.proposalHash,
        readbackLabel: "人工核对已记录",
      },
    });
    assert.equal(state.status, WORKER_STATUS.READY);
    assert.equal(state.deliveryProposal.status, DELIVERY_STATUS.ABANDONED);
    const html = renderToStaticMarkup(React.createElement(WorkerWorkspace, {
      state,
      dispatch() {},
      initialArtifactOpen: true,
    }));

    assert.match(html, /人工核对已记录/);
    assert.match(html, /未判断外部操作成功或失败/);
    assert.doesNotMatch(html, /外部交付已完成|已送达|对方已收到/);
  });
});

test("built-in action catalog covers document, mail, and read-only IMA note scope", () => {
  const larkIds = new Set(WORKER_ACTION_CATALOG[WORKER_IDS.LARK_DOCUMENT].map((action) => action.id));
  const mailIds = new Set(WORKER_ACTION_CATALOG[WORKER_IDS.AGENT_MAIL].map((action) => action.id));
  const imaActions = WORKER_ACTION_CATALOG[WORKER_IDS.IMA_NOTE];
  const imaIds = new Set(imaActions.map((action) => action.id));

  for (const actionId of [
    "fetch",
    "create",
    "append",
    "overwrite",
    "str_replace",
    "block_insert_after",
    "block_replace",
    "block_delete",
    "block_move_after",
    "history_list",
    "history_revert",
  ]) {
    assert.equal(larkIds.has(actionId), true, `missing Lark action: ${actionId}`);
  }

  for (const actionId of [
    "list",
    "search",
    "read",
    "attachment_download",
    "send",
    "reply",
    "reply_all",
    "forward",
    "trash",
  ]) {
    assert.equal(mailIds.has(actionId), true, `missing Agent Mail action: ${actionId}`);
  }

  assert.deepEqual(
    [...imaIds],
    ["list_notebook", "list_note", "search_note", "get_doc_content"],
  );
  assert.ok(imaActions.every((action) => action.mode === "read"));
});

test("each built-in Worker initializes with its own task, copy, and delivery contract", () => {
  const lark = createInitialWorkerState({ workerId: WORKER_IDS.LARK_DOCUMENT });
  const mail = createInitialWorkerState({ workerId: WORKER_IDS.AGENT_MAIL });
  const ima = createInitialWorkerState({ workerId: WORKER_IDS.IMA_NOTE });

  assert.equal(lark.worker.id, WORKER_IDS.LARK_DOCUMENT);
  assert.equal(lark.task.workerId, WORKER_IDS.LARK_DOCUMENT);
  assert.equal(lark.task.title, "整理本周项目进展");
  assert.equal(lark.deliveryProposal.operation, "str_replace");
  assert.equal(lark.deliveryProposal.baseRevision, "版本 128");
  assert.equal(lark.deliveryProposal.affectedBlockCount, 2);
  assert.match(lark.messages[1].content, /真正修改飞书前会读取当前版本/);
  assert.doesNotMatch(lark.messages[0].content, /导师|邮件/);

  assert.equal(mail.worker.id, WORKER_IDS.AGENT_MAIL);
  assert.equal(mail.task.workerId, WORKER_IDS.AGENT_MAIL);
  assert.equal(mail.deliveryProposal.operation, "send");
  assert.equal(mail.deliveryProposal.baseRevision, null);

  assert.equal(ima.worker.id, WORKER_IDS.IMA_NOTE);
  assert.equal(ima.task.workerId, WORKER_IDS.IMA_NOTE);
  assert.equal(ima.task.title, "整理 IMA 笔记");
  assert.equal(ima.draftRevision.format, "markdown");
  assert.equal(ima.deliveryProposal, null);
  assert.equal(ima.status, WORKER_STATUS.DRAFTING);
});

test("Worker Agent renders bounded plan progress, safe assistant Markdown, and literal user text", async () => {
  await withViteModule("/src/components/WorkerWorkspace.jsx", ({ WorkerWorkspace }) => {
    const state = createInitialWorkerState({
      messages: [
        { id: "user-literal", role: "user", content: "<strong>不要渲染</strong>" },
        { id: "assistant-markdown", role: "assistant", content: "## 已整理\n\n- 第一项\n\n<script>danger()</script>" },
      ],
      conversation: {
        status: "running",
        plan: { steps: [{ id: "step-1", title: "核对资料", status: "in_progress" }] },
        events: [{ seq: 1, type: "agent.progress", data: { detail: "正在形成草稿" } }],
      },
    });
    const html = renderToStaticMarkup(React.createElement(WorkerWorkspace, {
      state,
      dispatch() {},
    }));

    assert.match(html, /当前计划/);
    assert.match(html, /核对资料/);
    assert.match(html, /最新进度/);
    assert.match(html, /正在形成草稿/);
    assert.match(html, /<h2>已整理<\/h2>/);
    assert.match(html, /&lt;strong&gt;不要渲染&lt;\/strong&gt;/);
    assert.doesNotMatch(html, /<script>|danger\(\)/);
    assert.match(html, /作为草稿编辑/);
  });
});

test("Worker composer submits plain Enter but not Shift+Enter or IME confirmation", async () => {
  await withViteModule(
    "/src/components/WorkerWorkspace.jsx",
    ({ shouldSubmitWorkerComposerKeyDown }) => {
      assert.equal(shouldSubmitWorkerComposerKeyDown({ key: "Enter" }), true);
      assert.equal(shouldSubmitWorkerComposerKeyDown({ key: "Enter", shiftKey: true }), false);
      assert.equal(shouldSubmitWorkerComposerKeyDown({ key: "Enter", isComposing: true }), false);
      assert.equal(shouldSubmitWorkerComposerKeyDown({
        key: "Enter",
        nativeEvent: { isComposing: true },
      }), false);
      assert.equal(shouldSubmitWorkerComposerKeyDown({ key: "a" }), false);
    },
  );
});

test("mail trash previews retain exact current content without implying the body is deleted", async () => {
  await withViteModule("/src/components/WorkerWorkspace.jsx", ({ WorkerWorkspace }) => {
    const initial = createInitialWorkerState();
    const state = createInitialWorkerState({
      activeArtifactId: WORKER_ARTIFACTS.DELIVERY,
      deliveryProposal: {
        ...initial.deliveryProposal,
        id: "delivery-trash",
        operation: "trash",
        operationLabel: "移入回收站（保留 30 天）",
        risk: "high",
        beforeContent: "主题：旧邮件\n正文：需要保留的精确内容",
        afterContent: null,
        exactContent: "",
        draftRevisionId: null,
        draftHash: null,
      },
    });
    const html = renderToStaticMarkup(React.createElement(WorkerWorkspace, {
      state,
      dispatch() {},
      initialArtifactOpen: true,
    }));

    assert.match(html, /主题：旧邮件/);
    assert.match(html, /需要保留的精确内容/);
    assert.match(html, /邮件将移入回收站/);
    assert.match(html, /正文内容不会被改写/);
    assert.doesNotMatch(html, /删除后|无内容（移入回收站或删除）/);
  });
});

test("live exact-operation proposals render every bound field without presenting non-document results as deletion", async () => {
  const cases = [{
    operation: "append",
    diff: { kind: "append", content: "<p>追加正文</p>", format: "xml" },
    expected: [/追加内容/, /写入内容/, /追加正文/],
    draftBound: true,
  }, {
    operation: "str_replace",
    diff: { kind: "str_replace", pattern: "旧句", replacement: "新句", format: "xml" },
    expected: [/待替换内容/, /旧句/, /替换为/, /新句/],
    draftBound: true,
  }, {
    operation: "block_insert_after",
    diff: { kind: "block_insert_after", blockId: "blk_anchor", content: "<p>插入正文</p>", format: "xml" },
    expected: [/目标块 ID/, /blk_anchor/, /插入正文/],
    draftBound: true,
  }, {
    operation: "block_replace",
    diff: { kind: "block_replace", blockId: "blk_target", content: "<p>替换正文</p>", format: "xml" },
    expected: [/目标块 ID/, /blk_target/, /替换正文/],
    draftBound: true,
  }, {
    operation: "block_delete",
    diff: { kind: "block_delete", blockIds: ["blk_delete_a", "blk_delete_b"] },
    expected: [/删除前完整正文/, /待删除块 ID/, /blk_delete_a/, /完整删除后正文由飞书生成/],
    draftBound: false,
  }, {
    operation: "block_move_after",
    diff: { kind: "block_move_after", anchorBlockId: "blk_anchor", sourceBlockIds: ["blk_move_a"] },
    expected: [/目标锚点块 ID/, /blk_anchor/, /待移动块 ID/, /blk_move_a/],
    draftBound: false,
  }];

  await withViteModule("/src/components/WorkerWorkspace.jsx", ({ WorkerWorkspace }) => {
    for (const item of cases) {
      const draft = {
        id: "draft-live",
        version: 2,
        content: "<p>草稿正文</p>",
        format: "xml",
        sha256: "sha256:draft-live",
        source: "user",
      };
      const state = adaptWorkerBundle({
        task: {
          id: `task-${item.operation}`,
          workerId: WORKER_IDS.LARK_DOCUMENT,
          title: item.operation,
          sourceProjectId: null,
        },
        conversation: {
          conversation: { id: `conversation-${item.operation}`, status: "idle", messages: [] },
          events: [],
        },
        draft,
        sources: [],
        files: [],
        actions: [{
          id: `proposal-${item.operation}`,
          workerId: WORKER_IDS.LARK_DOCUMENT,
          operation: item.operation,
          risk: item.operation === "block_delete" ? "high" : "medium",
          status: "pending_confirmation",
          proposalHash: `sha256:${item.operation}`,
          draftRevisionId: item.draftBound ? draft.id : null,
          draftSha256: item.draftBound ? draft.sha256 : null,
          baseRevisionId: 22,
          parameters: { document: "doc-token" },
          preview: {
            operationLabel: item.operation,
            contentContract: "full_before_with_exact_operation_diff",
            target: { document: "doc-token", baseRevisionId: 22 },
            before: "<doc><p>当前完整正文</p></doc>",
            after: null,
            fullBefore: "<doc><p>当前完整正文</p></doc>",
            fullAfter: null,
            exactOperationDiff: item.diff,
            warnings: [],
          },
          preparation: {},
        }],
        receipts: [],
      });
      const html = renderToStaticMarkup(React.createElement(WorkerWorkspace, {
        state: { ...state, activeArtifactId: WORKER_ARTIFACTS.DELIVERY },
        dispatch() {},
        initialArtifactOpen: true,
      }));

      assert.match(html, /精确操作差异/, item.operation);
      for (const pattern of item.expected) assert.match(html, pattern, item.operation);
      assert.doesNotMatch(html, /<strong>删除后|无内容（移入回收站或删除）/, item.operation);
    }
  });
});

test("queued Lark history restore exposes status polling and blocks a second delivery", async () => {
  await withViteModule("/src/components/WorkerWorkspace.jsx", ({ WorkerWorkspace }) => {
    const state = adaptWorkerBundle({
      task: {
        id: "task-history-pending",
        workerId: WORKER_IDS.LARK_DOCUMENT,
        title: "恢复历史版本",
        sourceProjectId: null,
      },
      conversation: {
        conversation: { id: "conversation-history-pending", status: "idle", messages: [] },
        events: [],
      },
      draft: null,
      sources: [],
      files: [],
      actions: [{
        id: "proposal-history-pending",
        workerId: WORKER_IDS.LARK_DOCUMENT,
        operation: "history_revert",
        risk: "high",
        status: "queued",
        proposalHash: "sha256:history-pending",
        draftRevisionId: null,
        draftSha256: null,
        baseRevisionId: 22,
        parameters: { document: "doc-token", historyVersionId: "history-3" },
        preview: {
          operationLabel: "恢复飞书历史版本",
          contentContract: "full_before_and_after",
          target: { document: "doc-token", baseRevisionId: 22 },
          before: "当前正文",
          after: "历史正文",
          fullBefore: "当前正文",
          fullAfter: "历史正文",
          warnings: [],
        },
      }],
      receipts: [{
        id: "receipt-history-pending",
        proposalId: "proposal-history-pending",
        workerId: WORKER_IDS.LARK_DOCUMENT,
        status: "queued",
        providerState: "running",
        verification: { status: "pending_provider_completion" },
      }],
    });
    const html = renderToStaticMarkup(React.createElement(WorkerWorkspace, {
      state: { ...state, activeArtifactId: WORKER_ARTIFACTS.DELIVERY },
      dispatch() {},
      initialArtifactOpen: true,
    }));

    assert.match(html, /飞书仍在处理版本恢复/);
    assert.match(html, />续查状态</);
    assert.match(html, /不会再次执行版本恢复/);
    assert.doesNotMatch(html, /确认执行本次交付|准备交付预览/);
  });
});

test("reply, reply-all, and forward previews show resolved recipients and original attachments", async () => {
  const cases = [{
    operation: "reply",
    target: {
      messageId: "msg_reply",
      resolvedRecipients: { to: ["sender@example.com"], cc: [] },
      cc: ["added@example.com"],
      bcc: [],
    },
    after: { body: "回复正文", bodyFormat: "plain", attachments: [] },
    expected: [/收件人 To/, /sender@example\.com/, /新增抄送 CC/, /added@example\.com/],
  }, {
    operation: "reply_all",
    target: {
      messageId: "msg_reply_all",
      resolvedRecipients: {
        to: ["sender@example.com", "peer@example.com"],
        cc: ["team@example.com"],
      },
      cc: ["added@example.com"],
      bcc: ["audit@example.com"],
    },
    after: { body: "回复全部正文", bodyFormat: "plain", attachments: [] },
    expected: [
      /sender@example\.com、peer@example\.com/,
      /回复抄送 CC/,
      /team@example\.com/,
      /新增抄送 CC/,
      /密送 BCC/,
      /audit@example\.com/,
    ],
  }, {
    operation: "forward",
    target: {
      messageId: "msg_forward",
      to: ["reviewer@example.com"],
      cc: [],
      bcc: [],
    },
    after: {
      body: "转发说明",
      bodyFormat: "plain",
      attachments: [],
      includeOriginalAttachments: true,
      includedOriginalAttachments: [{ id: "att_original", name: "原报告.pdf", size: 4096 }],
    },
    expected: [/收件人 To/, /reviewer@example\.com/, /随转发保留的原附件 · 1/, /原报告\.pdf/],
  }];

  await withViteModule("/src/components/WorkerWorkspace.jsx", ({ WorkerWorkspace }) => {
    for (const item of cases) {
      const draft = {
        id: "draft-mail-live",
        version: 1,
        content: item.after.body,
        format: "plain",
        sha256: "sha256:draft-mail-live",
        source: "user",
      };
      const state = adaptWorkerBundle({
        task: {
          id: `task-${item.operation}`,
          workerId: WORKER_IDS.AGENT_MAIL,
          title: item.operation,
          sourceProjectId: null,
        },
        conversation: {
          conversation: { id: `conversation-${item.operation}`, status: "idle", messages: [] },
          events: [],
        },
        draft,
        sources: [],
        files: [],
        actions: [{
          id: `proposal-${item.operation}`,
          workerId: WORKER_IDS.AGENT_MAIL,
          operation: item.operation,
          risk: "medium",
          status: "pending_confirmation",
          proposalHash: `sha256:${item.operation}`,
          draftRevisionId: draft.id,
          draftSha256: draft.sha256,
          baseRevisionId: null,
          parameters: { messageId: item.target.messageId },
          preview: {
            operationLabel: item.operation,
            target: item.target,
            before: { subject: "原邮件", body: "原正文" },
            after: item.after,
            warnings: [],
          },
          preparation: {
            confirmationRequired: true,
            confirmationExpiresAt: "2099-01-01T00:00:00.000Z",
            summary: {
              operation: item.operation,
              to: item.target.resolvedRecipients?.to ?? item.target.to,
              body_preview: item.after.body,
            },
          },
        }],
        receipts: [],
      });
      const html = renderToStaticMarkup(React.createElement(WorkerWorkspace, {
        state: { ...state, activeArtifactId: WORKER_ARTIFACTS.DELIVERY },
        dispatch() {},
        initialArtifactOpen: true,
      }));

      for (const pattern of item.expected) assert.match(html, pattern, item.operation);
      assert.match(html, /Agent 邮箱原生确认摘要/, item.operation);
      assert.match(html, /body_preview/, item.operation);
      assert.doesNotMatch(html, /ctk_/, item.operation);
    }
  });
});

test("only retryable delivery failures expose retry; unknown outcomes stop for manual checking", async () => {
  await withViteModule("/src/components/WorkerWorkspace.jsx", ({ WorkerWorkspace }) => {
    const initial = createInitialWorkerState();
    const retryable = createInitialWorkerState({
      activeArtifactId: WORKER_ARTIFACTS.DELIVERY,
      deliveryProposal: {
        ...initial.deliveryProposal,
        status: DELIVERY_STATUS.FAILED,
        retryable: true,
        error: { message: "临时连接失败" },
      },
    });
    const retryableHtml = renderToStaticMarkup(React.createElement(WorkerWorkspace, {
      state: retryable,
      dispatch() {},
      initialArtifactOpen: true,
    }));
    assert.match(retryableHtml, /重新准备此提案/);

    const unknown = createInitialWorkerState({
      activeArtifactId: WORKER_ARTIFACTS.DELIVERY,
      deliveryProposal: {
        ...initial.deliveryProposal,
        status: DELIVERY_STATUS.UNKNOWN,
        retryable: false,
        error: { message: "发送结果未知" },
      },
    });
    const unknownHtml = renderToStaticMarkup(React.createElement(WorkerWorkspace, {
      state: unknown,
      dispatch() {},
      initialArtifactOpen: true,
    }));
    assert.match(unknownHtml, /外部结果不确定，已安全停止/);
    assert.match(unknownHtml, /发送结果未知/);
    assert.match(unknownHtml, /已人工核对并结束提案/);
    assert.doesNotMatch(unknownHtml, /重新准备此提案/);
  });
});

test("source reads remain explicit and Lark drafts default to XML", async () => {
  await withViteModule("/src/components/WorkerWorkspace.jsx", ({ WorkerWorkspace }) => {
    const state = createInitialWorkerState({
      workerId: WORKER_IDS.LARK_DOCUMENT,
      activeArtifactId: WORKER_ARTIFACTS.SOURCES,
    });
    const sourcesHtml = renderToStaticMarkup(React.createElement(WorkerWorkspace, {
      state,
      dispatch() {},
      initialArtifactOpen: true,
    }));
    assert.match(sourcesHtml, /只在点击读取后调用对应连接/);
    assert.match(sourcesHtml, /读取并加入资料/);
    assert.match(sourcesHtml, /飞书交付只能绑定“完整内容”读取结果/);
    assert.match(sourcesHtml, /“带块 ID”仅用于只读检查/);
    assert.match(sourcesHtml, /max="20"/);
    assert.doesNotMatch(sourcesHtml, /安全相对目录|\.\.\/unsafe/);

    const draftHtml = renderToStaticMarkup(React.createElement(WorkerWorkspace, {
      state: { ...state, activeArtifactId: WORKER_ARTIFACTS.DRAFT },
      dispatch() {},
      initialArtifactOpen: true,
    }));
    assert.match(draftHtml, /<option value="xml" selected="">XML（默认）<\/option>/);
  });
});

test("delivery receipts retain proposal hash, content hash, and read-back verification", async () => {
  await withViteModule("/src/components/WorkerWorkspace.jsx", ({ WorkerWorkspace }) => {
    const state = createInitialWorkerState({
      activeArtifactId: WORKER_ARTIFACTS.RECEIPT,
      receipt: {
        id: "receipt-safe",
        status: "completed",
        statusLabel: "交付已完成",
        summary: "飞书内容已更新",
        detail: "写入后已回读核对。",
        externalId: "doc-123",
        createdAtLabel: "刚刚",
        proposalHash: "sha256:proposal-safe",
        draftSha256: "sha256:draft-safe",
        readbackLabel: "已回读验证",
      },
    });
    const html = renderToStaticMarkup(React.createElement(WorkerWorkspace, {
      state,
      dispatch() {},
      initialArtifactOpen: true,
    }));

    assert.match(html, /sha256:proposal-safe/);
    assert.match(html, /sha256:draft-safe/);
    assert.match(html, /已回读验证/);
  });
});

test("mail delivery form stages controlled attachments and never asks for a browser file path", async () => {
  await withViteModule("/src/components/WorkerWorkspace.jsx", ({ WorkerWorkspace }) => {
    const state = createInitialWorkerState({
      activeArtifactId: WORKER_ARTIFACTS.DELIVERY,
      deliveryProposal: null,
      deliveryFiles: [{
        id: "worker-file-1",
        name: "report.pdf",
        mimeType: "application/pdf",
        byteLength: 4096,
        contentHash: "sha256:file",
        status: "ready",
      }],
    });
    const html = renderToStaticMarkup(React.createElement(WorkerWorkspace, {
      state,
      dispatch() {},
      initialArtifactOpen: true,
    }));

    assert.match(html, /上传受控附件/);
    assert.match(html, /report\.pdf/);
    assert.match(html, /交付附件 · 1\/3/);
    assert.match(html, /提案会绑定持久读取来源、附件哈希/);
    assert.doesNotMatch(html, /相对路径|\.\.\/|work\/attachments/);
  });
});
