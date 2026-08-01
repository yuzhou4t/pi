import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ATTENTION_EVENT_STATES,
  createDisabledLarkTransport,
  createInjectedLarkTransport,
  createLifecycleNotificationDispatcher,
  createNotificationService as createNotificationServiceBase,
} from "./index.js";

const TEST_BOT_IDENTITY = Object.freeze({
  fingerprint: `sha256:${"1".repeat(64)}`,
  label: "Pi Agent 提醒机器人",
});

function createNotificationService({
  transport = createDisabledLarkTransport(),
  testIdentityResolver = async () => TEST_BOT_IDENTITY,
  ...options
} = {}) {
  return createNotificationServiceBase({
    ...options,
    transport: Object.freeze({
      kind: transport.kind,
      resolveIdentity: testIdentityResolver,
      send: (envelope) => transport.send(envelope),
    }),
  });
}

async function withTempDir(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-notifications-test-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function createIdFactory(prefix = "id") {
  let sequence = 0;
  return () => `${prefix}-${++sequence}`;
}

function createClock(initial = "2026-08-01T00:00:00.000Z") {
  let current = new Date(initial);
  return {
    now: () => new Date(current),
    advance(milliseconds) {
      current = new Date(current.getTime() + milliseconds);
    },
  };
}

async function createDefaultSubscription(service, overrides = {}) {
  return service.createSubscription({
    id: "primary",
    target: {
      type: "chat_id",
      id: "oc_safe_target",
      label: "个人提醒",
    },
    authRevision: "auth-1",
    authorizationConfirmed: true,
    ...overrides,
  });
}

const lifecycleInput = Object.freeze({
  conversationId: "conversation-1",
  sourceEventSeq: 17,
  state: "awaiting_review",
  projectLabel: "Pi Agent",
});

test("subscription defaults to attention events and persists with completed disabled", async () => {
  await withTempDir(async (storageRoot) => {
    const service = createNotificationService({
      storageRoot,
      idFactory: createIdFactory(),
    });
    const created = await createDefaultSubscription(service);
    assert.deepEqual(created.enabledEventStates, ATTENTION_EVENT_STATES);
    assert.deepEqual(created.authorizedEventStates, ATTENTION_EVENT_STATES);
    assert.equal(created.target.label, "个人提醒");
    assert.deepEqual(created.botIdentity, TEST_BOT_IDENTITY);
    assert.equal("id" in created.target, false);

    const suppressed = await service.enqueueForSubscription("primary", {
      ...lifecycleInput,
      sourceEventSeq: 18,
      state: "completed",
    });
    assert.deepEqual(suppressed, {
      status: "suppressed",
      reason: "event_disabled",
    });

    const reopened = createNotificationService({
      storageRoot,
      idFactory: createIdFactory("reopened"),
    });
    assert.deepEqual(await reopened.listSubscriptions(), [created]);
  });
});

test("first binding cannot pre-authorize completed or use an unsupported target type", async () => {
  await withTempDir(async (storageRoot) => {
    let identityChecks = 0;
    const service = createNotificationService({
      storageRoot,
      idFactory: createIdFactory(),
      testIdentityResolver: async () => {
        identityChecks += 1;
        return TEST_BOT_IDENTITY;
      },
    });
    await assert.rejects(
      service.createSubscription({
        id: "unconfirmed",
        target: {
          type: "chat_id",
          id: "oc_safe_target",
          label: "个人提醒",
        },
        authRevision: "auth-unconfirmed",
      }),
      (error) => error.code === "NOTIFICATION_REAUTH_REQUIRED",
    );
    assert.equal(identityChecks, 0);
    await assert.rejects(
      createDefaultSubscription(service, {
        authorizedEventStates: [...ATTENTION_EVENT_STATES, "completed"],
      }),
      (error) => error.code === "NOTIFICATION_INITIAL_SCOPE_INVALID",
    );
    await assert.rejects(
      createDefaultSubscription(service, {
        target: {
          type: "user_id",
          id: "user_target",
          label: "旧目标类型",
        },
      }),
      (error) => error.code === "NOTIFICATION_TARGET_INVALID",
    );
    assert.equal(identityChecks, 0);
  });
});

test("bot identity changes fail closed before transport send and persist a failed delivery", async () => {
  await withTempDir(async (storageRoot) => {
    let identityChecks = 0;
    let sendCalls = 0;
    const service = createNotificationService({
      storageRoot,
      idFactory: createIdFactory(),
      transport: createInjectedLarkTransport(async () => {
        sendCalls += 1;
        return { messageId: "must-not-send" };
      }),
      testIdentityResolver: async () => {
        identityChecks += 1;
        return identityChecks === 1
          ? TEST_BOT_IDENTITY
          : {
              fingerprint: `sha256:${"2".repeat(64)}`,
              label: "另一个飞书机器人",
            };
      },
    });
    await createDefaultSubscription(service);
    await service.enqueueForSubscription("primary", lifecycleInput);
    const [job] = await service.processDue();
    assert.equal(job.status, "failed");
    assert.equal(job.lastErrorCode, "LARK_BOT_IDENTITY_MISMATCH");
    assert.equal(job.attemptCount, 1);
    assert.equal(sendCalls, 0);
    assert.deepEqual(await service.processDue(), []);
    assert.match(JSON.stringify(await service.readLedger()), /LARK_BOT_IDENTITY_MISMATCH/u);
  });
});

test("return entries are loopback or app-only and contain an opaque conversation id", async () => {
  await withTempDir(async (storageRoot) => {
    assert.throws(
      () => createNotificationService({
        storageRoot,
        returnEntryBaseUrl: "https://example.com/private/project",
      }),
      (error) => error.code === "NOTIFICATION_RETURN_ENTRY_INVALID",
    );
    const service = createNotificationService({
      storageRoot,
      idFactory: createIdFactory(),
      returnEntryBaseUrl: "pi-agent://app/",
    });
    await createDefaultSubscription(service);
    const queued = await service.enqueueForSubscription("primary", lifecycleInput);
    assert.equal(
      queued.job.returnEntry,
      "pi-agent://app/?work_type=project_work&conversation_id=conversation-1",
    );
    assert.doesNotMatch(queued.job.returnEntry, /Users|log|body|path/iu);
  });
});

test("safe envelope excludes original content and duplicate lifecycle events enqueue once", async () => {
  await withTempDir(async (storageRoot) => {
    const envelopes = [];
    const clock = createClock();
    const service = createNotificationService({
      storageRoot,
      now: clock.now,
      idFactory: createIdFactory(),
      transport: createInjectedLarkTransport(async (envelope) => {
        envelopes.push(envelope);
        return { messageId: "om_123", ignoredProviderBody: "must-not-persist" };
      }),
    });
    await createDefaultSubscription(service);
    const first = await service.enqueueForSubscription("primary", lifecycleInput);
    const duplicate = await service.enqueueForSubscription("primary", lifecycleInput);
    assert.equal(first.status, "enqueued");
    assert.equal(duplicate.status, "duplicate");
    assert.equal(first.job.id, duplicate.job.id);

    await service.processDue();
    assert.equal(envelopes.length, 1);
    assert.deepEqual(Object.keys(envelopes[0]).sort(), [
      "authRevision",
      "botIdentity",
      "channel",
      "idempotencyKey",
      "message",
      "target",
      "template",
    ]);
    assert.deepEqual(envelopes[0].message, {
      title: "Pi Agent 有内容等待审阅",
      text: "Pi Agent · 回到当前任务核对内容后再决定是否继续。",
      returnEntry: "http://127.0.0.1:4173/?work_type=project_work&conversation_id=conversation-1",
    });
    assert.deepEqual(envelopes[0].botIdentity, TEST_BOT_IDENTITY);
    assert.equal(envelopes[0].idempotencyKey, "lark:primary:conversation-1:17");
    assert.equal(JSON.stringify(envelopes[0]).includes("must-not"), false);

    const [sent] = await service.listOutbox({ status: "sent" });
    assert.deepEqual(sent.receipt, {
      messageId: "om_123",
      acceptedAt: "2026-08-01T00:00:00.000Z",
    });
    assert.equal(JSON.stringify(sent).includes("oc_safe_target"), false);
    assert.equal(JSON.stringify(sent).includes("ignoredProviderBody"), false);
  });
});

test("unsafe direct event fields and path-like project labels are rejected", async () => {
  await withTempDir(async (storageRoot) => {
    const service = createNotificationService({
      storageRoot,
      idFactory: createIdFactory(),
    });
    await createDefaultSubscription(service);
    await assert.rejects(
      service.enqueueForSubscription("primary", {
        ...lifecycleInput,
        logs: "secret output",
      }),
      (error) => error.code === "NOTIFICATION_UNSAFE_FIELD",
    );
    await assert.rejects(
      service.enqueueForSubscription("primary", {
        ...lifecycleInput,
        projectLabel: "/Users/private/project",
      }),
      (error) => error.code === "NOTIFICATION_INPUT_INVALID",
    );
  });
});

test("retriable transport failures use bounded backoff then reach sent", async () => {
  await withTempDir(async (storageRoot) => {
    const clock = createClock();
    let calls = 0;
    const service = createNotificationService({
      storageRoot,
      now: clock.now,
      idFactory: createIdFactory(),
      retryPolicy: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 },
      transport: createInjectedLarkTransport(async () => {
        calls += 1;
        if (calls < 3) {
          const error = new Error("provider details must not persist");
          error.code = "LARK_TEMPORARY_FAILURE";
          error.retriable = true;
          throw error;
        }
        return { messageId: "om_retry_ok" };
      }),
    });
    await createDefaultSubscription(service);
    await service.enqueueForSubscription("primary", lifecycleInput);

    let [job] = await service.processDue();
    assert.equal(job.status, "retry_wait");
    assert.equal(job.attemptCount, 1);
    assert.equal((await service.processDue()).length, 0);

    clock.advance(100);
    [job] = await service.processDue();
    assert.equal(job.status, "retry_wait");
    assert.equal(job.attemptCount, 2);

    clock.advance(200);
    [job] = await service.processDue();
    assert.equal(job.status, "sent");
    assert.equal(job.attemptCount, 3);
    assert.equal(calls, 3);
  });
});

