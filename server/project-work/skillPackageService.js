import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  DefaultPackageManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { projectWorkError } from "./errors.js";

const CATALOG_BASE_URL = "https://pi.dev/packages";
const NPM_REGISTRY_BASE_URL = "https://registry.npmjs.org";
const CATALOG_CACHE_TTL_MS = 5 * 60 * 1_000;
const PREVIEW_TTL_MS = 10 * 60 * 1_000;
const MAX_CATALOG_BYTES = 3 * 1024 * 1024;
const MAX_REGISTRY_BYTES = 4 * 1024 * 1024;
const MAX_TARBALL_BYTES = 10 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 32 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 2_000;
const MAX_SKILLS_PER_PACKAGE = 20;
const MAX_SKILL_FILE_BYTES = 256 * 1024;
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
const SORTS = new Set(["downloads", "recent", "name"]);
const BLOCKED_INSTALL_SCRIPTS = new Set([
  "preinstall",
  "install",
  "postinstall",
  "prepare",
]);
const DEFAULT_BUNDLED_SKILL_ROOT = fileURLToPath(
  new URL("./bundled-skills/", import.meta.url),
);
const BUNDLED_SKILL_PACKAGES = Object.freeze({
  "@pi-agent/project-orientation": Object.freeze({
    version: "1.0.0",
    directory: "project-orientation",
    skillName: "project-orientation",
    description: "先核对项目规则、入口、技术栈和运行边界，再安全开始当前工作。",
  }),
  "@pi-agent/git-closeout": Object.freeze({
    version: "1.0.0",
    directory: "git-closeout",
    skillName: "git-closeout",
    description: "审查任务变更、验证证据和暂存范围，经明确确认后完成本地 Git 提交。",
  }),
});

