import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { projectWorkError } from "./errors.js";

const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const EVENT_INDEX_STRIDE = 64;
const EVENT_READ_CHUNK_BYTES = 64 * 1024;
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
  const eventIndexes = new Map();

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

  async function withEventWatermark(conversationId, state) {
    const persisted = Number.isSafeInteger(state?.lastEventSeq)
      && state.lastEventSeq >= 0
      ? state.lastEventSeq
      : 0;
    const index = await ensureEventIndex(conversationId, { repairTail: true });
    eventSequences.set(conversationId, index.lastSeq);
    return index.exists === true && index.lastSeq !== persisted
      ? { ...state, lastEventSeq: index.lastSeq }
      : state;
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
          workType: value.workType === "worker" ? "worker" : "project_work",
        };
        await writeJsonAtomic(target, migrated);
        return withEventWatermark(id, migrated);
      }
      if (value.workType === undefined) {
        const migrated = { ...value, workType: "project_work" };
        await writeJsonAtomic(target, migrated);
        return withEventWatermark(id, migrated);
      }
      if (!["project_work", "worker"].includes(value.workType)) {
        throw projectWorkError(
          "PROJECT_WORK_CONVERSATION_RECORD_CORRUPT",
          "工作会话记录包含无效工作类型，需要恢复后继续",
          500,
          true,
        );
      }
      return withEventWatermark(id, value);
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

  function parseIndexedEvent(lineBuffer, derivedSequence) {
    const event = JSON.parse(lineBuffer.toString("utf8"));
    const persistedSequence = Number.isSafeInteger(event?.seq)
      && event.seq > derivedSequence
      ? event.seq
      : null;
    const seq = persistedSequence ?? derivedSequence + 1;
    return {
      event: { ...event, seq },
      seq,
    };
  }

  async function buildEventIndex(conversationId, { repairTail = false } = {}) {
    const id = assertConversationId(conversationId);
    const eventFilePath = eventsPath(id);
    let content;
    try {
      content = await readFile(eventFilePath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        const empty = {
          exists: false,
          size: 0,
          mtimeMs: 0,
          lastSeq: 0,
          eventCount: 0,
          checkpoints: [],
        };
        eventIndexes.set(id, empty);
        return empty;
      }
      throw error;
    }
    let derivedSequence = 0;
    let eventCount = 0;
    let lineStart = 0;
    const checkpoints = [];
    const parseLine = (start, end) => {
      if (end <= start) return true;
      try {
        const parsed = parseIndexedEvent(
          content.subarray(start, end),
          derivedSequence,
        );
        derivedSequence = parsed.seq;
        if (eventCount % EVENT_INDEX_STRIDE === 0) {
          checkpoints.push({ seq: parsed.seq, offset: start });
        }
        eventCount += 1;
        return true;
      } catch {
        return false;
      }
    };
    for (let cursor = 0; cursor < content.length; cursor += 1) {
      if (content[cursor] !== 0x0a && content[cursor] !== 0x0d) continue;
      if (!parseLine(lineStart, cursor)) {
        throw projectWorkError(
          "PROJECT_WORK_EVENT_LOG_CORRUPT",
          "工作会话事件记录损坏，需要恢复后继续",
          500,
          true,
        );
      }
      if (
        content[cursor] === 0x0d
        && content[cursor + 1] === 0x0a
      ) {
        cursor += 1;
      }
      lineStart = cursor + 1;
    }
    if (lineStart < content.length) {
      if (parseLine(lineStart, content.length)) {
        if (repairTail) await appendFile(eventFilePath, "\n", "utf8");
      } else if (repairTail) {
        await truncate(eventFilePath, lineStart);
      }
    }
    const indexedStat = await stat(eventFilePath);
    const index = {
      exists: true,
      size: indexedStat.size,
      mtimeMs: indexedStat.mtimeMs,
      lastSeq: derivedSequence,
      eventCount,
      checkpoints,
    };
    eventIndexes.set(id, index);
    return index;
  }

  async function ensureEventIndex(conversationId, { repairTail = false } = {}) {
    const id = assertConversationId(conversationId);
    let fileStat;
    try {
      fileStat = await stat(eventsPath(id));
    } catch (error) {
      if (error?.code === "ENOENT") {
        return buildEventIndex(id, { repairTail });
      }
      throw error;
    }
    const cached = eventIndexes.get(id);
    if (
      cached
      && cached.size === fileStat.size
      && cached.mtimeMs === fileStat.mtimeMs
    ) {
      return cached;
    }
    return buildEventIndex(id, { repairTail });
  }

  async function readIndexedEvents(conversationId, index, {
    afterSeq,
    limit,
  }) {
    if (index.lastSeq <= afterSeq || index.size === 0) return [];
    const checkpoint = [...index.checkpoints]
      .reverse()
      .find((entry) => entry.seq <= afterSeq + 1)
      ?? index.checkpoints[0]
      ?? { seq: 1, offset: 0 };
    let derivedSequence = Math.max(0, checkpoint.seq - 1);
    let position = checkpoint.offset;
    let carry = Buffer.alloc(0);
    const selected = [];
    const file = await open(eventsPath(conversationId), "r");
    const consumeLine = (line) => {
      if (line.length === 0) return;
      let parsed;
      try {
        parsed = parseIndexedEvent(line, derivedSequence);
      } catch {
        throw projectWorkError(
          "PROJECT_WORK_EVENT_LOG_CORRUPT",
          "工作会话事件记录损坏，需要恢复后继续",
          500,
          true,
        );
      }
      derivedSequence = parsed.seq;
      if (parsed.seq > afterSeq) selected.push(parsed.event);
    };
    try {
      while (position < index.size && selected.length <= limit) {
        const byteLength = Math.min(
          EVENT_READ_CHUNK_BYTES,
          index.size - position,
        );
        const chunk = Buffer.allocUnsafe(byteLength);
        const { bytesRead } = await file.read(chunk, 0, byteLength, position);
        if (bytesRead === 0) break;
        position += bytesRead;
        const available = carry.length > 0
          ? Buffer.concat([carry, chunk.subarray(0, bytesRead)])
          : chunk.subarray(0, bytesRead);
        let lineStart = 0;
        for (let cursor = 0; cursor < available.length; cursor += 1) {
          if (available[cursor] !== 0x0a && available[cursor] !== 0x0d) continue;
          consumeLine(available.subarray(lineStart, cursor));
          if (
            available[cursor] === 0x0d
            && available[cursor + 1] === 0x0a
          ) {
            cursor += 1;
          }
          lineStart = cursor + 1;
          if (selected.length > limit) break;
        }
        carry = available.subarray(lineStart);
      }
      if (position >= index.size && carry.length > 0 && selected.length <= limit) {
        consumeLine(carry);
      }
    } finally {
      await file.close();
    }
    return selected;
  }

  async function readIndexedEventsBefore(conversationId, index, {
    beforeSeq,
    limit,
  }) {
    if (index.size === 0 || beforeSeq <= 1) return [];
    const boundaryIndex = index.checkpoints.findIndex(
      (entry) => entry.seq >= beforeSeq,
    );
    const exclusiveBoundary = boundaryIndex === -1
      ? index.checkpoints.length
      : boundaryIndex;
    const checkpointDistance = Math.ceil((limit + 1) / EVENT_INDEX_STRIDE) + 1;
    const startIndex = Math.max(0, exclusiveBoundary - checkpointDistance);
    const checkpoint = index.checkpoints[startIndex]
      ?? { seq: 1, offset: 0 };
    const upperOffset = boundaryIndex === -1
      ? index.size
      : index.checkpoints[boundaryIndex].offset;
    let derivedSequence = Math.max(0, checkpoint.seq - 1);
    let position = checkpoint.offset;
    let carry = Buffer.alloc(0);
    const selected = [];
    const file = await open(eventsPath(conversationId), "r");
    const consumeLine = (line) => {
      if (line.length === 0) return;
      let parsed;
      try {
        parsed = parseIndexedEvent(line, derivedSequence);
      } catch {
        throw projectWorkError(
          "PROJECT_WORK_EVENT_LOG_CORRUPT",
          "工作会话事件记录损坏，需要恢复后继续",
          500,
          true,
        );
      }
      derivedSequence = parsed.seq;
      if (parsed.seq < beforeSeq) selected.push(parsed.event);
    };
    try {
      while (position < upperOffset) {
        const byteLength = Math.min(
          EVENT_READ_CHUNK_BYTES,
          upperOffset - position,
        );
        const chunk = Buffer.allocUnsafe(byteLength);
        const { bytesRead } = await file.read(chunk, 0, byteLength, position);
        if (bytesRead === 0) break;
        position += bytesRead;
        const available = carry.length > 0
          ? Buffer.concat([carry, chunk.subarray(0, bytesRead)])
          : chunk.subarray(0, bytesRead);
        let lineStart = 0;
        for (let cursor = 0; cursor < available.length; cursor += 1) {
          if (available[cursor] !== 0x0a && available[cursor] !== 0x0d) continue;
          consumeLine(available.subarray(lineStart, cursor));
          if (
            available[cursor] === 0x0d
            && available[cursor + 1] === 0x0a
          ) {
            cursor += 1;
          }
          lineStart = cursor + 1;
        }
        carry = available.subarray(lineStart);
      }
      if (position >= upperOffset && carry.length > 0) consumeLine(carry);
    } finally {
      await file.close();
    }
    return selected.slice(-(limit + 1));
  }

  async function currentSequence(conversationId) {
    const id = assertConversationId(conversationId);
    if (eventSequences.has(id)) return eventSequences.get(id);
    const index = await ensureEventIndex(id, { repairTail: true });
    const sequence = index.lastSeq;
    eventSequences.set(id, sequence);
    return sequence;
  }

  function appendEvent(conversationId, event) {
    return withLock(conversationId, async () => {
      const id = assertConversationId(conversationId);
      try {
        await stat(statePath(id));
      } catch (error) {
        if (error?.code === "ENOENT") {
          throw projectWorkError(
            "PROJECT_WORK_CONVERSATION_NOT_FOUND",
            "工作会话不存在",
            404,
          );
        }
        throw error;
      }
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
      const serialized = `${JSON.stringify(normalized)}\n`;
      await appendFile(eventsPath(id), serialized, {
        encoding: "utf8",
        mode: 0o600,
      });
      eventSequences.set(id, seq);
      const currentIndex = eventIndexes.get(id);
      if (currentIndex?.lastSeq === seq - 1) {
        const indexedStat = await stat(eventsPath(id));
        const checkpoints = currentIndex.eventCount % EVENT_INDEX_STRIDE === 0
          ? [
              ...currentIndex.checkpoints,
              { seq, offset: currentIndex.size },
            ]
          : currentIndex.checkpoints;
        eventIndexes.set(id, {
          exists: true,
          size: indexedStat.size,
          mtimeMs: indexedStat.mtimeMs,
          lastSeq: seq,
          eventCount: currentIndex.eventCount + 1,
          checkpoints,
        });
      } else {
        eventIndexes.delete(id);
      }
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
      const index = await ensureEventIndex(id, { repairTail: true });
      const selected = await readIndexedEvents(id, index, {
        afterSeq: normalizedAfter,
        limit: normalizedLimit,
      });
      const sequence = index.lastSeq;
      eventSequences.set(id, sequence);
      return {
        events: selected.slice(0, normalizedLimit),
        hasMore: selected.length > normalizedLimit,
        lastSeq: sequence,
      };
    });
  }

  function readEventsBefore(conversationId, {
    beforeSeq,
    limit = 500,
  } = {}) {
    const normalizedLimit = Number.isInteger(limit)
      ? Math.min(Math.max(limit, 1), 1_000)
      : 500;
    return withLock(conversationId, async () => {
      const id = assertConversationId(conversationId);
      const index = await ensureEventIndex(id, { repairTail: true });
      const normalizedBefore = Number.isSafeInteger(beforeSeq) && beforeSeq > 0
        ? beforeSeq
        : index.lastSeq + 1;
      const selected = await readIndexedEventsBefore(id, index, {
        beforeSeq: normalizedBefore,
        limit: normalizedLimit,
      });
      const events = selected.slice(-normalizedLimit);
      const firstSeq = index.checkpoints[0]?.seq ?? 0;
      const hasMore = events.length > 0 && events[0].seq > firstSeq;
      eventSequences.set(id, index.lastSeq);
      return {
        events,
        hasMore,
        nextBeforeSeq: hasMore ? events[0].seq : null,
        lastSeq: index.lastSeq,
      };
    });
  }

  function readAllEvents(conversationId) {
    return withLock(conversationId, async () => {
      const id = assertConversationId(conversationId);
      const index = await ensureEventIndex(id, { repairTail: true });
      const events = [];
      let afterSeq = 0;
      while (afterSeq < index.lastSeq) {
        const page = await readIndexedEvents(id, index, {
          afterSeq,
          limit: 1_000,
        });
        if (page.length === 0) break;
        const selected = page.slice(0, 1_000);
        events.push(...selected);
        afterSeq = selected.at(-1).seq;
        if (page.length <= 1_000) break;
      }
      const sequence = index.lastSeq;
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
      eventIndexes.delete(id);
    });
  }

  return Object.freeze({
    appendEvent,
    create,
    directory,
    get,
    list,
    readAllEvents,
    readEventsBefore,
    readEvents,
    remove,
    subscribe,
    update,
  });
}
