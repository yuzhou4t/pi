import { useEffect, useState } from "react";
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
import { PaperReader } from "./PaperReader.jsx";
import { PaperRichText } from "./PaperRichText.jsx";
import { ProviderMenu } from "./ProviderMenu.jsx";

const STATUS_LABELS = {
  review_ready: "本周待审阅",
  preparing_guides: "正在准备导读",
  guide_ready: "导读待决定",
  reading: "论文研读",
  draft_ready: "阅读成果待归档",
  awaiting_approval: "等待写入确认",
  committing: "正在写入",
  partial: "部分写入失败",
  manual_action_required: "需在 Zotero 手工处理",
  reading_ready: "旧版 Run · 待重新检查",
  completed: "本轮已完成",
  completed_no_write: "本轮无写入",
};

const JOURNAL_PHASE_LABELS = {
  source_scan: "扫描全部 11 个来源",
  candidate_ranking: "筛选 5 篇候选",
  pdf_download: "获取候选全文",
  mineru_upload: "上传候选全文",
  mineru_extract: "解析论文正文",
  candidate_review: "候选已准备，等待审阅",
  guide_generation: "生成五分钟导读",
  guide_review: "导读已准备，等待决定",
  close_reading: "在原文中完成论文研读",
  write_preview: "阅读成果已准备，等待归档预览",
  archive_preview: "阅读成果已准备，等待归档预览",
  zotero_preview: "核对 Zotero 精确预览",
  zotero_commit: "写入并核验 Zotero",
  zotero_partial: "部分 Zotero 归档待处理",
  failed: "本轮运行失败",
};

const WORKFLOW_STEPS = [
  { id: "review", label: "候选", statuses: ["review_ready"] },
  { id: "guide", label: "导读", statuses: ["preparing_guides", "guide_ready"] },
  { id: "reading", label: "精读", statuses: ["reading", "reading_ready"] },
  { id: "approval", label: "预览", statuses: ["draft_ready", "awaiting_approval", "committing", "partial", "manual_action_required"] },
  { id: "done", label: "完成", statuses: ["completed", "completed_no_write"] },
];

