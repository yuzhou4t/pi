import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import {
  createInitialProjectWorkState,
  PROJECT_WORK_ACTIONS,
  PROJECT_WORK_FIXTURE,
  projectWorkReducer,
} from "../project-work/projectWorkState.js";

const providers = [{
  id: "codex-subscription",
  name: "Codex 订阅",
  available: true,
  models: ["account-default"],
  hint: "本机登录",
}];

function reachConfirmation() {
  let state = createInitialProjectWorkState({
    providerId: "codex-subscription",
    modelId: "account-default",
  });
  state = projectWorkReducer(state, { type: PROJECT_WORK_ACTIONS.SEND_TASK });
  state = projectWorkReducer(state, { type: PROJECT_WORK_ACTIONS.START_EXECUTION });
  for (const step of PROJECT_WORK_FIXTURE.plan) {
    state = projectWorkReducer(state, {
      type: PROJECT_WORK_ACTIONS.ADVANCE_PLAN,
      stepId: step.id,
    });
  }
  return state;
}

function reachCompleted() {
  let state = reachConfirmation();
  state = projectWorkReducer(state, {
    type: PROJECT_WORK_ACTIONS.CONFIRM_CHANGES,
    changeSetId: state.changeSet.id,
    baseHash: state.changeSet.baseHash,
    afterHash: state.changeSet.afterHash,
    selectedFileIds: state.changeSet.files.map((file) => file.id),
  });
  state = projectWorkReducer(state, { type: PROJECT_WORK_ACTIONS.RUN_TESTS });
  return projectWorkReducer(state, { type: PROJECT_WORK_ACTIONS.RETRY_TESTS });
}

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

test("project workbench defaults to a full-width Agent and exposes four review artifacts when opened", async () => {
  await withViteModule("/src/components/ProjectWorkbench.jsx", ({ ProjectWorkbench }) => {
    const props = {
      project: { name: "Pi Agent 产品设计" },
      state: createInitialProjectWorkState({
        providerId: "codex-subscription",
        modelId: "account-default",
      }),
      dispatch() {},
      providers,
      providerId: "codex-subscription",
      modelId: "account-default",
    };
    const defaultHtml = renderToStaticMarkup(React.createElement(ProjectWorkbench, props));

    assert.match(defaultHtml, /项目 Agent/);
    assert.match(defaultHtml, /从一个明确任务开始/);
    assert.match(defaultHtml, /打开工件/);
    assert.doesNotMatch(defaultHtml, /aria-label="项目工件"/);

    const openHtml = renderToStaticMarkup(React.createElement(ProjectWorkbench, {
      ...props,
      initialArtifactOpen: true,
    }));

    assert.match(openHtml, /收起工件/);
    assert.match(openHtml, /aria-label="项目工件"/);
    assert.match(openHtml, /文件/);
    assert.match(openHtml, /更改/);
    assert.match(openHtml, /预览/);
    assert.match(openHtml, /运行/);
    assert.match(openHtml, /修复设置页移动端底部按钮遮挡/);
    assert.match(openHtml, /Agent 定位 L3–5/);
    assert.doesNotMatch(openHtml, /MinerU|Zotero|Obsidian|阅读镜头/);
  });
});

test("hash-bound write confirmation is co-located with the exact diff", async () => {
  await withViteModule("/src/components/ProjectWorkbench.jsx", ({ ProjectWorkbench }) => {
    const html = renderToStaticMarkup(React.createElement(ProjectWorkbench, {
      project: { name: "Pi Agent 产品设计" },
      state: reachConfirmation(),
      dispatch() {},
      providers,
      providerId: "codex-subscription",
      modelId: "account-default",
      initialArtifactOpen: true,
    }));

    assert.match(html, /修改已经准备好/);
    assert.match(html, /统一 diff|unified diff/i);
    assert.match(html, /sha256:settings-mobile-before-a91d/);
    assert.match(html, /sha256:settings-mobile-after-c42e/);
    assert.match(html, /确认应用所选修改/);
    assert.match(html, /取消/);
    assert.match(html, /查看文件/);
    assert.match(html, /查看更改/);
  });
});

