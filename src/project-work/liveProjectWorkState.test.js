import assert from "node:assert/strict";
import test from "node:test";
import {
  applyProjectWorkEventDelta,
  adjacentConversationAfterRemoval,
  createProjectConversationLock,
  hydrateCreatedConversation,
  insertCreatedConversation,
  isProjectWorkConversationBusy,
  isProjectWorkConversationDeleteBlocked,
  mergeFreshConversationSnapshot,
  mergeIncrementalConversationSnapshot,
  projectStreamingAssistantView,
  projectWorkEventNeedsHydration,
  removeLiveConversation,
  replaceProjectConversationSlice,
  renameLiveConversation,
  updateLiveConversationState,
  upsertLiveProject,
} from "./liveProjectWorkState.js";

test("incremental project events update visible state without a full snapshot", () => {
  const initial = {
    id: "conversation-stream",
    status: "running",
    turnStatus: "running",
    messages: [],
    events: [],
    workspaceRuns: [{
      id: "command-1",
      runId: null,
      status: "queued",
      executable: "npm",
      argv: ["test"],
    }],
    lastEventSeq: 0,
  };
  const withPlan = applyProjectWorkEventDelta(initial, {
    seq: 1,
    type: "plan.updated",
    data: {
      steps: [{ id: "inspect", text: "检查事件流", status: "in_progress" }],
    },
  });
  const withRun = applyProjectWorkEventDelta(withPlan, {
    seq: 2,
    type: "workspace_run.started",
    data: { id: "command-1", runId: "run-1", status: "running" },
  });
  const completed = applyProjectWorkEventDelta(withRun, {
    seq: 3,
    type: "message.completed",
    createdAt: "2026-08-02T12:00:00.000Z",
    data: {
      id: "assistant-1",
      role: "assistant",
      text: "事件流已经恢复。",
      status: "completed",
      isFinal: true,
      turnId: "turn-1",
    },
  });

  assert.equal(completed.plan[0].title, "检查事件流");
  assert.equal(completed.workspaceRuns[0].runId, "run-1");
  assert.equal(completed.workspaceRuns[0].status, "running");
  assert.equal(completed.messages[0].text, "事件流已经恢复。");
  assert.deepEqual(completed.events.map((event) => event.seq), [1, 2, 3]);
  assert.equal(completed.lastEventSeq, 3);
  assert.equal(completed.deliveredEventSeq, 3);
  assert.equal(applyProjectWorkEventDelta(completed, completed.events[2]), completed);
});

test("message deltas retain append metadata while advancing the live watermark", () => {
  const initial = {
    id: "conversation-stream",
    status: "running",
    turnStatus: "running",
    messages: [],
    events: [],
    lastEventSeq: 10,
  };
  const commentary = applyProjectWorkEventDelta(initial, {
    seq: 11,
    type: "message.delta",
    data: {
      id: "assistant-live",
      delta: "正在检查",
      revision: 1,
      contentIndex: 0,
      phase: "commentary",
    },
  });
  const finalAnswer = applyProjectWorkEventDelta(commentary, {
    seq: 12,
    type: "message.delta",
    data: {
      id: "assistant-live",
      delta: "检查完成",
      revision: 2,
      contentIndex: 1,
      phase: "final_answer",
    },
  });

  assert.deepEqual(
    finalAnswer.events.map((event) => ({
      seq: event.seq,
      delta: event.data.delta,
      revision: event.data.revision,
      contentIndex: event.data.contentIndex,
      phase: event.data.phase,
    })),
    [{
      seq: 11,
      delta: "正在检查",
      revision: 1,
      contentIndex: 0,
      phase: "commentary",
    }, {
      seq: 12,
      delta: "检查完成",
      revision: 2,
      contentIndex: 1,
      phase: "final_answer",
    }],
  );
  assert.equal(finalAnswer.lastEventSeq, 12);
  assert.equal(finalAnswer.deliveredEventSeq, 12);
  assert.equal(projectWorkEventNeedsHydration(finalAnswer.events[1]), false);
  assert.deepEqual(
    projectStreamingAssistantView(
      finalAnswer.streamingAssistantProjection,
      finalAnswer.messages,
      true,
    ),
    {
      id: "assistant-live",
      text: "检查完成",
      seq: 12,
      turnId: null,
    },
  );
});

test("the incremental streaming projection resumes from snapshot deltas after refresh", () => {
  const refreshed = {
    id: "conversation-stream",
    status: "running",
    turnStatus: "running",
    messages: [],
    events: [{
      seq: 20,
      type: "message.created",
      data: { id: "turn-live", role: "user" },
    }, {
      seq: 21,
      type: "message.delta",
      data: {
        id: "assistant-live",
        turnId: "turn-live",
        delta: "刷新前",
        revision: 1,
        contentIndex: 0,
        phase: "final_answer",
      },
    }],
    lastEventSeq: 21,
  };
  const resumed = applyProjectWorkEventDelta(refreshed, {
    seq: 22,
    type: "message.delta",
    data: {
      id: "assistant-live",
      turnId: "turn-live",
      delta: "刷新后",
      revision: 2,
      contentIndex: 0,
      phase: "final_answer",
    },
  });

  assert.equal(
    projectStreamingAssistantView(
      resumed.streamingAssistantProjection,
      resumed.messages,
      true,
    ).text,
    "刷新前刷新后",
  );
});

