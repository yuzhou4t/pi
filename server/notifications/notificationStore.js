import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { NOTIFICATION_SCHEMA_VERSION, notificationError } from "./contract.js";

function emptyState() {
  return {
    schemaVersion: NOTIFICATION_SCHEMA_VERSION,
    subscriptions: [],
    outbox: [],
  };
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

export function createNotificationStore({ storageRoot } = {}) {
  if (typeof storageRoot !== "string" || !storageRoot.trim()) {
    throw new TypeError("storageRoot is required");
  }
  const root = path.resolve(storageRoot, "notifications");
  const statePath = path.join(root, "state.json");
  const ledgerPath = path.join(root, "ledger.jsonl");
  let queue = Promise.resolve();

  async function readState() {
    try {
      const parsed = JSON.parse(await readFile(statePath, "utf8"));
      if (
        !parsed
        || typeof parsed !== "object"
        || Array.isArray(parsed)
        || parsed.schemaVersion !== NOTIFICATION_SCHEMA_VERSION
        || !Array.isArray(parsed.subscriptions)
        || !Array.isArray(parsed.outbox)
      ) {
        throw new Error("unsupported notification state");
      }
      return parsed;
    } catch (error) {
      if (error?.code === "ENOENT") return emptyState();
      throw notificationError(
        "NOTIFICATION_STATE_CORRUPT",
        "提醒状态记录损坏，需要恢复后继续",
      );
    }
  }

  function withLock(operation) {
    const current = queue.catch(() => undefined).then(operation);
    queue = current;
    return current;
  }

  function transaction(operation) {
    return withLock(async () => {
      const state = await readState();
      const result = await operation(state);
      await writeJsonAtomic(statePath, state);
      return structuredClone(result);
    });
  }

  function snapshot() {
    return withLock(async () => structuredClone(await readState()));
  }

  function appendLedger(record) {
    return withLock(async () => {
      await mkdir(root, { recursive: true });
      await appendFile(ledgerPath, `${JSON.stringify(record)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      return structuredClone(record);
    });
  }

  function readLedger() {
    return withLock(async () => {
      try {
        const content = await readFile(ledgerPath, "utf8");
        return content
          .split(/\r?\n/u)
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      } catch (error) {
        if (error?.code === "ENOENT") return [];
        throw notificationError(
          "NOTIFICATION_LEDGER_CORRUPT",
          "提醒投递记录损坏，需要恢复后继续",
        );
      }
    });
  }

  return Object.freeze({
    paths: Object.freeze({ root, statePath, ledgerPath }),
    snapshot,
    transaction,
    appendLedger,
    readLedger,
  });
}
