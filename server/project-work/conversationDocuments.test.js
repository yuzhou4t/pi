import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createConversationDocumentService } from "./conversationDocuments.js";

function createHarness(t, {
  parser = null,
  pollIntervalMs = 1,
  maxPollAttempts,
  processingConcurrency,
  beforeUpdateConversation,
  beforeAppendEvent,
} = {}) {
  let state = {
    id: "conversation-documents-1",
    documents: [],
    updatedAt: "2026-07-27T00:00:00.000Z",
  };
  const events = [];
  let sequence = 0;
  let idSequence = 0;
  const rootPromise = mkdtemp(path.join(os.tmpdir(), "pi-conversation-documents-"));
  t.after(async () => {
    const root = await rootPromise;
    await rm(root, { recursive: true, force: true });
  });
  const servicePromise = rootPromise.then(async (root) => {
    const conversationRoot = path.join(root, state.id);
    await mkdir(conversationRoot, { recursive: true });
    const service = createConversationDocumentService({
      getConversation: async (conversationId) => {
        assert.equal(conversationId, state.id);
        return structuredClone(state);
      },
      updateConversation: async (conversationId, updater) => {
        assert.equal(conversationId, state.id);
        const patch = typeof updater === "function"
          ? await updater(structuredClone(state))
          : updater;
        await beforeUpdateConversation?.({
          conversation: structuredClone(state),
          patch: structuredClone(patch),
        });
        state = { ...state, ...patch };
        return structuredClone(state);
      },
      appendEvent: async (conversationId, type, data) => {
        assert.equal(conversationId, state.id);
        await beforeAppendEvent?.({ type, data: structuredClone(data) });
        events.push({ seq: ++sequence, type, data });
      },
      directoryForConversation: () => conversationRoot,
      parser,
      pollIntervalMs,
      ...(maxPollAttempts ? { maxPollAttempts } : {}),
      ...(processingConcurrency ? { processingConcurrency } : {}),
      idFactory: () => `fixture-${++idSequence}`,
      now: (() => {
        let tick = 0;
        return () => new Date(Date.UTC(2026, 6, 27, 0, 0, tick++));
      })(),
    });
    t.after(() => service.dispose());
    return { service, root, conversationRoot };
  });
  return {
    events,
    get state() {
      return structuredClone(state);
    },
    ready: () => servicePromise,
  };
}

async function waitFor(check, message = "condition was not reached") {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await check();
    if (result) return result;
    await delay(5);
  }
  throw new Error(message);
}

test("conversation PDF becomes searchable and readable only after MinerU indexing", async (t) => {
  const markdown = [
    "# API 手册",
    "",
    "## 认证",
    "",
    "客户端必须发送认证令牌，服务端随后校验权限。",
    "",
    "## 错误处理",
    "",
    "失败时返回稳定错误码。",
  ].join("\n");
  const parserCalls = [];
  const parser = {
    async submitBatch(files, { onBatchAllocated }) {
      parserCalls.push({ type: "submit", files });
      await onBatchAllocated({
        batchId: "batch-documents-1",
        traceId: "trace-documents-1",
      });
      assert.match(await readFile(files[0].filePath, "utf8"), /^%PDF-/);
      return {
        batchId: "batch-documents-1",
        state: "uploaded",
        uploads: [{
          fileName: files[0].fileName,
          dataId: files[0].dataId,
          state: "uploaded",
          error: null,
        }],
      };
    },
    async getBatch(batchId) {
      parserCalls.push({ type: "poll", batchId });
      return {
        batchId,
        state: "done",
        items: [{
          dataId: "document-fixture-1",
          fileName: "接口说明.pdf",
          state: "done",
          fullZipUrl: "https://downloads.example.test/document.zip",
        }],
      };
    },
    async downloadResult(url) {
      parserCalls.push({ type: "download", url });
      return {
        markdown,
        markdownFileName: "full.md",
        images: [{
          name: "architecture.png",
          mimeType: "image/png",
          bytes: Uint8Array.from([1, 2, 3]),
        }],
      };
    },
  };
  const harness = createHarness(t, { parser });
  const { service, conversationRoot } = await harness.ready();
  const pdf = Buffer.from("%PDF-1.7\nfixture\n", "utf8");
  const created = await service.createDocument(harness.state.id, {
    fileName: "接口说明.pdf",
    byteLength: pdf.length,
  });

  await service.uploadContent(
    harness.state.id,
    created.id,
    Readable.from([pdf.subarray(0, 7), pdf.subarray(7)]),
    {
      contentType: "application/pdf",
      declaredLength: String(pdf.length),
    },
  );

  const readyDocument = await waitFor(() => {
    const document = harness.state.documents[0];
    return document?.status === "ready" ? document : null;
  });
  assert.equal(readyDocument.title, "API 手册");
  assert.ok(readyDocument.revision.startsWith("sha256:"));
  assert.equal(readyDocument.imageCount, 1);
  assert.deepEqual(parserCalls.map((call) => call.type), [
    "submit",
    "poll",
    "download",
  ]);

  const listed = await service.listForAgent(harness.state.id);
  assert.deepEqual(listed, [{
    document_id: created.id,
    file_name: "接口说明.pdf",
    status: "ready",
    document_revision: readyDocument.revision,
    title: "API 手册",
    block_count: readyDocument.blockCount,
  }]);
  const matches = await service.searchForAgent(harness.state.id, {
    query: "认证令牌",
  });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].document_id, created.id);
  assert.match(matches[0].excerpt, /认证令牌/);
  const read = await service.readForAgent(harness.state.id, {
    documentId: created.id,
    revision: readyDocument.revision,
    blockIds: [matches[0].block_id],
  });
  assert.equal(read.trust, "untrusted_reference");
  assert.match(read.blocks[0].content, /服务端随后校验权限/);
  await assert.rejects(
    service.readForAgent(harness.state.id, {
      documentId: created.id,
      revision: "sha256:stale",
      blockIds: [matches[0].block_id],
    }),
    (error) => error.code === "PROJECT_WORK_DOCUMENT_REVISION_STALE",
  );

  await access(path.join(
    conversationRoot,
    "documents",
    created.id,
    "source.pdf",
  ));
  await access(path.join(
    conversationRoot,
    "documents",
    created.id,
    "extraction",
    "index.json",
  ));
});

