import {
  useEffect,
  useId,
  useRef,
} from "react";
import {
  ArrowClockwise,
  CaretDown,
  ChatsCircle,
  GitBranch,
  Plus,
  Trash,
  TreeStructure,
} from "@phosphor-icons/react";

function compactLabel(value, fallback = "") {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : fallback;
}

function messageText(message) {
  if (typeof message?.content === "string") return message.content.trim();
  if (typeof message?.text === "string") return message.text.trim();
  return "";
}

function checkpointTurnKey(checkpoint, index) {
  if (compactLabel(checkpoint?.turnId)) return `turn:${checkpoint.turnId}`;
  if (Number.isSafeInteger(checkpoint?.turnSeq)) {
    return `turn-seq:${checkpoint.turnSeq}`;
  }
  return `checkpoint:${compactLabel(checkpoint?.id, String(index))}`;
}

function compareCheckpoints(left, right) {
  const leftAttempt = Number.isSafeInteger(left.attempt)
    ? left.attempt
    : Number.MAX_SAFE_INTEGER;
  const rightAttempt = Number.isSafeInteger(right.attempt)
    ? right.attempt
    : Number.MAX_SAFE_INTEGER;
  if (leftAttempt !== rightAttempt) return leftAttempt - rightAttempt;
  return left.index - right.index;
}

function checkpointModelLabel(checkpoint, assistantMessage) {
  const evidence = assistantMessage?.turnEvidence;
  const provider = compactLabel(
    checkpoint.providerName,
    compactLabel(
      checkpoint.providerId,
      compactLabel(evidence?.providerId, assistantMessage?.providerId),
    ),
  );
  const model = compactLabel(
    checkpoint.modelName,
    compactLabel(
      checkpoint.modelId,
      compactLabel(evidence?.modelId, assistantMessage?.modelId),
    ),
  );
  return [provider, model].filter(Boolean).join(" · ") || "模型未记录";
}

function checkpointPromptLabel(checkpoint, userMessage) {
  const explicit = compactLabel(checkpoint.title);
  const prompt = explicit || messageText(userMessage);
  if (!prompt) return "已完成的会话检查点";
  return prompt.length > 72 ? `${prompt.slice(0, 72)}…` : prompt;
}

/**
 * Builds the compact, public checkpoint projection used by the menu. The
 * browser receives only product-level checkpoint IDs; native runtime IDs are
 * intentionally irrelevant to this view.
 */
export function buildProjectSessionPathGroups(sessionPath, messages = []) {
  const checkpoints = Array.isArray(sessionPath?.checkpoints)
    ? sessionPath.checkpoints
    : [];
  const safeMessages = Array.isArray(messages) ? messages : [];
  const messagesById = new Map(
    safeMessages
      .filter((message) => compactLabel(message?.id))
      .map((message) => [message.id, message]),
  );
  const groups = new Map();

  checkpoints.forEach((checkpoint, index) => {
    const id = compactLabel(checkpoint?.id);
    if (!id) return;
    const key = checkpointTurnKey(checkpoint, index);
    const userMessage = messagesById.get(checkpoint.userMessageId)
      ?? safeMessages.find((message) => (
        message?.role === "user"
        && checkpoint.turnId
        && message.turnId === checkpoint.turnId
      ));
    const assistantMessage = messagesById.get(checkpoint.assistantMessageId)
      ?? safeMessages.find((message) => (
        message?.role === "assistant"
        && checkpoint.turnId
        && message.turnId === checkpoint.turnId
        && (
          !Number.isSafeInteger(checkpoint.attempt)
          || message.attempt === checkpoint.attempt
        )
      ));
    const normalized = {
      ...checkpoint,
      id,
      index,
      attempt: Number.isSafeInteger(checkpoint.attempt)
        && checkpoint.attempt > 0
        ? checkpoint.attempt
        : null,
      modelLabel: checkpointModelLabel(checkpoint, assistantMessage),
      status: compactLabel(
        checkpoint.status,
        compactLabel(assistantMessage?.status, "completed"),
      ),
    };
    const existing = groups.get(key) ?? {
      id: key,
      turnId: compactLabel(checkpoint.turnId) || null,
      turnSeq: Number.isSafeInteger(checkpoint.turnSeq)
        ? checkpoint.turnSeq
        : Number.isSafeInteger(userMessage?.turnSeq)
          ? userMessage.turnSeq
          : null,
      prompt: checkpointPromptLabel(checkpoint, userMessage),
      firstIndex: index,
      checkpoints: [],
    };
    existing.firstIndex = Math.min(existing.firstIndex, index);
    existing.checkpoints.push(normalized);
    groups.set(key, existing);
  });

  return [...groups.values()]
    .map((group) => ({
      ...group,
      checkpoints: group.checkpoints.sort(compareCheckpoints),
    }))
    .sort((left, right) => {
      if (
        Number.isSafeInteger(left.turnSeq)
        && Number.isSafeInteger(right.turnSeq)
        && left.turnSeq !== right.turnSeq
      ) {
        return left.turnSeq - right.turnSeq;
      }
      return left.firstIndex - right.firstIndex;
    });
}

