function cleanText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstText(...values) {
  return values.map(cleanText).find(Boolean) ?? null;
}

function authorLabel(authors) {
  if (Array.isArray(authors)) return authors.map(cleanText).filter(Boolean).join("、");
  return cleanText(authors);
}

function publicationLabel(paper) {
  const value = firstText(paper.publishedAt, paper.published_at);
  if (!value) return null;
  const precision = firstText(
    paper.publicationDatePrecision,
    paper.publication_date_precision,
  ) ?? (/^\d{4}$/.test(value) ? "year" : /^\d{4}-\d{2}$/.test(value) ? "month" : "day");
  if (precision === "year") return `发表于 ${value.slice(0, 4)}（年份）`;
  if (precision === "month") return `发表于 ${value.slice(0, 7)}`;
  return `发表于 ${value.slice(0, 10)}`;
}

function isPendingInsight(value) {
  return value === "待核验" || value === "对项目的具体作用待核验。";
}

export function toPaperPresentation(paper = {}, overrides = {}) {
  const originalTitle = firstText(overrides.originalTitle, paper.title, "未命名论文");
  const translatedTitle = firstText(
    overrides.titleZh,
    paper.titleZh,
    paper.title_zh,
  );
  const displayTitle = translatedTitle || originalTitle;
  const metadata = Array.isArray(overrides.metadata)
    ? overrides.metadata.map(cleanText).filter(Boolean)
    : [
        authorLabel(paper.authors),
        cleanText(paper.venue),
        publicationLabel(paper),
        Number.isInteger(paper.citedByCount ?? paper.cited_by_count)
          ? `引用 ${paper.citedByCount ?? paper.cited_by_count}`
          : null,
      ].filter(Boolean);

  return {
    id: paper.id ?? paper.paperId ?? paper.paper_id ?? null,
    displayTitle,
    originalTitle: translatedTitle && translatedTitle !== originalTitle
      ? originalTitle
      : null,
    metadata,
    summary: firstText(
      overrides.summary,
      paper.selectionSummary,
      paper.selection_summary,
      paper.abstractZh,
      paper.abstract_zh,
      paper.abstract,
    ) ?? "待核验",
    projectImpact: firstText(
      overrides.projectImpact,
      paper.projectImpact,
      paper.project_impact,
      paper.relevance,
      paper.relevanceReason,
      paper.relevance_reason,
    ) ?? "待核验",
  };
}

export function PaperDiscoveryCard({
  paper,
  presentation,
  presentationOverrides,
  href = null,
  leading = null,
  badge = null,
  statuses = null,
  actions = null,
  footer = null,
  className = "",
  selected = false,
}) {
  const view = presentation ?? toPaperPresentation(paper, presentationOverrides);
  const classes = [
    "paper-discovery-card",
    leading ? "has-leading" : "",
    actions ? "has-actions" : "",
    selected ? "is-selected" : "",
    className,
  ].filter(Boolean).join(" ");
  const title = href ? (
    <a href={href} target="_blank" rel="noreferrer noopener">{view.displayTitle}</a>
  ) : view.displayTitle;

  return (
    <article className={classes}>
      {leading ? <div className="paper-discovery-leading">{leading}</div> : null}
      <div className="paper-discovery-body">
        <header className="paper-discovery-heading">
          <div>
            <h3>{title}</h3>
            {view.originalTitle ? (
              <p className="paper-discovery-original-title" lang="en">{view.originalTitle}</p>
            ) : null}
          </div>
          {badge ? <div className="paper-discovery-badge">{badge}</div> : null}
        </header>
        {view.metadata.length > 0 ? (
          <p className="paper-discovery-meta">{view.metadata.join(" · ")}</p>
        ) : null}
        {statuses ? <div className="paper-discovery-statuses">{statuses}</div> : null}
        <dl className="paper-discovery-insights">
          <div>
            <dt>论文讲什么</dt>
            <dd className={isPendingInsight(view.summary) ? "is-pending" : ""}>{view.summary}</dd>
          </div>
          <div className="is-project-impact">
            <dt>对项目的作用</dt>
            <dd className={isPendingInsight(view.projectImpact) ? "is-pending" : ""}>
              {view.projectImpact}
            </dd>
          </div>
        </dl>
        {footer ? <div className="paper-discovery-footer">{footer}</div> : null}
      </div>
      {actions ? <div className="paper-discovery-actions">{actions}</div> : null}
    </article>
  );
}
