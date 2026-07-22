import { Fragment } from "react";
import {
  FolderSimplePlus,
  GearSix,
  MagnifyingGlass,
  Package,
  PlayCircle,
  Sparkle,
} from "@phosphor-icons/react";
import { ProviderMenu } from "./ProviderMenu.jsx";

export function ProjectRail({
  projects,
  selectedId,
  onSelect,
  query,
  onQueryChange,
  onAddProject,
  onOpenSettings,
  settingsOpen,
  mobileActive,
  activeRun,
  onSelectRun,
  providers,
  providerId,
  model,
  providerOpen,
  onProviderOpenChange,
  onProviderChange,
  onModelChange,
  onOpenSkills,
  installedSkillCount,
}) {
  const filteredProjects = projects.filter((project) =>
    `${project.name} ${project.state}`.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <aside className={`project-rail${mobileActive ? " is-mobile-active" : ""}`} aria-label="项目列表">
      <div className="sidebar-brand-header">
        <div className="brand-lockup">
          <span className="brand-icon">
            <Sparkle size={16} weight="fill" aria-hidden="true" />
          </span>
          <span className="brand-name">Pi Agent</span>
        </div>
        <button className="icon-button" type="button" aria-label="添加本地项目" onClick={onAddProject}>
          <FolderSimplePlus size={18} weight="regular" aria-hidden="true" />
        </button>
      </div>

      <div className="sidebar-provider-wrap">
        <ProviderMenu
          open={providerOpen}
          onOpenChange={onProviderOpenChange}
          providers={providers}
          providerId={providerId}
          model={model}
          onProviderChange={onProviderChange}
          onModelChange={onModelChange}
        />
      </div>

      <label className="search-field" htmlFor="project-search">
        <MagnifyingGlass size={15} weight="regular" aria-hidden="true" />
        <input
          id="project-search"
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="搜索项目与 Run..."
        />
      </label>

      <div className="project-list">
        <span className="eyebrow">项目与 Run</span>
        {filteredProjects.map((project) => {
          const selected = project.id === selectedId;
          return (
            <Fragment key={project.id}>
              <button
                className={`project-row${selected ? " is-selected" : ""}`}
                type="button"
                aria-current={selected ? "page" : undefined}
                onClick={() => onSelect(project.id)}
              >
                <span className="project-row-copy">
                  <strong>{project.name}</strong>
                  <small>{project.state}</small>
                </span>
                <time>{project.updated}</time>
              </button>
              {selected && activeRun ? (
                <button
                  className="capability-row is-active"
                  type="button"
                  aria-label={`打开运行：${activeRun.name ?? activeRun.title ?? "期刊追踪与精读"}`}
                  onClick={() => onSelectRun?.(activeRun.id)}
                >
                  <PlayCircle size={17} weight="regular" aria-hidden="true" />
                  <span>
                    <strong>{activeRun.name ?? activeRun.title ?? "期刊追踪与精读"}</strong>
                    <small>当前 Run</small>
                  </span>
                  <b>{activeRun.statusLabel ?? activeRun.status ?? "等待审阅"}</b>
                </button>
              ) : null}
            </Fragment>
          );
        })}
        {filteredProjects.length === 0 ? (
          <p className="empty-note">没有匹配项目</p>
        ) : null}
      </div>

      <div className="rail-capabilities">
        <span className="eyebrow">工具与设置</span>
        <button className="capability-row" type="button" onClick={onOpenSkills}>
          <Package size={17} weight="regular" aria-hidden="true" />
          <span>
            <strong>技能中心</strong>
            <small>已启 {installedSkillCount} 个能力包</small>
          </span>
          <b>打开</b>
        </button>

        <button
          id="settings-trigger"
          className={`capability-row${settingsOpen ? " is-active" : ""}`}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={settingsOpen}
          onClick={onOpenSettings}
        >
          <GearSix size={17} weight="regular" aria-hidden="true" />
          <span>
            <strong>设置</strong>
            <small>模型、外观与数据</small>
          </span>
          <b>打开</b>
        </button>
      </div>

      <div className="rail-footnote">
        <span className="status-dot" aria-hidden="true" />
        <span>Pi Agent · 本地工作流播放器</span>
      </div>
    </aside>
  );
}
