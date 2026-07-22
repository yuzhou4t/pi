import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FolderSimple,
  ListChecks,
  Package,
  PlayCircle,
} from "@phosphor-icons/react";
import { ProjectRail } from "./components/ProjectRail.jsx";
import { SettingsDialog, SettingsQuickPanel } from "./components/SettingsPanel.jsx";
import { SkillCenter } from "./components/SkillCenter.jsx";
import { TopBar } from "./components/TopBar.jsx";
import { WorkflowContextRail } from "./components/WorkflowContextRail.jsx";
import { WorkflowWorkspace } from "./components/WorkflowWorkspace.jsx";
import { providers, skillCatalog } from "./data.js";
import { usePersistentReducer } from "./hooks/usePersistentReducer.js";
import { usePersistentState } from "./hooks/usePersistentState.js";
import { workflowFixture } from "./workflow/fixtures.js";
import {
  createInitialRunState,
  RUN_ACTIONS,
  RUN_STATUS,
  runReducer,
} from "./workflow/runReducer.js";

const runStatusLabels = {
  [RUN_STATUS.REVIEW_READY]: "本周待审阅",
  [RUN_STATUS.PREPARING_GUIDES]: "正在准备导读",
  [RUN_STATUS.GUIDE_READY]: "导读待决定",
  [RUN_STATUS.READING]: "分阶段精读",
  [RUN_STATUS.AWAITING_APPROVAL]: "等待写入确认",
  [RUN_STATUS.COMMITTING]: "正在模拟写入",
  [RUN_STATUS.PARTIAL]: "部分写入失败",
  [RUN_STATUS.COMPLETED]: "本轮已完成",
  [RUN_STATUS.COMPLETED_NO_WRITE]: "本轮无写入",
};

const projects = [
  {
    id: workflowFixture.project.id,
    name: workflowFixture.project.name,
    state: "期刊追踪与精读 · 演示",
    updated: "本周",
  },
];

