import { useEffect, useMemo, useState } from "react";
import { SidebarSimple } from "@phosphor-icons/react";
import { PaperDiscoveryCard } from "./PaperDiscoveryCard.jsx";
import { PeriodNavigator } from "./PeriodNavigator.jsx";

function pastRunLabel(run) {
  const createdAt = String(run.createdAt ?? "");
  const parsed = new Date(createdAt);
  if (createdAt && Number.isFinite(parsed.getTime())) {
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(parsed).replaceAll("/", "-");
  }
  return run.windowKey ? `${run.windowKey} 记录` : "早先期次";
}

function pastDecisionLabel(decision) {
  if (decision === "read") return "已精读";
  if (decision === "collect") return "已收藏";
  return "未处理";
}

function needsChineseSupport(paper) {
  const hasEnglishOnly = (value) => (
    typeof value === "string"
    && value.trim()
    && !/\p{Script=Han}/u.test(value)
  );
  return Boolean(
    (paper.title && !paper.titleZh)
    || (paper.abstract && !paper.abstractZh)
    || hasEnglishOnly(paper.selectionSummary)
    || hasEnglishOnly(paper.projectImpact ?? paper.relevance)
    || !paper.projectImpact
    || paper.projectImpact === "对项目的具体作用待核验。"
  );
}

const TRANSLATE_LIBRARY_LABEL = "补全中文标题、摘要与作用";

function RecentClassicsView({
  recentClassics,
  canAddToWeekly,
  onAddRecentClassics,
  onDismissRecentClassic,
  onTranslate,
}) {
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);
  const [translating, setTranslating] = useState(false);
  const papers = recentClassics?.papers ?? [];
  const needsTranslation = papers.some(needsChineseSupport);

  const runAction = async (paperId, action) => {
    setBusyId(paperId);
    setError(null);
    try {
      await action();
    } catch (actionError) {
      setError(actionError?.message ?? "操作未完成，可稍后重试");
    } finally {
      setBusyId(null);
    }
  };

  const translate = async () => {
    if (translating) return;
    setTranslating(true);
    setError(null);
    try {
      await onTranslate();
    } catch (actionError) {
      setError(actionError?.message ?? "翻译未完成，可稍后重试");
    } finally {
      setTranslating(false);
    }
  };

  if (!recentClassics) {
    return (
      <p className="journal-library-empty">
        近年经典由本月扫描时整理。完成一次本月扫描后，这里会列出与项目主题相关的高引论文。
      </p>
    );
  }
  return (
    <div className="journal-library-body">
      <div className="journal-library-toolbar">
        <p className="workflow-recent-classics-note">
          {recentClassics.fromYear ? `${recentClassics.fromYear} 年以来、` : ""}
          与项目主题相关的注册刊物高引论文，已读、已收藏和标过不感兴趣的不会出现。
        </p>
        {needsTranslation && onTranslate ? (
          <button
            type="button"
            className="workflow-evidence-toggle"
            disabled={translating}
            onClick={translate}
          >
            {translating ? "正在翻译…" : TRANSLATE_LIBRARY_LABEL}
          </button>
        ) : null}
      </div>
      {recentClassics.status !== "success" ? (
        <p className="workflow-recent-classics-note">
          近年经典暂时无法获取（{recentClassics.error?.message ?? "数据源不可用"}），下次扫描会重试。
        </p>
      ) : null}
      {error ? <p className="workflow-recent-classics-error">{error}</p> : null}
      {recentClassics.status === "success" && papers.length === 0 ? (
        <p className="journal-library-empty">
          这一批高引论文都已经处理过或被标记为不感兴趣了，下次扫描会补充新的。
        </p>
      ) : null}
      <div className="workflow-recent-classics-list">
        {papers.map((paper) => (
          <PaperDiscoveryCard
            key={paper.id}
            paper={paper}
            href={paper.officialUrl ?? paper.pdfUrl}
            className="journal-library-paper"
            statuses={paper.discoveryType ? <span className="is-classic">{paper.discoveryType}</span> : null}
            actions={(
              <>
                <button
                  type="button"
                  className="workflow-secondary-action"
                  disabled={busyId === paper.id || !canAddToWeekly}
                  title={canAddToWeekly ? undefined : "本月候选就绪后可加入"}
                  onClick={() => runAction(paper.id, () => onAddRecentClassics([paper.id]))}
                >
                  加入本月推荐
                </button>
                <button
                  type="button"
                  className="workflow-secondary-action"
                  disabled={busyId === paper.id || !paper.dedupeKey}
                  onClick={() => runAction(paper.id, () => onDismissRecentClassic(paper))}
                >
                  不感兴趣
                </button>
              </>
            )}
          />
        ))}
      </div>
    </div>
  );
}