test("only structural project events request snapshot hydration", () => {
  assert.equal(projectWorkEventNeedsHydration({ type: "message.partial" }), false);
  assert.equal(projectWorkEventNeedsHydration({ type: "tool.completed" }), false);
  assert.equal(projectWorkEventNeedsHydration({
    type: "message.completed",
    data: { isFinal: false },
  }), false);
  assert.equal(projectWorkEventNeedsHydration({
    type: "message.completed",
    data: { isFinal: true },
  }), true);
  assert.equal(projectWorkEventNeedsHydration({ type: "workspace_run.started" }), false);
  assert.equal(projectWorkEventNeedsHydration({ type: "workspace_run.completed" }), true);
  assert.equal(projectWorkEventNeedsHydration({ type: "ask_user.requested" }), true);
  assert.equal(projectWorkEventNeedsHydration({ type: "document.ready" }), true);
});

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

test("accepted conversation configuration updates the active model and list immediately", () => {
  const current = state({
    conversations: [{
      id: "conversation-old",
      projectId: "project-1",
      title: "已有会话",
      status: "idle",
      providerId: "openai-codex",
      modelId: "gpt-5.6",
      lastEventSeq: 4,
      updatedAt: "2026-08-01T08:00:00.000Z",
    }],
    conversation: {
      id: "conversation-old",
      projectId: "project-1",
      title: "已有会话",
      status: "idle",
      providerId: "openai-codex",
      modelId: "gpt-5.6",
      lastEventSeq: 4,
      events: [{ seq: 4, type: "turn.completed" }],
      updatedAt: "2026-08-01T08:00:00.000Z",
    },
  });

  const next = updateLiveConversationState(current, {
    ...current.conversation,
    providerId: "deepseek",
    modelId: "deepseek-v4-pro",
    lastEventSeq: 5,
    events: [{ seq: 5, type: "model.configuration_changed" }],
    updatedAt: "2026-08-01T08:00:01.000Z",
  });

  assert.equal(next.conversation.providerId, "deepseek");
  assert.equal(next.conversation.modelId, "deepseek-v4-pro");
  assert.equal(next.conversations[0].providerId, "deepseek");
  assert.equal(next.conversations[0].modelId, "deepseek-v4-pro");
  assert.deepEqual(next.conversation.events.map((event) => event.seq), [4, 5]);
});

test("stale conversation configuration cannot overwrite the active model", () => {
  const current = state({
    conversations: [{
      id: "conversation-old",
      projectId: "project-1",
      title: "已有会话",
      status: "idle",
      providerId: "deepseek",
      modelId: "deepseek-v4-pro",
      lastEventSeq: 5,
      updatedAt: "2026-08-01T08:00:01.000Z",
    }],
    conversation: {
      id: "conversation-old",
      projectId: "project-1",
      title: "已有会话",
      status: "idle",
      providerId: "deepseek",
      modelId: "deepseek-v4-pro",
      lastEventSeq: 5,
      events: [{ seq: 5, type: "model.configuration_changed" }],
      updatedAt: "2026-08-01T08:00:01.000Z",
    },
  });

  const next = updateLiveConversationState(current, {
    ...current.conversation,
    providerId: "openai-codex",
    modelId: "gpt-5.6",
    lastEventSeq: 4,
    events: [{ seq: 4, type: "turn.completed" }],
    updatedAt: "2026-08-01T08:00:00.000Z",
  });

  assert.equal(next, current);
  assert.equal(next.conversation.providerId, "deepseek");
  assert.equal(next.conversation.modelId, "deepseek-v4-pro");
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

test("fresh snapshots keep durable prior events when a newer response is paged", () => {
  const current = {
    id: "conversation-old",
    status: "running",
    lastEventSeq: 4,
    updatedAt: "2026-07-25T14:00:00.000Z",
    events: [{ seq: 2, type: "agent.progress" }, { seq: 4, type: "turn.started" }],
  };
  const incoming = {
    id: "conversation-old",
    status: "failed",
    lastEventSeq: 6,
    updatedAt: "2026-07-25T14:00:01.000Z",
    events: [{ seq: 4, type: "turn.started", status: "replayed" }, {
      seq: 6,
      type: "agent.status",
      status: "failed",
    }],
  };

  const merged = mergeFreshConversationSnapshot(current, incoming);
  assert.equal(merged.status, "failed");
  assert.deepEqual(merged.events.map((event) => event.seq), [2, 4, 6]);
  assert.equal(merged.events[1].status, "replayed");
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
