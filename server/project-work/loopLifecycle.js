const SAFE_LIFECYCLE_COPY = {
  awaiting_user: {
    title: "Pi Agent 等待你的回答",
    detail: "回到当前任务继续；通知不会代替任何确认。",
    artifactId: null,
  },
  awaiting_review: {
    title: "Pi Agent 有内容等待审阅",
    detail: "回到当前任务核对精确内容后再决定是否继续。",
    artifactId: "changes",
  },
  verification_failed: {
    title: "Pi Agent 的验证未通过",
    detail: "回到当前任务查看受控运行结果和恢复选项。",
    artifactId: "run_result",
  },
  completed: {
    title: "Pi Agent 已完成本轮工作",
    detail: "结果和验证证据已保存在当前任务中。",
    artifactId: null,
  },
  recovery_blocked: {
    title: "Pi Agent 需要你检查恢复状态",
    detail: "自动恢复已停止；回到当前任务检查后再继续。",
    artifactId: "changes",
  },
};

const SAFE_ARTIFACT_IDS = new Set([
  "changes",
  "preview",
  "run_result",
]);

function lifecycleState(type, data) {
  if (type === "ask_user.requested") return "awaiting_user";
  if (
    type === "agent.status"
    && ["awaiting_confirmation", "awaiting_review"].includes(data?.status)
  ) {
    return "awaiting_review";
  }
  if (
    (
      type === "verification.completed"
      && data?.status === "failed"
    )
    || type === "browser_qa.failed"
    || (
      type === "browser_qa.completed"
      && data?.verdict === "issues"
    )
  ) {
    return "verification_failed";
  }
  if (
    type === "apply_journal.recovery_blocked"
    || type === "git_closeout.recovery_blocked"
    || (
      type === "agent.status"
      && data?.status === "recovery_blocked"
    )
  ) {
    return "recovery_blocked";
  }
  if (
    (
      type === "git_closeout.committed"
      && data?.pendingReview !== true
    )
    || (
      type === "browser_qa.completed"
      && data?.verdict !== "issues"
    )
    || (
      type === "agent.status"
      && ["idle", "applied"].includes(data?.status)
    )
  ) {
    return "completed";
  }
  return null;
}

export function deriveLoopLifecycleEvent(event) {
  if (!event || event.type === "loop.lifecycle") return null;
  const state = lifecycleState(event.type, event.data);
  const copy = SAFE_LIFECYCLE_COPY[state];
  if (!state || !copy || !Number.isSafeInteger(event.seq)) return null;
  const artifactId = (
    state === "awaiting_review"
    && SAFE_ARTIFACT_IDS.has(event.data?.artifactId)
  )
    ? event.data.artifactId
    : copy.artifactId;
  return {
    state,
    sourceEventSeq: event.seq,
    dedupeKey: `${state}:${event.seq}`,
    title: copy.title,
    detail: copy.detail,
    artifactId,
  };
}

export function loopLifecycleCopy(state) {
  const copy = SAFE_LIFECYCLE_COPY[state];
  return copy ? { ...copy } : null;
}
