import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_WORKFLOW_DIR = fileURLToPath(
  new URL("./workflows/journal-reading/", import.meta.url),
);

export class PromptRegistryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PromptRegistryError";
    this.code = code;
  }
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new PromptRegistryError("INPUT_NOT_SERIALIZABLE", "哈希输入必须是 JSON 值");
  }
  return serialized;
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function readText(filePath, code, label) {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    throw new PromptRegistryError(code, `无法读取${label}`);
  }
}

function parseJson(source, code, label) {
  try {
    return JSON.parse(source);
  } catch {
    throw new PromptRegistryError(code, `${label}不是有效 JSON`);
  }
}

function resolveAsset(baseDir, relativePath, extension, label) {
  if (typeof relativePath !== "string" || !relativePath.endsWith(extension)) {
    throw new PromptRegistryError("MANIFEST_INVALID", `${label}路径无效`);
  }
  const resolved = path.resolve(baseDir, relativePath);
  if (path.dirname(resolved) !== path.resolve(baseDir)) {
    throw new PromptRegistryError("MANIFEST_INVALID", `${label}必须位于工作流目录内`);
  }
  return resolved;
}

function validateManifest(manifest) {
  if (
    !manifest
    || manifest.schema_version !== 1
    || typeof manifest.workflow_id !== "string"
    || !manifest.system
    || typeof manifest.system.version !== "string"
    || typeof manifest.system.file !== "string"
    || !manifest.active
    || typeof manifest.active !== "object"
    || Array.isArray(manifest.active)
    || !manifest.versions
    || typeof manifest.versions !== "object"
    || Array.isArray(manifest.versions)
  ) {
    throw new PromptRegistryError("MANIFEST_INVALID", "提示词 manifest 合同无效");
  }

  for (const [promptId, version] of Object.entries(manifest.active)) {
    const definition = manifest.versions[version];
    if (
      !promptId
      || typeof version !== "string"
      || !definition
      || typeof definition.file !== "string"
      || typeof definition.schema !== "string"
    ) {
      throw new PromptRegistryError("MANIFEST_INVALID", `提示词映射无效：${promptId}`);
    }
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export function createPromptRegistry({ workflowDir = DEFAULT_WORKFLOW_DIR } = {}) {
  const promptsDir = path.join(workflowDir, "prompts");
  const schemasDir = path.join(workflowDir, "schemas");
  const manifestPath = path.join(promptsDir, "manifest.json");
  const manifest = parseJson(
    readText(manifestPath, "MANIFEST_NOT_FOUND", "提示词 manifest"),
    "MANIFEST_INVALID",
    "提示词 manifest",
  );
  validateManifest(manifest);
  deepFreeze(manifest);

  const cache = new Map();

  function loadPrompt(promptId) {
    if (typeof promptId !== "string" || !manifest.active[promptId]) {
      throw new PromptRegistryError("PROMPT_NOT_FOUND", `未知提示词：${promptId}`);
    }
    if (cache.has(promptId)) return cache.get(promptId);

    const version = manifest.active[promptId];
    const definition = manifest.versions[version];
    const systemPath = resolveAsset(promptsDir, manifest.system.file, ".md", "system");
    const bodyPath = resolveAsset(promptsDir, definition.file, ".md", "提示词");
    const schemaPath = resolveAsset(schemasDir, definition.schema, ".json", "schema");
    const system = readText(systemPath, "PROMPT_ASSET_NOT_FOUND", "system 提示词");
    const body = readText(bodyPath, "PROMPT_ASSET_NOT_FOUND", "阶段提示词");
    if (!system.trim() || !body.trim()) {
      throw new PromptRegistryError("PROMPT_ASSET_INVALID", "提示词正文不能为空");
    }
    const schemaSource = readText(schemaPath, "SCHEMA_NOT_FOUND", "输出 schema");
    const schema = parseJson(schemaSource, "SCHEMA_INVALID", "输出 schema");
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
      throw new PromptRegistryError("SCHEMA_INVALID", "输出 schema 合同无效");
    }

    const systemHash = sha256(system);
    const bodyHash = sha256(body);
    const schemaHash = sha256(stableStringify(schema));
    const promptHash = sha256(stableStringify({
      body_hash: bodyHash,
      schema_hash: schemaHash,
      system_hash: systemHash,
      version,
    }));
    const loaded = deepFreeze({
      id: promptId,
      version,
      system_version: manifest.system.version,
      system,
      body,
      schema,
      system_hash: systemHash,
      body_hash: bodyHash,
      schema_hash: schemaHash,
      prompt_hash: promptHash,
    });
    cache.set(promptId, loaded);
    return loaded;
  }

  function createInputHash({ promptId, input, modelSettings = {} }) {
    const prompt = loadPrompt(promptId);
    return sha256(stableStringify({
      input,
      model_settings: modelSettings,
      prompt_hash: prompt.prompt_hash,
      schema: prompt.schema,
    }));
  }

  return Object.freeze({
    workflow_id: manifest.workflow_id,
    getManifest: () => manifest,
    listActivePrompts: () => Object.keys(manifest.active),
    loadPrompt,
    createInputHash,
  });
}

export const promptRegistry = createPromptRegistry();
