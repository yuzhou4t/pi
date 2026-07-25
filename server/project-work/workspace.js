import { createHash, randomUUID } from "node:crypto";
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { createTwoFilesPatch, diffLines } from "diff";
import { projectWorkError } from "./errors.js";

const MAX_SNAPSHOT_FILES = 8_000;
const MAX_SNAPSHOT_BYTES = 96 * 1024 * 1024;
const MAX_SNAPSHOT_FILE_BYTES = 4 * 1024 * 1024;
const MAX_READ_BYTES = 1024 * 1024;
const MAX_CHANGE_FILE_BYTES = 512 * 1024;
const MAX_TREE_ENTRIES = 2_000;
const FILTERED_DIRECTORIES = new Set([
  ".git",
  ".pi",
  ".agents",
  ".codex",
  ".pi-agent",
  ".venv",
  "node_modules",
  "venv",
]);
const SNAPSHOT_ONLY_DIRECTORIES = new Set([
  ".cache",
  ".mypy_cache",
  ".next",
  ".nuxt",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  ".turbo",
  ".worktrees",
  "__pycache__",
  "coverage",
  "dist",
]);
const SNAPSHOT_BINARY_EXTENSIONS = new Set([
  ".7z",
  ".a",
  ".avi",
  ".bin",
  ".bmp",
  ".class",
  ".dmg",
  ".doc",
  ".docx",
  ".eot",
  ".gif",
  ".gz",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp3",
  ".mp4",
  ".o",
  ".otf",
  ".pdf",
  ".png",
  ".pyc",
  ".so",
  ".tar",
  ".tif",
  ".tiff",
  ".ttf",
  ".wav",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".xls",
  ".xlsx",
  ".zip",
]);

export function sha256(value) {
  const source = typeof value === "string" || value instanceof Uint8Array
    ? value
    : JSON.stringify(value);
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

export function normalizeProjectPath(value, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || value.includes("\0")) {
    throw projectWorkError("PROJECT_WORK_PATH_INVALID", "项目内路径无效", 400);
  }
  const source = value.replaceAll("\\", "/").trim();
  if (!source && allowEmpty) return "";
  if (!source || path.posix.isAbsolute(source)) {
    throw projectWorkError("PROJECT_WORK_PATH_INVALID", "项目内路径无效", 400);
  }
  const normalized = path.posix.normalize(source).replace(/^\.\//, "");
  if (
    !normalized
    || normalized === "."
    || normalized === ".."
    || normalized.startsWith("../")
    || normalized.includes("/../")
  ) {
    if (allowEmpty && normalized === ".") return "";
    throw projectWorkError(
      "PROJECT_WORK_PATH_OUT_OF_SCOPE",
      "路径必须位于项目文件夹内",
      400,
    );
  }
  return normalized;
}

export function isFilteredProjectPath(relativePath) {
  const normalized = normalizeProjectPath(relativePath);
  const segments = normalized.split("/");
  if (segments.some((segment) => FILTERED_DIRECTORIES.has(segment))) return true;
  const baseName = segments.at(-1);
  return (
    baseName === ".env"
    || (baseName.startsWith(".env.") && baseName !== ".env.example")
  );
}

function resolveInside(root, relativePath, { allowEmpty = false } = {}) {
  const normalized = normalizeProjectPath(relativePath, { allowEmpty });
  const target = normalized
    ? path.resolve(root, ...normalized.split("/"))
    : path.resolve(root);
  const relative = path.relative(path.resolve(root), target);
  if (
    relative.startsWith("..")
    || path.isAbsolute(relative)
  ) {
    throw projectWorkError(
      "PROJECT_WORK_PATH_OUT_OF_SCOPE",
      "路径必须位于项目文件夹内",
      400,
    );
  }
  return { normalized, target };
}

function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function canonicalDirectory(root) {
  let canonical;
  let rootStat;
  try {
    [canonical, rootStat] = await Promise.all([realpath(root), lstat(root)]);
  } catch {
    throw projectWorkError(
      "PROJECT_WORK_ROOT_NOT_FOUND",
      "项目文件夹当前不可用",
      404,
      true,
    );
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw projectWorkError(
      "PROJECT_WORK_ROOT_INVALID",
      "项目根目录必须是普通文件夹",
      409,
    );
  }
  return canonical;
}

async function inspectExisting(root, relativePath, expectedKind) {
  if (isFilteredProjectPath(relativePath)) {
    throw projectWorkError(
      "PROJECT_WORK_PATH_FILTERED",
      "该路径不在项目工作区的可访问范围内",
      403,
    );
  }
  const canonicalRoot = await canonicalDirectory(root);
  const { normalized, target } = resolveInside(canonicalRoot, relativePath);
  let targetStat;
  let canonicalTarget;
  try {
    [targetStat, canonicalTarget] = await Promise.all([lstat(target), realpath(target)]);
  } catch {
    throw projectWorkError("PROJECT_WORK_FILE_NOT_FOUND", "项目文件不存在", 404);
  }
  if (
    targetStat.isSymbolicLink()
    || !isInside(canonicalRoot, canonicalTarget)
    || (expectedKind === "file" && !targetStat.isFile())
    || (expectedKind === "directory" && !targetStat.isDirectory())
  ) {
    throw projectWorkError(
      "PROJECT_WORK_FILE_UNSAFE",
      "项目路径不是可安全访问的普通文件或文件夹",
      409,
    );
  }
  return {
    canonicalRoot,
    normalized,
    target: canonicalTarget,
    stat: targetStat,
  };
}

function isProbablyBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8_192));
  return sample.includes(0);
}

