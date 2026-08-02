import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_PORT_START = 48_080;
const DEFAULT_PORT_END = 48_119;
const DEFAULT_STARTUP_TIMEOUT_MS = 20_000;
const DEFAULT_POLL_INTERVAL_MS = 150;
const DEFAULT_PROBE_TIMEOUT_MS = 1_500;
const DEFAULT_STOP_TIMEOUT_MS = 1_000;
const DEFAULT_MAX_LOG_BYTES = 32 * 1024;
const APP_PATTERN = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*:[A-Za-z_]\w*$/;
const ROUTE_PATTERN = /^\/(?!\/)[^\s\\?#]*$/;
const STATIC_PREVIEW_SERVER = fileURLToPath(
  new URL("./staticPreviewServer.js", import.meta.url),
);
const PREVIEW_RUNTIMES = new Set([
  "python_uvicorn",
  "vite",
  "static",
]);

function previewError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeEnvironment() {
  return {
    ...Object.fromEntries(
      ["PATH", "LANG", "LC_ALL", "TMPDIR"].flatMap((name) => (
        typeof process.env[name] === "string" ? [[name, process.env[name]]] : []
      )),
    ),
    PYTHONUNBUFFERED: "1",
  };
}

function appendBoundedLog(record, name, chunk, maxBytes) {
  const current = record[name];
  if (current.length >= maxBytes) {
    record.logsTruncated = true;
    return;
  }
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  const remaining = maxBytes - current.length;
  record[name] = Buffer.concat([current, buffer.subarray(0, remaining)]);
  record.logsTruncated ||= buffer.length > remaining;
}

function sanitizedLogs(record) {
  return {
    stdout: record.stdout.toString("utf8"),
    stderr: record.stderr.toString("utf8"),
    truncated: record.logsTruncated,
  };
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function defaultCheckPort(port, host = LOOPBACK_HOST) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (error) => {
      if (error?.code === "EADDRINUSE" || error?.code === "EACCES") {
        resolve(false);
        return;
      }
      reject(error);
    });
    server.listen({ host, port, exclusive: true }, () => {
      server.close((error) => {
        if (error) reject(error);
        else resolve(true);
      });
    });
  });
}

async function defaultOpen(url) {
  await new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/open", [url], {
      detached: false,
      shell: false,
      stdio: "ignore",
      env: safeEnvironment(),
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      if (exitCode === 0) resolve();
      else reject(previewError(
        "PI_PREVIEW_OPEN_FAILED",
        "无法打开本地预览",
        { exitCode },
      ));
    });
  });
}

function defaultKill(child, signal) {
  if (
    process.platform !== "win32"
    && Number.isInteger(child.pid)
    && child.pid > 0
  ) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (error?.code === "ESRCH") return;
    }
  }
  child.kill?.(signal);
}

async function findPython(projectRoot, accessImpl) {
  for (const relative of [".venv/bin/python", "venv/bin/python"]) {
    const candidate = path.join(projectRoot, relative);
    try {
      await accessImpl(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Only the two project-local virtual environments are eligible.
    }
  }
  throw previewError(
    "PI_PREVIEW_PYTHON_NOT_FOUND",
    "项目中未找到可用的 Python 虚拟环境",
  );
}

async function findVite(projectRoot, accessImpl, realpathImpl) {
  const candidate = path.join(projectRoot, "node_modules", ".bin", "vite");
  try {
    await accessImpl(candidate, fsConstants.X_OK);
    const canonical = await realpathImpl(candidate);
    if (!isInside(projectRoot, canonical)) throw new Error("outside project");
    return canonical;
  } catch {
    throw previewError(
      "PI_PREVIEW_VITE_NOT_FOUND",
      "项目中未找到已安装的 Vite",
    );
  }
}

function validateRequest(key, request) {
  if (typeof key !== "string" || !key.trim()) {
    throw previewError("PI_PREVIEW_KEY_INVALID", "预览标识无效");
  }
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw previewError("PI_PREVIEW_REQUEST_INVALID", "预览请求无效");
  }
  if (!PREVIEW_RUNTIMES.has(request.runtime)) {
    throw previewError("PI_PREVIEW_RUNTIME_UNSUPPORTED", "不支持该预览运行方式");
  }
  const cwd = request.cwd ?? ".";
  if (
    typeof cwd !== "string"
    || !cwd.trim()
    || path.isAbsolute(cwd)
    || cwd.includes("\0")
  ) {
    throw previewError("PI_PREVIEW_CWD_INVALID", "预览工作目录无效");
  }
  if (
    request.runtime === "python_uvicorn"
    && (typeof request.app !== "string" || !APP_PATTERN.test(request.app))
  ) {
    throw previewError("PI_PREVIEW_APP_INVALID", "Uvicorn 应用入口无效");
  }
  if (
    request.runtime !== "python_uvicorn"
    && request.app != null
  ) {
    throw previewError("PI_PREVIEW_APP_INVALID", "该预览方式不接受应用入口");
  }
  const route = request.route ?? "/";
  if (typeof route !== "string" || !ROUTE_PATTERN.test(route)) {
    throw previewError("PI_PREVIEW_ROUTE_INVALID", "预览地址路径无效");
  }
  const title = request.title ?? "本地预览";
  if (
    typeof title !== "string"
    || !title.trim()
    || title.length > 120
    || /[\r\n\0]/.test(title)
  ) {
    throw previewError("PI_PREVIEW_TITLE_INVALID", "预览标题无效");
  }
  return {
    runtime: request.runtime,
    cwd,
    app: request.runtime === "python_uvicorn" ? request.app : null,
    route,
    title: title.trim(),
  };
}

