import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  BookOpenText,
  CheckCircle,
  Circle,
  CircleNotch,
  FileText,
  Flag,
  PaperPlaneTilt,
  PushPin,
  Quotes,
  ShieldCheck,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import {
  abandonJournalAgentNoteProposal,
  commitJournalAgentNoteProposal,
  createJournalAgentNoteProposal,
  createJournalReadingConversation,
  pinJournalReadingConclusion,
  promoteJournalReadingConversation,
  sendJournalReadingChatMessage,
  switchJournalReadingConversation,
  unpinJournalReadingConclusion,
} from "../api/journalRuns.js";
import { getModelDisplayName } from "../data.js";
import { usePersistentState } from "../hooks/usePersistentState.js";
import { workflowFixture } from "../workflow/fixtures.js";
import { PaperRichText } from "./PaperRichText.jsx";
import { handleProjectComposerKeyDown } from "./projectComposerKeyboard.js";

const MAX_SELECTION_LENGTH = 4_000;
const NOOP_SELECTION_CHANGE = () => {};
const READING_NOTE_LENSES = [
  { id: "research-question", label: "研究问题" },
  { id: "method", label: "方法机制" },
  { id: "evidence", label: "实验依据" },
  { id: "project-relation", label: "项目关系" },
];

function readerBlockSource(block) {
  if (!block) return "";
  if (block.kind === "table") return (block.markdown ?? block.text ?? "").trim();
  return (block.text ?? block.markdown ?? "").trim();
}

function readableReaderBlocks(blocks = []) {
  return blocks.filter(
    (block) => block.kind !== "heading" && readerBlockSource(block),
  );
}

function sectionChapterKey(title) {
  const match = String(title ?? "").match(/^\s*(\d+|[A-Z])(?=[.．\s])/);
  return match ? match[1].toUpperCase() : null;
}

// Unnumbered headings may open a walkable chapter only when they are a real
// top-level section name; anything else ("User Prompt"…) stays in the current one.
const SECTION_TITLE_WHITELIST = /^(abstract|introduction|background|related\s+works?|preliminar|motivation|method|approach|framework|architecture|experiment|result|evaluation|analysis|discussion|conclusion|limitation|acknowledg|appendix|摘要|引言|背景|相关工作|方法|实验|结果|讨论|结论|局限|致谢|附录)/i;
const REFERENCES_TITLE_PATTERN = /^(references?|bibliography|参考文献)\b/i;

export function readingSections(document) {
  const blocks = readableReaderBlocks(document?.blocks);
  const bodyBlocks = blocks.filter(
    (block) => (Array.isArray(block.path) ? block.path.filter(Boolean) : []).length >= 1,
  );
  // If every body block shares one path[0], it is the paper title and real chapters live at path[1].
  const roots = new Set(bodyBlocks.map((block) => block.path.filter(Boolean)[0]));
  const chapterDepth = roots.size === 1 && bodyBlocks.length > 3 ? 1 : 0;

  const sections = [];
  let current = null;
  let afterReferences = false;
  let appendixSection = null;
  for (const block of blocks) {
    const path = Array.isArray(block.path) ? block.path.filter(Boolean) : [];
    // Skip front-matter / title / author blocks — they are not a walkable chapter.
    if (path.length <= chapterDepth) continue;
    const rawTitle = String(path[chapterDepth] ?? "");
    // References carry no teachable body; they also mark the start of back matter.
    if (REFERENCES_TITLE_PATTERN.test(rawTitle)) {
      afterReferences = true;
      current = null;
      continue;
    }
    if (afterReferences) {
      // Everything after References (lettered appendices, prompt dumps…)
      // collapses into one walkable appendix chapter.
      if (!appendixSection) {
        appendixSection = {
          groupKey: "__appendix__",
          title: "附录",
          firstBlockId: block.id,
          blockIds: [],
        };
        sections.push(appendixSection);
      }
      current = appendixSection;
      current.blockIds.push(block.id);
      continue;
    }
    // Collapse numbered subsections (3.1, 3.2, B.8…) into their top-level chapter.
    const chapterKey = sectionChapterKey(rawTitle);
    const startsNewGroup = chapterKey != null || SECTION_TITLE_WHITELIST.test(rawTitle);
    const groupKey = chapterKey ?? rawTitle;
    if (!current) {
      // Before the first real chapter begins, stray titles are front matter.
      if (!startsNewGroup) continue;
      current = { groupKey, title: rawTitle, firstBlockId: block.id, blockIds: [] };
      sections.push(current);
    } else if (startsNewGroup && current.groupKey !== groupKey) {
      current = { groupKey, title: rawTitle, firstBlockId: block.id, blockIds: [] };
      sections.push(current);
    }
    current.blockIds.push(block.id);
  }
  return sections;
}

// The ten-round guided reading spine distilled from the validated BLT session:
// orientation-first rounds, each with a fixed teaching format and a self-check.
export const READING_ROUNDS = [
  {
    id: "field",
    label: "领域定位",
    goal: "知道它在解决哪类问题",
    match: /abstract|introduction|摘要|引言/i,
    prompt: "第 1 步 · 领域定位。只回答一个问题：这篇论文属于哪个研究领域、在解决哪类问题？先给出精确定位（领域/子方向），再说明它在哪条技术路线上，以及它不是在研究什么（避免混淆）。",
  },
  {
    id: "background",
    label: "技术背景",
    goal: "搞清它之前的主流做法与前史",
    match: /introduction|background|related|preliminar|引言|背景|相关工作/i,
    prompt: "第 2 步 · 技术背景。讲清这篇论文之前的技术前史：现有主流做法是什么、各自的优缺点、有哪几条代表性路线（适合时用对比表格）。",
  },
  {
    id: "gap",
    label: "发现的 gap",
    goal: "明白作者为什么要做这个工作",
    match: /abstract|introduction|background|related|motivation|摘要|引言|背景/i,
    prompt: "第 3 步 · 发现的 gap。这篇论文发现了什么 gap？逐条列出现有方法的不足与作者的切入点，并解释为什么这些 gap 值得解决、以前为什么没被解决。",
  },
  {
    id: "overview",
    label: "方法总图",
    goal: "建立整体架构地图",
    match: /method|approach|framework|architecture|model|方法/i,
    prompt: "第 4 步 · 方法总图。给我方法的整体地图：从输入到输出的完整流程怎么走、有哪几个关键组件、各自职责是什么，用分步列表或文字流程图表达，先不钻细节。",
  },
  {
    id: "modules",
    label: "核心模块",
    goal: "理解关键模块怎么工作",
    match: /method|approach|framework|architecture|model|方法/i,
    prompt: "第 5 步 · 核心模块。把核心模块逐个拆开讲：每个关键模块解决什么、具体怎么工作、关键假设是什么，模块之间怎么衔接；适当用类比帮我理解。",
  },
  {
    id: "experiments",
    label: "实验设计",
    goal: "看作者怎么证明方法有效",
    match: /experiment|evaluation|result|setup|benchmark|实验|结果|评估/i,
    prompt: "第 6 步 · 实验设计。作者用什么实验证明方法有效？讲清数据集、基线、指标、对照设置和主要结果，并判断实验逻辑是否公平、哪些结论真的被实验支持。",
  },
  {
    id: "novelty",
    label: "创新点",
    goal: "分清真贡献与工程组合",
    match: /abstract|introduction|conclusion|contribution|discussion|摘要|结论/i,
    prompt: "第 7 步 · 创新点。总结这篇论文的创新点：哪些是真正的新贡献、哪些只是工程组合？按重要性排序，并说明每条创新点对应的证据。",
  },
  {
    id: "limitations",
    label: "局限",
    goal: "知道哪些结论要保持怀疑",
    match: /limitation|discussion|conclusion|future|局限|讨论|结论/i,
    prompt: "第 8 步 · 局限。论文自己承认的局限有哪些？从方法和实验设计里还能看出哪些没明说的局限？逐条列出并说明影响范围。",
  },
  {
    id: "relations",
    label: "与其他论文的关系",
    goal: "把它放进技术路线地图",
    match: /related|background|introduction|相关工作|背景/i,
    prompt: "第 9 步 · 与其他论文的关系。它在挑战谁、继承谁、和哪些相近工作最容易混淆？用对比表或关系图把它放进技术路线地图里。",
  },
  {
    id: "transfer",
    label: "迁移运用与沉淀",
    goal: "把它变成自己的知识",
    match: /conclusion|discussion|abstract|future|结论|讨论/i,
    prompt: "第 10 步 · 迁移运用。这篇论文最值得带走的思想是什么？给出 2-3 个具体的迁移方向（可以用在什么场景、怎么用），最后给一句最值得记住的迁移句，并把本步要点整理成一段可以直接存进笔记的小结。",
  },
];

