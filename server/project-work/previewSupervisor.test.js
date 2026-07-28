import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  chmod,
  mkdtemp,
  mkdir,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createProjectPreviewSupervisor } from "./previewSupervisor.js";

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  return child;
}

async function makeProject() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-preview-"));
  await mkdir(path.join(root, ".venv", "bin"), { recursive: true });
  await mkdir(path.join(root, "backend"), { recursive: true });
  await writeFile(path.join(root, ".venv", "bin", "python"), "");
  await chmod(path.join(root, ".venv", "bin", "python"), 0o700);
  return root;
}

test("preview supervisor starts project-local uvicorn without a shell and opens the exact loopback URL", async () => {
  const root = await makeProject();
  const spawnCalls = [];
  const checkedPorts = [];
  const opened = [];
  const child = fakeChild(41001);
  let clock = Date.UTC(2026, 6, 27, 1, 2, 3);
  const supervisor = createProjectPreviewSupervisor({
    portStart: 48_080,
    portEnd: 48_082,
    now: () => {
      clock += 1;
      return clock;
    },
    checkPort: async (port, host) => {
      checkedPorts.push({ port, host });
      return port === 48_081;
    },
    spawnImpl: (file, args, options) => {
      spawnCalls.push({ file, args, options });
      return child;
    },
    fetchImpl: async (url, options) => {
      assert.equal(url, "http://127.0.0.1:48081/reader/");
      assert.equal(options.method, "GET");
      return { status: 200 };
    },
    openImpl: async (url) => opened.push(url),
  });

  const result = await supervisor.start({
    key: "conversation-1",
    projectRoot: root,
    request: {
      runtime: "python_uvicorn",
      cwd: "backend",
      app: "app.main:app",
      route: "/reader/",
      title: "读者端",
    },
  });

  assert.deepEqual(checkedPorts, [
    { port: 48_080, host: "127.0.0.1" },
    { port: 48_081, host: "127.0.0.1" },
  ]);
  const canonicalRoot = await realpath(root);
  assert.equal(spawnCalls.length, 1);
  assert.equal(
    spawnCalls[0].file,
    path.join(canonicalRoot, ".venv", "bin", "python"),
  );
  assert.deepEqual(spawnCalls[0].args, [
    "-m",
    "uvicorn",
    "app.main:app",
    "--host",
    "127.0.0.1",
    "--port",
    "48081",
  ]);
  assert.equal(spawnCalls[0].options.cwd, path.join(canonicalRoot, "backend"));
  assert.equal(spawnCalls[0].options.shell, false);
  assert.equal(spawnCalls[0].options.detached, true);
  assert.deepEqual(spawnCalls[0].options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(spawnCalls[0].options.env.PI_DEEPSEEK_API_KEY, undefined);
  assert.equal(spawnCalls[0].options.env.OPENAI_API_KEY, undefined);
  assert.equal(spawnCalls[0].options.env.PYTHONUNBUFFERED, "1");
  assert.equal(spawnCalls[0].args.includes("--reload"), false);
  assert.deepEqual(opened, ["http://127.0.0.1:48081/reader/"]);
  assert.equal(result.status, "ready");
  assert.equal(result.url, "http://127.0.0.1:48081/reader/");
  assert.equal(result.runtime, "python_uvicorn");
  assert.equal(result.cwd, "backend");
  assert.equal(result.app, "app.main:app");
  assert.equal(result.route, "/reader/");

  child.emit("close", 0, null);
  await supervisor.dispose();
});

test("preview supervisor supports installed Vite and the bundled static recipe", async () => {
  const root = await makeProject();
  await mkdir(path.join(root, "node_modules", ".bin"), { recursive: true });
  await mkdir(path.join(root, "node_modules", "vite", "bin"), { recursive: true });
  const viteTarget = path.join(root, "node_modules", "vite", "bin", "vite.js");
  await writeFile(viteTarget, "");
  await chmod(viteTarget, 0o700);
  await symlink(
    path.relative(path.join(root, "node_modules", ".bin"), viteTarget),
    path.join(root, "node_modules", ".bin", "vite"),
  );
  const children = [fakeChild(41_101), fakeChild(41_102)];
  const spawnCalls = [];
  const supervisor = createProjectPreviewSupervisor({
    portStart: 48_090,
    portEnd: 48_091,
    checkPort: async () => true,
    spawnImpl: (file, args, options) => {
      spawnCalls.push({ file, args, options });
      return children[spawnCalls.length - 1];
    },
    fetchImpl: async () => ({ status: 200 }),
    openImpl: async () => {},
    killImpl: (child, signal) => {
      queueMicrotask(() => child.emit("close", null, signal));
    },
  });

  const vite = await supervisor.start({
    key: "vite",
    projectRoot: root,
    request: {
      runtime: "vite",
      cwd: ".",
      route: "/",
      title: "Vite 预览",
    },
  });
  const staticResult = await supervisor.start({
    key: "static",
    projectRoot: root,
    request: {
      runtime: "static",
      cwd: ".",
      route: "/",
      title: "静态预览",
    },
  });

  assert.equal(vite.runtime, "vite");
  assert.equal(spawnCalls[0].file, await realpath(viteTarget));
  assert.deepEqual(spawnCalls[0].args, [
    "--host",
    "127.0.0.1",
    "--port",
    "48090",
    "--strictPort",
  ]);
  assert.equal(staticResult.runtime, "static");
  assert.equal(spawnCalls[1].file, process.execPath);
  assert.match(spawnCalls[1].args[0], /staticPreviewServer\.js$/);
  assert.deepEqual(spawnCalls[1].args.slice(1), [
    "--host",
    "127.0.0.1",
    "--port",
    "48090",
  ]);
  assert.equal(spawnCalls.every((call) => call.options.shell === false), true);
  await supervisor.dispose();
});

test("preview supervisor rejects malformed recipes and a cwd symlink outside the project", async () => {
  const root = await makeProject();
  const outside = await mkdtemp(path.join(os.tmpdir(), "pi-preview-outside-"));
  await symlink(outside, path.join(root, "escaped"));
  let spawned = false;
  const supervisor = createProjectPreviewSupervisor({
    spawnImpl: () => {
      spawned = true;
      return fakeChild(41002);
    },
    checkPort: async () => true,
    fetchImpl: async () => ({ status: 200 }),
    openImpl: async () => {},
  });

  await assert.rejects(
    supervisor.start({
      key: "bad-app",
      projectRoot: root,
      request: {
        runtime: "python_uvicorn",
        cwd: "backend",
        app: "app.main:app()",
        route: "/",
      },
    }),
    { code: "PI_PREVIEW_APP_INVALID" },
  );
  await assert.rejects(
    supervisor.start({
      key: "bad-route",
      projectRoot: root,
      request: {
        runtime: "python_uvicorn",
        cwd: "backend",
        app: "app.main:app",
        route: "https://example.com/",
      },
    }),
    { code: "PI_PREVIEW_ROUTE_INVALID" },
  );
  await assert.rejects(
    supervisor.start({
      key: "escaped-cwd",
      projectRoot: root,
      request: {
        runtime: "python_uvicorn",
        cwd: "escaped",
        app: "app.main:app",
        route: "/",
      },
    }),
    { code: "PI_PREVIEW_CWD_OUTSIDE_PROJECT" },
  );
  assert.equal(spawned, false);
  await supervisor.dispose();
});

test("preview supervisor replaces and disposes only its own tracked child groups", async () => {
  const root = await makeProject();
  const children = [fakeChild(42001), fakeChild(42002), fakeChild(42003)];
  const signals = [];
  let spawnIndex = 0;
  const supervisor = createProjectPreviewSupervisor({
    stopTimeoutMs: 5,
    spawnImpl: () => children[spawnIndex++],
    checkPort: async () => true,
    fetchImpl: async () => ({ status: 204 }),
    openImpl: async () => {},
    killImpl: (child, signal) => {
      signals.push({ pid: child.pid, signal });
      queueMicrotask(() => child.emit("close", null, signal));
    },
  });
  const recipe = {
    runtime: "python_uvicorn",
    cwd: "backend",
    app: "app.main:app",
    route: "/",
  };

  await supervisor.start({ key: "same", projectRoot: root, request: recipe });
  await supervisor.start({ key: "same", projectRoot: root, request: recipe });
  await supervisor.start({ key: "other", projectRoot: root, request: recipe });
  assert.deepEqual(signals, [{ pid: 42001, signal: "SIGTERM" }]);

  assert.equal(await supervisor.stop("not-owned"), false);
  await supervisor.dispose();
  assert.deepEqual(signals, [
    { pid: 42001, signal: "SIGTERM" },
    { pid: 42002, signal: "SIGTERM" },
    { pid: 42003, signal: "SIGTERM" },
  ]);
});

test("preview supervisor reports bounded startup logs and stops a failed child", async () => {
  const root = await makeProject();
  const child = fakeChild(43001);
  const signals = [];
  let clock = 0;
  const supervisor = createProjectPreviewSupervisor({
    maxLogBytes: 8,
    startupTimeoutMs: 3,
    pollIntervalMs: 1,
    now: () => {
      clock += 2;
      return clock;
    },
    spawnImpl: () => {
      queueMicrotask(() => {
        child.stderr.write("0123456789abcdef");
        child.emit("close", 1, null);
      });
      return child;
    },
    checkPort: async () => true,
    fetchImpl: async () => {
      throw new Error("not ready");
    },
    openImpl: async () => {
      throw new Error("must not open");
    },
    killImpl: (ownedChild, signal) => {
      signals.push({ pid: ownedChild.pid, signal });
      queueMicrotask(() => ownedChild.emit("close", null, signal));
    },
  });

  await assert.rejects(
    supervisor.start({
      key: "failed",
      projectRoot: root,
      request: {
        runtime: "python_uvicorn",
        cwd: "backend",
        app: "app.main:app",
        route: "/",
      },
    }),
    (error) => {
      assert.equal(error.code, "PI_PREVIEW_PROCESS_EXITED");
      assert.equal(error.details.stderr, "01234567");
      assert.equal(error.details.truncated, true);
      return true;
    },
  );
  assert.deepEqual(signals, []);
  await supervisor.dispose();
});
