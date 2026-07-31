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
const DEFAULT_TREE_PAGE_SIZE = 160;
const MAX_TREE_PAGE_SIZE = 500;
const MAX_TREE_SEARCH_ENTRIES = 20_000;
const MAX_TREE_QUERY_LENGTH = 120;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const FILTERED_DIRECTORIES = new Set([
  ".git",
  ".git-worktrees",
  ".pi",
  ".agents",
  ".codex",
  ".pi-agent",
  ".pi-worktrees",
  ".venv",
  ".worktree",
  ".worktrees",
  "node_modules",
  "venv",
]);
const FILTERED_FILE_NAMES = new Set([
  ".DS_Store",
  ".ds_store",
  ".netrc",
  ".npmrc",
  ".pypirc",
  "credentials.json",
  "id_ed25519",
  "id_rsa",
  "secret.json",
  "secrets.json",
]);
const FILTERED_SECRET_EXTENSIONS = new Set([
  ".key",
  ".p12",
  ".pem",
  ".pfx",
]);
const IMAGE_MIME_BY_EXTENSION = new Map([
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
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
  if (segments.some((segment) => FILTERED_DIRECTORIES.has(segment.toLowerCase()))) {
    return true;
  }
  const baseName = segments.at(-1);
  const lowerBaseName = baseName.toLowerCase();
  const extension = path.posix.extname(baseName).toLowerCase();
  return (
    lowerBaseName === ".env"
    || (
      lowerBaseName.startsWith(".env.")
      && lowerBaseName !== ".env.example"
    )
    || FILTERED_FILE_NAMES.has(baseName)
    || FILTERED_FILE_NAMES.has(lowerBaseName)
    || FILTERED_SECRET_EXTENSIONS.has(extension)
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
  try {
    let current = canonicalRoot;
    for (const segment of normalized.split("/")) {
      current = path.join(current, segment);
      targetStat = await lstat(current);
      if (targetStat.isSymbolicLink()) {
        throw projectWorkError(
          "PROJECT_WORK_FILE_UNSAFE",
          "项目路径不是可安全访问的普通文件或文件夹",
          409,
        );
      }
    }
  } catch {
    if (targetStat?.isSymbolicLink()) {
      throw projectWorkError(
        "PROJECT_WORK_FILE_UNSAFE",
        "项目路径不是可安全访问的普通文件或文件夹",
        409,
      );
    }
    throw projectWorkError("PROJECT_WORK_FILE_NOT_FOUND", "项目文件不存在", 404);
  }
  if (
    (expectedKind === "file" && !targetStat.isFile())
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
    target,
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

function imageMimeForPath(relativePath) {
  return IMAGE_MIME_BY_EXTENSION.get(
    path.posix.extname(relativePath).toLowerCase(),
  ) ?? null;
}

function publicTreeEntry(entry) {
  const result = {
    name: entry.name,
    path: entry.path,
    type: entry.type,
    depth: entry.path.split("/").length - 1,
  };
  if (entry.type === "file") {
    result.byteLength = entry.stat.size;
    const mimeType = imageMimeForPath(entry.path);
    if (mimeType) {
      result.previewKind = "image";
      result.mimeType = mimeType;
    }
  }
  if (entry.overlay) result.overlay = entry.overlay;
  return result;
}

function compareTreeEntries(left, right) {
  if (left.type !== right.type) return left.type === "directory" ? -1 : 1;
  return left.path.localeCompare(right.path, "en");
}

function normalizeTreeQuery(value) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    throw projectWorkError(
      "PROJECT_WORK_TREE_QUERY_INVALID",
      "文件搜索条件无效",
      400,
    );
  }
  const normalized = value.trim();
  if (normalized.length > MAX_TREE_QUERY_LENGTH) {
    throw projectWorkError(
      "PROJECT_WORK_TREE_QUERY_INVALID",
      `文件搜索条件不能超过 ${MAX_TREE_QUERY_LENGTH} 个字符`,
      400,
    );
  }
  return normalized;
}

function normalizeTreePageSize(value, { paged }) {
  if (!paged) return null;
  if (value === undefined || value === null || value === "") {
    return DEFAULT_TREE_PAGE_SIZE;
  }
  const normalized = Number(value);
  if (
    !Number.isSafeInteger(normalized)
    || normalized < 1
    || normalized > MAX_TREE_PAGE_SIZE
  ) {
    throw projectWorkError(
      "PROJECT_WORK_TREE_LIMIT_INVALID",
      `文件列表每页必须为 1–${MAX_TREE_PAGE_SIZE} 项`,
      400,
    );
  }
  return normalized;
}

function encodeTreeCursor(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeTreeCursor(cursor, binding) {
  if (!cursor) return 0;
  if (typeof cursor !== "string" || cursor.length > 2_048) {
    throw projectWorkError(
      "PROJECT_WORK_TREE_CURSOR_INVALID",
      "文件列表游标无效，请重新加载",
      400,
      true,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw projectWorkError(
      "PROJECT_WORK_TREE_CURSOR_INVALID",
      "文件列表游标无效，请重新加载",
      400,
      true,
    );
  }
  if (
    parsed?.version !== 1
    || parsed.scope !== binding.scope
    || parsed.path !== binding.path
    || parsed.query !== binding.query
    || parsed.revision !== binding.revision
    || !Number.isSafeInteger(parsed.offset)
    || parsed.offset < 0
  ) {
    throw projectWorkError(
      "PROJECT_WORK_TREE_CURSOR_STALE",
      "文件列表已变化，请重新加载",
      409,
      true,
    );
  }
  return parsed.offset;
}

async function readSafeDirectoryEntries(root, relativeDirectory) {
  let inspected;
  try {
    if (relativeDirectory) {
      inspected = await inspectExisting(root, relativeDirectory, "directory");
    } else {
      const canonicalRoot = await canonicalDirectory(root);
      inspected = {
        canonicalRoot,
        normalized: "",
        target: canonicalRoot,
      };
    }
  } catch (error) {
    if (error?.code === "PROJECT_WORK_FILE_NOT_FOUND") return new Map();
    throw error;
  }
  const entries = await readdir(inspected.target, { withFileTypes: true });
  const result = new Map();
  for (const entry of entries) {
    const relativePath = [inspected.normalized, entry.name]
      .filter(Boolean)
      .join("/");
    if (isFilteredProjectPath(relativePath)) continue;
    const target = path.join(inspected.target, entry.name);
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) continue;
    if (!stat.isDirectory() && !stat.isFile()) continue;
    result.set(entry.name, {
      name: entry.name,
      path: relativePath,
      target,
      stat,
      type: stat.isDirectory() ? "directory" : "file",
    });
  }
  return result;
}

async function createProjectTreeReader(root) {
  const canonicalRoot = await canonicalDirectory(root);
  return {
    scope: "project",
    async assertDirectory(relativeDirectory) {
      if (!relativeDirectory) return;
      await inspectExisting(canonicalRoot, relativeDirectory, "directory");
    },
    async list(relativeDirectory) {
      return [...(await readSafeDirectoryEntries(
        canonicalRoot,
        relativeDirectory,
      )).values()];
    },
  };
}

async function createOverlayTreeReader({ projectRoot, workspaceRoot }) {
  const [canonicalProjectRoot, canonicalWorkspaceRoot] = await Promise.all([
    canonicalDirectory(projectRoot),
    canonicalDirectory(workspaceRoot),
  ]);
  return {
    scope: "conversation_overlay",
    async assertDirectory(relativeDirectory) {
      if (!relativeDirectory) return;
      const [projectEntries, workspaceEntries] = await Promise.all([
        readSafeDirectoryEntries(canonicalProjectRoot, relativeDirectory),
        readSafeDirectoryEntries(canonicalWorkspaceRoot, relativeDirectory),
      ]);
      if (projectEntries.size === 0 && workspaceEntries.size === 0) {
        const projectDirectory = await inspectExisting(
          canonicalProjectRoot,
          relativeDirectory,
          "directory",
        ).catch((error) => {
          if (error?.code === "PROJECT_WORK_FILE_NOT_FOUND") return null;
          throw error;
        });
        const workspaceDirectory = await inspectExisting(
          canonicalWorkspaceRoot,
          relativeDirectory,
          "directory",
        ).catch((error) => {
          if (error?.code === "PROJECT_WORK_FILE_NOT_FOUND") return null;
          throw error;
        });
        if (!projectDirectory && !workspaceDirectory) {
          throw projectWorkError(
            "PROJECT_WORK_FILE_NOT_FOUND",
            "项目文件不存在",
            404,
          );
        }
      }
    },
    async list(relativeDirectory) {
      const [projectEntries, workspaceEntries] = await Promise.all([
        readSafeDirectoryEntries(canonicalProjectRoot, relativeDirectory),
        readSafeDirectoryEntries(canonicalWorkspaceRoot, relativeDirectory),
      ]);
      const names = new Set([
        ...projectEntries.keys(),
        ...workspaceEntries.keys(),
      ]);
      return [...names].map((name) => {
        const projectEntry = projectEntries.get(name);
        const workspaceEntry = workspaceEntries.get(name);
        if (!workspaceEntry) return projectEntry;
        return {
          ...workspaceEntry,
          overlay: projectEntry
            ? workspaceEntry.type === "file" && projectEntry.type === "file"
              ? "modified"
              : null
            : "created",
        };
      });
    },
  };
}

async function collectSearchEntries(reader, startPath, query) {
  const needle = query.toLocaleLowerCase("zh-CN");
  const pending = [startPath];
  const matches = [];
  let scannedEntries = 0;
  let scanTruncated = false;
  while (pending.length > 0 && !scanTruncated) {
    const relativeDirectory = pending.shift();
    const entries = await reader.list(relativeDirectory);
    entries.sort(compareTreeEntries);
    for (const entry of entries) {
      scannedEntries += 1;
      if (scannedEntries > MAX_TREE_SEARCH_ENTRIES) {
        scanTruncated = true;
        break;
      }
      if (entry.path.toLocaleLowerCase("zh-CN").includes(needle)) {
        matches.push(entry);
      }
      if (entry.type === "directory") pending.push(entry.path);
    }
  }
  matches.sort(compareTreeEntries);
  return { entries: matches, scannedEntries, scanTruncated };
}

async function getPagedTree(reader, {
  directory,
  query,
  limit,
  cursor,
}) {
  await reader.assertDirectory(directory);
  const collected = query
    ? await collectSearchEntries(reader, directory, query)
    : {
        entries: (await reader.list(directory)).sort(compareTreeEntries),
        scannedEntries: null,
        scanTruncated: false,
      };
  const revision = sha256(collected.entries.map((entry) => ({
    path: entry.path,
    type: entry.type,
    size: entry.stat.size,
    modifiedAt: Number(entry.stat.mtimeMs),
    overlay: entry.overlay ?? null,
  })));
  const binding = {
    scope: reader.scope,
    path: directory,
    query,
    revision,
  };
  const offset = decodeTreeCursor(cursor, binding);
  if (offset > collected.entries.length) {
    throw projectWorkError(
      "PROJECT_WORK_TREE_CURSOR_STALE",
      "文件列表已变化，请重新加载",
      409,
      true,
    );
  }
  const page = collected.entries.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const hasNextPage = nextOffset < collected.entries.length;
  return {
    path: directory,
    query: query || null,
    revision,
    entries: page.map(publicTreeEntry),
    nextCursor: hasNextPage
      ? encodeTreeCursor({
          version: 1,
          ...binding,
          offset: nextOffset,
        })
      : null,
    truncated: collected.scanTruncated || hasNextPage,
    scanTruncated: collected.scanTruncated,
    scannedEntries: collected.scannedEntries,
  };
}

export async function getProjectFileTree(root, {
  directory = "",
  depth = 2,
  query,
  limit,
  cursor,
} = {}) {
  const normalizedDirectory = directory
    ? normalizeProjectPath(directory)
    : "";
  const normalizedQuery = normalizeTreeQuery(query);
  const paged = Boolean(
    normalizedQuery
    || cursor
    || limit !== undefined && limit !== null && limit !== "",
  );
  const pageSize = normalizeTreePageSize(limit, { paged });
  if (paged) {
    return getPagedTree(
      await createProjectTreeReader(root),
      {
        directory: normalizedDirectory,
        query: normalizedQuery,
        limit: pageSize,
        cursor,
      },
    );
  }
  const normalizedDepth = Number.isInteger(depth) ? Math.min(Math.max(depth, 1), 5) : 2;
  const canonicalRoot = await canonicalDirectory(root);
  const start = normalizedDirectory
    ? await inspectExisting(canonicalRoot, normalizedDirectory, "directory")
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
      if (targetStat.isSymbolicLink()) continue;
      entryCount += 1;
      if (targetStat.isDirectory()) {
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
        const mimeType = imageMimeForPath(relativePath);
        if (mimeType) {
          result.at(-1).previewKind = "image";
          result.at(-1).mimeType = mimeType;
        }
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

export async function getProjectOverlayFileTree({
  projectRoot,
  workspaceRoot,
  directory = "",
  query,
  limit,
  cursor,
} = {}) {
  const normalizedDirectory = directory
    ? normalizeProjectPath(directory)
    : "";
  const normalizedQuery = normalizeTreeQuery(query);
  const pageSize = normalizeTreePageSize(limit, { paged: true });
  return getPagedTree(
    await createOverlayTreeReader({ projectRoot, workspaceRoot }),
    {
      directory: normalizedDirectory,
      query: normalizedQuery,
      limit: pageSize,
      cursor,
    },
  );
}

function detectImageMime(buffer) {
  if (
    buffer.length >= 8
    && buffer.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  ) {
    return "image/png";
  }
  if (
    buffer.length >= 3
    && buffer[0] === 0xff
    && buffer[1] === 0xd8
    && buffer[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 6
    && ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))
  ) {
    return "image/gif";
  }
  if (
    buffer.length >= 12
    && buffer.subarray(0, 4).toString("ascii") === "RIFF"
    && buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

async function imageFromInspected(inspected) {
  const expectedMimeType = imageMimeForPath(inspected.normalized);
  if (!expectedMimeType) {
    throw projectWorkError(
      "PROJECT_WORK_IMAGE_TYPE_UNSUPPORTED",
      "仅支持预览 PNG、JPEG、GIF 或 WebP 图片",
      415,
    );
  }
  if (inspected.stat.size < 1 || inspected.stat.size > MAX_IMAGE_BYTES) {
    throw projectWorkError(
      "PROJECT_WORK_IMAGE_TOO_LARGE",
      "图片过大，不能在当前查看器中打开",
      413,
    );
  }
  const bytes = await readFile(inspected.target);
  const mimeType = detectImageMime(bytes);
  if (!mimeType || mimeType !== expectedMimeType) {
    throw projectWorkError(
      "PROJECT_WORK_IMAGE_INVALID",
      "图片内容与文件类型不匹配",
      415,
    );
  }
  return {
    path: inspected.normalized,
    mimeType,
    byteLength: bytes.length,
    hash: sha256(bytes),
    bytes,
  };
}

export async function readProjectImageFile(root, { filePath } = {}) {
  return imageFromInspected(await inspectExisting(root, filePath, "file"));
}

export async function readProjectOverlayImageFile({
  projectRoot,
  workspaceRoot,
  filePath,
} = {}) {
  const normalized = normalizeProjectPath(filePath);
  let workspaceFile;
  try {
    workspaceFile = await inspectExisting(workspaceRoot, normalized, "file");
  } catch (error) {
    if (error?.code !== "PROJECT_WORK_FILE_NOT_FOUND") throw error;
  }
  if (workspaceFile) return imageFromInspected(workspaceFile);
  return imageFromInspected(
    await inspectExisting(projectRoot, normalized, "file"),
  );
}

function shouldSkipSnapshotPath(relativePath) {
  if (isFilteredProjectPath(relativePath)) return true;
  return relativePath
    .split("/")
    .some((segment) => SNAPSHOT_ONLY_DIRECTORIES.has(segment.toLowerCase()));
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
  allowDeletes = true,
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
    // Sparse overlays do not expose a delete tool. A base-only entry can be
    // left behind if a process stops between capturing the base and publishing
    // the proposed file, so it must never become a deletion proposal.
    if (before && !after && !allowDeletes) continue;
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

export async function readBoundFileState(root, relativePath) {
  const canonicalRoot = await canonicalDirectory(root);
  const state = await inspectFileState(canonicalRoot, relativePath);
  return {
    exists: state.exists,
    buffer: state.buffer ? Buffer.from(state.buffer) : null,
    hash: state.hash,
    mode: state.mode,
  };
}

export async function applyBoundFileTransitions({
  root,
  transitions,
} = {}) {
  if (!Array.isArray(transitions) || transitions.length === 0) {
    return [];
  }
  const canonicalRoot = await canonicalDirectory(root);
  const paths = new Set();
  const operations = [];
  for (const transition of transitions) {
    const relativePath = normalizeProjectPath(transition?.path);
    if (paths.has(relativePath)) {
      throw projectWorkError(
        "PROJECT_WORK_TRANSITION_INVALID",
        "文件恢复列表包含重复路径",
        400,
      );
    }
    paths.add(relativePath);
    const targetBuffer = transition?.targetBuffer === null
      ? null
      : Buffer.from(transition?.targetBuffer ?? "");
    const targetHash = targetBuffer === null ? null : sha256(targetBuffer);
    if (targetHash !== (transition?.targetHash ?? null)) {
      throw projectWorkError(
        "PROJECT_WORK_RECOVERY_BACKUP_INVALID",
        "文件恢复副本校验失败",
        500,
      );
    }
    const before = await inspectFileState(canonicalRoot, relativePath);
    assertExpectedState(before, transition?.expectedHash ?? null);
    operations.push({
      root: canonicalRoot,
      relativePath,
      expectedHash: transition?.expectedHash ?? null,
      afterBuffer: targetBuffer,
      afterMode: Number.isInteger(transition?.targetMode)
        ? transition.targetMode
        : 0o600,
      expectedAfterHash: targetHash,
      before,
    });
  }

  const applied = [];
  const createdDirectories = [];
  try {
    for (const operation of operations) {
      await applyOperation(operation, createdDirectories);
      applied.push(operation);
    }
    for (const operation of operations) {
      const readBack = await inspectFileState(
        operation.root,
        operation.relativePath,
      );
      assertExpectedState(readBack, operation.expectedAfterHash);
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
        "PROJECT_WORK_RECOVERY_ROLLBACK_FAILED",
        "文件恢复失败，且无法完整回滚恢复操作",
        500,
      );
    }
    throw error;
  }
  return operations.map((operation) => ({
    path: operation.relativePath,
    beforeHash: operation.before.hash,
    afterHash: operation.expectedAfterHash,
  }));
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