const ROUND_OUTPUT_FORMAT = "请按固定结构输出：先用一两句说明「本轮读什么」；然后分段讲解（短段落，需要时用列表、表格或类比）；接着用「关键概念」小节把本轮最重要的名词逐个一句话点破；再给出「你需要记住的一句话」；最后出一道 A/B/C/D 单选小问题检验理解（只给题目和选项，先不给答案，我回答后你再点评）。";
const ROUND_REFERENCE_BLOCK_LIMIT = 40;

export function readingRoundReference(round, sections) {
  if (!round || !Array.isArray(sections) || sections.length === 0) return null;
  const matched = sections.filter((section) => round.match.test(String(section.title ?? "")));
  const chosen = matched.length > 0 ? matched : sections.slice(0, 2);
  const blockIds = chosen
    .flatMap((section) => section.blockIds)
    .slice(0, ROUND_REFERENCE_BLOCK_LIMIT);
  if (blockIds.length === 0) return null;
  return { blockIds, firstBlockId: chosen[0]?.firstBlockId ?? null };
}

function getStageIndex(run, stages) {
  const value = run?.readingStageIndex ?? run?.currentStageIndex ?? run?.current_stage ?? 0;
  if (typeof value === "number") return value;
  const index = stages.findIndex((stage) => stage.id === value);
  return index < 0 ? 0 : index;
}

function getActivePaper(run, papers, preferredPaperId) {
  const activeId = preferredPaperId
    ?? run?.activePaperId
    ?? run?.active_paper_id
    ?? (run?.selectedPaperIds ?? run?.selected_ids ?? [])[0]
    ?? papers[0]?.id;
  return papers.find((paper) => paper.id === activeId) ?? papers[0];
}

function chatErrorMessage(error, fallback = "Agent 暂时没有完成这次任务") {
  if (typeof error === "string" && error.trim()) return error;
  if (typeof error?.message === "string" && error.message.trim()) return error.message;
  return fallback;
}

function createChatRequestId() {
  const suffix = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `reading-chat-${suffix}`;
}

function createAgentActionRequestId(kind) {
  const suffix = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `reading-agent-${kind}-${suffix}`;
}

function agentActionStatus(action) {
  if (["verified", "committed"].includes(action?.status)) {
    return { label: "已写入并核验", tone: "success" };
  }
  if (action?.status === "abandoned") return { label: "已放弃", tone: "muted" };
  if (["conflict", "stale"].includes(action?.status)) {
    return { label: "目标内容已变化", tone: "error" };
  }
  if (["committing", "approved"].includes(action?.status)) {
    return { label: "正在写入并读回核验", tone: "running" };
  }
  if (action?.status === "failed") return { label: "写入尚未核验", tone: "error" };
  return { label: "待确认", tone: "pending" };
}

function agentActionDiff(action) {
  if (typeof action?.diff?.append_text === "string") return action.diff.append_text;
  if (typeof action?.diff?.after === "string") return action.diff.after;
  if (typeof action?.diff?.patch === "string") return action.diff.patch;
  return "";
}

function ChatObsidianProposalCard({
  action,
  busy,
  error,
  writeBlocked = false,
  onCommit,
  onAbandon,
  onRegenerate,
}) {
  const state = agentActionStatus(action);
  const diff = agentActionDiff(action);
  const canCommit = !writeBlocked
    && ["draft", "proposal_ready", "failed"].includes(action.status);
  const canAbandon = !["verified", "committed", "abandoned"].includes(action.status);

  return (
    <section className={`reader-agent-note-action is-${state.tone}`} aria-label="Obsidian 修改提案">
      <header>
        <div>
          {state.tone === "success"
            ? <CheckCircle size={15} weight="fill" aria-hidden="true" />
            : state.tone === "running"
              ? <CircleNotch className="is-spinning" size={15} aria-hidden="true" />
              : <FileText size={15} aria-hidden="true" />}
          <strong>{state.label}</strong>
        </div>
        <span>Obsidian</span>
      </header>
      <p className="reader-agent-note-operation">
        {action.operationLabel || "追加到 Agent 补充笔记"}
      </p>
      <code className="reader-agent-note-path">{action.targetPath}</code>
      <p className="reader-agent-note-boundary">
        {writeBlocked
          ? "当前是草稿分支，这份预览不能写入；提升为主研读后再确认。"
          : "只修改这篇论文的 Agent 补充区；不会推进精读阶段。"}
      </p>
      {action.preview?.length ? (
        <ul>
          {action.preview.map((item) => <li key={item}>{item}</li>)}
        </ul>
      ) : null}
      {diff ? (
        <details>
          <summary>查看精确差异</summary>
          <pre>{diff}</pre>
        </details>
      ) : null}
      {error || action.error ? (
        <p className="reader-agent-note-error" role="status">
          {chatErrorMessage(error || action.error, "这次修改没有完成")}
        </p>
      ) : null}
      {action.status === "abandoned" && !writeBlocked ? (
        <button
          className="reader-agent-note-secondary"
          type="button"
          disabled={busy}
          onClick={onRegenerate}
        >
          重新生成修改预览
        </button>
      ) : null}
      {canCommit || canAbandon ? (
        <footer>
          {canAbandon ? (
            <button
              className="reader-agent-note-secondary"
              type="button"
              disabled={busy}
              onClick={onAbandon}
            >
              放弃
            </button>
          ) : null}
          {canCommit ? (
            <button
              className="reader-agent-note-primary"
              type="button"
              disabled={busy}
              onClick={onCommit}
            >
              {busy ? "正在核验…" : action.status === "failed" ? "重新核验写入" : "确认写入"}
            </button>
          ) : null}
        </footer>
      ) : null}
    </section>
  );
}

export function createReaderSelectionReference({
  documentRevision,
  blockId,
  blockText,
  startOffset,
  endOffset,
  selectedText,
}) {
  if (
    typeof documentRevision !== "string"
    || !documentRevision
    || typeof blockId !== "string"
    || !blockId
    || typeof blockText !== "string"
    || !Number.isSafeInteger(startOffset)
    || !Number.isSafeInteger(endOffset)
    || startOffset < 0
    || endOffset <= startOffset
    || endOffset > blockText.length
  ) {
    return { reference: null, error: "这次选文无法定位，请重新选择同一段中的文字。" };
  }
  const quote = blockText.slice(startOffset, endOffset);
  if (!quote.trim() || quote !== selectedText) {
    return { reference: null, error: "这次选文无法定位，请重新选择同一段中的文字。" };
  }
  if (quote.length > MAX_SELECTION_LENGTH) {
    return {
      reference: null,
      error: `一次最多引用 ${MAX_SELECTION_LENGTH} 个字符，请缩短选文。`,
    };
  }
  return {
    reference: {
      documentRevision,
      blockId,
      startOffset,
      endOffset,
      quote,
    },
    error: null,
  };
}

function selectionBlock(node) {
  const element = node?.nodeType === 1 ? node : node?.parentElement;
  return element?.closest?.("[data-reader-block-id]") ?? null;
}

function selectionInsideTranslation(node) {
  const element = node?.nodeType === 1 ? node : node?.parentElement;
  return Boolean(element?.closest?.("[data-reader-zh]"));
}

function selectionSourceMarker(node, block) {
  const element = node?.nodeType === 1 ? node : node?.parentElement;
  const marker = element?.closest?.("[data-source-start][data-source-end]") ?? null;
  return marker && block?.contains(marker) ? marker : null;
}

function sourceOffsetFromDom(marker, container, offset, blockSource, edge) {
  const sourceStart = Number.parseInt(marker?.dataset?.sourceStart, 10);
  const sourceEnd = Number.parseInt(marker?.dataset?.sourceEnd, 10);
  if (
    !Number.isSafeInteger(sourceStart)
    || !Number.isSafeInteger(sourceEnd)
    || sourceStart < 0
    || sourceEnd < sourceStart
    || sourceEnd > blockSource.length
  ) return null;

  const markerText = marker.textContent ?? "";
  if (blockSource.slice(sourceStart, sourceEnd) !== markerText) {
    return edge === "start" ? sourceStart : sourceEnd;
  }
  const prefix = marker.ownerDocument.createRange();
  prefix.selectNodeContents(marker);
  try {
    prefix.setEnd(container, offset);
  } catch {
    return edge === "start" ? sourceStart : sourceEnd;
  }
  return sourceStart + prefix.toString().length;
}

