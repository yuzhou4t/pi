export function createProjectConversationLock() {
  const requests = new Map();

  return {
    run(projectId, operation, onIntent) {
      onIntent?.();
      const existing = requests.get(projectId);
      if (existing) return existing;

      const request = Promise.resolve()
        .then(operation)
        .finally(() => {
          if (requests.get(projectId) === request) {
            requests.delete(projectId);
          }
        });
      requests.set(projectId, request);
      return request;
    },
  };
}

const BUSY_CONVERSATION_STATUSES = new Set([
  "queued",
  "planning",
  "running",
  "streaming",
  "executing",
  "steering",
  "aborting",
  "compacting",
  "verifying",
]);

export function isProjectWorkConversationBusy(conversation) {
  return BUSY_CONVERSATION_STATUSES.has(
    conversation?.turnStatus || conversation?.status,
  );
}

export function isProjectWorkConversationDeleteBlocked(conversationId, activeConversation) {
  return activeConversation?.id === conversationId
    && isProjectWorkConversationBusy(activeConversation);
}

function numericEventSeq(conversation) {
  const value = Number(conversation?.lastEventSeq);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function updatedAtTime(conversation) {
  const value = Date.parse(conversation?.updatedAt ?? "");
  return Number.isFinite(value) ? value : null;
}

function shouldApplyHydration(current, incoming) {
  if (!current) return true;
  const currentUpdatedAt = updatedAtTime(current);
  const incomingUpdatedAt = updatedAtTime(incoming);
  if (currentUpdatedAt !== null && incomingUpdatedAt === null) return false;
  if (
    currentUpdatedAt !== null
    && incomingUpdatedAt !== null
    && incomingUpdatedAt < currentUpdatedAt
  ) {
    return false;
  }

  const currentSeq = numericEventSeq(current);
  const incomingSeq = numericEventSeq(incoming);
  if (currentSeq !== null && incomingSeq !== null && currentSeq !== incomingSeq) {
    return incomingSeq > currentSeq;
  }
  if (currentSeq !== null && incomingSeq === null) return false;
  return true;
}

export function mergeFreshConversationSnapshot(current, incoming) {
  if (!incoming) return current;
  if (!current || current.id !== incoming.id) return incoming;
  if (!shouldApplyHydration(current, incoming)) return current;
  const events = new Map(
    [...(current.events ?? []), ...(incoming.events ?? [])]
      .filter((event) => Number.isSafeInteger(event?.seq) && event.seq > 0)
      .map((event) => [event.seq, event]),
  );
  return {
    ...incoming,
    events: [...events.values()].sort((left, right) => left.seq - right.seq),
    streamingAssistantProjection: Object.hasOwn(
      incoming,
      "streamingAssistantProjection",
    )
      ? incoming.streamingAssistantProjection
      : current.streamingAssistantProjection ?? null,
  };
}

export function mergeIncrementalConversationSnapshot(current, incoming) {
  return mergeFreshConversationSnapshot(current, incoming);
}

const EVENT_HYDRATION_PREFIXES = [
  "ask_user.",
  "apply_journal.",
  "browser_qa.",
  "change_set.",
  "compaction.",
  "document.",
  "git_closeout.",
  "image.",
  "office.",
  "operation.",
  "preview.",
  "verification.",
  "workspace_write.",
];

export function projectWorkEventNeedsHydration(event) {
  const type = String(event?.type ?? "");
  const data = eventData(event);
  return type === "workspace_run.completed"
    || (
      type === "message.completed"
      && value(data, "is_final", "isFinal") !== false
    )
    || EVENT_HYDRATION_PREFIXES.some((prefix) => type.startsWith(prefix));
}

function eventData(event) {
  return event?.data && typeof event.data === "object" && !Array.isArray(event.data)
    ? event.data
    : {};
}

function value(data, snakeName, camelName = snakeName) {
  return data?.[snakeName] ?? data?.[camelName];
}

function streamingMessageId(event) {
  const data = eventData(event);
  return event?.messageId ?? value(data, "id") ?? value(data, "message_id", "messageId");
}

export function reduceProjectStreamingAssistant(current, event) {
  if (event?.type === "message.created") return null;
  const id = streamingMessageId(event);
  if (event?.type === "message.completed") {
    return id && current?.id === id ? null : current;
  }
  if (
    !["message.delta", "message.partial"].includes(event?.type)
    || typeof id !== "string"
    || !id
  ) {
    return current;
  }
  const data = eventData(event);
  const next = current?.id === id
    ? {
        ...current,
        blocks: (current.blocks ?? []).map((block) => ({ ...block })),
      }
    : {
        id,
        seq: 0,
        turnId: null,
        legacyText: "",
        hasDeltas: false,
        lastRevision: 0,
        blocks: [],
      };
  next.seq = Math.max(next.seq, Number(event.seq) || 0);
  next.turnId = event.turnId ?? value(data, "turn_id", "turnId") ?? next.turnId;
  if (event.type === "message.partial") {
    const text = event.text ?? value(data, "text");
    if (typeof text === "string" && text) next.legacyText = text;
    return next;
  }

  const delta = event.delta ?? value(data, "delta");
  const revision = Number(event.revision ?? value(data, "revision"));
  if (
    typeof delta !== "string"
    || !delta
    || (
      Number.isSafeInteger(revision)
      && revision > 0
      && revision <= next.lastRevision
    )
  ) {
    return next;
  }
  next.hasDeltas = true;
  if (Number.isSafeInteger(revision) && revision > 0) {
    next.lastRevision = revision;
  }
  const rawContentIndex = Number(
    event.contentIndex ?? value(data, "content_index", "contentIndex"),
  );
  const contentIndex = Number.isSafeInteger(rawContentIndex) && rawContentIndex >= 0
    ? rawContentIndex
    : 0;
  const rawPhase = event.phase ?? value(data, "phase");
  const phase = ["commentary", "final_answer"].includes(rawPhase)
    ? rawPhase
    : null;
  const blockIndex = next.blocks.findIndex(
    (block) => block.contentIndex === contentIndex,
  );
  const block = blockIndex >= 0
    ? next.blocks[blockIndex]
    : { contentIndex, phase, text: "" };
  block.phase = phase ?? block.phase;
  block.text += delta;
  if (blockIndex < 0) next.blocks.push(block);
  return next;
}

export function projectStreamingAssistantView(projection, messages, running) {
  if (!running || !projection?.id) return null;
  if ((Array.isArray(messages) ? messages : []).some((message) => (
    message?.role === "assistant" && message.id === projection.id
  ))) {
    return null;
  }
  const blocks = [...(projection.blocks ?? [])]
    .sort((left, right) => left.contentIndex - right.contentIndex);
  const hasExplicitFinal = blocks.some((block) => block.phase === "final_answer");
  const text = projection.hasDeltas
    ? blocks
      .filter((block) => (
        hasExplicitFinal
          ? block.phase === "final_answer"
          : block.phase !== "commentary"
      ))
      .map((block) => block.text)
      .join("")
    : projection.legacyText;
  return text
    ? {
        id: projection.id,
        text,
        seq: projection.seq,
        turnId: projection.turnId,
      }
    : null;
}

export function projectStreamingAssistantFromEvents(events, messages, running) {
  const projection = projectStreamingAssistantProjection(events);
  return projectStreamingAssistantView(projection, messages, running);
}

export function projectStreamingAssistantProjection(events) {
  return (Array.isArray(events) ? events : [])
    .filter((event) => Number.isSafeInteger(event?.seq))
    .sort((left, right) => left.seq - right.seq)
    .reduce(reduceProjectStreamingAssistant, null);
}

function upsertEventMessage(messages, event) {
  const data = eventData(event);
  const id = value(data, "id") ?? event.messageId;
  const role = value(data, "role");
  if (typeof id !== "string" || !id || !["user", "assistant"].includes(role)) {
    return messages;
  }
  const existing = messages.find((message) => message.id === id);
  const text = typeof value(data, "text") === "string"
    ? value(data, "text")
    : existing?.content ?? existing?.text ?? "";
  const next = {
    ...(existing ?? {}),
    id,
    role,
    content: text,
    text,
    status: value(data, "status") ?? existing?.status ?? "completed",
    isFinal: value(data, "is_final", "isFinal") !== false,
    messageSeq: Number(value(data, "message_seq", "messageSeq"))
      || existing?.messageSeq
      || null,
    turnId: value(data, "turn_id", "turnId") ?? existing?.turnId ?? null,
    turnSeq: Number(value(data, "turn_seq", "turnSeq"))
      || existing?.turnSeq
      || null,
    attempt: Number(value(data, "attempt")) || existing?.attempt || 1,
    providerId: value(data, "provider_id", "providerId")
      ?? existing?.providerId
      ?? null,
    modelId: value(data, "model_id", "modelId") ?? existing?.modelId ?? null,
    thinkingLevel: value(data, "thinking_level", "thinkingLevel")
      ?? existing?.thinkingLevel
      ?? null,
    checkpointId: value(data, "checkpoint_id", "checkpointId")
      ?? existing?.checkpointId
      ?? null,
    turnEvidence: value(data, "turn_evidence", "turnEvidence")
      ?? existing?.turnEvidence
      ?? null,
    codeEvidence: value(data, "code_evidence", "codeEvidence")
      ?? existing?.codeEvidence
      ?? [],
    createdAt: value(data, "created_at", "createdAt")
      ?? event.createdAt
      ?? existing?.createdAt
      ?? null,
  };
  return existing
    ? messages.map((message) => (message.id === id ? next : message))
    : [...messages, next];
}

function updateWorkspaceRuns(runs, event) {
  const data = eventData(event);
  const id = value(data, "id", "requestId");
  if (typeof id !== "string" || !id) return runs;
  const current = runs.find((run) => run.id === id);
  if (!current && event.type !== "workspace_run.requested") return runs;
  const patch = {
    ...(current ?? {}),
    id,
    runId: value(data, "run_id", "runId") ?? current?.runId ?? null,
    turnId: value(data, "turn_id", "turnId") ?? current?.turnId ?? null,
    status: value(data, "status") ?? current?.status ?? "requested",
    executable: value(data, "executable") ?? current?.executable ?? "",
    argv: Array.isArray(value(data, "argv")) ? value(data, "argv") : current?.argv ?? [],
    relativeCwd: value(data, "relative_cwd", "relativeCwd")
      ?? current?.relativeCwd
      ?? ".",
    purpose: value(data, "purpose") ?? current?.purpose ?? null,
    requestHash: value(data, "request_hash", "requestHash")
      ?? current?.requestHash
      ?? null,
    exitCode: value(data, "exit_code", "exitCode") ?? current?.exitCode ?? null,
    durationMs: value(data, "duration_ms", "durationMs")
      ?? current?.durationMs
      ?? null,
    truncated: value(data, "truncated") === true || current?.truncated === true,
  };
  return current
    ? runs.map((run) => (run.id === id ? patch : run))
    : [...runs, patch];
}

export function applyProjectWorkEventDelta(current, event) {
  if (!current || !Number.isSafeInteger(event?.seq) || event.seq < 1) {
    return current;
  }
  if ((current.events ?? []).some((item) => item.seq === event.seq)) {
    return current;
  }
  const data = eventData(event);
  const events = [...(current.events ?? []), event]
    .sort((left, right) => left.seq - right.seq);
  const currentStreamingProjection = Object.hasOwn(
    current,
    "streamingAssistantProjection",
  )
    ? current.streamingAssistantProjection
    : projectStreamingAssistantProjection(current.events);
  let next = {
    ...current,
    events,
    streamingAssistantProjection: reduceProjectStreamingAssistant(
      currentStreamingProjection,
      event,
    ),
    lastEventSeq: Math.max(Number(current.lastEventSeq) || 0, event.seq),
    deliveredEventSeq: Math.max(
      Number(current.deliveredEventSeq) || 0,
      event.seq,
    ),
  };

  if (["message.created", "message.completed"].includes(event.type)) {
    next.messages = upsertEventMessage(current.messages ?? [], event);
  }
  if (event.type === "plan.updated") {
    next.plan = (Array.isArray(data.steps) ? data.steps : []).map((step, index) => ({
      id: step.id ?? `step-${index + 1}`,
      title: step.title ?? step.text ?? `步骤 ${index + 1}`,
      detail: step.detail ?? "",
      status: step.status ?? "pending",
    }));
  } else if (event.type === "plan.cleared") {
    next.plan = null;
  }
  if (event.type === "agent.status") {
    const status = value(data, "status");
    if (typeof status === "string" && status) {
      next.status = status;
      next.turnStatus = status;
    }
  } else if (event.type === "turn.started") {
    next.turnStatus = "running";
    next.activeTurnId = value(data, "turn_id", "turnId") ?? next.activeTurnId;
  }
  if (event.type === "ask_user.requested") next.status = "awaiting_user";
  if (["model.changed", "model.configuration_applied"].includes(event.type)) {
    next.providerId = value(data, "provider_id", "providerId") ?? next.providerId;
    next.modelId = value(data, "model_id", "modelId") ?? next.modelId;
    next.thinkingLevel = value(data, "thinking_level", "thinkingLevel")
      ?? next.thinkingLevel;
  }
  if (String(event.type).startsWith("workspace_run.")) {
    next.workspaceRuns = updateWorkspaceRuns(current.workspaceRuns ?? [], event);
    if (event.type === "workspace_run.requested") next.status = "awaiting_confirmation";
    if (["workspace_run.queued", "workspace_run.started"].includes(event.type)) {
      next.status = "verifying";
    }
  }
  return next;
}

export function updateLiveConversationState(state, incoming) {
  if (!incoming?.id) return state;
  const currentConversation = state.conversation;
  const freshConversation = currentConversation?.id === incoming.id
    ? mergeFreshConversationSnapshot(currentConversation, incoming)
    : incoming;
  if (freshConversation === currentConversation) return state;

  const summary = {
    id: freshConversation.id,
    projectId: freshConversation.projectId,
    title: freshConversation.title,
    status: freshConversation.status,
    providerId: freshConversation.providerId,
    modelId: freshConversation.modelId,
    thinkingLevel: freshConversation.thinkingLevel,
    lastEventSeq: freshConversation.lastEventSeq,
    unreadCount: freshConversation.unreadCount,
    latestMessageSeq: freshConversation.latestMessageSeq,
    lastReadMessageSeq: freshConversation.lastReadMessageSeq,
    pendingChangeFileCount: freshConversation.pendingChangeFileCount,
    updatedAt: freshConversation.updatedAt,
  };
  const existing = state.conversations.some((item) => item.id === freshConversation.id);
  return {
    ...state,
    status: "ready",
    conversations: existing
      ? state.conversations.map((item) => (
          item.id === freshConversation.id ? { ...item, ...summary } : item
        ))
      : [summary, ...state.conversations],
    conversation: freshConversation,
    error: null,
  };
}

export function upsertLiveProject(state, project) {
  const exists = state.projects.some((item) => item.id === project.id);
  return {
    ...state,
    status: "ready",
    projects: exists
      ? state.projects.map((item) => (
          item.id === project.id ? { ...item, ...project } : item
        ))
      : [project, ...state.projects],
    error: null,
  };
}

export function insertCreatedConversation(state, conversation, {
  activate = false,
  include = true,
} = {}) {
  const exists = include && state.conversations.some(
    (item) => item.id === conversation.id,
  );
  return {
    ...state,
    status: "ready",
    projects: state.projects.map((project) => (
      project.id === conversation.projectId && !exists
        ? {
            ...project,
            conversationCount: (project.conversationCount ?? 0) + 1,
          }
        : project
    )),
    conversations: include
      ? exists
        ? state.conversations.map((item) => (
            item.id === conversation.id ? { ...item, ...conversation } : item
          ))
        : [conversation, ...state.conversations]
      : state.conversations,
    conversation: activate ? conversation : state.conversation,
    error: null,
  };
}

export function hydrateCreatedConversation(state, conversation) {
  return {
    ...state,
    conversations: state.conversations.map((item) => (
      item.id === conversation.id
        ? {
            ...item,
            ...mergeFreshConversationSnapshot(item, conversation),
          }
        : item
    )),
    conversation: state.conversation?.id === conversation.id
      ? mergeFreshConversationSnapshot(state.conversation, conversation)
      : state.conversation,
  };
}

export function replaceProjectConversationSlice(state, projectId, conversations) {
  return {
    ...state,
    conversations: [
      ...state.conversations.filter((item) => item.projectId !== projectId),
      ...conversations,
    ],
  };
}

export function beginProjectConversationSelection(state) {
  return {
    ...state,
    status: "loading",
    conversation: null,
    error: null,
  };
}

export function adjacentConversationAfterRemoval(
  conversations,
  conversationId,
  visibleConversationIds,
) {
  const targetIndex = conversations.findIndex((item) => item.id === conversationId);
  if (targetIndex < 0) return null;
  const target = conversations[targetIndex];
  const projectConversations = Array.isArray(visibleConversationIds)
    ? visibleConversationIds
        .map((id) => conversations.find((item) => item.id === id))
        .filter((item) => item?.projectId === target.projectId)
    : conversations.filter((item) => item.projectId === target.projectId);
  const projectIndex = projectConversations.findIndex(
    (item) => item.id === conversationId,
  );
  return projectConversations[projectIndex + 1]
    ?? projectConversations[projectIndex - 1]
    ?? null;
}

export function removeLiveConversation(state, conversationId, {
  conversationCount,
} = {}) {
  const removed = state.conversations.find((item) => item.id === conversationId);
  if (!removed) return state;
  const exactConversationCount = Number.isSafeInteger(conversationCount)
    && conversationCount >= 0
    ? conversationCount
    : null;

  return {
    ...state,
    projects: state.projects.map((project) => (
      project.id === removed.projectId
        ? {
            ...project,
            conversationCount: exactConversationCount
              ?? Math.max(0, (project.conversationCount ?? 1) - 1),
          }
        : project
    )),
    conversations: state.conversations.filter((item) => item.id !== conversationId),
    conversation: state.conversation?.id === conversationId
      ? null
      : state.conversation,
    error: null,
  };
}

export function renameLiveConversation(state, conversation) {
  if (!conversation?.id || typeof conversation.title !== "string") return state;
  return {
    ...state,
    conversations: state.conversations.map((item) => (
      item.id === conversation.id
        ? { ...item, title: conversation.title, updatedAt: conversation.updatedAt ?? item.updatedAt }
        : item
    )),
    conversation: state.conversation?.id === conversation.id
      ? {
          ...state.conversation,
          title: conversation.title,
          updatedAt: conversation.updatedAt ?? state.conversation.updatedAt,
        }
      : state.conversation,
    error: null,
  };
}
