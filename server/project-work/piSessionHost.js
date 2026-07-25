import { randomUUID } from "node:crypto";
import {
  lstat,
  link,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import { Type } from "typebox";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { projectWorkError } from "./errors.js";
import {
  isFilteredProjectPath,
  normalizeProjectPath,
  readSafeAgentsFiles,
} from "./workspace.js";

const TOOL_NAMES = [
  "read",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "update_plan",
  "request_verification",
];
const MAX_TOOL_FILE_BYTES = 1024 * 1024;
const MAX_SEARCH_BYTES = 8 * 1024 * 1024;
const MAX_SEARCH_FILES = 2_000;
const MAX_TOOL_OUTPUT_CHARS = 64_000;
const APP_GUIDANCE = [
  "You are working in an isolated review snapshot, not the user's live project.",
  "Use only the provided contained file tools. They cannot access paths outside this snapshot.",
  "Keep the public plan current with update_plan.",
  "Use request_verification to propose a bounded verification command; it never runs until the user explicitly starts it.",
  "Edits in this snapshot are proposals. Never claim that the live project changed before the app confirms an applied change set.",
].join("\n");

function workspaceSnapshotGuidance(workspaceSnapshot) {
  if (workspaceSnapshot?.truncated !== true) return "";
  const includedFiles = Number.isSafeInteger(workspaceSnapshot.includedFiles)
    ? workspaceSnapshot.includedFiles
    : null;
  return [
    "The server reports that this large-project snapshot is incomplete.",
    includedFiles === null
      ? "It contains a bounded subset of editable text files."
      : `It contains ${includedFiles} editable text files.`,
    "Never claim that you inspected the entire project.",
    "If a requested path is missing, explain that it may be outside the current snapshot and ask the user to bind a narrower project folder.",
  ].join("\n");
}

function textResult(text, details) {
  return {
    content: [{ type: "text", text: String(text).slice(0, MAX_TOOL_OUTPUT_CHARS) }],
    details,
  };
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolveContainedPath(root, rawPath, {
  allowRoot = false,
  allowMissingLeaf = false,
  createParents = false,
  expectedKind,
} = {}) {
  const normalized = normalizeProjectPath(String(rawPath ?? ""), {
    allowEmpty: allowRoot,
  });
  if (normalized && isFilteredProjectPath(normalized)) {
    throw new Error("Path is outside the filtered project workspace");
  }
  const segments = normalized ? normalized.split("/") : [];
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const isLeaf = index === segments.length - 1;
    let currentStat;
    try {
      currentStat = await lstat(current);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      if (createParents && !isLeaf) {
        await mkdir(current, { mode: 0o700 });
        continue;
      }
      if (allowMissingLeaf && isLeaf) {
        return { normalized, target: current, stat: null };
      }
      throw new Error(`Path not found: ${normalized}`);
    }
    if (currentStat.isSymbolicLink()) {
      throw new Error("Symbolic links are not available in the filtered workspace");
    }
    const canonicalCurrent = await realpath(current);
    if (!isInside(root, canonicalCurrent)) {
      throw new Error("Path is outside the filtered project workspace");
    }
    if (!isLeaf && !currentStat.isDirectory()) {
      throw new Error(`Not a directory: ${segments.slice(0, index + 1).join("/")}`);
    }
    if (isLeaf) {
      if (expectedKind === "file" && !currentStat.isFile()) {
        throw new Error(`Not a file: ${normalized}`);
      }
      if (expectedKind === "directory" && !currentStat.isDirectory()) {
        throw new Error(`Not a directory: ${normalized || "."}`);
      }
      return { normalized, target: canonicalCurrent, stat: currentStat };
    }
  }
  const rootStat = await lstat(root);
  if (expectedKind === "file") throw new Error("Not a file: .");
  return { normalized: "", target: root, stat: rootStat };
}

async function readBoundedText(root, rawPath) {
  const resolved = await resolveContainedPath(root, rawPath, {
    expectedKind: "file",
  });
  if (resolved.stat.size > MAX_TOOL_FILE_BYTES) {
    throw new Error("File exceeds the contained tool size limit");
  }
  const buffer = await readFile(resolved.target);
  if (buffer.subarray(0, Math.min(buffer.length, 8_192)).includes(0)) {
    throw new Error("Binary files are not supported by this tool");
  }
  return {
    ...resolved,
    content: buffer.toString("utf8"),
    mode: resolved.stat.mode & 0o777,
  };
}

async function atomicScratchWrite(root, rawPath, content, mode = 0o600) {
  if (Buffer.byteLength(content, "utf8") > MAX_TOOL_FILE_BYTES) {
    throw new Error("File exceeds the contained tool size limit");
  }
  const resolved = await resolveContainedPath(root, rawPath, {
    allowMissingLeaf: true,
    createParents: true,
  });
  if (resolved.stat && !resolved.stat.isFile()) {
    throw new Error(`Not a file: ${resolved.normalized}`);
  }
  const temporaryPath = path.join(
    path.dirname(resolved.target),
    `.${path.basename(resolved.target)}.${randomUUID()}.tmp`,
  );
  await writeFile(temporaryPath, content, {
    encoding: "utf8",
    flag: "wx",
    mode,
  });
  try {
    const checked = await resolveContainedPath(root, rawPath, {
      allowMissingLeaf: true,
    });
    if (
      (resolved.stat === null && checked.stat !== null)
      || (resolved.stat !== null && checked.stat === null)
    ) {
      throw new Error("File changed while the contained write was being prepared");
    }
    if (resolved.stat === null) {
      await link(temporaryPath, resolved.target);
      await unlink(temporaryPath);
    } else {
      await rename(temporaryPath, resolved.target);
    }
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  return resolved.normalized;
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
      pattern.includes("(?")
      || /\\[1-9]/.test(pattern)
      || /(?:[+*}]|\{\d+(?:,\d*)?\})\s*(?:[+*{])/.test(pattern)
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

async function walkContainedFiles(root, start, visitor, {
  maxFiles = MAX_SEARCH_FILES,
  maxBytes = MAX_SEARCH_BYTES,
} = {}) {
  let files = 0;
  let bytes = 0;
  let stopped = false;

  async function visit(directoryPath, relativeDirectory) {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (stopped) return;
      const relativePath = [relativeDirectory, entry.name].filter(Boolean).join("/");
      if (isFilteredProjectPath(relativePath)) continue;
      const targetPath = path.join(directoryPath, entry.name);
      const targetStat = await lstat(targetPath);
      if (targetStat.isSymbolicLink()) continue;
      if (targetStat.isDirectory()) {
        await visit(targetPath, relativePath);
      } else if (targetStat.isFile()) {
        files += 1;
        bytes += targetStat.size;
        if (files > maxFiles || bytes > maxBytes) {
          stopped = true;
          return;
        }
        if (await visitor({
          relativePath,
          targetPath,
          stat: targetStat,
        }) === false) {
          stopped = true;
          return;
        }
      }
    }
  }

  await visit(start.target, start.normalized);
  return { files, bytes, truncated: stopped };
}

function createReadTool(root) {
  return defineTool({
    name: "read",
    label: "read",
    description: "Read a text file inside the isolated project snapshot.",
    promptSnippet: "Read a contained project text file",
    parameters: Type.Object({
      path: Type.String(),
      offset: Type.Optional(Type.Number()),
      limit: Type.Optional(Type.Number()),
    }),
    async execute(_toolCallId, { path: filePath, offset, limit }) {
      const file = await readBoundedText(root, filePath);
      const lines = file.content.split(/\r\n|\n|\r/);
      const start = Number.isInteger(offset) && offset > 0 ? offset - 1 : 0;
      const count = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 1_000) : 500;
      if (start >= lines.length) throw new Error("Offset is beyond the end of the file");
      const selected = lines.slice(start, start + count);
      const continuation = start + selected.length < lines.length
        ? `\n\n[${lines.length - start - selected.length} more lines; continue at offset ${start + selected.length + 1}]`
        : "";
      return textResult(`${selected.join("\n")}${continuation}`, {
        path: file.normalized,
        startLine: start + 1,
        endLine: start + selected.length,
        totalLines: lines.length,
      });
    },
  });
}

function createWriteTool(root) {
  return defineTool({
    name: "write",
    label: "write",
    description: "Write a text file inside the isolated project snapshot.",
    promptSnippet: "Write a contained project text file",
    executionMode: "sequential",
    parameters: Type.Object({
      path: Type.String(),
      content: Type.String(),
    }),
    async execute(_toolCallId, { path: filePath, content }) {
      const normalized = await atomicScratchWrite(root, filePath, content);
      return textResult(`Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${normalized}`, {
        path: normalized,
      });
    },
  });
}

function createEditTool(root) {
  return defineTool({
    name: "edit",
    label: "edit",
    description: "Apply exact text replacements to one file inside the isolated project snapshot.",
    promptSnippet: "Edit a contained project text file",
    executionMode: "sequential",
    parameters: Type.Object({
      path: Type.String(),
      edits: Type.Array(Type.Object({
        oldText: Type.String(),
        newText: Type.String(),
      }), { minItems: 1, maxItems: 32 }),
    }),
    async execute(_toolCallId, { path: filePath, edits }) {
      const file = await readBoundedText(root, filePath);
      const replacements = edits.map((edit) => {
        if (!edit.oldText) throw new Error("oldText cannot be empty");
        const first = file.content.indexOf(edit.oldText);
        if (first < 0) throw new Error("oldText was not found in the original file");
        if (file.content.indexOf(edit.oldText, first + 1) >= 0) {
          throw new Error("oldText must be unique in the original file");
        }
        return { ...edit, start: first, end: first + edit.oldText.length };
      }).sort((left, right) => left.start - right.start);
      for (let index = 1; index < replacements.length; index += 1) {
        if (replacements[index].start < replacements[index - 1].end) {
          throw new Error("Edit replacements cannot overlap");
        }
      }
      let next = file.content;
      for (const replacement of [...replacements].reverse()) {
        next = `${next.slice(0, replacement.start)}${replacement.newText}${next.slice(replacement.end)}`;
      }
      await atomicScratchWrite(root, file.normalized, next, file.mode);
      const patch = createTwoFilesPatch(
        `a/${file.normalized}`,
        `b/${file.normalized}`,
        file.content,
        next,
        "",
        "",
        { context: 3 },
      );
      return textResult(`Updated ${file.normalized}`, {
        path: file.normalized,
        patch: patch.slice(0, MAX_TOOL_OUTPUT_CHARS),
      });
    },
  });
}

function createLsTool(root) {
  return defineTool({
    name: "ls",
    label: "ls",
    description: "List a directory inside the isolated project snapshot.",
    promptSnippet: "List a contained project directory",
    parameters: Type.Object({
      path: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number()),
    }),
    async execute(_toolCallId, { path: directoryPath = "", limit }) {
      const directory = await resolveContainedPath(root, directoryPath, {
        allowRoot: true,
        expectedKind: "directory",
      });
      const maxEntries = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 500) : 500;
      const entries = await readdir(directory.target, { withFileTypes: true });
      const visible = [];
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        const relativePath = [directory.normalized, entry.name].filter(Boolean).join("/");
        if (isFilteredProjectPath(relativePath)) continue;
        const entryStat = await lstat(path.join(directory.target, entry.name));
        if (entryStat.isSymbolicLink()) continue;
        visible.push(`${entry.name}${entryStat.isDirectory() ? "/" : ""}`);
        if (visible.length >= maxEntries) break;
      }
      return textResult(visible.join("\n") || "(empty directory)", {
        path: directory.normalized,
        truncated: visible.length >= maxEntries,
      });
    },
  });
}