export function resolveProjectSessionPathSelection(
  sessionPath,
  selectedCheckpointId,
) {
  const checkpoints = Array.isArray(sessionPath?.checkpoints)
    ? sessionPath.checkpoints.filter((checkpoint) => compactLabel(checkpoint?.id))
    : [];
  return checkpoints.find((checkpoint) => checkpoint.id === selectedCheckpointId)
    ?? checkpoints.find((checkpoint) => (
      checkpoint.id === sessionPath?.activeLeafCheckpointId
    ))
    ?? checkpoints.at(-1)
    ?? null;
}

function commonActionReason(checkpoint, busy) {
  if (!checkpoint) return "当前还没有可用检查点";
  if (busy) return "当前 Agent 正在工作，完成后可调整会话路径";
  const blockedReason = compactLabel(checkpoint.blockedReason);
  if (blockedReason) return blockedReason;
  if (checkpoint.branchable !== true) return "这个检查点暂时不能创建新路径";
  return null;
}

export function projectSessionPathActionState(checkpoint, {
  busy = false,
  standalone = false,
  onRetryCheckpoint,
  onStartBranch,
  onForkCheckpoint,
} = {}) {
  const commonReason = commonActionReason(checkpoint, busy);
  const unavailableReason = "当前版本尚未提供此操作";
  const forkStandaloneReason = "独立对话不能复制为项目会话";
  return {
    retry: {
      disabled: Boolean(commonReason) || typeof onRetryCheckpoint !== "function",
      reason: commonReason
        ?? (typeof onRetryCheckpoint === "function" ? null : unavailableReason),
    },
    branch: {
      disabled: Boolean(commonReason) || typeof onStartBranch !== "function",
      reason: commonReason
        ?? (typeof onStartBranch === "function" ? null : unavailableReason),
    },
    fork: {
      disabled: Boolean(commonReason)
        || standalone
        || typeof onForkCheckpoint !== "function",
      reason: commonReason
        ?? (standalone ? forkStandaloneReason : null)
        ?? (typeof onForkCheckpoint === "function" ? null : unavailableReason),
    },
  };
}

export function projectWorkspaceActionState(workspace, {
  currentWorkspaceId = null,
  busy = false,
  loading = false,
} = {}) {
  const unavailable = workspace?.status && workspace.status !== "available"
    ? "Workspace 当前正在使用"
    : null;
  const commonReason = loading
    ? "正在刷新 Workspace"
    : busy
      ? "当前 Agent 正在工作"
      : unavailable;
  const current = workspace?.id === currentWorkspaceId;
  const openReason = commonReason ?? (current ? "当前会话已固定在这里" : null);
  const removeReason = commonReason
    ?? (workspace?.isMain ? "主 Workspace 不能删除" : null)
    ?? (!workspace?.isGit || workspace?.kind !== "git_worktree"
      ? "只有次级 Git worktree 可以删除"
      : null)
    ?? (workspace?.dirty ? "含有未提交修改，不能删除" : null)
    ?? (workspace?.conversationCount > 0 ? "仍有会话使用，不能删除" : null)
    ?? (!workspace?.head ? "缺少可确认的 Git HEAD" : null);
  return {
    current,
    open: { disabled: Boolean(openReason), reason: openReason },
    remove: { disabled: Boolean(removeReason), reason: removeReason },
  };
}

export function selectProjectSessionCheckpoint(
  checkpointId,
  callbacks,
) {
  if (!compactLabel(checkpointId)) return false;
  const onSelectCheckpoint = typeof callbacks === "function"
    ? callbacks
    : callbacks?.onSelectCheckpoint;
  onSelectCheckpoint?.(checkpointId);
  return typeof onSelectCheckpoint === "function";
}

export function closeProjectSessionPathMenu({
  onOpenChange,
  trigger,
} = {}) {
  onOpenChange?.(false);
  trigger?.focus?.();
}

export function handleProjectSessionPathEscape(event, options = {}) {
  if (event?.key !== "Escape") return false;
  event.preventDefault?.();
  event.stopPropagation?.();
  closeProjectSessionPathMenu(options);
  return true;
}

