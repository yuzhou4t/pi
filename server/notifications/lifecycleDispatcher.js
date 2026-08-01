import { isNotificationOrigin } from "./contract.js";

export function createLifecycleNotificationDispatcher({ notificationService } = {}) {
  if (!notificationService || typeof notificationService.dispatchLifecycle !== "function") {
    throw new TypeError("notificationService.dispatchLifecycle is required");
  }

  async function dispatch({ conversationId, projectLabel, event } = {}) {
    if (!event || event.type !== "loop.lifecycle") {
      return { status: "ignored", reason: "not_lifecycle_event", results: [] };
    }
    const origin = event.origin ?? event.data?.origin ?? event.data?.source;
    if (isNotificationOrigin(origin)) {
      return { status: "suppressed", reason: "notification_origin", results: [] };
    }
    return notificationService.dispatchLifecycle({
      conversationId,
      projectLabel,
      sourceEventSeq: event.data?.sourceEventSeq,
      state: event.data?.state,
      origin,
    });
  }

  return Object.freeze({ dispatch });
}