test("document reads stay valid JSON when parsed text contains heavy escaping", async (t) => {
  const heading = "超长标题".repeat(180);
  const markdown = [
    `# ${heading}`,
    "",
    `${"\"\\".repeat(12_000)} needle ${"\"\\".repeat(12_000)}`,
  ].join("\n");
  let dataId = null;
  const parser = {
    async submitBatch(files, { onBatchAllocated, onUploadCompleted }) {
      dataId = files[0].dataId;
      await onBatchAllocated({ batchId: "batch-bounded-json" });
      await onUploadCompleted({ batchId: "batch-bounded-json" });
      return {
        batchId: "batch-bounded-json",
        state: "uploaded",
        uploads: [{
          fileName: files[0].fileName,
          dataId,
          state: "uploaded",
          error: null,
        }],
      };
    },
    async getBatch(batchId) {
      return {
        batchId,
        state: "done",
        items: [{
          dataId,
          fileName: "特殊字符.pdf",
          state: "done",
          fullZipUrl: "https://downloads.example.test/bounded.zip",
        }],
      };
    },
    async downloadResult() {
      return { markdown, markdownFileName: "full.md", images: [] };
    },
  };
  const harness = createHarness(t, { parser });
  const { service } = await harness.ready();
  const pdf = Buffer.from("%PDF-1.7\nbounded-json\n", "utf8");
  const created = await service.createDocument(harness.state.id, {
    fileName: "特殊字符.pdf",
    byteLength: pdf.length,
  });
  await service.uploadContent(
    harness.state.id,
    created.id,
    Readable.from([pdf]),
    {
      contentType: "application/pdf",
      declaredLength: String(pdf.length),
    },
  );

  const ready = await waitFor(() => (
    harness.state.documents[0]?.status === "ready"
      ? harness.state.documents[0]
      : null
  ));
  const [match] = await service.searchForAgent(harness.state.id, {
    query: "needle",
  });
  const result = await service.readForAgent(harness.state.id, {
    documentId: created.id,
    revision: ready.revision,
    blockIds: [match.block_id],
  });
  const serialized = JSON.stringify(result);
  assert.doesNotThrow(() => JSON.parse(serialized));
  assert.ok(serialized.length <= 60_000);
  assert.equal(result.truncated, true);
  assert.ok(result.blocks[0].section_path.every((segment) => segment.length <= 200));
});

