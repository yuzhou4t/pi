import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { promisify } from "node:util";
import {
  createSafeWorktreeBranchName,
  createWorkspaceRegistry,
  parseGitWorktreePorcelain,
} from "./workspaceRegistry.js";

const execFileAsync = promisify(execFile);

function sequentialIds(prefix = "fixture") {
  let index = 0;
  return () => `${prefix}-${++index}`;
}

async function git(cwd, ...args) {
  return execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
}

async function makeGitProject(temporaryRoot) {
  const repositoryRoot = path.join(temporaryRoot, "repository");
  const projectRoot = path.join(repositoryRoot, "apps", "demo");
  await mkdir(projectRoot, { recursive: true });
  await execFileAsync("git", ["init", repositoryRoot]);
  await git(repositoryRoot, "config", "user.name", "Pi Agent Test");
  await git(repositoryRoot, "config", "user.email", "pi-agent@example.invalid");
  await git(repositoryRoot, "checkout", "-b", "main");
  await writeFile(path.join(repositoryRoot, "README.md"), "fixture\n");
  await writeFile(path.join(projectRoot, "package.json"), "{}\n");
  await git(repositoryRoot, "add", "README.md", "apps/demo/package.json");
  await git(repositoryRoot, "commit", "-m", "fixture");
  return {
    repositoryRoot,
    projectRoot,
    project: {
      id: "project-git-fixture",
      name: "Git fixture",
      rootLabel: "demo",
      rootPath: projectRoot,
    },
  };
}

test("Git porcelain parsing retains valid records and marks unusable records", () => {
  const parsed = parseGitWorktreePorcelain([
    "worktree /tmp/main",
    "HEAD 0123456789abcdef",
    "branch refs/heads/main",
    "",
    "worktree /tmp/locked",
    "HEAD fedcba9876543210",
    "detached",
    "locked maintenance",
    "",
    "worktree /tmp/gone",
    "HEAD 0011223344556677",
    "branch refs/heads/pi/gone",
    "prunable gitdir file points to non-existent location",
    "",
  ].join("\0"));

  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].branch, "refs/heads/main");
  assert.equal(parsed[1].detached, true);
  assert.equal(parsed[1].locked, "maintenance");
  assert.match(parsed[2].prunable, /non-existent/);
});

test("safe worktree branch names are deterministic and never embed Chinese prompt text", () => {
  assert.equal(
    createSafeWorktreeBranchName("修复 设置页面", "conversation-1234567890"),
    "pi/task-1234567890",
  );
  assert.equal(
    createSafeWorktreeBranchName("Fix settings footer", "ABC-123"),
    "pi/fix-settings-footer-abc123",
  );
});

test("a non-Git project has one persistent public-safe Workspace", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-workspace-registry-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "plain-project");
  const storageRoot = path.join(temporaryRoot, "state");
  await mkdir(projectRoot);
  const project = {
    id: "project-plain",
    name: "Plain project",
    rootLabel: "plain-project",
    rootPath: projectRoot,
  };
  const registry = createWorkspaceRegistry({
    storageRoot,
    idFactory: sequentialIds("plain"),
    now: () => new Date("2026-08-01T01:02:03.000Z"),
  });

  const [workspace] = await registry.list({
    project,
    conversationCounts: {},
  });
  assert.deepEqual(workspace, {
    id: "workspace-plain-1",
    projectId: "project-plain",
    label: "项目目录",
    kind: "project_root",
    isMain: true,
    isGit: false,
    branch: null,
    head: null,
    dirty: false,
    status: "available",
    conversationCount: 0,
    updatedAt: "2026-08-01T01:02:03.000Z",
  });
  assert.equal(JSON.stringify(workspace).includes(temporaryRoot), false);
  assert.equal(Object.hasOwn(workspace, "rootPath"), false);
  assert.equal(Object.hasOwn(workspace, "gitWorktreeRoot"), false);

  await registry.rememberLastWorkspace({ project, workspaceId: workspace.id });
  const restarted = createWorkspaceRegistry({
    storageRoot,
    idFactory: () => "must-not-replace-the-existing-id",
  });
  assert.equal(await restarted.getLastWorkspaceId(project.id), workspace.id);
  assert.equal((await restarted.selectWorkspace({ project })).id, workspace.id);
  assert.equal((await restarted.list({ project }))[0].id, workspace.id);

  const privateWorkspace = await restarted.resolveWorkspace({
    project,
    workspaceId: workspace.id,
  });
  assert.equal(privateWorkspace.rootPath, await realpath(projectRoot));
  assert.equal(privateWorkspace.projectSubpath, "");
});

