import { spawn } from "node:child_process";
import path from "node:path";
import { projectWorkError } from "./errors.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 128 * 1024;
const MACOS_SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const MACOS_SANDBOX_PROFILE_ID = "pi-agent-verification.v1";
const TRUNCATION_MARKER = Buffer.from(
  "\n… 验证输出达到安全采集上限；以下保留末尾诊断内容 …\n",
);
const SAFE_RECIPE_ENVIRONMENT = Object.freeze({
  CARGO_NET_OFFLINE: "true",
  GOPROXY: "off",
  GOSUMDB: "off",
  GOTOOLCHAIN: "local",
  GRADLE_OPTS: "-Dorg.gradle.offline=true",
  PIP_DISABLE_PIP_VERSION_CHECK: "1",
  PIP_NO_INDEX: "1",
});
const SAFE_VERIFICATION_EXECUTABLE_FAMILIES = Object.freeze({
  bun: "node",
  cargo: "rust",
  go: "go",
  gradle: "android",
  gradlew: "android",
  node: "node",
  npm: "node",
  pnpm: "node",
  python3: "python",
  swift: "swift",
  yarn: "node",
});
const MACOS_SYSTEM_READ_ONLY_ROOTS = Object.freeze([
  "/System",
  "/bin",
  "/sbin",
  "/usr/bin",
  "/usr/sbin",
  "/usr/lib",
  "/usr/libexec",
  "/usr/share",
  "/private/etc",
  "/private/var/db/dyld",
  "/private/var/select",
  "/Library/Apple",
]);
const MACOS_FIXED_TOOLCHAIN_READ_ONLY_ROOTS = Object.freeze([
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/opt/homebrew/lib",
  "/opt/homebrew/libexec",
  "/opt/homebrew/share",
  "/opt/homebrew/Cellar",
  "/opt/homebrew/opt",
  "/opt/local/bin",
  "/opt/local/sbin",
  "/opt/local/lib",
  "/opt/local/libexec",
  "/opt/local/share",
  "/usr/local/bin",
  "/usr/local/sbin",
  "/usr/local/lib",
  "/usr/local/share",
  "/usr/local/Cellar",
  "/usr/local/opt",
  "/usr/local/go",
]);
const MACOS_EXECUTABLE_PATHS = Object.freeze([
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/usr/local/sbin",
  "/opt/local/bin",
  "/opt/local/sbin",
  "/System/Cryptexes/App/usr/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
  "/Applications/Xcode.app/Contents/Developer/usr/bin",
  "/Library/Developer/CommandLineTools/usr/bin",
]);
const MACOS_FAMILY_READ_ONLY_ROOTS = Object.freeze({
  android: Object.freeze([
    "/Applications/Android Studio.app/Contents/jbr",
    "/Library/Java/JavaVirtualMachines",
  ]),
  go: Object.freeze([]),
  node: Object.freeze([]),
  python: Object.freeze([]),
  rust: Object.freeze([]),
  swift: Object.freeze([
    "/Applications/Xcode.app/Contents/Developer",
    "/Library/Developer/CommandLineTools",
  ]),
});
const MACOS_DEVICE_READ_PATHS = Object.freeze([
  "/dev/null",
  "/dev/random",
  "/dev/urandom",
]);
const UNSAFE_SANDBOX_ROOTS = new Set([
  "/",
  "/Applications",
  "/Library",
  "/System",
  "/Users",
  "/private",
  "/private/tmp",
  "/private/var",
  "/tmp",
  "/usr",
  "/var",
]);

function createBoundedOutput() {
  return {
    complete: Buffer.alloc(0),
    head: Buffer.alloc(0),
    tail: Buffer.alloc(0),
    truncated: false,
    maxBytes: null,
  };
}

