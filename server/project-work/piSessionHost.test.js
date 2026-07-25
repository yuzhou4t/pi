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
  createProjectWorkTools,
  readProjectWorkOverlayTextFile,
} from "./piSessionHost.js";

function toolByName(tools, name) {
  const tool = tools.find((item) => item.name === name);
  assert.ok(tool, `missing ${name} tool`);
  return tool;
}

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