function createFindTool(root) {
  return defineTool({
    name: "find",
    label: "find",
    description: "Find project files by a bounded glob pattern without running external programs.",
    promptSnippet: "Find contained project files",
    parameters: Type.Object({
      pattern: Type.String(),
      path: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number()),
    }),
    async execute(_toolCallId, { pattern, path: directoryPath = "", limit }) {
      const directory = await resolveContainedPath(root, directoryPath, {
        allowRoot: true,
        expectedKind: "directory",
      });
      const expression = globExpression(pattern);
      const maxResults = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 500) : 200;
      const matches = [];
      const walked = await walkContainedFiles(root, directory, ({ relativePath }) => {
        const relativeToStart = directory.normalized
          ? path.posix.relative(directory.normalized, relativePath)
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
  });
}

function createGrepTool(root) {
  return defineTool({
    name: "grep",
    label: "grep",
    description: "Search bounded project text files without running external programs.",
    promptSnippet: "Search contained project text files",
    parameters: Type.Object({
      pattern: Type.String(),
      path: Type.Optional(Type.String()),
      glob: Type.Optional(Type.String()),
      ignoreCase: Type.Optional(Type.Boolean()),
      literal: Type.Optional(Type.Boolean()),
      context: Type.Optional(Type.Number()),
      limit: Type.Optional(Type.Number()),
    }),
    async execute(_toolCallId, {
      pattern,
      path: searchPath = "",
      glob,
      ignoreCase = false,
      literal = false,
      context = 0,
      limit,
    }) {
      const resolved = await resolveContainedPath(root, searchPath, {
        allowRoot: true,
      });
      const expression = boundedSearchExpression(pattern, { literal, ignoreCase });
      const globFilter = glob ? globExpression(glob) : null;
      const maxResults = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 500) : 200;
      const contextLines = Number.isInteger(context) ? Math.min(Math.max(context, 0), 5) : 0;
      const matches = [];

      async function searchFile(filePath, relativePath, size) {
        if (size > MAX_TOOL_FILE_BYTES) return true;
        if (globFilter && !globFilter.test(relativePath)) return true;
        const buffer = await readFile(filePath);
        if (buffer.subarray(0, Math.min(buffer.length, 8_192)).includes(0)) return true;
        const lines = buffer.toString("utf8").split(/\r\n|\n|\r/);
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
          const line = lines[lineIndex].slice(0, 20_000);
          expression.lastIndex = 0;
          if (!expression.test(line)) continue;
          const from = Math.max(0, lineIndex - contextLines);
          const to = Math.min(lines.length, lineIndex + contextLines + 1);
          for (let index = from; index < to; index += 1) {
            matches.push(
              `${relativePath}:${index + 1}:${lines[index].slice(0, 500)}`,
            );
          }
          if (matches.length >= maxResults) return false;
        }
        return true;
      }

      let walked;
      if (resolved.stat?.isFile()) {
        walked = {
          truncated: (await searchFile(resolved.target, resolved.normalized, resolved.stat.size)) === false,
        };
      } else if (resolved.stat?.isDirectory()) {
        walked = await walkContainedFiles(
          root,
          resolved,
          ({ targetPath, relativePath, stat }) => searchFile(
            targetPath,
            relativePath,
            stat.size,
          ),
        );
      } else {
        throw new Error("Search path must be a file or directory");
      }
      return textResult(matches.join("\n") || "No matches found", {
        count: matches.length,
        truncated: walked.truncated || matches.length >= maxResults,
      });
    },
  });
}