test("a corrupt ready index downgrades to a retryable state and can be rebuilt", async (t) => {
  let submissions = 0;
  let downloads = 0;
  let dataId = null;
  const parser = {
    async submitBatch(files, { onBatchAllocated, onUploadCompleted }) {
      submissions += 1;
      dataId = files[0].dataId;
      const batchId = `batch-rebuild-${submissions}`;
      await onBatchAllocated({ batchId });
      await onUploadCompleted({ batchId });
      return {
        batchId,
        state: "uploaded",
        uploads: [{
          fileName: files[0].fileName,
          dataId,
          state: "uploaded",
          error: null,
        }],
      };
    },
    async getBatch(batchId) {
      return {
        batchId,
        state: "done",
        items: [{
          dataId,
          fileName: "可修复.pdf",
          state: "done",
          fullZipUrl: "https://downloads.example.test/rebuild.zip",
        }],
      };
    },
    async downloadResult() {
      downloads += 1;
      return {
        markdown: "# 可修复资料\n\n索引损坏后应当重新构建。",
        markdownFileName: "full.md",
        images: [],
      };
    },
  };
  const harness = createHarness(t, { parser });
  const { service, conversationRoot } = await harness.ready();
  const pdf = Buffer.from("%PDF-1.7\nrebuild\n", "utf8");
  const created = await service.createDocument(harness.state.id, {
    fileName: "可修复.pdf",
    byteLength: pdf.length,
  });
  await service.uploadContent(
    harness.state.id,
    created.id,
    Readable.from([pdf]),
    {
      contentType: "application/pdf",
      declaredLength: String(pdf.length),
    },
  );
  await waitFor(() => harness.state.documents[0]?.status === "ready");
  await writeFile(
    path.join(
      conversationRoot,
      "documents",
      created.id,
      "extraction",
      "index.json",
    ),
    "{broken",
    "utf8",
  );

  await assert.rejects(
    service.searchForAgent(harness.state.id, { query: "重新构建" }),
    (error) => error.code === "PROJECT_WORK_DOCUMENT_INDEX_UNAVAILABLE",
  );
  assert.equal(harness.state.documents[0].status, "indexing_failed");
  assert.equal(harness.state.documents[0].error.retryable, true);

  await service.retryDocument(harness.state.id, created.id);
  await waitFor(() => harness.state.documents[0]?.status === "ready");
  assert.equal(submissions, 1);
  assert.equal(downloads, 2);
  const [match] = await service.searchForAgent(harness.state.id, {
    query: "重新构建",
  });
  assert.equal(match.document_id, created.id);
});

test("MinerU preparation never exceeds the configured document concurrency", async (t) => {
  let activeOperations = 0;
  let maxActiveOperations = 0;
  const dataIds = new Map();
  async function trackedOperation(operation) {
    activeOperations += 1;
    maxActiveOperations = Math.max(maxActiveOperations, activeOperations);
    try {
      await delay(10);
      return await operation();
    } finally {
      activeOperations -= 1;
    }
  }
  const parser = {
    async submitBatch(files, { onBatchAllocated, onUploadCompleted }) {
      return trackedOperation(async () => {
        const dataId = files[0].dataId;
        const batchId = `batch-${dataId}`;
        dataIds.set(batchId, dataId);
        await onBatchAllocated({ batchId });
        await onUploadCompleted({ batchId });
        return {
          batchId,
          state: "uploaded",
          uploads: [{
            fileName: files[0].fileName,
            dataId,
            state: "uploaded",
            error: null,
          }],
        };
      });
    },
    async getBatch(batchId) {
      return trackedOperation(() => {
        const dataId = dataIds.get(batchId);
        return {
          batchId,
          state: "done",
          items: [{
            dataId,
            fileName: `${dataId}.pdf`,
            state: "done",
            fullZipUrl: `https://downloads.example.test/${dataId}.zip`,
          }],
        };
      });
    },
    async downloadResult() {
      return trackedOperation(() => ({
        markdown: "# 并发资料\n\n正文。",
        markdownFileName: "full.md",
        images: [],
      }));
    },
  };
  const harness = createHarness(t, {
    parser,
    processingConcurrency: 2,
  });
  const { service } = await harness.ready();

  for (let index = 1; index <= 3; index += 1) {
    const pdf = Buffer.from(`%PDF-1.7\nconcurrency-${index}\n`, "utf8");
    const created = await service.createDocument(harness.state.id, {
      fileName: `并发资料-${index}.pdf`,
      byteLength: pdf.length,
    });
    await service.uploadContent(
      harness.state.id,
      created.id,
      Readable.from([pdf]),
      {
        contentType: "application/pdf",
        declaredLength: String(pdf.length),
      },
    );
  }

  await waitFor(() => (
    harness.state.documents.every((document) => document.status === "ready")
      ? true
      : null
  ));
  assert.equal(harness.state.documents.length, 3);
  assert.equal(maxActiveOperations, 2);
});

