import assert from "node:assert/strict";
import test from "node:test";
import { ATTENTION_EVENT_STATES } from "./contract.js";
import { createNotificationHttpApi } from "./httpApi.js";

function createHarness({ payload, service = {} } = {}) {
  const responses = [];
  let originChecks = 0;
  const api = createNotificationHttpApi({
    notificationService: {
      listSubscriptions: async () => [],
      listOutbox: async () => [],
      getSubscription: async () => null,
      ...service,
    },
    readJson: async () => payload,
    sendJson(_response, status, body) {
      responses.push({ status, body });
    },
    requireMutationOrigin() {
      originChecks += 1;
    },
  });
  return { api, responses, originChecks: () => originChecks };
}

test("first notification binding authorizes only the four attention events", async () => {
  let captured;
  const subscription = { id: "subscription-1" };
  const harness = createHarness({
    payload: {
      schema_version: 1,
      target: { type: "open_id", id: "ou_target", label: "个人提醒" },
      auth_revision: "auth-1",
      authorization_confirmed: true,
    },
    service: {
      async createSubscription(input) {
        captured = input;
        return subscription;
      },
    },
  });
  const handled = await harness.api.handle(
    { method: "POST" },
    {},
    new URL("http://127.0.0.1/api/v1/notification-subscriptions"),
    "http://127.0.0.1",
  );
  assert.equal(handled, true);
  assert.equal(harness.originChecks(), 1);
  assert.deepEqual(captured.authorizedEventStates, ATTENTION_EVENT_STATES);
  assert.deepEqual(captured.enabledEventStates, ATTENTION_EVENT_STATES);
  assert.equal(captured.authorizationConfirmed, true);
  assert.equal(captured.target.type, "open_id");
  assert.deepEqual(harness.responses, [{
    status: 201,
    body: { schema_version: 1, subscription },
  }]);
});

test("event expansion reauthorizes without replacing the fixed target", async () => {
  let captured;
  const subscription = { id: "subscription-1" };
  const harness = createHarness({
    payload: {
      schema_version: 1,
      auth_revision: "auth-2",
      authorized_event_states: [...ATTENTION_EVENT_STATES, "completed"],
      enabled_event_states: [...ATTENTION_EVENT_STATES, "completed"],
      authorization_confirmed: true,
    },
    service: {
      async reauthorizeSubscription(subscriptionId, input) {
        captured = { subscriptionId, input };
        return subscription;
      },
    },
  });
  const handled = await harness.api.handle(
    { method: "PATCH" },
    {},
    new URL("http://127.0.0.1/api/v1/notification-subscriptions/subscription-1"),
    "http://127.0.0.1",
  );
  assert.equal(handled, true);
  assert.equal(captured.subscriptionId, "subscription-1");
  assert.equal(captured.input.target, undefined);
  assert.equal(captured.input.template, undefined);
  assert.equal(captured.input.authorizationConfirmed, true);
  assert.equal(captured.input.authorizedEventStates.includes("completed"), true);
  assert.equal(captured.input.enabledEventStates.includes("completed"), true);
});

test("an event expansion without explicit confirmation reaches the service as unconfirmed", async () => {
  let captured;
  const harness = createHarness({
    payload: {
      schema_version: 1,
      auth_revision: "auth-2",
      authorized_event_states: [...ATTENTION_EVENT_STATES, "completed"],
      enabled_event_states: [...ATTENTION_EVENT_STATES, "completed"],
    },
    service: {
      async reauthorizeSubscription(_subscriptionId, input) {
        captured = input;
        return { id: "subscription-1" };
      },
    },
  });
  await harness.api.handle(
    { method: "PATCH" },
    {},
    new URL("http://127.0.0.1/api/v1/notification-subscriptions/subscription-1"),
    "http://127.0.0.1",
  );
  assert.equal(captured.authorizationConfirmed, false);
});