function ProjectSessionPathAction({
  icon: Icon,
  label,
  description,
  state,
  onClick,
}) {
  return (
    <button
      type="button"
      disabled={state.disabled}
      onClick={onClick}
      title={state.reason ?? undefined}
    >
      <Icon size={15} weight="regular" aria-hidden="true" />
      <span>
        <strong>{label}</strong>
        <small>{state.reason ?? description}</small>
      </span>
    </button>
  );
}

export function ProjectSessionPathMenu({
  open,
  onOpenChange,
  hideTrigger = false,
  sessionPath,
  messages,
  selectedCheckpointId,
  onSelectCheckpoint,
  onRetryCheckpoint,
  onStartBranch,
  onForkCheckpoint,
  workspaces = [],
  currentWorkspaceId = null,
  workspacesLoading = false,
  workspaceAction = null,
  workspaceError = null,
  onCreateWorktreeConversation,
  onCreateConversationInWorkspace,
  onRemoveWorkspace,
  busy = false,
  standalone = false,
}) {
  const triggerRef = useRef(null);
  const dialogId = useId();
  const titleId = `${dialogId}-title`;
  const groups = buildProjectSessionPathGroups(sessionPath, messages);
  const selectedCheckpoint = resolveProjectSessionPathSelection(
    sessionPath,
    selectedCheckpointId,
  );
  const actionState = projectSessionPathActionState(selectedCheckpoint, {
    busy,
    standalone,
    onRetryCheckpoint,
    onStartBranch,
    onForkCheckpoint,
  });

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => handleProjectSessionPathEscape(event, {
      onOpenChange,
      trigger: triggerRef.current,
    });
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onOpenChange, open]);

  const closeWithoutFocus = () => onOpenChange?.(false);
  const runAction = (state, callback) => {
    if (state.disabled || !selectedCheckpoint) return;
    callback?.(selectedCheckpoint.id);
    closeWithoutFocus();
  };

  return (
    <div className="project-session-path-menu">
      {open ? (
        <button
          className="project-session-path-scrim"
          type="button"
          aria-label="关闭会话路径"
          onClick={() => closeProjectSessionPathMenu({
            onOpenChange,
            trigger: triggerRef.current,
          })}
        />
      ) : null}

      {!hideTrigger ? (
        <button
          ref={triggerRef}
          className={`header-meta-pill project-session-path-trigger${open ? " is-open" : ""}`}
          type="button"
          aria-expanded={Boolean(open)}
          aria-haspopup="dialog"
          aria-controls={open ? dialogId : undefined}
          onClick={() => {
            if (open) {
              closeProjectSessionPathMenu({
                onOpenChange,
                trigger: triggerRef.current,
              });
            } else {
              onOpenChange?.(true);
            }
          }}
        >
          <TreeStructure size={13} weight="regular" aria-hidden="true" />
          <span>路径</span>
          <CaretDown size={11} weight="bold" aria-hidden="true" />
        </button>
      ) : null}

      {open ? (
        <section
          id={dialogId}
          className="project-session-path-popover"
          role="dialog"
          aria-labelledby={titleId}
        >
          <header className="project-session-path-header">
            <div>
              <strong id={titleId}>路径与 Workspace</strong>
              <small>会话固定使用一个 Workspace；每个已完成回答都会保留为检查点</small>
            </div>
          </header>

          <div
            className="project-session-path-body"
            role="region"
            aria-label="会话路径内容"
            tabIndex={0}
          >
            {!standalone ? (
              <section className="project-session-workspaces" aria-label="项目 Workspace">
                <header>
                  <strong>Workspace</strong>
                  <small>{workspacesLoading ? "正在刷新…" : `${workspaces.length} 个可用位置`}</small>
                </header>
                {workspaces.length > 0 ? (
                  <ul>
                    {workspaces.map((workspace) => {
                      const state = projectWorkspaceActionState(workspace, {
                        currentWorkspaceId,
                        busy: busy || Boolean(workspaceAction),
                        loading: workspacesLoading,
                      });
                      return (
                        <li key={workspace.id}>
                          <div>
                            <strong>{workspace.label || "Workspace"}</strong>
                            <small>
                              {workspace.branch || (workspace.isGit ? "分离 HEAD" : "本地文件夹")}
                              {workspace.head ? ` · ${workspace.head.slice(0, 8)}` : ""}
                            </small>
                            <span>
                              {state.current ? "当前会话" : `${workspace.conversationCount ?? 0} 个会话`}
                              {workspace.dirty ? " · 有未提交修改" : ""}
                            </span>
                          </div>
                          {!state.current ? (
                            <button
                              type="button"
                              disabled={state.open.disabled}
                              title={state.open.reason ?? undefined}
                              onClick={() => onCreateConversationInWorkspace?.(workspace)}
                            >
                              {workspaceAction === `conversation:${workspace.id}` ? "正在创建" : "在此新建会话"}
                            </button>
                          ) : null}
                          {!workspace.isMain && workspace.kind === "git_worktree" ? (
                            <button
                              className="is-danger"
                              type="button"
                              disabled={state.remove.disabled}
                              title={state.remove.reason ?? undefined}
                              aria-label={`删除 Workspace ${workspace.label || workspace.branch || ""}`}
                              onClick={() => onRemoveWorkspace?.(workspace)}
                            >
                              <Trash size={13} aria-hidden="true" />
                            </button>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p>{workspacesLoading ? "正在读取 Workspace…" : "当前没有可显示的 Workspace。"}</p>
                )}
                {workspaceError ? <p className="is-error">{workspaceError}</p> : null}
                {workspaces.find((workspace) => workspace.id === currentWorkspaceId)?.isGit ? (
                  <button
                    className="project-session-workspace-create"
                    type="button"
                    disabled={busy || workspacesLoading || Boolean(workspaceAction)}
                    onClick={() => onCreateWorktreeConversation?.(
                      workspaces.find((workspace) => workspace.id === currentWorkspaceId),
                    )}
                  >
                    <Plus size={14} aria-hidden="true" />
                    {workspaceAction === "create" ? "正在创建" : "从当前 HEAD 新建 Workspace 会话"}
                  </button>
                ) : null}
              </section>
            ) : null}

            {groups.length > 0 ? (
              <ol className="project-session-path-turns">
                {groups.map((group, groupIndex) => (
                  <li className="project-session-path-turn" key={group.id}>
                    <header>
                      <span>
                        {Number.isSafeInteger(group.turnSeq)
                          ? `第 ${group.turnSeq} 轮`
                          : `检查点 ${groupIndex + 1}`}
                      </span>
                      <p>{group.prompt}</p>
                    </header>
                    <div
                      className="project-session-path-attempts"
                      role="radiogroup"
                      aria-label={`${Number.isSafeInteger(group.turnSeq)
                        ? `第 ${group.turnSeq} 轮`
                        : `检查点 ${groupIndex + 1}`}的回答方案`}
                    >
                      {group.checkpoints.map((checkpoint, attemptIndex) => {
                        const selected = checkpoint.id === selectedCheckpoint?.id;
                        const active = checkpoint.id
                          === sessionPath?.activeLeafCheckpointId;
                        return (
                          <button
                            className={[
                              "project-session-path-attempt",
                              selected ? "is-selected" : "",
                              active ? "is-active-path" : "",
                            ].filter(Boolean).join(" ")}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            key={checkpoint.id}
                            onClick={() => selectProjectSessionCheckpoint(
                              checkpoint.id,
                              { onSelectCheckpoint },
                            )}
                          >
                            <GitBranch size={14} weight="regular" aria-hidden="true" />
                            <span>
                              <strong>
                                方案 {checkpoint.attempt ?? attemptIndex + 1}
                              </strong>
                              <small>{checkpoint.modelLabel}</small>
                            </span>
                            {active ? <em>当前路径</em> : null}
                            {checkpoint.status === "failed" ? <em>未完成</em> : null}
                          </button>
                        );
                      })}
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="project-session-path-empty">
                完成一次回答后，这里会出现可继续的检查点。
              </p>
            )}
          </div>

          <footer className="project-session-path-actions">
            <ProjectSessionPathAction
              icon={ArrowClockwise}
              label="用当前模型重做"
              description="保留原回答，新增一个可切换方案"
              state={actionState.retry}
              onClick={() => runAction(
                actionState.retry,
                onRetryCheckpoint,
              )}
            />
            <ProjectSessionPathAction
              icon={GitBranch}
              label="从这里开新方案"
              description="回到输入框，显式发送后才开始"
              state={actionState.branch}
              onClick={() => runAction(
                actionState.branch,
                onStartBranch,
              )}
            />
            <ProjectSessionPathAction
              icon={ChatsCircle}
              label="复制为新会话"
              description="继承这里之前的上下文并独立继续"
              state={actionState.fork}
              onClick={() => runAction(
                actionState.fork,
                onForkCheckpoint,
              )}
            />
          </footer>
        </section>
      ) : null}
    </div>
  );
}

export default ProjectSessionPathMenu;
