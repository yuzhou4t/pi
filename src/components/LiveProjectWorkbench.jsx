import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Broom,
  CaretDown,
  CaretRight,
  Check,
  CheckCircle,
  CircleNotch,
  Code,
  FileCode,
  Files,
  Folder,
  GitDiff,
  Package,
  PaperPlaneTilt,
  Play,
  SidebarSimple,
  StopCircle,
  TestTube,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { projectWorkApi } from "../api/projectWork.js";
import { mergeFreshConversationSnapshot } from "../project-work/liveProjectWorkState.js";
import { AgentArtifactLayout } from "./AgentArtifactLayout.jsx";
import { ProviderMenu } from "./ProviderMenu.jsx";

const ARTIFACTS = [
  { id: "files", label: "文件" },
  { id: "changes", label: "更改" },
  { id: "preview", label: "预览" },
  { id: "run_result", label: "运行" },
];

const RUNNING_STATUSES = new Set([
  "queued",
  "planning",
  "running",
  "streaming",
  "executing",
  "steering",
  "aborting",
  "compacting",
  "verifying",
]);

const STATUS_LABELS = {
  idle: "等待任务",
  ready: "等待任务",
  queued: "等待 Agent",
  planning: "正在规划",
  running: "正在工作",
  streaming: "正在回答",
  executing: "正在执行",
  steering: "正在调整",
  awaiting_confirmation: "修改待审阅",
  awaiting_approval: "修改待审阅",
  changes_ready: "修改待审阅",
  applied: "修改已应用",
  verifying: "正在验证",
  compacting: "正在整理上下文",
  aborting: "正在停止",
  aborted: "已停止",
  completed: "本轮已完成",
  failed: "本轮失败",
  error: "需要处理",
  interrupted: "运行已中断",
};

const TOOL_LABELS = {
  read: "读取文件",
  edit: "准备修改",
  write: "准备新文件",
  grep: "搜索内容",
  find: "查找文件",
  ls: "查看目录",
  update_plan: "更新计划",
  request_verification: "保存验证命令",
};

const OPERATION_LABELS = {
  create: "新增",
  modify: "修改",
  delete: "删除",
};

const QUIET_EVENT_TYPES = new Set([
  "conversation.created",
  "message.created",
  "message.started",
  "message.completed",
  "agent.status",
  "agent.turn_finished",
  "turn.started",
  "turn.completed",
  "message_delta",
  "message_update",
  "text_delta",
  "assistant_delta",
  "message.delta",
  "message.update",
  "assistant.delta",
]);

const ARTIFACT_STORAGE_KEY = "pi-agent-project-work-artifacts-v1";

function readLastArtifact(conversationId, fallback = "files") {
  if (!conversationId || typeof window === "undefined") return fallback;
  try {
    const stored = JSON.parse(window.localStorage.getItem(ARTIFACT_STORAGE_KEY) || "{}");
    const artifactId = stored?.[conversationId];
    return ARTIFACTS.some((artifact) => artifact.id === artifactId)
      ? artifactId
      : fallback;
  } catch {
    return fallback;
  }
}

function writeLastArtifact(conversationId, artifactId) {
  if (!conversationId || typeof window === "undefined") return;
  try {
    const stored = JSON.parse(window.localStorage.getItem(ARTIFACT_STORAGE_KEY) || "{}");
    window.localStorage.setItem(
      ARTIFACT_STORAGE_KEY,
      JSON.stringify({ ...stored, [conversationId]: artifactId }),
    );
  } catch {
    // Artifact preference is optional; the live conversation remains authoritative.
  }
}

export function mergeConversationTitle(snapshot, conversation) {
  if (
    !snapshot
    || !conversation
    || snapshot.id !== conversation.id
    || typeof conversation.title !== "string"
    || snapshot.title === conversation.title
  ) {
    return snapshot;
  }
  return {
    ...snapshot,
    title: conversation.title,
    updatedAt: conversation.updatedAt ?? snapshot.updatedAt,
  };
}

function activeStatus(conversation) {
  return conversation?.turnStatus || conversation?.status || "idle";
}

function isConversationRunning(conversation) {
  return RUNNING_STATUSES.has(activeStatus(conversation));
}

function statusClass(conversation) {
  const status = activeStatus(conversation);
  if (RUNNING_STATUSES.has(status)) return "executing";
  if (["awaiting_confirmation", "awaiting_approval", "changes_ready"].includes(status)) {
    return "awaiting_confirmation";
  }
  if (["failed", "interrupted"].includes(status)) return "test_failed";
  if (["applied"].includes(status)) return "changes_applied";
  if (["completed"].includes(status)) return "completed";
  return "ready";
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function eventTitle(event) {
  if (event.title) return event.title;
  const type = String(event.type || "");
  const tool = TOOL_LABELS[event.toolName] ?? event.toolName ?? "工具";
  if (type === "conversation.created") return "工作会话已创建";
  if (type === "message.created") return "任务已提交";
  if (type === "message.started") return "Agent 开始回复";
  if (type === "message.completed") return "Agent 回复已完成";
  if (type === "agent.status") return "Agent 状态已更新";
  if (type === "workspace.snapshot_limited") return "大型项目已按安全范围载入";
  if (/tool.*(?:start|call)|tool_call/.test(type)) {
    return TOOL_LABELS[event.toolName] ?? `调用 ${tool}`;
  }
  if (/tool.*(?:end|result|complete)|tool_result/.test(type)) {
    return event.status === "failed" ? `${tool}失败` : `${tool}完成`;
  }
  if (/plan/.test(type)) return "计划已更新";
  if (/change/.test(type)) return "修改提案已更新";
  if (/verification|command|bash/.test(type)) return "验证活动";
  if (/agent.*start|turn.*start/.test(type)) return "Agent 开始工作";
  if (/agent.*end|turn.*end/.test(type)) return "Agent 本轮结束";
  return type ? type.replaceAll("_", " ") : "活动";
}

function boundedValue(value) {
  if (typeof value === "string") return value.slice(0, 500);
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value).slice(0, 500);
  } catch {
    return String(value).slice(0, 500);
  }
}

