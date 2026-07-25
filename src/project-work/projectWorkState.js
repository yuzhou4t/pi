import { PROJECT_WORK_FIXTURE } from "./fixtures.js";

export { PROJECT_WORK_FIXTURE } from "./fixtures.js";

export const PROJECT_WORK_STORAGE_VERSION = 1;
export const PROJECT_WORK_STORAGE_KEY = `pi-agent:project-work:v${PROJECT_WORK_STORAGE_VERSION}`;

export const CONVERSATION_KIND = {
  PROJECT_WORK: "project_work",
  PAPER_READING: "paper_reading",
  WORKFLOW_RUN: "workflow_run",
};

export const PROJECT_WORK_ARTIFACTS = {
  FILES: "files",
  CHANGES: "changes",
  PREVIEW: "preview",
  RUN_RESULT: "run_result",
};

export const PROJECT_WORK_STATUS = {
  READY: "ready",
  PLANNED: "planned",
  EXECUTING: "executing",
  AWAITING_CONFIRMATION: "awaiting_confirmation",
  CHANGES_APPLIED: "changes_applied",
  TEST_FAILED: "test_failed",
  COMPLETED: "completed",
};

export const PROJECT_WORK_ACTIONS = {
  SET_DRAFT: "SET_DRAFT",
  SET_MODEL: "SET_MODEL",
  SET_ACTIVE_ARTIFACT: "SET_ACTIVE_ARTIFACT",
  SEND_TASK: "SEND_TASK",
  START_EXECUTION: "START_EXECUTION",
  ADVANCE_PLAN: "ADVANCE_PLAN",
  TOGGLE_CHANGE_FILE: "TOGGLE_CHANGE_FILE",
  CANCEL_CHANGES: "CANCEL_CHANGES",
  CONFIRM_CHANGES: "CONFIRM_CHANGES",
  ADD_CONTEXT: "ADD_CONTEXT",
  REMOVE_CONTEXT: "REMOVE_CONTEXT",
  RUN_TESTS: "RUN_TESTS",
  RETRY_TESTS: "RETRY_TESTS",
};

const PLAN_STEP_STATUS = {
  PENDING: "pending",
  IN_PROGRESS: "in_progress",
  COMPLETED: "completed",
};

const CHANGE_SET_STATUS = {
  DRAFT: "draft",
  AWAITING_CONFIRMATION: "awaiting_confirmation",
  APPLIED: "applied",
};

const ARTIFACT_IDS = new Set(Object.values(PROJECT_WORK_ARTIFACTS));
const PROJECT_WORK_STATUSES = new Set(Object.values(PROJECT_WORK_STATUS));
const PLAN_STEP_STATUSES = new Set(Object.values(PLAN_STEP_STATUS));

function clonePlan() {
  return PROJECT_WORK_FIXTURE.plan.map((step) => ({
    ...step,
    status: PLAN_STEP_STATUS.PENDING,
  }));
}

function cloneChangeSet() {
  return {
    ...PROJECT_WORK_FIXTURE.changeSet,
    status: CHANGE_SET_STATUS.DRAFT,
    files: PROJECT_WORK_FIXTURE.changeSet.files.map((file) => ({
      ...file,
      diff: [...file.diff],
      selected: true,
      status: "draft",
    })),
  };
}

function cloneTestRun(run) {
  return {
    ...run,
    checks: run.checks.map((check) => ({ ...check })),
    logs: [...run.logs],
  };
}

function appendMessages(state, messages) {
  const nextMessages = messages.map((message, index) => ({
    id: `message-${state.nextMessageSeq + index}`,
    ...message,
  }));
  return {
    ...state,
    messages: [...state.messages, ...nextMessages],
    nextMessageSeq: state.nextMessageSeq + nextMessages.length,
  };
}

function appendEvent(state, event) {
  return {
    ...state,
    events: [...state.events, { seq: state.nextEventSeq, ...event }],
    nextEventSeq: state.nextEventSeq + 1,
  };
}

function selectedChangeFileIds(state) {
  return state.changeSet.files
    .filter((file) => file.selected)
    .map((file) => file.id);
}

function hasExactIds(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  const actualIds = new Set(actual);
  return actualIds.size === actual.length && expected.every((id) => actualIds.has(id));
}

