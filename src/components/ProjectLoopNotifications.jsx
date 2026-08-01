import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bell,
  BellRinging,
  BellSlash,
  CaretDown,
  CaretRight,
  CheckCircle,
  LinkSimple,
  SpinnerGap,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { notificationApi as serverNotificationApi } from "../api/notifications.js";
import {
  currentLoopCloseoutEvent,
  loopLifecycleEvents,
  safeLoopNotification,
  shouldSendLoopNotification,
} from "../project-work/loopNotifications.js";
import "./notifications.css";

const ENABLED_STORAGE_KEY = "pi-agent-loop-notifications-v1";

export const DEFAULT_ATTENTION_EVENT_STATES = Object.freeze([
  "awaiting_user",
  "awaiting_review",
  "verification_failed",
  "recovery_blocked",
]);

export const NOTIFICATION_EVENT_OPTIONS = Object.freeze([
  Object.freeze({ id: "awaiting_user", label: "等待回答" }),
  Object.freeze({ id: "awaiting_review", label: "等待审阅" }),
  Object.freeze({ id: "verification_failed", label: "验证未通过" }),
  Object.freeze({ id: "recovery_blocked", label: "恢复受阻" }),
  Object.freeze({ id: "completed", label: "工作完成" }),
]);

export function notificationScopeExpansion(currentStates, nextStates) {
  const current = new Set(currentStates ?? []);
  return (nextStates ?? []).filter((state) => !current.has(state));
}

export function notificationEventChangeMode(authorizedStates, nextStates) {
  return notificationScopeExpansion(authorizedStates, nextStates).length > 0
    ? "reauthorize"
    : "update";
}

function browserNotificationApi() {
  return typeof globalThis.Notification === "function"
    ? globalThis.Notification
    : null;
}

