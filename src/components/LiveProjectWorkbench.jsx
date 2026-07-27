import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  CaretDown,
  CaretRight,
  CaretUp,
  Check,
  CheckCircle,
  CircleNotch,
  Code,
  ArrowClockwise,
  Brain,
  FileCode,
  FilePdf,
  Files,
  Folder,
  Gauge,
  GitDiff,
  GlobeSimple,
  ImageSquare,
  Package,
  Paperclip,
  PaperPlaneTilt,
  Play,
  SidebarSimple,
  StopCircle,
  TestTube,
  UploadSimple,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import {
  projectWorkApi,
  validateProjectWorkImageFile,
} from "../api/projectWork.js";
import { mergeFreshConversationSnapshot } from "../project-work/liveProjectWorkState.js";
import {
  PROJECT_WORK_CAPABILITIES,
  PROJECT_WORK_WORKFLOWS,
  projectWorkCapability,
  projectWorkWorkflow,
} from "../../shared/projectWorkCapabilities.js";
import { AgentArtifactLayout } from "./AgentArtifactLayout.jsx";
import {
  ProviderMenu,
  THINKING_LEVEL_LABELS,
} from "./ProviderMenu.jsx";

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

const PROCESSING_DOCUMENT_STATUSES = new Set([
  "receiving",
  "local_ready",
  "submitting",
  "parsing",
  "preparing",
  "indexing",
]);

const DOCUMENT_STATUS_LABELS = {
  awaiting_upload: "等待上传",
  receiving: "正在上传",
  local_ready: "正在由 MinerU 解析",
  submitting: "正在由 MinerU 解析",
  parsing: "正在由 MinerU 解析",
  preparing: "正在准备可读内容",
  indexing: "正在准备可读内容",
  ready: "已可供 AI 阅读",
  not_configured: "MinerU 尚未配置",
  quota_deferred: "MinerU 今日额度已用完",
  upload_interrupted: "上传未完成",
  failed: "解析失败",
  indexing_failed: "可读内容准备失败",
  removing: "正在移除",
};

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
  compacting: "正在压缩上下文",
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
  list_documents: "查看 PDF 资料",
  search_documents: "搜索 PDF 资料",
  read_document: "读取 PDF 资料",
  search_web: "搜索网页",
  resolve_library_id: "查找技术文档库",
  query_docs: "查询技术文档",
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
  "document.created",
  "document.uploaded",
  "document.parsing_started",
  "document.parsing_progress",
  "document.ready",
  "document.failed",
  "document.retry_requested",
]);

const ARTIFACT_STORAGE_KEY = "pi-agent-project-work-artifacts-v1";
const PROJECT_MARKDOWN_COMPONENTS = {
  a: ({ node: _node, href, children, ...props }) => {
    const opensNewTab = /^https?:\/\//i.test(href ?? "");
    return (
      <a
        {...props}
        href={href}
        {...(opensNewTab ? { target: "_blank", rel: "noreferrer" } : {})}
      >
        {children}
      </a>
    );
  },
};

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

export function hasProcessingDocuments(conversation) {
  return (conversation?.documents ?? []).some(
    (document) => PROCESSING_DOCUMENT_STATUSES.has(document.status),
  );
}

function documentStatusLabel(document) {
  return DOCUMENT_STATUS_LABELS[document?.status] ?? document?.status ?? "等待处理";
}

