import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { projectWorkError } from "./errors.js";

const execFileAsync = promisify(execFile);
const REGISTRY_SCHEMA_VERSION = 1;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/;
const SAFE_PI_BRANCH_PATTERN = /^pi\/[a-z0-9](?:[a-z0-9._-]{0,78}[a-z0-9])?$/;
const GIT_MAX_BUFFER = 2 * 1024 * 1024;

function assertProject(project) {
  if (
    !project
    || typeof project !== "object"
    || typeof project.id !== "string"
    || !PROJECT_ID_PATTERN.test(project.id)
    || typeof project.rootPath !== "string"
    || !path.isAbsolute(project.rootPath)
  ) {
    throw projectWorkError(
      "PROJECT_WORK_WORKSPACE_PROJECT_INVALID",
      "Workspace 绑定的项目无效",
      400,
    );
  }
  return project;
}

function assertProjectId(projectId) {
  if (typeof projectId !== "string" || !PROJECT_ID_PATTERN.test(projectId)) {
    throw projectWorkError(
      "PROJECT_WORK_PROJECT_ID_INVALID",
      "项目标识无效",
      400,
    );
  }
  return projectId;
}

function assertWorkspaceId(workspaceId) {
  if (typeof workspaceId !== "string" || !WORKSPACE_ID_PATTERN.test(workspaceId)) {
    throw projectWorkError(
      "PROJECT_WORK_WORKSPACE_ID_INVALID",
      "Workspace 标识无效",
      400,
    );
  }
  return workspaceId;
}

function compactLabel(value, fallback) {
  const label = String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replaceAll(/\s+/g, " ")
    .slice(0, 80);
  if (!label || path.posix.isAbsolute(label) || path.win32.isAbsolute(label)) {
    return fallback;
  }
  return label;
}

function isInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function toProjectSubpath(gitRoot, projectRoot) {
  const relative = path.relative(gitRoot, projectRoot);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw projectWorkError(
      "PROJECT_WORK_WORKSPACE_PROJECT_INVALID",
      "项目目录不在 Git 工作区内",
      409,
    );
  }
  return relative.split(path.sep).filter(Boolean).join("/");
}

function resolveProjectSubpath(worktreeRoot, projectSubpath) {
  return projectSubpath
    ? path.join(worktreeRoot, ...projectSubpath.split("/"))
    : worktreeRoot;
}

function defaultRegistry() {
  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    projects: [],
  };
}

function validStoredWorkspace(workspace, projectId) {
  return workspace
    && typeof workspace === "object"
    && WORKSPACE_ID_PATTERN.test(workspace.id)
    && workspace.projectId === projectId
    && (workspace.kind === "project_root" || workspace.kind === "git_worktree")
    && typeof workspace.rootPath === "string"
    && path.isAbsolute(workspace.rootPath)
    && (
      workspace.gitWorktreeRoot === null
      || (
        typeof workspace.gitWorktreeRoot === "string"
        && path.isAbsolute(workspace.gitWorktreeRoot)
      )
    )
    && typeof workspace.projectSubpath === "string"
    && !path.posix.isAbsolute(workspace.projectSubpath)
    && !workspace.projectSubpath.split("/").includes("..")
    && typeof workspace.isMain === "boolean"
    && typeof workspace.isGit === "boolean"
    && (workspace.branch === null || typeof workspace.branch === "string")
    && (workspace.head === null || typeof workspace.head === "string")
    && typeof workspace.dirty === "boolean"
    && typeof workspace.locked === "boolean"
    && typeof workspace.label === "string"
    && typeof workspace.createdAt === "string"
    && typeof workspace.updatedAt === "string";
}

