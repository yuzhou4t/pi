import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  isFilteredProjectPath,
  normalizeProjectPath,
  readBoundFileState,
  sha256,
} from "./workspace.js";
import {
  ProjectWorkError,
  projectWorkError,
  safeProjectWorkError,
} from "./errors.js";

const execFileAsync = promisify(execFile);
const RECORD_SCHEMA_VERSION = 1;
const MAX_PATHS = 200;
const MAX_MESSAGE_LENGTH = 240;
const MAX_VERIFICATION_EVIDENCE = 20;
const RECORD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/;
const COMMIT_HASH_PATTERN = /^[0-9a-f]{40,64}$/;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const PENDING_TRANSACTION_STATUSES = new Set([
  "staging",
  "staged",
  "commit_created",
  "ref_updated",
]);

function compactText(value, maxLength) {
  return typeof value === "string"
    ? value.trim().slice(0, maxLength)
    : "";
}

function normalizedBindingId(value, field) {
  const normalized = compactText(value, 181);
  if (!normalized || normalized.length > 180) {
    throw projectWorkError(
      "GIT_CLOSEOUT_CONTEXT_INVALID",
      `Git 收尾缺少有效的 ${field} 绑定`,
      400,
    );
  }
  return normalized;
}

function normalizedOwnership({
  conversationId,
  turnId,
  changeSetId,
  changeSetHash,
} = {}) {
  if (!SHA256_PATTERN.test(String(changeSetHash ?? ""))) {
    throw projectWorkError(
      "GIT_CLOSEOUT_CONTEXT_INVALID",
      "Git 收尾缺少有效的修改集 hash 绑定",
      400,
    );
  }
  return {
    conversationId: normalizedBindingId(conversationId, "conversationId"),
    turnId: normalizedBindingId(turnId, "turnId"),
    changeSetId: normalizedBindingId(changeSetId, "changeSetId"),
    changeSetHash,
  };
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedCommitMessage(value) {
  const message = compactText(value, MAX_MESSAGE_LENGTH + 1);
  if (
    !message
    || message.length > MAX_MESSAGE_LENGTH
    || /[\r\n\u0000-\u001f\u007f]/u.test(message)
  ) {
    throw projectWorkError(
      "GIT_CLOSEOUT_MESSAGE_INVALID",
      "提交信息必须是 1 至 240 个字符的单行文本",
      400,
    );
  }
  return message;
}

function normalizedPaths(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw projectWorkError(
      "GIT_CLOSEOUT_PATHS_REQUIRED",
      "至少选择一个要提交的文件",
      400,
    );
  }
  if (values.length > MAX_PATHS) {
    throw projectWorkError(
      "GIT_CLOSEOUT_PATHS_LIMIT_EXCEEDED",
      `一次最多提交 ${MAX_PATHS} 个精确路径`,
      400,
    );
  }
  const paths = values.map((value) => {
    const normalized = normalizeProjectPath(value);
    if (isFilteredProjectPath(normalized)) {
      throw projectWorkError(
        "GIT_CLOSEOUT_PATH_FILTERED",
        "所选路径不在可提交范围内",
        403,
      );
    }
    return normalized;
  });
  if (new Set(paths).size !== paths.length) {
    throw projectWorkError(
      "GIT_CLOSEOUT_PATHS_INVALID",
      "提交路径不能重复",
      400,
    );
  }
  return [...paths].sort(compareText);
}

function normalizedBaseFiles(values, paths) {
  if (!Array.isArray(values) || values.length !== paths.length) {
    throw projectWorkError(
      "GIT_CLOSEOUT_BASE_BINDING_INVALID",
      "Git 收尾缺少完整的修改前文件绑定",
      400,
    );
  }
  const byPath = new Map();
  for (const value of values) {
    const relativePath = normalizeProjectPath(value?.path);
    const baseExists = value?.baseExists === true;
    const baseHash = value?.baseHash ?? null;
    const baseMode = value?.baseMode ?? null;
    if (
      byPath.has(relativePath)
      || !paths.includes(relativePath)
      || (
        baseExists
        && (
          !SHA256_PATTERN.test(String(baseHash))
          || !Number.isInteger(baseMode)
          || baseMode < 0
          || baseMode > 0o777
        )
      )
      || (
        !baseExists
        && (baseHash !== null || baseMode !== null)
      )
    ) {
      throw projectWorkError(
        "GIT_CLOSEOUT_BASE_BINDING_INVALID",
        "Git 收尾的修改前文件绑定无效",
        400,
      );
    }
    byPath.set(relativePath, {
      path: relativePath,
      baseExists,
      baseHash,
      baseMode,
    });
  }
  return paths.map((relativePath) => byPath.get(relativePath));
}