async function previewCommand({
  normalized,
  canonicalRoot,
  port,
  accessImpl,
  realpathImpl,
}) {
  if (normalized.runtime === "python_uvicorn") {
    return {
      file: await findPython(canonicalRoot, accessImpl),
      args: [
        "-m",
        "uvicorn",
        normalized.app,
        "--host",
        LOOPBACK_HOST,
        "--port",
        String(port),
      ],
    };
  }
  if (normalized.runtime === "vite") {
    return {
      file: await findVite(canonicalRoot, accessImpl, realpathImpl),
      args: [
        "--host",
        LOOPBACK_HOST,
        "--port",
        String(port),
        "--strictPort",
      ],
    };
  }
  return {
    file: process.execPath,
    args: [
      STATIC_PREVIEW_SERVER,
      "--host",
      LOOPBACK_HOST,
      "--port",
      String(port),
    ],
  };
}

async function probeUrl(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
    });
    return Number.isInteger(response?.status)
      && response.status >= 100
      && response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function createProjectPreviewSupervisor({
  spawnImpl = spawn,
  checkPort = defaultCheckPort,
  fetchImpl = globalThis.fetch,
  openImpl = defaultOpen,
  accessImpl = access,
  realpathImpl = realpath,
  killImpl = defaultKill,
  portStart = DEFAULT_PORT_START,
  portEnd = DEFAULT_PORT_END,
  startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
  maxLogBytes = DEFAULT_MAX_LOG_BYTES,
  now = () => Date.now(),
} = {}) {
  if (
    !Number.isInteger(portStart)
    || !Number.isInteger(portEnd)
    || portStart < 1_024
    || portEnd > 65_535
    || portEnd < portStart
  ) {
    throw previewError("PI_PREVIEW_PORT_RANGE_INVALID", "预览端口范围无效");
  }
  if (typeof fetchImpl !== "function") {
    throw previewError("PI_PREVIEW_FETCH_UNAVAILABLE", "当前环境无法检查本地预览");
  }

  const active = new Map();

  const waitForExit = async (record, timeoutMs) => {
    if (record.exited) return true;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        record.exitWaiters.delete(onExit);
        resolve(false);
      }, timeoutMs);
      timer.unref?.();
      const onExit = () => {
        clearTimeout(timer);
        record.exitWaiters.delete(onExit);
        resolve(true);
      };
      record.exitWaiters.add(onExit);
    });
  };

  const stopRecord = async (record) => {
    if (record.exited) return;
    record.stopping = true;
    killImpl(record.child, "SIGTERM");
    if (await waitForExit(record, stopTimeoutMs)) return;
    killImpl(record.child, "SIGKILL");
    await waitForExit(record, stopTimeoutMs);
  };

  const stop = async (key) => {
    const record = active.get(key);
    if (!record) return false;
    if (active.get(key) === record) active.delete(key);
    await stopRecord(record);
    return true;
  };

  const start = async ({ key, projectRoot, request } = {}) => {
    const normalized = validateRequest(key, request);
    if (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot)) {
      throw previewError("PI_PREVIEW_PROJECT_ROOT_INVALID", "项目根目录无效");
    }

    const canonicalRoot = await realpathImpl(projectRoot).catch(() => {
      throw previewError("PI_PREVIEW_PROJECT_ROOT_INVALID", "项目根目录不存在");
    });
    const requestedCwd = path.resolve(canonicalRoot, normalized.cwd);
    const canonicalCwd = await realpathImpl(requestedCwd).catch(() => {
      throw previewError("PI_PREVIEW_CWD_INVALID", "预览工作目录不存在");
    });
    if (!isInside(canonicalRoot, canonicalCwd)) {
      throw previewError("PI_PREVIEW_CWD_OUTSIDE_PROJECT", "预览工作目录必须位于项目内");
    }
    await stop(key);

    let port;
    for (let candidate = portStart; candidate <= portEnd; candidate += 1) {
      if (await checkPort(candidate, LOOPBACK_HOST)) {
        port = candidate;
        break;
      }
    }
    if (!port) {
      throw previewError("PI_PREVIEW_PORT_UNAVAILABLE", "没有可用的本地预览端口");
    }

    const startedAt = new Date(now()).toISOString();
    const url = `http://${LOOPBACK_HOST}:${port}${normalized.route}`;
    const command = await previewCommand({
      normalized,
      canonicalRoot,
      port,
      accessImpl,
      realpathImpl,
    });
    let child;
    try {
      child = spawnImpl(
        command.file,
        command.args,
        {
          cwd: canonicalCwd,
          detached: true,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          env: safeEnvironment(),
        },
      );
    } catch (error) {
      throw previewError("PI_PREVIEW_SPAWN_FAILED", "无法启动本地预览", {
        cause: error?.message,
      });
    }

    const record = {
      key,
      child,
      ownershipToken: Symbol(`preview:${key}`),
      status: "starting",
      url,
      origin: new URL(url).origin,
      title: normalized.title,
      runtime: normalized.runtime,
      route: normalized.route,
      startedAt,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      logsTruncated: false,
      exited: false,
      stopping: false,
      spawnError: null,
      exitCode: null,
      exitSignal: null,
      exitWaiters: new Set(),
    };
    active.set(key, record);

    child.stdout?.on("data", (chunk) => {
      appendBoundedLog(record, "stdout", chunk, maxLogBytes);
    });
    child.stderr?.on("data", (chunk) => {
      appendBoundedLog(record, "stderr", chunk, maxLogBytes);
    });

    const markExited = ({ error, exitCode, exitSignal } = {}) => {
      if (record.exited) return;
      record.exited = true;
      record.spawnError = error ?? null;
      record.exitCode = exitCode ?? null;
      record.exitSignal = exitSignal ?? null;
      for (const notify of [...record.exitWaiters]) notify();
      if (active.get(key) === record) active.delete(key);
    };
    child.once("error", (error) => markExited({ error }));
    child.once("close", (exitCode, exitSignal) => {
      markExited({ exitCode, exitSignal });
    });

    try {
      const deadline = now() + startupTimeoutMs;
      let healthy = false;
      const throwIfExited = () => {
        if (!record.exited) return;
        throw previewError(
          "PI_PREVIEW_PROCESS_EXITED",
          "本地预览在就绪前退出",
          {
            ...sanitizedLogs(record),
            exitCode: record.exitCode,
            signal: record.exitSignal,
            cause: record.spawnError?.message,
          },
        );
      };
      while (now() <= deadline) {
        throwIfExited();
        if (await probeUrl(fetchImpl, url, probeTimeoutMs)) {
          healthy = true;
          break;
        }
        throwIfExited();
        await delay(pollIntervalMs);
      }
      throwIfExited();
      if (!healthy) {
        throw previewError(
          "PI_PREVIEW_START_TIMEOUT",
          "等待本地预览就绪超时",
          sanitizedLogs(record),
        );
      }

      await openImpl(url);
      const openedAt = new Date(now()).toISOString();
      record.status = "ready";
      record.openedAt = openedAt;
      return {
        status: "ready",
        url,
        title: normalized.title,
        runtime: normalized.runtime,
        cwd: normalized.cwd,
        app: normalized.app,
        route: normalized.route,
        startedAt,
        openedAt,
      };
    } catch (error) {
      if (active.get(key) === record) active.delete(key);
      await stopRecord(record);
      if (error?.code) throw error;
      throw previewError("PI_PREVIEW_START_FAILED", "无法启动本地预览", {
        ...sanitizedLogs(record),
        cause: error?.message,
      });
    }
  };

  const dispose = async () => {
    const records = [...active.values()];
    active.clear();
    await Promise.all(records.map((record) => stopRecord(record)));
  };

  return {
    start,
    stop,
    has: (key) => active.has(key),
    getOwnedPreview: (key) => {
      const record = active.get(key);
      if (!record || record.exited || record.status !== "ready") return null;
      return Object.freeze({
        key: record.key,
        ownershipToken: record.ownershipToken,
        url: record.url,
        origin: record.origin,
        title: record.title,
        runtime: record.runtime,
        route: record.route,
        startedAt: record.startedAt,
        openedAt: record.openedAt,
      });
    },
    dispose,
  };
}