function languageFor(filePath) {
  const extension = path.posix.extname(filePath).slice(1).toLowerCase();
  return {
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    ts: "typescript",
    tsx: "typescript",
    json: "json",
    css: "css",
    html: "html",
    md: "markdown",
    py: "python",
    rs: "rust",
    go: "go",
    sh: "shell",
  }[extension] ?? "text";
}

export async function readProjectTextFile(root, {
  filePath,
  startLine = 1,
  endLine,
} = {}) {
  const inspected = await inspectExisting(root, filePath, "file");
  if (inspected.stat.size > MAX_READ_BYTES) {
    throw projectWorkError(
      "PROJECT_WORK_FILE_TOO_LARGE",
      "文件过大，不能在当前查看器中打开",
      413,
    );
  }
  const buffer = await readFile(inspected.target);
  if (isProbablyBinary(buffer)) {
    throw projectWorkError(
      "PROJECT_WORK_FILE_BINARY",
      "当前文件不是可直接查看的文本文件",
      415,
    );
  }
  const lines = buffer.toString("utf8").split(/\r\n|\n|\r/);
  const normalizedStart = Number.isInteger(startLine) && startLine > 0 ? startLine : 1;
  const normalizedEnd = Number.isInteger(endLine) && endLine >= normalizedStart
    ? Math.min(endLine, lines.length)
    : Math.min(normalizedStart + 399, lines.length);
  return {
    path: inspected.normalized,
    language: languageFor(inspected.normalized),
    byteLength: buffer.length,
    hash: sha256(buffer),
    content: lines.slice(normalizedStart - 1, normalizedEnd).join("\n"),
    startLine: normalizedStart,
    endLine: normalizedEnd,
    totalLines: lines.length,
  };
}

export async function getProjectFileTree(root, {
  directory = "",
  depth = 2,
} = {}) {
  const normalizedDepth = Number.isInteger(depth) ? Math.min(Math.max(depth, 1), 5) : 2;
  const canonicalRoot = await canonicalDirectory(root);
  const start = directory
    ? await inspectExisting(canonicalRoot, directory, "directory")
    : {
        canonicalRoot,
        normalized: "",
        target: canonicalRoot,
      };
  let entryCount = 0;
  let truncated = false;

  async function visit(directoryPath, relativeDirectory, remainingDepth) {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    entries.sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
    const result = [];
    for (const entry of entries) {
      if (entryCount >= MAX_TREE_ENTRIES) {
        truncated = true;
        break;
      }
      const relativePath = [relativeDirectory, entry.name].filter(Boolean).join("/");
      if (isFilteredProjectPath(relativePath)) continue;
      const targetPath = path.join(directoryPath, entry.name);
      const targetStat = await lstat(targetPath);
      entryCount += 1;
      if (targetStat.isSymbolicLink()) {
        result.push({ name: entry.name, path: relativePath, type: "symlink" });
      } else if (targetStat.isDirectory()) {
        const item = { name: entry.name, path: relativePath, type: "directory" };
        if (remainingDepth > 1) {
          item.children = await visit(targetPath, relativePath, remainingDepth - 1);
        }
        result.push(item);
      } else if (targetStat.isFile()) {
        result.push({
          name: entry.name,
          path: relativePath,
          type: "file",
          byteLength: targetStat.size,
        });
      }
    }
    return result;
  }

  return {
    path: start.normalized,
    entries: await visit(start.target, start.normalized, normalizedDepth),
    truncated,
  };
}

