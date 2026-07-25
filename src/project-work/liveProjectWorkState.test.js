import assert from "node:assert/strict";
import test from "node:test";
import {
  createProjectConversationLock,
  hydrateCreatedConversation,
  insertCreatedConversation,
  upsertLiveProject,
} from "./liveProjectWorkState.js";

function state(overrides = {}) {
  return {
    status: "ready",
    projects: [{
      id: "project-1",
      name: "项目一",
      conversationCount: 1,
    }],
    conversations: [{
      id: "conversation-old",
      projectId: "project-1",
      title: "已有会话",
      status: "idle",
    }],
    conversation: {
      id: "conversation-old",
      projectId: "project-1",
      title: "已有会话",
      status: "idle",
    },
    error: null,
    ...overrides,
  };
}

test("project conversation lock reuses the in-flight request for one project", async () => {
  const lock = createProjectConversationLock();
  let calls = 0;
  let intents = 0;
  let resolveRequest;
  const operation = () => {
    calls += 1;
    return new Promise((resolve) => {
      resolveRequest = resolve;
    });
  };

  const onIntent = () => {
    intents += 1;
  };
  const first = lock.run("project-1", operation, onIntent);
  const second = lock.run("project-1", operation, onIntent);
  await Promise.resolve();

  assert.equal(first, second);
  assert.equal(calls, 1);
  assert.equal(intents, 2);

  resolveRequest("conversation-1");
  assert.equal(await first, "conversation-1");
});

test("joining an in-flight creation restores the latest project intent", async () => {
  const lock = createProjectConversationLock();
  let pendingProjectId = null;
  let selectedProjectId = null;
  let resolveCreation;
  const operation = () => new Promise((resolve) => {
    resolveCreation = resolve;
  });
  const focusProject = (projectId) => () => {
    pendingProjectId = projectId;
    selectedProjectId = projectId;
  };

  const first = lock.run("project-a", operation, focusProject("project-a"));
  pendingProjectId = "project-b";
  selectedProjectId = "project-b";
  const joined = lock.run("project-a", operation, focusProject("project-a"));
  await Promise.resolve();

  resolveCreation({
    id: "conversation-a",
    activate: pendingProjectId === "project-a" && selectedProjectId === "project-a",
  });
  assert.equal(first, joined);
  assert.deepEqual(await first, {
    id: "conversation-a",
    activate: true,
  });
});

test("created conversation is visible without taking over a newer selection", () => {
  const created = {
    id: "conversation-new",
    projectId: "project-1",
    title: "新工作会话",
    status: "idle",
  };
  const next = insertCreatedConversation(state(), created, { activate: false });

  assert.equal(next.conversation.id, "conversation-old");
  assert.equal(next.conversations[0].id, "conversation-new");
  assert.equal(next.projects[0].conversationCount, 2);

  const hydrated = hydrateCreatedConversation(next, {
    ...created,
    messages: [{ id: "message-1", role: "assistant", content: "ready" }],
  });
  assert.equal(hydrated.conversation.id, "conversation-old");
  assert.equal(hydrated.conversations[0].messages.length, 1);
});

test("conversation created for a background project only updates its project count", () => {
  const current = state({
    projects: [{
      id: "project-1",
      name: "项目一",
      conversationCount: 1,
    }, {
      id: "project-2",
      name: "项目二",
      conversationCount: 3,
    }],
  });
  const next = insertCreatedConversation(current, {
    id: "conversation-background",
    projectId: "project-2",
    title: "后台创建的会话",
    status: "idle",
  }, {
    activate: false,
    include: false,
  });

  assert.deepEqual(next.conversations, current.conversations);
  assert.equal(next.conversation.id, "conversation-old");
  assert.equal(next.projects[1].conversationCount, 4);
});

test("created conversation can activate immediately and hydrate in place", () => {
  const projectState = upsertLiveProject(state({ projects: [] }), {
    id: "project-2",
    name: "项目二",
    conversationCount: 0,
  });
  const created = {
    id: "conversation-new",
    projectId: "project-2",
    title: "新工作会话",
    status: "idle",
  };
  const next = insertCreatedConversation(projectState, created, { activate: true });
  const hydrated = hydrateCreatedConversation(next, {
    ...created,
    workspaceSnapshot: { includedFiles: 12 },
  });

  assert.equal(next.conversation.id, "conversation-new");
  assert.equal(next.projects[0].conversationCount, 1);
  assert.deepEqual(hydrated.conversation.workspaceSnapshot, { includedFiles: 12 });
});

test("late hydration cannot replace a newer running conversation snapshot", () => {
  const current = state({
    conversations: [{
      id: "conversation-new",
      projectId: "project-1",
      title: "正在执行",
      status: "running",
      lastEventSeq: 8,
      updatedAt: "2026-07-25T12:00:08.000Z",
    }],
    conversation: {
      id: "conversation-new",
      projectId: "project-1",
      title: "正在执行",
      status: "running",
      lastEventSeq: 8,
      updatedAt: "2026-07-25T12:00:08.000Z",
    },
  });
  const hydrated = hydrateCreatedConversation(current, {
    id: "conversation-new",
    projectId: "project-1",
    title: "新工作会话",
    status: "idle",
    lastEventSeq: 1,
    updatedAt: "2026-07-25T12:00:01.000Z",
  });

  assert.equal(hydrated.conversation.status, "running");
  assert.equal(hydrated.conversation.lastEventSeq, 8);
  assert.equal(hydrated.conversations[0].status, "running");
});

test("hydration applies a snapshot with a newer event sequence", () => {
  const current = state({
    conversations: [{
      id: "conversation-new",
      projectId: "project-1",
      status: "idle",
      lastEventSeq: 1,
      updatedAt: "2026-07-25T12:00:01.000Z",
    }],
    conversation: {
      id: "conversation-new",
      projectId: "project-1",
      status: "idle",
      lastEventSeq: 1,
      updatedAt: "2026-07-25T12:00:01.000Z",
    },
  });
  const hydrated = hydrateCreatedConversation(current, {
    id: "conversation-new",
    projectId: "project-1",
    status: "running",
    lastEventSeq: 2,
    updatedAt: "2026-07-25T12:00:02.000Z",
  });

  assert.equal(hydrated.conversation.status, "running");
  assert.equal(hydrated.conversation.lastEventSeq, 2);
  assert.equal(hydrated.conversations[0].lastEventSeq, 2);
});

test("equal-sequence hydration keeps the snapshot with the newer update time", () => {
  const current = state({
    conversations: [{
      id: "conversation-new",
      projectId: "project-1",
      status: "running",
      lastEventSeq: 4,
      updatedAt: "2026-07-25T12:00:04.000Z",
    }],
    conversation: {
      id: "conversation-new",
      projectId: "project-1",
      status: "running",
      lastEventSeq: 4,
      updatedAt: "2026-07-25T12:00:04.000Z",
    },
  });
  const hydrated = hydrateCreatedConversation(current, {
    id: "conversation-new",
    projectId: "project-1",
    status: "idle",
    lastEventSeq: 4,
    updatedAt: "2026-07-25T12:00:03.000Z",
  });

  assert.equal(hydrated.conversation.status, "running");
  assert.equal(hydrated.conversations[0].status, "running");
});
