import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { workerError } from "./errors.js";

export const WORKER_STORE_SCHEMA_VERSION = 1;

function emptyState() {
  return {
    schemaVersion: WORKER_STORE_SCHEMA_VERSION,
    definitions: {},
    tasks: {},
    drafts: {},
    sources: {},
    files: {},
    proposals: {},
    receipts: {},
  };
}

function validateState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SyntaxError("worker state must be an object");
  }
  if (value.schemaVersion !== WORKER_STORE_SCHEMA_VERSION) {
    throw workerError(
      "WORKER_DATA_VERSION_UNSUPPORTED",
      "Worker 数据版本不受支持，无法安全读取",
      409,
    );
  }
  if (value.sources === undefined) value.sources = {};
  if (value.files === undefined) value.files = {};
  for (const key of ["definitions", "tasks", "drafts", "sources", "files", "proposals", "receipts"]) {
    if (!value[key] || typeof value[key] !== "object" || Array.isArray(value[key])) {
      throw new SyntaxError(`worker state ${key} must be an object`);
    }
  }
  return value;
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

export function createWorkerStore({ storageRoot } = {}) {
  if (typeof storageRoot !== "string" || !storageRoot.trim()) {
    throw new TypeError("storageRoot is required");
  }
  const statePath = path.resolve(storageRoot, "worker", "state.json");
  let queue = Promise.resolve();

  async function readState() {
    try {
      return validateState(JSON.parse(await readFile(statePath, "utf8")));
    } catch (error) {
      if (error?.code === "ENOENT") return emptyState();
      if (error instanceof SyntaxError) {
        throw workerError(
          "WORKER_DATA_CORRUPT",
          "Worker 数据损坏，需要恢复后继续",
          500,
        );
      }
      throw error;
    }
  }

  function withLock(operation) {
    const current = queue.catch(() => undefined).then(operation);
    queue = current;
    return current;
  }

  function transaction(mutator) {
    if (typeof mutator !== "function") {
      throw new TypeError("worker transaction requires a mutator");
    }
    return withLock(async () => {
      const state = structuredClone(await readState());
      const result = await mutator(state);
      validateState(state);
      await writeJsonAtomic(statePath, state);
      return structuredClone(result);
    });
  }

  async function initialize(definitions) {
    return transaction((state) => {
      for (const definition of definitions) {
        state.definitions[definition.id] = structuredClone(definition);
      }
      return state;
    });
  }

  return Object.freeze({
    statePath,
    initialize,
    read: async () => structuredClone(await readState()),
    transaction,
  });
}
