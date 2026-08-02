import assert from "node:assert/strict";
import test from "node:test";
import {
  createInitialRunState,
  isPersistedRunStateValid,
  RUN_ACTIONS,
  RUN_STATUS,
  runReducer,
} from "./runReducer.js";

function advanceToGuide(choice) {
  let state = createInitialRunState();
  state = runReducer(state, { type: RUN_ACTIONS.TOGGLE_PAPER, paperId: "paper-context-ledger" });
  state = runReducer(state, { type: RUN_ACTIONS.PREPARE_GUIDES });
  state = runReducer(state, { type: RUN_ACTIONS.GUIDES_READY });
  return runReducer(state, {
    type: RUN_ACTIONS.CHOOSE_GUIDE_ACTION,
    paperId: "paper-context-ledger",
    choice,
  });
}

test("papers without a downstream guide contract cannot be selected", () => {
  const initial = createInitialRunState();
  const next = runReducer(initial, {
    type: RUN_ACTIONS.TOGGLE_PAPER,
    paperId: "paper-tracebench",
  });

  assert.equal(next, initial);
  assert.deepEqual(next.selectedPaperIds, []);
});

test("persisted runs with an unsupported downstream paper are rejected", () => {
  const invalid = {
    ...createInitialRunState(),
    status: RUN_STATUS.GUIDE_READY,
    selectedPaperIds: ["paper-tracebench"],
    preparedGuideIds: ["paper-tracebench"],
    activePaperId: "paper-tracebench",
  };

  assert.equal(isPersistedRunStateValid(invalid), false);
  assert.equal(isPersistedRunStateValid(createInitialRunState()), true);
});

test("a live run binds full-text-ready papers without fixture ids", () => {
  let state = runReducer(createInitialRunState(), {
    type: RUN_ACTIONS.BIND_LIVE_RUN,
    runId: "journal-live-1",
    workflowId: "journal-reading-v1",
    candidatePaperIds: ["live-1", "live-2", "live-3"],
    selectablePaperIds: ["live-1", "live-2", "live-3"],
    guideStatus: "not_started",
  });

  assert.equal(state.source, "live");
  assert.equal(state.runId, "journal-live-1");
  state = runReducer(state, { type: RUN_ACTIONS.TOGGLE_PAPER, paperId: "live-1" });
  state = runReducer(state, { type: RUN_ACTIONS.TOGGLE_PAPER, paperId: "live-2" });
  const capped = runReducer(state, { type: RUN_ACTIONS.TOGGLE_PAPER, paperId: "live-3" });
  assert.deepEqual(capped.selectedPaperIds, ["live-1", "live-2"]);
  assert.equal(isPersistedRunStateValid(capped), true);
});

test("a fresh server review clears stale downstream state for the same live run", () => {
  const base = {
    type: RUN_ACTIONS.BIND_LIVE_RUN,
    runId: "journal-live-reset",
    candidatePaperIds: ["live-1", "live-2"],
    selectablePaperIds: ["live-1", "live-2"],
  };
  let state = runReducer(createInitialRunState(), {
    ...base,
    requestedPaperIds: ["live-1"],
    preparedGuideIds: ["live-1"],
    guideStatus: "ready",
    serverStatus: "reading",
    guideChoices: { "live-1": "read" },
    readings: {
      papers: {
        "live-1": {
          status: "reading",
          currentStage: "method",
        },
      },
    },
    proposals: [{ id: "old-proposal", selected: true }],
    zoteroProposalId: "old-zotero-preview",
    zoteroProposalHash: "sha256:old-preview",
  });
  state = {
    ...state,
    questions: [{ id: "old-question", text: "旧问题" }],
  };

  const reset = runReducer(state, {
    ...base,
    requestedPaperIds: [],
    preparedGuideIds: [],
    guideStatus: "not_started",
    serverStatus: "review_ready",
    guideChoices: {},
    readings: { papers: {} },
    proposals: [],
    zoteroProposalId: null,
    zoteroProposalHash: null,
    zoteroTarget: null,
  });

  assert.equal(reset.status, RUN_STATUS.REVIEW_READY);
  assert.deepEqual(reset.selectedPaperIds, []);
  assert.deepEqual(reset.preparedGuideIds, []);
  assert.deepEqual(reset.guideChoices, {});
  assert.deepEqual(reset.readingStageByPaperId, {});
  assert.deepEqual(reset.readingStatusByPaperId, {});
  assert.deepEqual(reset.questions, []);
  assert.deepEqual(reset.proposals, []);
  assert.equal(reset.zoteroProposalId, null);
  assert.equal(reset.zoteroProposalHash, null);
});