function normalizePlan(plan, explanation) {
  if (!Array.isArray(plan) || plan.length < 1 || plan.length > 12) {
    throw new Error("Plan must contain 1-12 steps");
  }
  const steps = plan.map((item, index) => ({
    id: `step-${index + 1}`,
    text: String(item.step ?? "").trim().slice(0, 240),
    status: item.status,
  }));
  if (steps.some((step) => !step.text)) throw new Error("Plan steps cannot be empty");
  if (steps.filter((step) => step.status === "in_progress").length > 1) {
    throw new Error("Only one plan step may be in progress");
  }
  return {
    explanation: String(explanation ?? "").trim().slice(0, 500),
    steps,
  };
}

export async function createProjectWorkTools({
  workspaceRoot,
  onPlan,
  onVerificationRequest,
} = {}) {
  const root = await realpath(workspaceRoot);
  const updatePlan = defineTool({
    name: "update_plan",
    label: "update_plan",
    description: "Publish or update the concise user-visible work plan.",
    promptSnippet: "Update the public work plan",
    executionMode: "sequential",
    parameters: Type.Object({
      explanation: Type.Optional(Type.String()),
      plan: Type.Array(Type.Object({
        step: Type.String(),
        status: Type.Union([
          Type.Literal("pending"),
          Type.Literal("in_progress"),
          Type.Literal("completed"),
        ]),
      }), { minItems: 1, maxItems: 12 }),
    }),
    async execute(_toolCallId, { explanation, plan }) {
      const normalized = normalizePlan(plan, explanation);
      await onPlan(normalized);
      return textResult("Plan updated", normalized);
    },
  });
  const requestVerification = defineTool({
    name: "request_verification",
    label: "request_verification",
    description: "Request a bounded verification command for explicit user execution.",
    promptSnippet: "Request user-approved verification",
    executionMode: "sequential",
    parameters: Type.Object({
      file: Type.String(),
      args: Type.Optional(Type.Array(Type.String(), { maxItems: 32 })),
      cwd: Type.Optional(Type.String()),
      checks: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
    }),
    async execute(_toolCallId, request) {
      const created = await onVerificationRequest(request);
      return textResult(
        `Verification request ${created.id} is ready for user review. It has not run.`,
        { id: created.id },
      );
    },
  });

  return [
    createReadTool(root),
    createEditTool(root),
    createWriteTool(root),
    createGrepTool(root),
    createFindTool(root),
    createLsTool(root),
    updatePlan,
    requestVerification,
  ];
}

