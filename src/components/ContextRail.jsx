import {
  CaretDown,
  CaretRight,
  CheckCircle,
  FileText,
  ShieldCheck,
} from "@phosphor-icons/react";

export function ContextRail({
  project,
  tab,
  onTabChange,
  openedSourceId,
  onSourceOpen,
  mobileActive,
}) {
  const tabs = [
    ["sources", `依据 ${project.sources.length}`],
    ["decisions", `记录 ${project.decisions.length}`],
  ];

  return (
    <aside className={`context-rail${mobileActive ? " is-mobile-active" : ""}`} aria-label="项目上下文">
      <header className="context-header">
        <div>
          <span className="eyebrow">当前工作区</span>
          <h2>项目上下文</h2>
        </div>
        <span className="evidence-count">{project.sourceCount} 个资料源</span>
      </header>

      <nav className="context-tabs" aria-label="上下文分类">
        {tabs.map(([id, label]) => (
          <button
            className={tab === id ? "is-active" : ""}
            type="button"
            key={id}
            aria-current={tab === id ? "page" : undefined}
            onClick={() => onTabChange(id)}
          >
            {label}
          </button>
        ))}
      </nav>

      <div className="context-content">
        {tab === "sources" ? (
          <div className="source-list">
            {project.sources.map((source) => {
              const open = source.id === openedSourceId;
              return (
                <button
                  className={`source-row${open ? " is-open" : ""}`}
                  type="button"
                  key={source.id}
                  aria-expanded={open}
                  onClick={() => onSourceOpen(open ? null : source.id)}
                >
                  <span className="source-icon"><FileText size={16} weight="regular" aria-hidden="true" /></span>
                  <span className="source-copy">
                    <strong>{source.name}</strong>
                    <span>{source.excerpt}</span>
                    {open ? <em>{source.detail}</em> : null}
                    <small>{source.status}</small>
                  </span>
                  {open ? <CaretDown size={14} aria-hidden="true" /> : <CaretRight size={14} aria-hidden="true" />}
                </button>
              );
            })}
            <div className="source-scope-note">
              <ShieldCheck size={17} weight="regular" aria-hidden="true" />
              <p><strong>来源范围固定</strong><span>生成只使用本轮已选资料，不会自动扩展到其他项目。</span></p>
            </div>
          </div>
        ) : null}

        {tab === "decisions" ? (
          <div className="decision-list">
            {project.decisions.map((decision, index) => (
              <article key={decision}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <p>{decision}</p>
                <CheckCircle size={17} weight="fill" aria-hidden="true" />
              </article>
            ))}
            <p className="context-helper">这里仅保留已经形成的工作记录，并随当前工作区一起切换。</p>
          </div>
        ) : null}
      </div>
    </aside>
  );
}
