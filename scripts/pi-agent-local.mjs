import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const WEB_HOST = "127.0.0.1";
const configuredWebPort = Number(process.env.PI_LOCAL_WEB_PORT);
export const WEB_PORT = Number.isInteger(configuredWebPort)
  && configuredWebPort >= 1_024
  && configuredWebPort <= 65_535
  ? configuredWebPort
  : 4_173;
export const WEB_URL = `http://${WEB_HOST}:${WEB_PORT}/`;
export const API_PORT_START = 47_880;
export const API_PORT_END = 47_919;
export const RUNTIME_PORT_START = 47_920;
export const RUNTIME_PORT_END = 47_959;

export function localServiceEnvironment(extraEnv = {}, webUrl = WEB_URL) {
  return {
    ...extraEnv,
    PI_LOCAL_WEB_URL: webUrl,
    PI_NOTIFICATION_RETURN_ENTRY_URL: webUrl,
  };
}

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const appMarker = '<meta name="pi-agent-app" content="pi-agent-local"';

export function isPiAgentHtml(html) {
  return typeof html === "string"
    && html.includes(appMarker)
    && /<title>\s*Pi Agent\s*<\/title>/i.test(html);
}

export function isPiAgentHealth(health) {
  return health?.status === "ok"
    && health?.journal_workflow === "available"
    && health?.project_work === "available";
}

export function isPiRuntimeHealth(health) {
  return health?.status === "ok"
    && health?.project_work === "available"
    && health?.runtime_role === "worker";
}

export async function isPortAvailable(port, host = WEB_HOST) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

export async function chooseApiPort({
  start = API_PORT_START,
  end = API_PORT_END,
  check = isPortAvailable,
} = {}) {
  for (let port = start; port <= end; port += 1) {
    if (await check(port)) return port;
  }
  throw new Error(`内部端口 ${start}-${end} 均被占用`);
}

async function fetchWithTimeout(url, type, timeoutMs = 900) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return type === "json" ? response.json() : response.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function probePiAgent(url = WEB_URL) {
  const [html, health] = await Promise.all([
    fetchWithTimeout(url, "text"),
    fetchWithTimeout(new URL("/api/v1/health", url), "json"),
  ]);
  return isPiAgentHtml(html) && isPiAgentHealth(health);
}

async function waitUntil(
  label,
  check,
  child,
  shouldStop,
  timeoutMs = 15_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (shouldStop()) throw new Error("启动已取消");
    if (child.startError) {
      throw new Error(`${label} 无法启动：${child.startError.message}`);
    }
    if (child.exitCode !== null) {
      throw new Error(`${label} 已提前退出（退出码 ${child.exitCode}）`);
    }
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`${label} 启动超时`);
}

function startChild(args, extraEnv = {}) {
  const child = spawn(process.execPath, args, {
    cwd: projectRoot,
    detached: true,
    env: {
      ...process.env,
      ...extraEnv,
    },
    stdio: "inherit",
  });
  child.startError = null;
  child.once("error", (error) => {
    child.startError = error;
  });
  return child;
}

async function stopChildGroup(child) {
  if (!child?.pid || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
    return;
  }
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
}

function openWebsite() {
  if (process.env.PI_LOCAL_NO_OPEN === "1") return;
  const opener = spawn("/usr/bin/open", [WEB_URL], {
    detached: true,
    stdio: "ignore",
  });
  opener.unref();
}

