import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { projectWorkError } from "./errors.js";

const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;

function assertProjectId(projectId) {
  if (typeof projectId !== "string" || !PROJECT_ID_PATTERN.test(projectId)) {
    throw projectWorkError("PROJECT_WORK_PROJECT_ID_INVALID", "项目标识无效", 400);
  }
  return projectId;
}

function compactName(value, fallback) {
  const result = String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replaceAll(/\s+/g, " ")
    .slice(0, 120);
  return result || fallback;
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporaryPath, filePath);
}

export function publicProject(project, conversationCount = 0) {
  return {
    id: project.id,
    name: project.name,
    rootLabel: project.rootLabel,
    conversationCount,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

export function createProjectRegistry({
  storageRoot,
  now = () => new Date(),
  idFactory = randomUUID,
} = {}) {
  if (typeof storageRoot !== "string" || !storageRoot.trim()) {
    throw new Error("storageRoot is required");
  }
  const registryPath = path.resolve(storageRoot, "projects.json");
  let writeQueue = Promise.resolve();

  async function load() {
    const registry = await readJson(registryPath, {
      schemaVersion: 1,
      projects: [],
    });
    if (!registry || registry.schemaVersion !== 1 || !Array.isArray(registry.projects)) {
      throw projectWorkError(
        "PROJECT_WORK_REGISTRY_INVALID",
        "项目注册表格式无效",
        500,
      );
    }
    return registry;
  }

  function withWriteLock(operation) {
    const current = writeQueue.catch(() => undefined).then(operation);
    writeQueue = current;
    return current;
  }

  async function inspectRoot(rootPath) {
    if (typeof rootPath !== "string" || !path.isAbsolute(rootPath)) {
      throw projectWorkError(
        "PROJECT_WORK_ROOT_INVALID",
        "项目文件夹选择结果无效",
        400,
      );
    }
    let canonicalRoot;
    let rootStat;
    try {
      [canonicalRoot, rootStat] = await Promise.all([
        realpath(rootPath),
        lstat(rootPath),
      ]);
    } catch {
      throw projectWorkError(
        "PROJECT_WORK_ROOT_NOT_FOUND",
        "所选项目文件夹不存在",
        404,
      );
    }
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw projectWorkError(
        "PROJECT_WORK_ROOT_INVALID",
        "项目根目录必须是普通文件夹",
        400,
      );
    }
    return canonicalRoot;
  }

  async function register({ rootPath, name } = {}) {
    const canonicalRoot = await inspectRoot(rootPath);
    return withWriteLock(async () => {
      const registry = await load();
      const existing = registry.projects.find((project) => project.rootPath === canonicalRoot);
      if (existing) {
        if (name) {
          existing.name = compactName(name, existing.name);
          existing.updatedAt = now().toISOString();
          await writeJsonAtomic(registryPath, registry);
        }
        return structuredClone(existing);
      }
      const createdAt = now().toISOString();
      const rootLabel = path.basename(canonicalRoot) || "本地项目";
      const project = {
        id: `project-${idFactory()}`,
        name: compactName(name, rootLabel),
        rootLabel,
        rootPath: canonicalRoot,
        createdAt,
        updatedAt: createdAt,
      };
      registry.projects.push(project);
      await writeJsonAtomic(registryPath, registry);
      return structuredClone(project);
    });
  }

  async function get(projectId) {
    const id = assertProjectId(projectId);
    const registry = await load();
    const project = registry.projects.find((item) => item.id === id);
    if (!project) {
      throw projectWorkError("PROJECT_WORK_PROJECT_NOT_FOUND", "项目不存在", 404);
    }
    return structuredClone(project);
  }

  async function list() {
    const registry = await load();
    return registry.projects
      .map((project) => structuredClone(project))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  function remove(projectId) {
    const id = assertProjectId(projectId);
    return withWriteLock(async () => {
      const registry = await load();
      const index = registry.projects.findIndex((project) => project.id === id);
      if (index < 0) {
        throw projectWorkError("PROJECT_WORK_PROJECT_NOT_FOUND", "项目不存在", 404);
      }
      const [removed] = registry.projects.splice(index, 1);
      await writeJsonAtomic(registryPath, registry);
      return structuredClone(removed);
    });
  }

  return Object.freeze({
    get,
    list,
    register,
    remove,
  });
}
