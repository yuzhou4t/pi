import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowClockwise,
  ArrowLeft,
  ArrowRight,
  BookOpenText,
  BookmarkSimple,
  CheckCircle,
  CircleNotch,
  FilePdf,
  ListBullets,
  Quotes,
  Sparkle,
  Translate,
} from "@phosphor-icons/react";
import {
  fetchJournalPaperDocument,
  fetchJournalPaperReading,
  fetchJournalPaperTranslation,
  generateJournalReadingStage,
  saveJournalReadingPosition,
  startJournalPaperTranslation,
} from "../api/journalRuns.js";
import { usePersistentState } from "../hooks/usePersistentState.js";
import { PaperRichText } from "./PaperRichText.jsx";
import { selectionReferenceFromDom } from "./WorkflowContextRail.jsx";

export const READING_LENSES = [
  {
    id: "research-question",
    label: "研究问题",
    description: "厘清论文真正要解决的问题、研究边界与核心主张。",
  },
  {
    id: "method",
    label: "方法机制",
    description: "拆开方法如何运作，找出关键假设和容易被忽略的条件。",
  },
  {
    id: "evidence",
    label: "实验依据",
    description: "核对实验设计、主要证据、对照关系和结果的适用边界。",
  },
  {
    id: "project-relation",
    label: "项目关系",
    description: "综合前三项后，判断它对当前项目的启发、风险与行动。",
  },
];

function errorMessage(error, fallback = "请求失败，请稍后重试") {
  if (typeof error === "string" && error.trim()) return error;
  if (typeof error?.message === "string" && error.message.trim()) return error.message;
  return fallback;
}

function readingBlocks(blocks) {
  return blocks.filter((block) => (
    block.kind !== "heading"
    && (block.text?.trim() || block.markdown?.trim())
  ));
}

function blockCopy(block) {
  if (!block) return "";
  if (block.kind === "table") return block.markdown?.trim() ?? block.text?.trim() ?? "";
  return block.text?.trim() || block.markdown?.trim() || "";
}

function locationLabel(block) {
  const path = block?.path?.filter(Boolean) ?? [];
  return path.slice(1).join(" › ") || "论文正文";
}

function activateOnKeyboard(event, action) {
  if (!["Enter", " "].includes(event.key)) return;
  event.preventDefault();
  action();
}

function FullBlock({
  block,
  section,
  active,
  activeRef,
  onActivate,
  zh = null,
  language = "original",
}) {
  const copy = blockCopy(block);
  if (block.kind === "heading") {
    const Heading = section?.level >= 3 ? "h4" : "h3";
    return (
      <Heading
        ref={active ? activeRef : null}
        className={`paper-reader-full-heading${active ? " is-active" : ""}`}
        id={block.id}
        data-reader-block-id={block.id}
        data-source-start="0"
        data-source-end={String(copy.length)}
        aria-current={active ? "location" : undefined}
      >
        {copy}
      </Heading>
    );
  }
  if (block.kind === "image") {
    return (
      <figure
        ref={active ? activeRef : null}
        className={`paper-reader-figure${active ? " is-active" : ""}`}
        id={block.id}
        data-reader-block-id={block.id}
        role="button"
        tabIndex="0"
        aria-current={active ? "location" : undefined}
        aria-label={`把图表设为当前阅读位置：${copy || "图表"}`}
        onClick={() => onActivate(block.id)}
        onKeyDown={(event) => activateOnKeyboard(event, () => onActivate(block.id))}
      >
        {block.imageUrl ? (
          <img
            className="paper-reader-figure-img"
            src={block.imageUrl}
            alt={copy || "论文图表"}
            loading="lazy"
          />
        ) : (
          <span>图表</span>
        )}
        <figcaption data-source-start="0" data-source-end={String(copy.length)}>
          {copy || (block.imageUrl ? "论文图表" : "请在原版论文中查看这一图表。")}
        </figcaption>
      </figure>
    );
  }
  return (
    <article
      ref={active ? activeRef : null}
      className={`paper-reader-full-block is-${block.kind}${active ? " is-active" : ""}`}
      id={block.id}
      data-reader-block-id={block.id}
      role="button"
      tabIndex="0"
      aria-current={active ? "location" : undefined}
      aria-label={`把这一段设为当前阅读位置：${copy.slice(0, 80)}`}
      onClick={() => onActivate(block.id)}
      onKeyDown={(event) => activateOnKeyboard(event, () => onActivate(block.id))}
    >
      {language === "zh" && zh ? (
        <div className="paper-reader-zh is-only" data-reader-zh="true">
          <PaperRichText content={zh} />
        </div>
      ) : (
        <>
          <PaperRichText content={copy} />
          {language === "bilingual" && zh ? (
            <div className="paper-reader-zh" data-reader-zh="true">
              <PaperRichText content={zh} />
            </div>
          ) : null}
        </>
      )}
    </article>
  );
}

