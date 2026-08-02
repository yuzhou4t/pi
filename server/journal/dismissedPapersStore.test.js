import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDismissedPapersStore } from "./dismissedPapersStore.js";

test("dismiss persists across store instances and dedupes by key", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-dismissed-"));
  const store = createDismissedPapersStore({
    dataDir,
    now: () => new Date("2026-07-30T08:00:00.000Z"),
  });
  await store.dismiss({ dedupeKey: "doi:10.1000/a", title: "Paper A" });
  await store.dismiss({ dedupeKey: "doi:10.1000/a", title: "Paper A duplicate" });
  await store.dismiss({ dedupeKey: "doi:10.1000/b", title: "Paper B" });

  const reopened = createDismissedPapersStore({ dataDir });
  const papers = await reopened.list();
  assert.equal(papers.length, 2);
  assert.deepEqual(await reopened.listKeys(), ["doi:10.1000/a", "doi:10.1000/b"]);
  assert.equal(papers[0].title, "Paper A");
  assert.equal(papers[0].dismissed_at, "2026-07-30T08:00:00.000Z");
});

test("restore removes a dismissed paper and missing store reads as empty", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-dismissed-restore-"));
  const store = createDismissedPapersStore({ dataDir });
  assert.deepEqual(await store.list(), []);
  await store.dismiss({ dedupeKey: "doi:10.1000/a", title: "Paper A" });
  const remaining = await store.restore("doi:10.1000/a");
  assert.deepEqual(remaining, []);
  assert.deepEqual(await store.listKeys(), []);
});

test("concurrent dismissals never lose entries", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-dismissed-concurrent-"));
  const store = createDismissedPapersStore({ dataDir });
  await Promise.all(Array.from({ length: 8 }, (_, index) => (
    store.dismiss({ dedupeKey: `key-${index}`, title: `Paper ${index}` })
  )));
  assert.equal((await store.list()).length, 8);
});
