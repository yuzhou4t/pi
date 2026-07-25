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
  sendJournalReadingChatMessage,
  switchJournalReadingConversation,
} from "../api/journalRuns.js";
import { getModelDisplayName } from "../data.js";
import { workflowFixture } from "../workflow/fixtures.js";
import { PaperRichText } from "./PaperRichText.jsx";

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

function readingSections(document) {
  const blocks = readableReaderBlocks(document?.blocks);
  const bodyBlocks = blocks.filter(
    (block) => (Array.isArray(block.path) ? block.path.filter(Boolean) : []).length >= 1,
  );
  // If every body block shares one path[0], it is the paper title and real chapters live at path[1].
  const roots = new Set(bodyBlocks.map((block) => block.path.filter(Boolean)[0]));
  const chapterDepth = roots.size === 1 && bodyBlocks.length > 3 ? 1 : 0;

  const sections = [];
  let current = null;
  for (const block of blocks) {
    const path = Array.isArray(block.path) ? block.path.filter(Boolean) : [];
    // Skip front-matter / title / author blocks — they are not a walkable chapter.
    if (path.length <= chapterDepth) continue;
    const rawTitle = path[chapterDepth];
    // Collapse numbered subsections (3.1, 3.2, B.8…) into their top-level chapter.
    const groupKey = sectionChapterKey(rawTitle) ?? rawTitle;
    if (!current || current.groupKey !== groupKey) {
      current = { groupKey, title: rawTitle, firstBlockId: block.id, blockIds: [] };
      sections.push(current);
    }
    current.blockIds.push(block.id);
  }
  return sections;
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
  onCommit,
  onAbandon,
  onRegenerate,
}) {
  const state = agentActionStatus(action);
  const diff = agentActionDiff(action);
  const canCommit = ["draft", "proposal_ready", "failed"].includes(action.status);
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
        只修改这篇论文的 Agent 补充区；不会推进精读阶段。
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
      {action.status === "abandoned" ? (
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
        <div><strong>{paper?.shortTitle ?? paper?.title}</strong><p>{paper?.venue} · {paper?.publishedAt ?? paper?.published_at}</p></div>
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

  const projectState = projectContextState?.data ?? workflowFixture.projectState ?? {};
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

export function ReadingNotesPanel({ readerContext, onOpenBlock }) {
  const reading = readerContext?.reading;
  const completedCount = READING_NOTE_LENSES.filter(
    (lens) => reading?.stages?.[lens.id]?.status === "ready",
  ).length;

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
          <span>本篇覆盖</span>
          <h3 id="reader-notes-title">{completedCount}/4 项研读结论</h3>
        </div>
        <small>结论与原文引用分开保存</small>
      </header>

      <div className="reader-notes-list">
        {READING_NOTE_LENSES.map((lens) => {
          const stage = reading.stages?.[lens.id] ?? {};
          const ready = stage.status === "ready" && Boolean(stage.result);
          return (
            <article className={`is-${stage.status ?? "not_started"}`} key={lens.id}>
              <header>
                <div>
                  {ready
                    ? <CheckCircle size={15} weight="fill" aria-hidden="true" />
                    : stage.status === "running"
                      ? <CircleNotch className="is-spinning" size={15} aria-hidden="true" />
                      : <Circle size={15} aria-hidden="true" />}
                  <strong>{lens.label}</strong>
                </div>
                <span>{ready ? "已整理" : stage.status === "running" ? "整理中" : "尚未整理"}</span>
              </header>
              {ready ? (
                <>
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
                </>
              ) : (
                <p className="reader-notes-placeholder">
                  整理研读结论后，这一项会出现在这里。
                </p>
              )}
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
  const noteActionRequestIds = useRef(new Map());
  const sessionKey = readerContext?.key ?? null;
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
    if (noteActionState.busyKey) return;
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
  const [walkOpen, setWalkOpen] = useState(true);
  const [conversationBusy, setConversationBusy] = useState(false);
  const conversations = readerContext?.reading?.conversations ?? [];
  const activeConversationId = readerContext?.reading?.activeConversationId ?? "current";

  const handleNewConversation = async () => {
    if (conversationBusy) return;
    setConversationBusy(true);
    try {
      publishReading(await createJournalReadingConversation({
        runId: readerContext.runId,
        paperId: readerContext.paperId,
      }));
      onReferenceChange({ reference: null, error: null });
    } catch (error) {
      setChatState((current) => ({ ...current, error }));
    } finally {
      setConversationBusy(false);
    }
  };

  const handleSwitchConversation = async (conversationId) => {
    if (conversationBusy || conversationId === activeConversationId) return;
    setConversationBusy(true);
    try {
      publishReading(await switchJournalReadingConversation({
        runId: readerContext.runId,
        paperId: readerContext.paperId,
        conversationId,
      }));
      onReferenceChange({ reference: null, error: null });
    } catch (error) {
      setChatState((current) => ({ ...current, error }));
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
  const overviewFiredRef = useRef(null);

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

  useEffect(() => {
    if (!sessionKey || overviewFiredRef.current === sessionKey) return;
    if (chatState.status === "running") return;
    if (chatState.turns.length > 0) {
      overviewFiredRef.current = sessionKey;
      return;
    }
    if (!modelAvailable || sectionTotal === 0) return;
    overviewFiredRef.current = sessionKey;
    askOverview();
  }, [sessionKey, chatState.turns.length, chatState.status, modelAvailable, sectionTotal]);

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
              {conversation.title}{conversation.turnCount ? `（${conversation.turnCount}）` : ""}
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
      {!chatState.turns.length ? (
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

      {chatState.turns.length ? (
        <div className="reader-agent-history" aria-label="Agent 对话历史" aria-live="polite">
          {chatState.turns.map((turn) => (
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
              {turn.status === "answered" ? <p className="reader-agent-answer">{turn.answer}</p> : null}
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
              {turn.status === "answered" && !turn.noteAction ? (
                <div className="reader-agent-note-entry">
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
          ))}
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
            <button
              type="button"
              className="reader-agent-walk-toggle"
              aria-expanded={walkOpen}
              onClick={() => setWalkOpen((open) => !open)}
            >
              {walkOpen ? "收起" : "展开"}
            </button>
          </div>
          {walkOpen ? (
            <>
          <div className="reader-agent-walk-head">
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
          <div className="reader-agent-walk-actions">
            <button type="button" disabled={walkDisabled} onClick={askOverview}>讲讲整体脉络</button>
            <button type="button" className="is-primary" disabled={walkDisabled} onClick={readCurrentSection}>带我读这部分</button>
            <button
              type="button"
              disabled={walkDisabled || !sectionHasNext}
              onClick={readNextSection}
            >
              读下一部分<ArrowRight size={14} weight="bold" aria-hidden="true" />
            </button>
          </div>
          <div className="reader-agent-walk-actions is-secondary">
            <button type="button" disabled={walkDisabled} onClick={() => teachSection(activeSectionIndex, "simpler")}>再浅一点</button>
            <button type="button" disabled={walkDisabled} onClick={() => teachSection(activeSectionIndex, "rephrase")}>换个说法</button>
            <button type="button" disabled={walkDisabled} onClick={() => teachSection(activeSectionIndex, "terms")}>本部分术语</button>
            <button type="button" disabled={walkDisabled} onClick={() => teachSection(activeSectionIndex, "translate")}>翻译本部分</button>
            <button type="button" disabled={walkDisabled} onClick={() => teachSection(activeSectionIndex, "quiz")}>考考我</button>
          </div>
            </>
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
  papers = workflowFixture.papers ?? [],
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
          {safeView === "evidence" ? <EvidenceSection paper={paper} stage={stage} /> : null}
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