test("a fresh server review keeps an unsubmitted local paper selection", () => {
  const binding = {
    type: RUN_ACTIONS.BIND_LIVE_RUN,
    runId: "journal-live-review-selection",
    candidatePaperIds: ["live-1", "live-2"],
    selectablePaperIds: ["live-1", "live-2"],
    requestedPaperIds: [],
    preparedGuideIds: [],
    guideStatus: "not_started",
    serverStatus: "review_ready",
    readings: { papers: {} },
    proposals: [],
  };
  let state = runReducer(createInitialRunState(), binding);
  state = runReducer(state, { type: RUN_ACTIONS.TOGGLE_PAPER, paperId: "live-2" });

  const rebound = runReducer(state, binding);

  assert.equal(rebound.status, RUN_STATUS.REVIEW_READY);
  assert.deepEqual(rebound.selectedPaperIds, ["live-2"]);
});

test("the same live run restores prepared guides and keeps reading decisions honest", () => {
  let state = runReducer(createInitialRunState(), {
    type: RUN_ACTIONS.BIND_LIVE_RUN,
    runId: "journal-live-2",
    candidatePaperIds: ["live-1", "live-2"],
    selectablePaperIds: ["live-1", "live-2"],
    requestedPaperIds: ["live-1"],
    preparedGuideIds: ["live-1"],
    guideStatus: "ready",
  });

  assert.equal(state.status, RUN_STATUS.GUIDE_READY);
  assert.deepEqual(state.selectedPaperIds, ["live-1"]);
  assert.deepEqual(state.preparedGuideIds, ["live-1"]);

  state = runReducer(state, {
    type: RUN_ACTIONS.CHOOSE_GUIDE_ACTION,
    paperId: "live-1",
    choice: "read",
  });
  assert.equal(state.status, RUN_STATUS.GUIDE_READY);
  assert.equal(state.guideChoices["live-1"], "read");
  assert.equal(state.pausedReason, "本轮阅读决定已保存");

  const rebound = runReducer(state, {
    type: RUN_ACTIONS.BIND_LIVE_RUN,
    runId: "journal-live-2",
    candidatePaperIds: ["live-1", "live-2"],
    selectablePaperIds: ["live-1", "live-2"],
    requestedPaperIds: ["live-1"],
    preparedGuideIds: ["live-1"],
    guideStatus: "ready",
  });
  assert.equal(rebound.guideChoices["live-1"], "read");
  assert.equal(rebound.status, RUN_STATUS.GUIDE_READY);
});

test("live reading and draft readiness come from the durable server state", () => {
  const base = {
    type: RUN_ACTIONS.BIND_LIVE_RUN,
    runId: "journal-live-reading",
    candidatePaperIds: ["live-1"],
    selectablePaperIds: ["live-1"],
    requestedPaperIds: ["live-1"],
    preparedGuideIds: ["live-1"],
    guideStatus: "ready",
    guideChoices: { "live-1": "read" },
  };
  let state = runReducer(createInitialRunState(), {
    ...base,
    serverStatus: "reading",
    readings: {
      papers: {
        "live-1": {
          status: "reading",
          currentStage: "method",
        },
      },
    },
  });

  assert.equal(state.status, RUN_STATUS.READING);
  assert.equal(state.readingStageByPaperId["live-1"], 1);
  assert.equal(state.readingStatusByPaperId["live-1"], "reading");

  state = runReducer(state, {
    ...base,
    serverStatus: "draft_ready",
    readings: {
      papers: {
        "live-1": {
          status: "complete",
          currentStage: "project-relation",
        },
      },
    },
  });
  assert.equal(state.status, RUN_STATUS.DRAFT_READY);
  assert.equal(state.readingStageByPaperId["live-1"], 3);
  assert.equal(state.readingStatusByPaperId["live-1"], "complete");
});

