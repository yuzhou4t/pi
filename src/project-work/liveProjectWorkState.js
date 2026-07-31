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
  };
}

export function mergeIncrementalConversationSnapshot(current, incoming) {
  return mergeFreshConversationSnapshot(current, incoming);
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
