import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const SUPPORTED_PI_SDK_VERSION = "0.82.1";
const UPGRADE_GUARD_MESSAGE = [
  "Pi Agent is validated against @earendil-works/pi-coding-agent 0.82.1.",
  "Do not upgrade to another version until this compatibility",
  "gate is deliberately updated and passes against the candidate install.",
].join(" ");
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

test("Pi SDK stays pinned to 0.82.1 in manifest, lockfile, and installed runtime", async () => {
  const [manifest, lockfile, installedManifest] = await Promise.all([
    readJson(path.join(projectRoot, "package.json")),
    readJson(path.join(projectRoot, "package-lock.json")),
    readJson(path.join(
      projectRoot,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "package.json",
    )),
  ]);
  const lockedPackage = lockfile.packages?.[
    "node_modules/@earendil-works/pi-coding-agent"
  ];

  assert.equal(
    manifest.dependencies?.["@earendil-works/pi-coding-agent"],
    SUPPORTED_PI_SDK_VERSION,
    UPGRADE_GUARD_MESSAGE,
  );
  assert.equal(
    lockfile.packages?.[""]?.dependencies?.[
      "@earendil-works/pi-coding-agent"
    ],
    SUPPORTED_PI_SDK_VERSION,
    UPGRADE_GUARD_MESSAGE,
  );
  assert.equal(
    lockedPackage?.version,
    SUPPORTED_PI_SDK_VERSION,
    UPGRADE_GUARD_MESSAGE,
  );
  assert.match(
    lockedPackage?.resolved ?? "",
    /pi-coding-agent-0\.82\.1\.tgz$/,
    UPGRADE_GUARD_MESSAGE,
  );
  assert.equal(
    installedManifest.version,
    SUPPORTED_PI_SDK_VERSION,
    UPGRADE_GUARD_MESSAGE,
  );
  assert.equal(installedManifest.type, "module");
  assert.equal(installedManifest.exports?.["."]?.import, "./dist/index.js");
});

test("Pi SDK 0.82.1 exposes the runtime contracts used by piSessionHost", async (t) => {
  for (const [name, value] of Object.entries({
    createAgentSession,
    DefaultResourceLoader,
    defineTool,
    getAgentDir,
    ModelRuntime,
    SessionManager,
    SettingsManager,
  })) {
    assert.equal(
      typeof value,
      "function",
      `${name} is required by piSessionHost; ${UPGRADE_GUARD_MESSAGE}`,
    );
  }
  assert.equal(typeof ModelRuntime.create, "function");
  assert.equal(typeof SessionManager.continueRecent, "function");
  assert.equal(typeof SessionManager.forkFrom, "function");
  assert.equal(typeof SettingsManager.create, "function");
  assert.equal(typeof SettingsManager.inMemory, "function");
  assert.equal(typeof DefaultResourceLoader.prototype.reload, "function");

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-sdk-contract-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const workspaceRoot = path.join(temporaryRoot, "workspace");
  const sessionRoot = path.join(temporaryRoot, "sessions");
  await Promise.all([
    mkdir(workspaceRoot),
    mkdir(sessionRoot),
  ]);

  const settings = SettingsManager.inMemory(
    {
      retry: { enabled: true, maxRetries: 2 },
      compaction: { enabled: true },
    },
    { projectTrusted: false },
  );
  for (const method of [
    "getDefaultProvider",
    "getDefaultModel",
    "getDefaultThinkingLevel",
  ]) {
    assert.equal(typeof settings[method], "function");
  }

  const sessions = SessionManager.continueRecent(
    workspaceRoot,
    sessionRoot,
  );
  assert.equal(path.resolve(sessions.getCwd()), path.resolve(workspaceRoot));
  for (const method of [
    "getCwd",
    "getSessionFile",
    "getEntries",
    "appendMessage",
  ]) {
    assert.equal(typeof sessions[method], "function");
  }

  const resourceLoader = new DefaultResourceLoader({
    cwd: workspaceRoot,
    agentDir: temporaryRoot,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  for (const method of [
    "getExtensions",
    "getSkills",
    "getPrompts",
    "getThemes",
    "getAgentsFiles",
    "getSystemPrompt",
    "getAppendSystemPrompt",
  ]) {
    assert.equal(typeof resourceLoader[method], "function");
  }

  const runtime = await ModelRuntime.create({ allowModelNetwork: false });
  assert.equal(typeof runtime.getAvailable, "function");
  assert.ok(Array.isArray(await runtime.getAvailable()));
  assert.ok(path.isAbsolute(getAgentDir()));

  const tool = defineTool({
    name: "pi_sdk_compatibility_probe",
    label: "pi_sdk_compatibility_probe",
    description: "Offline compatibility probe",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute() {
      return {
        content: [{ type: "text", text: "ok" }],
        details: { ok: true },
      };
    },
  });
  assert.equal(tool.name, "pi_sdk_compatibility_probe");
  assert.deepEqual(await tool.execute("compatibility-probe", {}), {
    content: [{ type: "text", text: "ok" }],
    details: { ok: true },
  });
});
