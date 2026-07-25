import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { strToU8, zipSync } from "fflate";
import {
  createMineruCloudAdapter,
  MineruCloudError,
} from "./mineruCloud.js";

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    async json() { return body; },
  };
}

function binaryResponse(bytes, status = 200) {
  const body = Uint8Array.from(bytes);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-length": String(body.byteLength) }),
    async arrayBuffer() {
      return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
    },
  };
}

async function createPdfs(t, names = ["first.pdf", "second.pdf"]) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-agent-mineru-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const files = [];
  for (let index = 0; index < names.length; index += 1) {
    const filePath = path.join(directory, names[index]);
    await writeFile(filePath, `%PDF-1.7\npaper-${index}\n`, "utf8");
    files.push({
      filePath,
      fileName: names[index],
      dataId: `paper-${index + 1}`,
    });
  }
  return files;
}

test("submitBatch keeps a partial upload result and sends no headers on signed PUTs", async (t) => {
  const files = await createPdfs(t);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (init.method === "POST") {
      return jsonResponse({
        code: 0,
        data: {
          batch_id: "batch-1",
          file_urls: [
            "https://uploads.example.test/first",
            "https://uploads.example.test/second",
          ],
        },
        msg: "ok",
        trace_id: "trace-1",
      });
    }
    return init.body.toString("utf8").includes("paper-0")
      ? jsonResponse({}, 200)
      : jsonResponse({}, 503);
  };
  const adapter = createMineruCloudAdapter({
    apiToken: "server-secret",
    fetchImpl,
  });

  const result = await adapter.submitBatch(files);

  assert.equal(result.batchId, "batch-1");
  assert.equal(result.state, "partial");
  assert.deepEqual(result.uploads.map((upload) => upload.state), ["uploaded", "failed"]);
  assert.equal(result.uploads[1].error.category, "retryable");
  assert.equal(result.uploads[1].error.retryable, true);
  assert.equal(calls[0].init.headers.authorization, "Bearer server-secret");
  const putCalls = calls.filter((call) => call.init.method === "PUT");
  assert.equal(putCalls.length, 2);
  for (const call of putCalls) {
    assert.equal("headers" in call.init, false);
    assert.equal(String(call.init.body.subarray(0, 5)), String(Buffer.from("%PDF-")));
  }
});

test("quota responses are classified separately from retryable and token errors", async (t) => {
  const [file] = await createPdfs(t, ["quota.pdf"]);
  const quotaAdapter = createMineruCloudAdapter({
    apiToken: "server-secret",
    fetchImpl: async () => jsonResponse({
      code: -60018,
      data: {},
      msg: "daily limit reached",
      trace_id: "trace-quota",
    }),
  });
  await assert.rejects(
    quotaAdapter.submitBatch([file]),
    (error) => (
      error instanceof MineruCloudError
      && error.code === "MINERU_QUOTA_EXHAUSTED"
      && error.category === "quota"
      && error.retryable === false
    ),
  );

  const tokenAdapter = createMineruCloudAdapter({
    apiToken: "expired-secret",
    fetchImpl: async () => jsonResponse({}, 401),
  });
  await assert.rejects(
    tokenAdapter.getBatch("batch-1"),
    (error) => error instanceof MineruCloudError && error.category === "token",
  );

  const retryableAdapter = createMineruCloudAdapter({
    apiToken: "server-secret",
    fetchImpl: async () => { throw new Error("network down"); },
  });
  await assert.rejects(
    retryableAdapter.getBatch("batch-1"),
    (error) => (
      error instanceof MineruCloudError
      && error.category === "retryable"
      && error.retryable === true
    ),
  );
});

