import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  realpath,
  stat,
  symlink,
} from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { projectWorkError } from "./errors.js";

const DEFAULT_MAX_FILES = 120_000;
const DEFAULT_MAX_BYTES = 1536 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 256 * 1024 * 1024;

const ALWAYS_EXCLUDED_DIRECTORIES = new Set([
  ".agents",
  ".codex",
  ".git",
  ".git-worktrees",
  ".pi",
  ".pi-agent",
  ".pi-worktrees",
  ".worktree",
  ".worktrees",
]);

const STACK_DEPENDENCY_DIRECTORIES = Object.freeze({
  node: new Set(["node_modules"]),
  swift: new Set([".build"]),
  android: new Set([".gradle"]),
});

const OPTIONAL_DEPENDENCY_DIRECTORIES = new Set([
  ".build",
  ".gradle",
  ".venv",
  "node_modules",
  "target",
  "venv",
]);

const SECRET_FILE_NAMES = new Set([
  ".netrc",
  ".npmrc",
  ".pypirc",
  "credentials.json",
  "id_ed25519",
  "id_rsa",
  "secret.json",
  "secrets.json",
]);

const SECRET_EXTENSIONS = new Set([
  ".key",
  ".p12",
  ".pem",
  ".pfx",
]);

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function normalizedRelativePath(value) {
  return value.split(path.sep).join("/");
}

function isSecretPath(relativePath) {
  const segments = relativePath.split("/");
  const baseName = segments.at(-1) ?? "";
  const lowerName = baseName.toLowerCase();
  const extension = path.posix.extname(lowerName);
  return (
    lowerName === ".env"
    || (
      lowerName.startsWith(".env.")
      && lowerName !== ".env.example"
    )
    || SECRET_FILE_NAMES.has(lowerName)
    || SECRET_EXTENSIONS.has(extension)
  );
}

function shouldExclude(relativePath, recipeStack) {
  const segments = relativePath.split("/");
  if (segments.some((segment) => ALWAYS_EXCLUDED_DIRECTORIES.has(segment))) {
    return true;
  }
  const allowedDependencies = STACK_DEPENDENCY_DIRECTORIES[recipeStack]
    ?? new Set();
  if (segments.some((segment) => (
    OPTIONAL_DEPENDENCY_DIRECTORIES.has(segment)
    && !allowedDependencies.has(segment)
  ))) {
    return true;
  }
  return isSecretPath(relativePath);
}

async function canonicalDirectory(directoryPath, label) {
  const resolved = path.resolve(String(directoryPath ?? ""));
  let canonical;
  let directoryStat;
  try {
    [canonical, directoryStat] = await Promise.all([
      realpath(resolved),
      stat(resolved),
    ]);
  } catch {
    throw projectWorkError(
      "PROJECT_WORK_VERIFICATION_WORKSPACE_UNAVAILABLE",
      `${label}不可用于受控验证`,
      409,
      true,
    );
  }
  if (!directoryStat.isDirectory()) {
    throw projectWorkError(
      "PROJECT_WORK_VERIFICATION_WORKSPACE_UNAVAILABLE",
      `${label}不是可用文件夹`,
      409,
      true,
    );
  }
  return canonical;
}

function assertWithinLimits(counters, sourceStat, limits) {
  if (sourceStat.size > limits.maxFileBytes) {
    throw projectWorkError(
      "PROJECT_WORK_VERIFICATION_WORKSPACE_TOO_LARGE",
      "项目包含超出受控验证上限的单个文件",
      409,
      true,
    );
  }
  if (
    counters.files + 1 > limits.maxFiles
    || counters.bytes + sourceStat.size > limits.maxBytes
  ) {
    throw projectWorkError(
      "PROJECT_WORK_VERIFICATION_WORKSPACE_TOO_LARGE",
      "项目超出受控验证副本的文件数或总大小上限",
      409,
      true,
    );
  }
}

