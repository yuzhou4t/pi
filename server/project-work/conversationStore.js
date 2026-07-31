import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { projectWorkError } from "./errors.js";

const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
export const CONVERSATION_RECORD_SCHEMA_VERSION = 1;

function assertConversationId(conversationId) {
  if (
    typeof conversationId !== "string"
    || !CONVERSATION_ID_PATTERN.test(conversationId)
  ) {
    throw projectWorkError(
      "PROJECT_WORK_CONVERSATION_ID_INVALID",
      "工作会话标识无效",
      400,
    );
  }
  return conversationId;
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

export function createConversationStore({ storageRoot } = {}) {
  if (typeof storageRoot !== "string" || !storageRoot.trim()) {
    throw new Error("storageRoot is required");
  }
  const conversationsRoot = path.resolve(storageRoot, "conversations");
  const queues = new Map();
  const eventSequences = new Map();
  const eventListeners = new Map();

  function directory(conversationId) {
    const id = assertConversationId(conversationId);
    const result = path.resolve(conversationsRoot, id);
    const relative = path.relative(conversationsRoot, result);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw projectWorkError(
        "PROJECT_WORK_CONVERSATION_ID_INVALID",
        "工作会话标识无效",
        400,
      );
    }
    return result;
  }

  function statePath(conversationId) {
    return path.join(directory(conversationId), "conversation.json");
  }

  function eventsPath(conversationId) {
    return path.join(directory(conversationId), "events.jsonl");
  }

  function withLock(conversationId, operation) {
    const id = assertConversationId(conversationId);
    const previous = queues.get(id) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    queues.set(id, current);
    return current.finally(() => {
      if (queues.get(id) === current) queues.delete(id);
    });
  }

  async function create(state) {
    const id = assertConversationId(state?.id);
    const target = statePath(id);
    try {
      await readFile(target);
      throw projectWorkError(
        "PROJECT_WORK_CONVERSATION_EXISTS",
        "工作会话已经存在",
      );
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const next = {
      ...state,
      schemaVersion: CONVERSATION_RECORD_SCHEMA_VERSION,
    };
    await writeJsonAtomic(target, next);
    return structuredClone(next);
  }

  async function get(conversationId) {
    const id = assertConversationId(conversationId);
    try {
      const target = statePath(id);
      const value = JSON.parse(await readFile(target, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new SyntaxError("conversation record must be an object");
      }
      const version = value.schemaVersion;
      if (
        version !== undefined
        && version !== 0
        && version !== CONVERSATION_RECORD_SCHEMA_VERSION
      ) {
        throw projectWorkError(
          "PROJECT_WORK_DATA_VERSION_UNSUPPORTED",
          "工作会话数据版本高于当前应用，无法安全读取",
          409,
        );
      }
      if (version === undefined || version === 0) {
        const migrated = {
          ...value,
          schemaVersion: CONVERSATION_RECORD_SCHEMA_VERSION,
        };
        await writeJsonAtomic(target, migrated);
        return migrated;
      }
      return value;
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw projectWorkError(
          "PROJECT_WORK_CONVERSATION_NOT_FOUND",
          "工作会话不存在",
          404,
        );
      }
      if (error instanceof SyntaxError) {
        throw projectWorkError(
          "PROJECT_WORK_CONVERSATION_RECORD_CORRUPT",
          "工作会话记录损坏，需要恢复后继续",
          500,
          true,
        );
      }
      throw error;
    }
  }

  function update(conversationId, updater) {
    return withLock(conversationId, async () => {
      const current = await get(conversationId);
      const patch = typeof updater === "function"
        ? await updater(structuredClone(current))
        : updater;
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
        throw new Error("conversation update must be an object");
      }
      const next = {
        ...current,
        ...patch,
        id: current.id,
        projectId: current.projectId,
        createdAt: current.createdAt,
      };
      await writeJsonAtomic(statePath(conversationId), next);
      return structuredClone(next);
    });
  }

  async function parseEvents(conversationId, { repairTail = false } = {}) {
    let content;
    try {
      content = await readFile(eventsPath(conversationId), "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const eventFilePath = eventsPath(conversationId);
    const lastNewlineIndex = Math.max(
      content.lastIndexOf("\n"),
      content.lastIndexOf("\r"),
    );
    const hasTerminatingNewline = /[\r\n]$/.test(content);
    const committedContent = hasTerminatingNewline
      ? content
      : lastNewlineIndex >= 0
        ? content.slice(0, lastNewlineIndex + 1)
        : "";
    const tail = hasTerminatingNewline
      ? ""
      : content.slice(lastNewlineIndex + 1);
    let derivedSequence = 0;
    const events = [];
    const parseLine = (line) => {
      try {
        const event = JSON.parse(line);
        const persistedSequence = Number.isSafeInteger(event?.seq)
          && event.seq > derivedSequence
          ? event.seq
          : null;
        derivedSequence = persistedSequence ?? derivedSequence + 1;
        events.push({
          ...event,
          seq: derivedSequence,
        });
        return true;
      } catch {
        return false;
      }
    };
    for (const line of committedContent.split(/\r\n|\n|\r/).filter(Boolean)) {
      if (!parseLine(line)) {
        throw projectWorkError(
          "PROJECT_WORK_EVENT_LOG_CORRUPT",
          "工作会话事件记录损坏，需要恢复后继续",
          500,
          true,
        );
      }
    }
    if (tail) {
      if (parseLine(tail)) {
        if (repairTail) await appendFile(eventFilePath, "\n", "utf8");
      } else if (repairTail) {
        await truncate(
          eventFilePath,
          Buffer.byteLength(committedContent, "utf8"),
        );
      }
    }
    return events;
  }

  async function currentSequence(conversationId) {
    const id = assertConversationId(conversationId);
    if (eventSequences.has(id)) return eventSequences.get(id);
    const events = await parseEvents(id, { repairTail: true });
    const sequence = events.at(-1)?.seq ?? 0;
    eventSequences.set(id, sequence);
    return sequence;
  }

  function appendEvent(conversationId, event) {
    return withLock(conversationId, async () => {
      const currentState = await get(conversationId);
      const id = assertConversationId(conversationId);
      const seq = (await currentSequence(id)) + 1;
      const normalized = {
        seq,
        type: event.type,
        at: event.at,
        data: event.data && typeof event.data === "object"
          ? structuredClone(event.data)
          : {},
      };
      await mkdir(directory(id), { recursive: true });
      await appendFile(eventsPath(id), `${JSON.stringify(normalized)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await writeJsonAtomic(statePath(id), {
        ...currentState,
        lastEventSeq: seq,
        updatedAt: normalized.at ?? currentState.updatedAt,
      });
      eventSequences.set(id, seq);
      for (const listener of eventListeners.get(id) ?? []) {
        try {
          Promise.resolve(listener(structuredClone(normalized)))
            .catch(() => undefined);
        } catch {
          // A disconnected subscriber must not make the durable append fail.
        }
      }
      return normalized;
    });
  }

  function subscribe(conversationId, listener) {
    const id = assertConversationId(conversationId);
    if (typeof listener !== "function") {
      throw new TypeError("conversation event listener must be a function");
    }
    const listeners = eventListeners.get(id) ?? new Set();
    listeners.add(listener);
    eventListeners.set(id, listeners);
    return () => {
      const current = eventListeners.get(id);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) eventListeners.delete(id);
    };
  }

  function readEvents(conversationId, { afterSeq = 0, limit = 500 } = {}) {
    const normalizedAfter = Number.isInteger(afterSeq) && afterSeq >= 0 ? afterSeq : 0;
    const normalizedLimit = Number.isInteger(limit)
      ? Math.min(Math.max(limit, 1), 1_000)
      : 500;
    return withLock(conversationId, async () => {
      const id = assertConversationId(conversationId);
      const allEvents = await parseEvents(id, { repairTail: true });
      const sequence = allEvents.at(-1)?.seq ?? 0;
      eventSequences.set(id, sequence);
      const events = allEvents.filter((event) => event.seq > normalizedAfter);
      return {
        events: events.slice(0, normalizedLimit),
        hasMore: events.length > normalizedLimit,
        lastSeq: sequence,
      };
    });
  }

  function readAllEvents(conversationId) {
    return withLock(conversationId, async () => {
      const id = assertConversationId(conversationId);
      const events = await parseEvents(id, { repairTail: true });
      const sequence = events.at(-1)?.seq ?? 0;
      eventSequences.set(id, sequence);
      return events;
    });
  }

  async function list(projectId) {
    let entries;
    try {
      entries = await readdir(conversationsRoot, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const conversations = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && CONVERSATION_ID_PATTERN.test(entry.name))
        .map(async (entry) => {
          try {
            return await get(entry.name);
          } catch (error) {
            if (error?.code === "PROJECT_WORK_CONVERSATION_NOT_FOUND") return null;
            throw error;
          }
        }),
    );
    return conversations
      .filter((conversation) => (
        conversation
        && (projectId === undefined || conversation.projectId === projectId)
      ))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  function remove(conversationId) {
    return withLock(conversationId, async () => {
      const id = assertConversationId(conversationId);
      await get(id);
      await rm(directory(id), { recursive: true, force: false });
      eventSequences.delete(id);
      eventListeners.delete(id);
    });
  }

  return Object.freeze({
    appendEvent,
    create,
    directory,
    get,
    list,
    readAllEvents,
    readEvents,
    remove,
    subscribe,
    update,
  });
}
