import { useRef, useState } from "react";
import {
  CheckCircle,
  Circle,
  FileText,
  Flag,
  FolderOpen,
  Quotes,
  ShieldCheck,
} from "@phosphor-icons/react";
import { workflowFixture } from "../workflow/fixtures.js";

function getStageIndex(run, stages) {
  const value = run?.readingStageIndex ?? run?.currentStageIndex ?? run?.current_stage ?? 0;
  if (typeof value === "number") return value;
  const index = stages.findIndex((stage) => stage.id === value);
  return index < 0 ? 0 : index;
}

function getActivePaper(run) {
  const papers = workflowFixture.papers ?? [];
  const activeId = run?.activePaperId ?? run?.active_paper_id ?? (run?.selectedPaperIds ?? run?.selected_ids ?? [])[0] ?? papers[0]?.id;
  return papers.find((p) => p.id === activeId) ?? papers[0];
}

function EvidenceSection({ paper, stage }) {
  const evidence = (workflowFixture.evidence ?? [])
    .filter((item) => item.paperId === paper?.id)
    .slice(0, 3);

  return (
    <section className="workflow-context-section" aria-labelledby="workflow-current-paper-title">
      <header>
        <div><FileText size={17} aria-hidden="true" /><h3 id="workflow-current-paper-title">当前论文</h3></div>
        <span>{stage ? stage.label : "候选判断"}</span>
      </header>

      <article className="workflow-context-paper">
        <span className="workflow-context-paper-icon"><FileText size={17} aria-hidden="true" /></span>
        <div><strong>{paper.shortTitle ?? paper.title}</strong><p>{paper.venue} · {paper.publishedAt ?? paper.published_at}</p></div>
      </article>

      {paper?.evidenceScope ?? paper?.evidence_scope ? (
        <div className="workflow-evidence-scope">
          <ShieldCheck size={16} aria-hidden="true" />
          <p><strong>证据范围</strong><span>{paper.evidenceScope ?? paper.evidence_scope}</span></p>
        </div>
      ) : null}

      {evidence.length > 0 ? (
        <div className="workflow-source-list" aria-label="最相关证据">
          {evidence.map((item) => (
            <article key={item.id}>
              <span><Quotes size={15} aria-hidden="true" /></span>
              <div>
                <strong>{item.label}</strong>
                <p>{item.detail}</p>
                <small>{item.kind} · {item.scope}</small>
              </div>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function ProjectStateSection() {
  const projectState = workflowFixture.projectState ?? {};
  const decisions = projectState.decisions ?? [];
  const openQuestions = projectState.openQuestions ?? projectState.open_questions ?? [];
  const nextAction = projectState.nextAction ?? projectState.next_action;

  return (
    <>
      <section className="workflow-context-section workflow-project-state" aria-labelledby="workflow-decisions-title">
        <header>
          <div><CheckCircle size={17} weight="fill" aria-hidden="true" /><h3 id="workflow-decisions-title">已确认决定</h3></div>
          <span>{decisions.length} 条</span>
        </header>
        <div className="workflow-state-list">
          {decisions.map((decision) => (
            <article key={decision}>
              <CheckCircle size={16} weight="fill" aria-hidden="true" />
              <p>{decision}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="workflow-context-section workflow-project-state" aria-labelledby="workflow-questions-title">
        <header>
          <div><Circle size={17} aria-hidden="true" /><h3 id="workflow-questions-title">开放问题</h3></div>
          <span>{openQuestions.length} 条</span>
        </header>
        <div className="workflow-state-list">
          {openQuestions.map((question) => (
            <article key={question}>
              <Circle size={16} aria-hidden="true" />
              <p>{question}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="workflow-context-section workflow-project-state" aria-labelledby="workflow-next-title">
        <header>
          <div><Flag size={17} weight="fill" aria-hidden="true" /><h3 id="workflow-next-title">下一步</h3></div>
        </header>
        {nextAction ? (
          <div className="workflow-next-action"><Flag size={16} weight="fill" aria-hidden="true" /><p><span>{nextAction}</span></p></div>
        ) : null}
      </section>
    </>
  );
}

const tabs = [
  { id: "evidence", label: "当前依据" },
  { id: "project-state", label: "项目状态" },
];

export function WorkflowContextRail({
  run,
  mobileActive,
  onMouseDownResizer,
  isResizing,
}) {
  const [activeTab, setActiveTab] = useState("evidence");
  const tabRefs = useRef([]);
  const stages = workflowFixture.readingStages ?? [];
  const stage = String(run?.status ?? "").toLowerCase() === "reading" ? stages[getStageIndex(run, stages)] : null;
  const paper = getActivePaper(run);
  const tabs = [
    { id: "evidence", label: "当前依据" },
    { id: "state", label: "项目状态" },
  ];

  const handleTabKeyDown = (event, index) => {
    let nextIndex = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabs.length - 1;
    if (nextIndex !== null) {
      event.preventDefault();
      setActiveTab(tabs[nextIndex].id);
      tabRefs.current[nextIndex]?.focus();
    }
  };

  return (
    <aside className={`context-rail workflow-context-rail${mobileActive ? " is-mobile-active" : ""}`} aria-label="运行上下文">
      {onMouseDownResizer ? (
        <div
          className={`panel-resizer-handle${isResizing ? " is-resizing" : ""}`}
          onMouseDown={onMouseDownResizer}
          title="按住左右滑动拖拽调整右侧栏宽度"
          aria-label="拖拽调整右侧栏宽度"
        >
          <span className="resizer-line" />
        </div>
      ) : null}
      <header className="workflow-context-header">
        <div>
          <span className="workflow-kicker">当前 Run</span>
          <h2>运行上下文</h2>
        </div>
      </header>

      <div className="workflow-context-content">
        <nav className="context-tabs" aria-label="运行上下文分类" role="tablist">
          {tabs.map((tab, index) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                ref={(node) => { tabRefs.current[index] = node; }}
                id={`workflow-context-tab-${tab.id}`}
                className={isActive ? "is-active" : ""}
                type="button"
                role="tab"
                aria-selected={isActive}
                aria-controls={`workflow-context-panel-${tab.id}`}
                tabIndex={isActive ? 0 : -1}
                onClick={() => setActiveTab(tab.id)}
                onKeyDown={(event) => handleTabKeyDown(event, index)}
              >
                {tab.label}
              </button>
            );
          })}
        </nav>

        <div
          id={`workflow-context-panel-${activeTab}`}
          role="tabpanel"
          aria-labelledby={`workflow-context-tab-${activeTab}`}
          tabIndex={0}
        >
          {activeTab === "evidence" ? <EvidenceSection paper={paper} stage={stage} /> : <ProjectStateSection />}
        </div>
      </div>
    </aside>
  );
}