test("completed activity links open preview, changes, and test evidence", async () => {
  await withViteModule("/src/components/ProjectWorkbench.jsx", ({ ProjectWorkbench }) => {
    const html = renderToStaticMarkup(React.createElement(ProjectWorkbench, {
      project: { name: "Pi Agent 产品设计" },
      state: reachCompleted(),
      dispatch() {},
      providers,
      providerId: "codex-subscription",
      modelId: "account-default",
      initialArtifactOpen: true,
    }));

    assert.match(html, /打开预览/);
    assert.match(html, /查看测试/);
    assert.match(html, /最终更改/);
    assert.match(html, /查看日志/);
    assert.match(html, /退出码 0/);
    assert.match(html, /任务已经完成并通过验证/);
  });
});

test("left rail shows the selected work type, nested conversations, and one project add entry", async () => {
  await withViteModule("/src/components/ProjectRail.jsx", ({ ProjectRail }) => {
    const html = renderToStaticMarkup(React.createElement(ProjectRail, {
      projects: [{
        id: "project-1",
        name: "Pi Agent 产品设计",
        state: "项目工作 · 论文研读",
        updated: "本月",
      }, {
        id: "project-2",
        name: "方法研究",
        state: "2 个会话",
        updated: "昨天",
      }],
      selectedId: "project-1",
      conversations: [{
        id: "work-1",
        projectId: "project-1",
        kind: "project_work",
        title: "修复设置页移动端遮挡",
        subtitle: "项目工作 · 修改待审阅",
        unreadCount: 3,
      }],
      selectedConversationId: "work-1",
      workspaceMode: "project_work",
      query: "",
      onQueryChange() {},
      onNewConversation() {},
      onDeleteConversation() {},
      onRenameConversation() {},
      onAddProject() {},
    }));

    assert.match(html, /Pi Agent 产品设计/);
    assert.match(html, /方法研究/);
    assert.match(html, /正常工作/);
    assert.match(html, /论文精读/);
    assert.match(html, /工作项目/);
    assert.match(html, /向正常工作添加项目/);
    assert.match(html, /在 Pi Agent 产品设计 中新建会话/);
    assert.match(html, /在 方法研究 中新建会话/);
    assert.match(html, /打开“修复设置页移动端遮挡”的更多操作/);
    assert.match(html, /项目工作 · 修改待审阅/);
    assert.match(html, /aria-label="3 条未读消息"/);
    assert.doesNotMatch(html, /收起左边栏/);
    assert.doesNotMatch(html, />会话</);
    assert.doesNotMatch(html, /后台运行/);
  });
});

test("normal work rail exposes first-class standalone conversations before projects", async () => {
  await withViteModule("/src/components/ProjectRail.jsx", ({ ProjectRail }) => {
    const html = renderToStaticMarkup(React.createElement(ProjectRail, {
      projects: [{
        id: "project-1",
        name: "Pi Agent",
        state: "1 个会话",
        updated: "今天",
      }],
      selectedId: "",
      conversations: [{
        id: "standalone-1",
        projectId: null,
        kind: "project_work",
        title: "整理需求",
        subtitle: "正常工作 · 未连接文件夹",
      }],
      selectedConversationId: "standalone-1",
      workspaceMode: "project_work",
      query: "",
      onQueryChange() {},
      onNewStandaloneConversation() {},
      onSelectConversation() {},
      onDeleteConversation() {},
      onRenameConversation() {},
      onAddProject() {},
    }));

    assert.match(html, /新建对话/);
    assert.match(html, /独立对话/);
    assert.match(html, /整理需求/);
    assert.match(html, /未连接文件夹/);
    assert.ok(html.indexOf("独立对话") < html.indexOf("工作项目"));
  });
});

test("paper reading conversations do not expose project-work deletion actions", async () => {
  await withViteModule("/src/components/ProjectRail.jsx", ({ ProjectRail }) => {
    const html = renderToStaticMarkup(React.createElement(ProjectRail, {
      projects: [{
        id: "paper-project",
        name: "期刊研读",
        state: "1 个会话",
        updated: "本月",
      }],
      selectedId: "paper-project",
      conversations: [{
        id: "paper-1",
        projectId: "paper-project",
        kind: "paper_reading",
        title: "精读 · Agent 论文",
        subtitle: "论文精读 · 位置与对话已保存",
      }],
      selectedConversationId: "paper-1",
      workspaceMode: "paper_reading",
      activeRun: {
        id: "journal-week",
        statusLabel: "等待审阅",
      },
      query: "",
      onQueryChange() {},
      onDeleteConversation() {},
      onRenameConversation() {},
      onAddProject() {},
    }));

    assert.match(html, /精读 · Agent 论文/);
    assert.match(html, /每月追踪/);
    assert.match(html, /论文研读/);
    assert.ok(html.indexOf("每月追踪") < html.indexOf("精读 · Agent 论文"));
    assert.doesNotMatch(html, /更多操作|删除会话/);
  });
});

