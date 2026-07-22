import { useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  BookmarkSimple,
  Check,
  CheckCircle,
  CircleNotch,
  FileText,
  FolderOpen,
  Info,
  ListChecks,
  NotePencil,
  Package,
  PaperPlaneTilt,
  Quotes,
  ShieldCheck,
  SidebarSimple,
  WarningCircle,
  XCircle,
} from "@phosphor-icons/react";
import { workflowFixture } from "../workflow/fixtures.js";
import { ProviderMenu } from "./ProviderMenu.jsx";

const STATUS_LABELS = {
  review_ready: "本周待审阅",
  preparing_guides: "正在准备导读",
  guide_ready: "导读待决定",
  reading: "分阶段精读",
  awaiting_approval: "等待写入确认",
  committing: "正在模拟写入",
  partial: "部分写入失败",
  completed: "本轮已完成",
  completed_no_write: "本轮无写入",
};

const WORKFLOW_STEPS = [
  { id: "review", label: "候选", statuses: ["review_ready"] },
  { id: "guide", label: "导读", statuses: ["preparing_guides", "guide_ready"] },
  { id: "reading", label: "精读", statuses: ["reading"] },
  { id: "approval", label: "预览", statuses: ["awaiting_approval", "committing", "partial"] },
  { id: "done", label: "完成", statuses: ["completed", "completed_no_write"] },
];

const TARGET_META = {
  zotero: {
    label: "Zotero",
    description: "题录、PDF 与五分钟导读",
    icon: BookmarkSimple,
  },
  obsidian: {
    label: "Obsidian",
    description: "一篇论文一份持续补充的精读笔记",
    icon: NotePencil,
  },
  project_state: {
    label: "项目状态",
    description: "只写入已确认的项目影响、问题与下一步",
    icon: FolderOpen,
  },
};

function normalizeStatus(status) {
  return String(status ?? "review_ready").toLowerCase();
}

function findStepIndex(status) {
  const index = WORKFLOW_STEPS.findIndex((step) => step.statuses.includes(status));
  return index < 0 ? 0 : index;
}

function formatSignal(signal) {
  if (typeof signal === "string") return signal;
  return signal?.label ?? signal?.description ?? signal?.value ?? "已核验热度信号";
}

function getGuideSections(paper) {
  const guide = workflowFixture.guides?.[paper?.id] ?? {};
  return [
    ["这篇论文解决什么问题", guide.problem],
    ["为什么现在值得读", guide.whyNow],
    ["方法的核心直觉", guide.intuition],
    ["作者提供的主要证据", guide.evidence],
    ["局限与待核验内容", guide.limitations ?? guide.limits],
    ["与当前项目的初步关系", guide.projectRelation ?? guide.relationship],
  ].filter(([, value]) => Boolean(value));
}

function getReadingStageIndex(run) {
  const value = run?.readingStageIndex ?? run?.currentStageIndex ?? run?.current_stage ?? 0;
  if (typeof value === "number") return value;
  const index = (workflowFixture.readingStages ?? []).findIndex((stage) => stage.id === value);
  return index < 0 ? 0 : index;
}

function getProposalPreview(proposal) {
  const preview = proposal.preview ?? proposal.preview_or_diff ?? proposal.diff;
  if (Array.isArray(preview)) return preview;
  return preview ? [preview] : [];
}