function createInitialSkillState() {
  return Object.fromEntries(
    skillCatalog.map((skill) => [
      skill.id,
      { installed: skill.defaultInstalled, enabled: skill.defaultEnabled },
    ]),
  );
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
    "> 数据说明：交互演示数据，未扫描网络，也未写入真实 Zotero、Obsidian 或项目文件。",
    "",
    "## 本轮所选论文",
    "",
  ];

  if (selectedPapers.length === 0) lines.push("- 未选择论文");
  selectedPapers.forEach((paper) => {
    lines.push(`- **${paper.titleZh}**（${paper.title}）`);
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
  const [contextRailOpen, setContextRailOpen] = useState(true);
  const [rightRailWidth, setRightRailWidth] = useState(360);
  const [isResizing, setIsResizing] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState(projects[0].id);
  const [projectQuery, setProjectQuery] = useState("");

  const startResizing = useCallback((e) => {
    e.preventDefault();
    setIsResizing(true);
    const startX = e.clientX;
    const startWidth = rightRailWidth;

    const onMouseMove = (moveEvent) => {
      const deltaX = startX - moveEvent.clientX;
      const nextWidth = Math.min(580, Math.max(220, startWidth + deltaX));
      setRightRailWidth(nextWidth);
    };

    const onMouseUp = () => {
      setIsResizing(false);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, [rightRailWidth]);
  const [providerConfig, setProviderConfig] = usePersistentState("pi-agent-provider-v2", {
    providerId: "baseline",
    model: "强模型（演示）",
  });
  const [providerOpen, setProviderOpen] = useState(false);
  const [skillState, setSkillState] = usePersistentState("pi-agent-skills-v2", createInitialSkillState());
  const [skillCenterOpen, setSkillCenterOpen] = useState(false);
  const [installingSkillId, setInstallingSkillId] = useState(null);
  const [settingsView, setSettingsView] = useState(null);
  const [settingsSection, setSettingsSection] = useState("general");
  const [mobileView, setMobileView] = useState("run");
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  const [run, dispatch] = usePersistentReducer(runReducer, createInitialRunState);

  const project = projects.find((item) => item.id === selectedProjectId) ?? projects[0];
  const selectedProvider = providers.find((item) => item.id === providerConfig.providerId) ?? providers[0];
  const installedSkillCount = useMemo(
    () => skillCatalog.filter((skill) => skillState[skill.id]?.installed).length,
    [skillState],
  );
  const activeRun = useMemo(() => ({
    id: run.runId,
    name: workflowFixture.workflowName,
    statusLabel: runStatusLabels[run.status] ?? run.status,
  }), [run.runId, run.status]);

  const showToast = useCallback((message, tone = "success") => {
    window.clearTimeout(toastTimer.current);
    setToast({ message, tone });
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  useEffect(() => {
    if (run.status === RUN_STATUS.PREPARING_GUIDES) {
      const timer = window.setTimeout(() => dispatch({ type: RUN_ACTIONS.GUIDES_READY }), 850);
      return () => window.clearTimeout(timer);
    }
    if (run.status === RUN_STATUS.COMMITTING) {
      const action = run.isRetrying ? RUN_ACTIONS.RETRY_RESULT : RUN_ACTIONS.COMMIT_RESULT;
      const timer = window.setTimeout(() => dispatch({ type: action }), 900);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [run.status, run.isRetrying]);

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
    const nextProvider = providers.find((item) => item.id === providerId) ?? providers[0];
    setProviderConfig({ providerId: nextProvider.id, model: nextProvider.models[0] });
    showToast(`已切换到 ${nextProvider.name}（演示配置）`);
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

  const installSkill = (skillId) => {
    setInstallingSkillId(skillId);
    window.setTimeout(() => {
      setSkillState((current) => ({
        ...current,
        [skillId]: { installed: true, enabled: true },
      }));
      setInstallingSkillId(null);
      showToast("能力包已在本地演示中启用");
    }, 700);
  };

  const toggleSkill = (skillId) => {
    setSkillState((current) => ({
      ...current,
      [skillId]: { ...current[skillId], enabled: !current[skillId]?.enabled },
    }));
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
    showToast("本轮演示记录已导出为 Markdown");
  };

  const dispatchAction = (type, payload = {}) => dispatch({ type, ...payload });

  const gridColumns = `${sidebarOpen ? 240 : 0}px minmax(0, 1fr) ${contextRailOpen ? rightRailWidth : 0}px`;

  return (
    <div className="app-shell">
      <div
        className={`app-body${sidebarOpen ? "" : " no-sidebar"}${contextRailOpen ? "" : " no-context"}${isResizing ? " is-resizing-active" : ""}`}
        style={{ gridTemplateColumns: gridColumns }}
      >
        <ProjectRail
          projects={projects}
          selectedId={project.id}
          onSelect={(projectId) => {
            setSelectedProjectId(projectId);
            setMobileView("run");
          }}
          query={projectQuery}
          onQueryChange={setProjectQuery}
          onAddProject={() => showToast("正式版将在这里绑定本地项目；当前原型不会读取真实文件", "warning")}
          onOpenSettings={openQuickSettings}
          settingsOpen={Boolean(settingsView)}
          mobileActive={mobileView === "projects"}
          activeRun={activeRun}
          onSelectRun={() => setMobileView("run")}
          providers={providers}
          providerId={selectedProvider.id}
          model={providerConfig.model}
          providerOpen={providerOpen}
          onProviderOpenChange={(open) => {
            setProviderOpen(open);
            if (open) {
              setSettingsView(null);
              setSkillCenterOpen(false);
            }
          }}
          onProviderChange={selectProvider}
          onModelChange={(model) => setProviderConfig((current) => ({ ...current, model }))}
          onOpenSkills={() => {
            setProviderOpen(false);
            setSettingsView(null);
            setSkillCenterOpen(true);
          }}
          installedSkillCount={installedSkillCount}
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen((prev) => !prev)}
        />

        <WorkflowWorkspace
          run={run}
          onTogglePaper={(paperId) => dispatchAction(RUN_ACTIONS.TOGGLE_PAPER, { paperId })}
          onPrepareGuides={() => dispatchAction(RUN_ACTIONS.PREPARE_GUIDES)}
          onSkipRun={() => dispatchAction(RUN_ACTIONS.SKIP_RUN)}
          onSetActivePaper={(paperId) => dispatchAction(RUN_ACTIONS.SET_ACTIVE_PAPER, { paperId })}
          onChooseGuideAction={(paperId, choice) => dispatchAction(RUN_ACTIONS.CHOOSE_GUIDE_ACTION, { paperId, choice })}
          onPreviousStage={() => dispatchAction(RUN_ACTIONS.PREVIOUS_READING_STAGE)}
          onNextStage={() => dispatchAction(RUN_ACTIONS.NEXT_READING_STAGE)}
          onAddQuestion={(text, paperId) => dispatchAction(RUN_ACTIONS.ADD_QUESTION, { text, paperId })}
          onGeneratePreview={() => dispatchAction(RUN_ACTIONS.GENERATE_PREVIEW)}
          onToggleProposal={(proposalId) => dispatchAction(RUN_ACTIONS.TOGGLE_PROPOSAL, { proposalId })}
          onCommit={({ simulateObsidianFailure }) => dispatchAction(RUN_ACTIONS.COMMIT, { simulateObsidianFailure })}
          onRetryFailed={() => dispatchAction(RUN_ACTIONS.RETRY_FAILED)}
          onReset={() => {
            dispatchAction(RUN_ACTIONS.RESET);
            showToast("已重置为本周待审阅状态");
          }}
          mobileActive={mobileView === "run"}
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen((prev) => !prev)}
          contextRailOpen={contextRailOpen}
          onToggleContextRail={() => setContextRailOpen((prev) => !prev)}
        />

        <WorkflowContextRail
          run={run}
          mobileActive={mobileView === "evidence"}
          contextRailOpen={contextRailOpen}
          onToggleContextRail={() => setContextRailOpen((prev) => !prev)}
          onMouseDownResizer={startResizing}
          isResizing={isResizing}
        />
      </div>

      <nav className="mobile-nav" aria-label="移动端主导航">
        <button className={mobileView === "projects" ? "is-active" : ""} type="button" onClick={() => setMobileView("projects")}>
          <FolderSimple size={19} weight={mobileView === "projects" ? "fill" : "regular"} aria-hidden="true" />
          项目
        </button>
        <button className={mobileView === "run" ? "is-active" : ""} type="button" onClick={() => setMobileView("run")}>
          <PlayCircle size={19} weight={mobileView === "run" ? "fill" : "regular"} aria-hidden="true" />
          本轮
        </button>
        <button className={mobileView === "evidence" ? "is-active" : ""} type="button" onClick={() => setMobileView("evidence")}>
          <ListChecks size={19} weight={mobileView === "evidence" ? "fill" : "regular"} aria-hidden="true" />
          依据
        </button>
        <button type="button" onClick={() => {
          setProviderOpen(false);
          setSettingsView(null);
          setSkillCenterOpen(true);
        }}>
          <Package size={19} weight="regular" aria-hidden="true" />
          技能
        </button>
      </nav>

      {skillCenterOpen ? (
        <SkillCenter
          catalog={skillCatalog}
          skillState={skillState}
          installingId={installingSkillId}
          onInstall={installSkill}
          onToggle={toggleSkill}
          onClose={() => setSkillCenterOpen(false)}
        />
      ) : null}

      {settingsView === "quick" ? (
        <SettingsQuickPanel
          providerName={selectedProvider.name}
          model={providerConfig.model}
          onOpenFull={openFullSettings}
          onClose={closeSettings}
        />
      ) : null}

      {settingsView === "full" ? (
        <SettingsDialog
          section={settingsSection}
          onSectionChange={setSettingsSection}
          providerName={selectedProvider.name}
          model={providerConfig.model}
          onOpenProvider={openProviderFromSettings}
          onClose={closeSettings}
        />
      ) : null}

      {toast ? <div className={`toast is-${toast.tone}`} role="status">{toast.message}</div> : null}
    </div>
  );
}
