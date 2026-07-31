import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import {
  getProjectFileTree,
  isFilteredProjectPath,
  normalizeProjectPath,
  readProjectTextFile,
} from "./workspace.js";

const MAX_SEARCH_BYTES = 8 * 1024 * 1024;
const MAX_SEARCH_FILES = 2_000;
const MAX_OUTPUT_CHARS = 64_000;
const MAX_RESULTS = 500;
const SAFE_ERROR_PREFIXES = [
  "Contained subagent workspace",
  "Path is outside",
  "Symbolic links are not allowed",
  "Not a file:",
  "Not a directory:",
  "Search pattern",
  "Find pattern",
];

function textResult(text, details = {}) {
  return {
    content: [{ type: "text", text: String(text).slice(0, MAX_OUTPUT_CHARS) }],
    details,
  };
}

function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function publicContainedError(error) {
  if (
    typeof error?.code === "string"
    && error.code.startsWith("PROJECT_WORK_")
  ) {
    return error;
  }
  const message = typeof error?.message === "string" ? error.message : "";
  if (SAFE_ERROR_PREFIXES.some((prefix) => message.startsWith(prefix))) {
    return error;
  }
  if (error?.name === "SyntaxError") {
    return new Error("Search pattern is invalid");
  }
  if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
    return new Error("Contained project path was not found");
  }
  if (error?.code === "EACCES" || error?.code === "EPERM") {
    return new Error("Contained project path is unavailable");
  }
  return new Error("Contained read-only operation failed");
}

async function canonicalRoot(cwd) {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) {
    throw new Error("Contained subagent workspace is unavailable");
  }
  const [root, stat] = await Promise.all([realpath(cwd), lstat(cwd)]);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Contained subagent workspace is unsafe");
  }
  return root;
}

async function resolveContained(root, rawPath, {
  allowRoot = false,
  expectedKind,
} = {}) {
  const normalized = normalizeProjectPath(String(rawPath ?? ""), {
    allowEmpty: allowRoot,
  });
  if (normalized && isFilteredProjectPath(normalized)) {
    throw new Error("Path is outside the filtered project workspace");
  }
  let target = root;
  let stat = await lstat(root);
  for (const segment of normalized ? normalized.split("/") : []) {
    target = path.join(target, segment);
    stat = await lstat(target);
    if (stat.isSymbolicLink()) {
      throw new Error("Symbolic links are not allowed in the contained project workspace");
    }
  }
  const canonicalTarget = await realpath(target);
  if (!isInside(root, canonicalTarget)) {
    throw new Error("Path is outside the contained project workspace");
  }
  if (
    expectedKind === "file" && !stat.isFile()
    || expectedKind === "directory" && !stat.isDirectory()
  ) {
    throw new Error(`Not a ${expectedKind}: ${normalized || "."}`);
  }
  return { normalized, target: canonicalTarget, stat };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function boundedSearchExpression(pattern, { literal, ignoreCase }) {
  if (typeof pattern !== "string" || !pattern || pattern.length > 200) {
    throw new Error("Search pattern must contain 1-200 characters");
  }
  if (
    !literal
    && (
      pattern.includes("(?)")
      || pattern.includes("(?")
      || /\\[1-9]/.test(pattern)
      || /(?:[+*}]|\{\d+(?:,\d*)?\})\s*(?:[+*{])/.test(pattern)
      || /\([^()]*(?:[+*]|\{\d+(?:,\d*)?\})[^()]*\)\s*(?:[+*]|\{\d+(?:,\d*)?\})/.test(pattern)
    )
  ) {
    throw new Error("Search pattern uses an unsupported expensive expression");
  }
  return new RegExp(literal ? escapeRegExp(pattern) : pattern, ignoreCase ? "i" : "");
}

function globExpression(pattern) {
  if (typeof pattern !== "string" || !pattern || pattern.length > 240) {
    throw new Error("Find pattern must contain 1-240 characters");
  }
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += escapeRegExp(character);
    }
  }
  return new RegExp(`${source}$`);
}

