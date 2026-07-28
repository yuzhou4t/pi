import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import {
  normalizeProjectWorkRuntimeUrl,
  probeProjectWorkRuntime,
  proxyProjectWorkRequest,
} from "./runtimeProxy.js";

function requestStream({
  method = "GET",
  url = "/api/v1/project-work/models",
  headers = {},
  body = "",
} = {}) {
  const request = Readable.from(body ? [Buffer.from(body)] : []);
  Object.assign(request, { method, url, headers });
  return request;
}

function responseStream() {
  const chunks = [];
  const response = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  response.statusCode = null;
  response.headers = {};
  response.writeHead = (statusCode, headers) => {
    response.statusCode = statusCode;
    response.headers = { ...headers };
    return response;
  };
  response.body = () => Buffer.concat(chunks).toString("utf8");
  return response;
}

test("runtime URL accepts only an explicit loopback HTTP endpoint", () => {
  const normalized = normalizeProjectWorkRuntimeUrl(
    "http://127.0.0.1:47888",
  );
  assert.equal(normalized.host, "127.0.0.1:47888");
  assert.equal(
    normalizeProjectWorkRuntimeUrl(normalized).host,
    "127.0.0.1:47888",
  );
  for (const value of [
    "https://127.0.0.1:47888",
    "http://localhost:47888",
    "http://127.0.0.1:47888/path",
    "http://example.test:47888",
  ]) {
    assert.throws(
      () => normalizeProjectWorkRuntimeUrl(value),
      /回环地址/,
    );
  }
});

test("runtime health probe reports only a valid worker response as reachable", async () => {
  const requests = [];
  const requestImpl = (options, callback) => {
    requests.push(options);
    const request = new EventEmitter();
    request.destroy = () => {};
    request.end = () => {
      queueMicrotask(() => {
        const response = Readable.from([
          JSON.stringify({
            status: "ok",
            runtime_role: "worker",
            project_work: "available",
            runtime_schema_version: 1,
          }),
        ]);
        response.statusCode = 200;
        callback(response);
      });
    };
    return request;
  };
  assert.deepEqual(
    await probeProjectWorkRuntime(
      normalizeProjectWorkRuntimeUrl("http://127.0.0.1:47888"),
      {
      requestImpl,
      },
    ),
    {
      reachable: true,
      runtimeRole: "worker",
      runtimeSchemaVersion: 1,
    },
  );
  assert.equal(requests[0].path, "/api/v1/health");

  const unavailable = await probeProjectWorkRuntime(
    "http://127.0.0.1:47888",
    {
      requestImpl: () => {
        const request = new EventEmitter();
        request.destroy = () => {};
        request.end = () => queueMicrotask(
          () => request.emit("error", new Error("offline")),
        );
        return request;
      },
    },
  );
  assert.deepEqual(unavailable, {
    reachable: false,
    runtimeRole: null,
    runtimeSchemaVersion: null,
  });
});

test("proxy preserves the project-work request and streams the worker response", async () => {
  const requestBody = JSON.stringify({ text: "继续" });
  const request = requestStream({
    method: "POST",
    url: "/api/v1/project-work/conversations/conversation-1/messages",
    headers: {
      "content-type": "application/json",
      origin: "http://127.0.0.1:4173",
    },
    body: requestBody,
  });
  const response = responseStream();
  let observedOptions;
  let observedBody = "";
  const requestImpl = (options, callback) => {
    observedOptions = options;
    const upstream = new Writable({
      write(chunk, _encoding, done) {
        observedBody += chunk.toString("utf8");
        done();
      },
      final(done) {
        const upstreamResponse = Readable.from([
          JSON.stringify({ accepted: true }),
        ]);
        upstreamResponse.statusCode = 202;
        upstreamResponse.headers = {
          "content-type": "application/json",
          "x-runtime-seq": "42",
        };
        callback(upstreamResponse);
        done();
      },
    });
    return upstream;
  };

  await proxyProjectWorkRequest(
    request,
    response,
    normalizeProjectWorkRuntimeUrl("http://127.0.0.1:47888"),
    { requestImpl },
  );

  assert.equal(observedOptions.method, "POST");
  assert.equal(observedOptions.path, request.url);
  assert.equal(
    observedOptions.headers.origin,
    "http://127.0.0.1:4173",
  );
  assert.equal(observedBody, requestBody);
  assert.equal(response.statusCode, 202);
  assert.equal(response.headers["x-runtime-seq"], "42");
  assert.deepEqual(JSON.parse(response.body()), { accepted: true });
});

test("proxy returns a retryable recovery state while the worker is unavailable", async () => {
  const request = requestStream();
  const response = responseStream();
  const requestImpl = () => {
    const upstream = new EventEmitter();
    upstream.destroy = () => {};
    upstream.write = () => true;
    upstream.end = () => {};
    queueMicrotask(() => upstream.emit("error", new Error("offline")));
    return upstream;
  };

  await proxyProjectWorkRequest(
    request,
    response,
    "http://127.0.0.1:47888",
    { requestImpl },
  );

  assert.equal(response.statusCode, 503);
  assert.deepEqual(JSON.parse(response.body()), {
    error: {
      code: "PROJECT_WORK_RUNTIME_UNAVAILABLE",
      message: "Pi Runtime 正在恢复，请稍后重试",
      retryable: true,
    },
  });
});
