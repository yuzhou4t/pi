import assert from "node:assert/strict";
import test from "node:test";
import {
  currentLoopCloseoutEvent,
  safeLoopNotification,
  shouldSendLoopNotification,
} from "./loopNotifications.js";

const event = {
  seq: 42,
  type: "loop.lifecycle",
  lifecycleState: "awaiting_review",
  data: {
    path: "/private/project/file.js",
    logs: "secret",
  },
};

test("loop notifications are silent in the foreground and dedupe by sequence", () => {
  assert.equal(shouldSendLoopNotification({
    event,
    enabled: true,
    permission: "granted",
    visibilityState: "visible",
    hasFocus: true,
    lastNotifiedSeq: 41,
  }), false);
  assert.equal(shouldSendLoopNotification({
    event,
    enabled: true,
    permission: "granted",
    visibilityState: "hidden",
    hasFocus: false,
    lastNotifiedSeq: 42,
  }), false);
  assert.equal(shouldSendLoopNotification({
    event,
    enabled: true,
    permission: "granted",
    visibilityState: "hidden",
    hasFocus: false,
    lastNotifiedSeq: 41,
  }), true);
});

test("notification copy never carries event paths, logs, or approval data", () => {
  const copy = safeLoopNotification(event);
  assert.deepEqual(copy, {
    title: "Pi Agent 有内容等待审阅",
    body: "回到当前任务核对精确内容后再决定是否继续。",
  });
  assert.doesNotMatch(JSON.stringify(copy), /private|secret|approve/i);
});

test("closeout card never reuses a stale lifecycle state", () => {
  assert.equal(currentLoopCloseoutEvent({
    events: [event],
    conversationStatus: "awaiting_confirmation",
  })?.seq, 42);
  assert.equal(currentLoopCloseoutEvent({
    events: [event],
    conversationStatus: "running",
  }), null);
  assert.equal(currentLoopCloseoutEvent({
    events: [{
      ...event,
      seq: 43,
      lifecycleState: "awaiting_user",
    }],
    conversationStatus: "idle",
  }), null);
  assert.equal(currentLoopCloseoutEvent({
    events: [{
      ...event,
      seq: 44,
      lifecycleState: "completed",
    }],
    conversationStatus: "idle",
  })?.seq, 44);
});
