import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  createSkillPackageService,
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

test("reviewed Skill installs disabled and only becomes loadable after explicit enable", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-skill-service-"));
  const storageRoot = path.join(temporaryRoot, "state");
  const installedPath = path.join(temporaryRoot, "installed", "demo-skill");
  const skillText = "# Demo\n\nA bounded test skill.\n";
  const tarball = createSkillFixture({ skillText });
  const tarballUrl = "https://registry.npmjs.org/demo-skill/-/demo-skill-1.2.3.tgz";
  const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href === "https://registry.npmjs.org/demo-skill") {
      return new Response(JSON.stringify({
        "dist-tags": { latest: "1.2.3" },
        versions: {
          "1.2.3": {
            name: "demo-skill",
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
      assert.equal(source, "npm:demo-skill@1.2.3");
      assert.deepEqual(options, { local: false });
      await mkdir(path.join(installedPath, "skills", "demo"), { recursive: true });
      await writeFile(
        path.join(installedPath, "skills", "demo", "SKILL.md"),
        skillText,
      );
    },
    getInstalledPath(source, scope) {
      assert.equal(source, "npm:demo-skill@1.2.3");
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
      name: "demo-skill",
      version: "1.2.3",
    });
    assert.equal(preview.defaultEnabled, false);
    assert.match(preview.previewHash, /^sha256:[a-f0-9]{64}$/);

    const installed = await service.installPackage({
      previewId: preview.previewId,
      previewHash: preview.previewHash,
    });
    assert.equal(installed.enabled, false);
    assert.deepEqual(await service.getEnabledSkillPaths(), []);

    const enabled = await service.setEnabled("demo-skill", true);
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