function WorkflowHeader({
  run,
  status,
  sidebarOpen,
  onToggleSidebar,
  contextRailOpen,
  onToggleContextRail,
  providers,
  providerId,
  model,
  providerOpen,
  onProviderOpenChange,
  onProviderChange,
  onModelChange,
  onOpenSkills,
  installedSkillCount,
}) {
  const activeStepIndex = findStepIndex(status);

  return (
    <header className="workflow-run-header">
      <div className="workflow-run-summary">
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
            <h1>{workflowFixture.workflowName ?? "期刊追踪与精读"}</h1>
          </div>
        </div>

        <div className="workflow-run-meta" aria-label="模型与运行摘要">
          {providers ? (
            <ProviderMenu
              open={providerOpen}
              onOpenChange={onProviderOpenChange}
              providers={providers}
              providerId={providerId}
              model={model}
              onProviderChange={onProviderChange}
              onModelChange={onModelChange}
            />
          ) : null}

          {onOpenSkills ? (
            <button className="header-meta-pill header-skill-pill" type="button" onClick={onOpenSkills}>
              <Package size={13} weight="regular" aria-hidden="true" />
              <span>技能 · {installedSkillCount}</span>
            </button>
          ) : null}

          <span className="header-meta-pill header-status-pill">
            <span className="status-dot" aria-hidden="true" />
            <span>{STATUS_LABELS[status] ?? status}</span>
          </span>
          <button
            className={`column-toggle-btn${!contextRailOpen ? " is-collapsed" : ""}`}
            type="button"
            aria-label={contextRailOpen ? "收起右侧依据" : "展开右侧依据"}
            title={contextRailOpen ? "收起右侧依据" : "展开右侧依据"}
            onClick={onToggleContextRail}
          >
            <SidebarSimple size={18} weight="regular" style={{ transform: "scaleX(-1)" }} />
          </button>
        </div>
      </div>

      <nav className="workflow-step-flow" aria-label="工作流步骤">
        <ol className="workflow-step-list">
          {WORKFLOW_STEPS.map((step, index) => {
            const isComplete = index < activeStepIndex;
            const isActive = index === activeStepIndex;
            const stateClass = isComplete ? "is-complete" : isActive ? "is-active" : "is-pending";
            return (
              <li className={`workflow-step-item ${stateClass}`} key={step.id} aria-current={isActive ? "step" : undefined}>
                <span className="workflow-step-dot" />
                <span className="workflow-step-name">{step.label}</span>
              </li>
            );
          })}
        </ol>
      </nav>
    </header>
  );
}

function PaperTabs({ papers, activePaperId, onSetActivePaper }) {
  if (papers.length < 2) return null;

  return (
    <div className="workflow-paper-tabs" role="tablist" aria-label="已选论文">
      {papers.map((paper, index) => (
        <button
          className={paper.id === activePaperId ? "is-active" : ""}
          type="button"
          role="tab"
          aria-selected={paper.id === activePaperId}
          onClick={() => onSetActivePaper?.(paper.id)}
          key={paper.id}
        >
          <span>论文 {index + 1}</span>
          <strong>{paper.shortTitle ?? paper.title}</strong>
        </button>
      ))}
    </div>
  );
}