test("a server reading restart clears stale local reading state for the same run", () => {
  const base = {
    type: RUN_ACTIONS.BIND_LIVE_RUN,
    runId: "journal-live-restart",
    candidatePaperIds: ["live-1"],
    selectablePaperIds: ["live-1"],
    requestedPaperIds: ["live-1"],
    preparedGuideIds: ["live-1"],
    guideStatus: "ready",
  };
  let state = runReducer(createInitialRunState(), {
    ...base,
    serverStatus: "reading",
    guideChoices: { "live-1": "read" },
    readings: {
      papers: {
        "live-1": {
          status: "reading",
          currentStage: "method",
        },
      },
    },
    proposals: [{ id: "stale-proposal", selected: true }],
  });
  state = {
    ...state,
    questions: [{ id: "stale-question", text: "旧追问" }],
  };

  const restarted = runReducer(state, {
    ...base,
    serverStatus: "guide_ready",
    guideChoices: {},
    readings: { papers: {} },
    proposals: [],
    restartRevision: "sha256:restart-1",
  });

  assert.equal(restarted.status, RUN_STATUS.GUIDE_READY);
  assert.deepEqual(restarted.selectedPaperIds, ["live-1"]);
  assert.deepEqual(restarted.preparedGuideIds, ["live-1"]);
  assert.deepEqual(restarted.guideChoices, {});
  assert.deepEqual(restarted.readingStageByPaperId, {});
  assert.deepEqual(restarted.readingStatusByPaperId, {});
  assert.deepEqual(restarted.questions, []);
  assert.deepEqual(restarted.proposals, []);
  assert.equal(restarted.readingRestartRevision, "sha256:restart-1");
});

test("a partial live guide batch stays reviewable until every selected guide is ready", () => {
  let state = runReducer(createInitialRunState(), {
    type: RUN_ACTIONS.BIND_LIVE_RUN,
    runId: "journal-live-partial",
    candidatePaperIds: ["live-1", "live-2"],
    selectablePaperIds: ["live-1", "live-2"],
    requestedPaperIds: ["live-1", "live-2"],
    preparedGuideIds: ["live-1"],
    guideStatus: "partial",
  });

  assert.equal(state.status, RUN_STATUS.REVIEW_READY);
  assert.deepEqual(state.selectedPaperIds, ["live-1", "live-2"]);
  assert.deepEqual(state.preparedGuideIds, ["live-1"]);
  assert.match(state.lastError, /重试/);

  state = runReducer(state, {
    type: RUN_ACTIONS.BIND_LIVE_RUN,
    runId: "journal-live-partial",
    candidatePaperIds: ["live-1", "live-2"],
    selectablePaperIds: ["live-1", "live-2"],
    requestedPaperIds: ["live-1", "live-2"],
    preparedGuideIds: [],
    guideStatus: "failed",
    serverStatus: "review_ready",
  });

  assert.equal(state.status, RUN_STATUS.REVIEW_READY);
  assert.deepEqual(state.selectedPaperIds, ["live-1", "live-2"]);
});

test("a pristine stale snapshot cannot reset an in-flight live guide selection", () => {
  let state = runReducer(createInitialRunState(), {
    type: RUN_ACTIONS.BIND_LIVE_RUN,
    runId: "journal-live-stale",
    candidatePaperIds: ["live-1", "live-2"],
    selectablePaperIds: ["live-1", "live-2"],
    requestedPaperIds: [],
    preparedGuideIds: [],
    guideStatus: "not_started",
    serverStatus: "review_ready",
  });
  state = runReducer(state, {
    type: RUN_ACTIONS.TOGGLE_PAPER,
    paperId: "live-2",
  });
  state = runReducer(state, { type: RUN_ACTIONS.PREPARE_GUIDES });

  state = runReducer(state, {
    type: RUN_ACTIONS.BIND_LIVE_RUN,
    runId: "journal-live-stale",
    candidatePaperIds: ["live-1", "live-2"],
    selectablePaperIds: ["live-1", "live-2"],
    requestedPaperIds: [],
    preparedGuideIds: [],
    guideStatus: "not_started",
    serverStatus: "review_ready",
  });

  assert.equal(state.status, RUN_STATUS.PREPARING_GUIDES);
  assert.deepEqual(state.selectedPaperIds, ["live-2"]);
});

test("a ready live guide can be explicitly regenerated and returns to the old guide on failure", () => {
  let state = runReducer(createInitialRunState(), {
    type: RUN_ACTIONS.BIND_LIVE_RUN,
    runId: "journal-live-chinese",
    candidatePaperIds: ["live-1"],
    selectablePaperIds: ["live-1"],
    requestedPaperIds: ["live-1"],
    preparedGuideIds: ["live-1"],
    guideStatus: "ready",
    serverStatus: "guide_ready",
  });
  state = runReducer(state, {
    type: RUN_ACTIONS.CHOOSE_GUIDE_ACTION,
    paperId: "live-1",
    choice: "collect",
  });
  state = runReducer(state, { type: RUN_ACTIONS.PREPARE_GUIDES });

  assert.equal(state.status, RUN_STATUS.PREPARING_GUIDES);
  assert.deepEqual(state.preparedGuideIds, ["live-1"]);
  assert.deepEqual(state.guideChoices, {});

  state = runReducer(state, {
    type: RUN_ACTIONS.GUIDES_FAILED,
    error: "中文导读生成失败",
  });
  assert.equal(state.status, RUN_STATUS.GUIDE_READY);
  assert.deepEqual(state.preparedGuideIds, ["live-1"]);
  assert.equal(state.lastError, "中文导读生成失败");
});

