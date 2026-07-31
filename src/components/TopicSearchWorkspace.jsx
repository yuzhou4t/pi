import { useEffect, useRef, useState } from "react";
import {
  CircleNotch,
  Globe,
  MagnifyingGlass,
  PaperPlaneRight,
  Plus,
  SidebarSimple,
} from "@phosphor-icons/react";
import { ProviderMenu } from "./ProviderMenu.jsx";

function venueCoverage(turn) {
  const failed = turn.venues.filter((venue) => venue.status === "failed");
  const base = `覆盖 ${turn.venueSuccessCount}/${turn.venues.length} 个注册刊物 · 命中 ${turn.totalFound} 篇`;
  if (failed.length === 0) return base;
  return `${base} · ${failed.map((venue) => venue.shortName).join("、")}暂不可用`;
}

function topicPhaseLabel(progress) {
  switch (progress?.phase) {
    case "planning":
      return "正在规划检索关键词…";
    case "searching":
      return "正在检索注册刊物与联网…";
    case "recommending":
      return "正在阅读命中结果并整理推荐…";
    case "translating":
      return "正在翻译英文标题与摘要…";
    default:
      return "正在检索注册刊物与联网并整理推荐…";
  }
}

function paperMeta(paper) {
  return [
    paper.venue,
    paper.publishedAt ? paper.publishedAt.slice(0, 10) : null,
    Number.isInteger(paper.citedByCount) ? `引用 ${paper.citedByCount}` : null,
  ].filter(Boolean).join(" · ");
}

