import { workflowFixture } from "./fixtures.js";

export const RUN_STATUS = {
  REVIEW_READY: "review_ready",
  PREPARING_GUIDES: "preparing_guides",
  GUIDE_READY: "guide_ready",
  READING: "reading",
  AWAITING_APPROVAL: "awaiting_approval",
  COMMITTING: "committing",
  PARTIAL: "partial",
  COMPLETED: "completed",
  COMPLETED_NO_WRITE: "completed_no_write",
};

export const RUN_ACTIONS = {
  TOGGLE_PAPER: "TOGGLE_PAPER",
  PREPARE_GUIDES: "PREPARE_GUIDES",
  GUIDES_READY: "GUIDES_READY",
  CHOOSE_GUIDE_ACTION: "CHOOSE_GUIDE_ACTION",
  SET_ACTIVE_PAPER: "SET_ACTIVE_PAPER",
  NEXT_READING_STAGE: "NEXT_READING_STAGE",
  PREVIOUS_READING_STAGE: "PREVIOUS_READING_STAGE",
  ADD_QUESTION: "ADD_QUESTION",
  GENERATE_PREVIEW: "GENERATE_PREVIEW",
  TOGGLE_PROPOSAL: "TOGGLE_PROPOSAL",
  COMMIT: "COMMIT",
  COMMIT_RESULT: "COMMIT_RESULT",
  RETRY_FAILED: "RETRY_FAILED",
  RETRY_RESULT: "RETRY_RESULT",
  SKIP_RUN: "SKIP_RUN",
  RESET: "RESET",
};

const READING_STAGE_COUNT = workflowFixture.readingStages.length;

export function createInitialRunState() {
  return {
    runId: "run-demo-2026-w29",
    workflowId: workflowFixture.workflowId,
    status: RUN_STATUS.REVIEW_READY,
    pausedReason: "等待选择本周论文",
    selectedPaperIds: [],
    preparedGuideIds: [],
    activePaperId: workflowFixture.papers[0].id,
    guideChoices: {},
    readingStageIndex: 0,
    readingStageByPaperId: {},
    questions: [],
    proposals: workflowFixture.proposals.map((proposal) => ({
      ...proposal,
      selected: true,
      status: "draft",
      error: null,
    })),
    commitResults: [],
    simulateObsidianFailure: false,
    isRetrying: false,
    lastError: null,
    updatedAt: "2026-07-20 08:04",
  };
}

export const initialRunState = createInitialRunState();

function isIn(status, allowed) {
  return allowed.includes(status);
}

function finishCommit(state) {
  const selectedObsidian = state.proposals.some(
    (proposal) => proposal.selected && proposal.target === "obsidian",
  );
  const shouldFail = state.simulateObsidianFailure && selectedObsidian;

  if (!shouldFail) {
    return {
      ...state,
      status: RUN_STATUS.COMPLETED,
      pausedReason: null,
      proposals: state.proposals.map((proposal) => ({
        ...proposal,
        status: proposal.selected ? "committed" : "skipped",
        error: null,
      })),
      commitResults: state.proposals
        .filter((proposal) => proposal.selected)
        .map((proposal) => ({ proposalId: proposal.id, target: proposal.target, status: "verified" })),
      lastError: null,
      updatedAt: "刚刚",
    };
  }

  const results = [];
  const proposals = state.proposals.map((proposal) => {
    if (!proposal.selected) return { ...proposal, status: "skipped", error: null };
    if (proposal.target === "zotero") {
      results.push({ proposalId: proposal.id, target: proposal.target, status: "verified" });
      return { ...proposal, status: "committed", error: null };
    }
    if (proposal.target === "obsidian") {
      results.push({ proposalId: proposal.id, target: proposal.target, status: "failed" });
      return { ...proposal, status: "failed", error: "演示故障：Obsidian 目标文件被占用" };
    }
    return { ...proposal, status: "blocked", error: "等待 Obsidian 写入成功后继续" };
  });

  return {
    ...state,
    status: RUN_STATUS.PARTIAL,
    pausedReason: "Obsidian 写入失败；已成功的 Zotero 条目不会重复创建",
    proposals,
    commitResults: results,
    lastError: "Obsidian 写入失败，可从失败项继续",
    updatedAt: "刚刚",
  };
}

