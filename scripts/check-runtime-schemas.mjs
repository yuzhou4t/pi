import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promptRegistry } from "../server/promptRegistry.js";
import {
  RUNTIME_SCHEMA_VERSION,
  CONVERSATION_LIFECYCLE,
} from "../server/runtimeSchema.js";
import {
  SOURCE_REGISTRY,
  validateSourceRegistry,
} from "../server/journal/sourceRegistry.js";
import { resolveModelMode } from "../server/modelMode.js";
import {
  CONVERSATION_RECORD_SCHEMA_VERSION,
} from "../server/project-work/conversationStore.js";
import {
  JOURNAL_RUN_SCHEMA_VERSION,
} from "../server/journal/runStore.js";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const schemasRoot = path.join(
  projectRoot,
  "server",
  "workflows",
  "journal-reading",
  "schemas",
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(
  Number.isSafeInteger(RUNTIME_SCHEMA_VERSION) && RUNTIME_SCHEMA_VERSION > 0,
  "runtime schema version must be a positive integer",
);
assert(
  CONVERSATION_RECORD_SCHEMA_VERSION === 1
    && JOURNAL_RUN_SCHEMA_VERSION === 1,
  "persisted runtime record schema versions are invalid",
);
assert(
  new Set(CONVERSATION_LIFECYCLE).size === CONVERSATION_LIFECYCLE.length
    && CONVERSATION_LIFECYCLE.length === 7,
  "conversation lifecycle contract is invalid",
);
assert(resolveModelMode({}) === "live", "model runtime must fail closed to live");
const exampleEnvironment = await readFile(
  path.join(projectRoot, ".env.example"),
  "utf8",
);
assert(
  /^PI_MODEL_MODE=live$/m.test(exampleEnvironment),
  ".env.example must not enable fixtures for normal runs",
);

const sourceValidation = validateSourceRegistry(SOURCE_REGISTRY);
assert(sourceValidation.valid, sourceValidation.errors.join("\n"));
assert(SOURCE_REGISTRY.length === 11, "journal source registry must contain 11 sources");

const activePrompts = promptRegistry.listActivePrompts();
assert(activePrompts.length > 0, "journal prompt manifest has no active prompts");
for (const promptId of activePrompts) {
  const prompt = promptRegistry.loadPrompt(promptId);
  assert(prompt.schema?.type === "object", `${promptId} output schema must be an object`);
  assert(prompt.prompt_hash.startsWith("sha256:"), `${promptId} prompt hash is missing`);
}

const schemaFiles = (await readdir(schemasRoot))
  .filter((fileName) => fileName.endsWith(".json"))
  .sort();
assert(schemaFiles.length > 0, "journal workflow has no JSON schemas");
for (const fileName of schemaFiles) {
  const schema = JSON.parse(
    await readFile(path.join(schemasRoot, fileName), "utf8"),
  );
  assert(
    schema?.$schema === "https://json-schema.org/draft/2020-12/schema",
    `${fileName} must declare JSON Schema 2020-12`,
  );
  assert(schema.type === "object", `${fileName} root type must be object`);
}

console.log(
  `Schema check passed: runtime v${RUNTIME_SCHEMA_VERSION}, `
  + `${SOURCE_REGISTRY.length} sources, ${activePrompts.length} prompts, `
  + `${schemaFiles.length} JSON schemas.`,
);