function GuideOrientation({
  guide,
  open,
  decision,
  canDecide,
  busy,
  onOpenChange,
  onDecision,
  onOpenReference,
}) {
  const sections = [
    ["这篇论文解决什么问题", guide?.problem],
    ["为什么值得读", guide?.whyRead ?? guide?.why_read ?? guide?.whyNow],
    ["方法的核心直觉", guide?.intuition],
    ["作者提供的主要证据", guide?.evidence],
    ["局限与待核验内容", guide?.limitations ?? guide?.limits],
  ].filter(([, value]) => Boolean(value));
  const questions = guide?.questions ?? [];
  const references = guide?.references ?? [];
  if (!guide && !canDecide) return null;

  return (
    <section className={`paper-reader-orientation${open ? " is-open" : ""}`}>
      <button
        className="paper-reader-orientation-toggle"
        type="button"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      >
        <span>
          <Sparkle size={16} weight="fill" aria-hidden="true" />
          <strong>五分钟定向</strong>
          <small>{open ? "收起后继续阅读全文" : "快速找准问题、方法、证据与局限"}</small>
        </span>
        <span>{open ? "收起" : "展开"}</span>
      </button>

      {open ? (
        <div className="paper-reader-orientation-body">
          {!guide ? (
            <p className="paper-reader-orientation-loading" role="status">
              <CircleNotch className="is-spinning" size={16} aria-hidden="true" />
              正在读取导读…
            </p>
          ) : (
            <>
              <div className="paper-reader-orientation-grid">
                {sections.map(([label, value]) => (
                  <article key={label}>
                    <h3>{label}</h3>
                    <p>{value}</p>
                  </article>
                ))}
              </div>
              {questions.length ? (
                <aside className="paper-reader-orientation-questions">
                  <Quotes size={16} weight="fill" aria-hidden="true" />
                  <div>
                    <strong>带着这些问题读</strong>
                    <ol>{questions.map((question) => <li key={question}>{question}</li>)}</ol>
                  </div>
                </aside>
              ) : null}
              {references.length ? (
                <div className="paper-reader-orientation-references" aria-label="导读引用">
                  <span>原文依据</span>
                  {references.map((reference) => (
                    <button
                      type="button"
                      onClick={() => onOpenReference(reference.blockId)}
                      key={reference.blockId}
                    >
                      {reference.path?.slice(-2).join(" › ")
                        || (Number.isSafeInteger(reference.ordinal)
                          ? `第 ${reference.ordinal} 段`
                          : "查看原文")}
                    </button>
                  ))}
                </div>
              ) : null}
            </>
          )}

          {canDecide ? (
            <footer className="paper-reader-orientation-actions">
              <p>
                {decision === "read"
                  ? "已选择进入研读；阅读结果仍需在最终预览中确认后才会写入。"
                  : decision === "collect"
                    ? "已选择只收藏导读；你仍可改为进入研读。"
                    : "先阅读全文或快速定向，再决定是否投入研读。"}
              </p>
              <div>
                <button
                  className={decision === "collect" ? "is-selected" : ""}
                  type="button"
                  disabled={busy}
                  onClick={() => onDecision("collect")}
                >
                  <BookmarkSimple size={15} aria-hidden="true" />只收藏导读
                </button>
                <button
                  className={`is-primary${decision === "read" ? " is-selected" : ""}`}
                  type="button"
                  disabled={busy}
                  onClick={() => onDecision("read")}
                >
                  <BookOpenText size={15} aria-hidden="true" />进入研读
                </button>
              </div>
            </footer>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function PaperReader({
  runId,
  paper,
  initialBlockId = null,
  purpose = "document",
  providerId = null,
  modelId = null,
  guide = null,
  guideDecision = null,
  guideDecisionBusy = false,
  peerPapers = [],
  onSwitchPaper,
  onGuideDecision,
  onSelectionChange,
  onReaderContextChange,
  onReadingChange,
  onClose,
}) {
  const [request, setRequest] = useState({ status: "loading", document: null, error: null });
  const [documentRetryKey, setDocumentRetryKey] = useState(0);
  const [readingRequest, setReadingRequest] = useState({
    status: purpose === "close-reading" ? "loading" : "idle",
    reading: null,
    error: null,
  });
  const [mode, setMode] = useState("full");
  const [activeBlockId, setActiveBlockId] = useState(null);
  const [contextOpen, setContextOpen] = useState(false);
  const [orientationOpen, setOrientationOpen] = useState(purpose === "orientation");
  const [compileStatus, setCompileStatus] = useState("idle");
  const [compileError, setCompileError] = useState(null);
  const [positionStatus, setPositionStatus] = useState("idle");
  const [language, setLanguage] = usePersistentState("pi-reader-language", "original");
  const [translationState, setTranslationState] = useState({
    status: "idle",
    translation: null,
    starting: false,
    error: null,
  });
  const [translationRefreshKey, setTranslationRefreshKey] = useState(0);
  const contentTitleRef = useRef(null);
  const focusedTabRef = useRef(null);
  const fullTabRef = useRef(null);
  const fullDocumentRef = useRef(null);
  const activeFullBlockRef = useRef(null);
  const restoredPositionRef = useRef(null);
  const savedPositionRef = useRef(null);
  const pendingScrollRef = useRef(false);
  const initialBlockIdRef = useRef(initialBlockId);
  const closeReading = purpose === "close-reading";
  const orientationMode = purpose === "orientation";
  const modelAvailable = Boolean(providerId && modelId);
  initialBlockIdRef.current = initialBlockId;

  useEffect(() => {
    const controller = new AbortController();
    setRequest({ status: "loading", document: null, error: null });
    setMode("full");
    setContextOpen(false);
    setOrientationOpen(purpose === "orientation");
    restoredPositionRef.current = null;
    savedPositionRef.current = null;
    fetchJournalPaperDocument(runId, paper.id, { signal: controller.signal })
      .then((document) => {
        const readableBlocks = readingBlocks(document.blocks);
        const requestedBlockId = initialBlockIdRef.current;
        const exact = readableBlocks.find((block) => block.id === requestedBlockId);
        const sourceIndex = document.blocks.findIndex((block) => block.id === requestedBlockId);
        const nearest = exact ?? document.blocks
          .slice(Math.max(sourceIndex, 0))
          .map((block) => readableBlocks.find((candidate) => candidate.id === block.id))
          .find(Boolean);
        pendingScrollRef.current = Boolean(nearest);
        setRequest({ status: "ready", document, error: null });
        setActiveBlockId(nearest?.id ?? readableBlocks[0]?.id ?? document.blocks[0]?.id ?? null);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setRequest({ status: "error", document: null, error: error.message });
      });
    return () => controller.abort();
  }, [documentRetryKey, paper.id, purpose, runId]);

  useEffect(() => {
    if (!closeReading) {
      setReadingRequest({ status: "idle", reading: null, error: null });
      return undefined;
    }
    const controller = new AbortController();
    setReadingRequest({ status: "loading", reading: null, error: null });
    setCompileStatus("idle");
    setCompileError(null);
    fetchJournalPaperReading(runId, paper.id, { signal: controller.signal })
      .then((reading) => {
        setReadingRequest({ status: "ready", reading, error: null });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setReadingRequest({ status: "error", reading: null, error });
      });
    return () => controller.abort();
  }, [closeReading, documentRetryKey, paper.id, runId]);

  const paperDocument = request.document;
  const reading = readingRequest.reading;

  useEffect(() => {
    if (request.status !== "ready") return undefined;
    const controller = new AbortController();
    let cancelled = false;
    let timer = null;
    const load = async () => {
      try {
        const translation = await fetchJournalPaperTranslation(runId, paper.id, {
          signal: controller.signal,
        });
        if (cancelled) return;
        setTranslationState((current) => ({
          status: "ready",
          translation,
          starting: current.starting && translation.status === "running",
          error: null,
        }));
        if (translation.status === "running") {
          timer = window.setTimeout(load, 2500);
        }
      } catch (error) {
        if (cancelled || controller.signal.aborted) return;
        setTranslationState((current) => ({
          status: "error",
          translation: current.translation,
          starting: false,
          error: errorMessage(error, "无法读取全文翻译"),
        }));
      }
    };
    setTranslationState((current) => ({
      status: "loading",
      translation: current.translation,
      starting: current.starting,
      error: null,
    }));
    void load();
    return () => {
      cancelled = true;
      controller.abort();
      if (timer) window.clearTimeout(timer);
    };
  }, [paper.id, request.status, runId, translationRefreshKey]);

  const translation = translationState.translation;
  const translationBlocks = useMemo(() => (
    translation && translation.documentRevision === paperDocument?.revision
      ? translation.blocks
      : {}
  ), [paperDocument?.revision, translation]);
  const translationUsable = Object.keys(translationBlocks).length > 0;
  const effectiveLanguage = translationUsable ? language : "original";
  const readable = useMemo(
    () => readingBlocks(paperDocument?.blocks ?? []),
    [paperDocument?.blocks],
  );
  const sourceByBlockId = useMemo(
    () => new Map((paperDocument?.blocks ?? []).map((block) => [block.id, blockCopy(block)])),
    [paperDocument?.blocks],
  );
  const sectionsById = useMemo(
    () => new Map((paperDocument?.sections ?? []).map((section) => [section.id, section])),
    [paperDocument?.sections],
  );
  const activeIndex = Math.max(readable.findIndex((block) => block.id === activeBlockId), 0);
  const activeBlock = readable[activeIndex] ?? null;
  const previousBlock = readable[activeIndex - 1] ?? null;
  const nextBlock = readable[activeIndex + 1] ?? null;
  const completedStageCount = READING_LENSES.filter(
    (stage) => reading?.stages?.[stage.id]?.status === "ready",
  ).length;
  const allStagesReady = completedStageCount >= READING_LENSES.length;

  useEffect(() => {
    if (!closeReading || !paperDocument || !reading) return;
    const restoreKey = `${runId}:${paper.id}:${reading.documentRevision}`;
    if (restoredPositionRef.current === restoreKey) return;
    const restoredBlockId = initialBlockId ?? reading.position?.blockId;
    if (restoredBlockId && readable.some((block) => block.id === restoredBlockId)) {
      pendingScrollRef.current = true;
      setActiveBlockId(restoredBlockId);
    }
    setMode("full");
    restoredPositionRef.current = restoreKey;
  }, [
    closeReading,
    initialBlockId,
    paper.id,
    paperDocument,
    readable,
    reading,
    runId,
  ]);

  useEffect(() => {
    if (mode !== "full" || !pendingScrollRef.current || !activeFullBlockRef.current) return;
    pendingScrollRef.current = false;
    activeFullBlockRef.current.scrollIntoView?.({ block: "center", behavior: "smooth" });
  }, [activeBlockId, mode, request.status]);

  useEffect(() => {
    if (!closeReading) return undefined;
    onReaderContextChange?.({
      key: `${runId}:${paper.id}`,
      runId,
      paperId: paper.id,
      purpose,
      paper: {
        id: paper.id,
        title: paper.title ?? paperDocument?.title ?? "",
        venue: paper.venue ?? "",
      },
      status: request.status,
      error: request.error,
      document: paperDocument,
      activeBlockId,
      reading,
    });
    return undefined;
  }, [
    activeBlockId,
    closeReading,
    onReaderContextChange,
    paper.id,
    paper.title,
    paper.venue,
    paperDocument,
    purpose,
    reading,
    request.error,
    request.status,
    runId,
  ]);

  useEffect(() => {
    if (!closeReading) return undefined;
    return () => onReaderContextChange?.(null);
  }, [closeReading, onReaderContextChange, paper.id, runId]);

  useEffect(() => {
    if (
      !closeReading
      || readingRequest.status !== "ready"
      || request.status !== "ready"
      || !activeBlockId
    ) {
      return undefined;
    }
    const positionKey = `${runId}:${paper.id}:${mode}:${activeBlockId}`;
    if (savedPositionRef.current === positionKey) return undefined;
    const timer = window.setTimeout(() => {
      setPositionStatus("saving");
      saveJournalReadingPosition({
        runId,
        paperId: paper.id,
        mode,
        blockId: activeBlockId,
      })
        .then(() => {
          savedPositionRef.current = positionKey;
          setPositionStatus("saved");
        })
        .catch(() => setPositionStatus("failed"));
    }, 650);
    return () => window.clearTimeout(timer);
  }, [
    activeBlockId,
    closeReading,
    mode,
    paper.id,
    readingRequest.status,
    request.status,
    runId,
  ]);

  const focusContent = () => {
    window.requestAnimationFrame(() => contentTitleRef.current?.focus());
  };

  const [readerChromeOpen, setReaderChromeOpen] = useState(false);
  const chromeOpen = orientationMode || readerChromeOpen;

  const activateBlock = (blockId, { focused = false, scroll = false } = {}) => {
    const exact = readable.find((block) => block.id === blockId);
    const sourceIndex = paperDocument?.blocks.findIndex((block) => block.id === blockId) ?? -1;
    const nearest = exact ?? paperDocument?.blocks
      .slice(Math.max(sourceIndex, 0))
      .map((block) => readable.find((candidate) => candidate.id === block.id))
      .find(Boolean);
    if (!nearest) return;
    pendingScrollRef.current = scroll;
    setActiveBlockId(nearest.id);
    setContextOpen(false);
    if (focused) {
      setMode("focused");
      focusContent();
    }
  };

  useEffect(() => {
    if (!initialBlockId || request.status !== "ready" || initialBlockId === activeBlockId) return;
    activateBlock(initialBlockId, { scroll: true });
  }, [activeBlockId, initialBlockId, request.status]);

  const moveBlock = (offset) => {
    const next = readable[activeIndex + offset];
    if (!next) return;
    activateBlock(next.id);
    focusContent();
  };

  const restartFromBeginning = () => {
    const firstBlock = readable[0];
    if (!firstBlock) return;
    savedPositionRef.current = null;
    pendingScrollRef.current = true;
    setMode("full");
    setContextOpen(false);
    setActiveBlockId(firstBlock.id);
    onSelectionChange?.({ reference: null, error: null });
    window.requestAnimationFrame(() => {
      activeFullBlockRef.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
    });
  };

  const publishReading = (nextReading) => {
    setReadingRequest({ status: "ready", reading: nextReading, error: null });
    onReadingChange?.(nextReading);
  };

  const refreshReadingAfterFailure = async () => {
    try {
      publishReading(await fetchJournalPaperReading(runId, paper.id));
    } catch {
      // Keep the last readable result and surface the original action error.
    }
  };

  const retryReadingLoad = async () => {
    setReadingRequest({ status: "loading", reading: null, error: null });
    try {
      publishReading(await fetchJournalPaperReading(runId, paper.id));
    } catch (error) {
      setReadingRequest({ status: "error", reading: null, error });
    }
  };

  const compileReading = async () => {
    if (!modelAvailable || compileStatus === "running" || !reading) return;
    setCompileStatus("running");
    setCompileError(null);
    let nextReading = reading;
    try {
      for (const lens of READING_LENSES) {
        if (nextReading.stages?.[lens.id]?.status === "ready") continue;
        nextReading = await generateJournalReadingStage({
          runId,
          paperId: paper.id,
          stage: lens.id,
          providerId,
          modelId,
        });
        publishReading(nextReading);
      }
      setCompileStatus("ready");
    } catch (error) {
      await refreshReadingAfterFailure();
      setCompileError(error);
      setCompileStatus("failed");
    }
  };

  const captureSelection = (root) => {
    const result = selectionReferenceFromDom(
      window.getSelection(),
      root,
      paperDocument?.revision,
      sourceByBlockId,
    );
    if (result.reference || result.error) onSelectionChange?.(result);
  };

  const startTranslation = async () => {
    if (!modelAvailable || translationState.starting) return;
    setTranslationState((current) => ({ ...current, starting: true, error: null }));
    try {
      const nextTranslation = await startJournalPaperTranslation({
        runId,
        paperId: paper.id,
        providerId,
        modelId,
      });
      setTranslationState({
        status: "ready",
        translation: nextTranslation,
        starting: nextTranslation.status === "running",
        error: null,
      });
      setTranslationRefreshKey((current) => current + 1);
    } catch (error) {
      setTranslationState((current) => ({
        status: "error",
        translation: current.translation,
        starting: false,
        error: errorMessage(error, "无法启动全文翻译"),
      }));
    }
  };

  const handleModeKeyDown = (event) => {
    let nextMode = null;
    if (event.key === "ArrowLeft" || event.key === "Home") nextMode = "full";
    if (event.key === "ArrowRight" || event.key === "End") nextMode = "focused";
    if (!nextMode) return;
    event.preventDefault();
    setMode(nextMode);
    (nextMode === "focused" ? focusedTabRef : fullTabRef).current?.focus();
  };

  return (
    <section className="paper-reader" aria-labelledby="paper-reader-title">
      <header className={`paper-reader-header${chromeOpen ? "" : " is-slim"}`}>
        <button className="paper-reader-back" type="button" onClick={onClose}>
          <ArrowLeft size={15} weight="bold" aria-hidden="true" />返回本轮
        </button>
        <div>
          {chromeOpen ? (
            <span>
              {closeReading ? "论文工作台 · 研读中" : orientationMode ? "论文工作台 · 快速定向" : "论文工作台"}
            </span>
          ) : null}
          <h2 id="paper-reader-title">{paper.title ?? paperDocument?.title}</h2>
          {chromeOpen ? (
            <p>
              {paper.venue}
              {closeReading ? " · 阅读位置与研读结果会保存在当前项目中" : ""}
            </p>
          ) : null}
        </div>
        {!orientationMode ? (
          <button
            type="button"
            className="paper-reader-chrome-toggle"
            aria-expanded={readerChromeOpen}
            onClick={() => setReaderChromeOpen((open) => !open)}
          >
            {readerChromeOpen ? "收起" : "工具与定向"}
          </button>
        ) : null}
        {chromeOpen && paperDocument?.originalPdfUrl ? (
          <a href={paperDocument.originalPdfUrl} target="_blank" rel="noreferrer">
            <FilePdf size={16} aria-hidden="true" />查看原版<span className="sr-only">（在新窗口打开）</span>
          </a>
        ) : null}
      </header>

      {peerPapers.length > 1 ? (
        <nav className="paper-reader-peers" aria-label="本轮论文">
          {peerPapers.map((peer, index) => (
            <button
              className={peer.id === paper.id ? "is-active" : ""}
              type="button"
              aria-current={peer.id === paper.id ? "page" : undefined}
              onClick={() => onSwitchPaper?.(peer.id)}
              key={peer.id}
            >
              <span>论文 {index + 1}</span>
              <strong>{peer.shortTitle ?? peer.title}</strong>
            </button>
          ))}
        </nav>
      ) : null}

      {request.status === "loading" ? (
        <div className="paper-reader-state" role="status">正在打开论文正文……</div>
      ) : null}
      {request.status === "error" ? (
        <div className="paper-reader-state is-error" role="alert">
          <strong>正文暂时无法打开</strong>
          <p>{request.error}</p>
          <button type="button" onClick={() => setDocumentRetryKey((current) => current + 1)}>
            <ArrowClockwise size={15} weight="bold" aria-hidden="true" />
            重试打开正文
          </button>
        </div>
      ) : null}

      {request.status === "ready" ? (
        <>
          {chromeOpen ? (
          <div className="paper-reader-toolbar">
            <div className="paper-reader-modes" role="tablist" aria-label="阅读方式">
              <button
                ref={fullTabRef}
                id="paper-reader-tab-full"
                type="button"
                role="tab"
                aria-selected={mode === "full"}
                aria-controls="paper-reader-panel-full"
                tabIndex={mode === "full" ? 0 : -1}
                className={mode === "full" ? "is-active" : ""}
                onKeyDown={handleModeKeyDown}
                onClick={() => setMode("full")}
              >
                <ListBullets size={15} aria-hidden="true" />连续阅读
              </button>
              <button
                ref={focusedTabRef}
                id="paper-reader-tab-focused"
                type="button"
                role="tab"
                aria-selected={mode === "focused"}
                aria-controls="paper-reader-panel-focused"
                tabIndex={mode === "focused" ? 0 : -1}
                className={mode === "focused" ? "is-active" : ""}
                onKeyDown={handleModeKeyDown}
                onClick={() => {
                  setMode("focused");
                  focusContent();
                }}
              >
                <BookOpenText size={15} aria-hidden="true" />单段聚焦
              </button>
            </div>

            <div className="paper-reader-toolbar-actions">
              {closeReading ? (
                <button type="button" onClick={restartFromBeginning}>
                  <ArrowClockwise size={15} aria-hidden="true" />
                  从头阅读
                </button>
              ) : null}
              <details className="paper-reader-outline">
                <summary>目录</summary>
                <nav aria-label="论文目录">
                  {(paperDocument.sections ?? [])
                    .filter((section) => section.level > 1 && section.firstBlockId)
                    .map((section) => (
                      <button
                        type="button"
                        style={{ "--outline-indent": `${Math.max(section.level - 2, 0) * 12}px` }}
                        onClick={() => activateBlock(section.firstBlockId, { scroll: true })}
                        key={section.id}
                      >
                        {section.title}
                      </button>
                    ))}
                </nav>
              </details>
            </div>
          </div>
          ) : null}

          {(orientationMode || readerChromeOpen) ? (
            <GuideOrientation
              guide={guide}
              open={orientationOpen}
              decision={guideDecision}
              canDecide={orientationMode && Boolean(onGuideDecision)}
              busy={guideDecisionBusy}
              onOpenChange={setOrientationOpen}
              onDecision={onGuideDecision}
              onOpenReference={(blockId) => activateBlock(blockId, { scroll: true })}
            />
          ) : null}

          {closeReading && chromeOpen ? (
            <section className="paper-reader-summary" aria-label="研读结论整理">
              <div className="paper-reader-summary-head">
                <p>随时自由阅读、追问；需要时把研读结论整理到右侧「阅读笔记」。</p>
                <span className={`paper-reader-position-status is-${positionStatus}`} aria-live="polite">
                  {positionStatus === "saving" ? "保存位置…" : null}
                  {positionStatus === "saved" ? "位置已保存" : null}
                  {positionStatus === "failed" ? "位置暂未保存" : null}
                </span>
              </div>
              <div className="paper-reader-summary-action">
                {readingRequest.status === "loading" ? (
                  <span role="status"><CircleNotch className="is-spinning" size={15} />恢复研读结果…</span>
                ) : null}
                {readingRequest.status === "error" ? (
                  <button type="button" onClick={retryReadingLoad}>
                    <ArrowClockwise size={15} />重试读取
                  </button>
                ) : null}
                {readingRequest.status === "ready" && allStagesReady ? (
                  <span><CheckCircle size={15} weight="fill" />研读结论已整理，可进入归档预览</span>
                ) : null}
                {readingRequest.status === "ready" && !allStagesReady ? (
                  <button
                    type="button"
                    disabled={!modelAvailable || compileStatus === "running"}
                    onClick={compileReading}
                  >
                    {compileStatus === "running"
                      ? <CircleNotch className="is-spinning" size={15} />
                      : <Sparkle size={15} weight="fill" />}
                    {compileStatus === "running" ? "正在整理研读结论…" : "整理研读结论"}
                  </button>
                ) : null}
                {compileStatus === "failed" ? (
                  <span className="paper-reader-summary-error">{errorMessage(compileError)}</span>
                ) : null}
              </div>
            </section>
          ) : null}

          <div className="paper-reader-language-bar">
            <div className="paper-reader-language-modes" role="group" aria-label="正文语言">
              <button
                type="button"
                className={effectiveLanguage === "original" ? "is-active" : ""}
                aria-pressed={effectiveLanguage === "original"}
                onClick={() => setLanguage("original")}
              >
                原文
              </button>
              <button
                type="button"
                className={effectiveLanguage === "zh" ? "is-active" : ""}
                aria-pressed={effectiveLanguage === "zh"}
                disabled={!translationUsable}
                onClick={() => setLanguage("zh")}
              >
                中文
              </button>
              <button
                type="button"
                className={effectiveLanguage === "bilingual" ? "is-active" : ""}
                aria-pressed={effectiveLanguage === "bilingual"}
                disabled={!translationUsable}
                onClick={() => setLanguage("bilingual")}
              >
                对照
              </button>
            </div>
            <div className="paper-reader-language-status" aria-live="polite">
              {translation?.status === "running" ? (
                <span role="status">
                  <CircleNotch className="is-spinning" size={14} aria-hidden="true" />
                  正在翻译 {translation.translatedBlocks}/{translation.totalBlocks} 段
                </span>
              ) : null}
              {translation && ["not_started", "stale"].includes(translation.status) ? (
                <button
                  type="button"
                  disabled={!modelAvailable || translationState.starting}
                  onClick={startTranslation}
                >
                  {translationState.starting
                    ? <CircleNotch className="is-spinning" size={14} aria-hidden="true" />
                    : <Translate size={14} aria-hidden="true" />}
                  {translation.status === "stale" ? "重新翻译全文" : "翻译全文"}
                </button>
              ) : null}
              {translation?.status === "partial" ? (
                <button
                  type="button"
                  disabled={!modelAvailable || translationState.starting}
                  onClick={startTranslation}
                >
                  {translationState.starting
                    ? <CircleNotch className="is-spinning" size={14} aria-hidden="true" />
                    : <Translate size={14} aria-hidden="true" />}
                  继续翻译（已完成 {translation.translatedBlocks}/{translation.totalBlocks}）
                </button>
              ) : null}
              {translationState.error ? (
                <span className="paper-reader-language-error">{translationState.error}</span>
              ) : null}
            </div>
          </div>

          {mode === "focused" ? (
            <div
              id="paper-reader-panel-focused"
              className="paper-reader-focused"
              role="tabpanel"
              aria-labelledby="paper-reader-tab-focused"
            >
              <div className="paper-reader-location">
                <span>{locationLabel(activeBlock)}</span>
                <small>第 {Math.min(activeIndex + 1, readable.length)}/{readable.length} 段</small>
              </div>

              <article
                className={`paper-reader-current is-${activeBlock?.kind ?? "text"}`}
                data-reader-block-id={activeBlock?.id}
                onMouseUp={(event) => captureSelection(event.currentTarget)}
                onKeyUp={(event) => captureSelection(event.currentTarget)}
              >
                <h3 ref={contentTitleRef} tabIndex="-1">当前原文</h3>
                <PaperRichText content={blockCopy(activeBlock)} />
                {effectiveLanguage !== "original" && translationBlocks[activeBlock?.id] ? (
                  <div className="paper-reader-zh" data-reader-zh="true">
                    <PaperRichText content={translationBlocks[activeBlock.id]} />
                  </div>
                ) : null}
              </article>

              <button
                className="paper-reader-context-toggle"
                type="button"
                aria-expanded={contextOpen}
                onClick={() => setContextOpen((current) => !current)}
              >
                {contextOpen ? "收起前后文" : "展开前后文"}
              </button>
              {contextOpen ? (
                <div className="paper-reader-context">
                  {previousBlock ? <article><span>上一段</span><PaperRichText content={blockCopy(previousBlock)} /></article> : null}
                  {nextBlock ? <article><span>下一段</span><PaperRichText content={blockCopy(nextBlock)} /></article> : null}
                </div>
              ) : null}

              <p className="paper-reader-anchor-note">
                选择同一段中的文字，可把可核验的原文引用加入右侧论文 Agent。
              </p>

              <footer className="paper-reader-navigation">
                <button type="button" disabled={!previousBlock} onClick={() => moveBlock(-1)}>
                  <ArrowLeft size={15} weight="bold" aria-hidden="true" />上一段
                </button>
                <button type="button" disabled={!nextBlock} onClick={() => moveBlock(1)}>
                  下一段<ArrowRight size={15} weight="bold" aria-hidden="true" />
                </button>
              </footer>
            </div>
          ) : (
            <div
              ref={fullDocumentRef}
              id="paper-reader-panel-full"
              className="paper-reader-full"
              role="tabpanel"
              aria-labelledby="paper-reader-tab-full"
              onMouseUp={() => captureSelection(fullDocumentRef.current)}
              onKeyUp={() => captureSelection(fullDocumentRef.current)}
            >
              <header className="paper-reader-document-heading">
                <span>结构化全文</span>
                <h3 ref={contentTitleRef} tabIndex="-1">{paperDocument.title ?? paper.title}</h3>
                <p>点击段落可记录当前位置；选择同一段文字，可连同原文位置一起交给右侧论文 Agent。</p>
              </header>
              {(paperDocument.blocks ?? []).map((block) => (
                <FullBlock
                  block={block}
                  section={sectionsById.get(block.sectionId)}
                  active={block.id === activeBlockId}
                  activeRef={activeFullBlockRef}
                  onActivate={(blockId) => activateBlock(blockId)}
                  zh={translationBlocks[block.id] ?? null}
                  language={effectiveLanguage}
                  key={block.id}
                />
              ))}
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}
