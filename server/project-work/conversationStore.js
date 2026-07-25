import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { projectWorkError } from "./errors.js";

const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;

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
    await writeJsonAtomic(target, state);
    return structuredClone(state);
  }

  async function get(conversationId) {
    const id = assertConversationId(conversationId);
    try {
      return JSON.parse(await readFile(statePath(id), "utf8"));
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

  async function parseEvents(conversationId) {
    let content;
    try {
      content = await readFile(eventsPath(conversationId), "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    return content
      .split(/\r\n|\n|\r/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  async function currentSequence(conversationId) {
    const id = assertConversationId(conversationId);
    if (eventSequences.has(id)) return eventSequences.get(id);
    const events = await parseEvents(id);
    const sequence = events.at(-1)?.seq ?? 0;
    eventSequences.set(id, sequence);
    return sequence;
  }

  function appendEvent(conversationId, event) {
    return withLock(conversationId, async () => {
      await get(conversationId);
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
      eventSequences.set(id, seq);
      return normalized;
    });
  }

  async function readEvents(conversationId, { afterSeq = 0, limit = 500 } = {}) {
    const normalizedAfter = Number.isInteger(afterSeq) && afterSeq >= 0 ? afterSeq : 0;
    const normalizedLimit = Number.isInteger(limit)
      ? Math.min(Math.max(limit, 1), 1_000)
      : 500;
    const events = (await parseEvents(conversationId))
      .filter((event) => event.seq > normalizedAfter);
    return {
      events: events.slice(0, normalizedLimit),
      hasMore: events.length > normalizedLimit,
      lastSeq: await currentSequence(conversationId),
    };
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
    });
  }

  return Object.freeze({
    appendEvent,
    create,
    directory,
    get,
    list,
    readEvents,
    remove,
    update,
  });
}
