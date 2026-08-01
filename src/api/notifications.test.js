import assert from "node:assert/strict";
import test from "node:test";
import { notificationApi } from "./notifications.js";

function response(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async json() {
      return payload;
    },
  };
}

async function withFetch(mock, run) {
  const previous = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    return await run();
  } finally {
    globalThis.fetch = previous;
  }
}

const serverSubscription = {
  id: "subscription-1",
  channel: "lark",
  enabled: true,
  target: { type: "chat_id", label: "个人提醒" },
  authRevision: "auth-1",
  botIdentity: {
    fingerprint: `sha256:${"1".repeat(64)}`,
    label: "Pi Agent 提醒机器人",
  },
  authorizedEventStates: [
    "awaiting_user",
    "awaiting_review",
    "verification_failed",
    "recovery_blocked",
  ],
  enabledEventStates: [
    "awaiting_user",
    "awaiting_review",
    "verification_failed",
    "recovery_blocked",
  ],
};

test("notification settings map default attention states with completed optional", async () => {
  await withFetch(async (url, init = {}) => {
    assert.equal(url, "/api/v1/notification-subscriptions");
    assert.equal(init.method, "GET");
    return response({
      schema_version: 1,
      default_event_states: [
        "awaiting_user",
        "awaiting_review",
        "verification_failed",
        "recovery_blocked",
      ],
      optional_event_states: ["completed"],
      subscriptions: [serverSubscription],
    });
  }, async () => {
    const settings = await notificationApi.getSettings();
    assert.deepEqual(settings.defaultEventStates, [
      "awaiting_user",
      "awaiting_review",
      "verification_failed",
      "recovery_blocked",
    ]);
    assert.deepEqual(settings.optionalEventStates, ["completed"]);
    assert.deepEqual(settings.subscriptions[0].botIdentity, {
      fingerprint: `sha256:${"1".repeat(64)}`,
      label: "Pi Agent 提醒机器人",
    });
    assert.deepEqual(settings.subscriptions[0].enabledEventStates, [
      "awaiting_user",
      "awaiting_review",
      "verification_failed",
      "recovery_blocked",
    ]);
  });
});

test("first binding carries an explicit confirmation and never sends a message", async () => {
  const calls = [];
  await withFetch(async (url, init = {}) => {
    calls.push({ url, init });
    return response({ schema_version: 1, subscription: serverSubscription }, { status: 201 });
  }, async () => {
    const subscription = await notificationApi.bind({
      target: { type: "chat_id", id: "oc_target", label: "个人提醒" },
      authRevision: "ui-auth-1",
      authorizedEventStates: serverSubscription.authorizedEventStates,
      enabledEventStates: serverSubscription.enabledEventStates,
      authorizationConfirmed: true,
    });
    assert.equal(subscription.target.label, "个人提醒");
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/v1/notification-subscriptions");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    schema_version: 1,
    target: { type: "chat_id", id: "oc_target", label: "个人提醒" },
    auth_revision: "ui-auth-1",
    authorized_event_states: serverSubscription.authorizedEventStates,
    enabled_event_states: serverSubscription.enabledEventStates,
    enabled: true,
    authorization_confirmed: true,
  });
  assert.doesNotMatch(calls[0].url, /deliver|send|message/u);
});

test("target changes use reauthorization while event toggles use the narrow endpoint", async () => {
  const calls = [];
  await withFetch(async (url, init = {}) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return response({ schema_version: 1, subscription: serverSubscription });
  }, async () => {
    await notificationApi.setEnabledEventStates("subscription/1", [
      "awaiting_user",
      "completed",
    ]);
    await notificationApi.reauthorize("subscription/1", {
      target: { type: "chat_id", id: "oc_new", label: "新目标" },
      authRevision: "ui-auth-2",
      authorizedEventStates: serverSubscription.authorizedEventStates,
      enabledEventStates: ["awaiting_user", "completed"],
      authorizationConfirmed: true,
    });
    await notificationApi.reauthorize("subscription/1", {
      authRevision: "ui-auth-3",
      authorizedEventStates: [
        ...serverSubscription.authorizedEventStates,
        "completed",
      ],
      enabledEventStates: ["awaiting_user", "completed"],
      authorizationConfirmed: true,
    });
  });
  assert.equal(
    calls[0].url,
    "/api/v1/notification-subscriptions/subscription%2F1",
  );
  assert.deepEqual(calls[0].body, {
    schema_version: 1,
    enabled_event_states: ["awaiting_user", "completed"],
  });
  assert.equal(calls[1].body.authorization_confirmed, true);
  assert.deepEqual(calls[1].body.target, {
    type: "chat_id",
    id: "oc_new",
    label: "新目标",
  });
  assert.equal("target" in calls[2].body, false);
  assert.equal(calls[2].body.authorization_confirmed, true);
  assert.equal(calls[2].body.authorized_event_states.includes("completed"), true);
});

test("delivery reads are status-filtered and remain read-only", async () => {
  await withFetch(async (url, init = {}) => {
    assert.equal(
      url,
      "/api/v1/notification-subscriptions/deliveries?status=failed",
    );
    assert.equal(init.method, "GET");
    return response({ deliveries: [{ id: "delivery-1", status: "failed" }] });
  }, async () => {
    assert.deepEqual(
      await notificationApi.listDeliveries({ status: "failed" }),
      [{
        id: "delivery-1",
        subscriptionId: null,
        state: null,
        status: "failed",
        attemptCount: 0,
        lastErrorCode: null,
        receipt: null,
        createdAt: null,
        updatedAt: null,
      }],
    );
  });
});