function appendBoundedOutput(state, chunk, maxBytes) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  if (!state.truncated) {
    const combined = Buffer.concat([state.complete, buffer]);
    if (combined.length <= maxBytes) {
      state.complete = combined;
      return;
    }
    const evidenceBytes = Math.max(0, maxBytes - TRUNCATION_MARKER.length);
    const headBytes = Math.ceil(evidenceBytes / 2);
    const tailBytes = evidenceBytes - headBytes;
    state.complete = Buffer.alloc(0);
    state.head = combined.subarray(0, headBytes);
    state.tail = combined.subarray(Math.max(0, combined.length - tailBytes));
    state.truncated = true;
    state.maxBytes = maxBytes;
    return;
  }
  const tailBytes = Math.max(
    0,
    maxBytes - TRUNCATION_MARKER.length - state.head.length,
  );
  state.tail = tailBytes > 0
    ? Buffer.concat([state.tail, buffer]).subarray(-tailBytes)
    : Buffer.alloc(0);
}

function boundedOutputBuffer(state) {
  if (!state.truncated) return state.complete;
  return Buffer.concat([state.head, TRUNCATION_MARKER, state.tail])
    .subarray(0, state.maxBytes);
}

function safeEnvironment(source, executablePath) {
  return {
    PATH: executablePath,
    ...Object.fromEntries(
      ["LANG", "LC_ALL"].flatMap((name) => (
        typeof source?.[name] === "string" ? [[name, source[name]]] : []
      )),
    ),
  };
}

function sandboxPath(value) {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("\"", "\\\"");
}

export function macOSVerificationSandboxProfile({
  workspaceRoot,
  temporaryDirectory,
  file,
  pathValue,
} = {}) {
  const layout = normalizeSandboxLayout({
    workspaceRoot,
    temporaryDirectory,
  });
  const execution = macOSExecutionPolicy({ file, pathValue });
  return buildMacOSVerificationSandboxProfile({
    ...layout,
    readOnlyRoots: execution.readOnlyRoots,
  });
}

function buildMacOSVerificationSandboxProfile({
  workspaceRoot,
  temporaryDirectory,
  readOnlyRoots,
}) {
  const subpaths = [
    workspaceRoot,
    temporaryDirectory,
    ...MACOS_SYSTEM_READ_ONLY_ROOTS,
    ...MACOS_FIXED_TOOLCHAIN_READ_ONLY_ROOTS,
    ...readOnlyRoots,
  ].filter((value, index, values) => values.indexOf(value) === index);
  const readRules = [
    ...subpaths.map(
      (value) => `  (subpath "${sandboxPath(value)}")`,
    ),
    ...MACOS_DEVICE_READ_PATHS.map(
      (value) => `  (literal "${sandboxPath(value)}")`,
    ),
  ];
  return [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    '(allow file-read-data (literal "/"))',
    "(allow file-read*",
    ...readRules,
    ")",
    "(allow sysctl-read)",
    `(allow file-write* (subpath "${sandboxPath(workspaceRoot)}") (subpath "${sandboxPath(temporaryDirectory)}"))`,
    "(deny network*)",
  ].join("\n");
}

function pathIsAbsolute(value) {
  return typeof value === "string" && path.posix.isAbsolute(value);
}

function normalizedAbsolutePath(value) {
  if (
    !pathIsAbsolute(value)
    || /[\u0000-\u001f\u007f]/.test(value)
    || value.split("/").some((segment) => segment === "..")
  ) {
    return null;
  }
  return path.posix.normalize(value);
}

function pathWithin(root, candidate) {
  const relative = path.posix.relative(root, candidate);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith("../")
    && !path.posix.isAbsolute(relative)
  );
}

function unsafePrivateRoot(value) {
  return (
    UNSAFE_SANDBOX_ROOTS.has(value)
    || /^\/Users\/[^/]+$/.test(value)
  );
}