function shouldSkipSnapshotPath(relativePath) {
  if (isFilteredProjectPath(relativePath)) return true;
  return relativePath
    .split("/")
    .some((segment) => SNAPSHOT_ONLY_DIRECTORIES.has(segment));
}

function isKnownSnapshotBinaryPath(relativePath) {
  return SNAPSHOT_BINARY_EXTENSIONS.has(
    path.posix.extname(relativePath).toLowerCase(),
  );
}

async function copyTree({
  sourceRoot,
  destinationRoot,
  excludedRoot,
  limits,
}) {
  const counters = {
    files: 0,
    bytes: 0,
    truncated: false,
    skippedBinaryFiles: 0,
    skippedOversizedFiles: 0,
  };
  const excluded = excludedRoot ? path.resolve(excludedRoot) : null;
  const pendingDirectories = [{
    sourceDirectory: sourceRoot,
    relativeDirectory: "",
  }];
  let nextDirectoryIndex = 0;
  await mkdir(destinationRoot, { recursive: true, mode: 0o700 });

  while (nextDirectoryIndex < pendingDirectories.length) {
    const {
      sourceDirectory,
      relativeDirectory,
    } = pendingDirectories[nextDirectoryIndex];
    nextDirectoryIndex += 1;
    const entries = await readdir(sourceDirectory, { withFileTypes: true });
    entries.sort((left, right) => (
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    ));
    const childDirectories = [];
    for (const entry of entries) {
      const relativePath = [relativeDirectory, entry.name].filter(Boolean).join("/");
      if (shouldSkipSnapshotPath(relativePath)) continue;
      const sourcePath = path.join(sourceDirectory, entry.name);
      if (
        excluded
        && (isInside(sourcePath, excluded) || isInside(excluded, sourcePath))
      ) {
        continue;
      }
      const sourceStat = await lstat(sourcePath);
      if (sourceStat.isSymbolicLink()) continue;
      if (sourceStat.isDirectory()) {
        childDirectories.push({
          sourceDirectory: sourcePath,
          relativeDirectory: relativePath,
        });
        continue;
      }
      if (!sourceStat.isFile()) continue;
      if (
        sourceStat.size > MAX_SNAPSHOT_FILE_BYTES
        || isKnownSnapshotBinaryPath(relativePath)
      ) {
        if (sourceStat.size > MAX_SNAPSHOT_FILE_BYTES) {
          counters.skippedOversizedFiles += 1;
        } else {
          counters.skippedBinaryFiles += 1;
        }
        continue;
      }
      if (
        counters.files >= limits.maxFiles
        || counters.bytes + sourceStat.size > limits.maxBytes
      ) {
        counters.truncated = true;
        continue;
      }
      const content = await readFile(sourcePath);
      if (isProbablyBinary(content)) {
        counters.skippedBinaryFiles += 1;
        continue;
      }
      const destinationPath = path.join(destinationRoot, ...relativePath.split("/"));
      await mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
      await writeFile(destinationPath, content, {
        flag: "wx",
        mode: sourceStat.mode & 0o777,
      });
      counters.files += 1;
      counters.bytes += content.length;
    }
    pendingDirectories.push(...childDirectories);
  }

  return counters;
}

export async function createFilteredProjectSnapshot({
  projectRoot,
  baseRoot,
  workspaceRoot,
  storageRoot,
  maxFiles = MAX_SNAPSHOT_FILES,
  maxBytes = MAX_SNAPSHOT_BYTES,
} = {}) {
  const canonicalRoot = await canonicalDirectory(projectRoot);
  const limits = { maxFiles, maxBytes };
  const copied = await copyTree({
    sourceRoot: canonicalRoot,
    destinationRoot: baseRoot,
    excludedRoot: storageRoot,
    limits,
  });
  await copyTree({
    sourceRoot: baseRoot,
    destinationRoot: workspaceRoot,
    excludedRoot: null,
    limits,
  });
  return copied;
}