function eventDetail(event) {
  if (event.detail) return event.detail;
  if (event.path) return event.path;
  if (event.error?.message) return event.error.message;
  if (event.summary) return boundedValue(event.summary);
  if (event.result) return boundedValue(event.result);
  if (event.arguments) return boundedValue(event.arguments);
  if (/change/.test(event.type ?? "") && event.status === "ready") {
    return "修改已生成，等待审阅";
  }
  if (/verification/.test(event.type ?? "") && event.status === "requested") {
    return "验证命令已保存，尚未运行";
  }
  if (/plan/.test(event.type ?? "")) return "公开计划已同步";
  return event.status
    ? `状态：${STATUS_LABELS[event.status] ?? event.status}`
    : "活动详情已记录";
}

function eventArtifact(event) {
  if (ARTIFACTS.some((artifact) => artifact.id === event.artifactId)) {
    return event.artifactId;
  }
  const type = `${event.type ?? ""} ${event.toolName ?? ""}`.toLowerCase();
  if (/edit|write|change|patch|diff/.test(type)) return "changes";
  if (
    event.path
    || /(?:^|[.\s])(read|grep|find|ls)(?:$|[.\s])/.test(type)
  ) return "files";
  if (/bash|command|verification|test|build/.test(type)) return "run_result";
  return null;
}

function isSuccessfulRun(run) {
  return ["passed", "succeeded", "completed"].includes(run.status);
}

function isFailedRun(run) {
  return ["failed", "timed_out", "interrupted", "aborted"].includes(run.status);
}

function safeLoopbackPreviewUrl(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol)
      || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || url.username
      || url.password
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function ActionError({ error }) {
  if (!error) return null;
  return (
    <section className="project-agent-decision is-warning" role="alert">
      <WarningCircle size={18} weight="fill" aria-hidden="true" />
      <div>
        <strong>
          {["CHANGE_SET_STALE", "PROJECT_WORK_CHANGE_STALE"].includes(error.code)
            ? "项目文件已经变化"
            : "操作没有完成"}
        </strong>
        <p>{error.message}</p>
      </div>
    </section>
  );
}

