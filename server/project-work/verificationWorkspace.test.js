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
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createVerificationProjectSnapshot } from "./verificationWorkspace.js";

test("verification workspace copies dependencies and binary assets without touching live files", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-verification-copy-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  const storageRoot = path.join(temporaryRoot, "private");
  const baseRoot = path.join(storageRoot, "base");
  const workspaceRoot = path.join(storageRoot, "workspace");
  await Promise.all([
    mkdir(path.join(projectRoot, "node_modules", "fixture", "bin"), {
      recursive: true,
    }),
    mkdir(path.join(projectRoot, "node_modules", ".bin"), {
      recursive: true,
    }),
    mkdir(storageRoot),
  ]);
  await writeFile(
    path.join(projectRoot, "package.json"),
    JSON.stringify({ scripts: { test: "vitest" } }),
  );
  await writeFile(
    path.join(projectRoot, "asset.png"),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  await writeFile(path.join(projectRoot, ".env"), "SECRET=hidden\n");
  await writeFile(
    path.join(projectRoot, "node_modules", "fixture", "bin", "vitest.js"),
    "#!/usr/bin/env node\nconsole.log('fixture');\n",
    { mode: 0o755 },
  );
  await symlink(
    "../fixture/bin/vitest.js",
    path.join(projectRoot, "node_modules", ".bin", "vitest"),
  );

  const materialized = await createVerificationProjectSnapshot({
    projectRoot,
    storageRoot,
    baseRoot,
    workspaceRoot,
    recipeStack: "node",
  });

  assert.equal(materialized.truncated, false);
  assert.equal(materialized.skippedBinaryFiles, 0);
  assert.match(materialized.manifestHash, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(
    await readFile(path.join(workspaceRoot, "asset.png")),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  assert.match(
    await readFile(
      path.join(workspaceRoot, "node_modules", ".bin", "vitest"),
      "utf8",
    ),
    /fixture/,
  );
  await assert.rejects(access(path.join(workspaceRoot, ".env")), {
    code: "ENOENT",
  });

  await writeFile(path.join(workspaceRoot, "package.json"), "{}\n");
  assert.notEqual(
    await readFile(path.join(projectRoot, "package.json"), "utf8"),
    "{}\n",
  );
});

test("verification workspace rejects links that escape the project", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-verification-link-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, "project");
  const storageRoot = path.join(temporaryRoot, "private");
  await Promise.all([mkdir(projectRoot), mkdir(storageRoot)]);
  await writeFile(path.join(temporaryRoot, "outside.txt"), "outside\n");
  await symlink(
    path.join(temporaryRoot, "outside.txt"),
    path.join(projectRoot, "outside-link.txt"),
  );

  await assert.rejects(
    createVerificationProjectSnapshot({
      projectRoot,
      storageRoot,
      baseRoot: path.join(storageRoot, "base"),
      workspaceRoot: path.join(storageRoot, "workspace"),
      recipeStack: "node",
    }),
    { code: "PROJECT_WORK_VERIFICATION_LINK_UNSAFE" },
  );
});
