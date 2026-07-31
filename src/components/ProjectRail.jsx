import { Fragment, useEffect, useState } from "react";
import {
  BookOpenText,
  CaretDown,
  CaretRight,
  ChatText,
  CircleNotch,
  ClockCounterClockwise,
  Code,
  DotsThree,
  FolderSimplePlus,
  GearSix,
  MagnifyingGlass,
  PencilSimple,
  PlayCircle,
  Plus,
  Sparkle,
  Trash,
  X,
} from "@phosphor-icons/react";
import { usePersistentState } from "../hooks/usePersistentState.js";

function ConversationList({
  conversations,
  selectedConversationId,
  deletingConversationId,
  onSelectConversation,
  onRenameConversation,
  onDeleteConversation,
  onResetPaperConversation,
  openConversationMenuId,
  setOpenConversationMenuId,
}) {
  return conversations.map((conversation) => {
    const conversationSelected = conversation.id === selectedConversationId;
    const deletingConversation = conversation.id === deletingConversationId;
    const deletionBlocked = conversation.deleteBlocked === true;
    const ConversationIcon = conversation.projectId === null
      ? ChatText
      : conversation.kind === "paper_reading"
        ? BookOpenText
        : Code;
    const resetBlocked = conversation.resetBlocked === true;
    const hasPaperActions = conversation.kind === "paper_reading" && Boolean(onResetPaperConversation);
    const hasConversationActions = (
      conversation.kind === "project_work"
      && (onRenameConversation || onDeleteConversation)
    ) || hasPaperActions;
    return (
      <div
        key={conversation.id}
        className={`project-conversation-item${hasConversationActions ? " has-actions" : ""}${openConversationMenuId === conversation.id ? " has-open-menu" : ""}`}
        data-conversation-menu
        data-delete-blocked={deletionBlocked || undefined}
      >
        <button
          className={`project-conversation-row${conversationSelected ? " is-active" : ""}`}
          type="button"
          disabled={deletingConversation}
          aria-current={conversationSelected ? "page" : undefined}
          onClick={() => onSelectConversation?.(conversation.id)}
        >
          {deletingConversation ? (
            <CircleNotch className="spin" size={16} weight="bold" aria-hidden="true" />
          ) : (
            <ConversationIcon
              size={16}
              weight={conversationSelected ? "fill" : "regular"}
              aria-hidden="true"
            />
          )}
          <span>
            <strong>{conversation.title}</strong>
            <small>{deletingConversation ? "正在删除…" : conversation.subtitle}</small>
          </span>
          {conversation.unreadCount > 0 ? (
            <b
              className="project-conversation-unread-badge"
              aria-label={`${conversation.unreadCount} 条未读消息`}
            >
              {conversation.unreadCount > 99 ? "99+" : conversation.unreadCount}
            </b>
          ) : null}
        </button>
        {hasConversationActions && !deletingConversation ? (
          <>
            <button
              className="project-conversation-more"
              type="button"
              aria-label={`打开“${conversation.title}”的更多操作`}
              aria-haspopup="menu"
              aria-expanded={openConversationMenuId === conversation.id}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                setOpenConversationMenuId((current) => (
                  current === conversation.id ? null : conversation.id
                ));
              }}
            >
              <DotsThree size={17} weight="bold" aria-hidden="true" />
            </button>
            {openConversationMenuId === conversation.id ? (
              <div
                className="project-conversation-menu"
                role="menu"
                aria-label={`“${conversation.title}”会话操作`}
                onPointerDown={(event) => event.stopPropagation()}
              >
                {conversation.kind === "project_work" && onRenameConversation ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={(event) => {
                      event.stopPropagation();
                      setOpenConversationMenuId(null);
                      onRenameConversation(conversation);
                    }}
                  >
                    <PencilSimple size={15} weight="regular" aria-hidden="true" />
                    重命名
                  </button>
                ) : null}
                {conversation.kind === "project_work" && onDeleteConversation ? (
                  <button
                    className="is-danger"
                    type="button"
                    role="menuitem"
                    disabled={deletionBlocked}
                    title={deletionBlocked ? "请先停止当前运行，再删除会话" : undefined}
                    onClick={(event) => {
                      event.stopPropagation();
                      setOpenConversationMenuId(null);
                      onDeleteConversation(conversation, {
                        visibleConversationIds: conversations.map((item) => item.id),
                      });
                    }}
                  >
                    <Trash size={15} weight="regular" aria-hidden="true" />
                    删除会话
                  </button>
                ) : null}
                {hasPaperActions ? (
                  <button
                    className="is-danger"
                    type="button"
                    role="menuitem"
                    disabled={resetBlocked}
                    title={resetBlocked
                      ? "这篇论文已完成归档，研读记录保持只读"
                      : undefined}
                    onClick={(event) => {
                      event.stopPropagation();
                      setOpenConversationMenuId(null);
                      onResetPaperConversation(conversation);
                    }}
                  >
                    <Trash size={15} weight="regular" aria-hidden="true" />
                    删除研读记录
                  </button>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    );
  });
}

export function ProjectRail({
  projects,
  selectedId,
  onSelect,
  conversations = [],
  selectedConversationId = null,
  onSelectConversation,
  onNewConversation,
  onNewStandaloneConversation,
  onDeleteConversation,
  onRenameConversation,
  onResetPaperConversation,
  deletingConversationId = null,
  creatingConversationProjectIds = [],
  preparingConversationProjectId = null,
  creatingStandaloneConversation = false,
  preparingStandaloneConversation = false,
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
  topicSearchActive = false,
  onSelectTopicSearch,
  recentClassicsActive = false,
  onSelectRecentClassics,
  pastRunsActive = false,
  onSelectPastRuns,
  topicConversations = [],
  activeTopicConversationId = null,
  onSelectTopicConversation,
  onCreateTopicConversation,
  onDeleteTopicConversation,
  onMouseDownResizer,
  isResizing,
}) {
  const [openConversationMenuId, setOpenConversationMenuId] = useState(null);
  const [topicListOpen, setTopicListOpen] = usePersistentState(
    "pi-agent-topic-list-open-v1",
    true,
  );
  const creatingProjectIds = new Set(creatingConversationProjectIds);
  const normalizedQuery = query.trim().toLowerCase();
  const matchesQuery = (value) => String(value ?? "").toLowerCase().includes(normalizedQuery);
  const standaloneConversations = conversations.filter((conversation) => (
    conversation.projectId === null
    && (!normalizedQuery || matchesQuery(
      `${conversation.title} ${conversation.subtitle} ${conversation.kind}`,
    ))
  ));
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

  useEffect(() => {
    if (!openConversationMenuId) return undefined;
    const closeMenu = () => setOpenConversationMenuId(null);
    const closeOnEscape = (event) => {
      if (event.key === "Escape") closeMenu();
    };
    window.addEventListener("pointerdown", closeMenu);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [openConversationMenuId]);

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
        {workspaceKind === "project_work" ? (
          <>
            <button
              className="standalone-new-button"
              type="button"
              onClick={onNewStandaloneConversation}
              disabled={creatingStandaloneConversation}
              aria-busy={creatingStandaloneConversation}
            >
              {creatingStandaloneConversation ? (
                <CircleNotch className="spin" size={17} weight="bold" aria-hidden="true" />
              ) : (
                <Plus size={17} weight="bold" aria-hidden="true" />
              )}
              <span>
                <strong>新建对话</strong>
              </span>
            </button>
            {creatingStandaloneConversation || standaloneConversations.length > 0 ? (
              <section className="standalone-conversations" aria-label="独立对话">
                <div className="project-list-heading">
                  <span className="eyebrow">独立对话</span>
                </div>
                <div className="project-conversation-list">
                  {creatingStandaloneConversation ? (
                    <button
                      className={`project-conversation-row${preparingStandaloneConversation ? " is-active" : ""}`}
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
                  <ConversationList
                    conversations={standaloneConversations}
                    selectedConversationId={selectedConversationId}
                    deletingConversationId={deletingConversationId}
                    onSelectConversation={onSelectConversation}
                    onRenameConversation={onRenameConversation}
                    onDeleteConversation={onDeleteConversation}
                    openConversationMenuId={openConversationMenuId}
                    setOpenConversationMenuId={setOpenConversationMenuId}
                  />
                </div>
              </section>
            ) : null}
          </>
        ) : null}
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
                  {workspaceKind === "paper_reading" && activeRun ? (
                    <button
                      className={`capability-row project-run-row${selectedRunId === activeRun.id ? " is-active" : ""}`}
                      type="button"
                      aria-label={`打开每月追踪：${activeRun.statusLabel ?? activeRun.status ?? "等待审阅"}`}
                      onClick={() => onSelectRun?.(activeRun.id)}
                    >
                      <PlayCircle size={17} weight="regular" aria-hidden="true" />
                      <span>
                        <strong>每月追踪</strong>
                        <small>{activeRun.statusLabel ?? activeRun.status ?? "等待审阅"}</small>
                      </span>
                    </button>
                  ) : null}
                  {workspaceKind === "paper_reading" && onSelectTopicSearch ? (
                    <div className="project-topic-search">
                      <div className="project-topic-head">
                        <button
                          className={`capability-row project-run-row project-topic-open${topicSearchActive ? " is-active" : ""}`}
                          type="button"
                          aria-label={topicListOpen ? "收起检索会话列表" : "展开主题检索"}
                          aria-expanded={topicListOpen}
                          onClick={() => {
                            if (topicListOpen) {
                              setTopicListOpen(false);
                              return;
                            }
                            setTopicListOpen(true);
                            onSelectTopicSearch();
                          }}
                        >
                          <MagnifyingGlass size={17} weight="regular" aria-hidden="true" />
                          <span>
                            <strong>主题检索</strong>
                            <small>注册刊物 + 联网检索</small>
                          </span>
                          {topicConversations.length > 0 ? (
                            topicListOpen
                              ? <CaretDown className="project-topic-caret" size={13} weight="bold" aria-hidden="true" />
                              : <CaretRight className="project-topic-caret" size={13} weight="bold" aria-hidden="true" />
                          ) : null}
                        </button>
                        {onCreateTopicConversation ? (
                          <button
                            className="project-topic-new"
                            type="button"
                            aria-label="新建检索会话"
                            title="新建检索会话"
                            onClick={() => {
                              setTopicListOpen(true);
                              onCreateTopicConversation();
                            }}
                          >
                            <Plus size={14} weight="bold" aria-hidden="true" />
                          </button>
                        ) : null}
                      </div>
                      {topicListOpen && topicConversations.length > 0 ? (
                        <ul className="project-topic-list">
                          {topicConversations.map((conversation) => (
                            <li
                              key={conversation.id}
                              className={`project-topic-item${
                                topicSearchActive && conversation.id === activeTopicConversationId
                                  ? " is-active"
                                  : ""
                              }`}
                            >
                              <button
                                type="button"
                                className="project-topic-item-open"
                                onClick={() => onSelectTopicConversation?.(conversation.id)}
                                title={conversation.title}
                              >
                                <span className="project-topic-item-title">{conversation.title}</span>
                                <small>{conversation.turnCount} 条检索</small>
                              </button>
                              {onDeleteTopicConversation ? (
                                <button
                                  type="button"
                                  className="project-topic-item-delete"
                                  aria-label="删除该检索会话"
                                  title="删除该检索会话"
                                  onClick={() => onDeleteTopicConversation(conversation)}
                                >
                                  <Trash size={13} weight="regular" aria-hidden="true" />
                                </button>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  ) : null}

                  {workspaceKind === "paper_reading" && onSelectRecentClassics ? (
                    <button
                      className={`capability-row project-run-row${recentClassicsActive ? " is-active" : ""}`}
                      type="button"
                      aria-label="打开近年经典：注册刊物高引未读论文"
                      onClick={onSelectRecentClassics}
                    >
                      <BookOpenText size={17} weight="regular" aria-hidden="true" />
                      <span>
                        <strong>近年经典</strong>
                        <small>高引未读论文</small>
                      </span>
                    </button>
                  ) : null}
                  {workspaceKind === "paper_reading" && onSelectPastRuns ? (
                    <button
                      className={`capability-row project-run-row${pastRunsActive ? " is-active" : ""}`}
                      type="button"
                      aria-label="打开往期回看：历次推荐与处理记录"
                      onClick={onSelectPastRuns}
                    >
                      <ClockCounterClockwise size={17} weight="regular" aria-hidden="true" />
                      <span>
                        <strong>往期回看</strong>
                        <small>历次推荐记录</small>
                      </span>
                    </button>
                  ) : null}

                  <section
                    className={workspaceKind === "paper_reading"
                      ? "project-paper-conversations"
                      : undefined}
                    aria-label={workspaceKind === "paper_reading" ? "论文研读" : "项目会话"}
                  >
                    {workspaceKind === "paper_reading" ? (
                      <div className="project-child-heading">
                        <span>论文研读</span>
                        <small>{projectConversations.length}</small>
                      </div>
                    ) : null}
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
                      <ConversationList
                        conversations={projectConversations}
                        selectedConversationId={selectedConversationId}
                        deletingConversationId={deletingConversationId}
                        onSelectConversation={onSelectConversation}
                        onRenameConversation={onRenameConversation}
                        onDeleteConversation={onDeleteConversation}
                        onResetPaperConversation={onResetPaperConversation}
                        openConversationMenuId={openConversationMenuId}
                        setOpenConversationMenuId={setOpenConversationMenuId}
                      />
                      {projectConversations.length === 0 && !creatingConversation ? (
                        <p className="project-child-empty">
                          {workspaceKind === "paper_reading"
                            ? "还没有选择研读的论文"
                            : "还没有会话"}
                        </p>
                      ) : null}
                    </div>
                  </section>

                  {workspaceKind !== "paper_reading" && activeRun ? (
                    <button
                      className={`capability-row project-run-row${selectedRunId === activeRun.id ? " is-active" : ""}`}
                      type="button"
                      aria-label={`打开每月追踪：${activeRun.statusLabel ?? activeRun.status ?? "等待审阅"}`}
                      onClick={() => onSelectRun?.(activeRun.id)}
                    >
                      <PlayCircle size={17} weight="regular" aria-hidden="true" />
                      <span>
                        <strong>每月追踪</strong>
                        <small>{activeRun.statusLabel ?? activeRun.status ?? "等待审阅"}</small>
                      </span>
                    </button>
                  ) : null}
                </div>
              ) : null}
            </Fragment>
          );
        })}
        {filteredProjects.length === 0 && (
          workspaceKind !== "project_work" || standaloneConversations.length === 0
        ) ? (
          <p className="empty-note">没有匹配内容</p>
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
