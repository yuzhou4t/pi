import { useCallback, useState } from "react";
import { ArrowCounterClockwise, BookOpenText, Package, SidebarSimple } from "@phosphor-icons/react";
import { AgentArtifactLayout } from "./AgentArtifactLayout.jsx";
import { usePersistentState } from "../hooks/usePersistentState.js";
import { PaperReader } from "./PaperReader.jsx";
import { ProviderMenu } from "./ProviderMenu.jsx";
import {
  ProjectStateSection,
  ReaderAgentComposer,
  ReadingNotesPanel,
} from "./WorkflowContextRail.jsx";
import { RestartReadingDialog } from "./WorkflowWorkspace.jsx";
import { workflowFixture } from "../workflow/fixtures.js";

const ARTIFACT_TABS = [
  { id: "doc", label: "原文" },
  { id: "notes", label: "研读笔记" },
  { id: "state", label: "项目" },
];

const NOOP = () => {};

export function ReadingWorkbench({
  readerTarget,
  readerPaper,
  readerGuide = null,
  readerPeerPapers = [],
  readerContext = null,
  readerSelectionState = null,
  providers = [],
  providerId = null,
  modelId = null,
  readingProviderId = null,
  readingModelId = null,
  projectContextState = null,
  onReloadProjectContext,
  onSwitchPaper,
  onGuideDecision,
  guideDecision = null,
  guideDecisionBusy = false,
  onReaderSelectionChange = NOOP,
  onReaderContextChange = NOOP,
  onReaderReadingChange = NOOP,
  onReadingChange = NOOP,
  onOpenReaderBlock = NOOP,
  onClose,
  sidebarOpen = true,
  onToggleSidebar,
  onOpenSkills,
  installedSkillCount = 0,
  providerOpen = false,
  onProviderOpenChange,
  onProviderChange,
  onModelChange,
  onRestartFromGuide,
  mobileActive = false,
  mobileView = "run",
}) {
  const [artifactTab, setArtifactTab] = useState("doc");
  // Close reading starts split: paper on the right, Agent on the left (~50/50).
  const [artifactOpen, setArtifactOpen] = usePersistentState("pi-reading-artifact-open", true);
  const [restart, setRestart] = useState({ open: false, pending: false, error: null });

  const confirmRestart = useCallback(async () => {
    if (!onRestartFromGuide || restart.pending) return;
    setRestart((current) => ({ ...current, pending: true, error: null }));
    try {
      await onRestartFromGuide();
      setRestart({ open: false, pending: false, error: null });
    } catch (error) {
      setRestart({ open: true, pending: false, error: error?.message ?? "暂时无法返回本周推荐文章" });
    }
  }, [onRestartFromGuide, restart.pending]);

  const readerReady = readerContext?.purpose === "close-reading"
    && readerContext?.status === "ready"
    && Boolean(readerContext.document);
  const selectionState = readerSelectionState ?? { reference: null, error: null };

  const openCitation = useCallback((blockId) => {
    if (!blockId) return;
    setArtifactTab("doc");
    setArtifactOpen(true);
    onOpenReaderBlock(blockId);
  }, [onOpenReaderBlock]);

  return (
    <AgentArtifactLayout
      aria-label="论文研读工作台"
      mobileActive={mobileActive}
      mobileView={mobileView}
      agentMobileView="evidence"
      artifactOpen={artifactOpen}
      onArtifactOpenChange={setArtifactOpen}
      closedLabel="打开原文"
      openLabel="收起原文"
      closedTitle="打开右侧论文工件"
      openTitle="收起右侧论文工件"
      resizeLabel="拖拽调整对话与原文的宽度"
      title={(
        <div className="workflow-title-block">
          <button
            className={`column-toggle-btn${!sidebarOpen ? " is-collapsed" : ""}`}
            type="button"
            aria-label={sidebarOpen ? "收起左边栏" : "展开左边栏"}
            title={sidebarOpen ? "收起左边栏" : "展开左边栏"}
            onClick={onToggleSidebar}
          >
            <SidebarSimple size={18} weight="regular" />
          </button>
          <div>
            <span className="workflow-kicker">{workflowFixture.project?.name ?? "Agent 工作流研究"}</span>
            <h1>论文研读</h1>
          </div>
        </div>
      )}
      headerActions={(
        <>
          {providers?.length ? (
            <ProviderMenu
              open={providerOpen}
              onOpenChange={onProviderOpenChange}
              providers={providers}
              providerId={providerId}
              model={modelId}
              onProviderChange={onProviderChange}
              onModelChange={onModelChange}
            />
          ) : null}
          {onRestartFromGuide ? (
            <button
              className="header-meta-pill reading-restart-pill"
              type="button"
              onClick={() => setRestart({ open: true, pending: false, error: null })}
              title="返回本周推荐文章，重新选择要研读的论文"
            >
              <ArrowCounterClockwise size={13} weight="regular" aria-hidden="true" />
              <span>返回本周文章</span>
            </button>
          ) : null}
          {onOpenSkills ? (
            <button className="header-meta-pill header-skill-pill" type="button" onClick={onOpenSkills}>
              <Package size={13} weight="regular" aria-hidden="true" />
              <span>技能 · {installedSkillCount}</span>
            </button>
          ) : null}
        </>
      )}
      agent={(
        <>
          {readerReady ? (
            <ReaderAgentComposer
              key={readerContext.key}
              readerContext={readerContext}
              providers={providers}
              providerId={providerId}
              modelId={modelId}
              reference={selectionState.reference}
              referenceError={selectionState.error}
              onReferenceChange={onReaderSelectionChange}
              onOpenCitation={openCitation}
              onReadingChange={onReaderReadingChange}
            />
          ) : (
            <div className="reading-agent-idle" role="status">
              <BookOpenText size={22} aria-hidden="true" />
              <div>
                <strong>先浏览五分钟定向并决定是否研读</strong>
                <p>进入研读后，就可以在这里让 Agent 带你逐段读、随时追问。</p>
              </div>
            </div>
          )}
        </>
      )}
      artifact={(
        <>
          <nav className="reading-artifact-tabs" role="tablist" aria-label="当前工件">
            {ARTIFACT_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={artifactTab === tab.id}
                className={artifactTab === tab.id ? "is-active" : ""}
                onClick={() => setArtifactTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </nav>

         <div className="reading-artifact-panels">
            <div className="reading-artifact-panel is-doc" hidden={artifactTab !== "doc"}>
              {readerPaper ? (
                <PaperReader
                  runId={readerTarget.runId}
                  paper={readerPaper}
                  initialBlockId={readerTarget.blockId}
                  purpose={readerTarget.purpose}
                  providerId={readingProviderId}
                  modelId={readingModelId}
                  guide={readerGuide}
                  guideDecision={guideDecision}
                  guideDecisionBusy={guideDecisionBusy}
                  peerPapers={readerPeerPapers}
                  onSwitchPaper={onSwitchPaper}
                  onGuideDecision={onGuideDecision}
                  onSelectionChange={onReaderSelectionChange}
                  onReaderContextChange={onReaderContextChange}
                  onReadingChange={onReadingChange}
                  onClose={onClose}
                />
              ) : null}
            </div>
            <div className="reading-artifact-panel is-notes" hidden={artifactTab !== "notes"}>
              <ReadingNotesPanel readerContext={readerContext} onOpenBlock={openCitation} />
            </div>
            <div className="reading-artifact-panel is-state" hidden={artifactTab !== "state"}>
              <ProjectStateSection
                projectContextState={projectContextState}
                onReload={onReloadProjectContext}
              />
            </div>
          </div>
        </>
      )}
      overlay={restart.open ? (
        <RestartReadingDialog
          pending={restart.pending}
          error={restart.error}
          onCancel={() => setRestart({ open: false, pending: false, error: null })}
          onConfirm={confirmRestart}
        />
      ) : null}
    />
  );
}
