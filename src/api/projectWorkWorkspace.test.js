import assert from "node:assert/strict";
import test from "node:test";
import {
  createProjectWorkConversation,
  createProjectWorkWorkspace,
  listProjectWorkWorkspaces,
  mapProjectWorkWorkspaceSummary,
  removeProjectWorkWorkspace,
} from "./projectWork.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("Workspace API maps only the public summary contract", async () => {
  const mapped = mapProjectWorkWorkspaceSummary({
    id: "workspace-1",
    projectId: "project-1",
    label: "pi/task-1",
    kind: "git_worktree",
    isMain: false,
    isGit: true,
    branch: "pi/task-1",
    head: "a".repeat(40),
    dirty: false,
    status: "available",
    conversationCount: 2,
    updatedAt: "2026-08-01T00:00:00.000Z",
    rootPath: "/private/must-not-leak",
  });
  assert.deepEqual(mapped, {
    id: "workspace-1",
    projectId: "project-1",
    label: "pi/task-1",
    kind: "git_worktree",
    isMain: false,
    isGit: true,
    branch: "pi/task-1",
    head: "a".repeat(40),
    dirty: false,
    status: "available",
    conversationCount: 2,
    updatedAt: "2026-08-01T00:00:00.000Z",
  });
});

test("Workspace list, creation, deletion, and conversation binding use scoped routes", async () => {
  const requests = [];
  const summary = {
    id: "workspace-2",
    projectId: "project/1",
    label: "pi/fix-2",
    kind: "git_worktree",
    isMain: false,
    isGit: true,
    branch: "pi/fix-2",
    head: "b".repeat(40),
    dirty: false,
    status: "available",
    conversationCount: 0,
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (options.method === "POST" && url.endsWith("/conversations")) {
      return jsonResponse({
        id: "conversation-1",
        projectId: "project/1",
        workspace: summary,
        title: "新工作会话",
        status: "idle",
      }, 201);
    }
    if (options.method === "POST") {
      return jsonResponse({ workspace: summary }, 201);
    }
    if (options.method === "DELETE") {
      return jsonResponse({ workspaceId: summary.id, removed: true });
    }
    return jsonResponse({ workspaces: [summary] });
  };

  const listed = await listProjectWorkWorkspaces({
    projectId: "project/1",
    fetchImpl,
  });
  assert.equal(listed[0].id, summary.id);
  await createProjectWorkWorkspace({
    projectId: "project/1",
    sourceWorkspaceId: "workspace-main",
    expectedHead: "a".repeat(40),
    branchName: "pi/fix-2",
    title: "Fix routing",
    fetchImpl,
  });
  await removeProjectWorkWorkspace({
    projectId: "project/1",
    workspaceId: summary.id,
    expectedHead: summary.head,
    fetchImpl,
  });
  const conversation = await createProjectWorkConversation({
    projectId: "project/1",
    workspaceId: summary.id,
    fetchImpl,
  });
  assert.equal(conversation.workspace.id, summary.id);

  assert.equal(
    requests[0].url,
    "/api/v1/project-work/projects/project%2F1/workspaces",
  );
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    schema_version: 1,
    source_workspace_id: "workspace-main",
    expected_head: "a".repeat(40),
    branch_name: "pi/fix-2",
    title: "Fix routing",
  });
  assert.equal(
    requests[2].url,
    "/api/v1/project-work/projects/project%2F1/workspaces/workspace-2",
  );
  assert.deepEqual(JSON.parse(requests[3].options.body), {
    schema_version: 1,
    workspace_id: "workspace-2",
  });
});
