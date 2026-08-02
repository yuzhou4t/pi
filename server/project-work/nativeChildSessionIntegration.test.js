import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProjectWorkService } from "./projectWorkService.js";

function modelCatalog() {
  return {
    defaultProviderId: "deepseek",
    defaultModelId: "deepseek-v4-flash",
    providers: [{
      id: "deepseek",
      label: "DeepSeek",
      models: [{
        id: "deepseek-v4-flash",
        label: "DeepSeek V4 Flash",
        thinkingLevels: ["off", "medium", "high", "ultra"],
        defaultThinkingLevel: "medium",
      }],
    }],
  };
}

function settledSessionFactory(onAllocations) {
  const factory = async (options) => {
    let listener = null;
    return {
      subscribe(next) {
        listener = next;
        return () => {
          listener = null;
        };
      },
      setActiveToolsByName(names) {
        return [...names];
      },
      async prompt() {
        const allocations = await options.prepareNativeChildWorkspaces({
          tasks: [{ mode: "write", model: "deepseek/deepseek-v4-flash" }, {
            mode: "write",
            model: "openai-codex/gpt-5.6-sol",
          }],
        });
        onAllocations(allocations);
        listener?.({ type: "agent_start" });
        listener?.({ type: "turn_start" });
        listener?.({
          type: "message_start",
          message: { role: "assistant" },
        });
        listener?.({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "两个子 Session 已准备。" }],
            stopReason: "stop",
          },
        });
        listener?.({ type: "turn_end" });
        listener?.({ type: "agent_end", willRetry: false });
        listener?.({ type: "agent_settled" });
      },
      async steer() {},
      async abort() {},
      async compact() {},
      async setModel() {},
      dispose() {},
    };
  };
  factory.listModels = async () => modelCatalog();
  factory.dispose = async () => {};
  return factory;
}

test("ProjectWorkService allocates persistent child worktrees without a project snapshot", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-native-child-service-"));
  let service = null;
  t.after(async () => {
    await service?.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const projectRoot = path.join(root, "project");
  const storageRoot = path.join(root, "state");
  await mkdir(projectRoot);
  await writeFile(path.join(projectRoot, "app.js"), "export const ready = true;\n");

  const sourceWorkspace = {
    id: "workspace-main",
    projectId: "project-native-child",
    rootPath: projectRoot,
    gitWorktreeRoot: projectRoot,
    projectSubpath: "",
    label: "主工作区",
    kind: "git_main",
    isMain: true,
    isGit: true,
    branch: "main",
    head: "abc123",
    dirty: false,
    locked: false,
    updatedAt: "2026-08-02T00:00:00.000Z",
  };
  const worktrees = new Map();
  const createCalls = [];
  const workspaceRegistry = {
    async selectWorkspace({ project }) {
      return { ...sourceWorkspace, projectId: project.id };
    },
    async resolveWorkspace({ project, workspaceId }) {
      if (workspaceId === sourceWorkspace.id) {
        return { ...sourceWorkspace, projectId: project.id };
      }
      return worktrees.get(workspaceId);
    },
    async createWorktree(input) {
      createCalls.push(input);
      const id = `child-worktree-${createCalls.length}`;
      const rootPath = path.join(root, id);
      await mkdir(rootPath);
      worktrees.set(id, {
        ...sourceWorkspace,
        id,
        rootPath,
        gitWorktreeRoot: rootPath,
        isMain: false,
        kind: "git_worktree",
        label: input.label,
      });
      return { id };
    },
    async list() {
      return [];
    },
    async rememberLastWorkspace() {},
    async removeWorktree() {},
  };
  let allocations = null;
  service = createProjectWorkService({
    storageRoot,
    picker: async () => ({ rootPath: projectRoot }),
    workspaceRegistry,
    snapshotter: async () => {
      throw new Error("native child sessions must not create project snapshots");
    },
    sessionFactory: settledSessionFactory((value) => {
      allocations = value;
    }),
  });
  const selection = await service.pickProjectRoot({ mode: "existing" });
  const project = await service.registerProject({
    selectionId: selection.selectionId,
  });
  const conversation = await service.createConversation(project.id);
  await service.sendMessage(conversation.id, { text: "并行实现两个方案" });

  assert.equal(createCalls.length, 2);
  assert.deepEqual(allocations.map((allocation) => allocation.kind), [
    "persistent_worktree",
    "persistent_worktree",
  ]);
  assert.notEqual(allocations[0].cwd, allocations[1].cwd);
  assert.ok(allocations.every((allocation) => allocation.persistent === true));
  assert.ok(createCalls.every((call) => call.busy === false));
  assert.ok(createCalls.every((call) => call.title === "child-session"));
});
