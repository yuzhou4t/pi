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
  Cloud,
  Code,
  DownloadSimple,
  DotsThree,
  ArrowClockwise,
  Brain,
  FileCode,
  FileDoc,
  FilePdf,
  FileXls,
  Files,
  Folder,
  Gauge,
  GitBranch,
  GitDiff,
  GithubLogo,
  GlobeSimple,
  ImageSquare,
  MagnifyingGlass,
  Package,
  Paperclip,
  PaperPlaneTilt,
  Play,
  ShieldCheck,
  SidebarSimple,
  Stop,
  StopCircle,
  TestTube,
  UploadSimple,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import {
  MAX_PROJECT_WORK_TEXT_ATTACHMENTS,
  projectWorkDroppedFileKind,
  projectWorkApi,
  validateProjectWorkImageFile,
  validateProjectWorkTextAttachmentFile,
} from "../api/projectWork.js";
import {
  applyProjectWorkEventDelta,
  mergeFreshConversationSnapshot,
  mergeIncrementalConversationSnapshot,
  projectStreamingAssistantFromEvents,
  projectStreamingAssistantView,
  projectWorkEventNeedsHydration,
} from "../project-work/liveProjectWorkState.js";
import {
  parseCodeEvidenceHref,
  remarkCodeEvidence,
} from "../project-work/codeEvidence.js";
import {
  PROJECT_WORK_CAPABILITIES,
  PROJECT_WORK_WORKFLOWS,
  projectWorkCapability,
  projectWorkWorkflow,
} from "../../shared/projectWorkCapabilities.js";
import { AgentArtifactLayout } from "./AgentArtifactLayout.jsx";
import {
  ProjectLoopCloseoutCard,
  ProjectLoopNotificationControl,
} from "./ProjectLoopNotifications.jsx";
import { ProjectGitCloseout } from "./ProjectGitCloseout.jsx";
import { ProjectBrowserQaResults } from "./ProjectBrowserQaResults.jsx";
import {
  ProviderMenu,
  THINKING_LEVEL_LABELS,
} from "./ProviderMenu.jsx";
import { ProjectSessionPathMenu } from "./ProjectSessionPathMenu.jsx";
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
  awaiting_verification: "验证待运行",
  verification_failed: "验证未通过",
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
  model_turn_failed: "模型未完成本轮工作，失败前的修改已隔离且不可应用",
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
  edit: "修改文件",
  write: "写入文件",
  grep: "搜索内容",
  find: "查找文件",
  ls: "查看目录",
  list_documents: "查看会话资料",
  search_documents: "搜索会话资料",
  read_document: "读取会话资料",
  list_attachments: "查看普通附件",
  search_attachments: "搜索普通附件",
  read_attachment: "读取普通附件",
  list_office_artifacts: "查看生成的 Office 文件",
  read_office_artifact: "读取 Office 结构预览",
  write_word_document: "生成 Word 文档",
  write_excel_workbook: "生成 Excel 工作簿",
  search_web: "搜索网页",
  resolve_library_id: "查找技术文档库",
  query_docs: "查询技术文档",
  update_plan: "更新计划",
  request_verification: "保存验证命令",
  request_git_closeout: "准备 Git 收尾",
  generate_image: "生成图片",
  request_preview: "登记本机预览",
  report_progress: "报告公开进展",
  subagent: "并行子智能体",
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
  list_attachments: "document",
  search_attachments: "document",
  read_attachment: "document",
  list_office_artifacts: "document",
  read_office_artifact: "document",
  search_web: "retrieval",
  resolve_library_id: "retrieval",
  query_docs: "retrieval",
};

const HIDDEN_TOOL_ACTIVITY = new Set([
  "update_plan",
  "request_verification",
  "request_git_closeout",
  "request_preview",
  "report_progress",
]);

const OPERATION_LABELS = {
  create: "新增",
  modify: "修改",
  delete: "删除",
};

const QUIET_EVENT_TYPES = new Set([
  "conversation.created",
  "conversation.read",
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
  "message.partial",
  "message.update",
  "assistant.delta",
  "follow_up.queued",
  "follow_up.delivered",
  "ask_user.requested",
  "ask_user.answered",
  "ask_user.cancelled",
  "harness.snapshot",
  "plan.updated",
  "workspace.recorded",
  "apply_journal.prepared",
  "document.created",
  "document.uploaded",
  "document.parsing_started",
  "document.parsing_progress",
  "document.ready",
  "document.failed",
  "document.retry_requested",
]);

const ARTIFACT_STORAGE_KEY = "pi-agent-project-work-artifacts-v1";
const TRANSPARENT_MODE_STORAGE_KEY = "pi-agent-project-work-transparent-mode-v1";
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

function readTransparentMode() {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(TRANSPARENT_MODE_STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

function writeTransparentMode(enabled) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      TRANSPARENT_MODE_STORAGE_KEY,
      enabled ? "on" : "off",
    );
  } catch {
    // The display preference is optional and never changes the Agent runtime.
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
  const attention = verificationAttention(conversation);
  if (attention) {
    if (["running", "queued"].includes(attention.status)) return "verifying";
    if (["failed", "timed_out", "interrupted", "aborted", "blocked"].includes(
      attention.status,
    )) {
      return "verification_failed";
    }
    return "awaiting_verification";
  }
  return conversation?.turnStatus || conversation?.status || "idle";
}

function isConversationRunning(conversation) {
  return RUNNING_STATUSES.has(activeStatus(conversation));
}

export function conversationEventResumeSeq(conversation) {
  const latest = Number(conversation?.lastEventSeq);
  const delivered = Number(conversation?.deliveredEventSeq);
  const lastReceived = Number(conversation?.events?.at(-1)?.seq);
  if (conversation?.hasMoreEvents) {
    return Math.max(
      Number.isSafeInteger(delivered) && delivered >= 0 ? delivered : 0,
      Number.isSafeInteger(lastReceived) && lastReceived >= 0 ? lastReceived : 0,
    );
  }
  if (Number.isSafeInteger(latest) && latest >= 0) return latest;
  if (Number.isSafeInteger(delivered) && delivered >= 0) return delivered;
  return Number.isSafeInteger(lastReceived) && lastReceived >= 0
    ? lastReceived
    : 0;
}

export function workspaceRunsToLoad(runs, expandedRunIds = new Set()) {
  return (Array.isArray(runs) ? runs : []).filter((run) => (
    run?.runId
    && expandedRunIds.has(run.runId)
  ));
}

export function workspaceRunGitSummary(evidence) {
  if (!evidence) return null;
  if (evidence.available !== true) return "不可用";
  const changed = [
    ...(evidence.staged ?? []),
    ...(evidence.unstaged ?? []),
    ...(evidence.untracked ?? []),
  ];
  const identity = [
    evidence.branch || "未命名分支",
    evidence.head ? evidence.head.slice(0, 8) : null,
  ].filter(Boolean).join(" @ ");
  return [
    identity,
    `${new Set(changed).size} 项变更`,
    evidence.truncated ? "列表已截断" : null,
  ].filter(Boolean).join(" · ");
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
  if (["failed", "interrupted", "verification_failed"].includes(status)) {
    return "test_failed";
  }
  if (status === "awaiting_verification") return "awaiting_confirmation";
  if (["applied"].includes(status)) return "changes_applied";
  if (["completed"].includes(status)) return "completed";
  return "ready";
}

function workspaceStatusCopy(workspace, standalone, fork) {
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
  if (fork?.status === "ready") {
    return {
      tone: "ready",
      title: "已从检查点继续",
      detail: "会话继承检查点上下文，并继续使用当前 Workspace。",
    };
  }
  return {
    tone: "ready",
    title: standalone ? "私有 Workspace 已连接" : "真实 Workspace 已连接",
    detail: standalone
      ? "这里的文件只属于当前会话。"
      : "读取、写入、构建与测试使用同一工作区；Pi 原生操作的活动与结果会持续保留。",
  };
}