function PlanCard({ plan }) {
  if (!Array.isArray(plan) || plan.length === 0) return null;
  return (
    <section className="project-plan-card" aria-label="Agent 计划">
      <header>
        <span>Agent 计划</span>
        <small>{plan.filter((step) => step.status === "completed").length}/{plan.length}</small>
      </header>
      <ol>
        {plan.map((step) => (
          <li className={`is-${step.status}`} key={step.id}>
            <span className="project-plan-status" aria-hidden="true">
              {step.status === "completed" ? (
                <Check size={12} weight="bold" />
              ) : step.status === "in_progress" || step.status === "running" ? (
                <CircleNotch size={12} weight="bold" />
              ) : null}
            </span>
            <span>{step.title}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function ActivityEvent({ event, isLatest, onOpenArtifact }) {
  const [open, setOpen] = useState(isLatest);
  const artifactId = eventArtifact(event);

  useEffect(() => {
    setOpen(isLatest);
  }, [isLatest]);

  return (
    <details open={open} onToggle={(toggleEvent) => setOpen(toggleEvent.currentTarget.open)}>
      <summary>
        <span className="project-activity-dot" aria-hidden="true" />
        <span>{eventTitle(event)}</span>
        <small>#{event.seq}</small>
        <CaretDown size={12} aria-hidden="true" />
      </summary>
      <p>
        <span>{eventDetail(event)}</span>
        {artifactId ? (
          <button type="button" onClick={() => onOpenArtifact(artifactId, event.path)}>
            {artifactId === "files"
              ? "查看文件"
              : artifactId === "changes"
                ? "查看更改"
                : "查看运行"}
            <CaretRight size={12} weight="bold" aria-hidden="true" />
          </button>
        ) : null}
      </p>
    </details>
  );
}

function ActivityTimeline({ events, onOpenArtifact }) {
  const visibleEvents = events
    .filter((event) => !QUIET_EVENT_TYPES.has(event.type))
    .slice(-100);
  if (visibleEvents.length === 0) return null;
  return (
    <section className="project-activity" aria-label="Pi Agent 活动">
      <header>
        <span>活动</span>
        <small>{visibleEvents.length} 条记录</small>
      </header>
      <div>
        {visibleEvents.map((event, index) => (
          <ActivityEvent
            event={event}
            isLatest={index === visibleEvents.length - 1}
            key={event.seq}
            onOpenArtifact={onOpenArtifact}
          />
        ))}
      </div>
    </section>
  );
}

function EmptyConversationPane({ project, preparing = false }) {
  return (
    <div className="project-agent">
      <header className="project-agent-header">
        <div>
          <span>项目 Agent</span>
          <strong>{preparing ? "正在创建" : "尚未开始"}</strong>
        </div>
        <span className="project-agent-status is-ready">
          <span aria-hidden="true" />
          {preparing ? "创建会话" : "等待会话"}
        </span>
      </header>
      <div className="project-agent-stream">
        <section className="project-agent-welcome">
          {preparing
            ? <CircleNotch className="spin" size={24} weight="regular" aria-hidden="true" />
            : <Code size={24} weight="regular" aria-hidden="true" />}
          <div>
            <h2>{preparing ? "正在准备新工作会话" : "绑定项目 / 新建会话后开始"}</h2>
            <p>
              {preparing
                ? "Pi Agent 正在创建轻量会话，马上就可以输入任务。"
                : project
                ? `在“${project.name}”中新建一个会话，Pi Agent 才会读取项目并开始工作。`
                : "先在左侧绑定本地项目，再新建一个正常工作会话。"}
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}

function ProjectAgentPane({
  conversation,
  draft,
  onDraftChange,
  contextChips,
  onRemoveContext,
  onSubmit,
  onAbort,
  onCompact,
  onOpenArtifact,
  action,
  error,
  modelLabel,
}) {
  const running = isConversationRunning(conversation);
  const status = activeStatus(conversation);
  const statusLabel = STATUS_LABELS[status] ?? status;
  const canSubmit = draft.trim() && !action;
  const limitedSnapshotEvent = conversation.events.find(
    (event) => event.type === "workspace.snapshot_limited",
  );
  const snapshotIsLimited = conversation.workspaceSnapshot?.truncated === true
    || Boolean(limitedSnapshotEvent);
  const includedFiles = conversation.workspaceSnapshot?.includedFiles
    ?? limitedSnapshotEvent?.data?.snapshot?.includedFiles;

  return (
    <div className="project-agent">
      <header className="project-agent-header">
        <div>
          <span>项目 Agent</span>
          <strong>{statusLabel}</strong>
        </div>
        <div className="live-project-session-actions">
          {running ? (
            <button
              className="header-meta-pill"
              type="button"
              onClick={onAbort}
              disabled={Boolean(action)}
            >
              <StopCircle size={13} aria-hidden="true" />
              停止
            </button>
          ) : (
            <button
              className="header-meta-pill"
              type="button"
              onClick={onCompact}
              disabled={Boolean(action) || conversation.messages.length === 0}
            >
              <Broom size={13} aria-hidden="true" />
              整理上下文
            </button>
          )}
          <span className={`project-agent-status is-${statusClass(conversation)}`}>
            <span aria-hidden="true" />
            {statusLabel}
          </span>
        </div>
      </header>

      <div className="project-agent-stream">
        {snapshotIsLimited ? (
          <section className="project-agent-decision" role="status">
            <WarningCircle size={18} weight="fill" aria-hidden="true" />
            <div>
              <strong>当前会话使用受控项目快照</strong>
              <p>
                {Number.isSafeInteger(includedFiles)
                  ? `大型项目已载入 ${includedFiles} 个可编辑文本文件。`
                  : "大型项目已按安全范围载入。"}
                Agent 不会把未载入范围当成已检查内容；需要完整检查时请绑定更具体的子文件夹。
              </p>
            </div>
          </section>
        ) : null}
        {conversation.messages.length === 0 ? (
          <section className="project-agent-welcome">
            <Code size={24} weight="regular" aria-hidden="true" />
            <div>
              <h2>从一个明确任务开始</h2>
              <p>Pi 会读取当前项目、公开实际工具活动，并把修改留到右侧等待确认。</p>
            </div>
            <div className="project-agent-scope">
              <span>真实项目上下文</span>
              <span>修改先审阅</span>
              <span>命令显式运行</span>
            </div>
          </section>
        ) : (
          conversation.messages.map((message) => {
            const text = messageText(message.content);
            if (!text) return null;
            return (
              <article
                className={`project-agent-message is-${message.role} is-${message.kind}`}
                key={message.id}
              >
                <small>{message.role === "user" ? "你" : "Pi Agent"}</small>
                <div>{text}</div>
              </article>
            );
          })
        )}

        <PlanCard plan={conversation.plan} />
        <ActivityTimeline events={conversation.events} onOpenArtifact={onOpenArtifact} />
        <ActionError error={error ?? conversation.error} />

        {conversation.pendingChangeSet?.status && [
          "pending",
          "proposed",
          "ready",
          "awaiting_confirmation",
          "awaiting_approval",
        ].includes(conversation.pendingChangeSet.status) ? (
          <section className="project-agent-decision">
            <GitDiff size={18} aria-hidden="true" />
            <div>
              <strong>修改已经准备好，尚未写入项目</strong>
              <p>请在右侧核对每个文件、基础哈希和目标哈希，再应用所选修改。</p>
            </div>
            <button
              className="project-agent-link"
              type="button"
              onClick={() => onOpenArtifact("changes")}
            >
              查看精确更改
              <CaretRight size={13} weight="bold" aria-hidden="true" />
            </button>
          </section>
        ) : null}
      </div>

      <form className="project-agent-composer" onSubmit={onSubmit}>
        {contextChips.length > 0 ? (
          <>
            <div className="project-context-chips" aria-label="本条消息的文件上下文">
              {contextChips.map((context) => (
                <span key={context.id}>
                  <FileCode size={13} aria-hidden="true" />
                  {context.label}
                  <button
                    type="button"
                    onClick={() => onRemoveContext(context.id)}
                    aria-label={`移除上下文：${context.label}`}
                  >
                    <X size={12} weight="bold" aria-hidden="true" />
                  </button>
                </span>
              ))}
            </div>
            {running ? (
              <small className="live-project-context-note">
                Agent 工作中；这些文件上下文会保留到下一轮消息。
              </small>
            ) : null}
          </>
        ) : null}
        <label>
          <span className="sr-only">给项目 Agent 的消息</span>
          <textarea
            value={draft}
            disabled={action === "abort" || action === "compact"}
            onChange={(event) => onDraftChange(event.target.value)}
            placeholder={running ? "补充方向，会作为 steer 发送给当前 Agent" : "描述希望 Pi 完成的项目任务"}
          />
        </label>
        <footer>
          <div>
            <span className="project-composer-model">{modelLabel || "跟随项目默认模型"}</span>
            <small>{running ? "发送会调整当前 Agent 的方向" : "只有显式发送才开始工作"}</small>
          </div>
          <button
            type="submit"
            disabled={!canSubmit}
            aria-label={running ? "调整当前 Agent" : "发送任务"}
            title={running ? "调整当前 Agent" : "发送任务"}
          >
            {action === "message" ? (
              <CircleNotch size={16} weight="bold" aria-hidden="true" />
            ) : (
              <PaperPlaneTilt size={16} weight="fill" aria-hidden="true" />
            )}
          </button>
        </footer>
      </form>
    </div>
  );
}

function FileArtifact({
  project,
  conversationId,
  api,
  selectedPath,
  requestedPath,
  onRequestedPathHandled,
  onAddContext,
  onError,
}) {
  const [entries, setEntries] = useState([]);
  const [expandedPaths, setExpandedPaths] = useState([]);
  const [activePath, setActivePath] = useState(selectedPath ?? "");
  const [fileCache, setFileCache] = useState({});
  const [loadingTree, setLoadingTree] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);
  const [error, setError] = useState(null);
  const loadedDirectories = useRef(new Set());
  const fileAbort = useRef(null);

  const reportError = useCallback((nextError) => {
    setError(nextError);
    onError?.(nextError);
  }, [onError]);

  const loadDirectory = useCallback(async (path = "") => {
    if (!project?.id || loadedDirectories.current.has(path)) return;
    setLoadingTree(true);
    setError(null);
    try {
      const tree = await api.fetchTree({ projectId: project.id, path });
      loadedDirectories.current.add(path);
      setEntries((current) => {
        const byPath = new Map(current.map((entry) => [entry.path, entry]));
        tree.entries.forEach((entry) => byPath.set(entry.path, entry));
        return [...byPath.values()].sort((left, right) => (
          left.path.localeCompare(right.path, "zh-CN")
        ));
      });
      if (path) {
        setExpandedPaths((current) => current.includes(path) ? current : [...current, path]);
      }
    } catch (nextError) {
      reportError(nextError);
    } finally {
      setLoadingTree(false);
    }
  }, [api, project?.id, reportError]);

  const loadFile = useCallback(async (path) => {
    if ((!conversationId && !project?.id) || !path) return;
    setActivePath(path);
    if (fileCache[path]) return;
    fileAbort.current?.abort();
    const controller = new AbortController();
    fileAbort.current = controller;
    setLoadingFile(true);
    setError(null);
    try {
      const file = await api.fetchFile({
        ...(conversationId
          ? { conversationId }
          : { projectId: project.id }),
        path,
        signal: controller.signal,
      });
      setFileCache((current) => ({ ...current, [path]: file }));
    } catch (nextError) {
      if (nextError?.name !== "AbortError") reportError(nextError);
    } finally {
      if (fileAbort.current === controller) setLoadingFile(false);
    }
  }, [api, conversationId, fileCache, project?.id, reportError]);

  useEffect(() => {
    loadedDirectories.current = new Set();
    fileAbort.current?.abort();
    setEntries([]);
    setExpandedPaths([]);
    setActivePath("");
    setFileCache({});
    setError(null);
    loadDirectory("");
    return () => fileAbort.current?.abort();
  }, [conversationId, loadDirectory, project?.id]);

  useEffect(() => {
    if (!requestedPath) return;
    loadFile(requestedPath);
    onRequestedPathHandled?.();
  }, [loadFile, onRequestedPathHandled, requestedPath]);

  const visibleEntries = entries.filter((entry) => {
    const segments = entry.path.split("/");
    if (segments.length <= 1) return true;
    const parents = segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join("/"));
    return parents.every((parent) => expandedPaths.includes(parent));
  });
  const selectedFile = fileCache[activePath] ?? null;

  return (
    <div className="project-file-artifact">
      <aside aria-label="项目文件">
        <header>
          <Files size={15} aria-hidden="true" />
          {loadingTree ? "正在读取项目" : "项目文件"}
        </header>
        {visibleEntries.map((entry) => (
          <button
            className={entry.path === activePath ? "is-active" : ""}
            type="button"
            key={entry.path}
            onClick={() => {
              if (entry.kind === "directory") {
                if (expandedPaths.includes(entry.path)) {
                  setExpandedPaths((current) => current.filter((path) => path !== entry.path));
                } else {
                  loadDirectory(entry.path);
                }
                return;
              }
              loadFile(entry.path);
            }}
            style={{ paddingLeft: `${8 + Math.max(0, entry.depth) * 12}px` }}
          >
            {entry.kind === "directory" ? (
              <Folder size={15} weight="fill" aria-hidden="true" />
            ) : (
              <FileCode size={15} aria-hidden="true" />
            )}
            <span>{entry.name || entry.path}</span>
          </button>
        ))}
        {!loadingTree && visibleEntries.length === 0 ? (
          <p className="live-project-inline-empty">项目中没有可显示的文件。</p>
        ) : null}
      </aside>
      <section className="project-code-viewer">
        <header>
          <div>
            <strong>{activePath || "选择一个文件"}</strong>
            <small>
              {selectedFile
                ? `${selectedFile.language.toUpperCase()} · 只读${selectedFile.truncated ? " · 已截断" : ""}`
                : loadingFile
                  ? "正在读取文件"
                  : "文件内容按需读取"}
            </small>
          </div>
          {selectedFile && !selectedFile.binary ? (
            <button
              type="button"
              onClick={() => onAddContext({
                id: `file:${selectedFile.path}:${selectedFile.contentHash ?? "current"}`,
                label: `${selectedFile.path} · 全文`,
                path: selectedFile.path,
                contentHash: selectedFile.contentHash,
                startLine: selectedFile.startLine ?? 1,
                endLine: selectedFile.endLine
                  ?? (selectedFile.startLine ?? 1) + selectedFile.lines.length - 1,
              })}
            >
              加入上下文
            </button>
          ) : null}
        </header>
        {error ? (
          <div className="project-run-empty" role="alert">
            <WarningCircle size={24} aria-hidden="true" />
            <h3>无法读取项目文件</h3>
            <p>{error.message}</p>
          </div>
        ) : selectedFile?.binary ? (
          <div className="project-run-empty">
            <FileCode size={24} aria-hidden="true" />
            <h3>二进制文件</h3>
            <p>当前只显示文件信息，不把二进制内容加入 Agent 上下文。</p>
          </div>
        ) : selectedFile ? (
          <ol>
            {selectedFile.lines.map((line, index) => (
              <li key={`${selectedFile.path}:${index + 1}`}>
                <button
                  type="button"
                  onClick={() => onAddContext({
                    id: `line:${selectedFile.path}:${(selectedFile.startLine ?? 1) + index}:${selectedFile.contentHash ?? "current"}`,
                    label: `${selectedFile.path} · L${(selectedFile.startLine ?? 1) + index}`,
                    path: selectedFile.path,
                    contentHash: selectedFile.contentHash,
                    startLine: (selectedFile.startLine ?? 1) + index,
                    endLine: (selectedFile.startLine ?? 1) + index,
                  })}
                  aria-label={`将 ${selectedFile.path} 第 ${(selectedFile.startLine ?? 1) + index} 行加入上下文`}
                >
                  <span>{(selectedFile.startLine ?? 1) + index}</span>
                  <code>{line || " "}</code>
                </button>
              </li>
            ))}
          </ol>
        ) : (
          <div className="project-run-empty">
            <Files size={24} aria-hidden="true" />
            <h3>{loadingFile ? "正在读取文件" : "选择一个文件"}</h3>
            <p>文件正文只会在打开时从本机服务读取。</p>
          </div>
        )}
      </section>
    </div>
  );
}

function ChangeArtifact({
  conversation,
  selectedFileIds,
  onSelectedFileIdsChange,
  onApply,
  applying,
  error,
}) {
  const changeSet = conversation.pendingChangeSet;
  const files = changeSet?.files ?? [];
  const [activeFileId, setActiveFileId] = useState(files[0]?.id ?? null);

  useEffect(() => {
    setActiveFileId(files[0]?.id ?? null);
  }, [changeSet?.id]);

  if (!changeSet || files.length === 0) {
    return (
      <div className="project-run-empty">
        <GitDiff size={24} aria-hidden="true" />
        <h3>还没有待审阅修改</h3>
        <p>Pi 提出文件修改后，精确 Diff 和内容哈希会出现在这里。</p>
      </div>
    );
  }

  const activeFile = files.find((file) => file.id === activeFileId) ?? files[0];
  const selectedFiles = files.filter((file) => selectedFileIds.includes(file.id));
  const canApply = [
    "pending",
    "proposed",
    "ready",
    "awaiting_confirmation",
    "awaiting_approval",
  ].includes(changeSet.status);

  return (
    <div className="project-change-artifact">
      <aside>
        <header>
          <span>修改文件</span>
          <small>
            +{files.reduce((sum, file) => sum + file.additions, 0)}
            {" / "}−{files.reduce((sum, file) => sum + file.deletions, 0)}
          </small>
        </header>
        {files.map((file) => (
          <div
            className={`project-change-file${file.id === activeFile.id ? " is-active" : ""}`}
            key={file.id}
          >
            <label>
              <input
                type="checkbox"
                checked={selectedFileIds.includes(file.id)}
                disabled={!canApply || !file.actionable || applying}
                onChange={() => onSelectedFileIdsChange(
                  selectedFileIds.includes(file.id)
                    ? selectedFileIds.filter((id) => id !== file.id)
                    : [...selectedFileIds, file.id],
                )}
              />
              <button type="button" onClick={() => setActiveFileId(file.id)}>
                <GitDiff size={14} aria-hidden="true" />
                <span>
                  <strong>{file.path}</strong>
                  <small>
                    {OPERATION_LABELS[file.operation] ?? file.operation} · +{file.additions} −{file.deletions}
                  </small>
                </span>
              </button>
            </label>
          </div>
        ))}
      </aside>
      <section className="project-diff-viewer">
        <header>
          <div>
            <strong>{activeFile.path}</strong>
            <small>{OPERATION_LABELS[activeFile.operation] ?? activeFile.operation} · unified diff</small>
          </div>
          <span>{changeSet.status === "applied" ? "已应用" : "待确认"}</span>
        </header>
        <pre>
          {activeFile.diff.map((line, index) => {
            const tone = line.startsWith("+") && !line.startsWith("+++")
              ? "is-added"
              : line.startsWith("-") && !line.startsWith("---")
                ? "is-removed"
                : line.startsWith("@@")
                  ? "is-hunk"
                  : "";
            return <code className={tone} key={`${activeFile.id}:${index}`}>{line}{"\n"}</code>;
          })}
        </pre>
        <div className="project-change-hashes">
          <span>基础版本 <code>{activeFile.baseHash ?? "无（新文件）"}</code></span>
          <span>目标版本 <code>{activeFile.afterHash ?? "无（删除文件）"}</code></span>
          <span>提案 <code>{changeSet.proposalHash ?? "服务端绑定"}</code></span>
        </div>
        <footer className="project-change-confirmation">
          <div>
            <strong>{selectedFiles.length} 个文件待应用</strong>
            <small>服务端会在写入前重新核对每个基础哈希。</small>
            {error ? <span className="project-change-cancelled">{error.message}</span> : null}
          </div>
          {canApply ? (
            <div>
              <button
                className="project-change-confirm"
                type="button"
                disabled={selectedFiles.length === 0 || applying}
                onClick={() => onApply(selectedFiles)}
              >
                {applying ? "正在应用" : "确认应用所选修改"}
              </button>
            </div>
          ) : (
            <span className="project-change-applied">
              <CheckCircle size={15} weight="fill" aria-hidden="true" />
              {changeSet.status === "applied" ? "所选修改已写入并核验" : changeSet.status}
            </span>
          )}
        </footer>
      </section>
    </div>
  );
}

function PreviewArtifact({ preview }) {
  const previewUrl = safeLoopbackPreviewUrl(preview?.url ?? preview?.previewUrl);
  return (
    <div className="project-preview-artifact">
      <header>
        <div>
          <strong>网页预览</strong>
          <small>{previewUrl ? "本机预览地址" : "当前会话没有预览工件"}</small>
        </div>
      </header>
      {previewUrl ? (
        <div className="project-preview-canvas">
          <iframe
            className="live-project-preview-frame"
            src={previewUrl}
            title={preview?.title || "项目网页预览"}
            sandbox="allow-scripts"
          />
        </div>
      ) : (
        <div className="project-run-empty">
          <Code size={24} aria-hidden="true" />
          <h3>当前没有网页预览</h3>
          <p>Pi 只有在真实启动并登记本机预览地址后，才会在这里显示页面。</p>
        </div>
      )}
    </div>
  );
}

function RunArtifact({
  conversation,
  onRunVerification,
  running,
  error,
}) {
  const command = conversation.verificationCommand;
  const changesNeedReview = Boolean(
    conversation.pendingChangeSet?.files?.length
    && [
      "pending",
      "proposed",
      "ready",
      "awaiting_confirmation",
      "awaiting_approval",
    ].includes(conversation.pendingChangeSet.status),
  );
  const runs = conversation.verificationRuns.filter((run) => ![
    "saved",
    "ready",
    "requested",
    "pending_approval",
    "proposed",
  ].includes(run.status));

  return (
    <div className="project-run-artifact">
      <header>
        <div>
          <strong>运行结果</strong>
          <small>只运行 Pi 已保存、用户明确点击的验证命令</small>
        </div>
        {command ? (
          <button
            type="button"
            onClick={onRunVerification}
            disabled={running || changesNeedReview}
            title={changesNeedReview ? "先审阅并应用修改" : "运行已保存的验证命令"}
          >
            {running ? (
              <CircleNotch size={14} weight="bold" aria-hidden="true" />
            ) : (
              <Play size={14} weight="fill" aria-hidden="true" />
            )}
            {running ? "正在运行" : changesNeedReview ? "先审阅修改" : "运行验证"}
          </button>
        ) : null}
      </header>
      {command ? (
        <section className="live-project-saved-command" aria-label="待运行验证命令">
          <strong>{command.label}</strong>
          <code>{command.displayCommand}</code>
          {command.resolvedScript ? (
            <small>实际项目脚本：<code>{command.resolvedScript}</code></small>
          ) : null}
          <small>工作目录：{command.cwdLabel}</small>
          <small>点击后会在工作快照中启动本机进程，并继承当前用户权限。</small>
        </section>
      ) : null}
      {error ? (
        <div className="project-run-empty" role="alert">
          <WarningCircle size={24} aria-hidden="true" />
          <h3>验证没有启动</h3>
          <p>{error.message}</p>
        </div>
      ) : runs.length === 0 ? (
        <section className="project-run-empty">
          <TestTube size={24} aria-hidden="true" />
          <h3>
            {command
              ? changesNeedReview ? "等待修改确认" : "验证命令等待运行"
              : "还没有验证命令"}
          </h3>
          <p>
            {command
              ? changesNeedReview
                ? "先在“更改”中核对并应用修改，验证才会变为可运行。"
                : "确认命令后点击“运行验证”，真实退出码和有界日志会保留在这里。"
              : "Pi 保存验证命令后，这里才会出现可运行操作。"}
          </p>
        </section>
      ) : (
        <div className="project-run-history">
          {runs.map((run, index) => {
            const successful = isSuccessfulRun(run);
            const failed = isFailedRun(run);
            const logs = run.logs.length > 0
              ? run.logs
              : [run.stdout, run.stderr].filter(Boolean);
            return (
              <article
                className={successful ? "is-passed" : failed ? "is-failed" : ""}
                key={run.id}
              >
                <header>
                  {successful ? (
                    <CheckCircle size={18} weight="fill" aria-hidden="true" />
                  ) : failed ? (
                    <WarningCircle size={18} weight="fill" aria-hidden="true" />
                  ) : (
                    <CircleNotch size={18} weight="bold" aria-hidden="true" />
                  )}
                  <div>
                    <strong>验证 {index + 1}</strong>
                    <code>{run.command || command?.displayCommand || "已保存命令"}</code>
                  </div>
                  <span>{run.status}</span>
                </header>
                {run.summary ? <p>{run.summary}</p> : null}
                {run.checks.length > 0 ? (
                  <ul>
                    {run.checks.map((check) => (
                      <li key={check.id}>
                        {check.status === "passed" ? (
                          <Check size={13} weight="bold" aria-hidden="true" />
                        ) : (
                          <X size={13} weight="bold" aria-hidden="true" />
                        )}
                        <span>{check.label}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <details className="project-run-log">
                  <summary>
                    查看日志
                    <CaretDown size={12} aria-hidden="true" />
                  </summary>
                  <pre>{logs.length > 0 ? logs.join("\n") : "命令没有产生输出"}</pre>
                </details>
                <footer>
                  <span>
                    {run.exitCode === null || run.exitCode === undefined
                      ? run.signal || run.status
                      : `退出码 ${run.exitCode}`}
                  </span>
                  <span>{Number.isFinite(run.durationMs) ? `${run.durationMs} ms` : "—"}</span>
                </footer>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ArtifactPane({
  project,
  conversation,
  api,
  activeArtifactId,
  onActiveArtifactChange,
  selectedChangeFileIds,
  onSelectedChangeFileIdsChange,
  onApply,
  applyError,
  applying,
  onRunVerification,
  verificationError,
  verificationRunning,
  requestedFilePath,
  onRequestedFilePathHandled,
  onAddContext,
  onError,
}) {
  const changeCount = conversation.pendingChangeSet?.files?.length ?? 0;
  return (
    <>
      <nav className="reading-artifact-tabs project-artifact-tabs" role="tablist" aria-label="项目工件">
        {ARTIFACTS.map((artifact) => (
          <button
            className={activeArtifactId === artifact.id ? "is-active" : ""}
            type="button"
            role="tab"
            aria-selected={activeArtifactId === artifact.id}
            key={artifact.id}
            onClick={() => onActiveArtifactChange(artifact.id)}
          >
            {artifact.label}
            {artifact.id === "changes" && changeCount > 0 ? <span>{changeCount}</span> : null}
          </button>
        ))}
      </nav>
      <div className="reading-artifact-panels project-artifact-panels">
        <div className="reading-artifact-panel project-artifact-panel">
          {activeArtifactId === "files" ? (
            <FileArtifact
              key={`${project?.id ?? "project"}:${conversation.pendingChangeSet?.id ?? "base"}:${conversation.pendingChangeSet?.status ?? "clean"}`}
              project={project}
              conversationId={conversation.id}
              api={api}
              requestedPath={requestedFilePath}
              onRequestedPathHandled={onRequestedFilePathHandled}
              onAddContext={onAddContext}
              onError={onError}
            />
          ) : activeArtifactId === "changes" ? (
            <ChangeArtifact
              conversation={conversation}
              selectedFileIds={selectedChangeFileIds}
              onSelectedFileIdsChange={onSelectedChangeFileIdsChange}
              onApply={onApply}
              applying={applying}
              error={applyError}
            />
          ) : activeArtifactId === "preview" ? (
            <PreviewArtifact preview={conversation.preview} />
          ) : (
            <RunArtifact
              conversation={conversation}
              onRunVerification={onRunVerification}
              running={verificationRunning}
              error={verificationError}
            />
          )}
        </div>
      </div>
    </>
  );
}

export function LiveProjectWorkbench({
  project = null,
  conversation = null,
  preparingConversation = false,
  providers = [],
  providerId = "",
  modelId = "",
  providerOpen = false,
  onProviderOpenChange,
  onProviderChange,
  onModelChange,
  onOpenSkills,
  installedSkillCount = 0,
  sidebarOpen = true,
  onToggleSidebar,
  api = projectWorkApi,
  pollIntervalMs = 1_000,
  onConversationChange,
  onError,
}) {
  const [snapshot, setSnapshot] = useState(conversation);
  const [draft, setDraft] = useState("");
  const [contextChips, setContextChips] = useState([]);
  const [artifactOpen, setArtifactOpen] = useState(false);
  const [activeArtifactId, setActiveArtifactId] = useState(
    readLastArtifact(
      conversation?.id,
      conversation?.activeArtifactId ?? "files",
    ),
  );
  const [requestedFilePath, setRequestedFilePath] = useState("");
  const [selectedChangeFileIds, setSelectedChangeFileIds] = useState([]);
  const [action, setAction] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [applyError, setApplyError] = useState(null);
  const [verificationError, setVerificationError] = useState(null);
  const snapshotRef = useRef(conversation);
  const conversationChangeRef = useRef(onConversationChange);
  const errorRef = useRef(onError);

  useEffect(() => {
    conversationChangeRef.current = onConversationChange;
    errorRef.current = onError;
  }, [onConversationChange, onError]);

  useEffect(() => {
    snapshotRef.current = conversation;
    setSnapshot(conversation);
    setDraft("");
    setContextChips([]);
    setArtifactOpen(false);
    setActiveArtifactId(readLastArtifact(
      conversation?.id,
      conversation?.activeArtifactId ?? "files",
    ));
    setActionError(null);
    setApplyError(null);
    setVerificationError(null);
  }, [conversation?.id]);

  useEffect(() => {
    setSnapshot((current) => {
      const merged = mergeConversationTitle(current, conversation);
      snapshotRef.current = merged;
      return merged;
    });
  }, [conversation?.id, conversation?.title, conversation?.updatedAt]);

  useEffect(() => {
    writeLastArtifact(snapshot?.id, activeArtifactId);
  }, [activeArtifactId, snapshot?.id]);

  const publishSnapshot = useCallback((nextSnapshot) => {
    if (!nextSnapshot) return;
    const acceptedSnapshot = mergeFreshConversationSnapshot(
      snapshotRef.current,
      nextSnapshot,
    );
    if (acceptedSnapshot !== snapshotRef.current) {
      snapshotRef.current = acceptedSnapshot;
      setSnapshot(acceptedSnapshot);
      conversationChangeRef.current?.(acceptedSnapshot);
    }
    return acceptedSnapshot;
  }, []);

  useEffect(() => {
    const conversationId = snapshot?.id;
    if (!conversationId || !isConversationRunning(snapshot)) return undefined;
    let disposed = false;
    let timeoutId = null;
    let controller = null;

    const poll = async () => {
      controller = new AbortController();
      try {
        const nextSnapshot = await api.fetchConversation({
          conversationId,
          signal: controller.signal,
        });
        if (disposed) return;
        const acceptedSnapshot = publishSnapshot(nextSnapshot);
        if (isConversationRunning(acceptedSnapshot)) {
          timeoutId = window.setTimeout(poll, pollIntervalMs);
        }
      } catch (error) {
        if (disposed || error?.name === "AbortError") return;
        errorRef.current?.(error);
        timeoutId = window.setTimeout(poll, pollIntervalMs);
      }
    };

    timeoutId = window.setTimeout(poll, pollIntervalMs);
    return () => {
      disposed = true;
      window.clearTimeout(timeoutId);
      controller?.abort();
    };
  }, [
    api,
    pollIntervalMs,
    publishSnapshot,
    snapshot?.id,
    snapshot?.status,
    snapshot?.turnStatus,
  ]);

  useEffect(() => {
    const changeSet = snapshot?.pendingChangeSet;
    setSelectedChangeFileIds(
      changeSet?.files
        ?.filter((file) => file.actionable && file.selected !== false)
        .map((file) => file.id) ?? [],
    );
  }, [snapshot?.pendingChangeSet?.id]);

  const executeAction = useCallback(async (name, operation, setLocalError = setActionError) => {
    if (!snapshot?.id || action) return null;
    setAction(name);
    setLocalError(null);
    try {
      const nextSnapshot = await operation();
      return publishSnapshot(nextSnapshot);
    } catch (error) {
      setLocalError(error);
      errorRef.current?.(error);
      return null;
    } finally {
      setAction(null);
    }
  }, [action, publishSnapshot, snapshot?.id]);

  const submitMessage = useCallback((event) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !snapshot?.id || action) return;
    const running = isConversationRunning(snapshot);
    executeAction("message", () => (
      running
        ? api.steerConversation({
            conversationId: snapshot.id,
            text,
          })
        : api.sendMessage({
            conversationId: snapshot.id,
            text,
            contexts: contextChips,
            providerId: providerId || snapshot.providerId,
            modelId: modelId || snapshot.modelId,
          })
    )).then((nextSnapshot) => {
      if (!nextSnapshot) return;
      setDraft("");
      if (!running) setContextChips([]);
    });
  }, [
    action,
    api,
    contextChips,
    draft,
    executeAction,
    modelId,
    providerId,
    snapshot,
  ]);

  const openArtifact = useCallback((artifactId, path = "") => {
    if (!ARTIFACTS.some((artifact) => artifact.id === artifactId)) return;
    setActiveArtifactId(artifactId);
    setArtifactOpen(true);
    if (artifactId === "files" && path) setRequestedFilePath(path);
  }, []);

  const addContext = useCallback((context) => {
    setContextChips((current) => (
      current.some((item) => item.id === context.id) ? current : [...current, context]
    ));
  }, []);

  const applySelectedChanges = useCallback((selectedFiles) => {
    const changeSet = snapshot?.pendingChangeSet;
    if (!changeSet) return;
    executeAction("apply", () => api.applyChangeSet({
      conversationId: snapshot.id,
      changeSetId: changeSet.id,
      proposalHash: changeSet.proposalHash,
      selectedFiles,
    }), setApplyError);
  }, [api, executeAction, snapshot]);

  const runVerification = useCallback(() => {
    const command = snapshot?.verificationCommand;
    if (!command) return;
    openArtifact("run_result");
    executeAction("verification", () => api.runVerification({
      conversationId: snapshot.id,
      commandId: command.id,
    }), setVerificationError);
  }, [api, executeAction, openArtifact, snapshot]);

  const activeProviderId = providerId || snapshot?.providerId;
  const activeProvider = providers.find((provider) => provider.id === activeProviderId)
    ?? providers.find((provider) => provider.available)
    ?? providers[0];
  const activeModelId = modelId || snapshot?.modelId || activeProvider?.models?.[0] || "";
  const headerTitle = (
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
        <span className="workflow-kicker">{project?.name ?? snapshot?.rootLabel ?? "正常工作"}</span>
        <h1>{snapshot?.title ?? "项目工作"}</h1>
      </div>
    </div>
  );
  const headerActions = (
    <>
      {providers.length > 0 ? (
        <ProviderMenu
          open={providerOpen}
          onOpenChange={onProviderOpenChange}
          providers={providers}
          providerId={activeProvider?.id}
          model={activeModelId}
          onProviderChange={onProviderChange}
          onModelChange={onModelChange}
        />
      ) : null}
      {onOpenSkills ? (
        <button className="header-meta-pill header-skill-pill" type="button" onClick={onOpenSkills}>
          <Package size={13} weight="regular" aria-hidden="true" />
          <span>技能 · {installedSkillCount}</span>
        </button>
      ) : null}
    </>
  );

  if (!snapshot) {
    return (
      <AgentArtifactLayout
        ariaLabel="项目工作"
        artifactOpen={false}
        onArtifactOpenChange={() => {}}
        closedLabel="打开工件"
        closedTitle="新建会话后可打开项目工件"
        title={headerTitle}
        headerActions={headerActions}
        agent={(
          <EmptyConversationPane
            project={project}
            preparing={preparingConversation}
          />
        )}
        artifact={null}
      />
    );
  }

  return (
    <AgentArtifactLayout
      ariaLabel="项目工作会话"
      artifactOpen={artifactOpen}
      onArtifactOpenChange={setArtifactOpen}
      closedLabel="打开工件"
      openLabel="收起工件"
      closedTitle="打开右侧项目工件"
      openTitle="收起右侧项目工件"
      resizeLabel="拖拽调整 Agent 与项目工件的宽度"
      title={headerTitle}
      headerActions={headerActions}
      agent={(
        <ProjectAgentPane
          conversation={snapshot}
          draft={draft}
          onDraftChange={setDraft}
          contextChips={contextChips}
          onRemoveContext={(contextId) => setContextChips(
            (current) => current.filter((context) => context.id !== contextId),
          )}
          onSubmit={submitMessage}
          onAbort={() => executeAction("abort", () => api.abortConversation({
            conversationId: snapshot.id,
          }))}
          onCompact={() => executeAction("compact", () => api.compactConversation({
            conversationId: snapshot.id,
          }))}
          onOpenArtifact={openArtifact}
          action={action}
          error={actionError}
          modelLabel={activeModelId}
        />
      )}
      artifact={(
        <ArtifactPane
          project={project}
          conversation={snapshot}
          api={api}
          activeArtifactId={activeArtifactId}
          onActiveArtifactChange={setActiveArtifactId}
          selectedChangeFileIds={selectedChangeFileIds}
          onSelectedChangeFileIdsChange={setSelectedChangeFileIds}
          onApply={applySelectedChanges}
          applyError={applyError}
          applying={action === "apply"}
          onRunVerification={runVerification}
          verificationError={verificationError}
          verificationRunning={action === "verification"
            || snapshot.verificationRuns.some((run) => run.status === "running")}
          requestedFilePath={requestedFilePath}
          onRequestedFilePathHandled={() => setRequestedFilePath("")}
          onAddContext={addContext}
          onError={(error) => errorRef.current?.(error)}
        />
      )}
    />
  );
}
