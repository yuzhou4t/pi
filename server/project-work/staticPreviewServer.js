import { createReadStream } from "node:fs";
import http from "node:http";
import {
  lstat,
  realpath,
} from "node:fs/promises";
import path from "node:path";

const MIME_TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
});

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolveFile(root, requestPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  const relative = decoded.replace(/^\/+/, "") || "index.html";
  const candidate = path.resolve(root, relative);
  if (!isInside(root, candidate)) return null;
  let stat;
  try {
    stat = await lstat(candidate);
  } catch {
    return null;
  }
  if (stat.isSymbolicLink()) return null;
  const file = stat.isDirectory() ? path.join(candidate, "index.html") : candidate;
  let canonical;
  let fileStat;
  try {
    [canonical, fileStat] = await Promise.all([realpath(file), lstat(file)]);
  } catch {
    return null;
  }
  if (
    !isInside(root, canonical)
    || fileStat.isSymbolicLink()
    || !fileStat.isFile()
  ) {
    return null;
  }
  return { file: canonical, stat: fileStat };
}

const host = argument("--host", "127.0.0.1");
const port = Number(argument("--port", "0"));
const root = await realpath(process.cwd());

if (
  host !== "127.0.0.1"
  || !Number.isInteger(port)
  || port < 1_024
  || port > 65_535
) {
  throw new Error("Static preview requires a valid loopback host and port");
}

const server = http.createServer(async (request, response) => {
  if (!["GET", "HEAD"].includes(request.method)) {
    response.writeHead(405, { allow: "GET, HEAD" });
    response.end();
    return;
  }
  const url = new URL(request.url, `http://${host}:${port}`);
  const resolved = await resolveFile(root, url.pathname);
  if (!resolved) {
    response.writeHead(404, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end("Not found");
    return;
  }
  response.writeHead(200, {
    "content-type": MIME_TYPES[path.extname(resolved.file).toLowerCase()]
      ?? "application/octet-stream",
    "content-length": resolved.stat.size,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(resolved.file).pipe(response);
});

server.listen(port, host);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
  });
}
