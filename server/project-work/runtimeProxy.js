import http from "node:http";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function runtimeProxyError(message) {
  const error = new Error(message);
  error.code = "PROJECT_WORK_RUNTIME_UNAVAILABLE";
  error.status = 503;
  error.retryable = true;
  return error;
}

export function normalizeProjectWorkRuntimeUrl(value) {
  if (value == null || (typeof value === "string" && !value.trim())) {
    return null;
  }
  let url;
  try {
    url = value instanceof URL ? new URL(value.href) : new URL(value);
  } catch {
    throw runtimeProxyError("Pi Runtime 地址无效");
  }
  if (
    url.protocol !== "http:"
    || url.hostname !== "127.0.0.1"
    || !url.port
    || url.username
    || url.password
    || (url.pathname !== "/" && url.pathname !== "")
    || url.search
    || url.hash
  ) {
    throw runtimeProxyError("Pi Runtime 必须使用本机回环地址");
  }
  return url;
}

export function probeProjectWorkRuntime(
  runtimeUrlValue,
  {
    requestImpl = http.request,
    timeoutMs = 750,
  } = {},
) {
  const runtimeUrl = normalizeProjectWorkRuntimeUrl(runtimeUrlValue);
  if (!runtimeUrl) {
    return Promise.resolve({
      reachable: false,
      runtimeRole: null,
      runtimeSchemaVersion: null,
    });
  }
  return new Promise((resolve) => {
    let settled = false;
    let request;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      request?.destroy?.();
      finish({
        reachable: false,
        runtimeRole: null,
        runtimeSchemaVersion: null,
      });
    }, Math.min(Math.max(Number(timeoutMs) || 750, 50), 5_000));
    timeout.unref?.();
    try {
      request = requestImpl({
        protocol: runtimeUrl.protocol,
        hostname: runtimeUrl.hostname,
        port: runtimeUrl.port,
        method: "GET",
        path: "/api/v1/health",
        headers: {
          accept: "application/json",
          host: runtimeUrl.host,
        },
        agent: false,
      }, (response) => {
        const chunks = [];
        let byteLength = 0;
        response.on("data", (chunk) => {
          byteLength += chunk.length;
          if (byteLength > 32 * 1024) {
            request.destroy?.();
            finish({
              reachable: false,
              runtimeRole: null,
              runtimeSchemaVersion: null,
            });
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.once("error", () => finish({
          reachable: false,
          runtimeRole: null,
          runtimeSchemaVersion: null,
        }));
        response.once("end", () => {
          try {
            const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            const reachable = (
              response.statusCode === 200
              && payload?.status === "ok"
              && payload?.runtime_role === "worker"
              && payload?.project_work === "available"
            );
            finish({
              reachable,
              runtimeRole: reachable ? payload.runtime_role : null,
              runtimeSchemaVersion: reachable
                && Number.isSafeInteger(payload.runtime_schema_version)
                ? payload.runtime_schema_version
                : null,
            });
          } catch {
            finish({
              reachable: false,
              runtimeRole: null,
              runtimeSchemaVersion: null,
            });
          }
        });
      });
      request.once("error", () => finish({
        reachable: false,
        runtimeRole: null,
        runtimeSchemaVersion: null,
      }));
      request.end();
    } catch {
      finish({
        reachable: false,
        runtimeRole: null,
        runtimeSchemaVersion: null,
      });
    }
  });
}

function forwardedHeaders(headers, runtimeUrl) {
  const result = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      continue;
    }
    result[name] = value;
  }
  result.host = runtimeUrl.host;
  return result;
}

function responseHeaders(headers) {
  const result = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      continue;
    }
    result[name] = value;
  }
  return result;
}

function sendUnavailable(response) {
  if (response.headersSent || response.destroyed) {
    response.destroy();
    return;
  }
  const payload = JSON.stringify({
    error: {
      code: "PROJECT_WORK_RUNTIME_UNAVAILABLE",
      message: "Pi Runtime 正在恢复，请稍后重试",
      retryable: true,
    },
  });
  response.writeHead(503, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  response.end(payload);
}

export function proxyProjectWorkRequest(
  request,
  response,
  runtimeUrlValue,
  {
    requestImpl = http.request,
  } = {},
) {
  const runtimeUrl = normalizeProjectWorkRuntimeUrl(runtimeUrlValue);
  if (!runtimeUrl) {
    return Promise.reject(runtimeProxyError("Pi Runtime 未配置"));
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const upstream = requestImpl({
      protocol: runtimeUrl.protocol,
      hostname: runtimeUrl.hostname,
      port: runtimeUrl.port,
      method: request.method,
      path: request.url,
      headers: forwardedHeaders(request.headers, runtimeUrl),
      agent: false,
    }, (upstreamResponse) => {
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        responseHeaders(upstreamResponse.headers),
      );
      upstreamResponse.pipe(response);
      upstreamResponse.once("end", finish);
      upstreamResponse.once("error", () => {
        sendUnavailable(response);
        finish();
      });
    });
    upstream.once("error", () => {
      sendUnavailable(response);
      finish();
    });
    request.once("aborted", () => {
      upstream.destroy();
      finish();
    });
    response.once("close", () => {
      if (!response.writableEnded) upstream.destroy();
      finish();
    });
    request.pipe(upstream);
  });
}