async function cloneTree({
  sourceRoot,
  destinationRoot,
  excludedRoot,
  recipeStack,
  limits,
}) {
  const counters = {
    files: 0,
    bytes: 0,
    links: 0,
    clonedFiles: 0,
    copiedFiles: 0,
  };
  const manifest = [];
  const pending = [{ sourceDirectory: sourceRoot, relativeDirectory: "" }];
  await mkdir(destinationRoot, { recursive: true, mode: 0o700 });

  for (let directoryIndex = 0; directoryIndex < pending.length; directoryIndex += 1) {
    const { sourceDirectory, relativeDirectory } = pending[directoryIndex];
    const entries = await readdir(sourceDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = normalizedRelativePath(
        [relativeDirectory, entry.name].filter(Boolean).join(path.sep),
      );
      if (shouldExclude(relativePath, recipeStack)) continue;
      const sourcePath = path.join(sourceDirectory, entry.name);
      if (
        excludedRoot
        && (inside(excludedRoot, sourcePath) || inside(sourcePath, excludedRoot))
      ) {
        continue;
      }
      const destinationPath = path.join(
        destinationRoot,
        ...relativePath.split("/"),
      );
      const sourceStat = await lstat(sourcePath);
      if (sourceStat.isDirectory()) {
        await mkdir(destinationPath, {
          recursive: true,
          mode: sourceStat.mode & 0o777,
        });
        pending.push({
          sourceDirectory: sourcePath,
          relativeDirectory: relativePath,
        });
        continue;
      }
      if (sourceStat.isSymbolicLink()) {
        let canonicalTarget;
        try {
          canonicalTarget = await realpath(sourcePath);
        } catch {
          throw projectWorkError(
            "PROJECT_WORK_VERIFICATION_LINK_UNSAFE",
            "项目包含无法安全复制的符号链接",
            409,
            true,
          );
        }
        if (!inside(sourceRoot, canonicalTarget)) {
          throw projectWorkError(
            "PROJECT_WORK_VERIFICATION_LINK_UNSAFE",
            "项目符号链接指向项目外部，未运行验证",
            409,
            true,
          );
        }
        const targetRelative = normalizedRelativePath(
          path.relative(sourceRoot, canonicalTarget),
        );
        if (shouldExclude(targetRelative, recipeStack)) {
          throw projectWorkError(
            "PROJECT_WORK_VERIFICATION_LINK_UNSAFE",
            "项目符号链接指向未纳入验证副本的内容",
            409,
            true,
          );
        }
        const destinationTarget = path.join(
          destinationRoot,
          ...targetRelative.split("/"),
        );
        const targetStat = await stat(canonicalTarget);
        await mkdir(path.dirname(destinationPath), {
          recursive: true,
          mode: 0o700,
        });
        await symlink(
          path.relative(path.dirname(destinationPath), destinationTarget),
          destinationPath,
          targetStat.isDirectory() ? "dir" : "file",
        );
        counters.links += 1;
        manifest.push({
          path: relativePath,
          link: targetRelative,
        });
        continue;
      }
      if (!sourceStat.isFile()) {
        throw projectWorkError(
          "PROJECT_WORK_VERIFICATION_ENTRY_UNSAFE",
          "项目包含不能进入受控验证副本的特殊文件",
          409,
          true,
        );
      }
      assertWithinLimits(counters, sourceStat, limits);
      await mkdir(path.dirname(destinationPath), {
        recursive: true,
        mode: 0o700,
      });
      let cloned = true;
      try {
        await copyFile(
          sourcePath,
          destinationPath,
          constants.COPYFILE_FICLONE_FORCE,
        );
      } catch (error) {
        if (!["ENOSYS", "ENOTSUP", "EXDEV"].includes(error?.code)) throw error;
        cloned = false;
        await copyFile(
          sourcePath,
          destinationPath,
          constants.COPYFILE_FICLONE,
        );
      }
      await chmod(destinationPath, sourceStat.mode & 0o777);
      const [sourceAfter, destinationStat] = await Promise.all([
        lstat(sourcePath),
        lstat(destinationPath),
      ]);
      if (
        !sourceAfter.isFile()
        || sourceAfter.size !== sourceStat.size
        || sourceAfter.mtimeMs !== sourceStat.mtimeMs
        || destinationStat.size !== sourceStat.size
      ) {
        throw projectWorkError(
          "PROJECT_WORK_VERIFICATION_SOURCE_CHANGED",
          "项目在创建验证副本时发生变化，请重试",
          409,
          true,
        );
      }
      counters.files += 1;
      counters.bytes += sourceStat.size;
      if (cloned) counters.clonedFiles += 1;
      else counters.copiedFiles += 1;
      manifest.push({
        path: relativePath,
        bytes: sourceStat.size,
        mode: sourceStat.mode & 0o777,
        mtimeMs: sourceStat.mtimeMs,
      });
    }
  }

  return {
    ...counters,
    manifestHash: sha256(JSON.stringify(manifest)),
  };
}

export async function createVerificationProjectSnapshot({
  projectRoot,
  baseRoot,
  workspaceRoot,
  storageRoot,
  recipeStack,
  maxFiles = DEFAULT_MAX_FILES,
  maxBytes = DEFAULT_MAX_BYTES,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
} = {}) {
  const canonicalProjectRoot = await canonicalDirectory(
    projectRoot,
    "项目文件夹",
  );
  const canonicalStorageRoot = storageRoot
    ? await canonicalDirectory(storageRoot, "Pi Agent 私有存储")
    : null;
  if (
    canonicalStorageRoot
    && inside(canonicalProjectRoot, canonicalStorageRoot)
  ) {
    throw projectWorkError(
      "PROJECT_WORK_VERIFICATION_STORAGE_OVERLAP",
      "Pi Agent 私有存储不能位于待验证项目内",
      409,
      true,
    );
  }
  const limits = {
    maxFiles,
    maxBytes,
    maxFileBytes,
  };
  const materialized = await cloneTree({
    sourceRoot: canonicalProjectRoot,
    destinationRoot: baseRoot,
    excludedRoot: null,
    recipeStack,
    limits,
  });
  await cloneTree({
    sourceRoot: await canonicalDirectory(baseRoot, "验证基础副本"),
    destinationRoot: workspaceRoot,
    excludedRoot: null,
    recipeStack,
    limits,
  });
  return {
    ...materialized,
    truncated: false,
    skippedBinaryFiles: 0,
    skippedOversizedFiles: 0,
    isolation: "private_copy",
  };
}
