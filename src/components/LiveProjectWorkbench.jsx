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
  MagnifyingGlass,
  Package,
  Paperclip,
  PaperPlaneTilt,
  Play,
  ShieldCheck,
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
import {
  mergeFreshConversationSnapshot,
  mergeIncrementalConversationSnapshot,
} from "../project-work/liveProjectWorkState.js";
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
import { handleProjectComposerKeyDown } from "./projectComposerKeyboard.js";

export { handleProjectComposerKeyDown } from "./projectComposerKeyboard.js";

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
  local_ready: "正在解析资料",
  submitting: "正在解析资料",
  parsing: "正在解析资料",
  preparing: "正在准备可读内容",
  indexing: "正在准备可读内容",
  ready: "已可供 AI 阅读",
  not_configured: "资料解析服务尚未配置",
  quota_deferred: "今日解析额度已用完",
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
  awaiting_user: "等待你的回答",
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

const AUTO_REVIEW_REASON_LABELS = {
  read_only_workflow: "当前流程为只读，不能自动执行写入或验证",
  change_set_not_ready: "修改提案尚未准备好",
  change_set_file_limit: "修改文件数量超出自动审批范围",
  change_set_line_limit: "修改行数超出自动审批范围",
  change_set_unsafe_file: "修改包含不允许自动处理的文件",
  change_set_not_auto_applied: "修改未通过自动审批，后续验证没有运行",
  safe_hash_bound_change_set: "修改已通过范围与哈希校验",
  verification_not_current_turn: "验证命令不属于当前任务",
  safe_bounded_verification: "验证命令已通过安全范围校验",
  verification_isolation_unavailable: "当前没有隔离运行环境，验证命令没有自动执行",
  verification_command_not_auto_safe: "验证命令不在自动审批的安全范围内",
  preview_project_required: "本机预览只能从已连接项目的普通任务启动",
  preview_not_current_turn: "预览请求不属于当前任务",
  preview_policy_revision_mismatch: "预览请求的工作权限已经变化",
  preview_profile_not_safe: "预览请求不符合受控 Uvicorn 本机预览规则",
  safe_loopback_preview: "本机预览已通过项目、回环地址与运行方式校验",
};

const TOOL_LABELS = {
  read: "读取文件",
  edit: "准备修改",
  write: "准备新文件",
  grep: "搜索内容",
  find: "查找文件",
  ls: "查看目录",
  list_documents: "查看会话资料",
  search_documents: "搜索会话资料",
  read_document: "读取会话资料",
  search_web: "搜索网页",
  resolve_library_id: "查找技术文档库",
  query_docs: "查询技术文档",
  update_plan: "更新计划",
  request_verification: "保存验证命令",
  request_preview: "登记本机预览",
};

const TOOL_ACTIVITY_TYPES = new Set([
  "tool.started",
  "tool.progress",
  "tool.completed",
]);

const RESEARCH_TOOL_GROUPS = {
  read: "project",
  grep: "project",
  find: "project",
  ls: "project",
  list_documents: "document",
  search_documents: "document",
  read_document: "document",
  search_web: "retrieval",
  resolve_library_id: "retrieval",
  query_docs: "retrieval",
};

const HIDDEN_TOOL_ACTIVITY = new Set([
  "update_plan",
  "request_verification",
  "request_preview",
]);

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
  "plan.updated",
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

function workspaceStatusCopy(workspace, standalone) {
  if (workspace?.status === "recovering") {
    return {
      tone: "recovering",
      title: "正在恢复上次文件操作",
      detail: "完成核对前不会继续写入项目文件。",
    };
  }
  if (workspace?.status === "recovery_blocked") {
    return {
      tone: "blocked",
      title: "上次文件操作需要检查",
      detail: "请打开“更改”查看文件应用记录；系统不会自行继续写入。",
    };
  }
  return {
    tone: "ready",
    title: standalone ? "私有草稿已隔离" : "修改在隔离副本中准备",
    detail: standalone
      ? "这里的文件只属于当前会话。"
      : "真实项目只会在你确认更改后更新。",
  };
}

export function ProjectWorkspaceStatus({ workspace, standalone = false }) {
  if (!workspace) return null;
  const copy = workspaceStatusCopy(workspace, standalone);
  return (
    <section
      className={`project-workspace-status is-${copy.tone}`}
      role={copy.tone === "blocked" ? "alert" : "status"}
    >
      {copy.tone === "recovering"
        ? <CircleNotch className="spin" size={16} aria-hidden="true" />
        : copy.tone === "blocked"
          ? <WarningCircle size={16} weight="fill" aria-hidden="true" />
          : <ShieldCheck size={16} weight="fill" aria-hidden="true" />}
      <div>
        <strong>{copy.title}</strong>
        <span>{copy.detail}</span>
      </div>
    </section>
  );
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

export function isNearProjectStreamBottom({
  scrollHeight,
  clientHeight,
  scrollTop,
}, threshold = 72) {
  const distance = Number(scrollHeight) - Number(clientHeight) - Number(scrollTop);
  return Number.isFinite(distance) && distance <= threshold;
}

function eventTitle(event) {
  const type = String(event.type || "");
  if (type === "auto_review.decision") {
    const decision = event.decision
      ?? event.data?.decision
      ?? event.data?.outcome
      ?? event.status;
    return ["allow", "allowed", "approved", "auto_approved", "completed"].includes(decision)
      ? "已自动放行安全操作"
      : "已阻止高风险操作";
  }
  if (event.title) return event.title;
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
  if (type === "preview.requested") return "已登记本机预览";
  if (type === "preview.starting") return "正在启动本机预览";
  if (type === "preview.ready") return "本机预览已就绪";
  if (type === "preview.opened") return "已打开本机预览";
  if (type === "preview.blocked") return "本机预览已被阻止";
  if (type === "preview.failed") return "本机预览启动失败";
  if (type === "preview.stopped") return "本机预览已停止";
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
  if (event.type === "auto_review.decision") {
    const reasonCode = event.reasonCode
      ?? event.data?.reasonCode
      ?? event.data?.reason_code;
    return event.reason
      ?? event.data?.reason
      ?? AUTO_REVIEW_REASON_LABELS[reasonCode]
      ?? (reasonCode ? `审批原因：${reasonCode}` : null)
      ?? event.detail
      ?? "服务端已记录本次审批判断";
  }
  if (event.detail) return event.detail;
  if (event.type === "agent.thinking") {
    return event.status === "active"
      ? "Pi 正在整理思路"
      : "本轮思考已完成";
  }
  if (event.type === "preview.ready" || event.type === "preview.opened") {
    return event.detail || "受控本机地址已登记到预览工件";
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
  if (/preview/.test(type)) return "preview";
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

const PREVIEW_RECIPE_LABELS = {
  vite: "Vite 开发预览",
  static: "静态站点预览",
  python_uvicorn: "Uvicorn 应用预览",
};

function safePreviewCwd(value) {
  if (value === ".") return "项目根目录";
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = value.trim().replaceAll("\\", "/");
  if (
    normalized.startsWith("/")
    || normalized === "~"
    || normalized.startsWith("~/")
    || /^[a-zA-Z]:\//.test(normalized)
    || normalized.split("/").some((segment) => segment === "..")
  ) {
    return null;
  }
  return normalized.split("/").filter((segment) => segment && segment !== ".").join("/") || null;
}

function safePreviewArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > 16) return null;
  const normalized = argv.map((value) => String(value ?? "").trim());
  if (normalized.some((value) => (
    !value
    || value.length > 120
    || value.startsWith("/")
    || value.startsWith("\\\\")
    || /^[a-zA-Z]:[\\/]/.test(value)
    || /(?:^|[=\s])\/(?:[^/]|$)/.test(value)
    || /(?:^|[=\s])[a-zA-Z]:[\\/]/.test(value)
    || /(?:^|[=\s])~[\\/]/.test(value)
  ))) {
    return null;
  }
  return JSON.stringify(normalized);
}

function previewFingerprint(value) {
  const digest = typeof value === "string" && value.startsWith("sha256:")
    ? value.slice(7)
    : "";
  if (!/^[a-f0-9]{64}$/.test(digest)) return null;
  return `${digest.slice(0, 8)}…${digest.slice(-8)}`;
}

function previewStartErrorCopy(error) {
  if (!error) return null;
  if (error.code === "PROJECT_WORK_PREVIEW_STALE") {
    return "预览请求已经变化，请重新核对当前面板后再确认。";
  }
  if (error.code === "PROJECT_WORK_PREVIEW_POLICY_STALE") {
    return "当前审批方式已经变化，请让 Pi 重新提出预览请求。";
  }
  if (error.code === "PROJECT_WORK_CONVERSATION_BUSY") {
    return "当前仍有操作在运行，结束后才能启动预览。";
  }
  return "本机预览没有启动，项目文件保持不变。";
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
  const autoReviewDecision = event.type === "auto_review.decision";
  const autoReviewBlocked = autoReviewDecision
    && eventTitle(event) === "已阻止高风险操作";

  useEffect(() => {
    setOpen(isLatest);
  }, [isLatest]);

  return (
    <details
      className={[
        event.type === "agent.thinking" ? "is-thinking" : "",
        autoReviewDecision ? "is-auto-review" : "",
        autoReviewBlocked ? "is-blocked" : "",
      ].filter(Boolean).join(" ") || undefined}
      open={open}
      onToggle={(toggleEvent) => setOpen(toggleEvent.currentTarget.open)}
    >
      <summary>
        <span className="project-activity-dot" aria-hidden="true" />
        <span>{eventTitle(event)}</span>
        <small>
          {event.type === "agent.thinking" || event.hideSequence ? "" : `#${event.seq}`}
        </small>
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
                : artifactId === "preview"
                  ? "查看预览"
                  : "查看运行"}
            <CaretRight size={12} weight="bold" aria-hidden="true" />
          </button>
        ) : null}
      </p>
    </details>
  );
}

function toolActivityStatus(event, previousStatus) {
  if (event.type === "tool.completed") {
    return event.status === "failed" ? "failed" : "completed";
  }
  if (["completed", "failed"].includes(previousStatus)) return previousStatus;
  return "active";
}

function collapseToolActivity(events) {
  const collapsed = [];
  const toolIndexes = new Map();

  for (const event of events) {
    if (!TOOL_ACTIVITY_TYPES.has(event.type)) {
      collapsed.push(event);
      continue;
    }

    const callKey = event.toolCallId || `seq-${event.seq}`;
    const existingIndex = toolIndexes.get(callKey);
    if (existingIndex === undefined) {
      toolIndexes.set(callKey, collapsed.length);
      collapsed.push({
        ...event,
        activityKey: `tool-${callKey}`,
        status: toolActivityStatus(event),
      });
      continue;
    }

    const existing = collapsed[existingIndex];
    collapsed[existingIndex] = {
      ...existing,
      ...event,
      activityKey: existing.activityKey,
      detail: event.detail || existing.detail,
      path: event.path || existing.path,
      status: toolActivityStatus(event, existing.status),
    };
  }

  return collapsed;
}