function isValidContext(context) {
  if (!context || typeof context !== "object" || Array.isArray(context)) return false;
  if (typeof context.id !== "string" || !context.id) return false;
  if (typeof context.label !== "string" || !context.label) return false;
  if (typeof context.path !== "string" || !context.path) return false;
  if (
    context.startLine !== undefined
    && (!Number.isInteger(context.startLine) || context.startLine < 1)
  ) return false;
  if (
    context.endLine !== undefined
    && (!Number.isInteger(context.endLine) || context.endLine < (context.startLine ?? 1))
  ) return false;
  return true;
}

export function createInitialProjectWorkState({
  providerId = "",
  modelId = "",
  conversationId = PROJECT_WORK_FIXTURE.conversation.id,
  title = PROJECT_WORK_FIXTURE.conversation.title,
  rootLabel = PROJECT_WORK_FIXTURE.conversation.rootLabel,
  draft = PROJECT_WORK_FIXTURE.task.title,
} = {}) {
  return {
    schemaVersion: PROJECT_WORK_STORAGE_VERSION,
    conversationId,
    kind: CONVERSATION_KIND.PROJECT_WORK,
    title,
    rootLabel,
    providerId,
    modelId,
    status: PROJECT_WORK_STATUS.READY,
    activeArtifactId: PROJECT_WORK_ARTIFACTS.FILES,
    draft,
    messages: [],
    nextMessageSeq: 1,
    events: [],
    nextEventSeq: 1,
    plan: clonePlan(),
    contextChips: [],
    changeSet: cloneChangeSet(),
    confirmation: null,
    testRuns: [],
  };
}