function readEnabled() {
  if (typeof window === "undefined") return false;
  try {
    const stored = window.localStorage.getItem(ENABLED_STORAGE_KEY);
    if (stored === "off") return false;
    return browserNotificationApi()?.permission === "granted";
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

function authorizationRevision() {
  const suffix = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `ui-${suffix}`;
}

function eventLabels(states) {
  return (states ?? []).map((state) => (
    NOTIFICATION_EVENT_OPTIONS.find((item) => item.id === state)?.label ?? state
  ));
}

export function latestNotificationDelivery(deliveries) {
  return (deliveries ?? [])
    .filter((delivery) => ["sent", "failed"].includes(delivery?.status))
    .reduce((latest, delivery) => {
      if (!latest) return delivery;
      const latestTime = Date.parse(latest.updatedAt ?? latest.createdAt ?? "") || 0;
      const deliveryTime = Date.parse(delivery.updatedAt ?? delivery.createdAt ?? "") || 0;
      return deliveryTime >= latestTime ? delivery : latest;
    }, null);
}

function deliveryTimeLabel(delivery) {
  const value = delivery?.updatedAt ?? delivery?.createdAt;
  const timestamp = Date.parse(value ?? "");
  if (!Number.isFinite(timestamp)) return "时间未记录";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function failedDeliveryDetail(code) {
  if (code === "LARK_BOT_IDENTITY_MISMATCH") {
    return "机器人身份已变化，已安全停止";
  }
  if (code === "LARK_NOTIFICATION_SEND_FAILED") {
    return "飞书未返回有效成功回执，已记录失败";
  }
  return "失败已保留在本机投递记录中";
}

export function NotificationDeliveryStatus({ delivery }) {
  if (!delivery) {
    return (
      <div className="notification-delivery-status">
        <span>最近投递</span>
        <strong>暂无成功或失败记录</strong>
      </div>
    );
  }
  const failed = delivery.status === "failed";
  return (
    <div className={`notification-delivery-status${failed ? " is-failed" : " is-sent"}`}>
      <span>最近投递 · {deliveryTimeLabel(delivery)}</span>
      <strong>{failed ? "投递失败" : "投递成功"}</strong>
      <small>
        {failed
          ? failedDeliveryDetail(delivery.lastErrorCode)
          : "飞书已接受该提醒；这不代表任何审批已完成"}
      </small>
    </div>
  );
}

export function NotificationBindingForm({
  mode,
  initialLabel = "",
  initialType = "chat_id",
  busy,
  onCancel,
  onPreview,
}) {
  const [targetLabel, setTargetLabel] = useState(initialLabel);
  const [targetId, setTargetId] = useState("");
  const [targetType, setTargetType] = useState(initialType);
  const valid = targetLabel.trim() && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(
    targetId.trim(),
  );
  return (
    <form
      className="notification-binding-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid || busy) return;
        onPreview({
          type: targetType,
          id: targetId.trim(),
          label: targetLabel.trim(),
        });
      }}
    >
      <label>
        <span>接收目标类型</span>
        <select
          value={targetType}
          onChange={(event) => setTargetType(event.target.value)}
          disabled={busy}
        >
          <option value="chat_id">群聊 · Chat ID</option>
          <option value="open_id">个人 · Open ID</option>
        </select>
      </label>
      <label>
        <span>接收目标名称</span>
        <input
          value={targetLabel}
          maxLength={120}
          placeholder="例如：个人提醒"
          onChange={(event) => setTargetLabel(event.target.value)}
          disabled={busy}
        />
      </label>
      <label>
        <span>{targetType === "open_id" ? "飞书 Open ID" : "飞书 Chat ID"}</span>
        <input
          value={targetId}
          maxLength={200}
          autoComplete="off"
          spellCheck="false"
          placeholder={targetType === "open_id" ? "ou_…" : "oc_…"}
          onChange={(event) => setTargetId(event.target.value)}
          disabled={busy}
        />
      </label>
      <p>目标只保存在本机服务端；这里只建立提醒订阅，不会发送测试消息。</p>
      <div className="notification-form-actions">
        <button type="button" onClick={onCancel} disabled={busy}>取消</button>
        <button className="is-primary" type="submit" disabled={!valid || busy}>
          预览{mode === "create" ? "绑定" : "更换"}
        </button>
      </div>
    </form>
  );
}

export function NotificationConfirmation({ pending, busy, onCancel, onConfirm }) {
  const isScope = pending.kind === "scope";
  return (
    <div className="notification-confirmation" role="alertdialog" aria-label="确认飞书提醒变更">
      <WarningCircle size={17} weight="fill" aria-hidden="true" />
      <div>
        <strong>{isScope ? "确认扩大提醒范围" : "确认提醒接收目标"}</strong>
        {isScope ? (
          <p>将新增：{eventLabels(pending.addedStates).join("、")}。确认后重新核验当前机器人身份并生成新的授权修订，后续自动发送到固定目标。</p>
        ) : (
          <>
            <p>
              {pending.mode === "create" ? "首次绑定" : "更换目标"}
              {" · "}{pending.target.label}（{pending.target.id}）。确认后会核验并绑定当前机器人身份指纹，同时固定保存目标、模板和授权修订。
            </p>
            <p>
              {pending.mode === "create"
                ? "默认开启：等待回答、等待审阅、验证未通过、恢复受阻；工作完成保持关闭。"
                : "现有提醒事件范围保持不变。"}
            </p>
          </>
        )}
        <span>通知不包含代码、路径、日志、正文，也不能代替任何审批。</span>
        <div className="notification-confirmation-actions">
          <button type="button" onClick={onCancel} disabled={busy}>返回修改</button>
          <button className="is-primary" type="button" onClick={onConfirm} disabled={busy}>
            {busy ? <SpinnerGap className="spin" size={14} aria-hidden="true" /> : null}
            明确确认
          </button>
        </div>
      </div>
    </div>
  );
}

export function LarkNotificationSettings({
  compact = false,
  client = serverNotificationApi,
  onActiveChange,
}) {
  const [state, setState] = useState({
    status: "loading",
    subscription: null,
    deliveries: [],
    error: null,
  });
  const [formMode, setFormMode] = useState(null);
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (signal) => {
    setState((current) => ({ ...current, status: "loading", error: null }));
    try {
      const [settings, deliveries] = await Promise.all([
        client.getSettings({ signal }),
        typeof client.listDeliveries === "function"
          ? client.listDeliveries({ signal })
          : Promise.resolve([]),
      ]);
      if (signal?.aborted) return;
      const subscription = settings.subscriptions[0] ?? null;
      setState({ status: "ready", subscription, deliveries, error: null });
      onActiveChange?.(subscription?.enabled === true);
    } catch (error) {
      if (signal?.aborted) return;
      setState((current) => ({
        ...current,
        status: "error",
        error: error.message,
      }));
    }
  }, [client, onActiveChange]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const replaceSubscription = (subscription) => {
    setState((current) => ({
      ...current,
      status: "ready",
      subscription,
      error: null,
    }));
    onActiveChange?.(subscription?.enabled === true);
  };

  const run = async (operation) => {
    setBusy(true);
    setState((current) => ({ ...current, error: null }));
    try {
      const subscription = await operation();
      replaceSubscription(subscription);
      setPending(null);
      setFormMode(null);
    } catch (error) {
      setState((current) => ({ ...current, error: error.message }));
    } finally {
      setBusy(false);
    }
  };

  const confirmPending = () => {
    if (!pending || busy) return;
    if (pending.kind === "scope") {
      if (pending.requiresReauthorization) {
        void run(() => client.reauthorize(state.subscription.id, {
          authRevision: authorizationRevision(),
          authorizedEventStates: [
            ...new Set([
              ...state.subscription.authorizedEventStates,
              ...pending.addedStates,
            ]),
          ],
          enabledEventStates: pending.nextStates,
          authorizationConfirmed: true,
        }));
      } else {
        void run(() => client.setEnabledEventStates(
          state.subscription.id,
          pending.nextStates,
        ));
      }
      return;
    }
    const input = {
      target: pending.target,
      authRevision: authorizationRevision(),
      authorizedEventStates: pending.mode === "create"
        ? DEFAULT_ATTENTION_EVENT_STATES
        : state.subscription.authorizedEventStates,
      enabledEventStates: state.subscription?.enabledEventStates
        ?? DEFAULT_ATTENTION_EVENT_STATES,
      enabled: true,
      authorizationConfirmed: true,
    };
    void run(() => (
      pending.mode === "create"
        ? client.bind(input)
        : client.reauthorize(state.subscription.id, input)
    ));
  };

  const toggleEvent = (eventState) => {
    const subscription = state.subscription;
    if (!subscription || busy) return;
    const selected = new Set(subscription.enabledEventStates);
    if (selected.has(eventState)) selected.delete(eventState);
    else selected.add(eventState);
    const nextStates = NOTIFICATION_EVENT_OPTIONS
      .map((item) => item.id)
      .filter((item) => selected.has(item));
    const addedStates = notificationScopeExpansion(
      subscription.authorizedEventStates,
      nextStates,
    );
    if (
      notificationEventChangeMode(
        subscription.authorizedEventStates,
        nextStates,
      ) === "reauthorize"
    ) {
      setPending({
        kind: "scope",
        nextStates,
        addedStates,
        requiresReauthorization: true,
      });
      return;
    }
    void run(() => client.setEnabledEventStates(subscription.id, nextStates));
  };

  const subscription = state.subscription;
  return (
    <section className={`lark-notification-settings${compact ? " is-compact" : ""}`}>
      <header>
        <span className="notification-channel-icon"><BellRinging size={16} aria-hidden="true" /></span>
        <div>
          <strong>飞书提醒</strong>
          <small>由 Pi 服务端持久投递</small>
        </div>
        {subscription ? (
          <button
            className={`notification-channel-switch${subscription.enabled ? " is-on" : ""}`}
            type="button"
            role="switch"
            aria-checked={subscription.enabled}
            disabled={busy}
            onClick={() => void run(() => client.setEnabled(
              subscription.id,
              !subscription.enabled,
            ))}
          >
            {subscription.enabled ? "已开启" : "已关闭"}
          </button>
        ) : null}
      </header>

      {state.status === "loading" ? (
        <div className="notification-inline-status" role="status">
          <SpinnerGap className="spin" size={15} aria-hidden="true" />
          正在读取提醒订阅…
        </div>
      ) : null}

      {state.status !== "loading" && !subscription && !formMode ? (
        <div className="notification-unbound-state">
          <p>尚未绑定接收目标。首次绑定需要核对固定目标和事件范围。</p>
          <button type="button" onClick={() => setFormMode("create")}>
            <LinkSimple size={14} aria-hidden="true" />
            设置飞书提醒
          </button>
        </div>
      ) : null}

      {formMode ? (
        <NotificationBindingForm
          mode={formMode}
          initialLabel={subscription?.target.label}
          initialType={subscription?.target.type}
          busy={busy}
          onCancel={() => setFormMode(null)}
          onPreview={(target) => setPending({
            kind: "binding",
            mode: formMode,
            target,
          })}
        />
      ) : null}

      {subscription && !formMode ? (
        <div className="notification-subscription-body">
          <div className="notification-target-row">
            <div>
              <span>固定接收目标</span>
              <strong>{subscription.target.label}</strong>
            </div>
            <button type="button" onClick={() => setFormMode("retarget")} disabled={busy}>
              更换
            </button>
          </div>
          {subscription.botIdentity ? (
            <div className="notification-target-row notification-bot-identity">
              <div>
                <span>固定机器人身份</span>
                <strong>{subscription.botIdentity.label}</strong>
                <small>
                  身份指纹 · {subscription.botIdentity.fingerprint?.slice(7, 19) ?? "未记录"}
                </small>
              </div>
            </div>
          ) : null}
          <div className="notification-authorized-scope">
            <span>已授权事件范围</span>
            <strong>{eventLabels(subscription.authorizedEventStates).join("、")}</strong>
          </div>
          <fieldset disabled={busy || !subscription.enabled}>
            <legend>提醒事件</legend>
            {NOTIFICATION_EVENT_OPTIONS.map((option) => (
              <label key={option.id}>
                <input
                  type="checkbox"
                  checked={subscription.enabledEventStates.includes(option.id)}
                  onChange={() => toggleEvent(option.id)}
                />
                <span>{option.label}</span>
                {option.id === "completed" ? (
                  <small>
                    {subscription.authorizedEventStates.includes(option.id)
                      ? "已授权"
                      : "需重新授权"}
                  </small>
                ) : null}
              </label>
            ))}
          </fieldset>
          <NotificationDeliveryStatus
            delivery={latestNotificationDelivery(state.deliveries)}
          />
          <p className="notification-safety-note">仅发送安全状态摘要；没有代码、路径、日志或正文。</p>
        </div>
      ) : null}

      {pending ? (
        <NotificationConfirmation
          pending={pending}
          busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={confirmPending}
        />
      ) : null}

      {state.error ? (
        <div className="notification-inline-error" role="alert">
          <span>{state.error}</span>
          <button type="button" onClick={() => void load()}>重试</button>
        </div>
      ) : null}
    </section>
  );
}

export function ProjectLoopNotificationControl({ conversation, defaultOpen = false }) {
  const [enabled, setEnabled] = useState(readEnabled);
  const [permission, setPermission] = useState(
    () => browserNotificationApi()?.permission ?? "unsupported",
  );
  const [open, setOpen] = useState(defaultOpen);
  const [larkActive, setLarkActive] = useState(false);
  const rootRef = useRef(null);
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

  useEffect(() => {
    if (!open) return undefined;
    const closeOnOutside = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const supported = permission !== "unsupported";
  const active = enabled && permission === "granted";
  const toggleLocal = async () => {
    const Api = browserNotificationApi();
    if (!Api || permission === "denied") return;
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
  };
  return (
    <div className="project-notification-control" ref={rootRef}>
      <button
        className={`header-meta-pill${active || larkActive ? " is-active" : ""}`}
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        title="管理本机和飞书提醒"
        onClick={() => setOpen((current) => !current)}
      >
        {active || larkActive ? (
          <Bell size={13} weight="fill" aria-hidden="true" />
        ) : (
          <BellSlash size={13} aria-hidden="true" />
        )}
        通知
        <CaretDown size={11} aria-hidden="true" />
      </button>
      {open ? (
        <section className="project-notification-popover" role="dialog" aria-label="通知设置">
          <header className="project-notification-popover-header">
            <div>
              <strong>通知</strong>
              <span>只提醒需要你注意的工作状态</span>
            </div>
            <button type="button" aria-label="关闭通知设置" onClick={() => setOpen(false)}>
              <X size={15} aria-hidden="true" />
            </button>
          </header>
          <section className="local-notification-channel">
            <div className="notification-channel-heading">
              <span className="notification-channel-icon"><Bell size={16} aria-hidden="true" /></span>
              <div>
                <strong>本机通知</strong>
                <small>
                  {!supported
                    ? "当前环境不支持"
                    : permission === "denied"
                      ? "已被系统阻止"
                      : "仅在 Pi Agent 不活跃时显示"}
                </small>
              </div>
              <button
                className={`notification-channel-switch${active ? " is-on" : ""}`}
                type="button"
                role="switch"
                aria-checked={active}
                disabled={!supported || permission === "denied"}
                onClick={() => void toggleLocal()}
              >
                {active ? "已开启" : "已关闭"}
              </button>
            </div>
          </section>
          <LarkNotificationSettings compact onActiveChange={setLarkActive} />
        </section>
      ) : null}
    </div>
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
