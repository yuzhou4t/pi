import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const SCHEMA_VERSION = 1;
const MAX_ENTRIES = 500;

function compact(value, maxLength = 300) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

// 「不感兴趣」是跨 Run 的持久决定：被标记的论文不再进入往期未读回补和近年经典栏目。
export function createDismissedPapersStore({
  dataDir,
  now = () => new Date(),
} = {}) {
  if (typeof dataDir !== "string" || !dataDir.trim()) {
    throw new TypeError("dataDir is required");
  }
  const filePath = path.resolve(dataDir, "journal", "dismissed-papers.json");
  let queue = Promise.resolve();

  async function readState() {
    try {
      const state = JSON.parse(await readFile(filePath, "utf8"));
      if (state?.schema_version !== SCHEMA_VERSION || !Array.isArray(state.papers)) {
        return { schema_version: SCHEMA_VERSION, papers: [] };
      }
      return state;
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) {
        return { schema_version: SCHEMA_VERSION, papers: [] };
      }
      throw error;
    }
  }

  async function writeState(state) {
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, filePath);
  }

  function enqueue(operation) {
    const next = queue.catch(() => undefined).then(operation);
    queue = next;
    return next;
  }

  async function list() {
    const state = await readState();
    return state.papers.map((paper) => ({ ...paper }));
  }

  async function listKeys() {
    const state = await readState();
    return state.papers.map((paper) => paper.dedupe_key);
  }

  function dismiss({ dedupeKey, title = "" } = {}) {
    const key = compact(dedupeKey, 400);
    if (!key) throw new TypeError("dedupeKey is required");
    return enqueue(async () => {
      const state = await readState();
      if (!state.papers.some((paper) => paper.dedupe_key === key)) {
        state.papers.push({
          dedupe_key: key,
          title: compact(title),
          dismissed_at: now().toISOString(),
        });
        if (state.papers.length > MAX_ENTRIES) {
          state.papers = state.papers.slice(-MAX_ENTRIES);
        }
        await writeState(state);
      }
      return state.papers.map((paper) => ({ ...paper }));
    });
  }

  function restore(dedupeKey) {
    const key = compact(dedupeKey, 400);
    if (!key) throw new TypeError("dedupeKey is required");
    return enqueue(async () => {
      const state = await readState();
      const next = state.papers.filter((paper) => paper.dedupe_key !== key);
      if (next.length !== state.papers.length) {
        await writeState({ ...state, papers: next });
      }
      return next.map((paper) => ({ ...paper }));
    });
  }

  return Object.freeze({ list, listKeys, dismiss, restore });
}