test("a live Zotero preview restores server status, exact proposals, and per-paper selection", () => {
  const proposals = [{
    id: "zotero-live-1",
    proposalId: "zotero-live-1",
    paperId: "live-1",
    paperIds: ["live-1"],
    target: "zotero",
    selected: true,
    status: "draft",
    contentHash: "sha256:content-1",
    targetVersionOrHash: "sha256:target",
  }, {
    id: "zotero-live-2",
    proposalId: "zotero-live-2",
    paperId: "live-2",
    paperIds: ["live-2"],
    target: "zotero",
    selected: true,
    status: "draft",
    contentHash: "sha256:content-2",
    targetVersionOrHash: "sha256:target",
  }];
  let state = runReducer(createInitialRunState(), {
    type: RUN_ACTIONS.BIND_LIVE_RUN,
    runId: "journal-live-zotero",
    candidatePaperIds: ["live-1", "live-2"],
    selectablePaperIds: ["live-1", "live-2"],
    requestedPaperIds: ["live-1", "live-2"],
    preparedGuideIds: ["live-1", "live-2"],
    guideStatus: "ready",
    serverStatus: "awaiting_approval",
    guideChoices: { "live-1": "collect", "live-2": "read" },
    proposals,
    zoteroProposalId: "zotero-preview-1",
    zoteroProposalHash: "sha256:proposal",
    zoteroTarget: { id: "C1", name: "AI 前沿论文" },
  });

  assert.equal(state.status, RUN_STATUS.AWAITING_APPROVAL);
  assert.equal(state.zoteroProposalHash, "sha256:proposal");
  assert.deepEqual(state.guideChoices, { "live-1": "collect", "live-2": "read" });
  assert.deepEqual(state.proposals.map((proposal) => proposal.id), ["zotero-live-1", "zotero-live-2"]);

  state = runReducer(state, {
    type: RUN_ACTIONS.TOGGLE_PROPOSAL,
    proposalId: "zotero-live-2",
  });
  assert.equal(state.proposals[0].selected, true);
  assert.equal(state.proposals[1].selected, false);

  state = runReducer(state, {
    type: RUN_ACTIONS.BIND_LIVE_RUN,
    runId: "journal-live-zotero",
    candidatePaperIds: ["live-1", "live-2"],
    selectablePaperIds: ["live-1", "live-2"],
    requestedPaperIds: ["live-1", "live-2"],
    preparedGuideIds: ["live-1", "live-2"],
    guideStatus: "ready",
    serverStatus: "awaiting_approval",
    guideChoices: { "live-1": "collect", "live-2": "read" },
    proposals,
    zoteroProposalId: "zotero-preview-1",
    zoteroProposalHash: "sha256:proposal",
  });
  assert.equal(state.proposals[1].selected, false);

  const blockedState = {
    ...state,
    proposals: [{
      ...proposals[0],
      actionable: false,
      selected: false,
      status: "blocked",
      writeMode: "manual_update_required",
    }],
  };
  assert.equal(runReducer(blockedState, {
    type: RUN_ACTIONS.TOGGLE_PROPOSAL,
    proposalId: "zotero-live-1",
  }), blockedState);

  state = runReducer(state, {
    type: RUN_ACTIONS.BIND_LIVE_RUN,
    runId: "journal-live-zotero",
    candidatePaperIds: ["live-1", "live-2"],
    selectablePaperIds: ["live-1", "live-2"],
    requestedPaperIds: ["live-1", "live-2"],
    preparedGuideIds: ["live-1", "live-2"],
    guideStatus: "ready",
    serverStatus: "committing",
    guideChoices: { "live-1": "collect", "live-2": "read" },
    proposals: proposals.map((proposal) => ({ ...proposal, status: "committing" })),
    zoteroProposalId: "zotero-preview-1",
    zoteroProposalHash: "sha256:proposal",
  });
  assert.equal(state.status, RUN_STATUS.COMMITTING);

  state = runReducer(state, {
    type: RUN_ACTIONS.BIND_LIVE_RUN,
    runId: "journal-live-zotero",
    candidatePaperIds: ["live-1", "live-2"],
    selectablePaperIds: ["live-1", "live-2"],
    requestedPaperIds: ["live-1", "live-2"],
    preparedGuideIds: ["live-1", "live-2"],
    guideStatus: "ready",
    serverStatus: "partial",
    proposals: [
      { ...proposals[0], status: "committed" },
      { ...proposals[1], status: "failed", error: "写入失败" },
    ],
  });
  assert.equal(state.status, RUN_STATUS.PARTIAL);
  assert.equal(state.proposals[1].status, "failed");

  state = runReducer(state, {
    type: RUN_ACTIONS.BIND_LIVE_RUN,
    runId: "journal-live-zotero",
    candidatePaperIds: ["live-1", "live-2"],
    selectablePaperIds: ["live-1", "live-2"],
    requestedPaperIds: ["live-1", "live-2"],
    preparedGuideIds: ["live-1", "live-2"],
    guideStatus: "ready",
    serverStatus: "completed",
    proposals: proposals.map((proposal) => ({ ...proposal, status: "committed" })),
  });
  assert.equal(state.status, RUN_STATUS.COMPLETED);
});