test("API requests time out as retryable MinerU failures", async () => {
  const adapter = createMineruCloudAdapter({
    apiToken: "server-secret",
    requestTimeoutMs: 5,
    fetchImpl: async (_url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
  });

  await assert.rejects(
    adapter.getBatch("batch-timeout"),
    (error) => (
      error instanceof MineruCloudError
      && error.code === "MINERU_UPSTREAM_RETRYABLE"
      && error.retryable === true
    ),
  );
});

test("getBatch preserves mixed done and failed results as partial", async () => {
  const adapter = createMineruCloudAdapter({
    apiToken: "server-secret",
    fetchImpl: async () => jsonResponse({
      code: 0,
      data: {
        batch_id: "batch-1",
        extract_result: [
          {
            file_name: "first.pdf",
            data_id: "paper-1",
            state: "done",
            err_msg: "",
            full_zip_url: "https://downloads.example.test/first.zip",
          },
          {
            file_name: "second.pdf",
            data_id: "paper-2",
            state: "failed",
            err_msg: "file conversion failed",
          },
        ],
      },
      msg: "ok",
      trace_id: "trace-results",
    }),
  });

  const result = await adapter.getBatch("batch-1");

  assert.equal(result.state, "partial");
  assert.equal(result.items[0].fullZipUrl, "https://downloads.example.test/first.zip");
  assert.equal(result.items[1].error, "file conversion failed");
});

test("downloadResult rejects ZIP path traversal", async () => {
  const archive = zipSync({
    "full.md": strToU8("# Safe"),
    "../escape.png": Uint8Array.from([1, 2, 3]),
  });
  const adapter = createMineruCloudAdapter({
    apiToken: "server-secret",
    fetchImpl: async () => binaryResponse(archive),
  });

  await assert.rejects(
    adapter.downloadResult("https://downloads.example.test/result.zip"),
    (error) => (
      error instanceof MineruCloudError
      && error.code === "MINERU_ARCHIVE_UNSAFE"
    ),
  );
});

test("downloadResult rejects empty Markdown", async () => {
  const archive = zipSync({
    "paper/full.md": strToU8(" \n\t "),
    "paper/images/figure.png": Uint8Array.from([1, 2, 3]),
  });
  const adapter = createMineruCloudAdapter({
    apiToken: "server-secret",
    fetchImpl: async () => binaryResponse(archive),
  });

  await assert.rejects(
    adapter.downloadResult("https://downloads.example.test/result.zip"),
    (error) => (
      error instanceof MineruCloudError
      && error.code === "MINERU_MARKDOWN_EMPTY"
    ),
  );
});

test("downloadResult times out while reading the ZIP body", async () => {
  const adapter = createMineruCloudAdapter({
    apiToken: "server-secret",
    downloadTimeoutMs: 5,
    fetchImpl: async (_url, init) => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      arrayBuffer: async () => new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    }),
  });

  await assert.rejects(
    adapter.downloadResult("https://downloads.example.test/slow.zip"),
    (error) => (
      error instanceof MineruCloudError
      && error.code === "MINERU_UPSTREAM_RETRYABLE"
      && error.retryable === true
    ),
  );
});

test("downloadResult returns only Markdown and flattened safe image names", async () => {
  const archive = zipSync({
    "paper/full.md": strToU8("# Parsed paper\n\nUseful content."),
    "paper/images/figure.png": Uint8Array.from([1, 2, 3]),
    "paper/content_list.json": strToU8("{}"),
  });
  const calls = [];
  const adapter = createMineruCloudAdapter({
    apiToken: "server-secret",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return binaryResponse(archive);
    },
  });

  const result = await adapter.downloadResult("https://downloads.example.test/result.zip");

  assert.equal(result.markdown, "# Parsed paper\n\nUseful content.");
  assert.equal(result.markdownFileName, "full.md");
  assert.deepEqual(result.images.map((image) => image.name), ["figure.png"]);
  assert.equal(result.images[0].mimeType, "image/png");
  assert.equal(calls[0].init.method, "GET");
  assert.equal("headers" in calls[0].init, false);
  assert.equal("authorization" in result, false);
});