export function selectionReferenceFromDom(
  selection,
  root,
  documentRevision,
  sourceByBlockId = null,
) {
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) {
    return { reference: null, error: null };
  }
  const range = selection.getRangeAt(0);
  if (
    selectionInsideTranslation(range.startContainer)
    || selectionInsideTranslation(range.endContainer)
  ) {
    return { reference: null, error: "引用需要选择英文原文；中文译文仅供阅读。" };
  }
  const startBlock = selectionBlock(range.startContainer);
  const endBlock = selectionBlock(range.endContainer);
  if (!startBlock || !endBlock || !root?.contains(startBlock) || !root?.contains(endBlock)) {
    return { reference: null, error: "这次选文无法定位，请重新选择正文中的文字。" };
  }
  if (startBlock !== endBlock) {
    // Cross-paragraph selection: cite every spanned block (backend accepts block_ids).
    const allBlocks = [...root.querySelectorAll("[data-reader-block-id]")];
    const startIndex = allBlocks.indexOf(startBlock);
    const endIndex = allBlocks.indexOf(endBlock);
    if (startIndex < 0 || endIndex < 0) {
      return { reference: null, error: "这次选文无法定位，请重新选择。" };
    }
    const [lo, hi] = startIndex <= endIndex ? [startIndex, endIndex] : [endIndex, startIndex];
    const blockIds = allBlocks
      .slice(lo, hi + 1)
      .map((element) => element.dataset.readerBlockId)
      .filter(Boolean);
    const selectedText = String(selection.toString() ?? "").trim();
    if (blockIds.length < 2 || !selectedText) {
      return { reference: null, error: null };
    }
    if (typeof documentRevision !== "string" || !documentRevision) {
      return { reference: null, error: "这次选文无法定位，请重新选择。" };
    }
    return {
      reference: {
        documentRevision,
        blockIds,
        quote: selectedText.length > MAX_SELECTION_LENGTH
          ? `${selectedText.slice(0, MAX_SELECTION_LENGTH)}…`
          : selectedText,
      },
      error: null,
    };
  }

  const blockId = startBlock.dataset.readerBlockId;
  const sourceText = sourceByBlockId?.get(blockId);
  if (typeof sourceText === "string") {
    const startMarker = selectionSourceMarker(range.startContainer, startBlock);
    const endMarker = selectionSourceMarker(range.endContainer, startBlock);
    if (!startMarker || !endMarker) {
      return { reference: null, error: "这次选文无法映射到原文，请重新选择同一段中的文字。" };
    }
    const startOffset = sourceOffsetFromDom(
      startMarker,
      range.startContainer,
      range.startOffset,
      sourceText,
      "start",
    );
    const endOffset = sourceOffsetFromDom(
      endMarker,
      range.endContainer,
      range.endOffset,
      sourceText,
      "end",
    );
    if (
      !Number.isSafeInteger(startOffset)
      || !Number.isSafeInteger(endOffset)
      || endOffset <= startOffset
    ) {
      return { reference: null, error: "这次选文无法映射到原文，请重新选择同一段中的文字。" };
    }
    return createReaderSelectionReference({
      documentRevision,
      blockId,
      blockText: sourceText,
      startOffset,
      endOffset,
      selectedText: sourceText.slice(startOffset, endOffset),
    });
  }

  const blockText = startBlock.textContent ?? "";
  const ownerDocument = startBlock.ownerDocument;
  const prefixRange = ownerDocument.createRange();
  prefixRange.selectNodeContents(startBlock);
  prefixRange.setEnd(range.startContainer, range.startOffset);
  const suffixRange = ownerDocument.createRange();
  suffixRange.selectNodeContents(startBlock);
  suffixRange.setEnd(range.endContainer, range.endOffset);

  return createReaderSelectionReference({
    documentRevision,
    blockId,
    blockText,
    startOffset: prefixRange.toString().length,
    endOffset: suffixRange.toString().length,
    selectedText: range.toString(),
  });
}