test("Git discovery maps the same project subpath into main and linked worktrees", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-workspace-git-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const fixture = await makeGitProject(temporaryRoot);
  const linkedRoot = path.join(temporaryRoot, "linked-worktree");
  await git(
    fixture.repositoryRoot,
    "worktree",
    "add",
    "-b",
    "pi/linked-fixture",
    linkedRoot,
    "HEAD",
  );
  const registry = createWorkspaceRegistry({
    storageRoot: path.join(temporaryRoot, "state"),
    idFactory: sequentialIds("git"),
  });

  const workspaces = await registry.list({
    project: fixture.project,
    conversationCounts: new Map(),
  });
  assert.equal(workspaces.length, 2);
  assert.equal(workspaces[0].isMain, true);
  assert.equal(workspaces[0].kind, "project_root");
  assert.equal(workspaces[0].branch, "main");
  assert.equal(workspaces[1].isMain, false);
  assert.equal(workspaces[1].kind, "git_worktree");
  assert.equal(workspaces[1].branch, "pi/linked-fixture");
  assert.equal(JSON.stringify(workspaces).includes(temporaryRoot), false);

  const linked = await registry.resolveWorkspace({
    project: fixture.project,
    workspaceId: workspaces[1].id,
  });
  assert.equal(linked.rootPath, await realpath(path.join(linkedRoot, "apps", "demo")));
  assert.equal(linked.gitWorktreeRoot, await realpath(linkedRoot));
  assert.equal(linked.projectSubpath, "apps/demo");

  const relisted = await registry.list({ project: fixture.project });
  assert.deepEqual(
    relisted.map(({ id, branch }) => ({ id, branch })),
    workspaces.map(({ id, branch }) => ({ id, branch })),
  );
});

test("worktree creation uses exact argv, persists selection, and rejects unsafe branches", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-workspace-create-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const fixture = await makeGitProject(temporaryRoot);
  const calls = [];
  const run = async (file, args, options) => {
    calls.push({ file, args: [...args], options: { ...options } });
    return execFileAsync(file, args, options);
  };
  const registry = createWorkspaceRegistry({
    storageRoot: path.join(temporaryRoot, "state"),
    idFactory: sequentialIds("created"),
    run,
  });
  const [main] = await registry.list({ project: fixture.project });

  await assert.rejects(
    registry.createWorktree({
      project: fixture.project,
      sourceWorkspaceId: main.id,
      branchName: "pi/safe;touch-pwned",
      busy: false,
    }),
    (error) => error?.code === "PROJECT_WORK_WORKTREE_BRANCH_INVALID",
  );
  assert.equal(
    calls.some((call) => call.args.includes("pi/safe;touch-pwned")),
    false,
  );

  const created = await registry.createWorktree({
    project: fixture.project,
    sourceWorkspaceId: main.id,
    branchName: "pi/workspace-registry-test",
    label: fixture.projectRoot,
    busy: false,
  });
  assert.equal(created.kind, "git_worktree");
  assert.equal(created.branch, "pi/workspace-registry-test");
  assert.equal(created.label, "pi/workspace-registry-test");
  assert.equal(JSON.stringify(created).includes(temporaryRoot), false);
  assert.equal(await registry.getLastWorkspaceId(fixture.project.id), created.id);
  assert.equal((await registry.selectWorkspace({ project: fixture.project })).id, created.id);

  const privateWorkspace = await registry.resolveWorkspace({
    project: fixture.project,
    workspaceId: created.id,
  });
  await access(path.join(privateWorkspace.rootPath, "package.json"));
  const addCall = calls.find((call) => call.args.includes("add"));
  assert.equal(addCall.file, "git");
  assert.equal(addCall.args.includes("-b"), true);
  assert.equal(addCall.args.includes("pi/workspace-registry-test"), true);
  assert.equal(addCall.options.shell, undefined);
});

