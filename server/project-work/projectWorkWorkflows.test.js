import assert from "node:assert/strict";
import test from "node:test";
import { resolveProjectWorkTurn } from "./projectWorkWorkflows.js";

const availableCapabilities = {
  web_search: { available: true, reason: "Tavily 已配置" },
  docs_search: { available: true, reason: "Context7 已配置" },
};

test("a normal turn keeps the default tools without extra guidance", () => {
  const turn = resolveProjectWorkTurn({
    capabilityStatus: availableCapabilities,
  });
  assert.equal(turn.workflowId, null);
  assert.deepEqual(turn.capabilityIds, []);
  assert.ok(turn.toolNames.includes("edit"));
  assert.ok(turn.toolNames.includes("write"));
  assert.equal(turn.guidance, "");
});

test("code review is one-turn read-only while optional search is explicit", () => {
  const turn = resolveProjectWorkTurn({
    workflowId: "code_review",
    capabilityIds: ["web_search"],
    capabilityStatus: availableCapabilities,
  });
  assert.equal(turn.workflowId, "code_review");
  assert.deepEqual(turn.capabilityIds, ["web_search"]);
  assert.ok(turn.toolNames.includes("read"));
  assert.ok(turn.toolNames.includes("search_web"));
  assert.equal(turn.toolNames.includes("edit"), false);
  assert.equal(turn.toolNames.includes("write"), false);
  assert.match(turn.guidance, /Review only/);
  assert.match(turn.guidance, /Tavily/);
});

test("official docs requires configured Context7 and activates both docs tools", () => {
  const turn = resolveProjectWorkTurn({
    workflowId: "official_docs",
    capabilityStatus: availableCapabilities,
  });
  assert.deepEqual(turn.capabilityIds, ["docs_search"]);
  assert.ok(turn.toolNames.includes("resolve_library_id"));
  assert.ok(turn.toolNames.includes("query_docs"));

  assert.throws(
    () => resolveProjectWorkTurn({
      workflowId: "official_docs",
      capabilityStatus: {
        docs_search: { available: false, reason: "Context7 尚未配置" },
      },
    }),
    (error) => (
      error.code === "PROJECT_WORK_CAPABILITY_UNAVAILABLE"
      && /尚未配置/.test(error.message)
    ),
  );
});

test("unknown selections and screenshot review without an image fail before a turn", () => {
  assert.throws(
    () => resolveProjectWorkTurn({
      workflowId: "unknown",
      capabilityStatus: availableCapabilities,
    }),
    { code: "PROJECT_WORK_WORKFLOW_INVALID" },
  );
  assert.throws(
    () => resolveProjectWorkTurn({
      capabilityIds: ["unknown"],
      capabilityStatus: availableCapabilities,
    }),
    { code: "PROJECT_WORK_CAPABILITIES_INVALID" },
  );
  assert.throws(
    () => resolveProjectWorkTurn({
      workflowId: "screenshot_review",
      capabilityStatus: availableCapabilities,
      hasImages: false,
    }),
    { code: "PROJECT_WORK_WORKFLOW_IMAGE_REQUIRED" },
  );
});
