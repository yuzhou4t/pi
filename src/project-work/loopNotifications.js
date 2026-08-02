const LOOP_NOTIFICATION_COPY = {
  awaiting_user: {
    title: "Pi Agent 等待你的回答",
    body: "回到当前任务继续；通知不会代替任何确认。",
  },
  awaiting_review: {
    title: "Pi Agent 有内容等待审阅",
    body: "回到当前任务核对精确内容后再决定是否继续。",
  },
  verification_failed: {
    title: "Pi Agent 的验证未通过",
    body: "回到当前任务查看受控运行结果和恢复选项。",
  },
  completed: {
    title: "Pi Agent 已完成本轮工作",
    body: "结果和验证证据已保存在当前任务中。",
  },
  recovery_blocked: {
    title: "Pi Agent 需要你检查恢复状态",
    body: "自动恢复已停止；回到当前任务检查后再继续。",
  },
};

export function loopLifecycleEvents(events) {
  return Array.isArray(events)
    ? events.filter((event) => (
        event?.type === "loop.lifecycle"
        && LOOP_NOTIFICATION_COPY[event.lifecycleState]
        && Number.isSafeInteger(event.seq)
      ))
    : [];
}

export function safeLoopNotification(event) {
  const copy = LOOP_NOTIFICATION_COPY[event?.lifecycleState];
  return copy ? { ...copy } : null;
}

export function currentLoopCloseoutEvent({
  events,
  conversationStatus,
} = {}) {
  const event = loopLifecycleEvents(events).at(-1);
  if (!event || typeof conversationStatus !== "string") return null;
  const status = conversationStatus;
  const compatible = {
    awaiting_user: status === "awaiting_user",
    awaiting_review: ["awaiting_confirmation", "awaiting_review"].includes(status),
    recovery_blocked: status === "recovery_blocked",
    completed: ["idle", "applied"].includes(status),
    verification_failed: [
      "idle",
      "error",
      "stopped",
      "aborted",
      "awaiting_confirmation",
    ].includes(status),
  };
  return compatible[event.lifecycleState] ? event : null;
}

export function shouldSendLoopNotification({
  event,
  enabled,
  permission,
  visibilityState,
  hasFocus,
  lastNotifiedSeq = 0,
} = {}) {
  return Boolean(
    enabled
    && permission === "granted"
    && event
    && Number.isSafeInteger(event.seq)
    && event.seq > lastNotifiedSeq
    && safeLoopNotification(event)
    && (visibilityState === "hidden" || hasFocus === false)
  );
}
