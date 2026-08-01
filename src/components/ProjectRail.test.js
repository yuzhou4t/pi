import assert from "node:assert/strict";
import test, { after } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const vite = await createServer({
  root: process.cwd(),
  appType: "custom",
  logLevel: "silent",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
});

after(async () => {
  await vite.close();
});

function conversations({ projectId, kind = "project_work", prefix }) {
  return Array.from({ length: 7 }, (_, index) => ({
    id: `${prefix}-${index + 1}`,
    projectId,
    kind,
    title: `${prefix} ${index + 1}`,
    subtitle: `${kind} · 空闲`,
  }));
}

test("conversation list keeps the existing first five and exposes one compact remainder control", async () => {
  const {
    ConversationList,
    PROJECT_RAIL_VISIBLE_CONVERSATION_LIMIT,
  } = await vite.ssrLoadModule("/src/components/ProjectRail.jsx");
  const items = conversations({ projectId: "project-1", prefix: "会话" });
  const sharedProps = {
    conversations: items,
    selectedConversationId: null,
    openConversationMenuId: null,
    setOpenConversationMenuId() {},
  };

  const collapsedHtml = renderToStaticMarkup(React.createElement(ConversationList, sharedProps));
  assert.equal(PROJECT_RAIL_VISIBLE_CONVERSATION_LIMIT, 5);
  for (const item of items.slice(0, 5)) assert.match(collapsedHtml, new RegExp(item.title));
  for (const item of items.slice(5)) assert.doesNotMatch(collapsedHtml, new RegExp(item.title));
  assert.match(collapsedHtml, /展开其余 2 个/);
  assert.match(collapsedHtml, /aria-expanded="false"/);
  assert.ok(collapsedHtml.indexOf("会话 1") < collapsedHtml.indexOf("会话 5"));

  const expandedHtml = renderToStaticMarkup(React.createElement(ConversationList, {
    ...sharedProps,
    expanded: true,
  }));
  for (const item of items) assert.match(expandedHtml, new RegExp(item.title));
  assert.match(expandedHtml, />收起</);
  assert.match(expandedHtml, /aria-expanded="true"/);

  const shortHtml = renderToStaticMarkup(React.createElement(ConversationList, {
    ...sharedProps,
    conversations: items.slice(0, 5),
  }));
  assert.doesNotMatch(shortHtml, /展开其余|>收起</);

  const selectedTailHtml = renderToStaticMarkup(React.createElement(ConversationList, {
    ...sharedProps,
    selectedConversationId: items[6].id,
  }));
  assert.match(selectedTailHtml, /会话 7/);
  assert.match(selectedTailHtml, /aria-current="page"/);
  assert.doesNotMatch(selectedTailHtml, /会话 5|会话 6/);
  assert.match(selectedTailHtml, /展开其余 2 个/);
});

test("normal work folds standalone and project groups without hiding creation or row actions", async () => {
  const { ProjectRail } = await vite.ssrLoadModule("/src/components/ProjectRail.jsx");
  const standalone = conversations({ projectId: null, prefix: "独立" });
  const projectItems = conversations({ projectId: "project-1", prefix: "项目" });
  const html = renderToStaticMarkup(React.createElement(ProjectRail, {
    projects: [{
      id: "project-1",
      name: "Pi Agent",
      state: "7 个会话",
      updated: "刚刚",
    }],
    selectedId: "project-1",
    conversations: [...standalone, ...projectItems],
    selectedConversationId: "project-1",
    workspaceMode: "project_work",
    query: "",
    onQueryChange() {},
    onSelect() {},
    onSelectConversation() {},
    onNewConversation() {},
    onNewStandaloneConversation() {},
    onDeleteConversation() {},
    onRenameConversation() {},
    onAddProject() {},
  }));

  assert.match(html, /新建对话/);
  assert.match(html, /在 Pi Agent 中新建会话/);
  assert.match(html, /打开“独立 1”的更多操作/);
  assert.match(html, /打开“项目 1”的更多操作/);
  assert.match(html, /独立 5/);
  assert.match(html, /项目 5/);
  assert.doesNotMatch(html, /独立 6|项目 6/);
  assert.equal((html.match(/展开其余 2 个/g) ?? []).length, 2);
});

test("paper-reading groups use the same five-item limit without changing their workflow entries", async () => {
  const { ProjectRail } = await vite.ssrLoadModule("/src/components/ProjectRail.jsx");
  const items = conversations({
    projectId: "paper-project",
    kind: "paper_reading",
    prefix: "论文",
  });
  const topicItems = Array.from({ length: 7 }, (_, index) => ({
    id: `topic-${index + 1}`,
    title: `检索 ${index + 1}`,
    turnCount: index + 1,
  }));
  const html = renderToStaticMarkup(React.createElement(ProjectRail, {
    projects: [{
      id: "paper-project",
      name: "研究项目",
      state: "7 篇论文",
      updated: "本月",
    }],
    selectedId: "paper-project",
    conversations: items,
    selectedConversationId: "paper-1",
    workspaceMode: "paper_reading",
    activeRun: { id: "monthly-run", statusLabel: "等待审阅" },
    topicConversations: topicItems,
    query: "",
    onQueryChange() {},
    onSelect() {},
    onSelectConversation() {},
    onSelectTopicSearch() {},
    onSelectTopicConversation() {},
    onAddProject() {},
  }));

  assert.match(html, /每月追踪/);
  assert.match(html, /论文研读/);
  assert.match(html, /论文 5/);
  assert.doesNotMatch(html, /论文 6|论文 7/);
  assert.match(html, /展开论文研读其余 2 个/);
  assert.match(html, /检索 5/);
  assert.doesNotMatch(html, /检索 6|检索 7/);
  assert.match(html, /展开主题检索会话其余 2 个/);
});

test("conversation expansion keys stay isolated by workspace, scope, and project", async () => {
  const { getProjectRailConversationGroupKey } = await vite.ssrLoadModule(
    "/src/components/ProjectRail.jsx",
  );
  const keys = [
    getProjectRailConversationGroupKey("project_work", "standalone"),
    getProjectRailConversationGroupKey("project_work", "project", "project-1"),
    getProjectRailConversationGroupKey("project_work", "project", "project-2"),
    getProjectRailConversationGroupKey("paper_reading", "project", "project-1"),
  ];
  assert.equal(new Set(keys).size, keys.length);
});
