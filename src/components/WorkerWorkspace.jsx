import { useEffect, useId, useMemo, useReducer, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowClockwise,
  ArrowsInSimple,
  BookOpenText,
  Briefcase,
  CaretDown,
  CaretRight,
  CheckCircle,
  EnvelopeSimple,
  FileText,
  FloppyDisk,
  FolderOpen,
  LinkSimple,
  MagnifyingGlass,
  PaperPlaneTilt,
  Paperclip,
  Plus,
  ShieldCheck,
  SidebarSimple,
  SpinnerGap,
  StopCircle,
  UploadSimple,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { AgentArtifactLayout } from "./AgentArtifactLayout.jsx";
import { ProviderMenu } from "./ProviderMenu.jsx";
import {
  BUILT_IN_WORKERS,
  createDeliveryConfirmationInput,
  createInitialWorkerState,
  DEFAULT_WORKER_TASKS,
  DELIVERY_STATUS,
  WORKER_ACTION_CATALOG,
  WORKER_ACTIONS,
  WORKER_ARTIFACTS,
  WORKER_IDS,
  WORKER_STATUS,
  workerReducer,
} from "../worker/workerState.js";
import "../worker.css";

const ARTIFACT_TABS = Object.freeze([
  { id: WORKER_ARTIFACTS.SOURCES, label: "资料" },
  { id: WORKER_ARTIFACTS.DRAFT, label: "草稿" },
  { id: WORKER_ARTIFACTS.DELIVERY, label: "交付" },
  { id: WORKER_ARTIFACTS.RECEIPT, label: "回执" },
]);

const STATUS_LABELS = Object.freeze({
  [WORKER_STATUS.READY]: "等待任务",
  [WORKER_STATUS.DRAFTING]: "整理草稿",
  [WORKER_STATUS.AWAITING_CONFIRMATION]: "交付待确认",
  [WORKER_STATUS.DELIVERING]: "正在交付",
  [WORKER_STATUS.COMPLETED]: "已完成",
  [WORKER_STATUS.BLOCKED]: "需要处理",
  [WORKER_STATUS.UNKNOWN]: "结果待核对",
});

const CONNECTION_LABELS = Object.freeze({
  connected: "已连接",
  disconnected: "未连接",
  degraded: "需要检查",
  checking: "正在检查",
});

export function shouldSubmitWorkerComposerKeyDown(event) {
  return event?.key === "Enter"
    && event.shiftKey !== true
    && event.isComposing !== true
    && event.nativeEvent?.isComposing !== true;
}

function WorkerTypeIcon({ workerId, size = 16, weight = "regular" }) {
  if (workerId === WORKER_IDS.LARK_DOCUMENT) {
    return <FileText size={size} weight={weight} aria-hidden="true" />;
  }
  if (workerId === WORKER_IDS.IMA_NOTE) {
    return <BookOpenText size={size} weight={weight} aria-hidden="true" />;
  }
  return <EnvelopeSimple size={size} weight={weight} aria-hidden="true" />;
}

function connectionFor(worker, connections) {
  return connections?.[worker.id] ?? connections?.[worker.connectorId] ?? {
    status: "disconnected",
    label: CONNECTION_LABELS.disconnected,
  };
}

/**
 * ProjectRail-compatible Worker list body. It deliberately does not render an
 * aside, brand header, work-type switch, resizer, or Settings entry.
 */
export function WorkerRail({
  workers = BUILT_IN_WORKERS,
  tasks = DEFAULT_WORKER_TASKS,
  connections = {},
  activeWorkerId = workers[0]?.id ?? null,
  activeTaskId = null,
  query: controlledQuery,
  onQueryChange,
  onSelectTask,
  onNewTask,
  creatingTask = false,
}) {
  const searchId = useId();
  const [internalQuery, setInternalQuery] = useState("");
  const [expandedWorkerIds, setExpandedWorkerIds] = useState([]);
  const query = controlledQuery ?? internalQuery;
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");

  useEffect(() => {
    const workerIds = new Set(workers.map((worker) => worker.id));
    setExpandedWorkerIds((current) => current.filter((id) => workerIds.has(id)));
  }, [workers]);

  const visibleWorkers = useMemo(() => workers.flatMap((worker) => {
    const workerTasks = tasks.filter((task) => task.workerId === worker.id);
    if (!normalizedQuery) return [{ worker, tasks: workerTasks }];
    const workerMatches = `${worker.name} ${worker.description}`
      .toLocaleLowerCase("zh-CN")
      .includes(normalizedQuery);
    const matchingTasks = workerTasks.filter((task) => (
      `${task.title} ${task.subtitle ?? ""}`
        .toLocaleLowerCase("zh-CN")
        .includes(normalizedQuery)
    ));
    return workerMatches || matchingTasks.length > 0
      ? [{ worker, tasks: workerMatches ? workerTasks : matchingTasks }]
      : [];
  }), [normalizedQuery, tasks, workers]);

  const setQuery = (value) => {
    if (controlledQuery === undefined) setInternalQuery(value);
    onQueryChange?.(value);
  };

  const toggleWorker = (workerId) => {
    setExpandedWorkerIds((current) => (
      current.includes(workerId)
        ? current.filter((id) => id !== workerId)
        : [...current, workerId]
    ));
  };

  const createNewTask = async (workerId) => {
    if (creatingTask) return;
    const created = await onNewTask?.({ workerId });
    if (created !== false) {
      setExpandedWorkerIds((current) => (
        current.includes(workerId) ? current : [...current, workerId]
      ));
    }
  };

  return (
    <section className="worker-rail-fragment" aria-label="Worker 任务">
      <label className="search-field worker-search-field" htmlFor={searchId}>
        <MagnifyingGlass size={15} weight="regular" aria-hidden="true" />
        <input
          id={searchId}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索 Worker 和任务..."
        />
      </label>

      <div className="worker-rail-list">
        <div className="project-list-heading worker-list-heading">
          <span className="eyebrow">专业 Worker</span>
        </div>

        {visibleWorkers.map(({ worker, tasks: workerTasks }) => {
          const selected = worker.id === activeWorkerId;
          const expanded = normalizedQuery
            ? true
            : expandedWorkerIds.includes(worker.id);
          const connection = connectionFor(worker, connections);
          return (
            <section
              className={`worker-rail-group${selected ? " is-selected" : ""}`}
              key={worker.id}
              aria-label={worker.name}
            >
              <button
                className="worker-rail-group-button"
                type="button"
                aria-expanded={expanded}
                onClick={() => toggleWorker(worker.id)}
              >
                {expanded
                  ? <CaretDown size={12} weight="bold" aria-hidden="true" />
                  : <CaretRight size={12} weight="bold" aria-hidden="true" />}
                <WorkerTypeIcon
                  workerId={worker.id}
                  weight={selected ? "fill" : "regular"}
                />
                <span>
                  <strong>{worker.name}</strong>
                  <small>{worker.description}</small>
                </span>
                <i
                  className={`worker-connection-dot is-${connection.status}`}
                  title={connection.label ?? CONNECTION_LABELS[connection.status]}
                  aria-label={connection.label ?? CONNECTION_LABELS[connection.status]}
                />
              </button>

              {expanded ? (
                <div className="worker-task-list">
                  <button
                    className="worker-task-create-button"
                    type="button"
                    onClick={() => createNewTask(worker.id)}
                    disabled={creatingTask}
                    aria-busy={creatingTask}
                    aria-label={`在“${worker.name}”下新建任务`}
                    title={`在“${worker.name}”下新建任务`}
                  >
                    <Plus size={14} weight="bold" aria-hidden="true" />
                    <span>{creatingTask ? "正在创建…" : "新建任务"}</span>
                  </button>

                  {workerTasks.length > 0 ? workerTasks.map((task) => {
                    const taskSelected = task.id === activeTaskId;
                    return (
                      <button
                        className={`project-conversation-row worker-task-row${taskSelected ? " is-active" : ""}`}
                        type="button"
                        aria-current={taskSelected ? "page" : undefined}
                        key={task.id}
                        onClick={() => onSelectTask?.(task.id, worker.id)}
                      >
                        <Briefcase
                          size={15}
                          weight={taskSelected ? "fill" : "regular"}
                          aria-hidden="true"
                        />
                        <span>
                          <strong>{task.title}</strong>
                          <small>{task.subtitle || task.updatedLabel || "等待开始"}</small>
                        </span>
                        {task.unreadCount > 0 ? (
                          <b
                            className="project-conversation-unread-badge"
                            aria-label={`${task.unreadCount} 条未读消息`}
                          >
                            {task.unreadCount > 99 ? "99+" : task.unreadCount}
                          </b>
                        ) : null}
                      </button>
                    );
                  }) : (
                    <p className="worker-task-empty">还没有任务</p>
                  )}
                </div>
              ) : null}
            </section>
          );
        })}

        {visibleWorkers.length === 0 ? (
          <div className="worker-rail-empty">
            <MagnifyingGlass size={18} weight="regular" aria-hidden="true" />
            <strong>没有匹配的 Worker 或任务</strong>
            <button type="button" onClick={() => setQuery("")}>清除搜索</button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function ArtifactLink({ artifactId, children, onOpenArtifact }) {
  return (
    <button
      className="project-agent-link"
      type="button"
      onClick={() => onOpenArtifact(artifactId)}
    >
      {children}
      <CaretRight size={13} weight="bold" aria-hidden="true" />
    </button>
  );
}

function WorkerAskUserCard({ request, busy, onAnswer, onCancel }) {
  const [answers, setAnswers] = useState({});
  const questions = request?.questions ?? [];
  const complete = questions.every((question) => (
    question.required === false
    || (Array.isArray(answers[question.id])
      ? answers[question.id].length > 0
      : String(answers[question.id] ?? "").trim())
  ));

  const submit = (event) => {
    event.preventDefault();
    if (!complete || busy) return;
    onAnswer?.(request, questions.map((question) => ({
      questionId: question.id,
      value: answers[question.id] ?? "",
    })));
  };

  return (
    <form className="worker-ask-user-card" onSubmit={submit}>
      <div>
        <strong>Worker 需要你补充信息</strong>
        <small>回答后才会继续当前任务。</small>
      </div>
      {questions.map((question) => (
        <fieldset key={question.id}>
          <legend>{question.prompt || question.label}</legend>
          {question.kind === "single_choice" ? (
            <select
              value={answers[question.id] ?? ""}
              onChange={(event) => setAnswers((current) => ({
                ...current,
                [question.id]: event.target.value,
              }))}
              required={question.required !== false}
            >
              <option value="">请选择</option>
              {(question.options ?? []).map((option) => (
                <option value={option.id} key={option.id}>{option.label}</option>
              ))}
            </select>
          ) : question.kind === "multiple_choice" ? (
            <div className="worker-ask-options">
              {(question.options ?? []).map((option) => {
                const selected = Array.isArray(answers[question.id])
                  && answers[question.id].includes(option.id);
                return (
                  <label key={option.id}>
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => setAnswers((current) => {
                        const values = Array.isArray(current[question.id])
                          ? current[question.id]
                          : [];
                        return {
                          ...current,
                          [question.id]: selected
                            ? values.filter((value) => value !== option.id)
                            : [...values, option.id],
                        };
                      })}
                    />
                    {option.label}
                  </label>
                );
              })}
            </div>
          ) : (
            <input
              value={answers[question.id] ?? ""}
              onChange={(event) => setAnswers((current) => ({
                ...current,
                [question.id]: event.target.value,
              }))}
              required={question.required !== false}
            />
          )}
        </fieldset>
      ))}
      <footer>
        <button type="button" disabled={busy} onClick={() => onCancel?.(request)}>取消追问</button>
        <button type="submit" disabled={busy || !complete}>提交回答</button>
      </footer>
    </form>
  );
}

function WorkerAssistantMarkdown({ children }) {
  return (
    <div className="project-agent-markdown worker-agent-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>
        {children}
      </ReactMarkdown>
    </div>
  );
}

function WorkerPlanProgress({ conversation, messages = [], running }) {
  const steps = conversation?.plan?.steps ?? conversation?.plan?.items ?? [];
  const safeEvents = (conversation?.events ?? []).filter((event) => [
    "message.started",
    "message.completed",
    "agent.status",
    "agent.progress",
    "compaction.started",
    "compaction.completed",
  ].includes(event?.type)).slice(-3);
  const latestMessage = messages.at(-1);
  const settledWithFinal = !running
    && latestMessage?.role === "assistant"
    && String(latestMessage.content ?? "").trim().length > 0;
  const [expanded, setExpanded] = useState(() => !settledWithFinal);

  useEffect(() => {
    if (running || !settledWithFinal) {
      setExpanded(true);
      return;
    }
    setExpanded(false);
  }, [running, settledWithFinal]);

  if (steps.length === 0 && safeEvents.length === 0) return null;
  return (
    <section className={`worker-plan-progress${expanded ? " is-expanded" : ""}`} aria-label="Worker 计划与进度">
      <button
        className="worker-plan-progress-toggle"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        {running ? (
          <SpinnerGap className="spin" size={15} weight="bold" aria-hidden="true" />
        ) : settledWithFinal ? (
          <CheckCircle size={15} weight="fill" aria-hidden="true" />
        ) : (
          <WarningCircle size={15} weight="fill" aria-hidden="true" />
        )}
        <span>
          <strong>{running ? "Worker 正在工作" : settledWithFinal ? "工作过程已完成" : "工作过程需要处理"}</strong>
          <small>{steps.length > 0 ? `${steps.length} 个步骤` : `${safeEvents.length} 项过程`}</small>
        </span>
        <CaretDown size={13} aria-hidden="true" />
      </button>
      <div className="worker-plan-progress-body" hidden={!expanded}>
        {steps.length > 0 ? (
          <div>
            <strong>当前计划</strong>
            <ol>
              {steps.map((step, index) => (
                <li className={`is-${step.status || "pending"}`} key={step.id || index}>
                  <span aria-hidden="true" />
                  <p>{step.title || step.step || step.detail || `步骤 ${index + 1}`}</p>
                </li>
              ))}
            </ol>
          </div>
        ) : null}
        {safeEvents.length > 0 ? (
          <div>
            <strong>{running ? "最新进度" : "过程记录"}</strong>
            <ul>
              {safeEvents.map((event, index) => (
                <li key={event.seq || `${event.type}-${index}`}>
                  {event.data?.detail
                    || event.data?.message
                    || event.data?.status
                    || ({
                      "message.started": "Agent 开始处理",
                      "message.completed": "Agent 已形成回答",
                      "agent.status": "Agent 状态已更新",
                      "agent.progress": "正在推进当前任务",
                      "compaction.started": "正在压缩上下文",
                      "compaction.completed": "上下文压缩完成",
                    }[event.type] ?? "Worker 状态已更新")}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function WorkerAgentPane({
  state,
  dispatch,
  projectOptions,
  onProjectContextChange,
  onDraftChange,
  onSendMessage,
  onUploadAttachment,
  onRemovePendingAttachment,
  onAbort,
  onRetryLastTurn,
  onCompact,
  onAnswerAskUser,
  onCancelAskUser,
  running = false,
  busyAction = null,
  error = null,
  onOpenArtifact,
}) {
  const attachmentInputRef = useRef(null);
  const composerFormRef = useRef(null);
  const submitMessage = (event) => {
    event.preventDefault();
    const content = state.composerDraft.trim();
    if (!content) return;
    dispatch({ type: WORKER_ACTIONS.SEND_MESSAGE, content });
    onSendMessage?.({
      taskId: state.task.id,
      workerId: state.worker.id,
      content,
      projectContextId: state.projectContext?.id ?? null,
    });
  };

  const selectProjectContext = (projectId) => {
    const context = projectOptions.find((project) => project.id === projectId) ?? null;
    dispatch({ type: WORKER_ACTIONS.SET_PROJECT_CONTEXT, context });
    onProjectContextChange?.({
      taskId: state.task.id,
      projectContext: context,
      access: "read_only",
    });
  };

  const proposal = state.deliveryProposal;
  const receipt = state.receipt;
  const pendingAskUserRequest = (state.conversation?.askUserRequests ?? [])
    .find((request) => request.status === "pending");
  const retryable = state.lastError?.retryable === true
    || ["error", "interrupted", "aborted", "stopped"].includes(state.conversation?.status);
  const actionBusy = Boolean(busyAction);

  const selectAttachments = (event) => {
    const files = [...(event.target.files ?? [])].slice(0, 5);
    files.forEach((file) => onUploadAttachment?.(file));
    event.target.value = "";
  };

  return (
    <div className="project-agent worker-agent">
      <header className="project-agent-header worker-agent-header">
        <div>
          <span>WORKER AGENT</span>
          <strong>{state.worker.description}</strong>
        </div>
        <div className="worker-agent-header-controls">
          <label className="worker-project-context-control">
            <span>项目背景</span>
            <select
              value={state.projectContext?.id ?? ""}
              onChange={(event) => selectProjectContext(event.target.value)}
              aria-label="选择只读项目背景"
            >
              <option value="">不关联项目</option>
              {projectOptions.map((project) => (
                <option value={project.id} key={project.id}>{project.label}</option>
              ))}
            </select>
          </label>
          <span className={`project-agent-status is-${state.status}`}>
            <span aria-hidden="true" />
            {STATUS_LABELS[state.status] ?? "等待任务"}
          </span>
        </div>
      </header>

      <div className="project-agent-stream">
        {error ? (
          <div className="worker-proposal-warning" role="alert">
            <WarningCircle size={17} weight="fill" aria-hidden="true" />
            <div>
              <strong>Worker 操作未完成</strong>
              <p>{error.message || "请刷新任务后重试。"}</p>
            </div>
          </div>
        ) : null}
        <WorkerPlanProgress
          conversation={state.conversation}
          messages={state.messages}
          running={running}
        />
        {state.messages.length === 0 ? (
          <section className="project-agent-welcome worker-agent-welcome">
            <WorkerTypeIcon workerId={state.worker.id} size={24} />
            <div>
              <h2>从一项明确的文字工作开始</h2>
              <p>Agent 可以读取本任务资料并整理草稿；任何外部修改或发送都会先给出精确预览。</p>
            </div>
            <div className="project-agent-scope">
              <span>项目背景只读</span>
              <span>草稿可直接编辑</span>
              <span>外部交付需确认</span>
            </div>
          </section>
        ) : state.messages.map((message) => (
          <article
            className={`project-agent-message is-${message.role}`}
            key={message.id}
          >
            <small>{message.role === "user" ? "你" : "Pi Agent"}</small>
            {message.role === "assistant"
              ? <WorkerAssistantMarkdown>{message.content}</WorkerAssistantMarkdown>
              : <div className="project-agent-plain-text">{message.content}</div>}
            {message.role === "assistant" && message.content.trim() ? (
              <button
                className="worker-message-to-draft"
                type="button"
                onClick={() => {
                  if (!state.draftDirty && message.content !== state.draftBuffer) {
                    onDraftChange?.({
                      taskId: state.task.id,
                      draftRevisionId: state.draftRevision.id,
                    });
                  }
                  dispatch({ type: WORKER_ACTIONS.SET_DRAFT_BUFFER, value: message.content });
                  onOpenArtifact(WORKER_ARTIFACTS.DRAFT);
                }}
              >
                <FileText size={13} aria-hidden="true" />
                作为草稿编辑
              </button>
            ) : null}
          </article>
        ))}

        {proposal?.status === DELIVERY_STATUS.PREPARED ? (
          <section className="project-agent-decision worker-agent-decision">
            <ShieldCheck size={18} weight="regular" aria-hidden="true" />
            <div>
              <strong>交付预览已经准备好</strong>
              <p>目标、正文、草稿版本和内容哈希会在同一个工件中确认。</p>
            </div>
            <ArtifactLink artifactId={WORKER_ARTIFACTS.DELIVERY} onOpenArtifact={onOpenArtifact}>
              核对交付
            </ArtifactLink>
          </section>
        ) : null}

        {proposal?.status === DELIVERY_STATUS.STALE ? (
          <section className="project-agent-decision worker-agent-decision is-warning">
            <WarningCircle size={18} weight="fill" aria-hidden="true" />
            <div>
              <strong>草稿已更新，旧交付预览不能再确认</strong>
              <p>保存当前草稿后，需要按新版本重新准备目标和精确内容。</p>
            </div>
            <ArtifactLink artifactId={WORKER_ARTIFACTS.DRAFT} onOpenArtifact={onOpenArtifact}>
              查看草稿
            </ArtifactLink>
          </section>
        ) : null}

        {receipt ? (
          <section className={`project-agent-complete worker-agent-complete is-${receipt.status}`}>
            {receipt.status === "unknown"
              ? <WarningCircle size={20} weight="fill" aria-hidden="true" />
              : <CheckCircle size={20} weight="fill" aria-hidden="true" />}
            <div>
              <strong>{receipt.status === "unknown" ? "交付结果需要人工核对" : receipt.summary}</strong>
              <p>{receipt.detail}</p>
            </div>
            <ArtifactLink artifactId={WORKER_ARTIFACTS.RECEIPT} onOpenArtifact={onOpenArtifact}>
              查看回执
            </ArtifactLink>
          </section>
        ) : null}

        {pendingAskUserRequest ? (
          <WorkerAskUserCard
            key={pendingAskUserRequest.id}
            request={pendingAskUserRequest}
            busy={actionBusy}
            onAnswer={onAnswerAskUser}
            onCancel={onCancelAskUser}
          />
        ) : null}
      </div>

      <form ref={composerFormRef} className="project-agent-composer worker-agent-composer" onSubmit={submitMessage}>
        {state.projectContext ? (
          <div className="worker-project-context-chip" aria-label="本条消息的项目背景">
            <FolderOpen size={13} weight="regular" aria-hidden="true" />
            <span>{state.projectContext.label} · 只读</span>
            <button
              type="button"
              aria-label={`移除项目背景：${state.projectContext.label}`}
              onClick={() => selectProjectContext("")}
            >
              <X size={12} weight="bold" aria-hidden="true" />
            </button>
          </div>
        ) : null}
        {state.pendingAttachments?.length ? (
          <div className="worker-pending-attachments" aria-label="下一条消息的资料附件">
            {state.pendingAttachments.map((attachment) => (
              <span key={attachment.id}>
                <Paperclip size={12} aria-hidden="true" />
                {attachment.fileName || attachment.name || "任务资料"}
                <button
                  type="button"
                  aria-label={`移除附件：${attachment.fileName || attachment.name || "任务资料"}`}
                  onClick={() => onRemovePendingAttachment?.(attachment.id)}
                >
                  <X size={11} weight="bold" aria-hidden="true" />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <label>
          <span className="sr-only">给 Worker Agent 的消息</span>
          <textarea
            autoFocus={state.messages.length === 0}
            value={state.composerDraft}
            onChange={(event) => dispatch({
              type: WORKER_ACTIONS.SET_COMPOSER_DRAFT,
              value: event.target.value,
            })}
            onKeyDown={(event) => {
              if (shouldSubmitWorkerComposerKeyDown(event)) {
                event.preventDefault();
                composerFormRef.current?.requestSubmit();
              }
            }}
            placeholder="补充要求，或让 Agent 根据资料调整草稿"
          />
        </label>
        <footer>
          <div>
            <span className="project-composer-model">{state.modelId || "跟随 Worker 默认模型"}</span>
            <small>打开、切换和编辑草稿不会调用模型</small>
          </div>
          <div className="worker-composer-actions">
            <input
              ref={attachmentInputRef}
              className="sr-only"
              type="file"
              accept=".txt,.md,.json,.jsonl,.csv,.tsv,.xml,.html,.yaml,.yml,.log,.js,.jsx,.ts,.tsx,.py,.sql"
              multiple
              onChange={selectAttachments}
            />
            <button
              type="button"
              aria-label="添加资料附件"
              title="添加资料附件"
              disabled={actionBusy || (state.pendingAttachments?.length ?? 0) >= 5}
              onClick={() => attachmentInputRef.current?.click()}
            >
              {busyAction === "upload_attachment"
                ? <SpinnerGap className="spin" size={15} aria-hidden="true" />
                : <UploadSimple size={15} aria-hidden="true" />}
            </button>
            <button
              type="button"
              aria-label="压缩上下文"
              title="立即压缩当前 Worker 会话上下文"
              disabled={actionBusy || running}
              onClick={onCompact}
            >
              <ArrowsInSimple size={15} aria-hidden="true" />
            </button>
            {running ? (
              <button type="button" aria-label="停止 Worker" title="停止当前 Worker" onClick={onAbort}>
                <StopCircle size={16} weight="fill" aria-hidden="true" />
              </button>
            ) : retryable ? (
              <button
                type="button"
                aria-label="重试上一轮"
                title="重试上一轮"
                disabled={actionBusy}
                onClick={onRetryLastTurn}
              >
                <ArrowClockwise size={15} aria-hidden="true" />
              </button>
            ) : null}
            <button
              type="submit"
              disabled={!state.composerDraft.trim() || actionBusy || running || Boolean(pendingAskUserRequest)}
              aria-label="发送消息"
            >
              {busyAction === "message"
                ? <SpinnerGap className="spin" size={16} aria-hidden="true" />
                : <PaperPlaneTilt size={16} weight="fill" aria-hidden="true" />}
            </button>
          </div>
        </footer>
      </form>
    </div>
  );
}

function WorkerReadSourceForm({ workerId, busy, onReadSource }) {
  const operations = (WORKER_ACTION_CATALOG[workerId] ?? [])
    .filter((action) => action.mode === "read");
  const [operation, setOperation] = useState(operations[0]?.id ?? "");
  const [values, setValues] = useState({
    detail: "simple",
    pageSize: "20",
    limit: "20",
    start: "0",
    end: "20",
    searchType: "0",
    sortType: "0",
  });
  const setValue = (key, value) => setValues((current) => ({ ...current, [key]: value }));

  useEffect(() => {
    setOperation(operations[0]?.id ?? "");
    setValues({
      detail: "simple",
      pageSize: "20",
      limit: "20",
      start: "0",
      end: "20",
      searchType: "0",
      sortType: "0",
    });
  }, [workerId]);

  const submit = (event) => {
    event.preventDefault();
    if (!operation || busy) return;
    onReadSource?.({ operation, values });
  };

  const lark = workerId === WORKER_IDS.LARK_DOCUMENT;
  const mail = workerId === WORKER_IDS.AGENT_MAIL;
  const ima = workerId === WORKER_IDS.IMA_NOTE;
  const mailList = mail && operation === "list";
  const mailSearch = mail && operation === "search";
  const mailRead = mail && operation === "read";
  const attachmentDownload = mail && operation === "attachment_download";

  return (
    <form className="worker-source-import" onSubmit={submit}>
      <div className="worker-source-import-heading">
        <div>
          <strong>读取并加入任务资料</strong>
          <small>只在点击读取后调用对应连接；结果会作为不受信任的只读资料保存。</small>
        </div>
        <select value={operation} onChange={(event) => setOperation(event.target.value)}>
          {operations.map((action) => (
            <option value={action.id} key={action.id}>{action.label}</option>
          ))}
        </select>
      </div>

      {ima ? (
        <div className="worker-source-form-grid">
          {operation === "list_notebook" ? (
            <>
              <label>
                <span>游标（首页为 0）</span>
                <input value={values.cursor ?? ""} onChange={(event) => setValue("cursor", event.target.value)} placeholder="0" />
              </label>
              <label>
                <span>数量</span>
                <input type="number" min="1" max="20" value={values.limit} onChange={(event) => setValue("limit", event.target.value)} />
              </label>
            </>
          ) : operation === "list_note" ? (
            <>
              <label className="is-wide">
                <span>笔记本标识（可选）</span>
                <input value={values.folderId ?? ""} onChange={(event) => setValue("folderId", event.target.value)} />
              </label>
              <label>
                <span>游标（首页留空）</span>
                <input value={values.cursor ?? ""} onChange={(event) => setValue("cursor", event.target.value)} />
              </label>
              <label>
                <span>排序</span>
                <select value={values.sortType} onChange={(event) => setValue("sortType", event.target.value)}>
                  <option value="0">更新时间</option>
                  <option value="1">创建时间</option>
                  <option value="2">标题</option>
                </select>
              </label>
              <label>
                <span>数量</span>
                <input type="number" min="1" max="20" value={values.limit} onChange={(event) => setValue("limit", event.target.value)} />
              </label>
            </>
          ) : operation === "search_note" ? (
            <>
              <label className="is-wide">
                <span>搜索词</span>
                <input value={values.query ?? ""} onChange={(event) => setValue("query", event.target.value)} required />
              </label>
              <label>
                <span>搜索范围</span>
                <select value={values.searchType} onChange={(event) => setValue("searchType", event.target.value)}>
                  <option value="0">标题</option>
                  <option value="1">正文</option>
                </select>
              </label>
              <label>
                <span>起始位置</span>
                <input type="number" min="0" value={values.start} onChange={(event) => setValue("start", event.target.value)} />
              </label>
              <label>
                <span>结束位置</span>
                <input type="number" min="1" value={values.end} onChange={(event) => setValue("end", event.target.value)} />
              </label>
            </>
          ) : operation === "get_doc_content" ? (
            <label className="is-wide">
              <span>笔记标识</span>
              <input value={values.noteId ?? ""} onChange={(event) => setValue("noteId", event.target.value)} required />
            </label>
          ) : null}
        </div>
      ) : lark ? (
        <div className="worker-source-form-grid">
          {operation === "search" ? (
            <>
              <label className="is-wide">
                <span>文档查询关键词</span>
                <input value={values.query ?? ""} onChange={(event) => setValue("query", event.target.value)} required />
              </label>
              <label>
                <span>每页数量</span>
                <input type="number" min="1" max="20" value={values.pageSize} onChange={(event) => setValue("pageSize", event.target.value)} />
              </label>
              <label>
                <span>分页 token（可选）</span>
                <input value={values.pageToken ?? ""} onChange={(event) => setValue("pageToken", event.target.value)} />
              </label>
            </>
          ) : (
            <label className="is-wide">
              <span>飞书文档地址或 token</span>
              <input
                value={values.document ?? ""}
                onChange={(event) => setValue("document", event.target.value)}
                required
              />
            </label>
          )}
          {operation === "fetch" ? (
            <>
              <label>
                <span>读取范围</span>
                <select value={values.detail} onChange={(event) => setValue("detail", event.target.value)}>
                  <option value="simple">简洁结构</option>
                  <option value="full">完整内容</option>
                  <option value="with-ids">带块 ID（只读检查）</option>
                </select>
                <small>所有文档交付必须重新读取“完整内容”；带块 ID 结果不能用于交付确认。</small>
              </label>
              <label>
                <span>指定历史 revision（可选）</span>
                <input value={values.revisionId ?? ""} onChange={(event) => setValue("revisionId", event.target.value)} />
              </label>
            </>
          ) : operation === "history_list" ? (
            <>
              <label>
                <span>每页数量</span>
                <input type="number" min="1" max="20" value={values.pageSize} onChange={(event) => setValue("pageSize", event.target.value)} />
              </label>
              <label>
                <span>分页 token（可选）</span>
                <input value={values.pageToken ?? ""} onChange={(event) => setValue("pageToken", event.target.value)} />
              </label>
            </>
          ) : null}
        </div>
      ) : mail ? (
        <div className="worker-source-form-grid">
          {mailSearch ? (
            <label className="is-wide">
              <span>搜索词</span>
              <input value={values.q ?? ""} onChange={(event) => setValue("q", event.target.value)} required />
            </label>
          ) : null}
          {(mailRead || attachmentDownload) ? (
            <label className="is-wide">
              <span>邮件标识</span>
              <input placeholder="msg_..." value={values.messageId ?? ""} onChange={(event) => setValue("messageId", event.target.value)} required />
            </label>
          ) : null}
          {attachmentDownload ? (
            <>
              <label>
                <span>附件标识</span>
                <input placeholder="att_..." value={values.attachmentId ?? ""} onChange={(event) => setValue("attachmentId", event.target.value)} required />
              </label>
            </>
          ) : null}
          {(mailList || mailSearch) ? (
            <>
              <label>
                <span>邮箱目录（可选）</span>
                <input value={values.dir ?? ""} onChange={(event) => setValue("dir", event.target.value)} />
              </label>
              <label>
                <span>数量</span>
                <input type="number" min="1" max="50" value={values.limit} onChange={(event) => setValue("limit", event.target.value)} />
              </label>
              <label>
                <span>起始日期（可选）</span>
                <input value={values.after ?? ""} onChange={(event) => setValue("after", event.target.value)} placeholder="YYYY-MM-DD" />
              </label>
              <label>
                <span>截止日期（可选）</span>
                <input value={values.before ?? ""} onChange={(event) => setValue("before", event.target.value)} placeholder="YYYY-MM-DD" />
              </label>
              <label className="worker-source-checkbox">
                <input type="checkbox" checked={Boolean(values.hasAttachments)} onChange={(event) => setValue("hasAttachments", event.target.checked)} />
                <span>仅含附件</span>
              </label>
              <label className="worker-source-checkbox">
                <input type="checkbox" checked={Boolean(values.isUnread)} onChange={(event) => setValue("isUnread", event.target.checked)} />
                <span>仅未读</span>
              </label>
            </>
          ) : null}
        </div>
      ) : (
        <p className="worker-proposal-warning">当前 Worker 没有可用的读取表单。</p>
      )}

      {lark ? (
        <p className="worker-source-contract-note">
          飞书交付只能绑定“完整内容”读取结果；“带块 ID”仅用于只读检查。
        </p>
      ) : null}
      {ima ? (
        <p className="worker-source-contract-note">
          IMA 读取只会把选定笔记资料加入当前任务；打开或切换操作不会自动调用连接。
        </p>
      ) : null}

      <button className="worker-secondary-button" type="submit" disabled={busy || !operation}>
        {busy ? <SpinnerGap className="spin" size={14} aria-hidden="true" /> : <FolderOpen size={14} aria-hidden="true" />}
        {busy ? "正在读取…" : "读取并加入资料"}
      </button>
    </form>
  );
}

function SourcesArtifact({ state, onReadSource, readBusy, onUseSource }) {
  const capabilities = WORKER_ACTION_CATALOG[state.worker.id] ?? [];
  const readActions = capabilities.filter((action) => action.mode === "read");
  const writeActions = capabilities.filter((action) => action.mode === "write");
  return (
    <div className="worker-artifact worker-sources-artifact">
      <header className="worker-artifact-header">
        <div>
          <span>任务资料</span>
          <h2>本次工作可读取的内容</h2>
        </div>
        <span className="worker-readonly-badge">只读</span>
      </header>

      <section className="worker-source-section" aria-label="已加入资料">
        <h3>已加入资料</h3>
        <div className="worker-source-list">
          {state.sources.length > 0 ? state.sources.map((source) => (
            <article key={source.id}>
              {source.kind === "attachment"
                ? <Paperclip size={16} weight="regular" aria-hidden="true" />
                : <FileText size={16} weight="regular" aria-hidden="true" />}
              <div>
                <strong>{source.label}</strong>
                <small>{source.detail}</small>
                {source.contentPreview ? (
                  <details className="worker-source-preview">
                    <summary>查看已清洗预览</summary>
                    <pre>{source.contentPreview}</pre>
                  </details>
                ) : null}
              </div>
              {source.attachment ? (
                <button type="button" onClick={() => onUseSource?.(source)}>加入下一条消息</button>
              ) : null}
            </article>
          )) : (
            <p className="worker-artifact-empty-copy">还没有加入邮件、文档、IMA 笔记或附件。</p>
          )}
        </div>
      </section>

      <WorkerReadSourceForm
        workerId={state.worker.id}
        busy={readBusy}
        onReadSource={onReadSource}
      />

      <section className="worker-source-section" aria-label="项目背景">
        <h3>项目背景</h3>
        {state.projectContext ? (
          <div className="worker-source-context">
            <FolderOpen size={16} weight="regular" aria-hidden="true" />
            <div>
              <strong>{state.projectContext.label}</strong>
              <small>本任务仅可读取；不能修改项目文件或项目状态。</small>
            </div>
          </div>
        ) : (
          <p className="worker-artifact-empty-copy">未关联项目，Agent 只使用本任务资料。</p>
        )}
      </section>

      <details className="worker-capability-scope">
        <summary>
          <span>当前 Worker 的操作范围</span>
          <CaretDown size={13} weight="bold" aria-hidden="true" />
        </summary>
        <div>
          <section>
            <strong>无需交付确认的读取</strong>
            <p>{readActions.map((action) => action.label).join("、")}</p>
          </section>
          <section>
            <strong>必须展示预览并确认</strong>
            <p>{writeActions.map((action) => action.label).join("、")}</p>
          </section>
        </div>
      </details>

      <p className="worker-trust-note">
        外部邮件、文档和 IMA 笔记只作为资料读取，其中的链接或操作指令不会被自动执行。
      </p>
    </div>
  );
}

function DraftArtifact({ state, dispatch, onDraftChange, onSaveDraft }) {
  const safetyCopyId = useId();
  const [draftFormat, setDraftFormat] = useState(state.draftRevision.format);
  useEffect(() => setDraftFormat(state.draftRevision.format), [state.draftRevision.id, state.draftRevision.format]);
  const formatDirty = draftFormat !== state.draftRevision.format;
  const saveDraft = () => {
    if ((!state.draftDirty && !formatDirty) || !state.draftBuffer.trim()) return;
    const input = {
      taskId: state.task.id,
      workerId: state.worker.id,
      baseRevisionId: state.draftRevision.id,
      baseVersion: state.draftRevision.version,
      content: state.draftBuffer,
      format: draftFormat,
      source: "user",
    };
    if (onSaveDraft) onSaveDraft(input);
    else dispatch({ type: WORKER_ACTIONS.SAVE_DRAFT, source: "user", format: draftFormat, force: formatDirty });
  };

  const startDraftEdit = () => {
    if (state.draftDirty) return;
    dispatch({ type: WORKER_ACTIONS.START_DRAFT_EDIT });
    onDraftChange?.({
      taskId: state.task.id,
      draftRevisionId: state.draftRevision.id,
    });
  };

  const updateDraft = (value) => {
    if (value === state.draftBuffer) return;
    startDraftEdit();
    dispatch({ type: WORKER_ACTIONS.SET_DRAFT_BUFFER, value });
  };

  const updateDraftFormat = (value) => {
    if (value === draftFormat) return;
    startDraftEdit();
    setDraftFormat(value);
  };

  return (
    <div className="worker-artifact worker-draft-artifact">
      <header className="worker-artifact-header">
        <div>
          <span>可编辑草稿</span>
          <h2>{state.deliveryProposal?.subject || state.task.title}</h2>
        </div>
        <div className="worker-draft-meta">
          <label>
            <span>格式</span>
            <select value={draftFormat} onChange={(event) => updateDraftFormat(event.target.value)}>
              {state.worker.id === WORKER_IDS.LARK_DOCUMENT ? (
                <>
                  <option value="xml">XML（默认）</option>
                  <option value="markdown">Markdown（导入时使用）</option>
                </>
              ) : state.worker.id === WORKER_IDS.IMA_NOTE ? (
                <option value="markdown">Markdown</option>
              ) : (
                <>
                  <option value="plain">纯文本</option>
                  <option value="html">HTML</option>
                </>
              )}
            </select>
          </label>
          <span className={`worker-draft-state${state.draftDirty || formatDirty ? " is-dirty" : ""}`}>
            {state.draftDirty || formatDirty ? "有未保存修改" : `版本 ${state.draftRevision.version}`}
          </span>
        </div>
      </header>

      <label className="worker-draft-editor">
        <span className="sr-only">直接编辑任务草稿</span>
        <textarea
          value={state.draftBuffer}
          onChange={(event) => updateDraft(event.target.value)}
          aria-describedby={safetyCopyId}
        />
      </label>

      <footer className="worker-draft-footer">
        <div id={safetyCopyId}>
          <strong>{state.draftRevision.contentHash || "内容哈希将在服务端保存后生成"}</strong>
          <small>直接编辑只形成新草稿版本，不会调用模型或执行外部操作。</small>
          {state.draftDirty && state.deliveryProposal ? (
            <small className="is-warning">草稿已经变化，原交付确认立即失效。</small>
          ) : null}
        </div>
        <button
          className="worker-primary-button"
          type="button"
          disabled={(!state.draftDirty && !formatDirty) || !state.draftBuffer.trim()}
          onClick={saveDraft}
        >
          <FloppyDisk size={14} weight="regular" aria-hidden="true" />
          保存新版本
        </button>
      </footer>
    </div>
  );
}

const LARK_FULL_SOURCE_OPERATIONS = new Set([
  "overwrite",
  "block_insert_after",
  "block_replace",
  "block_delete",
  "block_move_after",
  "history_revert",
]);

function deliverySourceLabel(source) {
  const revision = source?.binding?.revisionId;
  const historyRevision = source?.binding?.requestedRevisionId;
  const suffix = Number.isSafeInteger(historyRevision)
    ? `历史 revision ${historyRevision}`
    : Number.isSafeInteger(revision)
      ? `当前 revision ${revision}`
      : source?.operation || "已读取";
  return `${source?.label || "外部资料"} · ${suffix}`;
}

function deliveryFileSize(byteLength) {
  if (!Number.isFinite(byteLength)) return "大小未知";
  if (byteLength < 1024) return `${byteLength} B`;
  if (byteLength < 1024 * 1024) return `${Math.ceil(byteLength / 1024)} KB`;
  return `${(byteLength / 1024 / 1024).toFixed(1)} MB`;
}

function DeliveryProposalForm({
  workerId,
  busyAction,
  hasDraft,
  sources = [],
  files = [],
  onUploadDeliveryAttachment,
  onRemoveDeliveryAttachment,
  onProposeDelivery,
}) {
  const operations = (WORKER_ACTION_CATALOG[workerId] ?? [])
    .filter((action) => action.mode === "write");
  const [operation, setOperation] = useState(operations[0]?.id ?? "");
  const [values, setValues] = useState({ includeAttachments: false, attachments: [] });
  const attachmentInputRef = useRef(null);
  const setValue = (key, value) => setValues((current) => ({ ...current, [key]: value }));
  const busy = Boolean(busyAction);

  useEffect(() => {
    setOperation(operations[0]?.id ?? "");
    setValues({ includeAttachments: false, attachments: [] });
  }, [workerId]);

  const mail = workerId === WORKER_IDS.AGENT_MAIL;
  const lark = workerId === WORKER_IDS.LARK_DOCUMENT;
  const mailSend = mail && operation === "send";
  const mailForward = mail && operation === "forward";
  const mailTrash = mail && operation === "trash";
  const larkCreate = lark && operation === "create";
  const needsBoundSource = mail ? !mailSend : lark ? !larkCreate : false;
  const requiresFullLarkSource = lark && LARK_FULL_SOURCE_OPERATIONS.has(operation);
  const draftRequired = mail
    ? !mailTrash
    : lark
      ? !["block_delete", "block_move_after", "history_revert"].includes(operation)
      : false;
  const mailReadSources = sources.filter((source) => (
    source.kind === "mail"
    && source.operation === "read"
    && source.exact === true
    && typeof source.binding?.messageId === "string"
  ));
  const larkCurrentSources = sources.filter((source) => (
    source.kind === "document"
    && source.operation === "fetch"
    && source.exact === true
    && source.binding?.requestedRevisionId === null
    && (!requiresFullLarkSource || source.binding?.detail === "full")
  ));
  const beforeSources = mail ? mailReadSources : lark ? larkCurrentSources : [];
  const selectedBeforeSourceId = beforeSources.some((source) => source.id === values.beforeSourceId)
    ? values.beforeSourceId
    : beforeSources[0]?.id ?? "";
  const selectedBeforeSource = beforeSources.find((source) => source.id === selectedBeforeSourceId) ?? null;
  const selectedDocument = selectedBeforeSource?.binding?.requestedDocument ?? null;
  const historySources = lark && operation === "history_revert"
    ? sources.filter((source) => (
        source.kind === "document"
        && source.operation === "history_list"
        && source.binding?.requestedDocument === selectedDocument
      ))
    : [];
  const selectedHistorySourceId = historySources.some((source) => source.id === values.historySourceId)
    ? values.historySourceId
    : historySources[0]?.id ?? "";
  const selectedHistorySource = historySources.find((source) => source.id === selectedHistorySourceId) ?? null;
  const historyVersions = selectedHistorySource?.binding?.historyVersions ?? [];
  const selectedHistoryVersionId = historyVersions.some(
    (entry) => entry.historyVersionId === values.historyVersionId,
  )
    ? values.historyVersionId
    : historyVersions[0]?.historyVersionId ?? "";
  const selectedHistoryVersion = historyVersions.find(
    (entry) => entry.historyVersionId === selectedHistoryVersionId,
  ) ?? null;
  const afterSources = lark && operation === "history_revert"
    ? sources.filter((source) => (
        source.kind === "document"
        && source.operation === "fetch"
        && source.exact === true
        && source.binding?.detail === "full"
        && source.binding?.requestedDocument === selectedDocument
        && source.binding?.requestedRevisionId === selectedHistoryVersion?.revisionId
      ))
    : [];
  const selectedAfterSourceId = afterSources.some((source) => source.id === values.afterSourceId)
    ? values.afterSourceId
    : afterSources[0]?.id ?? "";
  const readyFiles = files.filter((file) => file.status === "ready");
  const selectedAttachmentIds = (values.attachments ?? []).filter((id) => (
    readyFiles.some((file) => file.id === id)
  ));
  const sourceReady = !needsBoundSource || Boolean(selectedBeforeSourceId);
  const historyReady = operation !== "history_revert" || Boolean(
    selectedHistorySourceId && selectedHistoryVersionId && selectedAfterSourceId,
  );
  const canSubmit = !busy
    && (!draftRequired || hasDraft)
    && sourceReady
    && historyReady;

  const submit = (event) => {
    event.preventDefault();
    if (!operation || !canSubmit) return;
    onProposeDelivery?.({
      operation,
      values: {
        ...values,
        attachments: selectedAttachmentIds,
        beforeSourceId: selectedBeforeSourceId || undefined,
        historySourceId: selectedHistorySourceId || undefined,
        historyVersionId: selectedHistoryVersionId || values.historyVersionId,
        afterSourceId: selectedAfterSourceId || undefined,
      },
    });
  };

  const uploadFiles = async (event) => {
    const room = Math.max(0, 3 - files.length);
    const nextFiles = [...(event.target.files ?? [])].slice(0, room);
    event.target.value = "";
    for (const file of nextFiles) {
      await onUploadDeliveryAttachment?.(file);
    }
  };

  return (
    <form className="worker-delivery-form" onSubmit={submit}>
      <header>
        <div>
          <strong>准备交付预览</strong>
          <small>这里仅生成精确提案；不会直接发送邮件或修改飞书。</small>
        </div>
        <select value={operation} onChange={(event) => setOperation(event.target.value)}>
          {operations.map((action) => (
            <option value={action.id} key={action.id}>{action.label}</option>
          ))}
        </select>
      </header>

      {draftRequired && !hasDraft ? (
        <p className="worker-proposal-warning">该操作需要先在“草稿”中保存一个版本。</p>
      ) : null}

      <div className="worker-delivery-form-grid">
        {mail ? (
          <>
            {(mailSend || mailForward) ? (
              <label className="is-wide">
                <span>收件人（逗号或换行分隔）</span>
                <textarea value={values.to ?? ""} onChange={(event) => setValue("to", event.target.value)} required />
              </label>
            ) : null}
            {mailSend ? (
              <label className="is-wide">
                <span>主题</span>
                <input value={values.subject ?? ""} onChange={(event) => setValue("subject", event.target.value)} required />
              </label>
            ) : null}
            {!mailSend ? (
              <label className="is-wide">
                <span>已读取的原邮件</span>
                <select
                  value={selectedBeforeSourceId}
                  onChange={(event) => setValue("beforeSourceId", event.target.value)}
                  required
                >
                  {mailReadSources.length === 0 ? <option value="">请先在“资料”中读取原邮件</option> : null}
                  {mailReadSources.map((source) => (
                    <option value={source.id} key={source.id}>{deliverySourceLabel(source)}</option>
                  ))}
                </select>
                <small>邮件标识与精确当前内容由持久读取来源绑定，不能手填。</small>
              </label>
            ) : null}
            {!mailTrash ? (
              <>
                <label>
                  <span>抄送（可选）</span>
                  <textarea value={values.cc ?? ""} onChange={(event) => setValue("cc", event.target.value)} />
                </label>
                <label>
                  <span>密送（可选）</span>
                  <textarea value={values.bcc ?? ""} onChange={(event) => setValue("bcc", event.target.value)} />
                </label>
                <div className="worker-delivery-files is-wide">
                  <div>
                    <span>交付附件 · {files.length}/3</span>
                    <input
                      ref={attachmentInputRef}
                      className="sr-only"
                      type="file"
                      multiple
                      onChange={uploadFiles}
                    />
                    <button
                      className="worker-secondary-button"
                      type="button"
                      disabled={busy || files.length >= 3}
                      onClick={() => attachmentInputRef.current?.click()}
                    >
                      {busyAction === "upload_delivery_attachment"
                        ? <SpinnerGap className="spin" size={13} aria-hidden="true" />
                        : <UploadSimple size={13} aria-hidden="true" />}
                      上传受控附件
                    </button>
                  </div>
                  {files.length > 0 ? (
                    <ul>
                      {files.map((file) => (
                        <li key={file.id}>
                          <label>
                            <input
                              type="checkbox"
                              disabled={file.status !== "ready" || busy}
                              checked={selectedAttachmentIds.includes(file.id)}
                              onChange={(event) => setValue(
                                "attachments",
                                event.target.checked
                                  ? [...selectedAttachmentIds, file.id].slice(0, 3)
                                  : selectedAttachmentIds.filter((id) => id !== file.id),
                              )}
                            />
                            <span>{file.name}</span>
                            <small>{file.status === "ready" ? deliveryFileSize(file.byteLength) : "上传未完成"}</small>
                          </label>
                          <button
                            type="button"
                            aria-label={`移除交付附件：${file.name}`}
                            disabled={busy}
                            onClick={() => onRemoveDeliveryAttachment?.(file.id)}
                          >
                            <X size={12} aria-hidden="true" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : <small>附件会上传到本任务的受控目录；浏览器不提交文件路径。</small>}
                </div>
              </>
            ) : null}
            {mailForward ? (
              <label className="worker-source-checkbox is-wide">
                <input type="checkbox" checked={Boolean(values.includeAttachments)} onChange={(event) => setValue("includeAttachments", event.target.checked)} />
                <span>包含原邮件附件</span>
              </label>
            ) : null}
          </>
        ) : larkCreate ? (
          <>
            <label className="is-wide">
              <span>文档标题（可选）</span>
              <input value={values.title ?? ""} onChange={(event) => setValue("title", event.target.value)} />
            </label>
            <label>
              <span>父级 token（可选）</span>
              <input value={values.parentToken ?? ""} onChange={(event) => setValue("parentToken", event.target.value)} />
            </label>
            <label>
              <span>父级位置（与 token 二选一）</span>
              <input value={values.parentPosition ?? ""} onChange={(event) => setValue("parentPosition", event.target.value)} />
            </label>
          </>
        ) : lark ? (
          <>
            <label className="is-wide">
              <span>已读取的当前飞书文档</span>
              <select
                value={selectedBeforeSourceId}
                onChange={(event) => setValue("beforeSourceId", event.target.value)}
                required
              >
                {larkCurrentSources.length === 0 ? (
                  <option value="">请先在“资料”中读取当前文档</option>
                ) : null}
                {larkCurrentSources.map((source) => (
                  <option value={source.id} key={source.id}>{deliverySourceLabel(source)}</option>
                ))}
              </select>
              <small>
                {requiresFullLarkSource
                  ? "该操作只能绑定“完整内容”读取结果；文档、基础版本与块清单由服务端派生。"
                  : "文档与基础版本由持久读取来源绑定，不能手填。"}
              </small>
            </label>
            {operation === "str_replace" ? (
              <label className="is-wide">
                <span>待精确替换内容</span>
                <textarea value={values.pattern ?? ""} onChange={(event) => setValue("pattern", event.target.value)} required />
              </label>
            ) : null}
            {["block_insert_after", "block_replace"].includes(operation) ? (
              <label>
                <span>目标块 ID</span>
                <input value={values.blockId ?? ""} onChange={(event) => setValue("blockId", event.target.value)} required />
              </label>
            ) : null}
            {operation === "block_delete" ? (
              <label className="is-wide">
                <span>待删除块 ID（逗号或换行分隔）</span>
                <textarea value={values.blockIds ?? ""} onChange={(event) => setValue("blockIds", event.target.value)} required />
              </label>
            ) : null}
            {operation === "block_move_after" ? (
              <>
                <label>
                  <span>目标锚点块 ID</span>
                  <input value={values.anchorBlockId ?? ""} onChange={(event) => setValue("anchorBlockId", event.target.value)} required />
                </label>
                <label>
                  <span>待移动块 ID</span>
                  <textarea value={values.sourceBlockIds ?? ""} onChange={(event) => setValue("sourceBlockIds", event.target.value)} required />
                </label>
              </>
            ) : null}
            {operation === "history_revert" ? (
              <>
                <label>
                  <span>已读取的历史版本列表</span>
                  <select
                    value={selectedHistorySourceId}
                    onChange={(event) => {
                      setValue("historySourceId", event.target.value);
                      setValue("historyVersionId", "");
                      setValue("afterSourceId", "");
                    }}
                    required
                  >
                    {historySources.length === 0 ? <option value="">请先查询同一文档的历史版本</option> : null}
                    {historySources.map((source) => (
                      <option value={source.id} key={source.id}>{deliverySourceLabel(source)}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>历史版本</span>
                  <select
                    value={selectedHistoryVersionId}
                    onChange={(event) => {
                      setValue("historyVersionId", event.target.value);
                      setValue("afterSourceId", "");
                    }}
                    required
                  >
                    {historyVersions.length === 0 ? <option value="">历史列表中没有可恢复版本</option> : null}
                    {historyVersions.map((entry) => (
                      <option value={entry.historyVersionId} key={`${entry.historyVersionId}:${entry.revisionId}`}>
                        {entry.historyVersionId} · revision {entry.revisionId}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="is-wide">
                  <span>已读取的目标历史内容</span>
                  <select
                    value={selectedAfterSourceId}
                    onChange={(event) => setValue("afterSourceId", event.target.value)}
                    required
                  >
                    {afterSources.length === 0 ? (
                      <option value="">请按所选 revision 读取完整历史内容</option>
                    ) : null}
                    {afterSources.map((source) => (
                      <option value={source.id} key={source.id}>{deliverySourceLabel(source)}</option>
                    ))}
                  </select>
                  <small>恢复前后完整内容与影响块数都由三份持久来源派生。</small>
                </label>
              </>
            ) : null}
          </>
        ) : (
          <p className="worker-proposal-warning">当前 Worker 尚未开放外部交付操作。</p>
        )}
      </div>

      {needsBoundSource && !sourceReady ? (
        <p className="worker-proposal-warning">先切到“资料”读取精确当前内容，才能准备这项交付。</p>
      ) : null}
      {operation === "history_revert" && !historyReady ? (
        <p className="worker-proposal-warning">版本恢复还需要同一文档的历史列表与所选 revision 完整内容。</p>
      ) : null}

      <footer>
        <small>提案会绑定持久读取来源、附件哈希、当前草稿与基础版本；任一变化都会失效。</small>
        <button className="worker-primary-button" type="submit" disabled={!canSubmit}>
          {busyAction === "propose_delivery"
            ? <SpinnerGap className="spin" size={14} aria-hidden="true" />
            : <ShieldCheck size={14} aria-hidden="true" />}
          {busyAction === "propose_delivery" ? "正在准备…" : "生成精确交付预览"}
        </button>
      </footer>
    </form>
  );
}

const EXACT_OPERATION_LABELS = Object.freeze({
  append: "追加内容",
  str_replace: "精确替换内容",
  block_insert_after: "在目标块后插入内容",
  block_replace: "替换目标内容块",
  block_delete: "删除指定内容块",
  block_move_after: "移动内容块到目标锚点后",
});

function OperationDiffValue({ label, value, code = false }) {
  if (value === null || value === undefined) return null;
  const rendered = Array.isArray(value) ? value.join("\n") : String(value);
  return (
    <div>
      <dt>{label}</dt>
      <dd>{code ? <pre>{rendered}</pre> : <code>{rendered}</code>}</dd>
    </div>
  );
}

function ExactOperationDiff({ diff }) {
  if (!diff) return null;
  return (
    <section className="worker-operation-diff" aria-label="精确操作差异">
      <strong>精确操作差异 · {EXACT_OPERATION_LABELS[diff.kind] || diff.kind}</strong>
      <dl>
        <OperationDiffValue label="内容格式" value={diff.format} />
        <OperationDiffValue label="目标块 ID" value={diff.blockId} />
        <OperationDiffValue label="目标锚点块 ID" value={diff.anchorBlockId} />
        <OperationDiffValue label="待删除块 ID" value={diff.blockIds} />
        <OperationDiffValue label="待移动块 ID" value={diff.sourceBlockIds} />
        <OperationDiffValue label="待替换内容" value={diff.pattern} code />
        <OperationDiffValue label="替换为" value={diff.replacement} code />
        <OperationDiffValue label="写入内容" value={diff.content} code />
      </dl>
    </section>
  );
}

function ProposalContent({ proposal }) {
  const beforeContent = proposal.fullBeforeContent ?? proposal.beforeContent;
  const afterContent = proposal.fullAfterContent ?? proposal.afterContent;

  if (proposal.operation === "block_delete") {
    return (
      <div className="worker-operation-preview">
        <section className="worker-proposal-body" aria-label="删除前完整正文">
          <strong>删除前完整正文</strong>
          <pre>{beforeContent ?? "无内容"}</pre>
        </section>
        <ExactOperationDiff diff={proposal.exactOperationDiff} />
        <p className="worker-operation-boundary">
          完整删除后正文由飞书生成，Pi Agent 不在本地猜测；确认仅绑定上方完整正文与待删除块 ID。
        </p>
      </div>
    );
  }

  if (proposal.operation === "trash") {
    return (
      <div className="worker-operation-preview">
        <section className="worker-proposal-body" aria-label="当前邮件完整内容">
          <strong>当前邮件完整内容</strong>
          <pre>{beforeContent ?? "无内容"}</pre>
        </section>
        <p className="worker-operation-boundary">
          操作结果：邮件将移入回收站，正文内容不会被改写，也不会永久删除。
        </p>
      </div>
    );
  }

  if (proposal.exactOperationDiff) {
    return (
      <div className="worker-operation-preview">
        {beforeContent !== null ? (
          <section className="worker-proposal-body" aria-label="操作前完整内容">
            <strong>操作前完整内容</strong>
            <pre>{beforeContent}</pre>
          </section>
        ) : null}
        <ExactOperationDiff diff={proposal.exactOperationDiff} />
      </div>
    );
  }

  if (beforeContent !== null && afterContent !== null) {
    return (
      <div className="worker-proposal-diff" aria-label="交付前后内容">
        <section>
          <strong>修改前</strong>
          <pre>{beforeContent}</pre>
        </section>
        <section>
          <strong>修改后</strong>
          <pre>{afterContent}</pre>
        </section>
      </div>
    );
  }

  if (beforeContent !== null) {
    return (
      <section className="worker-proposal-body" aria-label="操作前完整内容">
        <strong>操作前完整内容</strong>
        <pre>{beforeContent}</pre>
      </section>
    );
  }

  return (
    <section className="worker-proposal-body" aria-label="精确交付内容">
      <strong>精确交付内容</strong>
      <pre>{(afterContent ?? proposal.exactContent) || "没有可交付内容"}</pre>
    </section>
  );
}

export function confirmUnknownDeliveryClosure(confirm = globalThis.confirm) {
  if (typeof confirm !== "function") return false;
  return confirm(
    "请确认：你已在对应外部服务中人工核对本次操作。Pi Agent 不会判断它成功或失败，只会结束并解锁这份提案。",
  );
}

function DeliveryArtifact({
  state,
  dispatch,
  onProposeDelivery,
  onUploadDeliveryAttachment,
  onRemoveDeliveryAttachment,
  onConfirmDelivery,
  onAbandonDelivery,
  onRetryDelivery,
  busyAction,
}) {
  const proposal = state.deliveryProposal;
  const confirmationInput = createDeliveryConfirmationInput(state);
  const writeActions = (WORKER_ACTION_CATALOG[state.worker.id] ?? [])
    .filter((action) => action.mode === "write");

  if (writeActions.length === 0) {
    return (
      <div className="worker-artifact worker-delivery-artifact">
        <div className="worker-empty-artifact worker-delivery-empty-copy">
          <ShieldCheck size={22} weight="regular" aria-hidden="true" />
          <span className="worker-readonly-badge">只读 / 草稿阶段</span>
          <h2>IMA 外部写入尚未开放</h2>
          <p>当前可以读取 IMA 笔记、与 Agent 整理内容并保存 Markdown 草稿；不能创建或追加 IMA 笔记。</p>
        </div>
      </div>
    );
  }

  if (!proposal) {
    return (
      <div className="worker-artifact worker-delivery-artifact">
        <div className="worker-empty-artifact worker-delivery-empty-copy">
          <ShieldCheck size={22} weight="regular" aria-hidden="true" />
          <h2>还没有交付预览</h2>
          <p>选择具体操作并填写目标后，系统只会准备精确预览。</p>
        </div>
        <DeliveryProposalForm
          workerId={state.worker.id}
          busyAction={busyAction}
          hasDraft={Boolean(state.draftRevision?.id)}
          sources={state.sources}
          files={state.deliveryFiles}
          onUploadDeliveryAttachment={onUploadDeliveryAttachment}
          onRemoveDeliveryAttachment={onRemoveDeliveryAttachment}
          onProposeDelivery={onProposeDelivery}
        />
      </div>
    );
  }

  const stale = proposal.status === DELIVERY_STATUS.STALE;
  const confirming = proposal.status === DELIVERY_STATUS.CONFIRMING;
  const highRisk = proposal.risk === "high";
  const failed = proposal.status === DELIVERY_STATUS.FAILED;
  const unknown = proposal.status === DELIVERY_STATUS.UNKNOWN;
  const providerPending = proposal.status === DELIVERY_STATUS.PROVIDER_PENDING;
  const canAbandon = proposal.status === DELIVERY_STATUS.PREPARED
    || unknown
    || (failed && proposal.retryable);
  const canStartNew = [
    DELIVERY_STATUS.STALE,
    DELIVERY_STATUS.ABANDONED,
    DELIVERY_STATUS.COMPLETED,
  ].includes(proposal.status) || (failed && !proposal.retryable);
  const abandon = () => {
    if (unknown && !confirmUnknownDeliveryClosure()) return;
    dispatch({ type: WORKER_ACTIONS.ABANDON_DELIVERY, actionId: proposal.id });
    onAbandonDelivery?.({
      taskId: state.task.id,
      actionId: proposal.id,
      manualCheckCompleted: unknown,
      reason: unknown ? "用户确认已在外部服务中完成人工核对" : undefined,
    });
  };
  const confirm = () => {
    if (!confirmationInput) return;
    dispatch({
      type: WORKER_ACTIONS.CONFIRM_DELIVERY,
      proposalHash: confirmationInput.proposalHash,
      draftRevisionId: confirmationInput.draftRevisionId,
    });
    onConfirmDelivery?.(confirmationInput);
  };
  const retry = () => onRetryDelivery?.({ taskId: state.task.id, actionId: proposal.id });

  return (
    <div className="worker-artifact worker-delivery-artifact">
      <header className="worker-artifact-header">
        <div>
          <span>外部交付预览</span>
          <h2>{proposal.operationLabel}</h2>
        </div>
        <span className={`worker-risk-badge is-${proposal.risk}`}>
          {highRisk ? "高风险操作" : proposal.riskLabel || "需要确认"}
        </span>
      </header>

      {stale ? (
        <div className="worker-proposal-warning" role="status">
          <WarningCircle size={17} weight="fill" aria-hidden="true" />
          <div>
            <strong>这份预览已经失效</strong>
            <p>{proposal.staleReason || "草稿、目标或附件已经变化，请重新准备交付。"}</p>
          </div>
        </div>
      ) : null}

      {failed || unknown ? (
        <div className="worker-proposal-warning" role="status">
          <WarningCircle size={17} weight="fill" aria-hidden="true" />
          <div>
            <strong>{unknown ? "外部结果不确定，已安全停止" : "交付没有完成"}</strong>
            <p>{proposal.error?.message || (unknown
              ? "请先在外部服务中人工核对；系统不会盲目重试。"
              : "可以按当前提案状态选择重试或重新生成预览。")}</p>
          </div>
        </div>
      ) : null}

      {providerPending ? (
        <div className="worker-proposal-warning" role="status">
          <SpinnerGap className="spin" size={17} aria-hidden="true" />
          <div>
            <strong>飞书仍在处理版本恢复</strong>
            <p>当前外部任务尚未结束。续查只会轮询现有任务，不会再次执行版本恢复。</p>
          </div>
        </div>
      ) : null}

      {!proposal.previewComplete && proposal.status === DELIVERY_STATUS.PREPARED ? (
        <div className="worker-proposal-warning" role="alert">
          <WarningCircle size={17} weight="fill" aria-hidden="true" />
          <div>
            <strong>交付预览不完整，已禁用确认</strong>
            <p>完整正文或精确操作差异缺失，请重新读取资料并生成预览。</p>
          </div>
        </div>
      ) : null}

      <dl className="worker-proposal-facts">
        <div>
          <dt>目标</dt>
          <dd>{proposal.targetLabel}</dd>
        </div>
        {proposal.recipientDetails?.messageId ? (
          <div>
            <dt>原邮件</dt>
            <dd>{proposal.recipientDetails.messageId}</dd>
          </div>
        ) : null}
        {proposal.recipientDetails?.to?.length ? (
          <div>
            <dt>收件人 To</dt>
            <dd>{proposal.recipientDetails.to.join("、")}</dd>
          </div>
        ) : null}
        {proposal.recipientDetails?.resolvedCc?.length ? (
          <div>
            <dt>回复抄送 CC</dt>
            <dd>{proposal.recipientDetails.resolvedCc.join("、")}</dd>
          </div>
        ) : null}
        {proposal.recipientDetails?.additionalCc?.length ? (
          <div>
            <dt>{["reply", "reply_all"].includes(proposal.operation) ? "新增抄送 CC" : "抄送 CC"}</dt>
            <dd>{proposal.recipientDetails.additionalCc.join("、")}</dd>
          </div>
        ) : null}
        {proposal.recipientDetails?.bcc?.length ? (
          <div>
            <dt>密送 BCC</dt>
            <dd>{proposal.recipientDetails.bcc.join("、")}</dd>
          </div>
        ) : null}
        {proposal.subject ? (
          <div>
            <dt>主题</dt>
            <dd>{proposal.subject}</dd>
          </div>
        ) : null}
        {proposal.baseRevision ? (
          <div>
            <dt>基础版本</dt>
            <dd>{proposal.baseRevision}</dd>
          </div>
        ) : null}
        {Number.isInteger(proposal.affectedBlockCount) ? (
          <div>
            <dt>影响范围</dt>
            <dd>{proposal.affectedBlockCount} 个内容块</dd>
          </div>
        ) : null}
        {proposal.draftRevisionId ? (
          <div>
            <dt>当前草稿</dt>
            <dd>版本 {state.draftRevision.version} · {state.draftRevision.id}</dd>
          </div>
        ) : null}
        {proposal.draftRevisionId && proposal.draftRevisionId !== state.draftRevision.id ? (
          <div>
            <dt>提案绑定</dt>
            <dd>{proposal.draftRevisionId} · 已失效</dd>
          </div>
        ) : null}
      </dl>

      <ProposalContent proposal={proposal} />

      {proposal.attachments?.length ? (
        <section className="worker-proposal-attachments">
          <strong>新增附件 · {proposal.attachments.length}/3</strong>
          <ul>
            {proposal.attachments.map((attachment) => (
              <li key={attachment.id || attachment.name}>
                <Paperclip size={13} weight="regular" aria-hidden="true" />
                {attachment.name}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {proposal.includeOriginalAttachments ? (
        <section className="worker-proposal-attachments">
          <strong>随转发保留的原附件 · {proposal.includedOriginalAttachments.length}</strong>
          {proposal.includedOriginalAttachments.length ? (
            <ul>
              {proposal.includedOriginalAttachments.map((attachment, index) => (
                <li key={attachment.id || `${attachment.name}-${index}`}>
                  <Paperclip size={13} weight="regular" aria-hidden="true" />
                  {attachment.name}
                  {Number.isFinite(attachment.byteLength)
                    ? ` · ${deliveryFileSize(attachment.byteLength)}`
                    : null}
                </li>
              ))}
            </ul>
          ) : <small>原邮件没有可随转发保留的附件。</small>}
        </section>
      ) : null}

      {proposal.nativeConfirmationSummary ? (
        <section className="worker-native-confirmation-summary" aria-label="Agent 邮箱原生确认摘要">
          <strong>Agent 邮箱原生确认摘要</strong>
          <pre>{JSON.stringify(proposal.nativeConfirmationSummary, null, 2)}</pre>
        </section>
      ) : null}

      <section className="worker-proposal-hashes" aria-label="交付绑定信息">
        <span>
          <strong>草稿内容哈希</strong>
          <code>{proposal.draftHash || "未生成"}</code>
        </span>
        <span>
          <strong>本次提案哈希</strong>
          <code>{proposal.proposalHash || "已失效"}</code>
        </span>
      </section>

      <footer className="worker-delivery-footer">
        <div>
          <strong>{providerPending
            ? "外部任务完成前，不能开始新的交付。"
            : "确认只对当前目标、操作、草稿版本和内容哈希有效。"}</strong>
          <small>{providerPending
            ? "续查状态只查询现有任务，不会重复提交写入。"
            : proposal.confirmationHint || "内容发生变化后必须重新预览。"}</small>
        </div>
        <div>
          {providerPending ? (
            <button
              className="worker-secondary-button"
              type="button"
              disabled={Boolean(busyAction)}
              onClick={retry}
            >
              <ArrowClockwise size={14} aria-hidden="true" />
              {busyAction === "retry_delivery" ? "正在续查…" : "续查状态"}
            </button>
          ) : proposal.retryable ? (
            <button
              className="worker-secondary-button"
              type="button"
              disabled={Boolean(busyAction)}
              onClick={retry}
            >
              <ArrowClockwise size={14} aria-hidden="true" />
              {busyAction === "retry_delivery" ? "正在重试…" : "重新准备此提案"}
            </button>
          ) : null}
          {!providerPending && unknown ? (
            <button
              className="worker-secondary-button"
              type="button"
              disabled={Boolean(busyAction)}
              onClick={abandon}
            >
              <ShieldCheck size={14} weight="regular" aria-hidden="true" />
              {busyAction === "abandon_delivery" ? "正在记录…" : "已人工核对并结束提案"}
            </button>
          ) : !providerPending ? (
            <>
              <button
                className="worker-secondary-button"
                type="button"
                disabled={confirming || !canAbandon || Boolean(busyAction)}
                onClick={abandon}
              >
                放弃本次交付
              </button>
              <button
                className="worker-primary-button"
                type="button"
                disabled={!confirmationInput || confirming || Boolean(busyAction)}
                onClick={confirm}
              >
                <ShieldCheck size={14} weight="regular" aria-hidden="true" />
                {confirming ? "正在提交…" : "确认执行本次交付"}
              </button>
            </>
          ) : null}
        </div>
      </footer>

      {canStartNew ? (
        <DeliveryProposalForm
          workerId={state.worker.id}
          busyAction={busyAction}
          hasDraft={Boolean(state.draftRevision?.id)}
          sources={state.sources}
          files={state.deliveryFiles}
          onUploadDeliveryAttachment={onUploadDeliveryAttachment}
          onRemoveDeliveryAttachment={onRemoveDeliveryAttachment}
          onProposeDelivery={onProposeDelivery}
        />
      ) : null}
    </div>
  );
}

function ReceiptArtifact({ state, onAbandonDelivery, busyAction }) {
  const receipt = state.receipt;
  if (!receipt) {
    return (
      <div className="worker-artifact worker-empty-artifact">
        <CheckCircle size={22} weight="regular" aria-hidden="true" />
        <h2>还没有交付回执</h2>
        <p>交付执行后，这里会保留外部编号、时间、提案哈希和读取验证结果。</p>
      </div>
    );
  }

  const unknown = receipt.status === "unknown";
  const providerPending = receipt.status === "provider_pending";
  const manualResolved = receipt.status === "manual_resolved";
  const closeUnknown = () => {
    const proposal = state.deliveryProposal;
    if (!proposal?.id || !confirmUnknownDeliveryClosure()) return;
    onAbandonDelivery?.({
      taskId: state.task.id,
      actionId: proposal.id,
      manualCheckCompleted: true,
      reason: "用户确认已在外部服务中完成人工核对",
    });
  };
  return (
    <div className={`worker-artifact worker-receipt-artifact is-${receipt.status}`}>
      <header className="worker-receipt-summary">
        {unknown
          ? <WarningCircle size={22} weight="fill" aria-hidden="true" />
          : manualResolved
            ? <ShieldCheck size={22} weight="regular" aria-hidden="true" />
          : providerPending
            ? <SpinnerGap className="spin" size={22} aria-hidden="true" />
            : <CheckCircle size={22} weight="fill" aria-hidden="true" />}
        <div>
          <span>{unknown ? "需要人工核对" : receipt.statusLabel || "交付回执"}</span>
          <h2>{receipt.summary}</h2>
          <p>{receipt.detail}</p>
        </div>
      </header>
      <dl className="worker-proposal-facts">
        <div>
          <dt>外部编号</dt>
          <dd>{receipt.externalId || "未返回"}</dd>
        </div>
        <div>
          <dt>记录时间</dt>
          <dd>{receipt.createdAtLabel}</dd>
        </div>
        <div>
          <dt>提案哈希</dt>
          <dd><code>{receipt.proposalHash}</code></dd>
        </div>
        {receipt.draftSha256 ? (
          <div>
            <dt>内容哈希</dt>
            <dd><code>{receipt.draftSha256}</code></dd>
          </div>
        ) : null}
        <div>
          <dt>读取验证</dt>
          <dd>{receipt.readbackLabel || "等待验证"}</dd>
        </div>
      </dl>
      {isSafeExternalUrl(receipt.externalUrl) ? (
        <a className="worker-receipt-link" href={receipt.externalUrl} target="_blank" rel="noreferrer">
          <LinkSimple size={14} weight="regular" aria-hidden="true" />
          打开外部记录
        </a>
      ) : null}
      {unknown ? (
        <div className="worker-manual-resolution">
          <p className="worker-trust-note is-warning">
            当前结果不确定，系统不会自动重试。请先在对应服务中核对，再明确结束本次提案。
          </p>
          <button
            className="worker-secondary-button"
            type="button"
            disabled={Boolean(busyAction) || state.deliveryProposal?.status !== DELIVERY_STATUS.UNKNOWN}
            onClick={closeUnknown}
          >
            <ShieldCheck size={14} weight="regular" aria-hidden="true" />
            {busyAction === "abandon_delivery" ? "正在记录…" : "已人工核对并结束提案"}
          </button>
        </div>
      ) : null}
      {manualResolved ? (
        <p className="worker-trust-note">
          人工核对已记录。Pi Agent 未判断外部结果，本次提案已结束。
        </p>
      ) : null}
    </div>
  );
}

function isSafeExternalUrl(value) {
  if (typeof value !== "string" || !value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function WorkerArtifactPane({
  state,
  dispatch,
  onReadSource,
  onUseSource,
  onDraftChange,
  onSaveDraft,
  onProposeDelivery,
  onUploadDeliveryAttachment,
  onRemoveDeliveryAttachment,
  onConfirmDelivery,
  onAbandonDelivery,
  onRetryDelivery,
  busyAction,
}) {
  const tabPanelId = useId();
  const panels = {
    [WORKER_ARTIFACTS.SOURCES]: (
      <SourcesArtifact
        state={state}
        onReadSource={onReadSource}
        onUseSource={onUseSource}
        readBusy={busyAction === "read_source"}
      />
    ),
    [WORKER_ARTIFACTS.DRAFT]: (
      <DraftArtifact
        state={state}
        dispatch={dispatch}
        onDraftChange={onDraftChange}
        onSaveDraft={onSaveDraft}
      />
    ),
    [WORKER_ARTIFACTS.DELIVERY]: (
      <DeliveryArtifact
        state={state}
        dispatch={dispatch}
        onProposeDelivery={onProposeDelivery}
        onUploadDeliveryAttachment={onUploadDeliveryAttachment}
        onRemoveDeliveryAttachment={onRemoveDeliveryAttachment}
        onConfirmDelivery={onConfirmDelivery}
        onAbandonDelivery={onAbandonDelivery}
        onRetryDelivery={onRetryDelivery}
        busyAction={busyAction}
      />
    ),
    [WORKER_ARTIFACTS.RECEIPT]: (
      <ReceiptArtifact
        state={state}
        onAbandonDelivery={onAbandonDelivery}
        busyAction={busyAction}
      />
    ),
  };

  return (
    <>
      <nav className="reading-artifact-tabs worker-artifact-tabs" role="tablist" aria-label="Worker 工件">
        {ARTIFACT_TABS.map((tab) => {
          const active = state.activeArtifactId === tab.id;
          const badge = tab.id === WORKER_ARTIFACTS.DELIVERY
            && state.deliveryProposal?.status === DELIVERY_STATUS.PREPARED
            ? "1"
            : tab.id === WORKER_ARTIFACTS.RECEIPT && state.receipt
              ? "1"
              : null;
          return (
            <button
              className={active ? "is-active" : ""}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={tabPanelId}
              key={tab.id}
              onClick={() => dispatch({
                type: WORKER_ACTIONS.SET_ACTIVE_ARTIFACT,
                artifactId: tab.id,
              })}
            >
              {tab.label}
              {badge ? <span>{badge}</span> : null}
            </button>
          );
        })}
      </nav>
      <div className="reading-artifact-panels worker-artifact-panels">
        <div
          className="reading-artifact-panel worker-artifact-panel"
          id={tabPanelId}
          role="tabpanel"
        >
          {panels[state.activeArtifactId]}
        </div>
      </div>
    </>
  );
}

/**
 * Center Agent + right artifact surface. The caller owns work-type routing and
 * the left ProjectRail. Passing state/dispatch makes it fully controlled;
 * otherwise it runs the exported reducer locally for the clickable contract.
 */
export function WorkerWorkspace({
  state: controlledState,
  dispatch: controlledDispatch,
  initialState,
  projectOptions,
  providers = [],
  providerOpen = false,
  onProviderOpenChange,
  onProviderChange,
  onModelChange,
  onProjectContextChange,
  onSendMessage,
  onUploadAttachment,
  onRemovePendingAttachment,
  onReadSource,
  onUseSource,
  onDraftChange,
  onSaveDraft,
  onProposeDelivery,
  onUploadDeliveryAttachment,
  onRemoveDeliveryAttachment,
  onConfirmDelivery,
  onAbandonDelivery,
  onRetryDelivery,
  onAbort,
  onRetryLastTurn,
  onCompact,
  onAnswerAskUser,
  onCancelAskUser,
  onCheckConnection,
  onOpenConnections,
  busyAction = null,
  loading = false,
  error = null,
  sidebarOpen = true,
  onToggleSidebar,
  artifactOpen: controlledArtifactOpen,
  onArtifactOpenChange,
  initialArtifactOpen = false,
  mobileActive = false,
  mobileView = "agent",
}) {
  const [localState, localDispatch] = useReducer(
    workerReducer,
    initialState,
    (value) => createInitialWorkerState(value),
  );
  const [internalArtifactOpen, setInternalArtifactOpen] = useState(initialArtifactOpen);
  const state = controlledState === undefined ? localState : controlledState;
  const dispatch = controlledDispatch ?? localDispatch;
  const availableProjects = projectOptions ?? state?.projectOptions ?? [];
  const artifactOpen = controlledArtifactOpen ?? internalArtifactOpen;
  const setArtifactOpen = onArtifactOpenChange ?? setInternalArtifactOpen;
  const activeProvider = providers.find((provider) => provider.id === state?.providerId)
    ?? providers.find((provider) => provider.available)
    ?? providers[0];

  if (!state) {
    return (
      <main className="worker-workspace-placeholder" role="status">
        {loading ? <SpinnerGap className="spin" size={24} aria-hidden="true" /> : <Briefcase size={24} aria-hidden="true" />}
        <h1>{loading ? "正在恢复 Worker 任务…" : "还没有 Worker 任务"}</h1>
        <p>{error?.message || "从左侧选择 Worker 并新建任务，开始一项持久的文字工作。"}</p>
      </main>
    );
  }

  const openArtifact = (artifactId) => {
    dispatch({ type: WORKER_ACTIONS.SET_ACTIVE_ARTIFACT, artifactId });
    setArtifactOpen(true);
  };

  const changeProvider = (providerId) => {
    const provider = providers.find((item) => item.id === providerId);
    const modelId = provider?.models?.[0] ?? "";
    dispatch({ type: WORKER_ACTIONS.SET_MODEL, providerId, modelId });
    onProviderChange?.(providerId, modelId);
  };

  const changeModel = (modelId) => {
    const providerId = activeProvider?.id ?? state.providerId;
    dispatch({ type: WORKER_ACTIONS.SET_MODEL, providerId, modelId });
    onModelChange?.(modelId, providerId);
  };

  return (
    <AgentArtifactLayout
      ariaLabel="Worker 工作会话"
      mobileActive={mobileActive}
      mobileView={mobileView}
      agentMobileView="agent"
      artifactOpen={artifactOpen}
      onArtifactOpenChange={setArtifactOpen}
      closedLabel="打开工件"
      openLabel="收起工件"
      closedTitle="打开右侧 Worker 工件"
      openTitle="收起右侧 Worker 工件"
      resizeLabel="拖拽调整 Agent 与 Worker 工件的宽度"
      title={(
        <div className="workflow-title-block worker-title-block">
          <button
            className={`column-toggle-btn${!sidebarOpen ? " is-collapsed" : ""}`}
            type="button"
            aria-label={sidebarOpen ? "收起左边栏" : "展开左边栏"}
            title={sidebarOpen ? "收起左边栏" : "展开左边栏"}
            onClick={onToggleSidebar}
          >
            <SidebarSimple size={18} weight="regular" aria-hidden="true" />
          </button>
          <div>
            <span className="workflow-kicker">{state.worker.name}</span>
            <h1>{state.task.title}</h1>
          </div>
        </div>
      )}
      headerActions={(
        <>
          <button
            className={`header-meta-pill worker-connection-pill is-${state.connection.status}`}
            type="button"
            onClick={() => (onCheckConnection
              ? onCheckConnection(state.worker.id)
              : onOpenConnections?.())}
            title="检查当前 Worker 连接"
          >
            <LinkSimple size={13} weight="regular" aria-hidden="true" />
            <span>{state.connection.label}</span>
          </button>
          {providers.length > 0 ? (
            <ProviderMenu
              open={providerOpen}
              onOpenChange={onProviderOpenChange}
              providers={providers}
              providerId={activeProvider?.id}
              model={state.modelId || activeProvider?.models?.[0] || ""}
              onProviderChange={changeProvider}
              onModelChange={changeModel}
            />
          ) : null}
        </>
      )}
      agent={(
        <WorkerAgentPane
          state={state}
          dispatch={dispatch}
          projectOptions={availableProjects}
          onProjectContextChange={onProjectContextChange}
          onDraftChange={onDraftChange}
          onSendMessage={onSendMessage}
          onUploadAttachment={onUploadAttachment}
          onRemovePendingAttachment={onRemovePendingAttachment}
          onAbort={onAbort}
          onRetryLastTurn={onRetryLastTurn}
          onCompact={onCompact}
          onAnswerAskUser={onAnswerAskUser}
          onCancelAskUser={onCancelAskUser}
          running={["queued", "planning", "running", "streaming", "executing", "steering", "aborting", "compacting", "verifying"].includes(state.conversation?.turnStatus || state.conversation?.status)}
          busyAction={busyAction}
          error={error}
          onOpenArtifact={openArtifact}
        />
      )}
      artifact={(
        <WorkerArtifactPane
          state={state}
          dispatch={dispatch}
          onReadSource={onReadSource}
          onUseSource={onUseSource}
          onDraftChange={onDraftChange}
          onSaveDraft={onSaveDraft}
          onProposeDelivery={onProposeDelivery}
          onUploadDeliveryAttachment={onUploadDeliveryAttachment}
          onRemoveDeliveryAttachment={onRemoveDeliveryAttachment}
          onConfirmDelivery={onConfirmDelivery}
          onAbandonDelivery={onAbandonDelivery}
          onRetryDelivery={onRetryDelivery}
          busyAction={busyAction}
        />
      )}
    />
  );
}
