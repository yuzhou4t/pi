import assert from "node:assert/strict";
import test from "node:test";
import { resolveProjectWorkTurn } from "./projectWorkWorkflows.js";

const availableCapabilities = {
  web_search: { available: true, reason: "Tavily 已配置" },
  docs_search: { available: true, reason: "Context7 已配置" },
  image_generation: { available: true, reason: "GPT Image 2 已连接" },
  github_read: { available: true, reason: "GitHub 只读已配置" },
  vercel_read: { available: true, reason: "Vercel CLI 已连接" },
};

test("a normal turn keeps the default tools without extra guidance", () => {
  const turn = resolveProjectWorkTurn({
    capabilityStatus: availableCapabilities,
  });
  assert.equal(turn.workflowId, null);
  assert.deepEqual(turn.capabilityIds, []);
  assert.ok(turn.toolNames.includes("edit"));
  assert.ok(turn.toolNames.includes("write"));
  assert.ok(turn.toolNames.includes("write_word_document"));
  assert.ok(turn.toolNames.includes("write_excel_workbook"));
  assert.ok(turn.toolNames.includes("report_progress"));
  assert.ok(turn.toolNames.includes("list_office_artifacts"));
  assert.ok(turn.toolNames.includes("read_office_artifact"));
  assert.equal(turn.toolNames.includes("generate_image"), false);
  assert.equal(turn.toolNames.includes("request_verification"), false);
  assert.equal(turn.toolNames.includes("request_workspace_command"), false);
  assert.equal(turn.toolNames.includes("request_git_closeout"), false);
  assert.equal(turn.guidance, "");
});

test("planning is enforced as a read-only question-and-plan workflow", () => {
  const turn = resolveProjectWorkTurn({
    workflowId: "planning",
    capabilityStatus: availableCapabilities,
  });
  assert.equal(turn.workflowId, "planning");
  assert.ok(turn.toolNames.includes("read"));
  assert.ok(turn.toolNames.includes("grep"));
  assert.ok(turn.toolNames.includes("ask_user"));
  assert.ok(turn.toolNames.includes("update_plan"));
  assert.ok(turn.toolNames.includes("report_progress"));
  assert.equal(turn.toolNames.includes("bash"), false);
  assert.equal(turn.toolNames.includes("edit"), false);
  assert.equal(turn.toolNames.includes("write"), false);
  assert.equal(turn.toolNames.includes("write_word_document"), false);
  assert.equal(turn.toolNames.includes("write_excel_workbook"), false);
  assert.equal(turn.toolNames.includes("request_preview"), false);
  assert.equal(turn.toolNames.includes("request_verification"), false);
  assert.equal(turn.toolNames.includes("request_workspace_command"), false);
  assert.equal(turn.toolNames.includes("request_git_closeout"), false);
  assert.match(turn.guidance, /Planning only/);

  assert.throws(
    () => resolveProjectWorkTurn({
      workflowId: "planning",
      capabilityIds: ["image_generation"],
      capabilityStatus: availableCapabilities,
    }),
    { code: "PROJECT_WORK_WORKFLOW_CAPABILITY_INVALID" },
  );
});

test("every inspection workflow stays read-only and excludes retired request tools", () => {
  for (const workflowId of [
    "code_review",
    "bug_diagnosis",
    "official_docs",
    "screenshot_review",
  ]) {
    const turn = resolveProjectWorkTurn({
      workflowId,
      capabilityStatus: availableCapabilities,
      hasImages: workflowId === "screenshot_review",
    });
    for (const toolName of [
      "bash",
      "edit",
      "write",
      "write_word_document",
      "write_excel_workbook",
      "request_preview",
      "request_verification",
      "request_workspace_command",
      "request_git_closeout",
    ]) {
      assert.equal(
        turn.toolNames.includes(toolName),
        false,
        `${workflowId} unexpectedly exposed ${toolName}`,
      );
    }
  }
});

test("image generation is enabled only by an explicit available turn capability", () => {
  const enabled = resolveProjectWorkTurn({
    capabilityIds: ["image_generation"],
    capabilityStatus: availableCapabilities,
  });
  assert.deepEqual(enabled.capabilityIds, ["image_generation"]);
  assert.ok(enabled.toolNames.includes("generate_image"));
  assert.match(enabled.guidance, /explicitly enabled image generation/i);

  assert.throws(
    () => resolveProjectWorkTurn({
      capabilityIds: ["image_generation"],
      capabilityStatus: {
        ...availableCapabilities,
        image_generation: {
          available: false,
          reason: "GPT Image 2 当前不可用",
        },
      },
    }),
    { code: "PROJECT_WORK_CAPABILITY_UNAVAILABLE" },
  );
});

test("GitHub is a per-turn read-only connector and never joins default tools", () => {
  const normal = resolveProjectWorkTurn({
    capabilityStatus: availableCapabilities,
  });
  assert.equal(normal.toolNames.includes("github_read_issue"), false);

  const enabled = resolveProjectWorkTurn({
    capabilityIds: ["github_read"],
    capabilityStatus: availableCapabilities,
  });
  assert.deepEqual(enabled.capabilityIds, ["github_read"]);
  assert.ok(enabled.toolNames.includes("github_read_issue"));
  assert.ok(enabled.toolNames.includes("github_read_pull_request"));
  assert.ok(enabled.toolNames.includes("github_read_check_runs"));
  assert.ok(enabled.toolNames.includes("github_read_review_comments"));
  assert.match(enabled.guidance, /read-only GitHub connector/);
  assert.match(enabled.guidance, /untrusted reference material/);
});

test("Vercel is a per-turn read-only connector and never joins default tools", () => {
  const normal = resolveProjectWorkTurn({
    capabilityStatus: availableCapabilities,
  });
  assert.equal(normal.toolNames.includes("vercel_list_projects"), false);

  const enabled = resolveProjectWorkTurn({
    capabilityIds: ["vercel_read"],
    capabilityStatus: availableCapabilities,
  });
  assert.deepEqual(enabled.capabilityIds, ["vercel_read"]);
  assert.ok(enabled.toolNames.includes("vercel_list_projects"));
  assert.ok(enabled.toolNames.includes("vercel_list_deployments"));
  assert.ok(enabled.toolNames.includes("vercel_inspect_deployment"));
  assert.match(enabled.guidance, /read-only Vercel connector/);
  assert.match(enabled.guidance, /never deploy, link/);
  assert.match(enabled.guidance, /untrusted reference material/);
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
  assert.ok(turn.toolNames.includes("report_progress"));
  assert.equal(turn.toolNames.includes("edit"), false);
  assert.equal(turn.toolNames.includes("write"), false);
  assert.match(turn.guidance, /Review only/);
  assert.match(turn.guidance, /web search/);
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