test("worktree deletion is head-bound and refuses main, busy, dirty, or forced removal", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-workspace-delete-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const fixture = await makeGitProject(temporaryRoot);
  const calls = [];
  const run = async (file, args, options) => {
    calls.push({ file, args: [...args] });
    return execFileAsync(file, args, options);
  };
  const registry = createWorkspaceRegistry({
    storageRoot: path.join(temporaryRoot, "state"),
    idFactory: sequentialIds("delete"),
    run,
  });
  const [main] = await registry.list({ project: fixture.project });
  const created = await registry.createWorktree({
    project: fixture.project,
    sourceWorkspaceId: main.id,
    branchName: "pi/delete-fixture",
    busy: false,
  });

  await assert.rejects(
    registry.removeWorktree({
      project: fixture.project,
      workspaceId: main.id,
      expectedHead: main.head,
      busy: false,
    }),
    (error) => error?.code === "PROJECT_WORK_WORKTREE_DELETE_FORBIDDEN",
  );
  await assert.rejects(
    registry.removeWorktree({
      project: fixture.project,
      workspaceId: created.id,
      expectedHead: created.head,
      busy: true,
    }),
    (error) => error?.code === "PROJECT_WORK_WORKSPACE_BUSY",
  );
  await assert.rejects(
    registry.removeWorktree({
      project: fixture.project,
      workspaceId: created.id,
      expectedHead: "0000000000000000000000000000000000000000",
      busy: false,
    }),
    (error) => error?.code === "PROJECT_WORK_WORKTREE_STALE",
  );

  const privateWorkspace = await registry.resolveWorkspace({
    project: fixture.project,
    workspaceId: created.id,
  });
  const dirtyFile = path.join(privateWorkspace.rootPath, "dirty.txt");
  await writeFile(dirtyFile, "dirty\n");
  await assert.rejects(
    registry.removeWorktree({
      project: fixture.project,
      workspaceId: created.id,
      expectedHead: created.head,
      busy: false,
    }),
    (error) => error?.code === "PROJECT_WORK_WORKTREE_DIRTY",
  );
  await rm(dirtyFile);

  const removed = await registry.removeWorktree({
    project: fixture.project,
    workspaceId: created.id,
    expectedHead: created.head,
    busy: false,
  });
  assert.equal(removed.id, created.id);
  await assert.rejects(access(privateWorkspace.gitWorktreeRoot));
  assert.equal(await registry.getLastWorkspaceId(fixture.project.id), main.id);
  assert.equal((await registry.list({ project: fixture.project })).length, 1);

  const removeCall = calls.find((call) => call.args.includes("remove"));
  assert.ok(removeCall);
  assert.equal(removeCall.args.includes("--force"), false);
  assert.equal(removeCall.args.includes("-f"), false);
});

test("public summaries expose counts and busy state without private roots", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-workspace-public-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  await mkdir(projectRoot);
  const project = {
    id: "project-public",
    rootPath: projectRoot,
    rootLabel: "project",
  };
  const registry = createWorkspaceRegistry({
    storageRoot: path.join(temporaryRoot, "state"),
    idFactory: sequentialIds("public"),
  });
  const [initial] = await registry.list({ project });
  const [summary] = await registry.list({
    project,
    conversationCounts: { [initial.id]: 7 },
    busyWorkspaceIds: [initial.id],
  });

  assert.equal(summary.conversationCount, 7);
  assert.equal(summary.status, "busy");
  assert.deepEqual(Object.keys(summary), [
    "id",
    "projectId",
    "label",
    "kind",
    "isMain",
    "isGit",
    "branch",
    "head",
    "dirty",
    "status",
    "conversationCount",
    "updatedAt",
  ]);
  const stored = await readFile(path.join(temporaryRoot, "state", "workspaces.json"), "utf8");
  assert.equal(stored.includes(projectRoot), true);
  assert.equal(JSON.stringify(summary).includes(projectRoot), false);
});