export function runReducer(state, action) {
  switch (action.type) {
    case RUN_ACTIONS.TOGGLE_PAPER: {
      if (state.status !== RUN_STATUS.REVIEW_READY) return state;
      const paperId = action.paperId;
      const isSelected = state.selectedPaperIds.includes(paperId);
      if (!isSelected && state.selectedPaperIds.length >= 2) return state;
      const selectedPaperIds = isSelected
        ? state.selectedPaperIds.filter((id) => id !== paperId)
        : [...state.selectedPaperIds, paperId];
      return {
        ...state,
        selectedPaperIds,
        activePaperId: isSelected
          ? (state.activePaperId === paperId
            ? selectedPaperIds[0] ?? workflowFixture.papers[0].id
            : state.activePaperId)
          : paperId,
      };
    }

    case RUN_ACTIONS.PREPARE_GUIDES:
      if (state.status !== RUN_STATUS.REVIEW_READY || state.selectedPaperIds.length === 0) return state;
      return {
        ...state,
        status: RUN_STATUS.PREPARING_GUIDES,
        pausedReason: null,
        preparedGuideIds: [...state.selectedPaperIds],
        activePaperId: state.selectedPaperIds[0],
      };

    case RUN_ACTIONS.GUIDES_READY:
      if (state.status !== RUN_STATUS.PREPARING_GUIDES) return state;
      return { ...state, status: RUN_STATUS.GUIDE_READY, pausedReason: "等待决定是否进入精读" };

    case RUN_ACTIONS.CHOOSE_GUIDE_ACTION: {
      if (!isIn(state.status, [RUN_STATUS.GUIDE_READY, RUN_STATUS.READING])) return state;
      const { paperId, choice } = action;
      if (!state.preparedGuideIds.includes(paperId) || !["collect", "read"].includes(choice)) return state;
      const guideChoices = { ...state.guideChoices, [paperId]: choice };
      const readingStageByPaperId = choice === "read"
        ? { ...state.readingStageByPaperId, [paperId]: state.readingStageByPaperId[paperId] ?? 0 }
        : state.readingStageByPaperId;
      const undecidedPaperIds = state.preparedGuideIds.filter((id) => !guideChoices[id]);
      const readingPaperIds = state.preparedGuideIds.filter((id) => guideChoices[id] === "read");
      const activePaperId = undecidedPaperIds[0] ?? readingPaperIds[0] ?? paperId;
      const allDecided = undecidedPaperIds.length === 0;
      const isReading = allDecided && readingPaperIds.length > 0;
      return {
        ...state,
        status: isReading ? RUN_STATUS.READING : RUN_STATUS.GUIDE_READY,
        pausedReason: !allDecided
          ? `还需决定 ${undecidedPaperIds.length} 篇论文`
          : (isReading ? "精读可随时暂停并恢复" : "已保留导读，可以生成写入预览"),
        activePaperId,
        guideChoices,
        readingStageByPaperId,
        readingStageIndex: readingStageByPaperId[activePaperId] ?? 0,
      };
    }

    case RUN_ACTIONS.SET_ACTIVE_PAPER: {
      if (!state.preparedGuideIds.includes(action.paperId)) return state;
      return {
        ...state,
        activePaperId: action.paperId,
        readingStageIndex: state.readingStageByPaperId[action.paperId] ?? 0,
      };
    }

    case RUN_ACTIONS.NEXT_READING_STAGE: {
      if (state.status !== RUN_STATUS.READING || state.guideChoices[state.activePaperId] !== "read") return state;
      const nextIndex = Math.min(state.readingStageIndex + 1, READING_STAGE_COUNT - 1);
      return {
        ...state,
        readingStageIndex: nextIndex,
        readingStageByPaperId: { ...state.readingStageByPaperId, [state.activePaperId]: nextIndex },
      };
    }

    case RUN_ACTIONS.PREVIOUS_READING_STAGE: {
      if (state.status !== RUN_STATUS.READING || state.guideChoices[state.activePaperId] !== "read") return state;
      const previousIndex = Math.max(state.readingStageIndex - 1, 0);
      return {
        ...state,
        readingStageIndex: previousIndex,
        readingStageByPaperId: { ...state.readingStageByPaperId, [state.activePaperId]: previousIndex },
      };
    }

    case RUN_ACTIONS.ADD_QUESTION: {
      if (!isIn(state.status, [RUN_STATUS.GUIDE_READY, RUN_STATUS.READING])) return state;
      const text = action.text?.trim();
      if (!text) return state;
      return {
        ...state,
        questions: [
          ...state.questions,
          {
            id: action.id ?? `question-${state.questions.length + 1}`,
            paperId: action.paperId ?? state.activePaperId,
            stageIndex: state.readingStageIndex,
            text,
            createdAt: action.createdAt ?? "刚刚",
          },
        ],
      };
    }

    case RUN_ACTIONS.GENERATE_PREVIEW:
      if (!isIn(state.status, [RUN_STATUS.GUIDE_READY, RUN_STATUS.READING])) return state;
      return {
        ...state,
        status: RUN_STATUS.AWAITING_APPROVAL,
        pausedReason: "等待确认所选写入内容",
        proposals: state.proposals.map((proposal) => ({ ...proposal, status: "draft", error: null })),
      };

    case RUN_ACTIONS.TOGGLE_PROPOSAL:
      if (state.status !== RUN_STATUS.AWAITING_APPROVAL) return state;
      return {
        ...state,
        proposals: state.proposals.map((proposal) => proposal.id === action.proposalId
          ? { ...proposal, selected: !proposal.selected }
          : proposal),
      };

    case RUN_ACTIONS.COMMIT:
      if (
        state.status !== RUN_STATUS.AWAITING_APPROVAL
        || !state.proposals.some((proposal) => proposal.selected)
      ) return state;
      return {
        ...state,
        status: RUN_STATUS.COMMITTING,
        pausedReason: null,
        simulateObsidianFailure: Boolean(action.simulateObsidianFailure),
        isRetrying: false,
        lastError: null,
      };

    case RUN_ACTIONS.COMMIT_RESULT:
      return state.status === RUN_STATUS.COMMITTING && !state.isRetrying ? finishCommit(state) : state;

    case RUN_ACTIONS.RETRY_FAILED:
      if (state.status !== RUN_STATUS.PARTIAL) return state;
      return {
        ...state,
        status: RUN_STATUS.COMMITTING,
        pausedReason: null,
        simulateObsidianFailure: false,
        isRetrying: true,
        lastError: null,
      };

    case RUN_ACTIONS.RETRY_RESULT:
      if (state.status !== RUN_STATUS.COMMITTING || !state.isRetrying) return state;
      return {
        ...state,
        status: RUN_STATUS.COMPLETED,
        pausedReason: null,
        proposals: state.proposals.map((proposal) => ({
          ...proposal,
          status: proposal.selected ? "committed" : "skipped",
          error: null,
        })),
        commitResults: state.proposals
          .filter((proposal) => proposal.selected)
          .map((proposal) => ({ proposalId: proposal.id, target: proposal.target, status: "verified" })),
        isRetrying: false,
        lastError: null,
        updatedAt: "刚刚",
      };

    case RUN_ACTIONS.SKIP_RUN:
      if (state.status !== RUN_STATUS.REVIEW_READY) return state;
      return { ...state, status: RUN_STATUS.COMPLETED_NO_WRITE, pausedReason: null, updatedAt: "刚刚" };

    case RUN_ACTIONS.RESET:
      return createInitialRunState();

    default:
      return state;
  }
}