function normalizedVerificationEvidence(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw projectWorkError(
      "GIT_CLOSEOUT_VERIFICATION_REQUIRED",
      "创建提交预览前需要至少一项已通过的验证证据",
      409,
    );
  }
  if (values.length > MAX_VERIFICATION_EVIDENCE) {
    throw projectWorkError(
      "GIT_CLOSEOUT_VERIFICATION_LIMIT_EXCEEDED",
      `一次最多绑定 ${MAX_VERIFICATION_EVIDENCE} 项验证证据`,
      400,
    );
  }
  const ids = new Set();
  return values.map((value) => {
    const id = compactText(value?.id, 180);
    if (!id || ids.has(id)) {
      throw projectWorkError(
        "GIT_CLOSEOUT_VERIFICATION_INVALID",
        "验证证据标识无效或重复",
        400,
      );
    }
    ids.add(id);
    if (value?.status !== "passed" || value?.exitCode !== 0) {
      throw projectWorkError(
        "GIT_CLOSEOUT_VERIFICATION_FAILED",
        "存在未通过的验证，不能创建提交预览",
        409,
      );
    }
    return {
      id,
      commandId: compactText(value?.commandId, 180) || null,
      status: "passed",
      exitCode: 0,
      changeSetId: compactText(value?.changeSetId, 180) || null,
      changeSetHash: compactText(value?.changeSetHash, 180) || null,
      commandBindingHash: compactText(value?.commandBindingHash, 180) || null,
      completedAt: compactText(value?.completedAt, 80) || null,
    };
  });
}

function safeStatusPath(value) {
  try {
    const normalized = normalizeProjectPath(value);
    return isFilteredProjectPath(normalized) ? null : normalized;
  } catch {
    return null;
  }
}

function internalStatusPath(value) {
  try {
    return normalizeProjectPath(value);
  } catch {
    return `__invalid_git_path__:${sha256(String(value))}`;
  }
}

function parseGitStatus(output) {
  const entries = new Map();
  let branch = null;
  let head = null;
  let hasStaged = false;
  let hasConflict = false;
  let hasMixed = false;
  let skippedRenameOrigin = false;

  for (const field of String(output ?? "").split("\0")) {
    if (!field) continue;
    if (skippedRenameOrigin) {
      skippedRenameOrigin = false;
      continue;
    }
    for (const line of field.split("\n")) {
      if (!line) continue;
      if (line.startsWith("# branch.head ")) {
        branch = line.slice("# branch.head ".length).trim() || null;
        continue;
      }
      if (line.startsWith("# branch.oid ")) {
        const value = line.slice("# branch.oid ".length).trim();
        head = value === "(initial)" ? null : value || null;
        continue;
      }
      if (line.startsWith("? ")) {
        const relativePath = safeStatusPath(line.slice(2));
        if (relativePath) {
          entries.set(relativePath, {
            path: relativePath,
            indexStatus: ".",
            worktreeStatus: "?",
            untracked: true,
            renamed: false,
          });
        }
        continue;
      }
      if (line.startsWith("u ")) {
        hasConflict = true;
        continue;
      }
      if (!line.startsWith("1 ") && !line.startsWith("2 ")) continue;
      const parts = line.split(" ");
      const xy = parts[1] ?? "..";
      const indexStatus = xy[0] ?? ".";
      const worktreeStatus = xy[1] ?? ".";
      const staged = indexStatus !== ".";
      const unstaged = worktreeStatus !== ".";
      if (staged) hasStaged = true;
      if (staged && unstaged) hasMixed = true;
      if (xy.includes("U")) hasConflict = true;
      const metadataFields = line.startsWith("2 ") ? 9 : 8;
      const relativePath = safeStatusPath(parts.slice(metadataFields).join(" "));
      if (relativePath) {
        entries.set(relativePath, {
          path: relativePath,
          indexStatus,
          worktreeStatus,
          untracked: false,
          renamed: line.startsWith("2 "),
        });
      }
      if (line.startsWith("2 ")) skippedRenameOrigin = true;
    }
  }

  return {
    branch,
    head,
    entries,
    hasStaged,
    hasConflict,
    hasMixed,
  };
}

