import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createProjectWorkTurnGuidanceExtension,
  createPiSessionFactory,
  createProjectWorkTools,
  getProjectWorkDefaultThinkingLevel,
  getProjectWorkThinkingLevels,
  readProjectWorkOverlayTextFile,
} from "./piSessionHost.js";

function toolByName(tools, name) {
  const tool = tools.find((item) => item.name === name);
  assert.ok(tool, `missing ${name} tool`);
  return tool;
}

test("project-work model catalog exposes safe external capability status", async () => {
  const factory = createPiSessionFactory({
    modelRuntime: {
      async getAvailable() {
        return [];
      },
      getProvider() {
        return null;
      },
    },
    externalRetrievalOptions: {
      env: {
        PI_TAVILY_API_KEY: "must-not-appear-in-catalog",
      },
    },
  });
  const catalog = await factory.listModels();
  assert.deepEqual(catalog.capabilities, {
    web_search: {
      available: true,
      reason: "Tavily 网页检索已配置",
    },
    docs_search: {
      available: false,
      reason: "Context7 尚未配置",
    },
  });
  assert.doesNotMatch(JSON.stringify(catalog), /must-not-appear-in-catalog/);
});

test("project-work model catalog derives image support from Pi model input modalities", async () => {
  const factory = createPiSessionFactory({
    modelRuntime: {
      async getAvailable() {
        return [{
          id: "vision-model",
          name: "Vision Model",
          provider: "provider-one",
          input: ["text", "image"],
          reasoning: true,
          contextWindow: 128_000,
        }, {
          id: "text-model",
          name: "Text Model",
          provider: "provider-one",
          input: ["text"],
          reasoning: false,
          contextWindow: 64_000,
        }];
      },
      getProvider(providerId) {
        return providerId === "provider-one"
          ? { name: "Provider One" }
          : null;
      },
    },
  });
  const catalog = await factory.listModels();
  const models = catalog.providers[0].models;

  assert.equal(
    models.find((model) => model.id === "vision-model").supportsImages,
    true,
  );
  assert.equal(
    models.find((model) => model.id === "text-model").supportsImages,
    false,
  );
});

test("project-work session host forwards image attachments to Pi steer", async () => {
  const source = await readFile(new URL("./piSessionHost.js", import.meta.url), "utf8");
  assert.match(
    source,
    /steer\(text,\s*images\)\s*\{\s*return session\.steer\(text,\s*images\);\s*\}/,
  );
});

test("project-work turn guidance modifies only the current system prompt", async () => {
  let guidance = "Review only for this turn.";
  let beforeAgentStart = null;
  const extension = createProjectWorkTurnGuidanceExtension(() => guidance);
  assert.equal(extension.hidden, true);
  extension.factory({
    on(event, handler) {
      if (event === "before_agent_start") beforeAgentStart = handler;
    },
  });
  assert.equal(typeof beforeAgentStart, "function");

  const result = await beforeAgentStart({
    systemPrompt: "Base prompt",
  });
  assert.equal(
    result.systemPrompt,
    "Base prompt\n\n## Current-turn instructions\n\nReview only for this turn.",
  );

  guidance = "";
  assert.equal(
    await beforeAgentStart({ systemPrompt: "Base prompt" }),
    undefined,
  );
});

test("project-work thinking levels follow each Pi model's runtime capability map", () => {
  assert.deepEqual(getProjectWorkThinkingLevels({
    reasoning: false,
  }), ["off"]);
  assert.deepEqual(getProjectWorkThinkingLevels({
    reasoning: true,
  }), ["off", "minimal", "low", "medium", "high"]);
  const mappedModel = {
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
      max: "max",
    },
  };
  assert.deepEqual(getProjectWorkThinkingLevels(mappedModel), [
    "low",
    "medium",
    "high",
    "max",
  ]);
  assert.equal(getProjectWorkDefaultThinkingLevel(mappedModel), "medium");
  assert.equal(
    getProjectWorkDefaultThinkingLevel(mappedModel, "max"),
    "max",
  );
});

