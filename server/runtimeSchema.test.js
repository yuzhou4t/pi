import assert from "node:assert/strict";
import test from "node:test";
import {
  CONVERSATION_LIFECYCLE,
  deriveLifecycle,
  migrateRuntimeEnvelope,
  RUNTIME_SCHEMA_VERSION,
} from "./runtimeSchema.js";

test("shared lifecycle keeps workflow-specific status outside the runtime envelope", () => {
  assert.deepEqual(CONVERSATION_LIFECYCLE, [
    "idle",
    "running",
    "awaiting_user",
    "awaiting_review",
    "verifying",
    "recovering",
    "stopped",
  ]);
  assert.equal(deriveLifecycle("project_work", "awaiting_confirmation"), "awaiting_review");
  assert.equal(deriveLifecycle("project_work", "compacting"), "running");
  assert.equal(deriveLifecycle("project_work", "error"), "stopped");
  assert.equal(deriveLifecycle("journal", "preparing_documents"), "running");
  assert.equal(deriveLifecycle("journal", "preparing_guides"), "running");
  assert.equal(deriveLifecycle("journal", "reading"), "idle");
  assert.equal(deriveLifecycle("journal", "reading_ready"), "idle");
  assert.equal(deriveLifecycle("journal", "awaiting_approval"), "awaiting_review");
  assert.equal(deriveLifecycle("journal", "manual_action_required"), "awaiting_review");
  assert.equal(deriveLifecycle("journal", "failed"), "stopped");
});

test("runtime envelope migrates legacy records and re-derives stale current envelopes", () => {
  assert.deepEqual(
    migrateRuntimeEnvelope({ status: "running" }, {
      domain: "project_work",
    }),
    {
      runtime_schema_version: RUNTIME_SCHEMA_VERSION,
      lifecycle: "running",
    },
  );
  assert.deepEqual(
    migrateRuntimeEnvelope({
      runtime_schema_version: RUNTIME_SCHEMA_VERSION,
      lifecycle: "awaiting_user",
      status: "idle",
    }, {
      domain: "project_work",
    }),
    {
      runtime_schema_version: RUNTIME_SCHEMA_VERSION,
      lifecycle: "idle",
    },
  );
});