export function ProjectWorkspaceStatus({
  workspace,
  standalone = false,
  fork = null,
}) {
  if (!workspace) return null;
  const copy = workspaceStatusCopy(workspace, standalone, fork);
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

function sessionTurnKey(value, fallback = "") {
  if (typeof value?.turnId === "string" && value.turnId) {
    return `turn:${value.turnId}`;
  }
  if (Number.isSafeInteger(value?.turnSeq)) {
    return `turn-seq:${value.turnSeq}`;
  }
  return fallback;
}

function compareSessionAttempts(left, right) {
  const leftAttempt = Number.isSafeInteger(left?.attempt) ? left.attempt : 0;
  const rightAttempt = Number.isSafeInteger(right?.attempt) ? right.attempt : 0;
  if (leftAttempt !== rightAttempt) return leftAttempt - rightAttempt;
  return left.index - right.index;
}

/**
 * Projects the public Pi session tree into one visible answer per turn. Picking
 * an older checkpoint changes only this projection; it never mutates the live
 * runtime path or calls a model.
 */
export function projectSessionMessageView(
  messages = [],
  sessionPath = null,
  selectedCheckpointId = null,
) {
  const safeMessages = Array.isArray(messages) ? messages : [];
  const checkpoints = Array.isArray(sessionPath?.checkpoints)
    ? sessionPath.checkpoints
    : [];
  const checkpointGroups = new Map();
  checkpoints.forEach((checkpoint, index) => {
    if (typeof checkpoint?.id !== "string" || !checkpoint.id) return;
    const key = sessionTurnKey(checkpoint, `checkpoint:${checkpoint.id}`);
    const group = checkpointGroups.get(key) ?? [];
    group.push({ ...checkpoint, index });
    checkpointGroups.set(key, group);
  });
  checkpointGroups.forEach((group) => group.sort(compareSessionAttempts));

  const selectedCheckpoint = checkpoints.find(
    (checkpoint) => checkpoint?.id === selectedCheckpointId,
  );
  const selectedTurnKey = selectedCheckpoint
    ? sessionTurnKey(selectedCheckpoint, `checkpoint:${selectedCheckpoint.id}`)
    : null;
  const selectedAssistantByTurn = new Map();
  const attemptMetaByTurn = new Map();

  for (const [key, group] of checkpointGroups) {
    const chosen = key === selectedTurnKey
      ? group.find((checkpoint) => checkpoint.id === selectedCheckpointId)
        ?? group.at(-1)
      : group.at(-1);
    if (!chosen) continue;
    selectedAssistantByTurn.set(key, chosen.assistantMessageId ?? null);
    attemptMetaByTurn.set(key, {
      attempt: Number.isSafeInteger(chosen.attempt)
        ? chosen.attempt
        : group.indexOf(chosen) + 1,
      count: group.length,
      checkpointId: chosen.id,
    });
  }

  const assistantGroups = new Map();
  safeMessages.forEach((message, index) => {
    if (message?.role !== "assistant" || message.isFinal === false) return;
    const key = sessionTurnKey(message, `assistant:${message.id ?? index}`);
    const group = assistantGroups.get(key) ?? [];
    group.push({ message, index });
    assistantGroups.set(key, group);
  });

  const visibleAssistantIds = new Set();
  for (const [key, group] of assistantGroups) {
    const selectedAssistantId = selectedAssistantByTurn.get(key);
    const attemptMeta = attemptMetaByTurn.get(key);
    const chosen = group.find(({ message }) => message.id === selectedAssistantId)
      ?? group.find(({ message }) => (
        attemptMeta
        && Number.isSafeInteger(message.attempt)
        && message.attempt === attemptMeta.attempt
      ))
      ?? group.at(-1);
    if (chosen?.message?.id) visibleAssistantIds.add(chosen.message.id);
  }

  return {
    messages: safeMessages.filter((message) => (
      message?.role !== "assistant"
      || (message.isFinal !== false && visibleAssistantIds.has(message.id))
    )),
    attemptMetaByTurn,
  };
}

export function latestStreamingAssistant(
  events,
  messages,
  running,
  projection,
) {
  return projection === undefined
    ? projectStreamingAssistantFromEvents(events, messages, running)
    : projectStreamingAssistantView(projection, messages, running);
}

function isStreamingAnswerEvent(event) {
  if (event?.type === "message.partial") {
    return typeof (event.text ?? event.data?.text) === "string"
      && Boolean(event.text ?? event.data?.text);
  }
  if (event?.type !== "message.delta") return false;
  const phase = event.phase ?? event.data?.phase;
  const delta = event.delta ?? event.data?.delta;
  return phase !== "commentary" && typeof delta === "string" && Boolean(delta);
}

function ProjectAgentMarkdown({
  children,
  codeEvidence = [],
  onOpenCodeEvidence,
}) {
  const components = useMemo(() => ({
    a: ({ node: _node, href, children: linkChildren, ...props }) => {
      const reference = parseCodeEvidenceHref(href);
      const opensNewTab = /^https?:\/\//i.test(href ?? "");
      return (
        <a
          {...props}
          href={href}
          {...(opensNewTab ? { target: "_blank", rel: "noreferrer" } : {})}
          {...(reference ? {
            onClick: (event) => {
              event.preventDefault();
              onOpenCodeEvidence?.(reference);
            },
            title: `打开 ${reference.path} 第 ${reference.startLine} 行`,
          } : {})}
        >
          {linkChildren}
        </a>
      );
    },
  }), [onOpenCodeEvidence]);
  const remarkPlugins = useMemo(
    () => [
      remarkGfm,
      [remarkCodeEvidence, { evidence: codeEvidence }],
    ],
    [codeEvidence],
  );
  return (
    <div className="project-agent-markdown">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        components={components}
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
    if (event.status === "active") return "正在思考";
    if (event.status === "waiting") return "思考已暂停";
    if (event.status === "stopped") return "思考已停止";
    if (event.status === "incomplete") return "思考未完成";
    return safePhasePresentation(event.phaseContext, "finished").title;
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
  if (type === "image.generation_started") return "正在生成图片";
  if (type === "image.generation_completed") return "图片已生成";
  if (type === "image.generation_failed") return "图片生成未完成";
  if (/tool.*(?:start|call)|tool_call/.test(type)) {
    return TOOL_LABELS[event.toolName] ?? `调用 ${tool}`;
  }
  if (/tool.*(?:end|result|complete)|tool_result/.test(type)) {
    if (["aborted", "stopped"].includes(event.status)) return `${tool}已停止`;
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

function progressNarration(event) {
  const summary = [
    event?.summary,
    event?.data?.summary,
    event?.title,
    event?.detail,
  ].find((value) => typeof value === "string" && value.trim());
  const detail = [
    event?.data?.detail,
    event?.detail,
  ].find((value) => (
    typeof value === "string"
    && value.trim()
    && value.trim() !== summary?.trim()
  ));
  return {
    summary: summary?.trim().slice(0, 500) ?? "",
    detail: detail?.trim().slice(0, 1_000) ?? "",
  };
}

function safePhasePresentation(context, status = "active") {
  if (status === "waiting") {
    return {
      title: "分析已暂停",
      detail: "正在等待你的回答，再继续判断下一步",
    };
  }
  if (status === "stopped") {
    return {
      title: "分析已停止",
      detail: "本轮已停止，不会继续调用工具",
    };
  }
  if (status === "incomplete") {
    return {
      title: "分析未完成",
      detail: "本轮在完成下一步判断前中断",
    };
  }
  const active = status === "active";
  if (context === "research") {
    return {
      title: active ? "正在结合刚查看的资料" : "已结合刚查看的资料",
      detail: active
        ? "正在根据刚完成的文件与资料检查，判断下一步"
        : "已根据刚完成的文件与资料检查整理下一步",
    };
  }
  if (context === "command") {
    return {
      title: active ? "正在核对运行结果" : "已核对运行结果",
      detail: active
        ? "正在根据受控命令与验证结果，判断下一步"
        : "已根据受控命令与验证结果整理下一步",
    };
  }
  if (context === "action") {
    return {
      title: active ? "正在检查刚才的操作" : "已检查刚才的操作",
      detail: active
        ? "正在确认工具结果与后续动作"
        : "已确认工具结果与后续动作",
    };
  }
  return {
    title: active ? "正在分析任务" : "已完成这一步分析",
    detail: active
      ? "正在理解当前任务并决定下一步"
      : "已完成当前阶段的判断",
  };
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
  if (/image/.test(type)) return "files";
  return null;
}

function isSuccessfulRun(run) {
  return ["passed", "succeeded", "completed"].includes(run.status);
}

function isFailedRun(run) {
  return ["failed", "timed_out", "interrupted", "aborted"].includes(run.status);
}

const UNRESOLVED_VERIFICATION_STATUSES = new Set([
  "saved",
  "ready",
  "requested",
  "pending_approval",
  "proposed",
  "queued",
  "running",
  "failed",
  "timed_out",
  "interrupted",
  "aborted",
  "blocked",
]);

export function verificationAttention(conversation) {
  if (!conversation) return null;
  const latestWorkspaceRun = (conversation.workspaceRuns ?? []).at(-1) ?? null;
  const workspaceRun = latestWorkspaceRun
    && !["succeeded", "cancelled"].includes(latestWorkspaceRun.status)
    ? latestWorkspaceRun
    : null;
  if (workspaceRun) {
    const copy = {
      requested: ["项目命令等待确认", "请在“运行”工件核对精确命令后确认。"],
      queued: ["项目命令正在排队", "它会在当前 Workspace 获得运行租约后启动。"],
      running: ["项目命令正在运行", "实时日志会持续保存在“运行”工件。"],
      failed: ["项目命令未通过", workspaceRun.error?.message || "失败结果和日志已经保留。"],
      interrupted: ["项目命令已中断", "运行记录已经保留，且不会自动重跑。"],
    }[workspaceRun.status] ?? ["项目命令需要处理", "请打开“运行”工件查看。"];
    return {
      requestKey: workspaceRun.id,
      status: workspaceRun.status,
      title: copy[0],
      detail: copy[1],
      command: [workspaceRun.executable, ...(workspaceRun.argv ?? [])].join(" "),
    };
  }
  const command = conversation.verificationCommand ?? null;
  const runs = Array.isArray(conversation.verificationRuns)
    ? conversation.verificationRuns
    : [];
  const retiredRequestIds = new Set();
  for (const run of runs) {
    if (
      run.status !== "legacy_superseded"
      && run.errorCode !== "PROJECT_WORK_VERIFICATION_WORKSPACE_TOO_LARGE"
    ) continue;
    const requestId = run.commandId || run.id;
    if (requestId) retiredRequestIds.add(requestId);
  }
  if (command?.status === "legacy_superseded" && command.id) {
    retiredRequestIds.add(command.id);
  }
  const commandRetired = Boolean(
    command
    && (
      command.status === "legacy_superseded"
      || retiredRequestIds.has(command.id)
    ),
  );
  const executableRuns = runs.filter((run) => ![
    "saved",
    "ready",
    "requested",
    "pending_approval",
    "proposed",
    "legacy_superseded",
  ].includes(run.status)
    && run.errorCode !== "PROJECT_WORK_VERIFICATION_WORKSPACE_TOO_LARGE"
    && !retiredRequestIds.has(run.commandId));
  const matchingRuns = command
    ? executableRuns.filter((run) => run.commandId === command.id)
    : executableRuns;
  const latestRun = matchingRuns.at(-1) ?? null;
  const interruptedRepair = [...(conversation.operations ?? [])]
    .reverse()
    .find((operation) => (
      operation.type === "verification_repair"
      && operation.status === "interrupted"
    ));
  if (interruptedRepair) {
    return {
      requestKey: command?.id ?? interruptedRepair.id ?? "verification-repair",
      status: "interrupted",
      title: "修复与复测尚未完成",
      detail: "运行记录已经保留，请在“运行”工件中继续。",
      command: command?.displayCommand ?? latestRun?.command ?? "",
    };
  }
  if (commandRetired && !latestRun) return null;
  if (latestRun && isSuccessfulRun(latestRun)) return null;
  const status = latestRun?.status ?? command?.status ?? null;
  if (!UNRESOLVED_VERIFICATION_STATUSES.has(status) && !command) return null;
  if (!status && !command) return null;
  const copy = {
    failed: ["验证未通过", latestRun?.summary || "失败结果和日志已经保留。"],
    timed_out: ["验证已超时", "运行日志已经保留，可核对后重试。"],
    interrupted: ["验证已中断", "运行日志已经保留，不会自动重跑。"],
    aborted: ["验证已停止", "验证没有完成，可在运行工件中重新启动。"],
    blocked: ["验证尚未运行", "安全策略阻止了这次运行，请查看具体原因。"],
    running: ["验证正在运行", "实时结果和日志会持续进入运行工件。"],
    queued: ["验证正在等待运行", "请求已登记，尚未启动项目命令。"],
  }[status] ?? ["验证等待运行", "命令已经保存，需要在运行工件中明确启动。"];
  return {
    requestKey: command?.id ?? latestRun?.commandId ?? latestRun?.id ?? "verification",
    status: status ?? "requested",
    title: copy[0],
    detail: copy[1],
    command: command?.displayCommand ?? latestRun?.command ?? "",
  };
}

function VerificationAttentionCard({ attention, onOpenArtifact }) {
  if (!attention) return null;
  return (
    <section
      className={`project-verification-attention is-${attention.status}`}
      role={["failed", "timed_out", "interrupted", "blocked"].includes(attention.status)
        ? "alert"
        : "status"}
    >
      {["running", "queued"].includes(attention.status) ? (
        <CircleNotch size={18} weight="bold" aria-hidden="true" />
      ) : (
        <WarningCircle size={18} weight="fill" aria-hidden="true" />
      )}
      <div>
        <strong>{attention.title}</strong>
        <p>{attention.detail}</p>
        {attention.command ? <code>{attention.command}</code> : null}
      </div>
      <button type="button" onClick={() => onOpenArtifact?.("run_result")}>
        打开运行
        <CaretRight size={13} weight="bold" aria-hidden="true" />
      </button>
    </section>
  );
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

function normalizeActivityPlan(plan) {
  const steps = Array.isArray(plan)
    ? plan
    : Array.isArray(plan?.steps)
      ? plan.steps
      : [];
  return steps.flatMap((step, index) => {
    if (!step || typeof step !== "object") return [];
    const title = [step.title, step.text, step.step]
      .find((value) => typeof value === "string" && value.trim());
    if (!title) return [];
    return [{
      id: step.id ?? step.stepId ?? `step-${index + 1}`,
      title: title.trim(),
      status: ["pending", "in_progress", "running", "completed"].includes(step.status)
        ? step.status
        : "pending",
    }];
  });
}

export function planFromActivityEvents(events) {
  const planEvent = [...(Array.isArray(events) ? events : [])]
    .reverse()
    .find((event) => ["plan.updated", "plan.cleared"].includes(event?.type));
  if (planEvent?.type === "plan.cleared") return [];
  return normalizeActivityPlan(planEvent?.data ?? planEvent);
}

function PlanSteps({ plan, showStatusLabels = false }) {
  const statusLabels = {
    pending: "待处理",
    in_progress: "进行中",
    running: "进行中",
    completed: "已完成",
  };
  return (
    <ol>
      {plan.map((step) => (
        <li
          aria-label={`${statusLabels[step.status] ?? "待处理"}：${step.title}`}
          className={`is-${step.status}`}
          key={step.id}
        >
          <span className="project-plan-status" aria-hidden="true">
            {step.status === "completed" ? (
              <Check size={12} weight="bold" />
            ) : step.status === "in_progress" || step.status === "running" ? (
              <CircleNotch size={12} weight="bold" />
            ) : null}
          </span>
          {showStatusLabels ? (
            <small className="project-plan-status-label">
              {statusLabels[step.status] ?? "待处理"}
            </small>
          ) : null}
          <span className="project-plan-step-title">{step.title}</span>
        </li>
      ))}
    </ol>
  );
}

function PlanCard({ plan }) {
  if (!Array.isArray(plan) || plan.length === 0) return null;
  const completed = plan.filter((step) => step.status === "completed").length;
  return (
    <details className="project-plan-card is-history" aria-label="Agent 计划">
      <summary>
        <span>Agent 计划</span>
        <small>{completed}/{plan.length}</small>
        <CaretDown size={12} aria-hidden="true" />
      </summary>
      <PlanSteps plan={plan} />
    </details>
  );
}

function planSignature(plan) {
  return (Array.isArray(plan) ? plan : [])
    .map((step) => `${step.id}:${step.status}:${step.title}`)
    .join("|");
}

export function ProjectPlanDock({ plan, running }) {
  const [expanded, setExpanded] = useState(Boolean(running));
  const normalizedPlan = normalizeActivityPlan(plan);
  const completed = normalizedPlan.filter(
    (step) => step.status === "completed",
  ).length;
  const activeStep = normalizedPlan.find(
    (step) => step.status === "in_progress" || step.status === "running",
  );
  const nextStep = normalizedPlan.find((step) => step.status === "pending");
  const runningLabel = activeStep
    ? `正在：${activeStep.title}`
    : normalizedPlan.length === 0
      ? "正在准备本轮计划"
      : completed === normalizedPlan.length
        ? "正在整理最终回答"
        : nextStep
          ? `即将：${nextStep.title}`
          : "正在工作";
  const visiblePlan = running
    && normalizedPlan.length > 0
    && completed === normalizedPlan.length
    ? [
        ...normalizedPlan,
        {
          id: "final-answer",
          title: "整理最终回答",
          status: "running",
        },
      ]
    : normalizedPlan;
  const revision = planSignature(normalizedPlan);

  useEffect(() => {
    setExpanded(Boolean(running));
  }, [revision, running]);

  if (normalizedPlan.length === 0 && !running) return null;
  return (
    <aside
      className={`project-plan-dock${running ? " is-running" : " is-settled"}${expanded ? " is-expanded" : ""}`}
      aria-label="当前 Agent 计划"
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        {running ? (
          <CircleNotch size={14} weight="bold" aria-hidden="true" />
        ) : (
          <CheckCircle size={14} weight="fill" aria-hidden="true" />
        )}
        <span>
          <strong aria-live="polite">{running ? runningLabel : "Agent 计划"}</strong>
          <small>
            {running
              ? normalizedPlan.length > 0
                ? `实时计划 · ${completed}/${normalizedPlan.length}`
                : "等待 Agent 更新计划"
              : `本轮已收起 · ${completed}/${normalizedPlan.length}`}
          </small>
        </span>
        <CaretDown size={13} aria-hidden="true" />
      </button>
      {normalizedPlan.length > 0 ? (
        <div className="project-plan-dock-body" hidden={!expanded}>
          <PlanSteps plan={visiblePlan} showStatusLabels />
        </div>
      ) : null}
    </aside>
  );
}

const SUBAGENT_STATUSES = new Set([
  "queued",
  "running",
  "completed",
  "failed",
  "timed_out",
  "interrupted",
  "aborted",
  "stopped",
]);

const SUBAGENT_STATUS_LABELS = {
  queued: "等待启动",
  running: "正在工作",
  completed: "已完成",
  failed: "未完成",
  timed_out: "已超时",
  interrupted: "已中断",
  aborted: "已停止",
  stopped: "已停止",
};

function safeSubagentText(value, maxLength = 160) {
  if (typeof value !== "string") return "";
  return value
    .replace(/(?:\/Users|\/home|\/private|\/var\/folders)\/[^\s，。；：、]+/giu, "<workspace>")
    .replace(/[A-Za-z]:\\[^\s，。；：、]+/gu, "<workspace>")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,})\b/gu, "[已隐藏]")
    .replace(/\b(\d+)\/(\d+)\s+succeeded\b/giu, "$1/$2 个子任务已完成")
    .replace(/===\s*Task\s+(\d+)\s*:\s*[^=\n]{1,160}\s*===\s*/giu, "子任务 $1：")
    .replace(/===\s*Task\s+(\d+)\s*===\s*/giu, "子任务 $1：")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxLength);
}

function safeSubagentPath(value) {
  const path = safeSubagentText(value, 180);
  if (!path || path === "<workspace>") return path;
  if (
    path.startsWith("/")
    || path.startsWith("~")
    || /^[A-Za-z]:[\\/]/u.test(path)
    || path.split(/[\\/]/u).includes("..")
  ) {
    return "<workspace>";
  }
  return path;
}

function boundedSubagentNumber(value) {
  return Number.isFinite(Number(value)) && Number(value) >= 0
    ? Number(value)
    : null;
}

export function normalizeSubagentRun(event, fallbackIndex = 1, depth = 0) {
  if (!event || depth > 2) return null;
  const source = event?.data?.subagentRun
    ?? event?.subagentRun
    ?? event?.data?.subagent
    ?? event;
  const eventStatus = event.status ?? event.data?.status;
  const rawStatus = source.status ?? eventStatus;
  const status = SUBAGENT_STATUSES.has(rawStatus)
    ? rawStatus
    : rawStatus === "active"
      ? "running"
      : rawStatus === "succeeded"
        ? "completed"
        : "queued";
  const index = Number.isSafeInteger(Number(source.index))
    && Number(source.index) > 0
    ? Number(source.index)
    : fallbackIndex;
  const rawChildren = Array.isArray(source.children)
    ? source.children
    : Array.isArray(source.tasks)
      ? source.tasks
      : [];
  const children = rawChildren.slice(0, 8).flatMap((child, childIndex) => {
    const normalized = normalizeSubagentRun(child, childIndex + 1, depth + 1);
    return normalized ? [normalized] : [];
  });
  const error = source.error && typeof source.error === "object"
    ? source.error.message
    : source.error;
  return {
    key: `${event.seq ?? "run"}-${index}-${depth}`,
    index,
    task: safeSubagentText(
      source.task ?? source.title ?? source.label,
      120,
    ) || `并行子任务 ${index}`,
    status,
    currentTool: safeSubagentText(source.currentTool, 80),
    currentPath: safeSubagentPath(source.currentPath),
    modelRef: safeSubagentText(source.modelRef ?? source.model, 120),
    toolCount: boundedSubagentNumber(source.toolCount),
    turnCount: boundedSubagentNumber(source.turnCount),
    tokens: boundedSubagentNumber(source.tokens),
    durationMs: boundedSubagentNumber(source.durationMs),
    summary: safeSubagentText(
      source.summary ?? event.summary ?? event.detail ?? event.data?.summary,
      300,
    ),
    error: safeSubagentText(error, 240),
    children,
  };
}

export function subagentRunsFromEvents(events) {
  return collapseToolActivity(
    (Array.isArray(events) ? events : [])
      .filter((event) => TOOL_ACTIVITY_TYPES.has(event?.type))
      .sort((left, right) => left.seq - right.seq),
  ).filter((event) => event.toolName === "subagent")
    .map((event, index) => normalizeSubagentRun(event, index + 1))
    .filter(Boolean);
}

function SubagentActivityCard({ run, onOpenArtifact }) {
  const details = [
    run.currentTool ? `当前：${TOOL_LABELS[run.currentTool] ?? run.currentTool}` : "",
    run.currentPath,
  ].filter(Boolean).join(" · ");
  return (
    <article
      className={`project-subagent-activity is-${run.status}`}
      aria-label={`子智能体：${run.task}`}
    >
      <GitBranch size={15} weight="bold" aria-hidden="true" />
      <div>
        <strong>{run.task}</strong>
        <small>并行子智能体{SUBAGENT_STATUS_LABELS[run.status]}{details ? ` · ${details}` : ""}</small>
      </div>
      <button type="button" onClick={() => onOpenArtifact?.("run_result")}>
        查看运行
        <CaretRight size={12} weight="bold" aria-hidden="true" />
      </button>
    </article>
  );
}

function ActivityEvent({ event, isLatest, isLatestProgress = false, onOpenArtifact }) {
  const [open, setOpen] = useState(isLatest);
  const artifactId = eventArtifact(event);
  const thinkingPhase = event.type === "agent.thinking"
    || event.type === "activity.phase";
  const autoReviewDecision = event.type === "auto_review.decision";
  const autoReviewBlocked = autoReviewDecision
    && eventTitle(event) === "已阻止高风险操作";

  useEffect(() => {
    setOpen(isLatest);
  }, [isLatest]);

  if (event.toolName === "subagent") {
    const run = normalizeSubagentRun(event);
    return run ? (
      <SubagentActivityCard run={run} onOpenArtifact={onOpenArtifact} />
    ) : null;
  }

  if (event.type === "agent.progress") {
    const narration = progressNarration(event);
    return (
      <article
        className={`project-activity-progress${isLatestProgress ? " is-latest" : ""}`}
        {...(isLatestProgress ? {
          role: "status",
          "aria-live": "polite",
        } : {})}
      >
        <span className="project-activity-progress-dot" aria-hidden="true" />
        <div>
          <p>{narration.summary}</p>
          {narration.detail ? <small>{narration.detail}</small> : null}
        </div>
      </article>
    );
  }

  return (
    <details
      className={[
        thinkingPhase ? "is-thinking" : "",
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
          {thinkingPhase || event.hideSequence ? "" : `#${event.seq}`}
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
    if (["failed", "aborted", "stopped"].includes(event.status)) {
      return event.status;
    }
    return "completed";
  }
  if (["completed", "failed", "aborted", "stopped"].includes(previousStatus)) {
    return previousStatus;
  }
  return "active";
}

function collapseToolActivity(events) {
  const collapsed = [];
  const toolIndexes = new Map();

  for (const event of events) {
    const firstSeq = Number.isSafeInteger(event.firstSeq)
      ? event.firstSeq
      : event.seq;
    const lastSeq = Number.isSafeInteger(event.lastSeq)
      ? event.lastSeq
      : event.seq;
    if (!TOOL_ACTIVITY_TYPES.has(event.type)) {
      collapsed.push({
        ...event,
        firstSeq,
        lastSeq,
      });
      continue;
    }

    const callKey = event.toolCallId || `seq-${event.seq}`;
    const existingIndex = toolIndexes.get(callKey);
    if (existingIndex === undefined) {
      toolIndexes.set(callKey, collapsed.length);
      collapsed.push({
        ...event,
        seq: firstSeq,
        firstSeq,
        lastSeq,
        activityKey: `tool-${callKey}`,
        status: toolActivityStatus(event),
      });
      continue;
    }

    const existing = collapsed[existingIndex];
    const lifecycleFirstSeq = existing.firstSeq ?? existing.seq;
    collapsed[existingIndex] = {
      ...existing,
      ...event,
      data: {
        ...(existing.data ?? {}),
        ...(event.data ?? {}),
        ...(
          existing.data?.subagentRun || event.data?.subagentRun
            ? {
                subagentRun: {
                  ...(existing.data?.subagentRun ?? {}),
                  ...(event.data?.subagentRun ?? {}),
                },
              }
            : {}
        ),
      },
      seq: lifecycleFirstSeq,
      firstSeq: lifecycleFirstSeq,
      lastSeq: Math.max(existing.lastSeq ?? existing.seq, lastSeq),
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
  event.lastSeq = Math.max(event.lastSeq, toolEvent.lastSeq ?? toolEvent.seq);
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
  event.lastSeq = Math.max(event.lastSeq, commandEvent.lastSeq ?? commandEvent.seq);
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

function currentTurnActivityEvents(events) {
  const safeEvents = (Array.isArray(events) ? events : [])
    .filter((event) => Number.isSafeInteger(event?.seq) && event.seq > 0)
    .sort((left, right) => left.seq - right.seq);
  const latestMessageSeq = safeEvents.reduce((latest, event) => (
    event.type === "message.created" && Number.isSafeInteger(event.seq)
      ? Math.max(latest, event.seq)
      : latest
  ), 0);
  return {
    latestMessageSeq,
    events: safeEvents.filter((event) => (
      latestMessageSeq === 0 || event.seq >= latestMessageSeq
    )),
  };
}

function activityTurnBoundary(event) {
  if (event?.type === "message.created") {
    return {
      messageId: event.messageId ?? event.data?.id ?? null,
      turnId: event.turnId ?? event.data?.turnId ?? event.data?.id ?? null,
      turnSeq: event.turnSeq ?? event.data?.turnSeq ?? null,
      attempt: event.attempt ?? event.data?.attempt ?? null,
    };
  }
  if (event?.type === "follow_up.delivered") {
    return {
      messageId: event.messageId ?? event.data?.messageId ?? null,
      turnId: event.turnId
        ?? event.data?.turnId
        ?? event.data?.messageId
        ?? null,
      turnSeq: event.turnSeq ?? event.data?.turnSeq ?? null,
      attempt: event.attempt ?? event.data?.attempt ?? null,
    };
  }
  if (event?.type === "turn.started") {
    return {
      messageId: event.messageId ?? event.data?.messageId ?? null,
      turnId: event.turnId ?? event.data?.turnId ?? null,
      turnSeq: event.turnSeq ?? event.data?.turnSeq ?? null,
      attempt: event.attempt ?? event.data?.attempt ?? null,
    };
  }
  return null;
}

function activityBoundaryMatchesTurn(boundary, turn) {
  if (!boundary || !turn) return false;
  const turnId = turn.turnId ?? turn.id ?? null;
  if (turnId && boundary.turnId) return boundary.turnId === turnId;
  if (turn.id && boundary.messageId) return boundary.messageId === turn.id;
  return Number.isSafeInteger(turn.turnSeq)
    && Number.isSafeInteger(boundary.turnSeq)
    && boundary.turnSeq === turn.turnSeq;
}

export function activityTurnScopes(events) {
  const safeEvents = (Array.isArray(events) ? events : [])
    .filter((event) => Number.isSafeInteger(event?.seq) && event.seq > 0)
    .sort((left, right) => left.seq - right.seq);
  const scopes = [];
  let current = null;
  for (const event of safeEvents) {
    const boundary = activityTurnBoundary(event);
    if (boundary) {
      current = { boundary, events: [] };
      scopes.push(current);
    }
    current?.events.push(event);
  }
  return scopes;
}

export function buildActivityTurnIndex(events) {
  const scopes = activityTurnScopes(events);
  const byTurnId = new Map();
  const byMessageId = new Map();
  const byTurnSeq = new Map();
  const add = (index, key, scope) => {
    if (key === null || key === undefined || key === "") return;
    const matching = index.get(key);
    if (matching) matching.push(scope);
    else index.set(key, [scope]);
  };
  for (const scope of scopes) {
    add(byTurnId, scope.boundary?.turnId, scope);
    add(byMessageId, scope.boundary?.messageId, scope);
    add(byTurnSeq, scope.boundary?.turnSeq, scope);
  }
  return { scopes, byTurnId, byMessageId, byTurnSeq };
}

function indexedActivityScopesForTurn(index, turn) {
  if (!index || !turn) return [];
  const candidates = new Set();
  const turnId = turn.turnId ?? turn.id ?? null;
  for (const scope of index.byTurnId.get(turnId) ?? []) candidates.add(scope);
  for (const scope of index.byMessageId.get(turn.id) ?? []) candidates.add(scope);
  for (const scope of index.byTurnSeq.get(turn.turnSeq) ?? []) candidates.add(scope);
  return [...candidates].filter(({ boundary }) => (
    activityBoundaryMatchesTurn(boundary, turn)
  ));
}

export function activityEventsForTurn(events, turn) {
  return activityEventsForTurnAttempt(events, turn);
}

export function activityEventsForTurnAttempt(events, turn, attempt = null) {
  return activityEventsForTurnAttemptFromIndex(
    buildActivityTurnIndex(events),
    turn,
    attempt,
  );
}

export function activityEventsForTurnAttemptFromIndex(index, turn, attempt = null) {
  const matchingScopes = indexedActivityScopesForTurn(index, turn);
  if (matchingScopes.length === 0) return [];
  const eventAttempt = (event) => (
    event?.attempt
    ?? event?.data?.attempt
    ?? event?.data?.operation?.attempt
    ?? null
  );
  const latestAttempt = [...matchingScopes]
    .reverse()
    .flatMap((scope) => [
      scope.boundary?.attempt,
      ...[...scope.events].reverse().map(eventAttempt),
    ])
    .find(Number.isSafeInteger);
  const selectedAttempt = Number.isSafeInteger(attempt)
    ? attempt
    : latestAttempt;
  const selected = new Map();
  for (const scope of matchingScopes) {
    const scopeAttempt = scope.boundary?.attempt;
    for (const event of scope.events) {
      const currentAttempt = eventAttempt(event);
      if (
        Number.isSafeInteger(selectedAttempt)
        && (
          Number.isSafeInteger(currentAttempt)
            ? currentAttempt !== selectedAttempt
            : Number.isSafeInteger(scopeAttempt)
              && scopeAttempt !== selectedAttempt
        )
      ) {
        continue;
      }
      selected.set(event.seq, event);
    }
  }
  return [...selected.values()].sort((left, right) => left.seq - right.seq);
}

const ACTIVITY_TERMINAL_STATES = {
  completed: {
    key: "completed",
    label: "已完成",
    thinkingStatus: "finished",
    thinkingDetail: "本轮思考已完成",
    summaryDetail: "本轮已结束，没有额外记录公开进展或工具活动。",
  },
  waiting: {
    key: "waiting",
    label: "等待你的回答",
    thinkingStatus: "waiting",
    thinkingDetail: "本轮思考已暂停，正在等待你的回答",
    summaryDetail: "本轮已暂停，正在等待你的回答；没有额外记录公开进展。",
  },
  stopped: {
    key: "stopped",
    label: "已停止",
    thinkingStatus: "stopped",
    thinkingDetail: "本轮思考已停止",
    summaryDetail: "本轮已经停止；停止前没有额外记录公开进展。",
  },
  incomplete: {
    key: "incomplete",
    label: "未完成",
    thinkingStatus: "incomplete",
    thinkingDetail: "本轮思考未完成",
    summaryDetail: "本轮未完成；失败前没有额外记录可安全展示的进展。",
  },
};

function terminalStateForStatus(status) {
  if (status === "awaiting_user") return ACTIVITY_TERMINAL_STATES.waiting;
  if (["aborted", "stopped", "interrupted"].includes(status)) {
    return ACTIVITY_TERMINAL_STATES.stopped;
  }
  if (["failed", "error", "verification_failed"].includes(status)) {
    return ACTIVITY_TERMINAL_STATES.incomplete;
  }
  if ([
    "idle",
    "ready",
    "completed",
    "applied",
    "awaiting_confirmation",
    "awaiting_approval",
    "changes_ready",
  ].includes(status)) {
    return ACTIVITY_TERMINAL_STATES.completed;
  }
  return null;
}

function activityTerminalState(events, fallbackStatus = null) {
  let state = null;
  const orderedEvents = (Array.isArray(events) ? events : [])
    .filter((event) => Number.isSafeInteger(event?.seq) && event.seq > 0)
    .sort((left, right) => left.seq - right.seq);
  for (const event of orderedEvents) {
    const status = event.status ?? event.data?.status ?? null;
    if (event.type === "ask_user.requested") {
      state = ACTIVITY_TERMINAL_STATES.waiting;
      continue;
    }
    if (["ask_user.answered", "ask_user.cancelled"].includes(event.type)) {
      state = null;
      continue;
    }
    if (event.type === "error") {
      state = ACTIVITY_TERMINAL_STATES.incomplete;
      continue;
    }
    if (
      event.type === "message.completed"
      && event.isFinal !== false
      && event.data?.isFinal !== false
    ) {
      state = status === "failed"
        ? ACTIVITY_TERMINAL_STATES.incomplete
        : ACTIVITY_TERMINAL_STATES.completed;
      continue;
    }
    if (event.type === "agent.status") {
      if (["running", "queued", "planning", "streaming"].includes(status)) {
        state = null;
      } else {
        state = terminalStateForStatus(status) ?? state;
      }
    }
  }
  const fallback = terminalStateForStatus(fallbackStatus);
  return fallback ?? state ?? ACTIVITY_TERMINAL_STATES.completed;
}

function formatTraceDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return null;
  if (milliseconds < 1_000) return "<1 秒";
  const seconds = Math.round(milliseconds / 100) / 10;
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.round(seconds - minutes * 60);
  return remaining > 0 ? `${minutes} 分 ${remaining} 秒` : `${minutes} 分`;
}

function formatTraceTokens(value) {
  if (!Number.isFinite(value) || value < 0) return null;
  if (value < 1_000) return `${Math.round(value)} Token`;
  const compact = Math.round(value / 100) / 10;
  return `${compact}k Token`;
}

export function summarizeActivityTrace(events) {
  const currentTurn = currentTurnActivityEvents(events).events;
  const modelTurns = currentTurn.filter(
    (event) => event.type === "turn.started",
  ).length;
  const toolCalls = collapseToolActivity(
    currentTurn.filter((event) => TOOL_ACTIVITY_TYPES.has(event.type)),
  ).length;
  const startedAt = Date.parse(
    currentTurn.find((event) => event.type === "message.created")?.createdAt
      ?? currentTurn.find((event) => event.type === "message.created")?.at
      ?? currentTurn.find((event) => event.type === "turn.started")?.createdAt
      ?? currentTurn.find((event) => event.type === "turn.started")?.at
      ?? "",
  );
  const completedEvent = [...currentTurn].reverse().find((event) => (
    event.type === "message.completed" || event.type === "turn.completed"
  ));
  const completedAt = Date.parse(
    completedEvent?.createdAt ?? completedEvent?.at ?? "",
  );
  const duration = Number.isFinite(startedAt) && Number.isFinite(completedAt)
    ? formatTraceDuration(completedAt - startedAt)
    : null;
  const totalTokens = currentTurn
    .filter((event) => event.type === "turn.completed")
    .reduce((sum, event) => (
      sum + (Number(event.data?.usage?.totalTokens) || 0)
    ), 0);
  return [
    modelTurns > 0 ? `${modelTurns} 轮模型` : "",
    toolCalls > 0 ? `${toolCalls} 次工具` : "",
    duration ?? "",
    totalTokens > 0 ? formatTraceTokens(totalTokens) : "",
  ].filter(Boolean).join(" · ");
}

export function normalizeActivityEvents(
  events,
  running,
  phase = null,
  terminalStatus = null,
) {
  const safeEvents = Array.isArray(events) ? events : [];
  const currentTurn = currentTurnActivityEvents(safeEvents);
  const terminalState = activityTerminalState(
    currentTurn.events,
    terminalStatus,
  );
  const latestMessageSeq = currentTurn.latestMessageSeq;
  const turnStartsWithThinking = new Set();
  const completedTurnStarts = new Set();
  let scannedTurnStartSeq = null;
  for (const event of currentTurn.events) {
    if (event.type === "turn.started") {
      scannedTurnStartSeq = event.seq;
    } else if (event.type === "agent.thinking" && scannedTurnStartSeq !== null) {
      turnStartsWithThinking.add(scannedTurnStartSeq);
    } else if (event.type === "turn.completed" && scannedTurnStartSeq !== null) {
      completedTurnStarts.add(scannedTurnStartSeq);
    }
  }
  const currentTurnEvents = currentTurn.events
    .map((event) => {
      if (
        event.type !== "message.completed"
        || (
          event.isFinal !== false
          && event.data?.isFinal !== false
        )
      ) {
        return event;
      }
      const text = [event.text, event.data?.text].find(
        (value) => typeof value === "string" && value.trim(),
      );
      if (!text) return event;
      return {
        ...event,
        type: "agent.progress",
        data: {
          summary: text.trim().slice(0, 500),
          detail: null,
          source: "intermediate_assistant_message",
        },
      };
    })
    .filter((event) => (
      event.type === "turn.started"
      || event.type === "turn.completed"
      || !QUIET_EVENT_TYPES.has(event.type)
    ));
  const hasRuntimeFallback = currentTurnEvents.some((event) => (
    event.type === "agent.progress"
    && event.data?.source === "runtime_fallback"
  ));
  const completedVerificationIds = new Set(
    currentTurnEvents
      .filter((event) => event.type === "verification.completed" && event.eventId)
      .map((event) => event.eventId),
  );
  const normalized = [];
  let activeThinkingEvent = null;
  let latestThinkingEvent = null;
  let latestPhaseEvent = null;
  let researchEvent = null;
  let commandEvent = null;
  let previousActivityKind = null;
  let activeTurnStartSeq = null;
  const thinkingCyclesByTurn = new Map();

  const closeVisibleBatches = () => {
    researchEvent = null;
    commandEvent = null;
  };

  const finishActiveThinking = (status = "finished") => {
    if (!activeThinkingEvent) return;
    activeThinkingEvent.status = status;
    activeThinkingEvent.detail = status === "finished"
      ? safePhasePresentation(
        activeThinkingEvent.phaseContext,
        "finished",
      ).detail
      : terminalState.thinkingDetail;
    activeThinkingEvent = null;
  };

  for (const event of collapseToolActivity(currentTurnEvents)) {
    if (event.type === "turn.started") {
      finishActiveThinking();
      if (!hasRuntimeFallback) closeVisibleBatches();
      activeTurnStartSeq = event.firstSeq ?? event.seq;
      if (
        !hasRuntimeFallback
        && !turnStartsWithThinking.has(activeTurnStartSeq)
      ) {
        const status = completedTurnStarts.has(activeTurnStartSeq)
          ? "finished"
          : running
            ? "active"
            : terminalState.key;
        const presentation = safePhasePresentation(
          previousActivityKind,
          status,
        );
        latestPhaseEvent = {
          type: "activity.phase",
          seq: activeTurnStartSeq,
          firstSeq: activeTurnStartSeq,
          lastSeq: event.lastSeq ?? event.seq,
          activityKey: `phase-${latestMessageSeq || "current"}-${activeTurnStartSeq}`,
          hideSequence: true,
          status,
          phaseContext: previousActivityKind,
          title: presentation.title,
          detail: presentation.detail,
        };
        normalized.push(latestPhaseEvent);
      }
      continue;
    }
    if (event.type === "turn.completed") {
      finishActiveThinking();
      continue;
    }
    if (event.type === "agent.progress") {
      const narration = progressNarration(event);
      if (!narration.summary) continue;
      closeVisibleBatches();
      normalized.push({
        ...event,
        activityKey: event.activityKey ?? `progress-${event.eventId ?? event.seq}`,
        hideSequence: true,
      });
      previousActivityKind = "progress";
      continue;
    }
    if (event.type === "agent.thinking") {
      const status = event.status === "finished" ? "finished" : "active";
      if (!activeThinkingEvent) {
        closeVisibleBatches();
        const turnKey = activeTurnStartSeq || event.firstSeq || event.seq;
        const cycle = (thinkingCyclesByTurn.get(turnKey) ?? 0) + 1;
        thinkingCyclesByTurn.set(turnKey, cycle);
        activeThinkingEvent = {
          type: "agent.thinking",
          seq: event.firstSeq ?? event.seq,
          firstSeq: event.firstSeq ?? event.seq,
          lastSeq: event.lastSeq ?? event.seq,
          activityKey: `phase-${latestMessageSeq || "current"}-${turnKey}${cycle > 1 ? `-${cycle}` : ""}`,
          status,
          phaseContext: previousActivityKind,
          detail: safePhasePresentation(previousActivityKind, status).detail,
        };
        latestThinkingEvent = activeThinkingEvent;
        normalized.push(activeThinkingEvent);
      } else {
        activeThinkingEvent.lastSeq = Math.max(
          activeThinkingEvent.lastSeq,
          event.lastSeq ?? event.seq,
        );
        activeThinkingEvent.status = status;
        activeThinkingEvent.detail = safePhasePresentation(
          activeThinkingEvent.phaseContext,
          status,
        ).detail;
      }
      if (status === "finished") finishActiveThinking();
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
      commandEvent = null;
      if (!researchEvent) {
        const firstSeq = event.firstSeq ?? event.seq;
        researchEvent = {
          type: "activity.research_summary",
          seq: firstSeq,
          firstSeq,
          lastSeq: event.lastSeq ?? event.seq,
          activityKey: `research-${firstSeq}`,
          artifactId: null,
          hideSequence: true,
          counts: { project: 0, document: 0, retrieval: 0 },
          status: "completed",
        };
        normalized.push(researchEvent);
      }
      updateResearchSummary(researchEvent, event, running);
      previousActivityKind = "research";
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
      researchEvent = null;
      if (!commandEvent) {
        const firstSeq = event.firstSeq ?? event.seq;
        commandEvent = {
          type: "activity.command_summary",
          seq: firstSeq,
          firstSeq,
          lastSeq: event.lastSeq ?? event.seq,
          activityKey: `commands-${firstSeq}`,
          artifactId: "run_result",
          hideSequence: true,
          prepared: 0,
          ran: 0,
          active: 0,
        };
        normalized.push(commandEvent);
      }
      updateCommandSummary(commandEvent, event, running);
      previousActivityKind = "command";
      continue;
    }
    closeVisibleBatches();
    normalized.push(event);
    if (TOOL_ACTIVITY_TYPES.has(event.type)) {
      previousActivityKind = "action";
    }
  }

  if (activeThinkingEvent) {
    const status = running ? "active" : terminalState.thinkingStatus;
    activeThinkingEvent.status = status;
    activeThinkingEvent.detail = status === "active"
      ? safePhasePresentation(
        activeThinkingEvent.phaseContext,
        status,
      ).detail
      : terminalState.thinkingDetail;
  }
  const latestReasoningEvent = [latestThinkingEvent, latestPhaseEvent]
    .filter(Boolean)
    .sort((left, right) => (
      (right.firstSeq ?? right.seq) - (left.firstSeq ?? left.seq)
    ))[0];
  if (
    !running
    && latestReasoningEvent
    && terminalState.key !== "completed"
  ) {
    latestReasoningEvent.status = terminalState.thinkingStatus;
    if (latestReasoningEvent.type === "activity.phase") {
      const presentation = safePhasePresentation(
        latestReasoningEvent.phaseContext,
        terminalState.thinkingStatus,
      );
      latestReasoningEvent.title = presentation.title;
      latestReasoningEvent.detail = presentation.detail;
    } else {
      latestReasoningEvent.detail = terminalState.thinkingDetail;
    }
  }
  if (normalized.length === 0 && running) {
    const hasPartialAnswer = safeEvents.some((event) => (
      isStreamingAnswerEvent(event)
      && (
        latestMessageSeq === 0
        || (Number.isSafeInteger(event.seq) && event.seq >= latestMessageSeq)
      )
    ));
    normalized.push({
      type: hasPartialAnswer ? "activity.responding" : "activity.preparing",
      seq: currentTurnEvents.at(-1)?.seq ?? latestMessageSeq ?? 0,
      firstSeq: currentTurnEvents.at(-1)?.seq ?? latestMessageSeq ?? 0,
      lastSeq: currentTurnEvents.at(-1)?.seq ?? latestMessageSeq ?? 0,
      activityKey: `phase-${latestMessageSeq || "current"}`,
      hideSequence: true,
      status: "active",
      title: phase === "submitting"
        ? "正在提交本轮任务"
        : hasPartialAnswer
          ? "正在生成公开回复"
          : "正在准备本轮工作",
      detail: phase === "submitting"
        ? "正在连接 Pi 会话并登记任务"
        : hasPartialAnswer
          ? "回答正文正在逐步写入"
          : "Pi 已接收任务，正在准备上下文与模型回复",
    });
  } else if (
    normalized.length === 0
    && currentTurn.events.some((event) => [
      "message.created",
      "follow_up.delivered",
      "message.completed",
      "agent.status",
    ].includes(event.type))
  ) {
    normalized.push({
      type: "activity.turn_summary",
      seq: currentTurn.events.at(-1)?.seq ?? currentTurn.latestMessageSeq ?? 0,
      firstSeq: currentTurn.events.at(-1)?.seq
        ?? currentTurn.latestMessageSeq
        ?? 0,
      lastSeq: currentTurn.events.at(-1)?.seq
        ?? currentTurn.latestMessageSeq
        ?? 0,
      activityKey: `terminal-${currentTurn.latestMessageSeq || "turn"}`,
      hideSequence: true,
      status: terminalState.key,
      title: "本轮状态已记录",
      detail: terminalState.summaryDetail,
    });
  }
  return normalized;
}

function fallbackProgressCopy(stage, toolNames) {
  const hasResearch = toolNames.some((name) => RESEARCH_TOOL_GROUPS[name]);
  const hasAction = toolNames.some((name) => (
    !RESEARCH_TOOL_GROUPS[name]
    && !HIDDEN_TOOL_ACTIVITY.has(name)
  ));
  if (stage === "start") {
    return "我先确认任务范围，再按需查看相关资料。";
  }
  if (stage === "middle") {
    if (hasResearch && !hasAction) {
      return "已经查看了一批相关资料，正在交叉核对关键依据。";
    }
    if (hasAction) {
      return "主要步骤已经推进，正在核对工具结果和剩余问题。";
    }
    return "当前步骤已经推进，正在确认下一步。";
  }
  if (hasResearch && !hasAction) {
    return "关键资料已经核对，正在整理结论与适用边界。";
  }
  if (hasAction) {
    return "关键操作已经完成，正在整理结果与验证证据。";
  }
  return "主要检查已经完成，正在整理最终结果。";
}

export function withRuntimeProgressFallback(events, running = false) {
  const safeEvents = Array.isArray(events) ? events : [];
  const currentTurn = currentTurnActivityEvents(safeEvents).events;
  const hasPublicNarration = currentTurn.some((event) => (
    event.type === "agent.progress"
    || (
      event.type === "message.completed"
      && (event.isFinal === false || event.data?.isFinal === false)
      && [event.text, event.data?.text].some(
        (value) => typeof value === "string" && value.trim(),
      )
    )
  ));
  if (hasPublicNarration) return safeEvents;

  const toolCalls = collapseToolActivity(
    currentTurn.filter((event) => TOOL_ACTIVITY_TYPES.has(event.type)),
  ).filter((event) => !HIDDEN_TOOL_ACTIVITY.has(event.toolName));
  if (toolCalls.length === 0) return safeEvents;

  const firstCall = toolCalls[0];
  const lastCall = toolCalls.at(-1);
  const toolNames = toolCalls.map((event) => event.toolName).filter(Boolean);
  const milestones = [{
    stage: "start",
    position: "before",
    seq: firstCall.firstSeq ?? firstCall.seq,
    event: firstCall,
  }];
  if (toolCalls.length >= 4) {
    const middleCall = toolCalls[Math.floor((toolCalls.length - 1) / 2)];
    milestones.push({
      stage: "middle",
      position: "after",
      seq: middleCall.lastSeq ?? middleCall.seq,
      event: middleCall,
    });
  }
  if (!running) {
    milestones.push({
      stage: "finish",
      position: "after",
      seq: lastCall.lastSeq ?? lastCall.seq,
      event: lastCall,
    });
  }

  const before = new Map();
  const after = new Map();
  for (const milestone of milestones) {
    const target = milestone.position === "before" ? before : after;
    const progress = {
      seq: milestone.seq,
      type: "agent.progress",
      activityKey: `runtime-progress-${milestone.stage}-${milestone.seq}`,
      hideSequence: true,
      status: milestone.stage === "finish" ? "completed" : "active",
      turnId: milestone.event.turnId ?? milestone.event.data?.turnId ?? null,
      attempt: milestone.event.attempt ?? milestone.event.data?.attempt ?? null,
      data: {
        summary: fallbackProgressCopy(milestone.stage, toolNames),
        detail: null,
        source: "runtime_fallback",
      },
    };
    target.set(milestone.seq, [
      ...(target.get(milestone.seq) ?? []),
      progress,
    ]);
  }

  return safeEvents.flatMap((event) => [
    ...(before.get(event.seq) ?? []),
    event,
    ...(after.get(event.seq) ?? []),
  ]);
}

function HarnessSnapshot({ event }) {
  const snapshot = event?.data;
  if (!snapshot || typeof snapshot !== "object") return null;
  const tools = Array.isArray(snapshot.activeTools) ? snapshot.activeTools : [];
  const skills = Array.isArray(snapshot.skills) ? snapshot.skills : [];
  const layers = Array.isArray(snapshot.prompt?.layers)
    ? snapshot.prompt.layers
    : [];
  const model = [snapshot.providerId, snapshot.modelId]
    .filter(Boolean)
    .join(" / ");
  const thinking = THINKING_LEVEL_LABELS[snapshot.thinkingLevel]
    ?? snapshot.thinkingLevel
    ?? "未记录";
  const workspace = snapshot.context?.workspace === "scratch"
    ? "独立对话工作区"
    : "项目 Workspace";
  const snapshotScope = snapshot.context?.snapshot === "bounded"
    ? "有边界快照"
    : "当前安全快照";

  return (
    <details className="project-harness-snapshot">
      <summary>
        <ShieldCheck size={14} weight="fill" aria-hidden="true" />
        <span>
          <strong>Harness 快照</strong>
          <small>{snapshot.harnessVersion ?? "project-work"}</small>
        </span>
        <CaretDown size={12} aria-hidden="true" />
      </summary>
      <div className="project-harness-snapshot-body">
        <dl>
          <div>
            <dt>模型</dt>
            <dd>{model || "未记录"} · {thinking}</dd>
          </div>
          <div>
            <dt>工具</dt>
            <dd>
              {tools.length > 0
                ? tools.map((name) => TOOL_LABELS[name] ?? name).join("、")
                : "本轮未启用工具"}
            </dd>
          </div>
          <div>
            <dt>Skills</dt>
            <dd>{skills.length > 0 ? skills.join("、") : "本轮未启用 Skill"}</dd>
          </div>
          <div>
            <dt>上下文</dt>
            <dd>
              {workspace} · {snapshotScope}
              {snapshot.context?.projectRules > 0
                ? ` · ${snapshot.context.projectRules} 份项目规则`
                : ""}
            </dd>
          </div>
        </dl>
        {layers.length > 0 ? (
          <p className="project-harness-prompt">
            <strong>提示结构</strong>
            <span>{layers.join(" → ")}</span>
          </p>
        ) : null}
        <p className="project-harness-boundary">
          展示可审计事件和公开输出；私有推理、密钥与未脱敏内容不会进入浏览器。
        </p>
      </div>
    </details>
  );
}

export function ActivityTimeline({
  events,
  running,
  compact,
  transparentMode = false,
  phase,
  terminalStatus = null,
  onOpenArtifact,
}) {
  const [expanded, setExpanded] = useState(!compact);
  const normalizedEvents = normalizeActivityEvents(
    withRuntimeProgressFallback(events, running),
    running,
    phase,
    terminalStatus,
  );
  const visibleEvents = normalizedEvents;
  const currentTurn = currentTurnActivityEvents(events).events;
  const terminalState = activityTerminalState(currentTurn, terminalStatus);
  const harnessEvent = [...currentTurn]
    .reverse()
    .find((event) => event.type === "harness.snapshot");
  const traceSummary = summarizeActivityTrace(events);
  const latestProgressEvent = [...visibleEvents]
    .reverse()
    .find((event) => event.type === "agent.progress");
  const latestProgressSummary = latestProgressEvent
    ? progressNarration(latestProgressEvent).summary
    : "";

  useEffect(() => {
    setExpanded(!compact);
  }, [compact]);

  if (
    visibleEvents.length === 0
    && !(transparentMode && harnessEvent)
  ) {
    return null;
  }
  return (
    <section
      className={[
        "project-activity",
        running ? "is-running" : "is-settled",
        running ? "" : `is-${terminalState.key}`,
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
        ) : terminalState.key === "stopped" ? (
          <StopCircle size={15} weight="fill" aria-hidden="true" />
        ) : ["waiting", "incomplete"].includes(terminalState.key) ? (
          <WarningCircle size={15} weight="fill" aria-hidden="true" />
        ) : (
          <CheckCircle size={15} weight="fill" aria-hidden="true" />
        )}
        <span>
          <strong>
            {transparentMode
              ? running
                ? "Agent 透视 · 正在工作"
                : `Agent 透视 · ${terminalState.label}`
              : running
                ? "Agent 正在工作"
                : terminalState.label}
          </strong>
          <small>
            {transparentMode
              ? traceSummary || `${visibleEvents.length} 项过程`
              : running
                ? latestProgressSummary || `${visibleEvents.length} 项实时进展`
                : `${visibleEvents.length} 项 · 查看过程`}
          </small>
        </span>
        <CaretDown size={13} aria-hidden="true" />
      </button>
      <div className="project-activity-body" hidden={!expanded}>
        {transparentMode ? <HarnessSnapshot event={harnessEvent} /> : null}
        {visibleEvents.map((event, index) => (
          <ActivityEvent
            event={event}
            isLatest={index === visibleEvents.length - 1}
            isLatestProgress={event === latestProgressEvent}
            key={event.activityKey ?? event.seq}
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
  const mode = ["manual_review", "auto_review", "native"].includes(
    executionPolicy?.mode,
  )
    ? executionPolicy.mode
    : "manual_review";
  const native = mode === "native";
  const disabled = native || running || saving;
  const label = saving
    ? "正在保存"
    : native
      ? "Pi 原生"
    : mode === "auto_review"
      ? "替我审批"
      : "需确认";

  if (native) return null;

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
          native ? "is-native" : "",
        ].filter(Boolean).join(" ")}
        type="button"
        disabled={disabled}
        aria-expanded={open && !disabled}
        aria-haspopup={native ? undefined : "dialog"}
        aria-controls={native ? undefined : "project-execution-policy-popover"}
        title={native
          ? "可信 Workspace：选择项目即表示信任；Pi 可原生读取、修改和运行项目"
          : running
            ? "Agent 工作期间不能更改权限"
            : "设置当前会话的工作权限"}
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
        {!native ? <CaretUp size={11} weight="bold" aria-hidden="true" /> : null}
      </button>

      {open && !disabled && !native ? (
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
  hideTrigger = false,
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
      {!hideTrigger ? (
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
      ) : null}
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
              <span>本轮能力</span>
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
                      ) : capability.id === "image_generation" ? (
                        <ImageSquare size={15} aria-hidden="true" />
                      ) : capability.id === "github_read" ? (
                        <GithubLogo size={15} aria-hidden="true" />
                      ) : capability.id === "vercel_read" ? (
                        <Cloud size={15} aria-hidden="true" />
                      ) : (
                        <Files size={15} aria-hidden="true" />
                      )}
                    </span>
                    <span>
                      <strong>{capability.label}</strong>
                      <small>
                        {status.available
                          ? capability.id === "image_generation"
                            ? status.reason || capability.description
                            : capability.description
                          : status.reason}
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

function ProjectHeaderMoreMenu({
  open,
  onOpenChange,
  selectedCapabilityCount = 0,
  onOpenCapabilities,
  onOpenPath,
  transparentMode = false,
  onToggleTransparentMode,
  notificationControl,
}) {
  useEffect(() => {
    if (!open) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onOpenChange, open]);

  const runAction = (callback) => {
    onOpenChange(false);
    callback?.();
  };

  return (
    <div className="project-header-more-menu">
      {open ? (
        <button
          className="popover-scrim"
          type="button"
          aria-label="关闭更多选项"
          onClick={() => onOpenChange(false)}
        />
      ) : null}
      <button
        className={`header-meta-pill project-header-more-trigger${open ? " is-open" : ""}`}
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => onOpenChange(!open)}
      >
        <DotsThree size={15} weight="bold" aria-hidden="true" />
        <span>更多</span>
        <CaretDown size={11} weight="bold" aria-hidden="true" />
      </button>
      {open ? (
        <section className="project-header-more-popover" role="menu" aria-label="更多会话选项">
          <button type="button" role="menuitem" onClick={() => runAction(onOpenCapabilities)}>
            <Package size={15} aria-hidden="true" />
            <span>
              <strong>本轮能力</strong>
              <small>{selectedCapabilityCount > 0 ? `已选择 ${selectedCapabilityCount} 项` : "按需为下一条消息启用"}</small>
            </span>
            <CaretRight size={12} aria-hidden="true" />
          </button>
          <button type="button" role="menuitem" onClick={() => runAction(onOpenPath)}>
            <GitBranch size={15} aria-hidden="true" />
            <span>
              <strong>会话路径</strong>
              <small>查看检查点、分支与工作区</small>
            </span>
            <CaretRight size={12} aria-hidden="true" />
          </button>
          <button
            className={transparentMode ? "is-active" : ""}
            type="button"
            role="menuitemcheckbox"
            aria-checked={transparentMode}
            onClick={() => onToggleTransparentMode?.()}
          >
            <Gauge size={15} weight={transparentMode ? "fill" : "regular"} aria-hidden="true" />
            <span>
              <strong>透明模式</strong>
              <small>{transparentMode ? "正在显示过程细节" : "需要时查看 Harness 与用量"}</small>
            </span>
            <span className="project-header-more-state">{transparentMode ? "开" : "关"}</span>
          </button>
          {notificationControl}
          <footer>飞书提醒等全局偏好可在左下角“设置”中管理。</footer>
        </section>
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
  autoReview = false,
  native = false,
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
            {native
              ? "回答只用于明确任务需求。当前项目已进入可信 Pi 原生模式，Agent 会继续在同一 Workspace 工作。"
              : autoReview
              ? "回答只用于明确任务需求。当前为“替我审批”，符合安全范围的修改会自动写入；超出范围的操作会直接阻止。"
              : "回答只用于明确任务需求，不代表批准任何文件修改。写入仍需在“更改”中核对并确认。"}
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

function TurnEvidence({ message, attemptCount = 1 }) {
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
    Number.isFinite(message.attempt) && attemptCount > 1
      ? `方案 ${message.attempt}/${attemptCount}`
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

function GeneratedImageCards({
  conversationId,
  images,
  imageUrl,
  onOpenArtifact,
}) {
  if (!Array.isArray(images) || images.length === 0) return null;
  return (
    <div className="project-agent-generated-images" aria-label="本轮生成图片">
      {images.map((image) => {
        const src = typeof imageUrl === "function"
          ? imageUrl({ conversationId, imageId: image.id })
          : null;
        return (
          <figure key={image.id}>
            {src ? (
              <img
                src={src}
                alt={image.prompt?.slice(0, 160) || "Pi Agent 生成的图片"}
              />
            ) : null}
            <figcaption>
              <span>
                <strong>GPT Image 2</strong>
                <small>
                  {image.width && image.height
                    ? `${image.width} × ${image.height}`
                    : "图片已生成"}
                  {image.usage?.totalTokens
                    ? ` · ${formatTurnTokenCount(image.usage.totalTokens)} tokens`
                    : ""}
                  {" · ChatGPT 订阅 · 未提供单次价格"}
                </small>
              </span>
              <button type="button" onClick={() => onOpenArtifact?.("files")}>
                在文件中查看
                <CaretRight size={12} aria-hidden="true" />
              </button>
            </figcaption>
          </figure>
        );
      })}
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
  pendingAttachments = [],
  uploadingAttachments = [],
  onRemoveAttachment,
  onDropFiles,
  localFileInputRef,
  supportsImages,
  onSubmit,
  onAbort,
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
  onOpenCodeEvidence,
  generatedImageUrl,
  action,
  error,
  modelSelectionDisabled = false,
  executionPolicyControl,
  contextUsageControl,
  transparentMode = false,
  uploadingPdf,
  onRetryDocument,
  retryingDocumentId,
  standalone = false,
  selectedCheckpointId = null,
  branchTarget = null,
  onCancelBranch,
}) {
  const running = isConversationRunning(conversation);
  const submitting = action === "message";
  const workActive = running || submitting;
  const pendingAskUserRequest = (conversation.askUserRequests ?? []).find(
    (request) => request.status === "pending",
  );
  const queuedFollowUps = (conversation.followUpQueue ?? []).filter(
    (item) => item.status === "queued",
  );
  const unresolvedVerification = verificationAttention(conversation);
  const pendingWorkspaceWrites = (conversation.workspaceWrites ?? []).filter(
    (write) => write.status === "pending",
  );
  const autoReview = conversation.executionPolicy?.mode === "auto_review";
  const nativeExecution = conversation.executionPolicy?.mode === "native";
  const streamRef = useRef(null);
  const attachmentMenuRef = useRef(null);
  const dragDepthRef = useRef(0);
  const followLatestRef = useRef(true);
  const [dropActive, setDropActive] = useState(false);
  const sessionView = useMemo(() => projectSessionMessageView(
    conversation.messages,
    conversation.sessionPath,
    selectedCheckpointId,
  ), [conversation.messages, conversation.sessionPath, selectedCheckpointId]);
  const visibleMessages = sessionView.messages;
  const previousConversationIdRef = useRef(conversation.id);
  const previousRunningRef = useRef(running);
  const userMessageCount = visibleMessages.filter(
    (message) => message.role === "user",
  ).length;
  const previousUserMessageCountRef = useRef(userMessageCount);
  const turnPayloadLocked = action === "message" || action === "follow-up";
  const awaitingUser = Boolean(pendingAskUserRequest);
  const selectedWorkflow = projectWorkWorkflow(selectedWorkflowId);
  const selectedCapabilities = selectedCapabilityIds
    .map(projectWorkCapability)
    .filter(Boolean);
  const imageUnsupported = Boolean(pendingImage) && !supportsImages;
  const workflowImageMissing = selectedWorkflow?.requiresImages === true
    && !pendingImage;
  const turnSelectionDeferred = running && Boolean(
    pendingImage
    || pendingAttachments.length > 0
    || selectedWorkflow
    || selectedCapabilities.length > 0,
  );
  const canSubmit = Boolean(
    draft.trim()
    && !action
    && !modelSelectionDisabled
    && uploadingAttachments.length === 0
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
  const persistedPlan = normalizeActivityPlan(conversation.plan);
  const dockPlan = persistedPlan.length > 0
    ? persistedPlan
    : planFromActivityEvents(conversation.events);
  const dockPlanSignature = planSignature(dockPlan);
  const activityTurnIndex = useMemo(
    () => buildActivityTurnIndex(conversation.events),
    [conversation.events],
  );
  const activityByUserMessageId = new Map();
  let latestExecutedTurnStartSeq = 0;
  const userMessages = visibleMessages.filter(
    (message) => message.role === "user",
  );
  for (const message of userMessages) {
    const turnKey = sessionTurnKey(message, `user:${message.id}`);
    const turnAttempt = sessionView.attemptMetaByTurn.get(turnKey)?.attempt;
    const turnEvents = activityEventsForTurnAttemptFromIndex(
      activityTurnIndex,
      message,
      turnAttempt,
    );
    if (turnEvents.length === 0) continue;
    const startSeq = turnEvents[0].seq;
    activityByUserMessageId.set(message.id, { events: turnEvents, startSeq });
    latestExecutedTurnStartSeq = Math.max(latestExecutedTurnStartSeq, startSeq);
  }
  if (
    activityByUserMessageId.size === 0
    && userMessages.length === 1
    && conversation.events.some((event) => event.type === "message.created")
  ) {
    const legacyEvents = currentTurnActivityEvents(conversation.events).events;
    if (legacyEvents.length > 0) {
      const startSeq = legacyEvents[0]?.seq ?? 0;
      activityByUserMessageId.set(userMessages[0].id, {
        events: legacyEvents,
        startSeq,
      });
      latestExecutedTurnStartSeq = startSeq;
    }
  }
  const hasUnscopedActivity = activityByUserMessageId.size === 0
    && conversation.events.length > 0;
  const latestVisibleMessage = visibleMessages.at(-1);
  const hasUnscopedFinalAnswer = latestVisibleMessage?.role === "assistant"
    && latestVisibleMessage.isFinal !== false;
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
    const workStarted = workActive && !previousRunningRef.current;
    const userMessageAdded = userMessageCount > previousUserMessageCountRef.current;
    previousConversationIdRef.current = conversation.id;
    previousRunningRef.current = workActive;
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
    workActive,
    userMessageCount,
  ]);

  const streamingAssistant = latestStreamingAssistant(
    conversation.events,
    conversation.messages,
    running,
    conversation.streamingAssistantProjection,
  );
  const handleDragEnter = useCallback((event) => {
    if (!Array.from(event.dataTransfer?.types ?? []).includes("Files")) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDropActive(true);
  }, []);
  const handleDragOver = useCallback((event) => {
    if (!Array.from(event.dataTransfer?.types ?? []).includes("Files")) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  }, []);
  const handleDragLeave = useCallback((event) => {
    if (!Array.from(event.dataTransfer?.types ?? []).includes("Files")) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDropActive(false);
  }, []);
  const handleDrop = useCallback((event) => {
    if (!Array.from(event.dataTransfer?.types ?? []).includes("Files")) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setDropActive(false);
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length > 0) onDropFiles?.(files);
  }, [onDropFiles]);

  return (
    <div
      className={`project-agent${dropActive ? " is-file-drop-active" : ""}`}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dropActive ? (
        <div className="project-file-drop-overlay" role="status">
          <UploadSimple size={20} weight="bold" aria-hidden="true" />
          <strong>释放以添加到当前会话</strong>
          <span>PDF、Word、Excel、图片和文本资料都会留在当前会话</span>
        </div>
      ) : null}
      <ProjectPlanDock plan={dockPlan} running={workActive} />
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
          fork={conversation.fork}
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
        {visibleMessages.length === 0 ? (
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
                    : nativeExecution
                      ? "Pi 会在当前可信 Workspace 原生读取、修改、运行并持续公开实际工具活动。"
                      : "Pi 会读取当前项目、公开实际工具活动，并把修改留到右侧等待确认。"}
              </p>
            </div>
            <div className="project-agent-scope">
              <span>{standalone ? "未连接本地文件夹" : "真实项目上下文"}</span>
              {standalone ? <span>私有草稿区</span> : null}
              <span>{nativeExecution
                ? "原生修改即时生效"
                : autoReview
                  ? "安全修改自动继续"
                  : "修改先审阅"}</span>
              {!standalone ? (
                <span>{nativeExecution
                  ? "命令在同一 Workspace 运行"
                  : autoReview
                    ? "高风险操作会阻止"
                    : "命令显式运行"}</span>
              ) : null}
            </div>
          </section>
        ) : (
          visibleMessages.map((message, index) => {
            if (message.role === "assistant" && message.isFinal === false) {
              return null;
            }
            const text = messageText(message.content);
            const messageImages = Array.isArray(message.images)
              ? message.images
              : [];
            const messageAttachments = Array.isArray(message.attachments)
              ? message.attachments
              : [];
            const turnActivity = message.role === "user"
              ? activityByUserMessageId.get(message.id)
              : null;
            const isLatestExecutedTurn = turnActivity?.startSeq
              === latestExecutedTurnStartSeq;
            const turnRunning = Boolean(running && isLatestExecutedTurn);
            const followingMessages = visibleMessages.slice(index + 1);
            const nextUserOffset = followingMessages.findIndex(
              (candidate) => candidate.role === "user",
            );
            const turnMessages = nextUserOffset === -1
              ? followingMessages
              : followingMessages.slice(0, nextUserOffset);
            const turnHasFinalAnswer = message.role === "user"
              && turnMessages.some((candidate) => (
                candidate.role === "assistant"
                && candidate.isFinal !== false
              ));
            const scopedPlan = turnActivity
              ? planFromActivityEvents(turnActivity.events)
              : [];
            const turnPlan = scopedPlan;
            const isLastAssistantForTurn = message.role === "assistant"
              && !visibleMessages.slice(index + 1).some((candidate) => (
                candidate.role === "assistant"
                && candidate.turnId === message.turnId
              ));
            const generatedImages = isLastAssistantForTurn
              ? (conversation.generatedImages ?? []).filter((image) => (
                  image.status === "completed"
                  && image.turnId === message.turnId
                  && (
                    !Number.isSafeInteger(image.attempt)
                    || !Number.isSafeInteger(message.attempt)
                    || image.attempt === message.attempt
                  )
                ))
              : [];
            if (
              !text
              && messageImages.length === 0
              && messageAttachments.length === 0
              && generatedImages.length === 0
            ) return null;
            return (
              <Fragment key={message.id}>
                <article
                  className={`project-agent-message is-${message.role} is-${message.kind}`}
                >
                  <small>{message.role === "user" ? "你" : "Pi Agent"}</small>
                  {message.role === "assistant" ? (
                    <>
                      {text ? (
                        <ProjectAgentMarkdown
                          codeEvidence={message.codeEvidence}
                          onOpenCodeEvidence={onOpenCodeEvidence}
                        >
                          {text}
                        </ProjectAgentMarkdown>
                      ) : null}
                      <GeneratedImageCards
                        conversationId={conversation.id}
                        images={generatedImages}
                        imageUrl={generatedImageUrl}
                        onOpenArtifact={onOpenArtifact}
                      />
                    </>
                  ) : messageImages.length > 0 || messageAttachments.length > 0 ? (
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
                        {messageAttachments.map((attachment, attachmentIndex) => (
                          <span
                            key={attachment.contentHash
                              ?? `${message.id}-attachment-${attachmentIndex}`}
                          >
                            <FileCode size={13} aria-hidden="true" />
                            文件 · {attachment.fileName || "文本附件"}
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="project-agent-plain-text">{text}</div>
                  )}
                  {message.role === "assistant" ? (
                    <TurnEvidence
                      message={message}
                      attemptCount={sessionView.attemptMetaByTurn.get(
                        sessionTurnKey(message, `assistant:${message.id}`),
                      )?.count ?? 1}
                    />
                  ) : null}
                </article>
                {turnActivity ? (
                  <>
                    {turnPlan.length > 0
                      && planSignature(turnPlan) !== dockPlanSignature ? (
                        <PlanCard plan={turnPlan} />
                      ) : null}
                    <ActivityTimeline
                      events={turnActivity.events}
                      running={turnRunning}
                      compact={turnHasFinalAnswer && !turnRunning}
                      transparentMode={transparentMode}
                      terminalStatus={isLatestExecutedTurn
                        ? activeStatus(conversation)
                        : null}
                      onOpenArtifact={onOpenArtifact}
                    />
                  </>
                ) : null}
              </Fragment>
            );
          })
        )}

        {submitting && !running ? (
          <ActivityTimeline
            events={[]}
            running
            compact={false}
            transparentMode={transparentMode}
            phase="submitting"
            onOpenArtifact={onOpenArtifact}
          />
        ) : null}
        {!submitting && hasUnscopedActivity ? (
          <ActivityTimeline
            events={conversation.events}
            running={running}
            compact={hasUnscopedFinalAnswer && !running}
            transparentMode={transparentMode}
            terminalStatus={activeStatus(conversation)}
            onOpenArtifact={onOpenArtifact}
          />
        ) : null}
        {streamingAssistant ? (
          <article
            className="project-agent-message is-assistant is-streaming"
            aria-label="Pi Agent 正在生成回复"
            aria-live="polite"
          >
            <small>Pi Agent · 生成中</small>
            <ProjectAgentMarkdown>{streamingAssistant.text}</ProjectAgentMarkdown>
          </article>
        ) : null}
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
            autoReview={autoReview}
            native={nativeExecution}
            onAnswer={(answers) => onAnswerAskUser?.(
              pendingAskUserRequest.id,
              answers,
            )}
            onCancel={() => onCancelAskUser?.(pendingAskUserRequest.id)}
          />
        ) : null}
        <ActionError error={error ?? conversation.error} />
        <VerificationAttentionCard
          attention={unresolvedVerification}
          onOpenArtifact={onOpenArtifact}
        />
        {!unresolvedVerification ? (
          <ProjectLoopCloseoutCard
            events={conversation.events}
            conversationStatus={conversation.status}
            onOpenArtifact={onOpenArtifact}
          />
        ) : null}

        {pendingWorkspaceWrites.length > 0 ? (
          <section className="project-agent-decision is-workspace-write" role="status">
            <GitDiff size={18} aria-hidden="true" />
            <div>
              <strong>{pendingWorkspaceWrites.length} 次文件写入等待确认</strong>
              <p>
                {pendingWorkspaceWrites.slice(0, 2).map((write) => write.path).join("、")}
                {pendingWorkspaceWrites.length > 2 ? ` 等 ${pendingWorkspaceWrites.length} 个文件` : ""}
              </p>
            </div>
            <button
              className="project-agent-link"
              type="button"
              onClick={() => onOpenArtifact("changes")}
            >
              核对精确 Diff
              <CaretRight size={13} weight="bold" aria-hidden="true" />
            </button>
          </section>
        ) : null}

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
        {pendingAttachments.length > 0 || uploadingAttachments.length > 0 ? (
          <div className="project-pending-attachments" aria-label="当前消息的普通附件">
            {pendingAttachments.map((attachment) => (
              <span key={attachment.id}>
                <FileCode size={13} aria-hidden="true" />
                <span>
                  <strong>{attachment.fileName}</strong>
                  <small>
                    {attachment.contentKind === "office_word"
                      ? "Word 结构已解析 · AI 按需读取"
                      : attachment.contentKind === "office_workbook"
                        ? "Excel 单元格已解析 · AI 按需读取"
                        : "AI 按需读取 · 不预载全文"}
                  </small>
                </span>
                <button
                  type="button"
                  disabled={turnPayloadLocked}
                  onClick={() => onRemoveAttachment?.(attachment.id)}
                  aria-label={`移除文件：${attachment.fileName}`}
                >
                  <X size={12} weight="bold" aria-hidden="true" />
                </button>
              </span>
            ))}
            {uploadingAttachments.map((fileName, index) => (
              <span key={`uploading:${fileName}:${index}`} className="is-uploading">
                <CircleNotch className="spin" size={13} aria-hidden="true" />
                <span>
                  <strong>{fileName}</strong>
                  <small>正在保存到当前会话</small>
                </span>
              </span>
            ))}
          </div>
        ) : null}
        {branchTarget || selectedWorkflow || selectedCapabilities.length > 0 ? (
          <div className="project-turn-chips" aria-label="当前消息使用的能力">
            {branchTarget ? (
              <span className="is-branch">
                <GitBranch size={13} aria-hidden="true" />
                从检查点继续 · {branchTarget.label}
                <button
                  type="button"
                  disabled={running || turnPayloadLocked}
                  onClick={onCancelBranch}
                  aria-label="取消从检查点继续"
                >
                  <X size={12} weight="bold" aria-hidden="true" />
                </button>
              </span>
            ) : null}
            {selectedWorkflow && !branchTarget ? (
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
                ) : capability.id === "image_generation" ? (
                  <ImageSquare size={13} aria-hidden="true" />
                ) : capability.id === "github_read" ? (
                  <GithubLogo size={13} aria-hidden="true" />
                ) : capability.id === "vercel_read" ? (
                  <Cloud size={13} aria-hidden="true" />
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
        {branchTarget ? (
          <small className="live-project-context-note project-branch-context-note">
            只读规划分支会继承这里的对话上下文；项目文件仍按当前状态读取。
          </small>
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
                : "当前 Agent 完成后再发送所选能力、图片或文件"}
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
              <details className="project-composer-add-menu" ref={attachmentMenuRef}>
                <summary className="project-composer-tool project-composer-attachment">
                  {uploadingPdf || uploadingAttachments.length > 0 ? (
                    <CircleNotch className="spin" size={13} aria-hidden="true" />
                  ) : (
                    <Paperclip size={13} aria-hidden="true" />
                  )}
                  添加
                  <CaretUp size={11} weight="bold" aria-hidden="true" />
                </summary>
                <div className="project-composer-add-popover" role="menu" aria-label="添加内容">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      if (attachmentMenuRef.current) attachmentMenuRef.current.open = false;
                      onOpenArtifact("files");
                    }}
                  >
                    <Files size={15} aria-hidden="true" />
                    <span>
                      <strong>引用项目文件</strong>
                      <small>从项目中选择上下文</small>
                    </span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={
                      running
                      || turnPayloadLocked
                      || Boolean(uploadingPdf)
                      || uploadingAttachments.length > 0
                    }
                    onClick={() => {
                      if (attachmentMenuRef.current) attachmentMenuRef.current.open = false;
                      localFileInputRef.current?.click();
                    }}
                    title="从电脑选择资料；未知后缀会按实际内容检查，也可用 ⌘⇧G 粘贴路径"
                  >
                    <UploadSimple size={15} aria-hidden="true" />
                    <span>
                      <strong>添加本地资料</strong>
                      <small>PDF、Word、Excel、图片或文本</small>
                    </span>
                  </button>
                </div>
              </details>
              <input
                className="sr-only"
                ref={localFileInputRef}
                type="file"
                multiple
                disabled={running || turnPayloadLocked}
                aria-label="选择要添加的本地资料"
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  event.target.value = "";
                  if (files.length > 0) void onDropFiles?.(files);
                }}
              />
              {executionPolicyControl}
              {contextUsageControl}
            </div>
            <small>
              {awaitingUser
                ? "回答需求问题不会批准文件写入"
                : runningMessageMode === "follow_up" && running
                  ? "发送会加入持久后续队列"
                  : running
                    ? "发送会立即调整当前 Agent 的方向"
                    : "只有显式发送才开始工作 · 会话资料由 AI 按需读取"}
              {" · Enter 发送 · Shift+Enter 换行"}
            </small>
          </div>
          <button
            className={running ? "is-stop" : undefined}
            type={running ? "button" : "submit"}
            disabled={running ? Boolean(action) : !canSubmit}
            aria-label={running ? "停止当前 Agent" : "发送任务"}
            title={running ? "停止当前 Agent" : "发送任务"}
            onClick={running ? onAbort : undefined}
          >
            {running && action === "abort" ? (
              <CircleNotch className="spin" size={16} weight="bold" aria-hidden="true" />
            ) : running ? (
              <Stop size={16} weight="fill" aria-hidden="true" />
            ) : action === "message" ? (
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
  generatedImages = [],
  generatedOfficeArtifacts = [],
  api,
  selectedPath,
  requestedPath,
  requestedLine,
  requestedHash,
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
  const [activeGeneratedImageId, setActiveGeneratedImageId] = useState("");
  const [activeGeneratedOfficeArtifactId, setActiveGeneratedOfficeArtifactId] = useState("");
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

  const loadFile = useCallback(async (
    path,
    { line = null, expectedHash = null } = {},
  ) => {
    if (!conversationId || !path) return null;
    setActiveDocumentId("");
    setActiveGeneratedImageId("");
    setActiveGeneratedOfficeArtifactId("");
    setActivePath(path);
    setImageLoadFailed(false);
    if (PROJECT_FILE_IMAGE_PATTERN.test(path)) {
      fileAbort.current?.abort();
      setLoadingFile(false);
      setError(null);
      return;
    }
    const cached = fileCache[path];
    if (
      cached
      && !expectedHash
      && (
        !Number.isSafeInteger(line)
        || (
          line >= (cached.startLine ?? 1)
          && line <= (cached.endLine ?? cached.totalLines ?? 1)
        )
      )
    ) {
      return cached;
    }
    fileAbort.current?.abort();
    const controller = new AbortController();
    fileAbort.current = controller;
    setLoadingFile(true);
    setError(null);
    try {
      const file = await api.fetchFile({
        conversationId,
        path,
        ...(Number.isSafeInteger(line) ? {
          startLine: Math.max(1, line - 120),
          endLine: Math.max(1, line - 120) + PROJECT_FILE_VISIBLE_LINE_LIMIT - 1,
        } : {}),
        ...(expectedHash ? { expectedContentHash: expectedHash } : {}),
        signal: controller.signal,
      });
      setFileCache((current) => ({ ...current, [path]: file }));
      return file;
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
    setActiveGeneratedImageId("");
    setActiveGeneratedOfficeArtifactId("");
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
    let active = true;
    void loadFile(requestedPath, {
      line: requestedLine,
      expectedHash: requestedHash,
    }).then((file) => {
      if (!active || !file || !Number.isSafeInteger(requestedLine)) return;
      const index = requestedLine - (file.startLine ?? 1);
      if (index < 0 || index >= (file.lines?.length ?? 0)) return;
      setActiveLineIndex(index);
      window.requestAnimationFrame(() => {
        document.getElementById(`project-code-line-${index}`)
          ?.scrollIntoView({ block: "center" });
      });
    }).finally(() => {
      if (active) onRequestedPathHandled?.();
    });
    return () => {
      active = false;
    };
  }, [
    loadFile,
    onRequestedPathHandled,
    requestedLine,
    requestedPath,
    requestedHash,
  ]);

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
  const completedGeneratedImages = generatedImages.filter(
    (image) => image.status === "completed",
  );
  const completedGeneratedOfficeArtifacts = generatedOfficeArtifacts.filter(
    (artifact) => artifact.status === "completed",
  );
  const selectedGeneratedImage = completedGeneratedImages.find(
    (image) => image.id === activeGeneratedImageId,
  ) ?? null;
  const selectedGeneratedImageUrl = selectedGeneratedImage
    && typeof api.generatedImageUrl === "function"
    ? api.generatedImageUrl({
        conversationId,
        imageId: selectedGeneratedImage.id,
      })
    : null;
  const selectedGeneratedOfficeArtifact = completedGeneratedOfficeArtifacts.find(
    (artifact) => artifact.id === activeGeneratedOfficeArtifactId,
  ) ?? null;
  const selectedGeneratedOfficeDownloadUrl = selectedGeneratedOfficeArtifact
    && typeof api.generatedOfficeDownloadUrl === "function"
    ? api.generatedOfficeDownloadUrl({
        conversationId,
        artifactId: selectedGeneratedOfficeArtifact.id,
      })
    : null;
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
        {completedGeneratedImages.length > 0
          || completedGeneratedOfficeArtifacts.length > 0 ? (
          <>
            <div className="project-file-section-heading">
              <Files size={15} aria-hidden="true" />
              会话生成
            </div>
            {completedGeneratedOfficeArtifacts.map((artifact) => {
              const OfficeIcon = artifact.kind === "excel" ? FileXls : FileDoc;
              return (
                <button
                  className={`project-generated-image-file project-generated-office-file${
                    artifact.id === activeGeneratedOfficeArtifactId
                      ? " is-active"
                      : ""
                  }`}
                  type="button"
                  key={artifact.id}
                  onClick={() => {
                    setActivePath("");
                    setActiveDocumentId("");
                    setActiveGeneratedImageId("");
                    setActiveGeneratedOfficeArtifactId(artifact.id);
                    setImageLoadFailed(false);
                  }}
                >
                  <OfficeIcon size={15} aria-hidden="true" />
                  <span>
                    <strong>{artifact.fileName}</strong>
                    <small>
                      {artifact.kind === "excel"
                        ? `${artifact.sheetCount ?? 1} 个工作表`
                        : `${artifact.pageCount ?? 1} 页`}
                    </small>
                  </span>
                </button>
              );
            })}
            {completedGeneratedImages.map((image) => (
              <button
                className={`project-generated-image-file${
                  image.id === activeGeneratedImageId ? " is-active" : ""
                }`}
                type="button"
                key={image.id}
                onClick={() => {
                  setActivePath("");
                  setActiveDocumentId("");
                  setActiveGeneratedOfficeArtifactId("");
                  setActiveGeneratedImageId(image.id);
                  setImageLoadFailed(false);
                }}
              >
                <ImageSquare size={15} aria-hidden="true" />
                <span>
                  <strong>{image.fileName || "GPT Image 2 图片"}</strong>
                  <small>
                    {image.width && image.height
                      ? `${image.width} × ${image.height}`
                      : "已生成"}
                  </small>
                </span>
              </button>
            ))}
          </>
        ) : null}
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
                  setActiveGeneratedImageId("");
                  setActiveGeneratedOfficeArtifactId("");
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
              setActiveGeneratedImageId("");
              setActiveGeneratedOfficeArtifactId("");
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
              {selectedGeneratedImage?.fileName
                || selectedGeneratedOfficeArtifact?.fileName
                || selectedDocument?.fileName
                || activePath
                || "选择一个文件"}
            </strong>
            <small>
              {selectedGeneratedImage
                ? `GPT Image 2 · ${
                    selectedGeneratedImage.width
                  } × ${selectedGeneratedImage.height} · 会话工件`
                : selectedGeneratedOfficeArtifact
                  ? `${selectedGeneratedOfficeArtifact.kind === "excel" ? "Excel 工作簿" : "Word 文档"} · 结构与渲染已核验 · 会话工件`
                : selectedDocument
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
          {selectedGeneratedOfficeDownloadUrl ? (
            <a
              className="project-office-download"
              href={selectedGeneratedOfficeDownloadUrl}
              download={selectedGeneratedOfficeArtifact.fileName}
            >
              <DownloadSimple size={14} aria-hidden="true" />
              下载文件
            </a>
          ) : selectedDocument && canRetryDocument(selectedDocument) ? (
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
        {selectedGeneratedOfficeArtifact ? (
          <div className="project-office-detail project-document-detail">
            <div className="project-document-detail-icon is-ready">
              {selectedGeneratedOfficeArtifact.kind === "excel" ? (
                <FileXls size={24} aria-hidden="true" />
              ) : (
                <FileDoc size={24} aria-hidden="true" />
              )}
            </div>
            <div>
              <span>会话生成文件</span>
              <h3>{selectedGeneratedOfficeArtifact.title}</h3>
              <p>{selectedGeneratedOfficeArtifact.summary}</p>
            </div>
            <dl>
              <div>
                <dt>文件</dt>
                <dd>{selectedGeneratedOfficeArtifact.fileName}</dd>
              </div>
              <div>
                <dt>大小</dt>
                <dd>{formatDocumentSize(selectedGeneratedOfficeArtifact.byteLength)}</dd>
              </div>
              <div>
                <dt>校验</dt>
                <dd>结构、渲染与哈希读回均通过</dd>
              </div>
              <div>
                <dt>版本</dt>
                <dd>{selectedGeneratedOfficeArtifact.revision?.slice(0, 20)}…</dd>
              </div>
            </dl>
            <section className="project-office-preview" aria-label="Office 文件结构预览">
              <header>
                <strong>结构预览</strong>
                {selectedGeneratedOfficeArtifact.previewTruncated ? (
                  <small>当前仅显示前段内容</small>
                ) : null}
              </header>
              <pre>{selectedGeneratedOfficeArtifact.previewText}</pre>
            </section>
          </div>
        ) : selectedGeneratedImageUrl ? (
          <div className="project-image-preview project-generated-image-preview">
            {imageLoadFailed ? (
              <div className="project-run-empty" role="alert">
                <WarningCircle size={24} aria-hidden="true" />
                <h3>无法预览这张生成图片</h3>
                <p>图片未通过当前读回校验，原项目文件没有变化。</p>
              </div>
            ) : (
              <figure>
                <img
                  src={selectedGeneratedImageUrl}
                  alt={selectedGeneratedImage.prompt?.slice(0, 160)
                    || "GPT Image 2 生成图片"}
                  onError={() => setImageLoadFailed(true)}
                />
                <figcaption>
                  <span>{selectedGeneratedImage.prompt}</span>
                  <small>
                    {selectedGeneratedImage.modelId} · ChatGPT 订阅 ·
                    {" "}未提供单次价格 ·
                    {" "}{formatDocumentSize(selectedGeneratedImage.byteLength)}
                  </small>
                </figcaption>
              </figure>
            )}
          </div>
        ) : selectedDocument ? (
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
                    : "会话资料不会写入 Workspace；解析过程也不会自动调用模型。")}
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
  gitCloseouts,
  gitCloseoutStatus,
  onRefreshGitCloseouts,
  onConfirmGitCloseout,
  gitCloseoutConfirming,
  gitCloseoutError,
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
      : "Workspace 正常";
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
        <small>状态读取保持只读；只有下方精确确认才会创建本地提交。</small>
      </div>

      <ProjectGitCloseout
        records={gitCloseouts}
        status={gitCloseoutStatus}
        onRefresh={onRefreshGitCloseouts}
        onConfirm={onConfirmGitCloseout}
        confirming={gitCloseoutConfirming}
        running={running}
        error={gitCloseoutError}
      />

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

const WORKSPACE_WRITE_STATUS_LABELS = {
  pending: "等待确认",
  applying: "正在写入",
  applied: "已写入 Workspace",
  written: "已写入 Workspace",
  cancelled: "已取消",
  failed: "写入失败",
  stale: "文件已变化",
  undone: "已安全撤销",
};

function WorkspaceWriteArtifact({
  writes,
  onConfirm,
  onCancel,
  onUndo,
  action,
  error,
}) {
  const orderedWrites = [
    ...writes.filter((write) => write.status === "pending"),
    ...writes.filter((write) => write.status !== "pending").reverse(),
  ];
  const [activeWriteId, setActiveWriteId] = useState(orderedWrites[0]?.id ?? null);
  const revision = orderedWrites.map((write) => `${write.id}:${write.status}`).join("|");

  useEffect(() => {
    setActiveWriteId((current) => (
      orderedWrites.some((write) => write.id === current)
        ? current
        : orderedWrites[0]?.id ?? null
    ));
  }, [revision]);

  const activeWrite = orderedWrites.find((write) => write.id === activeWriteId)
    ?? orderedWrites[0]
    ?? null;
  if (!activeWrite) return null;
  const patchLines = String(activeWrite.patch ?? "").split("\n");
  const pending = activeWrite.status === "pending";
  const confirming = action === `workspace-write-confirm:${activeWrite.id}`;
  const cancelling = action === `workspace-write-cancel:${activeWrite.id}`;
  const busy = Boolean(action);
  return (
    <div className="project-change-artifact is-workspace-writes">
      <aside>
        <header>
          <span>Workspace 写入记录</span>
          <small>{writes.some((write) => write.status === "pending")
            ? `${writes.filter((write) => write.status === "pending").length} 待确认`
            : `${writes.length} 条记录`}</small>
        </header>
        {orderedWrites.map((write) => (
          <div
            className={`project-change-file${write.id === activeWrite.id ? " is-active" : ""}`}
            key={write.id}
          >
            <button type="button" onClick={() => setActiveWriteId(write.id)}>
              <GitDiff size={14} aria-hidden="true" />
              <span>
                <strong>{write.path}</strong>
                <small>
                  {OPERATION_LABELS[write.operation]
                    ?? OPERATION_LABELS[write.operation === "update" ? "modify" : write.operation]
                    ?? write.operation}
                  {" · "}{WORKSPACE_WRITE_STATUS_LABELS[write.status] ?? write.status}
                </small>
              </span>
            </button>
          </div>
        ))}
      </aside>
      <section className="project-diff-viewer">
        <header>
          <div>
            <strong>{activeWrite.path}</strong>
            <small>精确 unified diff · {activeWrite.approvalMode === "native"
              ? "Pi 原生已执行"
              : activeWrite.approvalMode === "auto_review"
                ? "替我审批"
                : "逐次确认"}</small>
          </div>
          <span className={`is-${activeWrite.status}`}>
            {WORKSPACE_WRITE_STATUS_LABELS[activeWrite.status] ?? activeWrite.status}
          </span>
        </header>
        <pre>
          {patchLines.map((line, index) => {
            const tone = line.startsWith("+") && !line.startsWith("+++")
              ? "is-added"
              : line.startsWith("-") && !line.startsWith("---")
                ? "is-removed"
                : line.startsWith("@@")
                  ? "is-hunk"
                  : "";
            return <code className={tone} key={`${activeWrite.id}:${index}`}>{line}{"\n"}</code>;
          })}
        </pre>
        <div className="project-change-hashes">
          <span>基础版本 <code>{activeWrite.baseHash ?? "无（新文件）"}</code></span>
          <span>目标版本 <code>{activeWrite.afterHash ?? "无（删除文件）"}</code></span>
        </div>
        <footer className="project-change-confirmation">
          <div>
            <strong>{pending ? "这次写入等待确认" : WORKSPACE_WRITE_STATUS_LABELS[activeWrite.status]}</strong>
            <small>
              {pending
                ? "确认时服务端会重新核对基础哈希；文件变化后会拒绝写入。"
                : activeWrite.error?.message ?? activeWrite.error ?? "写入事实与读回结果已保留。"}
            </small>
            {error ? <span className="project-change-cancelled">{error.message}</span> : null}
          </div>
          {pending ? (
            <div>
              <button
                className="project-change-cancel"
                type="button"
                disabled={busy}
                onClick={() => onCancel?.(activeWrite)}
              >
                {cancelling ? "正在取消" : "取消写入"}
              </button>
              <button
                className="project-change-confirm"
                type="button"
                disabled={busy}
                onClick={() => onConfirm?.(activeWrite)}
              >
                {confirming ? "正在写入" : "确认写入"}
              </button>
            </div>
          ) : (
            <div className="project-change-completed-actions">
              {activeWrite.status === "written"
                && activeWrite.undo?.status === "available" ? (
                <button
                  className="project-change-cancel"
                  type="button"
                  disabled={busy}
                  onClick={() => onUndo?.(activeWrite)}
                >
                  撤销这次写入
                </button>
              ) : null}
              <span className="project-change-applied">
              {["applied", "written"].includes(activeWrite.status) ? (
                <CheckCircle size={15} weight="fill" aria-hidden="true" />
              ) : (
                <WarningCircle size={15} weight="fill" aria-hidden="true" />
              )}
              {WORKSPACE_WRITE_STATUS_LABELS[activeWrite.status] ?? activeWrite.status}
              </span>
            </div>
          )}
        </footer>
      </section>
    </div>
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
  gitCloseouts,
  gitCloseoutStatus,
  onRefreshGitCloseouts,
  onConfirmGitCloseout,
  gitCloseoutConfirming,
  gitCloseoutError,
  onUndoApply,
  undoingApplyId,
  undoError,
  onConfirmWorkspaceWrite,
  onCancelWorkspaceWrite,
  workspaceWriteAction = null,
  workspaceWriteError = null,
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
        gitCloseouts={gitCloseouts}
        gitCloseoutStatus={gitCloseoutStatus}
        onRefreshGitCloseouts={onRefreshGitCloseouts}
        onConfirmGitCloseout={onConfirmGitCloseout}
        gitCloseoutConfirming={gitCloseoutConfirming}
        gitCloseoutError={gitCloseoutError}
        workspace={conversation.workspace}
        applyJournal={conversation.applyJournal}
        onUndoApply={onUndoApply}
        undoingApplyId={undoingApplyId}
        undoError={undoError}
        running={running}
      />
      {(conversation.workspaceWrites ?? []).length > 0 ? (
        <WorkspaceWriteArtifact
          writes={conversation.workspaceWrites}
          onConfirm={onConfirmWorkspaceWrite}
          onCancel={onCancelWorkspaceWrite}
          onUndo={onUndoApply}
          action={workspaceWriteAction}
          error={workspaceWriteError}
        />
      ) : !changeSet || !activeFile ? (
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
  onRunBrowserQa,
  browserQaRunning = false,
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
          <div className="project-preview-actions">
            <button
              className="project-preview-open"
              type="button"
              disabled={browserQaRunning}
              onClick={onRunBrowserQa}
            >
              {browserQaRunning ? (
                <CircleNotch className="spin" size={14} aria-hidden="true" />
              ) : (
                <ShieldCheck size={14} weight="fill" aria-hidden="true" />
              )}
              {browserQaRunning ? "正在验收" : "验收页面"}
            </button>
            <a
              className="project-preview-open"
              href={previewUrl}
              target="_blank"
              rel="noreferrer"
            >
              <GlobeSimple size={14} aria-hidden="true" />
              在浏览器打开
            </a>
          </div>
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

function SubagentRunNode({ run }) {
  const metrics = [
    run.modelRef ? `模型 ${run.modelRef}` : "",
    run.toolCount !== null ? `${run.toolCount} 次工具` : "",
    run.turnCount !== null ? `${run.turnCount} 轮` : "",
    run.tokens !== null ? formatTraceTokens(run.tokens) : "",
    run.durationMs !== null ? formatTraceDuration(run.durationMs) : "",
  ].filter(Boolean);
  return (
    <li className={`is-${run.status}`}>
      <div className="project-subagent-run-row">
        <span className="project-subagent-run-state" aria-hidden="true">
          {run.status === "running" ? (
            <CircleNotch size={13} weight="bold" />
          ) : run.status === "completed" ? (
            <Check size={13} weight="bold" />
          ) : ["failed", "timed_out", "interrupted"].includes(run.status) ? (
            <WarningCircle size={13} weight="fill" />
          ) : (
            <StopCircle size={13} />
          )}
        </span>
        <div>
          <strong>{run.task}</strong>
          <small>{SUBAGENT_STATUS_LABELS[run.status]}</small>
          {run.currentTool || run.currentPath ? (
            <p>
              {run.currentTool
                ? `当前动作：${TOOL_LABELS[run.currentTool] ?? run.currentTool}`
                : ""}
              {run.currentTool && run.currentPath ? " · " : ""}
              {run.currentPath || ""}
            </p>
          ) : null}
          {run.error ? <p className="is-error">{run.error}</p> : null}
          {!run.error && run.summary ? <p>{run.summary}</p> : null}
          {metrics.length > 0 ? <footer>{metrics.join(" · ")}</footer> : null}
        </div>
      </div>
      {run.children.length > 0 ? (
        <ol>
          {run.children.map((child) => (
            <SubagentRunNode key={child.key} run={child} />
          ))}
        </ol>
      ) : null}
    </li>
  );
}

function ProjectSubagentRuns({ events }) {
  const runs = subagentRunsFromEvents(events);
  if (runs.length === 0) return null;
  const active = runs.filter((run) => ["queued", "running"].includes(run.status)).length;
  return (
    <section className="project-subagent-runs" aria-label="子智能体任务">
      <header>
        <GitBranch size={16} weight="bold" aria-hidden="true" />
        <div>
          <strong>子智能体任务</strong>
          <small>{active > 0 ? `${active} 项正在工作` : `${runs.length} 项已记录`}</small>
        </div>
      </header>
      <ol className="project-subagent-run-tree">
        {runs.map((run) => (
          <SubagentRunNode key={run.key} run={run} />
        ))}
      </ol>
    </section>
  );
}

function RunArtifact({
  conversation,
  workspaceRunLogs,
  expandedWorkspaceRunIds,
  onWorkspaceRunExpandedChange,
  onRunVerification,
  onConfirmWorkspaceRun,
  onCancelWorkspaceRun,
  workspaceRunAction,
  onResumeVerificationRepair,
  resumingOperationId,
  running,
  error,
  browserQaRunning,
  browserQaError,
  browserQaScreenshotUrl,
}) {
  const command = conversation.verificationCommand?.status === "legacy_superseded"
    ? null
    : conversation.verificationCommand;
  const interruptedRepairs = (conversation.operations ?? []).filter(
    (operation) => (
      operation.type === "verification_repair"
      && operation.status === "interrupted"
    ),
  );
  const verificationRuns = conversation.verificationRuns ?? [];
  const linkedVerificationRequestIds = new Set(
    verificationRuns.map((run) => run.commandId).filter(Boolean),
  );
  const runs = verificationRuns.filter((run) => (
    ![
      "saved",
      "ready",
      "requested",
      "pending_approval",
      "proposed",
    ].includes(run.status)
    && !(
      run.status === "legacy_superseded"
      && !run.commandId
      && linkedVerificationRequestIds.has(run.id)
    )
  ));
  const workspaceRuns = conversation.workspaceRuns ?? [];

  return (
    <div className="project-run-artifact">
      <header>
        <div>
          <strong>运行结果</strong>
          <small>Pi 原生命令、验证与子 Session 的状态和日志会持续保存</small>
        </div>
        {command ? (
          <button
            type="button"
            onClick={onRunVerification}
            disabled={running}
            title="在当前 Workspace 运行已保存的验证命令"
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
          <small>点击后会在当前 Workspace 运行，并复用项目工具链与构建缓存。</small>
        </section>
      ) : null}
      {workspaceRuns.length > 0 ? (
        <section className="project-workspace-run-requests" aria-label="Workspace 运行">
          {workspaceRuns.map((run) => {
            const pending = run.status === "requested";
            const active = ["queued", "running"].includes(run.status);
            const commandText = [run.executable, ...(run.argv ?? [])].join(" ");
            const liveLogEvents = run.runId
              ? workspaceRunLogs?.[run.runId]?.events ?? []
              : [];
            const logExpanded = Boolean(
              run.runId && expandedWorkspaceRunIds?.has(run.runId),
            );
            const liveOutput = logExpanded
              ? liveLogEvents
                .filter((event) => event.type === "chunk" && typeof event.text === "string")
                .sort((left, right) => left.seq - right.seq)
                .map((event) => event.text)
                .join("")
              : "";
            const displayedOutput = liveOutput || run.output;
            const gitBefore = workspaceRunGitSummary(run.gitBefore);
            const gitAfter = workspaceRunGitSummary(run.gitAfter);
            return (
              <article
                className={`live-project-saved-command is-${run.status}`}
                key={run.id}
              >
                <strong>{run.purpose || "项目命令"}</strong>
                <code>{commandText}</code>
                <small>工作目录：{run.relativeCwd || "."}</small>
                <small>
                  {pending
                    ? "等待精确确认；替我审批不会自动运行自定义命令。"
                    : `状态：${run.status}${Number.isInteger(run.exitCode) ? ` · 退出码 ${run.exitCode}` : ""}`}
                </small>
                {gitBefore || gitAfter ? (
                  <small>
                    Git：运行前 {gitBefore || "未记录"} · 运行后 {gitAfter || "未完成"}
                  </small>
                ) : null}
                {run.runId || displayedOutput ? (
                  <details
                    className="project-run-log"
                    open={logExpanded}
                    onToggle={(event) => onWorkspaceRunExpandedChange?.(
                      run.runId,
                      event.currentTarget.open,
                    )}
                  >
                    <summary>
                      {active ? "查看实时日志" : "查看已采集日志"}{" "}
                      <CaretDown size={12} aria-hidden="true" />
                    </summary>
                    <pre aria-live={active ? "polite" : undefined}>
                      {displayedOutput || (active ? "等待输出…" : "没有可显示的日志")}
                    </pre>
                  </details>
                ) : null}
                {run.error ? <p className="project-run-error">{run.error.message ?? run.error}</p> : null}
                {pending || active ? (
                  <footer className="project-run-request-actions">
                    <button
                      type="button"
                      disabled={Boolean(workspaceRunAction)}
                      onClick={() => onCancelWorkspaceRun?.(run)}
                    >
                      {workspaceRunAction === `cancel:${run.id}` ? "正在停止" : active ? "停止运行" : "取消"}
                    </button>
                    {pending ? (
                      <button
                        type="button"
                        disabled={Boolean(workspaceRunAction)}
                        onClick={() => onConfirmWorkspaceRun?.(run)}
                      >
                        {workspaceRunAction === `confirm:${run.id}` ? "正在排队" : "确认并运行"}
                      </button>
                    ) : null}
                  </footer>
                ) : null}
              </article>
            );
          })}
        </section>
      ) : null}
      <ProjectSubagentRuns events={conversation.events} />
      <ProjectBrowserQaResults
        conversationId={conversation.id}
        runs={conversation.browserQaRuns ?? []}
        screenshotUrl={browserQaScreenshotUrl}
        running={browserQaRunning}
        error={browserQaError}
      />
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
              已保留当前修改和验证记录。继续会再次调用当前模型，然后在当前 Workspace 复测。
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
              ? "点击“运行验证”后，会在当前 Workspace 执行并保留真实退出码与完整有界日志。"
              : "Pi 保存验证命令后，这里才会出现可运行操作。"}
          </p>
        </section>
      ) : (
        <div className="project-run-history">
          {runs.map((run, index) => {
            const successful = isSuccessfulRun(run);
            const failed = isFailedRun(run);
            const blocked = run.status === "blocked";
            const legacy = run.status === "legacy_superseded";
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
                  legacy ? "is-legacy" : "",
                ].filter(Boolean).join(" ")}
                key={run.id}
              >
                <header>
                  {successful ? (
                    <CheckCircle size={18} weight="fill" aria-hidden="true" />
                  ) : blocked || legacy ? (
                    <ShieldCheck size={18} weight="fill" aria-hidden="true" />
                  ) : failed ? (
                    <WarningCircle size={18} weight="fill" aria-hidden="true" />
                  ) : (
                    <CircleNotch size={18} weight="bold" aria-hidden="true" />
                  )}
                  <div>
                    <strong>{legacy
                      ? "旧验证记录"
                      : blocked ? "验证已阻止" : `验证 ${index + 1}`}</strong>
                    <code>{run.command || command?.displayCommand || "已保存命令"}</code>
                  </div>
                  <span>{legacy ? "已退役" : blocked ? "未运行" : run.status}</span>
                </header>
                {legacy ? (
                  <p>
                    旧复制验证已退役，不影响当前 Workspace 状态。
                    {run.summary ? ` 原记录：${run.summary}` : ""}
                  </p>
                ) : blockedReason ? <p>{blockedReason}</p> : run.summary ? <p>{run.summary}</p> : null}
                {!blocked && !legacy && run.checks.length > 0 ? (
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
                      {legacy ? "查看旧验证日志" : "查看完整已采集日志"}
                      <CaretDown size={12} aria-hidden="true" />
                    </summary>
                    <pre>{logs.length > 0 ? logs.join("\n") : "命令没有产生输出"}</pre>
                  </details>
                ) : null}
                {!blocked && run.truncated ? (
                  <p className="project-run-compression-note">
                    日志达到安全采集上限；以上内容已完整保留，但进程后续输出未进入本次记录。
                  </p>
                ) : null}
                {!blocked && run.outputCompression?.applied ? (
                  <p className="project-run-compression-note">
                    完整日志保留在这里；回灌给 Pi 的修复上下文已由 RTK 从{" "}
                    {formatDocumentSize(run.outputCompression.rawBytes)} 压缩到{" "}
                    {formatDocumentSize(run.outputCompression.compactBytes)}。
                  </p>
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
  onConfirmWorkspaceWrite,
  onCancelWorkspaceWrite,
  workspaceWriteAction,
  workspaceWriteError,
  onConfirmGitCloseout,
  gitCloseoutConfirming,
  gitCloseoutError,
  conversationRunning,
  onStartPreview,
  previewStarting,
  previewError,
  onRunBrowserQa,
  browserQaRunning,
  browserQaError,
  onRunVerification,
  onConfirmWorkspaceRun,
  onCancelWorkspaceRun,
  workspaceRunAction,
  workspaceRunLogs,
  expandedWorkspaceRunIds,
  onWorkspaceRunExpandedChange,
  onResumeVerificationRepair,
  resumingOperationId,
  verificationError,
  verificationRunning,
  requestedFilePath,
  requestedFileLine,
  requestedFileHash,
  onRequestedFilePathHandled,
  onAddContext,
  onRetryDocument,
  retryingDocumentId,
  onRemoveDocument,
  removingDocumentId,
  onError,
}) {
  const pendingWorkspaceWriteCount = (conversation.workspaceWrites ?? []).filter(
    (write) => write.status === "pending",
  ).length;
  const changeCount = pendingWorkspaceWriteCount
    + (conversation.pendingChangeSet?.files?.length ?? 0);
  const standalone = conversation.scope === "standalone"
    || conversation.workspaceKind === "scratch"
    || conversation.projectId === null;
  const [gitEvidenceState, setGitEvidenceState] = useState({
    status: "idle",
    data: null,
  });
  const gitEvidenceAbort = useRef(null);
  const gitCloseoutAbort = useRef(null);
  const [gitCloseoutState, setGitCloseoutState] = useState({
    status: "idle",
    data: [],
  });
  const applyJournalRevision = (conversation.applyJournal ?? [])
    .map((record) => `${record.id}:${record.status}:${record.undo?.status ?? ""}`)
    .join("|");
  const gitCloseoutRevision = (conversation.gitCloseouts ?? [])
    .map((record) => `${record.id}:${record.status}:${record.updatedAt ?? ""}`)
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

  const loadGitCloseouts = useCallback(async () => {
    if (typeof api.fetchGitCloseouts !== "function") {
      setGitCloseoutState({ status: "ready", data: [] });
      return;
    }
    gitCloseoutAbort.current?.abort();
    const controller = new AbortController();
    gitCloseoutAbort.current = controller;
    setGitCloseoutState((current) => ({
      status: current.data.length > 0 ? "refreshing" : "loading",
      data: current.data,
    }));
    try {
      const data = await api.fetchGitCloseouts({
        conversationId: conversation.id,
        signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        setGitCloseoutState({ status: "ready", data });
      }
    } catch {
      if (!controller.signal.aborted) {
        setGitCloseoutState((current) => ({
          status: "error",
          data: current.data,
        }));
      }
    } finally {
      if (gitCloseoutAbort.current === controller) {
        gitCloseoutAbort.current = null;
      }
    }
  }, [api, conversation.id]);

  useEffect(() => {
    gitEvidenceAbort.current?.abort();
    gitCloseoutAbort.current?.abort();
    setGitEvidenceState({ status: "idle", data: null });
    setGitCloseoutState({ status: "idle", data: [] });
  }, [conversation.id]);

  useEffect(() => {
    if (activeArtifactId !== "changes") return undefined;
    void loadGitEvidence();
    void loadGitCloseouts();
    return () => {
      gitEvidenceAbort.current?.abort();
      gitCloseoutAbort.current?.abort();
    };
  }, [
    activeArtifactId,
    applyJournalRevision,
    conversation.pendingChangeSet?.status,
    gitCloseoutRevision,
    loadGitEvidence,
    loadGitCloseouts,
  ]);

  useEffect(() => () => {
    gitEvidenceAbort.current?.abort();
    gitCloseoutAbort.current?.abort();
  }, []);

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
              generatedImages={conversation.generatedImages ?? []}
              generatedOfficeArtifacts={conversation.generatedOfficeArtifacts ?? []}
              api={api}
              requestedPath={requestedFilePath}
              requestedLine={requestedFileLine}
              requestedHash={requestedFileHash}
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
              gitCloseouts={gitCloseoutState.data}
              gitCloseoutStatus={gitCloseoutState.status}
              onRefreshGitCloseouts={loadGitCloseouts}
              onConfirmGitCloseout={onConfirmGitCloseout}
              gitCloseoutConfirming={gitCloseoutConfirming}
              gitCloseoutError={gitCloseoutError}
              onUndoApply={onUndoApply}
              undoingApplyId={undoingApplyId}
              undoError={undoError}
              onConfirmWorkspaceWrite={onConfirmWorkspaceWrite}
              onCancelWorkspaceWrite={onCancelWorkspaceWrite}
              workspaceWriteAction={workspaceWriteAction}
              workspaceWriteError={workspaceWriteError}
              running={conversationRunning}
            />
          ) : activeArtifactId === "preview" ? (
            <PreviewArtifact
              preview={conversation.preview}
              onStart={onStartPreview}
              starting={previewStarting}
              error={previewError}
              onRunBrowserQa={onRunBrowserQa}
              browserQaRunning={browserQaRunning}
            />
          ) : (
            <RunArtifact
              conversation={conversation}
              workspaceRunLogs={workspaceRunLogs}
              expandedWorkspaceRunIds={expandedWorkspaceRunIds}
              onWorkspaceRunExpandedChange={onWorkspaceRunExpandedChange}
              onRunVerification={onRunVerification}
              onConfirmWorkspaceRun={onConfirmWorkspaceRun}
              onCancelWorkspaceRun={onCancelWorkspaceRun}
              workspaceRunAction={workspaceRunAction}
              onResumeVerificationRepair={onResumeVerificationRepair}
              resumingOperationId={resumingOperationId}
              running={verificationRunning}
              error={verificationError}
              browserQaRunning={browserQaRunning}
              browserQaError={browserQaError}
              browserQaScreenshotUrl={api.browserQaScreenshotUrl}
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

export function mergeTurnHistoryEvents(turns, events) {
  return [...new Map([
    ...turns.flatMap((turn) => turn.events ?? []),
    ...(events ?? []),
  ].filter((event) => Number.isSafeInteger(event?.seq) && event.seq > 0)
    .map((event) => [event.seq, event])).values()]
    .sort((left, right) => left.seq - right.seq);
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
  modelSelectionDisabled = false,
  onOpenSkills,
  installedSkillCount = 0,
  sidebarOpen = true,
  onToggleSidebar,
  mobileActive = false,
  mobileView = "agent",
  onMobileViewChange,
  api = projectWorkApi,
  pollIntervalMs = 1_000,
  onConversationChange,
  onConversationForked,
  onCreateConversationInWorkspace,
  onError,
}) {
  const [snapshot, setSnapshot] = useState(conversation);
  const [draft, setDraft] = useState("");
  const [contextChips, setContextChips] = useState([]);
  const [artifactOpen, setArtifactOpen] = useState(false);
  const [contextUsageOpen, setContextUsageOpen] = useState(false);
  const [executionPolicyOpen, setExecutionPolicyOpen] = useState(false);
  const [capabilityOpen, setCapabilityOpen] = useState(false);
  const [pathOpen, setPathOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [selectedCheckpointId, setSelectedCheckpointId] = useState(null);
  const [branchTarget, setBranchTarget] = useState(null);
  const [transparentMode, setTransparentMode] = useState(readTransparentMode);
  const [selectedCapabilityIds, setSelectedCapabilityIds] = useState([]);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState(null);
  const [runningMessageMode, setRunningMessageMode] = useState("steer");
  const [pendingImage, setPendingImage] = useState(null);
  const [pendingAttachments, setPendingAttachments] = useState([]);
  const [uploadingAttachments, setUploadingAttachments] = useState([]);
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
  const [requestedFileLine, setRequestedFileLine] = useState(null);
  const [requestedFileHash, setRequestedFileHash] = useState("");
  const [selectedChangeFileIds, setSelectedChangeFileIds] = useState([]);
  const [action, setAction] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [applyError, setApplyError] = useState(null);
  const [workspaceWriteError, setWorkspaceWriteError] = useState(null);
  const [workspaceCatalog, setWorkspaceCatalog] = useState({
    status: "idle",
    items: [],
  });
  const [workspaceAction, setWorkspaceAction] = useState(null);
  const [workspaceError, setWorkspaceError] = useState(null);
  const [workspaceRunLogs, setWorkspaceRunLogs] = useState({});
  const [expandedWorkspaceRunIds, setExpandedWorkspaceRunIds] = useState(
    () => new Set(),
  );
  const [undoError, setUndoError] = useState(null);
  const [gitCloseoutError, setGitCloseoutError] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const [browserQaError, setBrowserQaError] = useState(null);
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
  const localFileInputRef = useRef(null);
  const pdfUploadAbort = useRef(null);
  const pendingImageRef = useRef(null);
  const pendingAttachmentsRef = useRef([]);
  const verificationAutoOpenRef = useRef(new Set());
  const workspaceRunLogStateRef = useRef(new Map());
  const shouldPollConversationRef = useRef(false);

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

  const replacePendingAttachments = useCallback((nextAttachments) => {
    pendingAttachmentsRef.current = nextAttachments;
    setPendingAttachments(nextAttachments);
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
    const conversationId = snapshotRef.current?.id;
    const attachments = pendingAttachmentsRef.current;
    pendingAttachmentsRef.current = [];
    if (conversationId && typeof api.removeAttachment === "function") {
      for (const attachment of attachments) {
        api.removeAttachment({
          conversationId,
          attachmentId: attachment.id,
        }).catch(() => undefined);
      }
    }
  }, [api]);

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
    const previousConversationId = snapshotRef.current?.id;
    const previousAttachments = pendingAttachmentsRef.current;
    if (
      previousConversationId
      && previousConversationId !== conversation?.id
      && typeof api.removeAttachment === "function"
    ) {
      for (const attachment of previousAttachments) {
        api.removeAttachment({
          conversationId: previousConversationId,
          attachmentId: attachment.id,
        }).catch(() => undefined);
      }
    }
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
    setPathOpen(false);
    setMoreOpen(false);
    setSelectedCheckpointId(null);
    setBranchTarget(null);
    setSelectedCapabilityIds([]);
    setSelectedWorkflowId(null);
    setRunningMessageMode("steer");
    replacePendingImage(null);
    replacePendingAttachments([]);
    setUploadingAttachments([]);
    setActiveArtifactId(readLastArtifact(
      conversation?.id,
      conversation?.activeArtifactId ?? "files",
    ));
    setActionError(null);
    setApplyError(null);
    setWorkspaceWriteError(null);
    setWorkspaceCatalog({ status: "idle", items: [] });
    setWorkspaceAction(null);
    setWorkspaceError(null);
    workspaceRunLogStateRef.current = new Map();
    setWorkspaceRunLogs({});
    setExpandedWorkspaceRunIds(new Set());
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
  }, [
    api,
    conversation?.id,
    replacePendingAttachments,
    replacePendingImage,
  ]);

  const unresolvedVerification = verificationAttention(snapshot);
  useEffect(() => {
    if (!snapshot?.id || !unresolvedVerification) return;
    const key = `${snapshot.id}:${unresolvedVerification.requestKey}`;
    if (verificationAutoOpenRef.current.has(key)) return;
    verificationAutoOpenRef.current.add(key);
    setActiveArtifactId("run_result");
    setArtifactOpen(true);
    if (mobileActive) onMobileViewChange?.("artifact");
  }, [
    mobileActive,
    onMobileViewChange,
    snapshot?.id,
    unresolvedVerification?.requestKey,
  ]);

  useEffect(() => {
    if (!selectedCheckpointId) return;
    const exists = snapshot?.sessionPath?.checkpoints?.some(
      (checkpoint) => checkpoint.id === selectedCheckpointId,
    );
    if (!exists) setSelectedCheckpointId(null);
  }, [selectedCheckpointId, snapshot?.sessionPath?.checkpoints]);

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
    writeTransparentMode(transparentMode);
  }, [transparentMode]);

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
  shouldPollConversationRef.current = shouldPollConversation;

  useEffect(() => {
    const conversationId = snapshot?.id;
    if (!conversationId) return undefined;
    let disposed = false;
    let timeoutId = null;
    let controller = null;
    let requestActive = false;
    let refreshQueued = false;
    let refreshQueuedWithActivity = false;
    let unsubscribe = null;
    let streamConnected = false;
    let lastStreamActivityAt = Date.now();
    let reconnectTimeoutId = null;
    let streamWatchdogTimeoutId = null;
    let hydrationTimeoutId = null;
    let eventFrameId = null;
    let pendingStreamEvents = [];

    function scheduleHydration() {
      if (hydrationTimeoutId !== null) {
        window.clearTimeout(hydrationTimeoutId);
      }
      hydrationTimeoutId = window.setTimeout(() => {
        hydrationTimeoutId = null;
        void refreshSnapshot();
      }, 100);
    }

    function flushPendingStreamEvents() {
      eventFrameId = null;
      if (disposed || pendingStreamEvents.length === 0) return;
      const events = pendingStreamEvents
        .sort((left, right) => Number(left?.seq) - Number(right?.seq));
      pendingStreamEvents = [];
      let nextSnapshot = snapshotRef.current;
      let hydrationNeeded = false;
      for (const event of events) {
        nextSnapshot = applyProjectWorkEventDelta(nextSnapshot, event);
        hydrationNeeded ||= projectWorkEventNeedsHydration(event);
      }
      publishSnapshot(nextSnapshot);
      if (hydrationNeeded) scheduleHydration();
    }

    function schedulePoll() {
      if (disposed || timeoutId !== null) return;
      timeoutId = window.setTimeout(() => {
        timeoutId = null;
        void refreshSnapshot({ continuePolling: true });
      }, pollIntervalMs);
    }

    async function refreshSnapshot({
      continuePolling = false,
      includeActivity = false,
    } = {}) {
      if (disposed) return;
      if (requestActive) {
        refreshQueued = true;
        refreshQueuedWithActivity ||= includeActivity;
        if (continuePolling) schedulePoll();
        return;
      }
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }
      requestActive = true;
      controller = new AbortController();
      let keepPolling = continuePolling;
      try {
        const nextSnapshot = await api.fetchConversation({
          conversationId,
          includeActivity,
          signal: controller.signal,
        });
        if (disposed) return;
        const acceptedSnapshot = publishSnapshot(nextSnapshot);
        keepPolling = continuePolling && !streamConnected && (
          isConversationRunning(acceptedSnapshot)
          || hasProcessingDocuments(acceptedSnapshot)
        );
      } catch (error) {
        if (disposed || error?.name === "AbortError") return;
        errorRef.current?.(error);
      } finally {
        requestActive = false;
        if (refreshQueued && !disposed) {
          const queuedActivity = refreshQueuedWithActivity;
          refreshQueued = false;
          refreshQueuedWithActivity = false;
          void refreshSnapshot({
            continuePolling: keepPolling,
            includeActivity: queuedActivity,
          });
          return;
        }
        if (keepPolling) schedulePoll();
      }
    }

    function scheduleStreamWatchdog() {
      if (disposed || streamWatchdogTimeoutId !== null) return;
      const watchdogDelay = Math.max(45_000, pollIntervalMs * 15);
      streamWatchdogTimeoutId = window.setTimeout(() => {
        streamWatchdogTimeoutId = null;
        if (
          streamConnected
          && shouldPollConversationRef.current
          && Date.now() - lastStreamActivityAt >= watchdogDelay
        ) {
          void refreshSnapshot({ includeActivity: true });
        }
        scheduleStreamWatchdog();
      }, watchdogDelay);
    }

    if (typeof api.subscribeConversation === "function") {
      try {
        unsubscribe = api.subscribeConversation({
          conversationId,
          afterSeq: conversationEventResumeSeq(snapshotRef.current),
          onConversation: (nextSnapshot) => {
            if (disposed) return;
            lastStreamActivityAt = Date.now();
            publishSnapshot(mergeIncrementalConversationSnapshot(
              snapshotRef.current,
              nextSnapshot,
            ));
          },
          onEvent: (event) => {
            if (disposed) return;
            lastStreamActivityAt = Date.now();
            pendingStreamEvents.push(event);
            if (eventFrameId === null) {
              eventFrameId = window.requestAnimationFrame(
                flushPendingStreamEvents,
              );
            }
          },
          onHeartbeat: () => {
            if (disposed) return;
            lastStreamActivityAt = Date.now();
          },
          onResync: () => {
            if (disposed) return;
            if (eventFrameId !== null) {
              window.cancelAnimationFrame(eventFrameId);
              flushPendingStreamEvents();
            }
            void refreshSnapshot({ includeActivity: true });
          },
          onConnectionState: (state) => {
            if (disposed) return;
            streamConnected = state === "connected";
            if (streamConnected) {
              lastStreamActivityAt = Date.now();
              if (reconnectTimeoutId !== null) {
                window.clearTimeout(reconnectTimeoutId);
                reconnectTimeoutId = null;
              }
              if (timeoutId !== null) {
                window.clearTimeout(timeoutId);
                timeoutId = null;
              }
              return;
            }
            if (reconnectTimeoutId !== null) return;
            reconnectTimeoutId = window.setTimeout(() => {
              reconnectTimeoutId = null;
              if (!streamConnected && shouldPollConversationRef.current) {
                schedulePoll();
              }
            }, Math.max(5_000, pollIntervalMs * 3));
          },
          onError: (error) => {
            if (disposed) return;
            errorRef.current?.(error);
          },
        });
      } catch (error) {
        errorRef.current?.(error);
      }
    }
    if (unsubscribe) scheduleStreamWatchdog();
    if (!unsubscribe && shouldPollConversationRef.current) {
      schedulePoll();
    }
    return () => {
      disposed = true;
      window.clearTimeout(timeoutId);
      window.clearTimeout(reconnectTimeoutId);
      window.clearTimeout(streamWatchdogTimeoutId);
      window.clearTimeout(hydrationTimeoutId);
      window.cancelAnimationFrame(eventFrameId);
      pendingStreamEvents = [];
      controller?.abort();
      unsubscribe?.();
    };
  }, [
    api,
    pollIntervalMs,
    publishSnapshot,
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
    if (
      !text
      || !snapshot?.id
      || action
      || modelSelectionDisabled
      || uploadingAttachments.length > 0
    ) return;
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
        || pendingAttachments.length > 0
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
    let startedNewTurn = !running;
    const sendNewTurn = () => api.sendMessage({
      conversationId: snapshot.id,
      text,
      checkpointId: branchTarget?.id,
      contexts: contextChips,
      images: pendingImage ? [pendingImage.file] : [],
      attachments: pendingAttachments,
      capabilities: selectedCapabilityIds,
      workflowId: branchTarget ? "planning" : selectedWorkflowId,
      providerId: providerId || snapshot.providerId,
      modelId: modelId || snapshot.modelId,
      thinkingLevel: activeThinkingLevel,
    });
    setDraft("");
    executeAction(queueFollowUp ? "follow-up" : "message", async () => {
      if (!running) return sendNewTurn();
      try {
        return queueFollowUp
          ? await api.enqueueFollowUp({
              conversationId: snapshot.id,
              text,
            }).then((result) => result.snapshot)
          : await api.steerConversation({
              conversationId: snapshot.id,
              text,
            });
      } catch (error) {
        if (error?.code !== "PROJECT_WORK_NOT_RUNNING") throw error;
        if (typeof api.fetchConversation === "function") {
          const currentSnapshot = await api.fetchConversation({
            conversationId: snapshot.id,
            includeActivity: true,
          });
          publishSnapshot(currentSnapshot);
        }
        startedNewTurn = true;
        return sendNewTurn();
      }
    }).then((nextSnapshot) => {
      if (!nextSnapshot) {
        setDraft((current) => current || submittedDraft);
        return;
      }
      if (startedNewTurn) {
        setBranchTarget(null);
        if (branchTarget) setSelectedCheckpointId(null);
        setContextChips([]);
        setSelectedCapabilityIds([]);
        setSelectedWorkflowId(null);
        replacePendingImage(null);
        replacePendingAttachments([]);
      }
    });
  }, [
    action,
    api,
    branchTarget,
    contextChips,
    draft,
    executeAction,
    modelSelectionDisabled,
    modelId,
    pendingAttachments,
    pendingImage,
    providerId,
    publishSnapshot,
    replacePendingAttachments,
    replacePendingImage,
    runningMessageMode,
    selectedCapabilityIds,
    selectedWorkflowId,
    supportsImages,
    activeThinkingLevel,
    snapshot,
    uploadingAttachments,
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

  const addPendingAttachments = useCallback(async (files) => {
    if (
      action
      || uploadingAttachments.length > 0
      || isConversationRunning(snapshot)
    ) {
      throw new TypeError("请等待当前 Agent 完成后再添加消息文件");
    }
    if (!snapshot?.id || typeof api.uploadAttachment !== "function") {
      throw new TypeError("当前会话暂时不能保存普通附件");
    }
    const current = pendingAttachmentsRef.current;
    const additions = files
      .map(validateProjectWorkTextAttachmentFile)
      .filter((file) => !current.some((attachment) => (
        attachment.fileName === file.name
        && attachment.byteLength === file.size
      )));
    if (current.length + additions.length > MAX_PROJECT_WORK_TEXT_ATTACHMENTS) {
      throw new TypeError(
        `每条消息最多添加 ${MAX_PROJECT_WORK_TEXT_ATTACHMENTS} 个文本或代码文件`,
      );
    }
    if (additions.length === 0) {
      setActionError(null);
      return;
    }
    const conversationId = snapshot.id;
    setUploadingAttachments(additions.map((file) => file.name));
    try {
      for (const file of additions) {
        const attachment = await api.uploadAttachment({
          conversationId,
          file,
        });
        if (snapshotRef.current?.id !== conversationId) {
          await api.removeAttachment?.({
            conversationId,
            attachmentId: attachment.id,
          }).catch(() => undefined);
          continue;
        }
        replacePendingAttachments([
          ...pendingAttachmentsRef.current,
          attachment,
        ]);
      }
      setActionError(null);
    } finally {
      setUploadingAttachments([]);
    }
  }, [
    action,
    api,
    replacePendingAttachments,
    snapshot,
    uploadingAttachments.length,
  ]);

  const removePendingAttachment = useCallback((attachmentId) => {
    if (!attachmentId || action === "message") return;
    const conversationId = snapshot?.id;
    const attachment = pendingAttachmentsRef.current.find(
      (item) => item.id === attachmentId,
    );
    if (!conversationId || !attachment) return;
    replacePendingAttachments(
      pendingAttachmentsRef.current.filter(
        (item) => item.id !== attachmentId,
      ),
    );
    if (typeof api.removeAttachment !== "function") return;
    api.removeAttachment({
      conversationId,
      attachmentId,
    }).catch((error) => {
      if (
        snapshotRef.current?.id === conversationId
        && !pendingAttachmentsRef.current.some(
          (item) => item.id === attachmentId,
        )
      ) {
        replacePendingAttachments([
          ...pendingAttachmentsRef.current,
          attachment,
        ]);
      }
      setActionError(error);
      errorRef.current?.(error);
    });
  }, [action, api, replacePendingAttachments, snapshot?.id]);

  const openArtifact = useCallback((
    artifactId,
    path = "",
    line = null,
    contentHash = "",
  ) => {
    if (!ARTIFACTS.some((artifact) => artifact.id === artifactId)) return;
    setActiveArtifactId(artifactId);
    setArtifactOpen(true);
    if (mobileActive) onMobileViewChange?.("artifact");
    if (artifactId === "files" && path) {
      setRequestedFilePath(path);
      setRequestedFileLine(Number.isSafeInteger(line) ? line : null);
      setRequestedFileHash(typeof contentHash === "string" ? contentHash : "");
    }
  }, [mobileActive, onMobileViewChange]);

  const openCodeEvidence = useCallback(async (reference) => {
    const conversationId = snapshotRef.current?.id;
    if (!conversationId || !reference?.path || !reference?.contentHash) return;
    try {
      const current = await api.fetchFile({
        conversationId,
        path: reference.path,
        startLine: reference.startLine,
        endLine: reference.startLine,
      });
      if (current.contentHash !== reference.contentHash) {
        const staleError = new Error(
          `引用已过期：${reference.path} 在本轮读取后已经变化，未跳转到可能错误的内容。`,
        );
        staleError.code = "PROJECT_WORK_CODE_EVIDENCE_STALE";
        throw staleError;
      }
      setActionError(null);
      openArtifact(
        "files",
        reference.path,
        reference.startLine,
        reference.contentHash,
      );
    } catch (error) {
      setActionError(error);
      errorRef.current?.(error);
    }
  }, [api, openArtifact]);

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

  const dropFiles = useCallback(async (files) => {
    const grouped = {
      pdf: [],
      image: [],
      text: [],
      unsupported: [],
    };
    files.forEach((file) => {
      grouped[projectWorkDroppedFileKind(file)].push(file);
    });
    const errors = [];

    if (grouped.unsupported.length > 0) {
      errors.push(new TypeError(
        `暂不支持 ${grouped.unsupported.map((file) => file.name).join("、")}；可拖入 PDF、Word、Excel、图片、文本或代码文件`,
      ));
    }
    if (grouped.image.length > 1) {
      errors.push(new TypeError("每条消息最多添加一张图片"));
    } else if (grouped.image.length === 1) {
      if (isConversationRunning(snapshot)) {
        errors.push(new TypeError("请等待当前 Agent 完成后再添加图片"));
      } else {
        try {
          validateProjectWorkImageFile(grouped.image[0]);
          selectImage(grouped.image[0]);
        } catch (error) {
          errors.push(error);
        }
      }
    }
    if (grouped.text.length > 0) {
      try {
        await addPendingAttachments(grouped.text);
      } catch (error) {
        errors.push(error);
      }
    }
    for (const file of grouped.pdf) {
      await uploadPdf(file);
    }
    if (errors.length > 0) {
      setActionError(errors[0]);
      errorRef.current?.(errors[0]);
    }
  }, [addPendingAttachments, selectImage, snapshot, uploadPdf]);

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

  const confirmWorkspaceWrite = useCallback((write) => {
    if (!write?.id || typeof api.confirmWorkspaceWrite !== "function") return;
    executeAction(
      `workspace-write-confirm:${write.id}`,
      () => api.confirmWorkspaceWrite({
        conversationId: snapshot.id,
        writeId: write.id,
      }),
      setWorkspaceWriteError,
    );
  }, [api, executeAction, snapshot?.id]);

  const cancelWorkspaceWrite = useCallback((write) => {
    if (!write?.id || typeof api.cancelWorkspaceWrite !== "function") return;
    executeAction(
      `workspace-write-cancel:${write.id}`,
      () => api.cancelWorkspaceWrite({
        conversationId: snapshot.id,
        writeId: write.id,
      }),
      setWorkspaceWriteError,
    );
  }, [api, executeAction, snapshot?.id]);

  const confirmWorkspaceRun = useCallback((run) => {
    if (
      !run?.id
      || !run.requestHash
      || typeof api.confirmWorkspaceRun !== "function"
    ) return;
    openArtifact("run_result");
    executeAction(
      `workspace-run-confirm:${run.id}`,
      () => api.confirmWorkspaceRun({
        conversationId: snapshot.id,
        requestId: run.id,
        requestHash: run.requestHash,
      }),
      setVerificationError,
    );
  }, [api, executeAction, openArtifact, snapshot?.id]);

  const cancelWorkspaceRun = useCallback((run) => {
    if (!run?.id || typeof api.cancelWorkspaceRun !== "function") return;
    executeAction(
      `workspace-run-cancel:${run.id}`,
      () => api.cancelWorkspaceRun({
        conversationId: snapshot.id,
        requestId: run.id,
      }),
      setVerificationError,
    );
  }, [api, executeAction, snapshot?.id]);

  const undoAppliedChanges = useCallback((record) => {
    const workspaceWrite = record?.status === "written";
    if (
      !record?.id
      || (!workspaceWrite && record.status !== "applied")
      || record.undo?.status !== "available"
      || !record.undo?.hash
      || typeof api.undoApply !== "function"
    ) {
      return;
    }
    const recordFiles = workspaceWrite
      ? [{ path: record.path }]
      : record.files ?? [];
    const fileList = recordFiles.map((file) => `• ${file.path}`).join("\n");
    const confirmed = typeof window === "undefined" || window.confirm(
      [
        "撤销这次已应用的修改？",
        "",
        `将恢复以下 ${recordFiles.length} 个文件到写入前版本：`,
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

  const confirmGitCloseout = useCallback((proposal) => {
    if (
      !proposal?.id
      || proposal.status !== "ready"
      || typeof api.confirmGitCloseout !== "function"
    ) {
      return;
    }
    executeAction(
      `git-closeout:${proposal.id}`,
      () => api.confirmGitCloseout({
        conversationId: snapshot.id,
        proposal,
      }),
      setGitCloseoutError,
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

  const retryCheckpoint = useCallback((checkpointId) => {
    if (!checkpointId || typeof api.retryCheckpoint !== "function") return;
    executeAction(
      `retry-checkpoint:${checkpointId}`,
      () => api.retryCheckpoint({
        conversationId: snapshot.id,
        checkpointId,
      }),
    ).then((nextSnapshot) => {
      if (nextSnapshot) setSelectedCheckpointId(null);
    });
  }, [api, executeAction, snapshot?.id]);

  const startCheckpointBranch = useCallback((checkpointId) => {
    const checkpoint = snapshot?.sessionPath?.checkpoints?.find(
      (item) => item.id === checkpointId,
    );
    if (!checkpoint) return;
    const turnLabel = Number.isSafeInteger(checkpoint.turnSeq)
      ? `第 ${checkpoint.turnSeq} 轮`
      : "已选回答";
    const attemptLabel = Number.isSafeInteger(checkpoint.attempt)
      ? `方案 ${checkpoint.attempt}`
      : "检查点";
    setSelectedCheckpointId(checkpoint.id);
    setBranchTarget({
      id: checkpoint.id,
      label: `${turnLabel} · ${attemptLabel}`,
    });
    setSelectedWorkflowId("planning");
  }, [snapshot?.sessionPath?.checkpoints]);

  const cancelCheckpointBranch = useCallback(() => {
    setBranchTarget(null);
    setSelectedWorkflowId((current) => current === "planning" ? null : current);
  }, []);

  const forkCheckpoint = useCallback(async (checkpointId) => {
    if (
      !checkpointId
      || action
      || !snapshot?.id
      || typeof api.forkCheckpoint !== "function"
    ) {
      return;
    }
    setAction(`fork-checkpoint:${checkpointId}`);
    setActionError(null);
    try {
      const forkedConversation = await api.forkCheckpoint({
        conversationId: snapshot.id,
        checkpointId,
      });
      onConversationForked?.(forkedConversation);
    } catch (error) {
      setActionError(error);
      errorRef.current?.(error);
    } finally {
      setAction(null);
    }
  }, [action, api, onConversationForked, snapshot?.id]);

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

  const runBrowserQa = useCallback(() => {
    if (
      snapshot?.preview?.status !== "ready"
      || typeof api.runBrowserQa !== "function"
    ) {
      return;
    }
    openArtifact("run_result");
    executeAction(
      "browser-qa",
      () => api.runBrowserQa({ conversationId: snapshot.id }),
      setBrowserQaError,
    );
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
  const headerStatus = activeStatus(snapshot);
  const headerStatusLabel = STATUS_LABELS[headerStatus] ?? headerStatus;

  useEffect(() => {
    if (!conversationRunning) setRunningMessageMode("steer");
  }, [conversationRunning]);

  useEffect(() => {
    if (
      !pathOpen
      || standalone
      || !project?.id
      || typeof api.listWorkspaces !== "function"
    ) return undefined;
    const controller = new AbortController();
    setWorkspaceCatalog((current) => ({
      status: current.items.length > 0 ? "refreshing" : "loading",
      items: current.items,
    }));
    setWorkspaceError(null);
    api.listWorkspaces({ projectId: project.id, signal: controller.signal })
      .then((items) => setWorkspaceCatalog({ status: "ready", items }))
      .catch((error) => {
        if (error?.name === "AbortError") return;
        setWorkspaceCatalog((current) => ({ ...current, status: "error" }));
        setWorkspaceError(error.message || "无法读取 Workspace");
      });
    return () => controller.abort();
  }, [api, pathOpen, project?.id, standalone]);

  const refreshWorkspaces = useCallback(async () => {
    if (!project?.id || typeof api.listWorkspaces !== "function") return [];
    const items = await api.listWorkspaces({ projectId: project.id });
    setWorkspaceCatalog({ status: "ready", items });
    return items;
  }, [api, project?.id]);

  const createConversationInWorkspace = useCallback(async (workspace) => {
    if (!workspace?.id || !project?.id || !onCreateConversationInWorkspace) return;
    setWorkspaceAction(`conversation:${workspace.id}`);
    setWorkspaceError(null);
    try {
      await onCreateConversationInWorkspace({
        projectId: project.id,
        workspaceId: workspace.id,
      });
    } catch (error) {
      setWorkspaceError(error.message || "无法在此 Workspace 新建会话");
      await refreshWorkspaces().catch(() => undefined);
    } finally {
      setWorkspaceAction(null);
    }
  }, [onCreateConversationInWorkspace, project?.id, refreshWorkspaces]);

  const createWorktreeConversation = useCallback(async (sourceWorkspace) => {
    if (
      !sourceWorkspace?.id
      || !sourceWorkspace.head
      || !project?.id
      || typeof api.createWorkspace !== "function"
    ) return;
    setWorkspaceAction("create");
    setWorkspaceError(null);
    try {
      const created = await api.createWorkspace({
        projectId: project.id,
        sourceWorkspaceId: sourceWorkspace.id,
        expectedHead: sourceWorkspace.head,
        title: snapshot?.title || "task",
      });
      setWorkspaceCatalog((current) => ({
        status: "ready",
        items: [...current.items.filter((item) => item.id !== created.id), created],
      }));
      if (onCreateConversationInWorkspace) {
        await onCreateConversationInWorkspace({
          projectId: project.id,
          workspaceId: created.id,
        });
      }
    } catch (error) {
      setWorkspaceError(error.message || "无法创建 Workspace");
      await refreshWorkspaces().catch(() => undefined);
    } finally {
      setWorkspaceAction(null);
    }
  }, [api, onCreateConversationInWorkspace, project?.id, refreshWorkspaces, snapshot?.title]);

  const removeWorkspace = useCallback(async (workspace) => {
    if (
      !workspace?.id
      || !workspace.head
      || !project?.id
      || typeof api.removeWorkspace !== "function"
    ) return;
    const confirmed = typeof window === "undefined" || window.confirm(
      `删除干净的 Workspace“${workspace.label || workspace.branch}”？\n\n工作目录会被移除，Git 分支仍会保留；不会使用强制删除。`,
    );
    if (!confirmed) return;
    setWorkspaceAction(`delete:${workspace.id}`);
    setWorkspaceError(null);
    try {
      await api.removeWorkspace({
        projectId: project.id,
        workspaceId: workspace.id,
        expectedHead: workspace.head,
      });
      await refreshWorkspaces();
    } catch (error) {
      setWorkspaceError(error.message || "无法删除 Workspace");
      await refreshWorkspaces().catch(() => undefined);
    } finally {
      setWorkspaceAction(null);
    }
  }, [api, project?.id, refreshWorkspaces]);

  const workspaceRunRevision = (snapshot?.workspaceRuns ?? [])
    .map((run) => `${run.id}:${run.runId ?? ""}:${run.status}`)
    .join("|");
  const expandedWorkspaceRunRevision = [...expandedWorkspaceRunIds]
    .sort()
    .join("|");
  const handleWorkspaceRunExpandedChange = useCallback((runId, expanded) => {
    if (!runId) return;
    setExpandedWorkspaceRunIds((current) => {
      const next = new Set(current);
      if (expanded) next.add(runId);
      else next.delete(runId);
      return next;
    });
    if (!expanded) {
      workspaceRunLogStateRef.current.delete(runId);
      setWorkspaceRunLogs((current) => {
        if (!Object.hasOwn(current, runId)) return current;
        const next = { ...current };
        delete next[runId];
        return next;
      });
    }
  }, []);
  const runArtifactVisible = artifactOpen && activeArtifactId === "run_result";
  useEffect(() => {
    if (!runArtifactVisible) {
      if (workspaceRunLogStateRef.current.size > 0) {
        workspaceRunLogStateRef.current = new Map();
        setWorkspaceRunLogs({});
      }
      return undefined;
    }
    const conversationId = snapshot?.id;
    const runs = workspaceRunsToLoad(
      snapshot?.workspaceRuns,
      expandedWorkspaceRunIds,
    );
    if (!conversationId || runs.length === 0 || typeof api.fetchWorkspaceRun !== "function") {
      return undefined;
    }
    let disposed = false;
    let timeoutId = null;
    const controllers = new Set();
    const publishLogs = () => {
      const next = {};
      for (const [runId, state] of workspaceRunLogStateRef.current) {
        next[runId] = { events: state.events, afterSeq: state.afterSeq };
      }
      setWorkspaceRunLogs(next);
    };
    const fetchRun = async (run) => {
      const previous = workspaceRunLogStateRef.current.get(run.runId) ?? {
        afterSeq: 0,
        events: [],
      };
      let afterSeq = previous.afterSeq;
      let events = previous.events;
      let hasMore = true;
      while (!disposed && hasMore) {
        const controller = new AbortController();
        controllers.add(controller);
        try {
          const page = await api.fetchWorkspaceRun({
            conversationId,
            runId: run.runId,
            afterSeq,
            limit: 500,
            signal: controller.signal,
          });
          const incoming = Array.isArray(page?.events) ? page.events : [];
          events = [...new Map([...events, ...incoming]
            .filter((event) => Number.isSafeInteger(event?.seq))
            .map((event) => [event.seq, event])).values()]
            .sort((left, right) => left.seq - right.seq);
          afterSeq = Number.isSafeInteger(page?.nextSeq)
            ? page.nextSeq
            : events.at(-1)?.seq ?? afterSeq;
          hasMore = page?.hasMore === true;
        } finally {
          controllers.delete(controller);
        }
      }
      workspaceRunLogStateRef.current.set(run.runId, { afterSeq, events });
    };
    const poll = async () => {
      try {
        await Promise.all(runs.map(fetchRun));
        if (!disposed) publishLogs();
      } catch (error) {
        if (!disposed && error?.name !== "AbortError") errorRef.current?.(error);
      }
      if (!disposed && runs.some((run) => ["queued", "running"].includes(run.status))) {
        timeoutId = window.setTimeout(poll, Math.min(pollIntervalMs, 750));
      }
    };
    void poll();
    return () => {
      disposed = true;
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      for (const controller of controllers) controller.abort();
    };
  }, [
    api,
    expandedWorkspaceRunRevision,
    pollIntervalMs,
    runArtifactVisible,
    snapshot?.id,
    workspaceRunRevision,
  ]);

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

  useEffect(() => {
    if (providerOpen) {
      setPathOpen(false);
      setMoreOpen(false);
    }
  }, [providerOpen]);
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
  const thinkingBusy = modelSelectionDisabled
    || conversationRunning
    || Boolean(action && !thinkingSaving);
  const thinkingHint = activeModelInfo?.supportsThinking !== true
    ? "当前模型不支持调节思考强度"
    : conversationRunning
      ? "Agent 工作期间不能切换思考强度"
      : modelSelectionDisabled
        ? "正在保存模型选择"
        : thinkingSaving
          ? "正在保存思考强度"
          : thinkingBusy
            ? "当前操作完成后可切换思考强度"
            : "选择下一轮使用的思考强度";
  const showProviderThinking = Boolean(activeModelId);
  const changeThinkingLevel = useCallback((nextThinkingLevel) => {
    if (
      conversationRunning
      || modelSelectionDisabled
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
    modelSelectionDisabled,
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
  const titleStatusLabel = snapshot
    ? headerStatusLabel
    : preparingConversation
      ? "正在创建"
      : "尚未开始";
  const titleStatusClass = snapshot
    ? statusClass(snapshot)
    : preparingConversation
      ? "executing"
      : "ready";
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
        <div className="live-project-title-meta">
          <span className="workflow-kicker">
            {standalone ? "独立对话" : project?.name ?? snapshot?.rootLabel ?? "正常工作"}
          </span>
          <span className={`live-project-title-status is-${titleStatusClass}`}>
            <span aria-hidden="true" />
            {titleStatusLabel}
          </span>
        </div>
        <h1 title={snapshot?.title ?? "项目工作"}>
          {snapshot?.title ?? "项目工作"}
        </h1>
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
              setPathOpen(false);
              setMoreOpen(false);
            }
            onProviderOpenChange?.(open);
          }}
          providers={providers}
          providerId={activeProvider?.id}
          model={activeModelId}
          onProviderChange={onProviderChange}
          onModelChange={onModelChange}
          selectionDisabled={
            modelSelectionDisabled || conversationRunning || turnPayloadLocked
          }
          thinkingLevels={showProviderThinking ? availableThinkingLevels : null}
          thinkingLevel={activeThinkingLevel}
          supportsThinking={activeModelInfo?.supportsThinking === true}
          thinkingDisabled={thinkingBusy || thinkingSaving}
          thinkingHint={thinkingHint}
          onThinkingLevelChange={changeThinkingLevel}
        />
      ) : null}
      <ProjectCapabilityMenu
        open={capabilityOpen}
        hideTrigger
        onOpenChange={(open) => {
          if (turnPayloadLocked && open) return;
          setCapabilityOpen(open);
          if (open) {
            setContextUsageOpen(false);
            setExecutionPolicyOpen(false);
            setPathOpen(false);
            setMoreOpen(false);
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
      {snapshot ? (
        <>
          <ProjectSessionPathMenu
            open={pathOpen}
            hideTrigger
            onOpenChange={(open) => {
              setPathOpen(open);
              if (open) {
                setContextUsageOpen(false);
                setExecutionPolicyOpen(false);
                setCapabilityOpen(false);
                setMoreOpen(false);
                onProviderOpenChange?.(false);
              }
            }}
            sessionPath={snapshot.sessionPath}
            messages={snapshot.messages}
            selectedCheckpointId={selectedCheckpointId}
            onSelectCheckpoint={setSelectedCheckpointId}
            onRetryCheckpoint={retryCheckpoint}
            onStartBranch={startCheckpointBranch}
            onForkCheckpoint={forkCheckpoint}
            workspaces={workspaceCatalog.items}
            currentWorkspaceId={snapshot.workspace?.id ?? snapshot.workspaceId}
            workspacesLoading={["loading", "refreshing"].includes(workspaceCatalog.status)}
            workspaceAction={workspaceAction}
            workspaceError={workspaceError}
            onCreateWorktreeConversation={createWorktreeConversation}
            onCreateConversationInWorkspace={createConversationInWorkspace}
            onRemoveWorkspace={removeWorkspace}
            busy={conversationRunning || Boolean(action)}
            standalone={standalone}
          />
          <ProjectHeaderMoreMenu
            open={moreOpen}
            onOpenChange={(open) => {
              setMoreOpen(open);
              if (open) {
                setContextUsageOpen(false);
                setExecutionPolicyOpen(false);
                setCapabilityOpen(false);
                setPathOpen(false);
                onProviderOpenChange?.(false);
              }
            }}
            selectedCapabilityCount={selectedCapabilityIds.length + (selectedWorkflowId ? 1 : 0)}
            onOpenCapabilities={() => setCapabilityOpen(true)}
            onOpenPath={() => setPathOpen(true)}
            transparentMode={transparentMode}
            onToggleTransparentMode={() => setTransparentMode(!transparentMode)}
            notificationControl={<ProjectLoopNotificationControl conversation={snapshot} menuItem />}
          />
          {snapshot.unreadCount > 0 ? (
            <span className="project-agent-unread" role="status">
              {snapshot.unreadCount} 条未读
            </span>
          ) : null}
        </>
      ) : null}
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
          events: mergeTurnHistoryEvents(olderTurns, snapshot.events),
        }
      : snapshot
  ), [olderTurns, snapshot]);

  if (!snapshot) {
    return (
      <AgentArtifactLayout
        ariaLabel="项目工作"
        mobileActive={mobileActive}
        mobileView={mobileView === "artifact" ? "agent" : mobileView}
        agentMobileView="agent"
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
      mobileActive={mobileActive}
      mobileView={mobileView}
      agentMobileView="agent"
      artifactOpen={artifactOpen || (mobileActive && mobileView === "artifact")}
      onArtifactOpenChange={(open) => {
        setArtifactOpen(open);
        if (mobileActive) onMobileViewChange?.(open ? "artifact" : "agent");
      }}
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
          pendingAttachments={pendingAttachments}
          uploadingAttachments={uploadingAttachments}
          onRemoveAttachment={removePendingAttachment}
          onDropFiles={dropFiles}
          localFileInputRef={localFileInputRef}
          supportsImages={supportsImages}
          onSubmit={submitMessage}
          onAbort={abortConversation}
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
          onOpenCodeEvidence={openCodeEvidence}
          generatedImageUrl={api.generatedImageUrl}
          action={action}
          error={actionError}
          modelSelectionDisabled={modelSelectionDisabled}
          executionPolicyControl={(
            <ProjectExecutionPolicyControl
              open={executionPolicyOpen}
              onOpenChange={(open) => {
                if (conversationRunning || action) return;
                setExecutionPolicyOpen(open);
                if (open) {
                  setContextUsageOpen(false);
                  setCapabilityOpen(false);
                  setPathOpen(false);
                  onProviderOpenChange?.(false);
                }
              }}
              executionPolicy={snapshot.executionPolicy}
              running={conversationRunning}
              saving={executionPolicySaving}
              onChange={changeExecutionPolicy}
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
                  setPathOpen(false);
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
          transparentMode={transparentMode}
          uploadingPdf={uploadingPdf}
          onRetryDocument={retryDocument}
          retryingDocumentId={retryingDocumentId}
          standalone={standalone}
          selectedCheckpointId={selectedCheckpointId}
          branchTarget={branchTarget}
          onCancelBranch={cancelCheckpointBranch}
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
          onConfirmWorkspaceWrite={confirmWorkspaceWrite}
          onCancelWorkspaceWrite={cancelWorkspaceWrite}
          workspaceWriteAction={String(action ?? "").startsWith("workspace-write-")
            ? action
            : null}
          workspaceWriteError={workspaceWriteError}
          onConfirmGitCloseout={confirmGitCloseout}
          gitCloseoutConfirming={String(action ?? "").startsWith("git-closeout:")}
          gitCloseoutError={gitCloseoutError}
          conversationRunning={conversationRunning}
          onStartPreview={startPreview}
          previewStarting={action === "preview-start"}
          previewError={previewError}
          onRunBrowserQa={runBrowserQa}
          browserQaRunning={action === "browser-qa"
            || snapshot.browserQaRuns?.some((run) => run.status === "running")}
          browserQaError={browserQaError}
          onRunVerification={runVerification}
          onConfirmWorkspaceRun={confirmWorkspaceRun}
          onCancelWorkspaceRun={cancelWorkspaceRun}
          workspaceRunAction={String(action ?? "").startsWith("workspace-run-")
            ? action
                .replace("workspace-run-confirm:", "confirm:")
                .replace("workspace-run-cancel:", "cancel:")
            : null}
          workspaceRunLogs={workspaceRunLogs}
          expandedWorkspaceRunIds={expandedWorkspaceRunIds}
          onWorkspaceRunExpandedChange={handleWorkspaceRunExpandedChange}
          onResumeVerificationRepair={resumeVerificationRepair}
          resumingOperationId={resumingVerificationRepairId}
          verificationError={verificationError}
          verificationRunning={action === "verification"
            || Boolean(resumingVerificationRepairId)
            || snapshot.verificationRuns.some((run) => run.status === "running")}
          requestedFilePath={requestedFilePath}
          requestedFileLine={requestedFileLine}
          requestedFileHash={requestedFileHash}
          onRequestedFilePathHandled={() => {
            setRequestedFilePath("");
            setRequestedFileLine(null);
            setRequestedFileHash("");
          }}
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