async function collectSnapshotFiles(root) {
  const result = new Map();

  async function visit(directoryPath, relativeDirectory) {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = [relativeDirectory, entry.name].filter(Boolean).join("/");
      if (shouldSkipSnapshotPath(relativePath)) continue;
      const targetPath = path.join(directoryPath, entry.name);
      const targetStat = await lstat(targetPath);
      if (targetStat.isSymbolicLink()) {
        throw projectWorkError(
          "PROJECT_WORK_SNAPSHOT_SYMLINK",
          "工作快照中出现了不允许的符号链接",
          409,
        );
      }
      if (targetStat.isDirectory()) {
        await visit(targetPath, relativePath);
      } else if (targetStat.isFile()) {
        result.set(relativePath, {
          buffer: await readFile(targetPath),
          mode: targetStat.mode & 0o777,
        });
      }
    }
  }

  await visit(root, "");
  return result;
}

function lineStats(before, after) {
  let additions = 0;
  let deletions = 0;
  for (const part of diffLines(before, after)) {
    const count = part.count ?? part.value.split("\n").length - 1;
    if (part.added) additions += count;
    if (part.removed) deletions += count;
  }
  return { additions, deletions };
}

function changeFileId(relativePath) {
  return `file-${sha256(relativePath).slice(7, 23)}`;
}

export async function recomputeChangeSet({
  conversationId,
  baseRoot,
  workspaceRoot,
} = {}) {
  const [baseFiles, workspaceFiles] = await Promise.all([
    collectSnapshotFiles(baseRoot),
    collectSnapshotFiles(workspaceRoot),
  ]);
  const paths = [...new Set([...baseFiles.keys(), ...workspaceFiles.keys()])].sort();
  const files = [];
  for (const relativePath of paths) {
    const before = baseFiles.get(relativePath);
    const after = workspaceFiles.get(relativePath);
    if (before && after && before.buffer.equals(after.buffer)) continue;
    const beforeBuffer = before?.buffer ?? Buffer.alloc(0);
    const afterBuffer = after?.buffer ?? Buffer.alloc(0);
    if (
      beforeBuffer.length > MAX_CHANGE_FILE_BYTES
      || afterBuffer.length > MAX_CHANGE_FILE_BYTES
    ) {
      throw projectWorkError(
        "PROJECT_WORK_CHANGE_TOO_LARGE",
        `文件 ${relativePath} 的改动超出当前审阅限制`,
        413,
      );
    }
    if (isProbablyBinary(beforeBuffer) || isProbablyBinary(afterBuffer)) {
      throw projectWorkError(
        "PROJECT_WORK_BINARY_CHANGE_UNSUPPORTED",
        `文件 ${relativePath} 的二进制改动不能在当前版本中应用`,
        415,
      );
    }
    const beforeText = beforeBuffer.toString("utf8");
    const afterText = afterBuffer.toString("utf8");
    const operation = before ? (after ? "modify" : "delete") : "create";
    const stats = lineStats(beforeText, afterText);
    files.push({
      id: changeFileId(relativePath),
      path: relativePath,
      operation,
      baseHash: before ? sha256(before.buffer) : null,
      afterHash: after ? sha256(after.buffer) : null,
      additions: stats.additions,
      deletions: stats.deletions,
      diff: createTwoFilesPatch(
        before ? `a/${relativePath}` : "/dev/null",
        after ? `b/${relativePath}` : "/dev/null",
        beforeText,
        afterText,
        "",
        "",
        { context: 3 },
      ),
    });
  }
  const core = {
    conversationId,
    files: files.map((file) => ({
      id: file.id,
      path: file.path,
      operation: file.operation,
      baseHash: file.baseHash,
      afterHash: file.afterHash,
    })),
  };
  const hash = sha256(core);
  return {
    id: `changeset-${hash.slice(7, 23)}`,
    hash,
    status: files.length > 0 ? "ready" : "clean",
    stats: {
      files: files.length,
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    },
    files,
  };
}