test("live Zotero terminal handoff states survive refresh without pretending reading finished", () => {
  const base = {
    type: RUN_ACTIONS.BIND_LIVE_RUN,
    runId: "journal-live-handoff",
    candidatePaperIds: ["live-1"],
    selectablePaperIds: ["live-1"],
    requestedPaperIds: ["live-1"],
    preparedGuideIds: ["live-1"],
    guideStatus: "ready",
    guideChoices: { "live-1": "read" },
    zoteroProposalId: "zotero-preview-handoff",
    zoteroProposalHash: "sha256:handoff",
  };
  let state = runReducer(createInitialRunState(), {
    ...base,
    serverStatus: "reading_ready",
    proposals: [{
      id: "zotero-live-1",
      paperIds: ["live-1"],
      target: "zotero",
      selected: true,
      status: "committed",
    }],
  });
  assert.equal(state.status, RUN_STATUS.READING_READY);

  state = runReducer(state, {
    ...base,
    serverStatus: "manual_action_required",
    proposals: [{
      id: "zotero-live-1",
      paperIds: ["live-1"],
      target: "zotero",
      selected: false,
      actionable: false,
      status: "blocked",
      writeMode: "manual_update_required",
    }],
  });
  assert.equal(state.status, RUN_STATUS.MANUAL_ACTION_REQUIRED);
});

test("collect-only selection proposes Zotero and no close-reading writes", () => {
  let state = advanceToGuide("collect");
  assert.equal(state.status, RUN_STATUS.GUIDE_READY);

  state = runReducer(state, { type: RUN_ACTIONS.GENERATE_PREVIEW });
  const proposals = Object.fromEntries(state.proposals.map((proposal) => [proposal.target, proposal]));

  assert.equal(state.status, RUN_STATUS.AWAITING_APPROVAL);
  assert.deepEqual(proposals.zotero.paperIds, ["paper-context-ledger"]);
  assert.equal(proposals.zotero.selected, true);
  assert.equal(proposals.zotero.preview.some((line) => line.includes("Human Gates")), false);
  assert.deepEqual(proposals.obsidian.paperIds, []);
  assert.equal(proposals.obsidian.selected, false);
  assert.deepEqual(proposals.project_state.paperIds, []);
  assert.equal(proposals.project_state.selected, false);

  const toggled = runReducer(state, {
    type: RUN_ACTIONS.TOGGLE_PROPOSAL,
    proposalId: proposals.obsidian.id,
  });
  assert.equal(toggled, state);
});

test("read selection scopes every proposal to the selected paper", () => {
  let state = advanceToGuide("read");
  assert.equal(state.status, RUN_STATUS.READING);

  state = runReducer(state, { type: RUN_ACTIONS.GENERATE_PREVIEW });

  for (const proposal of state.proposals) {
    assert.deepEqual(proposal.paperIds, ["paper-context-ledger"]);
    assert.equal(proposal.selected, true);
  }
  const projectStateProposal = state.proposals.find((proposal) => proposal.target === "project_state");
  assert.equal(projectStateProposal.preview.some((line) => line.includes("写入批准")), false);
  assert.equal(projectStateProposal.preview.some((line) => line.includes("状态更新保留引用")), true);
});
