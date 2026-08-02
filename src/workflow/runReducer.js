import { workflowFixture } from "./fixtures.js";

export const RUN_STATUS = {
  REVIEW_READY: "review_ready",
  PREPARING_GUIDES: "preparing_guides",
  GUIDE_READY: "guide_ready",
  READING: "reading",
  DRAFT_READY: "draft_ready",
  AWAITING_APPROVAL: "awaiting_approval",
  COMMITTING: "committing",
  PARTIAL: "partial",
  MANUAL_ACTION_REQUIRED: "manual_action_required",
  READING_READY: "reading_ready",
  COMPLETED: "completed",
  COMPLETED_NO_WRITE: "completed_no_write",
};

export const RUN_ACTIONS = {
  BIND_LIVE_RUN: "BIND_LIVE_RUN",
  TOGGLE_PAPER: "TOGGLE_PAPER",
  PREPARE_GUIDES: "PREPARE_GUIDES",
  GUIDES_READY: "GUIDES_READY",
  GUIDES_FAILED: "GUIDES_FAILED",
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
    source: "fixture",
    runId: "run-demo-2026-w29",
    workflowId: workflowFixture.workflowId,
    status: RUN_STATUS.REVIEW_READY,
    pausedReason: "等待选择本月论文",
    selectedPaperIds: [],
    candidatePaperIds: workflowFixture.papers.map((paper) => paper.id),
    selectablePaperIds: Object.keys(workflowFixture.guides ?? {}),
    preparedGuideIds: [],
    guideReturnStatus: null,
    activePaperId: workflowFixture.papers[0].id,
    guideChoices: {},
    readingStageIndex: 0,
    readingStageByPaperId: {},
    readingStatusByPaperId: {},
    readingRestartRevision: null,
    questions: [],
    proposals: workflowFixture.proposals.map((proposal) => ({
      ...proposal,
      selected: true,
      status: "draft",
      error: null,
    })),
    zoteroProposalId: null,
    zoteroProposalHash: null,
    zoteroTarget: null,
    commitResults: [],
    simulateObsidianFailure: false,
    isRetrying: false,
    lastError: null,
    updatedAt: "2026-07-20 08:04",
  };
}

export const initialRunState = createInitialRunState();

export function isPersistedRunStateValid(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!["fixture", "live"].includes(value.source)) return false;
  if (typeof value.runId !== "string" || !value.runId) return false;
  if (!Object.values(RUN_STATUS).includes(value.status)) return false;
  if (!Array.isArray(value.candidatePaperIds) || !Array.isArray(value.selectablePaperIds)) return false;
  const candidateIds = new Set(value.candidatePaperIds);
  const selectableIds = new Set(value.selectablePaperIds);
  if (
    candidateIds.size !== value.candidatePaperIds.length
    || selectableIds.size !== value.selectablePaperIds.length
    || value.selectablePaperIds.some((paperId) => !candidateIds.has(paperId))
  ) return false;
  if (!Array.isArray(value.selectedPaperIds) || value.selectedPaperIds.length > 2) return false;
  if (value.selectedPaperIds.some((paperId) => !selectableIds.has(paperId))) return false;
  if (!Array.isArray(value.preparedGuideIds)) return false;
  if (value.preparedGuideIds.some((paperId) => !value.selectedPaperIds.includes(paperId))) return false;
  return true;
}

function isIn(status, allowed) {
  return allowed.includes(status);
}