function updateResearchSummary(event, toolEvent, running) {
  const group = RESEARCH_TOOL_GROUPS[toolEvent.toolName];
  event.counts[group] += 1;
  event.artifactId = event.counts.project || event.counts.document ? "files" : null;
  event.seq = Math.max(event.seq, toolEvent.seq);
  event.status = event.status === "active" || toolEvent.status === "active"
    ? "active"
    : "completed";
  const total = Object.values(event.counts).reduce((sum, count) => sum + count, 0);
  const parts = [
    event.counts.project ? `项目资料 ${event.counts.project} 次` : "",
    event.counts.document ? `会话资料 ${event.counts.document} 次` : "",
    event.counts.retrieval ? `外部检索 ${event.counts.retrieval} 次` : "",
  ].filter(Boolean);
  event.title = event.status === "active" && running
    ? "正在查看与检索"
    : `查看与检索了 ${total} 次`;
  event.detail = parts.join(" · ");
}

function updateCommandSummary(event, commandEvent, running) {
  if (commandEvent.type === "verification.requested") {
    event.prepared += 1;
  } else {
    event.ran += 1;
    if (commandEvent.type === "verification.started") event.active += 1;
  }
  event.seq = Math.max(event.seq, commandEvent.seq);
  event.title = event.active > 0 && running
    ? "正在运行验证命令"
    : event.ran > 0
      ? `运行了 ${event.ran} 条验证命令`
      : `准备了 ${event.prepared} 条验证命令`;
  event.detail = [
    event.prepared ? `已准备 ${event.prepared} 条` : "",
    event.ran ? `已运行 ${event.ran} 条` : "",
  ].filter(Boolean).join(" · ");
}