test("paper reading rail keeps weekly tracking visible when no paper was selected to read", async () => {
  await withViteModule("/src/components/ProjectRail.jsx", ({ ProjectRail }) => {
    const html = renderToStaticMarkup(React.createElement(ProjectRail, {
      projects: [{
        id: "paper-project",
        name: "长期研究项目",
        state: "0 篇论文 · 1 个追踪",
        updated: "本月",
      }],
      selectedId: "paper-project",
      conversations: [],
      selectedConversationId: null,
      workspaceMode: "paper_reading",
      activeRun: {
        id: "journal-week",
        statusLabel: "真实候选待审阅",
      },
      selectedRunId: "journal-week",
      query: "",
      onQueryChange() {},
      onAddProject() {},
    }));

    assert.match(html, /每月追踪/);
    assert.match(html, /真实候选待审阅/);
    assert.match(html, /还没有选择研读的论文/);
    assert.match(html, /aria-label="论文研读"/);
  });
});

test("deleting conversation remains in the rail with a busy status", async () => {
  await withViteModule("/src/components/ProjectRail.jsx", ({ ProjectRail }) => {
    const html = renderToStaticMarkup(React.createElement(ProjectRail, {
      projects: [{
        id: "project-1",
        name: "Pi Agent",
        state: "1 个会话",
        updated: "刚刚",
      }],
      selectedId: "project-1",
      conversations: [{
        id: "work-1",
        projectId: "project-1",
        kind: "project_work",
        title: "检查登录页",
        subtitle: "正常工作 · 空闲",
      }],
      selectedConversationId: "work-1",
      deletingConversationId: "work-1",
      workspaceMode: "project_work",
      query: "",
      onQueryChange() {},
      onDeleteConversation() {},
      onRenameConversation() {},
      onAddProject() {},
    }));

    assert.match(html, /检查登录页/);
    assert.match(html, /正在删除/);
    assert.match(html, /disabled/);
    assert.doesNotMatch(html, /更多操作/);
  });
});

test("only the current live busy conversation pre-blocks deletion", async () => {
  await withViteModule("/src/components/ProjectRail.jsx", ({ ProjectRail }) => {
    const html = renderToStaticMarkup(React.createElement(ProjectRail, {
      projects: [{
        id: "project-1",
        name: "Pi Agent",
        state: "2 个会话",
        updated: "刚刚",
      }],
      selectedId: "project-1",
      conversations: [{
        id: "work-current",
        projectId: "project-1",
        kind: "project_work",
        title: "当前运行",
        subtitle: "正常工作 · 正在工作",
        status: "running",
        deleteBlocked: true,
      }, {
        id: "work-background",
        projectId: "project-1",
        kind: "project_work",
        title: "背景旧状态",
        subtitle: "正常工作 · 正在工作",
        status: "running",
        deleteBlocked: false,
      }],
      selectedConversationId: "work-current",
      workspaceMode: "project_work",
      query: "",
      onQueryChange() {},
      onDeleteConversation() {},
      onRenameConversation() {},
      onAddProject() {},
    }));

    assert.equal((html.match(/data-delete-blocked="true"/g) ?? []).length, 1);
    assert.match(html, /打开“当前运行”的更多操作/);
    assert.match(html, /打开“背景旧状态”的更多操作/);
  });
});

test("left rail shows one disabled pending conversation while a project is being prepared", async () => {
  await withViteModule("/src/components/ProjectRail.jsx", ({ ProjectRail }) => {
    const html = renderToStaticMarkup(React.createElement(ProjectRail, {
      projects: [{
        id: "project-1",
        name: "Pi Agent 产品设计",
        state: "0 个会话",
        updated: "刚刚",
      }],
      selectedId: "project-1",
      conversations: [],
      selectedConversationId: null,
      creatingConversationProjectIds: ["project-1"],
      preparingConversationProjectId: "project-1",
      workspaceMode: "project_work",
      query: "",
      onQueryChange() {},
      onNewConversation() {},
      onAddProject() {},
    }));

    assert.match(html, /新工作会话/);
    assert.match(html, /正在创建会话/);
    assert.match(html, /aria-busy="true"/);
    assert.doesNotMatch(html, /还没有会话/);
  });
});
