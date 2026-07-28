import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createFilteredProjectSnapshot,
  getProjectFileTree,
  getProjectOverlayFileTree,
  readProjectImageFile,
  readProjectOverlayImageFile,
  recomputeChangeSet,
} from "./workspace.js";

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

test("a sparse base-only crash remnant never becomes a delete proposal", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-workspace-sparse-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const baseRoot = path.join(temporaryRoot, "base");
  const workspaceRoot = path.join(temporaryRoot, "workspace");
  await Promise.all([mkdir(baseRoot), mkdir(workspaceRoot)]);
  await writeFile(path.join(baseRoot, "app.js"), "captured before crash\n");

  const sparse = await recomputeChangeSet({
    conversationId: "conversation-sparse",
    baseRoot,
    workspaceRoot,
    allowDeletes: false,
  });
  const legacy = await recomputeChangeSet({
    conversationId: "conversation-legacy",
    baseRoot,
    workspaceRoot,
  });

  assert.equal(sparse.status, "clean");
  assert.deepEqual(sparse.files, []);
  assert.equal(legacy.files[0].operation, "delete");
});

test("project trees paginate and search without exposing secrets or symlinks", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-workspace-tree-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  await mkdir(path.join(projectRoot, "src", "components"), { recursive: true });
  await mkdir(path.join(projectRoot, ".worktrees", "internal"), { recursive: true });
  await writeFile(path.join(projectRoot, "README.md"), "read me\n");
  await writeFile(path.join(projectRoot, "package.json"), "{}\n");
  await writeFile(path.join(projectRoot, "src", "settings.js"), "export {};\n");
  await writeFile(
    path.join(projectRoot, "src", "components", "SettingsPanel.jsx"),
    "export default null;\n",
  );
  await writeFile(path.join(projectRoot, ".DS_Store"), "private");
  await writeFile(path.join(projectRoot, ".env"), "TOKEN=private\n");
  await writeFile(path.join(projectRoot, "credentials.json"), "{}\n");
  await writeFile(path.join(projectRoot, "signing.key"), "private\n");
  await writeFile(
    path.join(projectRoot, ".worktrees", "internal", "ignored.js"),
    "ignored\n",
  );
  await symlink(path.join(projectRoot, "src"), path.join(projectRoot, "linked-src"));

  const first = await getProjectFileTree(projectRoot, { limit: 2 });
  assert.equal(first.entries.length, 2);
  assert.ok(first.nextCursor);
  const second = await getProjectFileTree(projectRoot, {
    limit: 2,
    cursor: first.nextCursor,
  });
  assert.equal(
    new Set([...first.entries, ...second.entries].map((entry) => entry.path)).size,
    first.entries.length + second.entries.length,
  );

  const complete = await getProjectFileTree(projectRoot, { limit: 50 });
  assert.deepEqual(
    complete.entries.map((entry) => entry.path),
    ["src", "package.json", "README.md"],
  );
  assert.equal(
    complete.entries.some((entry) => entry.type === "symlink"),
    false,
  );

  const search = await getProjectFileTree(projectRoot, {
    query: "settings",
    limit: 10,
  });
  assert.deepEqual(
    search.entries.map((entry) => entry.path),
    ["src/components/SettingsPanel.jsx", "src/settings.js"],
  );
  assert.ok(search.scannedEntries >= 4);

  await assert.rejects(
    getProjectFileTree(projectRoot, {
      directory: "linked-src",
      limit: 10,
    }),
    (error) => error?.code === "PROJECT_WORK_FILE_UNSAFE",
  );
  await writeFile(path.join(projectRoot, "after-cursor.txt"), "changed\n");
  await assert.rejects(
    getProjectFileTree(projectRoot, {
      limit: 2,
      cursor: first.nextCursor,
    }),
    (error) => error?.code === "PROJECT_WORK_TREE_CURSOR_STALE",
  );
});

test("conversation trees merge created and modified workspace files", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-workspace-overlay-tree-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  const workspaceRoot = path.join(temporaryRoot, "workspace");
  await Promise.all([
    mkdir(path.join(projectRoot, "src"), { recursive: true }),
    mkdir(path.join(workspaceRoot, "src"), { recursive: true }),
  ]);
  await writeFile(path.join(projectRoot, "README.md"), "before\n");
  await writeFile(path.join(projectRoot, "src", "existing.js"), "before\n");
  await writeFile(path.join(workspaceRoot, "README.md"), "after\n");
  await writeFile(path.join(workspaceRoot, "src", "created.js"), "created\n");

  const root = await getProjectOverlayFileTree({
    projectRoot,
    workspaceRoot,
    limit: 20,
  });
  assert.deepEqual(
    root.entries.map(({ path: entryPath, overlay }) => ({ path: entryPath, overlay })),
    [
      { path: "src", overlay: undefined },
      { path: "README.md", overlay: "modified" },
    ],
  );
  const nested = await getProjectOverlayFileTree({
    projectRoot,
    workspaceRoot,
    directory: "src",
    limit: 20,
  });
  assert.deepEqual(
    nested.entries.map(({ path: entryPath, overlay }) => ({ path: entryPath, overlay })),
    [
      { path: "src/created.js", overlay: "created" },
      { path: "src/existing.js", overlay: undefined },
    ],
  );
  const searched = await getProjectOverlayFileTree({
    projectRoot,
    workspaceRoot,
    query: "created",
    limit: 20,
  });
  assert.equal(searched.entries[0].path, "src/created.js");
  assert.equal(searched.entries[0].overlay, "created");
});

test("image reads require a safe path, bounded bytes, and matching magic bytes", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-workspace-images-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  const workspaceRoot = path.join(temporaryRoot, "workspace");
  await Promise.all([mkdir(projectRoot), mkdir(workspaceRoot)]);
  const pngHeader = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  await writeFile(path.join(projectRoot, "preview.png"), pngHeader);
  await writeFile(path.join(projectRoot, "fake.png"), "not an image");
  await writeFile(
    path.join(projectRoot, "large.png"),
    Buffer.concat([pngHeader, Buffer.alloc(8 * 1024 * 1024)]),
  );
  await symlink(
    path.join(projectRoot, "preview.png"),
    path.join(projectRoot, "linked.png"),
  );
  await writeFile(
    path.join(workspaceRoot, "created.webp"),
    Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]),
  );

  const image = await readProjectImageFile(projectRoot, {
    filePath: "preview.png",
  });
  assert.equal(image.path, "preview.png");
  assert.equal(image.mimeType, "image/png");
  assert.equal(image.byteLength, pngHeader.length);
  assert.equal(image.bytes.equals(pngHeader), true);
  assert.equal(Object.hasOwn(image, "target"), false);

  const overlayImage = await readProjectOverlayImageFile({
    projectRoot,
    workspaceRoot,
    filePath: "created.webp",
  });
  assert.equal(overlayImage.path, "created.webp");
  assert.equal(overlayImage.mimeType, "image/webp");

  await assert.rejects(
    readProjectImageFile(projectRoot, { filePath: "fake.png" }),
    (error) => error?.code === "PROJECT_WORK_IMAGE_INVALID",
  );
  await assert.rejects(
    readProjectImageFile(projectRoot, { filePath: "large.png" }),
    (error) => error?.code === "PROJECT_WORK_IMAGE_TOO_LARGE",
  );
  await assert.rejects(
    readProjectImageFile(projectRoot, { filePath: "linked.png" }),
    (error) => error?.code === "PROJECT_WORK_FILE_UNSAFE",
  );
});