const TARGET_META = {
  zotero: {
    label: "Zotero",
    description: "题录、原始论文与五分钟导读",
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

function getAvailableStepIds({
  run,
  status,
  journalRun,
  proposals,
  obsidianUiState,
  projectStateUiState,
}) {
  const currentStepIndex = findStepIndex(status);
  const guideChoices = run?.guideChoices ?? {};
  const hasGuides = (
    (run?.preparedGuideIds ?? []).length > 0
    || (journalRun?.guides?.requestedPaperIds ?? []).length > 0
  );
  const hasReading = (
    Object.values(guideChoices).includes("read")
    || Object.keys(run?.readingStatusByPaperId ?? {}).length > 0
    || Boolean(journalRun?.readings?.paperIds?.length)
  );
  const hasPreview = (
    (proposals ?? []).length > 0
    || Boolean(obsidianUiState?.preview)
    || Boolean(projectStateUiState?.preview)
  );
  const available = new Set(["review", WORKFLOW_STEPS[currentStepIndex].id]);
  if (hasGuides) available.add("guide");
  if (hasReading) available.add("reading");
  if (hasPreview || currentStepIndex === 3) available.add("approval");
  if (currentStepIndex === 4) available.add("done");
  return available;
}

function formatSignal(signal) {
  if (typeof signal === "string") return signal;
  return signal?.label ?? signal?.description ?? signal?.value ?? "已核验热度信号";
}

function formatZoteroTarget(target) {
  if (Array.isArray(target?.path) && target.path.length > 0) {
    return target.path.join(" / ");
  }
  return [target?.libraryName, target?.name].filter(Boolean)
    .filter((segment, index, path) => index === 0 || segment !== path[index - 1])
    .join(" / ");
}

function mineruDisplay(status, runStatus) {
  if (status === "ready") return { label: "全文已解析", tone: "ready" };
  if (runStatus === "not_configured" && status === "pdf_ready") {
    return { label: "全文解析待启用", tone: "pending" };
  }
  if (runStatus === "quota_deferred" && status === "pdf_ready") {
    return { label: "全文将在稍后解析", tone: "pending" };
  }
  if (status === "pdf_ready") return { label: "全文正在准备", tone: "pending" };
  if (/failed|unavailable/.test(status ?? "")) return { label: "全文准备失败", tone: "failed" };
  return { label: "全文等待准备", tone: "pending" };
}

function scanMetric(summary, liveKey, fixtureKey, fallback) {
  return summary?.[liveKey] ?? summary?.[fixtureKey] ?? fallback;
}

function getGuideSections(paper, liveGuide) {
  if (paper?.isDemo === false) {
    return [
      ["这篇论文解决什么问题", liveGuide?.problem],
      ["为什么值得读", liveGuide?.whyRead],
      ["方法的核心直觉", liveGuide?.intuition],
      ["作者提供的主要证据", liveGuide?.evidence],
      ["局限与待核验内容", liveGuide?.limitations],
    ].filter(([, value]) => Boolean(value));
  }
  const fixtureGuide = workflowFixture.guides?.[paper?.id] ?? {};
  return [
    ["这篇论文解决什么问题", fixtureGuide.problem],
    ["为什么现在值得读", fixtureGuide.whyNow],
    ["方法的核心直觉", fixtureGuide.intuition],
    ["作者提供的主要证据", fixtureGuide.evidence],
    ["局限与待核验内容", fixtureGuide.limitations ?? fixtureGuide.limits],
    ["与当前项目的初步关系", fixtureGuide.projectRelation ?? fixtureGuide.relationship],
  ].filter(([, value]) => Boolean(value));
}

function guideUsesChinese(guide) {
  if (!guide) return false;
  return [
    guide.problem,
    guide.whyRead,
    guide.intuition,
    guide.evidence,
    guide.limitations,
    ...(guide.questions ?? []),
  ].filter(Boolean).every((value) => /\p{Script=Han}/u.test(value));
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

const GUIDE_SECTION_LABELS = {
  problem: "这篇论文解决什么问题",
  why_read: "为什么值得读",
  intuition: "方法的核心直觉",
  evidence: "作者提供的主要证据",
  limitations: "局限与待核验内容",
};

function formatFileSize(byteLength) {
  if (!Number.isFinite(byteLength)) return "大小待核验";
  if (byteLength < 1024) return `${byteLength} B`;
  if (byteLength < 1024 * 1024) return `${(byteLength / 1024).toFixed(1)} KB`;
  return `${(byteLength / (1024 * 1024)).toFixed(1)} MB`;
}

function ProposalExactDetails({ proposal }) {
  const metadata = proposal.metadata ?? {};
  const pdf = proposal.pdf ?? {};
  const guide = proposal.guide ?? {};
  const sections = guide.sections ?? {};
  const questions = sections.questions ?? guide.questions ?? [];
  const references = guide.references ?? [];
  const abstract = metadata.abstract ?? metadata.abstract_note ?? metadata.abstractNote;
  const tags = (metadata.tags ?? []).map((tag) => (
    typeof tag === "string" ? tag : tag?.tag
  )).filter(Boolean);
  const extra = metadata.extra;
  const hasExactDetails = proposal.contentHash
    || Object.keys(metadata).length > 0
    || Object.keys(pdf).length > 0
    || Object.keys(guide).length > 0;
  if (!hasExactDetails) return null;

  return (
    <details className="workflow-proposal-exact">
      <summary>查看将写入的完整内容</summary>
      <div>
        <section>
          <h4>规范题录</h4>
          <dl>
            {metadata.item_type || metadata.itemType ? <div><dt>类型</dt><dd>{metadata.item_type ?? metadata.itemType}</dd></div> : null}
            <div><dt>题名</dt><dd>{metadata.title || "待补"}</dd></div>
            <div><dt>作者</dt><dd>{metadata.authors?.join("、") || "待补"}</dd></div>
            <div><dt>来源</dt><dd>{metadata.venue || "待补"}</dd></div>
            <div><dt>日期</dt><dd>{metadata.published_at || metadata.date || "待补"}</dd></div>
            {metadata.doi || metadata.DOI ? <div><dt>DOI</dt><dd>{metadata.doi ?? metadata.DOI}</dd></div> : null}
            {metadata.url ? <div><dt>链接</dt><dd>{metadata.url}</dd></div> : null}
            {abstract ? <div><dt>摘要</dt><dd>{abstract}</dd></div> : null}
            {tags.length > 0 ? <div><dt>标签</dt><dd>{tags.join("、")}</dd></div> : null}
            {extra ? <div><dt>Extra</dt><dd><code>{extra}</code></dd></div> : null}
          </dl>
        </section>
        <section>
          <h4>原版全文文件</h4>
          <dl>
            <div><dt>文件名</dt><dd>{pdf.file_name || "待补"}</dd></div>
            <div><dt>大小</dt><dd>{formatFileSize(pdf.byte_length)}</dd></div>
            <div><dt>校验值</dt><dd><code>{pdf.sha256 || "待核验"}</code></dd></div>
          </dl>
        </section>
        <section>
          <h4>五分钟导读</h4>
          <div className="workflow-proposal-guide">
            {Object.entries(GUIDE_SECTION_LABELS).map(([key, label]) => sections[key] ? (
              <article key={key}><strong>{label}</strong><p>{sections[key]}</p></article>
            ) : null)}
            {questions.length > 0 ? (
              <article><strong>进入精读最值得追问</strong><ol>{questions.map((question) => <li key={question}>{question}</li>)}</ol></article>
            ) : null}
            {references.length > 0 ? (
              <article>
                <strong>证据锚点</strong>
                <ul>{references.map((reference) => (
                  <li key={reference.block_id ?? reference.blockId}>
                    <code>{reference.block_id ?? reference.blockId}</code>
                    {reference.path?.length ? ` · ${reference.path.join(" › ")}` : ""}
                    {reference.excerpt ? <q>{reference.excerpt}</q> : null}
                  </li>
                ))}</ul>
              </article>
            ) : null}
          </div>
        </section>
        {proposal.contentHash && proposal.targetVersionOrHash ? (
          <section>
            <h4>本次确认绑定</h4>
            <dl>
              <div><dt>内容</dt><dd><code>{proposal.contentHash}</code></dd></div>
              <div><dt>目标</dt><dd><code>{proposal.targetVersionOrHash}</code></dd></div>
            </dl>
          </section>
        ) : null}
      </div>
    </details>
  );
}

function ObsidianPreviewSection({
  obsidianUiState,
  onToggleProposal,
  readOnly = false,
}) {
  if (!obsidianUiState || obsidianUiState.status === "not_required") return null;
  if (obsidianUiState.status === "loading") {
    return (
      <div className="workflow-demo-notice" role="status">
        <CircleNotch className="spin" size={18} weight="bold" aria-hidden="true" />
        <div><strong>正在读取 Obsidian 精确预览</strong><p>加载完成后可与其他归档项一起核对和确认。</p></div>
      </div>
    );
  }
  if (obsidianUiState.status === "error") {
    return (
      <div className="workflow-demo-notice is-error" role="alert">
        <WarningCircle size={18} weight="fill" aria-hidden="true" />
        <div><strong>Obsidian 预览不可用</strong><p>{obsidianUiState.error}</p></div>
      </div>
    );
  }
  const preview = obsidianUiState.preview;
  if (!preview) return null;
  return (
    <section className="workflow-proposal-group workflow-obsidian-preview" aria-labelledby="obsidian-preview-title">
      <header>
        <span><NotePencil size={19} aria-hidden="true" /></span>
        <div>
          <h3 id="obsidian-preview-title">Obsidian 精读笔记</h3>
          <p>完整笔记正文、目标文件与内容哈希；只有本次精确预览获批后才会写入。</p>
        </div>
      </header>
      {preview.proposals.map((proposal) => {
        const proposalId = proposal.proposalId ?? proposal.id;
        const inputId = `obsidian-proposal-${proposalId}`;
        return (
        <article className={`workflow-proposal${proposal.selected ? " is-selected" : ""}${proposal.actionable ? "" : " is-blocked"}`} key={proposalId}>
          <input
            id={inputId}
            type="checkbox"
            checked={Boolean(proposal.selected)}
            disabled={readOnly || proposal.actionable === false}
            onChange={() => onToggleProposal?.(proposalId)}
          />
          <label className="workflow-proposal-check" htmlFor={inputId}>
            <span className="workflow-checkbox">
              {proposal.actionable
                ? proposal.selected
                  ? <Check size={13} weight="bold" aria-hidden="true" />
                  : null
                : <WarningCircle size={13} weight="fill" aria-hidden="true" />}
            </span>
            <span className="sr-only">{proposal.selected
              ? "取消这篇 Obsidian 笔记"
              : "选择这篇 Obsidian 笔记"}</span>
          </label>
          <div className="workflow-proposal-copy">
            <div className="workflow-proposal-main">
              <strong>{proposal.title}</strong>
              <small>{proposal.targetLocator}</small>
              <span className="workflow-diff-preview">
                {getProposalPreview(proposal).map((line, index) => (
                  <code key={`${proposal.id}-line-${index}`}>{line}</code>
                ))}
              </span>
            </div>
            {!proposal.actionable ? (
              <span className="workflow-proposal-manual">
                <WarningCircle size={15} aria-hidden="true" />
                目标笔记已经存在；当前版本不会覆盖或追加。
              </span>
            ) : null}
            <details className="workflow-proposal-exact">
              <summary>查看将写入的完整笔记</summary>
              <div>
                <section>
                  <h4>精读笔记全文</h4>
                  <pre className="workflow-markdown-preview">{proposal.markdown}</pre>
                </section>
                <section>
                  <h4>本次预览绑定</h4>
                  <dl>
                    <div><dt>内容</dt><dd><code>{proposal.contentHash}</code></dd></div>
                    <div><dt>目标</dt><dd><code>{proposal.targetVersionOrHash}</code></dd></div>
                  </dl>
                </section>
              </div>
            </details>
          </div>
        </article>
        );
      })}
    </section>
  );
}

function ProjectStatePreviewSection({
  projectStateUiState,
  onToggleProposal,
  readOnly = false,
}) {
  if (!projectStateUiState || projectStateUiState.status === "not_required") return null;
  if (projectStateUiState.status === "loading") {
    return (
      <div className="workflow-demo-notice" role="status">
        <CircleNotch className="spin" size={18} weight="bold" aria-hidden="true" />
        <div><strong>正在读取项目状态精确预览</strong><p>加载完成后可与其他归档项一起核对和确认。</p></div>
      </div>
    );
  }
  if (projectStateUiState.status === "error") {
    return (
      <div className="workflow-demo-notice is-error" role="alert">
        <WarningCircle size={18} weight="fill" aria-hidden="true" />
        <div><strong>项目状态预览不可用</strong><p>{projectStateUiState.error}</p></div>
      </div>
    );
  }
  const preview = projectStateUiState.preview;
  const proposal = preview?.proposal ?? preview?.proposals?.[0] ?? (
    preview?.targetLocator || preview?.target_locator ? preview : null
  );
  if (!proposal) return null;
  const proposalId = proposal.id ?? proposal.proposalId ?? proposal.proposal_id ?? "project-state-preview";
  const diff = proposal.diff ?? {};
  const beforeHash = diff.beforeHash ?? diff.before_hash;
  const afterHash = diff.afterHash ?? diff.after_hash;
  const targetLocator = proposal.targetLocator ?? proposal.target_locator;

  return (
    <section className="workflow-proposal-group workflow-obsidian-preview" aria-labelledby="project-state-preview-title">
      <header>
        <span><FolderOpen size={19} aria-hidden="true" /></span>
        <div>
          <h3 id="project-state-preview-title">项目状态更新</h3>
          <p>只追加下面展示的内容；写入前会重新核验文件版本和预览哈希。</p>
        </div>
      </header>
      <article className={`workflow-proposal${proposal.actionable === false ? " is-blocked" : ""}`}>
        <input
          id={`project-state-proposal-${proposalId}`}
          type="checkbox"
          checked={Boolean(proposal.selected)}
          disabled={readOnly || proposal.actionable === false}
          onChange={() => onToggleProposal?.(proposalId)}
        />
        <label
          className="workflow-proposal-check"
          htmlFor={`project-state-proposal-${proposalId}`}
        >
          <span className="workflow-checkbox">
            {proposal.actionable === false
              ? <WarningCircle size={13} weight="fill" aria-hidden="true" />
              : proposal.selected
                ? <Check size={13} weight="bold" aria-hidden="true" />
                : null}
          </span>
          <span className="sr-only">{proposal.selected
            ? "取消项目状态更新"
            : "选择项目状态更新"}</span>
        </label>
        <div className="workflow-proposal-copy">
          <div className="workflow-proposal-main">
            <strong>{proposal.title ?? proposal.targetDetails?.sourcePath ?? "项目状态更新建议"}</strong>
            <small>{targetLocator}</small>
            <span className="workflow-diff-preview">
              {getProposalPreview(proposal).map((line, index) => (
                <code key={`${proposalId}-line-${index}`}>{line}</code>
              ))}
            </span>
          </div>
          {proposal.actionable === false ? (
            <span className="workflow-proposal-manual">
              <WarningCircle size={15} aria-hidden="true" />
              当前文件状态不允许安全追加；项目文件保持不变。
            </span>
          ) : null}
          <details className="workflow-proposal-exact">
            <summary>查看将追加的完整内容</summary>
            <div>
              <section>
                <h4>拟追加内容</h4>
                <pre className="workflow-markdown-preview">{diff.appendText ?? diff.append_text ?? proposal.markdown}</pre>
              </section>
              <section>
                <h4>本次预览绑定</h4>
                <dl>
                  {beforeHash ? <div><dt>更新前</dt><dd><code>{beforeHash}</code></dd></div> : null}
                  {afterHash ? <div><dt>更新后</dt><dd><code>{afterHash}</code></dd></div> : null}
                  {proposal.contentHash ? <div><dt>追加内容</dt><dd><code>{proposal.contentHash}</code></dd></div> : null}
                </dl>
              </section>
            </div>
          </details>
        </div>
      </article>
    </section>
  );
}

function WorkflowHeader({
  run,
  status,
  statusLabel,
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
  viewStepId,
  availableStepIds,
  onViewStep,
  artifactMode = false,
  hideSteps = false,
}) {
  const activeStepIndex = findStepIndex(status);

  return (
    <header className={`workflow-run-header${artifactMode ? " is-artifact-mode" : ""}`}>
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

          <span className="header-status-inline">
            <span className="status-dot" aria-hidden="true" />
            <span>{statusLabel ?? STATUS_LABELS[status] ?? status}</span>
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

      {!artifactMode && !hideSteps ? (
        <nav className="workflow-step-flow" aria-label="工作流步骤">
          <ol className="workflow-step-list">
            {WORKFLOW_STEPS.map((step, index) => {
              const isAvailable = availableStepIds?.has(step.id) ?? index <= activeStepIndex;
              const isComplete = index < activeStepIndex && isAvailable;
              const isActive = index === activeStepIndex;
              const isViewing = step.id === viewStepId;
              const stateClass = isComplete
                ? "is-complete"
                : isActive
                  ? "is-active"
                  : index < activeStepIndex
                    ? "is-skipped"
                    : "is-pending";
              return (
                <li className={`workflow-step-item ${stateClass}${isViewing ? " is-viewing" : ""}`} key={step.id}>
                  <button
                    className="workflow-step-button"
                    type="button"
                    disabled={!isAvailable || index > activeStepIndex}
                    aria-current={isActive ? "step" : undefined}
                    aria-pressed={isViewing}
                    aria-label={
                      isActive
                        ? `查看当前步骤：${step.label}`
                        : isAvailable && index < activeStepIndex
                          ? `回看已完成步骤：${step.label}`
                          : `${step.label}尚不可查看`
                    }
                    onClick={() => onViewStep?.(step.id)}
                  >
                    <span className="workflow-step-dot" />
                    <span className="workflow-step-name">{step.label}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>
      ) : null}
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

function CandidateReview({
  run,
  papers,
  candidateSummaryState,
  onGenerateCandidateSummaries,
  onTogglePaper,
  onPrepareGuides,
  onSkipRun,
  journalRunState,
  onOpenPaper,
  onStartJournalRun,
  onResumeJournalRun,
  onRetryPaperDocument,
  readOnly = false,
  readOnlyQuiet = false,
}) {
  const selectedPaperIds = run?.selectedPaperIds ?? run?.selected_ids ?? [];
  const displayedPaperIds = new Set(papers.map((paper) => paper.id));
  const selectedCount = selectedPaperIds.filter((paperId) => displayedPaperIds.has(paperId)).length;
  const [expandedEvidenceId, setExpandedEvidenceId] = useState(null);
  const [documentRetryState, setDocumentRetryState] = useState({
    paperId: null,
    errors: {},
  });
  const unavailableGuideCount = papers.filter((paper) => (
    paper.isDemo === false
      ? !run?.selectablePaperIds?.includes(paper.id)
      : !workflowFixture.guides?.[paper.id]
  )).length;
  const liveRun = journalRunState?.run;
  const liveScanStarted = Boolean(liveRun) || ["starting", "running", "ready", "failed", "error"].includes(journalRunState?.status);
  const hasLiveCandidates = Boolean(liveRun?.candidates?.length);
  const hasFixtureCandidates = run?.source === "fixture"
    && papers.some((paper) => paper.isDemo !== false);
  const scanInProgress = ["starting", "running"].includes(journalRunState?.status);
  const scanSummary = liveRun?.scanSummary
    ?? (liveScanStarted || !hasFixtureCandidates ? null : workflowFixture.scanSummary);
  const sourceProgress = liveRun?.sourceProgress;
  const successfulSourceCount = liveRun?.scanSummary?.successful_source_count
    ?? sourceProgress?.successful_source_ids?.length;
  const sourceCount = liveRun?.scanSummary?.source_count ?? sourceProgress?.total_count ?? 11;
  const failedSourceIds = liveRun?.scanSummary?.failed_source_ids ?? sourceProgress?.failed_source_ids ?? [];
  const completedSourceCount = sourceProgress?.completed_source_ids?.length;
  const canResumeMineru = hasLiveCandidates && [
    "not_configured",
    "quota_deferred",
    "failed",
    "unavailable",
  ].includes(liveRun?.mineru?.status);
  const failedGuidePaperIds = new Set(
    (liveRun?.guides?.requestedPaperIds ?? []).filter(
      (paperId) => liveRun?.guides?.papers?.[paperId]?.status === "failed",
    ),
  );
  const failedGuidePapers = papers.filter((paper) => failedGuidePaperIds.has(paper.id));
  const guideFailure = failedGuidePapers.length > 0 || (
    ["failed", "partial"].includes(liveRun?.guides?.status) && Boolean(run?.lastError)
  );
  const guideLengthAdjusted = guideFailure
    && /长度不符合导读合同/.test(run?.lastError ?? "");

  const summarySourceLabel = hasLiveCandidates
    ? `候选说明 · 真实运行${liveRun?.ranking?.source === "model" ? "模型排序" : "确定性回退排序"}`
    : ["error", "failed"].includes(journalRunState?.status)
      ? "真实扫描未完成，没有可供审阅的候选"
    : liveScanStarted
      ? scanInProgress
        ? "真实候选正在准备"
        : "本轮没有可供审阅的候选"
      : !hasFixtureCandidates
        ? "尚未开始真实扫描"
      : candidateSummaryState?.status === "loading"
        ? "候选说明 · 正在检查本地模型服务"
        : candidateSummaryState?.status === "fallback"
          ? "候选说明 · 模型生成失败，已回退到内置说明"
          : candidateSummaryState?.source === "model"
            ? `候选说明 · ${candidateSummaryState.modelId}`
            : candidateSummaryState?.source === "cache"
              ? `候选说明 · ${candidateSummaryState.modelId} 缓存`
              : "候选说明 · 内置说明（未调用模型）";

  const toggleEvidence = (paperId) => {
    setExpandedEvidenceId((current) => current === paperId ? null : paperId);
  };

  const retryPaperDocument = async (paperId) => {
    if (!onRetryPaperDocument || documentRetryState.paperId) return;
    setDocumentRetryState((current) => ({
      paperId,
      errors: { ...current.errors, [paperId]: null },
    }));
    try {
      await onRetryPaperDocument(paperId);
      setDocumentRetryState({ paperId: null, errors: {} });
    } catch {
      setDocumentRetryState((current) => ({
        paperId: null,
        errors: {
          ...current.errors,
          [paperId]: "全文准备仍未完成，请稍后再试。",
        },
      }));
    }
  };

  return (
    <section className="workflow-stage workflow-review-stage" aria-labelledby="review-title">
      <div className="workflow-stage-scroll-area">
        <header className="workflow-stage-heading">
          <div>
            <span className="workflow-stage-label">
              {hasLiveCandidates
                ? "真实扫描结果"
                : scanInProgress
                  ? "本周扫描进行中"
                  : liveScanStarted
                    ? "本周扫描未产生候选"
                    : hasFixtureCandidates
                      ? "本周扫描完成"
                      : "等待开始本周扫描"}
            </span>
            <h2 id="review-title">选择本周要读的论文</h2>
            {scanSummary ? (
              <p className="workflow-scan-summary">
                扫描 <strong>{scanMetric(scanSummary, "raw_record_count", "rawCount", 46)}</strong> 条
                <span aria-hidden="true"> · </span>
                <strong>{scanMetric(scanSummary, "topic_candidate_count", "topicMatchedCount", 18)}</strong> 条主题相关
                <span aria-hidden="true"> · </span>
                <strong>{hasLiveCandidates ? papers.length : scanMetric(scanSummary, "candidate_count", "focusedCount", papers.length)}</strong> 条重点候选
              </p>
            ) : null}
            {liveScanStarted ? (
              <p className="workflow-live-scan-status" role={journalRunState?.error ? "alert" : "status"}>
                {successfulSourceCount !== undefined ? (
                  <>
                    {completedSourceCount !== undefined ? <span>已检查 {completedSourceCount}/{sourceCount}</span> : null}
                    <span>来源成功 {successfulSourceCount}/{sourceCount}</span>
                    <span title={failedSourceIds.join("、")}>失败 {failedSourceIds.length}</span>
                  </>
                ) : <span>来源结果等待汇总</span>}
                {journalRunState?.error ? <span className="is-error">{journalRunState.error}</span> : null}
              </p>
            ) : null}
            <div className="workflow-scan-model-row">
              <p className="workflow-scan-source" role="status">{summarySourceLabel}</p>
              {!readOnly && !liveScanStarted && hasFixtureCandidates ? (
                <button
                  className="workflow-evidence-toggle workflow-model-refresh"
                  type="button"
                  disabled={candidateSummaryState?.status === "loading"}
                  onClick={onGenerateCandidateSummaries}
                >
                  {candidateSummaryState?.status === "loading" ? "生成中" : "用当前模型更新"}
                </button>
              ) : null}
            </div>
          </div>
          {!readOnly ? (
            <button
              className="workflow-secondary-action workflow-scan-action"
              type="button"
              disabled={scanInProgress}
              onClick={canResumeMineru ? onResumeJournalRun : onStartJournalRun}
            >
              {scanInProgress ? <CircleNotch className="spin" size={15} weight="bold" aria-hidden="true" /> : null}
              {scanInProgress ? "扫描中" : canResumeMineru ? "重新准备全文" : "扫描全部来源"}
            </button>
          ) : null}
        </header>

        {papers.length === 0 ? (
          <div className="workflow-empty-candidates" role="status">
            <FileText size={22} aria-hidden="true" />
            <div>
              <strong>当前没有可供审阅的真实候选</strong>
              <p>
                {scanInProgress
                  ? "扫描与筛选仍在进行，完成后会在这里显示结果。"
                  : journalRunState?.error
                    ? "本次真实扫描没有完成。修复连接后重新扫描，不会改用示例论文。"
                    : "运行本周扫描后，候选论文会在这里出现。"}
              </p>
            </div>
          </div>
        ) : null}

        {guideFailure ? (
          <div className="workflow-guide-failure" role="alert">
            <WarningCircle size={20} weight="fill" aria-hidden="true" />
            <div>
              <strong>{guideLengthAdjusted ? "上一次导读过长，已保留选择" : "五分钟导读没有生成成功"}</strong>
              <p>
                {failedGuidePapers.length > 0
                  ? `已保留所选论文：${failedGuidePapers.map((paper) => `《${paper.title}》`).join("、")}。`
                  : "已保留本次选择。"}
                {" "}{guideLengthAdjusted
                  ? "模型结果已经返回；系统现在会自动收敛到展示长度，可以直接重新生成。"
                  : "模型输出格式未通过校验，可以直接重新生成。"}
              </p>
            </div>
          </div>
        ) : null}

        <div className="workflow-candidate-list">
          {papers.map((paper, index) => {
            const selected = selectedPaperIds.includes(paper.id);
            const selectionFull = selectedCount >= 2 && !selected;
            const guideUnavailable = paper.isDemo === false
              ? !run?.selectablePaperIds?.includes(paper.id)
              : !workflowFixture.guides?.[paper.id];
            const evidenceExpanded = expandedEvidenceId === paper.id;
            const mineru = mineruDisplay(paper.mineruStatus, paper.mineruRunStatus);
            const canOpenFullText = paper.isDemo === false && paper.mineruStatus === "ready";
            return (
              <article className={`workflow-candidate${selected ? " is-selected" : ""}`} key={paper.id}>
                <label className="workflow-candidate-select">
                  <input
                    type="checkbox"
                    checked={selected}
                    disabled={readOnly || selectionFull || guideUnavailable}
                    aria-label={readOnly
                      ? `${paper.title}${selected ? "，当时已选择" : "，当时未选择"}`
                      : `${selected ? "取消选择" : "选择"}${paper.title}${guideUnavailable ? "，正文尚未准备完成" : ""}`}
                    title={guideUnavailable ? "正文准备完成后才可生成导读" : undefined}
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
                  {paper.isDemo === false ? (
                    <p className="workflow-paper-status-row">
                      <span className={paper.isNew === false || paper.publishedThisWeek === false ? "is-classic" : "is-new"}>
                        {paper.discoveryType ?? (paper.isNew === false ? "经典回顾 · 非本周新论文" : "本周新论文")}
                      </span>
                      <span className={`is-${mineru.tone}`}>{mineru.label}</span>
                    </p>
                  ) : null}
                  {guideUnavailable ? <p className="workflow-unavailable-note">正文尚未准备完成，暂不能生成导读</p> : null}
                  <dl className="workflow-candidate-summary">
                    <div>
                      <dt>论文讲什么</dt>
                      <dd className="workflow-abstract-copy">{paper.selectionSummary ?? paper.selection_summary ?? paper.abstract}</dd>
                    </div>
                    <div className="is-project-impact">
                      <dt>对项目的作用</dt>
                      <dd className="workflow-relevance-copy">{paper.projectImpact ?? paper.project_impact ?? paper.relevance ?? paper.relevanceReason ?? paper.relevance_reason}</dd>
                    </div>
                  </dl>
                  <div className="workflow-scan-model-row">
                    <button
                      className="workflow-evidence-toggle"
                      type="button"
                      aria-expanded={evidenceExpanded}
                      aria-controls={`${paper.id}-evidence`}
                      onClick={() => toggleEvidence(paper.id)}
                    >
                      {evidenceExpanded ? "收起依据" : "查看依据"}
                    </button>
                    {canOpenFullText ? (
                      <button
                        className="workflow-evidence-toggle"
                        type="button"
                        aria-label={`打开《${paper.title}》全文`}
                        onClick={() => onOpenPaper?.(paper.id)}
                      >
                        打开全文
                      </button>
                    ) : null}
                    {!readOnly && mineru.tone === "failed" && onRetryPaperDocument ? (
                      <button
                        className="workflow-evidence-toggle"
                        type="button"
                        disabled={Boolean(documentRetryState.paperId)}
                        onClick={() => retryPaperDocument(paper.id)}
                      >
                        {documentRetryState.paperId === paper.id
                          ? <CircleNotch className="spin" size={13} weight="bold" aria-hidden="true" />
                          : null}
                        {documentRetryState.paperId === paper.id
                          ? "正在重试"
                          : "重试全文准备"}
                      </button>
                    ) : null}
                  </div>
                  {documentRetryState.errors[paper.id] ? (
                    <p className="workflow-unavailable-note is-error" role="alert">
                      {documentRetryState.errors[paper.id]}
                    </p>
                  ) : null}
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

      {readOnly && readOnlyQuiet ? null : (
        <footer className="workflow-stage-actions">
          {readOnly ? (
            <p>正在回看候选阶段。当时的选择已锁定；这里不会重新扫描、调用模型或改变当前进度。</p>
          ) : (
            <>
              <p>
                已选择 {selectedCount}/2 篇用于生成导读。浏览全文不会改变选择，也不会写入 Zotero。
                {unavailableGuideCount > 0 ? ` 另有 ${unavailableGuideCount} 篇正文尚未准备完成。` : ""}
              </p>
              <div>
                <button className="workflow-secondary-action" type="button" onClick={onSkipRun}>本周不处理</button>
                <button className="workflow-primary-action" type="button" onClick={onPrepareGuides} disabled={selectedCount === 0}>
                  {guideFailure ? "重新生成五分钟导读" : "生成五分钟导读"} <ArrowRight size={15} weight="bold" aria-hidden="true" />
                </button>
              </div>
            </>
          )}
        </footer>
      )}
    </section>
  );
}

function PreparingGuides({ run, selectedPapers, journalRunState }) {
  const activeIndex = run?.source === "live" ? 2 : run?.preparationStep ?? 1;
  const preparationSteps = ["获取论文全文", "解析正文与结构", "生成五分钟导读"];
  const liveGuidePapers = journalRunState?.run?.guides?.papers ?? {};
  const guideStatusLabel = (paperId) => {
    const status = liveGuidePapers[paperId]?.status;
    if (status === "ready") return "导读已准备";
    if (status === "failed") return "导读生成失败";
    if (["generating", "running"].includes(status)) return "正在生成导读";
    return "等待生成";
  };

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
      <div className="workflow-processing-papers" role="status" aria-live="polite">
        {selectedPapers.map((paper) => (
          <span key={paper.id}>
            <FileText size={14} aria-hidden="true" />
            {paper.shortTitle ?? paper.title}
            {run?.source === "live" ? <small>{guideStatusLabel(paper.id)}</small> : null}
          </span>
        ))}
      </div>
    </section>
  );
}

function GuideReady({
  run,
  selectedPapers,
  activePaper,
  guideState,
  onSetActivePaper,
  onPrepareGuides,
  onChooseGuideAction,
  onGeneratePreview,
  onOpenPaper,
  zoteroUiState,
  onSelectZoteroTarget,
  onRetryZoteroTargets,
  readOnly = false,
}) {
  const guideChoices = run?.guideChoices ?? {};
  const liveGuide = activePaper?.isDemo === false
    ? guideState?.byPaperId?.[activePaper.id]
    : null;
  const fixtureGuide = workflowFixture.guides?.[activePaper?.id] ?? {};
  const sections = getGuideSections(activePaper, liveGuide);
  const questions = liveGuide?.questions ?? fixtureGuide.questions ?? [];
  const references = liveGuide?.references ?? [];
  const guideError = guideState?.errorsByPaperId?.[activePaper?.id];
  const guideNeedsChinese = activePaper?.isDemo === false
    && Boolean(liveGuide)
    && !guideUsesChinese(liveGuide);
  const allGuidesDecided = selectedPapers.length > 0 && selectedPapers.every((paper) => Boolean(guideChoices[paper.id]));

  return (
    <section className="workflow-stage workflow-guide-stage" aria-labelledby="guide-title">
      <div className="workflow-stage-scroll-area">
        <PaperTabs papers={selectedPapers} activePaperId={activePaper?.id} onSetActivePaper={onSetActivePaper} />
        <header className="workflow-stage-heading workflow-paper-heading">
          <div>
            <span className="workflow-stage-label">五分钟导读</span>
            <h2 id="guide-title">{activePaper?.title}</h2>
            <p>{activePaper?.venue} · {activePaper?.publishedAt ?? activePaper?.published_at}</p>
          </div>
          <span className="workflow-evidence-badge"><ShieldCheck size={15} aria-hidden="true" />基于已解析全文 · 引用已核验</span>
        </header>

        {activePaper?.isDemo === false && !liveGuide && !guideError ? (
          <div className="workflow-demo-notice" role="status">
            <CircleNotch className="spin" size={18} weight="bold" aria-hidden="true" />
            <div><strong>正在读取五分钟导读</strong><p>导读已生成，正在核对引用段落。</p></div>
          </div>
        ) : null}
        {guideError ? (
          <div className="workflow-demo-notice is-error" role="alert">
            <WarningCircle size={18} aria-hidden="true" />
            <div><strong>导读暂时无法读取</strong><p>{guideError}</p></div>
          </div>
        ) : null}
        {guideNeedsChinese ? (
          <div className="workflow-demo-notice" role="status">
            <Info size={18} aria-hidden="true" />
            <div>
              <strong>这是一份旧版英文导读</strong>
              <p>它不会作为正式结果继续流转。重新生成后，导读正文和追问都会使用简体中文。</p>
            </div>
          </div>
        ) : null}
        {!guideNeedsChinese && sections.length > 0 ? (
          <div className="workflow-guide-grid">
            {sections.map(([title, content]) => (
              <article className="workflow-guide-section" key={title}>
                <h3>{title}</h3>
                {Array.isArray(content) ? <ul>{content.map((item) => <li key={item}>{item}</li>)}</ul> : <p>{content}</p>}
              </article>
            ))}
          </div>
        ) : null}

        {activePaper?.isDemo === false && activePaper?.projectImpact ? (
          <aside className="workflow-demo-notice">
            <Info size={18} aria-hidden="true" />
            <div>
              <strong>候选阶段判断 · 基于题录与摘要</strong>
              <p>{activePaper.projectImpact}</p>
            </div>
          </aside>
        ) : null}

        {references.length > 0 ? (
          <aside className="workflow-reading-questions workflow-guide-references">
            <Quotes size={20} weight="fill" aria-hidden="true" />
            <div>
              <strong>导读引用原文 · 点击查看完整段落</strong>
              <ol>
                {references.map((reference) => (
                  <li key={reference.blockId}>
                    <button
                      type="button"
                      aria-label={`查看《${activePaper?.title}》${reference.path?.join("，") || "正文"}引用原文`}
                      onClick={() => onOpenPaper?.(activePaper?.id, reference.blockId)}
                    >
                      {reference.path?.slice(-2).join(" › ") || `第 ${reference.ordinal} 段`}
                      <PaperRichText content={reference.excerpt} inline />
                    </button>
                  </li>
                ))}
              </ol>
            </div>
          </aside>
        ) : null}

        {!guideNeedsChinese && questions.length > 0 ? (
          <aside className="workflow-reading-questions">
            <Quotes size={20} weight="fill" aria-hidden="true" />
            <div><strong>进入精读最值得追问</strong><ol>{questions.map((question) => <li key={question}>{question}</li>)}</ol></div>
          </aside>
        ) : null}

      </div>

      <footer className="workflow-stage-actions workflow-guide-actions">
        {readOnly ? (
          <p>正在回看五分钟导读。引用和正文仍可查看；重新生成与阅读决定已锁定，不会改变当前进度。</p>
        ) : (
          <>
            <p>
              {guideNeedsChinese
                ? "重新生成会调用当前所选模型；旧产物会保留来源记录，但不会被复用。"
                : allGuidesDecided && run?.source === "live"
                ? "本轮阅读决定已记录。真正写入 Zotero 前仍会展示精确预览并再次确认。"
                : guideChoices[activePaper?.id]
                  ? `已选择：${guideChoices[activePaper.id] === "read" ? "进入精读" : "只收藏导读"}`
                  : "先决定这篇论文是否值得进入精读。"}
            </p>
            <div>
              {guideNeedsChinese ? (
                <button className="workflow-primary-action" type="button" onClick={onPrepareGuides}>
                  重新生成中文导读 <ArrowRight size={15} weight="bold" aria-hidden="true" />
                </button>
              ) : allGuidesDecided && run?.source === "live" ? (
                <span className="workflow-zotero-target-status" role="status">
                  <CircleNotch className="spin" size={15} weight="bold" aria-hidden="true" />
                  正在进入下一步
                </span>
              ) : allGuidesDecided ? (
                <>
                  <button className="workflow-secondary-action" type="button" onClick={() => onChooseGuideAction?.(activePaper?.id, "read")}>
                    <BookOpen size={16} aria-hidden="true" />改为精读
                  </button>
                  <button className="workflow-primary-action" type="button" onClick={onGeneratePreview}>
                    生成写入预览 <ArrowRight size={15} weight="bold" aria-hidden="true" />
                  </button>
                </>
              ) : liveGuide || activePaper?.isDemo !== false ? (
                <>
                  <button className="workflow-secondary-action" type="button" onClick={() => onChooseGuideAction?.(activePaper?.id, "collect")}>
                    <BookmarkSimple size={16} aria-hidden="true" />只收藏导读
                  </button>
                  <button className="workflow-primary-action" type="button" onClick={() => onChooseGuideAction?.(activePaper?.id, "read")}>
                    <BookOpen size={16} weight="bold" aria-hidden="true" />进入论文研读
                  </button>
                </>
              ) : null}
            </div>
          </>
        )}
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
  zoteroUiState,
  onSelectZoteroTarget,
  onRetryZoteroTargets,
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
          <span className="workflow-stage-label">研读整理</span>
          <h2 id="reading-title">{activePaper?.title}</h2>
          <p>本阶段只聚焦所需的章节与证据片段。</p>
        </div>
      </header>

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
          <ArrowLeft size={15} weight="bold" aria-hidden="true" />上一项
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
            继续整理 <ArrowRight size={15} weight="bold" aria-hidden="true" />
          </button>
        )}
      </footer>
    </section>
  );
}

function LiveReadingStage({
  run,
  selectedPapers,
  onOpenCloseReading,
  onRestartFromGuide,
  readOnly = false,
}) {
  const completedCount = selectedPapers.filter(
    (paper) => run?.readingStatusByPaperId?.[paper.id] === "complete",
  ).length;
  return (
    <section className="workflow-stage workflow-reading-library" aria-labelledby="live-reading-title">
      <header className="workflow-stage-heading">
        <div>
          <span className="workflow-stage-label">{readOnly ? "阅读记录 · 历史回看" : "本轮论文"}</span>
          <h2 id="live-reading-title">{readOnly ? "查看本轮阅读完成情况" : "选择一篇论文继续阅读"}</h2>
          <p>
            {readOnly
              ? "这里只展示当时的阅读覆盖，不会重新调用模型。"
              : "打开后会直接回到上次位置。正文、论文 Agent 与阅读笔记会一起恢复。"}
          </p>
        </div>
        <span className="workflow-evidence-badge">
          <CheckCircle size={15} weight="fill" aria-hidden="true" />
          {completedCount}/{selectedPapers.length} 篇已整理
        </span>
      </header>
      <div className="workflow-reading-paper-list">
        {selectedPapers.map((paper) => {
          const status = run?.readingStatusByPaperId?.[paper.id] ?? "not_started";
          return (
            <article key={paper.id}>
              <div>
                {status === "complete"
                  ? <CheckCircle size={17} weight="fill" aria-hidden="true" />
                  : <BookOpen size={17} aria-hidden="true" />}
                <p>
                  <strong>{paper.title}</strong>
                  <span>{paper.venue} · {status === "complete" ? "阅读成果已整理" : "可继续阅读全文"}</span>
                </p>
              </div>
              {!readOnly ? (
                <button type="button" onClick={() => onOpenCloseReading?.(paper.id)}>
                  {status === "complete" ? "打开工作台" : "继续阅读"}
                  <ArrowRight size={15} weight="bold" aria-hidden="true" />
                </button>
              ) : null}
            </article>
          );
        })}
      </div>
      {!readOnly && onRestartFromGuide ? (
        <footer className="workflow-reading-restart">
          <span>
            想清除本轮未完成的阅读，再从导读开始？
            <small>候选、正文和五分钟导读会保留；研读结论、位置、追问与未写入提案会清除。</small>
          </span>
          <button type="button" onClick={onRestartFromGuide}>
            <ArrowLeft size={15} weight="bold" aria-hidden="true" />
            从导读重新开始
          </button>
        </footer>
      ) : null}
    </section>
  );
}

function RunRestoreState({ status, error, onRetry }) {
  const failed = status === "error";
  return (
    <section className={`workflow-stage workflow-restore-state${failed ? " is-error" : ""}`}>
      {failed
        ? <WarningCircle size={28} weight="fill" aria-hidden="true" />
        : <CircleNotch className="spin" size={28} weight="bold" aria-hidden="true" />}
      <div>
        <span className="workflow-stage-label">{failed ? "连接暂时中断" : "恢复阅读现场"}</span>
        <h2>{failed ? "暂时无法连接本地工作流服务" : "正在恢复上次 Run 与论文正文"}</h2>
        <p>
          {failed
            ? error || "上次阅读进度仍然保留；重新连接后会回到原来的论文和段落。"
            : "正在读取真实的论文、导读和阅读位置，不会先显示一个空的阅读列表。"}
        </p>
      </div>
      {failed ? (
        <button className="workflow-primary-action" type="button" onClick={onRetry}>
          <ArrowRight size={15} weight="bold" aria-hidden="true" />
          重新连接
        </button>
      ) : null}
    </section>
  );
}

export function RestartReadingDialog({ pending, error, onCancel, onConfirm }) {
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) onCancel();
      }}
    >
      <section
        className="restart-reading-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="restart-reading-title"
      >
        <header>
          <span><BookOpen size={20} aria-hidden="true" /></span>
          <div>
            <h2 id="restart-reading-title">从导读重新开始？</h2>
            <p>这是一次重置操作。完成后会回到本周推荐文章列表。</p>
          </div>
        </header>
        <div className="restart-reading-scope">
          <article>
            <CheckCircle size={16} weight="fill" aria-hidden="true" />
            <span><strong>继续保留</strong><small>候选论文、已解析正文与五分钟导读</small></span>
          </article>
          <article>
            <WarningCircle size={16} weight="fill" aria-hidden="true" />
            <span><strong>重新开始</strong><small>研读结论、阅读位置、追问、论文 Agent 对话与未写入提案</small></span>
          </article>
        </div>
        <p className="restart-reading-note">
          如果归档预览、外部写入或已确认的 Agent 笔记已经发生，系统会阻止这次重置。
        </p>
        {error ? <p className="restart-reading-error" role="alert">{error}</p> : null}
        <footer>
          <button type="button" disabled={pending} onClick={onCancel}>取消</button>
          <button className="is-primary" type="button" disabled={pending} onClick={onConfirm}>
            {pending ? <CircleNotch className="spin" size={15} aria-hidden="true" /> : null}
            {pending ? "正在重新开始…" : "确认重新开始"}
          </button>
        </footer>
      </section>
    </div>
  );
}

function ArchiveReadyStage({
  run,
  selectedPapers,
  zoteroUiState,
  obsidianUiState,
  projectStateUiState,
  onSelectZoteroTarget,
  onRetryZoteroTargets,
  onGeneratePreview,
}) {
  const readingPapers = selectedPapers.filter(
    (paper) => run?.guideChoices?.[paper.id] === "read",
  );
  const previewPending = zoteroUiState?.proposalPending
    || obsidianUiState?.status === "loading"
    || projectStateUiState?.status === "loading";
  return (
    <section className="workflow-stage workflow-result-stage" aria-labelledby="archive-ready-title">
      <span className="workflow-stage-label">阅读成果待归档</span>
      <h2 id="archive-ready-title">阅读阶段已完成，先核对归档目标</h2>
      <p>这里只准备精确预览；在你确认具体内容之前，不会写入外部位置。</p>
      <div className="workflow-processing-papers">
        {selectedPapers.map((paper) => (
          <span key={paper.id}>
            <CheckCircle size={15} weight="fill" aria-hidden="true" />
            {paper.shortTitle ?? paper.title}
            <small>
              {run?.guideChoices?.[paper.id] === "read" ? "研读成果已准备" : "保留五分钟导读"}
            </small>
          </span>
        ))}
      </div>
      {readingPapers.length > 0 ? (
        <section className="workflow-zotero-target workflow-obsidian-target" aria-labelledby="archive-obsidian-target-title">
          <div>
            <NotePencil size={18} aria-hidden="true" />
            <span>
              <strong id="archive-obsidian-target-title">Obsidian 精读笔记</strong>
              <small>每篇精读论文生成一份完整笔记；目标目录只由本地配置决定。</small>
            </span>
          </div>
          <span className="workflow-zotero-target-status">
            {obsidianUiState?.status === "loading"
              ? <><CircleNotch className="spin" size={15} weight="bold" aria-hidden="true" />正在生成精确预览</>
              : obsidianUiState?.status === "ready"
                ? <><CheckCircle size={15} weight="fill" aria-hidden="true" />精确预览已准备</>
                : "将在下一步生成，不会直接写入"}
          </span>
          {obsidianUiState?.error ? <p role="alert">{obsidianUiState.error}</p> : null}
        </section>
      ) : null}
      {readingPapers.length > 0 ? (
        <section className="workflow-zotero-target" aria-labelledby="archive-project-state-target-title">
          <div>
            <FolderOpen size={18} aria-hidden="true" />
            <span>
              <strong id="archive-project-state-target-title">项目状态更新建议</strong>
              <small>只追加已确认的项目影响、开放问题与下一步；目标文件由项目配置决定。</small>
            </span>
          </div>
          <span className="workflow-zotero-target-status">
            {projectStateUiState?.status === "loading"
              ? <><CircleNotch className="spin" size={15} weight="bold" aria-hidden="true" />正在生成精确追加预览</>
              : projectStateUiState?.status === "ready"
                ? <><CheckCircle size={15} weight="fill" aria-hidden="true" />精确追加预览已准备</>
                : projectStateUiState?.status === "not_required"
                  ? <><CheckCircle size={15} weight="fill" aria-hidden="true" />本轮无需更新</>
                  : "将在下一步生成，不会直接写入"}
          </span>
          {projectStateUiState?.error ? <p role="alert">{projectStateUiState.error}</p> : null}
        </section>
      ) : null}
      <section className="workflow-zotero-target" aria-labelledby="archive-zotero-target-title">
        <div>
          <BookmarkSimple size={18} aria-hidden="true" />
          <span>
            <strong id="archive-zotero-target-title">Zotero collection</strong>
            <small>题录、原始论文和五分钟导读将进入这里。</small>
          </span>
        </div>
        <ZoteroRecoveryTarget
          zoteroUiState={zoteroUiState}
          onSelectZoteroTarget={onSelectZoteroTarget}
          onRetryZoteroTargets={onRetryZoteroTargets}
        />
        {zoteroUiState?.error ? <p role="alert">{zoteroUiState.error}</p> : null}
      </section>
      <footer className="workflow-stage-actions">
        <p>下一步会逐篇展示题录、原始论文、导读和目标位置。</p>
        <button
          className="workflow-primary-action"
          type="button"
          disabled={
            zoteroUiState?.targetStatus !== "ready"
            || !zoteroUiState?.selectedTargetId
            || previewPending
          }
          onClick={onGeneratePreview}
        >
          {previewPending
            ? <><CircleNotch className="spin" size={15} weight="bold" aria-hidden="true" />正在生成预览</>
            : <>生成归档精确预览 <ArrowRight size={15} weight="bold" aria-hidden="true" /></>}
        </button>
      </footer>
    </section>
  );
}

function ZoteroRecoveryTarget({
  zoteroUiState,
  onSelectZoteroTarget,
  onRetryZoteroTargets,
}) {
  if (zoteroUiState?.targetStatus === "loading") {
    return (
      <span className="workflow-zotero-target-status" role="status">
        <CircleNotch className="spin" size={15} weight="bold" aria-hidden="true" />
        正在重新读取 collection
      </span>
    );
  }
  if (zoteroUiState?.targetStatus === "error") {
    return (
      <button className="workflow-secondary-action" type="button" onClick={onRetryZoteroTargets}>
        重新读取 collection
      </button>
    );
  }
  return (
    <label>
      <span>Zotero 目标</span>
      <select
        value={zoteroUiState?.selectedTargetId ?? ""}
        onChange={(event) => onSelectZoteroTarget?.(event.target.value)}
      >
        <option value="">请选择 collection</option>
        {(zoteroUiState?.targets ?? []).map((target) => (
          <option value={target.id} disabled={!target.editable || !target.filesEditable} key={target.id}>
            {formatZoteroTarget(target)}
            {!target.editable || !target.filesEditable ? "（不可写）" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

function ReadingLinks({ papers, onOpenPaper }) {
  if (papers.length === 0) return null;
  return (
    <div className="workflow-completion-summary">
      {papers.map((paper) => (
        <button className="workflow-secondary-action" type="button" onClick={() => onOpenPaper?.(paper.id)} key={paper.id}>
          <BookOpen size={16} aria-hidden="true" />
          继续阅读全文：{paper.shortTitle ?? paper.title}
        </button>
      ))}
    </div>
  );
}

function ApprovalStage({
  run,
  proposals,
  readingPapers,
  onOpenPaper,
  onToggleProposal,
  onCommit,
  onRegeneratePreview,
  zoteroUiState,
  obsidianUiState,
  projectStateUiState,
  onToggleObsidianProposal,
  onToggleProjectStateProposal,
  onSelectZoteroTarget,
  onRetryZoteroTargets,
  readOnly = false,
}) {
  const [simulateObsidianFailure, setSimulateObsidianFailure] = useState(false);
  const displayedProposals = proposals.filter((proposal) => (proposal.paperIds ?? []).length > 0);
  const actionableProposals = displayedProposals.filter((proposal) => (
    proposal.actionable !== false
    && ["draft", "failed"].includes(proposal.status)
  ));
  const manualOnly = displayedProposals.length > 0 && actionableProposals.length === 0;
  const duplicateOnly = manualOnly && displayedProposals.every((proposal) => (
    proposal.status === "blocked" || proposal.writeMode === "manual_update_required"
  ));
  const selectedZoteroCount = actionableProposals.filter((proposal) => proposal.selected).length;
  const actionableObsidianProposals = (obsidianUiState?.preview?.proposals ?? [])
    .filter((proposal) => proposal.actionable !== false);
  const selectedObsidianCount = actionableObsidianProposals
    .filter((proposal) => proposal.selected !== false).length;
  const projectStateProposal = projectStateUiState?.preview?.proposal
    ?? projectStateUiState?.preview?.proposals?.[0]
    ?? null;
  const selectedProjectStateCount = projectStateProposal?.actionable !== false
    && projectStateProposal
    && projectStateProposal.selected !== false
    ? 1
    : 0;
  const selectedCount = selectedZoteroCount + selectedObsidianCount + selectedProjectStateCount;
  const actionableCount = actionableProposals.length
    + actionableObsidianProposals.length
    + (
      projectStateProposal?.actionable !== false && projectStateProposal
        ? 1
        : 0
    );
  const hasArchiveWrites = selectedCount > 0;
  const targetPath = [
    selectedObsidianCount > 0 ? "Obsidian" : null,
    selectedZoteroCount > 0 ? "Zotero" : null,
    selectedProjectStateCount > 0 ? "项目状态" : null,
  ].filter(Boolean).join(" → ");

  return (
    <section className="workflow-stage workflow-approval-stage" aria-labelledby="approval-title">
      <header className="workflow-stage-heading">
        <div>
          <span className="workflow-stage-label">{readOnly
            ? "归档预览 · 历史回看"
            : manualOnly && !hasArchiveWrites
              ? duplicateOnly ? "Zotero 已有匹配条目" : "自动写入已停止"
              : "内联确认 · 最后一步"}</span>
          <h2 id="approval-title">{readOnly
            ? "查看当时核对过的确切内容"
            : manualOnly && !hasArchiveWrites
              ? "当前没有可安全自动写入的内容"
              : "检查准备写入的确切内容"}</h2>
          <p>{readOnly
            ? "这是只读快照；提案选择、重新生成、提交与重试都不会在回看时开放。"
            : manualOnly && !hasArchiveWrites
            ? duplicateOnly
              ? "下面保留完整预览供你核对；Pi Agent 不会移动或修改现有条目。"
              : "下面保留失败原因和精确预览；请先人工检查，再重新读取 Zotero 状态。"
            : "可逐项取消，最后只确认一次。预览内容改变后，本次批准会失效。"}</p>
        </div>
        {!readOnly ? <span className="workflow-selected-count">待写入 {selectedCount}/{actionableCount}</span> : null}
      </header>

      <div className={`workflow-demo-notice${!readOnly && manualOnly && !hasArchiveWrites ? " is-error" : ""}`} role="note">
        {readOnly
          ? <ShieldCheck size={18} weight="fill" aria-hidden="true" />
          : manualOnly && !hasArchiveWrites
          ? <WarningCircle size={18} weight="fill" aria-hidden="true" />
          : <Info size={18} weight="fill" aria-hidden="true" />}
        <div>
          <strong>{readOnly
            ? "回看不会改变真实 Run"
            : manualOnly && !hasArchiveWrites ? "需要人工检查后再继续" : "确认后才会写入"}</strong>
          <p>{readOnly
            ? "你可以展开完整内容核对，但这里的所有写操作都已锁定。"
            : manualOnly && !hasArchiveWrites
            ? duplicateOnly
              ? "当前版本不会自动更新已有条目的原始论文、导读或 collection，也不会把浏览行为视为写入授权。"
              : "不可安全重试的失败不会自动再次提交；重新检查只生成新预览，仍需再次确认。"
            : `只写入下面已勾选的项，按 ${targetPath || "所选目标"} 顺序提交；任一步失败可单独重试，不影响已成功项。`}</p>
        </div>
      </div>

      <ObsidianPreviewSection
        obsidianUiState={obsidianUiState}
        onToggleProposal={onToggleObsidianProposal}
        readOnly={readOnly}
      />
      <ProjectStatePreviewSection
        projectStateUiState={projectStateUiState}
        onToggleProposal={onToggleProjectStateProposal}
        readOnly={readOnly}
      />

      <div className="workflow-proposal-groups">
        {Object.entries(TARGET_META).map(([target, meta]) => {
          const targetProposals = displayedProposals.filter((proposal) => proposal.target === target);
          if (targetProposals.length === 0) return null;
          const TargetIcon = meta.icon;
          return (
            <section className="workflow-proposal-group" key={target}>
              <header>
                <span><TargetIcon size={19} weight="regular" aria-hidden="true" /></span>
                <div><h3>{meta.label}</h3><p>{meta.description}</p></div>
              </header>
              {targetProposals.map((proposal) => {
                const proposalId = proposal.id ?? proposal.proposal_id;
                const inputId = `proposal-${proposalId}`;
                const blocked = proposal.actionable === false;
                const alreadyCommitted = proposal.status === "committed";
                return (
                <article className={`workflow-proposal${proposal.selected ? " is-selected" : ""}${blocked ? " is-blocked" : ""}`} key={proposalId}>
                  <input id={inputId} type="checkbox" checked={Boolean(proposal.selected)} disabled={readOnly || blocked || alreadyCommitted} onChange={() => onToggleProposal?.(proposalId)} />
                  <label className="workflow-proposal-check" htmlFor={inputId}>
                    <span className="workflow-checkbox">{proposal.selected ? <Check size={13} weight="bold" aria-hidden="true" /> : null}</span>
                    <span className="sr-only">{blocked ? "此项需要手工处理" : proposal.selected ? "取消这篇论文" : "选择这篇论文"}</span>
                  </label>
                  <div className="workflow-proposal-copy">
                    <label className="workflow-proposal-main" htmlFor={inputId}>
                      <strong>{proposal.title ?? proposal.operationLabel ?? proposal.operation ?? "准备写入内容"}</strong>
                      <small>{proposal.targetLabel ?? proposal.targetLocator ?? proposal.target_locator}</small>
                      <span className="workflow-diff-preview">{getProposalPreview(proposal).map((line, index) => <code key={`${proposalId}-line-${index}`}>{line}</code>)}</span>
                    </label>
                    {blocked ? (
                      <span className="workflow-proposal-manual">
                        <WarningCircle size={15} aria-hidden="true" />
                        需在 Zotero 手工处理；本轮不会自动改动现有条目。
                      </span>
                    ) : null}
                    {alreadyCommitted ? (
                      <span className="workflow-proposal-manual">
                        <CheckCircle size={15} aria-hidden="true" />
                        已写入并读回核验；本次恢复不会重复执行。
                      </span>
                    ) : null}
                    <ProposalExactDetails proposal={proposal} />
                  </div>
                </article>
                );
              })}
            </section>
          );
        })}
      </div>

      {manualOnly && !readOnly ? (
        <div className="workflow-zotero-target">
          <div>
            <BookmarkSimple size={18} aria-hidden="true" />
            <span><strong>重新检查 Zotero</strong><small>人工处理后可重新查重并生成一份新的精确预览。</small></span>
          </div>
          <ZoteroRecoveryTarget
            zoteroUiState={zoteroUiState}
            onSelectZoteroTarget={onSelectZoteroTarget}
            onRetryZoteroTargets={onRetryZoteroTargets}
          />
        </div>
      ) : null}

      <ReadingLinks papers={readingPapers} onOpenPaper={onOpenPaper} />

      {!readOnly && selectedObsidianCount > 0 ? (
        <label className="workflow-failure-toggle">
          <input type="checkbox" checked={simulateObsidianFailure} onChange={(event) => setSimulateObsidianFailure(event.target.checked)} />
          <span><WarningCircle size={16} aria-hidden="true" /><strong>模拟 Obsidian 写入失败</strong><small>用于验证失败后只重试失败项，不会重复创建 Zotero 条目。</small></span>
        </label>
      ) : null}

      {zoteroUiState?.error ? (
        <div className="workflow-demo-notice is-error" role="alert">
          <WarningCircle size={18} aria-hidden="true" />
          <div><strong>暂时无法提交</strong><p>{zoteroUiState.error}</p></div>
        </div>
      ) : null}

      <footer className="workflow-stage-actions workflow-confirm-actions">
        {readOnly ? (
          <p><ShieldCheck size={16} aria-hidden="true" />正在回看预览阶段；当前 Run 与所有外部目标保持不变。</p>
        ) : (
          <>
            <p><ShieldCheck size={16} aria-hidden="true" />{manualOnly && !hasArchiveWrites
                ? "没有可提交的自动写入项；现有 Zotero 数据保持不变。"
                : `本次批准只绑定当前 ${selectedCount} 项内容及其预览哈希；写后逐项读回核验。`}</p>
            <button
              className="workflow-primary-action"
              type="button"
              disabled={manualOnly && !hasArchiveWrites
                ? (
                    zoteroUiState?.targetStatus !== "ready"
                    || !zoteroUiState?.selectedTargetId
                    || zoteroUiState?.proposalPending
                  )
                : !hasArchiveWrites || zoteroUiState?.commitPending}
              onClick={manualOnly && !hasArchiveWrites
                ? onRegeneratePreview
                : () => onCommit?.({ simulateObsidianFailure })}
            >
              {manualOnly && !hasArchiveWrites && zoteroUiState?.proposalPending
                ? <><CircleNotch className="spin" size={15} weight="bold" aria-hidden="true" />正在重新检查</>
                : zoteroUiState?.commitPending
                ? <><CircleNotch className="spin" size={15} weight="bold" aria-hidden="true" />正在提交确认</>
                : manualOnly && !hasArchiveWrites
                  ? <>重新检查并生成新预览</>
                  : <><Check size={15} weight="bold" aria-hidden="true" />确认写入所选内容</>}
            </button>
          </>
        )}
      </footer>
    </section>
  );
}

function CommittingStage({ run, proposals, recoveryError, onResume }) {
  const targets = [...new Set(proposals.filter((proposal) => proposal.selected).map((proposal) => proposal.target))];
  const activeTarget = proposals.find((proposal) => proposal.status === "committing")?.target
    ?? (run?.isRetrying ? proposals.find((proposal) => proposal.status === "failed")?.target : null)
    ?? targets[0]
    ?? "zotero";
  const activeIndex = targets.indexOf(activeTarget);

  return (
    <section className="workflow-stage workflow-progress-stage" aria-labelledby="committing-title">
      <CircleNotch className="spin" size={30} weight="bold" aria-hidden="true" />
      <span className="workflow-stage-label">{run?.isRetrying ? "从失败节点继续" : "顺序提交并逐项核验"}</span>
      <h2 id="committing-title">{run?.isRetrying ? `正在只重试 ${TARGET_META[activeTarget]?.label ?? "失败项"}` : "正在写入所选内容"}</h2>
      <p>成功项会立即记录外部 ID；后续失败时不会自动回滚或重复创建。</p>
      {recoveryError ? (
        <div className="workflow-demo-notice is-error" role="alert">
          <WarningCircle size={18} aria-hidden="true" />
          <div><strong>恢复提交状态失败</strong><p>{recoveryError}</p></div>
          <button className="workflow-secondary-action" type="button" onClick={onResume}>重新恢复</button>
        </div>
      ) : null}
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
      {proposals.filter((proposal) => proposal.selected || ["committed", "failed", "blocked"].includes(proposal.status)).map((proposal) => {
        const success = proposal.status === "committed";
        return (
          <article className={success ? "is-success" : "is-failed"} key={proposal.id ?? proposal.proposal_id}>
            {success ? <CheckCircle size={20} weight="fill" aria-hidden="true" /> : <XCircle size={20} weight="fill" aria-hidden="true" />}
            <div>
              <strong>{TARGET_META[proposal.target]?.label} · {proposal.title ?? proposal.operation ?? "写入内容"}</strong>
              <p>{success
                ? proposal.verificationResult
                  ?? proposal.verification_result
                  ?? "写入完成；未提供更细的读回核验范围"
                : proposal.error ?? "写入失败，原目标保持不变"}</p>
              {proposal.externalId ?? proposal.external_id ? <small>外部 ID：{proposal.externalId ?? proposal.external_id}</small> : null}
            </div>
          </article>
        );
      })}
    </div>
  );
}

function PartialStage({
  proposals,
  readingPapers,
  onOpenPaper,
  onRetryFailed,
  onRegeneratePreview,
  zoteroUiState,
  onSelectZoteroTarget,
  onRetryZoteroTargets,
}) {
  const failedProposals = proposals.filter((proposal) => proposal.status === "failed");
  const retryableCount = failedProposals.filter((proposal) => (
    proposal.retryable !== false && proposal.actionable !== false
  )).length;
  const manualProposals = proposals.filter((proposal) => (
    proposal.status === "blocked"
    || proposal.writeMode === "manual_update_required"
    || (proposal.status === "failed" && proposal.actionable === false)
    || (proposal.status === "failed" && proposal.retryable === false)
  ));
  const manualCount = manualProposals.length;
  return (
    <section className="workflow-stage workflow-result-stage is-partial" aria-labelledby="partial-title">
      <WarningCircle size={34} weight="fill" aria-hidden="true" />
      <span className="workflow-stage-label">部分写入失败</span>
      <h2 id="partial-title">
        {retryableCount > 0
          ? `成功项已保留，可重试 ${retryableCount} 个失败项`
          : "成功项已保留，剩余项目需要人工处理"}
      </h2>
      <p>不会回滚已成功内容，也不会再次创建已经核验的 Zotero 条目。</p>
      <ResultList proposals={proposals} />
      {manualCount > 0 ? (
        <div className="workflow-demo-notice is-error" role="note">
          <WarningCircle size={18} aria-hidden="true" />
          <div><strong>需要在 Zotero 手工修复 {manualCount} 项</strong><p>这类错误不能安全自动重试；修复后请重新生成精确预览。</p></div>
        </div>
      ) : null}
      <ReadingLinks papers={readingPapers} onOpenPaper={onOpenPaper} />
      {manualCount > 0 ? (
        <div className="workflow-zotero-target">
          <div>
            <BookmarkSimple size={18} aria-hidden="true" />
            <span><strong>重新检查 Zotero</strong><small>人工处理后重新查重；已核验成功项使用稳定操作标识，不会重复创建。</small></span>
          </div>
          <ZoteroRecoveryTarget
            zoteroUiState={zoteroUiState}
            onSelectZoteroTarget={onSelectZoteroTarget}
            onRetryZoteroTargets={onRetryZoteroTargets}
          />
        </div>
      ) : null}
      {zoteroUiState?.error ? (
        <div className="workflow-demo-notice is-error" role="alert">
          <WarningCircle size={18} aria-hidden="true" />
          <div><strong>暂时无法重试</strong><p>{zoteroUiState.error}</p></div>
        </div>
      ) : null}
      <footer className="workflow-stage-actions">
        <p>{retryableCount > 0 ? "重试会从可安全恢复的失败项继续，并再次核验目标版本。" : "请先完成 Zotero 中的人工修复，再重新生成预览。"}</p>
        <div>
          {retryableCount > 0 ? (
            <button className="workflow-primary-action" type="button" disabled={zoteroUiState?.commitPending} onClick={onRetryFailed}>
              {zoteroUiState?.commitPending
                ? <><CircleNotch className="spin" size={15} weight="bold" aria-hidden="true" />正在重试失败项</>
                : <>只重试可恢复项 <ArrowRight size={15} weight="bold" aria-hidden="true" /></>}
            </button>
          ) : null}
          {manualCount > 0 ? (
            <button
              className="workflow-secondary-action"
              type="button"
              disabled={
                zoteroUiState?.targetStatus !== "ready"
                || !zoteroUiState?.selectedTargetId
                || zoteroUiState?.proposalPending
              }
              onClick={onRegeneratePreview}
            >
              {zoteroUiState?.proposalPending ? "正在重新检查" : "重新检查并生成新预览"}
            </button>
          ) : null}
        </div>
      </footer>
    </section>
  );
}

function CompletedStage({ proposals, onReset }) {
  const committedProposals = proposals.filter((proposal) => proposal.status === "committed");
  return (
    <section className="workflow-stage workflow-result-stage is-complete" aria-labelledby="completed-title">
      <CheckCircle size={36} weight="fill" aria-hidden="true" />
      <span className="workflow-stage-label">本轮运行已完成</span>
      <h2 id="completed-title">所选论文成果已完成归档</h2>
      <p>只执行了预览中被选择的目标；未选择的外部位置保持不变。</p>
      <ResultList proposals={proposals} />
      <div className="workflow-completion-summary">
        {committedProposals.map((proposal) => {
          const meta = TARGET_META[proposal.target] ?? TARGET_META.project_state;
          const Icon = meta.icon;
          return <span key={proposal.id}><Icon size={16} aria-hidden="true" />{meta.description}</span>;
        })}
      </div>
      {onReset ? <button className="workflow-secondary-action" type="button" onClick={onReset}>重新运行本周 Run</button> : null}
    </section>
  );
}

function ReadingReadyStage({ proposals, readingPapers, onOpenPaper }) {
  return (
    <section className="workflow-stage workflow-result-stage is-complete" aria-labelledby="reading-ready-title">
      <WarningCircle size={36} weight="fill" aria-hidden="true" />
      <span className="workflow-stage-label">旧版运行状态</span>
      <h2 id="reading-ready-title">这轮使用了旧的“先归档、后精读”顺序</h2>
      <p>当前版本不会把 Zotero 归档视为研读已经开始或完成。下面只保留历史结果和原文入口；请新建一轮，按“导读决定 → 论文研读 → 统一预览”继续。</p>
      <ResultList proposals={proposals} />
      <ReadingLinks papers={readingPapers} onOpenPaper={onOpenPaper} />
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
      <div className="workflow-demo-notice"><ShieldCheck size={18} aria-hidden="true" /><div><strong>扫描结果已保留</strong><p>本轮没有写入任何外部位置；下次运行仍可参考本周发现记录。</p></div></div>
      {onReset ? <button className="workflow-secondary-action" type="button" onClick={onReset}>重新运行本周 Run</button> : null}
    </section>
  );
}

export function WorkflowWorkspace({
  run,
  papers: suppliedPapers,
  candidateSummaryState,
  onGenerateCandidateSummaries,
  journalRunState,
  guideState,
  readerTarget,
  onOpenPaper,
  onOpenCloseReading,
  onCloseReader,
  onReaderSelectionChange,
  onReaderContextChange,
  onReadingChange,
  onStartJournalRun,
  onRestoreJournalRuns,
  onResumeJournalRun,
  onRetryPaperDocument,
  onRestartFromGuide,
  onTogglePaper,
  onPrepareGuides,
  onSkipRun,
  onSetActivePaper,
  onChooseGuideAction,
  onPreviousStage,
  onNextStage,
  onAddQuestion,
  zoteroUiState,
  obsidianUiState,
  projectStateUiState,
  onToggleObsidianProposal,
  onToggleProjectStateProposal,
  onSelectZoteroTarget,
  onRetryZoteroTargets,
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
  readingProviderId,
  readingModelId,
}) {
  const status = normalizeStatus(run?.status);
  const currentStepIndex = findStepIndex(status);
  const currentStep = WORKFLOW_STEPS[currentStepIndex];
  const runIdentity = run?.runId ?? run?.id ?? null;
  const [viewStepId, setViewStepId] = useState(null);
  const [restartDialog, setRestartDialog] = useState({
    open: false,
    pending: false,
    error: null,
  });
  useEffect(() => {
    setViewStepId(null);
  }, [runIdentity]);
  const liveRunUnavailable = (
    run?.source === "live"
    && !journalRunState?.run
    && ["restoring", "error"].includes(journalRunState?.status)
  );
  const canRestartFromGuide = Boolean(
    onRestartFromGuide
    && run?.source === "live"
    && ["reading", "draft_ready"].includes(status),
  );
  const papers = suppliedPapers
    ?? (run?.source === "fixture" ? workflowFixture.papers ?? [] : []);
  const reviewPapers = papers.slice(0, 5);
  const selectedPaperIds = run?.selectedPaperIds ?? run?.selected_ids ?? [];
  const selectedPapers = papers.filter((paper) => selectedPaperIds.includes(paper.id));
  const readingPapers = selectedPapers.filter((paper) => run?.guideChoices?.[paper.id] === "read");
  const activePaperId = run?.activePaperId ?? run?.active_paper_id ?? selectedPapers[0]?.id ?? papers[0]?.id;
  const activePaper = papers.find((paper) => paper.id === activePaperId) ?? selectedPapers[0] ?? papers[0];
  const readerPaper = readerTarget
    ? papers.find((paper) => paper.id === readerTarget.paperId && paper.isDemo === false && paper.mineruStatus === "ready")
    : null;
  const readerGuide = readerPaper
    ? guideState?.byPaperId?.[readerPaper.id] ?? null
    : null;
  const readerPeerPapers = readerTarget?.purpose === "close-reading"
    ? readingPapers
    : selectedPapers;
  const switchReaderPaper = (paperId) => {
    if (readerTarget?.purpose === "close-reading") {
      onOpenCloseReading?.(paperId);
      return;
    }
    onOpenPaper?.(paperId, null, readerTarget?.purpose ?? "document");
  };
  const proposals = run?.proposals
    ?? (run?.source === "fixture" ? workflowFixture.proposals ?? [] : []);
  const availableStepIds = getAvailableStepIds({
    run,
    status,
    journalRun: journalRunState?.run,
    proposals,
    obsidianUiState,
    projectStateUiState,
  });
  const requestedStepIndex = WORKFLOW_STEPS.findIndex((step) => step.id === viewStepId);
  // 每周追踪的固定落点是候选审阅页：精读进行中的过程只从左栏「论文研读」
  // 列表进入，不再作为工作流视图的默认画面；步骤条上的「精读」仍可显式查看。
  const pinnedToReview = currentStep.id === "reading" && availableStepIds.has("review");
  const defaultStep = pinnedToReview ? WORKFLOW_STEPS[0] : currentStep;
  const viewedStep = (
    requestedStepIndex >= 0
    && requestedStepIndex <= currentStepIndex
    && availableStepIds.has(viewStepId)
  )
    ? WORKFLOW_STEPS[requestedStepIndex]
    : defaultStep;
  const viewingHistory = viewedStep.id !== currentStep.id;
  const pinnedLanding = pinnedToReview && viewStepId === null && viewedStep.id === "review";
  const viewStep = (stepId) => {
    const stepIndex = WORKFLOW_STEPS.findIndex((step) => step.id === stepId);
    if (
      stepIndex < 0
      || stepIndex > currentStepIndex
      || !availableStepIds.has(stepId)
    ) return;
    onCloseReader?.();
    setViewStepId(stepId === defaultStep.id ? null : stepId);
  };
  const openRestartDialog = () => {
    setRestartDialog({ open: true, pending: false, error: null });
  };
  const confirmRestart = async () => {
    if (!onRestartFromGuide || restartDialog.pending) return;
    setRestartDialog((current) => ({ ...current, pending: true, error: null }));
    try {
      await onRestartFromGuide();
      setRestartDialog({ open: false, pending: false, error: null });
      setViewStepId(null);
    } catch (error) {
      setRestartDialog({
        open: true,
        pending: false,
        error: error?.message ?? "暂时无法返回本周推荐文章",
      });
    }
  };
  const liveHeaderStatus = readerPaper
    ? readerTarget?.purpose === "close-reading" ? "论文工作台 · 研读中" : "论文工作台 · 阅读中"
    : journalRunState?.status === "restoring"
      ? "正在恢复上次 Run"
      : journalRunState?.status === "starting"
    ? "正在启动扫描"
    : journalRunState?.status === "error"
      ? "本地工作流暂时离线"
      : journalRunState?.run?.status === "review_ready"
        ? "真实候选待审阅"
        : JOURNAL_PHASE_LABELS[journalRunState?.run?.phase];

  let content = null;
  if (status === "review_ready") content = <CandidateReview run={run} papers={reviewPapers} candidateSummaryState={candidateSummaryState} onGenerateCandidateSummaries={onGenerateCandidateSummaries} onTogglePaper={onTogglePaper} onPrepareGuides={onPrepareGuides} onSkipRun={onSkipRun} journalRunState={journalRunState} onOpenPaper={onOpenPaper} onStartJournalRun={onStartJournalRun} onResumeJournalRun={onResumeJournalRun} onRetryPaperDocument={onRetryPaperDocument} />;
  if (status === "preparing_guides") {
    content = <PreparingGuides run={run} selectedPapers={selectedPapers} journalRunState={journalRunState} />;
  }
  if (status === "guide_ready") {
    content = (
      <GuideReady
        run={run}
        selectedPapers={selectedPapers}
        activePaper={activePaper}
        guideState={guideState}
        onSetActivePaper={onSetActivePaper}
        onPrepareGuides={onPrepareGuides}
        onChooseGuideAction={onChooseGuideAction}
        onGeneratePreview={onGeneratePreview}
        onOpenPaper={onOpenPaper}
        zoteroUiState={zoteroUiState}
        onSelectZoteroTarget={onSelectZoteroTarget}
        onRetryZoteroTargets={onRetryZoteroTargets}
      />
    );
  }
  if (status === "reading") {
    content = run?.source === "live"
      ? (
          <LiveReadingStage
            run={run}
            selectedPapers={readingPapers}
            onOpenCloseReading={onOpenCloseReading}
            onRestartFromGuide={canRestartFromGuide ? openRestartDialog : null}
          />
        )
      : <ReadingStage run={run} selectedPapers={readingPapers} activePaper={activePaper} onSetActivePaper={onSetActivePaper} onPreviousStage={onPreviousStage} onNextStage={onNextStage} onAddQuestion={onAddQuestion} onGeneratePreview={onGeneratePreview} />;
  }
  if (status === "draft_ready") {
    content = (
      <ArchiveReadyStage
        run={run}
        selectedPapers={selectedPapers}
        zoteroUiState={zoteroUiState}
        obsidianUiState={obsidianUiState}
        projectStateUiState={projectStateUiState}
        onSelectZoteroTarget={onSelectZoteroTarget}
        onRetryZoteroTargets={onRetryZoteroTargets}
        onGeneratePreview={onGeneratePreview}
      />
    );
  }
  if (status === "awaiting_approval") content = <ApprovalStage run={run} proposals={proposals} readingPapers={readingPapers} onOpenPaper={onOpenPaper} onToggleProposal={onToggleProposal} onCommit={onCommit} onRegeneratePreview={onGeneratePreview} zoteroUiState={zoteroUiState} obsidianUiState={obsidianUiState} projectStateUiState={projectStateUiState} onToggleObsidianProposal={onToggleObsidianProposal} onToggleProjectStateProposal={onToggleProjectStateProposal} onSelectZoteroTarget={onSelectZoteroTarget} onRetryZoteroTargets={onRetryZoteroTargets} />;
  if (status === "manual_action_required") content = <ApprovalStage run={run} proposals={proposals} readingPapers={readingPapers} onOpenPaper={onOpenPaper} onToggleProposal={onToggleProposal} onCommit={onCommit} onRegeneratePreview={onGeneratePreview} zoteroUiState={zoteroUiState} obsidianUiState={obsidianUiState} projectStateUiState={projectStateUiState} onToggleObsidianProposal={onToggleObsidianProposal} onToggleProjectStateProposal={onToggleProjectStateProposal} onSelectZoteroTarget={onSelectZoteroTarget} onRetryZoteroTargets={onRetryZoteroTargets} />;
  if (status === "committing") content = <CommittingStage run={run} proposals={proposals} recoveryError={journalRunState?.status === "error" ? journalRunState.error : null} onResume={onResumeJournalRun} />;
  if (status === "partial") {
    const archiveBatch = journalRunState?.run?.archiveBatch;
    const localArchivePending = Boolean(
      archiveBatch
      && archiveBatch.status !== "completed"
      && (
        Boolean(obsidianUiState?.preview)
        || Boolean(projectStateUiState?.preview)
      )
    );
    content = localArchivePending
      ? <ApprovalStage run={run} proposals={proposals} readingPapers={readingPapers} onOpenPaper={onOpenPaper} onToggleProposal={onToggleProposal} onCommit={onRetryFailed} onRegeneratePreview={onGeneratePreview} zoteroUiState={zoteroUiState} obsidianUiState={obsidianUiState} projectStateUiState={projectStateUiState} onToggleObsidianProposal={onToggleObsidianProposal} onToggleProjectStateProposal={onToggleProjectStateProposal} onSelectZoteroTarget={onSelectZoteroTarget} onRetryZoteroTargets={onRetryZoteroTargets} />
      : <PartialStage proposals={proposals} readingPapers={readingPapers} onOpenPaper={onOpenPaper} onRetryFailed={onRetryFailed} onRegeneratePreview={onGeneratePreview} zoteroUiState={zoteroUiState} onSelectZoteroTarget={onSelectZoteroTarget} onRetryZoteroTargets={onRetryZoteroTargets} />;
  }
  if (status === "reading_ready") content = <ReadingReadyStage proposals={proposals} readingPapers={readingPapers} onOpenPaper={onOpenPaper} />;
  if (status === "completed") content = <CompletedStage proposals={proposals} onReset={onReset} />;
  if (status === "completed_no_write") content = <CompletedNoWriteStage onReset={onReset} />;
  if (viewingHistory && viewedStep.id === "review") {
    content = <CandidateReview run={run} papers={reviewPapers} candidateSummaryState={candidateSummaryState} onTogglePaper={onTogglePaper} journalRunState={journalRunState} onOpenPaper={onOpenPaper} onRetryPaperDocument={onRetryPaperDocument} readOnly readOnlyQuiet={pinnedLanding} />;
  }
  if (viewingHistory && viewedStep.id === "guide") {
    content = (
      <GuideReady
        run={run}
        selectedPapers={selectedPapers}
        activePaper={activePaper}
        guideState={guideState}
        onSetActivePaper={onSetActivePaper}
        onOpenPaper={onOpenPaper}
        zoteroUiState={zoteroUiState}
        readOnly
      />
    );
  }
  if (viewingHistory && viewedStep.id === "reading") {
    content = (
      <LiveReadingStage
        run={run}
        selectedPapers={readingPapers}
        readOnly
      />
    );
  }
  if (liveRunUnavailable) {
    content = (
      <RunRestoreState
        status={journalRunState.status}
        error={journalRunState.error}
        onRetry={onRestoreJournalRuns}
      />
    );
  }
  if (viewingHistory && viewedStep.id === "approval") {
    content = (
      <ApprovalStage
        run={run}
        proposals={proposals}
        readingPapers={readingPapers}
        obsidianUiState={obsidianUiState}
        projectStateUiState={projectStateUiState}
        zoteroUiState={zoteroUiState}
        readOnly
      />
    );
  }
  if (readerPaper) {
    content = (
      <PaperReader
        runId={readerTarget.runId}
        paper={readerPaper}
        initialBlockId={readerTarget.blockId}
        purpose={readerTarget.purpose}
        providerId={readingProviderId}
        modelId={readingModelId}
        guide={readerGuide}
        guideDecision={run?.guideChoices?.[readerPaper.id] ?? null}
        peerPapers={readerPeerPapers}
        onSwitchPaper={switchReaderPaper}
        onGuideDecision={(choice) => onChooseGuideAction?.(readerPaper.id, choice)}
        onSelectionChange={onReaderSelectionChange}
        onReaderContextChange={onReaderContextChange}
        onReadingChange={onReadingChange}
        onClose={onCloseReader}
      />
    );
  }

  return (
    <main className={`workflow-workspace${mobileActive ? " is-mobile-active" : ""}`}>
      <WorkflowHeader
        run={run}
        status={status}
        statusLabel={pinnedLanding
          ? liveHeaderStatus
          : viewingHistory
            ? `回看${viewedStep.label} · 当前进度：${STATUS_LABELS[status] ?? liveHeaderStatus}`
            : liveHeaderStatus}
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
        viewStepId={viewedStep.id}
        availableStepIds={availableStepIds}
        onViewStep={viewStep}
        artifactMode={Boolean(readerPaper)}
        hideSteps={liveRunUnavailable}
      />
      {viewingHistory ? (
        <div className="workflow-history-bar" role="status">
          <span>
            {pinnedLanding
              ? `本周推荐的论文都在这里；精读从左侧「论文研读」列表继续，当前进度在「${currentStep.label}」。`
              : `正在查看已完成的「${viewedStep.label}」步骤，当前流程仍在「${currentStep.label}」。`}
          </span>
          <div>
            {viewedStep.id === "guide" && canRestartFromGuide ? (
              <button type="button" onClick={openRestartDialog}>从导读重新开始</button>
            ) : null}
            <button type="button" onClick={() => viewStep(currentStep.id)}>
              {pinnedLanding ? "查看精读进度" : "返回当前步骤"}
            </button>
          </div>
        </div>
      ) : null}
      {content}
      {restartDialog.open ? (
        <RestartReadingDialog
          pending={restartDialog.pending}
          error={restartDialog.error}
          onCancel={() => setRestartDialog({ open: false, pending: false, error: null })}
          onConfirm={confirmRestart}
        />
      ) : null}
    </main>
  );
}
