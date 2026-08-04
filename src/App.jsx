import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ChatText,
  Files,
  FolderSimple,
  ListChecks,
  Package,
  PlayCircle,
} from "@phosphor-icons/react";
import { BindProjectDialog } from "./components/BindProjectDialog.jsx";
import { DeleteConversationDialog } from "./components/DeleteConversationDialog.jsx";
import { DeleteTopicConversationDialog } from "./components/DeleteTopicConversationDialog.jsx";
import { ResetPaperReadingDialog } from "./components/ResetPaperReadingDialog.jsx";
import { ProjectRail } from "./components/ProjectRail.jsx";
import { WorkerRail, WorkerWorkspace } from "./components/WorkerWorkspace.jsx";
import { RenameConversationDialog } from "./components/RenameConversationDialog.jsx";
import { SettingsDialog, SettingsQuickPanel } from "./components/SettingsPanel.jsx";
import { SkillCenter } from "./components/SkillCenter.jsx";
import { fetchCandidateSummaries, fetchModelProviders, mergeCandidateSummaries } from "./api/candidateSummaries.js";
import { projectWorkApi } from "./api/projectWork.js";
import {
  adjacentConversationAfterRemoval,
  createProjectConversationLock,
  hydrateCreatedConversation,
  insertCreatedConversation,
  isProjectWorkConversationBusy,
  isProjectWorkConversationDeleteBlocked,
  removeLiveConversation,
  replaceProjectConversationSlice,
  renameLiveConversation,
  updateLiveConversationState,
  upsertLiveProject,
} from "./project-work/liveProjectWorkState.js";
import {
  commitArchiveBatch,
  createObsidianPreview,
  createProjectStatePreview,
  createZoteroProposal,
  fetchObsidianPreview,
  fetchProjectContext,
  fetchJournalPaperGuide,
  journalGuideNeedsRefresh,
  fetchJournalRun,
  fetchJournalRuns,
  fetchProjectStatePreview,
  fetchZoteroProposal,
  fetchZoteroTargets,
  addRecentClassicsToWeekly,
  addPastRunPapersToWeekly,
  translateJournalRunLibrary,
  refreshJournalCandidates,
  dismissJournalPaper,
  restartJournalReadingFromGuide,
  resetJournalPaperReading,
  retryJournalPaperDocument,
  resumeJournalRun,
  saveJournalPaperDecisions,
  selectZoteroCommitOperations,
  startJournalGuides,
  startJournalRun,
  subscribeJournalRun,
} from "./api/journalRuns.js";
import {
  addVenueSearchPapersToWeekly,
  createVenueSearchConversation,
  deleteVenueSearchConversation,
  fetchVenueSearchConversation,
  fetchVenueSearchConversations,
  fetchVenueSearchTurnProgress,
  submitVenueSearchTurn,
} from "./api/venueSearch.js";
import { getModelDisplayName, providers, skillCatalog } from "./data.js";
import { usePersistentReducer } from "./hooks/usePersistentReducer.js";
import { usePersistentState } from "./hooks/usePersistentState.js";
import { useWorkerController } from "./worker/useWorkerController.js";
import { workflowFixture } from "./workflow/fixtures.js";
import { buildPaperReadingLibrary } from "./workflow/paperLibrary.js";
import {
  createInitialRunState,
  isPersistedRunStateValid,
  RUN_ACTIONS,
  RUN_STATUS,
  runReducer,
} from "./workflow/runReducer.js";

const LiveProjectWorkbench = lazy(() => import(
  "./components/LiveProjectWorkbench.jsx"
).then((module) => ({ default: module.LiveProjectWorkbench })));
const ReadingWorkbench = lazy(() => import(
  "./components/ReadingWorkbench.jsx"
).then((module) => ({ default: module.ReadingWorkbench })));
const WorkflowWorkspace = lazy(() => import(
  "./components/WorkflowWorkspace.jsx"
).then((module) => ({ default: module.WorkflowWorkspace })));
const WorkflowContextRail = lazy(() => import(
  "./components/WorkflowContextRail.jsx"
).then((module) => ({ default: module.WorkflowContextRail })));
const TopicSearchWorkspace = lazy(() => import(
  "./components/TopicSearchWorkspace.jsx"
).then((module) => ({ default: module.TopicSearchWorkspace })));
const JournalLibraryWorkspace = lazy(() => import(
  "./components/JournalLibraryWorkspace.jsx"
).then((module) => ({ default: module.JournalLibraryWorkspace })));
const WORKFLOW_FIXTURES_ENABLED = import.meta.env.VITE_ENABLE_WORKFLOW_FIXTURES === "true";
export const DEFAULT_PROJECT_WORK_EXECUTION_POLICY_MODE = "auto_review";
const NOTIFICATION_CONVERSATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;

export function parseProjectWorkNotificationEntry(search = "") {
  const parameters = new URLSearchParams(typeof search === "string" ? search : "");
  const workTypes = parameters.getAll("work_type");
  const conversationIds = parameters.getAll("conversation_id");
  if (
    workTypes.length !== 1
    || workTypes[0] !== "project_work"
    || conversationIds.length !== 1
    || !NOTIFICATION_CONVERSATION_ID_PATTERN.test(conversationIds[0])
  ) {
    return null;
  }
  return {
    workType: "project_work",
    conversationId: conversationIds[0],
  };
}

export function notificationEntryUrlWithoutControlParameters(locationLike = {}) {
  const parameters = new URLSearchParams(locationLike.search ?? "");
  parameters.delete("work_type");
  parameters.delete("conversation_id");
  const search = parameters.toString();
  return `${locationLike.pathname || "/"}${search ? `?${search}` : ""}${locationLike.hash || ""}`;
}

const runStatusLabels = {
  [RUN_STATUS.REVIEW_READY]: "本月待审阅",
  [RUN_STATUS.PREPARING_GUIDES]: "正在准备导读",
  [RUN_STATUS.GUIDE_READY]: "导读待决定",
  [RUN_STATUS.READING]: "论文研读",
  [RUN_STATUS.DRAFT_READY]: "阅读成果待归档",
  [RUN_STATUS.AWAITING_APPROVAL]: "等待写入确认",
  [RUN_STATUS.COMMITTING]: "正在写入",
  [RUN_STATUS.PARTIAL]: "部分写入失败",
  [RUN_STATUS.MANUAL_ACTION_REQUIRED]: "需在 Zotero 手工处理",
  [RUN_STATUS.READING_READY]: "旧版 Run · 待重新检查",
  [RUN_STATUS.COMPLETED]: "本轮已完成",
  [RUN_STATUS.COMPLETED_NO_WRITE]: "本轮无写入",
};

const journalRunStatusLabels = {
  scanning: "正在扫描来源",
  ranking: "正在筛选候选",
  preparing_documents: "正在准备全文",
  review_ready: "真实候选待审阅",
  preparing_guides: "正在生成导读",
  guide_ready: "真实导读待决定",
  reading: "正在论文研读",
  draft_ready: "阅读成果待归档",
  awaiting_approval: "归档精确预览待核对",
  committing: "正在写入 Zotero",
  partial: "部分 Zotero 写入失败",
  manual_action_required: "需在 Zotero 手工处理",
  reading_ready: "旧版 Run · 待重新检查",
  completed: "本轮已完成",
  failed: "运行失败",
};

const BASE_PROJECTS = [
  {
    id: workflowFixture.project.id,
    name: workflowFixture.project.name,
    state: "2 个会话 · 1 个追踪",
    rootLabel: workflowFixture.project.rootLabel,
    updated: "本月",
    workspaceKinds: ["project_work", "paper_reading"],
    seeded: true,
  },
  {
    id: "pi-agent-frontend",
    name: "Pi Agent 前端",
    state: "1 个会话",
    rootLabel: "Pi Agent 前端",
    updated: "昨天",
    workspaceKinds: ["project_work"],
    seeded: true,
  },
];

function createLiveProjectWorkState() {
  return {
    status: "loading",
    projects: [],
    conversations: [],
    conversation: null,
    error: null,
  };
}

function projectWorkConversationLabel(status) {
  return {
    idle: "等待任务",
    running: "正在工作",
    compacting: "正在压缩上下文",
    awaiting_confirmation: "修改待审阅",
    applied: "修改已应用",
    verifying: "正在验证",
    verification_failed: "验证未通过",
    recovery_blocked: "恢复受阻",
    completed: "本轮已完成",
    failed: "本轮失败",
    interrupted: "运行已中断",
    aborted: "已停止",
    error: "需要处理",
  }[status] ?? status ?? "等待任务";
}

function mergeProviderCatalog(catalogProviders) {
  return providers.map((definition) => {
    const catalogProvider = catalogProviders.find((item) => item.id === definition.id);
    const catalogModels = catalogProvider?.models.filter((model) => definition.models.includes(model)) ?? [];
    const models = catalogModels.length > 0 ? catalogModels : definition.models;
    return {
      ...definition,
      available: Boolean(catalogProvider?.available && catalogModels.length > 0),
      status: catalogProvider?.status ?? "unavailable",
      reasonCode: catalogProvider?.reasonCode ?? "PROVIDER_NOT_REPORTED",
      models,
    };
  });
}

function normalizeProviderConfig(config, catalogProviders, defaultProviderId) {
  const configuredProvider = catalogProviders.find(
    (item) => item.id === config?.providerId && item.available,
  );
  const provider = configuredProvider
    ?? catalogProviders.find((item) => item.id === defaultProviderId && item.available)
    ?? catalogProviders.find((item) => item.available)
    ?? catalogProviders[0];
  // codex-subscription 的完整 GPT 模型清单是稍后从项目工作目录合并进来的，
  // 基础目录里只有 account-default。这里不能用基础清单去校验并清掉用户已保存的
  // GPT 模型选择，否则每次加载都会被重置回默认模型；保留已保存值，渲染时再兜底。
  if (provider?.id === "codex-subscription") {
    const savedModel = typeof config?.model === "string" && config.model.trim()
      ? config.model
      : provider?.models[0] ?? "";
    return { providerId: provider?.id ?? "", model: savedModel };
  }
  const model = provider?.models.includes(config?.model) ? config.model : provider?.models[0] ?? "";
  return { providerId: provider?.id ?? "", model };
}

function modelPreferenceId(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

export function normalizeProjectWorkModelPreference(value) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  const providerId = modelPreferenceId(source.providerId, 120);
  const modelsByProvider = {};
  if (
    source.modelsByProvider
    && typeof source.modelsByProvider === "object"
    && !Array.isArray(source.modelsByProvider)
  ) {
    for (const [rawProviderId, rawModelId] of Object.entries(source.modelsByProvider)) {
      const savedProviderId = modelPreferenceId(rawProviderId, 120);
      const savedModelId = modelPreferenceId(rawModelId, 200);
      if (savedProviderId && savedModelId) {
        modelsByProvider[savedProviderId] = savedModelId;
      }
    }
  }
  const legacyModelId = modelPreferenceId(source.model, 200);
  if (providerId && legacyModelId && !modelsByProvider[providerId]) {
    modelsByProvider[providerId] = legacyModelId;
  }
  return { providerId, modelsByProvider };
}

export function rememberProjectWorkModelPreference(value, providerId, modelId) {
  const current = normalizeProjectWorkModelPreference(value);
  const nextProviderId = modelPreferenceId(providerId, 120);
  const nextModelId = modelPreferenceId(modelId, 200);
  if (!nextProviderId || !nextModelId) return current;
  return {
    providerId: nextProviderId,
    modelsByProvider: {
      ...current.modelsByProvider,
      [nextProviderId]: nextModelId,
    },
  };
}

export function resolveProjectWorkModelSelection({
  preference,
  providers: availableProviders,
  defaultProviderId,
  defaultModelId,
  conversation = null,
}) {
  const normalizedPreference = normalizeProjectWorkModelPreference(preference);
  const providersList = Array.isArray(availableProviders) ? availableProviders : [];
  const conversationProvider = providersList.find((provider) => (
    provider?.available
    && provider.id === conversation?.providerId
    && provider.models?.includes(conversation?.modelId)
  ));
  if (conversationProvider) {
    return {
      providerId: conversationProvider.id,
      modelId: conversation.modelId,
    };
  }
  const provider = providersList.find((item) => (
    item?.available && item.id === normalizedPreference.providerId
  )) ?? providersList.find((item) => (
    item?.available && item.id === defaultProviderId
  )) ?? providersList.find((item) => item?.available)
    ?? providersList[0];
  const savedModel = normalizedPreference.modelsByProvider[provider?.id];
  const modelId = provider?.models?.includes(savedModel)
    ? savedModel
    : provider?.id === defaultProviderId && provider?.models?.includes(defaultModelId)
      ? defaultModelId
      : provider?.models?.[0] ?? "";
  return {
    providerId: provider?.id ?? "",
    modelId,
  };
}

function createLoadingSummaryState() {
  return {
    status: "loading",
    source: null,
    providerId: null,
    modelId: null,
    items: [],
    error: null,
    errorCode: null,
    retryable: false,
  };
}

function createIdleSummaryState() {
  return { ...createLoadingSummaryState(), status: "idle" };
}

function createRestoringJournalRunState() {
  return {
    status: "restoring",
    run: null,
    error: null,
  };
}

function createIdleZoteroUiState() {
  return {
    runId: null,
    targetStatus: "idle",
    targets: [],
    selectedTargetId: "",
    proposalPending: false,
    commitPending: false,
    error: null,
  };
}

function createIdleObsidianUiState(runId = null) {
  return {
    runId,
    status: "idle",
    preview: null,
    error: null,
  };
}

function createIdleProjectStateUiState(runId = null) {
  return {
    runId,
    status: "idle",
    preview: null,
    error: null,
  };
}

function readingAgentActionRevision(reading) {
  const proposals = reading?.agentActions?.proposals ?? [];
  return proposals
    .map((proposal) => [
      proposal.proposalId,
      proposal.status,
      proposal.contentHash,
      proposal.committedAt,
      proposal.updatedAt,
    ].join(":"))
    .sort()
    .join("|");
}

function runAgentActionRevision(run) {
  return Object.entries(run?.readings?.papers ?? {})
    .map(([paperId, reading]) => [
      paperId,
      reading.agentActions?.status ?? "",
      reading.agentActions?.updatedAt ?? "",
      readingAgentActionRevision(reading),
    ].join(":"))
    .sort()
    .join("|");
}

function createLoadingProjectContextState() {
  return {
    status: "loading",
    data: null,
    error: null,
    errorCode: null,
  };
}

function journalRunStateFromRun(run) {
  if ([
    "review_ready",
    "guide_ready",
    "reading",
    "draft_ready",
    "awaiting_approval",
    "partial",
    "manual_action_required",
    "reading_ready",
    "completed",
    "completed_no_write",
  ].includes(run.status)) {
    return { status: "ready", run, error: null };
  }
  if (run.status === "failed") {
    return {
      status: "failed",
      run,
      error: run.pausedReason ?? "本轮扫描失败，可重新运行。",
    };
  }
  return { status: "running", run, error: null };
}

function mergeZoteroProposal(run, proposal) {
  return {
    ...run,
    zotero: {
      ...run.zotero,
      target: proposal.target,
      decisions: proposal.decisions,
      proposalId: proposal.proposalId,
      proposalHash: proposal.proposalHash,
      proposals: proposal.proposals,
    },
  };
}

function createIdleGuideState(runId = null) {
  return {
    runId,
    status: "idle",
    byPaperId: {},
    errorsByPaperId: {},
    error: null,
  };
}

function liveRunBinding(run) {
  const candidatePaperIds = run.candidates.map((paper) => paper.id);
  const selectablePaperIds = run.candidates
    .filter((paper) => paper.mineruStatus === "ready")
    .map((paper) => paper.id);
  const requestedPaperIds = run.guides?.requestedPaperIds ?? [];
  const preparedGuideIds = requestedPaperIds.filter(
    (paperId) => run.guides?.papers?.[paperId]?.status === "ready",
  );
  const failedMessages = requestedPaperIds
    .map((paperId) => run.guides?.papers?.[paperId]?.error?.message)
    .filter(Boolean);
  return {
    type: RUN_ACTIONS.BIND_LIVE_RUN,
    runId: run.id,
    workflowId: "journal-reading-v1",
    candidatePaperIds,
    selectablePaperIds,
    requestedPaperIds,
    preparedGuideIds,
    guideStatus: run.guides?.status ?? "not_started",
    serverStatus: run.status,
    guideChoices: run.paperDecisions ?? run.zotero?.decisions ?? {},
    readings: run.readings,
    restartRevision: run.readingRestart?.revision ?? null,
    proposals: run.zotero?.proposals ?? [],
    zoteroProposalId: run.zotero?.proposalId ?? null,
    zoteroProposalHash: run.zotero?.proposalHash ?? null,
    zoteroTarget: run.zotero?.target ?? null,
    zoteroError: run.zotero?.error ?? null,
    pausedReason: run.pausedReason,
    error: failedMessages.join("；") || null,
  };
}

function runToMarkdown(run) {
  const selectedPapers = workflowFixture.papers.filter((paper) => run.selectedPaperIds.includes(paper.id));
  const lines = [
    "# Pi Agent · 期刊追踪与精读运行记录",
    "",
    `> 项目：${workflowFixture.project.name}  `,
    `> Run：${run.runId}  `,
    `> 状态：${runStatusLabels[run.status] ?? run.status}  `,
    `> 扫描窗口：${workflowFixture.scanSummary.window}  `,
    "",
    "## 本轮所选论文",
    "",
  ];

  if (selectedPapers.length === 0) lines.push("- 未选择论文");
  selectedPapers.forEach((paper) => {
    lines.push(`- **${paper.titleZh || paper.title}**（${paper.title}）`);
    lines.push(`  - 来源：${paper.venue}`);
    lines.push(`  - 决定：${run.guideChoices[paper.id] === "read" ? "进入精读" : run.guideChoices[paper.id] === "collect" ? "只收藏导读" : "尚未决定"}`);
  });

  lines.push("", "## 用户追问", "");
  if (run.questions.length === 0) lines.push("- 暂无追问");
  run.questions.forEach((question) => lines.push(`- ${question.text}`));

  lines.push("", "## 写入提案状态", "");
  run.proposals.forEach((proposal) => {
    lines.push(`- **${proposal.targetLabel}**：${proposal.selected ? proposal.status : "已取消"}`);
  });

  return lines.join("\n");
}