export function projectWorkReducer(state, action) {
  switch (action.type) {
    case PROJECT_WORK_ACTIONS.SET_DRAFT:
      if (typeof action.draft !== "string") return state;
      return { ...state, draft: action.draft };

    case PROJECT_WORK_ACTIONS.SET_MODEL:
      if (typeof action.providerId !== "string" || typeof action.modelId !== "string") return state;
      return {
        ...state,
        providerId: action.providerId,
        modelId: action.modelId,
      };

    case PROJECT_WORK_ACTIONS.SET_ACTIVE_ARTIFACT:
      if (!ARTIFACT_IDS.has(action.artifactId) || action.artifactId === state.activeArtifactId) {
        return state;
      }
      return { ...state, activeArtifactId: action.artifactId };

    case PROJECT_WORK_ACTIONS.SEND_TASK: {
      if (state.status !== PROJECT_WORK_STATUS.READY) return state;
      const text = (action.text ?? state.draft)?.trim();
      if (!text) return state;
      let next = {
        ...state,
        status: PROJECT_WORK_STATUS.PLANNED,
        title: state.title === "新会话" ? text.slice(0, 32) : state.title,
        draft: "",
      };
      next = appendMessages(next, [
        { role: "user", kind: "task", content: text },
        {
          role: "assistant",
          kind: "plan",
          content: "我会先检查设置页结构，再准备最小修改，最后核对变更并验证移动端结果。",
        },
      ]);
      return appendEvent(next, {
        kind: "plan_created",
        taskId: PROJECT_WORK_FIXTURE.task.id,
      });
    }

    case PROJECT_WORK_ACTIONS.START_EXECUTION:
      if (state.status !== PROJECT_WORK_STATUS.PLANNED) return state;
      return appendEvent({
        ...state,
        status: PROJECT_WORK_STATUS.EXECUTING,
        plan: state.plan.map((step, index) => ({
          ...step,
          status: index === 0 ? PLAN_STEP_STATUS.IN_PROGRESS : step.status,
        })),
      }, {
        kind: "plan_step_started",
        stepId: state.plan[0].id,
      });

    case PROJECT_WORK_ACTIONS.ADVANCE_PLAN: {
      if (state.status !== PROJECT_WORK_STATUS.EXECUTING) return state;
      const currentIndex = state.plan.findIndex(
        (step) => step.status === PLAN_STEP_STATUS.IN_PROGRESS,
      );
      if (currentIndex < 0 || state.plan[currentIndex].id !== action.stepId) return state;
      const nextIndex = currentIndex + 1;
      const plan = state.plan.map((step, index) => ({
        ...step,
        status: index === currentIndex
          ? PLAN_STEP_STATUS.COMPLETED
          : index === nextIndex
            ? PLAN_STEP_STATUS.IN_PROGRESS
            : step.status,
      }));
      if (nextIndex < plan.length) {
        return appendEvent({
          ...state,
          plan,
        }, {
          kind: "plan_step_completed",
          stepId: action.stepId,
          nextStepId: plan[nextIndex].id,
        });
      }

      let next = {
        ...state,
        status: PROJECT_WORK_STATUS.AWAITING_CONFIRMATION,
        activeArtifactId: PROJECT_WORK_ARTIFACTS.CHANGES,
        plan,
        changeSet: {
          ...state.changeSet,
          status: CHANGE_SET_STATUS.AWAITING_CONFIRMATION,
        },
      };
      next = appendMessages(next, [{
        role: "assistant",
        kind: "approval",
        content: "修改已经准备好。请在右侧核对所选文件和精确差异，再确认应用。",
      }]);
      return appendEvent(next, {
        kind: "changes_ready",
        changeSetId: state.changeSet.id,
      });
    }

    case PROJECT_WORK_ACTIONS.TOGGLE_CHANGE_FILE:
      if (state.status !== PROJECT_WORK_STATUS.AWAITING_CONFIRMATION) return state;
      if (!state.changeSet.files.some((file) => file.id === action.fileId)) return state;
      return {
        ...state,
        confirmation: null,
        changeSet: {
          ...state.changeSet,
          files: state.changeSet.files.map((file) => file.id === action.fileId
            ? { ...file, selected: !file.selected }
            : file),
        },
      };

    case PROJECT_WORK_ACTIONS.CANCEL_CHANGES:
      if (state.status !== PROJECT_WORK_STATUS.AWAITING_CONFIRMATION) return state;
      return appendEvent({
        ...state,
        confirmation: {
          status: "cancelled",
          changeSetId: state.changeSet.id,
        },
      }, {
        kind: "confirmation_cancelled",
        changeSetId: state.changeSet.id,
      });

    case PROJECT_WORK_ACTIONS.CONFIRM_CHANGES: {
      if (
        state.status !== PROJECT_WORK_STATUS.AWAITING_CONFIRMATION
        || state.changeSet.status !== CHANGE_SET_STATUS.AWAITING_CONFIRMATION
      ) return state;
      const selectedFileIds = selectedChangeFileIds(state);
      if (
        selectedFileIds.length === 0
        || action.changeSetId !== state.changeSet.id
        || action.baseHash !== state.changeSet.baseHash
        || action.afterHash !== state.changeSet.afterHash
        || !hasExactIds(action.selectedFileIds, selectedFileIds)
      ) return state;
      return appendEvent({
        ...state,
        status: PROJECT_WORK_STATUS.CHANGES_APPLIED,
        activeArtifactId: PROJECT_WORK_ARTIFACTS.PREVIEW,
        confirmation: {
          status: "confirmed",
          changeSetId: state.changeSet.id,
          baseHash: state.changeSet.baseHash,
          afterHash: state.changeSet.afterHash,
          selectedFileIds,
        },
        changeSet: {
          ...state.changeSet,
          status: CHANGE_SET_STATUS.APPLIED,
          files: state.changeSet.files.map((file) => ({
            ...file,
            status: file.selected ? "applied" : "skipped",
          })),
        },
      }, {
        kind: "changes_confirmed",
        changeSetId: state.changeSet.id,
        selectedFileIds,
      });
    }

    case PROJECT_WORK_ACTIONS.ADD_CONTEXT:
      if (!isValidContext(action.context)) return state;
      if (state.contextChips.some((context) => context.id === action.context.id)) return state;
      return {
        ...state,
        contextChips: [...state.contextChips, { ...action.context }],
      };

    case PROJECT_WORK_ACTIONS.REMOVE_CONTEXT:
      if (!state.contextChips.some((context) => context.id === action.contextId)) return state;
      return {
        ...state,
        contextChips: state.contextChips.filter((context) => context.id !== action.contextId),
      };

    case PROJECT_WORK_ACTIONS.RUN_TESTS: {
      if (state.status !== PROJECT_WORK_STATUS.CHANGES_APPLIED) return state;
      let next = {
        ...state,
        status: PROJECT_WORK_STATUS.TEST_FAILED,
        activeArtifactId: PROJECT_WORK_ARTIFACTS.RUN_RESULT,
        testRuns: [cloneTestRun(PROJECT_WORK_FIXTURE.testRuns.failed)],
      };
      next = appendMessages(next, [{
        role: "assistant",
        kind: "validation",
        content: "第一次移动端检查没有通过：内容区还缺少 16px 安全底距。我已经定位到失败项，可以重试修正后的检查。",
      }]);
      return appendEvent(next, {
        kind: "validation_failed",
        runId: PROJECT_WORK_FIXTURE.testRuns.failed.id,
      });
    }

    case PROJECT_WORK_ACTIONS.RETRY_TESTS: {
      if (state.status !== PROJECT_WORK_STATUS.TEST_FAILED) return state;
      let next = {
        ...state,
        status: PROJECT_WORK_STATUS.COMPLETED,
        activeArtifactId: PROJECT_WORK_ARTIFACTS.RUN_RESULT,
        testRuns: [
          ...state.testRuns,
          cloneTestRun(PROJECT_WORK_FIXTURE.testRuns.passed),
        ],
      };
      next = appendMessages(next, [{
        role: "assistant",
        kind: "result",
        content: "修复已经完成。桌面布局保持不变，移动端底部按钮不再遮挡最后一项设置内容。",
      }]);
      return appendEvent(next, {
        kind: "validation_passed",
        runId: PROJECT_WORK_FIXTURE.testRuns.passed.id,
      });
    }

    default:
      return state;
  }
}