test("document removal rolls back safely and does not fail after only event logging fails", async (t) => {
  let failRemovalUpdate = false;
  let failRemovalEvent = false;
  const harness = createHarness(t, {
    beforeUpdateConversation({ conversation, patch }) {
      if (
        failRemovalUpdate
        && conversation.documents.length === 1
        && patch.documents?.length === 0
      ) {
        throw new Error("manifest write failed");
      }
    },
    beforeAppendEvent({ type }) {
      if (failRemovalEvent && type === "document.removed") {
        throw new Error("event write failed");
      }
    },
  });
  const { service, conversationRoot } = await harness.ready();
  const created = await service.createDocument(harness.state.id, {
    fileName: "待移除.pdf",
    byteLength: 12,
  });
  const documentDirectory = path.join(
    conversationRoot,
    "documents",
    created.id,
  );

  failRemovalUpdate = true;
  await assert.rejects(
    service.removeDocument(harness.state.id, created.id),
    /manifest write failed/,
  );
  assert.equal(harness.state.documents[0].status, "awaiting_upload");
  await access(documentDirectory);

  failRemovalUpdate = false;
  failRemovalEvent = true;
  const removed = await service.removeDocument(harness.state.id, created.id);
  assert.equal(removed.localAssetsRemoved, true);
  assert.deepEqual(harness.state.documents, []);
  await assert.rejects(access(documentDirectory), { code: "ENOENT" });
});

test("dispose waits for an in-flight MinerU document job", async (t) => {
  let releaseSubmission;
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const parser = {
    async submitBatch(files, { onBatchAllocated }) {
      await onBatchAllocated({ batchId: "batch-dispose" });
      markStarted();
      await new Promise((resolve) => {
        releaseSubmission = resolve;
      });
      return {
        batchId: "batch-dispose",
        state: "uploaded",
        uploads: [{
          fileName: files[0].fileName,
          dataId: files[0].dataId,
          state: "uploaded",
          error: null,
        }],
      };
    },
    async getBatch() {
      throw new Error("polling must not start after dispose");
    },
    async downloadResult() {
      throw new Error("not reached");
    },
  };
  const harness = createHarness(t, { parser });
  const { service } = await harness.ready();
  const pdf = Buffer.from("%PDF-1.7\ndispose\n", "utf8");
  const created = await service.createDocument(harness.state.id, {
    fileName: "退出等待.pdf",
    byteLength: pdf.length,
  });
  await service.uploadContent(
    harness.state.id,
    created.id,
    Readable.from([pdf]),
    {
      contentType: "application/pdf",
      declaredLength: String(pdf.length),
    },
  );
  await started;

  let disposeSettled = false;
  const disposePromise = service.dispose().then(() => {
    disposeSettled = true;
  });
  await delay(5);
  assert.equal(disposeSettled, false);
  releaseSubmission();
  await disposePromise;
  assert.equal(disposeSettled, true);
});

test("invalid PDF bytes never become a source document", async (t) => {
  const harness = createHarness(t);
  const { service, conversationRoot } = await harness.ready();
  const invalid = Buffer.from("not-a-pdf", "utf8");
  const created = await service.createDocument(harness.state.id, {
    fileName: "伪造.pdf",
    byteLength: invalid.length,
  });

  await assert.rejects(
    service.uploadContent(
      harness.state.id,
      created.id,
      Readable.from([invalid]),
      {
        contentType: "application/pdf",
        declaredLength: String(invalid.length),
      },
    ),
    (error) => error.code === "PROJECT_WORK_DOCUMENT_SIGNATURE_INVALID",
  );
  assert.equal(harness.state.documents[0].status, "upload_interrupted");
  await assert.rejects(
    access(path.join(
      conversationRoot,
      "documents",
      created.id,
      "source.pdf",
    )),
    (error) => error.code === "ENOENT",
  );
  const removed = await service.removeDocument(harness.state.id, created.id);
  assert.equal(removed.localAssetsRemoved, true);
  assert.equal(removed.remoteDeletionClaimed, false);
  assert.deepEqual(harness.state.documents, []);
});

