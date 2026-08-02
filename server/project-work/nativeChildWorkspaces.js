import { projectWorkError } from "./errors.js";

const CHILD_SESSION_WORKTREE_TITLE = "child-session";

function assertTaskMode(task) {
  if (!task || typeof task !== "object" || Array.isArray(task)) {
    throw projectWorkError(
      "PROJECT_WORK_CHILD_SESSION_INVALID",
      "子 Session 的 Workspace 请求无效",
      400,
    );
  }
  if (!["read", "write"].includes(task.mode)) {
    throw projectWorkError(
      "PROJECT_WORK_CHILD_SESSION_INVALID",
      "子 Session 必须声明只读或写入模式",
      400,
    );
  }
}

/**
 * Resolves real, persistent Workspaces for Pi child sessions.
 *
 * Read-only children share the parent's real cwd. A foreground writer may use
 * the same cwd for a non-Git project, while Git writers always receive a
 * long-lived registered worktree. The caller intentionally does not receive a
 * cleanup function: child worktrees follow the normal explicit Workspace
 * deletion contract and are never removed when a turn ends.
 */
export function createNativeChildWorkspaceAllocator({
  project,
  sourceWorkspace,
  workspaceRegistry,
} = {}) {
  if (!project || typeof project !== "object") {
    throw new TypeError("project is required");
  }
  if (
    !sourceWorkspace
    || typeof sourceWorkspace !== "object"
    || typeof sourceWorkspace.id !== "string"
    || typeof sourceWorkspace.rootPath !== "string"
  ) {
    throw new TypeError("sourceWorkspace is required");
  }
  if (
    !workspaceRegistry
    || typeof workspaceRegistry.resolveWorkspace !== "function"
    || typeof workspaceRegistry.createWorktree !== "function"
  ) {
    throw new TypeError("workspaceRegistry is required");
  }

  return async function allocateNativeChildWorkspaces({ tasks } = {}) {
    if (!Array.isArray(tasks) || tasks.length === 0) {
      throw projectWorkError(
        "PROJECT_WORK_CHILD_SESSION_INVALID",
        "子 Session 至少需要一个 Workspace 请求",
        400,
      );
    }
    tasks.forEach(assertTaskMode);
    const writers = tasks.filter((task) => task.mode === "write");
    if (!sourceWorkspace.isGit && writers.length > 1) {
      throw projectWorkError(
        "PROJECT_WORK_CHILD_SESSION_PARALLEL_WRITE_UNAVAILABLE",
        "非 Git 项目不能在同一目录并行运行多个写入子 Session",
        409,
        true,
      );
    }

    const allocations = [];
    let writerIndex = 0;
    for (const task of tasks) {
      if (task.mode === "read" || !sourceWorkspace.isGit) {
        allocations.push({
          cwd: sourceWorkspace.rootPath,
          workspaceId: sourceWorkspace.id,
          kind: "shared_workspace",
          persistent: true,
        });
        continue;
      }

      writerIndex += 1;
      const currentSource = await workspaceRegistry.resolveWorkspace({
        project,
        workspaceId: sourceWorkspace.id,
      });
      if (!currentSource.isGit || typeof currentSource.head !== "string") {
        throw projectWorkError(
          "PROJECT_WORK_CHILD_SESSION_WORKTREE_UNAVAILABLE",
          "当前 Git Workspace 无法创建写入子 Session",
          409,
          true,
        );
      }
      const created = await workspaceRegistry.createWorktree({
        project,
        sourceWorkspaceId: currentSource.id,
        expectedHead: currentSource.head,
        title: CHILD_SESSION_WORKTREE_TITLE,
        label: writers.length > 1
          ? `子任务 Workspace ${writerIndex}`
          : "子任务 Workspace",
        // A registered child worktree is created from the source HEAD without
        // mutating source files, so the parent turn does not block this step.
        busy: false,
      });
      const childWorkspace = await workspaceRegistry.resolveWorkspace({
        project,
        workspaceId: created.id,
      });
      allocations.push({
        cwd: childWorkspace.rootPath,
        workspaceId: childWorkspace.id,
        kind: "persistent_worktree",
        persistent: true,
      });
    }
    return allocations;
  };
}