function CandidateReview({ run, papers, onTogglePaper, onPrepareGuides, onSkipRun }) {
  const selectedPaperIds = run?.selectedPaperIds ?? run?.selected_ids ?? [];
  const selectedCount = selectedPaperIds.length;
  const [expandedEvidenceId, setExpandedEvidenceId] = useState(null);

  const toggleEvidence = (paperId) => {
    setExpandedEvidenceId((current) => current === paperId ? null : paperId);
  };

  return (
    <section className="workflow-stage workflow-review-stage" aria-labelledby="review-title">
      <div className="workflow-stage-scroll-area">
        <header className="workflow-stage-heading">
          <div>
            <span className="workflow-stage-label">本周扫描完成</span>
            <h2 id="review-title">选择本周要读的论文</h2>
            <p>最多选择两篇；仅所选论文会下载 PDF 并进入后续处理。</p>
            <p className="workflow-scan-summary">
              扫描 <strong>{workflowFixture.scanSummary?.rawCount ?? 46}</strong> 条
              <span aria-hidden="true"> · </span>
              <strong>{workflowFixture.scanSummary?.topicMatchedCount ?? 18}</strong> 条主题相关
              <span aria-hidden="true"> · </span>
              <strong>{workflowFixture.scanSummary?.focusedCount ?? papers.length}</strong> 条重点候选
            </p>
          </div>
        </header>

        <div className="workflow-candidate-list">
          {papers.map((paper, index) => {
            const selected = selectedPaperIds.includes(paper.id);
            const selectionFull = selectedCount >= 2 && !selected;
            const evidenceExpanded = expandedEvidenceId === paper.id;
            return (
              <article className={`workflow-candidate${selected ? " is-selected" : ""}`} key={paper.id}>
                <label className="workflow-candidate-select">
                  <input
                    type="checkbox"
                    checked={selected}
                    disabled={selectionFull}
                    aria-label={`${selected ? "取消选择" : "选择"}${paper.title}`}
                    onChange={() => onTogglePaper?.(paper.id)}
                  />
                  <span>{selected ? <Check size={13} weight="bold" aria-hidden="true" /> : index + 1}</span>
                </label>
                <div className="workflow-candidate-main">
                  <div className="workflow-candidate-title-row">
                    <h3>{paper.title}</h3>
                    <span className="workflow-recommendation-badge">{paper.recommendation}</span>
                  </div>
                  <p className="workflow-authors">{Array.isArray(paper.authors) ? paper.authors.join("、") : paper.authors}</p>
                  <dl className="workflow-candidate-summary">
                    <div>
                      <dt>论文讲什么</dt>
                      <dd className="workflow-abstract-copy">{paper.abstract}</dd>
                    </div>
                    <div className="is-project-impact">
                      <dt>对项目的作用</dt>
                      <dd className="workflow-relevance-copy">{paper.relevance ?? paper.relevanceReason ?? paper.relevance_reason}</dd>
                    </div>
                  </dl>
                  <button
                    className="workflow-evidence-toggle"
                    type="button"
                    aria-expanded={evidenceExpanded}
                    aria-controls={`${paper.id}-evidence`}
                    onClick={() => toggleEvidence(paper.id)}
                  >
                    {evidenceExpanded ? "收起依据" : "查看依据"}
                  </button>
                  {evidenceExpanded ? (
                    <div className="workflow-candidate-evidence" id={`${paper.id}-evidence`}>
                      <div>
                        <strong>热度依据</strong>
                        <ul>{(paper.heatSignals ?? paper.heat_signals ?? []).map((signal, signalIndex) => <li key={`${paper.id}-signal-${signalIndex}`}>{formatSignal(signal)}</li>)}</ul>
                      </div>
                      <div>
                        <strong>证据范围</strong>
                        <p>{paper.evidenceScope ?? paper.evidence_scope ?? "仅依据题录与摘要，尚未阅读全文"}</p>
                      </div>
                    </div>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      </div>

      <footer className="workflow-stage-actions">
        <p>已选择 {selectedPaperIds.length}/2 篇。只有所选论文会下载 PDF 并运行 MinerU。</p>
        <div>
          <button className="workflow-secondary-action" type="button" onClick={onSkipRun}>本周不处理</button>
          <button className="workflow-primary-action" type="button" onClick={onPrepareGuides} disabled={selectedPaperIds.length === 0}>
            准备五分钟导读 <ArrowRight size={15} weight="bold" aria-hidden="true" />
          </button>
        </div>
      </footer>
    </section>
  );
}

function PreparingGuides({ run, selectedPapers }) {
  const activeIndex = run?.preparationStep ?? 1;
  const preparationSteps = ["下载并校验 PDF", "MinerU 转换 Markdown", "生成五分钟导读"];

  return (
    <section className="workflow-stage workflow-progress-stage" aria-labelledby="preparing-title">
      <CircleNotch className="spin" size={30} weight="bold" aria-hidden="true" />
      <span className="workflow-stage-label">正在处理 {selectedPapers.length} 篇所选论文</span>
      <h2 id="preparing-title">准备五分钟导读</h2>
      <p>候选扫描结果已保留，不会在这一步重新抓取来源。</p>
      <ol className="workflow-progress-list">
        {preparationSteps.map((label, index) => (
          <li className={index < activeIndex ? "is-complete" : index === activeIndex ? "is-active" : ""} key={label}>
            <span>{index < activeIndex ? <Check size={13} weight="bold" aria-hidden="true" /> : index + 1}</span>
            <strong>{label}</strong>
          </li>
        ))}
      </ol>
      <div className="workflow-processing-papers">
        {selectedPapers.map((paper) => <span key={paper.id}><FileText size={14} aria-hidden="true" />{paper.shortTitle ?? paper.title}</span>)}
      </div>
    </section>
  );
}

function GuideReady({ run, selectedPapers, activePaper, onSetActivePaper, onChooseGuideAction, onGeneratePreview }) {
  const guideChoices = run?.guideChoices ?? {};
  const guide = workflowFixture.guides?.[activePaper?.id] ?? {};
  const sections = getGuideSections(activePaper);
  const questions = guide.questions ?? [];
  const allGuidesDecided = selectedPapers.length > 0 && selectedPapers.every((paper) => Boolean(guideChoices[paper.id]));

  return (
    <section className="workflow-stage workflow-guide-stage" aria-labelledby="guide-title">
      <div className="workflow-stage-scroll-area">
        <PaperTabs papers={selectedPapers} activePaperId={activePaper?.id} onSetActivePaper={onSetActivePaper} />
        <header className="workflow-stage-heading workflow-paper-heading">
          <div>
            <span className="workflow-stage-label">五分钟导读</span>
            <h2 id="guide-title">{activePaper?.title}</h2>
            <p>{activePaper?.venue} · {activePaper?.publishedAt ?? activePaper?.published_at} · PDF 与 MinerU 文本仅保存在本次演示 Run</p>
          </div>
          <span className="workflow-evidence-badge"><ShieldCheck size={15} aria-hidden="true" />基于演示全文转换结果</span>
        </header>

        <div className="workflow-guide-grid">
          {sections.map(([title, content]) => (
            <article className="workflow-guide-section" key={title}>
              <h3>{title}</h3>
              {Array.isArray(content) ? <ul>{content.map((item) => <li key={item}>{item}</li>)}</ul> : <p>{content}</p>}
            </article>
          ))}
        </div>

        {questions.length > 0 ? (
          <aside className="workflow-reading-questions">
            <Quotes size={20} weight="fill" aria-hidden="true" />
            <div><strong>进入精读最值得追问</strong><ol>{questions.map((question) => <li key={question}>{question}</li>)}</ol></div>
          </aside>
        ) : null}
      </div>

      <footer className="workflow-stage-actions workflow-guide-actions">
        <p>{guideChoices[activePaper?.id] ? `已选择：${guideChoices[activePaper.id] === "read" ? "进入精读" : "只收藏导读"}` : "先决定这篇论文是否值得进入精读。"}</p>
        <div>
          {allGuidesDecided ? (
            <>
              <button className="workflow-secondary-action" type="button" onClick={() => onChooseGuideAction?.(activePaper?.id, "read")}>
                <BookOpen size={16} aria-hidden="true" />改为精读
              </button>
              <button className="workflow-primary-action" type="button" onClick={onGeneratePreview}>
                生成写入预览 <ArrowRight size={15} weight="bold" aria-hidden="true" />
              </button>
            </>
          ) : (
            <>
              <button className="workflow-secondary-action" type="button" onClick={() => onChooseGuideAction?.(activePaper?.id, "collect")}>
                <BookmarkSimple size={16} aria-hidden="true" />只收藏导读
              </button>
              <button className="workflow-primary-action" type="button" onClick={() => onChooseGuideAction?.(activePaper?.id, "read")}>
                <BookOpen size={16} weight="bold" aria-hidden="true" />进入分阶段精读
              </button>
            </>
          )}
        </div>
      </footer>
    </section>
  );
}

function ReadingStage({
  run,
  selectedPapers,
  activePaper,
  onSetActivePaper,
  onPreviousStage,
  onNextStage,
  onAddQuestion,
  onGeneratePreview,
}) {
  const [question, setQuestion] = useState("");
  const readingStages = workflowFixture.readingStages ?? [];
  const stageIndex = Math.min(getReadingStageIndex(run), Math.max(readingStages.length - 1, 0));
  const stage = readingStages[stageIndex];
  const content = stage?.content?.[activePaper?.id] ?? [];
  const allQuestions = run?.questions ?? [];
  const questions = allQuestions.filter((item) => (item.paperId ?? item.paper_id) === activePaper?.id);
  const isLastStage = stageIndex === readingStages.length - 1;
  const nextIncompletePaper = selectedPapers.find((paper) => (
    paper.id !== activePaper?.id
    && (run?.readingStageByPaperId?.[paper.id] ?? 0) < readingStages.length - 1
  ));

  const submitQuestion = (event) => {
    event.preventDefault();
    const nextQuestion = question.trim();
    if (!nextQuestion) return;
    onAddQuestion?.(nextQuestion, activePaper?.id);
    setQuestion("");
  };

  return (
    <section className="workflow-stage workflow-reading-stage" aria-labelledby="reading-title">
      <PaperTabs papers={selectedPapers} activePaperId={activePaper?.id} onSetActivePaper={onSetActivePaper} />
      <header className="workflow-stage-heading workflow-paper-heading">
        <div>
          <span className="workflow-stage-label">分阶段精读 · {stageIndex + 1}/{readingStages.length}</span>
          <h2 id="reading-title">{activePaper?.title}</h2>
          <p>本阶段只使用所需章节和证据片段，不重复发送整篇 Markdown。</p>
        </div>
      </header>

      <nav className="workflow-reading-stepper" aria-label="精读阶段">
        {readingStages.map((item, index) => (
          <span className={index < stageIndex ? "is-complete" : index === stageIndex ? "is-active" : ""} key={item.id} aria-current={index === stageIndex ? "step" : undefined}>
            <i>{index < stageIndex ? <Check size={12} weight="bold" aria-hidden="true" /> : index + 1}</i>
            {item.label}
          </span>
        ))}
      </nav>

      <article className="workflow-reading-document">
        <header>
          <span>{stage?.eyebrow ?? `阶段 ${stageIndex + 1}`}</span>
          <h3>{stage?.label}</h3>
          <p>{stage?.prompt}</p>
        </header>
        {content.length > 0 ? <ul>{content.map((point) => <li key={point}>{point}</li>)}</ul> : null}
      </article>

      <section className="workflow-intervention" aria-label="本阶段追问">
        <div className="workflow-question-history">
          {questions.map((item, index) => (
            <article key={item.id ?? `${item.text}-${index}`}>
              <strong>你的追问</strong><p>{item.text}</p>
              {item.answer ? <><strong>Pi 的补充</strong><p>{item.answer}</p></> : null}
            </article>
          ))}
        </div>
        <form onSubmit={submitQuestion}>
          <textarea value={question} onChange={(event) => setQuestion(event.target.value)} placeholder={`追问、修正或补充“${stage?.label ?? "当前阶段"}”……`} />
          <button type="submit" disabled={!question.trim()} aria-label="提交追问"><PaperPlaneTilt size={16} weight="fill" aria-hidden="true" /></button>
        </form>
      </section>

      <footer className="workflow-stage-actions">
        <button className="workflow-secondary-action" type="button" onClick={onPreviousStage} disabled={stageIndex === 0}>
          <ArrowLeft size={15} weight="bold" aria-hidden="true" />上一步
        </button>
        {isLastStage && nextIncompletePaper ? (
          <button className="workflow-primary-action" type="button" onClick={() => onSetActivePaper?.(nextIncompletePaper.id)}>
            继续精读：{nextIncompletePaper.shortTitle ?? nextIncompletePaper.title} <ArrowRight size={15} weight="bold" aria-hidden="true" />
          </button>
        ) : isLastStage ? (
          <button className="workflow-primary-action" type="button" onClick={onGeneratePreview}>
            生成三处写入预览 <ArrowRight size={15} weight="bold" aria-hidden="true" />
          </button>
        ) : (
          <button className="workflow-primary-action" type="button" onClick={onNextStage}>
            下一步：{readingStages[stageIndex + 1]?.label} <ArrowRight size={15} weight="bold" aria-hidden="true" />
          </button>
        )}
      </footer>
    </section>
  );
}

function ApprovalStage({ run, proposals, onToggleProposal, onCommit }) {
  const [simulateObsidianFailure, setSimulateObsidianFailure] = useState(false);
  const selectedCount = proposals.filter((proposal) => proposal.selected).length;

  return (
    <section className="workflow-stage workflow-approval-stage" aria-labelledby="approval-title">
      <header className="workflow-stage-heading">
        <div>
          <span className="workflow-stage-label">内联确认 · 最后一步</span>
          <h2 id="approval-title">检查准备写入的确切内容</h2>
          <p>可逐项取消，最后只确认一次。预览内容改变后，本次批准会失效。</p>
        </div>
        <span className="workflow-selected-count">已选 {selectedCount}/{proposals.length}</span>
      </header>

      <div className="workflow-demo-notice" role="note">
        <Info size={18} weight="fill" aria-hidden="true" />
        <div><strong>前端演示不会真实写入</strong><p>点击确认只演示 Zotero → Obsidian → 项目状态的提交顺序与失败恢复。</p></div>
      </div>

      <div className="workflow-proposal-groups">
        {Object.entries(TARGET_META).map(([target, meta]) => {
          const targetProposals = proposals.filter((proposal) => proposal.target === target);
          const TargetIcon = meta.icon;
          return (
            <section className="workflow-proposal-group" key={target}>
              <header>
                <span><TargetIcon size={19} weight="regular" aria-hidden="true" /></span>
                <div><h3>{meta.label}</h3><p>{meta.description}</p></div>
              </header>
              {targetProposals.map((proposal) => (
                <label className={`workflow-proposal${proposal.selected ? " is-selected" : ""}`} key={proposal.id ?? proposal.proposal_id}>
                  <input type="checkbox" checked={Boolean(proposal.selected)} onChange={() => onToggleProposal?.(proposal.id ?? proposal.proposal_id)} />
                  <span className="workflow-checkbox">{proposal.selected ? <Check size={13} weight="bold" aria-hidden="true" /> : null}</span>
                  <span className="workflow-proposal-copy">
                    <strong>{proposal.title ?? proposal.operationLabel ?? proposal.operation ?? "准备写入内容"}</strong>
                    <small>{proposal.targetLabel ?? proposal.targetLocator ?? proposal.target_locator}</small>
                    <span className="workflow-diff-preview">{getProposalPreview(proposal).map((line, index) => <code key={`${proposal.id}-line-${index}`}>{line}</code>)}</span>
                  </span>
                </label>
              ))}
            </section>
          );
        })}
      </div>

      <label className="workflow-failure-toggle">
        <input type="checkbox" checked={simulateObsidianFailure} onChange={(event) => setSimulateObsidianFailure(event.target.checked)} />
        <span><WarningCircle size={16} aria-hidden="true" /><strong>模拟 Obsidian 写入失败</strong><small>用于验证 PARTIAL 状态只重试失败项，不重复创建 Zotero 条目。</small></span>
      </label>

      <footer className="workflow-stage-actions workflow-confirm-actions">
        <p><ShieldCheck size={16} aria-hidden="true" />本次批准只绑定当前所选提案及其预览哈希。</p>
        <button className="workflow-primary-action" type="button" disabled={selectedCount === 0} onClick={() => onCommit?.({ simulateObsidianFailure })}>
          <Check size={15} weight="bold" aria-hidden="true" />确认写入所选内容
        </button>
      </footer>
    </section>
  );
}

function CommittingStage({ run, proposals }) {
  const targets = Object.keys(TARGET_META);
  const activeTarget = proposals.find((proposal) => proposal.status === "committing")?.target
    ?? (run?.isRetrying ? proposals.find((proposal) => proposal.status === "failed")?.target : null)
    ?? "zotero";
  const activeIndex = targets.indexOf(activeTarget);

  return (
    <section className="workflow-stage workflow-progress-stage" aria-labelledby="committing-title">
      <CircleNotch className="spin" size={30} weight="bold" aria-hidden="true" />
      <span className="workflow-stage-label">{run?.isRetrying ? "从失败节点继续" : "顺序提交并逐项核验"}</span>
      <h2 id="committing-title">{run?.isRetrying ? `正在只重试 ${TARGET_META[activeTarget]?.label ?? "失败项"}` : "正在模拟写入所选内容"}</h2>
      <p>成功项会立即记录外部 ID；后续失败时不会自动回滚或重复创建。</p>
      <ol className="workflow-progress-list">
        {targets.map((target, index) => (
          <li className={index < activeIndex ? "is-complete" : index === activeIndex ? "is-active" : ""} key={target}>
            <span>{index < activeIndex ? <Check size={13} weight="bold" aria-hidden="true" /> : index + 1}</span>
            <strong>{TARGET_META[target].label}</strong>
          </li>
        ))}
      </ol>
    </section>
  );
}

function ResultList({ proposals }) {
  return (
    <div className="workflow-result-list">
      {proposals.filter((proposal) => proposal.selected || ["committed", "failed"].includes(proposal.status)).map((proposal) => {
        const success = proposal.status === "committed";
        return (
          <article className={success ? "is-success" : "is-failed"} key={proposal.id ?? proposal.proposal_id}>
            {success ? <CheckCircle size={20} weight="fill" aria-hidden="true" /> : <XCircle size={20} weight="fill" aria-hidden="true" />}
            <div>
              <strong>{TARGET_META[proposal.target]?.label} · {proposal.title ?? proposal.operation ?? "写入内容"}</strong>
              <p>{success ? proposal.verificationResult ?? proposal.verification_result ?? "已核验" : proposal.error ?? "模拟写入失败，原目标保持不变"}</p>
              {proposal.externalId ?? proposal.external_id ? <small>外部 ID：{proposal.externalId ?? proposal.external_id}</small> : null}
            </div>
          </article>
        );
      })}
    </div>
  );
}

function PartialStage({ proposals, onRetryFailed }) {
  const failedCount = proposals.filter((proposal) => proposal.status === "failed").length;
  return (
    <section className="workflow-stage workflow-result-stage is-partial" aria-labelledby="partial-title">
      <WarningCircle size={34} weight="fill" aria-hidden="true" />
      <span className="workflow-stage-label">部分写入失败</span>
      <h2 id="partial-title">成功项已保留，只需重试 {failedCount} 个失败项</h2>
      <p>不会回滚已成功内容，也不会再次创建已经核验的 Zotero 条目。</p>
      <ResultList proposals={proposals} />
      <footer className="workflow-stage-actions">
        <p>重试会从失败目标继续，并再次核验目标版本。</p>
        <button className="workflow-primary-action" type="button" onClick={onRetryFailed}>只重试失败项 <ArrowRight size={15} weight="bold" aria-hidden="true" /></button>
      </footer>
    </section>
  );
}

function CompletedStage({ proposals, onReset }) {
  return (
    <section className="workflow-stage workflow-result-stage is-complete" aria-labelledby="completed-title">
      <CheckCircle size={36} weight="fill" aria-hidden="true" />
      <span className="workflow-stage-label">本轮运行已完成</span>
      <h2 id="completed-title">论文成果已按三层分工归档</h2>
      <p>Zotero 管论文，Obsidian 管精读，项目状态只保留已确认的项目影响。</p>
      <ResultList proposals={proposals} />
      <div className="workflow-completion-summary">
        <span><BookmarkSimple size={16} aria-hidden="true" />题录与五分钟导读</span>
        <span><NotePencil size={16} aria-hidden="true" />可持续补充的精读笔记</span>
        <span><ListChecks size={16} aria-hidden="true" />项目决定、问题与下一步</span>
      </div>
      {onReset ? <button className="workflow-secondary-action" type="button" onClick={onReset}>重新演示本周 Run</button> : null}
    </section>
  );
}

function CompletedNoWriteStage({ onReset }) {
  return (
    <section className="workflow-stage workflow-result-stage is-no-write" aria-labelledby="no-write-title">
      <CheckCircle size={36} weight="fill" aria-hidden="true" />
      <span className="workflow-stage-label">正常结束</span>
      <h2 id="no-write-title">本周没有选择处理论文</h2>
      <p>扫描结果和可靠游标已经保留；Zotero、Obsidian 与项目状态均未发生变化。</p>
      <div className="workflow-demo-notice"><ShieldCheck size={18} aria-hidden="true" /><div><strong>零外部写入</strong><p>本轮结束不等于丢弃候选，下次运行仍可参考历史发现记录。</p></div></div>
      {onReset ? <button className="workflow-secondary-action" type="button" onClick={onReset}>重新演示本周 Run</button> : null}
    </section>
  );
}

export function WorkflowWorkspace({
  run,
  onTogglePaper,
  onPrepareGuides,
  onSkipRun,
  onSetActivePaper,
  onChooseGuideAction,
  onPreviousStage,
  onNextStage,
  onAddQuestion,
  onGeneratePreview,
  onToggleProposal,
  onCommit,
  onRetryFailed,
  onReset,
  mobileActive,
  sidebarOpen,
  onToggleSidebar,
  contextRailOpen,
  onToggleContextRail,
  providers,
  providerId,
  model,
  providerOpen,
  onProviderOpenChange,
  onProviderChange,
  onModelChange,
  onOpenSkills,
  installedSkillCount,
}) {
  const status = normalizeStatus(run?.status);
  const papers = workflowFixture.papers ?? [];
  const reviewPapers = papers.slice(0, 5);
  const selectedPaperIds = run?.selectedPaperIds ?? run?.selected_ids ?? [];
  const selectedPapers = papers.filter((paper) => selectedPaperIds.includes(paper.id));
  const readingPapers = selectedPapers.filter((paper) => run?.guideChoices?.[paper.id] === "read");
  const activePaperId = run?.activePaperId ?? run?.active_paper_id ?? selectedPapers[0]?.id ?? papers[0]?.id;
  const activePaper = papers.find((paper) => paper.id === activePaperId) ?? selectedPapers[0] ?? papers[0];
  const proposals = run?.proposals ?? workflowFixture.proposals ?? [];

  let content = null;
  if (status === "review_ready") content = <CandidateReview run={run} papers={reviewPapers} onTogglePaper={onTogglePaper} onPrepareGuides={onPrepareGuides} onSkipRun={onSkipRun} />;
  if (status === "preparing_guides") content = <PreparingGuides run={run} selectedPapers={selectedPapers} />;
  if (status === "guide_ready") content = <GuideReady run={run} selectedPapers={selectedPapers} activePaper={activePaper} onSetActivePaper={onSetActivePaper} onChooseGuideAction={onChooseGuideAction} onGeneratePreview={onGeneratePreview} />;
  if (status === "reading") content = <ReadingStage run={run} selectedPapers={readingPapers} activePaper={activePaper} onSetActivePaper={onSetActivePaper} onPreviousStage={onPreviousStage} onNextStage={onNextStage} onAddQuestion={onAddQuestion} onGeneratePreview={onGeneratePreview} />;
  if (status === "awaiting_approval") content = <ApprovalStage run={run} proposals={proposals} onToggleProposal={onToggleProposal} onCommit={onCommit} />;
  if (status === "committing") content = <CommittingStage run={run} proposals={proposals} />;
  if (status === "partial") content = <PartialStage proposals={proposals} onRetryFailed={onRetryFailed} />;
  if (status === "completed") content = <CompletedStage proposals={proposals} onReset={onReset} />;
  if (status === "completed_no_write") content = <CompletedNoWriteStage onReset={onReset} />;

  return (
    <main className={`workspace workflow-workspace${mobileActive ? " is-mobile-active" : ""}`}>
      <WorkflowHeader
        run={run}
        status={status}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={onToggleSidebar}
        contextRailOpen={contextRailOpen}
        onToggleContextRail={onToggleContextRail}
        providers={providers}
        providerId={providerId}
        model={model}
        providerOpen={providerOpen}
        onProviderOpenChange={onProviderOpenChange}
        onProviderChange={onProviderChange}
        onModelChange={onModelChange}
        onOpenSkills={onOpenSkills}
        installedSkillCount={installedSkillCount}
      />
      {content}
    </main>
  );
}