async function inspectFileState(root, relativePath) {
  const { target } = resolveInside(root, relativePath);
  let targetStat;
  try {
    targetStat = await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { exists: false, buffer: null, hash: null, mode: 0o600 };
    }
    throw error;
  }
  if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
    throw projectWorkError(
      "PROJECT_WORK_APPLY_TARGET_UNSAFE",
      "变更目标不是可安全修改的普通文件",
      409,
    );
  }
  const buffer = await readFile(target);
  return {
    exists: true,
    buffer,
    hash: sha256(buffer),
    mode: targetStat.mode & 0o777,
  };
}

function assertExpectedState(state, expectedHash) {
  if (
    (expectedHash === null && state.exists)
    || (expectedHash !== null && (!state.exists || state.hash !== expectedHash))
  ) {
    throw projectWorkError(
      "PROJECT_WORK_CHANGE_STALE",
      "项目文件已发生变化，请重新检查更改",
      409,
      true,
    );
  }
}

async function ensureSafeParent(root, relativePath, createdDirectories) {
  const normalized = normalizeProjectPath(relativePath);
  const segments = normalized.split("/").slice(0, -1);
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    let currentStat;
    try {
      currentStat = await lstat(current);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o700 });
      createdDirectories.push(current);
      continue;
    }
    if (!currentStat.isDirectory() || currentStat.isSymbolicLink()) {
      throw projectWorkError(
        "PROJECT_WORK_APPLY_TARGET_UNSAFE",
        "变更目标的父目录不安全",
        409,
      );
    }
  }
}