function validateRegistry(registry) {
  const projectIds = Array.isArray(registry?.projects)
    ? registry.projects.map((project) => project?.projectId)
    : [];
  const valid = registry
    && registry.schemaVersion === REGISTRY_SCHEMA_VERSION
    && Array.isArray(registry.projects)
    && new Set(projectIds).size === projectIds.length
    && registry.projects.every((project) => (
      project
      && typeof project === "object"
      && typeof project.projectId === "string"
      && PROJECT_ID_PATTERN.test(project.projectId)
      && Array.isArray(project.workspaces)
      && project.workspaces.every(
        (workspace) => validStoredWorkspace(workspace, project.projectId),
      )
      && new Set(project.workspaces.map((workspace) => workspace.id)).size
        === project.workspaces.length
      && (
        project.lastWorkspaceId === null
        || project.lastWorkspaceId === undefined
        || (
          typeof project.lastWorkspaceId === "string"
          && WORKSPACE_ID_PATTERN.test(project.lastWorkspaceId)
        )
      )
    ));
  if (!valid) {
    throw projectWorkError(
      "PROJECT_WORK_WORKSPACE_REGISTRY_INVALID",
      "Workspace 注册表格式无效",
      500,
    );
  }
  return registry;
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporaryPath, filePath);
}

function projectStateFor(registry, projectId) {
  let projectState = registry.projects.find((item) => item.projectId === projectId);
  if (!projectState) {
    projectState = {
      projectId,
      lastWorkspaceId: null,
      workspaces: [],
    };
    registry.projects.push(projectState);
  }
  return projectState;
}

function countFor(conversationCounts, workspaceId) {
  const raw = conversationCounts instanceof Map
    ? conversationCounts.get(workspaceId)
    : conversationCounts?.[workspaceId];
  return Number.isSafeInteger(raw) && raw >= 0 ? raw : 0;
}

function busySet(value) {
  if (value instanceof Set) return value;
  return new Set(Array.isArray(value) ? value : []);
}

export function publicWorkspace(
  workspace,
  { conversationCount = 0, busy = false } = {},
) {
  return {
    id: workspace.id,
    projectId: workspace.projectId,
    label: compactLabel(
      workspace.label,
      workspace.isMain ? (workspace.isGit ? "主工作区" : "项目目录") : "Workspace",
    ),
    kind: workspace.kind,
    isMain: workspace.isMain,
    isGit: workspace.isGit,
    branch: workspace.branch,
    head: workspace.head,
    dirty: workspace.dirty,
    status: busy ? "busy" : workspace.locked ? "locked" : "available",
    conversationCount: Number.isSafeInteger(conversationCount) && conversationCount >= 0
      ? conversationCount
      : 0,
    updatedAt: workspace.updatedAt,
  };
}

export function parseGitWorktreePorcelain(value) {
  const records = [];
  let record = null;
  for (const field of String(value ?? "").split("\0")) {
    if (!field) {
      if (record?.worktree) records.push(record);
      record = null;
      continue;
    }
    record ??= {};
    const separator = field.indexOf(" ");
    const key = separator < 0 ? field : field.slice(0, separator);
    const fieldValue = separator < 0 ? true : field.slice(separator + 1);
    if (key === "worktree") record.worktree = fieldValue;
    else if (key === "HEAD") record.head = fieldValue;
    else if (key === "branch") record.branch = fieldValue;
    else if (key === "detached") record.detached = true;
    else if (key === "bare") record.bare = true;
    else if (key === "locked") record.locked = fieldValue;
    else if (key === "prunable") record.prunable = fieldValue;
  }
  if (record?.worktree) records.push(record);
  return records;
}

function safeBranchSuffix(value) {
  const suffix = String(value ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/g, "")
    .slice(-10);
  return suffix || "workspace";
}

export function createSafeWorktreeBranchName(title, shortId) {
  const slug = String(title ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 48)
    .replaceAll(/-+$/g, "") || "task";
  return `pi/${slug}-${safeBranchSuffix(shortId)}`;
}

function validateSafeBranchName(branchName) {
  if (
    typeof branchName !== "string"
    || branchName !== branchName.trim()
    || branchName !== branchName.normalize("NFKC")
    || !SAFE_PI_BRANCH_PATTERN.test(branchName)
    || branchName.includes("..")
    || branchName.includes("@{")
    || branchName.endsWith(".lock")
  ) {
    throw projectWorkError(
      "PROJECT_WORK_WORKTREE_BRANCH_INVALID",
      "新 Workspace 的 Git 分支名无效",
      400,
    );
  }
  return branchName;
}

function shortBranchName(ref) {
  const prefix = "refs/heads/";
  return typeof ref === "string" && ref.startsWith(prefix)
    ? ref.slice(prefix.length)
    : null;
}

