import { homedir } from "node:os";
import path from "node:path";

export function resolveProjectWorkStorageRoot(env = process.env) {
  const configured = String(env?.PI_PROJECT_WORK_STORAGE_ROOT ?? "").trim();
  if (configured) return path.resolve(configured);
  return process.platform === "darwin"
    ? path.join(homedir(), "Library", "Application Support", "Pi Agent", "project-work")
    : path.join(homedir(), ".local", "share", "pi-agent", "project-work");
}

export function resolveProjectWorkDoubaoQuotaFilePath({
  env = process.env,
  storageRoot = null,
} = {}) {
  const root = storageRoot
    ? path.resolve(storageRoot)
    : resolveProjectWorkStorageRoot(env);
  return path.join(root, "external-retrieval-usage.json");
}

export function resolveProjectWorkTavilyQuotaFilePath({
  env = process.env,
  storageRoot = null,
} = {}) {
  const root = storageRoot
    ? path.resolve(storageRoot)
    : resolveProjectWorkStorageRoot(env);
  return path.join(root, "external-retrieval-tavily-usage.json");
}