async function atomicWrite(root, relativePath, buffer, mode, expectedHash, createdDirectories) {
  const { target } = resolveInside(root, relativePath);
  await ensureSafeParent(root, relativePath, createdDirectories);
  const beforeWrite = await inspectFileState(root, relativePath);
  assertExpectedState(beforeWrite, expectedHash);
  const temporaryPath = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomUUID()}.tmp`,
  );
  await writeFile(temporaryPath, buffer, {
    flag: "wx",
    mode: mode || 0o600,
  });
  try {
    const immediatelyBeforeCommit = await inspectFileState(root, relativePath);
    assertExpectedState(immediatelyBeforeCommit, expectedHash);
    if (expectedHash === null) {
      await link(temporaryPath, target);
      await unlink(temporaryPath);
    } else {
      await rename(temporaryPath, target);
    }
    await chmod(target, mode || 0o600);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function applyOperation(operation, createdDirectories) {
  const current = await inspectFileState(operation.root, operation.relativePath);
  assertExpectedState(current, operation.expectedHash);
  if (operation.afterBuffer === null) {
    await unlink(resolveInside(operation.root, operation.relativePath).target);
  } else {
    await atomicWrite(
      operation.root,
      operation.relativePath,
      operation.afterBuffer,
      operation.afterMode,
      operation.expectedHash,
      createdDirectories,
    );
  }
}

async function restoreOperation(operation, createdDirectories) {
  const current = await inspectFileState(operation.root, operation.relativePath);
  assertExpectedState(current, operation.expectedAfterHash);
  if (operation.before.exists) {
    await atomicWrite(
      operation.root,
      operation.relativePath,
      operation.before.buffer,
      operation.before.mode,
      current.hash,
      createdDirectories,
    );
  } else if (current.exists) {
    await unlink(resolveInside(operation.root, operation.relativePath).target);
  }
}

async function removeCreatedDirectories(createdDirectories) {
  for (const directory of [...createdDirectories].reverse()) {
    await rmdir(directory).catch(() => undefined);
  }
}

export async function applySelectedChangeSet({
  projectRoot,
  baseRoot,
  workspaceRoot,
  changeSet,
  selectedFiles,
} = {}) {
  if (!Array.isArray(selectedFiles) || selectedFiles.length === 0) {
    throw projectWorkError(
      "PROJECT_WORK_CHANGE_SELECTION_REQUIRED",
      "至少选择一个要应用的文件",
      400,
    );
  }
  const selectedIds = new Set();
  const selectedChanges = selectedFiles.map((binding) => {
    if (!binding || selectedIds.has(binding.fileId)) {
      throw projectWorkError(
        "PROJECT_WORK_CHANGE_SELECTION_INVALID",
        "所选文件绑定无效",
        400,
      );
    }
    selectedIds.add(binding.fileId);
    const change = changeSet.files.find((file) => file.id === binding.fileId);
    if (
      !change
      || binding.baseHash !== change.baseHash
      || binding.afterHash !== change.afterHash
    ) {
      throw projectWorkError(
        "PROJECT_WORK_CHANGE_BINDING_MISMATCH",
        "更改内容已变化，请重新检查后再确认",
        409,
        true,
      );
    }
    return change;
  });

  const canonicalProjectRoot = await canonicalDirectory(projectRoot);
  const operations = [];
  for (const change of selectedChanges) {
    const workspaceState = await inspectFileState(workspaceRoot, change.path);
    if (
      (change.afterHash === null && workspaceState.exists)
      || (change.afterHash !== null && workspaceState.hash !== change.afterHash)
    ) {
      throw projectWorkError(
        "PROJECT_WORK_CHANGE_STALE",
        "工作快照已发生变化，请重新检查更改",
        409,
        true,
      );
    }
    const [projectBefore, baseBefore] = await Promise.all([
      inspectFileState(canonicalProjectRoot, change.path),
      inspectFileState(baseRoot, change.path),
    ]);
    assertExpectedState(projectBefore, change.baseHash);
    assertExpectedState(baseBefore, change.baseHash);
    for (const [root, before] of [
      [canonicalProjectRoot, projectBefore],
      [baseRoot, baseBefore],
    ]) {
      operations.push({
        root,
        relativePath: change.path,
        expectedHash: change.baseHash,
        afterBuffer: workspaceState.exists ? workspaceState.buffer : null,
        afterMode: workspaceState.mode,
        expectedAfterHash: change.afterHash,
        before,
      });
    }
  }

  const applied = [];
  const createdDirectories = [];
  try {
    for (const operation of operations) {
      await applyOperation(operation, createdDirectories);
      applied.push(operation);
    }
    for (const operation of operations) {
      const readBack = await inspectFileState(operation.root, operation.relativePath);
      if (
        (operation.expectedAfterHash === null && readBack.exists)
        || (
          operation.expectedAfterHash !== null
          && readBack.hash !== operation.expectedAfterHash
        )
      ) {
        throw projectWorkError(
          "PROJECT_WORK_APPLY_READBACK_FAILED",
          "更改写入后的校验失败，已开始回滚",
          500,
          true,
        );
      }
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const operation of [...applied].reverse()) {
      try {
        await restoreOperation(operation, createdDirectories);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    await removeCreatedDirectories(createdDirectories);
    if (rollbackErrors.length > 0) {
      throw projectWorkError(
        "PROJECT_WORK_ROLLBACK_FAILED",
        "更改应用失败，且自动回滚未能完整完成",
        500,
      );
    }
    throw error;
  }

  return selectedChanges.map((change) => ({
    fileId: change.id,
    path: change.path,
    baseHash: change.baseHash,
    afterHash: change.afterHash,
  }));
}

export async function assertScratchToolPath(workspaceRoot, value, {
  allowEmpty = false,
} = {}) {
  const normalized = normalizeProjectPath(value ?? "", { allowEmpty });
  if (normalized && isFilteredProjectPath(normalized)) {
    throw new Error("Path is outside the filtered project workspace");
  }
  const { target } = resolveInside(workspaceRoot, normalized, { allowEmpty });
  if (!isInside(workspaceRoot, target)) {
    throw new Error("Path is outside the filtered project workspace");
  }
  return normalized;
}

export async function readSafeAgentsFiles(workspaceRoot) {
  const result = [];
  for (const name of ["AGENTS.md", "AGENTS.MD"]) {
    const target = path.join(workspaceRoot, name);
    let targetStat;
    try {
      targetStat = await lstat(target);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (!targetStat.isFile() || targetStat.isSymbolicLink() || targetStat.size > 256 * 1024) {
      continue;
    }
    await access(target, constants.R_OK);
    result.push({
      path: name,
      content: await readFile(target, "utf8"),
    });
    break;
  }
  return result;
}