function PastRunsView({
  pastRuns,
  canAddToWeekly,
  onAddPastPaper,
  onTranslate,
  weeklyCandidateIds,
}) {
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);
  const [translatingRunId, setTranslatingRunId] = useState(null);
  const orderedRuns = useMemo(() => (
    Array.isArray(pastRuns)
      ? [...pastRuns].sort((left, right) => (
          String(left.createdAt ?? left.updatedAt ?? "").localeCompare(
            String(right.createdAt ?? right.updatedAt ?? ""),
          )
        ))
      : []
  ), [pastRuns]);
  const [activeRunId, setActiveRunId] = useState(() => orderedRuns.at(-1)?.id ?? null);
  useEffect(() => {
    setActiveRunId((current) => (
      orderedRuns.some((run) => run.id === current)
        ? current
        : orderedRuns.at(-1)?.id ?? null
    ));
  }, [orderedRuns]);

  const activeRun = orderedRuns.find((run) => run.id === activeRunId)
    ?? orderedRuns.at(-1)
    ?? null;
  const weeklyIds = new Set(weeklyCandidateIds);
  const addPaper = async (sourceRunId, paperId) => {
    setBusyId(paperId);
    setError(null);
    try {
      await onAddPastPaper(sourceRunId, paperId);
    } catch (actionError) {
      setError(actionError?.message ?? "操作未完成，可稍后重试");
    } finally {
      setBusyId(null);
    }
  };
  const translateRun = async (runId) => {
    if (translatingRunId) return;
    setTranslatingRunId(runId);
    setError(null);
    try {
      await onTranslate(runId);
    } catch (actionError) {
      setError(actionError?.message ?? "翻译未完成，可稍后重试");
    } finally {
      setTranslatingRunId(null);
    }
  };
  if (!activeRun) {
    return <p className="journal-library-empty">还没有可回看的往期推荐。</p>;
  }
  const decisions = activeRun.paperDecisions ?? {};
  const candidates = activeRun.candidates ?? [];
  const handledCount = candidates.filter(
    (paper) => ["read", "collect"].includes(decisions[paper.id]),
  ).length;
  const needsTranslation = candidates.some(needsChineseSupport);
  return (
    <div className="workflow-past-weeks-list">
      {error ? <p className="workflow-recent-classics-error">{error}</p> : null}
      <PeriodNavigator
        periods={orderedRuns}
        activeId={activeRun.id}
        activeLabel={pastRunLabel(activeRun)}
        onSelect={setActiveRunId}
      />
      <article className="workflow-past-week" key={activeRun.id}>
        <header>
          <strong>{pastRunLabel(activeRun)}</strong>
          <small>{candidates.length} 篇推荐 · 处理 {handledCount} 篇</small>
          {needsTranslation && onTranslate ? (
            <button
              type="button"
              className="workflow-evidence-toggle journal-library-past-translate"
              disabled={translatingRunId === activeRun.id}
              onClick={() => translateRun(activeRun.id)}
            >
              {translatingRunId === activeRun.id ? "翻译中…" : TRANSLATE_LIBRARY_LABEL}
            </button>
          ) : null}
        </header>
        <div className="journal-library-period-papers">
          {candidates.map((paper) => {
            const decision = decisions[paper.id];
            const handled = ["read", "collect"].includes(decision);
            const alreadyAdded = weeklyIds.has(paper.id);
            return (
              <PaperDiscoveryCard
                key={`${activeRun.id}-${paper.id}`}
                paper={paper}
                href={paper.officialUrl ?? paper.pdfUrl}
                className="journal-library-paper"
                statuses={(
                  <>
                    <em className={decision ? `is-${decision}` : "is-unread"}>
                      {pastDecisionLabel(decision)}
                    </em>
                    {alreadyAdded ? <em className="is-read">已加入本月</em> : null}
                  </>
                )}
                actions={!handled && !alreadyAdded && onAddPastPaper ? (
                  <button
                    type="button"
                    className="workflow-secondary-action"
                    disabled={busyId === paper.id || !canAddToWeekly}
                    title={canAddToWeekly ? undefined : "本月候选就绪后可加入"}
                    onClick={() => addPaper(activeRun.id, paper.id)}
                  >
                    加入本月推荐
                  </button>
                ) : null}
              />
            );
          })}
        </div>
      </article>
    </div>
  );
}

export function JournalLibraryWorkspace({
  view,
  recentClassics,
  canAddToWeekly = false,
  onAddRecentClassics,
  onDismissRecentClassic,
  onAddPastPaper,
  onTranslateLibrary,
  recentClassicsRunId = null,
  pastRuns = [],
  weeklyCandidateIds = [],
  sidebarOpen,
  onToggleSidebar,
  mobileActive = false,
}) {
  const isClassics = view === "recent_classics";
  return (
    <main className={`workflow-workspace journal-library-workspace${mobileActive ? " is-mobile-active" : ""}`}>
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
              <span className="workflow-kicker">
                {isClassics ? "注册刊物 · 高引题录" : "历次推荐与处理记录"}
              </span>
              <h1>{isClassics ? "近年经典" : "往期回看"}</h1>
            </div>
          </div>
        </div>
      </header>
      <section className="journal-library-scroll" aria-label={isClassics ? "近年经典" : "往期回看"}>
        {isClassics ? (
          <RecentClassicsView
            recentClassics={recentClassics}
            canAddToWeekly={canAddToWeekly}
            onAddRecentClassics={onAddRecentClassics}
            onDismissRecentClassic={onDismissRecentClassic}
            onTranslate={recentClassicsRunId && onTranslateLibrary
              ? () => onTranslateLibrary(recentClassicsRunId)
              : undefined}
          />
        ) : (
          <PastRunsView
            pastRuns={pastRuns}
            canAddToWeekly={canAddToWeekly}
            onAddPastPaper={onAddPastPaper}
            onTranslate={onTranslateLibrary}
            weeklyCandidateIds={weeklyCandidateIds}
          />
        )}
      </section>
    </main>
  );
}