test("retry stops at the limit and persists a sanitized failed status", async () => {
  await withTempDir(async (storageRoot) => {
    const clock = createClock();
    const service = createNotificationService({
      storageRoot,
      now: clock.now,
      idFactory: createIdFactory(),
      retryPolicy: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 10 },
      transport: createInjectedLarkTransport(async () => {
        const error = new Error("/private/path and secret log");
        error.code = "/private/path";
        error.retriable = true;
        throw error;
      }),
    });
    await createDefaultSubscription(service);
    await service.enqueueForSubscription("primary", lifecycleInput);
    await service.processDue();
    clock.advance(10);
    const [job] = await service.processDue();
    assert.equal(job.status, "failed");
    assert.equal(job.attemptCount, 2);
    assert.equal(job.lastErrorCode, "NOTIFICATION_TRANSPORT_FAILED");
    assert.equal(JSON.stringify(await service.readLedger()).includes("/private/path"), false);
    assert.equal((await service.processDue()).length, 0);
  });
});

test("default transport never claims a real send", async () => {
  await withTempDir(async (storageRoot) => {
    const service = createNotificationService({
      storageRoot,
      idFactory: createIdFactory(),
    });
    await createDefaultSubscription(service);
    await service.enqueueForSubscription("primary", lifecycleInput);
    const [job] = await service.processDue();
    assert.equal(job.status, "failed");
    assert.equal(job.lastErrorCode, "LARK_TRANSPORT_DISABLED");
    assert.equal(job.receipt, null);
  });
});