test("upload without a configured MinerU parser stays durable without starting AI", async (t) => {
  const harness = createHarness(t);
  const { service } = await harness.ready();
  const pdf = Buffer.from("%PDF-1.7\nprivate\n", "utf8");
  const created = await service.createDocument(harness.state.id, {
    fileName: "本地资料.pdf",
    byteLength: pdf.length,
  });

  await service.uploadContent(
    harness.state.id,
    created.id,
    Readable.from([pdf]),
    {
      contentType: "application/pdf",
      declaredLength: String(pdf.length),
    },
  );

  const document = await waitFor(() => {
    const current = harness.state.documents[0];
    return current?.status === "not_configured" ? current : null;
  });
  assert.equal(document.error.code, "PROJECT_WORK_MINERU_NOT_CONFIGURED");
  assert.equal((await service.listForAgent(harness.state.id))[0].status, "not_configured");
  assert.equal(
    harness.events.some((event) => event.type === "document.ready"),
    false,
  );
});

test("a stalled MinerU batch reaches a finite retryable timeout", async (t) => {
  let polls = 0;
  let dataId = null;
  const parser = {
    async submitBatch(files, { onBatchAllocated }) {
      dataId = files[0].dataId;
      await onBatchAllocated({ batchId: "batch-stalled" });
      return {
        batchId: "batch-stalled",
        state: "uploaded",
        uploads: [{
          fileName: files[0].fileName,
          dataId,
          state: "uploaded",
          error: null,
        }],
      };
    },
    async getBatch(batchId) {
      polls += 1;
      return {
        batchId,
        state: "running",
        items: [{
          dataId,
          fileName: "停滞.pdf",
          state: "running",
          fullZipUrl: null,
        }],
      };
    },
    async downloadResult() {
      throw new Error("not reached");
    },
  };
  const harness = createHarness(t, {
    parser,
    pollIntervalMs: 1,
    maxPollAttempts: 2,
  });
  const { service } = await harness.ready();
  const pdf = Buffer.from("%PDF-1.7\nstalled\n", "utf8");
  const created = await service.createDocument(harness.state.id, {
    fileName: "停滞.pdf",
    byteLength: pdf.length,
  });
  await service.uploadContent(
    harness.state.id,
    created.id,
    Readable.from([pdf]),
    {
      contentType: "application/pdf",
      declaredLength: String(pdf.length),
    },
  );

  const failed = await waitFor(() => {
    const document = harness.state.documents[0];
    return document?.error?.code === "MINERU_POLL_TIMEOUT"
      ? document
      : null;
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.error.retryable, true);
  assert.equal(polls, 2);
  await delay(15);
  assert.equal(polls, 2);
});

test("a failed signed upload retries with a new MinerU batch instead of polling the empty one", async (t) => {
  let submissions = 0;
  let dataId = null;
  const parser = {
    async submitBatch(files, { onBatchAllocated }) {
      submissions += 1;
      dataId = files[0].dataId;
      await onBatchAllocated({ batchId: `batch-upload-${submissions}` });
      if (submissions === 1) {
        return {
          batchId: "batch-upload-1",
          state: "failed",
          uploads: [{
            fileName: files[0].fileName,
            dataId,
            state: "failed",
            error: {
              code: "MINERU_UPLOAD_FAILED",
              category: "retryable",
              retryable: true,
              message: "network failed",
            },
          }],
        };
      }
      return {
        batchId: "batch-upload-2",
        state: "uploaded",
        uploads: [{
          fileName: files[0].fileName,
          dataId,
          state: "uploaded",
          error: null,
        }],
      };
    },
    async getBatch(batchId) {
      assert.equal(batchId, "batch-upload-2");
      return {
        batchId,
        state: "done",
        items: [{
          dataId,
          fileName: "重试.pdf",
          state: "done",
          fullZipUrl: "https://downloads.example.test/retry.zip",
        }],
      };
    },
    async downloadResult() {
      return {
        markdown: "# 重试成功\n\n正文。",
        markdownFileName: "full.md",
        images: [],
      };
    },
  };
  const harness = createHarness(t, { parser });
  const { service } = await harness.ready();
  const pdf = Buffer.from("%PDF-1.7\nretry\n", "utf8");
  const created = await service.createDocument(harness.state.id, {
    fileName: "重试.pdf",
    byteLength: pdf.length,
  });
  await service.uploadContent(
    harness.state.id,
    created.id,
    Readable.from([pdf]),
    {
      contentType: "application/pdf",
      declaredLength: String(pdf.length),
    },
  );
  await waitFor(() => harness.state.documents[0]?.status === "failed");
  assert.equal(harness.state.documents[0].batchTerminal, true);

  await service.retryDocument(harness.state.id, created.id);
  await waitFor(() => harness.state.documents[0]?.status === "ready");
  assert.equal(submissions, 2);
  assert.equal(harness.state.documents[0].batchId, "batch-upload-2");
});