function normalizeSandboxLayout({ workspaceRoot, temporaryDirectory }) {
  const normalizedWorkspace = normalizedAbsolutePath(workspaceRoot);
  const normalizedTemporary = normalizedAbsolutePath(temporaryDirectory);
  if (
    !normalizedWorkspace
    || !normalizedTemporary
    || unsafePrivateRoot(normalizedWorkspace)
    || unsafePrivateRoot(normalizedTemporary)
  ) {
    throw projectWorkError(
      "PROJECT_WORK_VERIFICATION_SANDBOX_INVALID",
      "受控验证缺少独立工作区或临时目录",
      500,
    );
  }
  const privateContainer = path.posix.dirname(normalizedWorkspace);
  if (
    normalizedTemporary === privateContainer
    || !pathWithin(privateContainer, normalizedTemporary)
  ) {
    throw projectWorkError(
      "PROJECT_WORK_VERIFICATION_SANDBOX_INVALID",
      "验证临时目录必须位于同一私有运行目录",
      500,
    );
  }
  return {
    workspaceRoot: normalizedWorkspace,
    temporaryDirectory: normalizedTemporary,
  };
}

function verificationExecutableFamily(file) {
  if (typeof file !== "string" || !file) {
    throw projectWorkError(
      "PROJECT_WORK_VERIFICATION_COMMAND_INVALID",
      "验证命令无效",
      400,
    );
  }
  const workspaceRelative = file === "./gradlew";
  const absolute = path.posix.isAbsolute(file);
  if (
    (!absolute && !workspaceRelative && path.posix.basename(file) !== file)
    || /[\u0000-\u001f\u007f]/.test(file)
  ) {
    throw projectWorkError(
      "PROJECT_WORK_VERIFICATION_COMMAND_INVALID",
      "验证命令必须来自已注册的工具链",
      400,
    );
  }
  const executable = path.posix.basename(file);
  const family = SAFE_VERIFICATION_EXECUTABLE_FAMILIES[executable];
  if (!family) {
    throw projectWorkError(
      "PROJECT_WORK_VERIFICATION_COMMAND_INVALID",
      "验证命令必须来自已注册的工具链",
      400,
    );
  }
  return { absolute, executable, family, workspaceRelative };
}

function dynamicToolchainPath(entry, family) {
  const normalized = normalizedAbsolutePath(entry);
  if (!normalized) return null;
  const patterns = {
    android: [
      /^(\/Users\/[^/]+\/\.sdkman\/candidates\/(?:gradle|java)\/[^/]+)\/bin$/,
    ],
    go: [
      /^(\/Users\/[^/]+\/sdk\/go[^/]+)\/bin$/,
    ],
    node: [
      /^(\/Users\/[^/]+\/\.nvm\/versions\/node\/[^/]+)\/bin$/,
      /^(\/Users\/[^/]+\/\.bun)\/bin$/,
    ],
    python: [
      /^(\/Users\/[^/]+\/\.pyenv\/versions\/[^/]+)\/bin$/,
    ],
    rust: [
      /^(\/Users\/[^/]+)\/\.cargo\/bin$/,
    ],
    swift: [],
  };
  for (const pattern of patterns[family] ?? []) {
    const match = normalized.match(pattern);
    if (!match) continue;
    if (family === "rust") {
      return {
        executablePath: normalized,
        readOnlyRoots: [
          `${match[1]}/.cargo/bin`,
          `${match[1]}/.rustup/toolchains`,
        ],
      };
    }
    return {
      executablePath: normalized,
      readOnlyRoots: [match[1]],
    };
  }
  return null;
}

