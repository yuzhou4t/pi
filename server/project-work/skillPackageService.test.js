import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import { gzipSync } from "node:zlib";
import {
  createSkillPackageService,
  describeSkillRuntimeContract,
  inspectSkillTarball,
  parsePiSkillCatalog,
} from "./skillPackageService.js";

function writeTarText(buffer, offset, length, value) {
  buffer.write(value, offset, Math.min(length, Buffer.byteLength(value)), "utf8");
}

function tarHeader(name, size) {
  const header = Buffer.alloc(512);
  writeTarText(header, 0, 100, name);
  writeTarText(header, 100, 8, "0000644\0");
  writeTarText(header, 108, 8, "0000000\0");
  writeTarText(header, 116, 8, "0000000\0");
  writeTarText(header, 124, 12, `${size.toString(8).padStart(11, "0")}\0`);
  writeTarText(header, 136, 12, "00000000000\0");
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeTarText(header, 257, 6, "ustar\0");
  writeTarText(header, 263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeTarText(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

function createTarball(files) {
  const chunks = [];
  for (const [name, value] of Object.entries(files)) {
    const content = Buffer.from(value);
    chunks.push(tarHeader(name, content.length), content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1_024));
  return gzipSync(Buffer.concat(chunks));
}

function createSkillFixture({
  name = "demo-skill",
  version = "1.2.3",
  manifest = {},
  skillText = "# Demo\n\nA bounded test skill.\n",
} = {}) {
  return createTarball({
    "package/package.json": JSON.stringify({
      name,
      version,
      description: "Demo package",
      pi: { skills: ["skills/demo"] },
      ...manifest,
    }),
    "package/skills/demo/SKILL.md": skillText,
  });
}

test("Pi catalog parser exposes pure Skill packages and blocks mixed packages", () => {
  const html = `
    <article data-package-card="true" data-package-name="pure-skill"
      data-package-types="skill" data-package-downloads="2100" data-package-date="1770000000">
      <p class="packages-desc">A focused Skill.</p>
      <div class="packages-meta"><span>Pi Author</span></div>
      <a href="/report?package=pure-skill&amp;package-version=1.4.0">Report</a>
    </article>
    <article data-package-card="true" data-package-name="mixed-package"
      data-package-types="skill extension" data-package-downloads="80" data-package-date="1770000001">
      <p class="packages-desc">Contains executable resources.</p>
      <div class="packages-meta"><span>Pi Author</span></div>
      <a href="/report?package=mixed-package&amp;package-version=2.0.0">Report</a>
    </article>
  `;

  const packages = parsePiSkillCatalog(html);
  assert.equal(packages.length, 2);
  assert.equal(packages[0].name, "pure-skill");
  assert.equal(packages[0].installSupported, true);
  assert.equal(packages[0].version, "1.4.0");
  assert.equal(packages[0].downloads, 2_100);
  assert.equal(packages[1].installSupported, false);
  assert.match(packages[1].unsupportedReason, /只支持纯 Skill/);
});

test("Skill archive inspection binds each Skill file and rejects active package content", () => {
  const tarball = createSkillFixture();
  const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  const inspected = inspectSkillTarball(tarball, {
    expectedName: "demo-skill",
    expectedVersion: "1.2.3",
    integrity,
  });

  assert.deepEqual(inspected.skillFiles, ["skills/demo/SKILL.md"]);
  assert.deepEqual(inspected.skillDocuments, [{
    path: "skills/demo/SKILL.md",
    content: "# Demo\n\nA bounded test skill.\n",
    digest: inspected.skillFileDigests["skills/demo/SKILL.md"],
  }]);
  assert.match(
    inspected.skillFileDigests["skills/demo/SKILL.md"],
    /^sha256:[a-f0-9]{64}$/,
  );
  assert.equal(inspected.integrity, integrity);

  assert.throws(
    () => inspectSkillTarball(createSkillFixture({
      manifest: { scripts: { postinstall: "node setup.js" } },
    }), {
      expectedName: "demo-skill",
      expectedVersion: "1.2.3",
    }),
    /安装阶段脚本/,
  );
  assert.throws(
    () => inspectSkillTarball(createSkillFixture({
      manifest: { dependencies: { "left-pad": "1.3.0" } },
    }), {
      expectedName: "demo-skill",
      expectedVersion: "1.2.3",
    }),
    /运行时依赖/,
  );
  assert.throws(
    () => inspectSkillTarball(createTarball({
      "package/package.json": JSON.stringify({
        name: "demo-skill",
        version: "1.2.3",
        pi: {
          skills: ["skills/demo"],
          extensions: ["extensions/index.js"],
        },
      }),
      "package/skills/demo/SKILL.md": "# Demo",
      "package/extensions/index.js": "export default () => {};",
    }), {
      expectedName: "demo-skill",
      expectedVersion: "1.2.3",
    }),
    /Extension/,
  );
});

test("reviewed Skill contracts expose exact effects and missing runtime capabilities", () => {
  const compatible = describeSkillRuntimeContract(
    "@pi-agent/project-orientation",
    ["project_read"],
  );
  assert.equal(compatible.reviewed, true);
  assert.equal(compatible.runtimeCompatible, true);
  assert.deepEqual(
    compatible.requiredRuntimeCapabilities.map((item) => item.id),
    ["project_read"],
  );
  assert.deepEqual(
    compatible.effectScopes.map((item) => item.id),
    ["project_orientation", "conversation_project_map"],
  );

  const incompatible = describeSkillRuntimeContract(
    "@pi-agent/git-closeout",
    ["project_read"],
  );
  assert.equal(incompatible.runtimeCompatible, false);
  assert.equal(incompatible.compatibilityStatus, "incompatible");
  assert.deepEqual(
    incompatible.missingRuntimeCapabilities.map((item) => item.id),
    ["git_closeout_transaction"],
  );
  assert.match(incompatible.compatibilityReason, /Git 收尾事务/);

  const unreviewed = describeSkillRuntimeContract("unknown-skill", []);
  assert.equal(unreviewed.reviewed, false);
  assert.equal(unreviewed.runtimeCompatible, false);
  assert.equal(unreviewed.compatibilityStatus, "unreviewed");
});

test("reviewed Skill installs disabled and only becomes loadable after explicit enable", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-skill-service-"));
  const storageRoot = path.join(temporaryRoot, "state");
  const installedPath = path.join(temporaryRoot, "installed", "demo-skill");
  const skillName = "@firstpick/pi-skill-html-report";
  const skillText = "# Demo\n\nA bounded test skill.\n";
  const tarball = createSkillFixture({ name: skillName, skillText });
  const tarballUrl = "https://registry.npmjs.org/@firstpick/pi-skill-html-report/-/pi-skill-html-report-1.2.3.tgz";
  const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href === "https://registry.npmjs.org/%40firstpick%2Fpi-skill-html-report") {
      return new Response(JSON.stringify({
        "dist-tags": { latest: "1.2.3" },
        versions: {
          "1.2.3": {
            name: skillName,
            version: "1.2.3",
            dist: { tarball: tarballUrl, integrity },
          },
        },
      }), { headers: { "content-type": "application/json" } });
    }
    if (href === tarballUrl) return new Response(tarball);
    throw new Error(`Unexpected URL: ${href}`);
  };
  const packageManager = {
    async install(source, options) {
      assert.equal(source, `npm:${skillName}@1.2.3`);
      assert.deepEqual(options, { local: false });
      await mkdir(path.join(installedPath, "skills", "demo"), { recursive: true });
      await writeFile(
        path.join(installedPath, "skills", "demo", "SKILL.md"),
        skillText,
      );
    },
    getInstalledPath(source, scope) {
      assert.equal(source, `npm:${skillName}@1.2.3`);
      assert.equal(scope, "user");
      return installedPath;
    },
  };
  const service = createSkillPackageService({
    storageRoot,
    fetchImpl,
    packageManager,
    now: () => new Date("2026-07-28T08:00:00.000Z"),
    idFactory: () => "stable-id",
  });

  try {
    const preview = await service.inspectPackage({
      name: skillName,
      version: "1.2.3",
    });
    assert.equal(preview.defaultEnabled, false);
    assert.match(preview.previewHash, /^sha256:[a-f0-9]{64}$/);
    assert.equal(preview.reviewMode, "install");
    assert.equal(preview.runtimeCompatible, true);
    assert.equal(preview.skillDocuments[0].content, skillText);
    assert.deepEqual(
      preview.effectScopes.map((item) => item.id),
      ["project_html_change_proposal"],
    );

    const installed = await service.installPackage({
      previewId: preview.previewId,
      previewHash: preview.previewHash,
    });
    assert.equal(installed.enabled, false);
    assert.deepEqual(await service.getEnabledSkillPaths(), []);

    const enabled = await service.setEnabled(skillName, true);
    assert.equal(enabled.enabled, true);
    assert.deepEqual(
      await service.getEnabledSkillPaths(),
      [path.join(installedPath, "skills", "demo", "SKILL.md")],
    );

    const stateText = await readFile(
      path.join(storageRoot, "skill-packages.json"),
      "utf8",
    );
    assert.doesNotMatch(stateText, /postinstall|extensions\/index/);

    const legacyState = JSON.parse(stateText);
    assert.deepEqual(
      legacyState.packages[0].skillFileDigests,
      {
        "skills/demo/SKILL.md": `sha256:${createHash("sha256")
          .update(skillText)
          .digest("hex")}`,
      },
    );
    assert.equal(legacyState.packages[0].integrityTrust, "review_confirmed");
    delete legacyState.packages[0].description;
    await writeFile(
      path.join(storageRoot, "skill-packages.json"),
      `${JSON.stringify(legacyState, null, 2)}\n`,
    );
    const refreshPreview = await service.inspectPackage({
      name: skillName,
      version: "1.2.3",
    });
    const refreshed = await service.installPackage({
      previewId: refreshPreview.previewId,
      previewHash: refreshPreview.previewHash,
    });
    assert.equal(refreshed.description, "Demo package");
    assert.equal(refreshed.enabled, true);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("Skill upgrade preview shows a hash-bound exact SKILL.md diff", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-skill-upgrade-"));
  const skillName = "@firstpick/pi-skill-html-report";
  const installedPath = path.join(temporaryRoot, "installed");
  const skillPath = path.join(installedPath, "skills", "demo", "SKILL.md");
  const versions = {
    "1.0.0": "# Report\n\nOld behavior.\n",
    "1.1.0": "# Report\n\nNew bounded behavior.\n",
  };
  const tarballs = Object.fromEntries(Object.entries(versions).map(
    ([version, skillText]) => [
      version,
      createSkillFixture({
        name: skillName,
        version,
        skillText,
      }),
    ],
  ));
  const tarballUrls = Object.fromEntries(Object.keys(versions).map((version) => [
    version,
    `https://registry.npmjs.org/@firstpick/pi-skill-html-report/-/pi-skill-html-report-${version}.tgz`,
  ]));
  const service = createSkillPackageService({
    storageRoot: path.join(temporaryRoot, "state"),
    fetchImpl: async (url) => {
      const href = String(url);
      if (href === "https://registry.npmjs.org/%40firstpick%2Fpi-skill-html-report") {
        return new Response(JSON.stringify({
          "dist-tags": { latest: "1.1.0" },
          versions: Object.fromEntries(Object.keys(versions).map((version) => [
            version,
            {
              name: skillName,
              version,
              dist: {
                tarball: tarballUrls[version],
                integrity: `sha512-${createHash("sha512")
                  .update(tarballs[version])
                  .digest("base64")}`,
              },
            },
          ])),
        }));
      }
      const version = Object.keys(tarballUrls).find(
        (candidate) => tarballUrls[candidate] === href,
      );
      if (version) return new Response(tarballs[version]);
      throw new Error(`Unexpected URL: ${href}`);
    },
    packageManager: {
      async install(source) {
        const version = source.endsWith("@1.1.0") ? "1.1.0" : "1.0.0";
        await mkdir(path.dirname(skillPath), { recursive: true });
        await writeFile(skillPath, versions[version]);
      },
      getInstalledPath() {
        return installedPath;
      },
    },
    idFactory: () => "upgrade-id",
  });

  try {
    const firstPreview = await service.inspectPackage({
      name: skillName,
      version: "1.0.0",
    });
    await service.installPackage({
      previewId: firstPreview.previewId,
      previewHash: firstPreview.previewHash,
    });

    const upgradePreview = await service.inspectPackage({
      name: skillName,
      version: "1.1.0",
    });
    assert.equal(upgradePreview.reviewMode, "upgrade");
    assert.equal(upgradePreview.installedVersion, "1.0.0");
    assert.deepEqual(upgradePreview.skillDocuments, []);
    assert.equal(upgradePreview.skillDiffs.length, 1);
    assert.match(upgradePreview.skillDiffs[0].patch, /-Old behavior\./);
    assert.match(upgradePreview.skillDiffs[0].patch, /\+New bounded behavior\./);

    await writeFile(skillPath, "# Report\n\nChanged after preview.\n");
    await assert.rejects(
      service.installPackage({
        previewId: upgradePreview.previewId,
        previewHash: upgradePreview.previewHash,
      }),
      (error) => (
        error.code === "PROJECT_WORK_SKILL_PREVIEW_STALE"
        && /内容在确认前发生了变化/.test(error.message)
      ),
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("bundled Pi Agent Skills use the same reviewed install and enable boundary", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bundled-skill-"));
  const storageRoot = path.join(temporaryRoot, "state");
  const bundledSkillRoot = path.join(temporaryRoot, "bundled");
  const skillText = [
    "---",
    "name: project-orientation",
    "description: Safely map a project before work.",
    "---",
    "",
    "# Project orientation",
    "",
  ].join("\n");
  await mkdir(path.join(bundledSkillRoot, "project-orientation"), {
    recursive: true,
  });
  await writeFile(
    path.join(bundledSkillRoot, "project-orientation", "SKILL.md"),
    skillText,
  );
  const service = createSkillPackageService({
    storageRoot,
    bundledSkillRoot,
    fetchImpl: null,
    now: () => new Date("2026-07-28T09:00:00.000Z"),
    idFactory: () => "bundled-id",
  });

  try {
    const catalog = await service.listCatalog({
      query: "@pi-agent/project-orientation",
    });
    assert.equal(catalog.source, "pi-agent");
    assert.equal(catalog.packages[0].bundled, true);
    assert.equal(catalog.packages[0].installed, false);

    const preview = await service.inspectPackage({
      name: "@pi-agent/project-orientation",
      version: "1.0.0",
    });
    assert.equal(preview.source, "bundled:@pi-agent/project-orientation@1.0.0");
    assert.deepEqual(
      preview.skillFiles,
      ["skills/project-orientation/SKILL.md"],
    );

    const installed = await service.installPackage({
      previewId: preview.previewId,
      previewHash: preview.previewHash,
    });
    assert.equal(installed.enabled, false);
    assert.equal(installed.description.includes("项目规则"), true);

    const enabled = await service.setEnabled(
      "@pi-agent/project-orientation",
      true,
    );
    assert.equal(enabled.enabled, true);
    const [enabledPath] = await service.getEnabledSkillPaths();
    assert.equal(
      await readFile(enabledPath, "utf8"),
      skillText,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("an installed Skill with missing runtime tools cannot be enabled or loaded", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-skill-incompatible-"));
  const bundledSkillRoot = path.join(temporaryRoot, "bundled");
  const skillText = "# Git closeout\n\nRequires a controlled Git transaction.\n";
  await mkdir(path.join(bundledSkillRoot, "git-closeout"), { recursive: true });
  await writeFile(
    path.join(bundledSkillRoot, "git-closeout", "SKILL.md"),
    skillText,
  );
  const service = createSkillPackageService({
    storageRoot: path.join(temporaryRoot, "state"),
    bundledSkillRoot,
    fetchImpl: null,
    runtimeCapabilityProvider: () => ["project_read"],
    now: () => new Date("2026-07-28T10:00:00.000Z"),
    idFactory: () => "incompatible-id",
  });

  try {
    const preview = await service.inspectPackage({
      name: "@pi-agent/git-closeout",
      version: "1.1.0",
    });
    assert.equal(preview.runtimeCompatible, false);
    assert.equal(preview.reviewMode, "install");
    assert.equal(preview.skillDocuments[0].content, skillText);

    const installed = await service.installPackage({
      previewId: preview.previewId,
      previewHash: preview.previewHash,
    });
    assert.equal(installed.enabled, false);
    assert.equal(installed.runtimeCompatible, false);

    await assert.rejects(
      service.setEnabled("@pi-agent/git-closeout", true),
      (error) => (
        error.code === "PROJECT_WORK_SKILL_RUNTIME_INCOMPATIBLE"
        && /Git 收尾事务/.test(error.message)
      ),
    );
    assert.deepEqual(await service.getEnabledSkillPaths(), []);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("an enabled Skill is disabled at load time when SKILL.md changes", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-skill-tamper-"));
  const storageRoot = path.join(temporaryRoot, "state");
  const bundledSkillRoot = path.join(temporaryRoot, "bundled");
  const sourcePath = path.join(
    bundledSkillRoot,
    "project-orientation",
    "SKILL.md",
  );
  const installedPath = path.join(
    storageRoot,
    "pi-skill-runtime",
    "bundled",
    "project-orientation",
    "skills",
    "project-orientation",
    "SKILL.md",
  );
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, "# Project orientation\n\nReviewed behavior.\n");
  const service = createSkillPackageService({
    storageRoot,
    bundledSkillRoot,
    fetchImpl: null,
    idFactory: () => "tamper-id",
  });

  try {
    const preview = await service.inspectPackage({
      name: "@pi-agent/project-orientation",
      version: "1.0.0",
    });
    await service.installPackage({
      previewId: preview.previewId,
      previewHash: preview.previewHash,
    });
    await service.setEnabled("@pi-agent/project-orientation", true);
    assert.deepEqual(await service.getEnabledSkillPaths(), [installedPath]);

    await writeFile(installedPath, "# Project orientation\n\nTampered.\n");

    assert.deepEqual(await service.getEnabledSkillPaths(), []);
    const installed = await service.listInstalled();
    assert.equal(installed.packages[0].enabled, false);
    assert.equal(installed.packages[0].enabledPreference, true);
    assert.equal(
      installed.packages[0].contentIntegrityStatus,
      "content_mismatch",
    );
    assert.match(
      installed.packages[0].contentIntegrityReason,
      /内容已变化/,
    );
    await assert.rejects(
      service.setEnabled("@pi-agent/project-orientation", true),
      { code: "PROJECT_WORK_SKILL_CONTENT_MISMATCH" },
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("an enabled Skill never follows a replacement SKILL.md symlink", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-skill-symlink-"));
  const storageRoot = path.join(temporaryRoot, "state");
  const bundledSkillRoot = path.join(temporaryRoot, "bundled");
  const sourcePath = path.join(
    bundledSkillRoot,
    "project-orientation",
    "SKILL.md",
  );
  const installedPath = path.join(
    storageRoot,
    "pi-skill-runtime",
    "bundled",
    "project-orientation",
    "skills",
    "project-orientation",
    "SKILL.md",
  );
  const outsidePath = path.join(temporaryRoot, "outside-SKILL.md");
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, "# Project orientation\n\nReviewed behavior.\n");
  await writeFile(outsidePath, "# Outside\n\nMust never be loaded.\n");
  const service = createSkillPackageService({
    storageRoot,
    bundledSkillRoot,
    fetchImpl: null,
    idFactory: () => "symlink-id",
  });

  try {
    const preview = await service.inspectPackage({
      name: "@pi-agent/project-orientation",
      version: "1.0.0",
    });
    await service.installPackage({
      previewId: preview.previewId,
      previewHash: preview.previewHash,
    });
    await service.setEnabled("@pi-agent/project-orientation", true);
    await rm(installedPath);
    await symlink(outsidePath, installedPath);

    assert.deepEqual(await service.getEnabledSkillPaths(), []);
    const installed = await service.listInstalled();
    assert.equal(installed.packages[0].enabled, false);
    assert.equal(
      installed.packages[0].contentIntegrityStatus,
      "content_mismatch",
    );
    assert.match(
      installed.packages[0].contentIntegrityReason,
      /路径已变化/,
    );
    await assert.rejects(
      service.setEnabled("@pi-agent/project-orientation", true),
      { code: "PROJECT_WORK_SKILL_CONTENT_MISMATCH" },
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("installed Skill content must still match the confirmed preview", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-skill-mismatch-"));
  const installedPath = path.join(temporaryRoot, "installed", "demo-skill");
  const tarball = createSkillFixture();
  const tarballUrl = "https://registry.npmjs.org/demo-skill/-/demo-skill-1.2.3.tgz";
  const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  const service = createSkillPackageService({
    storageRoot: path.join(temporaryRoot, "state"),
    fetchImpl: async (url) => {
      if (String(url) === tarballUrl) return new Response(tarball);
      return new Response(JSON.stringify({
        versions: {
          "1.2.3": {
            dist: { tarball: tarballUrl, integrity },
          },
        },
      }));
    },
    packageManager: {
      async install() {
        await mkdir(path.join(installedPath, "skills", "demo"), { recursive: true });
        await writeFile(
          path.join(installedPath, "skills", "demo", "SKILL.md"),
          "# Changed after review",
        );
      },
      getInstalledPath() {
        return installedPath;
      },
    },
    idFactory: () => "mismatch-id",
  });

  try {
    const preview = await service.inspectPackage({
      name: "demo-skill",
      version: "1.2.3",
    });
    await assert.rejects(
      service.installPackage({
        previewId: preview.previewId,
        previewHash: preview.previewHash,
      }),
      /已确认的 Skill 预览不一致/,
    );
    assert.deepEqual((await service.listInstalled()).packages, []);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