function decodeHtml(value = "") {
  return value
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_match, code) => (
      String.fromCodePoint(Number.parseInt(code, 16))
    ))
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function textFromHtml(value = "") {
  return decodeHtml(value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function attribute(tag, name) {
  const match = tag.match(new RegExp(`${name}="([^"]*)"`));
  return match ? decodeHtml(match[1]) : "";
}

function firstMatch(value, pattern) {
  const match = value.match(pattern);
  return match ? textFromHtml(match[1]) : "";
}

function publicInstalledPackage(value) {
  return {
    id: value.name,
    name: value.name,
    version: value.version,
    source: value.source,
    description: typeof value.description === "string" ? value.description : "",
    enabled: value.enabled === true,
    installedAt: value.installedAt,
    skillCount: Array.isArray(value.skillFiles) ? value.skillFiles.length : 0,
    skillFiles: Array.isArray(value.skillFiles) ? [...value.skillFiles] : [],
  };
}

export function parsePiSkillCatalog(html) {
  if (typeof html !== "string") return [];
  const packages = [];
  const articlePattern = /(<article\b[^>]*data-package-card="true"[^>]*>)([\s\S]*?)<\/article>/g;
  for (const match of html.matchAll(articlePattern)) {
    const [, openingTag, body] = match;
    const name = attribute(openingTag, "data-package-name");
    if (!PACKAGE_NAME_PATTERN.test(name)) continue;
    const types = attribute(openingTag, "data-package-types")
      .split(/\s+/)
      .filter(Boolean);
    if (!types.includes("skill")) continue;
    const description = firstMatch(
      body,
      /<p\b[^>]*class="[^"]*\bpackages-desc\b[^"]*"[^>]*>([\s\S]*?)<\/p>/,
    );
    const author = firstMatch(
      body,
      /<div\b[^>]*class="[^"]*\bpackages-meta\b[^"]*"[^>]*>\s*<span>([\s\S]*?)<\/span>/,
    );
    const versionMatch = body.match(/package-version=([^&"']+)/);
    const version = versionMatch ? decodeURIComponent(decodeHtml(versionMatch[1])) : null;
    const repoMatch = body.match(/href="(https:\/\/github\.com\/[^"]+)"/);
    const downloads = Number(attribute(openingTag, "data-package-downloads")) || 0;
    packages.push({
      id: name,
      name,
      description,
      author,
      version,
      types,
      downloads,
      publishedAt: Number(attribute(openingTag, "data-package-date")) || null,
      source: version ? `npm:${name}@${version}` : `npm:${name}`,
      catalogUrl: `${CATALOG_BASE_URL}?type=skill&name=${encodeURIComponent(name)}`,
      npmUrl: `https://www.npmjs.com/package/${name}`,
      repoUrl: repoMatch ? decodeHtml(repoMatch[1]) : null,
      installSupported: types.length === 1 && types[0] === "skill",
      unsupportedReason: types.length === 1 && types[0] === "skill"
        ? null
        : "这个包还包含 Extension 或其他资源，当前只支持纯 Skill 包",
    });
  }
  return packages;
}

function tarString(buffer, start, length) {
  return buffer.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
}

function safeArchivePath(value) {
  const normalized = path.posix.normalize(value);
  return (
    normalized === value
    && normalized.startsWith("package/")
    && !normalized.includes("/../")
    && !normalized.startsWith("/")
  );
}

function parseTarEntries(buffer) {
  const entries = [];
  let offset = 0;
  let unpackedBytes = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const filePath = prefix ? `${prefix}/${name}` : name;
    const sizeText = tarString(header, 124, 12).trim();
    const size = Number.parseInt(sizeText || "0", 8);
    const type = String.fromCharCode(header[156] || 48);
    if (!Number.isSafeInteger(size) || size < 0 || !safeArchivePath(filePath)) {
      throw projectWorkError(
        "PROJECT_WORK_SKILL_ARCHIVE_INVALID",
        "Skill 包的归档结构无效",
        422,
      );
    }
    if (type === "1" || type === "2") {
      throw projectWorkError(
        "PROJECT_WORK_SKILL_ARCHIVE_LINK_UNSUPPORTED",
        "Skill 包包含链接文件，当前不能安装",
        422,
      );
    }
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (contentEnd > buffer.length) {
      throw projectWorkError(
        "PROJECT_WORK_SKILL_ARCHIVE_TRUNCATED",
        "Skill 包下载不完整",
        422,
      );
    }
    unpackedBytes += size;
    if (unpackedBytes > MAX_UNPACKED_BYTES || entries.length >= MAX_ARCHIVE_FILES) {
      throw projectWorkError(
        "PROJECT_WORK_SKILL_ARCHIVE_TOO_LARGE",
        "Skill 包展开后超过当前安全限制",
        413,
      );
    }
    if (type === "0" || type === "\0") {
      entries.push({
        path: filePath,
        size,
        content: buffer.subarray(contentStart, contentEnd),
      });
    }
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function manifestArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

export function inspectSkillTarball(tarball, {
  expectedName,
  expectedVersion,
  integrity,
} = {}) {
  if (!Buffer.isBuffer(tarball) || tarball.length > MAX_TARBALL_BYTES) {
    throw projectWorkError(
      "PROJECT_WORK_SKILL_ARCHIVE_TOO_LARGE",
      "Skill 包下载体积超过当前安全限制",
      413,
    );
  }
  if (typeof integrity === "string" && integrity.includes("-")) {
    const separator = integrity.indexOf("-");
    const algorithm = integrity.slice(0, separator);
    const expectedDigest = integrity.slice(separator + 1);
    if (["sha256", "sha384", "sha512"].includes(algorithm)) {
      const actualDigest = createHash(algorithm).update(tarball).digest("base64");
      if (actualDigest !== expectedDigest) {
        throw projectWorkError(
          "PROJECT_WORK_SKILL_INTEGRITY_MISMATCH",
          "Skill 包完整性校验失败",
          422,
        );
      }
    }
  }
  let unpacked;
  try {
    unpacked = gunzipSync(tarball, { maxOutputLength: MAX_UNPACKED_BYTES });
  } catch {
    throw projectWorkError(
      "PROJECT_WORK_SKILL_ARCHIVE_INVALID",
      "Skill 包无法安全解压",
      422,
    );
  }
  const entries = parseTarEntries(unpacked);
  const manifestEntry = entries.find((entry) => entry.path === "package/package.json");
  if (!manifestEntry || manifestEntry.size > 256 * 1024) {
    throw projectWorkError(
      "PROJECT_WORK_SKILL_MANIFEST_MISSING",
      "Skill 包缺少有效的 package.json",
      422,
    );
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestEntry.content.toString("utf8"));
  } catch {
    throw projectWorkError(
      "PROJECT_WORK_SKILL_MANIFEST_INVALID",
      "Skill 包的 package.json 无效",
      422,
    );
  }
  if (
    manifest.name !== expectedName
    || (expectedVersion && manifest.version !== expectedVersion)
  ) {
    throw projectWorkError(
      "PROJECT_WORK_SKILL_IDENTITY_MISMATCH",
      "Skill 包身份与安装预览不一致",
      422,
    );
  }
  const scripts = manifest.scripts && typeof manifest.scripts === "object"
    ? Object.keys(manifest.scripts)
    : [];
  if (scripts.some((name) => BLOCKED_INSTALL_SCRIPTS.has(name))) {
    throw projectWorkError(
      "PROJECT_WORK_SKILL_INSTALL_SCRIPT_BLOCKED",
      "Skill 包包含安装阶段脚本，当前不能安装",
      422,
    );
  }
  const dependencyCount = [
    manifest.dependencies,
    manifest.optionalDependencies,
    manifest.bundleDependencies,
    manifest.bundledDependencies,
  ].reduce((count, value) => {
    if (Array.isArray(value)) return count + value.length;
    return count + (
      value && typeof value === "object" ? Object.keys(value).length : 0
    );
  }, 0);
  if (dependencyCount > 0) {
    throw projectWorkError(
      "PROJECT_WORK_SKILL_DEPENDENCIES_BLOCKED",
      "Skill 包包含运行时依赖，当前纯 Skill 安装暂不支持",
      422,
    );
  }
  const piManifest = manifest.pi && typeof manifest.pi === "object"
    ? manifest.pi
    : {};
  if (
    manifestArray(piManifest.extensions).length
    || manifestArray(piManifest.prompts).length
    || manifestArray(piManifest.themes).length
  ) {
    throw projectWorkError(
      "PROJECT_WORK_SKILL_MIXED_RESOURCES_BLOCKED",
      "这个包还包含 Extension、Prompt 或 Theme，当前不能安装",
      422,
    );
  }
  const skillEntries = entries.filter((entry) => (
    /^package\/skills\/.+\/SKILL\.md$/.test(entry.path)
  ));
  if (!skillEntries.length || skillEntries.length > MAX_SKILLS_PER_PACKAGE) {
    throw projectWorkError(
      "PROJECT_WORK_SKILL_FILES_INVALID",
      "包内必须包含 1–20 个标准 skills/<name>/SKILL.md",
      422,
    );
  }
  if (skillEntries.some((entry) => entry.size > MAX_SKILL_FILE_BYTES)) {
    throw projectWorkError(
      "PROJECT_WORK_SKILL_FILE_TOO_LARGE",
      "包内 Skill 文件超过当前安全限制",
      413,
    );
  }
  const mixedFiles = entries.some((entry) => (
    /^package\/(extensions|prompts|themes)\//.test(entry.path)
  ));
  if (mixedFiles) {
    throw projectWorkError(
      "PROJECT_WORK_SKILL_MIXED_RESOURCES_BLOCKED",
      "这个包还包含 Extension、Prompt 或 Theme，当前不能安装",
      422,
    );
  }
  const skillFiles = skillEntries.map((entry) => entry.path.slice("package/".length));
  const skillFileDigests = Object.fromEntries(skillEntries.map((entry) => [
    entry.path.slice("package/".length),
    `sha256:${createHash("sha256").update(entry.content).digest("hex")}`,
  ]));
  return {
    name: manifest.name,
    version: manifest.version,
    description: typeof manifest.description === "string" ? manifest.description : "",
    integrity: integrity ?? `sha256-${createHash("sha256").update(tarball).digest("base64")}`,
    skillFiles,
    skillFileDigests,
    archiveFileCount: entries.length,
    archiveBytes: tarball.length,
  };
}

async function fetchBuffer(fetchImpl, url, {
  maxBytes,
  timeoutMs = 10_000,
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: "application/json,text/html,application/octet-stream" },
    });
    if (!response.ok) {
      throw projectWorkError(
        "PROJECT_WORK_SKILL_SOURCE_FAILED",
        "Skill 目录暂时无法访问",
        502,
        true,
      );
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw projectWorkError(
        "PROJECT_WORK_SKILL_SOURCE_TOO_LARGE",
        "Skill 来源返回内容过大",
        413,
      );
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw projectWorkError(
        "PROJECT_WORK_SKILL_SOURCE_TOO_LARGE",
        "Skill 来源返回内容过大",
        413,
      );
    }
    return buffer;
  } finally {
    clearTimeout(timer);
  }
}

export function createSkillPackageService({
  storageRoot,
  fetchImpl = globalThis.fetch,
  packageManager,
  bundledSkillRoot = DEFAULT_BUNDLED_SKILL_ROOT,
  now = () => new Date(),
  idFactory = randomUUID,
} = {}) {
  const root = path.resolve(storageRoot ?? ".pi-agent");
  const agentDir = path.join(root, "pi-skill-runtime");
  const statePath = path.join(root, "skill-packages.json");
  let effectivePackageManager = packageManager;
  let packageManagerPromise = null;
  let mutationQueue = Promise.resolve();
  const catalogCache = new Map();
  const previews = new Map();

  async function getPackageManager() {
    if (effectivePackageManager) return effectivePackageManager;
    if (!packageManagerPromise) {
      packageManagerPromise = (async () => {
        await mkdir(agentDir, { recursive: true, mode: 0o700 });
        const settingsManager = SettingsManager.create(agentDir, agentDir, {
          projectTrusted: false,
        });
        return new DefaultPackageManager({
          cwd: agentDir,
          agentDir,
          settingsManager,
        });
      })();
    }
    effectivePackageManager = await packageManagerPromise;
    return effectivePackageManager;
  }

  async function readState() {
    try {
      const parsed = JSON.parse(await readFile(statePath, "utf8"));
      return {
        schemaVersion: 1,
        revision: Number.isSafeInteger(parsed.revision) ? parsed.revision : 0,
        packages: Array.isArray(parsed.packages) ? parsed.packages : [],
      };
    } catch (error) {
      if (error?.code === "ENOENT") {
        return { schemaVersion: 1, revision: 0, packages: [] };
      }
      throw projectWorkError(
        "PROJECT_WORK_SKILL_STATE_INVALID",
        "本机 Skill 安装状态无法读取",
        500,
        true,
      );
    }
  }

  async function writeState(state) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const temporaryPath = `${statePath}.${idFactory()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, statePath);
  }

  function mutate(task) {
    const operation = mutationQueue.then(task, task);
    mutationQueue = operation.catch(() => undefined);
    return operation;
  }

  async function listInstalled() {
    const state = await readState();
    return {
      schemaVersion: 1,
      revision: state.revision,
      packages: state.packages.map(publicInstalledPackage),
    };
  }

  async function listCatalog({ query = "", sort = "downloads" } = {}) {
    const normalizedQuery = typeof query === "string" ? query.trim().slice(0, 80) : "";
    const normalizedSort = SORTS.has(sort) ? sort : "downloads";
    const bundled = BUNDLED_SKILL_PACKAGES[normalizedQuery];
    if (bundled) {
      const installed = await readState();
      const current = installed.packages.find((item) => item.name === normalizedQuery);
      return {
        schemaVersion: 1,
        source: "pi-agent",
        query: normalizedQuery,
        sort: normalizedSort,
        packages: [{
          id: normalizedQuery,
          name: normalizedQuery,
          description: bundled.description,
          author: "Pi Agent",
          version: bundled.version,
          types: ["skill"],
          downloads: 0,
          publishedAt: null,
          source: `bundled:${normalizedQuery}@${bundled.version}`,
          catalogUrl: null,
          npmUrl: null,
          repoUrl: null,
          installSupported: true,
          unsupportedReason: null,
          bundled: true,
          installed: Boolean(current),
          enabled: current?.enabled === true,
          installedVersion: current?.version ?? null,
        }],
      };
    }
    if (typeof fetchImpl !== "function") {
      throw projectWorkError(
        "PROJECT_WORK_SKILL_CATALOG_UNAVAILABLE",
        "当前环境无法访问 Pi Skill 目录",
        503,
        true,
      );
    }
    const cacheKey = `${normalizedQuery}\n${normalizedSort}`;
    const cached = catalogCache.get(cacheKey);
    if (cached && cached.expiresAt > now().getTime()) {
      return structuredClone(cached.value);
    }
    const url = new URL(CATALOG_BASE_URL);
    url.searchParams.set("type", "skill");
    url.searchParams.set("sort", normalizedSort);
    if (normalizedQuery) url.searchParams.set("name", normalizedQuery);
    const html = (
      await fetchBuffer(fetchImpl, url, { maxBytes: MAX_CATALOG_BYTES })
    ).toString("utf8");
    const [catalog, installed] = await Promise.all([
      Promise.resolve(parsePiSkillCatalog(html)),
      readState(),
    ]);
    const installedByName = new Map(
      installed.packages.map((item) => [item.name, item]),
    );
    const value = {
      schemaVersion: 1,
      source: "pi.dev",
      query: normalizedQuery,
      sort: normalizedSort,
      packages: catalog.map((item) => ({
        ...item,
        installed: installedByName.has(item.name),
        enabled: installedByName.get(item.name)?.enabled === true,
        installedVersion: installedByName.get(item.name)?.version ?? null,
      })),
    };
    catalogCache.set(cacheKey, {
      expiresAt: now().getTime() + CATALOG_CACHE_TTL_MS,
      value,
    });
    return structuredClone(value);
  }

  async function inspectPackage({ name, version } = {}) {
    if (!PACKAGE_NAME_PATTERN.test(name ?? "")) {
      throw projectWorkError(
        "PROJECT_WORK_SKILL_PACKAGE_INVALID",
        "Skill 包名称无效",
        400,
      );
    }
    const bundled = BUNDLED_SKILL_PACKAGES[name];
    if (bundled) {
      if (version && version !== bundled.version) {
        throw projectWorkError(
          "PROJECT_WORK_SKILL_VERSION_NOT_FOUND",
          "Skill 包版本不存在或来源不受支持",
          404,
        );
      }
      const sourcePath = path.join(
        bundledSkillRoot,
        bundled.directory,
        "SKILL.md",
      );
      let content;
      try {
        content = await readFile(sourcePath);
      } catch {
        throw projectWorkError(
          "PROJECT_WORK_SKILL_SOURCE_FAILED",
          "Pi Agent 内置 Skill 暂时无法读取",
          500,
          true,
        );
      }
      if (content.length > MAX_SKILL_FILE_BYTES) {
        throw projectWorkError(
          "PROJECT_WORK_SKILL_FILE_TOO_LARGE",
          "内置 Skill 文件超过当前安全限制",
          413,
        );
      }
      const skillFile = `skills/${bundled.skillName}/SKILL.md`;
      const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
      const source = `bundled:${name}@${bundled.version}`;
      const integrity = `sha256-${createHash("sha256").update(content).digest("base64")}`;
      const previewHash = `sha256:${createHash("sha256").update(JSON.stringify({
        source,
        integrity,
        skillFiles: [skillFile],
        skillFileDigests: { [skillFile]: digest },
      })).digest("hex")}`;
      const previewId = `skill-preview-${idFactory()}`;
      const preview = {
        schemaVersion: 1,
        previewId,
        previewHash,
        name,
        version: bundled.version,
        source,
        description: bundled.description,
        integrity,
        skillFiles: [skillFile],
        skillFileDigests: { [skillFile]: digest },
        skillCount: 1,
        archiveFileCount: 1,
        archiveBytes: content.length,
        defaultEnabled: false,
        bundled: true,
        expiresAt: new Date(now().getTime() + PREVIEW_TTL_MS).toISOString(),
      };
      previews.set(previewId, preview);
      return structuredClone(preview);
    }
    const registryUrl = `${NPM_REGISTRY_BASE_URL}/${encodeURIComponent(name)}`;
    const metadata = JSON.parse((
      await fetchBuffer(fetchImpl, registryUrl, { maxBytes: MAX_REGISTRY_BYTES })
    ).toString("utf8"));
    const selectedVersion = version || metadata?.["dist-tags"]?.latest;
    const manifest = metadata?.versions?.[selectedVersion];
    const tarballUrl = manifest?.dist?.tarball;
    if (
      !manifest
      || typeof tarballUrl !== "string"
      || !tarballUrl.startsWith(`${NPM_REGISTRY_BASE_URL}/`)
    ) {
      throw projectWorkError(
        "PROJECT_WORK_SKILL_VERSION_NOT_FOUND",
        "Skill 包版本不存在或来源不受支持",
        404,
      );
    }
    const tarball = await fetchBuffer(fetchImpl, tarballUrl, {
      maxBytes: MAX_TARBALL_BYTES,
      timeoutMs: 20_000,
    });
    const inspected = inspectSkillTarball(tarball, {
      expectedName: name,
      expectedVersion: selectedVersion,
      integrity: manifest.dist.integrity,
    });
    const source = `npm:${name}@${selectedVersion}`;
    const previewHash = `sha256:${createHash("sha256").update(JSON.stringify({
      source,
      integrity: inspected.integrity,
      skillFiles: inspected.skillFiles,
      skillFileDigests: inspected.skillFileDigests,
    })).digest("hex")}`;
    const previewId = `skill-preview-${idFactory()}`;
    const preview = {
      schemaVersion: 1,
      previewId,
      previewHash,
      name,
      version: selectedVersion,
      source,
      description: inspected.description,
      integrity: inspected.integrity,
      skillFiles: inspected.skillFiles,
      skillFileDigests: inspected.skillFileDigests,
      skillCount: inspected.skillFiles.length,
      archiveFileCount: inspected.archiveFileCount,
      archiveBytes: inspected.archiveBytes,
      defaultEnabled: false,
      expiresAt: new Date(now().getTime() + PREVIEW_TTL_MS).toISOString(),
    };
    previews.set(previewId, preview);
    return structuredClone(preview);
  }

  async function installPackage({ previewId, previewHash } = {}) {
    return mutate(async () => {
      const preview = previews.get(previewId);
      if (
        !preview
        || preview.previewHash !== previewHash
        || Date.parse(preview.expiresAt) <= now().getTime()
      ) {
        previews.delete(previewId);
        throw projectWorkError(
          "PROJECT_WORK_SKILL_PREVIEW_EXPIRED",
          "Skill 安装预览已失效，请重新检查",
          409,
          true,
        );
      }
      const state = await readState();
      const existing = state.packages.find((item) => item.name === preview.name);
      if (existing?.version === preview.version) {
        previews.delete(previewId);
        if (
          !existing.description
          && typeof preview.description === "string"
          && preview.description
        ) {
          const updated = {
            ...existing,
            description: preview.description,
          };
          await writeState({
            schemaVersion: 1,
            revision: state.revision + 1,
            packages: state.packages.map((item) => (
              item.name === preview.name ? updated : item
            )),
          });
          catalogCache.clear();
          return publicInstalledPackage(updated);
        }
        return publicInstalledPackage(existing);
      }
      let installedPath;
      if (preview.bundled === true) {
        const definition = BUNDLED_SKILL_PACKAGES[preview.name];
        const sourcePath = path.join(
          bundledSkillRoot,
          definition.directory,
          "SKILL.md",
        );
        const content = await readFile(sourcePath);
        const skillFile = preview.skillFiles[0];
        const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
        if (digest !== preview.skillFileDigests?.[skillFile]) {
          throw projectWorkError(
            "PROJECT_WORK_SKILL_INSTALL_INTEGRITY_MISMATCH",
            "内置 Skill 内容在确认后发生了变化，请重新检查",
            409,
            true,
          );
        }
        installedPath = path.join(
          agentDir,
          "bundled",
          definition.directory,
        );
        const targetPath = path.join(installedPath, skillFile);
        await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
        const temporaryPath = `${targetPath}.${idFactory()}.tmp`;
        await writeFile(temporaryPath, content, { mode: 0o600 });
        await rename(temporaryPath, targetPath);
      } else {
        const manager = await getPackageManager();
        await manager.install(preview.source, { local: false });
        installedPath = manager.getInstalledPath(preview.source, "user");
      }
      if (!installedPath) {
        throw projectWorkError(
          "PROJECT_WORK_SKILL_INSTALL_FAILED",
          "Skill 包已下载，但未能确认本机安装位置",
          500,
          true,
        );
      }
      for (const skillFile of preview.skillFiles) {
        const absolutePath = path.resolve(installedPath, skillFile);
        const relative = path.relative(installedPath, absolutePath);
        if (relative.startsWith("..") || path.isAbsolute(relative)) {
          throw projectWorkError(
            "PROJECT_WORK_SKILL_INSTALL_INVALID",
            "Skill 安装路径越界",
            500,
          );
        }
        const installedContent = await readFile(absolutePath);
        const installedDigest = `sha256:${createHash("sha256")
          .update(installedContent)
          .digest("hex")}`;
        if (installedDigest !== preview.skillFileDigests?.[skillFile]) {
          throw projectWorkError(
            "PROJECT_WORK_SKILL_INSTALL_INTEGRITY_MISMATCH",
            "本机安装内容与已确认的 Skill 预览不一致",
            409,
            true,
          );
        }
      }
      const installed = {
        name: preview.name,
        version: preview.version,
        source: preview.source,
        description: preview.description,
        integrity: preview.integrity,
        installedPath,
        skillFiles: [...preview.skillFiles],
        enabled: false,
        installedAt: now().toISOString(),
      };
      const nextState = {
        schemaVersion: 1,
        revision: state.revision + 1,
        packages: [
          ...state.packages.filter((item) => item.name !== preview.name),
          installed,
        ].sort((left, right) => left.name.localeCompare(right.name)),
      };
      await writeState(nextState);
      previews.delete(previewId);
      catalogCache.clear();
      return publicInstalledPackage(installed);
    });
  }

  async function setEnabled(name, enabled) {
    return mutate(async () => {
      const state = await readState();
      const current = state.packages.find((item) => item.name === name);
      if (!current) {
        throw projectWorkError(
          "PROJECT_WORK_SKILL_NOT_INSTALLED",
          "Skill 包尚未安装",
          404,
        );
      }
      const nextEnabled = enabled === true;
      if (current.enabled === nextEnabled) return publicInstalledPackage(current);
      const next = {
        ...current,
        enabled: nextEnabled,
      };
      await writeState({
        schemaVersion: 1,
        revision: state.revision + 1,
        packages: state.packages.map((item) => item.name === name ? next : item),
      });
      catalogCache.clear();
      return publicInstalledPackage(next);
    });
  }

  async function getEnabledSkillPaths() {
    const state = await readState();
    return state.packages.flatMap((item) => (
      item.enabled === true
        ? item.skillFiles.map((skillFile) => path.resolve(item.installedPath, skillFile))
        : []
    ));
  }

  async function getRevision() {
    return (await readState()).revision;
  }

  return Object.freeze({
    getEnabledSkillPaths,
    getRevision,
    inspectPackage,
    installPackage,
    listCatalog,
    listInstalled,
    setEnabled,
  });
}
