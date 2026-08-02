export const RUNTIME_SCHEMA_VERSION = 1;

export const CONVERSATION_LIFECYCLE = Object.freeze([
  "idle",
  "running",
  "awaiting_user",
  "awaiting_review",
  "verifying",
  "recovering",
  "stopped",
]);

const LIFECYCLE_SET = new Set(CONVERSATION_LIFECYCLE);

const PROJECT_WORK_STATUS_MAP = Object.freeze({
  idle: "idle",
  applied: "idle",
  running: "running",
  awaiting_user: "awaiting_user",
  awaiting_confirmation: "awaiting_review",
  verifying: "verifying",
  compacting: "running",
  recovering: "recovering",
  interrupted: "recovering",
  recovery_blocked: "stopped",
  error: "stopped",
  failed: "stopped",
  aborted: "stopped",
  stopped: "stopped",
});

const JOURNAL_STATUS_MAP = Object.freeze({
  created: "idle",
  scanning: "running",
  ranking: "running",
  preparing_documents: "running",
  preparing_pdfs: "running",
  preparing_guides: "running",
  generating_guides: "running",
  committing: "running",
  review_ready: "awaiting_review",
  guide_ready: "awaiting_review",
  draft_ready: "awaiting_review",
  awaiting_approval: "awaiting_review",
  manual_action_required: "awaiting_review",
  partial: "awaiting_review",
  paused: "idle",
  reading: "idle",
  reading_ready: "idle",
  completed: "idle",
  recovering: "recovering",
  failed: "stopped",
  stopped: "stopped",
});

export function normalizeLifecycle(value, fallback = "idle") {
  return LIFECYCLE_SET.has(value) ? value : fallback;
}

export function deriveLifecycle(domain, status, {
  pendingQuestion = false,
  pendingReview = false,
  verifying = false,
  recovering = false,
  stopped = false,
} = {}) {
  if (stopped) return "stopped";
  if (recovering) return "recovering";
  if (verifying) return "verifying";
  if (pendingQuestion) return "awaiting_user";
  if (pendingReview) return "awaiting_review";
  const map = domain === "journal"
    ? JOURNAL_STATUS_MAP
    : PROJECT_WORK_STATUS_MAP;
  return normalizeLifecycle(map[String(status ?? "")], "idle");
}

export function migrateRuntimeEnvelope(value, {
  domain,
  status,
  pendingQuestion,
  pendingReview,
  verifying,
  recovering,
  stopped,
} = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  const shouldDerive = (
    typeof domain === "string"
    || status !== undefined
    || pendingQuestion !== undefined
    || pendingReview !== undefined
    || verifying !== undefined
    || recovering !== undefined
    || stopped !== undefined
  );
  if (shouldDerive) {
    return {
      runtime_schema_version: RUNTIME_SCHEMA_VERSION,
      lifecycle: deriveLifecycle(domain, status ?? source.status, {
        pendingQuestion,
        pendingReview,
        verifying,
        recovering,
        stopped,
      }),
    };
  }
  if (
    source.runtime_schema_version === RUNTIME_SCHEMA_VERSION
    && LIFECYCLE_SET.has(source.lifecycle)
  ) {
    return {
      runtime_schema_version: RUNTIME_SCHEMA_VERSION,
      lifecycle: source.lifecycle,
    };
  }
  return {
    runtime_schema_version: RUNTIME_SCHEMA_VERSION,
    lifecycle: "idle",
  };
}