async function run() {
  if (!(await isPortAvailable(WEB_PORT))) {
    if (await probePiAgent()) {
      console.log(`Pi Agent 已经在运行：${WEB_URL}`);
      openWebsite();
      return;
    }
    throw new Error(
      `端口 ${WEB_PORT} 已被其他或无响应的进程占用。Pi Agent 不会打开或停止未知服务。`,
    );
  }

  const runtimePort = await chooseApiPort({
    start: RUNTIME_PORT_START,
    end: RUNTIME_PORT_END,
  });
  let apiProcess = null;
  let runtimeProcess = null;
  let webProcess = null;
  let stopping = false;
  let stopSignal = null;
  let requestStop;
  const stopRequested = new Promise((resolve) => {
    requestStop = (signal) => {
      if (stopSignal) return;
      stopSignal = signal;
      resolve({ kind: "signal", signal });
    };
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(signal, () => requestStop(signal));
  }

  const cleanup = async () => {
    if (stopping) return;
    stopping = true;
    console.log("\n正在关闭 Pi Agent…");
    await Promise.allSettled([
      stopChildGroup(webProcess),
      stopChildGroup(apiProcess),
      stopChildGroup(runtimeProcess),
    ]);
    console.log("Pi Agent 已关闭，端口已经释放。");
  };

  try {
    console.log(`正在启动 Pi Runtime（内部端口 ${runtimePort}）…`);
    runtimeProcess = startChild(
      [
        "--env-file-if-exists=.env.local",
        "server/index.js",
      ],
      localServiceEnvironment({
        PI_API_PORT: String(runtimePort),
        PI_PROJECT_WORK_RUNTIME_ONLY: "1",
      }),
    );
    await waitUntil(
      "Pi Runtime",
      async () => isPiRuntimeHealth(
        await fetchWithTimeout(
          `http://${WEB_HOST}:${runtimePort}/api/v1/health`,
          "json",
        ),
      ),
      runtimeProcess,
      () => Boolean(stopSignal),
    );

    const apiPort = await chooseApiPort();
    console.log(`正在启动 Pi Agent API（内部端口 ${apiPort}）…`);
    const startApi = async () => {
      apiProcess = startChild(
        [
          "--env-file-if-exists=.env.local",
          "server/index.js",
        ],
        localServiceEnvironment({
          PI_API_PORT: String(apiPort),
          PI_PROJECT_WORK_RUNTIME_URL: `http://${WEB_HOST}:${runtimePort}`,
        }),
      );
      await waitUntil(
        "Pi Agent API",
        async () => isPiAgentHealth(
          await fetchWithTimeout(
            `http://${WEB_HOST}:${apiPort}/api/v1/health`,
            "json",
          ),
        ),
        apiProcess,
        () => Boolean(stopSignal),
      );
    };
    await startApi();

    const superviseApi = async () => {
      while (!stopping && !stopSignal) {
        const watchedProcess = apiProcess;
        const [code, signal] = await once(watchedProcess, "exit");
        if (stopping || stopSignal || watchedProcess !== apiProcess) return;
        console.warn(
          `Pi Agent API 已退出（${signal ?? `退出码 ${code}`}），正在连接保留中的 Pi Runtime 并重启 API…`,
        );
        await startApi();
      }
    };

    console.log(`正在启动 Pi Agent 网页（固定端口 ${WEB_PORT}）…`);
    webProcess = startChild(
      [
        "node_modules/vite/bin/vite.js",
        "--host",
        WEB_HOST,
        "--port",
        String(WEB_PORT),
        "--strictPort",
      ],
      { PI_API_TARGET: `http://${WEB_HOST}:${apiPort}` },
    );
    await waitUntil(
      "Pi Agent 网页",
      () => probePiAgent(),
      webProcess,
      () => Boolean(stopSignal),
    );

    console.log(`\nPi Agent 已启动：${WEB_URL}`);
    console.log("关闭这个终端窗口，或按 Control+C，即可关闭 Pi Agent。");
    openWebsite();

    const result = await Promise.race([
      stopRequested,
      superviseApi(),
      once(runtimeProcess, "exit").then(([code, signal]) => ({
        kind: "child",
        name: "Pi Runtime",
        code,
        signal,
      })),
      once(webProcess, "exit").then(([code, signal]) => ({
        kind: "child",
        name: "网页",
        code,
        signal,
      })),
    ]);
    if (result.kind === "child") {
      throw new Error(
        `${result.name} 服务意外退出（${result.signal ?? `退出码 ${result.code}`}）`,
      );
    }
  } finally {
    await cleanup();
  }
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  run().catch((error) => {
    console.error(`\nPi Agent 启动失败：${error.message}`);
    process.exitCode = 1;
  });
}
