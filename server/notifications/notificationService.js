import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  ATTENTION_EVENT_STATES,
  DEFAULT_RETURN_ENTRY_BASE_URL,
  DEFAULT_TEMPLATE,
  NOTIFICATION_SCHEMA_VERSION,
  assertOnlyKeys,
  buildReturnEntry,
  buildSafeMessage,
  isNotificationOrigin,
  normalizeBotIdentity,
  normalizeEventState,
  normalizeEventStates,
  normalizeIdentifier,
  normalizeSafeLabel,
  normalizeTarget,
  normalizeTemplate,
  normalizeReturnEntryBaseUrl,
  notificationError,
  sanitizeTransportReceipt,
} from "./contract.js";
import { createDisabledLarkTransport } from "./larkTransport.js";
import { createNotificationStore } from "./notificationStore.js";

const DEFAULT_RETRY_POLICY = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
});

function iso(now) {
  return now().toISOString();
}

function normalizeAuthRevision(value) {
  return normalizeIdentifier(value, "提醒授权修订");
}

function normalizeRetryPolicy(value = {}) {
  const result = { ...DEFAULT_RETRY_POLICY, ...value };
  for (const key of ["maxAttempts", "baseDelayMs", "maxDelayMs"]) {
    if (!Number.isSafeInteger(result[key]) || result[key] < 1) {
      throw new TypeError(`retryPolicy.${key} must be a positive integer`);
    }
  }
  return result;
}

function normalizeSourceEventSeq(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw notificationError("NOTIFICATION_INPUT_INVALID", "来源事件序号无效");
  }
  return value;
}

function sameBotFingerprint(left, right) {
  try {
    const leftBytes = Buffer.from(
      normalizeBotIdentity(left).fingerprint,
      "utf8",
    );
    const rightBytes = Buffer.from(
      normalizeBotIdentity(right).fingerprint,
      "utf8",
    );
    return leftBytes.length === rightBytes.length
      && timingSafeEqual(leftBytes, rightBytes);
  } catch {
    return false;
  }
}

function publicSubscription(subscription) {
  return {
    id: subscription.id,
    channel: subscription.channel,
    enabled: subscription.enabled,
    target: {
      type: subscription.target.type,
      label: subscription.target.label,
    },
    template: structuredClone(subscription.template),
    authRevision: subscription.authRevision,
    botIdentity: subscription.botIdentity
      ? structuredClone(subscription.botIdentity)
      : null,
    authorizedEventStates: [...subscription.authorizedEventStates],
    enabledEventStates: [...subscription.enabledEventStates],
    createdAt: subscription.createdAt,
    updatedAt: subscription.updatedAt,
  };
}

