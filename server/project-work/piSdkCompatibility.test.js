import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createGrepTool,
  createReadTool,
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
    createAgentSessionFromServices,
    createAgentSessionRuntime,
    createAgentSessionServices,
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

  const createRuntime = async ({
    cwd,
    sessionManager,
    sessionStartEvent,
  }) => {
    const services = await createAgentSessionServices({
      cwd,
      agentDir: temporaryRoot,
      modelRuntime: runtime,
      settingsManager: settings,
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      },
    });
    return {
      ...(await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        noTools: "all",
      })),
      services,
      diagnostics: services.diagnostics,
    };
  };
  const agentRuntime = await createAgentSessionRuntime(createRuntime, {
    cwd: workspaceRoot,
    agentDir: temporaryRoot,
    sessionManager: SessionManager.inMemory(workspaceRoot),
  });
  assert.equal(path.resolve(agentRuntime.cwd), path.resolve(workspaceRoot));
  assert.equal(typeof agentRuntime.session.prompt, "function");
  assert.equal(typeof agentRuntime.services.resourceLoader.reload, "function");
  assert.equal(Array.isArray(agentRuntime.diagnostics), true);
  await agentRuntime.dispose();
});

test("Pi native read and grep cross the retired project snapshot limits", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-sdk-native-files-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const largePath = path.join(temporaryRoot, "large.txt");
  const linkedPath = path.join(temporaryRoot, "linked-large.txt");
  const paddingLines = 1_200_000;
  const marker = "PI_NATIVE_SEARCH_MARKER_AFTER_EIGHT_MEGABYTES";
  await writeFile(
    largePath,
    `${"padding\n".repeat(paddingLines)}${marker}\n`,
  );
  await symlink(largePath, linkedPath);

  const read = createReadTool(temporaryRoot);
  const readPage = await read.execute("read-large-page", {
    path: "linked-large.txt",
    offset: paddingLines + 1,
    limit: 2,
  });
  assert.match(readPage.content[0].text, new RegExp(marker));

  const grep = createGrepTool(temporaryRoot);
  const search = await grep.execute("grep-large-file", {
    path: "large.txt",
    pattern: marker,
    literal: true,
  });
  assert.match(search.content[0].text, new RegExp(marker));
  assert.match(search.content[0].text, new RegExp(`${paddingLines + 1}`));
});
