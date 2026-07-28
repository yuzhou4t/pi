import assert from "node:assert/strict";
import test from "node:test";
import {
  adjacentConversationAfterRemoval,
  createProjectConversationLock,
  hydrateCreatedConversation,
  insertCreatedConversation,
  isProjectWorkConversationBusy,
  isProjectWorkConversationDeleteBlocked,
  mergeFreshConversationSnapshot,
  mergeIncrementalConversationSnapshot,
  removeLiveConversation,
  replaceProjectConversationSlice,
  renameLiveConversation,
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

test("reloading one project keeps standalone conversations and replaces only that project slice", () => {
  const current = state({
    conversations: [{
      id: "standalone-1",
      projectId: null,
      title: "独立任务",
    }, {
      id: "project-old",
      projectId: "project-1",
      title: "旧项目会话",
    }, {
      id: "other-project",
      projectId: "project-2",
      title: "其他项目会话",
    }],
  });

  const next = replaceProjectConversationSlice(current, "project-1", [{
    id: "project-new",
    projectId: "project-1",
    title: "最新项目会话",
  }]);

  assert.deepEqual(next.conversations.map((item) => item.id), [
    "standalone-1",
    "other-project",
    "project-new",
  ]);
});

test("standalone creation and removal do not change any project conversation count", () => {
  const created = insertCreatedConversation(state(), {
    id: "standalone-new",
    projectId: null,
    workspaceKind: "scratch",
    scope: "standalone",
    title: "新工作会话",
  }, { activate: true });

  assert.equal(created.projects[0].conversationCount, 1);
  assert.equal(created.conversation.id, "standalone-new");

  const removed = removeLiveConversation(created, "standalone-new");
  assert.equal(removed.projects[0].conversationCount, 1);
  assert.equal(removed.conversation, null);
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

test("deleting the current conversation chooses the next row, then the previous row", () => {
  const conversations = [{
    id: "conversation-newest",
    projectId: "project-1",
  }, {
    id: "conversation-current",
    projectId: "project-1",
  }, {
    id: "conversation-oldest",
    projectId: "project-1",
  }, {
    id: "conversation-other-project",
    projectId: "project-2",
  }];

  assert.equal(
    adjacentConversationAfterRemoval(conversations, "conversation-current").id,
    "conversation-oldest",
  );
  assert.equal(
    adjacentConversationAfterRemoval(conversations, "conversation-oldest").id,
    "conversation-current",
  );
  assert.equal(
    adjacentConversationAfterRemoval(conversations, "missing"),
    null,
  );
  assert.equal(
    adjacentConversationAfterRemoval(
      conversations,
      "conversation-current",
      ["conversation-current"],
    ),
    null,
  );
  assert.equal(
    adjacentConversationAfterRemoval(
      conversations,
      "conversation-current",
      ["conversation-current", "conversation-newest"],
    ).id,
    "conversation-newest",
  );
});

test("deleting a live conversation removes only that row and decrements its project count", () => {
  const current = state({
    projects: [{
      id: "project-1",
      name: "项目一",
      conversationCount: 2,
    }, {
      id: "project-2",
      name: "项目二",
      conversationCount: 1,
    }],
    conversations: [{
      id: "conversation-current",
      projectId: "project-1",
    }, {
      id: "conversation-neighbor",
      projectId: "project-1",
    }, {
      id: "conversation-other",
      projectId: "project-2",
    }],
    conversation: {
      id: "conversation-current",
      projectId: "project-1",
    },
  });

  const next = removeLiveConversation(current, "conversation-current");

  assert.deepEqual(
    next.conversations.map((conversation) => conversation.id),
    ["conversation-neighbor", "conversation-other"],
  );
  assert.equal(next.projects[0].conversationCount, 1);
  assert.equal(next.projects[1].conversationCount, 1);
  assert.equal(next.conversation, null);
});

test("deleting a background conversation preserves the active conversation and trusts server count", () => {
  const current = state({
    projects: [{
      id: "project-1",
      name: "项目一",
      conversationCount: 8,
    }],
    conversations: [{
      id: "conversation-old",
      projectId: "project-1",
    }, {
      id: "conversation-background",
      projectId: "project-1",
    }],
  });

  const next = removeLiveConversation(current, "conversation-background", {
    conversationCount: 1,
  });

  assert.equal(next.projects[0].conversationCount, 1);
  assert.equal(next.conversation.id, "conversation-old");
});

test("renaming a conversation updates its list row and active heading without replacing detail", () => {
  const current = state({
    conversation: {
      id: "conversation-old",
      projectId: "project-1",
      title: "新工作会话",
      messages: [{ id: "message-1", content: "保留详情" }],
    },
  });
  const next = renameLiveConversation(current, {
    id: "conversation-old",
    title: "检查登录页",
    updatedAt: "2026-07-25T13:00:00.000Z",
  });

  assert.equal(next.conversations[0].title, "检查登录页");
  assert.equal(next.conversation.title, "检查登录页");
  assert.equal(next.conversation.messages[0].content, "保留详情");
  assert.equal(next.conversation.updatedAt, "2026-07-25T13:00:00.000Z");
});

test("late hydration cannot resurrect a deleted conversation", () => {
  const removed = removeLiveConversation(state(), "conversation-old");
  const hydrated = hydrateCreatedConversation(removed, {
    id: "conversation-old",
    projectId: "project-1",
    title: "迟到的会话快照",
    status: "idle",
    lastEventSeq: 9,
  });

  assert.equal(hydrated.conversations.some((item) => item.id === "conversation-old"), false);
  assert.equal(hydrated.conversation, null);
});

test("a late idle snapshot cannot roll back a newer manual rename", () => {
  const renamed = {
    id: "conversation-old",
    projectId: "project-1",
    title: "检查登录页",
    status: "running",
    lastEventSeq: 4,
    updatedAt: "2026-07-25T14:00:00.000Z",
  };
  const lateIdle = {
    ...renamed,
    title: "新工作会话",
    status: "idle",
    lastEventSeq: 5,
    updatedAt: "2026-07-25T13:59:59.000Z",
  };

  assert.equal(mergeFreshConversationSnapshot(renamed, lateIdle), renamed);
});

test("incremental event snapshots keep prior history and deduplicate replays", () => {
  const current = {
    id: "conversation-old",
    projectId: "project-1",
    title: "检查登录页",
    status: "running",
    lastEventSeq: 4,
    updatedAt: "2026-07-25T14:00:00.000Z",
    events: [{
      seq: 3,
      type: "tool.completed",
    }, {
      seq: 4,
      type: "message.delta",
      detail: "旧片段",
    }],
  };
  const incoming = {
    ...current,
    status: "awaiting_user",
    lastEventSeq: 6,
    updatedAt: "2026-07-25T14:00:01.000Z",
    events: [{
      seq: 4,
      type: "message.delta",
      detail: "重放片段",
    }, {
      seq: 5,
      type: "message.completed",
    }, {
      seq: 6,
      type: "ask_user.requested",
    }],
  };

  const merged = mergeIncrementalConversationSnapshot(current, incoming);
  assert.equal(merged.status, "awaiting_user");
  assert.deepEqual(merged.events.map((event) => event.seq), [3, 4, 5, 6]);
  assert.equal(merged.events[1].detail, "重放片段");

  const stale = {
    ...incoming,
    lastEventSeq: 2,
    updatedAt: "2026-07-25T13:59:59.000Z",
    events: [{ seq: 2, type: "stale" }],
  };
  assert.equal(mergeIncrementalConversationSnapshot(merged, stale), merged);
});

test("only a live busy status blocks conversation deletion", () => {
  assert.equal(isProjectWorkConversationBusy({ status: "running" }), true);
  assert.equal(
    isProjectWorkConversationBusy({ status: "idle", turnStatus: "verifying" }),
    true,
  );
  assert.equal(isProjectWorkConversationBusy({ status: "awaiting_confirmation" }), false);
  assert.equal(
    isProjectWorkConversationDeleteBlocked(
      "conversation-current",
      { id: "conversation-current", status: "running" },
    ),
    true,
  );
  assert.equal(
    isProjectWorkConversationDeleteBlocked(
      "conversation-background",
      { id: "conversation-current", status: "running" },
    ),
    false,
  );
});
