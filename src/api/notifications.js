async function requestJson(path, { method = "GET", body, signal } = {}) {
  const response = await fetch(path, {
    method,
    signal,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.error?.message || "提醒设置请求失败");
    error.name = "NotificationApiError";
    error.code = payload?.error?.code || "NOTIFICATION_REQUEST_FAILED";
    error.status = response.status;
    throw error;
  }
  return payload;
}

function normalizeSubscription(value) {
  if (!value || typeof value !== "object") return null;
  const botIdentity = value.botIdentity ?? value.bot_identity;
  return {
    id: value.id,
    channel: value.channel ?? "lark",
    enabled: value.enabled === true,
    target: {
      type: value.target?.type ?? "chat_id",
      label: value.target?.label ?? "飞书接收目标",
    },
    template: value.template ?? null,
    authRevision: value.authRevision ?? value.auth_revision ?? null,
    botIdentity: botIdentity && typeof botIdentity === "object"
      ? {
          fingerprint: botIdentity.fingerprint ?? null,
          label: botIdentity.label ?? "已连接的飞书机器人",
        }
      : null,
    authorizedEventStates: value.authorizedEventStates
      ?? value.authorized_event_states
      ?? [],
    enabledEventStates: value.enabledEventStates
      ?? value.enabled_event_states
      ?? [],
    createdAt: value.createdAt ?? value.created_at ?? null,
    updatedAt: value.updatedAt ?? value.updated_at ?? null,
  };
}

function normalizeDelivery(value) {
  if (!value || typeof value !== "object") return null;
  return {
    id: value.id,
    subscriptionId: value.subscriptionId ?? value.subscription_id ?? null,
    state: value.state ?? null,
    status: value.status ?? null,
    attemptCount: value.attemptCount ?? value.attempt_count ?? 0,
    lastErrorCode: value.lastErrorCode ?? value.last_error_code ?? null,
    receipt: value.receipt ?? null,
    createdAt: value.createdAt ?? value.created_at ?? null,
    updatedAt: value.updatedAt ?? value.updated_at ?? null,
  };
}

function subscriptionFromPayload(payload) {
  return normalizeSubscription(payload?.subscription);
}

export const notificationApi = Object.freeze({
  async list(options = {}) {
    return requestJson("/api/v1/notification-subscriptions", options);
  },
  async create(input, options = {}) {
    return requestJson("/api/v1/notification-subscriptions", {
      ...options,
      method: "POST",
      body: {
        schema_version: 1,
        target: input.target,
        auth_revision: input.authRevision,
        authorized_event_states: input.authorizedEventStates,
        enabled_event_states: input.enabledEventStates,
        enabled: input.enabled,
        authorization_confirmed: input.authorizationConfirmed === true,
      },
    });
  },
  async update(subscriptionId, input, options = {}) {
    return requestJson(`/api/v1/notification-subscriptions/${encodeURIComponent(subscriptionId)}`, {
      ...options,
      method: "PATCH",
      body: { schema_version: 1, ...input },
    });
  },
  async deliveries(options = {}) {
    return requestJson("/api/v1/notification-subscriptions/deliveries", options);
  },
  async getSettings(options = {}) {
    const payload = await requestJson("/api/v1/notification-subscriptions", options);
    return {
      defaultEventStates: payload.default_event_states ?? [],
      optionalEventStates: payload.optional_event_states ?? [],
      subscriptions: (payload.subscriptions ?? [])
        .map(normalizeSubscription)
        .filter(Boolean),
    };
  },
  async bind(input, options = {}) {
    const payload = await requestJson("/api/v1/notification-subscriptions", {
      ...options,
      method: "POST",
      body: {
        schema_version: 1,
        target: input.target,
        auth_revision: input.authRevision,
        authorized_event_states: input.authorizedEventStates,
        enabled_event_states: input.enabledEventStates,
        enabled: input.enabled !== false,
        authorization_confirmed: input.authorizationConfirmed === true,
      },
    });
    return subscriptionFromPayload(payload);
  },
  async setEnabled(subscriptionId, enabled, options = {}) {
    const payload = await requestJson(
      `/api/v1/notification-subscriptions/${encodeURIComponent(subscriptionId)}`,
      {
        ...options,
        method: "PATCH",
        body: { schema_version: 1, enabled },
      },
    );
    return subscriptionFromPayload(payload);
  },
  async setEnabledEventStates(subscriptionId, enabledEventStates, options = {}) {
    const payload = await requestJson(
      `/api/v1/notification-subscriptions/${encodeURIComponent(subscriptionId)}`,
      {
        ...options,
        method: "PATCH",
        body: {
          schema_version: 1,
          enabled_event_states: enabledEventStates,
        },
      },
    );
    return subscriptionFromPayload(payload);
  },
  async reauthorize(subscriptionId, input, options = {}) {
    const payload = await requestJson(
      `/api/v1/notification-subscriptions/${encodeURIComponent(subscriptionId)}`,
      {
        ...options,
        method: "PATCH",
        body: {
          schema_version: 1,
          target: input.target,
          auth_revision: input.authRevision,
          authorized_event_states: input.authorizedEventStates,
          enabled_event_states: input.enabledEventStates,
          authorization_confirmed: input.authorizationConfirmed === true,
        },
      },
    );
    return subscriptionFromPayload(payload);
  },
  async listDeliveries({ status, signal } = {}) {
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    const payload = await requestJson(
      `/api/v1/notification-subscriptions/deliveries${query}`,
      { signal },
    );
    return (payload.deliveries ?? []).map(normalizeDelivery).filter(Boolean);
  },
});
