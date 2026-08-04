import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const COMPONENT_PATH = "/src/components/ProjectSessionPathMenu.jsx";
const STYLES = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

async function withPathMenu(callback) {
  const vite = await createServer({
    root: process.cwd(),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  try {
    return await callback(await vite.ssrLoadModule(COMPONENT_PATH));
  } finally {
    await vite.close();
  }
}

const messages = [{
  id: "message-user-3",
  role: "user",
  turnId: "turn-3",
  turnSeq: 3,
  content: "检查设置页切换模型后为什么没有立即更新",
}, {
  id: "message-gpt-3",
  role: "assistant",
  turnId: "turn-3",
  turnSeq: 3,
  attempt: 1,
  status: "completed",
  turnEvidence: {
    providerId: "openai-codex",
    modelId: "gpt-5.3-codex",
  },
}, {
  id: "message-deepseek-3",
  role: "assistant",
  turnId: "turn-3",
  turnSeq: 3,
  attempt: 2,
  status: "completed",
  turnEvidence: {
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
  },
}];

const sessionPath = {
  activeLeafCheckpointId: "checkpoint-deepseek-3",
  checkpoints: [{
    id: "checkpoint-gpt-3",
    parentId: "checkpoint-previous",
    turnId: "turn-3",
    turnSeq: 3,
    userMessageId: "message-user-3",
    assistantMessageId: "message-gpt-3",
    attempt: 1,
    branchable: true,
    status: "completed",
  }, {
    id: "checkpoint-deepseek-3",
    parentId: "checkpoint-previous",
    turnId: "turn-3",
    turnSeq: 3,
    userMessageId: "message-user-3",
    assistantMessageId: "message-deepseek-3",
    attempt: 2,
    branchable: true,
    status: "completed",
  }],
};

test("path menu groups GPT and DeepSeek attempts under one automatic checkpoint turn", async () => {
  await withPathMenu(({ ProjectSessionPathMenu }) => {
    const html = renderToStaticMarkup(React.createElement(ProjectSessionPathMenu, {
      open: true,
      onOpenChange() {},
      sessionPath,
      messages,
      selectedCheckpointId: "checkpoint-gpt-3",
      onSelectCheckpoint() {},
      onRetryCheckpoint() {},
      onStartBranch() {},
      onForkCheckpoint() {},
    }));

    assert.match(html, /header-meta-pill project-session-path-trigger/);
    assert.match(html, />路径</);
    assert.match(html, /role="dialog"/);
    assert.match(html, /class="project-session-path-body" role="region" aria-label="会话路径内容" tabindex="0"/);
    assert.match(html, /每个已完成回答都会保留为检查点/);
    assert.match(html, /第 3 轮/);
    assert.match(html, /检查设置页切换模型后为什么没有立即更新/);
    assert.match(html, /方案 1/);
    assert.match(html, /openai-codex · gpt-5\.3-codex/);
    assert.match(html, /方案 2/);
    assert.match(html, /deepseek · deepseek-v4-flash/);
    assert.match(html, /aria-checked="true"/);
    assert.match(html, /当前路径/);
    assert.match(html, /用当前模型重做/);
    assert.match(html, /从这里开新方案/);
    assert.match(html, /复制为新会话/);
    assert.doesNotMatch(html, /entryId|entry_id/);
  });
});

test("path content owns the bounded vertical scroll while header and actions stay fixed", () => {
  assert.match(
    STYLES,
    /\.project-session-path-popover\s*\{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\) auto;/s,
  );
  assert.match(
    STYLES,
    /\.project-session-path-body\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/s,
  );
  assert.doesNotMatch(
    STYLES,
    /\.project-session-path-turns\s*\{[^}]*overflow-y:\s*auto;/s,
  );
});

test("selecting an attempt only reports the public checkpoint selection", async () => {
  await withPathMenu(({ selectProjectSessionCheckpoint }) => {
    const calls = [];
    let retries = 0;
    let branches = 0;
    let forks = 0;
    const selected = selectProjectSessionCheckpoint(
      "checkpoint-deepseek-3",
      {
        onSelectCheckpoint: (checkpointId) => calls.push(checkpointId),
        onRetryCheckpoint: () => { retries += 1; },
        onStartBranch: () => { branches += 1; },
        onForkCheckpoint: () => { forks += 1; },
      },
    );

    assert.equal(selected, true);
    assert.deepEqual(calls, ["checkpoint-deepseek-3"]);
    assert.equal(retries, 0);
    assert.equal(branches, 0);
    assert.equal(forks, 0);
  });
});

test("blocked, busy, and standalone states explain exactly which actions are unavailable", async () => {
  await withPathMenu(({
    ProjectSessionPathMenu,
    projectSessionPathActionState,
  }) => {
    const handlers = {
      onRetryCheckpoint() {},
      onStartBranch() {},
      onForkCheckpoint() {},
    };
    const blockedCheckpoint = {
      ...sessionPath.checkpoints[0],
      blockedReason: "请先处理待审阅修改",
    };
    const blocked = projectSessionPathActionState(blockedCheckpoint, handlers);
    assert.equal(blocked.retry.disabled, true);
    assert.equal(blocked.branch.disabled, true);
    assert.equal(blocked.fork.disabled, true);
    assert.equal(blocked.retry.reason, "请先处理待审阅修改");

    const busy = projectSessionPathActionState(
      sessionPath.checkpoints[0],
      { ...handlers, busy: true },
    );
    assert.equal(busy.retry.disabled, true);
    assert.match(busy.retry.reason, /当前 Agent 正在工作/);

    const standalone = projectSessionPathActionState(
      sessionPath.checkpoints[0],
      { ...handlers, standalone: true },
    );
    assert.equal(standalone.retry.disabled, false);
    assert.equal(standalone.branch.disabled, false);
    assert.equal(standalone.fork.disabled, true);
    assert.equal(standalone.fork.reason, "独立对话不能复制为项目会话");

    const html = renderToStaticMarkup(React.createElement(ProjectSessionPathMenu, {
      open: true,
      onOpenChange() {},
      sessionPath: {
        ...sessionPath,
        checkpoints: [blockedCheckpoint],
        activeLeafCheckpointId: blockedCheckpoint.id,
      },
      messages,
      selectedCheckpointId: blockedCheckpoint.id,
      ...handlers,
    }));
    assert.match(html, /请先处理待审阅修改/);
    assert.equal((html.match(/disabled=""/g) ?? []).length, 3);
  });
});

test("Workspace rows create new conversations without switching the current cwd and only clean unused worktrees can be removed", async () => {
  await withPathMenu(({
    ProjectSessionPathMenu,
    projectWorkspaceActionState,
  }) => {
    const main = {
      id: "workspace-main",
      label: "主工作区",
      kind: "project_root",
      isMain: true,
      isGit: true,
      branch: "main",
      head: "1234567890abcdef",
      dirty: true,
      status: "available",
      conversationCount: 1,
    };
    const secondary = {
      id: "workspace-secondary",
      label: "pi/fix-title-abcd",
      kind: "git_worktree",
      isMain: false,
      isGit: true,
      branch: "pi/fix-title-abcd",
      head: "fedcba0987654321",
      dirty: false,
      status: "available",
      conversationCount: 0,
    };
    assert.equal(projectWorkspaceActionState(main, {
      currentWorkspaceId: main.id,
    }).open.disabled, true);
    assert.equal(projectWorkspaceActionState(main).remove.disabled, true);
    assert.equal(projectWorkspaceActionState(secondary).remove.disabled, false);
    assert.match(projectWorkspaceActionState({
      ...secondary,
      dirty: true,
    }).remove.reason, /未提交修改/);
    assert.match(projectWorkspaceActionState({
      ...secondary,
      conversationCount: 2,
    }).remove.reason, /仍有会话使用/);

    const html = renderToStaticMarkup(React.createElement(ProjectSessionPathMenu, {
      open: true,
      onOpenChange() {},
      sessionPath,
      messages,
      workspaces: [main, secondary],
      currentWorkspaceId: main.id,
      onCreateWorktreeConversation() {},
      onCreateConversationInWorkspace() {},
      onRemoveWorkspace() {},
    }));
    assert.match(html, /主工作区/);
    assert.match(html, /当前会话/);
    assert.match(html, /pi\/fix-title-abcd/);
    assert.match(html, /fedcba09/);
    assert.match(html, /在此新建会话/);
    assert.match(html, /从当前 HEAD 新建 Workspace 会话/);
    assert.match(html, /删除 Workspace pi\/fix-title-abcd/);
    assert.doesNotMatch(html, /Users\//);
  });
});

test("Escape and the shared close helper close the dialog and restore trigger focus", async () => {
  await withPathMenu(({
    closeProjectSessionPathMenu,
    handleProjectSessionPathEscape,
  }) => {
    const openChanges = [];
    let focused = 0;
    const trigger = { focus: () => { focused += 1; } };
    const event = {
      key: "Escape",
      prevented: false,
      stopped: false,
      preventDefault() { this.prevented = true; },
      stopPropagation() { this.stopped = true; },
    };

    assert.equal(handleProjectSessionPathEscape(event, {
      onOpenChange: (open) => openChanges.push(open),
      trigger,
    }), true);
    assert.deepEqual(openChanges, [false]);
    assert.equal(focused, 1);
    assert.equal(event.prevented, true);
    assert.equal(event.stopped, true);

    assert.equal(handleProjectSessionPathEscape({ key: "Enter" }, {
      onOpenChange: (open) => openChanges.push(open),
      trigger,
    }), false);
    assert.deepEqual(openChanges, [false]);
    assert.equal(focused, 1);

    closeProjectSessionPathMenu({
      onOpenChange: (open) => openChanges.push(open),
      trigger,
    });
    assert.deepEqual(openChanges, [false, false]);
    assert.equal(focused, 2);
  });
});