test("notification-origin events are suppressed and never enter the outbox", async () => {
  await withTempDir(async (storageRoot) => {
    const service = createNotificationService({
      storageRoot,
      idFactory: createIdFactory(),
    });
    await createDefaultSubscription(service);
    const result = await service.dispatchLifecycle({
      ...lifecycleInput,
      origin: "notification.transport",
    });
    assert.deepEqual(result, {
      status: "suppressed",
      reason: "notification_origin",
      results: [],
    });
    assert.deepEqual(await service.listOutbox(), []);
  });
});

test("dispatcher extracts only lifecycle-safe fields from a rich event", async () => {
  const received = [];
  const dispatcher = createLifecycleNotificationDispatcher({
    notificationService: {
      async dispatchLifecycle(input) {
        received.push(input);
        return { status: "enqueued", results: [] };
      },
    },
  });
  await dispatcher.dispatch({
    conversationId: "conversation-1",
    projectLabel: "Pi Agent",
    event: {
      seq: 99,
      type: "loop.lifecycle",
      data: {
        sourceEventSeq: 17,
        state: "awaiting_review",
        title: "untrusted title",
        detail: "source body",
        path: "/private/project.js",
        logs: "secret",
      },
    },
  });
  assert.deepEqual(received, [{
    conversationId: "conversation-1",
    projectLabel: "Pi Agent",
    sourceEventSeq: 17,
    state: "awaiting_review",
    origin: undefined,
  }]);
});