export function normalizeActivityEvents(events, running) {
  const safeEvents = Array.isArray(events) ? events : [];
  const latestMessageSeq = safeEvents.reduce((latest, event) => (
    event.type === "message.created" && Number.isSafeInteger(event.seq)
      ? Math.max(latest, event.seq)
      : latest
  ), 0);
  const currentTurnEvents = safeEvents.filter((event) => (
    !QUIET_EVENT_TYPES.has(event.type)
    && !(latestMessageSeq > 0 && event.seq < latestMessageSeq)
  ));
  const completedVerificationIds = new Set(
    currentTurnEvents
      .filter((event) => event.type === "verification.completed" && event.eventId)
      .map((event) => event.eventId),
  );
  const normalized = [];
  let thinkingEvent = null;
  let researchEvent = null;
  let commandEvent = null;

  for (const event of collapseToolActivity(currentTurnEvents)) {
    if (event.type === "agent.thinking") {
      if (!thinkingEvent) {
        thinkingEvent = {
          ...event,
          activityKey: `thinking-${latestMessageSeq || event.seq}`,
          status: event.status,
        };
      } else if (event.status === "finished") {
        thinkingEvent.status = "finished";
      }
      continue;
    }
    if (
      event.type === "change_set.ready"
      && (
        event.status === "clean"
        || event.data?.stats?.files === 0
      )
    ) {
      continue;
    }
    if (
      TOOL_ACTIVITY_TYPES.has(event.type)
      && HIDDEN_TOOL_ACTIVITY.has(event.toolName)
    ) {
      continue;
    }
    if (
      TOOL_ACTIVITY_TYPES.has(event.type)
      && RESEARCH_TOOL_GROUPS[event.toolName]
      && event.status !== "failed"
    ) {
      if (!researchEvent) {
        researchEvent = {
          type: "activity.research_summary",
          seq: event.seq,
          activityKey: `research-${latestMessageSeq || event.seq}`,
          artifactId: null,
          hideSequence: true,
          counts: { project: 0, document: 0, retrieval: 0 },
          status: "completed",
        };
        normalized.push(researchEvent);
      }
      updateResearchSummary(researchEvent, event, running);
      continue;
    }
    if (
      event.type === "verification.started"
      && event.eventId
      && completedVerificationIds.has(event.eventId)
    ) {
      continue;
    }
    if (
      event.type === "verification.requested"
      || event.type === "verification.started"
      || (
        event.type === "verification.completed"
        && ["passed", "succeeded", "completed"].includes(event.status)
      )
    ) {
      if (!commandEvent) {
        commandEvent = {
          type: "activity.command_summary",
          seq: event.seq,
          activityKey: `commands-${latestMessageSeq || event.seq}`,
          artifactId: "run_result",
          hideSequence: true,
          prepared: 0,
          ran: 0,
          active: 0,
        };
        normalized.push(commandEvent);
      }
      updateCommandSummary(commandEvent, event, running);
      continue;
    }
    normalized.push(event);
  }

  if (thinkingEvent) {
    thinkingEvent.status = running ? "active" : "finished";
    thinkingEvent.detail = running
      ? researchEvent
        ? "正在结合刚查看的资料，判断下一步"
        : commandEvent
          ? "正在核对命令与结果，判断下一步"
          : "正在分析任务并组织下一步"
      : "本轮思考已完成";
    normalized.push(thinkingEvent);
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
      aria-busy={running}
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

export function ProjectExecutionPolicyControl({
  open,
  onOpenChange,
  executionPolicy,
  running = false,
  saving = false,
  onChange,
}) {
  const mode = executionPolicy?.mode === "auto_review"
    ? "auto_review"
    : "manual_review";
  const disabled = running || saving;
  const label = saving
    ? "正在保存"
    : mode === "auto_review"
      ? "替我审批"
      : "需确认";

  return (
    <div className="provider-menu-wrap project-execution-policy-menu">
      {open && !disabled ? (
        <button
          className="popover-scrim"
          type="button"
          aria-label="关闭工作权限"
          onClick={() => onOpenChange(false)}
        />
      ) : null}
      <button
        className={[
          "project-composer-tool",
          "project-execution-policy-trigger",
          mode === "auto_review" ? "is-auto" : "",
        ].filter(Boolean).join(" ")}
        type="button"
        disabled={disabled}
        aria-expanded={open && !disabled}
        aria-haspopup="dialog"
        aria-controls="project-execution-policy-popover"
        title={running ? "Agent 工作期间不能更改权限" : "设置当前会话的工作权限"}
        onClick={() => {
          if (!disabled) onOpenChange(!open);
        }}
      >
        {saving ? (
          <CircleNotch className="spin" size={13} weight="bold" aria-hidden="true" />
        ) : (
          <ShieldCheck size={13} weight="regular" aria-hidden="true" />
        )}
        <span>{label}</span>
        <CaretUp size={11} weight="bold" aria-hidden="true" />
      </button>

      {open && !disabled ? (
        <section
          id="project-execution-policy-popover"
          className="provider-popover project-execution-policy-popover"
          role="dialog"
          aria-labelledby="project-execution-policy-title"
        >
          <header>
            <strong id="project-execution-policy-title">工作权限</strong>
            <span>当前会话</span>
          </header>
          <div role="radiogroup" aria-label="工作权限">
            <button
              className={mode === "manual_review" ? "is-selected" : ""}
              type="button"
              role="radio"
              aria-checked={mode === "manual_review"}
              onClick={() => onChange("manual_review")}
            >
              <span>
                <strong>需确认</strong>
                <small>写入与运行等操作先等你确认</small>
              </span>
              {mode === "manual_review" ? (
                <Check size={13} weight="bold" aria-hidden="true" />
              ) : null}
            </button>
            <button
              className={mode === "auto_review" ? "is-selected" : ""}
              type="button"
              role="radio"
              aria-checked={mode === "auto_review"}
              onClick={() => onChange("auto_review")}
            >
              <span>
                <strong>替我审批</strong>
                <small>安全修改与受控本机预览自动继续，高风险操作直接阻止</small>
              </span>
              {mode === "auto_review" ? (
                <Check size={13} weight="bold" aria-hidden="true" />
              ) : null}
            </button>
          </div>
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
    <div className="project-document-statuses" aria-label="会话资料状态">
      {uploadingPdf ? (
        <button type="button" onClick={onOpenFiles}>
          <CircleNotch className="spin" size={15} aria-hidden="true" />
          <span>
            <strong>{uploadingPdf.fileName}</strong>
            <small>正在上传并准备解析</small>
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
              title="重新解析这份资料"
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

export function createAskUserAnswerDraft(request) {
  const existingAnswers = new Map(
    (request?.answers ?? []).map((answer) => [answer.questionId, answer.value]),
  );
  return Object.fromEntries((request?.questions ?? []).map((question) => {
    const existing = existingAnswers.get(question.id);
    if (question.kind === "multiple_choice") {
      return [question.id, Array.isArray(existing) ? existing : []];
    }
    return [question.id, typeof existing === "string" ? existing : ""];
  }));
}

export function isAskUserAnswerComplete(request, answerDraft) {
  return (request?.questions ?? []).every((question) => {
    if (question.required === false) return true;
    const value = answerDraft?.[question.id];
    return question.kind === "multiple_choice"
      ? Array.isArray(value) && value.length > 0
      : typeof value === "string" && Boolean(value.trim());
  });
}

export function serializeAskUserAnswers(request, answerDraft) {
  return (request?.questions ?? []).flatMap((question) => {
    const value = answerDraft?.[question.id];
    if (question.kind === "multiple_choice") {
      const selected = Array.isArray(value) ? value : [];
      return selected.length > 0 || question.required !== false
        ? [{ questionId: question.id, value: selected }]
        : [];
    }
    const text = typeof value === "string" ? value.trim() : "";
    return text || question.required !== false
      ? [{ questionId: question.id, value: text }]
      : [];
  });
}

export function ProjectAskUserCard({
  request,
  busy = false,
  onAnswer,
  onCancel,
}) {
  const [answerDraft, setAnswerDraft] = useState(
    () => createAskUserAnswerDraft(request),
  );

  useEffect(() => {
    setAnswerDraft(createAskUserAnswerDraft(request));
  }, [request?.id]);

  if (!request) return null;
  const complete = isAskUserAnswerComplete(request, answerDraft);

  return (
    <form
      className="project-ask-user"
      aria-label="Agent 等待回答"
      onSubmit={(event) => {
        event.preventDefault();
        if (!complete || busy) return;
        onAnswer?.(serializeAskUserAnswers(request, answerDraft));
      }}
    >
      <header>
        <Brain size={18} weight="fill" aria-hidden="true" />
        <div>
          <strong>Agent 等待你的决定</strong>
          <p>
            回答只用于明确任务需求，不代表批准任何文件修改。写入仍需在“更改”中核对并确认。
          </p>
        </div>
      </header>
      <div className="project-ask-user-fields">
        {request.questions.map((question) => (
          <fieldset key={question.id}>
            <legend>
              {question.label ? <span>{question.label}</span> : null}
              <strong>{question.prompt}</strong>
              {question.required === false ? <small>选填</small> : null}
            </legend>
            {question.kind === "text" ? (
              <textarea
                value={answerDraft[question.id] ?? ""}
                maxLength={4_000}
                disabled={busy}
                aria-label={question.prompt}
                onChange={(event) => {
                  const { value } = event.target;
                  setAnswerDraft((current) => ({
                    ...current,
                    [question.id]: value,
                  }));
                }}
              />
            ) : (
              <div className="project-ask-user-options">
                {question.options.map((option) => {
                  const selected = question.kind === "multiple_choice"
                    ? (answerDraft[question.id] ?? []).includes(option.id)
                    : answerDraft[question.id] === option.id;
                  return (
                    <label key={option.id}>
                      <input
                        type={question.kind === "multiple_choice" ? "checkbox" : "radio"}
                        name={`${request.id}:${question.id}`}
                        value={option.id}
                        checked={selected}
                        disabled={busy}
                        onChange={(event) => {
                          setAnswerDraft((current) => {
                            if (question.kind === "single_choice") {
                              return { ...current, [question.id]: option.id };
                            }
                            const selectedValues = Array.isArray(current[question.id])
                              ? current[question.id]
                              : [];
                            return {
                              ...current,
                              [question.id]: event.target.checked
                                ? [...selectedValues, option.id]
                                : selectedValues.filter((id) => id !== option.id),
                            };
                          });
                        }}
                      />
                      <span>
                        <strong>{option.label}</strong>
                        {option.description ? <small>{option.description}</small> : null}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </fieldset>
        ))}
      </div>
      <footer>
        <button type="button" disabled={busy} onClick={() => onCancel?.()}>
          取消这组问题
        </button>
        <button className="project-agent-primary" type="submit" disabled={!complete || busy}>
          {busy ? <CircleNotch className="spin" size={14} aria-hidden="true" /> : null}
          提交回答
        </button>
      </footer>
    </form>
  );
}

export function ProjectFollowUpQueue({
  items = [],
  busy = false,
  onRemove,
  onClear,
}) {
  if (items.length === 0) return null;
  return (
    <section className="project-follow-up-queue" aria-label="后续消息队列">
      <header>
        <div>
          <strong>后续队列</strong>
          <span>{items.length} 条等待当前 Agent 完成后处理</span>
        </div>
        <button type="button" disabled={busy} onClick={() => onClear?.()}>
          清空
        </button>
      </header>
      <ol>
        {items.map((item, index) => (
          <li key={item.id}>
            <span aria-hidden="true">{index + 1}</span>
            <p>{item.text}</p>
            <button
              type="button"
              disabled={busy}
              onClick={() => onRemove?.(item.id)}
              aria-label={`删除后续消息：${item.text}`}
            >
              <X size={12} weight="bold" aria-hidden="true" />
            </button>
          </li>
        ))}
      </ol>
      <p>“立即调整”会改变当前工作方向，不会进入这个队列。</p>
    </section>
  );
}

function formatTurnTokenCount(value) {
  return Number.isFinite(value)
    ? new Intl.NumberFormat("zh-CN").format(value)
    : null;
}

function TurnEvidence({ message }) {
  const evidence = message.turnEvidence;
  const usage = evidence?.usage;
  const model = [evidence?.providerId, evidence?.modelId]
    .filter(Boolean)
    .join(" · ");
  const totalTokens = formatTurnTokenCount(usage?.totalTokens);
  const cost = Number.isFinite(usage?.costUsd)
    ? `$${usage.costUsd.toFixed(4)}`
    : null;
  const thinking = evidence?.thinkingLevel
    ? THINKING_LEVEL_LABELS[evidence.thinkingLevel] ?? evidence.thinkingLevel
    : null;
  const items = [
    model,
    thinking ? `思考 ${thinking}` : null,
    totalTokens ? `${totalTokens} tokens` : null,
    cost,
    Number.isFinite(message.attempt) && message.attempt > 1
      ? `第 ${message.attempt} 次回答`
      : null,
  ].filter(Boolean);
  if (items.length === 0) return null;
  return (
    <footer className="project-agent-turn-evidence" aria-label="本轮模型与用量">
      {items.map((item, index) => (
        <span key={`${item}:${index}`}>{item}</span>
      ))}
    </footer>
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
  onRetryLastTurn,
  retryingLastTurn = false,
  onLoadEarlier,
  loadingEarlier = false,
  canLoadEarlier = false,
  runningMessageMode = "steer",
  onRunningMessageModeChange,
  onAnswerAskUser,
  onCancelAskUser,
  onRemoveFollowUp,
  onClearFollowUps,
  onOpenArtifact,
  action,
  error,
  modelLabel,
  executionPolicyControl,
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
  const pendingAskUserRequest = (conversation.askUserRequests ?? []).find(
    (request) => request.status === "pending",
  );
  const queuedFollowUps = (conversation.followUpQueue ?? []).filter(
    (item) => item.status === "queued",
  );
  const autoReview = conversation.executionPolicy?.mode === "auto_review";
  const streamRef = useRef(null);
  const followLatestRef = useRef(true);
  const previousConversationIdRef = useRef(conversation.id);
  const previousRunningRef = useRef(running);
  const userMessageCount = conversation.messages.filter(
    (message) => message.role === "user",
  ).length;
  const previousUserMessageCountRef = useRef(userMessageCount);
  const turnPayloadLocked = action === "message" || action === "follow-up";
  const awaitingUser = Boolean(pendingAskUserRequest);
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
    && !turnSelectionDeferred
    && !awaitingUser
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
  const canRetryLastTurn = settledWithAnswer
    && !awaitingUser
    && typeof onRetryLastTurn === "function";
  const latestEventSeq = conversation.events.at(-1)?.seq
    ?? conversation.lastEventSeq
    ?? 0;
  const handleStreamScroll = useCallback((event) => {
    followLatestRef.current = isNearProjectStreamBottom(event.currentTarget);
  }, []);
  const handleLoadEarlier = useCallback(async () => {
    const stream = streamRef.current;
    const previousHeight = stream?.scrollHeight ?? 0;
    const previousTop = stream?.scrollTop ?? 0;
    await onLoadEarlier?.();
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const nextStream = streamRef.current;
        if (!nextStream) return;
        nextStream.scrollTop = previousTop
          + Math.max(0, nextStream.scrollHeight - previousHeight);
      });
    });
  }, [onLoadEarlier]);

  useEffect(() => {
    const conversationChanged = previousConversationIdRef.current !== conversation.id;
    const workStarted = running && !previousRunningRef.current;
    const userMessageAdded = userMessageCount > previousUserMessageCountRef.current;
    previousConversationIdRef.current = conversation.id;
    previousRunningRef.current = running;
    previousUserMessageCountRef.current = userMessageCount;
    if (conversationChanged || workStarted || userMessageAdded) {
      followLatestRef.current = true;
    }
    if (!followLatestRef.current) return undefined;

    const frame = window.requestAnimationFrame(() => {
      const stream = streamRef.current;
      if (stream) stream.scrollTop = stream.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    conversation.id,
    conversation.messages.length,
    latestEventSeq,
    running,
    userMessageCount,
  ]);

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
              aria-label={queuedFollowUps.length > 0
                ? `停止 Agent 并取消 ${queuedFollowUps.length} 条后续消息`
                : "停止 Agent"}
              title={queuedFollowUps.length > 0
                ? "停止会同时取消尚未处理的后续消息"
                : "停止当前 Agent"}
            >
              <StopCircle size={13} aria-hidden="true" />
              {queuedFollowUps.length > 0 ? "停止并清空队列" : "停止"}
            </button>
          ) : null}
          {!running && canRetryLastTurn ? (
            <button
              className="header-meta-pill"
              type="button"
              onClick={onRetryLastTurn}
              disabled={Boolean(action) || retryingLastTurn}
              title="重新执行上一轮，会再次调用当前模型"
            >
              <ArrowClockwise
                className={retryingLastTurn ? "spin" : undefined}
                size={13}
                aria-hidden="true"
              />
              {retryingLastTurn ? "正在重试" : "重试上一轮"}
            </button>
          ) : null}
          {conversation.unreadCount > 0 ? (
            <span className="project-agent-unread" role="status">
              {conversation.unreadCount} 条未读
            </span>
          ) : null}
          <span className={`project-agent-status is-${statusClass(conversation)}`}>
            <span aria-hidden="true" />
            {statusLabel}
          </span>
        </div>
      </header>

      <div
        className="project-agent-stream"
        onScroll={handleStreamScroll}
        ref={streamRef}
      >
        {canLoadEarlier ? (
          <button
            className="project-agent-load-history"
            type="button"
            disabled={loadingEarlier}
            onClick={handleLoadEarlier}
          >
            {loadingEarlier ? (
              <CircleNotch className="spin" size={14} aria-hidden="true" />
            ) : (
              <CaretUp size={14} aria-hidden="true" />
            )}
            {loadingEarlier ? "正在加载" : "加载更早记录"}
          </button>
        ) : null}
        <ProjectWorkspaceStatus
          workspace={conversation.workspace}
          standalone={standalone}
        />
        {!standalone && snapshotIsLimited ? (
          <section className="project-agent-decision" role="status">
            <WarningCircle size={18} weight="fill" aria-hidden="true" />
            <div>
              <strong>当前会话仅载入部分项目内容</strong>
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
                  ? autoReview
                    ? "当前对话未连接本地文件夹。Pi 只能访问私有草稿区；安全修改会自动继续，高风险操作会被阻止。"
                    : "当前对话未连接本地文件夹。Pi 只能访问这个对话的私有草稿区，并公开实际工具活动。"
                  : autoReview
                    ? "Pi 会读取当前项目并公开实际工具活动；安全修改会自动继续，高风险操作会被阻止。"
                    : "Pi 会读取当前项目、公开实际工具活动，并把修改留到右侧等待确认。"}
              </p>
            </div>
            <div className="project-agent-scope">
              <span>{standalone ? "未连接本地文件夹" : "真实项目上下文"}</span>
              {standalone ? <span>私有草稿区</span> : null}
              <span>{autoReview ? "安全修改自动继续" : "修改先审阅"}</span>
              {!standalone ? (
                <span>{autoReview ? "高风险操作会阻止" : "命令显式运行"}</span>
              ) : null}
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
                  {message.role === "assistant" ? (
                    <TurnEvidence message={message} />
                  ) : null}
                </article>
              </Fragment>
            );
          })
        )}

        {settledWithAnswer ? null : processBlock(!running)}
        <ProjectFollowUpQueue
          items={queuedFollowUps}
          busy={Boolean(action)}
          onRemove={onRemoveFollowUp}
          onClear={onClearFollowUps}
        />
        {pendingAskUserRequest ? (
          <ProjectAskUserCard
            request={pendingAskUserRequest}
            busy={Boolean(action)}
            onAnswer={(answers) => onAnswerAskUser?.(
              pendingAskUserRequest.id,
              answers,
            )}
            onCancel={() => onCancelAskUser?.(pendingAskUserRequest.id)}
          />
        ) : null}
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
        {running ? (
          <div className="project-running-message-mode" role="group" aria-label="工作中消息方式">
            <button
              type="button"
              className={runningMessageMode === "steer" ? "is-active" : ""}
              aria-pressed={runningMessageMode === "steer"}
              disabled={turnPayloadLocked}
              onClick={() => onRunningMessageModeChange?.("steer")}
            >
              <strong>立即调整</strong>
              <span>改变当前工作方向</span>
            </button>
            <button
              type="button"
              className={runningMessageMode === "follow_up" ? "is-active" : ""}
              aria-pressed={runningMessageMode === "follow_up"}
              disabled={turnPayloadLocked}
              onClick={() => onRunningMessageModeChange?.("follow_up")}
            >
              <strong>排队后续</strong>
              <span>当前工作结束后处理</span>
            </button>
          </div>
        ) : null}
        <label>
          <span className="sr-only">给 Agent 的消息</span>
          <textarea
            value={draft}
            disabled={
              turnPayloadLocked
              || action === "abort"
              || action === "compact"
              || awaitingUser
            }
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={handleProjectComposerKeyDown}
            aria-keyshortcuts="Enter"
            placeholder={awaitingUser
              ? "请先回答 Agent 的问题"
              : runningMessageMode === "follow_up" && running
                ? "添加当前工作结束后处理的后续消息"
                : running
                  ? "补充方向，立即调整当前 Agent"
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
                title="选择一份论文资料并解析"
              >
                {uploadingPdf ? (
                  <CircleNotch className="spin" size={13} aria-hidden="true" />
                ) : (
                  <UploadSimple size={13} aria-hidden="true" />
                )}
                添加资料
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
                aria-label="选择要解析的论文资料"
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
              {executionPolicyControl}
              <span className="project-composer-model">
                {modelLabel || (standalone ? "跟随默认模型" : "跟随项目默认模型")}
              </span>
              {thinkingLevelControl}
              {contextUsageControl}
            </div>
            <small>
              {awaitingUser
                ? "回答需求问题不会批准文件写入"
                : runningMessageMode === "follow_up" && running
                  ? "发送会加入持久后续队列"
                  : running
                    ? "发送会立即调整当前 Agent 的方向"
                    : "只有显式发送才开始工作"}
              {" · Enter 发送 · Shift+Enter 换行"}
            </small>
          </div>
          <button
            type="submit"
            disabled={!canSubmit}
            aria-label={runningMessageMode === "follow_up" && running
              ? "加入后续队列"
              : running
                ? "调整当前 Agent"
                : "发送任务"}
            title={runningMessageMode === "follow_up" && running
              ? "加入后续队列"
              : running
                ? "调整当前 Agent"
                : "发送任务"}
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

const PROJECT_FILE_VISIBLE_LINE_LIMIT = 400;
const PROJECT_FILE_TREE_PAGE_SIZE = 160;
const PROJECT_FILE_IMAGE_PATTERN = /\.(?:gif|jpe?g|png|webp)$/i;

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
  const [activeLineIndex, setActiveLineIndex] = useState(0);
  const [loadingTree, setLoadingTree] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);
  const [directoryCursors, setDirectoryCursors] = useState({});
  const [searchDraft, setSearchDraft] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchEntries, setSearchEntries] = useState([]);
  const [searchCursor, setSearchCursor] = useState(null);
  const [searching, setSearching] = useState(false);
  const [imageLoadFailed, setImageLoadFailed] = useState(false);
  const [error, setError] = useState(null);
  const loadedDirectories = useRef(new Set());
  const fileAbort = useRef(null);
  const searchAbort = useRef(null);

  const reportError = useCallback((nextError) => {
    setError(nextError);
    onError?.(nextError);
  }, [onError]);

  const loadDirectory = useCallback(async (
    path = "",
    { cursor = null } = {},
  ) => {
    if (
      !conversationId
      || (!cursor && loadedDirectories.current.has(path))
    ) return;
    setLoadingTree(true);
    setError(null);
    try {
      const tree = await api.fetchTree({
        conversationId,
        path,
        limit: PROJECT_FILE_TREE_PAGE_SIZE,
        cursor: cursor ?? undefined,
      });
      if (!cursor) loadedDirectories.current.add(path);
      setEntries((current) => {
        const byPath = new Map(current.map((entry) => [entry.path, entry]));
        tree.entries.forEach((entry) => byPath.set(entry.path, entry));
        return [...byPath.values()].sort((left, right) => (
          left.path.localeCompare(right.path, "zh-CN")
        ));
      });
      setDirectoryCursors((current) => ({
        ...current,
        [path]: tree.cursor ?? null,
      }));
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
    setImageLoadFailed(false);
    if (PROJECT_FILE_IMAGE_PATTERN.test(path)) {
      fileAbort.current?.abort();
      setLoadingFile(false);
      setError(null);
      return;
    }
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

  const runSearch = useCallback(async (
    rawQuery,
    { cursor = null } = {},
  ) => {
    if (!conversationId) return;
    const normalized = String(rawQuery ?? "").trim();
    if (!normalized) {
      searchAbort.current?.abort();
      setSearchQuery("");
      setSearchEntries([]);
      setSearchCursor(null);
      setSearching(false);
      return;
    }
    searchAbort.current?.abort();
    const controller = new AbortController();
    searchAbort.current = controller;
    setSearchQuery(normalized);
    setSearching(true);
    setError(null);
    try {
      const tree = await api.fetchTree({
        conversationId,
        query: normalized,
        limit: PROJECT_FILE_TREE_PAGE_SIZE,
        cursor: cursor ?? undefined,
        signal: controller.signal,
      });
      setSearchEntries((current) => {
        const byPath = new Map(
          (cursor ? current : []).map((entry) => [entry.path, entry]),
        );
        tree.entries.forEach((entry) => byPath.set(entry.path, entry));
        return [...byPath.values()];
      });
      setSearchCursor(tree.cursor ?? null);
    } catch (nextError) {
      if (nextError?.name !== "AbortError") reportError(nextError);
    } finally {
      if (searchAbort.current === controller) setSearching(false);
    }
  }, [api, conversationId, reportError]);

  useEffect(() => {
    loadedDirectories.current = new Set();
    fileAbort.current?.abort();
    searchAbort.current?.abort();
    setEntries([]);
    setExpandedPaths([]);
    setActivePath("");
    setActiveDocumentId("");
    setFileCache({});
    setDirectoryCursors({});
    setSearchDraft("");
    setSearchQuery("");
    setSearchEntries([]);
    setSearchCursor(null);
    setSearching(false);
    setImageLoadFailed(false);
    setError(null);
    loadDirectory("");
    return () => {
      fileAbort.current?.abort();
      searchAbort.current?.abort();
    };
  }, [conversationId, loadDirectory]);

  useEffect(() => {
    if (!requestedPath) return;
    loadFile(requestedPath);
    onRequestedPathHandled?.();
  }, [loadFile, onRequestedPathHandled, requestedPath]);

  const visibleEntries = searchQuery
    ? searchEntries
    : entries.filter((entry) => {
        const segments = entry.path.split("/");
        if (segments.length <= 1) return true;
        const parents = segments.slice(0, -1).map(
          (_, index) => segments.slice(0, index + 1).join("/"),
        );
        return parents.every((parent) => expandedPaths.includes(parent));
      });
  const paginationTargets = searchQuery
    ? []
    : Object.entries(directoryCursors)
      .filter(([directory, cursor]) => (
        cursor && (!directory || expandedPaths.includes(directory))
      ))
      .map(([directory, cursor]) => ({ directory, cursor }));
  const selectedFile = fileCache[activePath] ?? null;
  const selectedImageUrl = (
    activePath
    && PROJECT_FILE_IMAGE_PATTERN.test(activePath)
    && typeof api.imageUrl === "function"
  )
    ? api.imageUrl({ conversationId, path: activePath })
    : null;
  const visibleFileLines = selectedFile?.lines
    ?.slice(0, PROJECT_FILE_VISIBLE_LINE_LIMIT) ?? [];
  const selectedDocument = documents.find(
    (document) => document.id === activeDocumentId,
  ) ?? null;
  const addFileLineContext = useCallback((index) => {
    if (!selectedFile || !Number.isSafeInteger(index)) return;
    const lineNumber = (selectedFile.startLine ?? 1) + index;
    onAddContext({
      id: `line:${selectedFile.path}:${lineNumber}:${selectedFile.contentHash ?? "current"}`,
      label: `${selectedFile.path} · L${lineNumber}`,
      path: selectedFile.path,
      contentHash: selectedFile.contentHash,
      startLine: lineNumber,
      endLine: lineNumber,
    });
  }, [onAddContext, selectedFile]);

  useEffect(() => {
    setActiveLineIndex(0);
  }, [activePath, selectedFile?.contentHash]);

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
        <form
          className="project-file-search"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            runSearch(searchDraft);
          }}
        >
          <MagnifyingGlass size={14} aria-hidden="true" />
          <input
            type="search"
            value={searchDraft}
            placeholder="搜索文件名或路径"
            aria-label="搜索文件名或路径"
            onChange={(event) => setSearchDraft(event.target.value)}
          />
          {searchQuery ? (
            <button
              type="button"
              aria-label="清除文件搜索"
              onClick={() => {
                setSearchDraft("");
                runSearch("");
              }}
            >
              <X size={13} aria-hidden="true" />
            </button>
          ) : (
            <button
              type="submit"
              aria-label="搜索文件"
              disabled={!searchDraft.trim() || searching}
            >
              {searching ? (
                <CircleNotch className="spin" size={13} aria-hidden="true" />
              ) : (
                <CaretRight size={13} aria-hidden="true" />
              )}
            </button>
          )}
        </form>
        {searchQuery ? (
          <div className="project-file-search-status" role="status">
            <span>{searching ? "正在搜索" : `“${searchQuery}”的结果`}</span>
            <small>{searchEntries.length} 项</small>
          </div>
        ) : null}
        {visibleEntries.map((entry) => (
          <button
            className={entry.path === activePath ? "is-active" : ""}
            type="button"
            key={entry.path}
            onClick={() => {
              if (entry.kind === "directory") {
                if (searchQuery) {
                  const segments = entry.path.split("/");
                  setSearchDraft("");
                  setSearchQuery("");
                  setSearchEntries([]);
                  setSearchCursor(null);
                  setExpandedPaths((current) => [
                    ...new Set([
                      ...current,
                      ...segments.map(
                        (_, index) => segments.slice(0, index + 1).join("/"),
                      ),
                    ]),
                  ]);
                  loadDirectory(entry.path);
                  return;
                }
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
            ) : entry.previewKind === "image"
              || PROJECT_FILE_IMAGE_PATTERN.test(entry.path) ? (
              <ImageSquare size={15} aria-hidden="true" />
            ) : (
              <FileCode size={15} aria-hidden="true" />
            )}
            <span>
              {searchQuery ? entry.path : entry.name || entry.path}
              {entry.overlay ? (
                <small>
                  {entry.overlay === "created" ? "Agent 新建" : "Agent 已修改"}
                </small>
              ) : null}
            </span>
          </button>
        ))}
        {searchQuery && searchCursor ? (
          <button
            className="project-file-load-more"
            type="button"
            disabled={searching}
            onClick={() => runSearch(searchQuery, { cursor: searchCursor })}
          >
            {searching ? (
              <CircleNotch className="spin" size={14} aria-hidden="true" />
            ) : (
              <CaretDown size={14} aria-hidden="true" />
            )}
            <span>继续加载搜索结果</span>
          </button>
        ) : null}
        {paginationTargets.map(({ directory, cursor }) => (
          <button
            className="project-file-load-more"
            type="button"
            key={`page:${directory || "root"}`}
            disabled={loadingTree}
            onClick={() => loadDirectory(directory, { cursor })}
          >
            {loadingTree ? (
              <CircleNotch className="spin" size={14} aria-hidden="true" />
            ) : (
              <CaretDown size={14} aria-hidden="true" />
            )}
            <span>
              {directory
                ? `继续加载 ${directory.split("/").at(-1)}`
                : "继续加载更多文件"}
            </span>
          </button>
        ))}
        {!loadingTree && !searching && visibleEntries.length === 0 ? (
          <p className="live-project-inline-empty">
            {searchQuery
              ? "没有找到匹配的文件。"
              : standalone
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
                : selectedImageUrl
                  ? "图片 · 只读预览"
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
                  ?? (selectedFile.startLine ?? 1) + visibleFileLines.length - 1,
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
              <span>资料解析</span>
              <h3>{documentStatusLabel(selectedDocument)}</h3>
              <p>
                {selectedDocument.error?.message
                  ?? (selectedDocument.status === "ready"
                    ? Number(selectedDocument.imageCount) > 0
                      ? `Pi 已可按需读取解析正文。这份资料保留了 ${selectedDocument.imageCount} 张图像，但本版资料工具暂不解读这些图像。`
                      : "解析正文保存在当前会话中。下一次明确发送任务时，Pi 可以通过只读资料工具按需检索和阅读。"
                    : "会话资料已与项目文件和待应用修改隔离；解析过程不会自动调用模型。")}
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
        ) : selectedImageUrl ? (
          <div className="project-image-preview">
            {imageLoadFailed ? (
              <div className="project-run-empty" role="alert">
                <WarningCircle size={24} aria-hidden="true" />
                <h3>无法预览这张图片</h3>
                <p>图片可能已变化、过大，或内容与文件类型不匹配。</p>
              </div>
            ) : (
              <img
                src={selectedImageUrl}
                alt={activePath.split("/").at(-1) || "项目图片"}
                onError={() => setImageLoadFailed(true)}
              />
            )}
          </div>
        ) : selectedFile?.binary ? (
          <div className="project-run-empty">
            <FileCode size={24} aria-hidden="true" />
            <h3>二进制文件</h3>
            <p>当前只显示文件信息，不把二进制内容加入 Agent 上下文。</p>
          </div>
        ) : selectedFile ? (
          <ol
            role="listbox"
            tabIndex={0}
            aria-label={`${selectedFile.path} 的代码行；使用上下方向键定位，按回车加入上下文`}
            aria-activedescendant={`project-code-line-${activeLineIndex}`}
            onKeyDown={(event) => {
              const lastIndex = Math.max(visibleFileLines.length - 1, 0);
              let nextIndex = null;
              if (event.key === "ArrowDown") nextIndex = Math.min(activeLineIndex + 1, lastIndex);
              if (event.key === "ArrowUp") nextIndex = Math.max(activeLineIndex - 1, 0);
              if (event.key === "Home") nextIndex = 0;
              if (event.key === "End") nextIndex = lastIndex;
              if (nextIndex !== null) {
                event.preventDefault();
                setActiveLineIndex(nextIndex);
                return;
              }
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                addFileLineContext(activeLineIndex);
              }
            }}
          >
            {visibleFileLines.map((line, index) => (
              <li
                id={`project-code-line-${index}`}
                className={index === activeLineIndex ? "is-active" : ""}
                role="option"
                aria-selected={index === activeLineIndex}
                key={`${selectedFile.path}:${index + 1}`}
                onMouseDown={() => setActiveLineIndex(index)}
                onClick={() => addFileLineContext(index)}
              >
                <span>{(selectedFile.startLine ?? 1) + index}</span>
                <code>{line || " "}</code>
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

const GIT_EVIDENCE_VISIBLE_PATHS = 20;
const APPLY_HISTORY_VISIBLE_RECORDS = 5;

function GitEvidenceColumn({ label, paths }) {
  const visiblePaths = paths.slice(0, GIT_EVIDENCE_VISIBLE_PATHS);
  return (
    <section>
      <header>
        <strong>{label}</strong>
        <span>{paths.length}</span>
      </header>
      {visiblePaths.length > 0 ? (
        <ul>
          {visiblePaths.map((path) => <li key={path}>{path}</li>)}
        </ul>
      ) : <p>无</p>}
      {paths.length > visiblePaths.length ? (
        <small>另有 {paths.length - visiblePaths.length} 项未展开</small>
      ) : null}
    </section>
  );
}

function applyRecordStatus(record) {
  if (record.status === "applied") return { label: "已应用并核验", tone: "ready" };
  if (record.status === "undone") return { label: "已撤销并核验", tone: "muted" };
  if (record.status === "rolled_back") return { label: "中断后已恢复原状", tone: "muted" };
  if (record.status === "prepared") return { label: "正在恢复核对", tone: "recovering" };
  return { label: "需要人工检查", tone: "blocked" };
}

function undoErrorCopy(error) {
  if (!error) return null;
  if ([
    "PROJECT_WORK_CHANGE_STALE",
    "PROJECT_WORK_UNDO_BINDING_MISMATCH",
  ].includes(error.code)) {
    return "项目文件已发生变化，撤销已阻止。请刷新并重新检查。";
  }
  if (error.code === "PROJECT_WORK_CONVERSATION_BUSY") {
    return "当前仍有操作在运行，结束后才能撤销。";
  }
  return "这次撤销没有完成，文件保持当前状态。";
}

export function ChangeEvidencePanel({
  gitEvidence,
  gitStatus = "idle",
  onRefreshGit,
  workspace,
  applyJournal = [],
  onUndoApply,
  undoingApplyId = null,
  undoError = null,
  running = false,
}) {
  const records = [...applyJournal].reverse().slice(0, APPLY_HISTORY_VISIBLE_RECORDS);
  const workspaceLabel = workspace?.status === "recovering"
    ? "正在恢复文件操作"
    : workspace?.status === "recovery_blocked"
      ? "恢复需要检查"
      : "隔离副本正常";
  const gitUnavailable = gitStatus === "ready" && gitEvidence?.available === false;
  return (
    <section className="project-change-evidence" aria-label="项目改动证据">
      <div className="project-git-evidence">
        <header>
          <div>
            <GitDiff size={15} aria-hidden="true" />
            <strong>Git 只读状态</strong>
            {gitEvidence?.available ? (
              <span>
                {gitEvidence.branch ?? "未命名分支"}
                {gitEvidence.head ? ` · ${gitEvidence.head.slice(0, 8)}` : ""}
              </span>
            ) : null}
          </div>
          <button
            type="button"
            disabled={gitStatus === "loading" || gitStatus === "refreshing"}
            onClick={onRefreshGit}
          >
            <ArrowClockwise
              className={gitStatus === "loading" || gitStatus === "refreshing" ? "spin" : ""}
              size={13}
              aria-hidden="true"
            />
            刷新
          </button>
        </header>
        {gitStatus === "loading" || gitStatus === "idle" ? (
          <p className="project-change-evidence-state">正在读取 Git 状态…</p>
        ) : gitStatus === "error" ? (
          <p className="project-change-evidence-state is-error">
            暂时无法读取 Git 状态。修改提案仍可独立核对。
          </p>
        ) : gitUnavailable ? (
          <p className="project-change-evidence-state">
            当前项目没有可用的 Git 状态。
          </p>
        ) : (
          <div className="project-git-groups">
            <GitEvidenceColumn label="已暂存" paths={gitEvidence?.staged ?? []} />
            <GitEvidenceColumn label="未暂存" paths={gitEvidence?.unstaged ?? []} />
            <GitEvidenceColumn label="未跟踪" paths={gitEvidence?.untracked ?? []} />
          </div>
        )}
        {gitEvidence?.truncated ? (
          <p className="project-change-evidence-state">改动较多，当前仅显示安全范围内的结果。</p>
        ) : null}
        <small>这里只读查看，不会暂存、提交或推送。</small>
      </div>

      <div className="project-apply-history">
        <header>
          <div>
            <ShieldCheck size={15} weight="fill" aria-hidden="true" />
            <strong>文件应用记录</strong>
          </div>
          <span className={`is-${workspace?.status ?? "ready"}`}>{workspaceLabel}</span>
        </header>
        {records.length === 0 ? (
          <p className="project-change-evidence-state">还没有已确认的文件应用记录。</p>
        ) : (
          <ol>
            {records.map((record) => {
              const status = applyRecordStatus(record);
              const recordFiles = record.files ?? [];
              const visibleFiles = recordFiles.slice(0, 4);
              const canUndo = record.status === "applied"
                && record.undo?.status === "available"
                && Boolean(record.undo.hash);
              return (
                <li className={`is-${status.tone}`} key={record.id}>
                  <header>
                    <strong>{status.label}</strong>
                    <span>{recordFiles.length} 个文件</span>
                  </header>
                  {visibleFiles.length > 0 ? (
                    <ul>
                      {visibleFiles.map((file) => <li key={file.id}>{file.path}</li>)}
                    </ul>
                  ) : null}
                  {recordFiles.length > visibleFiles.length ? (
                    <small>另有 {recordFiles.length - visibleFiles.length} 个文件</small>
                  ) : null}
                  {record.undo?.status === "blocked" ? (
                    <p>项目文件已变化，不能自动撤销。</p>
                  ) : null}
                  {canUndo ? (
                    <button
                      type="button"
                      disabled={running || Boolean(undoingApplyId)}
                      onClick={() => onUndoApply?.(record)}
                    >
                      <ArrowClockwise size={13} aria-hidden="true" />
                      {undoingApplyId === record.id ? "正在撤销" : "撤销这次应用"}
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
        {applyJournal.length > records.length ? (
          <small>仅展示最近 {records.length} 条，共 {applyJournal.length} 条记录。</small>
        ) : null}
        {undoError ? (
          <p className="project-change-evidence-state is-error" role="alert">
            {undoErrorCopy(undoError)}
          </p>
        ) : null}
      </div>
    </section>
  );
}

export function ChangeArtifact({
  conversation,
  selectedFileIds,
  onSelectedFileIdsChange,
  onApply,
  applying,
  error,
  gitEvidence,
  gitStatus,
  onRefreshGit,
  onUndoApply,
  undoingApplyId,
  undoError,
  running = false,
}) {
  const changeSet = conversation.pendingChangeSet;
  const files = changeSet?.files ?? [];
  const [activeFileId, setActiveFileId] = useState(files[0]?.id ?? null);

  useEffect(() => {
    setActiveFileId(files[0]?.id ?? null);
  }, [changeSet?.id]);

  const activeFile = files.find((file) => file.id === activeFileId) ?? files[0] ?? null;
  const selectedFiles = files.filter((file) => selectedFileIds.includes(file.id));
  const blocked = changeSet?.status === "blocked";
  const blockedReason = AUTO_REVIEW_REASON_LABELS[changeSet?.blockedReason]
    ?? (blocked ? "这项修改超出替我审批的安全范围" : null);
  const canApply = [
    "pending",
    "proposed",
    "ready",
    "awaiting_confirmation",
    "awaiting_approval",
  ].includes(changeSet?.status);

  return (
    <div className="project-change-surface">
      <ChangeEvidencePanel
        gitEvidence={gitEvidence}
        gitStatus={gitStatus}
        onRefreshGit={onRefreshGit}
        workspace={conversation.workspace}
        applyJournal={conversation.applyJournal}
        onUndoApply={onUndoApply}
        undoingApplyId={undoingApplyId}
        undoError={undoError}
        running={running}
      />
      {!changeSet || !activeFile ? (
        <div className="project-run-empty">
          <GitDiff size={24} aria-hidden="true" />
          <h3>还没有待审阅修改</h3>
          <p>Pi 提出文件修改后，精确 Diff 和内容哈希会出现在这里。</p>
        </div>
      ) : (
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
              <span>
                {changeSet.status === "applied"
                  ? "已应用"
                  : blocked
                    ? "已阻止"
                    : "待确认"}
              </span>
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
                <strong>
                  {blocked
                    ? "修改已被替我审批阻止"
                    : `${selectedFiles.length} 个文件待应用`}
                </strong>
                <small>
                  {blocked
                    ? blockedReason
                    : "服务端会在写入前重新核对每个基础哈希。"}
                </small>
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
                  {changeSet.status === "applied"
                    ? "所选修改已写入并核验"
                    : blocked
                      ? "只可查看，不能应用"
                      : changeSet.status}
                </span>
              )}
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}

export function PreviewArtifact({
  preview,
  onStart,
  starting = false,
  error = null,
}) {
  const status = preview?.status ?? "empty";
  const previewUrl = status === "ready"
    ? safeLoopbackPreviewUrl(preview?.url ?? preview?.previewUrl)
    : null;
  const manualRequested = status === "requested"
    && preview?.executionPolicyMode === "manual_review";
  const autoRequested = status === "requested" && !manualRequested;
  const recipeLabel = PREVIEW_RECIPE_LABELS[preview?.recipe?.runtime] ?? null;
  const cwdLabel = safePreviewCwd(preview?.recipe?.cwd);
  const argvSummary = safePreviewArgv(preview?.recipe?.command?.argv);
  const fingerprint = previewFingerprint(preview?.requestHash);
  const canStart = Boolean(
    manualRequested
    && preview?.confirmationRequired === true
    && preview?.id
    && recipeLabel
    && cwdLabel
    && argvSummary
    && fingerprint,
  );
  const statusLabel = {
    requested: manualRequested ? "等待你确认" : "等待自动安全判断",
    starting: "正在启动",
    ready: "本机预览已就绪",
    blocked: "已被安全策略阻止",
    failed: "启动失败",
    stopped: "预览已停止",
  }[status] ?? "当前会话没有预览工件";
  return (
    <div className="project-preview-artifact">
      <header>
        <div>
          <strong>网页预览</strong>
          <small>{statusLabel}</small>
        </div>
        {previewUrl ? (
          <a
            className="project-preview-open"
            href={previewUrl}
            target="_blank"
            rel="noreferrer"
          >
            <GlobeSimple size={14} aria-hidden="true" />
            在浏览器打开
          </a>
        ) : null}
      </header>
      {previewUrl ? (
        <div className="project-preview-canvas">
          <iframe
            className="live-project-preview-frame"
            src={previewUrl}
            title={preview?.title || "项目网页预览"}
            sandbox="allow-scripts allow-same-origin allow-forms"
          />
        </div>
      ) : manualRequested ? (
        <section className="project-preview-confirmation" aria-label="本机预览启动确认">
          <header>
            <ShieldCheck size={20} weight="fill" aria-hidden="true" />
            <div>
              <strong>核对本机预览</strong>
              <p>确认后只会启动下面这项受控预览，不会安装依赖或运行其他命令。</p>
            </div>
          </header>
          <dl>
            <div>
              <dt>运行方式</dt>
              <dd>{recipeLabel ?? "无法安全识别"}</dd>
            </div>
            <div>
              <dt>工作目录</dt>
              <dd><code>{cwdLabel ?? "无法安全显示"}</code></dd>
            </div>
            <div>
              <dt>启动参数</dt>
              <dd><code>{argvSummary ?? "无法安全显示"}</code></dd>
            </div>
            <div>
              <dt>请求指纹</dt>
              <dd><code>{fingerprint ?? "无法核验"}</code></dd>
            </div>
          </dl>
          {!canStart ? (
            <p className="project-preview-confirmation-error" role="alert">
              预览信息不完整或无法安全显示，因此不能启动。
            </p>
          ) : null}
          {error ? (
            <p className="project-preview-confirmation-error" role="alert">
              {previewStartErrorCopy(error)}
            </p>
          ) : null}
          <footer>
            <span>启动后只会开放本机回环地址。</span>
            <button
              type="button"
              disabled={!canStart || starting}
              onClick={onStart}
            >
              {starting ? (
                <CircleNotch className="spin" size={14} aria-hidden="true" />
              ) : (
                <Play size={14} weight="fill" aria-hidden="true" />
              )}
              {starting ? "正在启动" : "确认启动本机预览"}
            </button>
          </footer>
        </section>
      ) : status === "starting" ? (
        <div className="project-run-empty" role="status">
          <CircleNotch className="spin" size={24} aria-hidden="true" />
          <h3>正在启动本机预览</h3>
          <p>Pi 会自动选择未占用的回环端口；无需手动运行命令。</p>
        </div>
      ) : autoRequested ? (
        <div className="project-run-empty" role="status">
          <ShieldCheck size={24} weight="fill" aria-hidden="true" />
          <h3>等待自动安全判断</h3>
          <p>服务端仍在核对这项预览请求；页面不会自行发起启动。</p>
        </div>
      ) : preview?.error?.message ? (
        <div className="project-run-empty" role="alert">
          <WarningCircle size={24} aria-hidden="true" />
          <h3>{statusLabel}</h3>
          <p>{previewStartErrorCopy(preview.error)}</p>
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
  onResumeVerificationRepair,
  resumingOperationId,
  running,
  error,
}) {
  const command = conversation.verificationCommand;
  const interruptedRepairs = (conversation.operations ?? []).filter(
    (operation) => (
      operation.type === "verification_repair"
      && operation.status === "interrupted"
    ),
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
            disabled={running}
            title="在隔离工作区运行已保存的验证命令"
          >
            {running ? (
              <CircleNotch size={14} weight="bold" aria-hidden="true" />
            ) : (
              <Play size={14} weight="fill" aria-hidden="true" />
            )}
            {running ? "正在运行" : "运行验证"}
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
          <small>点击后会在隔离工作区运行；待审阅修改不会提前写入真实项目。</small>
        </section>
      ) : null}
      {interruptedRepairs.map((operation) => (
        <section
          className="project-verification-repair-resume"
          role="alert"
          key={operation.id}
        >
          <WarningCircle size={20} weight="fill" aria-hidden="true" />
          <div>
            <strong>修复与复测尚未完成</strong>
            <p>
              已保留当前修改和验证记录。继续会再次调用当前模型，然后在隔离工作区复测。
            </p>
          </div>
          <button
            type="button"
            disabled={Boolean(resumingOperationId) || running}
            onClick={() => onResumeVerificationRepair?.(operation.id)}
          >
            {resumingOperationId === operation.id ? (
              <CircleNotch className="spin" size={14} aria-hidden="true" />
            ) : (
              <ArrowClockwise size={14} aria-hidden="true" />
            )}
            {resumingOperationId === operation.id
              ? "正在继续"
              : "继续修复并复测"}
          </button>
        </section>
      ))}
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
            {command ? "验证命令等待运行" : "还没有验证命令"}
          </h3>
          <p>
            {command
              ? "点击“运行验证”后，会核对隔离修改并保留真实退出码与有界日志。"
              : "Pi 保存验证命令后，这里才会出现可运行操作。"}
          </p>
        </section>
      ) : (
        <div className="project-run-history">
          {runs.map((run, index) => {
            const successful = isSuccessfulRun(run);
            const failed = isFailedRun(run);
            const blocked = run.status === "blocked";
            const blockedReason = AUTO_REVIEW_REASON_LABELS[run.blockedReason]
              ?? (blocked ? "这条验证命令没有通过替我审批" : null);
            const logs = run.logs.length > 0
              ? run.logs
              : [run.stdout, run.stderr].filter(Boolean);
            return (
              <article
                className={[
                  successful ? "is-passed" : "",
                  failed ? "is-failed" : "",
                  blocked ? "is-blocked" : "",
                ].filter(Boolean).join(" ")}
                key={run.id}
              >
                <header>
                  {successful ? (
                    <CheckCircle size={18} weight="fill" aria-hidden="true" />
                  ) : blocked ? (
                    <ShieldCheck size={18} weight="fill" aria-hidden="true" />
                  ) : failed ? (
                    <WarningCircle size={18} weight="fill" aria-hidden="true" />
                  ) : (
                    <CircleNotch size={18} weight="bold" aria-hidden="true" />
                  )}
                  <div>
                    <strong>{blocked ? "验证已阻止" : `验证 ${index + 1}`}</strong>
                    <code>{run.command || command?.displayCommand || "已保存命令"}</code>
                  </div>
                  <span>{blocked ? "未运行" : run.status}</span>
                </header>
                {blockedReason ? <p>{blockedReason}</p> : run.summary ? <p>{run.summary}</p> : null}
                {!blocked && run.checks.length > 0 ? (
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
                {!blocked ? (
                  <details className="project-run-log">
                    <summary>
                      查看日志
                      <CaretDown size={12} aria-hidden="true" />
                    </summary>
                    <pre>{logs.length > 0 ? logs.join("\n") : "命令没有产生输出"}</pre>
                  </details>
                ) : null}
                <footer>
                  <span>
                    {blocked
                      ? "未启动本机进程"
                      : run.exitCode === null || run.exitCode === undefined
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
  onUndoApply,
  undoingApplyId,
  undoError,
  conversationRunning,
  onStartPreview,
  previewStarting,
  previewError,
  onRunVerification,
  onResumeVerificationRepair,
  resumingOperationId,
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
  const [gitEvidenceState, setGitEvidenceState] = useState({
    status: "idle",
    data: null,
  });
  const gitEvidenceAbort = useRef(null);
  const applyJournalRevision = (conversation.applyJournal ?? [])
    .map((record) => `${record.id}:${record.status}:${record.undo?.status ?? ""}`)
    .join("|");

  const loadGitEvidence = useCallback(async () => {
    if (typeof api.fetchGitEvidence !== "function") {
      setGitEvidenceState({
        status: "ready",
        data: {
          available: false,
          branch: null,
          head: null,
          staged: [],
          unstaged: [],
          untracked: [],
          truncated: false,
        },
      });
      return;
    }
    gitEvidenceAbort.current?.abort();
    const controller = new AbortController();
    gitEvidenceAbort.current = controller;
    setGitEvidenceState((current) => ({
      status: current.data ? "refreshing" : "loading",
      data: current.data,
    }));
    try {
      const data = await api.fetchGitEvidence({
        conversationId: conversation.id,
        signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        setGitEvidenceState({ status: "ready", data });
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setGitEvidenceState((current) => ({
          status: "error",
          data: current.data,
        }));
      }
    } finally {
      if (gitEvidenceAbort.current === controller) {
        gitEvidenceAbort.current = null;
      }
    }
  }, [api, conversation.id]);

  useEffect(() => {
    gitEvidenceAbort.current?.abort();
    setGitEvidenceState({ status: "idle", data: null });
  }, [conversation.id]);

  useEffect(() => {
    if (activeArtifactId !== "changes") return undefined;
    void loadGitEvidence();
    return () => gitEvidenceAbort.current?.abort();
  }, [
    activeArtifactId,
    applyJournalRevision,
    conversation.pendingChangeSet?.status,
    loadGitEvidence,
  ]);

  useEffect(() => () => gitEvidenceAbort.current?.abort(), []);

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
              gitEvidence={gitEvidenceState.data}
              gitStatus={gitEvidenceState.status}
              onRefreshGit={loadGitEvidence}
              onUndoApply={onUndoApply}
              undoingApplyId={undoingApplyId}
              undoError={undoError}
              running={conversationRunning}
            />
          ) : activeArtifactId === "preview" ? (
            <PreviewArtifact
              preview={conversation.preview}
              onStart={onStartPreview}
              starting={previewStarting}
              error={previewError}
            />
          ) : (
            <RunArtifact
              conversation={conversation}
              onRunVerification={onRunVerification}
              onResumeVerificationRepair={onResumeVerificationRepair}
              resumingOperationId={resumingOperationId}
              running={verificationRunning}
              error={verificationError}
            />
          )}
        </div>
      </div>
    </>
  );
}

function firstVisibleTurnSeq(conversation) {
  const turnSequences = (conversation?.messages ?? [])
    .map((message) => message.turnSeq)
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  return turnSequences.length > 0 ? Math.min(...turnSequences) : null;
}

function mergeTurnHistoryMessages(turns, messages) {
  const byId = new Map();
  for (const message of [
    ...turns.flatMap((turn) => turn.messages ?? []),
    ...(messages ?? []),
  ]) {
    if (message?.id) byId.set(message.id, message);
  }
  return [...byId.values()].sort((left, right) => (
    (left.messageSeq ?? Number.MAX_SAFE_INTEGER)
    - (right.messageSeq ?? Number.MAX_SAFE_INTEGER)
  ));
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
  const [executionPolicyOpen, setExecutionPolicyOpen] = useState(false);
  const [capabilityOpen, setCapabilityOpen] = useState(false);
  const [selectedCapabilityIds, setSelectedCapabilityIds] = useState([]);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState(null);
  const [runningMessageMode, setRunningMessageMode] = useState("steer");
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
  const [undoError, setUndoError] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const [verificationError, setVerificationError] = useState(null);
  const [uploadingPdf, setUploadingPdf] = useState(null);
  const [olderTurns, setOlderTurns] = useState([]);
  const [historyCursor, setHistoryCursor] = useState(() => {
    if (conversation?.hasMoreTurns && conversation?.nextBeforeTurnSeq) {
      return conversation.nextBeforeTurnSeq;
    }
    const firstTurnSeq = firstVisibleTurnSeq(conversation);
    return firstTurnSeq > 1 ? firstTurnSeq : null;
  });
  const [loadingEarlier, setLoadingEarlier] = useState(false);
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
    setExecutionPolicyOpen(false);
    setCapabilityOpen(false);
    setSelectedCapabilityIds([]);
    setSelectedWorkflowId(null);
    setRunningMessageMode("steer");
    replacePendingImage(null);
    setActiveArtifactId(readLastArtifact(
      conversation?.id,
      conversation?.activeArtifactId ?? "files",
    ));
    setActionError(null);
    setApplyError(null);
    setUndoError(null);
    setPreviewError(null);
    setVerificationError(null);
    setUploadingPdf(null);
    setOlderTurns([]);
    if (conversation?.hasMoreTurns && conversation?.nextBeforeTurnSeq) {
      setHistoryCursor(conversation.nextBeforeTurnSeq);
      setLoadingEarlier(false);
      return;
    }
    const firstTurnSeq = firstVisibleTurnSeq(conversation);
    setHistoryCursor(firstTurnSeq > 1 ? firstTurnSeq : null);
    setLoadingEarlier(false);
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
    setPreviewError(null);
  }, [snapshot?.preview?.id, snapshot?.preview?.requestHash]);

  useEffect(() => {
    if (!contextUsageOpen && !executionPolicyOpen) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === "Escape") {
        setContextUsageOpen(false);
        setExecutionPolicyOpen(false);
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [contextUsageOpen, executionPolicyOpen]);

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
    if (!conversationId) return undefined;
    let disposed = false;
    let timeoutId = null;
    let controller = null;
    let requestActive = false;
    let unsubscribe = null;

    const refreshSnapshot = async ({ continuePolling = false } = {}) => {
      if (disposed || requestActive) return;
      requestActive = true;
      controller = new AbortController();
      try {
        const nextSnapshot = await api.fetchConversation({
          conversationId,
          signal: controller.signal,
        });
        if (disposed) return;
        const acceptedSnapshot = publishSnapshot(nextSnapshot);
        if (
          continuePolling
          && (
          isConversationRunning(acceptedSnapshot)
          || hasProcessingDocuments(acceptedSnapshot)
          )
        ) {
          timeoutId = window.setTimeout(
            () => refreshSnapshot({ continuePolling: true }),
            pollIntervalMs,
          );
        }
      } catch (error) {
        if (disposed || error?.name === "AbortError") return;
        errorRef.current?.(error);
        if (continuePolling) {
          timeoutId = window.setTimeout(
            () => refreshSnapshot({ continuePolling: true }),
            pollIntervalMs,
          );
        }
      } finally {
        requestActive = false;
      }
    };

    if (typeof api.subscribeConversation === "function") {
      try {
        unsubscribe = api.subscribeConversation({
          conversationId,
          afterSeq: snapshotRef.current?.lastEventSeq ?? 0,
          onConversation: (nextSnapshot) => {
            if (disposed) return;
            publishSnapshot(mergeIncrementalConversationSnapshot(
              snapshotRef.current,
              nextSnapshot,
            ));
          },
          onError: () => {
            void refreshSnapshot();
          },
        });
      } catch (error) {
        errorRef.current?.(error);
      }
    }
    if (!unsubscribe && shouldPollConversation) {
      timeoutId = window.setTimeout(
        () => refreshSnapshot({ continuePolling: true }),
        pollIntervalMs,
      );
    }
    return () => {
      disposed = true;
      window.clearTimeout(timeoutId);
      controller?.abort();
      unsubscribe?.();
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

  const loadEarlierTurns = useCallback(async () => {
    if (
      !snapshot?.id
      || !historyCursor
      || loadingEarlier
      || typeof api.fetchTurns !== "function"
    ) {
      return;
    }
    setLoadingEarlier(true);
    setActionError(null);
    try {
      const page = await api.fetchTurns({
        conversationId: snapshot.id,
        beforeTurnSeq: historyCursor,
        limit: 20,
      });
      setOlderTurns((current) => {
        const byId = new Map(current.map((turn) => [turn.id, turn]));
        page.turns.forEach((turn) => byId.set(turn.id, turn));
        return [...byId.values()].sort((left, right) => (
          left.turnSeq - right.turnSeq
        ));
      });
      setHistoryCursor(
        page.hasMore && page.nextBeforeTurnSeq
          ? page.nextBeforeTurnSeq
          : null,
      );
    } catch (error) {
      setActionError(error);
      errorRef.current?.(error);
    } finally {
      setLoadingEarlier(false);
    }
  }, [api, historyCursor, loadingEarlier, snapshot?.id]);

  useEffect(() => {
    if (
      !snapshot?.id
      || snapshot.unreadCount < 1
      || typeof api.markRead !== "function"
    ) {
      return undefined;
    }
    const watermark = snapshot.readState?.latestAssistantMessageSeq
      || snapshot.latestMessageSeq
      || 0;
    if (watermark <= (snapshot.lastReadMessageSeq ?? 0)) return undefined;
    const controller = new AbortController();
    const markVisibleConversation = () => {
      if (document.visibilityState === "hidden") return;
      api.markRead({
        conversationId: snapshot.id,
        throughMessageSeq: watermark,
        signal: controller.signal,
      }).then(publishSnapshot).catch((error) => {
        if (error?.name !== "AbortError") errorRef.current?.(error);
      });
    };
    markVisibleConversation();
    document.addEventListener("visibilitychange", markVisibleConversation);
    return () => {
      controller.abort();
      document.removeEventListener("visibilitychange", markVisibleConversation);
    };
  }, [
    api,
    publishSnapshot,
    snapshot?.id,
    snapshot?.lastReadMessageSeq,
    snapshot?.latestMessageSeq,
    snapshot?.readState?.latestAssistantMessageSeq,
    snapshot?.unreadCount,
  ]);

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
    if ((snapshot.askUserRequests ?? []).some(
      (request) => request.status === "pending",
    )) {
      return;
    }
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
    const queueFollowUp = running && runningMessageMode === "follow_up";
    executeAction(queueFollowUp ? "follow-up" : "message", () => (
      queueFollowUp
        ? api.enqueueFollowUp({
            conversationId: snapshot.id,
            text,
          }).then((result) => result.snapshot)
        : running
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
    runningMessageMode,
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
      `移除“${document.fileName}”？\n\n这会删除 Pi Agent 当前会话中的资料和解析结果，不会影响你原来的文件。`,
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

  const undoAppliedChanges = useCallback((record) => {
    if (
      !record?.id
      || record.status !== "applied"
      || record.undo?.status !== "available"
      || !record.undo?.hash
      || typeof api.undoApply !== "function"
    ) {
      return;
    }
    const recordFiles = record.files ?? [];
    const fileList = recordFiles.map((file) => `• ${file.path}`).join("\n");
    const confirmed = typeof window === "undefined" || window.confirm(
      [
        "撤销这次已应用的修改？",
        "",
        `将恢复以下 ${recordFiles.length} 个文件到应用前版本：`,
        fileList || "• 当前记录没有可显示的文件",
        "",
        "服务端会重新核对当前文件；任何外部变化都会阻止撤销。",
        "此操作不会暂存、提交或推送。",
      ].join("\n"),
    );
    if (!confirmed) return;
    executeAction(
      `undo-apply:${record.id}`,
      () => api.undoApply({
        conversationId: snapshot.id,
        applyId: record.id,
        undoHash: record.undo.hash,
      }),
      setUndoError,
    );
  }, [api, executeAction, snapshot?.id]);

  const runVerification = useCallback(() => {
    const command = snapshot?.verificationCommand;
    if (!command) return;
    openArtifact("run_result");
    executeAction("verification", () => api.runVerification({
      conversationId: snapshot.id,
      commandId: command.id,
    }), setVerificationError);
  }, [api, executeAction, openArtifact, snapshot]);

  const resumeVerificationRepair = useCallback((operationId) => {
    if (
      !operationId
      || typeof api.resumeVerificationRepair !== "function"
    ) {
      return;
    }
    openArtifact("run_result");
    executeAction(
      `verification-repair:${operationId}`,
      () => api.resumeVerificationRepair({
        conversationId: snapshot.id,
        operationId,
      }),
      setVerificationError,
    );
  }, [api, executeAction, openArtifact, snapshot?.id]);

  const retryLastTurn = useCallback(() => {
    if (typeof api.retryLastTurn !== "function") return;
    executeAction("retry-last-turn", () => api.retryLastTurn({
      conversationId: snapshot.id,
    }));
  }, [api, executeAction, snapshot?.id]);

  const startPreview = useCallback(() => {
    const preview = snapshot?.preview;
    if (
      preview?.status !== "requested"
      || preview.executionPolicyMode !== "manual_review"
      || preview.confirmationRequired !== true
      || !preview.id
      || !preview.requestHash
      || typeof api.startPreview !== "function"
    ) {
      return;
    }
    executeAction("preview-start", () => api.startPreview({
      conversationId: snapshot.id,
      previewId: preview.id,
      requestHash: preview.requestHash,
    }), setPreviewError);
  }, [api, executeAction, snapshot]);

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

  useEffect(() => {
    if (!conversationRunning) setRunningMessageMode("steer");
  }, [conversationRunning]);

  const removeFollowUp = useCallback((itemId) => {
    if (!itemId || typeof api.removeFollowUp !== "function") return;
    executeAction(`follow-up-remove:${itemId}`, async () => {
      await api.removeFollowUp({
        conversationId: snapshot.id,
        itemId,
      });
      return api.fetchConversation({ conversationId: snapshot.id });
    });
  }, [api, executeAction, snapshot?.id]);

  const clearFollowUps = useCallback(() => {
    if (typeof api.clearFollowUps !== "function") return;
    executeAction("follow-up-clear", async () => {
      await api.clearFollowUps({ conversationId: snapshot.id });
      return api.fetchConversation({ conversationId: snapshot.id });
    });
  }, [api, executeAction, snapshot?.id]);

  const answerAskUser = useCallback((requestId, answers) => {
    if (!requestId || typeof api.answerAskUserRequest !== "function") return;
    executeAction(`ask-user-answer:${requestId}`, () => (
      api.answerAskUserRequest({
        conversationId: snapshot.id,
        requestId,
        answers,
      }).then((result) => result.snapshot)
    ));
  }, [api, executeAction, snapshot?.id]);

  const cancelAskUser = useCallback((requestId) => {
    if (!requestId || typeof api.cancelAskUserRequest !== "function") return;
    executeAction(`ask-user-cancel:${requestId}`, () => (
      api.cancelAskUserRequest({
        conversationId: snapshot.id,
        requestId,
      }).then((result) => result.snapshot)
    ));
  }, [api, executeAction, snapshot?.id]);

  const abortConversation = useCallback(() => {
    const queuedCount = (snapshot?.followUpQueue ?? []).filter(
      (item) => item.status === "queued",
    ).length;
    const confirmed = queuedCount === 0
      || typeof window === "undefined"
      || window.confirm(
        `停止当前 Agent？\n\n尚未处理的 ${queuedCount} 条后续消息会同时取消。`,
      );
    if (!confirmed) return;
    executeAction("abort", () => api.abortConversation({
      conversationId: snapshot.id,
    }));
  }, [api, executeAction, snapshot]);

  useEffect(() => {
    if (conversationRunning || action) setExecutionPolicyOpen(false);
  }, [action, conversationRunning]);
  const turnPayloadLocked = action === "message";
  const retryingDocumentId = action?.startsWith("document-retry:")
    ? action.slice("document-retry:".length)
    : null;
  const removingDocumentId = action?.startsWith("document-remove:")
    ? action.slice("document-remove:".length)
    : null;
  const undoingApplyId = action?.startsWith("undo-apply:")
    ? action.slice("undo-apply:".length)
    : null;
  const resumingVerificationRepairId = action?.startsWith(
    "verification-repair:",
  )
    ? action.slice("verification-repair:".length)
    : null;
  const thinkingSaving = action === "thinking-level";
  const executionPolicySaving = action === "execution-policy";
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
  const changeExecutionPolicy = useCallback((nextMode) => {
    const currentPolicy = snapshot?.executionPolicy ?? {
      mode: "manual_review",
      revision: 0,
    };
    setExecutionPolicyOpen(false);
    if (
      conversationRunning
      || action
      || nextMode === currentPolicy.mode
      || !["manual_review", "auto_review"].includes(nextMode)
      || typeof api.configureExecutionPolicy !== "function"
    ) {
      return;
    }
    executeAction("execution-policy", () => api.configureExecutionPolicy({
      conversationId: snapshot.id,
      mode: nextMode,
      expectedRevision: currentPolicy.revision,
    }));
  }, [
    action,
    api,
    conversationRunning,
    executeAction,
    snapshot?.executionPolicy,
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
              setExecutionPolicyOpen(false);
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
            setExecutionPolicyOpen(false);
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
  const agentConversation = useMemo(() => (
    snapshot
      ? {
          ...snapshot,
          messages: mergeTurnHistoryMessages(
            olderTurns,
            snapshot.messages,
          ),
        }
      : snapshot
  ), [olderTurns, snapshot]);

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
          conversation={agentConversation}
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
          onAbort={abortConversation}
          onRetryLastTurn={retryLastTurn}
          retryingLastTurn={action === "retry-last-turn"}
          onLoadEarlier={loadEarlierTurns}
          loadingEarlier={loadingEarlier}
          canLoadEarlier={Boolean(historyCursor)}
          runningMessageMode={runningMessageMode}
          onRunningMessageModeChange={setRunningMessageMode}
          onAnswerAskUser={answerAskUser}
          onCancelAskUser={cancelAskUser}
          onRemoveFollowUp={removeFollowUp}
          onClearFollowUps={clearFollowUps}
          onOpenArtifact={openArtifact}
          action={action}
          error={actionError}
          modelLabel={activeModelId}
          executionPolicyControl={(
            <ProjectExecutionPolicyControl
              open={executionPolicyOpen}
              onOpenChange={(open) => {
                if (conversationRunning || action) return;
                setExecutionPolicyOpen(open);
                if (open) {
                  setContextUsageOpen(false);
                  setCapabilityOpen(false);
                  onProviderOpenChange?.(false);
                }
              }}
              executionPolicy={snapshot.executionPolicy}
              running={conversationRunning}
              saving={executionPolicySaving}
              onChange={changeExecutionPolicy}
            />
          )}
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
                  setExecutionPolicyOpen(false);
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
          onUndoApply={undoAppliedChanges}
          undoingApplyId={undoingApplyId}
          undoError={undoError}
          conversationRunning={conversationRunning}
          onStartPreview={startPreview}
          previewStarting={action === "preview-start"}
          previewError={previewError}
          onRunVerification={runVerification}
          onResumeVerificationRepair={resumeVerificationRepair}
          resumingOperationId={resumingVerificationRepairId}
          verificationError={verificationError}
          verificationRunning={action === "verification"
            || Boolean(resumingVerificationRepairId)
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
