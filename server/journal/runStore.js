import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const RUN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/;
const PROJECT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/;

export const DEFAULT_JOURNAL_PROJECT_ID = "pi-agent-product";

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
  const updateQueues = new Map();

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
  } = {}) {
    if (typeof projectId !== "string" || !PROJECT_ID_PATTERN.test(projectId)) {
      throw new Error("projectId contains unsupported characters");
    }
    const createdAt = now().toISOString();
    const runId = `journal-${createdAt.replaceAll(/[:.]/g, "-")}-${idFactory().slice(0, 8)}`;
    const run = {
      schema_version: 1,
      run_id: runId,
      project_id: projectId,
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

  async function getRun(runId) {
    try {
      return await readJson(path.join(runDir(runId), "run.json"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
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

  async function appendEvent(runId, event) {
    const directory = runDir(runId);
    await mkdir(directory, { recursive: true });
    await appendFile(
      path.join(directory, "events.jsonl"),
      `${JSON.stringify({ ...event, run_id: runId })}\n`,
      "utf8",
    );
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
    getRun,
    listRuns,
    readArtifact,
    readBinaryArtifact,
    updateRun,
    writeArtifact,
    writeBinaryArtifact,
  };
}
