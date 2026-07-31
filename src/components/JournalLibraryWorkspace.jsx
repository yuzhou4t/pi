import { useState } from "react";
import { SidebarSimple } from "@phosphor-icons/react";

function pastRunLabel(run) {
  const date = String(run.createdAt ?? "").slice(0, 10);
  return date ? `${date} 那期` : "早先期次";
}

function pastDecisionLabel(decision) {
  if (decision === "read") return "已精读";
  if (decision === "collect") return "已收藏";
  return "未处理";
}

// 标题可点击打开论文官方页面（或 PDF）；没有链接时退回纯文本。
function PaperTitleLink({ url, className, children }) {
  if (!url) return <span className={className}>{children}</span>;
  return (
    <a className={className} href={url} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}

function RecentClassicsView({
  recentClassics,
  canAddToWeekly,
  onAddRecentClassics,
  onDismissRecentClassic,
}) {
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);
  const papers = recentClassics?.papers ?? [];

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

  if (!recentClassics) {
    return (
      <p className="journal-library-empty">
        近年经典由本月扫描时整理。完成一次本月扫描后，这里会列出与项目主题相关的高引论文。
      </p>
    );
  }
  return (
    <div className="journal-library-body">
      <p className="workflow-recent-classics-note">
        {recentClassics.fromYear ? `${recentClassics.fromYear} 年以来、` : ""}
        与项目主题相关的注册刊物高引论文，已读、已收藏和标过不感兴趣的不会出现。
      </p>
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
      <ul className="workflow-recent-classics-list">
        {papers.map((paper) => (
          <li key={paper.id}>
            <div className="workflow-recent-classic-main">
              <PaperTitleLink url={paper.officialUrl ?? paper.pdfUrl} className="journal-library-title">
                <strong>{paper.titleZh || paper.title}</strong>
              </PaperTitleLink>
              {paper.titleZh && paper.titleZh !== paper.title ? <small>{paper.title}</small> : null}
              <small>
                {paper.venue}
                {paper.publishedAt ? ` · 发表于 ${String(paper.publishedAt).slice(0, 10)}` : ""}
                {Number.isInteger(paper.citedByCount) ? ` · 引用 ${paper.citedByCount}` : ""}
              </small>
              {paper.abstract ? <p>{paper.abstract.slice(0, 200)}</p> : null}
            </div>
            <div className="workflow-recent-classic-actions">
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
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PastRunsView({ pastRuns }) {
  if (!Array.isArray(pastRuns) || pastRuns.length === 0) {
    return <p className="journal-library-empty">还没有可回看的往期推荐。</p>;
  }
  return (
    <div className="workflow-past-weeks-list">
      {pastRuns.map((pastRun) => {
        const decisions = pastRun.paperDecisions ?? {};
        const candidates = pastRun.candidates ?? [];
        const handledCount = candidates.filter(
          (paper) => ["read", "collect"].includes(decisions[paper.id]),
        ).length;
        return (
          <article className="workflow-past-week" key={pastRun.id}>
            <header>
              <strong>{pastRunLabel(pastRun)}</strong>
              <small>{candidates.length} 篇推荐 · 处理 {handledCount} 篇</small>
            </header>
            <ul>
              {candidates.map((paper) => {
                const decision = decisions[paper.id];
                const date = String(paper.publishedAt ?? "").slice(0, 10);
                return (
                  <li key={`${pastRun.id}-${paper.id}`}>
                    <PaperTitleLink
                      url={paper.officialUrl ?? paper.pdfUrl}
                      className="workflow-past-paper-title journal-library-title"
                    >
                      {paper.titleZh && paper.titleZh !== paper.title ? paper.titleZh : paper.title}
                    </PaperTitleLink>
                    {paper.titleZh && paper.titleZh !== paper.title ? (
                      <small className="journal-library-original">{paper.title}</small>
                    ) : null}
                    <small>
                      {[paper.venue, date ? `发表于 ${date}` : null].filter(Boolean).join(" · ")}
                    </small>
                    <em className={decision ? `is-${decision}` : "is-unread"}>
                      {pastDecisionLabel(decision)}
                    </em>
                  </li>
                );
              })}
            </ul>
          </article>
        );
      })}
    </div>
  );
}

export function JournalLibraryWorkspace({
  view,
  recentClassics,
  canAddToWeekly = false,
  onAddRecentClassics,
  onDismissRecentClassic,
  pastRuns = [],
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
          />
        ) : (
          <PastRunsView pastRuns={pastRuns} />
        )}
      </section>
    </main>
  );
}