function safeHead(value) {
  return typeof value === "string" && /^[0-9a-f]{7,64}$/i.test(value)
    ? value.toLowerCase()
    : null;
}

function isNotGitRepository(error) {
  if (typeof error?.code !== "number") return false;
  const diagnostic = `${error?.stderr ?? ""}\n${error?.stdout ?? ""}`.toLowerCase();
  return diagnostic.includes("not a git repository")
    || diagnostic.includes("not in a git directory");
}

function workspaceIdFrom(factory) {
  const value = `workspace-${factory()}`;
  if (!WORKSPACE_ID_PATTERN.test(value)) {
    throw new Error("idFactory returned an unsafe workspace id");
  }
  return value;
}

function entryChanged(previous, next) {
  const keys = [
    "kind",
    "rootPath",
    "gitWorktreeRoot",
    "projectSubpath",
    "isMain",
    "isGit",
    "branch",
    "head",
    "dirty",
    "locked",
    "label",
  ];
  return keys.some((key) => previous?.[key] !== next[key]);
}

function safeGitFailure(code, message, retryable = false) {
  return projectWorkError(code, message, 409, retryable);
}

export function createWorkspaceRegistry({
  storageRoot,
  now = () => new Date(),
  idFactory = randomUUID,
  run = execFileAsync,
} = {}) {
  if (typeof storageRoot !== "string" || !storageRoot.trim()) {
    throw new Error("storageRoot is required");
  }
  if (typeof run !== "function") throw new Error("run must be a function");

  const registryPath = path.resolve(storageRoot, "workspaces.json");
  const managedWorktreeRoot = path.resolve(storageRoot, "git-worktrees");
  let writeQueue = Promise.resolve();

  function withWriteLock(operation) {
    const current = writeQueue.catch(() => undefined).then(operation);
    writeQueue = current;
    return current;
  }

  async function load() {
    return validateRegistry(await readJson(registryPath, defaultRegistry()));
  }

  async function runGit(args) {
    return run("git", args, {
      encoding: "utf8",
      maxBuffer: GIT_MAX_BUFFER,
      windowsHide: true,
    });
  }

  async function canonicalProjectRoot(project) {
    assertProject(project);
    let root;
    let stat;
    try {
      [root, stat] = await Promise.all([
        realpath(project.rootPath),
        lstat(project.rootPath),
      ]);
    } catch {
      throw projectWorkError(
        "PROJECT_WORK_ROOT_NOT_FOUND",
        "项目文件夹当前不可用",
        404,
        true,
      );
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw projectWorkError(
        "PROJECT_WORK_ROOT_INVALID",
        "项目根目录必须是普通文件夹",
        409,
      );
    }
    return root;
  }

  async function gitRootFor(projectRoot) {
    try {
      const { stdout } = await runGit([
        "-C",
        projectRoot,
        "rev-parse",
        "--show-toplevel",
      ]);
      return realpath(String(stdout).trim());
    } catch (error) {
      if (isNotGitRepository(error)) return null;
      throw safeGitFailure(
        "PROJECT_WORK_GIT_INSPECTION_FAILED",
        "无法检查项目的 Git Workspace",
        true,
      );
    }
  }

  async function inspectMappedRoot(worktreeRoot, projectSubpath) {
    let canonicalWorktreeRoot;
    let mappedStat;
    let canonicalRoot;
    try {
      canonicalWorktreeRoot = await realpath(worktreeRoot);
      const mappedRoot = resolveProjectSubpath(canonicalWorktreeRoot, projectSubpath);
      [mappedStat, canonicalRoot] = await Promise.all([
        lstat(mappedRoot),
        realpath(mappedRoot),
      ]);
    } catch {
      return null;
    }
    if (
      !mappedStat.isDirectory()
      || mappedStat.isSymbolicLink()
      || !isInside(canonicalWorktreeRoot, canonicalRoot)
    ) {
      return null;
    }
    return { canonicalRoot, canonicalWorktreeRoot };
  }

  async function inspectProject(project) {
    const projectRoot = await canonicalProjectRoot(project);
    const gitTopLevel = await gitRootFor(projectRoot);
    if (!gitTopLevel) {
      return [{
        projectId: project.id,
        kind: "project_root",
        rootPath: projectRoot,
        gitWorktreeRoot: null,
        projectSubpath: "",
        isMain: true,
        isGit: false,
        branch: null,
        head: null,
        dirty: false,
        locked: false,
        label: "项目目录",
      }];
    }

    const projectSubpath = toProjectSubpath(gitTopLevel, projectRoot);
    let records;
    try {
      const { stdout } = await runGit([
        "-C",
        gitTopLevel,
        "worktree",
        "list",
        "--porcelain",
        "-z",
      ]);
      records = parseGitWorktreePorcelain(stdout);
    } catch {
      throw safeGitFailure(
        "PROJECT_WORK_GIT_INSPECTION_FAILED",
        "无法读取 Git Workspace 列表",
        true,
      );
    }
    if (records.length === 0) {
      throw safeGitFailure(
        "PROJECT_WORK_GIT_INSPECTION_FAILED",
        "Git Workspace 列表为空",
        true,
      );
    }

    const workspaces = [];
    for (const [index, record] of records.entries()) {
      if (!record.worktree || record.prunable || record.bare) continue;
      const mapped = await inspectMappedRoot(record.worktree, projectSubpath);
      if (!mapped) {
        if (index === 0) {
          throw safeGitFailure(
            "PROJECT_WORK_GIT_INSPECTION_FAILED",
            "Git 主 Workspace 当前不可用",
            true,
          );
        }
        continue;
      }
      let dirty;
      try {
        const { stdout } = await runGit([
          "-C",
          mapped.canonicalWorktreeRoot,
          "status",
          "--porcelain=v1",
          "--untracked-files=normal",
        ]);
        dirty = String(stdout).length > 0;
      } catch {
        throw safeGitFailure(
          "PROJECT_WORK_GIT_INSPECTION_FAILED",
          "无法检查 Git Workspace 状态",
          true,
        );
      }
      const branch = shortBranchName(record.branch);
      workspaces.push({
        projectId: project.id,
        kind: index === 0 ? "project_root" : "git_worktree",
        rootPath: mapped.canonicalRoot,
        gitWorktreeRoot: mapped.canonicalWorktreeRoot,
        projectSubpath,
        isMain: index === 0,
        isGit: true,
        branch,
        head: safeHead(record.head),
        dirty,
        locked: Boolean(record.locked),
        label: index === 0 ? "主工作区" : (branch || "分离 HEAD"),
      });
    }
    return workspaces;
  }

  async function reconcile(project, registry) {
    const projectState = projectStateFor(registry, project.id);
    const inspected = await inspectProject(project);
    const timestamp = now().toISOString();
    const nextEntries = inspected.map((workspace) => {
      const previous = projectState.workspaces.find(
        (entry) => entry.rootPath === workspace.rootPath,
      );
      const next = {
        ...workspace,
        id: previous?.id ?? workspaceIdFrom(idFactory),
        label: compactLabel(previous?.label, workspace.label),
        createdAt: previous?.createdAt ?? timestamp,
        updatedAt: previous?.updatedAt ?? timestamp,
      };
      if (previous && entryChanged(previous, next)) next.updatedAt = timestamp;
      return next;
    });
    projectState.workspaces = nextEntries;
    if (
      projectState.lastWorkspaceId
      && !nextEntries.some((entry) => entry.id === projectState.lastWorkspaceId)
    ) {
      projectState.lastWorkspaceId = null;
    }
    return { projectState, workspaces: nextEntries };
  }

  async function saveIfChanged(registry, before) {
    if (JSON.stringify(registry) !== before) {
      await writeJsonAtomic(registryPath, registry);
    }
  }

  async function list({
    project,
    conversationCounts = {},
    busyWorkspaceIds = [],
  } = {}) {
    assertProject(project);
    return withWriteLock(async () => {
      const registry = await load();
      const before = JSON.stringify(registry);
      const { workspaces } = await reconcile(project, registry);
      await saveIfChanged(registry, before);
      const busy = busySet(busyWorkspaceIds);
      return workspaces.map((workspace) => publicWorkspace(workspace, {
        conversationCount: countFor(conversationCounts, workspace.id),
        busy: busy.has(workspace.id),
      }));
    });
  }

  async function resolveWorkspace({ project, workspaceId } = {}) {
    assertProject(project);
    const id = assertWorkspaceId(workspaceId);
    return withWriteLock(async () => {
      const registry = await load();
      const before = JSON.stringify(registry);
      const { workspaces } = await reconcile(project, registry);
      await saveIfChanged(registry, before);
      const workspace = workspaces.find((item) => item.id === id);
      if (!workspace) {
        throw projectWorkError(
          "PROJECT_WORK_WORKSPACE_NOT_FOUND",
          "Workspace 不存在或当前不可用",
          404,
        );
      }
      return structuredClone(workspace);
    });
  }

  async function getLastWorkspaceId(projectId) {
    const id = assertProjectId(projectId);
    const registry = await load();
    const projectState = registry.projects.find((item) => item.projectId === id);
    return typeof projectState?.lastWorkspaceId === "string"
      ? projectState.lastWorkspaceId
      : null;
  }

  async function rememberLastWorkspace({ project, workspaceId } = {}) {
    assertProject(project);
    const id = assertWorkspaceId(workspaceId);
    return withWriteLock(async () => {
      const registry = await load();
      const before = JSON.stringify(registry);
      const { projectState, workspaces } = await reconcile(project, registry);
      if (!workspaces.some((workspace) => workspace.id === id)) {
        throw projectWorkError(
          "PROJECT_WORK_WORKSPACE_NOT_FOUND",
          "Workspace 不存在或当前不可用",
          404,
        );
      }
      projectState.lastWorkspaceId = id;
      await saveIfChanged(registry, before);
      return id;
    });
  }

  async function selectWorkspace({ project, workspaceId = null } = {}) {
    assertProject(project);
    if (workspaceId !== null) assertWorkspaceId(workspaceId);
    return withWriteLock(async () => {
      const registry = await load();
      const before = JSON.stringify(registry);
      const { projectState, workspaces } = await reconcile(project, registry);
      const selectedId = workspaceId ?? projectState.lastWorkspaceId;
      const selected = workspaces.find((workspace) => workspace.id === selectedId)
        ?? workspaces.find((workspace) => workspace.isMain);
      if (!selected) {
        throw projectWorkError(
          "PROJECT_WORK_WORKSPACE_NOT_FOUND",
          "没有可用的 Workspace",
          404,
        );
      }
      if (workspaceId && selected.id !== workspaceId) {
        throw projectWorkError(
          "PROJECT_WORK_WORKSPACE_NOT_FOUND",
          "Workspace 不存在或当前不可用",
          404,
        );
      }
      projectState.lastWorkspaceId = selected.id;
      await saveIfChanged(registry, before);
      return structuredClone(selected);
    });
  }

  async function createWorktree({
    project,
    sourceWorkspaceId,
    expectedHead = null,
    branchName = null,
    title = "task",
    label = null,
    busy = false,
  } = {}) {
    assertProject(project);
    const sourceId = assertWorkspaceId(sourceWorkspaceId);
    if (typeof busy !== "boolean") {
      throw projectWorkError(
        "PROJECT_WORK_WORKSPACE_BUSY_STATE_REQUIRED",
        "创建 Workspace 前必须确认当前运行状态",
        400,
      );
    }
    if (busy) {
      throw projectWorkError(
        "PROJECT_WORK_WORKSPACE_BUSY",
        "当前 Workspace 正在运行任务，暂不能创建 worktree",
        409,
        true,
      );
    }

    return withWriteLock(async () => {
      const registry = await load();
      const before = JSON.stringify(registry);
      const { projectState, workspaces } = await reconcile(project, registry);
      const source = workspaces.find((workspace) => workspace.id === sourceId);
      if (!source) {
        throw projectWorkError(
          "PROJECT_WORK_WORKSPACE_NOT_FOUND",
          "源 Workspace 不存在或当前不可用",
          404,
        );
      }
      if (!source.isGit) {
        throw projectWorkError(
          "PROJECT_WORK_WORKTREE_REQUIRES_GIT",
          "只有 Git 项目可以创建 worktree",
          409,
        );
      }
      if (expectedHead !== null && source.head !== expectedHead) {
        throw projectWorkError(
          "PROJECT_WORK_WORKTREE_STALE",
          "源 Workspace 的 HEAD 已变化，请重新确认",
          409,
          true,
        );
      }

      if (source.projectSubpath) {
        let trackedSubpath = false;
        try {
          const { stdout } = await runGit([
            "-C",
            source.gitWorktreeRoot,
            "ls-tree",
            "-z",
            "-d",
            "--full-name",
            "HEAD",
            "--",
            source.projectSubpath,
          ]);
          trackedSubpath = String(stdout)
            .split("\0")
            .some((entry) => entry.endsWith(`\t${source.projectSubpath}`));
        } catch {
          trackedSubpath = false;
        }
        if (!trackedSubpath) {
          throw projectWorkError(
            "PROJECT_WORK_WORKTREE_SUBPATH_UNAVAILABLE",
            "项目子目录尚未存在于当前 HEAD，不能创建对应 worktree",
            409,
          );
        }
      }

      const workspaceId = workspaceIdFrom(idFactory);
      const branch = validateSafeBranchName(
        branchName ?? createSafeWorktreeBranchName(title, workspaceId),
      );
      try {
        await runGit(["check-ref-format", "--branch", branch]);
      } catch {
        throw projectWorkError(
          "PROJECT_WORK_WORKTREE_BRANCH_INVALID",
          "新 Workspace 的 Git 分支名无效",
          400,
        );
      }

      const targetParent = path.resolve(managedWorktreeRoot, project.id);
      await mkdir(targetParent, { recursive: true });
      const [canonicalManagedRoot, canonicalTargetParent] = await Promise.all([
        realpath(managedWorktreeRoot),
        realpath(targetParent),
      ]);
      const targetRoot = path.join(canonicalTargetParent, workspaceId);
      if (!isInside(canonicalManagedRoot, targetRoot)) {
        throw projectWorkError(
          "PROJECT_WORK_WORKTREE_TARGET_INVALID",
          "新 Workspace 的存储位置无效",
          500,
        );
      }
      try {
        await lstat(targetRoot);
        throw projectWorkError(
          "PROJECT_WORK_WORKTREE_TARGET_EXISTS",
          "新 Workspace 的存储位置已存在",
          409,
        );
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      try {
        await runGit([
          "-C",
          source.gitWorktreeRoot,
          "worktree",
          "add",
          "-b",
          branch,
          targetRoot,
          expectedHead ?? "HEAD",
        ]);
      } catch {
        await rm(targetRoot, { recursive: true, force: true });
        throw safeGitFailure(
          "PROJECT_WORK_WORKTREE_CREATE_FAILED",
          "Git worktree 创建失败",
          true,
        );
      }

      try {
        const mapped = await inspectMappedRoot(targetRoot, source.projectSubpath);
        if (!mapped) {
          throw safeGitFailure(
            "PROJECT_WORK_WORKTREE_CREATE_FAILED",
            "新 Git Workspace 当前不可用",
            true,
          );
        }
        const timestamp = now().toISOString();
        projectState.workspaces.push({
          id: workspaceId,
          projectId: project.id,
          kind: "git_worktree",
          rootPath: mapped.canonicalRoot,
          gitWorktreeRoot: mapped.canonicalWorktreeRoot,
          projectSubpath: source.projectSubpath,
          isMain: false,
          isGit: true,
          branch,
          head: source.head,
          dirty: false,
          locked: false,
          label: compactLabel(label, branch),
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        projectState.lastWorkspaceId = workspaceId;

        const reconciled = await reconcile(project, registry);
        reconciled.projectState.lastWorkspaceId = workspaceId;
        const created = reconciled.workspaces.find((workspace) => workspace.id === workspaceId);
        if (!created) {
          throw safeGitFailure(
            "PROJECT_WORK_WORKTREE_CREATE_FAILED",
            "新 Git Workspace 未能完成注册",
            true,
          );
        }
        await saveIfChanged(registry, before);
        return publicWorkspace(created);
      } catch (error) {
        await runGit([
          "-C",
          source.gitWorktreeRoot,
          "worktree",
          "remove",
          targetRoot,
        ]).catch(() => undefined);
        await runGit([
          "-C",
          source.gitWorktreeRoot,
          "branch",
          "-d",
          branch,
        ]).catch(() => undefined);
        throw error;
      }
    });
  }

  async function removeWorktree({
    project,
    workspaceId,
    expectedHead,
    busy,
  } = {}) {
    assertProject(project);
    const id = assertWorkspaceId(workspaceId);
    if (typeof busy !== "boolean") {
      throw projectWorkError(
        "PROJECT_WORK_WORKSPACE_BUSY_STATE_REQUIRED",
        "删除 Workspace 前必须确认当前运行状态",
        400,
      );
    }
    if (busy) {
      throw projectWorkError(
        "PROJECT_WORK_WORKSPACE_BUSY",
        "Workspace 正在运行任务，暂不能删除",
        409,
        true,
      );
    }
    if (typeof expectedHead !== "string" || !expectedHead) {
      throw projectWorkError(
        "PROJECT_WORK_WORKTREE_CONFIRMATION_REQUIRED",
        "删除 Workspace 前需要确认当前 HEAD",
        400,
      );
    }

    return withWriteLock(async () => {
      const registry = await load();
      const before = JSON.stringify(registry);
      const { projectState, workspaces } = await reconcile(project, registry);
      const workspace = workspaces.find((item) => item.id === id);
      if (!workspace) {
        throw projectWorkError(
          "PROJECT_WORK_WORKSPACE_NOT_FOUND",
          "Workspace 不存在或当前不可用",
          404,
        );
      }
      if (!workspace.isGit || workspace.isMain || workspace.kind !== "git_worktree") {
        throw projectWorkError(
          "PROJECT_WORK_WORKTREE_DELETE_FORBIDDEN",
          "主 Workspace 或非 Git Workspace 不能删除",
          409,
        );
      }
      if (workspace.locked) {
        throw projectWorkError(
          "PROJECT_WORK_WORKTREE_DELETE_FORBIDDEN",
          "锁定的 Git Workspace 不能删除",
          409,
        );
      }
      if (workspace.head !== expectedHead) {
        throw projectWorkError(
          "PROJECT_WORK_WORKTREE_STALE",
          "Workspace 的 HEAD 已变化，请重新确认",
          409,
          true,
        );
      }

      let dirty;
      try {
        const { stdout } = await runGit([
          "-C",
          workspace.gitWorktreeRoot,
          "status",
          "--porcelain=v1",
          "--untracked-files=normal",
        ]);
        dirty = String(stdout).length > 0;
      } catch {
        throw safeGitFailure(
          "PROJECT_WORK_GIT_INSPECTION_FAILED",
          "无法在删除前复核 Git Workspace",
          true,
        );
      }
      if (dirty) {
        throw projectWorkError(
          "PROJECT_WORK_WORKTREE_DIRTY",
          "Workspace 含有未提交修改，不能删除",
          409,
        );
      }

      const main = workspaces.find((item) => item.isMain && item.isGit);
      if (!main) {
        throw safeGitFailure(
          "PROJECT_WORK_GIT_INSPECTION_FAILED",
          "Git 主 Workspace 当前不可用",
          true,
        );
      }
      try {
        await runGit([
          "-C",
          main.gitWorktreeRoot,
          "worktree",
          "remove",
          workspace.gitWorktreeRoot,
        ]);
      } catch {
        throw safeGitFailure(
          "PROJECT_WORK_WORKTREE_DELETE_FAILED",
          "Git Workspace 删除失败，未使用强制删除",
          true,
        );
      }

      projectState.workspaces = projectState.workspaces.filter((item) => item.id !== id);
      if (projectState.lastWorkspaceId === id) {
        projectState.lastWorkspaceId = main.id;
      }
      await saveIfChanged(registry, before);
      return publicWorkspace(workspace);
    });
  }

  return Object.freeze({
    createWorktree,
    getLastWorkspaceId,
    list,
    rememberLastWorkspace,
    removeWorktree,
    resolveWorkspace,
    selectWorkspace,
  });
}