async function walkFiles(root, startPath, visitor) {
  const start = await resolveContained(root, startPath, { allowRoot: true });
  let files = 0;
  let bytes = 0;
  let truncated = false;

  async function visit(target, relativePath, stat) {
    if (truncated) return;
    if (stat.isFile()) {
      files += 1;
      bytes += stat.size;
      if (files > MAX_SEARCH_FILES || bytes > MAX_SEARCH_BYTES) {
        truncated = true;
        return;
      }
      if (await visitor({ relativePath, stat }) === false) truncated = true;
      return;
    }
    if (!stat.isDirectory()) return;
    const entries = await readdir(target, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      if (truncated) return;
      const childPath = [relativePath, entry.name].filter(Boolean).join("/");
      if (isFilteredProjectPath(childPath)) continue;
      const childTarget = path.join(target, entry.name);
      const childStat = await lstat(childTarget);
      if (childStat.isSymbolicLink()) continue;
      await visit(childTarget, childPath, childStat);
    }
  }

  await visit(start.target, start.normalized, start.stat);
  return { files, bytes, truncated };
}

export function createContainedSubagentToolDefinitions() {
  const tools = [
    {
      name: "read",
      label: "read (contained)",
      description: "Read a UTF-8 text file using a project-relative path inside the filtered read-only view.",
      promptSnippet: "Read a contained project text file by relative path",
      parameters: Type.Object({
        path: Type.String(),
        offset: Type.Optional(Type.Number()),
        limit: Type.Optional(Type.Number()),
      }, { additionalProperties: false }),
      async execute(_toolCallId, { path: filePath, offset, limit }, _signal, _onUpdate, ctx) {
        const root = await canonicalRoot(ctx.cwd);
        const normalized = normalizeProjectPath(filePath);
        await resolveContained(root, normalized, { expectedKind: "file" });
        const startLine = Number.isInteger(offset) && offset > 0 ? offset : 1;
        const requestedLimit = Number.isInteger(limit) && limit > 0
          ? Math.min(limit, 1_000)
          : 500;
        const file = await readProjectTextFile(root, {
          filePath: normalized,
          startLine,
          endLine: startLine + requestedLimit - 1,
        });
        const remaining = file.totalLines - file.endLine;
        return textResult(
          `${file.content}${remaining > 0 ? `\n\n[${remaining} more lines; continue at offset ${file.endLine + 1}]` : ""}`,
          {
            path: file.path,
            contentHash: file.hash,
            startLine: file.startLine,
            endLine: file.endLine,
            totalLines: file.totalLines,
          },
        );
      },
    },
    {
      name: "ls",
      label: "ls (contained)",
      description: "List one project-relative directory inside the filtered read-only view.",
      promptSnippet: "List a contained project directory",
      parameters: Type.Object({
        path: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Number()),
      }, { additionalProperties: false }),
      async execute(_toolCallId, { path: directoryPath = "", limit }, _signal, _onUpdate, ctx) {
        const root = await canonicalRoot(ctx.cwd);
        const directory = await resolveContained(root, directoryPath, {
          allowRoot: true,
          expectedKind: "directory",
        });
        const tree = await getProjectFileTree(root, {
          directory: directory.normalized,
          depth: 1,
        });
        const maxEntries = Number.isInteger(limit)
          ? Math.min(Math.max(limit, 1), MAX_RESULTS)
          : MAX_RESULTS;
        const visible = tree.entries.slice(0, maxEntries).map((entry) => (
          `${entry.name}${entry.type === "directory" ? "/" : ""}`
        ));
        return textResult(visible.join("\n") || "(empty directory)", {
          path: directory.normalized,
          truncated: tree.truncated || tree.entries.length > visible.length,
        });
      },
    },
    {
      name: "find",
      label: "find (contained)",
      description: "Find files with a bounded glob under a project-relative directory without shell access.",
      promptSnippet: "Find contained project files",
      parameters: Type.Object({
        pattern: Type.String(),
        path: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Number()),
      }, { additionalProperties: false }),
      async execute(_toolCallId, { pattern, path: directoryPath = "", limit }, _signal, _onUpdate, ctx) {
        const root = await canonicalRoot(ctx.cwd);
        const start = await resolveContained(root, directoryPath, { allowRoot: true });
        const expression = globExpression(pattern);
        const maxResults = Number.isInteger(limit)
          ? Math.min(Math.max(limit, 1), MAX_RESULTS)
          : 200;
        const matches = [];
        const walked = await walkFiles(root, start.normalized, ({ relativePath }) => {
          const relativeToStart = start.normalized
            ? path.posix.relative(start.normalized, relativePath)
            : relativePath;
          if (expression.test(relativeToStart) || expression.test(relativePath)) {
            matches.push(relativePath);
          }
          return matches.length < maxResults;
        });
        return textResult(matches.join("\n") || "No files found matching pattern", {
          count: matches.length,
          truncated: walked.truncated || matches.length >= maxResults,
        });
      },
    },
    {
      name: "grep",
      label: "grep (contained)",
      description: "Search bounded UTF-8 project text files without shell access.",
      promptSnippet: "Search contained project text files",
      parameters: Type.Object({
        pattern: Type.String(),
        path: Type.Optional(Type.String()),
        glob: Type.Optional(Type.String()),
        ignoreCase: Type.Optional(Type.Boolean()),
        literal: Type.Optional(Type.Boolean()),
        context: Type.Optional(Type.Number()),
        limit: Type.Optional(Type.Number()),
      }, { additionalProperties: false }),
      async execute(_toolCallId, {
        pattern,
        path: searchPath = "",
        glob,
        ignoreCase = false,
        literal = false,
        context = 0,
        limit,
      }, _signal, _onUpdate, ctx) {
        const root = await canonicalRoot(ctx.cwd);
        const start = await resolveContained(root, searchPath, { allowRoot: true });
        const expression = boundedSearchExpression(pattern, { literal, ignoreCase });
        const globFilter = glob ? globExpression(glob) : null;
        const maxResults = Number.isInteger(limit)
          ? Math.min(Math.max(limit, 1), MAX_RESULTS)
          : 200;
        const contextLines = Number.isInteger(context)
          ? Math.min(Math.max(context, 0), 5)
          : 0;
        const matches = [];
        const walked = await walkFiles(root, start.normalized, async ({ relativePath, stat }) => {
          if (stat.size > 1024 * 1024 || globFilter && !globFilter.test(relativePath)) {
            return true;
          }
          let file;
          try {
            file = await readProjectTextFile(root, {
              filePath: relativePath,
              endLine: Number.MAX_SAFE_INTEGER,
            });
          } catch {
            return true;
          }
          const lines = file.content.split(/\r\n|\n|\r/);
          for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
            expression.lastIndex = 0;
            if (!expression.test(lines[lineIndex].slice(0, 20_000))) continue;
            const from = Math.max(0, lineIndex - contextLines);
            const to = Math.min(lines.length, lineIndex + contextLines + 1);
            for (let index = from; index < to; index += 1) {
              matches.push(`${relativePath}:${index + 1}: ${lines[index].slice(0, 20_000)}`);
              if (matches.length >= maxResults) return false;
            }
          }
          return true;
        });
        return textResult(matches.join("\n") || "No matches found", {
          count: matches.length,
          truncated: walked.truncated || matches.length >= maxResults,
        });
      },
    },
  ];
  return tools.map((tool) => ({
    ...tool,
    async execute(...args) {
      try {
        return await tool.execute(...args);
      } catch (error) {
        throw publicContainedError(error);
      }
    },
  }));
}

export default function registerContainedSubagentTools(pi) {
  for (const tool of createContainedSubagentToolDefinitions()) {
    pi.registerTool(tool);
  }
}