test("contained project tools read live files and keep writes in the sparse review overlay", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-overlay-tools-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  const baseRoot = path.join(temporaryRoot, "base");
  const workspaceRoot = path.join(temporaryRoot, "workspace");
  await Promise.all([
    mkdir(projectRoot),
    mkdir(baseRoot),
    mkdir(workspaceRoot),
  ]);
  await writeFile(path.join(projectRoot, "app.js"), "export const value = 1;\n");
  await writeFile(path.join(projectRoot, "race.js"), "export const value = 'A';\n");

  const tools = await createProjectWorkTools({
    projectRoot,
    baseRoot,
    workspaceRoot,
    onPlan: async () => {},
    onVerificationRequest: async () => ({ id: "verification-1" }),
  });
  const read = toolByName(tools, "read");
  const edit = toolByName(tools, "edit");
  const write = toolByName(tools, "write");
  const grep = toolByName(tools, "grep");
  const find = toolByName(tools, "find");
  const ls = toolByName(tools, "ls");

  await writeFile(path.join(projectRoot, "created-after-session.js"), "export const late = true;\n");
  await writeFile(path.join(projectRoot, "capture-interrupted.js"), "live remains visible\n");
  await writeFile(path.join(baseRoot, "capture-interrupted.js"), "captured before interruption\n");
  const liveRead = await read.execute("read-live", {
    path: "created-after-session.js",
  });
  assert.match(liveRead.content[0].text, /late = true/);
  assert.match(
    (await read.execute("read-interrupted-capture", {
      path: "capture-interrupted.js",
    })).content[0].text,
    /live remains visible/,
  );
  await edit.execute("resume-interrupted-capture", {
    path: "capture-interrupted.js",
    edits: [{
      oldText: "live remains visible",
      newText: "proposal after retry",
    }],
  });
  assert.equal(
    await readFile(path.join(baseRoot, "capture-interrupted.js"), "utf8"),
    "live remains visible\n",
  );
  assert.equal(
    await readFile(path.join(workspaceRoot, "capture-interrupted.js"), "utf8"),
    "proposal after retry\n",
  );
  assert.match((await ls.execute("ls-root", {})).content[0].text, /created-after-session\.js/);
  assert.match(
    (await find.execute("find-js", { pattern: "*.js" })).content[0].text,
    /created-after-session\.js/,
  );

  let changedDuringEdit = false;
  await assert.rejects(
    edit.execute("edit-race", {
      path: "race.js",
      edits: [{
        oldText: "value = 'A'",
        get newText() {
          if (!changedDuringEdit) {
            changedDuringEdit = true;
            writeFileSync(
              path.join(projectRoot, "race.js"),
              "export const value = 'B';\n",
            );
          }
          return "value = 'A-prime'";
        },
      }],
    }),
    /Project file changed while the review edit was being prepared/,
  );
  assert.equal(
    await readFile(path.join(projectRoot, "race.js"), "utf8"),
    "export const value = 'B';\n",
  );
  await assert.rejects(access(path.join(baseRoot, "race.js")));
  await assert.rejects(access(path.join(workspaceRoot, "race.js")));

  await edit.execute("edit-app", {
    path: "app.js",
    edits: [{
      oldText: "value = 1",
      newText: "value = 2",
    }],
  });
  assert.equal(await readFile(path.join(projectRoot, "app.js"), "utf8"), "export const value = 1;\n");
  assert.equal(await readFile(path.join(baseRoot, "app.js"), "utf8"), "export const value = 1;\n");
  assert.equal(
    await readFile(path.join(workspaceRoot, "app.js"), "utf8"),
    "export const value = 2;\n",
  );
  assert.match((await read.execute("read-overlay", { path: "app.js" })).content[0].text, /value = 2/);
  assert.match(
    (await grep.execute("grep-overlay", {
      pattern: "value = 2",
      path: "",
      literal: true,
    })).content[0].text,
    /app\.js:1/,
  );

  await write.execute("write-new", {
    path: "src/new.js",
    content: "export const created = true;\n",
  });
  assert.equal(
    await readFile(path.join(workspaceRoot, "src", "new.js"), "utf8"),
    "export const created = true;\n",
  );
  await assert.rejects(access(path.join(baseRoot, "src", "new.js")));
  await assert.rejects(access(path.join(projectRoot, "src", "new.js")));

  await assert.rejects(
    write.execute("write-filtered", {
      path: ".env",
      content: "SECRET=no\n",
    }),
    /outside the filtered project workspace/,
  );
  await symlink(path.join(projectRoot, "app.js"), path.join(projectRoot, "linked.js"));
  await assert.rejects(
    read.execute("read-symlink", { path: "linked.js" }),
    /Symbolic links are not available/,
  );

  const attached = await readProjectWorkOverlayTextFile({
    projectRoot,
    baseRoot,
    workspaceRoot,
    filePath: "created-after-session.js",
  });
  assert.equal(attached.content, "export const late = true;\n");
  assert.match(attached.hash, /^sha256:/);
});

test("contained PDF tools expose only bounded conversation document access", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-document-tools-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  const baseRoot = path.join(temporaryRoot, "base");
  const workspaceRoot = path.join(temporaryRoot, "workspace");
  await Promise.all([
    mkdir(projectRoot),
    mkdir(baseRoot),
    mkdir(workspaceRoot),
  ]);
  const calls = [];
  const tools = await createProjectWorkTools({
    projectRoot,
    baseRoot,
    workspaceRoot,
    documentAccess: {
      async list() {
        calls.push({ type: "list" });
        return [{
          document_id: "document-1",
          file_name: "manual.pdf",
          status: "ready",
          document_revision: "sha256:current",
        }];
      },
      async search(request) {
        calls.push({ type: "search", request });
        return [{
          document_id: "document-1",
          document_revision: "sha256:current",
          block_id: "block-auth",
          excerpt: "认证令牌",
        }];
      },
      async read(request) {
        calls.push({ type: "read", request });
        return {
          document_id: "document-1",
          document_revision: "sha256:current",
          blocks: [{
            block_id: "block-auth",
            content: "认证令牌只能通过安全通道发送。",
          }],
          trust: "untrusted_reference",
        };
      },
    },
    onPlan: async () => {},
    onVerificationRequest: async () => ({ id: "verification-1" }),
  });

  const listed = await toolByName(tools, "list_documents").execute("list-docs", {});
  assert.match(listed.content[0].text, /manual\.pdf/);
  const searched = await toolByName(tools, "search_documents").execute(
    "search-docs",
    {
      query: "认证",
      document_ids: ["document-1"],
      limit: 3,
    },
  );
  assert.match(searched.content[0].text, /block-auth/);
  const read = await toolByName(tools, "read_document").execute("read-doc", {
    document_id: "document-1",
    document_revision: "sha256:current",
    block_ids: ["block-auth"],
  });
  assert.match(read.content[0].text, /untrusted_reference/);
  assert.deepEqual(calls, [{
    type: "list",
  }, {
    type: "search",
    request: {
      query: "认证",
      documentIds: ["document-1"],
      limit: 3,
    },
  }, {
    type: "read",
    request: {
      documentId: "document-1",
      revision: "sha256:current",
      blockIds: ["block-auth"],
    },
  }]);
});