function macOSExecutionPolicy({ file, pathValue }) {
  const command = verificationExecutableFamily(file);
  const readOnlyRoots = [
    ...(MACOS_FAMILY_READ_ONLY_ROOTS[command.family] ?? []),
  ];
  const allowedPathEntries = [];
  for (const entry of String(pathValue ?? "").split(":")) {
    const normalized = normalizedAbsolutePath(entry);
    if (!normalized) continue;
    if (MACOS_EXECUTABLE_PATHS.includes(normalized)) {
      allowedPathEntries.push(normalized);
      continue;
    }
    const dynamic = dynamicToolchainPath(normalized, command.family);
    if (!dynamic) continue;
    allowedPathEntries.push(dynamic.executablePath);
    readOnlyRoots.push(...dynamic.readOnlyRoots);
  }
  for (const entry of MACOS_EXECUTABLE_PATHS) {
    if (!allowedPathEntries.includes(entry)) allowedPathEntries.push(entry);
  }
  return {
    ...command,
    executablePath: allowedPathEntries.join(":"),
    readOnlyRoots: readOnlyRoots.filter(
      (value, index, values) => values.indexOf(value) === index,
    ),
  };
}

function normalizeExecutableFile(file, workspaceRoot, cwd, execution) {
  if (execution.workspaceRelative) {
    const candidate = path.posix.resolve(cwd, execution.executable);
    if (!pathWithin(workspaceRoot, candidate)) {
      throw projectWorkError(
        "PROJECT_WORK_VERIFICATION_COMMAND_INVALID",
        "项目验证包装器不在受控工作区内",
        400,
      );
    }
    return candidate;
  }
  if (!execution.absolute) return execution.executable;
  const normalized = normalizedAbsolutePath(file);
  const allowedRoots = [
    workspaceRoot,
    ...MACOS_SYSTEM_READ_ONLY_ROOTS,
    ...MACOS_FIXED_TOOLCHAIN_READ_ONLY_ROOTS,
    ...execution.readOnlyRoots,
  ];
  if (
    !normalized
    || !allowedRoots.some((root) => pathWithin(root, normalized))
  ) {
    throw projectWorkError(
      "PROJECT_WORK_VERIFICATION_COMMAND_INVALID",
      "验证命令不在受控工作区或已知工具链中",
      400,
    );
  }
  return normalized;
}

function normalizeRecipeEnvironment(value) {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw projectWorkError(
      "PROJECT_WORK_VERIFICATION_ENVIRONMENT_BLOCKED",
      "验证环境必须来自服务端配方",
      400,
    );
  }
  const entries = Object.entries(value);
  if (entries.some(([name, setting]) => (
    SAFE_RECIPE_ENVIRONMENT[name] !== setting
  ))) {
    throw projectWorkError(
      "PROJECT_WORK_VERIFICATION_ENVIRONMENT_BLOCKED",
      "验证环境包含未注册的设置",
      400,
    );
  }
  return Object.fromEntries(entries);
}

function killProcessTree(child, signal) {
  if (
    process.platform !== "win32"
    && Number.isInteger(child.pid)
    && child.pid > 0
  ) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (error?.code !== "ESRCH") {
        child.kill(signal);
      }
      return;
    }
  }
  child.kill(signal);
}

