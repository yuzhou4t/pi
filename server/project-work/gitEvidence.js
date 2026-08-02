import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  isFilteredProjectPath,
  normalizeProjectPath,
} from "./workspace.js";

const execFileAsync = promisify(execFile);
const MAX_STATUS_ENTRIES = 2_000;

function safePath(value) {
  try {
    const normalized = normalizeProjectPath(value);
    return isFilteredProjectPath(normalized) ? null : normalized;
  } catch {
    return null;
  }
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function parseGitStatusPorcelainV2(output) {
  const fields = String(output ?? "").split("\0");
  const staged = [];
  const unstaged = [];
  const untracked = [];
  let branch = null;
  let head = null;
  let skippedRenameOrigin = false;

  for (const rawField of fields) {
    if (!rawField) continue;
    if (skippedRenameOrigin) {
      skippedRenameOrigin = false;
      continue;
    }
    for (const line of rawField.split("\n")) {
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
        const filePath = safePath(line.slice(2));
        if (filePath) untracked.push(filePath);
        continue;
      }
      if (!line.startsWith("1 ") && !line.startsWith("2 ")) continue;
      const parts = line.split(" ");
      const xy = parts[1] ?? "..";
      const metadataFields = line.startsWith("2 ") ? 9 : 8;
      const filePath = safePath(parts.slice(metadataFields).join(" "));
      if (filePath) {
        if (xy[0] && xy[0] !== ".") staged.push(filePath);
        if (xy[1] && xy[1] !== ".") unstaged.push(filePath);
      }
      if (line.startsWith("2 ")) skippedRenameOrigin = true;
    }
  }

  const bounded = (values) => uniqueSorted(values).slice(0, MAX_STATUS_ENTRIES);
  return {
    available: true,
    branch,
    head,
    staged: bounded(staged),
    unstaged: bounded(unstaged),
    untracked: bounded(untracked),
    truncated: staged.length > MAX_STATUS_ENTRIES
      || unstaged.length > MAX_STATUS_ENTRIES
      || untracked.length > MAX_STATUS_ENTRIES,
  };
}

export async function inspectGitEvidence(projectRoot, {
  run = execFileAsync,
} = {}) {
  try {
    const { stdout } = await run(
      "git",
      [
        "-C",
        projectRoot,
        "status",
        "--porcelain=v2",
        "--branch",
        "-z",
        "--untracked-files=all",
      ],
      {
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
      },
    );
    return parseGitStatusPorcelainV2(stdout);
  } catch (error) {
    return {
      available: false,
      branch: null,
      head: null,
      staged: [],
      unstaged: [],
      untracked: [],
      truncated: false,
      reason: error?.code === "ENOENT"
        ? "git_unavailable"
        : "not_a_git_worktree",
    };
  }
}
