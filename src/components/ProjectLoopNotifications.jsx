import { useEffect, useRef, useState } from "react";
import {
  Bell,
  BellSlash,
  CaretRight,
  CheckCircle,
  WarningCircle,
} from "@phosphor-icons/react";
import {
  currentLoopCloseoutEvent,
  loopLifecycleEvents,
  safeLoopNotification,
  shouldSendLoopNotification,
} from "../project-work/loopNotifications.js";

const ENABLED_STORAGE_KEY = "pi-agent-loop-notifications-v1";

function notificationApi() {
  return typeof globalThis.Notification === "function"
    ? globalThis.Notification
    : null;
}

function readEnabled() {
  if (typeof window === "undefined") return false;
  try {
    const stored = window.localStorage.getItem(ENABLED_STORAGE_KEY);
    if (stored === "off") return false;
    return notificationApi()?.permission === "granted";
  } catch {
    return false;
  }
}

function writeEnabled(enabled) {
  try {
    window.localStorage.setItem(
      ENABLED_STORAGE_KEY,
      enabled ? "on" : "off",
    );
  } catch {
    // Notification preference is optional and may remain session-only.
  }
}

export function ProjectLoopNotificationControl({ conversation }) {
  const [enabled, setEnabled] = useState(readEnabled);
  const [permission, setPermission] = useState(
    () => notificationApi()?.permission ?? "unsupported",
  );
  const seenByConversation = useRef(new Map());
  const initializedConversations = useRef(new Set());
  const lifecycle = loopLifecycleEvents(conversation?.events);

  useEffect(() => {
    const conversationId = conversation?.id;
    if (!conversationId) return;
    const latestSeq = lifecycle.at(-1)?.seq ?? 0;
    if (!initializedConversations.current.has(conversationId)) {
      initializedConversations.current.add(conversationId);
      seenByConversation.current.set(conversationId, latestSeq);
      return;
    }
    let seen = seenByConversation.current.get(conversationId) ?? 0;
    for (const event of lifecycle) {
      if (event.seq <= seen) continue;
      const shouldSend = shouldSendLoopNotification({
        event,
        enabled,
        permission,
        visibilityState: document.visibilityState,
        hasFocus: document.hasFocus(),
        lastNotifiedSeq: seen,
      });
      seen = Math.max(seen, event.seq);
      if (!shouldSend) continue;
      const copy = safeLoopNotification(event);
      try {
        const notification = new globalThis.Notification(copy.title, {
          body: copy.body,
          tag: `pi-agent:${conversationId}:${event.seq}`,
          renotify: false,
        });
        notification.onclick = () => {
          window.focus();
          notification.close();
        };
      } catch {
        // A notification failure never changes or resumes the task.
      }
    }
    seenByConversation.current.set(conversationId, seen);
  }, [conversation?.id, enabled, lifecycle, permission]);

  const supported = permission !== "unsupported";
  const active = enabled && permission === "granted";
  return (
    <button
      className={`header-meta-pill${active ? " is-active" : ""}`}
      type="button"
      aria-pressed={active}
      disabled={!supported || permission === "denied"}
      title={
        !supported
          ? "当前环境不支持本机通知"
          : permission === "denied"
            ? "系统已阻止通知，请在浏览器设置中重新允许"
            : active
              ? "仅在 Pi Agent 不活跃时通知；点击可关闭"
              : "启用本机 Loop 通知"
      }
      onClick={async () => {
        const Api = notificationApi();
        if (!Api) return;
        if (active) {
          setEnabled(false);
          writeEnabled(false);
          return;
        }
        const nextPermission = Api.permission === "default"
          ? await Api.requestPermission()
          : Api.permission;
        setPermission(nextPermission);
        const nextEnabled = nextPermission === "granted";
        setEnabled(nextEnabled);
        writeEnabled(nextEnabled);
      }}
    >
      {active ? (
        <Bell size={13} weight="fill" aria-hidden="true" />
      ) : (
        <BellSlash size={13} aria-hidden="true" />
      )}
      {active ? "离开时通知" : "本机通知"}
    </button>
  );
}

export function ProjectLoopCloseoutCard({
  events,
  conversationStatus,
  onOpenArtifact,
}) {
  const event = currentLoopCloseoutEvent({
    events,
    conversationStatus,
  });
  if (!event) return null;
  const copy = safeLoopNotification(event);
  const needsAttention = [
    "awaiting_user",
    "awaiting_review",
    "verification_failed",
    "recovery_blocked",
  ].includes(event.lifecycleState);
  const artifactId = event.data?.artifactId ?? event.artifactId ?? null;
  return (
    <section className="project-agent-decision" data-lifecycle={event.lifecycleState}>
      {needsAttention ? (
        <WarningCircle size={18} weight="fill" aria-hidden="true" />
      ) : (
        <CheckCircle size={18} weight="fill" aria-hidden="true" />
      )}
      <div>
        <strong>{copy.title}</strong>
        <p>{copy.body}</p>
      </div>
      {artifactId ? (
        <button
          className="project-agent-link"
          type="button"
          onClick={() => onOpenArtifact?.(artifactId)}
        >
          查看工件
          <CaretRight size={13} weight="bold" aria-hidden="true" />
        </button>
      ) : null}
    </section>
  );
}