function formatDocumentSize(byteLength) {
  const bytes = Number(byteLength);
  if (!Number.isFinite(bytes) || bytes < 0) return "大小未知";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

function ProjectAgentMarkdown({ children }) {
  return (
    <div className="project-agent-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={PROJECT_MARKDOWN_COMPONENTS}
        skipHtml
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

export function handleProjectComposerKeyDown(event) {
  if (event.key !== "Enter") return;

  const nativeEvent = event.nativeEvent ?? event;
  if (nativeEvent.isComposing || nativeEvent.keyCode === 229) return;
  if (event.shiftKey) return;

  event.preventDefault();
  if (event.repeat) return;
  event.currentTarget.form?.requestSubmit();
}

function eventTitle(event) {
  if (event.title) return event.title;
  const type = String(event.type || "");
  const tool = TOOL_LABELS[event.toolName] ?? event.toolName ?? "工具";
  if (type === "agent.thinking") {
    return event.status === "active" ? "正在思考" : "思考完成";
  }
  if (type === "conversation.created") return "工作会话已创建";
  if (type === "message.created") return "任务已提交";
  if (type === "message.started") return "Agent 开始回复";
  if (type === "message.completed") return "Agent 回复已完成";
  if (type === "agent.status") return "Agent 状态已更新";
  if (type === "workspace.snapshot_limited") return "大型项目已按安全范围载入";
  if (type === "compaction.started") {
    const trigger = event.reason
      ?? event.trigger
      ?? event.data?.reason
      ?? event.data?.trigger;
    return trigger && trigger !== "manual"
      ? "Pi 正在自动压缩上下文"
      : "开始压缩上下文";
  }
  if (type === "compaction.completed") {
    return event.status === "failed" ? "上下文压缩失败" : "上下文压缩完成";
  }
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
  if (event.type === "agent.thinking") {
    return event.status === "active"
      ? "Pi 正在整理思路"
      : "本轮思考已完成";
  }
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
        <small>{event.type === "agent.thinking" ? "" : `#${event.seq}`}</small>
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

function normalizeActivityEvents(events, running) {
  const safeEvents = Array.isArray(events) ? events : [];
  const latestMessageSeq = safeEvents.reduce((latest, event) => (
    event.type === "message.created" && Number.isSafeInteger(event.seq)
      ? Math.max(latest, event.seq)
      : latest
  ), 0);
  const normalized = [];
  let thinkingEvent = null;

  for (const event of safeEvents) {
    if (
      QUIET_EVENT_TYPES.has(event.type)
      || (latestMessageSeq > 0 && event.seq < latestMessageSeq)
    ) {
      continue;
    }
    if (event.type === "agent.thinking") {
      if (!thinkingEvent) {
        thinkingEvent = {
          ...event,
          activityKey: `thinking-${latestMessageSeq || event.seq}`,
          status: event.status,
        };
        normalized.push(thinkingEvent);
      } else if (event.status === "finished") {
        thinkingEvent.status = "finished";
      }
      continue;
    }
    normalized.push(event);
  }

  if (thinkingEvent) {
    thinkingEvent.status = running ? "active" : "finished";
  }
  return normalized.slice(-100);
}

function ActivityTimeline({
  events,
  running,
  compact,
  onOpenArtifact,
}) {
  const [expanded, setExpanded] = useState(!compact);
  const visibleEvents = normalizeActivityEvents(events, running);

  useEffect(() => {
    setExpanded(!compact);
  }, [compact]);

  if (visibleEvents.length === 0) return null;
  return (
    <section
      className={[
        "project-activity",
        running ? "is-running" : "is-settled",
        compact ? "is-compact" : "",
        expanded ? "is-expanded" : "",
      ].filter(Boolean).join(" ")}
      aria-label="Pi Agent 活动"
    >
      <button
        className="project-activity-toggle"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        {running ? (
          <CircleNotch size={15} weight="bold" aria-hidden="true" />
        ) : (
          <CheckCircle size={15} weight="fill" aria-hidden="true" />
        )}
        <span>
          <strong>{running ? "Agent 正在工作" : "已完成"}</strong>
          <small>
            {running
              ? `${visibleEvents.length} 项实时进展`
              : `${visibleEvents.length} 项 · 查看过程`}
          </small>
        </span>
        <CaretDown size={13} aria-hidden="true" />
      </button>
      <div className="project-activity-body" hidden={!expanded}>
        {visibleEvents.map((event, index) => (
          <ActivityEvent
            event={event}
            isLatest={index === visibleEvents.length - 1}
            key={event.activityKey ?? event.seq}
            onOpenArtifact={onOpenArtifact}
          />
        ))}
      </div>
    </section>
  );
}

function EmptyConversationPane({ project, preparing = false, standalone = false }) {
  return (
    <div className="project-agent">
      <header className="project-agent-header">
        <div>
          <span>{standalone ? "Pi Agent" : "项目 Agent"}</span>
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
            <h2>
              {preparing
                ? "正在准备新工作会话"
                : project
                  ? `在“${project.name}”中新建会话后开始`
                  : "新建对话后开始"}
            </h2>
          </div>
        </section>
      </div>
    </div>
  );
}

export function formatContextTokens(value) {
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value < 1_000) return String(Math.round(value));
  if (value < 100_000) return `${(value / 1_000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

export function ProjectContextUsageMenu({
  open,
  onOpenChange,
  contextUsage,
  modelContextWindow,
  compaction,
  hasAssistantReply,
  running,
  compacting,
  onCompact,
}) {
  const tokens = Number.isFinite(contextUsage?.tokens)
    ? contextUsage.tokens
    : null;
  const contextWindow = Number.isFinite(contextUsage?.contextWindow)
    && contextUsage.contextWindow > 0
    ? contextUsage.contextWindow
    : Number.isFinite(modelContextWindow) && modelContextWindow > 0
      ? modelContextWindow
      : null;
  const percent = Number.isFinite(contextUsage?.percent)
    ? contextUsage.percent
    : null;
  const boundedPercent = percent === null
    ? null
    : Math.min(100, Math.max(0, percent));
  const displayPercent = boundedPercent === null
    ? null
    : Math.round(boundedPercent);
  const recalculating = tokens === null
    && contextUsage?.status === "awaiting_measurement"
    && (
      compaction?.status === "completed"
      || Boolean(compaction?.completedAt)
    );
  const autoEnabled = compaction?.autoEnabled !== false;
  const manualDisabled = !hasAssistantReply || running || compacting || recalculating;
  const manualHint = compacting
    ? "正在压缩上下文"
    : running
      ? "Agent 工作期间不能手动压缩"
      : !hasAssistantReply
        ? "产生首轮回复后可手动压缩"
        : recalculating
          ? "等待下一次模型响应后重新计算"
          : "不必手动操作，也可以等待 Pi 自动压缩";
  const triggerLabel = compacting
    ? "正在压缩"
    : recalculating
      ? "上下文 · 重新计算中"
      : displayPercent === null
        ? "上下文 —"
        : `上下文 ${displayPercent}%`;
  const usageLabel = `${formatContextTokens(tokens)} / ${formatContextTokens(contextWindow)} tokens`;
  const riskClass = boundedPercent !== null && boundedPercent >= 90
    ? " is-critical"
    : boundedPercent !== null && boundedPercent >= 70
      ? " is-warning"
      : "";

  return (
    <div className="provider-menu-wrap project-context-usage-menu">
      {open ? (
        <button
          className="popover-scrim"
          type="button"
          aria-label="关闭上下文用量"
          onClick={() => onOpenChange(false)}
        />
      ) : null}

      <button
        className={`project-composer-tool project-context-usage-trigger${riskClass}`}
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls="project-context-usage-popover"
        aria-label={recalculating
          ? "上下文用量正在重新计算"
          : displayPercent === null
            ? "打开上下文用量"
            : `上下文已使用 ${displayPercent}%`}
        onClick={() => onOpenChange(!open)}
      >
        {compacting ? (
          <CircleNotch className="spin" size={13} weight="bold" aria-hidden="true" />
        ) : (
          <Gauge size={13} weight="regular" aria-hidden="true" />
        )}
        <span>{triggerLabel}</span>
        <CaretUp size={11} weight="bold" aria-hidden="true" />
      </button>

      {open ? (
        <section
          id="project-context-usage-popover"
          className="provider-popover project-context-usage-popover"
          role="dialog"
          aria-labelledby="project-context-usage-title"
        >
          <header className="popover-header">
            <div>
              <strong id="project-context-usage-title">上下文用量</strong>
              <span>当前工作会话</span>
            </div>
            <strong className="project-context-usage-percent">
              {displayPercent === null ? "—" : `${displayPercent}%`}
            </strong>
          </header>

          <div className="project-context-usage-summary">
            <span>{usageLabel}</span>
            <div
              className="project-context-usage-progress"
              role="progressbar"
              aria-label="上下文占用比例"
              aria-valuemin={0}
              aria-valuemax={100}
              {...(displayPercent === null
                ? { "aria-valuetext": recalculating ? "重新计算中" : "尚未计算" }
                : { "aria-valuenow": displayPercent })}
            >
              <span style={{ width: `${boundedPercent ?? 0}%` }} />
            </div>
            {recalculating ? <small>压缩已完成，下一次模型响应后重新计算。</small> : null}
          </div>

          <div className="project-context-auto-row">
            <div>
              <strong>自动压缩</strong>
              <span>接近当前模型上限时，Pi 会自动压缩较早内容。</span>
            </div>
            <span className={autoEnabled ? "is-enabled" : ""}>
              {autoEnabled ? "已开启" : "已关闭"}
            </span>
          </div>

          <p className="project-context-compaction-note">
            不会删除你看到的聊天记录；当前模型会把较早内容总结为有损摘要，
            供后续对话继续使用，并产生一次模型调用。
          </p>
          <button
            className="project-context-compact-button"
            type="button"
            disabled={manualDisabled}
            onClick={() => {
              if (manualDisabled) return;
              onOpenChange(false);
              onCompact();
            }}
          >
            {compacting ? (
              <CircleNotch className="spin" size={14} weight="bold" aria-hidden="true" />
            ) : null}
            {compacting ? "正在压缩上下文" : "立即压缩上下文"}
          </button>
          <small className="project-context-compact-hint">{manualHint}</small>
        </section>
      ) : null}
    </div>
  );
}

export function ProjectThinkingLevelControl({
  thinkingLevels = [],
  thinkingLevel,
  supportsThinking = false,
  running = false,
  saving = false,
  onChange,
}) {
  const levels = thinkingLevels.filter(
    (level) => typeof level === "string" && level,
  );
  const activeLevel = levels.includes(thinkingLevel)
    ? thinkingLevel
    : levels[0] ?? "off";
  const disabled = !supportsThinking || levels.length === 0 || running || saving;
  const hint = !supportsThinking
    ? "当前模型不支持调节思考强度"
    : running
      ? "Agent 工作期间不能切换思考强度"
      : saving
        ? "正在保存思考强度"
        : "选择下一轮使用的思考强度";

  return (
    <label
      className={`project-composer-tool project-composer-thinking${disabled ? " is-disabled" : ""}`}
      title={hint}
    >
      <Brain size={13} weight="regular" aria-hidden="true" />
      <span className="sr-only">思考强度</span>
      <select
        aria-label="思考强度"
        value={activeLevel}
        disabled={disabled}
        onChange={(event) => onChange?.(event.target.value)}
      >
        {!supportsThinking ? (
          <option value="off">思考 · 不支持</option>
        ) : levels.map((level) => (
          <option value={level} key={level}>
            {`思考 · ${THINKING_LEVEL_LABELS[level] ?? level}`}
          </option>
        ))}
      </select>
    </label>
  );
}

function capabilityAvailability(capabilityStatus, capabilityId) {
  const status = capabilityStatus?.[capabilityId];
  return {
    available: status?.available === true,
    reason: typeof status?.reason === "string" && status.reason
      ? status.reason
      : "正在读取服务端配置",
  };
}

export function ProjectCapabilityMenu({
  open,
  onOpenChange,
  capabilityStatus = {},
  selectedCapabilityIds = [],
  onToggleCapability,
  selectedWorkflowId = null,
  onSelectWorkflow,
  supportsImages = false,
  running = false,
  onOpenSkills,
  installedSkillCount = 0,
}) {
  useEffect(() => {
    if (!open) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onOpenChange, open]);

  const selectedCount = selectedCapabilityIds.length
    + (selectedWorkflowId ? 1 : 0);

  return (
    <div className="project-capability-menu">
      <button
        className={`header-meta-pill header-skill-pill${open ? " is-open" : ""}`}
        type="button"
        disabled={running}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => onOpenChange(!open)}
      >
        <Package size={13} weight="regular" aria-hidden="true" />
        <span>{selectedCount > 0 ? `能力 · ${selectedCount}` : "能力"}</span>
        <CaretDown size={11} weight="bold" aria-hidden="true" />
      </button>
      {open ? (
        <>
          <button
            className="popover-scrim"
            type="button"
            aria-label="关闭能力选择"
            onClick={() => onOpenChange(false)}
          />
          <section
            className="project-capability-popover"
            role="dialog"
            aria-label="选择当前消息的能力"
          >
            <header>
              <div>
                <strong>当前消息</strong>
                <span>只在显式发送的这一轮生效</span>
              </div>
              {selectedCount > 0 ? <small>{selectedCount} 项</small> : null}
            </header>

            <div className="project-capability-section">
              <span>检索</span>
              {PROJECT_WORK_CAPABILITIES.map((capability) => {
                const status = capabilityAvailability(
                  capabilityStatus,
                  capability.id,
                );
                const selected = selectedCapabilityIds.includes(capability.id);
                return (
                  <button
                    className={`project-capability-option${selected ? " is-selected" : ""}`}
                    type="button"
                    key={capability.id}
                    disabled={running || !status.available}
                    aria-pressed={selected}
                    onClick={() => onToggleCapability(capability.id)}
                  >
                    <span className="project-capability-option-icon">
                      {capability.id === "web_search" ? (
                        <GlobeSimple size={15} aria-hidden="true" />
                      ) : (
                        <Files size={15} aria-hidden="true" />
                      )}
                    </span>
                    <span>
                      <strong>{capability.label}</strong>
                      <small>
                        {status.available ? capability.description : status.reason}
                      </small>
                    </span>
                    {selected ? (
                      <Check size={14} weight="bold" aria-hidden="true" />
                    ) : null}
                  </button>
                );
              })}
            </div>

            <div className="project-capability-section">
              <span>代码流程</span>
              {PROJECT_WORK_WORKFLOWS.map((workflow) => {
                const missingCapability = workflow.requiredCapabilities?.find(
                  (capabilityId) => (
                    !capabilityAvailability(
                      capabilityStatus,
                      capabilityId,
                    ).available
                  ),
                );
                const unavailableReason = missingCapability
                  ? capabilityAvailability(
                      capabilityStatus,
                      missingCapability,
                    ).reason
                  : workflow.requiresImages && !supportsImages
                    ? "当前模型不支持识图"
                    : "";
                const selected = selectedWorkflowId === workflow.id;
                return (
                  <button
                    className={`project-capability-option${selected ? " is-selected" : ""}`}
                    type="button"
                    key={workflow.id}
                    disabled={running || Boolean(unavailableReason)}
                    aria-pressed={selected}
                    onClick={() => onSelectWorkflow(
                      selected ? null : workflow.id,
                    )}
                  >
                    <span className="project-capability-option-icon">
                      {workflow.requiresImages ? (
                        <ImageSquare size={15} aria-hidden="true" />
                      ) : (
                        <Code size={15} aria-hidden="true" />
                      )}
                    </span>
                    <span>
                      <strong>{workflow.label}</strong>
                      <small>{unavailableReason || workflow.description}</small>
                    </span>
                    {selected ? (
                      <Check size={14} weight="bold" aria-hidden="true" />
                    ) : null}
                  </button>
                );
              })}
            </div>

            <footer>
              <span>
                {running
                  ? "Agent 工作期间不能更换本轮能力"
                  : "未选择时不增加工具或提示词"}
              </span>
              {onOpenSkills ? (
                <button
                  type="button"
                  onClick={() => {
                    onOpenChange(false);
                    onOpenSkills();
                  }}
                >
                  查看内置流程{installedSkillCount > 0
                    ? ` · ${installedSkillCount}`
                    : ""}
                </button>
              ) : null}
            </footer>
          </section>
        </>
      ) : null}
    </div>
  );
}

function canRetryDocument(document) {
  return document?.error?.retryable === true
    && document.status !== "upload_interrupted";
}

function ConversationDocumentStrip({
  documents,
  uploadingPdf,
  onOpenFiles,
  onRetryDocument,
  retryingDocumentId,
}) {
  const activeDocuments = documents.filter((document) => (
    PROCESSING_DOCUMENT_STATUSES.has(document.status)
    || document.error
  ));
  const visibleDocuments = (
    activeDocuments.length > 0 ? activeDocuments : documents.slice(-1)
  ).slice(-3);
  if (!uploadingPdf && visibleDocuments.length === 0) return null;
  return (
    <div className="project-document-statuses" aria-label="会话 PDF 资料状态">
      {uploadingPdf ? (
        <button type="button" onClick={onOpenFiles}>
          <CircleNotch className="spin" size={15} aria-hidden="true" />
          <span>
            <strong>{uploadingPdf.fileName}</strong>
            <small>正在上传 · 将发送至 MinerU Cloud</small>
          </span>
        </button>
      ) : null}
      {visibleDocuments.map((document) => (
        <div
          className={`project-document-status is-${document.status}`}
          key={document.id}
        >
          <button type="button" onClick={onOpenFiles}>
            {PROCESSING_DOCUMENT_STATUSES.has(document.status) ? (
              <CircleNotch className="spin" size={15} aria-hidden="true" />
            ) : document.status === "ready" ? (
              <CheckCircle size={15} weight="fill" aria-hidden="true" />
            ) : (
              <WarningCircle size={15} weight="fill" aria-hidden="true" />
            )}
            <span>
              <strong>{document.fileName}</strong>
              <small>
                {document.error?.message ?? documentStatusLabel(document)}
              </small>
            </span>
          </button>
          {canRetryDocument(document) ? (
            <button
              className="project-document-retry"
              type="button"
              disabled={retryingDocumentId === document.id}
              onClick={() => onRetryDocument(document.id)}
              aria-label={`重试解析 ${document.fileName}`}
              title="重试 MinerU 解析"
            >
              {retryingDocumentId === document.id ? (
                <CircleNotch className="spin" size={13} aria-hidden="true" />
              ) : (
                <ArrowClockwise size={13} aria-hidden="true" />
              )}
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function ProjectAgentPane({
  conversation,
  draft,
  onDraftChange,
  contextChips,
  onRemoveContext,
  selectedCapabilityIds,
  onRemoveCapability,
  selectedWorkflowId,
  onRemoveWorkflow,
  pendingImage,
  onRemoveImage,
  imageInputRef,
  onSelectImage,
  supportsImages,
  onSubmit,
  onAbort,
  onOpenArtifact,
  action,
  error,
  modelLabel,
  thinkingLevelControl,
  contextUsageControl,
  pdfInputRef,
  uploadingPdf,
  onUploadPdf,
  onRetryDocument,
  retryingDocumentId,
  standalone = false,
}) {
  const running = isConversationRunning(conversation);
  const turnPayloadLocked = action === "message";
  const status = activeStatus(conversation);
  const statusLabel = STATUS_LABELS[status] ?? status;
  const selectedWorkflow = projectWorkWorkflow(selectedWorkflowId);
  const selectedCapabilities = selectedCapabilityIds
    .map(projectWorkCapability)
    .filter(Boolean);
  const imageUnsupported = Boolean(pendingImage) && !supportsImages;
  const workflowImageMissing = selectedWorkflow?.requiresImages === true
    && !pendingImage;
  const turnSelectionDeferred = running && Boolean(
    pendingImage
    || selectedWorkflow
    || selectedCapabilities.length > 0,
  );
  const canSubmit = Boolean(
    draft.trim()
    && !action
    && !imageUnsupported
    && !workflowImageMissing
    && !turnSelectionDeferred,
  );
  const limitedSnapshotEvent = conversation.events.find(
    (event) => event.type === "workspace.snapshot_limited",
  );
  const snapshotIsLimited = conversation.workspaceSnapshot?.truncated === true
    || Boolean(limitedSnapshotEvent);
  const includedFiles = conversation.workspaceSnapshot?.includedFiles
    ?? limitedSnapshotEvent?.data?.snapshot?.includedFiles;
  const lastAssistantMessageIndex = conversation.messages.reduce(
    (latest, message, index) => (
      message.role === "assistant" && messageText(message.content)
        ? index
        : latest
    ),
    -1,
  );
  const settledWithAnswer = !running && lastAssistantMessageIndex >= 0;
  const processBlock = (compact) => (
    <>
      <PlanCard plan={conversation.plan} />
      <ActivityTimeline
        events={conversation.events}
        running={running}
        compact={compact}
        onOpenArtifact={onOpenArtifact}
      />
    </>
  );

  return (
    <div className="project-agent">
      <header className="project-agent-header">
        <div>
          <span>{standalone ? "Pi Agent" : "项目 Agent"}</span>
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
          ) : null}
          <span className={`project-agent-status is-${statusClass(conversation)}`}>
            <span aria-hidden="true" />
            {statusLabel}
          </span>
        </div>
      </header>

      <div className="project-agent-stream">
        {!standalone && snapshotIsLimited ? (
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
              <p>
                {standalone
                  ? "当前对话未连接本地文件夹。Pi 只能访问这个对话的私有草稿区，并公开实际工具活动。"
                  : "Pi 会读取当前项目、公开实际工具活动，并把修改留到右侧等待确认。"}
              </p>
            </div>
            <div className="project-agent-scope">
              <span>{standalone ? "未连接本地文件夹" : "真实项目上下文"}</span>
              {standalone ? <span>私有草稿区</span> : null}
              <span>修改先审阅</span>
              {!standalone ? <span>命令显式运行</span> : null}
            </div>
          </section>
        ) : (
          conversation.messages.map((message, index) => {
            const text = messageText(message.content);
            const messageImages = Array.isArray(message.images)
              ? message.images
              : [];
            if (!text && messageImages.length === 0) return null;
            return (
              <Fragment key={message.id}>
                {settledWithAnswer && index === lastAssistantMessageIndex
                  ? processBlock(true)
                  : null}
                <article
                  className={`project-agent-message is-${message.role} is-${message.kind}`}
                >
                  <small>{message.role === "user" ? "你" : "Pi Agent"}</small>
                  {message.role === "assistant" ? (
                    <ProjectAgentMarkdown>{text}</ProjectAgentMarkdown>
                  ) : messageImages.length > 0 ? (
                    <div className="project-agent-user-message-content">
                      {text ? (
                        <div className="project-agent-plain-text">{text}</div>
                      ) : null}
                      <div className="project-agent-message-images">
                        {messageImages.map((image, imageIndex) => (
                          <span key={image.id ?? `${message.id}-image-${imageIndex}`}>
                            <ImageSquare size={13} aria-hidden="true" />
                            图片 · {image.fileName || "图片"}
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="project-agent-plain-text">{text}</div>
                  )}
                </article>
              </Fragment>
            );
          })
        )}

        {settledWithAnswer ? null : processBlock(!running)}
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
              <strong>
                {standalone
                  ? "修改已经准备好，尚未保存到私有草稿区"
                  : "修改已经准备好，尚未写入项目"}
              </strong>
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
        <ConversationDocumentStrip
          documents={conversation.documents ?? []}
          uploadingPdf={uploadingPdf}
          onOpenFiles={() => onOpenArtifact("files")}
          onRetryDocument={onRetryDocument}
          retryingDocumentId={retryingDocumentId}
        />
        {contextChips.length > 0 ? (
          <>
            <div className="project-context-chips" aria-label="本条消息的文件上下文">
              {contextChips.map((context) => (
                <span key={context.id}>
                  <FileCode size={13} aria-hidden="true" />
                  {context.label}
                  <button
                    type="button"
                    disabled={turnPayloadLocked}
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
        {selectedWorkflow || selectedCapabilities.length > 0 ? (
          <div className="project-turn-chips" aria-label="当前消息使用的能力">
            {selectedWorkflow ? (
              <span className="is-workflow">
                <Code size={13} aria-hidden="true" />
                流程 · {selectedWorkflow.label}
                <button
                  type="button"
                  disabled={running || turnPayloadLocked}
                  onClick={onRemoveWorkflow}
                  aria-label={`移除流程：${selectedWorkflow.label}`}
                >
                  <X size={12} weight="bold" aria-hidden="true" />
                </button>
              </span>
            ) : null}
            {selectedCapabilities.map((capability) => (
              <span key={capability.id}>
                {capability.id === "web_search" ? (
                  <GlobeSimple size={13} aria-hidden="true" />
                ) : (
                  <Files size={13} aria-hidden="true" />
                )}
                {capability.label}
                <button
                  type="button"
                  disabled={running || turnPayloadLocked}
                  onClick={() => onRemoveCapability(capability.id)}
                  aria-label={`移除能力：${capability.label}`}
                >
                  <X size={12} weight="bold" aria-hidden="true" />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        {pendingImage ? (
          <div className="project-pending-image">
            {pendingImage.previewUrl ? (
              <img src={pendingImage.previewUrl} alt="" />
            ) : (
              <span><ImageSquare size={18} aria-hidden="true" /></span>
            )}
            <div>
              <strong>{pendingImage.file.name}</strong>
              <small>仅随当前消息发送</small>
            </div>
            <button
              type="button"
              disabled={running || turnPayloadLocked}
              onClick={onRemoveImage}
              aria-label={`移除图片：${pendingImage.file.name}`}
            >
              <X size={13} weight="bold" aria-hidden="true" />
            </button>
          </div>
        ) : null}
        {imageUnsupported || workflowImageMissing || turnSelectionDeferred ? (
          <small className="project-composer-warning" role="status">
            <WarningCircle size={13} weight="fill" aria-hidden="true" />
            {imageUnsupported
              ? "当前模型不能看图，请切换支持图片的模型"
              : workflowImageMissing
                ? "截图验收需要先添加一张图片"
                : "当前 Agent 完成后再发送所选能力或图片"}
          </small>
        ) : null}
        <label>
          <span className="sr-only">给 Agent 的消息</span>
          <textarea
            value={draft}
            disabled={
              turnPayloadLocked
              || action === "abort"
              || action === "compact"
            }
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={handleProjectComposerKeyDown}
            aria-keyshortcuts="Enter"
            placeholder={running
              ? "补充方向，会作为 steer 发送给当前 Agent"
              : standalone
                ? "描述希望 Pi 完成的任务"
                : "描述希望 Pi 完成的项目任务"}
          />
        </label>
        <footer>
          <div className="project-composer-meta">
            <div className="project-composer-tools">
              <button
                className="project-composer-tool project-composer-attachment"
                type="button"
                onClick={() => onOpenArtifact("files")}
              >
                <Paperclip size={13} aria-hidden="true" />
                添加文件
              </button>
              <button
                className="project-composer-tool project-composer-attachment"
                type="button"
                disabled={Boolean(uploadingPdf)}
                onClick={() => pdfInputRef.current?.click()}
                title="选择 PDF 后将上传至 MinerU Cloud 解析"
              >
                {uploadingPdf ? (
                  <CircleNotch className="spin" size={13} aria-hidden="true" />
                ) : (
                  <UploadSimple size={13} aria-hidden="true" />
                )}
                上传 PDF
              </button>
              <button
                className="project-composer-tool project-composer-attachment"
                type="button"
                disabled={running || turnPayloadLocked}
                onClick={() => imageInputRef.current?.click()}
                title="为当前消息添加一张 PNG、JPEG 或 WebP 图片"
              >
                <ImageSquare size={13} aria-hidden="true" />
                添加图片
              </button>
              <input
                className="sr-only"
                ref={pdfInputRef}
                type="file"
                accept=".pdf,application/pdf"
                aria-label="选择要交给 MinerU Cloud 解析的 PDF"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) onUploadPdf(file);
                }}
              />
              <input
                className="sr-only"
                ref={imageInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                disabled={running || turnPayloadLocked}
                aria-label="为当前消息选择一张图片"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) onSelectImage(file);
                }}
              />
              <span className="project-composer-model">
                {modelLabel || (standalone ? "跟随默认模型" : "跟随项目默认模型")}
              </span>
              {thinkingLevelControl}
              {contextUsageControl}
            </div>
            <small>
              {running ? "发送会调整当前 Agent 的方向" : "只有显式发送才开始工作"}
              {" · Enter 发送 · Shift+Enter 换行"}
            </small>
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
  conversationId,
  standalone = false,
  documents = [],
  api,
  selectedPath,
  requestedPath,
  onRequestedPathHandled,
  onAddContext,
  onRetryDocument,
  retryingDocumentId,
  onRemoveDocument,
  removingDocumentId,
  onError,
}) {
  const [entries, setEntries] = useState([]);
  const [expandedPaths, setExpandedPaths] = useState([]);
  const [activePath, setActivePath] = useState(selectedPath ?? "");
  const [activeDocumentId, setActiveDocumentId] = useState("");
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
    if (!conversationId || loadedDirectories.current.has(path)) return;
    setLoadingTree(true);
    setError(null);
    try {
      const tree = await api.fetchTree({ conversationId, path });
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
  }, [api, conversationId, reportError]);

  const loadFile = useCallback(async (path) => {
    if (!conversationId || !path) return;
    setActiveDocumentId("");
    setActivePath(path);
    if (fileCache[path]) return;
    fileAbort.current?.abort();
    const controller = new AbortController();
    fileAbort.current = controller;
    setLoadingFile(true);
    setError(null);
    try {
      const file = await api.fetchFile({
        conversationId,
        path,
        signal: controller.signal,
      });
      setFileCache((current) => ({ ...current, [path]: file }));
    } catch (nextError) {
      if (nextError?.name !== "AbortError") reportError(nextError);
    } finally {
      if (fileAbort.current === controller) setLoadingFile(false);
    }
  }, [api, conversationId, fileCache, reportError]);

  useEffect(() => {
    loadedDirectories.current = new Set();
    fileAbort.current?.abort();
    setEntries([]);
    setExpandedPaths([]);
    setActivePath("");
    setActiveDocumentId("");
    setFileCache({});
    setError(null);
    loadDirectory("");
    return () => fileAbort.current?.abort();
  }, [conversationId, loadDirectory]);

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
  const selectedDocument = documents.find(
    (document) => document.id === activeDocumentId,
  ) ?? null;

  return (
    <div className="project-file-artifact">
      <aside aria-label={standalone ? "私有草稿文件" : "项目文件"}>
        {documents.length > 0 ? (
          <>
            <div className="project-file-section-heading">
              <FilePdf size={15} aria-hidden="true" />
              会话资料
            </div>
            {documents.map((document) => (
              <button
                className={`project-document-file${
                  document.id === activeDocumentId ? " is-active" : ""
                }`}
                type="button"
                key={document.id}
                onClick={() => {
                  setActivePath("");
                  setActiveDocumentId(document.id);
                }}
              >
                <FilePdf size={15} aria-hidden="true" />
                <span>
                  <strong>{document.fileName}</strong>
                  <small>{documentStatusLabel(document)}</small>
                </span>
              </button>
            ))}
          </>
        ) : null}
        <header>
          <Files size={15} aria-hidden="true" />
          {loadingTree
            ? "正在读取文件"
            : standalone
              ? "私有草稿文件"
              : "项目文件"}
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
          <p className="live-project-inline-empty">
            {standalone
              ? "私有草稿区中还没有文件。"
              : "项目中没有可显示的文件。"}
          </p>
        ) : null}
      </aside>
      <section className="project-code-viewer">
        <header>
          <div>
            <strong>
              {selectedDocument?.fileName || activePath || "选择一个文件"}
            </strong>
            <small>
              {selectedDocument
                ? `${documentStatusLabel(selectedDocument)} · ${
                    formatDocumentSize(selectedDocument.byteLength)
                  }`
                : selectedFile
                ? `${selectedFile.language.toUpperCase()} · 只读${selectedFile.truncated ? " · 已截断" : ""}`
                : loadingFile
                  ? "正在读取文件"
                  : "文件内容按需读取"}
            </small>
          </div>
          {selectedDocument && canRetryDocument(selectedDocument) ? (
            <button
              type="button"
              disabled={retryingDocumentId === selectedDocument.id}
              onClick={() => onRetryDocument(selectedDocument.id)}
            >
              {retryingDocumentId === selectedDocument.id
                ? "正在重试"
                : "重试解析"}
            </button>
          ) : selectedFile && !selectedFile.binary ? (
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
        {selectedDocument ? (
          <div className="project-document-detail">
            <div className={`project-document-detail-icon is-${selectedDocument.status}`}>
              {PROCESSING_DOCUMENT_STATUSES.has(selectedDocument.status) ? (
                <CircleNotch className="spin" size={24} aria-hidden="true" />
              ) : selectedDocument.status === "ready" ? (
                <CheckCircle size={24} weight="fill" aria-hidden="true" />
              ) : (
                <FilePdf size={24} aria-hidden="true" />
              )}
            </div>
            <div>
              <span>MinerU Cloud v4</span>
              <h3>{documentStatusLabel(selectedDocument)}</h3>
              <p>
                {selectedDocument.error?.message
                  ?? (selectedDocument.status === "ready"
                    ? Number(selectedDocument.imageCount) > 0
                      ? `Pi 已可按需读取解析正文。PDF 中保留了 ${selectedDocument.imageCount} 张图像，但本版资料工具暂不解读这些图像。`
                      : "解析正文保存在当前会话中。下一次明确发送任务时，Pi 可以通过只读资料工具按需检索和阅读。"
                    : "PDF 已与项目文件和待应用修改隔离；解析过程不会自动调用模型。")}
              </p>
            </div>
            <dl>
              <div>
                <dt>文件</dt>
                <dd>{selectedDocument.fileName}</dd>
              </div>
              <div>
                <dt>大小</dt>
                <dd>{formatDocumentSize(selectedDocument.byteLength)}</dd>
              </div>
              {selectedDocument.title ? (
                <div>
                  <dt>解析标题</dt>
                  <dd>{selectedDocument.title}</dd>
                </div>
              ) : null}
              {Number.isSafeInteger(selectedDocument.blockCount) ? (
                <div>
                  <dt>可读内容块</dt>
                  <dd>{selectedDocument.blockCount}</dd>
                </div>
              ) : null}
            </dl>
            {!PROCESSING_DOCUMENT_STATUSES.has(selectedDocument.status) ? (
              <button
                className="project-document-remove"
                type="button"
                disabled={removingDocumentId === selectedDocument.id}
                onClick={() => onRemoveDocument(selectedDocument)}
              >
                {removingDocumentId === selectedDocument.id
                  ? "正在移除"
                  : "移除这份会话资料"}
              </button>
            ) : null}
          </div>
        ) : error ? (
          <div className="project-run-empty" role="alert">
            <WarningCircle size={24} aria-hidden="true" />
            <h3>{standalone ? "无法读取草稿文件" : "无法读取项目文件"}</h3>
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
  onRetryDocument,
  retryingDocumentId,
  onRemoveDocument,
  removingDocumentId,
  onError,
}) {
  const changeCount = conversation.pendingChangeSet?.files?.length ?? 0;
  const standalone = conversation.scope === "standalone"
    || conversation.workspaceKind === "scratch"
    || conversation.projectId === null;
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
              key={`${conversation.id}:${conversation.pendingChangeSet?.id ?? "base"}:${conversation.pendingChangeSet?.status ?? "clean"}`}
              conversationId={conversation.id}
              standalone={standalone}
              documents={conversation.documents ?? []}
              api={api}
              requestedPath={requestedFilePath}
              onRequestedPathHandled={onRequestedFilePathHandled}
              onAddContext={onAddContext}
              onRetryDocument={onRetryDocument}
              retryingDocumentId={retryingDocumentId}
              onRemoveDocument={onRemoveDocument}
              removingDocumentId={removingDocumentId}
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
  modelContextWindow = null,
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
  const [contextUsageOpen, setContextUsageOpen] = useState(false);
  const [capabilityOpen, setCapabilityOpen] = useState(false);
  const [selectedCapabilityIds, setSelectedCapabilityIds] = useState([]);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState(null);
  const [pendingImage, setPendingImage] = useState(null);
  const [modelCatalog, setModelCatalog] = useState({
    providers: [],
    defaultThinkingLevel: null,
    capabilities: {},
  });
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
  const [uploadingPdf, setUploadingPdf] = useState(null);
  const snapshotRef = useRef(conversation);
  const conversationChangeRef = useRef(onConversationChange);
  const errorRef = useRef(onError);
  const pdfInputRef = useRef(null);
  const imageInputRef = useRef(null);
  const pdfUploadAbort = useRef(null);
  const pendingImageRef = useRef(null);

  const replacePendingImage = useCallback((nextImage) => {
    const current = pendingImageRef.current;
    if (
      current?.previewUrl
      && typeof globalThis.URL?.revokeObjectURL === "function"
    ) {
      globalThis.URL.revokeObjectURL(current.previewUrl);
    }
    pendingImageRef.current = nextImage;
    setPendingImage(nextImage);
  }, []);

  useEffect(() => {
    conversationChangeRef.current = onConversationChange;
    errorRef.current = onError;
  }, [onConversationChange, onError]);

  useEffect(() => () => {
    pdfUploadAbort.current?.abort();
    const image = pendingImageRef.current;
    if (
      image?.previewUrl
      && typeof globalThis.URL?.revokeObjectURL === "function"
    ) {
      globalThis.URL.revokeObjectURL(image.previewUrl);
    }
    pendingImageRef.current = null;
  }, []);

  useEffect(() => {
    if (typeof api.listModels !== "function") return undefined;
    const controller = new AbortController();
    api.listModels({ signal: controller.signal }).then((catalog) => {
      setModelCatalog(catalog);
    }).catch((error) => {
      if (error?.name !== "AbortError") errorRef.current?.(error);
    });
    return () => controller.abort();
  }, [api]);

  useEffect(() => {
    pdfUploadAbort.current?.abort();
    pdfUploadAbort.current = null;
    snapshotRef.current = conversation;
    setSnapshot(conversation);
    setDraft("");
    setContextChips([]);
    setArtifactOpen(false);
    setContextUsageOpen(false);
    setCapabilityOpen(false);
    setSelectedCapabilityIds([]);
    setSelectedWorkflowId(null);
    replacePendingImage(null);
    setActiveArtifactId(readLastArtifact(
      conversation?.id,
      conversation?.activeArtifactId ?? "files",
    ));
    setActionError(null);
    setApplyError(null);
    setVerificationError(null);
    setUploadingPdf(null);
  }, [conversation?.id, replacePendingImage]);

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

  useEffect(() => {
    if (!contextUsageOpen) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === "Escape") setContextUsageOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [contextUsageOpen]);

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

  const shouldPollConversation = Boolean(
    snapshot?.id
    && (isConversationRunning(snapshot) || hasProcessingDocuments(snapshot)),
  );

  useEffect(() => {
    const conversationId = snapshot?.id;
    if (!conversationId || !shouldPollConversation) return undefined;
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
        if (
          isConversationRunning(acceptedSnapshot)
          || hasProcessingDocuments(acceptedSnapshot)
        ) {
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
    shouldPollConversation,
    snapshot?.id,
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

  const activeProviderId = providerId || snapshot?.providerId;
  const activeProvider = providers.find((provider) => provider.id === activeProviderId)
    ?? providers.find((provider) => provider.available)
    ?? providers[0];
  const activeModelId = modelId || snapshot?.modelId || activeProvider?.models?.[0] || "";
  const activeModelInfo = modelCatalog.providers
    .find((provider) => provider.id === activeProviderId)
    ?.models.find((model) => model.id === activeModelId);
  const supportsImages = activeModelInfo?.supportsImages === true;
  const availableThinkingLevels = activeModelInfo?.thinkingLevels ?? [];
  const activeThinkingLevel = availableThinkingLevels.includes(
    snapshot?.thinkingLevel,
  )
    ? snapshot.thinkingLevel
    : availableThinkingLevels.includes(activeModelInfo?.defaultThinkingLevel)
      ? activeModelInfo.defaultThinkingLevel
      : availableThinkingLevels.includes(modelCatalog.defaultThinkingLevel)
        ? modelCatalog.defaultThinkingLevel
        : availableThinkingLevels[0] ?? snapshot?.thinkingLevel ?? null;

  const submitMessage = useCallback((event) => {
    event.preventDefault();
    const submittedDraft = draft;
    const text = submittedDraft.trim();
    if (!text || !snapshot?.id || action) return;
    const running = isConversationRunning(snapshot);
    if (
      running
      && (
        pendingImage
        || selectedWorkflowId
        || selectedCapabilityIds.length > 0
      )
    ) {
      return;
    }
    if (
      pendingImage
      && !supportsImages
    ) {
      return;
    }
    if (
      projectWorkWorkflow(selectedWorkflowId)?.requiresImages
      && !pendingImage
    ) {
      return;
    }
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
            images: pendingImage ? [pendingImage.file] : [],
            capabilities: selectedCapabilityIds,
            workflowId: selectedWorkflowId,
            providerId: providerId || snapshot.providerId,
            modelId: modelId || snapshot.modelId,
            thinkingLevel: activeThinkingLevel,
          })
    )).then((nextSnapshot) => {
      if (!nextSnapshot) return;
      setDraft((current) => (
        current === submittedDraft ? "" : current
      ));
      if (!running) {
        setContextChips([]);
        setSelectedCapabilityIds([]);
        setSelectedWorkflowId(null);
        replacePendingImage(null);
      }
    });
  }, [
    action,
    api,
    contextChips,
    draft,
    executeAction,
    modelId,
    pendingImage,
    providerId,
    replacePendingImage,
    selectedCapabilityIds,
    selectedWorkflowId,
    supportsImages,
    activeThinkingLevel,
    snapshot,
  ]);

  const selectImage = useCallback((file) => {
    if (action === "message") return;
    try {
      validateProjectWorkImageFile(file);
      const previewUrl = typeof globalThis.URL?.createObjectURL === "function"
        ? globalThis.URL.createObjectURL(file)
        : "";
      replacePendingImage({ file, previewUrl });
      setActionError(null);
    } catch (error) {
      setActionError(error);
      errorRef.current?.(error);
    }
  }, [action, replacePendingImage]);

  const openArtifact = useCallback((artifactId, path = "") => {
    if (!ARTIFACTS.some((artifact) => artifact.id === artifactId)) return;
    setActiveArtifactId(artifactId);
    setArtifactOpen(true);
    if (artifactId === "files" && path) setRequestedFilePath(path);
  }, []);

  const uploadPdf = useCallback(async (file) => {
    if (!snapshot?.id || uploadingPdf || typeof api.uploadPdf !== "function") return;
    const controller = new AbortController();
    pdfUploadAbort.current?.abort();
    pdfUploadAbort.current = controller;
    setUploadingPdf({
      fileName: file.name,
      byteLength: file.size,
    });
    setActionError(null);
    try {
      const nextSnapshot = await api.uploadPdf({
        conversationId: snapshot.id,
        file,
        signal: controller.signal,
      });
      publishSnapshot(nextSnapshot);
      openArtifact("files");
    } catch (error) {
      if (error?.name === "AbortError") return;
      setActionError(error);
      errorRef.current?.(error);
      try {
        const refreshed = await api.fetchConversation({
          conversationId: snapshot.id,
        });
        publishSnapshot(refreshed);
      } catch {
        // The original upload error remains the useful user-facing result.
      }
    } finally {
      if (pdfUploadAbort.current === controller) {
        pdfUploadAbort.current = null;
        setUploadingPdf(null);
      }
    }
  }, [
    api,
    openArtifact,
    publishSnapshot,
    snapshot?.id,
    uploadingPdf,
  ]);

  const retryDocument = useCallback((documentId) => {
    if (!documentId || typeof api.retryPdf !== "function") return;
    executeAction(
      `document-retry:${documentId}`,
      () => api.retryPdf({
        conversationId: snapshot.id,
        documentId,
      }),
    );
  }, [api, executeAction, snapshot?.id]);

  const removeDocument = useCallback((document) => {
    if (!document?.id || typeof api.removePdf !== "function") return;
    const confirmed = typeof window === "undefined" || window.confirm(
      `移除“${document.fileName}”？\n\n这会删除 Pi Agent 当前会话中的本地 PDF 和解析结果，不代表删除 MinerU Cloud 上的副本。`,
    );
    if (!confirmed) return;
    executeAction(
      `document-remove:${document.id}`,
      () => api.removePdf({
        conversationId: snapshot.id,
        documentId: document.id,
      }),
    );
  }, [api, executeAction, snapshot?.id]);

  const addContext = useCallback((context) => {
    if (action === "message") return;
    setContextChips((current) => (
      current.some((item) => item.id === context.id) ? current : [...current, context]
    ));
  }, [action]);

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

  const compactContext = useCallback(() => (
    executeAction("compact", () => api.compactConversation({
      conversationId: snapshot.id,
    }))
  ), [api, executeAction, snapshot?.id]);

  const standalone = snapshot?.scope === "standalone"
    || snapshot?.workspaceKind === "scratch"
    || snapshot?.projectId === null;
  const compacting = action === "compact"
    || activeStatus(snapshot) === "compacting"
    || snapshot?.compaction?.status === "running";
  const hasAssistantReply = snapshot?.messages?.some(
    (message) => message.role === "assistant" && Boolean(messageText(message.content)),
  ) === true;
  const conversationRunning = snapshot ? isConversationRunning(snapshot) : false;
  const turnPayloadLocked = action === "message";
  const retryingDocumentId = action?.startsWith("document-retry:")
    ? action.slice("document-retry:".length)
    : null;
  const removingDocumentId = action?.startsWith("document-remove:")
    ? action.slice("document-remove:".length)
    : null;
  const thinkingSaving = action === "thinking-level";
  const thinkingBusy = conversationRunning || Boolean(action && !thinkingSaving);
  const thinkingHint = activeModelInfo?.supportsThinking !== true
    ? "当前模型不支持调节思考强度"
    : conversationRunning
      ? "Agent 工作期间不能切换思考强度"
      : thinkingSaving
        ? "正在保存思考强度"
        : thinkingBusy
          ? "当前操作完成后可切换思考强度"
          : "选择下一轮使用的思考强度";
  const showGptThinking = activeProviderId === "openai-codex"
    && Boolean(activeModelId);
  const changeThinkingLevel = useCallback((nextThinkingLevel) => {
    if (
      conversationRunning
      || !snapshot?.id
      || action
      || !availableThinkingLevels.includes(nextThinkingLevel)
      || typeof api.configureConversation !== "function"
    ) {
      return;
    }
    executeAction("thinking-level", () => api.configureConversation({
      conversationId: snapshot.id,
      providerId: activeProviderId,
      modelId: activeModelId,
      thinkingLevel: nextThinkingLevel,
    }));
  }, [
    action,
    activeModelId,
    activeProviderId,
    api,
    availableThinkingLevels,
    conversationRunning,
    executeAction,
    snapshot?.id,
  ]);
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
        <span className="workflow-kicker">
          {standalone ? "独立对话" : project?.name ?? snapshot?.rootLabel ?? "正常工作"}
        </span>
        <h1>{snapshot?.title ?? "项目工作"}</h1>
      </div>
    </div>
  );
  const headerActions = (
    <>
      {providers.length > 0 ? (
        <ProviderMenu
          open={providerOpen}
          onOpenChange={(open) => {
            if (open) {
              setContextUsageOpen(false);
              setCapabilityOpen(false);
            }
            onProviderOpenChange?.(open);
          }}
          providers={providers}
          providerId={activeProvider?.id}
          model={activeModelId}
          onProviderChange={onProviderChange}
          onModelChange={onModelChange}
          thinkingLevels={showGptThinking ? availableThinkingLevels : null}
          thinkingLevel={activeThinkingLevel}
          supportsThinking={activeModelInfo?.supportsThinking === true}
          thinkingDisabled={thinkingBusy || thinkingSaving}
          thinkingHint={thinkingHint}
          onThinkingLevelChange={changeThinkingLevel}
        />
      ) : null}
      <ProjectCapabilityMenu
        open={capabilityOpen}
        onOpenChange={(open) => {
          if (turnPayloadLocked && open) return;
          setCapabilityOpen(open);
          if (open) {
            setContextUsageOpen(false);
            onProviderOpenChange?.(false);
          }
        }}
        capabilityStatus={modelCatalog.capabilities}
        selectedCapabilityIds={selectedCapabilityIds}
        onToggleCapability={(capabilityId) => {
          if (turnPayloadLocked) return;
          setSelectedCapabilityIds((current) => (
            current.includes(capabilityId)
              ? current.filter((id) => id !== capabilityId)
              : [...current, capabilityId]
          ));
        }}
        selectedWorkflowId={selectedWorkflowId}
        onSelectWorkflow={(workflowId) => {
          if (!turnPayloadLocked) setSelectedWorkflowId(workflowId);
        }}
        supportsImages={supportsImages}
        running={conversationRunning || turnPayloadLocked}
        onOpenSkills={onOpenSkills}
        installedSkillCount={installedSkillCount}
      />
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
            standalone={!project}
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
          onDraftChange={(nextDraft) => {
            if (!turnPayloadLocked) setDraft(nextDraft);
          }}
          contextChips={contextChips}
          onRemoveContext={(contextId) => {
            if (turnPayloadLocked) return;
            setContextChips(
              (current) => current.filter((context) => context.id !== contextId),
            );
          }}
          selectedCapabilityIds={selectedCapabilityIds}
          onRemoveCapability={(capabilityId) => {
            if (turnPayloadLocked) return;
            setSelectedCapabilityIds(
              (current) => current.filter((id) => id !== capabilityId),
            );
          }}
          selectedWorkflowId={selectedWorkflowId}
          onRemoveWorkflow={() => {
            if (!turnPayloadLocked) setSelectedWorkflowId(null);
          }}
          pendingImage={pendingImage}
          onRemoveImage={() => {
            if (!turnPayloadLocked) replacePendingImage(null);
          }}
          imageInputRef={imageInputRef}
          onSelectImage={selectImage}
          supportsImages={supportsImages}
          onSubmit={submitMessage}
          onAbort={() => executeAction("abort", () => api.abortConversation({
            conversationId: snapshot.id,
          }))}
          onOpenArtifact={openArtifact}
          action={action}
          error={actionError}
          modelLabel={activeModelId}
          thinkingLevelControl={(
            <ProjectThinkingLevelControl
              thinkingLevels={availableThinkingLevels}
              thinkingLevel={activeThinkingLevel}
              supportsThinking={activeModelInfo?.supportsThinking === true}
              running={thinkingBusy}
              saving={thinkingSaving}
              onChange={changeThinkingLevel}
            />
          )}
          contextUsageControl={(
            <ProjectContextUsageMenu
              open={contextUsageOpen}
              onOpenChange={(open) => {
                setContextUsageOpen(open);
                if (open) {
                  setCapabilityOpen(false);
                  onProviderOpenChange?.(false);
                }
              }}
              contextUsage={snapshot.contextUsage}
              modelContextWindow={modelContextWindow}
              compaction={snapshot.compaction}
              hasAssistantReply={hasAssistantReply}
              running={conversationRunning}
              compacting={compacting}
              onCompact={compactContext}
            />
          )}
          pdfInputRef={pdfInputRef}
          uploadingPdf={uploadingPdf}
          onUploadPdf={uploadPdf}
          onRetryDocument={retryDocument}
          retryingDocumentId={retryingDocumentId}
          standalone={standalone}
        />
      )}
      artifact={(
        <ArtifactPane
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
          onRetryDocument={retryDocument}
          retryingDocumentId={retryingDocumentId}
          onRemoveDocument={removeDocument}
          removingDocumentId={removingDocumentId}
          onError={(error) => errorRef.current?.(error)}
        />
      )}
    />
  );
}
