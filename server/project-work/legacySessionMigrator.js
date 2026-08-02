import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { projectWorkError } from "./errors.js";

async function canonicalDirectory(directory, label) {
  try {
    const [canonical, stat] = await Promise.all([
      realpath(directory),
      lstat(directory),
    ]);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(label);
    return canonical;
  } catch {
    throw projectWorkError(
      "PROJECT_WORK_SESSION_WORKSPACE_MIGRATION_BLOCKED",
      `Pi 会话${label}不可用，旧会话记录已保留`,
      409,
      true,
    );
  }
}

function assertMigratedSession({ source, target, targetCwd, checkpoints }) {
  const sourceIds = source.getEntries().map((entry) => entry.id);
  const targetIds = target.getEntries().map((entry) => entry.id);
  if (
    JSON.stringify(targetIds) !== JSON.stringify(sourceIds)
    || (target.getLeafId() ?? null) !== (source.getLeafId() ?? null)
    || path.resolve(target.getCwd()) !== path.resolve(targetCwd)
  ) {
    throw new Error("migrated Pi session tree, leaf, or cwd did not match");
  }
  for (const checkpoint of checkpoints ?? []) {
    const entry = target.getEntry(checkpoint.id);
    if (
      !entry
      || entry.type !== "message"
      || entry.message?.role !== checkpoint.role
    ) {
      throw new Error("migrated Pi session checkpoint did not match");
    }
  }
}

export async function migrateLegacyProjectWorkSession({
  legacyWorkspaceRoot,
  targetWorkspaceRoot,
  sessionDir,
  checkpoints = [],
} = {}) {
  const legacyDiscoveryCwd = path.resolve(legacyWorkspaceRoot);
  const [legacyCwd, targetCwd, canonicalSessionDir] = await Promise.all([
    canonicalDirectory(legacyWorkspaceRoot, "旧工作目录"),
    canonicalDirectory(targetWorkspaceRoot, "目标工作目录"),
    canonicalDirectory(sessionDir, "存储目录"),
  ]);
  let source = SessionManager.continueRecent(
    legacyDiscoveryCwd,
    canonicalSessionDir,
  );
  if (
    source.getEntries().length === 0
    && legacyDiscoveryCwd !== legacyCwd
  ) {
    source = SessionManager.continueRecent(legacyCwd, canonicalSessionDir);
  }
  if (source.getEntries().length === 0) {
    return {
      status: "empty",
      sessionId: null,
      entryCount: 0,
      leafId: null,
    };
  }

  const existingTarget = SessionManager.continueRecent(
    targetCwd,
    canonicalSessionDir,
  );
  if (existingTarget.getEntries().length > 0) {
    try {
      assertMigratedSession({
        source,
        target: existingTarget,
        targetCwd,
        checkpoints,
      });
    } catch {
      throw projectWorkError(
        "PROJECT_WORK_SESSION_WORKSPACE_MIGRATION_BLOCKED",
        "目标 Pi 会话与旧会话树不一致，旧会话记录已保留",
        409,
        true,
      );
    }
    return {
      status: "already_migrated",
      sessionId: existingTarget.getSessionId(),
      entryCount: existingTarget.getEntries().length,
      leafId: existingTarget.getLeafId() ?? null,
    };
  }

  const sourceFile = source.getSessionFile();
  if (!sourceFile) {
    throw projectWorkError(
      "PROJECT_WORK_SESSION_WORKSPACE_MIGRATION_BLOCKED",
      "旧 Pi 会话缺少持久记录，旧会话记录已保留",
      409,
      true,
    );
  }
  const temporaryDir = await mkdtemp(path.join(
    path.dirname(canonicalSessionDir),
    "pi-session-migration-",
  ));
  let committedFile = null;
  try {
    const migrated = SessionManager.forkFrom(
      sourceFile,
      targetCwd,
      temporaryDir,
    );
    assertMigratedSession({
      source,
      target: migrated,
      targetCwd,
      checkpoints,
    });
    const temporaryFile = migrated.getSessionFile();
    if (!temporaryFile) throw new Error("migrated Pi session file is missing");
    await mkdir(canonicalSessionDir, { recursive: true, mode: 0o700 });
    committedFile = path.join(
      canonicalSessionDir,
      `${randomUUID()}-${path.basename(temporaryFile)}`,
    );
    await rename(temporaryFile, committedFile);
    const committed = SessionManager.open(
      committedFile,
      canonicalSessionDir,
      targetCwd,
    );
    assertMigratedSession({
      source,
      target: committed,
      targetCwd,
      checkpoints,
    });
    return {
      status: "migrated",
      sessionId: committed.getSessionId(),
      entryCount: committed.getEntries().length,
      leafId: committed.getLeafId() ?? null,
    };
  } catch {
    if (committedFile) {
      await rm(committedFile, { force: true }).catch(() => undefined);
    }
    throw projectWorkError(
      "PROJECT_WORK_SESSION_WORKSPACE_MIGRATION_BLOCKED",
      "Pi 会话未能迁移到真实 Workspace，旧会话记录已保留",
      409,
      true,
    );
  } finally {
    await rm(temporaryDir, { recursive: true, force: true })
      .catch(() => undefined);
  }
}