test("queued jobs retain their authorized target after subscription reauthorization", async () => {
  await withTempDir(async (storageRoot) => {
    const targets = [];
    const service = createNotificationService({
      storageRoot,
      idFactory: createIdFactory(),
      transport: createInjectedLarkTransport(async (envelope) => {
        targets.push(envelope.target.id);
        return { messageId: "om_fixed_binding" };
      }),
    });
    await createDefaultSubscription(service);
    await service.enqueueForSubscription("primary", lifecycleInput);
    await service.reauthorizeSubscription("primary", {
      target: {
        type: "chat_id",
        id: "oc_new_target",
        label: "新提醒目标",
      },
      authRevision: "auth-2",
      authorizationConfirmed: true,
    });
    await service.processDue();
    assert.deepEqual(targets, ["oc_safe_target"]);
  });
});

test("concurrent processors claim one outbox job only once", async () => {
  await withTempDir(async (storageRoot) => {
    let releaseSend;
    let markStarted;
    const sendStarted = new Promise((resolve) => {
      markStarted = resolve;
    });
    const sendReleased = new Promise((resolve) => {
      releaseSend = resolve;
    });
    let calls = 0;
    const service = createNotificationService({
      storageRoot,
      idFactory: createIdFactory(),
      transport: createInjectedLarkTransport(async () => {
        calls += 1;
        markStarted();
        await sendReleased;
        return { messageId: "om_once" };
      }),
    });
    await createDefaultSubscription(service);
    await service.enqueueForSubscription("primary", lifecycleInput);

    const firstProcessor = service.processDue();
    await sendStarted;
    const secondResult = await service.processDue();
    assert.deepEqual(secondResult, []);
    releaseSend();
    const [sent] = await firstProcessor;
    assert.equal(sent.status, "sent");
    assert.equal(calls, 1);
  });
});

test("a restarted service safely retries a persisted interrupted send", async () => {
  await withTempDir(async (storageRoot) => {
    const first = createNotificationService({
      storageRoot,
      idFactory: createIdFactory("first"),
    });
    await createDefaultSubscription(first);
    await first.enqueueForSubscription("primary", lifecycleInput);
    const persisted = JSON.parse(await readFile(first.paths.statePath, "utf8"));
    persisted.outbox[0].status = "sending";
    persisted.outbox[0].attemptCount = 1;
    await writeFile(first.paths.statePath, `${JSON.stringify(persisted, null, 2)}\n`);

    let calls = 0;
    const restarted = createNotificationService({
      storageRoot,
      idFactory: createIdFactory("restarted"),
      transport: createInjectedLarkTransport(async () => {
        calls += 1;
        return { messageId: "om_after_restart" };
      }),
    });
    const [job] = await restarted.processDue();
    assert.equal(job.status, "sent");
    assert.equal(job.attemptCount, 2);
    assert.equal(calls, 1);
  });
});

test("completed can be opted into, while an unauthorized expansion requires reauthorization", async () => {
  await withTempDir(async (storageRoot) => {
    const service = createNotificationService({
      storageRoot,
      idFactory: createIdFactory(),
    });
    const original = await createDefaultSubscription(service);
    await assert.rejects(
      service.setEnabledEventStates("primary", [
        ...ATTENTION_EVENT_STATES,
        "completed",
      ]),
      (error) => error.code === "NOTIFICATION_REAUTH_REQUIRED",
    );
    await assert.rejects(
      service.reauthorizeSubscription("primary", {
        authRevision: "auth-2",
        authorizedEventStates: [...ATTENTION_EVENT_STATES, "completed"],
        enabledEventStates: [...ATTENTION_EVENT_STATES, "completed"],
      }),
      (error) => error.code === "NOTIFICATION_REAUTH_REQUIRED",
    );
    const expanded = await service.reauthorizeSubscription("primary", {
      authRevision: "auth-2",
      authorizedEventStates: [...ATTENTION_EVENT_STATES, "completed"],
      enabledEventStates: [...ATTENTION_EVENT_STATES, "completed"],
      authorizationConfirmed: true,
    });
    assert.equal(expanded.enabledEventStates.includes("completed"), true);
    assert.equal(expanded.authorizedEventStates.includes("completed"), true);
    assert.deepEqual(expanded.target, original.target);
  });
});