function proposalsForSelection(proposals, selectedPaperIds, guideChoices) {
  const decidedPaperIds = selectedPaperIds.filter(
    (paperId) => ["collect", "read"].includes(guideChoices[paperId]),
  );
  const readingPaperIds = selectedPaperIds.filter((paperId) => guideChoices[paperId] === "read");
  return proposals.map((proposal) => {
    const paperIds = proposal.target === "zotero" ? decidedPaperIds : readingPaperIds;
    const scopedPreview = paperIds.flatMap((paperId) => proposal.previewByPaperId?.[paperId] ?? []);
    return {
      ...proposal,
      paperIds,
      preview: scopedPreview.length > 0 ? scopedPreview : proposal.preview,
      selected: paperIds.length > 0,
      status: "draft",
      error: null,
    };
  });
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
      return { ...proposal, status: "failed", error: "Obsidian 目标文件被占用，写入未完成" };
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
    case RUN_ACTIONS.BIND_LIVE_RUN: {
      if (typeof action.runId !== "string" || !action.runId) return state;
      const candidatePaperIds = [...new Set(
        (action.candidatePaperIds ?? []).filter((paperId) => typeof paperId === "string" && paperId),
      )];
      const candidateIds = new Set(candidatePaperIds);
      const selectablePaperIds = [...new Set(
        (action.selectablePaperIds ?? []).filter((paperId) => candidateIds.has(paperId)),
      )];
      const selectableIds = new Set(selectablePaperIds);
      const requestedPaperIds = [...new Set(
        (action.requestedPaperIds ?? []).filter((paperId) => selectableIds.has(paperId)),
      )].slice(0, 2);
      const preparedGuideIds = [...new Set(
        (action.preparedGuideIds ?? []).filter((paperId) => requestedPaperIds.includes(paperId)),
      )];
      const sameRun = state.source === "live" && state.runId === action.runId;
      const readingRestartRevision = action.restartRevision
        ?? (sameRun ? state.readingRestartRevision ?? null : null);
      const restartChanged = Boolean(
        sameRun
        && action.restartRevision
        && action.restartRevision !== state.readingRestartRevision,
      );
      const serverAtFreshReview = (
        action.serverStatus === RUN_STATUS.REVIEW_READY
        && action.guideStatus === "not_started"
        && requestedPaperIds.length === 0
        && preparedGuideIds.length === 0
        && Object.keys(action.guideChoices ?? {}).length === 0
        && Object.keys(action.readings?.papers ?? {}).length === 0
        && (action.proposals?.length ?? 0) === 0
        && action.zoteroProposalId == null
        && action.zoteroProposalHash == null
      );
      const hasLocalDownstreamState = (
        state.status !== RUN_STATUS.REVIEW_READY
        || state.preparedGuideIds.length > 0
        || Object.keys(state.guideChoices ?? {}).length > 0
        || Object.keys(state.readingStageByPaperId ?? {}).length > 0
        || Object.keys(state.readingStatusByPaperId ?? {}).length > 0
        || (state.questions?.length ?? 0) > 0
        || (state.proposals?.length ?? 0) > 0
        || state.zoteroProposalId !== null
        || state.zoteroProposalHash !== null
      );
      const staleFreshReview = (
        sameRun
        && state.status === RUN_STATUS.PREPARING_GUIDES
        && serverAtFreshReview
      );
      const resetToFreshReview = (
        sameRun
        && serverAtFreshReview
        && hasLocalDownstreamState
        && !staleFreshReview
      );
      const preserveSameRunState = sameRun && !resetToFreshReview && !restartChanged;
      const preservedSelection = preserveSameRunState
        ? state.selectedPaperIds.filter((paperId) => selectableIds.has(paperId))
        : [];
      const selectedPaperIds = requestedPaperIds.length > 0
        ? requestedPaperIds
        : preservedSelection;
      const preparedIds = preparedGuideIds.length > 0
        ? preparedGuideIds
        : preserveSameRunState
          ? state.preparedGuideIds.filter((paperId) => selectedPaperIds.includes(paperId))
          : [];
      let status = preserveSameRunState ? state.status : RUN_STATUS.REVIEW_READY;
      if (["running", "generating"].includes(action.guideStatus)) {
        status = RUN_STATUS.PREPARING_GUIDES;
      }
      if (
        action.guideStatus === "ready"
        && action.serverStatus !== RUN_STATUS.REVIEW_READY
        && requestedPaperIds.length > 0
        && preparedIds.length === requestedPaperIds.length
      ) {
        status = RUN_STATUS.GUIDE_READY;
      }
      if (["failed", "partial"].includes(action.guideStatus)) {
        status = RUN_STATUS.REVIEW_READY;
      }
      if (serverAtFreshReview && !staleFreshReview) {
        status = RUN_STATUS.REVIEW_READY;
      }
      // The server is authoritative: when it sits at review_ready (e.g. after a restart
      // back to the weekly candidates, even with guides still cached ready), the reader
      // must show the candidate list, never a stale guide/reading/archival view. The only
      // review_ready sub-state that keeps its own view is active guide preparation.
      if (
        action.serverStatus === RUN_STATUS.REVIEW_READY
        && status !== RUN_STATUS.PREPARING_GUIDES
      ) {
        status = RUN_STATUS.REVIEW_READY;
      }
      if ([
        RUN_STATUS.READING,
        RUN_STATUS.DRAFT_READY,
        RUN_STATUS.AWAITING_APPROVAL,
        RUN_STATUS.COMMITTING,
        RUN_STATUS.PARTIAL,
        RUN_STATUS.MANUAL_ACTION_REQUIRED,
        RUN_STATUS.READING_READY,
        RUN_STATUS.COMPLETED,
      ].includes(action.serverStatus)) {
        status = action.serverStatus;
      }
      const preservedGuideChoices = Object.fromEntries(
        Object.entries(preserveSameRunState ? state.guideChoices : {})
          .filter(([paperId]) => selectedPaperIds.includes(paperId)),
      );
      const serverGuideChoices = Object.fromEntries(
        Object.entries(action.guideChoices ?? {})
          .filter(([paperId, choice]) => (
            selectedPaperIds.includes(paperId)
            && ["collect", "read"].includes(choice)
          )),
      );
      const guideChoices = { ...preservedGuideChoices, ...serverGuideChoices };
      const readingStageByPaperId = Object.fromEntries(
        Object.entries(action.readings?.papers ?? {})
          .map(([paperId, paperState]) => {
            const stageId = paperState?.currentStage ?? paperState?.current_stage;
            const stageIndex = workflowFixture.readingStages.findIndex((stage) => stage.id === stageId);
            return [paperId, Math.max(stageIndex, 0)];
          }),
      );
      const readingStatusByPaperId = Object.fromEntries(
        Object.entries(action.readings?.papers ?? {})
          .map(([paperId, paperState]) => [paperId, paperState?.status ?? "not_started"]),
      );
      const preservePreviewSelection = sameRun
        && action.serverStatus === RUN_STATUS.AWAITING_APPROVAL
        && typeof action.zoteroProposalHash === "string"
        && action.zoteroProposalHash === state.zoteroProposalHash;
      const localSelection = new Map(
        preservePreviewSelection
          ? state.proposals.map((proposal) => [proposal.id, proposal.selected])
          : [],
      );
      const proposals = Array.isArray(action.proposals)
        ? action.proposals.map((proposal) => ({
            ...proposal,
            selected: localSelection.has(proposal.id)
              ? localSelection.get(proposal.id)
              : proposal.selected,
          }))
        : preserveSameRunState
          ? state.proposals
          : [];
      const activePaperId = (
        preserveSameRunState && preparedIds.includes(state.activePaperId)
          ? state.activePaperId
          : preparedIds[0] ?? selectedPaperIds[0] ?? candidatePaperIds[0] ?? null
      );
      return {
        ...(preserveSameRunState ? state : createInitialRunState()),
        source: "live",
        runId: action.runId,
        workflowId: action.workflowId ?? state.workflowId,
        status,
        pausedReason: (staleFreshReview ? state.pausedReason : action.pausedReason) ?? (status === RUN_STATUS.REVIEW_READY
          ? "等待选择本月论文"
          : status === RUN_STATUS.PREPARING_GUIDES
            ? "正在生成五分钟导读"
            : "等待决定只收藏或进入精读"),
        candidatePaperIds,
        selectablePaperIds,
        selectedPaperIds,
        preparedGuideIds: preparedIds,
        guideChoices,
        readingStageByPaperId: {
          ...(preserveSameRunState ? state.readingStageByPaperId : {}),
          ...readingStageByPaperId,
        },
        readingStatusByPaperId: {
          ...(preserveSameRunState ? state.readingStatusByPaperId : {}),
          ...readingStatusByPaperId,
        },
        readingStageIndex: readingStageByPaperId[activePaperId]
          ?? (preserveSameRunState ? state.readingStageIndex : 0),
        readingRestartRevision,
        proposals,
        zoteroProposalId: action.zoteroProposalId
          ?? (preserveSameRunState ? state.zoteroProposalId : null),
        zoteroProposalHash: action.zoteroProposalHash
          ?? (preserveSameRunState ? state.zoteroProposalHash : null),
        zoteroTarget: action.zoteroTarget
          ?? (preserveSameRunState ? state.zoteroTarget : null),
        activePaperId,
        lastError: action.zoteroError ?? (["failed", "partial"].includes(action.guideStatus)
          ? action.error ?? "部分五分钟导读生成失败，可重试失败论文"
          : null),
      };
    }

    case RUN_ACTIONS.TOGGLE_PAPER: {
      if (state.status !== RUN_STATUS.REVIEW_READY) return state;
      const paperId = action.paperId;
      if (!state.selectablePaperIds.includes(paperId)) return state;
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
      if (
        !isIn(state.status, [RUN_STATUS.REVIEW_READY, RUN_STATUS.GUIDE_READY])
        || state.selectedPaperIds.length === 0
      ) return state;
      return {
        ...state,
        status: RUN_STATUS.PREPARING_GUIDES,
        pausedReason: null,
        preparedGuideIds: state.status === RUN_STATUS.GUIDE_READY
          ? state.preparedGuideIds
          : state.source === "fixture" ? [...state.selectedPaperIds] : [],
        activePaperId: state.selectedPaperIds[0],
        guideChoices: state.status === RUN_STATUS.GUIDE_READY ? {} : state.guideChoices,
        guideReturnStatus: state.status === RUN_STATUS.GUIDE_READY
          ? RUN_STATUS.GUIDE_READY
          : RUN_STATUS.REVIEW_READY,
        lastError: null,
      };

    case RUN_ACTIONS.GUIDES_READY: {
      if (state.status !== RUN_STATUS.PREPARING_GUIDES) return state;
      const preparedGuideIds = (action.paperIds ?? state.selectedPaperIds)
        .filter((paperId) => state.selectedPaperIds.includes(paperId));
      if (preparedGuideIds.length === 0) return state;
      return {
        ...state,
        status: RUN_STATUS.GUIDE_READY,
        preparedGuideIds,
        activePaperId: preparedGuideIds[0],
        pausedReason: "等待决定只收藏或进入精读",
        guideReturnStatus: null,
        lastError: null,
      };
    }

    case RUN_ACTIONS.GUIDES_FAILED:
      if (state.status !== RUN_STATUS.PREPARING_GUIDES) return state;
      return {
        ...state,
        status: state.guideReturnStatus ?? RUN_STATUS.REVIEW_READY,
        preparedGuideIds: state.guideReturnStatus === RUN_STATUS.GUIDE_READY
          ? state.preparedGuideIds
          : [],
        pausedReason: state.guideReturnStatus === RUN_STATUS.GUIDE_READY
          ? "中文导读重新生成失败，旧产物仍可查看"
          : "导读生成失败，可保留所选论文后重试",
        guideReturnStatus: null,
        lastError: action.error ?? "五分钟导读生成失败",
      };

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
        status: state.source === "live"
          ? RUN_STATUS.GUIDE_READY
          : isReading ? RUN_STATUS.READING : RUN_STATUS.GUIDE_READY,
        pausedReason: !allDecided
          ? `还需决定 ${undecidedPaperIds.length} 篇论文`
          : state.source === "live"
            ? "本轮阅读决定已保存"
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
      if (state.source === "live") return state;
      return {
        ...state,
        status: RUN_STATUS.AWAITING_APPROVAL,
        pausedReason: "等待确认所选写入内容",
        proposals: proposalsForSelection(state.proposals, state.selectedPaperIds, state.guideChoices),
      };

    case RUN_ACTIONS.TOGGLE_PROPOSAL:
      if (state.status !== RUN_STATUS.AWAITING_APPROVAL) return state;
      if (!state.proposals.some((proposal) => (
        proposal.id === action.proposalId
        && (proposal.paperIds ?? []).length > 0
        && proposal.actionable !== false
        && proposal.status !== "blocked"
        && proposal.writeMode !== "manual_update_required"
      ))) return state;
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
      if (state.source !== "live") return createInitialRunState();
      return {
        ...createInitialRunState(),
        source: "live",
        runId: state.runId,
        workflowId: state.workflowId,
        candidatePaperIds: [...state.candidatePaperIds],
        selectablePaperIds: [...state.selectablePaperIds],
        activePaperId: state.candidatePaperIds[0] ?? null,
      };

    default:
      return state;
  }
}