function EvidenceSection({ paper, stage, run, liveRun }) {
  const live = run?.source === "live";
  const evidence = live || paper?.isDemo === false
    ? []
    : (workflowFixture.evidence ?? [])
        .filter((item) => item.paperId === paper?.id)
        .slice(0, 3);
  const sourceProgress = liveRun?.sourceProgress;
  const scanSummary = liveRun?.scanSummary;
  const sourceCount = scanSummary?.source_count
    ?? sourceProgress?.total_count
    ?? 11;
  const completedSourceCount = sourceProgress?.completed_source_ids?.length
    ?? scanSummary?.source_count;
  const successfulSourceCount = scanSummary?.successful_source_count
    ?? sourceProgress?.successful_source_ids?.length;
  const failedSourceCount = (
    scanSummary?.failed_source_ids
    ?? sourceProgress?.failed_source_ids
    ?? []
  ).length;

  return (
    <section className="workflow-context-section" aria-labelledby="workflow-current-paper-title">
      <header>
        <div>
          <FileText size={17} aria-hidden="true" />
          <h3 id="workflow-current-paper-title">
            {paper ? "当前论文" : live ? "当前扫描" : "当前论文"}
          </h3>
        </div>
        <span>{paper && stage ? stage.label : paper ? "候选判断" : "来源进度"}</span>
      </header>

      {paper ? (
        <article className="workflow-context-paper">
          <span className="workflow-context-paper-icon"><FileText size={17} aria-hidden="true" /></span>
          <div>
            <strong>{paper.shortTitle ?? paper.title}</strong>
            <p>{paper.venue} · {paper.publishedAt ?? paper.published_at}</p>
          </div>
        </article>
      ) : live ? (
        <div className="workflow-evidence-scope" role="status">
          <ShieldCheck size={16} aria-hidden="true" />
          <p>
            <strong>
              {completedSourceCount === undefined
                ? "正在恢复来源进度"
                : `已检查 ${completedSourceCount}/${sourceCount} 个来源`}
            </strong>
            <span>
              {successfulSourceCount === undefined
                ? "真实候选仍在准备"
                : `成功 ${successfulSourceCount} · 失败 ${failedSourceCount}`}
            </span>
          </p>
        </div>
      ) : null}

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

function projectStateErrorLabel(errorCode) {
  if (errorCode === "PROJECT_STATE_NOT_CONFIGURED") return "尚未绑定项目状态文件";
  if (errorCode === "PROJECT_STATE_EMPTY") return "项目状态文件为空";
  if (errorCode === "PROJECT_STATE_OUT_OF_SCOPE") return "项目状态配置无效";
  return "暂时无法读取项目状态";
}

function EmptyProjectStateItem({ children }) {
  return <p className="workflow-context-empty">{children}</p>;
}

export function ProjectStateSection({ projectContextState, onReload }) {
  if (projectContextState?.status === "loading") {
    return (
      <section className="workflow-context-section workflow-project-state" aria-live="polite">
        <div className="workflow-context-loading">
          <CircleNotch className="is-spinning" size={17} aria-hidden="true" />
          <p>正在读取项目状态…</p>
        </div>
      </section>
    );
  }
  if (projectContextState?.status === "error") {
    return (
      <section className="workflow-context-section workflow-project-state" role="alert">
        <div className="workflow-context-state-error">
          <WarningCircle size={17} weight="fill" aria-hidden="true" />
          <div>
            <strong>{projectStateErrorLabel(projectContextState.errorCode)}</strong>
            <p>{projectContextState.error}</p>
          </div>
        </div>
        <button type="button" className="workflow-context-retry" onClick={onReload}>重新读取</button>
      </section>
    );
  }

  const projectState = projectContextState?.data ?? {};
  const decisions = projectState.decisions ?? [];
  const openQuestions = projectState.openQuestions ?? projectState.open_questions ?? [];
  const nextActions = projectState.nextActions
    ?? [projectState.nextAction ?? projectState.next_action].filter(Boolean);

  return (
    <>
      {projectState.sourcePath ? (
        <div className="workflow-context-state-source">
          <FileText size={14} aria-hidden="true" />
          <span>{projectState.sourcePath}</span>
          <code>{projectState.revision?.slice(7, 15)}</code>
        </div>
      ) : null}

      {projectState.goal ? (
        <section className="workflow-context-section workflow-project-state" aria-labelledby="workflow-goal-title">
          <header>
            <div><Flag size={17} weight="fill" aria-hidden="true" /><h3 id="workflow-goal-title">当前目标</h3></div>
          </header>
          <p className="workflow-project-goal">{projectState.goal}</p>
        </section>
      ) : null}

      <section className="workflow-context-section workflow-project-state" aria-labelledby="workflow-decisions-title">
        <header>
          <div><CheckCircle size={17} weight="fill" aria-hidden="true" /><h3 id="workflow-decisions-title">已确认决定</h3></div>
          <span>{decisions.length} 条</span>
        </header>
        <div className="workflow-state-list">
          {decisions.length > 0 ? decisions.map((decision) => (
            <article key={decision}>
              <CheckCircle size={16} weight="fill" aria-hidden="true" />
              <p>{decision}</p>
            </article>
          )) : <EmptyProjectStateItem>尚无已确认决定</EmptyProjectStateItem>}
        </div>
      </section>

      <section className="workflow-context-section workflow-project-state" aria-labelledby="workflow-questions-title">
        <header>
          <div><Circle size={17} aria-hidden="true" /><h3 id="workflow-questions-title">开放问题</h3></div>
          <span>{openQuestions.length} 条</span>
        </header>
        <div className="workflow-state-list">
          {openQuestions.length > 0 ? openQuestions.map((question) => (
            <article key={question}>
              <Circle size={16} aria-hidden="true" />
              <p>{question}</p>
            </article>
          )) : <EmptyProjectStateItem>尚无开放问题</EmptyProjectStateItem>}
        </div>
      </section>

      <section className="workflow-context-section workflow-project-state" aria-labelledby="workflow-next-title">
        <header>
          <div><Flag size={17} weight="fill" aria-hidden="true" /><h3 id="workflow-next-title">下一步</h3></div>
        </header>
        {nextActions.length > 0 ? nextActions.map((nextAction) => (
          <div className="workflow-next-action" key={nextAction}>
            <Flag size={16} weight="fill" aria-hidden="true" />
            <p><span>{nextAction}</span></p>
          </div>
        )) : <EmptyProjectStateItem>尚未记录下一步</EmptyProjectStateItem>}
      </section>
    </>
  );
}

export function ReadingNotesPanel({ readerContext, onOpenBlock, onReadingChange }) {
  const reading = readerContext?.reading;
  const [mutationState, setMutationState] = useState({
    busyConclusionId: null,
    error: null,
  });
  const requestIds = useRef(new Map());
  const confirmedNotes = READING_NOTE_LENSES.filter(
    (lens) => reading?.stages?.[lens.id]?.status === "ready",
  );
  const pinnedConclusions = (reading?.pinnedConclusions ?? []).filter(
    (conclusion) => conclusion.status === "pinned",
  );
  const totalNotes = pinnedConclusions.length + confirmedNotes.length;

  useEffect(() => {
    setMutationState({ busyConclusionId: null, error: null });
    requestIds.current.clear();
  }, [readerContext?.key]);

  const handleUnpin = async (conclusion) => {
    if (!conclusion?.conclusionId || mutationState.busyConclusionId) return;
    const requestKey = conclusion.conclusionId;
    if (!requestIds.current.has(requestKey)) {
      requestIds.current.set(requestKey, createAgentActionRequestId("unpin"));
    }
    setMutationState({ busyConclusionId: conclusion.conclusionId, error: null });
    try {
      const nextReading = await unpinJournalReadingConclusion({
        runId: readerContext.runId,
        paperId: readerContext.paperId,
        conclusionId: conclusion.conclusionId,
        clientRequestId: requestIds.current.get(requestKey),
        confirmedBy: "local-user",
      });
      setMutationState({ busyConclusionId: null, error: null });
      onReadingChange?.(nextReading);
    } catch (error) {
      setMutationState({ busyConclusionId: null, error });
    }
  };

  if (!reading) {
    return (
      <section className="reader-notes reader-notes-empty" role="status">
        <CircleNotch className="is-spinning" size={17} aria-hidden="true" />
        <div>
          <strong>正在恢复阅读笔记</strong>
          <p>正文已经可以阅读，整理后的研读结论会在这里出现。</p>
        </div>
      </section>
    );
  }

  return (
    <section className="reader-notes" aria-labelledby="reader-notes-title">
      <header>
        <div>
          <span>本篇研读</span>
          <h3 id="reader-notes-title">已确认的研读结论</h3>
        </div>
        <small>{totalNotes > 0 ? `${totalNotes} 条 · 均保留原文引用` : "可在对话中逐步固定"}</small>
      </header>

      <div className="reader-notes-list">
        {totalNotes === 0 ? (
          <p className="reader-notes-placeholder">
            尚未固定研读结论。阅读时确认的重要判断会逐步出现在这里。
          </p>
        ) : null}
        {pinnedConclusions.map((conclusion) => (
          <article className="is-ready is-pinned" key={conclusion.conclusionId}>
            <header>
              <div>
                <PushPin size={15} weight="fill" aria-hidden="true" />
                <strong>对话结论</strong>
              </div>
              <div className="reader-notes-item-actions">
                <span>已固定</span>
                <button
                  type="button"
                  disabled={Boolean(mutationState.busyConclusionId)}
                  onClick={() => handleUnpin(conclusion)}
                >
                  {mutationState.busyConclusionId === conclusion.conclusionId
                    ? "正在取消…"
                    : "取消固定"}
                </button>
              </div>
            </header>
            <div className="reader-notes-content">
              <PaperRichText content={conclusion.content} />
            </div>
            {conclusion.citations?.length ? (
              <div className="reader-notes-citations" aria-label="对话结论原文引用">
                {conclusion.citations.map((reference, index) => (
                  <button
                    type="button"
                    onClick={() => onOpenBlock(reference.blockId)}
                    key={`${conclusion.conclusionId}-${reference.blockId}-${index}`}
                  >
                    <Quotes size={13} aria-hidden="true" />
                    {citationLabel(reference)}
                  </button>
                ))}
              </div>
            ) : null}
          </article>
        ))}
        {mutationState.error ? (
          <p className="reader-notes-mutation-error" role="status">
            {chatErrorMessage(mutationState.error, "暂时无法取消固定")}
          </p>
        ) : null}
        {confirmedNotes.map((lens) => {
          const stage = reading.stages?.[lens.id] ?? {};
          return (
            <article className="is-ready" key={lens.id}>
              <header>
                <div>
                  <CheckCircle size={15} weight="fill" aria-hidden="true" />
                  <strong>{lens.label}</strong>
                </div>
                <span>已确认</span>
              </header>
              <p>{stage.result.answer}</p>
              {stage.result.evidence?.length ? (
                <div className="reader-notes-citations" aria-label={`${lens.label}原文引用`}>
                  {stage.result.evidence.map((reference, index) => (
                    <button
                      type="button"
                      onClick={() => onOpenBlock(reference.blockId)}
                      key={`${lens.id}-${reference.blockId}-${index}`}
                    >
                      <Quotes size={13} aria-hidden="true" />
                      {citationLabel(reference)}
                    </button>
                  ))}
                </div>
              ) : null}
              {stage.result.openQuestions?.length ? (
                <details>
                  <summary>仍需留意 {stage.result.openQuestions.length} 项</summary>
                  <ul>
                    {stage.result.openQuestions.map((question) => (
                      <li key={question}>{question}</li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function citationLabel(citation) {
  const path = citation?.path?.filter(Boolean)?.slice(1).join(" › ");
  if (path) return path;
  if (Number.isSafeInteger(citation?.ordinal)) return `第 ${citation.ordinal} 段`;
  return "查看引用原文";
}

function turnModelLabel(turn, providers) {
  const provider = providers?.find((item) => item.id === turn.providerId);
  return [
    provider?.name ?? turn.providerId,
    turn.modelId ? getModelDisplayName(turn.modelId) : null,
  ].filter(Boolean).join(" · ");
}

function turnContextLabel(turn) {
  if (turn.projectContextStatus === "available") return "已结合项目状态";
  if (turn.projectContextStatus === "unavailable") return "项目状态暂不可用";
  if (turn.includeProjectContext) return "正在读取项目状态";
  return "仅论文上下文";
}

function readingConversationLabel(conversation) {
  const kind = conversation?.canonical
    ? "主研读"
    : conversation?.promotionStatus === "superseded"
      ? "原主研读 · 草稿"
      : "草稿分支";
  const title = String(conversation?.title ?? "").trim();
  return title && title !== kind ? `${kind} · ${title}` : kind;
}

export function ReaderAgentComposer({
  readerContext,
  providers,
  providerId,
  modelId,
  reference,
  referenceError,
  onReferenceChange,
  onOpenCitation,
  onReadingChange,
}) {
  const [draft, setDraft] = useState("");
  const [includeProjectContext, setIncludeProjectContext] = useState(false);
  const [chatState, setChatState] = useState(() => ({
    status: readerContext?.reading?.chat?.status ?? "idle",
    turns: readerContext?.reading?.chat?.turns ?? [],
    error: null,
  }));
  const [noteActionState, setNoteActionState] = useState({
    busyKey: null,
    errors: {},
  });
  const [conversationBusy, setConversationBusy] = useState(false);
  const [conversationError, setConversationError] = useState(null);
  const noteActionRequestIds = useRef(new Map());
  const sessionKey = readerContext?.key ?? null;
  const reading = readerContext?.reading;
  const conversations = reading?.conversations ?? [];
  const activeConversationId = reading?.activeConversationId ?? "current";
  const canonicalConversationId = reading?.canonicalConversationId
    ?? activeConversationId;
  const activeConversation = conversations.find(
    (conversation) => conversation.id === activeConversationId,
  );
  const isScratchBranch = (
    reading?.chat?.branchType === "scratch"
    || activeConversation?.branchType === "scratch"
    || activeConversationId !== canonicalConversationId
  );
  const pinnedConclusions = (reading?.pinnedConclusions ?? []).filter(
    (conclusion) => conclusion.status === "pinned",
  );
  const incomingTurns = readerContext?.reading?.chat?.turns ?? [];
  const incomingRevision = incomingTurns
    .map((turn) => [
      turn.id,
      turn.status,
      turn.answeredAt ?? "",
      turn.noteAction?.proposalId ?? "",
      turn.noteAction?.status ?? "",
      turn.noteAction?.updatedAt ?? "",
    ].join(":"))
    .join("|");
  const activeProvider = providers?.find((provider) => provider.id === providerId);
  const modelAvailable = Boolean(
    providerId
    && modelId
    && activeProvider?.available !== false,
  );

  useEffect(() => {
    setDraft("");
    setIncludeProjectContext(false);
    setChatState({
      status: readerContext?.reading?.chat?.status ?? "idle",
      turns: readerContext?.reading?.chat?.turns ?? [],
      error: null,
    });
    setNoteActionState({ busyKey: null, errors: {} });
    setConversationBusy(false);
    setConversationError(null);
    noteActionRequestIds.current.clear();
    onReferenceChange({ reference: null, error: null });
  }, [sessionKey]);

  useEffect(() => {
    if (!sessionKey) return;
    setChatState((current) => {
      if (incomingTurns.length < current.turns.length) return current;
      return {
        ...current,
        status: readerContext?.reading?.chat?.status ?? current.status,
        turns: incomingTurns,
      };
    });
  }, [incomingRevision, sessionKey]);

  const updateDraft = (value) => {
    setDraft(value);
    setChatState((current) => ({
      ...current,
      error: null,
    }));
  };

  const requestIdFor = (key, kind) => {
    if (!noteActionRequestIds.current.has(key)) {
      noteActionRequestIds.current.set(key, createAgentActionRequestId(kind));
    }
    return noteActionRequestIds.current.get(key);
  };

  const publishReading = (nextReading) => {
    setChatState({
      status: nextReading.chat?.status ?? "ready",
      turns: nextReading.chat?.turns ?? [],
      error: null,
    });
    onReadingChange?.(nextReading);
  };

  const updateNoteActionError = (key, error) => {
    setNoteActionState((current) => ({
      busyKey: null,
      errors: { ...current.errors, [key]: error },
    }));
  };

  const createNoteProposal = async (turn) => {
    const key = `${turn.id}:preview`;
    if (noteActionState.busyKey || isScratchBranch) return;
    setNoteActionState((current) => ({
      busyKey: key,
      errors: { ...current.errors, [key]: null },
    }));
    try {
      publishReading(await createJournalAgentNoteProposal({
        runId: readerContext.runId,
        paperId: readerContext.paperId,
        turnId: turn.id,
        clientRequestId: requestIdFor(key, "preview"),
      }));
      setNoteActionState({ busyKey: null, errors: {} });
    } catch (error) {
      updateNoteActionError(key, error);
    }
  };

  const commitNoteProposal = async (turn) => {
    const action = turn.noteAction;
    const key = `${action.proposalId}:commit`;
    if (noteActionState.busyKey) return;
    setNoteActionState((current) => ({
      busyKey: key,
      errors: { ...current.errors, [key]: null },
    }));
    try {
      publishReading(await commitJournalAgentNoteProposal({
        runId: readerContext.runId,
        paperId: readerContext.paperId,
        proposalId: action.proposalId,
        clientRequestId: requestIdFor(key, "commit"),
        proposalHash: action.proposalHash,
        contentHash: action.contentHash,
        targetVersionOrHash: action.targetVersionOrHash,
      }));
      setNoteActionState({ busyKey: null, errors: {} });
    } catch (error) {
      const failedStatus = error?.code === "READING_NOTE_TARGET_STALE"
        ? "conflict"
        : "failed";
      setChatState((current) => ({
        ...current,
        turns: current.turns.map((item) => (
          item.noteAction?.proposalId === action.proposalId
            ? {
                ...item,
                noteAction: {
                  ...item.noteAction,
                  status: failedStatus,
                  error: {
                    code: error?.code ?? "OBSIDIAN_NOTE_WRITE_FAILED",
                    message: chatErrorMessage(error, "这次修改没有完成"),
                    retryable: Boolean(error?.retryable),
                  },
                },
              }
            : item
        )),
      }));
      updateNoteActionError(key, error);
    }
  };

  const abandonNoteProposal = async (turn) => {
    const action = turn.noteAction;
    const key = `${action.proposalId}:abandon`;
    if (noteActionState.busyKey) return;
    setNoteActionState((current) => ({
      busyKey: key,
      errors: { ...current.errors, [key]: null },
    }));
    try {
      publishReading(await abandonJournalAgentNoteProposal({
        runId: readerContext.runId,
        paperId: readerContext.paperId,
        proposalId: action.proposalId,
        clientRequestId: requestIdFor(key, "abandon"),
      }));
      noteActionRequestIds.current.delete(`${turn.id}:preview`);
      setNoteActionState({ busyKey: null, errors: {} });
    } catch (error) {
      updateNoteActionError(key, error);
    }
  };

  const pinConclusion = async (turn) => {
    const key = `${turn.id}:pin`;
    if (
      noteActionState.busyKey
      || turn.status !== "answered"
      || !turn.citations?.length
    ) {
      return;
    }
    setNoteActionState((current) => ({
      busyKey: key,
      errors: { ...current.errors, [key]: null },
    }));
    try {
      publishReading(await pinJournalReadingConclusion({
        runId: readerContext.runId,
        paperId: readerContext.paperId,
        turnId: turn.id,
        clientRequestId: requestIdFor(key, "pin"),
        confirmedBy: "local-user",
      }));
      setNoteActionState({ busyKey: null, errors: {} });
    } catch (error) {
      updateNoteActionError(key, error);
    }
  };

  const submit = async (attempt = null) => {
    if (!modelAvailable || chatState.status === "running") return;
    const text = attempt?.text ?? draft.trim();
    if (!text) return;
    const nextAttempt = attempt ?? {
      clientRequestId: createChatRequestId(),
      text,
      reference,
      includeProjectContext,
    };
    const optimisticTurn = {
      id: nextAttempt.clientRequestId,
      clientRequestId: nextAttempt.clientRequestId,
      question: nextAttempt.text,
      status: "running",
      reference: nextAttempt.reference,
      roundId: nextAttempt.roundId ?? null,
      answer: null,
      citations: [],
      providerId,
      modelId,
      includeProjectContext: nextAttempt.includeProjectContext,
      createdAt: new Date().toISOString(),
    };
    setChatState((current) => ({
      status: "running",
      turns: [
        ...current.turns.filter((turn) => turn.id !== optimisticTurn.id),
        optimisticTurn,
      ],
      error: null,
    }));
    try {
      const nextReading = await sendJournalReadingChatMessage({
        runId: readerContext.runId,
        paperId: readerContext.paperId,
        text: nextAttempt.text,
        reference: nextAttempt.reference
          ? (Array.isArray(nextAttempt.reference.blockIds)
              ? {
                  documentRevision: nextAttempt.reference.documentRevision,
                  blockIds: nextAttempt.reference.blockIds,
                }
              : {
                  documentRevision: nextAttempt.reference.documentRevision,
                  blockId: nextAttempt.reference.blockId,
                  startOffset: nextAttempt.reference.startOffset,
                  endOffset: nextAttempt.reference.endOffset,
                })
          : null,
        roundId: nextAttempt.roundId ?? null,
        includeProjectContext: nextAttempt.includeProjectContext,
        clientRequestId: nextAttempt.clientRequestId,
        providerId,
        modelId,
      });
      publishReading(nextReading);
      setDraft("");
      onReferenceChange({ reference: null, error: null });
    } catch (error) {
      setChatState((current) => ({
        ...current,
        status: "failed",
        turns: current.turns.map((turn) => (
          turn.id === nextAttempt.clientRequestId
            ? { ...turn, status: "failed", error }
            : turn
        )),
        error,
      }));
    }
  };

  const [readingDepth, setReadingDepth] = useState("normal");
  const [walkOpen, setWalkOpen] = usePersistentState("pi-reading-walk-open", true);
  const [walkMode, setWalkMode] = usePersistentState("pi-reading-walk-mode", "rounds");
  const [roundProgress, setRoundProgress] = usePersistentState("pi-reading-round-progress", {});
  const [roundSelection, setRoundSelection] = useState(null);
  const roundKey = `${sessionKey ?? "unknown"}:${activeConversationId}`;
  const visibleChatTurns = chatState.turns.filter((turn) => !turn.auditOnly);

  useEffect(() => {
    setRoundSelection(null);
  }, [roundKey]);

  const handleNewConversation = async () => {
    if (conversationBusy) return;
    setConversationBusy(true);
    setConversationError(null);
    try {
      publishReading(await createJournalReadingConversation({
        runId: readerContext.runId,
        paperId: readerContext.paperId,
      }));
      onReferenceChange({ reference: null, error: null });
    } catch (error) {
      setConversationError(error);
    } finally {
      setConversationBusy(false);
    }
  };

  const handleSwitchConversation = async (conversationId) => {
    if (conversationBusy || conversationId === activeConversationId) return;
    setConversationBusy(true);
    setConversationError(null);
    try {
      publishReading(await switchJournalReadingConversation({
        runId: readerContext.runId,
        paperId: readerContext.paperId,
        conversationId,
      }));
      onReferenceChange({ reference: null, error: null });
    } catch (error) {
      setConversationError(error);
    } finally {
      setConversationBusy(false);
    }
  };

  const handlePromoteConversation = async () => {
    if (!isScratchBranch || conversationBusy) return;
    const confirmed = globalThis.confirm?.(
      [
        "将这个草稿分支提升为主研读吗？",
        "",
        "提升后，这个分支将成为唯一可以进入归档的主研读；原主研读会保留为草稿，不会被删除。",
        "本操作不会写入 Zotero、Obsidian 或项目状态。",
      ].join("\n"),
    );
    if (!confirmed) return;
    const key = `${activeConversationId}:promote`;
    setConversationBusy(true);
    setConversationError(null);
    try {
      publishReading(await promoteJournalReadingConversation({
        runId: readerContext.runId,
        paperId: readerContext.paperId,
        conversationId: activeConversationId,
        clientRequestId: requestIdFor(key, "promote"),
        confirmedBy: "local-user",
      }));
    } catch (error) {
      setConversationError(error);
    } finally {
      setConversationBusy(false);
    }
  };
  const walkDocument = readerContext?.document ?? null;
  const walkSections = useMemo(
    () => readingSections(walkDocument),
    [walkDocument?.blocks],
  );
  const activeSectionIndex = Math.max(
    walkSections.findIndex((section) => section.blockIds.includes(readerContext?.activeBlockId)),
    0,
  );
  const sectionTotal = walkSections.length;
  const sectionHasNext = activeSectionIndex < sectionTotal - 1;
  const walkDisabled = !modelAvailable || chatState.status === "running";

  const askOverview = () => {
    if (walkDisabled) return;
    void submit({
      clientRequestId: createChatRequestId(),
      text: "请先带我把这篇论文过一遍：用几句话讲清整体脉络（各部分分别在做什么、怎么串起来），再指出最该重点看的 2-3 个地方以及原因。",
      reference: null,
      includeProjectContext,
    });
  };

  const depthInstruction = readingDepth === "novice"
    ? "面向没有相关背景的读者：多打比方、尽量少堆术语，必要时补上最基础的背景知识。"
    : readingDepth === "expert"
      ? "面向熟悉该领域的读者：可以深入方法细节与局限，并指出值得存疑的地方。"
      : "面向有一定基础的读者：兼顾准确与易懂。";
  const inlineTermsInstruction = "讲解中遇到关键专业名词时，请顺手用「名词：一句话大白话解释」的形式就地点破，不要打断整体节奏。";

  const teachSection = (index, intent = "read") => {
    if (walkDisabled) return;
    const section = walkSections[index];
    if (!section || !walkDocument?.revision) return;
    if (section.firstBlockId) onOpenCitation(section.firstBlockId);
    const title = section.title;
    let text;
    if (intent === "simpler") {
      text = `我还是没太懂「${title}」这部分。请用更基础、更口语化的方式重讲一遍，多打比方，并把里面的关键专业名词都用大白话解释清楚。`;
    } else if (intent === "rephrase") {
      text = `「${title}」这部分请换一个角度、换一种说法再讲一遍，帮我加深理解。${inlineTermsInstruction}`;
    } else if (intent === "terms") {
      text = `请列出「${title}」这部分里最关键的专业名词（挑最重要的 5 个以内），每个用一句话大白话解释，并说明它在这篇论文里为什么重要。`;
    } else if (intent === "translate") {
      text = `请把「${title}」这部分的原文翻译成流畅的简体中文，保留必要的英文术语并在括号里给出中文。`;
    } else if (intent === "quiz") {
      text = `基于「${title}」这部分的内容，出 2-3 道能检验我是否真的读懂的问题（先只给问题、不要给答案）。我回答后你再逐条点评。`;
    } else {
      text = `请带我读「${title}」这部分：先用一句话说清这部分在做什么，再按顺序讲清关键点、方法或结论，并指出容易卡住或需要留意的地方。${inlineTermsInstruction}${depthInstruction}`;
    }
    void submit({
      clientRequestId: createChatRequestId(),
      text,
      reference: { documentRevision: walkDocument.revision, blockIds: section.blockIds },
      includeProjectContext,
    });
  };

  const readCurrentSection = () => teachSection(activeSectionIndex, "read");
  const readNextSection = () => teachSection(activeSectionIndex + 1, "read");

  // Ten-round guided reading: progress is a client-side reading aid keyed by
  // paper conversation; it never advances the durable Run or reading stages.
  const durableRoundsTaught = chatState.turns.reduce((highest, turn) => {
    if (turn.status !== "answered" || turn.auditOnly || !turn.roundId) return highest;
    const roundId = turn.roundId === "orientation" ? "field" : turn.roundId;
    const index = READING_ROUNDS.findIndex((round) => round.id === roundId);
    return index < 0 ? highest : Math.max(highest, index + 1);
  }, 0);
  const legacyRoundsTaught = Number.isSafeInteger(roundProgress[roundKey])
    ? roundProgress[roundKey]
    : 0;
  const roundsTaught = Math.min(
    durableRoundsTaught > 0 ? durableRoundsTaught : legacyRoundsTaught,
    READING_ROUNDS.length,
  );
  const activeRoundIndex = Math.min(
    roundSelection ?? Math.min(roundsTaught, READING_ROUNDS.length - 1),
    READING_ROUNDS.length - 1,
  );
  const roundsCompleted = roundsTaught >= READING_ROUNDS.length;
  const roundHasNext = activeRoundIndex < READING_ROUNDS.length - 1;

  const teachRound = (index, intent = "read") => {
    if (walkDisabled) return;
    const round = READING_ROUNDS[index];
    if (!round || !walkDocument?.revision) return;
    const reference = readingRoundReference(round, walkSections);
    if (intent === "read" && reference?.firstBlockId) onOpenCitation(reference.firstBlockId);
    let text;
    if (intent === "simpler") {
      text = `我还是没太懂「${round.label}」这一步。请用更基础、更口语化的方式重讲一遍，多打比方，并把关键专业名词都用大白话解释清楚。`;
    } else if (intent === "rephrase") {
      text = `「${round.label}」这一步请换一个角度、换一种说法再讲一遍，帮我加深理解。${inlineTermsInstruction}`;
    } else if (intent === "terms") {
      text = `请列出「${round.label}」这一步涉及的最关键专业名词（挑最重要的 5 个以内），每个用一句话大白话解释，并说明它在这篇论文里为什么重要。`;
    } else if (intent === "quiz") {
      text = `基于我们刚读的「${round.label}」，再出 2-3 道能检验我是否真的读懂的选择题（先只给题目和选项，不要给答案）。我回答后你再逐条点评。`;
    } else {
      text = `${round.prompt}${ROUND_OUTPUT_FORMAT}${inlineTermsInstruction}${depthInstruction}`;
    }
    void submit({
      clientRequestId: createChatRequestId(),
      text,
      roundId: round.id,
      reference: reference
        ? { documentRevision: walkDocument.revision, blockIds: reference.blockIds }
        : null,
      includeProjectContext,
    });
    if (intent === "read") setRoundSelection(index);
  };

  const readCurrentRound = () => teachRound(activeRoundIndex, "read");
  const readNextRound = () => teachRound(activeRoundIndex + 1, "read");

  return (
    <section className="reader-agent" aria-label="论文 Agent 对话">
      <div className="reader-agent-conversations">
        <select
          aria-label="研读会话"
          value={activeConversationId}
          disabled={conversationBusy || chatState.status === "running"}
          onChange={(event) => handleSwitchConversation(event.target.value)}
        >
          {conversations.map((conversation) => (
            <option value={conversation.id} key={conversation.id}>
              {readingConversationLabel(conversation)}
              {conversation.turnCount ? `（${conversation.turnCount}）` : ""}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="reader-agent-conversation-new"
          disabled={conversationBusy || chatState.status === "running"}
          onClick={handleNewConversation}
        >
          ＋ 新建对话
        </button>
      </div>
      <div className={`reader-agent-branch-state${isScratchBranch ? " is-scratch" : " is-canonical"}`}>
        <div>
          <span>{isScratchBranch ? "草稿分支" : "主研读"}</span>
          <p>
            {isScratchBranch
              ? "用于探索不同思路；提升为主研读后才能生成或确认归档写入。"
              : "这是当前唯一可以进入归档的研读会话。"}
          </p>
        </div>
        {isScratchBranch ? (
          <button
            type="button"
            disabled={conversationBusy || chatState.status === "running"}
            onClick={handlePromoteConversation}
          >
            {conversationBusy ? "正在提升…" : "提升为主研读"}
          </button>
        ) : null}
      </div>
      {conversationError ? (
        <p className="reader-agent-conversation-error" role="status">
          {chatErrorMessage(conversationError, "暂时无法更新研读会话")}
        </p>
      ) : null}
      {!visibleChatTurns.length ? (
        <div className="reader-agent-empty">
          <BookOpenText size={20} aria-hidden="true" />
          <div>
            <strong>让 Agent 带你读这篇</strong>
            <p>先讲整体脉络与重点，再按章节带你读；你也可以随时打断提问，或选中原文追问。</p>
          </div>
          {sectionTotal > 0 ? (
            <button
              type="button"
              className="reader-agent-walk-start"
              disabled={walkDisabled}
              onClick={askOverview}
            >
              <BookOpenText size={15} weight="fill" aria-hidden="true" />先讲脉络与重点
            </button>
          ) : null}
          <div className="reader-agent-starters" aria-label="常用提问">
            {[
              "用直白语言解释这篇论文的核心机制",
              "这段论证最依赖什么假设？",
              "帮我区分作者的证据与推断",
            ].map((prompt) => (
              <button type="button" onClick={() => updateDraft(prompt)} key={prompt}>
                {prompt}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {visibleChatTurns.length ? (
        <div className="reader-agent-history" aria-label="Agent 对话历史" aria-live="polite">
          {visibleChatTurns.map((turn) => {
            const pinnedConclusion = pinnedConclusions.find(
              (conclusion) => (
                conclusion.sourceConversationId === activeConversationId
                && conclusion.sourceTurnId === turn.id
              ),
            );
            const pinKey = `${turn.id}:pin`;
            return (
              <article className={`is-${turn.status}`} key={turn.id}>
              <div className="reader-agent-question">
                {turn.reference?.quote ? (
                  <blockquote><PaperRichText content={turn.reference.quote} inline /></blockquote>
                ) : null}
                <p>{turn.question}</p>
              </div>
              {turn.status === "running" ? (
                <p className="reader-agent-turn-state is-thinking">
                  <span className="reader-agent-typing" aria-hidden="true"><i /><i /><i /></span>
                  Agent 正在思考…
                </p>
              ) : null}
              {turn.status === "answered" ? (
                <div className="reader-agent-answer">
                  <PaperRichText content={turn.answer ?? ""} />
                </div>
              ) : null}
              {turn.status === "failed" ? (
                <div className="reader-agent-turn-failed">
                  <p className="reader-agent-turn-state is-error">
                    <WarningCircle size={14} weight="fill" aria-hidden="true" />
                    {chatErrorMessage(turn.error)}
                  </p>
                  <button
                    type="button"
                    onClick={() => submit({
                      clientRequestId: createChatRequestId(),
                      text: turn.question,
                      roundId: turn.roundId ?? null,
                      reference: turn.reference ? {
                        ...turn.reference,
                        documentRevision: readerContext.document?.revision,
                      } : null,
                      includeProjectContext: turn.includeProjectContext,
                    })}
                  >
                    重试
                  </button>
                </div>
              ) : null}
              {turn.citations?.length ? (
                <div className="reader-agent-citations" aria-label="回答引用">
                  {turn.citations.map((citation, index) => (
                    <button
                      type="button"
                      onClick={() => onOpenCitation(citation.blockId)}
                      key={`${turn.id}-${citation.blockId}-${index}`}
                    >
                      <Quotes size={13} aria-hidden="true" />
                      <span>{citationLabel(citation)}</span>
                    </button>
                  ))}
                </div>
              ) : null}
              {turn.status === "answered" ? (
                <div className="reader-agent-note-entry">
                  <button
                    type="button"
                    disabled={
                      Boolean(noteActionState.busyKey)
                      || Boolean(pinnedConclusion)
                      || !turn.citations?.length
                    }
                    title={
                      turn.citations?.length
                        ? "固定到阅读笔记，不会批准或执行任何归档写入"
                        : "需要至少一条已验证的原文引用才能固定"
                    }
                    onClick={() => pinConclusion(turn)}
                  >
                    {noteActionState.busyKey === pinKey
                      ? <CircleNotch className="is-spinning" size={14} aria-hidden="true" />
                      : <PushPin size={14} weight={pinnedConclusion ? "fill" : "regular"} aria-hidden="true" />}
                    {pinnedConclusion ? "已固定到阅读笔记" : "固定结论"}
                  </button>
                  {!isScratchBranch && !turn.noteAction ? (
                    <button
                      type="button"
                      disabled={Boolean(noteActionState.busyKey)}
                      onClick={() => createNoteProposal(turn)}
                    >
                      {noteActionState.busyKey === `${turn.id}:preview`
                        ? <CircleNotch className="is-spinning" size={14} aria-hidden="true" />
                        : <FileText size={14} aria-hidden="true" />}
                      整理到 Obsidian 笔记
                    </button>
                  ) : null}
                  {isScratchBranch ? (
                    <span>草稿分支只保存阅读探索，不生成归档写入。</span>
                  ) : null}
                  {noteActionState.errors[pinKey] ? (
                    <p className="reader-agent-note-error" role="status">
                      {chatErrorMessage(
                        noteActionState.errors[pinKey],
                        "暂时无法固定这条结论",
                      )}
                    </p>
                  ) : null}
                  {noteActionState.errors[`${turn.id}:preview`] ? (
                    <p className="reader-agent-note-error" role="status">
                      {chatErrorMessage(noteActionState.errors[`${turn.id}:preview`])}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {turn.noteAction ? (
                <ChatObsidianProposalCard
                  action={turn.noteAction}
                  writeBlocked={isScratchBranch}
                  busy={noteActionState.busyKey?.startsWith(turn.noteAction.proposalId)}
                  error={
                    noteActionState.errors[`${turn.noteAction.proposalId}:commit`]
                    || noteActionState.errors[`${turn.noteAction.proposalId}:abandon`]
                  }
                  onCommit={() => commitNoteProposal(turn)}
                  onAbandon={() => abandonNoteProposal(turn)}
                  onRegenerate={() => createNoteProposal(turn)}
                />
              ) : null}
              <small>
                {turnModelLabel(turn, providers) || "当前模型"}
                {" · "}
                {turnContextLabel(turn)}
              </small>
              </article>
            );
          })}
        </div>
      ) : null}

      {reference ? (
        <div className="reader-agent-reference">
          <Quotes size={14} aria-hidden="true" />
          <p>
            <strong>已引用原文</strong>
            <span><PaperRichText content={reference.quote} inline /></span>
          </p>
          <button
            type="button"
            aria-label="移除原文引用"
            onClick={() => onReferenceChange({ reference: null, error: null })}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      ) : null}
      {referenceError ? <p className="reader-agent-reference-error" role="status">{referenceError}</p> : null}

      {sectionTotal > 0 ? (
        <div className={`reader-agent-walk${walkOpen ? "" : " is-collapsed"}`} aria-label="带读">
          <div className="reader-agent-walk-bar">
            <span className="reader-agent-walk-label">
              <BookOpenText size={14} weight="fill" aria-hidden="true" />带读
            </span>
            {walkOpen ? (
              <div className="reader-agent-walk-modes" role="tablist" aria-label="带读方式">
                <button
                  type="button"
                  role="tab"
                  aria-selected={walkMode === "rounds"}
                  className={walkMode === "rounds" ? "is-active" : ""}
                  onClick={() => setWalkMode("rounds")}
                >
                  十步导读
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={walkMode === "sections"}
                  className={walkMode === "sections" ? "is-active" : ""}
                  onClick={() => setWalkMode("sections")}
                >
                  按章节读
                </button>
              </div>
            ) : null}
            {walkOpen && walkMode === "rounds" ? (
              <span className="reader-agent-walk-progress" aria-label="十步进度">
                {roundsTaught}/{READING_ROUNDS.length}
              </span>
            ) : null}
            <button
              type="button"
              className="reader-agent-walk-toggle"
              aria-expanded={walkOpen}
              onClick={() => setWalkOpen((open) => !open)}
            >
              {walkOpen ? "收起" : "展开"}
            </button>
          </div>
          {walkOpen && walkMode === "rounds" ? (
            <>
              <div className="reader-agent-walk-row">
                <label className="reader-agent-walk-pick">
                  <BookOpenText size={14} weight="fill" aria-hidden="true" />
                  <select
                    aria-label="选择要读的步骤"
                    value={activeRoundIndex}
                    onChange={(event) => setRoundSelection(Number(event.target.value))}
                  >
                    {READING_ROUNDS.map((round, index) => (
                      <option value={index} key={round.id}>
                        {index < roundsTaught ? "✓ " : ""}第 {index + 1} 步 · {round.label}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="is-primary"
                  disabled={walkDisabled}
                  onClick={readCurrentRound}
                >
                  读这一步
                </button>
                <button
                  type="button"
                  disabled={walkDisabled || !roundHasNext}
                  onClick={readNextRound}
                >
                  下一步<ArrowRight size={14} weight="bold" aria-hidden="true" />
                </button>
                <details className="reader-agent-walk-more">
                  <summary aria-label="更多带读操作">⋯</summary>
                  <div className="reader-agent-walk-more-menu">
                    <button type="button" disabled={walkDisabled} onClick={askOverview}>讲讲整体脉络</button>
                    <button type="button" disabled={walkDisabled} onClick={() => teachRound(activeRoundIndex, "simpler")}>再浅一点</button>
                    <button type="button" disabled={walkDisabled} onClick={() => teachRound(activeRoundIndex, "rephrase")}>换个说法</button>
                    <button type="button" disabled={walkDisabled} onClick={() => teachRound(activeRoundIndex, "terms")}>本步术语</button>
                    <button type="button" disabled={walkDisabled} onClick={() => teachRound(activeRoundIndex, "quiz")}>考考我</button>
                    <label className="reader-agent-walk-depth">
                      讲解深浅
                      <select
                        aria-label="讲解深浅"
                        value={readingDepth}
                        onChange={(event) => setReadingDepth(event.target.value)}
                      >
                        <option value="novice">小白</option>
                        <option value="normal">一般</option>
                        <option value="expert">进阶</option>
                      </select>
                    </label>
                  </div>
                </details>
              </div>
              {roundsCompleted ? (
                <p className="reader-agent-walk-complete" role="status">
                  {isScratchBranch
                    ? "十步已完成 · 可继续固定关键结论；草稿分支不会进入归档。"
                    : "十步已完成 · 可固定关键结论，或进入归档整理。"}
                </p>
              ) : null}
            </>
          ) : null}
          {walkOpen && walkMode === "sections" ? (
            <div className="reader-agent-walk-row">
              <label className="reader-agent-walk-pick">
                <BookOpenText size={14} weight="fill" aria-hidden="true" />
                <select
                  aria-label="选择要读的部分"
                  value={activeSectionIndex}
                  onChange={(event) => {
                    const target = walkSections[Number(event.target.value)];
                    if (target?.firstBlockId) onOpenCitation(target.firstBlockId);
                  }}
                >
                  {walkSections.map((section, index) => (
                    <option value={index} key={section.firstBlockId ?? index}>
                      {index + 1}. {section.title}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="is-primary"
                disabled={walkDisabled}
                onClick={readCurrentSection}
              >
                带我读这部分
              </button>
              <button
                type="button"
                disabled={walkDisabled || !sectionHasNext}
                onClick={readNextSection}
              >
                读下一部分<ArrowRight size={14} weight="bold" aria-hidden="true" />
              </button>
              <details className="reader-agent-walk-more">
                <summary aria-label="更多带读操作">⋯</summary>
                <div className="reader-agent-walk-more-menu">
                  <button type="button" disabled={walkDisabled} onClick={askOverview}>讲讲整体脉络</button>
                  <button type="button" disabled={walkDisabled} onClick={() => teachSection(activeSectionIndex, "simpler")}>再浅一点</button>
                  <button type="button" disabled={walkDisabled} onClick={() => teachSection(activeSectionIndex, "rephrase")}>换个说法</button>
                  <button type="button" disabled={walkDisabled} onClick={() => teachSection(activeSectionIndex, "terms")}>本部分术语</button>
                  <button type="button" disabled={walkDisabled} onClick={() => teachSection(activeSectionIndex, "translate")}>翻译本部分</button>
                  <button type="button" disabled={walkDisabled} onClick={() => teachSection(activeSectionIndex, "quiz")}>考考我</button>
                  <label className="reader-agent-walk-depth">
                    讲解深浅
                    <select
                      aria-label="讲解深浅"
                      value={readingDepth}
                      onChange={(event) => setReadingDepth(event.target.value)}
                    >
                      <option value="novice">小白</option>
                      <option value="normal">一般</option>
                      <option value="expert">进阶</option>
                    </select>
                  </label>
                </div>
              </details>
            </div>
          ) : null}
        </div>
      ) : null}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <textarea
          aria-label="给论文 Agent 的任务"
          rows="2"
          maxLength="1000"
          value={draft}
          placeholder="解释、翻译、比较，或让 Agent 整理一份草稿…"
          onChange={(event) => updateDraft(event.target.value)}
          onKeyDown={handleProjectComposerKeyDown}
          aria-keyshortcuts="Enter"
        />
        <div>
          <label className={includeProjectContext ? "is-active" : ""}>
            <input
              type="checkbox"
              checked={includeProjectContext}
              onChange={(event) => {
                setIncludeProjectContext(event.target.checked);
                setChatState((current) => ({ ...current, error: null }));
              }}
            />
            结合项目
          </label>
          <button
            type="submit"
            aria-label="发送给论文 Agent"
            disabled={!draft.trim() || !modelAvailable || chatState.status === "running"}
          >
            {chatState.status === "running"
              ? <CircleNotch className="is-spinning" size={16} aria-hidden="true" />
              : <PaperPlaneTilt size={16} weight="fill" aria-hidden="true" />}
          </button>
        </div>
      </form>

      {!modelAvailable ? <p className="reader-agent-hint">请选择一个可用模型。</p> : null}
    </section>
  );
}

export function WorkflowContextRail({
  run,
  liveRun = null,
  papers = [],
  preferredPaperId,
  mobileActive,
  readerContext = null,
  readerSelectionState = null,
  activeView = "evidence",
  onActiveViewChange,
  providers = [],
  providerId = null,
  modelId = null,
  projectContextState = null,
  onReloadProjectContext,
  onOpenReaderBlock,
  onReaderReadingChange,
  onReaderSelectionChange,
  onMouseDownResizer,
  isResizing,
}) {
  const tabRefs = useRef([]);
  const stages = workflowFixture.readingStages ?? [];
  const stage = String(run?.status ?? "").toLowerCase() === "reading"
    ? stages[getStageIndex(run, stages)]
    : null;
  const paper = getActivePaper(run, papers, preferredPaperId);
  const readerReady = readerContext?.purpose === "close-reading"
    && readerContext?.status === "ready"
    && Boolean(readerContext.document);
  const readerViews = new Set(["agent", "notes", "state"]);
  const runViews = new Set(["evidence", "state"]);
  const safeView = readerReady
    ? readerViews.has(activeView) ? activeView : "agent"
    : runViews.has(activeView) ? activeView : "evidence";
  const tabs = readerReady
    ? [
        { id: "agent", label: "论文 Agent" },
        { id: "notes", label: "阅读笔记" },
        { id: "state", label: "项目" },
      ]
    : [
        { id: "evidence", label: "当前依据" },
        { id: "state", label: "项目状态" },
      ];
  const selectionState = readerSelectionState ?? { reference: null, error: null };

  const selectView = (view) => {
    onActiveViewChange?.(view);
  };

  const handleTabKeyDown = (event, index) => {
    let nextIndex = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabs.length - 1;
    if (nextIndex !== null) {
      event.preventDefault();
      selectView(tabs[nextIndex].id);
      tabRefs.current[nextIndex]?.focus();
    }
  };

  const openCitation = (blockId) => {
    if (!blockId) return;
    onOpenReaderBlock?.(blockId);
  };

  return (
    <aside className={`context-rail workflow-context-rail${readerReady ? " is-reader-ready" : ""}${mobileActive ? " is-mobile-active" : ""}`} aria-label={readerReady ? "论文协作区" : "运行上下文"}>
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
          <span className="workflow-kicker">{readerReady ? "当前论文" : "当前 Run"}</span>
          <h2>{readerReady ? "论文协作" : "运行上下文"}</h2>
        </div>
      </header>

      <div className="workflow-context-content">
        <nav className="context-tabs" aria-label={readerReady ? "论文协作分类" : "运行上下文分类"} role="tablist">
          {tabs.map((tab, index) => {
            const isActive = safeView === tab.id;
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
                onClick={() => selectView(tab.id)}
                onKeyDown={(event) => handleTabKeyDown(event, index)}
              >
                {tab.label}
              </button>
            );
          })}
        </nav>

        <div
          id={`workflow-context-panel-${safeView}`}
          role="tabpanel"
          aria-labelledby={`workflow-context-tab-${safeView}`}
          tabIndex={0}
        >
          {safeView === "evidence" ? (
            <EvidenceSection
              paper={paper}
              stage={stage}
              run={run}
              liveRun={liveRun}
            />
          ) : null}
          {safeView === "agent" ? (
            <ReaderAgentComposer
              key={readerContext.key}
              readerContext={readerContext}
              providers={providers}
              providerId={providerId}
              modelId={modelId}
              reference={selectionState.reference}
              referenceError={selectionState.error}
              onReferenceChange={onReaderSelectionChange ?? NOOP_SELECTION_CHANGE}
              onOpenCitation={openCitation}
              onReadingChange={onReaderReadingChange}
            />
          ) : null}
          {safeView === "notes" ? (
            <ReadingNotesPanel
              readerContext={readerContext}
              onOpenBlock={openCitation}
              onReadingChange={onReaderReadingChange}
            />
          ) : null}
          {safeView === "state" ? (
            <ProjectStateSection
              projectContextState={projectContextState}
              onReload={onReloadProjectContext}
            />
          ) : null}
        </div>
      </div>
    </aside>
  );
}