function configuredDefaults(agentDir) {
  try {
    const settings = SettingsManager.create(agentDir, agentDir, {
      projectTrusted: false,
    });
    return {
      providerId: settings.getDefaultProvider() ?? null,
      modelId: settings.getDefaultModel() ?? null,
    };
  } catch {
    return { providerId: null, modelId: null };
  }
}

function findSelectedModel(available, requestedModelId, defaults) {
  if (requestedModelId) {
    const separator = requestedModelId.indexOf("/");
    if (separator > 0) {
      const providerId = requestedModelId.slice(0, separator);
      const modelId = requestedModelId.slice(separator + 1);
      return available.find(
        (model) => model.provider === providerId && model.id === modelId,
      );
    }
    const defaultMatch = available.find(
      (model) => model.provider === defaults.providerId && model.id === requestedModelId,
    );
    if (defaultMatch) return defaultMatch;
    const matches = available.filter((model) => model.id === requestedModelId);
    if (matches.length === 1) return matches[0];
    return null;
  }
  return available.find(
    (model) => model.provider === defaults.providerId && model.id === defaults.modelId,
  ) ?? available[0] ?? null;
}

function publicModelCatalog(runtime, available, defaults) {
  const byProvider = new Map();
  for (const model of available) {
    const models = byProvider.get(model.provider) ?? [];
    models.push({
      id: model.id,
      name: model.name ?? model.id,
      contextWindow: Number.isFinite(model.contextWindow) ? model.contextWindow : null,
      supportsThinking: model.reasoning === true,
    });
    byProvider.set(model.provider, models);
  }
  const providers = [...byProvider.entries()]
    .map(([providerId, models]) => ({
      id: providerId,
      name: runtime.getProvider(providerId)?.name ?? providerId,
      models: models.sort((left, right) => left.name.localeCompare(right.name)),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const selected = findSelectedModel(available, null, defaults);
  return {
    providers,
    defaultProviderId: selected?.provider ?? null,
    defaultModelId: selected?.id ?? null,
  };
}

export function createPiSessionFactory({
  agentDir = getAgentDir(),
  modelRuntime,
} = {}) {
  const runtimePromise = modelRuntime
    ? Promise.resolve(modelRuntime)
    : ModelRuntime.create({ allowModelNetwork: false });
  const defaults = configuredDefaults(agentDir);

  async function listModels() {
    const runtime = await runtimePromise;
    const available = [...await runtime.getAvailable()];
    return publicModelCatalog(runtime, available, defaults);
  }

  const factory = async ({
    workspaceRoot,
    sessionDir,
    modelRef,
    thinkingLevel = "medium",
    workspaceSnapshot,
    onPlan,
    onVerificationRequest,
  } = {}) => {
    const cwd = await realpath(workspaceRoot);
    const runtime = await runtimePromise;
    const available = [...await runtime.getAvailable()];
    const model = findSelectedModel(available, modelRef, defaults);
    if (!model) {
      throw projectWorkError(
        "PROJECT_WORK_MODEL_UNAVAILABLE",
        "所选 Pi 模型当前不可用",
        409,
        true,
      );
    }
    const sessionManager = SessionManager.continueRecent(cwd, sessionDir);
    if (path.resolve(sessionManager.getCwd()) !== path.resolve(cwd)) {
      throw projectWorkError(
        "PROJECT_WORK_SESSION_INVALID",
        "Pi 会话工作目录与隔离快照不一致",
        500,
      );
    }
    const settingsManager = SettingsManager.inMemory(
      {
        retry: { enabled: true, maxRetries: 2 },
        compaction: { enabled: true },
      },
      { projectTrusted: false },
    );
    const agentsFiles = await readSafeAgentsFiles(cwd);
    const appendedGuidance = [
      APP_GUIDANCE,
      workspaceSnapshotGuidance(workspaceSnapshot),
    ].filter(Boolean);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: "",
      appendSystemPrompt: appendedGuidance,
      extensionsOverride: (base) => ({ ...base, extensions: [], errors: [] }),
      skillsOverride: () => ({ skills: [], diagnostics: [] }),
      promptsOverride: () => ({ prompts: [], diagnostics: [] }),
      themesOverride: () => ({ themes: [], diagnostics: [] }),
      agentsFilesOverride: () => ({ agentsFiles }),
      systemPromptOverride: () => undefined,
      appendSystemPromptOverride: () => appendedGuidance,
    });
    await resourceLoader.reload();
    const customTools = await createProjectWorkTools({
      workspaceRoot: cwd,
      onPlan,
      onVerificationRequest,
    });
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime: runtime,
      model,
      thinkingLevel,
      settingsManager,
      resourceLoader,
      sessionManager,
      noTools: "builtin",
      customTools,
      tools: TOOL_NAMES,
    });
    async function setModel(nextModelRef) {
      const currentAvailable = [...await runtime.getAvailable()];
      const nextModel = findSelectedModel(currentAvailable, nextModelRef, defaults);
      if (!nextModel) {
        throw projectWorkError(
          "PROJECT_WORK_MODEL_UNAVAILABLE",
          "所选 Pi 模型当前不可用",
          409,
          true,
        );
      }
      await session.setModel(nextModel);
      return {
        providerId: nextModel.provider,
        modelId: nextModel.id,
        modelRef: `${nextModel.provider}/${nextModel.id}`,
      };
    }
    return {
      get isStreaming() {
        return session.isStreaming;
      },
      prompt(text, options) {
        return session.prompt(text, options);
      },
      steer(text) {
        return session.steer(text);
      },
      abort() {
        return session.abort();
      },
      compact(instructions) {
        return session.compact(instructions);
      },
      setModel,
      subscribe(listener) {
        return session.subscribe(listener);
      },
      dispose() {
        session.dispose();
      },
    };
  };
  factory.listModels = listModels;
  factory.dispose = async () => {};
  return factory;
}