export function createVerificationRunner({
  spawnImpl = spawn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  now = () => Date.now(),
  platform = process.platform,
  sandboxExecPath = MACOS_SANDBOX_EXEC,
  baseEnvironment = process.env,
} = {}) {
  return function runVerificationCommand({
    file,
    args = [],
    workspaceRoot,
    cwd,
    environment,
    temporaryDirectory,
    signal,
  } = {}) {
    if (typeof file !== "string" || !file || !Array.isArray(args)) {
      throw projectWorkError(
        "PROJECT_WORK_VERIFICATION_COMMAND_INVALID",
        "验证命令无效",
        400,
      );
    }
    if (!pathIsAbsolute(cwd)) {
      throw projectWorkError(
        "PROJECT_WORK_VERIFICATION_COMMAND_INVALID",
        "验证工作目录必须由服务端解析为绝对路径",
        400,
      );
    }
    if (platform !== "darwin") {
      throw projectWorkError(
        "PROJECT_WORK_VERIFICATION_SANDBOX_UNAVAILABLE",
        "当前系统没有可用的受控验证隔离器",
        503,
        false,
      );
    }
    const normalizedWorkspace = normalizedAbsolutePath(workspaceRoot);
    const normalizedCwd = normalizedAbsolutePath(cwd);
    if (
      !normalizedWorkspace
      || !normalizedCwd
      || !pathWithin(normalizedWorkspace, normalizedCwd)
    ) {
      throw projectWorkError(
        "PROJECT_WORK_VERIFICATION_SANDBOX_INVALID",
        "验证工作目录必须位于独立验证副本内",
        500,
      );
    }
    const sandboxTemporaryDirectory = temporaryDirectory
      ?? `${normalizedWorkspace}/.pi-verification-tmp`;
    const layout = normalizeSandboxLayout({
      workspaceRoot: normalizedWorkspace,
      temporaryDirectory: sandboxTemporaryDirectory,
    });
    const execution = macOSExecutionPolicy({
      file,
      pathValue: baseEnvironment?.PATH,
    });
    const spawnCommand = normalizeExecutableFile(
      file,
      layout.workspaceRoot,
      normalizedCwd,
      execution,
    );
    const sandboxProfile = buildMacOSVerificationSandboxProfile({
      ...layout,
      readOnlyRoots: execution.readOnlyRoots,
    });
    const spawnFile = sandboxExecPath;
    const spawnArgs = [
      "-p",
      sandboxProfile,
      spawnCommand,
      ...args,
    ];
    return new Promise((resolve, reject) => {
      const startedAt = now();
      const child = spawnImpl(spawnFile, spawnArgs, {
        cwd: normalizedCwd,
        detached: process.platform !== "win32",
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...safeEnvironment(baseEnvironment, execution.executablePath),
          ...normalizeRecipeEnvironment(environment),
          TMPDIR: sandboxTemporaryDirectory,
          CI: "1",
          NO_COLOR: "1",
        },
      });
      const stdout = createBoundedOutput();
      const stderr = createBoundedOutput();
      let timedOut = false;
      let settled = false;
      let forceKill;
      let hardStop;

      const cleanup = () => {
        clearTimeout(timeout);
        clearTimeout(forceKill);
        clearTimeout(hardStop);
        signal?.removeEventListener("abort", onAbort);
      };

      const resolveForcedStop = () => {
        if (settled) return;
        settled = true;
        cleanup();
        child.stdout?.destroy?.();
        child.stderr?.destroy?.();
        resolve({
          exitCode: null,
          signal: "SIGKILL",
          timedOut,
          aborted: signal?.aborted === true,
          isolation: MACOS_SANDBOX_PROFILE_ID,
          durationMs: Math.max(0, now() - startedAt),
          stdout: boundedOutputBuffer(stdout).toString("utf8"),
          stderr: boundedOutputBuffer(stderr).toString("utf8"),
          truncated: stdout.truncated || stderr.truncated,
        });
      };

      const terminate = () => {
        if (!child.killed) {
          killProcessTree(child, "SIGTERM");
          forceKill = setTimeout(() => {
            if (!settled) killProcessTree(child, "SIGKILL");
          }, 1_000);
          forceKill.unref?.();
          hardStop = setTimeout(resolveForcedStop, 4_000);
          hardStop.unref?.();
        }
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeoutMs);
      timeout.unref?.();
      const onAbort = () => terminate();
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();

      child.stdout?.on("data", (chunk) => {
        appendBoundedOutput(stdout, chunk, maxOutputBytes);
      });
      child.stderr?.on("data", (chunk) => {
        appendBoundedOutput(stderr, chunk, maxOutputBytes);
      });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      });
      child.on("close", (exitCode, exitSignal) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          exitCode,
          signal: exitSignal,
          timedOut,
          aborted: signal?.aborted === true,
          isolation: MACOS_SANDBOX_PROFILE_ID,
          durationMs: Math.max(0, now() - startedAt),
          stdout: boundedOutputBuffer(stdout).toString("utf8"),
          stderr: boundedOutputBuffer(stderr).toString("utf8"),
          truncated: stdout.truncated || stderr.truncated,
        });
      });
    });
  };
}
