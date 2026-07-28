import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const RUN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/;
const PROJECT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/;
const TERMINAL_RUN_STATUSES = new Set([
  "abandoned",
  "committed",
  "complete",
  "failed",
  "stopped",
]);
const CREATION_LOCK_RETRY_MS = 5;
const CREATION_LOCK_ATTEMPTS = 400;
const CREATION_LOCK_STALE_MS = 30_000;

export const DEFAULT_JOURNAL_PROJECT_ID = "pi-agent-product";
export const JOURNAL_RUN_SCHEMA_VERSION = 1;

function emptyJournalMutationLedger() {
  return {
    schema_version: 1,
    entries: {},
  };
}

function normalizeJournalMutationLedger(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return emptyJournalMutationLedger();
  }
  return {
    schema_version: 1,
    entries: value.entries
      && typeof value.entries === "object"
      && !Array.isArray(value.entries)
      ? structuredClone(value.entries)
      : {},
  };
}

export function journalWeekWindowKey(value) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid journal week date");
  const day = date.getUTCDay();
  const daysSinceMonday = (day + 6) % 7;
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  return date.toISOString().slice(0, 10);
}

function assertRunId(runId) {
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) {
    throw new Error("runId contains unsupported characters");
  }
  return runId;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

export function createRunStore({ dataDir, now = () => new Date(), idFactory = randomUUID } = {}) {
  if (typeof dataDir !== "string" || dataDir.trim().length === 0) {
    throw new Error("dataDir is required");
  }
  const runsDir = path.resolve(dataDir, "runs");
  const creationLockPath = path.resolve(runsDir, ".create.lock");
  const updateQueues = new Map();
  const eventQueues = new Map();
  const eventSequences = new Map();
  const eventEmitter = new EventEmitter();
  eventEmitter.setMaxListeners(100);
  let creationQueue = Promise.resolve();

  async function withCreationLock(task) {
    await mkdir(runsDir, { recursive: true });
    let handle;
    for (let attempt = 0; attempt < CREATION_LOCK_ATTEMPTS; attempt += 1) {
      try {
        handle = await open(creationLockPath, "wx");
        break;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        try {
          const lockStat = await stat(creationLockPath);
          if (Date.now() - lockStat.mtimeMs > CREATION_LOCK_STALE_MS) {
            await unlink(creationLockPath);
            continue;
          }
        } catch (lockError) {
          if (lockError?.code === "ENOENT") continue;
          throw lockError;
        }
        await new Promise((resolve) => setTimeout(resolve, CREATION_LOCK_RETRY_MS));
      }
    }
    if (!handle) {
      const error = new Error("Journal run creation lock is busy");
      error.code = "JOURNAL_RUN_LOCK_BUSY";
      error.retryable = true;
      throw error;
    }
    try {
      return await task();
    } finally {
      await handle.close();
      await unlink(creationLockPath).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
  }

  function runDir(runId) {
    const directory = path.resolve(runsDir, assertRunId(runId));
    const relative = path.relative(runsDir, directory);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("runId must stay inside the runs directory");
    }
    return directory;
  }

  function artifactPath(runId, relativePath) {
    if (typeof relativePath !== "string" || !relativePath) {
      throw new Error("artifact path must stay inside the run");
    }
    const normalized = path.posix.normalize(relativePath);
    if (
      normalized.startsWith("../")
      || normalized.includes("/../")
      || path.posix.isAbsolute(normalized)
    ) {
      throw new Error("artifact path must stay inside the run");
    }
    return path.join(runDir(runId), ...normalized.split("/"));
  }

  async function createRun({
    workflowId = "journal-reading-v1",
    trigger = "manual",
    sourceIds = [],
    projectId = DEFAULT_JOURNAL_PROJECT_ID,
    windowKey,
  } = {}) {
    if (typeof projectId !== "string" || !PROJECT_ID_PATTERN.test(projectId)) {
      throw new Error("projectId contains unsupported characters");
    }
    const createdAt = now().toISOString();
    const resolvedWindowKey = windowKey || journalWeekWindowKey(createdAt);
    const runId = `journal-${createdAt.replaceAll(/[:.]/g, "-")}-${idFactory().slice(0, 8)}`;
    const run = {
      schema_version: JOURNAL_RUN_SCHEMA_VERSION,
      run_id: runId,
      project_id: projectId,
      window_key: resolvedWindowKey,
      workflow_id: workflowId,
      trigger,
      status: "scanning",
      phase: "source_scan",
      source_ids: [...sourceIds],
      scan_summary: null,
      candidates: [],
      mineru: {
        status: "not_started",
        batch_id: null,
        papers: {},
      },
      guides: {
        status: "not_started",
        requested_paper_ids: [],
        provider_id: null,
        model_id: null,
        papers: {},
      },
      paper_decisions: {},
      readings: {
        schema_version: 1,
        status: "not_started",
        paper_ids: [],
        provider_id: null,
        model_id: null,
        papers: {},
        last_error: null,
      },
      journal_mutations: emptyJournalMutationLedger(),
      zotero: {
        status: "not_started",
        target: null,
        decisions: {},
        proposal_id: null,
        proposal_hash: null,
        artifact_path: null,
        proposals: [],
        approval: null,
        last_error: null,
      },
      created_at: createdAt,
      updated_at: createdAt,
    };
    await writeJsonAtomic(path.join(runDir(runId), "run.json"), run);
    await appendEvent(runId, {
      type: "run_created",
      status: run.status,
      phase: run.phase,
      at: createdAt,
    });
    return run;
  }

  function createOrReuseActiveRun(options = {}) {
    const projectId = options.projectId ?? DEFAULT_JOURNAL_PROJECT_ID;
    const windowKey = options.windowKey || journalWeekWindowKey(now());
    const previous = creationQueue;
    const operation = previous
      .catch(() => undefined)
      .then(() => withCreationLock(async () => {
        const runs = await listRuns();
        const active = runs.find((run) => (
          run.project_id === projectId
          && (run.window_key || journalWeekWindowKey(run.created_at)) === windowKey
          && !TERMINAL_RUN_STATUSES.has(run.status)
        ));
        if (active) return { run: active, created: false };
        return {
          run: await createRun({
            ...options,
            projectId,
            windowKey,
          }),
          created: true,
        };
      }));
    creationQueue = operation;
    return operation.finally(() => {
      if (creationQueue === operation) creationQueue = Promise.resolve();
    });
  }

  async function parseEvents(runId, { repairTail = false } = {}) {
    try {
      const eventPath = path.join(runDir(runId), "events.jsonl");
      const content = await readFile(eventPath, "utf8");
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
      let sequence = 0;
      const events = [];
      const parseLine = (line) => {
        try {
          const event = JSON.parse(line);
          const persisted = Number(event.seq);
          sequence = Number.isSafeInteger(persisted) && persisted > sequence
            ? persisted
            : sequence + 1;
          events.push({ ...event, seq: sequence });
          return true;
        } catch {
          return false;
        }
      };
      for (const line of committedContent.split(/\r\n|\n|\r/).filter(Boolean)) {
        if (!parseLine(line)) {
          const error = new Error(
            "Journal event log is corrupt and requires recovery",
          );
          error.code = "JOURNAL_EVENT_LOG_CORRUPT";
          error.retryable = true;
          throw error;
        }
      }
      if (tail) {
        if (parseLine(tail)) {
          if (repairTail) await appendFile(eventPath, "\n", "utf8");
        } else if (repairTail) {
          await truncate(
            eventPath,
            Buffer.byteLength(committedContent, "utf8"),
          );
        }
      }
      return events;
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }

  async function currentEventSequence(runId) {
    const id = assertRunId(runId);
    if (eventSequences.has(id)) return eventSequences.get(id);
    const events = await parseEvents(id, { repairTail: true });
    const sequence = events.at(-1)?.seq ?? 0;
    eventSequences.set(id, sequence);
    return sequence;
  }

  function withEventQueue(runId, task) {
    const id = assertRunId(runId);
    const previous = eventQueues.get(id) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(() => task(id));
    eventQueues.set(id, operation);
    return operation.finally(() => {
      if (eventQueues.get(id) === operation) eventQueues.delete(id);
    });
  }

  async function getRun(runId) {
    const id = assertRunId(runId);
    return withEventQueue(id, async () => {
      try {
        const run = await readJson(path.join(runDir(id), "run.json"));
        const version = run?.schema_version;
        if (!run || typeof run !== "object" || Array.isArray(run)) {
          const error = new Error("Journal run record must be an object");
          error.code = "JOURNAL_RUN_RECORD_CORRUPT";
          error.retryable = true;
          throw error;
        }
        if (
          version !== undefined
          && version !== 0
          && version !== JOURNAL_RUN_SCHEMA_VERSION
        ) {
          const error = new Error(
            "Journal run data version is newer than this application",
          );
          error.code = "JOURNAL_RUN_DATA_VERSION_UNSUPPORTED";
          error.retryable = false;
          throw error;
        }
        const migratedRun = version === undefined || version === 0
          ? {
              ...run,
              schema_version: JOURNAL_RUN_SCHEMA_VERSION,
            }
          : run;
        if (version === undefined || version === 0) {
          await writeJsonAtomic(path.join(runDir(id), "run.json"), migratedRun);
        }
        const events = await parseEvents(id, { repairTail: true });
        const watermark = events.at(-1)?.seq ?? 0;
        eventSequences.set(id, watermark);
        return {
          ...migratedRun,
          journal_mutations: normalizeJournalMutationLedger(
            run.journal_mutations,
          ),
          snapshot_watermark: watermark,
          last_event_seq: watermark,
        };
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        if (error instanceof SyntaxError) {
          const corrupt = new Error(
            "Journal run record is corrupt and requires recovery",
          );
          corrupt.code = "JOURNAL_RUN_RECORD_CORRUPT";
          corrupt.retryable = true;
          throw corrupt;
        }
        throw error;
      }
    });
  }

  async function updateRunUnlocked(runId, update) {
    const current = await getRun(runId);
    if (!current) throw new Error(`Unknown run: ${runId}`);
    const patch = typeof update === "function" ? await update(structuredClone(current)) : update;
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new Error("run update must be an object");
    }
    const next = {
      ...current,
      ...patch,
      run_id: current.run_id,
      created_at: current.created_at,
      updated_at: now().toISOString(),
    };
    await writeJsonAtomic(path.join(runDir(runId), "run.json"), next);
    return next;
  }

  function updateRun(runId, update) {
    const id = assertRunId(runId);
    const previous = updateQueues.get(id) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => updateRunUnlocked(id, update));
    updateQueues.set(id, current);
    return current.finally(() => {
      if (updateQueues.get(id) === current) updateQueues.delete(id);
    });
  }

  function appendEvent(runId, event) {
    const id = assertRunId(runId);
    return withEventQueue(id, async () => {
      const directory = runDir(id);
      await mkdir(directory, { recursive: true });
      const normalized = {
        ...event,
        run_id: id,
        seq: (await currentEventSequence(id)) + 1,
      };
      await appendFile(
        path.join(directory, "events.jsonl"),
        `${JSON.stringify(normalized)}\n`,
        "utf8",
      );
      eventSequences.set(id, normalized.seq);
      eventEmitter.emit(id, structuredClone(normalized));
      return normalized;
    });
  }

  function readEvents(runId, { afterSeq = 0, limit = 500 } = {}) {
    const id = assertRunId(runId);
    const normalizedAfter = Number.isSafeInteger(afterSeq) && afterSeq >= 0
      ? afterSeq
      : 0;
    const normalizedLimit = Number.isSafeInteger(limit)
      ? Math.min(Math.max(limit, 1), 1_000)
      : 500;
    return withEventQueue(id, async () => {
      const allEvents = await parseEvents(id, { repairTail: true });
      const lastSeq = allEvents.at(-1)?.seq ?? 0;
      eventSequences.set(id, lastSeq);
      const events = allEvents.filter((event) => event.seq > normalizedAfter);
      return {
        events: events.slice(0, normalizedLimit),
        hasMore: events.length > normalizedLimit,
        lastSeq,
      };
    });
  }

  function subscribeEvents(runId, listener) {
    const id = assertRunId(runId);
    if (typeof listener !== "function") {
      throw new TypeError("listener must be a function");
    }
    eventEmitter.on(id, listener);
    return () => eventEmitter.off(id, listener);
  }

  async function writeArtifact(runId, relativePath, value) {
    const filePath = artifactPath(runId, relativePath);
    const extension = path.extname(filePath).toLowerCase();
    if (extension === ".json") await writeJsonAtomic(filePath, value);
    else {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, String(value), "utf8");
    }
    return filePath;
  }

  async function writeBinaryArtifact(runId, relativePath, value) {
    if (!(value instanceof Uint8Array)) throw new Error("binary artifact must be Uint8Array");
    const filePath = artifactPath(runId, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, value);
    return filePath;
  }

  async function readArtifact(runId, relativePath) {
    const filePath = artifactPath(runId, relativePath);
    return path.extname(filePath).toLowerCase() === ".json"
      ? readJson(filePath)
      : readFile(filePath, "utf8");
  }

  async function readBinaryArtifact(runId, relativePath) {
    return readFile(artifactPath(runId, relativePath));
  }

  async function listRuns() {
    let entries;
    try {
      entries = await readdir(runsDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const runs = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && RUN_ID_PATTERN.test(entry.name))
        .map((entry) => getRun(entry.name)),
    );
    return runs.filter(Boolean).sort((left, right) => right.created_at.localeCompare(left.created_at));
  }

  return {
    appendEvent,
    createRun,
    createOrReuseActiveRun,
    getRun,
    listRuns,
    readArtifact,
    readBinaryArtifact,
    readEvents,
    subscribeEvents,
    updateRun,
    writeArtifact,
    writeBinaryArtifact,
  };
}
