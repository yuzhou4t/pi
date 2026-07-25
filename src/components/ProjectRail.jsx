import { Fragment } from "react";
import {
  BookOpenText,
  CircleNotch,
  Code,
  FolderSimplePlus,
  GearSix,
  MagnifyingGlass,
  PlayCircle,
  Plus,
  Sparkle,
  X,
} from "@phosphor-icons/react";

export function ProjectRail({
  projects,
  selectedId,
  onSelect,
  conversations = [],
  selectedConversationId = null,
  onSelectConversation,
  onNewConversation,
  creatingConversationProjectIds = [],
  preparingConversationProjectId = null,
  workspaceKind = "project_work",
  onWorkspaceKindChange,
  query,
  onQueryChange,
  onAddProject,
  onRemoveProject,
  onOpenSettings,
  settingsOpen,
  mobileActive,
  activeRun,
  onSelectRun,
  selectedRunId = null,
  onMouseDownResizer,
  isResizing,
}) {
  const creatingProjectIds = new Set(creatingConversationProjectIds);
  const normalizedQuery = query.trim().toLowerCase();
  const matchesQuery = (value) => String(value ?? "").toLowerCase().includes(normalizedQuery);
  const filteredProjects = projects.filter((project) => {
    if (!normalizedQuery) return true;
    const projectMatches = matchesQuery(`${project.name} ${project.state} ${project.rootLabel}`);
    const conversationMatches = conversations.some(
      (conversation) => conversation.projectId === project.id
        && matchesQuery(`${conversation.title} ${conversation.subtitle} ${conversation.kind}`),
    );
    const runMatches = project.id === selectedId
      && matchesQuery(`${activeRun?.name} ${activeRun?.title} ${activeRun?.statusLabel}`);
    return projectMatches || conversationMatches || runMatches;
  });

  return (
    <aside className={`project-rail${mobileActive ? " is-mobile-active" : ""}`} aria-label="项目列表">
      <div className="sidebar-brand-header">
        <div className="brand-lockup">
          <span className="brand-icon">
            <Sparkle size={16} weight="fill" aria-hidden="true" />
          </span>
          <span className="brand-name">Pi Agent</span>
        </div>
      </div>

      <nav className="workspace-kind-switch" aria-label="工作类型">
        <button
          className={workspaceKind === "project_work" ? "is-active" : ""}
          type="button"
          aria-pressed={workspaceKind === "project_work"}
          onClick={() => onWorkspaceKindChange?.("project_work")}
        >
          <Code size={15} weight={workspaceKind === "project_work" ? "fill" : "regular"} aria-hidden="true" />
          正常工作
        </button>
        <button
          className={workspaceKind === "paper_reading" ? "is-active" : ""}
          type="button"
          aria-pressed={workspaceKind === "paper_reading"}
          onClick={() => onWorkspaceKindChange?.("paper_reading")}
        >
          <BookOpenText size={15} weight={workspaceKind === "paper_reading" ? "fill" : "regular"} aria-hidden="true" />
          论文精读
        </button>
      </nav>

      <label className="search-field" htmlFor="project-search">
        <MagnifyingGlass size={15} weight="regular" aria-hidden="true" />
        <input
          id="project-search"
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="搜索项目和会话..."
        />
      </label>

      <div className="project-list">
        <div className="project-list-heading">
          <span className="eyebrow">{workspaceKind === "paper_reading" ? "研读项目" : "工作项目"}</span>
          <button
            className="icon-button"
            type="button"
            aria-label={`向${workspaceKind === "paper_reading" ? "论文精读" : "正常工作"}添加项目`}
            title="添加项目"
            onClick={onAddProject}
          >
            <FolderSimplePlus size={17} weight="regular" aria-hidden="true" />
          </button>
        </div>
        {filteredProjects.map((project) => {
          const selected = project.id === selectedId;
          const creatingConversation = creatingProjectIds.has(project.id);
          const projectMatches = matchesQuery(`${project.name} ${project.state} ${project.rootLabel}`);
          const projectConversations = conversations.filter((conversation) => (
            conversation.projectId === project.id
            && (!normalizedQuery || projectMatches || matchesQuery(
              `${conversation.title} ${conversation.subtitle} ${conversation.kind}`,
            ))
          ));
          return (
            <Fragment key={project.id}>
              <div
                className={`project-row${selected ? " is-selected" : ""}`}
              >
                <button
                  className="project-row-copy"
                  type="button"
                  aria-current={selected ? "page" : undefined}
                  aria-expanded={selected}
                  onClick={() => onSelect(project.id)}
                >
                  <strong>{project.name}</strong>
                  <small>{project.state}</small>
                </button>
                <time>{project.updated}</time>
                {onRemoveProject && project.removable ? (
                  <button
                    className="icon-button project-remove-button"
                    type="button"
                    onClick={() => onRemoveProject(project.id)}
                    aria-label={`从当前类型移除 ${project.name}`}
                    title="从列表移除，不删除本地文件"
                  >
                    <X size={14} weight="regular" aria-hidden="true" />
                  </button>
                ) : null}
                {onNewConversation ? (
                  <button
                    className="icon-button"
                    type="button"
                    onClick={() => onNewConversation(project.id)}
                    disabled={creatingConversation}
                    aria-busy={creatingConversation}
                    aria-label={`在 ${project.name} 中新建会话`}
                    title={creatingConversation ? "正在创建工作会话" : "新建会话"}
                  >
                    {creatingConversation
                      ? <CircleNotch className="spin" size={15} weight="bold" aria-hidden="true" />
                      : <Plus size={15} weight="bold" aria-hidden="true" />}
                  </button>
                ) : null}
              </div>
              {selected ? (
                <div className="project-children">
                  <div className="project-conversation-list">
                    {creatingConversation ? (
                      <button
                        className={`project-conversation-row${preparingConversationProjectId === project.id ? " is-active" : ""}`}
                        type="button"
                        disabled
                        aria-live="polite"
                      >
                        <CircleNotch className="spin" size={16} weight="bold" aria-hidden="true" />
                        <span>
                          <strong>新工作会话</strong>
                          <small>正在创建会话…</small>
                        </span>
                      </button>
                    ) : null}
                    {projectConversations.map((conversation) => {
                      const conversationSelected = conversation.id === selectedConversationId;
                      const ConversationIcon = conversation.kind === "paper_reading"
                        ? BookOpenText
                        : Code;
                      return (
                        <button
                          key={conversation.id}
                          className={`project-conversation-row${conversationSelected ? " is-active" : ""}`}
                          type="button"
                          aria-current={conversationSelected ? "page" : undefined}
                          onClick={() => onSelectConversation?.(conversation.id)}
                        >
                          <ConversationIcon
                            size={16}
                            weight={conversationSelected ? "fill" : "regular"}
                            aria-hidden="true"
                          />
                          <span>
                            <strong>{conversation.title}</strong>
                            <small>{conversation.subtitle}</small>
                          </span>
                        </button>
                      );
                    })}
                    {projectConversations.length === 0 && !creatingConversation ? (
                      <p className="project-child-empty">还没有会话</p>
                    ) : null}
                  </div>

                  {activeRun ? (
                    <button
                      className={`capability-row project-run-row${selectedRunId === activeRun.id ? " is-active" : ""}`}
                      type="button"
                      aria-label={`打开本周追踪：${activeRun.statusLabel ?? activeRun.status ?? "等待审阅"}`}
                      onClick={() => onSelectRun?.(activeRun.id)}
                    >
                      <PlayCircle size={17} weight="regular" aria-hidden="true" />
                      <span>
                        <strong>本周追踪</strong>
                        <small>{activeRun.statusLabel ?? activeRun.status ?? "等待审阅"}</small>
                      </span>
                    </button>
                  ) : null}
                </div>
              ) : null}
            </Fragment>
          );
        })}
        {filteredProjects.length === 0 ? (
          <p className="empty-note">没有匹配项目</p>
        ) : null}
      </div>

      <div className="rail-footer">
        <div className="rail-footnote">
          <span className="status-dot" aria-hidden="true" />
          <span>Pi Agent · 本地工作流播放器</span>
        </div>
        <button
          id="settings-trigger"
          className={`settings-row${settingsOpen ? " is-active" : ""}`}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={settingsOpen}
          onClick={onOpenSettings}
        >
          <GearSix size={18} weight="regular" aria-hidden="true" />
          <span>
            <strong>设置</strong>
            <small>模型、能力包与偏好</small>
          </span>
        </button>
      </div>

      {onMouseDownResizer ? (
        <div
          className={`panel-resizer-handle${isResizing ? " is-resizing" : ""}`}
          onMouseDown={onMouseDownResizer}
          title="按住左右拖拽调整左侧栏宽度"
          aria-label="拖拽调整左侧栏宽度"
        >
          <span className="resizer-line" />
        </div>
      ) : null}
    </aside>
  );
}
