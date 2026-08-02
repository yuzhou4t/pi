import assert from "node:assert/strict";
import test from "node:test";
import { createNativeChildWorkspaceAllocator } from "./nativeChildWorkspaces.js";

const project = {
  id: "project-1",
  rootPath: "/private/project",
};

test("read-only child sessions use the parent's real Workspace cwd", async () => {
  const sourceWorkspace = {
    id: "workspace-main",
    rootPath: "/private/project",
    isGit: true,
    head: "abc123",
  };
  let createCalls = 0;
  const allocate = createNativeChildWorkspaceAllocator({
    project,
    sourceWorkspace,
    workspaceRegistry: {
      async resolveWorkspace() {
        return sourceWorkspace;
      },
      async createWorktree() {
        createCalls += 1;
        throw new Error("read-only allocation must not create a worktree");
      },
    },
  });

  const result = await allocate({
    tasks: [{ mode: "read" }, { mode: "read" }],
  });

  assert.equal(createCalls, 0);
  assert.deepEqual(result, [{
    cwd: "/private/project",
    workspaceId: "workspace-main",
    kind: "shared_workspace",
    persistent: true,
  }, {
    cwd: "/private/project",
    workspaceId: "workspace-main",
    kind: "shared_workspace",
    persistent: true,
  }]);
});

test("parallel Git writers receive separate long-lived registered worktrees", async () => {
  const sourceWorkspace = {
    id: "workspace-main",
    rootPath: "/private/project",
    isGit: true,
    head: "abc123",
  };
  const calls = [];
  const worktrees = new Map();
  const workspaceRegistry = {
    async resolveWorkspace({ workspaceId }) {
      if (workspaceId === sourceWorkspace.id) return sourceWorkspace;
      return worktrees.get(workspaceId);
    },
    async createWorktree(input) {
      calls.push(input);
      const id = `child-${calls.length}`;
      worktrees.set(id, {
        id,
        rootPath: `/private/worktrees/${id}`,
        isGit: true,
        head: sourceWorkspace.head,
      });
      return { id };
    },
  };
  const allocate = createNativeChildWorkspaceAllocator({
    project,
    sourceWorkspace,
    workspaceRegistry,
  });

  const result = await allocate({
    tasks: [{ mode: "write" }, { mode: "write" }],
  });

  assert.deepEqual(result, [{
    cwd: "/private/worktrees/child-1",
    workspaceId: "child-1",
    kind: "persistent_worktree",
    persistent: true,
  }, {
    cwd: "/private/worktrees/child-2",
    workspaceId: "child-2",
    kind: "persistent_worktree",
    persistent: true,
  }]);
  assert.deepEqual(calls.map((call) => ({
    sourceWorkspaceId: call.sourceWorkspaceId,
    expectedHead: call.expectedHead,
    title: call.title,
    label: call.label,
    busy: call.busy,
  })), [{
    sourceWorkspaceId: "workspace-main",
    expectedHead: "abc123",
    title: "child-session",
    label: "子任务 Workspace 1",
    busy: false,
  }, {
    sourceWorkspaceId: "workspace-main",
    expectedHead: "abc123",
    title: "child-session",
    label: "子任务 Workspace 2",
    busy: false,
  }]);
  assert.notEqual(result[0].cwd, result[1].cwd);
});

test("parallel writers are rejected for a non-Git Workspace", async () => {
  const allocate = createNativeChildWorkspaceAllocator({
    project,
    sourceWorkspace: {
      id: "workspace-folder",
      rootPath: "/private/folder",
      isGit: false,
      head: null,
    },
    workspaceRegistry: {
      async resolveWorkspace() {
        throw new Error("must not resolve a non-Git worktree");
      },
      async createWorktree() {
        throw new Error("must not create a non-Git worktree");
      },
    },
  });

  await assert.rejects(
    allocate({ tasks: [{ mode: "write" }, { mode: "write" }] }),
    (error) => {
      assert.equal(
        error.code,
        "PROJECT_WORK_CHILD_SESSION_PARALLEL_WRITE_UNAVAILABLE",
      );
      assert.equal(error.retryable, true);
      return true;
    },
  );
});
