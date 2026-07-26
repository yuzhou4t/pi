import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PromptRegistryError,
  createPromptRegistry,
  promptRegistry,
} from "./promptRegistry.js";

const expectedPrompts = [
  "candidate-ranking",
  "candidate-summary",
  "evidence",
  "five-minute-guide",
    "method",
    "project-relation",
    "reading-chat",
    "reading-follow-up",
  "research-question",
  "translation",
];

function hash(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function makeWorkflow(manifest, files = {}) {
  const workflowDir = await mkdtemp(path.join(os.tmpdir(), "pi-prompts-"));
  const promptsDir = path.join(workflowDir, "prompts");
  const schemasDir = path.join(workflowDir, "schemas");
  await mkdir(promptsDir);
  await mkdir(schemasDir);
  await writeFile(path.join(promptsDir, "manifest.json"), JSON.stringify(manifest), "utf8");
  for (const [relativePath, body] of Object.entries(files)) {
    const targetDir = relativePath.endsWith(".md") ? promptsDir : schemasDir;
    await writeFile(path.join(targetDir, relativePath), body, "utf8");
  }
  return workflowDir;
}

test("default manifest exposes every active journal-reading prompt", () => {
  assert.equal(promptRegistry.workflow_id, "journal-reading-v1");
  assert.deepEqual(promptRegistry.listActivePrompts().sort(), expectedPrompts);
  assert.equal(promptRegistry.getManifest().active["candidate-ranking"], "candidate-ranking.v1");
  assert.equal(promptRegistry.loadPrompt("candidate-ranking").version, "candidate-ranking.v1");
  assert.equal(promptRegistry.loadPrompt("candidate-summary").version, "candidate-summary.v2");
  assert.equal(promptRegistry.loadPrompt("five-minute-guide").version, "five-minute-guide.v3");
  assert.equal(promptRegistry.loadPrompt("research-question").version, "research-question.v2");
  assert.equal(promptRegistry.loadPrompt("method").version, "method.v3");
  assert.equal(promptRegistry.loadPrompt("evidence").version, "evidence.v3");
  assert.equal(promptRegistry.loadPrompt("project-relation").version, "project-relation.v3");
  assert.equal(promptRegistry.loadPrompt("reading-follow-up").version, "reading-follow-up.v1");
  for (const promptId of expectedPrompts) {
    assert.equal(promptRegistry.loadPrompt(promptId).id, promptId);
  }
});

test("loaded assets expose exact body, schema, and sha256 identities", () => {
  const prompt = promptRegistry.loadPrompt("five-minute-guide");
  assert.equal(prompt.body_hash, hash(prompt.body));
  assert.equal(prompt.system_hash, hash(prompt.system));
  assert.match(prompt.prompt_hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(prompt.schema.type, "object");
  assert.ok(Object.isFrozen(prompt));
  assert.ok(Object.isFrozen(prompt.schema));
});

test("origin stays outside model-owned output and is guarded by the shared system prompt", () => {
  const prompt = promptRegistry.loadPrompt("candidate-ranking");
  assert.match(prompt.system, /origin 是只读来源标签/);
  assert.match(prompt.body, /经典论文.*不得伪装成新增/);
  assert.equal(prompt.schema.properties.items.items.properties.origin, undefined);
});

test("input hash is stable and includes prompt, schema, and model settings", () => {
  const request = {
    promptId: "research-question",
    input: { paper_id: "paper-1", markdown_hash: "sha256:paper" },
    modelSettings: { provider: "deepseek", model: "deepseek-v4-flash", temperature: 0 },
  };
  const first = promptRegistry.createInputHash(request);
  const reordered = promptRegistry.createInputHash({
    promptId: request.promptId,
    input: { markdown_hash: "sha256:paper", paper_id: "paper-1" },
    modelSettings: { temperature: 0, model: "deepseek-v4-flash", provider: "deepseek" },
  });
  const changedModel = promptRegistry.createInputHash({
    ...request,
    modelSettings: { ...request.modelSettings, model: "deepseek-v4-pro" },
  });
  assert.equal(first, reordered);
  assert.notEqual(first, changedModel);
  assert.match(first, /^sha256:[a-f0-9]{64}$/);
});

test("assets are loaded only when their active prompt is requested", async (t) => {
  const manifest = {
    schema_version: 1,
    workflow_id: "test",
    system: { version: "system.v1", file: "system.v1.md" },
    active: { valid: "valid.v1", missing: "missing.v1" },
    versions: {
      "valid.v1": { file: "valid.v1.md", schema: "output.v1.json" },
      "missing.v1": { file: "missing.v1.md", schema: "missing.v1.json" },
    },
  };
  const workflowDir = await makeWorkflow(manifest, {
    "system.v1.md": "system",
    "valid.v1.md": "valid",
    "output.v1.json": JSON.stringify({ type: "object" }),
  });
  t.after(() => rm(workflowDir, { recursive: true, force: true }));

  const registry = createPromptRegistry({ workflowDir });
  assert.equal(registry.loadPrompt("valid").body, "valid");
  assert.throws(
    () => registry.loadPrompt("missing"),
    (error) => error instanceof PromptRegistryError && error.code === "PROMPT_ASSET_NOT_FOUND",
  );
});

test("registry reports unknown prompts and malformed manifests without model calls", async (t) => {
  assert.throws(
    () => promptRegistry.loadPrompt("unknown"),
    (error) => error instanceof PromptRegistryError && error.code === "PROMPT_NOT_FOUND",
  );

  const workflowDir = await makeWorkflow({ schema_version: 1 }, {});
  t.after(() => rm(workflowDir, { recursive: true, force: true }));
  assert.throws(
    () => createPromptRegistry({ workflowDir }),
    (error) => error instanceof PromptRegistryError && error.code === "MANIFEST_INVALID",
  );
});
