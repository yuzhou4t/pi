import {
  ATTENTION_EVENT_STATES,
  DEFAULT_TEMPLATE,
  NotificationError,
} from "./contract.js";

const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

function segment(value) {
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    decoded = "";
  }
  if (!SEGMENT_PATTERN.test(decoded)) {
    const error = new NotificationError(
      "NOTIFICATION_INPUT_INVALID",
      "提醒订阅标识无效",
    );
    throw error;
  }
  return decoded;
}

function requireSchema(payload) {
  if (!payload || payload.schema_version !== 1) {
    throw new NotificationError(
      "NOTIFICATION_INPUT_INVALID",
      "提醒请求版本无效",
    );
  }
  return payload;
}

export function createNotificationHttpApi({
  notificationService,
  readJson,
  sendJson,
  requireMutationOrigin,
} = {}) {
  if (!notificationService) throw new TypeError("notificationService is required");

  async function handle(request, response, url, origin) {
    if (
      request.method === "GET"
      && url.pathname === "/api/v1/notification-subscriptions"
    ) {
      sendJson(response, 200, {
        schema_version: 1,
        default_event_states: [...ATTENTION_EVENT_STATES],
        optional_event_states: ["completed"],
        subscriptions: await notificationService.listSubscriptions(),
      }, origin);
      return true;
    }

    if (
      request.method === "POST"
      && url.pathname === "/api/v1/notification-subscriptions"
    ) {
      requireMutationOrigin(origin);
      const payload = requireSchema(await readJson(request));
      if (payload.authorization_confirmed !== true) {
        throw new NotificationError(
          "NOTIFICATION_REAUTH_REQUIRED",
          "绑定飞书机器人身份和接收目标需要明确确认",
        );
      }
      const subscription = await notificationService.createSubscription({
        target: payload.target,
        template: payload.template ?? DEFAULT_TEMPLATE,
        authRevision: payload.auth_revision,
        authorizedEventStates: payload.authorized_event_states
          ?? ATTENTION_EVENT_STATES,
        enabledEventStates: payload.enabled_event_states
          ?? ATTENTION_EVENT_STATES,
        enabled: payload.enabled,
        authorizationConfirmed: true,
      });
      sendJson(response, 201, { schema_version: 1, subscription }, origin);
      return true;
    }

    if (
      request.method === "GET"
      && url.pathname === "/api/v1/notification-subscriptions/deliveries"
    ) {
      sendJson(response, 200, {
        schema_version: 1,
        deliveries: await notificationService.listOutbox({
          status: url.searchParams.get("status") || undefined,
        }),
      }, origin);
      return true;
    }

    const subscriptionMatch = url.pathname.match(
      /^\/api\/v1\/notification-subscriptions\/([^/]+)$/u,
    );
    if (subscriptionMatch && request.method === "PATCH") {
      requireMutationOrigin(origin);
      const payload = requireSchema(await readJson(request));
      const subscriptionId = segment(subscriptionMatch[1]);
      let subscription;
      const reauthorize = payload.target !== undefined
        || payload.auth_revision !== undefined
        || payload.authorized_event_states !== undefined
        || payload.template !== undefined;
      if (reauthorize) {
        subscription = await notificationService.reauthorizeSubscription(
          subscriptionId,
          {
            target: payload.target,
            template: payload.template,
            authRevision: payload.auth_revision,
            authorizedEventStates: payload.authorized_event_states,
            enabledEventStates: payload.enabled_event_states,
            authorizationConfirmed: payload.authorization_confirmed === true,
          },
        );
      } else {
        if (payload.enabled_event_states !== undefined) {
          subscription = await notificationService.setEnabledEventStates(
            subscriptionId,
            payload.enabled_event_states,
          );
        }
        if (payload.enabled !== undefined) {
          subscription = await notificationService.setSubscriptionEnabled(
            subscriptionId,
            payload.enabled,
          );
        }
        subscription ??= await notificationService.getSubscription(subscriptionId);
      }
      sendJson(response, 200, { schema_version: 1, subscription }, origin);
      return true;
    }

    return false;
  }

  return Object.freeze({ handle });
}

function notificationStatus(error) {
  if (error?.code === "NOTIFICATION_SUBSCRIPTION_NOT_FOUND") return 404;
  if (
    error?.code === "NOTIFICATION_REAUTH_REQUIRED"
    || error?.code === "NOTIFICATION_AUTH_REVISION_REUSED"
    || error?.code === "NOTIFICATION_SUBSCRIPTION_EXISTS"
  ) return 409;
  if (
    typeof error?.code === "string"
    && (
      error.code.includes("INPUT")
      || error.code.includes("INVALID")
      || error.code.includes("UNSAFE")
      || error.code.includes("UNSUPPORTED")
    )
  ) return 400;
  return 500;
}

export function sendNotificationHttpError(response, error, origin, sendJson) {
  sendJson(response, notificationStatus(error), {
    error: {
      code: error instanceof NotificationError
        ? error.code
        : "NOTIFICATION_INTERNAL_ERROR",
      message: error instanceof NotificationError
        ? error.message
        : "提醒操作失败",
      retryable: error?.retriable === true,
    },
  }, origin);
}
