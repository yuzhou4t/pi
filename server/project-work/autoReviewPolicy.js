import {
  isFilteredProjectPath,
  normalizeProjectPath,
} from "./workspace.js";
import { isSafeResolvedVerificationRecipe } from "./verificationRecipes.js";

export const AUTO_REVIEW_POLICY_VERSION = 1;
export const EXECUTION_POLICY_MODES = Object.freeze([
  "manual_review",
  "auto_review",
]);

const EXECUTION_POLICY_MODE_SET = new Set(EXECUTION_POLICY_MODES);
const MAX_AUTO_REVIEW_FILES = 32;
const MAX_AUTO_REVIEW_CHANGED_LINES = 5_000;
const SAFE_PACKAGE_SCRIPT_NAME = /^(?:test|lint|check|typecheck)(?::[A-Za-z0-9._-]+)*$/;
const SAFE_PACKAGE_SCRIPT = /^(?:node\s+--test(?:\s+[A-Za-z0-9_./*:@=,+-]+)*|(?:vitest|jest|eslint|tsc|biome|ruff|pytest)(?:\s+[A-Za-z0-9_./*:@=,+-]+)*)$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const PREVIEW_APP_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*:[A-Za-z_][A-Za-z0-9_]*$/;
const PREVIEW_ROUTE_PATTERN = /^\/(?!\/)[^\s\\?#]*$/;
const UNSAFE_PREVIEW_FIELDS = [
  "args",
  "command",
  "env",
  "host",
  "inlineCode",
  "install",
  "network",
  "port",
  "script",
  "url",
];

function decision(decisionValue, reasonCode) {
  return Object.freeze({
    decision: decisionValue,
    reasonCode,
    policyVersion: AUTO_REVIEW_POLICY_VERSION,
  });
}

export function defaultExecutionPolicy() {
  return {
    mode: "manual_review",
    revision: 1,
    policyVersion: AUTO_REVIEW_POLICY_VERSION,
  };
}

export function normalizeExecutionPolicy(value) {
  const fallback = defaultExecutionPolicy();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fallback;
  }
  const policyCompatible = value.policyVersion === AUTO_REVIEW_POLICY_VERSION;
  return {
    mode: policyCompatible && EXECUTION_POLICY_MODE_SET.has(value.mode)
      ? value.mode
      : fallback.mode,
    revision: Number.isSafeInteger(value.revision) && value.revision > 0
      ? value.revision
      : fallback.revision,
    policyVersion: AUTO_REVIEW_POLICY_VERSION,
  };
}

export function isExecutionPolicyMode(value) {
  return EXECUTION_POLICY_MODE_SET.has(value);
}

function safeChangeFile(file) {
  if (!file || typeof file !== "object" || Array.isArray(file)) return false;
  if (!["create", "modify"].includes(file.operation)) return false;
  let normalized;
  try {
    normalized = normalizeProjectPath(file.path);
  } catch {
    return false;
  }
  if (normalized !== file.path || isFilteredProjectPath(normalized)) return false;
  if (!SHA256_PATTERN.test(String(file.afterHash ?? ""))) return false;
  if (
    file.operation === "create"
      ? file.baseHash !== null
      : !SHA256_PATTERN.test(String(file.baseHash ?? ""))
  ) {
    return false;
  }
  return true;
}

export function reviewAutoChangeSet(changeSet, {
  workflowId = null,
} = {}) {
  if (workflowId) return decision("deny", "read_only_workflow");
  if (
    !changeSet
    || changeSet.status !== "ready"
    || !Array.isArray(changeSet.files)
    || changeSet.files.length === 0
  ) {
    return decision("deny", "change_set_not_ready");
  }
  if (changeSet.files.length > MAX_AUTO_REVIEW_FILES) {
    return decision("deny", "change_set_file_limit");
  }
  const changedLines = Number(changeSet.stats?.additions ?? 0)
    + Number(changeSet.stats?.deletions ?? 0);
  if (!Number.isFinite(changedLines) || changedLines > MAX_AUTO_REVIEW_CHANGED_LINES) {
    return decision("deny", "change_set_line_limit");
  }
  if (!changeSet.files.every(safeChangeFile)) {
    return decision("deny", "change_set_unsafe_file");
  }
  return decision("allow", "safe_hash_bound_change_set");
}

function safeNodeTest(command) {
  if (command.file !== "node" || !Array.isArray(command.args)) return false;
  if (command.args[0] !== "--test") return false;
  return command.args.slice(1).every((argument) => {
    if (typeof argument !== "string" || !argument || argument.startsWith("-")) {
      return false;
    }
    try {
      return normalizeProjectPath(argument) === argument;
    } catch {
      return false;
    }
  });
}

function safePackageVerification(command, resolvedScript) {
  if (
    !["npm", "pnpm", "yarn", "bun"].includes(command.file)
    || !Array.isArray(command.args)
  ) {
    return false;
  }
  const scriptName = command.args[0] === "test"
    ? "test"
    : command.args[0] === "run" && command.args.length === 2
      ? command.args[1]
      : null;
  if (!scriptName || !SAFE_PACKAGE_SCRIPT_NAME.test(scriptName)) return false;
  const normalizedScript = String(resolvedScript ?? "")
    .trim()
    .replaceAll(/\s+/g, " ");
  return SAFE_PACKAGE_SCRIPT.test(normalizedScript);
}

export function reviewAutoVerification(verification, {
  workflowId = null,
  turnId = null,
  isolated = false,
} = {}) {
  if (workflowId) return decision("deny", "read_only_workflow");
  if (
    !verification
    || verification.status !== "requested"
    || !turnId
    || verification.turnId !== turnId
  ) {
    return decision("deny", "verification_not_current_turn");
  }
  if (
    verification.recipeId
      ? !isSafeResolvedVerificationRecipe(verification.recipe)
        || verification.recipeId !== verification.recipe.id
        || JSON.stringify(verification.command)
          !== JSON.stringify(verification.recipe.command)
      : !safeNodeTest(verification.command)
        && !safePackageVerification(
          verification.command,
          verification.resolvedScript,
        )
  ) {
    return decision("deny", "verification_command_not_auto_safe");
  }
  return isolated
    ? decision("allow", "safe_bounded_verification")
    : decision("deny", "verification_isolation_unavailable");
}

export function reviewAutoPreview(previewRequest, {
  workflowId = null,
  turnId = null,
  workspaceKind = null,
  executionPolicyRevision = null,
  changeApplied = false,
} = {}) {
  if (workflowId) return decision("deny", "read_only_workflow");
  if (workspaceKind !== "bound_project") {
    return decision("deny", "preview_project_required");
  }
  if (
    !previewRequest
    || previewRequest.status !== "requested"
    || !turnId
    || previewRequest.turnId !== turnId
  ) {
    return decision("deny", "preview_not_current_turn");
  }
  if (
    !Number.isSafeInteger(executionPolicyRevision)
    || previewRequest.executionPolicyMode !== "auto_review"
    || previewRequest.executionPolicyRevision !== executionPolicyRevision
  ) {
    return decision("deny", "preview_policy_revision_mismatch");
  }
  if (!changeApplied) {
    return decision("deny", "change_set_not_auto_applied");
  }
  let normalizedCwd = null;
  try {
    normalizedCwd = normalizeProjectPath(
      previewRequest.cwd ?? "",
      { allowEmpty: true },
    ) || ".";
  } catch {
    normalizedCwd = null;
  }
  const safeCwd = normalizedCwd === (previewRequest.cwd ?? "");
  const safeCommon = safeCwd
    && PREVIEW_ROUTE_PATTERN.test(previewRequest.route ?? "")
    && typeof previewRequest.title === "string"
    && previewRequest.title.length > 0
    && previewRequest.title.length <= 120
    && !/[\r\n\0]/.test(previewRequest.title)
    && UNSAFE_PREVIEW_FIELDS.every(
      (field) => previewRequest[field] === undefined,
    );
  const safeRecipe = safeCommon && (
    (
      previewRequest.runtime === "python_uvicorn"
      && PREVIEW_APP_PATTERN.test(previewRequest.app ?? "")
    )
    || (
      ["vite", "static"].includes(previewRequest.runtime)
      && previewRequest.app == null
    )
  );
  return safeRecipe
    ? decision("allow", "safe_loopback_preview")
    : decision("deny", "preview_profile_not_safe");
}