function publicJob(job) {
  return {
    id: job.id,
    idempotencyKey: job.idempotencyKey,
    subscriptionId: job.subscriptionId,
    conversationId: job.conversationId,
    sourceEventSeq: job.sourceEventSeq,
    state: job.state,
    projectLabel: job.projectLabel,
    returnEntry: job.binding?.returnEntry ?? null,
    status: job.status,
    attemptCount: job.attemptCount,
    nextAttemptAt: job.nextAttemptAt,
    lastErrorCode: job.lastErrorCode,
    receipt: job.receipt ? structuredClone(job.receipt) : null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function ledgerRecord({ id, at, type, job = null, subscriptionId = null, reason = null }) {
  return {
    schemaVersion: NOTIFICATION_SCHEMA_VERSION,
    id,
    at,
    type,
    jobId: job?.id ?? null,
    subscriptionId: job?.subscriptionId ?? subscriptionId,
    idempotencyKey: job?.idempotencyKey ?? null,
    state: job?.state ?? null,
    attempt: job?.attemptCount ?? null,
    status: job?.status ?? null,
    reason,
  };
}

export function createNotificationService({
  storageRoot,
  transport = createDisabledLarkTransport(),
  now = () => new Date(),
  idFactory = () => randomUUID(),
  retryPolicy,
  returnEntryBaseUrl = DEFAULT_RETURN_ENTRY_BASE_URL,
} = {}) {
  if (
    !transport
    || typeof transport.resolveIdentity !== "function"
    || typeof transport.send !== "function"
  ) {
    throw new TypeError("transport.resolveIdentity and transport.send are required");
  }
  const policy = normalizeRetryPolicy(retryPolicy);
  const controlledReturnEntryBaseUrl = normalizeReturnEntryBaseUrl(
    returnEntryBaseUrl,
  );
  const store = createNotificationStore({ storageRoot });
  let recoveredInterruptedJobs = false;

  async function resolveCurrentBotIdentity() {
    try {
      return normalizeBotIdentity(await transport.resolveIdentity());
    } catch (error) {
      if (error?.code === "LARK_BOT_IDENTITY_INVALID") throw error;
      throw notificationError(
        "LARK_BOT_IDENTITY_UNAVAILABLE",
        "无法确认当前飞书机器人身份",
        { retriable: false },
      );
    }
  }

  async function createSubscription(input) {
    assertOnlyKeys(input, [
      "id",
      "target",
      "template",
      "authRevision",
      "authorizedEventStates",
      "enabledEventStates",
      "enabled",
      "authorizationConfirmed",
    ], "提醒订阅");
    if (input.authorizationConfirmed !== true) {
      throw notificationError(
        "NOTIFICATION_REAUTH_REQUIRED",
        "绑定飞书机器人身份和接收目标需要明确确认",
      );
    }
    const id = input.id === undefined
      ? normalizeIdentifier(idFactory(), "提醒订阅标识")
      : normalizeIdentifier(input.id, "提醒订阅标识");
    if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
      throw notificationError("NOTIFICATION_INPUT_INVALID", "提醒开关无效");
    }
    const target = normalizeTarget(input.target);
    const template = normalizeTemplate(input.template ?? DEFAULT_TEMPLATE);
    const authRevision = normalizeAuthRevision(input.authRevision);
    const authorizedEventStates = normalizeEventStates(
      input.authorizedEventStates,
      { fallback: ATTENTION_EVENT_STATES, allowEmpty: false },
    );
    if (
      authorizedEventStates.length !== ATTENTION_EVENT_STATES.length
      || ATTENTION_EVENT_STATES.some(
        (eventState) => !authorizedEventStates.includes(eventState),
      )
    ) {
      throw notificationError(
        "NOTIFICATION_INITIAL_SCOPE_INVALID",
        "首次绑定只能授权默认的四类注意事件",
      );
    }
    const enabledEventStates = normalizeEventStates(input.enabledEventStates, {
      fallback: ATTENTION_EVENT_STATES,
    });
    if (enabledEventStates.some((state) => !authorizedEventStates.includes(state))) {
      throw notificationError(
        "NOTIFICATION_REAUTH_REQUIRED",
        "启用的提醒事件超出当前授权范围",
      );
    }
    const botIdentity = await resolveCurrentBotIdentity();
    const at = iso(now);
    const subscription = {
      schemaVersion: NOTIFICATION_SCHEMA_VERSION,
      id,
      channel: "lark",
      enabled: input.enabled !== false,
      target,
      template,
      authRevision,
      botIdentity,
      authorizedEventStates,
      enabledEventStates,
      createdAt: at,
      updatedAt: at,
    };
    const created = await store.transaction((state) => {
      if (state.subscriptions.some((item) => item.id === id)) {
        throw notificationError("NOTIFICATION_SUBSCRIPTION_EXISTS", "提醒订阅已经存在");
      }
      state.subscriptions.push(subscription);
      return subscription;
    });
    await store.appendLedger(ledgerRecord({
      id: idFactory(),
      at,
      type: "subscription.created",
      subscriptionId: id,
    }));
    return publicSubscription(created);
  }

  async function listSubscriptions() {
    const state = await store.snapshot();
    return state.subscriptions.map(publicSubscription);
  }

  async function getSubscription(subscriptionId) {
    const id = normalizeIdentifier(subscriptionId, "提醒订阅标识");
    const state = await store.snapshot();
    const subscription = state.subscriptions.find((item) => item.id === id);
    if (!subscription) {
      throw notificationError("NOTIFICATION_SUBSCRIPTION_NOT_FOUND", "提醒订阅不存在");
    }
    return publicSubscription(subscription);
  }

  async function setSubscriptionEnabled(subscriptionId, enabled) {
    if (typeof enabled !== "boolean") {
      throw notificationError("NOTIFICATION_INPUT_INVALID", "提醒开关无效");
    }
    const id = normalizeIdentifier(subscriptionId, "提醒订阅标识");
    const at = iso(now);
    const updated = await store.transaction((state) => {
      const subscription = state.subscriptions.find((item) => item.id === id);
      if (!subscription) {
        throw notificationError("NOTIFICATION_SUBSCRIPTION_NOT_FOUND", "提醒订阅不存在");
      }
      subscription.enabled = enabled;
      subscription.updatedAt = at;
      return subscription;
    });
    await store.appendLedger(ledgerRecord({
      id: idFactory(),
      at,
      type: enabled ? "subscription.enabled" : "subscription.disabled",
      subscriptionId: id,
    }));
    return publicSubscription(updated);
  }

  async function setEnabledEventStates(subscriptionId, eventStates) {
    const id = normalizeIdentifier(subscriptionId, "提醒订阅标识");
    const normalized = normalizeEventStates(eventStates);
    const at = iso(now);
    const updated = await store.transaction((state) => {
      const subscription = state.subscriptions.find((item) => item.id === id);
      if (!subscription) {
        throw notificationError("NOTIFICATION_SUBSCRIPTION_NOT_FOUND", "提醒订阅不存在");
      }
      if (normalized.some((item) => !subscription.authorizedEventStates.includes(item))) {
        throw notificationError(
          "NOTIFICATION_REAUTH_REQUIRED",
          "提醒事件超出当前授权范围，需要重新授权",
        );
      }
      subscription.enabledEventStates = normalized;
      subscription.updatedAt = at;
      return subscription;
    });
    await store.appendLedger(ledgerRecord({
      id: idFactory(),
      at,
      type: "subscription.events_updated",
      subscriptionId: id,
    }));
    return publicSubscription(updated);
  }

  async function reauthorizeSubscription(subscriptionId, input) {
    assertOnlyKeys(input, [
      "target",
      "template",
      "authRevision",
      "authorizedEventStates",
      "enabledEventStates",
      "authorizationConfirmed",
    ], "提醒重新授权");
    if (input.authorizationConfirmed !== true) {
      throw notificationError(
        "NOTIFICATION_REAUTH_REQUIRED",
        "修改提醒目标或授权范围需要明确确认",
      );
    }
    const id = normalizeIdentifier(subscriptionId, "提醒订阅标识");
    const target = input.target === undefined ? null : normalizeTarget(input.target);
    const template = input.template === undefined
      ? null
      : normalizeTemplate(input.template);
    const authRevision = normalizeAuthRevision(input.authRevision);
    const authorizedEventStates = input.authorizedEventStates === undefined
      ? null
      : normalizeEventStates(input.authorizedEventStates, {
        allowEmpty: false,
      });
    const enabledEventStates = input.enabledEventStates === undefined
      ? null
      : normalizeEventStates(input.enabledEventStates);
    const botIdentity = await resolveCurrentBotIdentity();
    const at = iso(now);
    const updated = await store.transaction((state) => {
      const subscription = state.subscriptions.find((item) => item.id === id);
      if (!subscription) {
        throw notificationError("NOTIFICATION_SUBSCRIPTION_NOT_FOUND", "提醒订阅不存在");
      }
      if (subscription.authRevision === authRevision) {
        throw notificationError(
          "NOTIFICATION_AUTH_REVISION_REUSED",
          "重新授权必须使用新的授权修订",
        );
      }
      const nextAuthorizedEventStates = authorizedEventStates
        ?? subscription.authorizedEventStates;
      const nextEnabledEventStates = enabledEventStates
        ?? subscription.enabledEventStates;
      if (
        nextEnabledEventStates.some(
          (eventState) => !nextAuthorizedEventStates.includes(eventState),
        )
      ) {
        throw notificationError(
          "NOTIFICATION_REAUTH_REQUIRED",
          "启用的提醒事件超出新授权范围",
        );
      }
      subscription.target = target ?? subscription.target;
      subscription.template = template ?? subscription.template;
      subscription.authRevision = authRevision;
      subscription.botIdentity = botIdentity;
      subscription.authorizedEventStates = nextAuthorizedEventStates;
      subscription.enabledEventStates = nextEnabledEventStates;
      subscription.updatedAt = at;
      return subscription;
    });
    await store.appendLedger(ledgerRecord({
      id: idFactory(),
      at,
      type: "subscription.reauthorized",
      subscriptionId: id,
    }));
    return publicSubscription(updated);
  }

  async function enqueueForSubscription(subscriptionId, input) {
    assertOnlyKeys(input, [
      "conversationId",
      "sourceEventSeq",
      "state",
      "projectLabel",
      "origin",
    ], "提醒事件");
    const id = normalizeIdentifier(subscriptionId, "提醒订阅标识");
    const conversationId = normalizeIdentifier(input.conversationId, "工作会话标识");
    const sourceEventSeq = normalizeSourceEventSeq(input.sourceEventSeq);
    const eventState = normalizeEventState(input.state);
    const projectLabel = normalizeSafeLabel(input.projectLabel);
    const at = iso(now);
    if (isNotificationOrigin(input.origin)) {
      await store.appendLedger(ledgerRecord({
        id: idFactory(),
        at,
        type: "notification.suppressed",
        subscriptionId: id,
        reason: "notification_origin",
      }));
      return { status: "suppressed", reason: "notification_origin" };
    }
    const result = await store.transaction((state) => {
      const subscription = state.subscriptions.find((item) => item.id === id);
      if (!subscription) {
        throw notificationError("NOTIFICATION_SUBSCRIPTION_NOT_FOUND", "提醒订阅不存在");
      }
      if (!subscription.enabled) {
        return { status: "suppressed", reason: "subscription_disabled" };
      }
      if (!subscription.enabledEventStates.includes(eventState)) {
        return { status: "suppressed", reason: "event_disabled" };
      }
      const idempotencyKey = `lark:${id}:${conversationId}:${sourceEventSeq}`;
      const existing = state.outbox.find((job) => job.idempotencyKey === idempotencyKey);
      if (existing) return { status: "duplicate", job: existing };
      const job = {
        schemaVersion: NOTIFICATION_SCHEMA_VERSION,
        id: normalizeIdentifier(idFactory(), "提醒任务标识"),
        idempotencyKey,
        subscriptionId: id,
        conversationId,
        sourceEventSeq,
        state: eventState,
        projectLabel,
        binding: {
          target: structuredClone(subscription.target),
          template: structuredClone(subscription.template),
          authRevision: subscription.authRevision,
          botIdentity: subscription.botIdentity
            ? structuredClone(subscription.botIdentity)
            : null,
          returnEntry: buildReturnEntry({
            baseUrl: controlledReturnEntryBaseUrl,
            conversationId,
          }),
        },
        status: "pending",
        attemptCount: 0,
        nextAttemptAt: at,
        lastErrorCode: null,
        receipt: null,
        createdAt: at,
        updatedAt: at,
      };
      state.outbox.push(job);
      return { status: "enqueued", job };
    });
    await store.appendLedger(ledgerRecord({
      id: idFactory(),
      at,
      type: result.status === "enqueued"
        ? "notification.enqueued"
        : result.status === "duplicate"
          ? "notification.duplicate"
          : "notification.suppressed",
      job: result.job,
      subscriptionId: id,
      reason: result.reason ?? null,
    }));
    return result.job
      ? { status: result.status, job: publicJob(result.job) }
      : result;
  }

  async function dispatchLifecycle(input) {
    assertOnlyKeys(input, [
      "conversationId",
      "sourceEventSeq",
      "state",
      "projectLabel",
      "origin",
    ], "生命周期提醒");
    if (isNotificationOrigin(input.origin)) {
      const at = iso(now);
      await store.appendLedger(ledgerRecord({
        id: idFactory(),
        at,
        type: "notification.suppressed",
        reason: "notification_origin",
      }));
      return { status: "suppressed", reason: "notification_origin", results: [] };
    }
    const safeInput = {
      conversationId: normalizeIdentifier(input.conversationId, "工作会话标识"),
      sourceEventSeq: normalizeSourceEventSeq(input.sourceEventSeq),
      state: normalizeEventState(input.state),
      projectLabel: normalizeSafeLabel(input.projectLabel),
      origin: input.origin,
    };
    const subscriptions = await listSubscriptions();
    const results = [];
    for (const subscription of subscriptions) {
      results.push(await enqueueForSubscription(subscription.id, safeInput));
    }
    return {
      status: results.some((item) => item.status === "enqueued")
        ? "enqueued"
        : "suppressed",
      results,
    };
  }

  async function claimNextDueJob() {
    const timestamp = now().getTime();
    const at = new Date(timestamp).toISOString();
    return store.transaction((state) => {
      if (!recoveredInterruptedJobs) {
        for (const job of state.outbox) {
          if (job.status === "sending") {
            job.status = "retry_wait";
            job.nextAttemptAt = at;
            job.updatedAt = at;
            job.lastErrorCode = "NOTIFICATION_SEND_INTERRUPTED";
          }
        }
        recoveredInterruptedJobs = true;
      }
      const job = state.outbox.find((item) => (
        ["pending", "retry_wait"].includes(item.status)
        && new Date(item.nextAttemptAt).getTime() <= timestamp
      ));
      if (!job) return null;
      job.status = "sending";
      job.attemptCount += 1;
      job.updatedAt = at;
      return job;
    });
  }

  async function settleSuccess(jobId, result) {
    const at = iso(now);
    const job = await store.transaction((state) => {
      const current = state.outbox.find((item) => item.id === jobId);
      if (!current || current.status !== "sending") return null;
      current.status = "sent";
      current.nextAttemptAt = null;
      current.lastErrorCode = null;
      current.receipt = sanitizeTransportReceipt(result, at);
      current.updatedAt = at;
      return current;
    });
    if (job) {
      await store.appendLedger(ledgerRecord({
        id: idFactory(),
        at,
        type: "notification.sent",
        job,
      }));
    }
    return job;
  }

  async function settleFailure(jobId, error) {
    const atDate = now();
    const at = atDate.toISOString();
    const code = typeof error?.code === "string"
      && /^[A-Z0-9_:-]{1,100}$/u.test(error.code)
      ? error.code
      : "NOTIFICATION_TRANSPORT_FAILED";
    const retriable = error?.retriable === true;
    const job = await store.transaction((state) => {
      const current = state.outbox.find((item) => item.id === jobId);
      if (!current || current.status !== "sending") return null;
      const canRetry = retriable && current.attemptCount < policy.maxAttempts;
      current.status = canRetry ? "retry_wait" : "failed";
      current.lastErrorCode = code;
      current.nextAttemptAt = canRetry
        ? new Date(atDate.getTime() + Math.min(
          policy.maxDelayMs,
          policy.baseDelayMs * (2 ** (current.attemptCount - 1)),
        )).toISOString()
        : null;
      current.updatedAt = at;
      return current;
    });
    if (job) {
      await store.appendLedger(ledgerRecord({
        id: idFactory(),
        at,
        type: job.status === "failed"
          ? "notification.failed"
          : "notification.retry_scheduled",
        job,
        reason: code,
      }));
    }
    return job;
  }

  async function processDue({ limit = 20 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw notificationError("NOTIFICATION_INPUT_INVALID", "提醒处理数量无效");
    }
    const processed = [];
    for (let index = 0; index < limit; index += 1) {
      const job = await claimNextDueJob();
      if (!job) break;
      const startedAt = iso(now);
      await store.appendLedger(ledgerRecord({
        id: idFactory(),
        at: startedAt,
        type: "notification.attempt_started",
        job,
      }));
      try {
        const currentBotIdentity = await resolveCurrentBotIdentity();
        if (!sameBotFingerprint(currentBotIdentity, job.binding.botIdentity)) {
          throw notificationError(
            "LARK_BOT_IDENTITY_MISMATCH",
            "当前飞书机器人身份与提醒授权不一致",
            { retriable: false },
          );
        }
        const result = await transport.send(Object.freeze({
          channel: "lark",
          target: Object.freeze(structuredClone(job.binding.target)),
          template: Object.freeze(structuredClone(job.binding.template)),
          authRevision: job.binding.authRevision,
          botIdentity: Object.freeze(structuredClone(job.binding.botIdentity)),
          idempotencyKey: job.idempotencyKey,
          message: buildSafeMessage({
            state: job.state,
            projectLabel: job.projectLabel,
            returnEntry: job.binding.returnEntry,
          }),
        }));
        const settled = await settleSuccess(job.id, result);
        if (settled) processed.push(publicJob(settled));
      } catch (error) {
        const settled = await settleFailure(job.id, error);
        if (settled) processed.push(publicJob(settled));
      }
    }
    return processed;
  }

  async function listOutbox({ status } = {}) {
    if (
      status !== undefined
      && !["pending", "sending", "retry_wait", "sent", "failed"].includes(status)
    ) {
      throw notificationError("NOTIFICATION_INPUT_INVALID", "提醒投递状态无效");
    }
    const state = await store.snapshot();
    return state.outbox
      .filter((job) => status === undefined || job.status === status)
      .map(publicJob);
  }

  async function readLedger() {
    return store.readLedger();
  }

  return Object.freeze({
    createSubscription,
    listSubscriptions,
    getSubscription,
    setSubscriptionEnabled,
    setEnabledEventStates,
    reauthorizeSubscription,
    enqueueForSubscription,
    dispatchLifecycle,
    processDue,
    listOutbox,
    readLedger,
    paths: store.paths,
  });
}