export function App() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [contextRailOpen, setContextRailOpen] = useState(false);
  const [leftRailWidth, setLeftRailWidth] = useState(240);
  const [rightRailWidth, setRightRailWidth] = useState(360);
  const [resizingSide, setResizingSide] = useState(null);
  const [selectedProjectId, setSelectedProjectId] = useState(BASE_PROJECTS[0].id);
  const [workspaceMode, setWorkspaceMode] = usePersistentState(
    "pi-agent-workspace-kind-v1",
    "project_work",
  );
  const notificationEntryRef = useRef(undefined);
  if (notificationEntryRef.current === undefined) {
    notificationEntryRef.current = typeof window === "undefined"
      ? null
      : parseProjectWorkNotificationEntry(window.location.search);
  }
  const [registeredProjects, setRegisteredProjects] = usePersistentState(
    "pi-agent-registered-projects-v1",
    [],
  );
  const [workspaceSelection, setWorkspaceSelection] = usePersistentState(
    "pi-agent-workspace-selection-v1",
    {
      project_work: {
        projectId: "",
        conversationId: "",
      },
      paper_reading: {
        projectId: workflowFixture.project.id,
        conversationId: "workflow-run",
      },
      worker: {
        taskId: "",
        workerId: "",
      },
    },
  );
  const [projectQuery, setProjectQuery] = useState("");
  const isResizing = resizingSide !== null;

  useEffect(() => {
    if (!notificationEntryRef.current || typeof window === "undefined") return;
    setWorkspaceMode("project_work");
    window.history.replaceState(
      window.history.state,
      "",
      notificationEntryUrlWithoutControlParameters(window.location),
    );
  }, [setWorkspaceMode]);

  const startResizing = useCallback((side) => (e) => {
    e.preventDefault();
    setResizingSide(side);
    const startX = e.clientX;
    const startWidth = side === "left" ? leftRailWidth : rightRailWidth;
    let rafId = null;

    const onMouseMove = (moveEvent) => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const deltaX = side === "left" ? moveEvent.clientX - startX : startX - moveEvent.clientX;
        // The right rail is a free split: it may grow to roughly two thirds of
        // the window so the paper and the Agent can share the space evenly.
        const rightMax = Math.max(640, Math.round(window.innerWidth * 0.68));
        const nextWidth = side === "left"
          ? Math.min(360, Math.max(200, startWidth + deltaX))
          : Math.min(rightMax, Math.max(200, startWidth + deltaX));
        if (side === "left") setLeftRailWidth(nextWidth);
        else setRightRailWidth(nextWidth);
      });
    };

    const onMouseUp = () => {
      if (rafId) cancelAnimationFrame(rafId);
      setResizingSide(null);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, [leftRailWidth, rightRailWidth]);
  const [providerConfig, setProviderConfig] = usePersistentState("pi-agent-provider-v3", {
    providerId: "",
    model: "",
  });
  const [journalThinkingLevelPref, setJournalThinkingLevelPref] = usePersistentState(
    "pi-agent-journal-thinking-v1",
    "",
  );
  const [providerCatalog, setProviderCatalog] = useState({
    status: "loading",
    mode: null,
    providers,
    error: null,
  });
  const [providerOpen, setProviderOpen] = useState(false);
  const [skillCenterOpen, setSkillCenterOpen] = useState(false);
  const [installedPackageSkillCount, setInstalledPackageSkillCount] = useState(0);
  const [settingsView, setSettingsView] = useState(null);
  const [settingsSection, setSettingsSection] = useState("general");
  const [mobileView, setMobileView] = useState("agent");
  const [toast, setToast] = useState(null);
  const [bindProjectOpen, setBindProjectOpen] = useState(false);
  const [conversationToDelete, setConversationToDelete] = useState(null);
  const [conversationToRename, setConversationToRename] = useState(null);
  const [paperToReset, setPaperToReset] = useState(null);
  const [topicConversationToDelete, setTopicConversationToDelete] = useState(null);
  const [deletingConversationId, setDeletingConversationId] = useState(null);
  const [activeConversationId, setActiveConversationId] = usePersistentState(
    "pi-agent-active-conversation-v1",
    "",
  );
  const [topicSearchState, setTopicSearchState] = useState({
    status: "idle",
    conversation: null,
    error: null,
  });
  const [topicConversations, setTopicConversations] = useState([]);
  const [activeTopicConversationId, setActiveTopicConversationId] = usePersistentState(
    "pi-agent-topic-conversation-v1",
    "",
  );
  const [topicSearchSubmitting, setTopicSearchSubmitting] = useState(false);
  const [topicSearchProgress, setTopicSearchProgress] = useState(null);
  const [topicSearchSubmitError, setTopicSearchSubmitError] = useState(null);
  const [topicSearchAddingTurnId, setTopicSearchAddingTurnId] = useState(null);
  const [topicSearchAddErrors, setTopicSearchAddErrors] = useState({});
  const topicSearchLoadedRef = useRef(false);
  const [liveProjectWork, setLiveProjectWork] = useState(createLiveProjectWorkState);
  const activeProjectWorkState = liveProjectWork.conversation;
  const [projectWorkModelCatalog, setProjectWorkModelCatalog] = useState({
    status: "loading",
    providers: [],
    defaultProviderId: "",
    defaultModelId: "",
    error: null,
  });
  const [projectWorkProviderConfig, setProjectWorkProviderConfig] = usePersistentState(
    "pi-agent-project-work-provider-v1",
    { providerId: "", modelsByProvider: {} },
  );
  const [projectWorkModelSelectionSaving, setProjectWorkModelSelectionSaving] = useState(false);
  const projectWorkModelSelectionPendingRef = useRef(false);
  const projectWorkLoadRef = useRef(0);
  const activeConversationIdRef = useRef(activeConversationId);
  const selectedProjectIdRef = useRef(selectedProjectId);
  const projectConversationCreationLockRef = useRef(null);
  const preparingConversationSelectionRef = useRef(null);
  const deletePreflightRequestRef = useRef(0);
  const [creatingConversationProjectIds, setCreatingConversationProjectIds] = useState([]);
  const [creatingStandaloneConversation, setCreatingStandaloneConversation] = useState(false);
  const [preparingConversationSelection, setPreparingConversationSelection] = useState(null);
  const toastTimer = useRef(null);
  if (!projectConversationCreationLockRef.current) {
    projectConversationCreationLockRef.current = createProjectConversationLock();
  }
  const [run, dispatch] = usePersistentReducer(runReducer, createInitialRunState, {
    validate: isPersistedRunStateValid,
  });
  const [candidateSummaryState, setCandidateSummaryState] = useState(createIdleSummaryState);
  const candidateRequestController = useRef(null);
  const [journalRunState, setJournalRunState] = useState(createRestoringJournalRunState);
  const [journalRunHistory, setJournalRunHistory] = useState([]);
  const journalStartController = useRef(null);
  const journalRestoreController = useRef(null);
  const journalGuideController = useRef(null);
  const journalDecisionController = useRef(null);
  const journalRestartController = useRef(null);
  const zoteroTargetsController = useRef(null);
  const zoteroActionController = useRef(null);
  const projectContextController = useRef(null);
  const [guideState, setGuideState] = useState(createIdleGuideState);
  const [readerGuideCache, setReaderGuideCache] = useState({});
  const [zoteroUiState, setZoteroUiState] = useState(createIdleZoteroUiState);
  const [obsidianUiState, setObsidianUiState] = useState(createIdleObsidianUiState);
  const [projectStateUiState, setProjectStateUiState] = useState(
    createIdleProjectStateUiState,
  );
  const [projectContextState, setProjectContextState] = useState(
    createLoadingProjectContextState,
  );
  const [readerTarget, setReaderTarget] = useState(null);
  const [readerContext, setReaderContext] = useState(null);
  const [readerSelectionState, setReaderSelectionState] = useState({
    reference: null,
    error: null,
  });
  const [contextRailView, setContextRailView] = useState("evidence");

  const registeredProjectItems = useMemo(() => (
    Array.isArray(registeredProjects)
      ? registeredProjects.filter((item) => (
        item
        && typeof item.id === "string"
        && typeof item.name === "string"
        && typeof item.rootLabel === "string"
        && Array.isArray(item.workspaceKinds)
      ))
      : []
  ), [registeredProjects]);
  const allProjects = useMemo(() => {
    const registeredIds = new Set(registeredProjectItems.map((item) => item.id));
    return [
      ...BASE_PROJECTS.filter((item) => !registeredIds.has(item.id)),
      ...registeredProjectItems,
    ];
  }, [registeredProjectItems]);
  const paperLibrary = useMemo(
    () => buildPaperReadingLibrary(journalRunHistory, {
      projectId: workflowFixture.project.id,
    }),
    [journalRunHistory],
  );
  const paperProjectItems = useMemo(() => allProjects
    .filter((item) => item.workspaceKinds.includes("paper_reading"))
    .map((item) => {
    const baseConversationCount = item.id === workflowFixture.project.id
      ? paperLibrary.length
      : 0;
    const trackingCopy = item.id === workflowFixture.project.id
      ? " · 1 个追踪"
      : "";
    return {
      ...item,
      state: `${baseConversationCount} 篇论文${trackingCopy}`,
      removable: !item.seeded,
    };
  }), [allProjects, paperLibrary.length]);
  const liveProjectItems = useMemo(() => liveProjectWork.projects.map((item) => ({
    ...item,
    workspaceKinds: ["project_work"],
    state: `${item.conversationCount ?? 0} 个会话`,
    updated: item.updatedAt ? "本机" : "刚刚",
    removable: true,
  })), [liveProjectWork.projects]);
  const projectItems = workspaceMode === "project_work"
    ? liveProjectItems
    : workspaceMode === "paper_reading"
      ? paperProjectItems
      : [];
  const project = (
    workspaceMode === "project_work" && selectedProjectId === ""
      ? {
          id: "",
          name: "独立对话",
          rootLabel: "未连接文件夹",
          state: "私有草稿区",
          updated: "",
        }
      : projectItems.find((item) => item.id === selectedProjectId)
    ) ?? projectItems[0]
    ?? {
      id: "",
      name: workspaceMode === "project_work"
        ? "尚未绑定项目"
        : workspaceMode === "worker"
          ? "Worker"
          : "论文精读",
      rootLabel: "",
      state: "0 个会话",
      updated: "",
    };
  const catalogProviders = providerCatalog.providers;
  // 论文侧 GPT 订阅复用写代码同一份 ChatGPT 订阅目录（模型 + 思考强度），
  // 执行仍走已验证的 Codex CLI 结构化通道，故沿用 codex-subscription 的 id 与
  // 本机登录可用性，仅把可选模型清单换成完整目录。
  const journalCodexCatalog = projectWorkModelCatalog.providers.find(
    (provider) => provider.id === "openai-codex",
  );
  const journalCodexModelThinking = new Map(
    (journalCodexCatalog?.models ?? []).map((model) => [
      model.id,
      {
        thinkingLevels: Array.isArray(model.thinkingLevels) ? model.thinkingLevels : [],
        defaultThinkingLevel: model.defaultThinkingLevel ?? null,
        supportsThinking: Boolean(model.supportsThinking),
      },
    ]),
  );
  const journalProviders = catalogProviders.map((provider) => {
    if (provider.id !== "codex-subscription") return provider;
    const catalogModels = (journalCodexCatalog?.models ?? []).map((model) => model.id);
    const models = [...new Set(["account-default", ...catalogModels])];
    return { ...provider, models };
  });
  const selectedProvider = journalProviders.find(
    (item) => item.id === providerConfig.providerId && item.available,
  ) ?? journalProviders.find((item) => item.available) ?? journalProviders[0];
  const selectedModel = selectedProvider?.models.includes(providerConfig.model)
    ? providerConfig.model
    : selectedProvider?.models[0] ?? "";
  const CODEX_DEFAULT_THINKING_LEVELS = ["low", "medium", "high", "xhigh"];
  const selectedModelThinking = selectedProvider?.id === "codex-subscription"
    ? (journalCodexModelThinking.get(selectedModel) ?? {
        thinkingLevels: CODEX_DEFAULT_THINKING_LEVELS,
        defaultThinkingLevel: "medium",
        supportsThinking: true,
      })
    : null;
  const journalThinkingLevels = selectedModelThinking
    ? (selectedModelThinking.thinkingLevels.length > 0
        ? selectedModelThinking.thinkingLevels
        : CODEX_DEFAULT_THINKING_LEVELS)
    : null;
  const journalSupportsThinking = Boolean(selectedModelThinking?.supportsThinking ?? true)
    && selectedProvider?.id === "codex-subscription";
  const activeJournalThinkingLevel = journalThinkingLevels?.includes(journalThinkingLevelPref)
    ? journalThinkingLevelPref
    : selectedModelThinking?.defaultThinkingLevel
      ?? journalThinkingLevels?.[0]
      ?? null;
  const hasProjectWorkCodexProvider = projectWorkModelCatalog.providers.some(
    (provider) => provider.id === "openai-codex",
  );
  const projectWorkProviders = [
    ...projectWorkModelCatalog.providers.map((provider) => ({
      id: provider.id,
      name: provider.id === "openai-codex"
        ? "GPT · ChatGPT 订阅"
        : provider.name,
      available: true,
      authLabel: "由 Pi 本机配置提供",
      description: "Pi SDK 可用模型",
      hint: "已连接 · 下轮消息生效",
      models: provider.models.map((model) => model.id),
    })),
    ...(projectWorkModelCatalog.status === "ready" && !hasProjectWorkCodexProvider ? [{
      id: "openai-codex",
      name: "GPT · ChatGPT 订阅",
      available: false,
      status: "尚未连接",
      hint: "需在 Pi 中单独连接 ChatGPT 订阅",
      models: [],
    }] : []),
  ];
  const preferredProjectWorkSelection = resolveProjectWorkModelSelection({
    preference: projectWorkProviderConfig,
    providers: projectWorkProviders,
    defaultProviderId: projectWorkModelCatalog.defaultProviderId,
    defaultModelId: projectWorkModelCatalog.defaultModelId,
  });
  const selectedProjectWorkSelection = resolveProjectWorkModelSelection({
    preference: projectWorkProviderConfig,
    providers: projectWorkProviders,
    defaultProviderId: projectWorkModelCatalog.defaultProviderId,
    defaultModelId: projectWorkModelCatalog.defaultModelId,
    conversation: activeProjectWorkState,
  });
  const selectedProjectWorkProvider = projectWorkProviders.find(
    (item) => item.id === selectedProjectWorkSelection.providerId,
  ) ?? projectWorkProviders[0];
  const selectedProjectWorkModel = selectedProjectWorkSelection.modelId;
  const selectedProjectWorkModelInfo = projectWorkModelCatalog.providers
    .find((provider) => provider.id === selectedProjectWorkProvider?.id)
    ?.models.find((model) => model.id === selectedProjectWorkModel);
  const installedSkillCount = useMemo(
    () => skillCatalog.length + installedPackageSkillCount,
    [installedPackageSkillCount],
  );
  const activeRun = useMemo(() => ({
    id: journalRunState.run?.id
      ?? (WORKFLOW_FIXTURES_ENABLED ? run.runId : "weekly-journal-tracking"),
    name: workflowFixture.workflowName,
    statusLabel: journalRunState.status === "restoring"
      ? "正在恢复上次 Run"
      : journalRunState.status === "starting"
      ? "正在启动扫描"
      : journalRunState.status === "error"
        ? "扫描状态读取失败"
        : journalRunState.status === "idle" && !journalRunState.run
          ? "等待开始本月扫描"
        : journalRunStatusLabels[journalRunState.run?.status]
          ?? (WORKFLOW_FIXTURES_ENABLED
            ? runStatusLabels[run.status] ?? run.status
            : "等待开始本月扫描"),
  }), [journalRunState.run?.id, journalRunState.run?.status, journalRunState.status, run.runId, run.status]);
  const liveJournalCandidates = journalRunState.run?.candidates;
  const recommendedJournalPaperIds = journalRunState.run?.weeklyRecommendation?.paperIds ?? [];
  const liveJournalPapers = recommendedJournalPaperIds.length > 0
    ? liveJournalCandidates?.filter((paper) => recommendedJournalPaperIds.includes(paper.id))
    : liveJournalCandidates;
  const obsidianAgentActionRevision = runAgentActionRevision(journalRunState.run);
  const workflowPapers = useMemo(() => (
    run.source === "live" || !WORKFLOW_FIXTURES_ENABLED
      ? liveJournalPapers ?? []
      : mergeCandidateSummaries(workflowFixture.papers, candidateSummaryState.items)
  ), [candidateSummaryState.items, liveJournalPapers, run.source]);
  const selectedReaderPapers = workflowPapers.filter(
    (paper) => (run.selectedPaperIds ?? []).includes(paper.id),
  );
  const readerRun = readerTarget
    ? (
        journalRunState.run?.id === readerTarget.runId
          ? journalRunState.run
          : journalRunHistory.find((candidateRun) => candidateRun.id === readerTarget.runId)
      ) ?? null
    : null;
  const readerPaper = readerTarget
    ? readerRun?.candidates?.find(
        (paper) => paper.id === readerTarget.paperId
          && paper.isDemo === false
          && paper.mineruStatus === "ready",
      ) ?? null
    : null;
  const paperConversationId = readerTarget
    ? `paper:${readerTarget.paperId}`
    : "paper-reading-entry";
  const projectWorkMode = workspaceMode === "project_work";
  const workerMode = workspaceMode === "worker";
  const paperReadingMode = workspaceMode === "paper_reading";
  const readingMode = Boolean(readerPaper) && activeConversationId === paperConversationId;
  const topicSearchMode = paperReadingMode
    && !readingMode
    && activeConversationId === "topic-search";
  const journalLibraryView = paperReadingMode && !readingMode
    ? (activeConversationId === "journal-classics"
        ? "recent_classics"
        : activeConversationId === "journal-history"
          ? "past_runs"
          : null)
    : null;
  const workflowMode = paperReadingMode && !readingMode && !topicSearchMode && !journalLibraryView;
  // 近年经典优先取当前 Run；当前 Run 还没整理时退回最近一期有数据的 Run。
  const recentClassicsSource = useMemo(() => {
    if (journalRunState.run?.recentClassics) {
      return { data: journalRunState.run.recentClassics, runId: journalRunState.run.id, status: journalRunState.run.status };
    }
    const fallback = journalRunHistory.find((historyRun) => historyRun.recentClassics);
    return fallback
      ? { data: fallback.recentClassics, runId: fallback.id, status: fallback.status }
      : null;
  }, [journalRunState.run, journalRunHistory]);
  const recentClassicsCanAdd = (
    recentClassicsSource?.runId === journalRunState.run?.id
    && recentClassicsSource?.status === "review_ready"
  );
  // 往期论文加入本月推荐的前提：当月已有进入审阅的 Run。
  const currentMonthReviewable = journalRunState.run?.status === "review_ready";
  const journalPastRuns = useMemo(() => journalRunHistory.filter((historyRun) => (
    historyRun.id !== journalRunState.run?.id
    && (historyRun.candidates?.length ?? 0) > 0
  )), [journalRunHistory, journalRunState.run?.id]);
  const readerGuideArtifactState = readerTarget
    ? readerRun?.guides?.papers?.[readerTarget.paperId] ?? null
    : null;
  const readerGuideCacheKey = readerTarget && readerGuideArtifactState?.status === "ready"
    ? [
        readerTarget.runId,
        readerTarget.paperId,
        readerGuideArtifactState.documentRevision,
        readerGuideArtifactState.promptVersion,
        readerGuideArtifactState.inputHash,
      ].join(":")
    : null;
  const readerGuide = (
    readerGuideCacheKey
      ? readerGuideCache[readerGuideCacheKey]?.guide
      : null
  ) ?? (
    readerPaper && guideState.runId === readerTarget?.runId
      ? (guideState.byPaperId?.[readerPaper.id] ?? null)
      : null
  );
  const readerPeerPapers = readerTarget?.runId === journalRunState.run?.id
    ? (
        readerTarget?.purpose === "close-reading"
          ? selectedReaderPapers.filter((paper) => run.guideChoices?.[paper.id] === "read")
          : selectedReaderPapers
      )
    : (readerRun?.candidates ?? []).filter(
        (paper) => readerRun?.paperDecisions?.[paper.id] === "read",
      );
  const liveZoteroDecisionsReady = run.source === "live"
    && [
      RUN_STATUS.DRAFT_READY,
      RUN_STATUS.MANUAL_ACTION_REQUIRED,
      RUN_STATUS.PARTIAL,
    ].includes(run.status)
    && run.preparedGuideIds.length > 0
    && run.preparedGuideIds.every((paperId) => ["collect", "read"].includes(run.guideChoices[paperId]));
  const paperConversations = useMemo(() => paperLibrary.map((entry) => ({
    id: entry.id,
    projectId: entry.projectId,
    kind: "paper_reading",
    title: entry.paper.shortTitle ?? entry.paper.title,
    subtitle: [
      entry.statusLabel,
      entry.position?.blockId ? "位置已保存" : null,
      entry.sourceRuns.length > 1 ? `${entry.sourceRuns.length} 次周度记录` : null,
    ].filter(Boolean).join(" · "),
    runId: entry.runId,
    paperId: entry.paperId,
    blockId: entry.position?.blockId ?? null,
    activeReadingConversationId: entry.activeConversationId,
    resetBlocked: entry.archived,
  })), [paperLibrary]);
  const liveProjectWorkConversations = useMemo(
    () => liveProjectWork.conversations.map((conversation) => ({
      id: conversation.id,
      projectId: conversation.projectId,
      kind: "project_work",
      title: conversation.title,
      status: conversation.status,
      subtitle: conversation.projectId === null
        ? `未连接文件夹 · ${projectWorkConversationLabel(conversation.status)}`
        : `正常工作 · ${projectWorkConversationLabel(conversation.status)}`,
      unreadCount: conversation.unreadCount ?? 0,
      pendingChangeFileCount: conversation.pendingChangeFileCount ?? 0,
      deleteBlocked: isProjectWorkConversationDeleteBlocked(
        conversation.id,
        activeProjectWorkState,
      ),
    })),
    [
      activeProjectWorkState,
      liveProjectWork.conversations,
    ],
  );
  const conversations = workspaceMode === "project_work"
    ? liveProjectWorkConversations
    : workspaceMode === "paper_reading"
      ? paperConversations
      : [];
  const visibleConversations = useMemo(
    () => conversations.filter((conversation) => conversation.kind === workspaceMode),
    [conversations, workspaceMode],
  );

  useEffect(() => {
    if (
      !readerGuideCacheKey
      || !readerTarget?.runId
      || !readerTarget?.paperId
      || readerGuideCache[readerGuideCacheKey]?.guide
    ) {
      return undefined;
    }
    const controller = new AbortController();
    fetchJournalPaperGuide(readerTarget.runId, readerTarget.paperId, {
      signal: controller.signal,
    }).then((guide) => {
      setReaderGuideCache((current) => ({
        ...current,
        [readerGuideCacheKey]: {
          guide,
          error: null,
        },
      }));
    }).catch((error) => {
      if (controller.signal.aborted) return;
      setReaderGuideCache((current) => ({
        ...current,
        [readerGuideCacheKey]: {
          guide: current[readerGuideCacheKey]?.guide ?? null,
          error: error.message,
        },
      }));
    });
    return () => controller.abort();
  }, [
    readerGuideCacheKey,
    readerTarget?.paperId,
    readerTarget?.runId,
  ]);

  const clearPreparingConversationSelection = useCallback(() => {
    preparingConversationSelectionRef.current = null;
    setPreparingConversationSelection(null);
  }, []);

  const loadLiveProjectWork = useCallback(async ({
    preferredProjectId,
    preferredConversationId,
    notificationConversationId,
  } = {}) => {
    clearPreparingConversationSelection();
    const requestId = projectWorkLoadRef.current + 1;
    projectWorkLoadRef.current = requestId;
    activeConversationIdRef.current = "";
    setLiveProjectWork((current) => ({
      ...current,
      status: "loading",
      conversation: null,
      error: null,
    }));
    try {
      const [projects, standaloneConversations, notificationConversation] = await Promise.all([
        projectWorkApi.listProjects(),
        projectWorkApi.listStandaloneConversations(),
        notificationConversationId
          ? projectWorkApi.fetchConversation({ conversationId: notificationConversationId })
            .catch(() => null)
          : Promise.resolve(null),
      ]);
      const notificationProjectId = notificationConversation?.projectId ?? null;
      const preferredStandalone = notificationConversation?.projectId === null
        ? notificationConversation
        : preferredProjectId === ""
        ? standaloneConversations.find((item) => item.id === preferredConversationId)
        : null;
      const projectId = notificationConversation
        ? notificationProjectId ?? ""
        : preferredStandalone
        ? ""
        : projects.some((item) => item.id === preferredProjectId)
          ? preferredProjectId
          : projects[0]?.id ?? "";
      const projectConversations = projectId
        ? await projectWorkApi.listConversations({ projectId })
        : [];
      const listedConversationIds = new Set([
        ...standaloneConversations,
        ...projectConversations,
      ].map((item) => item.id));
      const nextConversations = [
        ...standaloneConversations,
        ...projectConversations,
        ...(notificationConversation && !listedConversationIds.has(notificationConversation.id)
          ? [notificationConversation]
          : []),
      ];
      const conversationId = notificationConversation?.id
        ?? preferredStandalone?.id
        ?? (projectConversations.some((item) => item.id === preferredConversationId)
          ? preferredConversationId
          : projectConversations[0]?.id ?? standaloneConversations[0]?.id ?? "");
      const conversation = notificationConversation ?? (conversationId
        ? await projectWorkApi.fetchConversation({ conversationId })
        : null);
      if (projectWorkLoadRef.current !== requestId) return null;
      setLiveProjectWork({
        status: "ready",
        projects,
        conversations: nextConversations,
        conversation,
        error: null,
      });
      const activeProjectId = conversation?.projectId ?? (conversation ? "" : projectId);
      selectedProjectIdRef.current = activeProjectId;
      setSelectedProjectId(activeProjectId);
      activeConversationIdRef.current = conversationId;
      setActiveConversationId(conversationId);
      setMobileView("agent");
      return conversation;
    } catch (error) {
      if (projectWorkLoadRef.current !== requestId) return null;
      setLiveProjectWork((current) => ({
        ...current,
        status: "error",
        error,
      }));
      return null;
    }
  }, [
    clearPreparingConversationSelection,
    setActiveConversationId,
  ]);

  const selectLiveProject = useCallback(async (projectId, preferredConversationId) => {
    clearPreparingConversationSelection();
    const requestId = projectWorkLoadRef.current + 1;
    projectWorkLoadRef.current = requestId;
    activeConversationIdRef.current = "";
    setActiveConversationId("");
    selectedProjectIdRef.current = projectId;
    setSelectedProjectId(projectId);
    setLiveProjectWork((current) => ({
      ...current,
      status: "loading",
      conversations: current.conversations.filter((item) => item.projectId === null),
      conversation: null,
      error: null,
    }));
    try {
      const nextConversations = await projectWorkApi.listConversations({ projectId });
      const conversationId = nextConversations.some(
        (item) => item.id === preferredConversationId,
      )
        ? preferredConversationId
        : nextConversations[0]?.id ?? "";
      const conversation = conversationId
        ? await projectWorkApi.fetchConversation({ conversationId })
        : null;
      if (projectWorkLoadRef.current !== requestId) return null;
      setLiveProjectWork((current) => ({
        ...replaceProjectConversationSlice(current, projectId, nextConversations),
        status: "ready",
        conversation,
        error: null,
      }));
      activeConversationIdRef.current = conversationId;
      setActiveConversationId(conversationId);
      return conversation;
    } catch (error) {
      if (projectWorkLoadRef.current !== requestId) return null;
      setLiveProjectWork((current) => ({
        ...current,
        status: "error",
        error,
      }));
      return null;
    }
  }, [
    clearPreparingConversationSelection,
    setActiveConversationId,
  ]);

  const selectLiveConversation = useCallback(async (conversationId) => {
    if (!conversationId) return null;
    clearPreparingConversationSelection();
    const requestId = projectWorkLoadRef.current + 1;
    projectWorkLoadRef.current = requestId;
    activeConversationIdRef.current = conversationId;
    setActiveConversationId(conversationId);
    setLiveProjectWork((current) => ({
      ...current,
      status: "loading",
      conversation: null,
      error: null,
    }));
    try {
      const conversation = await projectWorkApi.fetchConversation({ conversationId });
      if (projectWorkLoadRef.current !== requestId) return null;
      setLiveProjectWork((current) => ({
        ...current,
        status: "ready",
        conversations: current.conversations.map((item) => (
          item.id === conversation.id
            ? {
                ...item,
                title: conversation.title,
                status: conversation.status,
                providerId: conversation.providerId,
                modelId: conversation.modelId,
                unreadCount: conversation.unreadCount,
                latestMessageSeq: conversation.latestMessageSeq,
                lastReadMessageSeq: conversation.lastReadMessageSeq,
                pendingChangeFileCount: conversation.pendingChangeFileCount,
                updatedAt: conversation.updatedAt,
              }
            : item
        )),
        conversation,
        error: null,
      }));
      const nextProjectId = conversation.projectId ?? "";
      selectedProjectIdRef.current = nextProjectId;
      setSelectedProjectId(nextProjectId);
      activeConversationIdRef.current = conversation.id;
      setActiveConversationId(conversation.id);
      setMobileView("agent");
      return conversation;
    } catch (error) {
      if (projectWorkLoadRef.current !== requestId) return null;
      setLiveProjectWork((current) => ({
        ...current,
        status: "error",
        error,
      }));
      return null;
    }
  }, [
    clearPreparingConversationSelection,
    setActiveConversationId,
  ]);

  const updateLiveConversation = useCallback((conversation) => {
    if (
      !conversation?.id
      || activeConversationIdRef.current !== conversation.id
    ) {
      return;
    }
    setLiveProjectWork((current) => updateLiveConversationState(current, conversation));
  }, []);

  const activateForkedProjectConversation = useCallback((conversation) => {
    if (!conversation?.id) return;
    const nextProjectId = conversation.projectId ?? "";
    selectedProjectIdRef.current = nextProjectId;
    activeConversationIdRef.current = conversation.id;
    setSelectedProjectId(nextProjectId);
    setActiveConversationId(conversation.id);
    setLiveProjectWork((current) => insertCreatedConversation(
      current,
      conversation,
      { activate: true, include: true },
    ));
    setProviderOpen(false);
    setMobileView("agent");
  }, [setActiveConversationId]);

  useEffect(() => {
    activeConversationIdRef.current = activeConversationId;
  }, [activeConversationId]);

  useEffect(() => {
    selectedProjectIdRef.current = selectedProjectId;
  }, [selectedProjectId]);

  useEffect(() => {
    if (workspaceMode !== "project_work") return;
    const savedSelection = workspaceSelection?.project_work;
    const notificationEntry = notificationEntryRef.current;
    loadLiveProjectWork({
      preferredProjectId: savedSelection?.projectId,
      preferredConversationId: savedSelection?.conversationId,
      notificationConversationId: notificationEntry?.conversationId,
    }).finally(() => {
      if (notificationEntryRef.current === notificationEntry) {
        notificationEntryRef.current = null;
      }
    });
  }, [
    loadLiveProjectWork,
    workspaceMode,
  ]);

  useEffect(() => {
    if (workspaceMode === "worker") return;
    const selectionMatchesKind = workspaceMode === "project_work"
      ? projectWorkMode
      : !projectWorkMode;
    if (
      !selectionMatchesKind
      || (workspaceMode === "project_work" && liveProjectWork.status !== "ready")
    ) {
      return;
    }
    setWorkspaceSelection((current) => ({
      ...(current && typeof current === "object" ? current : {}),
      [workspaceMode]: {
        projectId: selectedProjectId,
        conversationId: activeConversationId,
      },
    }));
  }, [
    activeConversationId,
    projectWorkMode,
    selectedProjectId,
    setWorkspaceSelection,
    liveProjectWork.status,
    workspaceMode,
  ]);

  const showToast = useCallback((message, tone = "success") => {
    window.clearTimeout(toastTimer.current);
    setToast({ message, tone });
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);
  const handleProjectWorkError = useCallback((error) => {
    showToast(error?.message || "项目工作操作没有完成", "warning");
  }, [showToast]);
  const handleWorkerError = useCallback((error) => {
    showToast(error?.message || "Worker 操作没有完成", "warning");
  }, [showToast]);
  const workerProjectOptions = useMemo(() => liveProjectItems.map((item) => ({
    id: item.id,
    label: item.name,
  })), [liveProjectItems]);
  const rememberWorkerSelection = useCallback(({ taskId, workerId }) => {
    setWorkspaceSelection((current) => ({
      ...(current && typeof current === "object" ? current : {}),
      worker: { taskId, workerId },
    }));
  }, [setWorkspaceSelection]);
  const workerController = useWorkerController({
    active: workerMode,
    preferredTaskId: workspaceSelection?.worker?.taskId ?? "",
    projectOptions: workerProjectOptions,
    defaultProviderId: preferredProjectWorkSelection.providerId,
    defaultModelId: preferredProjectWorkSelection.modelId,
    onSelectionChange: rememberWorkerSelection,
    onError: handleWorkerError,
  });

  useEffect(() => {
    if (workspaceMode !== "worker" || liveProjectWork.projects.length > 0) return undefined;
    const controller = new AbortController();
    projectWorkApi.listProjects({ signal: controller.signal }).then((projects) => {
      if (controller.signal.aborted) return;
      setLiveProjectWork((current) => ({
        ...current,
        projects,
        error: null,
      }));
    }).catch((nextError) => {
      if (controller.signal.aborted) return;
      handleWorkerError(nextError);
    });
    return () => controller.abort();
  }, [handleWorkerError, liveProjectWork.projects.length, workspaceMode]);

  const loadProjectContext = useCallback(() => {
    projectContextController.current?.abort();
    const controller = new AbortController();
    projectContextController.current = controller;
    setProjectContextState(createLoadingProjectContextState());
    fetchProjectContext({ signal: controller.signal }).then((data) => {
      setProjectContextState({
        status: "ready",
        data,
        error: null,
        errorCode: null,
      });
    }).catch((error) => {
      if (controller.signal.aborted) return;
      setProjectContextState({
        status: "error",
        data: null,
        error: error.message,
        errorCode: error.code ?? "PROJECT_CONTEXT_READ_FAILED",
      });
    }).finally(() => {
      if (projectContextController.current === controller) {
        projectContextController.current = null;
      }
    });
  }, []);

  const syncJournalRun = useCallback((nextRun) => {
    setJournalRunHistory((current) => [
      nextRun,
      ...current.filter((runItem) => runItem.id !== nextRun.id),
    ].sort((left, right) => (
      String(right.createdAt ?? right.updatedAt ?? "").localeCompare(
        String(left.createdAt ?? left.updatedAt ?? ""),
      )
    )));
    setJournalRunState(journalRunStateFromRun(nextRun));
    dispatch(liveRunBinding(nextRun));
    setObsidianUiState((current) => (
      current.runId === nextRun.id
        ? current
        : createIdleObsidianUiState(nextRun.id)
    ));
    setProjectStateUiState((current) => (
      current.runId === nextRun.id
        ? current
        : createIdleProjectStateUiState(nextRun.id)
    ));
    setGuideState((current) => (
      current.runId === nextRun.id
        ? { ...current, status: nextRun.guides?.status ?? "not_started" }
        : {
            ...createIdleGuideState(nextRun.id),
            status: nextRun.guides?.status ?? "not_started",
          }
    ));
  }, [dispatch]);

  const restoreJournalRuns = useCallback(async () => {
    journalRestoreController.current?.abort();
    const controller = new AbortController();
    journalRestoreController.current = controller;
    setJournalRunState((current) => ({
      status: "restoring",
      run: current.run,
      error: null,
    }));
    try {
      const runs = await fetchJournalRuns({ signal: controller.signal });
      setJournalRunHistory(runs);
      if (runs.length > 0) {
        syncJournalRun(runs[0]);
      } else {
        setJournalRunState({ status: "idle", run: null, error: null });
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      setJournalRunState((current) => ({
        status: "error",
        run: current.run,
        error: error.message,
      }));
    } finally {
      if (journalRestoreController.current === controller) {
        journalRestoreController.current = null;
      }
    }
  }, [syncJournalRun]);

  const loadZoteroTargets = useCallback(async (runId, preferredTargetId = null) => {
    zoteroTargetsController.current?.abort();
    const controller = new AbortController();
    zoteroTargetsController.current = controller;
    setZoteroUiState((current) => ({
      ...current,
      runId,
      targetStatus: "loading",
      targets: [],
      selectedTargetId: "",
      error: null,
    }));
    try {
      const result = await fetchZoteroTargets({ signal: controller.signal });
      const selectedTarget = result.targets.find(
        (target) => target.id === preferredTargetId,
      ) ?? result.targets.find((target) => target.id === result.selectedTargetId);
      const selectedTargetId = selectedTarget?.editable && selectedTarget.filesEditable
        ? selectedTarget.id
        : "";
      setZoteroUiState((current) => current.runId === runId
        ? {
            ...current,
            targetStatus: "ready",
            targets: result.targets,
            selectedTargetId,
            error: null,
          }
        : current);
    } catch (error) {
      if (controller.signal.aborted) return;
      setZoteroUiState((current) => current.runId === runId
        ? {
            ...current,
            targetStatus: "error",
            targets: [],
            selectedTargetId: "",
            error: error.message,
          }
        : current);
    } finally {
      if (zoteroTargetsController.current === controller) {
        zoteroTargetsController.current = null;
      }
    }
  }, []);

  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  const refreshProjectWorkModels = useCallback(async ({ signal } = {}) => {
    try {
      const catalog = await projectWorkApi.listModels({ signal });
      if (signal?.aborted) return;
      setProjectWorkModelCatalog({
        status: "ready",
        providers: catalog.providers,
        defaultProviderId: catalog.defaultProviderId,
        defaultModelId: catalog.defaultModelId,
        error: null,
      });
    } catch (error) {
      if (signal?.aborted) return;
      setProjectWorkModelCatalog({
        status: "error",
        providers: [],
        defaultProviderId: "",
        defaultModelId: "",
        error: error.message,
      });
    }
  }, []);

  const handleSkillStateChange = useCallback(({ installedCount }) => {
    setInstalledPackageSkillCount(Number(installedCount) || 0);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    projectWorkApi.listInstalledSkills({ signal: controller.signal }).then((result) => {
      if (!controller.signal.aborted) {
        setInstalledPackageSkillCount(result.packages.length);
      }
    }).catch(() => undefined);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetchModelProviders({ signal: controller.signal }).then((catalog) => {
      const nextProviders = mergeProviderCatalog(catalog.providers);
      setProviderCatalog({
        status: "ready",
        mode: catalog.mode,
        providers: nextProviders,
        error: null,
      });
      setProviderConfig((current) => normalizeProviderConfig(current, nextProviders, catalog.defaultProviderId));
    }).catch((error) => {
      if (controller.signal.aborted) return;
      setProviderCatalog({
        status: "error",
        mode: null,
        providers: mergeProviderCatalog([]),
        error: error.message,
      });
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refreshProjectWorkModels({ signal: controller.signal });
    return () => controller.abort();
  }, [refreshProjectWorkModels]);

  useEffect(() => () => {
    candidateRequestController.current?.abort();
    journalStartController.current?.abort();
    journalRestoreController.current?.abort();
    journalGuideController.current?.abort();
    journalDecisionController.current?.abort();
    journalRestartController.current?.abort();
    zoteroTargetsController.current?.abort();
    zoteroActionController.current?.abort();
    projectContextController.current?.abort();
  }, []);

  useEffect(() => {
    loadProjectContext();
    window.addEventListener("focus", loadProjectContext);
    return () => window.removeEventListener("focus", loadProjectContext);
  }, [loadProjectContext]);

  useEffect(() => {
    if (!liveZoteroDecisionsReady) return;
    void loadZoteroTargets(run.runId, run.zoteroTarget?.id);
  }, [liveZoteroDecisionsReady, loadZoteroTargets, run.runId, run.zoteroTarget?.id]);

  useEffect(() => {
    const runId = journalRunState.run?.id;
    const proposalHash = journalRunState.run?.obsidian?.proposalHash;
    if (!runId || !proposalHash) return undefined;
    const controller = new AbortController();
    setObsidianUiState({
      runId,
      status: "loading",
      preview: null,
      error: null,
    });
    fetchObsidianPreview(runId, { signal: controller.signal }).then((preview) => {
      setObsidianUiState({
        runId,
        status: "ready",
        preview,
        error: null,
      });
    }).catch((error) => {
      if (controller.signal.aborted) return;
      setObsidianUiState({
        runId,
        status: "error",
        preview: null,
        error: error.message,
      });
    });
    return () => controller.abort();
  }, [
    obsidianAgentActionRevision,
    journalRunState.run?.id,
    journalRunState.run?.obsidian?.proposalHash,
  ]);

  useEffect(() => {
    const runId = journalRunState.run?.id;
    const proposalHash = journalRunState.run?.projectState?.proposalHash;
    if (!runId || !proposalHash) return undefined;
    const controller = new AbortController();
    setProjectStateUiState({
      runId,
      status: "loading",
      preview: null,
      error: null,
    });
    fetchProjectStatePreview(runId, { signal: controller.signal }).then((preview) => {
      setProjectStateUiState({
        runId,
        status: "ready",
        preview,
        error: null,
      });
    }).catch((error) => {
      if (controller.signal.aborted) return;
      setProjectStateUiState({
        runId,
        status: "error",
        preview: null,
        error: error.message,
      });
    });
    return () => controller.abort();
  }, [
    journalRunState.run?.id,
    journalRunState.run?.projectState?.proposalHash,
  ]);

  useEffect(() => {
    void restoreJournalRuns();
    return () => journalRestoreController.current?.abort();
  }, [restoreJournalRuns]);

  useEffect(() => {
    const runId = journalRunState.run?.id;
    const localGuidePreparing = (
      run.source === "live"
      && run.runId === runId
      && run.status === RUN_STATUS.PREPARING_GUIDES
    );
    if (
      !runId
      || (!localGuidePreparing && [
        "review_ready",
        "guide_ready",
        "reading",
        "draft_ready",
        "awaiting_approval",
        "partial",
        "manual_action_required",
        "reading_ready",
        "completed",
        "completed_no_write",
        "failed",
      ].includes(journalRunState.run.status))
    ) return undefined;

    const controller = new AbortController();
    const unsubscribe = subscribeJournalRun({
      runId,
      afterSeq: journalRunState.run?.lastEventSeq ?? 0,
      onRun: syncJournalRun,
      onError: () => {
        // EventSource reconnects automatically. The bounded poll below remains
        // the fallback only when this runtime does not provide EventSource.
      },
    });
    if (unsubscribe) return unsubscribe;
    let requestActive = false;
    const poll = async () => {
      if (requestActive) return;
      requestActive = true;
      try {
        const nextRun = await fetchJournalRun(runId, { signal: controller.signal });
        syncJournalRun(nextRun);
      } catch (error) {
        if (controller.signal.aborted) return;
        setJournalRunState((current) => ({
          status: "error",
          run: current.run,
          error: error.message,
        }));
      } finally {
        requestActive = false;
      }
    };
    void poll();
    const timer = window.setInterval(poll, 1800);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [
    journalRunState.run?.id,
    journalRunState.run?.status,
    run.runId,
    run.source,
    run.status,
    syncJournalRun,
  ]);

  const zoteroProposalRestoreKey = [
    journalRunState.run?.id,
    journalRunState.run?.zotero?.proposalId,
    journalRunState.run?.status,
  ].join(":");

  useEffect(() => {
    const currentRun = journalRunState.run;
    if (
      !currentRun?.id
      || !currentRun.zotero?.proposalId
      || currentRun.zotero.proposals?.length > 0
      || ![
        "awaiting_approval",
        "partial",
        "manual_action_required",
        "reading_ready",
      ].includes(currentRun.status)
    ) return undefined;
    const controller = new AbortController();
    fetchZoteroProposal(currentRun.id, { signal: controller.signal })
      .then((proposal) => syncJournalRun(mergeZoteroProposal(currentRun, proposal)))
      .catch((error) => {
        if (controller.signal.aborted) return;
        setZoteroUiState((state) => ({
          ...state,
          runId: currentRun.id,
          error: error.message,
        }));
      });
    return () => controller.abort();
  }, [syncJournalRun, zoteroProposalRestoreKey]);

  const readyGuideKey = useMemo(() => {
    const liveRun = journalRunState.run;
    if (!liveRun?.id) return "";
    return JSON.stringify((liveRun.guides?.requestedPaperIds ?? [])
      .filter((paperId) => liveRun.guides?.papers?.[paperId]?.status === "ready")
      .sort()
      .map((paperId) => ({
        paperId,
        documentRevision: liveRun.guides?.papers?.[paperId]?.documentRevision ?? null,
        promptVersion: liveRun.guides?.papers?.[paperId]?.promptVersion ?? null,
        inputHash: liveRun.guides?.papers?.[paperId]?.inputHash ?? null,
      })));
  }, [journalRunState.run]);

  useEffect(() => {
    const runId = journalRunState.run?.id;
    const readyGuides = readyGuideKey ? JSON.parse(readyGuideKey) : [];
    if (!runId || readyGuides.length === 0) return undefined;
    const refreshIds = readyGuides
      .filter((guideReference) => journalGuideNeedsRefresh(
        guideState.byPaperId[guideReference.paperId],
        guideReference,
      ))
      .map(({ paperId }) => paperId);
    if (refreshIds.length === 0) return undefined;
    const controller = new AbortController();
    Promise.allSettled(refreshIds.map(async (paperId) => ({
      paperId,
      guide: await fetchJournalPaperGuide(runId, paperId, { signal: controller.signal }),
    }))).then((results) => {
      if (controller.signal.aborted) return;
      setGuideState((current) => {
        if (current.runId !== runId) return current;
        const byPaperId = { ...current.byPaperId };
        const errorsByPaperId = { ...current.errorsByPaperId };
        results.forEach((result, index) => {
          const paperId = refreshIds[index];
          if (result.status === "fulfilled") {
            byPaperId[paperId] = result.value.guide;
            delete errorsByPaperId[paperId];
          } else {
            errorsByPaperId[paperId] = result.reason?.message ?? "无法读取五分钟导读";
          }
        });
        return {
          ...current,
          byPaperId,
          errorsByPaperId,
          error: Object.keys(errorsByPaperId).length > 0 ? "部分导读暂时无法读取" : null,
        };
      });
    });
    return () => controller.abort();
  }, [guideState.byPaperId, journalRunState.run?.id, readyGuideKey]);

  const generateCandidateSummaries = useCallback(() => {
    if (run.status !== RUN_STATUS.REVIEW_READY) return;
    if (providerCatalog.status === "error" || !selectedProvider?.available || !selectedModel) {
      setCandidateSummaryState({
        ...createLoadingSummaryState(),
        status: "fallback",
        error: providerCatalog.error ?? "当前没有可用的模型服务商",
        errorCode: "MODEL_PROVIDER_UNAVAILABLE",
      });
      return;
    }

    candidateRequestController.current?.abort();
    const controller = new AbortController();
    candidateRequestController.current = controller;
    setCandidateSummaryState(createLoadingSummaryState());
    fetchCandidateSummaries({
      runId: run.runId,
      papers: workflowFixture.papers.slice(0, 5),
      providerId: selectedProvider.id,
      modelId: selectedModel,
      signal: controller.signal,
    }).then((result) => {
      setCandidateSummaryState({
        status: "ready",
        source: result.source === "coalesced" ? "model" : result.source,
        providerId: result.providerId,
        modelId: getModelDisplayName(result.modelId),
        items: result.items,
        error: null,
        errorCode: null,
        retryable: false,
      });
    }).catch((error) => {
      if (controller.signal.aborted) return;
      setCandidateSummaryState({
        status: "fallback",
        source: null,
        providerId: selectedProvider.id,
        modelId: null,
        items: [],
        error: error.message,
        errorCode: error.code ?? null,
        retryable: Boolean(error.retryable),
      });
    }).finally(() => {
      if (candidateRequestController.current === controller) candidateRequestController.current = null;
    });
  }, [
    providerCatalog.error,
    providerCatalog.status,
    run.runId,
    run.status,
    selectedModel,
    selectedProvider?.available,
    selectedProvider?.id,
  ]);

  const startWeeklyJournalScan = useCallback(async () => {
    journalStartController.current?.abort();
    const controller = new AbortController();
    journalStartController.current = controller;
    setReaderTarget(null);
    setGuideState(createIdleGuideState());
    setJournalRunState({
      status: "starting",
      run: null,
      error: null,
    });
    try {
      const nextRun = await startJournalRun({
        providerId: selectedProvider?.id,
        modelId: selectedModel,
        thinkingLevel: journalSupportsThinking ? activeJournalThinkingLevel : null,
        signal: controller.signal,
      });
      syncJournalRun(nextRun);
    } catch (error) {
      if (controller.signal.aborted) return;
      setJournalRunState({
        status: "error",
        run: null,
        error: error.message,
      });
    } finally {
      if (journalStartController.current === controller) journalStartController.current = null;
    }
  }, [
    selectedModel,
    selectedProvider?.id,
    journalSupportsThinking,
    activeJournalThinkingLevel,
    syncJournalRun,
  ]);

  const resumeCurrentJournalRun = useCallback(async () => {
    const runId = journalRunState.run?.id;
    if (!runId) return;
    journalStartController.current?.abort();
    const controller = new AbortController();
    journalStartController.current = controller;
    try {
      const nextRun = await resumeJournalRun(runId, { signal: controller.signal });
      syncJournalRun(nextRun);
    } catch (error) {
      if (controller.signal.aborted) return;
      setJournalRunState((current) => ({
        status: "error",
        run: current.run,
        error: error.message,
      }));
    } finally {
      if (journalStartController.current === controller) {
        journalStartController.current = null;
      }
    }
  }, [journalRunState.run?.id, syncJournalRun]);

  // 打开主题检索只读取缓存的检索记录，不会触发任何模型或联网检索。
  // 依赖只放 topicSearchMode：用 ref 守护单次加载，避免把 status 放进依赖后
  // setState('loading') 触发 effect 重跑、清理函数把自己的请求 abort 导致永远转圈。
  useEffect(() => {
    if (!topicSearchMode) {
      topicSearchLoadedRef.current = false;
      return undefined;
    }
    if (topicSearchLoadedRef.current) return undefined;
    topicSearchLoadedRef.current = true;
    const controller = new AbortController();
    setTopicSearchState({ status: "loading", conversation: null, error: null });
    (async () => {
      const list = await fetchVenueSearchConversations({ signal: controller.signal });
      if (controller.signal.aborted) return;
      setTopicConversations(list.conversations);
      const persisted = activeTopicConversationId
        && list.conversations.some((item) => item.id === activeTopicConversationId)
        ? activeTopicConversationId
        : (list.activeConversationId ?? list.conversations[0]?.id ?? null);
      setActiveTopicConversationId(persisted ?? "");
      const conversation = await fetchVenueSearchConversation({
        conversationId: persisted ?? undefined,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setTopicSearchState({ status: "ready", conversation, error: null });
    })().catch((error) => {
      if (controller.signal.aborted) return;
      topicSearchLoadedRef.current = false;
      setTopicSearchState({ status: "error", conversation: null, error: error.message });
    });
    return () => controller.abort();
  }, [topicSearchMode]);

  const refreshTopicConversations = useCallback(async () => {
    try {
      const list = await fetchVenueSearchConversations();
      setTopicConversations(list.conversations);
      return list;
    } catch {
      return null;
    }
  }, []);

  const openTopicSearch = useCallback(() => {
    setReaderTarget(null);
    setActiveConversationId("topic-search");
    setMobileView("run");
  }, [setActiveConversationId]);

  const openRecentClassics = useCallback(() => {
    setReaderTarget(null);
    setActiveConversationId("journal-classics");
    setMobileView("run");
  }, [setActiveConversationId]);

  const openPastRuns = useCallback(() => {
    setReaderTarget(null);
    setActiveConversationId("journal-history");
    setMobileView("run");
  }, [setActiveConversationId]);

  const selectTopicConversation = useCallback(async (conversationId) => {
    setActiveTopicConversationId(conversationId);
    setActiveConversationId("topic-search");
    setReaderTarget(null);
    setMobileView("run");
    setTopicSearchState({ status: "loading", conversation: null, error: null });
    try {
      const conversation = await fetchVenueSearchConversation({ conversationId });
      setTopicSearchState({ status: "ready", conversation, error: null });
    } catch (error) {
      setTopicSearchState({ status: "error", conversation: null, error: error.message });
    }
  }, [setActiveConversationId, setActiveTopicConversationId]);

  const createTopicConversation = useCallback(async () => {
    setActiveConversationId("topic-search");
    setReaderTarget(null);
    setMobileView("run");
    try {
      const conversation = await createVenueSearchConversation();
      setActiveTopicConversationId(conversation.conversationId ?? "");
      setTopicSearchState({ status: "ready", conversation, error: null });
      await refreshTopicConversations();
    } catch (error) {
      showToast(error.message);
    }
  }, [refreshTopicConversations, setActiveConversationId, setActiveTopicConversationId, showToast]);

  const deleteTopicConversation = useCallback(async (conversationId) => {
    const list = await deleteVenueSearchConversation({ conversationId });
    setTopicConversations(list.conversations);
    if (activeTopicConversationId === conversationId) {
      const nextId = list.activeConversationId ?? list.conversations[0]?.id ?? null;
      setActiveTopicConversationId(nextId ?? "");
      const conversation = await fetchVenueSearchConversation({
        conversationId: nextId ?? undefined,
      });
      setTopicSearchState({ status: "ready", conversation, error: null });
    }
    showToast("已删除该检索会话");
  }, [activeTopicConversationId, setActiveTopicConversationId, showToast]);

  const submitTopicSearchQuestion = useCallback(async (question) => {
    setTopicSearchSubmitting(true);
    setTopicSearchSubmitError(null);
    const clientRequestId = `venue-search-${globalThis.crypto?.randomUUID?.()
      ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
    setTopicSearchProgress({ phase: "planning", thinking: null, query: null });
    // 轮询服务端的分阶段思考进度，与研读对话一致。
    let cancelled = false;
    const pollProgress = async () => {
      while (!cancelled) {
        try {
          const progress = await fetchVenueSearchTurnProgress({ clientRequestId });
          if (cancelled) break;
          if (progress) {
            setTopicSearchProgress(progress);
            if (progress.status === "complete" || progress.status === "failed") break;
          }
        } catch {
          // 进度轮询失败不影响检索本身。
        }
        await new Promise((resolve) => setTimeout(resolve, 900));
      }
    };
    const polling = pollProgress();
    try {
      const conversation = await submitVenueSearchTurn({
        conversationId: activeTopicConversationId || undefined,
        question,
        providerId: selectedProvider?.id,
        modelId: selectedModel,
        thinkingLevel: journalSupportsThinking ? activeJournalThinkingLevel : null,
        clientRequestId,
      });
      setTopicSearchState({ status: "ready", conversation, error: null });
      if (conversation.conversationId) {
        setActiveTopicConversationId(conversation.conversationId);
      }
      await refreshTopicConversations();
    } catch (error) {
      setTopicSearchSubmitError(error.message);
    } finally {
      cancelled = true;
      await polling;
      setTopicSearchSubmitting(false);
      setTopicSearchProgress(null);
    }
  }, [
    activeTopicConversationId,
    selectedModel,
    selectedProvider?.id,
    journalSupportsThinking,
    activeJournalThinkingLevel,
    refreshTopicConversations,
    setActiveTopicConversationId,
  ]);

  const addTopicSearchPapers = useCallback(async (turnId, paperIds) => {
    setTopicSearchAddingTurnId(turnId);
    setTopicSearchAddErrors((current) => ({ ...current, [turnId]: null }));
    try {
      const result = await addVenueSearchPapersToWeekly({
        conversationId: activeTopicConversationId || undefined,
        turnId,
        paperIds,
      });
      setTopicSearchState({ status: "ready", conversation: result.conversation, error: null });
      syncJournalRun(result.run);
      showToast("已加入本月推荐，可从每月追踪准备全文");
    } catch (error) {
      setTopicSearchAddErrors((current) => ({ ...current, [turnId]: error.message }));
    } finally {
      setTopicSearchAddingTurnId(null);
    }
  }, [activeTopicConversationId, showToast, syncJournalRun]);

  const addRecentClassicPapers = useCallback(async (runId, paperIds) => {
    if (!runId) throw new Error("当前没有可操作的运行");
    const nextRun = await addRecentClassicsToWeekly({ runId, paperIds });
    syncJournalRun(nextRun);
    showToast("已加入本月推荐，可从每月追踪准备全文");
  }, [showToast, syncJournalRun]);

  const dismissRecentClassicPaper = useCallback(async (runId, paper) => {
    const result = await dismissJournalPaper({
      runId: runId ?? null,
      dedupeKey: paper.dedupeKey,
      title: paper.title ?? "",
    });
    if (result.run) syncJournalRun(result.run);
    showToast("已标记不感兴趣，之后不会再推荐这篇论文");
  }, [showToast, syncJournalRun]);

  const addPastRunPaper = useCallback(async (sourceRunId, paperId) => {
    if (!sourceRunId) throw new Error("往期运行不存在");
    const nextRun = await addPastRunPapersToWeekly({ sourceRunId, paperIds: [paperId] });
    syncJournalRun(nextRun);
    showToast("已加入本月推荐，可从每月追踪准备全文");
  }, [showToast, syncJournalRun]);

  const refreshCandidates = useCallback(async () => {
    const runId = journalRunState.run?.id;
    if (!runId) throw new Error("当前没有可刷新的运行");
    const nextRun = await refreshJournalCandidates({ runId });
    syncJournalRun(nextRun);
    const added = nextRun?.candidateRefresh?.lastAddedCount ?? 0;
    showToast(added > 0 ? `已刷新，新增 ${added} 篇论文` : "已刷新，暂无新发表的论文");
  }, [journalRunState.run?.id, showToast, syncJournalRun]);

  // 翻译回填：当前 Run 走完整 sync；往期 Run 只更新历史，不把它切成当前。
  const translateLibrary = useCallback(async (runId) => {
    if (!runId) throw new Error("运行不存在");
    const nextRun = await translateJournalRunLibrary({ runId });
    if (runId === journalRunState.run?.id) {
      syncJournalRun(nextRun);
    } else {
      setJournalRunHistory((current) => current.map(
        (runItem) => (runItem.id === nextRun.id ? nextRun : runItem),
      ));
    }
    showToast("已翻译为中文");
  }, [journalRunState.run?.id, showToast, syncJournalRun]);

  const retryPaperDocument = useCallback(async (paperId) => {
    const runId = journalRunState.run?.id;
    if (!runId || !paperId) {
      throw new Error("当前没有可重试的论文");
    }
    const suffix = globalThis.crypto?.randomUUID?.()
      ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const nextRun = await retryJournalPaperDocument({
      runId,
      paperId,
      clientRequestId: `document-retry-${suffix}`,
    });
    syncJournalRun(nextRun);
    return nextRun;
  }, [journalRunState.run?.id, syncJournalRun]);

  useEffect(() => {
    // 扫描/排序阶段的 Run 在服务端重启后没有执行者：恢复时主动请求
    // resume，让服务端幂等地重新接管；正常进行中的 Run 会被 inFlight 保护。
    if (!["scanning", "ranking", "committing"].includes(journalRunState.run?.status)) return;
    void resumeCurrentJournalRun();
  }, [journalRunState.run?.status, resumeCurrentJournalRun]);

  const openJournalPaperFromRun = useCallback((
    targetRun,
    paperId,
    blockId = null,
    purpose = "document",
    activeReadingConversationId = null,
  ) => {
    const paper = targetRun?.candidates?.find((candidate) => candidate.id === paperId);
    if (!targetRun?.id || paper?.mineruStatus !== "ready") return;
    setReaderContext(null);
    setReaderSelectionState({ reference: null, error: null });
    setContextRailView(purpose === "close-reading" ? "agent" : "evidence");
    if (purpose === "close-reading") setContextRailOpen(true);
    setReaderTarget({
      runId: targetRun.id,
      paperId,
      blockId,
      purpose,
      activeReadingConversationId,
    });
    setActiveConversationId(`paper:${paperId}`);
    setMobileView("run");
  }, [setActiveConversationId]);

  const openJournalPaper = useCallback((paperId, blockId = null, purpose = "document") => {
    openJournalPaperFromRun(journalRunState.run, paperId, blockId, purpose);
  }, [journalRunState.run, openJournalPaperFromRun]);

  const openPaperLibraryConversation = useCallback((conversation) => {
    const targetRun = journalRunHistory.find((runItem) => runItem.id === conversation?.runId);
    if (!targetRun || !conversation?.paperId) {
      showToast("这篇论文的历史研读暂时无法恢复", "warning");
      return;
    }
    openJournalPaperFromRun(
      targetRun,
      conversation.paperId,
      conversation.blockId,
      "close-reading",
      conversation.activeReadingConversationId,
    );
  }, [journalRunHistory, openJournalPaperFromRun, showToast]);

  // Deleting one paper's reading record is a durable server-side action: it
  // clears the conversation and progress, withdraws the read decision, and
  // returns the paper to the weekly candidate list. Archived papers stay
  // read-only. The library entry disappears because it is decision-driven.
  const confirmResetPaperReading = useCallback(async (conversation) => {
    const refreshed = await resetJournalPaperReading({
      runId: conversation.runId,
      paperId: conversation.paperId,
    });
    if (refreshed.id === journalRunState.run?.id) {
      syncJournalRun(refreshed);
    } else {
      setJournalRunHistory((current) => [
        refreshed,
        ...current.filter((runItem) => runItem.id !== refreshed.id),
      ]);
    }
    // Drop the client-side ten-round walk progress for this paper so a later
    // fresh reading does not resurrect stale progress.
    try {
      const rawProgress = window.localStorage.getItem("pi-reading-round-progress");
      if (rawProgress) {
        const progress = JSON.parse(rawProgress);
        const prefix = `${conversation.runId}:${conversation.paperId}:`;
        const kept = Object.fromEntries(
          Object.entries(progress).filter(([key]) => !key.startsWith(prefix)),
        );
        window.localStorage.setItem("pi-reading-round-progress", JSON.stringify(kept));
      }
    } catch {
      // Local reading aids are best-effort; the durable reset already happened.
    }
    if (
      (readerTarget?.runId === conversation.runId
        && readerTarget?.paperId === conversation.paperId)
      || activeConversationId === conversation.id
    ) {
      setReaderTarget(null);
      setReaderContext(null);
      setActiveConversationId("workflow-run");
      setMobileView("run");
    }
    showToast("已删除研读记录，论文已回到本月候选");
  }, [
    activeConversationId,
    journalRunState.run?.id,
    readerTarget?.paperId,
    readerTarget?.runId,
    setActiveConversationId,
    showToast,
    syncJournalRun,
  ]);

  useEffect(() => {
    if (
      workspaceMode !== "paper_reading"
      || readerTarget
      || journalRunState.status === "restoring"
      || !String(activeConversationId).startsWith("paper:")
    ) {
      return;
    }
    const savedConversation = paperConversations.find(
      (conversation) => conversation.id === activeConversationId,
    );
    if (savedConversation) {
      openPaperLibraryConversation(savedConversation);
      return;
    }
    setActiveConversationId("workflow-run");
    setMobileView("run");
  }, [
    activeConversationId,
    journalRunState.status,
    openPaperLibraryConversation,
    paperConversations,
    readerTarget,
    setActiveConversationId,
    workspaceMode,
  ]);

  const closeJournalPaper = useCallback(() => {
    setReaderTarget(null);
    setReaderContext(null);
    setReaderSelectionState({ reference: null, error: null });
    setContextRailView("evidence");
    setActiveConversationId("workflow-run");
    setMobileView("run");
  }, [setActiveConversationId]);

  const chooseGuideAction = useCallback(async (paperId, choice) => {
    if (run.source !== "live") {
      dispatch({ type: RUN_ACTIONS.CHOOSE_GUIDE_ACTION, paperId, choice });
      return;
    }
    const runId = journalRunState.run?.id;
    if (!runId || !run.preparedGuideIds.includes(paperId)) return;
    journalDecisionController.current?.abort();
    const controller = new AbortController();
    journalDecisionController.current = controller;
    try {
      const decisions = { ...run.guideChoices, [paperId]: choice };
      const nextRun = await saveJournalPaperDecisions({
        runId,
        decisions,
        signal: controller.signal,
      });
      syncJournalRun(nextRun);
      if (nextRun.status === "reading") {
        const firstReadingPaperId = nextRun.guides.requestedPaperIds.find(
          (candidateId) => nextRun.paperDecisions?.[candidateId] === "read",
        );
        if (firstReadingPaperId) {
          setReaderContext(null);
          setReaderSelectionState({ reference: null, error: null });
          setContextRailView("agent");
          setContextRailOpen(true);
          setReaderTarget({
            runId,
            paperId: firstReadingPaperId,
            blockId: null,
            purpose: "close-reading",
          });
          // Switching to the paper conversation is what moves the shell into the
          // Agent-centered reading workbench instead of the workflow layout.
          setActiveConversationId(`paper:${firstReadingPaperId}`);
        }
      }
      showToast(
        nextRun.status === "draft_ready"
          ? "阅读决定已保存，可以生成归档预览"
          : choice === "read"
            ? "已加入研读"
            : "已设为只收藏导读",
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      showToast(error.message, "warning");
    } finally {
      if (journalDecisionController.current === controller) {
        journalDecisionController.current = null;
      }
    }
  }, [
    journalRunState.run?.id,
    run.guideChoices,
    run.preparedGuideIds,
    run.source,
    setActiveConversationId,
    showToast,
    syncJournalRun,
  ]);

  const restartCurrentReadingFromGuide = useCallback(async (requestedRunId = null) => {
    const runId = requestedRunId ?? journalRunState.run?.id;
    if (!runId) return null;
    journalRestartController.current?.abort();
    const controller = new AbortController();
    journalRestartController.current = controller;
    try {
      const nextRun = await restartJournalReadingFromGuide({
        runId,
        signal: controller.signal,
      });
      setReaderTarget(null);
      setReaderContext(null);
      setReaderSelectionState({ reference: null, error: null });
      setContextRailView("evidence");
      setActiveConversationId("workflow-run");
      try {
        const rawProgress = window.localStorage.getItem("pi-reading-round-progress");
        if (rawProgress) {
          const progress = JSON.parse(rawProgress);
          const prefix = `${runId}:`;
          const kept = Object.fromEntries(
            Object.entries(progress).filter(([key]) => !key.startsWith(prefix)),
          );
          window.localStorage.setItem("pi-reading-round-progress", JSON.stringify(kept));
        }
      } catch {
        // Local reading aids are best-effort; the durable restart already happened.
      }
      if (runId === journalRunState.run?.id) {
        setZoteroUiState(createIdleZoteroUiState());
        setObsidianUiState(createIdleObsidianUiState(runId));
        setProjectStateUiState(createIdleProjectStateUiState(runId));
        syncJournalRun(nextRun);
        showToast("已从导读重新开始，可以重新选择要研读的论文");
      } else {
        setJournalRunHistory((current) => [
          nextRun,
          ...current.filter((runItem) => runItem.id !== nextRun.id),
        ]);
        showToast("该次研读已从导读重新开始；当前每月追踪保持不变");
      }
      return nextRun;
    } catch (error) {
      if (controller.signal.aborted) return null;
      throw error;
    } finally {
      if (journalRestartController.current === controller) {
        journalRestartController.current = null;
      }
    }
  }, [
    journalRunState.run?.id,
    setActiveConversationId,
    showToast,
    syncJournalRun,
  ]);

  const refreshReadingRun = useCallback(async (requestedRunId = null) => {
    const runId = requestedRunId ?? journalRunState.run?.id;
    if (!runId) return;
    try {
      const refreshed = await fetchJournalRun(runId);
      if (runId === journalRunState.run?.id) {
        syncJournalRun(refreshed);
      } else {
        setJournalRunHistory((current) => [
          refreshed,
          ...current.filter((runItem) => runItem.id !== refreshed.id),
        ]);
      }
    } catch (error) {
      showToast(error.message, "warning");
    }
  }, [journalRunState.run?.id, showToast, syncJournalRun]);

  const publishReaderReading = useCallback((nextReading) => {
    const actionChanged = readingAgentActionRevision(readerContext?.reading)
      !== readingAgentActionRevision(nextReading);
    if (actionChanged) {
      setObsidianUiState((current) => (
        current.runId === nextReading?.runId
        && ["loading", "ready"].includes(current.status)
          ? {
              runId: nextReading.runId,
              status: "error",
              preview: null,
              error: "Agent 笔记已变化，请重新生成 Obsidian 精确预览。",
            }
          : current
      ));
    }
    setReaderContext((current) => (
      current
      && current.runId === nextReading?.runId
      && current.paperId === nextReading?.paperId
        ? { ...current, reading: nextReading }
        : current
    ));
    void refreshReadingRun(nextReading?.runId);
  }, [readerContext?.reading, refreshReadingRun]);

  const openReaderBlock = useCallback((blockId) => {
    if (!blockId) return;
    setReaderTarget((current) => (
      current ? { ...current, blockId } : current
    ));
    if (window.matchMedia?.("(max-width: 860px)").matches) {
      setMobileView("run");
    }
  }, []);

  const updateReaderSelection = useCallback((nextSelection) => {
    setReaderSelectionState(nextSelection);
    if (!nextSelection?.reference && !nextSelection?.error) return;
    setContextRailOpen(true);
    setContextRailView("agent");
    if (window.matchMedia?.("(max-width: 860px)").matches) {
      setMobileView("evidence");
    }
  }, []);

  useEffect(() => {
    if (readerTarget) return;
    setReaderContext(null);
    setReaderSelectionState({ reference: null, error: null });
    setContextRailView((current) => (
      ["agent", "notes"].includes(current) ? "evidence" : current
    ));
  }, [readerTarget]);

  const prepareGuides = useCallback(async () => {
    if (run.source !== "live") {
      dispatch({ type: RUN_ACTIONS.PREPARE_GUIDES });
      return;
    }
    const liveRun = journalRunState.run;
    if (
      !liveRun?.id
      || ![RUN_STATUS.REVIEW_READY, RUN_STATUS.GUIDE_READY].includes(run.status)
      || run.selectedPaperIds.length === 0
    ) return;
    if (!selectedProvider?.available || !selectedModel) {
      showToast("当前没有可用模型，无法生成五分钟导读", "warning");
      return;
    }

    journalGuideController.current?.abort();
    const controller = new AbortController();
    journalGuideController.current = controller;
    dispatch({ type: RUN_ACTIONS.PREPARE_GUIDES });
    setGuideState((current) => ({
      ...(current.runId === liveRun.id ? current : createIdleGuideState(liveRun.id)),
      status: "submitting",
      error: null,
    }));
    try {
      const nextRun = await startJournalGuides({
        runId: liveRun.id,
        paperIds: run.selectedPaperIds,
        providerId: selectedProvider.id,
        modelId: selectedModel,
        thinkingLevel: journalSupportsThinking ? activeJournalThinkingLevel : null,
        signal: controller.signal,
      });
      syncJournalRun(nextRun);
    } catch (error) {
      if (controller.signal.aborted) return;
      dispatch({ type: RUN_ACTIONS.GUIDES_FAILED, error: error.message });
      setGuideState((current) => ({
        ...current,
        status: "error",
        error: error.message,
      }));
    } finally {
      if (journalGuideController.current === controller) {
        journalGuideController.current = null;
      }
    }
  }, [
    journalRunState.run,
    run.selectedPaperIds,
    run.source,
    run.status,
    selectedModel,
    selectedProvider?.available,
    selectedProvider?.id,
    showToast,
    syncJournalRun,
  ]);

  const generateWritePreview = useCallback(async () => {
    if (run.source !== "live") {
      dispatch({ type: RUN_ACTIONS.GENERATE_PREVIEW });
      return;
    }
    const runId = journalRunState.run?.id;
    const targetId = zoteroUiState.selectedTargetId;
    if (!runId || !liveZoteroDecisionsReady || !targetId) {
      setZoteroUiState((current) => ({
        ...current,
        error: "请先明确选择一个 Zotero collection",
      }));
      return;
    }
    const decisions = Object.fromEntries(
      run.preparedGuideIds.map((paperId) => [paperId, run.guideChoices[paperId]]),
    );
    const requiresObsidian = Object.values(decisions).includes("read");
    zoteroActionController.current?.abort();
    const controller = new AbortController();
    zoteroActionController.current = controller;
    setZoteroUiState((current) => ({
      ...current,
      proposalPending: true,
      error: null,
    }));
    setObsidianUiState({
      runId,
      status: requiresObsidian ? "loading" : "not_required",
      preview: null,
      error: null,
    });
    setProjectStateUiState({
      runId,
      status: requiresObsidian ? "idle" : "not_required",
      preview: null,
      error: null,
    });
    let previewStep = requiresObsidian ? "obsidian" : "zotero";
    try {
      if (requiresObsidian) {
        const preview = await createObsidianPreview({
          runId,
          signal: controller.signal,
        });
        setObsidianUiState({
          runId,
          status: "ready",
          preview,
          error: null,
        });
        previewStep = "project_state";
        setProjectStateUiState({
          runId,
          status: "loading",
          preview: null,
          error: null,
        });
        try {
          const projectStatePreview = await createProjectStatePreview({
            runId,
            signal: controller.signal,
          });
          setProjectStateUiState({
            runId,
            status: "ready",
            preview: projectStatePreview,
            error: null,
          });
        } catch (error) {
          if (error.code !== "PROJECT_STATE_NOT_REQUIRED") throw error;
          setProjectStateUiState({
            runId,
            status: "not_required",
            preview: null,
            error: null,
          });
        }
        previewStep = "zotero";
      }
      await createZoteroProposal({
        runId,
        decisions,
        targetId,
        signal: controller.signal,
      });
      const [proposal, nextRun] = await Promise.all([
        fetchZoteroProposal(runId, { signal: controller.signal }),
        fetchJournalRun(runId, { signal: controller.signal }),
      ]);
      syncJournalRun(mergeZoteroProposal(nextRun, proposal));
      showToast(requiresObsidian
        ? "Obsidian、项目状态与 Zotero 精确预览已生成，请逐项核对"
        : "Zotero 精确预览已生成，请逐篇核对");
    } catch (error) {
      if (controller.signal.aborted) return;
      if (previewStep === "obsidian") {
        setObsidianUiState({
          runId,
          status: "error",
          preview: null,
          error: error.message,
        });
      } else if (previewStep === "project_state") {
        setProjectStateUiState({
          runId,
          status: "error",
          preview: null,
          error: error.message,
        });
      } else {
        setZoteroUiState((current) => ({
          ...current,
          error: error.message,
        }));
      }
    } finally {
      if (zoteroActionController.current === controller) {
        zoteroActionController.current = null;
        setZoteroUiState((current) => ({
          ...current,
          proposalPending: false,
        }));
      }
    }
  }, [
    journalRunState.run?.id,
    liveZoteroDecisionsReady,
    run.guideChoices,
    run.preparedGuideIds,
    run.source,
    showToast,
    syncJournalRun,
    zoteroUiState.selectedTargetId,
  ]);

  const commitWritePreview = useCallback(async ({ simulateObsidianFailure = false, retry = false } = {}) => {
    if (run.source !== "live") {
      dispatch({
        type: retry ? RUN_ACTIONS.RETRY_FAILED : RUN_ACTIONS.COMMIT,
        simulateObsidianFailure,
      });
      return;
    }
    const runId = journalRunState.run?.id;
    const zoteroOperations = selectZoteroCommitOperations(run.proposals, { retry });
    const obsidianPreview = obsidianUiState.preview;
    const obsidianOperations = (obsidianPreview?.proposals ?? [])
      .filter((proposal) => (
        proposal.actionable !== false
        && proposal.selected !== false
      ))
      .map((proposal) => ({
        proposalId: proposal.proposalId ?? proposal.id,
        contentHash: proposal.contentHash,
        targetVersionOrHash: proposal.targetVersionOrHash,
      }));
    const projectStatePreview = projectStateUiState.preview;
    const projectStateProposal = projectStatePreview?.proposal
      ?? projectStatePreview?.proposals?.[0]
      ?? null;
    const includesReading = Object.values(run.guideChoices).includes("read");
    const hasAnyOperation = (
      zoteroOperations.length > 0
      || obsidianOperations.length > 0
      || (
        projectStateProposal
        && projectStateProposal.actionable !== false
      )
    );
    if (!runId || !hasAnyOperation) {
      setZoteroUiState((current) => ({
        ...current,
        error: "当前没有可确认的归档写入项",
      }));
      return;
    }
    zoteroActionController.current?.abort();
    const controller = new AbortController();
    zoteroActionController.current = controller;
    setZoteroUiState((current) => ({
      ...current,
      commitPending: true,
      error: null,
    }));
    try {
      const nextRun = await commitArchiveBatch({
        runId,
        clientRequestId: `archive-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`,
        obsidian: includesReading && obsidianPreview
          ? {
              proposalHash: obsidianPreview.proposalHash,
              operations: obsidianOperations,
            }
          : null,
        zotero: run.zoteroProposalHash && zoteroOperations.length > 0
          ? {
              proposalHash: run.zoteroProposalHash,
              operations: zoteroOperations,
            }
          : null,
        projectState: includesReading
          && projectStatePreview
          && projectStateProposal?.actionable !== false
          && projectStateProposal?.selected !== false
          ? {
              proposalHash: projectStatePreview.proposalHash,
              operation: {
                proposalId: projectStateProposal.proposalId
                  ?? projectStateProposal.id,
                contentHash: projectStateProposal.contentHash,
                targetVersionOrHash:
                  projectStateProposal.targetVersionOrHash,
              },
            }
          : null,
        simulateObsidianFailure,
        signal: controller.signal,
      });
      syncJournalRun(nextRun);
    } catch (error) {
      if (controller.signal.aborted) return;
      setZoteroUiState((current) => ({
        ...current,
        error: error.message,
      }));
    } finally {
      if (zoteroActionController.current === controller) {
        zoteroActionController.current = null;
        setZoteroUiState((current) => ({
          ...current,
          commitPending: false,
        }));
      }
    }
  }, [
    journalRunState.run?.id,
    obsidianUiState.preview,
    projectStateUiState.preview,
    run.guideChoices,
    run.proposals,
    run.source,
    run.zoteroProposalHash,
    syncJournalRun,
  ]);

  useEffect(() => {
    if (run.source === "fixture" && run.status === RUN_STATUS.PREPARING_GUIDES) {
      const timer = window.setTimeout(() => dispatch({ type: RUN_ACTIONS.GUIDES_READY }), 850);
      return () => window.clearTimeout(timer);
    }
    if (run.source === "fixture" && run.status === RUN_STATUS.COMMITTING) {
      const action = run.isRetrying ? RUN_ACTIONS.RETRY_RESULT : RUN_ACTIONS.COMMIT_RESULT;
      const timer = window.setTimeout(() => dispatch({ type: action }), 900);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [run.source, run.status, run.isRetrying]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === ",") {
        event.preventDefault();
        setProviderOpen(false);
        setSkillCenterOpen(false);
        setSettingsSection("general");
        setSettingsView("full");
        return;
      }
      if (event.key !== "Escape") return;
      setProviderOpen(false);
      setSkillCenterOpen(false);
      setSettingsView(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const selectProvider = (providerId) => {
    const nextProvider = journalProviders.find((item) => item.id === providerId && item.available);
    if (!nextProvider) return;
    if (nextProvider.id === selectedProvider.id && nextProvider.models[0] === selectedModel) return;
    candidateRequestController.current?.abort();
    setCandidateSummaryState(createIdleSummaryState());
    setProviderConfig({ providerId: nextProvider.id, model: nextProvider.models[0] });
    showToast(`已切换到 ${nextProvider.name} · 点击更新候选说明`);
  };

  const selectModel = (model) => {
    if (!selectedProvider?.available || !selectedProvider.models.includes(model)) return;
    if (model === selectedModel) return;
    candidateRequestController.current?.abort();
    setCandidateSummaryState(createIdleSummaryState());
    setProviderConfig({ providerId: selectedProvider.id, model });
  };

  const selectJournalThinkingLevel = (level) => {
    if (!journalThinkingLevels?.includes(level)) return;
    setJournalThinkingLevelPref(level);
  };

  const persistProjectWorkModelSelection = async (providerId, modelId) => {
    if (!providerId || !modelId) return;
    if (projectWorkModelSelectionPendingRef.current) {
      showToast("模型正在切换，请稍候", "warning");
      return;
    }
    const conversation = activeProjectWorkState;
    if (conversation && isProjectWorkConversationBusy(conversation)) {
      showToast("Agent 工作期间不能切换模型", "warning");
      return;
    }
    projectWorkModelSelectionPendingRef.current = true;
    setProjectWorkModelSelectionSaving(true);
    try {
      if (conversation?.id) {
        const configured = await projectWorkApi.configureConversation({
          conversationId: conversation.id,
          providerId,
          modelId,
        });
        updateLiveConversation(configured);
      }
      setProjectWorkProviderConfig((current) => (
        rememberProjectWorkModelPreference(current, providerId, modelId)
      ));
    } catch (error) {
      showToast(error.message || "无法保存模型选择", "warning");
    } finally {
      projectWorkModelSelectionPendingRef.current = false;
      setProjectWorkModelSelectionSaving(false);
    }
  };

  const selectProjectWorkProvider = (providerId) => {
    const nextProvider = projectWorkProviders.find(
      (item) => item.id === providerId && item.available,
    );
    if (!nextProvider) return;
    const preference = normalizeProjectWorkModelPreference(projectWorkProviderConfig);
    const rememberedModel = preference.modelsByProvider[nextProvider.id];
    const nextModel = nextProvider.models.includes(rememberedModel)
      ? rememberedModel
      : nextProvider.models[0] ?? "";
    void persistProjectWorkModelSelection(nextProvider.id, nextModel);
  };

  const selectProjectWorkModel = (model) => {
    if (!selectedProjectWorkProvider?.models.includes(model)) return;
    void persistProjectWorkModelSelection(selectedProjectWorkProvider.id, model);
  };

  const openQuickSettings = () => {
    setProviderOpen(false);
    setSkillCenterOpen(false);
    setSettingsView((current) => current === "quick" ? null : "quick");
  };

  const openFullSettings = (section = "general") => {
    setProviderOpen(false);
    setSkillCenterOpen(false);
    setSettingsSection(section);
    setSettingsView("full");
  };

  const closeSettings = () => {
    setSettingsView(null);
    window.requestAnimationFrame(() => document.getElementById("settings-trigger")?.focus());
  };

  const openProviderFromSettings = () => {
    setSettingsView(null);
    setProviderOpen(true);
  };

  const exportRun = () => {
    const blob = new Blob([runToMarkdown(run)], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `Pi-Agent_${run.runId}.md`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast("本轮运行记录已导出");
  };

  const dispatchAction = (type, payload = {}) => dispatch({ type, ...payload });

  const focusCreatingWorkConversation = (projectId) => {
    const pendingSelection = { projectId };
    preparingConversationSelectionRef.current = pendingSelection;
    setPreparingConversationSelection(pendingSelection);
    if (projectId === null) {
      setCreatingStandaloneConversation(true);
    } else {
      setCreatingConversationProjectIds((current) => (
        current.includes(projectId) ? current : [...current, projectId]
      ));
    }
    projectWorkLoadRef.current += 1;
    const nextProjectId = projectId ?? "";
    selectedProjectIdRef.current = nextProjectId;
    setSelectedProjectId(nextProjectId);
    activeConversationIdRef.current = "";
    setActiveConversationId("");
    setLiveProjectWork((current) => ({
      ...current,
      status: "ready",
      conversation: null,
      error: null,
    }));
    setMobileView("agent");
  };

  const createWorkConversation = (projectId, {
    workspaceId = null,
    activate = false,
  } = {}) => {
    if (!projectId) return Promise.resolve(null);
    return projectConversationCreationLockRef.current.run(projectId, async () => {
      try {
        const created = await projectWorkApi.createConversation({
          projectId,
          workspaceId: workspaceId || undefined,
          providerId: preferredProjectWorkSelection.providerId || undefined,
          modelId: preferredProjectWorkSelection.modelId || undefined,
          executionPolicyMode: DEFAULT_PROJECT_WORK_EXECUTION_POLICY_MODE,
        });
        const projectStillSelected = selectedProjectIdRef.current === projectId;
        const shouldActivate = projectStillSelected && (
          activate
          || preparingConversationSelectionRef.current?.projectId === projectId
        );
        setLiveProjectWork((current) => insertCreatedConversation(current, created, {
          activate: shouldActivate,
          include: projectStillSelected,
        }));
        if (shouldActivate) {
          preparingConversationSelectionRef.current = null;
          setPreparingConversationSelection(null);
          activeConversationIdRef.current = created.id;
          setActiveConversationId(created.id);
          setMobileView("agent");
        }

        projectWorkApi.fetchConversation({
          conversationId: created.id,
        }).then((conversation) => {
          setLiveProjectWork((current) => hydrateCreatedConversation(current, conversation));
        }).catch((error) => {
          if (activeConversationIdRef.current === created.id) {
            showToast(error.message || "会话已创建，详情暂时无法载入", "warning");
          }
        });
        return created.id;
      } catch (error) {
        if (preparingConversationSelectionRef.current?.projectId === projectId) {
          preparingConversationSelectionRef.current = null;
          setPreparingConversationSelection(null);
        }
        setLiveProjectWork((current) => ({
          ...current,
          status: "ready",
          error,
        }));
        showToast(error.message || "无法新建工作会话", "warning");
        if (activate) throw error;
        return null;
      } finally {
        setCreatingConversationProjectIds((current) => (
          current.filter((id) => id !== projectId)
        ));
      }
    }, activate ? undefined : () => focusCreatingWorkConversation(projectId));
  };

  const createStandaloneConversation = () => (
    projectConversationCreationLockRef.current.run("standalone", async () => {
      try {
        const created = await projectWorkApi.createStandaloneConversation({
          providerId: preferredProjectWorkSelection.providerId || undefined,
          modelId: preferredProjectWorkSelection.modelId || undefined,
          executionPolicyMode: DEFAULT_PROJECT_WORK_EXECUTION_POLICY_MODE,
        });
        const shouldActivate = selectedProjectIdRef.current === ""
          && preparingConversationSelectionRef.current?.projectId === null;
        setLiveProjectWork((current) => insertCreatedConversation(current, created, {
          activate: shouldActivate,
          include: true,
        }));
        if (shouldActivate) {
          preparingConversationSelectionRef.current = null;
          setPreparingConversationSelection(null);
          activeConversationIdRef.current = created.id;
          setActiveConversationId(created.id);
        }

        projectWorkApi.fetchConversation({
          conversationId: created.id,
        }).then((conversation) => {
          setLiveProjectWork((current) => hydrateCreatedConversation(current, conversation));
        }).catch((error) => {
          if (activeConversationIdRef.current === created.id) {
            showToast(error.message || "会话已创建，详情暂时无法载入", "warning");
          }
        });
        return created.id;
      } catch (error) {
        if (preparingConversationSelectionRef.current?.projectId === null) {
          clearPreparingConversationSelection();
        }
        setLiveProjectWork((current) => ({
          ...current,
          status: "ready",
          error,
        }));
        showToast(error.message || "无法新建独立对话", "warning");
        return null;
      } finally {
        setCreatingStandaloneConversation(false);
      }
    }, () => focusCreatingWorkConversation(null))
  );

  const closeDeleteConversation = () => {
    deletePreflightRequestRef.current += 1;
    setConversationToDelete(null);
  };

  const requestDeleteWorkConversation = (conversation, {
    visibleConversationIds = [],
  } = {}) => {
    if (!conversation?.id) return;
    const requestId = deletePreflightRequestRef.current + 1;
    deletePreflightRequestRef.current = requestId;
    setConversationToDelete({
      ...conversation,
      visibleConversationIds,
      checking: true,
      checkError: "",
      deleteBlocked: false,
    });
    projectWorkApi.fetchConversation({
      conversationId: conversation.id,
    }).then((latestConversation) => {
      if (deletePreflightRequestRef.current !== requestId) return;
      setLiveProjectWork((current) => (
        hydrateCreatedConversation(current, latestConversation)
      ));
      setConversationToDelete((current) => (
        current?.id === latestConversation.id
          ? {
              ...current,
              title: latestConversation.title,
              status: latestConversation.status,
              pendingChangeFileCount: latestConversation.pendingChangeSet?.status === "ready"
                ? latestConversation.pendingChangeSet.files?.length ?? 0
                : 0,
              checking: false,
              checkError: "",
              deleteBlocked: isProjectWorkConversationBusy(latestConversation),
            }
          : current
      ));
    }).catch(() => {
      if (deletePreflightRequestRef.current !== requestId) return;
      setConversationToDelete((current) => (
        current?.id === conversation.id
          ? {
              ...current,
              checking: false,
              checkError: "无法核对会话状态，请取消后重试",
              deleteBlocked: true,
            }
          : current
      ));
    });
  };

  const deleteWorkConversation = async (targetConversation) => {
    if (!targetConversation?.id) return;
    if (
      targetConversation.checking
      || targetConversation.checkError
      || targetConversation.deleteBlocked
    ) {
      throw new Error(
        targetConversation.checkError || "请先停止当前运行，再删除会话",
      );
    }
    setDeletingConversationId(targetConversation.id);
    try {
      const deletingActive = activeConversationIdRef.current === targetConversation.id;
      const adjacentConversation = deletingActive
        ? adjacentConversationAfterRemoval(
            liveProjectWork.conversations,
            targetConversation.id,
            targetConversation.visibleConversationIds,
          )
        : null;
      const result = await projectWorkApi.deleteConversation({
        projectId: targetConversation.projectId,
        conversationId: targetConversation.id,
      });
      if (!result?.removed) {
        throw new Error("服务未确认删除，请稍后重试");
      }

      setLiveProjectWork((current) => removeLiveConversation(
        current,
        targetConversation.id,
        { conversationCount: result.conversationCount },
      ));

      if (!deletingActive) {
        showToast("工作会话已删除");
        return;
      }

      clearPreparingConversationSelection();
      if (adjacentConversation) {
        selectLiveConversation(adjacentConversation.id).then((loaded) => {
          if (!loaded) {
            showToast("会话已删除，相邻会话暂时无法载入", "warning");
          }
        });
        showToast("工作会话已删除");
        return;
      }

      projectWorkLoadRef.current += 1;
      activeConversationIdRef.current = "";
      setActiveConversationId("");
      setLiveProjectWork((current) => ({
        ...current,
        status: "ready",
        conversation: null,
        error: null,
      }));
      setMobileView("agent");
      showToast("工作会话已删除");
    } finally {
      setDeletingConversationId((current) => (
        current === targetConversation.id ? null : current
      ));
    }
  };

  const renameWorkConversation = async (targetConversation, title) => {
    if (!targetConversation?.id) return;
    const renamed = await projectWorkApi.renameConversation({
      projectId: targetConversation.projectId,
      conversationId: targetConversation.id,
      title,
    });
    if (!renamed?.id) throw new Error("服务未确认重命名，请稍后重试");
    setLiveProjectWork((current) => renameLiveConversation(current, renamed));
    showToast("会话名称已更新");
  };

  const selectWorkspaceMode = (nextKind) => {
    if (!["project_work", "worker", "paper_reading"].includes(nextKind) || nextKind === workspaceMode) {
      return;
    }
    clearPreparingConversationSelection();
    setWorkspaceMode(nextKind);
    setProjectQuery("");
    const savedSelection = workspaceSelection?.[nextKind];
    if (nextKind === "worker") {
      setReaderTarget(null);
      setMobileView("agent");
      return;
    }
    if (nextKind === "paper_reading") {
      const nextProject = allProjects.find(
        (item) => item.id === savedSelection?.projectId && item.workspaceKinds.includes(nextKind),
      ) ?? allProjects.find((item) => item.workspaceKinds.includes(nextKind));
      if (nextProject) setSelectedProjectId(nextProject.id);
      const savedPaperConversation = paperConversations.find(
        (conversation) => conversation.id === savedSelection?.conversationId
          && conversation.kind === "paper_reading"
          && conversation.projectId === nextProject?.id,
      );
      if (savedPaperConversation) {
        openPaperLibraryConversation(savedPaperConversation);
        return;
      }
      setReaderTarget(null);
      setActiveConversationId("workflow-run");
      setMobileView("run");
      return;
    }

    const savedStandalone = savedSelection?.projectId === ""
      ? liveProjectWork.conversations.find(
          (item) => item.projectId === null && item.id === savedSelection?.conversationId,
        )
      : null;
    if (savedStandalone) {
      selectLiveConversation(savedStandalone.id);
      return;
    }

    const nextProject = liveProjectWork.projects.find(
      (item) => item.id === savedSelection?.projectId,
    ) ?? liveProjectWork.projects[0];
    if (!nextProject) {
      setSelectedProjectId("");
      setActiveConversationId("");
      setMobileView("agent");
      return;
    }
    selectLiveProject(nextProject.id, savedSelection?.conversationId);
  };

  const addProject = async (nextProject) => {
    if (!nextProject?.id || !nextProject?.name || !nextProject?.rootLabel) return;
    if (workspaceMode === "project_work") {
      const projectRecord = {
        ...nextProject,
        conversationCount: nextProject.conversationCount ?? 0,
      };
      setLiveProjectWork((current) => upsertLiveProject(current, projectRecord));
      createWorkConversation(projectRecord.id).then((conversationId) => {
        if (conversationId) showToast("工作会话已准备好");
      });
      showToast("项目已绑定，正在创建工作会话");
      return;
    }
    const projectRecord = {
      ...nextProject,
      workspaceKinds: Array.from(new Set([
        ...(nextProject.workspaceKinds ?? []),
        workspaceMode,
      ])),
      seeded: false,
      updated: nextProject.updated ?? "刚刚",
    };
    setRegisteredProjects((current) => {
      const projects = Array.isArray(current) ? current : [];
      const existing = projects.find((item) => item.id === projectRecord.id);
      if (!existing) return [...projects, projectRecord];
      return projects.map((item) => item.id === projectRecord.id
        ? {
          ...item,
          ...projectRecord,
          workspaceKinds: Array.from(new Set([
            ...(item.workspaceKinds ?? []),
            workspaceMode,
          ])),
        }
        : item);
    });
    setSelectedProjectId(projectRecord.id);
    setActiveConversationId("workflow-run");
    setMobileView("run");
    showToast(`已添加到${workspaceMode === "paper_reading" ? "论文精读" : "正常工作"}`);
  };

  const removeProject = async (projectId) => {
    if (workspaceMode === "project_work") {
      const target = liveProjectWork.projects.find((item) => item.id === projectId);
      const confirmed = window.confirm(
        `解绑“${target?.name ?? "这个项目"}”会移除 Pi Agent 中的工作会话和快照，但不会删除本地文件。是否继续？`,
      );
      if (!confirmed) return;
      try {
        await projectWorkApi.removeProject({ projectId });
        const savedSelection = workspaceSelection?.project_work;
        await loadLiveProjectWork({
          preferredProjectId: savedSelection?.projectId === projectId
            ? undefined
            : savedSelection?.projectId,
          preferredConversationId: savedSelection?.projectId === projectId
            ? undefined
            : savedSelection?.conversationId,
        });
        showToast("已解绑项目；本地文件未删除");
      } catch (error) {
        showToast(error.message || "无法解绑项目", "warning");
      }
      return;
    }
    const targetProject = registeredProjectItems.find((item) => item.id === projectId);
    if (!targetProject) return;
    setRegisteredProjects((current) => (Array.isArray(current) ? current : [])
      .map((item) => item.id === projectId
        ? {
          ...item,
          workspaceKinds: item.workspaceKinds.filter((kind) => kind !== workspaceMode),
        }
        : item)
      .filter((item) => item.workspaceKinds.length > 0));
    const fallbackProject = BASE_PROJECTS.find(
      (item) => item.workspaceKinds.includes(workspaceMode),
    );
    if (fallbackProject) {
      setSelectedProjectId(fallbackProject.id);
      setActiveConversationId("workflow-run");
      setMobileView("run");
    }
    showToast("已从论文精读移除；本地文件未删除");
  };

  const artifactMode = readingMode || projectWorkMode || workerMode;
  const gridColumns = artifactMode
    ? `${sidebarOpen ? leftRailWidth : 0}px minmax(0, 1fr)`
    : `${sidebarOpen ? leftRailWidth : 0}px minmax(0, 1fr) ${contextRailOpen ? rightRailWidth : 0}px`;

  return (
    <div className="app-shell">
      <div
        className={`app-body${sidebarOpen ? "" : " no-sidebar"}${!artifactMode && !contextRailOpen ? " no-context" : ""}${artifactMode ? " is-artifact-mode" : ""}${isResizing ? " is-resizing-active" : ""}`}
        style={{ gridTemplateColumns: gridColumns }}
      >
        <ProjectRail
          projects={projectItems}
          workerRail={(
            <WorkerRail
              workers={workerController.definitions}
              tasks={workerController.tasks}
              connections={workerController.connections}
              activeWorkerId={workerController.activeWorkerId}
              activeTaskId={workerController.activeTaskId}
              query={projectQuery}
              onQueryChange={setProjectQuery}
              onSelectWorker={workerController.selectWorker}
              onSelectTask={workerController.selectTask}
              onNewTask={workerController.createTask}
              creatingTask={workerController.busyAction === "create_task"}
            />
          )}
          selectedId={selectedProjectId}
          onSelect={(projectId) => {
            if (workspaceMode === "worker") return;
            if (workspaceMode === "paper_reading") {
              setSelectedProjectId(projectId);
              setReaderTarget(null);
              setActiveConversationId("workflow-run");
              setMobileView("run");
              return;
            }
            if (projectId === selectedProjectId) return;
            if (creatingConversationProjectIds.includes(projectId)) {
              focusCreatingWorkConversation(projectId);
              return;
            }
            const savedConversationId = workspaceSelection?.project_work?.projectId === projectId
              ? workspaceSelection.project_work.conversationId
              : undefined;
            selectLiveProject(projectId, savedConversationId);
          }}
          conversations={visibleConversations}
          selectedConversationId={projectWorkMode
            ? activeConversationId || activeProjectWorkState?.id || null
            : readingMode
              ? paperConversationId
              : null}
          onSelectConversation={(conversationId) => {
            if (projectWorkMode) {
              if (conversationId !== activeProjectWorkState?.id) {
                selectLiveConversation(conversationId);
              }
              return;
            }
            const paperConversation = paperConversations.find(
              (conversation) => conversation.id === conversationId,
            );
            if (paperConversation) {
              openPaperLibraryConversation(paperConversation);
              return;
            }
            setActiveConversationId("workflow-run");
            setMobileView("run");
            showToast("请先从每月追踪选择一篇论文开始研读", "warning");
          }}
          creatingConversationProjectIds={creatingConversationProjectIds}
          preparingConversationProjectId={preparingConversationSelection?.projectId ?? null}
          creatingStandaloneConversation={creatingStandaloneConversation}
          preparingStandaloneConversation={
            preparingConversationSelection?.projectId === null
          }
          onNewStandaloneConversation={() => {
            createStandaloneConversation().then((conversationId) => {
              if (conversationId) showToast("独立对话已创建");
            });
          }}
          deletingConversationId={deletingConversationId}
          onNewConversation={(projectId) => {
            if (workspaceMode === "project_work") {
              createWorkConversation(projectId).then((conversationId) => {
                if (conversationId) showToast("正常工作会话已创建");
              });
              return;
            }
            setSelectedProjectId(projectId);
            setReaderTarget(null);
            setActiveConversationId("workflow-run");
            setMobileView("run");
            showToast(
              projectId === workflowFixture.project.id
                ? "请从每月追踪选择要精读的论文"
                : "该项目尚未设置论文追踪",
              "warning",
            );
          }}
          onRenameConversation={workspaceMode === "project_work"
            ? setConversationToRename
            : undefined}
          onDeleteConversation={workspaceMode === "project_work"
            ? requestDeleteWorkConversation
            : undefined}
          onResetPaperConversation={workspaceMode === "paper_reading"
            ? setPaperToReset
            : undefined}
          workspaceMode={workspaceMode}
          onWorkspaceModeChange={selectWorkspaceMode}
          query={projectQuery}
          onQueryChange={setProjectQuery}
          onAddProject={() => setBindProjectOpen(true)}
          onRemoveProject={removeProject}
          onOpenSettings={openQuickSettings}
          settingsOpen={Boolean(settingsView)}
          mobileActive={mobileView === "projects"}
          activeRun={workspaceMode === "paper_reading"
            && project.id === workflowFixture.project.id
            ? activeRun
            : null}
          selectedRunId={workspaceMode === "paper_reading"
            && workflowMode
            && project.id === workflowFixture.project.id
            ? activeRun.id
            : null}
          onSelectRun={() => {
            // 每月追踪固定落在候选页：清掉残留的论文阅读目标，避免旧工作流
            // 布局把论文渲染到中栏、把论文 Agent 挤到右栏（位置调换 bug）。
            closeJournalPaper();
          }}
          topicSearchActive={topicSearchMode}
          onSelectTopicSearch={workspaceMode === "paper_reading"
            && project.id === workflowFixture.project.id
            ? openTopicSearch
            : undefined}
          recentClassicsActive={journalLibraryView === "recent_classics"}
          onSelectRecentClassics={workspaceMode === "paper_reading"
            && project.id === workflowFixture.project.id
            ? openRecentClassics
            : undefined}
          pastRunsActive={journalLibraryView === "past_runs"}
          onSelectPastRuns={workspaceMode === "paper_reading"
            && project.id === workflowFixture.project.id
            ? openPastRuns
            : undefined}
          topicConversations={topicConversations}
          activeTopicConversationId={activeTopicConversationId}
          onSelectTopicConversation={selectTopicConversation}
          onCreateTopicConversation={createTopicConversation}
          onDeleteTopicConversation={setTopicConversationToDelete}
          providers={journalProviders}
          providerId={selectedProvider.id}
          model={selectedModel}
          providerOpen={providerOpen}
          onProviderOpenChange={(open) => {
            setProviderOpen(open);
            if (open) {
              setSettingsView(null);
              setSkillCenterOpen(false);
            }
          }}
          onProviderChange={selectProvider}
          onModelChange={selectModel}
          onOpenSkills={() => {
            setProviderOpen(false);
            setSettingsView(null);
            setSkillCenterOpen(true);
          }}
          installedSkillCount={installedSkillCount}
          sidebarOpen={sidebarOpen}
          onMouseDownResizer={startResizing("left")}
          isResizing={resizingSide === "left"}
        />

        <Suspense fallback={(
          <main className="workspace-module-loading" role="status">
            正在打开工作台…
          </main>
        )}>
        {workerMode ? (
          <WorkerWorkspace
            key={workerController.activeTaskId || "worker-empty"}
            state={workerController.state}
            dispatch={workerController.dispatch}
            loading={["idle", "loading", "loading_task"].includes(workerController.status)}
            error={workerController.error}
            projectOptions={workerProjectOptions}
            providers={projectWorkProviders}
            providerOpen={providerOpen}
            onProviderOpenChange={(open) => {
              setProviderOpen(open);
              if (open) {
                setSettingsView(null);
                setSkillCenterOpen(false);
              }
            }}
            onProviderChange={(providerId, modelId) => workerController.configureModel({
              providerId,
              modelId,
              thinkingLevel: workerController.state?.thinkingLevel,
            })}
            onModelChange={(modelId, providerId) => workerController.configureModel({
              providerId,
              modelId,
              thinkingLevel: workerController.state?.thinkingLevel,
            })}
            onProjectContextChange={workerController.updateProjectContext}
            onSendMessage={workerController.sendMessage}
            onUploadAttachment={workerController.uploadAttachment}
            onRemovePendingAttachment={workerController.removePendingAttachment}
            onUploadDeliveryAttachment={workerController.uploadDeliveryAttachment}
            onRemoveDeliveryAttachment={workerController.removeDeliveryAttachment}
            onReadSource={workerController.readSource}
            onUseSource={workerController.useSource}
            onDraftChange={workerController.invalidateDraftOnEdit}
            onSaveDraft={workerController.saveDraft}
            onProposeDelivery={workerController.proposeDelivery}
            onConfirmDelivery={workerController.confirmDelivery}
            onAbandonDelivery={workerController.abandonDelivery}
            onRetryDelivery={workerController.retryDelivery}
            onAbort={workerController.abort}
            onRetryLastTurn={workerController.retryLastTurn}
            onCompact={workerController.compact}
            onAnswerAskUser={workerController.answerAskUser}
            onCancelAskUser={workerController.cancelAskUser}
            onCheckConnection={workerController.checkConnection}
            busyAction={workerController.busyAction}
            sidebarOpen={sidebarOpen}
            onToggleSidebar={() => setSidebarOpen((prev) => !prev)}
            mobileActive={mobileView === "agent" || mobileView === "artifact"}
            mobileView={mobileView}
          />
        ) : projectWorkMode ? (
          <LiveProjectWorkbench
            key={activeProjectWorkState?.id || project.id || "standalone-empty-workbench"}
            project={
              selectedProjectId === ""
                || activeProjectWorkState?.projectId === null
                || preparingConversationSelection?.projectId === null
                ? null
                : project
            }
            conversation={activeProjectWorkState}
            preparingConversation={
              preparingConversationSelection?.projectId === null
                || preparingConversationSelection?.projectId === project.id
            }
            providers={projectWorkProviders}
            providerId={selectedProjectWorkProvider?.id}
            modelId={selectedProjectWorkModel}
            modelContextWindow={selectedProjectWorkModelInfo?.contextWindow ?? null}
            providerOpen={providerOpen}
            onProviderOpenChange={(open) => {
              setProviderOpen(open);
              if (open) {
                setSettingsView(null);
                setSkillCenterOpen(false);
              }
            }}
            onProviderChange={selectProjectWorkProvider}
            onModelChange={selectProjectWorkModel}
            modelSelectionDisabled={projectWorkModelSelectionSaving}
            onOpenSkills={() => {
              setProviderOpen(false);
              setSettingsView(null);
              setSkillCenterOpen(true);
            }}
            installedSkillCount={installedSkillCount}
            sidebarOpen={sidebarOpen}
            onToggleSidebar={() => setSidebarOpen((prev) => !prev)}
            mobileActive={mobileView === "agent" || mobileView === "artifact"}
            mobileView={mobileView}
            onMobileViewChange={setMobileView}
            onConversationChange={updateLiveConversation}
            onConversationForked={activateForkedProjectConversation}
            onCreateConversationInWorkspace={({ projectId, workspaceId }) => (
              createWorkConversation(projectId, {
                workspaceId,
                activate: true,
              })
            )}
            onError={handleProjectWorkError}
          />
        ) : readingMode ? (
          <ReadingWorkbench
            readerTarget={readerTarget}
            readerPaper={readerPaper}
            activeReadingConversationId={readerTarget?.activeReadingConversationId ?? null}
            readerGuide={readerGuide}
            readerPeerPapers={readerPeerPapers}
            readerContext={readerContext}
            readerSelectionState={readerSelectionState}
            providers={journalProviders}
            providerId={selectedProvider?.id}
            modelId={selectedModel}
            readingProviderId={selectedProvider?.id}
            readingModelId={selectedModel}
            readingThinkingLevel={journalSupportsThinking ? activeJournalThinkingLevel : null}
            thinkingLevels={journalThinkingLevels}
            thinkingLevel={activeJournalThinkingLevel}
            supportsThinking={journalSupportsThinking}
            onThinkingLevelChange={selectJournalThinkingLevel}
            projectContextState={projectContextState}
            onReloadProjectContext={loadProjectContext}
            onSwitchPaper={(paperId) => openJournalPaperFromRun(
              readerRun,
              paperId,
              readerTarget?.purpose === "close-reading"
                ? readerRun?.readings?.papers?.[paperId]?.position?.blockId ?? null
                : null,
              readerTarget?.purpose ?? "document",
              readerRun?.readings?.papers?.[paperId]?.activeConversationId ?? null,
            )}
            onGuideDecision={readerTarget?.runId === journalRunState.run?.id
              ? (choice) => chooseGuideAction(readerPaper.id, choice)
              : undefined}
            guideDecision={readerTarget?.runId === journalRunState.run?.id
              ? run.guideChoices?.[readerPaper.id] ?? null
              : "read"}
            onReaderSelectionChange={updateReaderSelection}
            onReaderContextChange={setReaderContext}
            onReaderReadingChange={publishReaderReading}
            onReadingChange={refreshReadingRun}
            onOpenReaderBlock={openReaderBlock}
            onClose={closeJournalPaper}
            sidebarOpen={sidebarOpen}
            onToggleSidebar={() => setSidebarOpen((prev) => !prev)}
            onOpenSkills={() => {
              setProviderOpen(false);
              setSettingsView(null);
              setSkillCenterOpen(true);
            }}
            installedSkillCount={installedSkillCount}
            providerOpen={providerOpen}
            onProviderOpenChange={(open) => {
              setProviderOpen(open);
              if (open) {
                setSettingsView(null);
                setSkillCenterOpen(false);
              }
            }}
            onProviderChange={selectProvider}
            onModelChange={selectModel}
            onRestartFromGuide={
              readerTarget?.purpose === "close-reading"
              && readerRun
                ? () => restartCurrentReadingFromGuide(readerTarget.runId)
                : undefined
            }
            mobileActive={mobileView === "run" || mobileView === "evidence"}
            mobileView={mobileView}
          />
        ) : journalLibraryView ? (
          <JournalLibraryWorkspace
            view={journalLibraryView}
            recentClassics={recentClassicsSource?.data ?? null}
            canAddToWeekly={journalLibraryView === "past_runs"
              ? currentMonthReviewable
              : recentClassicsCanAdd}
            onAddRecentClassics={(paperIds) => addRecentClassicPapers(recentClassicsSource?.runId ?? null, paperIds)}
            onDismissRecentClassic={(paper) => dismissRecentClassicPaper(recentClassicsSource?.runId ?? null, paper)}
            onAddPastPaper={addPastRunPaper}
            onTranslateLibrary={translateLibrary}
            recentClassicsRunId={recentClassicsSource?.runId ?? null}
            pastRuns={journalPastRuns}
            weeklyCandidateIds={journalRunState.run?.candidates?.map((paper) => paper.id) ?? []}
            sidebarOpen={sidebarOpen}
            onToggleSidebar={() => setSidebarOpen((prev) => !prev)}
          />
        ) : topicSearchMode ? (
          <TopicSearchWorkspace
            conversationState={topicSearchState}
            onSubmitQuestion={submitTopicSearchQuestion}
            onAddToWeekly={addTopicSearchPapers}
            onNewConversation={createTopicConversation}
            submitting={topicSearchSubmitting}
            progress={topicSearchProgress}
            submitError={topicSearchSubmitError}
            addingTurnId={topicSearchAddingTurnId}
            addErrors={topicSearchAddErrors}
            sidebarOpen={sidebarOpen}
            onToggleSidebar={() => setSidebarOpen((prev) => !prev)}
            providers={journalProviders}
            providerId={selectedProvider?.id}
            model={selectedModel}
            providerOpen={providerOpen}
            onProviderOpenChange={(open) => {
              setProviderOpen(open);
              if (open) {
                setSettingsView(null);
                setSkillCenterOpen(false);
              }
            }}
            onProviderChange={selectProvider}
            onModelChange={selectModel}
            thinkingLevels={journalThinkingLevels}
            thinkingLevel={activeJournalThinkingLevel}
            supportsThinking={journalSupportsThinking}
            onThinkingLevelChange={selectJournalThinkingLevel}
            mobileActive={mobileView === "run"}
          />
        ) : (
          <>
        <WorkflowWorkspace
          run={run}
          papers={workflowPapers}
          candidateSummaryState={candidateSummaryState}
          onGenerateCandidateSummaries={generateCandidateSummaries}
          journalRunState={journalRunState}
          readerTarget={readerTarget}
          onOpenPaper={openJournalPaper}
          onOpenCloseReading={(paperId) => openJournalPaper(
            paperId,
            journalRunState.run?.readings?.papers?.[paperId]?.position?.blockId ?? null,
            "close-reading",
          )}
          onCloseReader={closeJournalPaper}
          onReaderSelectionChange={updateReaderSelection}
          onReaderContextChange={setReaderContext}
          onReadingChange={refreshReadingRun}
          onStartJournalRun={startWeeklyJournalScan}
          onRestoreJournalRuns={restoreJournalRuns}
          onResumeJournalRun={resumeCurrentJournalRun}
          onRetryPaperDocument={retryPaperDocument}
          onRefreshCandidates={refreshCandidates}
          onRestartFromGuide={restartCurrentReadingFromGuide}
          guideState={guideState}
          onTogglePaper={(paperId) => dispatchAction(RUN_ACTIONS.TOGGLE_PAPER, { paperId })}
          onPrepareGuides={prepareGuides}
          onSkipRun={() => dispatchAction(RUN_ACTIONS.SKIP_RUN)}
          onSetActivePaper={(paperId) => dispatchAction(RUN_ACTIONS.SET_ACTIVE_PAPER, { paperId })}
          onChooseGuideAction={chooseGuideAction}
          onPreviousStage={() => dispatchAction(RUN_ACTIONS.PREVIOUS_READING_STAGE)}
          onNextStage={() => dispatchAction(RUN_ACTIONS.NEXT_READING_STAGE)}
          onAddQuestion={(text, paperId) => dispatchAction(RUN_ACTIONS.ADD_QUESTION, { text, paperId })}
          zoteroUiState={zoteroUiState}
          obsidianUiState={obsidianUiState}
          projectStateUiState={projectStateUiState}
          onToggleObsidianProposal={(proposalId) => {
            setObsidianUiState((current) => ({
              ...current,
              preview: current.preview
                ? {
                    ...current.preview,
                    proposals: current.preview.proposals.map((proposal) => (
                      (proposal.proposalId ?? proposal.id) === proposalId
                        ? { ...proposal, selected: !proposal.selected }
                        : proposal
                    )),
                  }
                : current.preview,
            }));
          }}
          onToggleProjectStateProposal={() => {
            setProjectStateUiState((current) => {
              if (!current.preview) return current;
              const proposal = current.preview.proposal
                ?? current.preview.proposals?.[0]
                ?? null;
              if (!proposal) return current;
              const nextProposal = {
                ...proposal,
                selected: !proposal.selected,
              };
              return {
                ...current,
                preview: {
                  ...current.preview,
                  proposal: nextProposal,
                  proposals: [nextProposal],
                },
              };
            });
          }}
          onSelectZoteroTarget={(targetId) => setZoteroUiState((current) => ({
            ...current,
            selectedTargetId: targetId,
            error: null,
          }))}
          onRetryZoteroTargets={() => loadZoteroTargets(run.runId, run.zoteroTarget?.id)}
          onGeneratePreview={generateWritePreview}
          onToggleProposal={(proposalId) => dispatchAction(RUN_ACTIONS.TOGGLE_PROPOSAL, { proposalId })}
          onCommit={commitWritePreview}
          onRetryFailed={() => commitWritePreview({ retry: true })}
          onReset={() => {
            dispatchAction(RUN_ACTIONS.RESET);
            showToast("已重置为本月待审阅状态");
          }}
          mobileActive={mobileView === "run"}
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen((prev) => !prev)}
          contextRailOpen={contextRailOpen}
          onToggleContextRail={() => setContextRailOpen((prev) => !prev)}
          providers={journalProviders}
          providerId={selectedProvider.id}
          model={selectedModel}
          providerOpen={providerOpen}
          onProviderOpenChange={(open) => {
            setProviderOpen(open);
            if (open) {
              setSettingsView(null);
              setSkillCenterOpen(false);
            }
          }}
          onProviderChange={selectProvider}
          onModelChange={selectModel}
          thinkingLevels={journalThinkingLevels}
          thinkingLevel={activeJournalThinkingLevel}
          supportsThinking={journalSupportsThinking}
          onThinkingLevelChange={selectJournalThinkingLevel}
          onOpenSkills={() => {
            setProviderOpen(false);
            setSettingsView(null);
            setSkillCenterOpen(true);
          }}
          installedSkillCount={installedSkillCount}
          readingProviderId={selectedProvider?.id}
          readingModelId={selectedModel}
        />

        <WorkflowContextRail
          run={run}
          liveRun={journalRunState.run}
          papers={workflowPapers}
          preferredPaperId={readerTarget?.paperId}
          mobileActive={mobileView === "evidence"}
          readerContext={readerContext}
          readerSelectionState={readerSelectionState}
          activeView={contextRailView}
          onActiveViewChange={setContextRailView}
          providers={journalProviders}
          providerId={selectedProvider?.id}
          modelId={selectedModel}
          thinkingLevel={journalSupportsThinking ? activeJournalThinkingLevel : null}
          projectContextState={projectContextState}
          onReloadProjectContext={loadProjectContext}
          onOpenReaderBlock={openReaderBlock}
          onReaderReadingChange={publishReaderReading}
          onReaderSelectionChange={updateReaderSelection}
          contextRailOpen={contextRailOpen}
          onToggleContextRail={() => setContextRailOpen((prev) => !prev)}
          onMouseDownResizer={startResizing("right")}
          isResizing={resizingSide === "right"}
        />
          </>
        )}
        </Suspense>
      </div>

      <nav className="mobile-nav" aria-label="移动端主导航">
        <button className={mobileView === "projects" ? "is-active" : ""} type="button" onClick={() => setMobileView("projects")}>
          <FolderSimple size={19} weight={mobileView === "projects" ? "fill" : "regular"} aria-hidden="true" />
          {workerMode ? "Worker" : "项目"}
        </button>
        {projectWorkMode || workerMode ? (
          <>
            <button className={mobileView === "agent" ? "is-active" : ""} type="button" onClick={() => setMobileView("agent")}>
              <ChatText size={19} weight={mobileView === "agent" ? "fill" : "regular"} aria-hidden="true" />
              Agent
            </button>
            <button className={mobileView === "artifact" ? "is-active" : ""} type="button" onClick={() => setMobileView("artifact")}>
              <Files size={19} weight={mobileView === "artifact" ? "fill" : "regular"} aria-hidden="true" />
              工件
            </button>
          </>
        ) : (
          <>
            <button className={mobileView === "run" ? "is-active" : ""} type="button" onClick={() => setMobileView("run")}>
              <PlayCircle size={19} weight={mobileView === "run" ? "fill" : "regular"} aria-hidden="true" />
              本轮
            </button>
            <button className={mobileView === "evidence" ? "is-active" : ""} type="button" onClick={() => setMobileView("evidence")}>
              <ListChecks size={19} weight={mobileView === "evidence" ? "fill" : "regular"} aria-hidden="true" />
              {readerTarget?.purpose === "close-reading" ? "Agent" : "依据"}
            </button>
          </>
        )}
        <button type="button" onClick={() => {
          setProviderOpen(false);
          setSettingsView(null);
          setSkillCenterOpen(true);
        }}>
          <Package size={19} weight="regular" aria-hidden="true" />
          技能
        </button>
      </nav>

      <BindProjectDialog
        open={bindProjectOpen}
        workspaceMode={workspaceMode}
        onClose={() => setBindProjectOpen(false)}
        onBind={addProject}
      />

      <DeleteConversationDialog
        conversation={conversationToDelete}
        onClose={closeDeleteConversation}
        onConfirm={deleteWorkConversation}
      />

      <ResetPaperReadingDialog
        paperConversation={paperToReset}
        onClose={() => setPaperToReset(null)}
        onConfirm={confirmResetPaperReading}
      />

      <DeleteTopicConversationDialog
        topicConversation={topicConversationToDelete}
        onClose={() => setTopicConversationToDelete(null)}
        onConfirm={(conversation) => deleteTopicConversation(conversation.id)}
      />

      <RenameConversationDialog
        conversation={conversationToRename}
        onClose={() => setConversationToRename(null)}
        onConfirm={renameWorkConversation}
      />

      {skillCenterOpen ? (
        <SkillCenter
          builtinCatalog={skillCatalog}
          onStateChange={handleSkillStateChange}
          onClose={() => setSkillCenterOpen(false)}
        />
      ) : null}

      {settingsView === "quick" ? (
        <SettingsQuickPanel
          providerName={projectWorkMode
            || workerMode
            ? selectedProjectWorkProvider?.name ?? "Pi 本机模型"
            : selectedProvider.name}
          model={getModelDisplayName(
            projectWorkMode || workerMode ? selectedProjectWorkModel : selectedModel,
          )}
          onOpenFull={openFullSettings}
          onClose={closeSettings}
        />
      ) : null}

      {settingsView === "full" ? (
        <SettingsDialog
          section={settingsSection}
          onSectionChange={setSettingsSection}
          providerName={projectWorkMode
            || workerMode
            ? selectedProjectWorkProvider?.name ?? "Pi 本机模型"
            : selectedProvider.name}
          model={getModelDisplayName(
            projectWorkMode || workerMode ? selectedProjectWorkModel : selectedModel,
          )}
          onOpenProvider={openProviderFromSettings}
          onConnectionsChanged={refreshProjectWorkModels}
          onOpenSkills={() => {
            setSettingsView(null);
            setSkillCenterOpen(true);
          }}
          installedSkillCount={installedSkillCount}
          onClose={closeSettings}
        />
      ) : null}

      {toast ? <div className={`toast is-${toast.tone}`} role="status">{toast.message}</div> : null}
    </div>
  );
}