function bindingPayload(record) {
  return {
    proposalId: record.id,
    proposalHash: record.proposalHash,
    conversationId: record.conversationId,
    turnId: record.turnId,
    changeSetId: record.changeSetId,
    changeSetHash: record.changeSetHash,
    branch: record.branch,
    head: record.head,
    commitMessage: record.commitMessage,
    files: record.files.map((file) => ({
      path: file.path,
      hash: file.hash,
      exists: file.exists,
      mode: file.mode,
      baseHash: file.baseHash,
      baseExists: file.baseExists,
      baseMode: file.baseMode,
    })),
    verificationEvidence: structuredClone(record.verificationEvidence),
  };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createGitCloseoutBinding(proposal) {
  return bindingPayload(proposal);
}

function publicRecord(record) {
  return structuredClone(record);
}

export function createGitCloseoutService({
  storageRoot,
  run = execFileAsync,
  idFactory = randomUUID,
  now = () => new Date(),
  checkpoint = null,
} = {}) {
  if (typeof storageRoot !== "string" || !storageRoot.trim()) {
    throw new Error("storageRoot is required");
  }
  const recordsRoot = path.resolve(storageRoot, "git-closeout");
  const queues = new Map();

  function timestamp() {
    return now().toISOString();
  }

  async function canonicalProjectRoot(projectRoot) {
    if (typeof projectRoot !== "string" || !projectRoot.trim()) {
      throw projectWorkError(
        "GIT_CLOSEOUT_ROOT_INVALID",
        "项目文件夹无效",
        400,
      );
    }
    let rootStat;
    let canonical;
    try {
      [rootStat, canonical] = await Promise.all([
        lstat(projectRoot),
        realpath(projectRoot),
      ]);
    } catch {
      throw projectWorkError(
        "GIT_CLOSEOUT_ROOT_UNAVAILABLE",
        "项目文件夹当前不可用",
        404,
        true,
      );
    }
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw projectWorkError(
        "GIT_CLOSEOUT_ROOT_INVALID",
        "项目根目录必须是普通文件夹",
        409,
      );
    }
    return canonical;
  }

  function rootFingerprint(canonicalRoot) {
    return sha256(canonicalRoot).slice(7, 39);
  }

  function recordsDirectory(canonicalRoot) {
    return path.join(recordsRoot, rootFingerprint(canonicalRoot));
  }

  function assertRecordId(recordId) {
    if (
      typeof recordId !== "string"
      || !RECORD_ID_PATTERN.test(recordId)
    ) {
      throw projectWorkError(
        "GIT_CLOSEOUT_PROPOSAL_ID_INVALID",
        "Git 收尾预览标识无效",
        400,
      );
    }
    return recordId;
  }

  function recordPath(canonicalRoot, recordId) {
    return path.join(
      recordsDirectory(canonicalRoot),
      `${assertRecordId(recordId)}.json`,
    );
  }

  function newRecordId() {
    const suffix = String(idFactory())
      .replace(/[^A-Za-z0-9._-]+/gu, "-")
      .replace(/^-+/u, "")
      .slice(0, 155);
    return assertRecordId(`git-closeout-${suffix || randomUUID()}`);
  }

  async function writeRecord(canonicalRoot, record) {
    const directory = recordsDirectory(canonicalRoot);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = recordPath(canonicalRoot, record.id);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, target);
    return publicRecord(record);
  }

  async function readRecord(canonicalRoot, recordId) {
    try {
      const value = JSON.parse(
        await readFile(recordPath(canonicalRoot, recordId), "utf8"),
      );
      if (
        !value
        || typeof value !== "object"
        || Array.isArray(value)
        || value.schemaVersion !== RECORD_SCHEMA_VERSION
        || value.rootFingerprint !== rootFingerprint(canonicalRoot)
      ) {
        throw new SyntaxError("invalid Git closeout record");
      }
      return value;
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw projectWorkError(
          "GIT_CLOSEOUT_PROPOSAL_NOT_FOUND",
          "Git 收尾预览不存在",
          404,
        );
      }
      if (error instanceof ProjectWorkError) throw error;
      throw projectWorkError(
        "GIT_CLOSEOUT_RECORD_CORRUPT",
        "Git 收尾记录损坏，需要人工检查",
        500,
      );
    }
  }

  async function git(canonicalRoot, args, {
    timeout = 10_000,
    encoding = "utf8",
  } = {}) {
    return run(
      "git",
      ["-C", canonicalRoot, ...args],
      {
        encoding,
        timeout,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
      },
    );
  }

  async function inspectRepository(canonicalRoot) {
    let output;
    try {
      ({ stdout: output } = await git(canonicalRoot, [
        "status",
        "--porcelain=v2",
        "--branch",
        "-z",
        "--untracked-files=all",
      ]));
    } catch {
      throw projectWorkError(
        "GIT_CLOSEOUT_NOT_A_REPOSITORY",
        "当前项目不是可用的 Git 工作区",
        409,
      );
    }
    const status = parseGitStatus(output);
    if (!status.head) {
      throw projectWorkError(
        "GIT_CLOSEOUT_HEAD_REQUIRED",
        "仓库需要先有一个基线提交",
        409,
      );
    }
    if (!status.branch || status.branch === "(detached)") {
      throw projectWorkError(
        "GIT_CLOSEOUT_DETACHED_HEAD",
        "当前处于 detached HEAD，不能执行受控收尾",
        409,
      );
    }
    return status;
  }

  function assertRepositoryCanPrepare(status, paths) {
    if (status.hasConflict) {
      throw projectWorkError(
        "GIT_CLOSEOUT_CONFLICT",
        "仓库存在未解决冲突，不能创建提交预览",
        409,
      );
    }
    if (status.hasMixed) {
      throw projectWorkError(
        "GIT_CLOSEOUT_MIXED_FILE",
        "仓库存在同时包含已暂存和未暂存内容的混合文件",
        409,
      );
    }
    if (status.hasStaged) {
      throw projectWorkError(
        "GIT_CLOSEOUT_EXISTING_STAGED_CHANGES",
        "暂存区已有内容；为避免混入用户现有工作，本次收尾已停止",
        409,
      );
    }
    for (const relativePath of paths) {
      const entry = status.entries.get(relativePath);
      if (!entry) {
        throw projectWorkError(
          "GIT_CLOSEOUT_PATH_NOT_CHANGED",
          "所选路径中包含当前没有改动的文件",
          409,
        );
      }
      if (entry.renamed) {
        throw projectWorkError(
          "GIT_CLOSEOUT_RENAME_UNSUPPORTED",
          "当前版本暂不自动提交重命名文件",
          409,
        );
      }
    }
  }

  async function fileBindings(canonicalRoot, paths, baseFiles) {
    const baseByPath = new Map(
      (baseFiles ?? []).map((file) => [file.path, file]),
    );
    const files = [];
    for (const relativePath of paths) {
      const state = await readBoundFileState(canonicalRoot, relativePath);
      const base = baseByPath.get(relativePath);
      files.push({
        path: relativePath,
        hash: state.hash,
        exists: state.exists,
        mode: state.exists ? state.mode : null,
        ...(base ?? {}),
      });
    }
    return files;
  }

  function gitModeForFileMode(mode) {
    return (mode & 0o111) === 0 ? "100644" : "100755";
  }

  async function readHeadFileState(canonicalRoot, relativePath) {
    const { stdout } = await git(canonicalRoot, [
      "ls-tree",
      "-z",
      "HEAD",
      "--",
      relativePath,
    ]);
    const entry = String(stdout).split("\0").find(Boolean);
    if (!entry) {
      return {
        exists: false,
        hash: null,
        mode: null,
      };
    }
    const tab = entry.indexOf("\t");
    const metadata = tab >= 0 ? entry.slice(0, tab) : entry;
    const match = metadata.match(/^([0-7]{6}) blob ([0-9a-f]{40,64})$/u);
    if (!match) {
      throw projectWorkError(
        "GIT_CLOSEOUT_HEAD_FILE_UNSUPPORTED",
        "所选路径在 HEAD 中不是可提交的普通文件",
        409,
      );
    }
    const { stdout: blob } = await git(
      canonicalRoot,
      ["cat-file", "blob", match[2]],
      { encoding: null },
    );
    return {
      exists: true,
      hash: sha256(Buffer.from(blob)),
      mode: match[1],
    };
  }

  async function assertBasesMatchHead(canonicalRoot, files) {
    for (const file of files) {
      const head = await readHeadFileState(canonicalRoot, file.path);
      const expectedMode = file.baseExists
        ? gitModeForFileMode(file.baseMode)
        : null;
      if (
        head.exists !== file.baseExists
        || head.hash !== file.baseHash
        || head.mode !== expectedMode
      ) {
        throw projectWorkError(
          "GIT_CLOSEOUT_BASE_NOT_HEAD",
          "所选文件在 Pi 接手前已有未提交改动，不能混入本次提交",
          409,
        );
      }
    }
  }

  function proposalHash(record) {
    return sha256({
      schemaVersion: RECORD_SCHEMA_VERSION,
      id: record.id,
      conversationId: record.conversationId,
      turnId: record.turnId,
      changeSetId: record.changeSetId,
      changeSetHash: record.changeSetHash,
      branch: record.branch,
      head: record.head,
      commitMessage: record.commitMessage,
      files: record.files,
      verificationEvidence: record.verificationEvidence,
    });
  }

  async function checkpointAt(phase, record) {
    if (typeof checkpoint === "function") {
      await checkpoint(phase, publicRecord(record));
    }
  }

  function withLock(canonicalRoot, operation) {
    const key = rootFingerprint(canonicalRoot);
    const previous = queues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    queues.set(key, current);
    return current.finally(() => {
      if (queues.get(key) === current) queues.delete(key);
    });
  }

  async function updateRecord(canonicalRoot, record, patch) {
    const next = {
      ...record,
      ...patch,
      updatedAt: timestamp(),
    };
    await writeRecord(canonicalRoot, next);
    return next;
  }

  async function currentHead(canonicalRoot) {
    const { stdout } = await git(canonicalRoot, ["rev-parse", "HEAD"]);
    return String(stdout).trim();
  }

  async function stagedPaths(canonicalRoot) {
    const { stdout } = await git(canonicalRoot, [
      "diff",
      "--cached",
      "--name-only",
      "-z",
    ]);
    return String(stdout)
      .split("\0")
      .filter(Boolean)
      .map(internalStatusPath)
      .sort(compareText);
  }

  async function resetSelectedIndex(canonicalRoot, record) {
    await git(canonicalRoot, [
      "reset",
      "--quiet",
      "HEAD",
      "--",
      ...record.files.map((file) => file.path),
    ]);
  }

  async function selectedFilesStillMatch(canonicalRoot, record) {
    const current = await fileBindings(
      canonicalRoot,
      record.files.map((file) => file.path),
      record.files.map((file) => ({
        path: file.path,
        baseExists: file.baseExists,
        baseHash: file.baseHash,
        baseMode: file.baseMode,
      })),
    );
    return sameJson(current, record.files);
  }

  async function verifyCreatedCommit(canonicalRoot, record) {
    if (!COMMIT_HASH_PATTERN.test(record.commitHash ?? "")) return false;
    try {
      const [{ stdout: tree }, { stdout: parents }] = await Promise.all([
        git(canonicalRoot, ["show", "-s", "--format=%T", record.commitHash]),
        git(canonicalRoot, ["show", "-s", "--format=%P", record.commitHash]),
      ]);
      return String(tree).trim() === record.treeHash
        && String(parents).trim() === record.head;
    } catch {
      return false;
    }
  }

  async function recoverRecord(canonicalRoot, source, {
    failure = null,
  } = {}) {
    let record = source;
    const head = await currentHead(canonicalRoot).catch(() => null);
    const commitMatches = await verifyCreatedCommit(canonicalRoot, record);

    if (
      record.commitHash
      && head === record.commitHash
      && commitMatches
    ) {
      record = await updateRecord(canonicalRoot, record, {
        status: "committed",
        committedAt: record.committedAt ?? timestamp(),
        error: null,
      });
      return record;
    }

    if (head !== record.head) {
      return updateRecord(canonicalRoot, record, {
        status: "recovery_blocked",
        error: {
          code: "GIT_CLOSEOUT_RECOVERY_HEAD_CHANGED",
          message: "Git HEAD 已变化，未自动回退索引",
          retryable: false,
        },
      });
    }

    const staged = await stagedPaths(canonicalRoot).catch(() => null);
    const expectedPaths = record.files.map((file) => file.path);
    const filesMatch = await selectedFilesStillMatch(
      canonicalRoot,
      record,
    ).catch(() => false);
    if (
      staged === null
      || !filesMatch
      || (
        staged.length > 0
        && !sameJson(staged, expectedPaths)
      )
    ) {
      return updateRecord(canonicalRoot, record, {
        status: "recovery_blocked",
        error: {
          code: "GIT_CLOSEOUT_RECOVERY_STATE_CHANGED",
          message: "Git 索引或所选文件已变化，未自动覆盖",
          retryable: false,
        },
      });
    }

    try {
      if (staged.length > 0) await resetSelectedIndex(canonicalRoot, record);
    } catch {
      return updateRecord(canonicalRoot, record, {
        status: "recovery_blocked",
        error: {
          code: "GIT_CLOSEOUT_RECOVERY_RESET_FAILED",
          message: "Git 索引未能安全恢复",
          retryable: false,
        },
      });
    }

    return updateRecord(canonicalRoot, record, {
      status: failure ? "failed" : "rolled_back",
      recoveredAt: timestamp(),
      error: failure,
    });
  }

  async function requestGitCloseout({
    projectRoot,
    conversationId,
    turnId,
    changeSetId,
    changeSetHash,
    commitMessage,
    paths,
    baseFiles,
    verificationEvidence,
  } = {}) {
    const canonicalRoot = await canonicalProjectRoot(projectRoot);
    return withLock(canonicalRoot, async () => {
      const ownership = normalizedOwnership({
        conversationId,
        turnId,
        changeSetId,
        changeSetHash,
      });
      const normalizedMessage = normalizedCommitMessage(commitMessage);
      const selectedPaths = normalizedPaths(paths);
      const bases = normalizedBaseFiles(baseFiles, selectedPaths);
      const evidence = normalizedVerificationEvidence(verificationEvidence);
      if (evidence.some((item) => (
        item.changeSetId !== ownership.changeSetId
        || item.changeSetHash !== ownership.changeSetHash
      ))) {
        throw projectWorkError(
          "GIT_CLOSEOUT_VERIFICATION_BINDING_MISMATCH",
          "验证证据与当前修改集绑定不一致",
          409,
        );
      }
      const status = await inspectRepository(canonicalRoot);
      assertRepositoryCanPrepare(status, selectedPaths);
      const files = await fileBindings(canonicalRoot, selectedPaths, bases);
      await assertBasesMatchHead(canonicalRoot, files);
      const createdAt = timestamp();
      let record = {
        schemaVersion: RECORD_SCHEMA_VERSION,
        id: newRecordId(),
        rootFingerprint: rootFingerprint(canonicalRoot),
        ...ownership,
        status: "ready",
        branch: status.branch,
        head: status.head,
        commitMessage: normalizedMessage,
        files,
        verificationEvidence: evidence,
        proposalHash: null,
        treeHash: null,
        commitHash: null,
        createdAt,
        updatedAt: createdAt,
        committedAt: null,
        recoveredAt: null,
        error: null,
      };
      record = {
        ...record,
        proposalHash: proposalHash(record),
      };
      await writeRecord(canonicalRoot, record);
      return publicRecord(record);
    });
  }

  function assertConfirmationBinding(record, confirmation) {
    const ownership = normalizedOwnership(confirmation);
    if (
      record.status !== "ready"
      || confirmation?.proposalId !== record.id
      || confirmation?.proposalHash !== record.proposalHash
      || ownership.conversationId !== record.conversationId
      || ownership.turnId !== record.turnId
      || ownership.changeSetId !== record.changeSetId
      || ownership.changeSetHash !== record.changeSetHash
      || confirmation?.branch !== record.branch
      || confirmation?.head !== record.head
      || confirmation?.commitMessage !== record.commitMessage
      || !sameJson(confirmation?.files, bindingPayload(record).files)
      || !sameJson(
        confirmation?.verificationEvidence,
        record.verificationEvidence,
      )
    ) {
      throw projectWorkError(
        "GIT_CLOSEOUT_BINDING_MISMATCH",
        "Git 收尾预览已变化，请刷新后重新确认",
        409,
        true,
      );
    }
  }

  async function assertProposalStillCurrent(canonicalRoot, record) {
    const status = await inspectRepository(canonicalRoot);
    if (status.branch !== record.branch || status.head !== record.head) {
      throw projectWorkError(
        "GIT_CLOSEOUT_HEAD_STALE",
        "分支或 HEAD 已变化，请重新生成提交预览",
        409,
        true,
      );
    }
    assertRepositoryCanPrepare(
      status,
      record.files.map((file) => file.path),
    );
    if (!await selectedFilesStillMatch(canonicalRoot, record)) {
      throw projectWorkError(
        "GIT_CLOSEOUT_FILES_STALE",
        "所选文件已变化，请重新生成提交预览",
        409,
        true,
      );
    }
    await assertBasesMatchHead(canonicalRoot, record.files);
  }

  async function markStale(canonicalRoot, record, error) {
    return updateRecord(canonicalRoot, record, {
      status: "stale",
      error: safeProjectWorkError(error),
    });
  }

  async function confirmGitCloseout({
    projectRoot,
    ...confirmation
  } = {}) {
    const canonicalRoot = await canonicalProjectRoot(projectRoot);
    return withLock(canonicalRoot, async () => {
      let record = await readRecord(canonicalRoot, confirmation.proposalId);
      assertConfirmationBinding(record, confirmation);
      try {
        await assertProposalStillCurrent(canonicalRoot, record);
      } catch (error) {
        if (error instanceof ProjectWorkError) {
          await markStale(canonicalRoot, record, error);
        }
        throw error;
      }

      try {
        record = await updateRecord(canonicalRoot, record, {
          status: "staging",
          error: null,
        });
        await checkpointAt("staging", record);
        await git(canonicalRoot, [
          "add",
          "--",
          ...record.files.map((file) => file.path),
        ]);

        const staged = await stagedPaths(canonicalRoot);
        if (!sameJson(staged, record.files.map((file) => file.path))) {
          throw projectWorkError(
            "GIT_CLOSEOUT_STAGED_SCOPE_MISMATCH",
            "实际暂存范围与确认预览不一致",
            409,
          );
        }
        try {
          await git(canonicalRoot, [
            "diff",
            "--cached",
            "--check",
            "--",
            ...record.files.map((file) => file.path),
          ]);
        } catch {
          throw projectWorkError(
            "GIT_CLOSEOUT_WHITESPACE_ERROR",
            "暂存内容包含 Git 检查发现的空白错误",
            409,
          );
        }
        const { stdout: treeOutput } = await git(
          canonicalRoot,
          ["write-tree"],
        );
        const treeHash = String(treeOutput).trim();
        if (!COMMIT_HASH_PATTERN.test(treeHash)) {
          throw new Error("invalid tree hash");
        }
        if (!await selectedFilesStillMatch(canonicalRoot, record)) {
          throw projectWorkError(
            "GIT_CLOSEOUT_FILES_STALE",
            "所选文件已变化，请重新生成提交预览",
            409,
            true,
          );
        }
        try {
          await git(canonicalRoot, [
            "diff",
            "--quiet",
            treeHash,
            "--",
            ...record.files.map((file) => file.path),
          ]);
        } catch {
          throw projectWorkError(
            "GIT_CLOSEOUT_STAGED_CONTENT_MISMATCH",
            "实际暂存内容与确认预览不一致",
            409,
          );
        }
        record = await updateRecord(canonicalRoot, record, {
          status: "staged",
          treeHash,
        });
        await checkpointAt("staged", record);

        const { stdout: commitOutput } = await git(canonicalRoot, [
          "commit-tree",
          treeHash,
          "-p",
          record.head,
          "-m",
          record.commitMessage,
        ]);
        const commitHash = String(commitOutput).trim();
        if (!COMMIT_HASH_PATTERN.test(commitHash)) {
          throw new Error("invalid commit hash");
        }
        record = await updateRecord(canonicalRoot, record, {
          status: "commit_created",
          commitHash,
        });
        await checkpointAt("commit_created", record);

        await git(canonicalRoot, [
          "update-ref",
          "-m",
          "pi-agent git closeout",
          "HEAD",
          commitHash,
          record.head,
        ]);
        record = await updateRecord(canonicalRoot, record, {
          status: "ref_updated",
        });
        await checkpointAt("ref_updated", record);

        if (
          await currentHead(canonicalRoot) !== commitHash
          || !await verifyCreatedCommit(canonicalRoot, record)
        ) {
          throw projectWorkError(
            "GIT_CLOSEOUT_READBACK_FAILED",
            "本地提交读回校验失败",
            409,
          );
        }
        record = await updateRecord(canonicalRoot, record, {
          status: "committed",
          committedAt: timestamp(),
          error: null,
        });
        await checkpointAt("committed", record);
        return publicRecord(record);
      } catch (error) {
        if (error?.simulatedCrash === true) throw error;
        const failure = {
          code: error instanceof ProjectWorkError
            ? error.code
            : "GIT_CLOSEOUT_COMMIT_FAILED",
          message: error instanceof ProjectWorkError
            ? error.message
            : "Git 本地提交没有完成",
          retryable: true,
        };
        const recovered = await recoverRecord(canonicalRoot, record, {
          failure,
        });
        if (recovered.status === "recovery_blocked") {
          throw projectWorkError(
            "GIT_CLOSEOUT_RECOVERY_BLOCKED",
            recovered.error?.message || "Git 收尾恢复被阻止",
            409,
          );
        }
        throw projectWorkError(
          failure.code,
          failure.message,
          409,
          true,
        );
      }
    });
  }

  async function getGitCloseout({
    projectRoot,
    proposalId,
    conversationId,
  } = {}) {
    const canonicalRoot = await canonicalProjectRoot(projectRoot);
    const record = await readRecord(canonicalRoot, proposalId);
    if (record.conversationId !== normalizedBindingId(
      conversationId,
      "conversationId",
    )) {
      throw projectWorkError(
        "GIT_CLOSEOUT_PROPOSAL_NOT_FOUND",
        "Git 收尾预览不存在",
        404,
      );
    }
    return publicRecord(record);
  }

  async function listGitCloseouts({ projectRoot, conversationId } = {}) {
    const canonicalRoot = await canonicalProjectRoot(projectRoot);
    const ownerId = normalizedBindingId(conversationId, "conversationId");
    let names;
    try {
      names = await readdir(recordsDirectory(canonicalRoot));
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const records = [];
    for (const name of names.filter((value) => value.endsWith(".json")).sort()) {
      records.push(await readRecord(canonicalRoot, name.slice(0, -5)));
    }
    return records
      .filter((record) => record.conversationId === ownerId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(publicRecord);
  }

  async function recoverGitCloseouts({ projectRoot, conversationId } = {}) {
    const canonicalRoot = await canonicalProjectRoot(projectRoot);
    const ownerId = normalizedBindingId(conversationId, "conversationId");
    return withLock(canonicalRoot, async () => {
      const records = await listGitCloseouts({
        projectRoot: canonicalRoot,
        conversationId: ownerId,
      });
      const recovered = [];
      for (const source of records) {
        if (!PENDING_TRANSACTION_STATUSES.has(source.status)) continue;
        recovered.push(await recoverRecord(canonicalRoot, source));
      }
      return recovered.map(publicRecord);
    });
  }

  return {
    confirmGitCloseout,
    getGitCloseout,
    listGitCloseouts,
    recoverGitCloseouts,
    requestGitCloseout,
  };
}
