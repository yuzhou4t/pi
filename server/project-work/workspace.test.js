import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFilteredProjectSnapshot } from "./workspace.js";

async function listSnapshotFiles(root, relativeDirectory = "") {
  const directory = path.join(root, relativeDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = [relativeDirectory, entry.name].filter(Boolean).join("/");
    if (entry.isDirectory()) {
      files.push(...await listSnapshotFiles(root, relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files.sort();
}

test("large project snapshots stay usable by collecting shallow text files first", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-workspace-large-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  const baseRoot = path.join(temporaryRoot, "state", "base");
  const workspaceRoot = path.join(temporaryRoot, "state", "workspace");
  const secondBaseRoot = path.join(temporaryRoot, "second-state", "base");
  const secondWorkspaceRoot = path.join(temporaryRoot, "second-state", "workspace");

  await mkdir(path.join(projectRoot, "alpha", "src", "deep"), { recursive: true });
  await mkdir(path.join(projectRoot, "beta", "src"), { recursive: true });
  await mkdir(path.join(projectRoot, ".worktrees", "copy"), { recursive: true });
  await writeFile(path.join(projectRoot, "README.md"), "root\n");
  await writeFile(path.join(projectRoot, "alpha", "package.json"), "{}\n");
  await writeFile(path.join(projectRoot, "beta", "package.json"), "{}\n");
  await writeFile(path.join(projectRoot, "alpha", "src", "app.js"), "alpha\n");
  await writeFile(path.join(projectRoot, "beta", "src", "app.js"), "beta\n");
  await writeFile(
    path.join(projectRoot, "alpha", "src", "deep", "later.js"),
    "later\n",
  );
  await writeFile(path.join(projectRoot, ".worktrees", "copy", "ignored.js"), "ignored\n");
  await writeFile(path.join(projectRoot, "preview.png"), Buffer.from([0, 1, 2]));

  const snapshot = await createFilteredProjectSnapshot({
    projectRoot,
    baseRoot,
    workspaceRoot,
    storageRoot: path.join(temporaryRoot, "state"),
    maxFiles: 5,
    maxBytes: 1_024,
  });
  const secondSnapshot = await createFilteredProjectSnapshot({
    projectRoot,
    baseRoot: secondBaseRoot,
    workspaceRoot: secondWorkspaceRoot,
    storageRoot: path.join(temporaryRoot, "second-state"),
    maxFiles: 5,
    maxBytes: 1_024,
  });

  assert.equal(snapshot.files, 5);
  assert.equal(snapshot.truncated, true);
  assert.deepEqual(secondSnapshot, snapshot);
  assert.deepEqual(
    await listSnapshotFiles(secondWorkspaceRoot),
    await listSnapshotFiles(workspaceRoot),
  );
  assert.equal(await readFile(path.join(workspaceRoot, "alpha", "src", "app.js"), "utf8"), "alpha\n");
  assert.equal(await readFile(path.join(workspaceRoot, "beta", "src", "app.js"), "utf8"), "beta\n");
  await assert.rejects(access(path.join(workspaceRoot, ".worktrees", "copy", "ignored.js")));
  await assert.rejects(access(path.join(workspaceRoot, "preview.png")));
  await assert.rejects(access(path.join(workspaceRoot, "alpha", "src", "deep", "later.js")));
});
