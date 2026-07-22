import { useMemo, useState } from "react";
import {
  Check,
  CheckCircle,
  DownloadSimple,
  MagnifyingGlass,
  Package,
  ShieldCheck,
  SpinnerGap,
  X,
} from "@phosphor-icons/react";

export function SkillCenter({ catalog, skillState, installingId, onInstall, onToggle, onClose }) {
  const [query, setQuery] = useState("");
  const [view, setView] = useState("all");

  const visibleSkills = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return catalog.filter((skill) => {
      const state = skillState[skill.id];
      const matchesSearch = `${skill.name} ${skill.description} ${skill.category}`.toLowerCase().includes(normalized);
      const matchesView = view === "all" || (view === "installed" ? state?.installed : !state?.installed);
      return matchesSearch && matchesView;
    });
  }, [catalog, query, skillState, view]);

  const installedCount = catalog.filter((skill) => skillState[skill.id]?.installed).length;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="skill-dialog" role="dialog" aria-modal="true" aria-labelledby="skill-center-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="skill-dialog-header">
          <div className="skill-dialog-title">
            <span className="skill-dialog-icon"><Package size={20} weight="regular" aria-hidden="true" /></span>
            <div>
              <span className="eyebrow">按需扩展，不堆功能</span>
              <h2 id="skill-center-title">技能中心</h2>
              <p>下载能力包，再决定是否为当前 Agent 启用。</p>
            </div>
          </div>
          <button className="icon-button" type="button" aria-label="关闭 Skill 中心" onClick={onClose}>
            <X size={19} aria-hidden="true" />
          </button>
        </header>

        {catalog.length > 0 ? (
          <div className="skill-toolbar">
            <label className="search-field skill-search" htmlFor="skill-search">
              <MagnifyingGlass size={15} aria-hidden="true" />
            <input id="skill-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索技能" />
            </label>
            <div className="segmented-control" aria-label="筛选 Skill">
              <button className={view === "all" ? "is-active" : ""} type="button" onClick={() => setView("all")}>全部 {catalog.length}</button>
              <button className={view === "installed" ? "is-active" : ""} type="button" onClick={() => setView("installed")}>已安装 {installedCount}</button>
              <button className={view === "available" ? "is-active" : ""} type="button" onClick={() => setView("available")}>可下载 {catalog.length - installedCount}</button>
            </div>
          </div>
        ) : null}

        <div className="skill-list">
          {visibleSkills.map((skill) => {
            const state = skillState[skill.id];
            const installing = installingId === skill.id;
            return (
              <article className={`skill-row${state?.enabled ? " is-enabled" : ""}`} key={skill.id}>
                <span className="skill-row-icon"><Package size={19} weight="regular" aria-hidden="true" /></span>
                <div className="skill-row-copy">
                  <div className="skill-row-title">
                    <h3>{skill.name}</h3>
                    <span>{skill.category}</span>
                    <small>{skill.source}</small>
                  </div>
                  <p>{skill.description}</p>
                  <div className="skill-state-line">
                    {state?.installed ? <CheckCircle size={14} weight="fill" aria-hidden="true" /> : <DownloadSimple size={14} aria-hidden="true" />}
                    <span>{state?.installed ? (state.enabled ? "已安装并启用" : "已安装，当前停用") : "尚未下载到本机"}</span>
                  </div>
                </div>
                <div className="skill-row-action">
                  {state?.installed ? (
                    <button
                      className={`switch-control${state.enabled ? " is-on" : ""}`}
                      type="button"
                      role="switch"
                      aria-checked={state.enabled}
                      aria-label={`${state.enabled ? "停用" : "启用"}${skill.name}`}
                      onClick={() => onToggle(skill.id)}
                    >
                      <span>{state.enabled ? <Check size={12} weight="bold" aria-hidden="true" /> : null}</span>
                    </button>
                  ) : (
                    <button className="download-button" type="button" onClick={() => onInstall(skill.id)} disabled={installing}>
                      {installing ? <SpinnerGap className="spin" size={15} aria-hidden="true" /> : <DownloadSimple size={15} weight="bold" aria-hidden="true" />}
                      {installing ? "下载中" : "下载"}
                    </button>
                  )}
                </div>
              </article>
            );
          })}
          {catalog.length === 0 ? (
            <div className="skill-empty-state">
              <span><Package size={25} weight="regular" aria-hidden="true" /></span>
              <h3>首个工作流已确认</h3>
              <p>“期刊追踪与精读”会先作为完整工作流验证，内部能力暂不作为市场条目展示。</p>
              <small>当前不会预装、推荐或模拟可下载能力包。</small>
            </div>
          ) : null}
          {catalog.length > 0 && visibleSkills.length === 0 ? <p className="empty-note skill-empty">没有匹配的技能</p> : null}
        </div>

        <footer className="skill-dialog-footer">
          <div>
            <ShieldCheck size={17} weight="regular" aria-hidden="true" />
            <p><strong>毛坯状态</strong><span>当前只保留入口和结构；不会执行真实包安装，也不收集密钥。</span></p>
          </div>
          <button className="primary-action" type="button" onClick={onClose}>完成</button>
        </footer>
      </section>
    </div>
  );
}
