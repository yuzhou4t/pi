import assert from "node:assert/strict";
import test from "node:test";
import { deriveLoopLifecycleEvent } from "./loopLifecycle.js";

test("loop lifecycle derives only the approved user-facing states", () => {
  assert.equal(
    deriveLoopLifecycleEvent({
      seq: 7,
      type: "ask_user.requested",
      data: { prompt: "secret path /tmp/example" },
    }).state,
    "awaiting_user",
  );
  assert.equal(
    deriveLoopLifecycleEvent({
      seq: 8,
      type: "verification.completed",
      data: { status: "failed", output: "must-not-leak" },
    }).state,
    "verification_failed",
  );
  assert.equal(
    deriveLoopLifecycleEvent({
      seq: 9,
      type: "agent.status",
      data: { status: "running" },
    }),
    null,
  );
  assert.equal(
    deriveLoopLifecycleEvent({
      seq: 10,
      type: "browser_qa.completed",
      data: { verdict: "issues" },
    }).state,
    "verification_failed",
  );
  assert.equal(
    deriveLoopLifecycleEvent({
      seq: 11,
      type: "browser_qa.completed",
      data: { verdict: "passed" },
    }).state,
    "completed",
  );
  assert.equal(
    deriveLoopLifecycleEvent({
      seq: 12,
      type: "git_closeout.committed",
      data: { pendingReview: true },
    }),
    null,
  );
});

test("loop lifecycle payload contains no source logs, paths, or approval action", () => {
  const lifecycle = deriveLoopLifecycleEvent({
    seq: 11,
    type: "agent.status",
    data: {
      status: "awaiting_confirmation",
      path: "/Users/example/private.js",
      logs: "secret",
      approvalToken: "approve-me",
    },
  });
  assert.deepEqual(lifecycle, {
    state: "awaiting_review",
    sourceEventSeq: 11,
    dedupeKey: "awaiting_review:11",
    title: "Pi Agent 有内容等待审阅",
    detail: "回到当前任务核对精确内容后再决定是否继续。",
    artifactId: "changes",
  });
});

test("awaiting review keeps only an approved artifact target", () => {
  assert.equal(
    deriveLoopLifecycleEvent({
      seq: 12,
      type: "agent.status",
      data: {
        status: "awaiting_confirmation",
        artifactId: "preview",
      },
    }).artifactId,
    "preview",
  );
  assert.equal(
    deriveLoopLifecycleEvent({
      seq: 13,
      type: "agent.status",
      data: {
        status: "awaiting_confirmation",
        artifactId: "/private/project/secret.js",
      },
    }).artifactId,
    "changes",
  );
});

test("a clean or intermediate change-set event is not a review notification", () => {
  assert.equal(
    deriveLoopLifecycleEvent({
      seq: 12,
      type: "change_set.ready",
      data: { stats: { files: 0 } },
    }),
    null,
  );
  assert.equal(
    deriveLoopLifecycleEvent({
      seq: 13,
      type: "change_set.ready",
      data: { stats: { files: 2 } },
    }),
    null,
  );
});