function TurnCard({
  turn,
  selection,
  onToggleSelect,
  onAddToWeekly,
  adding,
  addError,
}) {
  const recommendationsById = new Map(
    turn.recommendations.map((item) => [item.paperId, item]),
  );
  const recommended = turn.recommendations
    .map((item) => turn.papers.find((paper) => paper.id === item.paperId))
    .filter(Boolean);
  const others = turn.papers.filter(
    (paper) => !recommendationsById.has(paper.id),
  );
  const orderedPapers = [...recommended, ...others];
  const selectedIds = orderedPapers
    .filter((paper) => selection.has(paper.id) && !turn.addedPaperIds.includes(paper.id))
    .map((paper) => paper.id);

  return (
    <article className="topic-search-turn">
      <div className="topic-search-question">
        <p>{turn.question}</p>
      </div>
      <div className="topic-search-answer">
        <p>{turn.answer}</p>
        <small>{venueCoverage(turn)}</small>
        {turn.searchQueries?.length > 0 ? (
          <div className="topic-search-queries" aria-label="本次检索使用的检索式">
            {turn.searchQueries.map((item) => (
              <span className="topic-search-query-chip" key={item}>{item}</span>
            ))}
          </div>
        ) : null}
      </div>
      {orderedPapers.length > 0 ? (
        <ul className="topic-search-papers">
          {orderedPapers.map((paper) => {
            const recommendation = recommendationsById.get(paper.id);
            const added = turn.addedPaperIds.includes(paper.id);
            return (
              <li
                key={paper.id}
                className={`topic-search-paper${recommendation ? " is-recommended" : ""}`}
              >
                <label>
                  <input
                    type="checkbox"
                    checked={added || selection.has(paper.id)}
                    disabled={added}
                    onChange={() => onToggleSelect(turn.turnId, paper.id)}
                  />
                  <span className="topic-search-paper-body">
                    <strong>{recommendation?.titleZh || paper.titleZh || paper.title}</strong>
                    {(recommendation?.titleZh || paper.titleZh) ? (
                      <small className="topic-search-paper-original">{paper.title}</small>
                    ) : null}
                    <small>{paperMeta(paper)}</small>
                    {recommendation ? (
                      <p className="topic-search-reason">{recommendation.reason}</p>
                    ) : paper.abstract ? (
                      <p className="topic-search-reason">{paper.abstract.slice(0, 160)}</p>
                    ) : null}
                    {recommendation?.projectImpact ? (
                      <p className="topic-search-impact">{recommendation.projectImpact}</p>
                    ) : null}
                    {added ? <em className="topic-search-added">已加入本月推荐</em> : null}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      ) : null}
      {orderedPapers.some((paper) => !turn.addedPaperIds.includes(paper.id)) ? (
        <div className="topic-search-actions">
          <button
            type="button"
            disabled={selectedIds.length === 0 || adding}
            onClick={() => onAddToWeekly(turn.turnId, selectedIds)}
          >
            {adding
              ? <CircleNotch className="spin" size={14} weight="bold" aria-hidden="true" />
              : null}
            {adding ? "正在加入…" : `把选中的 ${selectedIds.length} 篇加入本月推荐`}
          </button>
          {addError ? <p className="topic-search-error" role="alert">{addError}</p> : null}
        </div>
      ) : null}
      {turn.web?.results?.length > 0 ? (
        <div className="topic-search-web">
          <p className="topic-search-web-title">
            <Globe size={14} weight="regular" aria-hidden="true" />
            联网发现 · 参考（不进入本月推荐）
          </p>
          <ul className="topic-search-web-list">
            {turn.web.results.map((item) => (
              <li key={item.url}>
                <a href={item.url} target="_blank" rel="noreferrer noopener">
                  {item.titleZh || item.title}
                </a>
                {item.titleZh && item.titleZh !== item.title ? (
                  <small className="topic-search-web-original">{item.title}</small>
                ) : null}
                {(item.excerptZh || item.excerpt) ? (
                  <p>{(item.excerptZh || item.excerpt).slice(0, 200)}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : turn.web?.status === "failed" ? (
        <p className="topic-search-web-note">联网发现暂不可用，本次仅展示注册刊物结果。</p>
      ) : null}
    </article>
  );
}

export function TopicSearchWorkspace({
  conversationState,
  onSubmitQuestion,
  onAddToWeekly,
  onNewConversation,
  submitting,
  progress,
  submitError,
  addingTurnId,
  addErrors,
  sidebarOpen,
  onToggleSidebar,
  providers,
  providerId,
  model,
  providerOpen,
  onProviderOpenChange,
  onProviderChange,
  onModelChange,
  thinkingLevels = null,
  thinkingLevel = null,
  supportsThinking = false,
  onThinkingLevelChange,
  mobileActive = false,
}) {
  const [question, setQuestion] = useState("");
  const [selections, setSelections] = useState(new Map());
  const scrollRef = useRef(null);
  const turns = conversationState.conversation?.turns ?? [];

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns.length, submitting]);

  const toggleSelect = (turnId, paperId) => {
    setSelections((current) => {
      const next = new Map(current);
      const set = new Set(next.get(turnId) ?? []);
      if (set.has(paperId)) set.delete(paperId);
      else set.add(paperId);
      next.set(turnId, set);
      return next;
    });
  };

  const submit = () => {
    const trimmed = question.trim();
    if (!trimmed || submitting) return;
    onSubmitQuestion(trimmed);
    setQuestion("");
  };

  return (
    <main className={`workflow-workspace topic-search-workspace${mobileActive ? " is-mobile-active" : ""}`}>
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
              <span className="workflow-kicker">注册刊物 + 联网检索</span>
              <h1>{conversationState.conversation?.title || "主题检索"}</h1>
            </div>
          </div>
          <div className="workflow-run-meta" aria-label="模型选择">
            {onNewConversation ? (
              <button
                type="button"
                className="topic-search-new"
                onClick={onNewConversation}
                title="新建检索会话"
              >
                <Plus size={14} weight="bold" aria-hidden="true" />
                新建检索
              </button>
            ) : null}
            {providers ? (
              <ProviderMenu
                open={providerOpen}
                onOpenChange={onProviderOpenChange}
                providers={providers}
                providerId={providerId}
                model={model}
                onProviderChange={onProviderChange}
                onModelChange={onModelChange}
                thinkingLevels={thinkingLevels}
                thinkingLevel={thinkingLevel}
                supportsThinking={supportsThinking}
                onThinkingLevelChange={onThinkingLevelChange}
              />
            ) : null}
          </div>
        </div>
      </header>

      <div className="topic-search-scroll" ref={scrollRef}>
        {conversationState.status === "loading" ? (
          <p className="topic-search-hint" role="status">
            <CircleNotch className="spin" size={15} weight="bold" aria-hidden="true" />
            正在打开检索记录…
          </p>
        ) : null}
        {conversationState.status === "error" ? (
          <p className="topic-search-error" role="alert">{conversationState.error}</p>
        ) : null}
        {conversationState.status === "ready" && turns.length === 0 && !submitting ? (
          <div className="topic-search-empty">
            <MagnifyingGlass size={22} weight="regular" aria-hidden="true" />
            <p>用自然语言描述想找的内容，会在注册期刊与会议内检索，并联网补充更广的参考发现。</p>
            <small>例如：「有什么关于 LLM Agent 长期记忆的最新论文？」</small>
          </div>
        ) : null}
        {turns.map((turn) => (
          <TurnCard
            key={turn.turnId}
            turn={turn}
            selection={selections.get(turn.turnId) ?? new Set()}
            onToggleSelect={toggleSelect}
            onAddToWeekly={onAddToWeekly}
            adding={addingTurnId === turn.turnId}
            addError={addErrors[turn.turnId] ?? null}
          />
        ))}
        {submitting ? (
          <div className="topic-search-thinking" role="status">
            <p className="topic-search-hint">
              <CircleNotch className="spin" size={15} weight="bold" aria-hidden="true" />
              {topicPhaseLabel(progress)}
            </p>
            {progress?.query ? (
              <p className="topic-search-thinking-query">检索词：{progress.query}</p>
            ) : null}
            {progress?.thinking ? (
              <p className="topic-search-thinking-summary">{progress.thinking}</p>
            ) : null}
          </div>
        ) : null}
        {submitError ? (
          <p className="topic-search-error" role="alert">{submitError}</p>
        ) : null}
      </div>

      <form
        className="topic-search-composer"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <textarea
          value={question}
          rows={2}
          placeholder="想找什么方向的论文？"
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <button
          type="submit"
          disabled={!question.trim() || submitting}
          aria-label="发送检索问题"
        >
          {submitting
            ? <CircleNotch className="spin" size={16} weight="bold" aria-hidden="true" />
            : <PaperPlaneRight size={16} weight="fill" aria-hidden="true" />}
        </button>
      </form>
    </main>
  );
}
