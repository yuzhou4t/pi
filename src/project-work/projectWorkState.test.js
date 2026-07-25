import assert from "node:assert/strict";
import test from "node:test";
import {
  CONVERSATION_KIND,
  createInitialProjectWorkState,
  createProjectWorkPersistenceEnvelope,
  isPersistedProjectWorkStateValid,
  PROJECT_WORK_ACTIONS,
  PROJECT_WORK_ARTIFACTS,
  PROJECT_WORK_FIXTURE,
  PROJECT_WORK_STATUS,
  PROJECT_WORK_STORAGE_VERSION,
  projectWorkReducer,
  restoreProjectWorkState,
} from "./projectWorkState.js";

function reachConfirmation() {
  let state = createInitialProjectWorkState();
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

function confirmChanges(state) {
  return projectWorkReducer(state, {
    type: PROJECT_WORK_ACTIONS.CONFIRM_CHANGES,
    changeSetId: state.changeSet.id,
    baseHash: state.changeSet.baseHash,
    afterHash: state.changeSet.afterHash,
    selectedFileIds: state.changeSet.files
      .filter((file) => file.selected)
      .map((file) => file.id),
  });
}

test("initial state exposes the fixed project_work fixture and per-conversation model", () => {
  assert.deepEqual(CONVERSATION_KIND, {
    PROJECT_WORK: "project_work",
    PAPER_READING: "paper_reading",
    WORKFLOW_RUN: "workflow_run",
  });

  const state = createInitialProjectWorkState({
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
  });

  assert.equal(state.kind, CONVERSATION_KIND.PROJECT_WORK);
  assert.equal(state.draft, "修复设置页移动端底部按钮遮挡");
  assert.equal(state.providerId, "deepseek");
  assert.equal(state.modelId, "deepseek-v4-flash");
  assert.equal(state.status, PROJECT_WORK_STATUS.READY);
  assert.equal(isPersistedProjectWorkStateValid(state), true);
});

test("project work conversations can keep independent identities and progress", () => {
  const primary = createInitialProjectWorkState();
  const secondary = createInitialProjectWorkState({
    conversationId: "project-work-secondary",
    title: "检查设置页移动端布局",
    rootLabel: "Pi Agent 前端",
  });
  const plannedSecondary = projectWorkReducer(secondary, {
    type: PROJECT_WORK_ACTIONS.SEND_TASK,
  });

  assert.equal(primary.status, PROJECT_WORK_STATUS.READY);
  assert.equal(primary.messages.length, 0);
  assert.equal(plannedSecondary.status, PROJECT_WORK_STATUS.PLANNED);
  assert.equal(plannedSecondary.conversationId, "project-work-secondary");
  assert.equal(plannedSecondary.title, "检查设置页移动端布局");
});

test("a newly created blank work conversation derives its title only after explicit send", () => {
  const state = createInitialProjectWorkState({
    conversationId: "project-work-new",
    title: "新会话",
    rootLabel: "Pi Agent 前端",
    draft: "",
  });
  const planned = projectWorkReducer(state, {
    type: PROJECT_WORK_ACTIONS.SEND_TASK,
    text: "整理移动端项目导航的层级",
  });

  assert.equal(state.title, "新会话");
  assert.equal(planned.title, "整理移动端项目导航的层级");
  assert.equal(planned.status, PROJECT_WORK_STATUS.PLANNED);
});

test("only an explicit non-empty send creates the plan conversation", () => {
  const initial = createInitialProjectWorkState();
  const artifactOnly = projectWorkReducer(initial, {
    type: PROJECT_WORK_ACTIONS.SET_ACTIVE_ARTIFACT,
    artifactId: PROJECT_WORK_ARTIFACTS.PREVIEW,
  });
  const modelOnly = projectWorkReducer(artifactOnly, {
    type: PROJECT_WORK_ACTIONS.SET_MODEL,
    providerId: "codex-subscription",
    modelId: "account-default",
  });

  assert.equal(modelOnly.status, PROJECT_WORK_STATUS.READY);
  assert.deepEqual(modelOnly.messages, []);

  const empty = projectWorkReducer({ ...modelOnly, draft: "" }, {
    type: PROJECT_WORK_ACTIONS.SEND_TASK,
    text: "   ",
  });
  assert.equal(empty.status, PROJECT_WORK_STATUS.READY);
  assert.deepEqual(empty.messages, []);

  const sent = projectWorkReducer(modelOnly, {
    type: PROJECT_WORK_ACTIONS.SEND_TASK,
  });
  assert.equal(sent.status, PROJECT_WORK_STATUS.PLANNED);
  assert.deepEqual(sent.messages.map((message) => message.role), ["user", "assistant"]);
  assert.equal(sent.events[0].seq, 1);
});

test("plan steps advance only in order after execution starts", () => {
  let state = createInitialProjectWorkState();
  const illegalStart = projectWorkReducer(state, {
    type: PROJECT_WORK_ACTIONS.START_EXECUTION,
  });
  assert.equal(illegalStart, state);

  state = projectWorkReducer(state, { type: PROJECT_WORK_ACTIONS.SEND_TASK });
  const illegalAdvance = projectWorkReducer(state, {
    type: PROJECT_WORK_ACTIONS.ADVANCE_PLAN,
    stepId: "inspect",
  });
  assert.equal(illegalAdvance, state);

  state = projectWorkReducer(state, { type: PROJECT_WORK_ACTIONS.START_EXECUTION });
  const outOfOrder = projectWorkReducer(state, {
    type: PROJECT_WORK_ACTIONS.ADVANCE_PLAN,
    stepId: "prepare-change",
  });
  assert.equal(outOfOrder, state);

  for (const step of PROJECT_WORK_FIXTURE.plan) {
    state = projectWorkReducer(state, {
      type: PROJECT_WORK_ACTIONS.ADVANCE_PLAN,
      stepId: step.id,
    });
  }
  assert.equal(state.status, PROJECT_WORK_STATUS.AWAITING_CONFIRMATION);
  assert.equal(state.activeArtifactId, PROJECT_WORK_ARTIFACTS.CHANGES);
  assert.deepEqual(state.plan.map((step) => step.status), [
    "completed",
    "completed",
    "completed",
  ]);
  assert.deepEqual(state.events.map((event) => event.seq), [1, 2, 3, 4, 5]);
});

test("switching artifacts never changes the conversation messages", () => {
  const state = projectWorkReducer(createInitialProjectWorkState(), {
    type: PROJECT_WORK_ACTIONS.SEND_TASK,
  });
  const messages = state.messages;
  const switched = projectWorkReducer(state, {
    type: PROJECT_WORK_ACTIONS.SET_ACTIVE_ARTIFACT,
    artifactId: PROJECT_WORK_ARTIFACTS.RUN_RESULT,
  });

  assert.equal(switched.activeArtifactId, PROJECT_WORK_ARTIFACTS.RUN_RESULT);
  assert.equal(switched.messages, messages);
});

test("context chips can be added and removed without sending a message", () => {
  const state = createInitialProjectWorkState();
  const context = {
    id: "styles-7-10",
    label: "styles.css 第 7–10 行",
    path: "src/styles.css",
    startLine: 7,
    endLine: 10,
  };
  const added = projectWorkReducer(state, {
    type: PROJECT_WORK_ACTIONS.ADD_CONTEXT,
    context,
  });
  const duplicate = projectWorkReducer(added, {
    type: PROJECT_WORK_ACTIONS.ADD_CONTEXT,
    context,
  });

  assert.equal(added.contextChips.length, 1);
  assert.equal(duplicate, added);
  assert.equal(added.status, PROJECT_WORK_STATUS.READY);
  assert.deepEqual(added.messages, []);

  const removed = projectWorkReducer(added, {
    type: PROJECT_WORK_ACTIONS.REMOVE_CONTEXT,
    contextId: context.id,
  });
  assert.deepEqual(removed.contextChips, []);
  assert.deepEqual(removed.messages, []);
});

test("cancelling an exact change preview records the decision without advancing", () => {
  const state = reachConfirmation();
  const cancelled = projectWorkReducer(state, {
    type: PROJECT_WORK_ACTIONS.CANCEL_CHANGES,
  });

  assert.equal(cancelled.status, PROJECT_WORK_STATUS.AWAITING_CONFIRMATION);
  assert.equal(cancelled.changeSet.status, "awaiting_confirmation");
  assert.equal(cancelled.confirmation.status, "cancelled");
  assert.equal(cancelled.activeArtifactId, PROJECT_WORK_ARTIFACTS.CHANGES);
});

test("confirmation is blocked for wrong hashes, missing files, and empty selections", () => {
  const state = reachConfirmation();
  const wrongHash = projectWorkReducer(state, {
    type: PROJECT_WORK_ACTIONS.CONFIRM_CHANGES,
    changeSetId: state.changeSet.id,
    baseHash: "sha256:wrong",
    afterHash: state.changeSet.afterHash,
    selectedFileIds: state.changeSet.files.map((file) => file.id),
  });
  assert.equal(wrongHash, state);

  const missingFile = projectWorkReducer(state, {
    type: PROJECT_WORK_ACTIONS.CONFIRM_CHANGES,
    changeSetId: state.changeSet.id,
    baseHash: state.changeSet.baseHash,
    afterHash: state.changeSet.afterHash,
    selectedFileIds: [state.changeSet.files[0].id],
  });
  assert.equal(missingFile, state);

  let empty = state;
  for (const file of state.changeSet.files) {
    empty = projectWorkReducer(empty, {
      type: PROJECT_WORK_ACTIONS.TOGGLE_CHANGE_FILE,
      fileId: file.id,
    });
  }
  assert.equal(confirmChanges(empty), empty);
});

test("a valid hash-bound confirmation applies only the selected files", () => {
  let state = reachConfirmation();
  state = projectWorkReducer(state, {
    type: PROJECT_WORK_ACTIONS.TOGGLE_CHANGE_FILE,
    fileId: "settings-panel",
  });
  const confirmed = confirmChanges(state);

  assert.equal(confirmed.status, PROJECT_WORK_STATUS.CHANGES_APPLIED);
  assert.equal(confirmed.activeArtifactId, PROJECT_WORK_ARTIFACTS.PREVIEW);
  assert.deepEqual(confirmed.confirmation.selectedFileIds, ["app-styles"]);
  assert.equal(
    confirmed.changeSet.files.find((file) => file.id === "settings-panel").status,
    "skipped",
  );
  assert.equal(
    confirmed.changeSet.files.find((file) => file.id === "app-styles").status,
    "applied",
  );
});

test("verification fails once and only a retry can complete it", () => {
  let state = confirmChanges(reachConfirmation());
  const illegalRetry = projectWorkReducer(state, {
    type: PROJECT_WORK_ACTIONS.RETRY_TESTS,
  });
  assert.equal(illegalRetry, state);

  state = projectWorkReducer(state, { type: PROJECT_WORK_ACTIONS.RUN_TESTS });
  assert.equal(state.status, PROJECT_WORK_STATUS.TEST_FAILED);
  assert.deepEqual(state.testRuns.map((run) => run.status), ["failed"]);

  const duplicateRun = projectWorkReducer(state, {
    type: PROJECT_WORK_ACTIONS.RUN_TESTS,
  });
  assert.equal(duplicateRun, state);

  state = projectWorkReducer(state, { type: PROJECT_WORK_ACTIONS.RETRY_TESTS });
  assert.equal(state.status, PROJECT_WORK_STATUS.COMPLETED);
  assert.deepEqual(state.testRuns.map((run) => run.status), ["failed", "passed"]);
  assert.equal(state.messages.at(-1).kind, "result");
});

test("versioned persistence restores valid state and falls back safely", () => {
  const initialOptions = {
    providerId: "codex-subscription",
    modelId: "account-default",
  };
  const state = projectWorkReducer(
    createInitialProjectWorkState(initialOptions),
    { type: PROJECT_WORK_ACTIONS.SEND_TASK },
  );
  const envelope = createProjectWorkPersistenceEnvelope(state);

  assert.deepEqual(restoreProjectWorkState(JSON.stringify(envelope)), state);

  const stale = restoreProjectWorkState({
    version: PROJECT_WORK_STORAGE_VERSION + 1,
    state,
  }, initialOptions);
  assert.equal(stale.status, PROJECT_WORK_STATUS.READY);
  assert.equal(stale.providerId, initialOptions.providerId);
  assert.deepEqual(stale.messages, []);

  const malformed = restoreProjectWorkState("{not-json", initialOptions);
  assert.equal(malformed.status, PROJECT_WORK_STATUS.READY);

  const invalid = restoreProjectWorkState({
    version: PROJECT_WORK_STORAGE_VERSION,
    state: { ...state, activeArtifactId: "unknown" },
  }, initialOptions);
  assert.equal(invalid.status, PROJECT_WORK_STATUS.READY);
});

test("persistence rejects incomplete run evidence", () => {
  const state = createInitialProjectWorkState();
  state.testRuns = [{
    id: "legacy-run",
    checks: [],
  }];

  assert.equal(isPersistedProjectWorkStateValid(state), false);
});
