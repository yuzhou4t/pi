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
  const currentSeq = numericEventSeq(current);
  const incomingSeq = numericEventSeq(incoming);
  if (currentSeq !== null && incomingSeq !== null && currentSeq !== incomingSeq) {
    return incomingSeq > currentSeq;
  }
  if (currentSeq !== null && incomingSeq === null) return false;

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
  return true;
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
      item.id === conversation.id && shouldApplyHydration(item, conversation)
        ? { ...item, ...conversation }
        : item
    )),
    conversation: state.conversation?.id === conversation.id
      && shouldApplyHydration(state.conversation, conversation)
      ? conversation
      : state.conversation,
  };
}