export function isPersistedProjectWorkStateValid(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.schemaVersion !== PROJECT_WORK_STORAGE_VERSION) return false;
  if (value.kind !== CONVERSATION_KIND.PROJECT_WORK) return false;
  if (typeof value.conversationId !== "string" || !value.conversationId) return false;
  if (typeof value.title !== "string" || !value.title) return false;
  if (typeof value.rootLabel !== "string" || !value.rootLabel) return false;
  if (typeof value.draft !== "string") return false;
  if (typeof value.providerId !== "string" || typeof value.modelId !== "string") return false;
  if (!PROJECT_WORK_STATUSES.has(value.status)) return false;
  if (!ARTIFACT_IDS.has(value.activeArtifactId)) return false;
  if (!Array.isArray(value.messages) || !Array.isArray(value.events)) return false;
  if (!Array.isArray(value.plan) || value.plan.length !== PROJECT_WORK_FIXTURE.plan.length) return false;
  if (value.plan.some((step) => (
    typeof step?.id !== "string" || !PLAN_STEP_STATUSES.has(step.status)
  ))) return false;
  if (!Array.isArray(value.contextChips) || value.contextChips.some((item) => !isValidContext(item))) {
    return false;
  }
  if (!value.changeSet || typeof value.changeSet !== "object") return false;
  if (
    value.changeSet.id !== PROJECT_WORK_FIXTURE.changeSet.id
    || value.changeSet.baseHash !== PROJECT_WORK_FIXTURE.changeSet.baseHash
    || value.changeSet.afterHash !== PROJECT_WORK_FIXTURE.changeSet.afterHash
    || !Array.isArray(value.changeSet.files)
  ) return false;
  if (
    !Array.isArray(value.testRuns)
    || value.testRuns.some((run) => (
      !run
      || typeof run.id !== "string"
      || !Array.isArray(run.checks)
      || !Array.isArray(run.logs)
    ))
  ) return false;
  if (!Number.isInteger(value.nextMessageSeq) || value.nextMessageSeq < 1) return false;
  if (!Number.isInteger(value.nextEventSeq) || value.nextEventSeq < 1) return false;
  let previousSeq = 0;
  for (const event of value.events) {
    if (!Number.isInteger(event?.seq) || event.seq <= previousSeq) return false;
    previousSeq = event.seq;
  }
  return value.nextEventSeq > previousSeq;
}

export function createProjectWorkPersistenceEnvelope(state) {
  return {
    version: PROJECT_WORK_STORAGE_VERSION,
    state,
  };
}

export function restoreProjectWorkState(saved, initialOptions) {
  const fallback = createInitialProjectWorkState(initialOptions);
  try {
    const envelope = typeof saved === "string" ? JSON.parse(saved) : saved;
    if (
      envelope?.version !== PROJECT_WORK_STORAGE_VERSION
      || !isPersistedProjectWorkStateValid(envelope.state)
    ) return fallback;
    return envelope.state;
  } catch {
    return fallback;
  }
}
