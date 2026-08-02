import { createHash } from "node:crypto";
import path from "node:path";
import { projectWorkError } from "./errors.js";
import { normalizeProjectPath } from "./workspace.js";

const MAX_MANIFEST_BYTES = 512 * 1024;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SAFE_SCRIPT_TOKEN = /^[A-Za-z0-9_./:@=,+-]+$/;
const UNSAFE_SCRIPT_TOKEN = /^(?:dev|serve|start|watch|install|add|remove|uninstall|publish|link|exec|dlx|npx|curl|wget)$/i;
const URL_PATTERN = /(?:https?|ftp):\/\//i;

const NODE_SCRIPT_EXECUTABLES = Object.freeze({
  test: new Set(["node", "vitest", "jest"]),
  check: new Set(["eslint", "tsc", "biome"]),
  build: new Set(["vite", "tsc", "swc", "rollup"]),
});

const RECIPE_DEFINITIONS = Object.freeze([
  {
    id: "node.test",
    stack: "node",
    action: "test",
    label: "Node 测试",
    manifests: ["package.json"],
  },
  {
    id: "node.check",
    stack: "node",
    action: "check",
    label: "Node 检查",
    manifests: ["package.json"],
  },
  {
    id: "node.build",
    stack: "node",
    action: "build",
    label: "Node 构建",
    manifests: ["package.json"],
  },
  {
    id: "python.test",
    stack: "python",
    action: "test",
    label: "Python 测试",
    manifests: ["pyproject.toml", "setup.cfg", "setup.py", "pytest.ini"],
  },
  {
    id: "python.check",
    stack: "python",
    action: "check",
    label: "Python 语法检查",
    manifests: ["pyproject.toml", "setup.cfg", "setup.py"],
  },
  {
    id: "python.build",
    stack: "python",
    action: "build",
    label: "Python 构建",
    manifests: ["pyproject.toml"],
  },
  {
    id: "swift.test",
    stack: "swift",
    action: "test",
    label: "Swift 测试",
    manifests: ["Package.swift"],
  },
  {
    id: "swift.build",
    stack: "swift",
    action: "build",
    label: "Swift 构建",
    manifests: ["Package.swift"],
  },
  {
    id: "rust.test",
    stack: "rust",
    action: "test",
    label: "Rust 测试",
    manifests: ["Cargo.toml"],
  },
  {
    id: "rust.check",
    stack: "rust",
    action: "check",
    label: "Rust 检查",
    manifests: ["Cargo.toml"],
  },
  {
    id: "rust.build",
    stack: "rust",
    action: "build",
    label: "Rust 构建",
    manifests: ["Cargo.toml"],
  },
  {
    id: "go.test",
    stack: "go",
    action: "test",
    label: "Go 测试",
    manifests: ["go.mod"],
  },
  {
    id: "go.check",
    stack: "go",
    action: "check",
    label: "Go 检查",
    manifests: ["go.mod"],
  },
  {
    id: "go.build",
    stack: "go",
    action: "build",
    label: "Go 构建",
    manifests: ["go.mod"],
  },
  {
    id: "android.test",
    stack: "android",
    action: "test",
    label: "Android 测试",
    manifests: [
      "settings.gradle",
      "settings.gradle.kts",
      "build.gradle",
      "build.gradle.kts",
    ],
  },
  {
    id: "android.check",
    stack: "android",
    action: "check",
    label: "Android 检查",
    manifests: [
      "settings.gradle",
      "settings.gradle.kts",
      "build.gradle",
      "build.gradle.kts",
    ],
  },
  {
    id: "android.build",
    stack: "android",
    action: "build",
    label: "Android 调试构建",
    manifests: [
      "settings.gradle",
      "settings.gradle.kts",
      "build.gradle",
      "build.gradle.kts",
    ],
  },
]);

const RECIPE_BY_ID = new Map(
  RECIPE_DEFINITIONS.map((recipe) => [recipe.id, recipe]),
);

export const VERIFICATION_RECIPE_IDS = Object.freeze(
  RECIPE_DEFINITIONS.map((recipe) => recipe.id),
);

const FIXED_COMMANDS = Object.freeze({
  "python.test": {
    file: "python3",
    args: ["-m", "pytest"],
    environment: {
      PIP_DISABLE_PIP_VERSION_CHECK: "1",
      PIP_NO_INDEX: "1",
    },
  },
  "python.check": {
    file: "python3",
    args: ["-m", "compileall", "-q", "."],
    environment: {
      PIP_DISABLE_PIP_VERSION_CHECK: "1",
      PIP_NO_INDEX: "1",
    },
  },
  "python.build": {
    file: "python3",
    args: ["-m", "build", "--no-isolation"],
    environment: {
      PIP_DISABLE_PIP_VERSION_CHECK: "1",
      PIP_NO_INDEX: "1",
    },
  },
  "swift.test": {
    file: "swift",
    args: ["test", "--disable-automatic-resolution"],
    environment: {},
  },
  "swift.build": {
    file: "swift",
    args: ["build", "--disable-automatic-resolution"],
    environment: {},
  },
  "rust.test": {
    file: "cargo",
    args: ["test", "--locked", "--offline"],
    environment: { CARGO_NET_OFFLINE: "true" },
  },
  "rust.check": {
    file: "cargo",
    args: ["check", "--locked", "--offline"],
    environment: { CARGO_NET_OFFLINE: "true" },
  },
  "rust.build": {
    file: "cargo",
    args: ["build", "--locked", "--offline"],
    environment: { CARGO_NET_OFFLINE: "true" },
  },
  "go.test": {
    file: "go",
    args: ["test", "./..."],
    environment: {
      GOPROXY: "off",
      GOSUMDB: "off",
      GOTOOLCHAIN: "local",
    },
  },
  "go.check": {
    file: "go",
    args: ["vet", "./..."],
    environment: {
      GOPROXY: "off",
      GOSUMDB: "off",
      GOTOOLCHAIN: "local",
    },
  },
  "go.build": {
    file: "go",
    args: ["build", "./..."],
    environment: {
      GOPROXY: "off",
      GOSUMDB: "off",
      GOTOOLCHAIN: "local",
    },
  },
  "android.test": {
    file: "./gradlew",
    args: ["--offline", "--no-daemon", "--console=plain", "test"],
    environment: { GRADLE_OPTS: "-Dorg.gradle.offline=true" },
  },
  "android.check": {
    file: "./gradlew",
    args: ["--offline", "--no-daemon", "--console=plain", "check"],
    environment: { GRADLE_OPTS: "-Dorg.gradle.offline=true" },
  },
  "android.build": {
    file: "./gradlew",
    args: ["--offline", "--no-daemon", "--console=plain", "assembleDebug"],
    environment: { GRADLE_OPTS: "-Dorg.gradle.offline=true" },
  },
});

function sha256(value) {
  const source = typeof value === "string"
    ? value
    : JSON.stringify(value);
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

function normalizeRecipeCwd(value) {
  if (value === undefined || value === null || value === "") return "";
  return normalizeProjectPath(String(value), { allowEmpty: true });
}

function manifestPath(cwd, fileName) {
  return [cwd, fileName].filter(Boolean).join("/");
}

async function readOptionalManifest(readTextFile, filePath) {
  try {
    const content = await readTextFile(filePath);
    if (typeof content !== "string") return null;
    if (Buffer.byteLength(content, "utf8") > MAX_MANIFEST_BYTES) {
      throw projectWorkError(
        "PROJECT_WORK_VERIFICATION_RECIPE_MANIFEST_TOO_LARGE",
        "项目清单过大，无法安全解析验证配方",
        409,
      );
    }
    return content;
  } catch (error) {
    if (error?.code === "PROJECT_WORK_VERIFICATION_RECIPE_MANIFEST_TOO_LARGE") {
      throw error;
    }
    return null;
  }
}

function commandRecord({ file, args, cwd, environment = {} }) {
  return {
    file,
    args: [...args],
    cwd,
    environment: { ...environment },
  };
}

function safeNodeScript(script, action) {
  const normalized = String(script ?? "").trim().replaceAll(/\s+/g, " ");
  if (
    !normalized
    || normalized.length > 2_000
    || /[\0\r\n;&|><`$()]/.test(normalized)
    || URL_PATTERN.test(normalized)
  ) {
    return false;
  }
  const tokens = normalized.split(" ");
  const unsafePathToken = (token) => {
    const candidate = token.startsWith("-") && token.includes("=")
      ? token.slice(token.indexOf("=") + 1)
      : token;
    return (
      candidate.startsWith("/")
      || candidate.startsWith("~")
      || candidate.split("/").includes("..")
    );
  };
  if (
    tokens.some((token) => !SAFE_SCRIPT_TOKEN.test(token))
    || tokens.some((token) => UNSAFE_SCRIPT_TOKEN.test(token.replace(/^-+/, "")))
    || tokens.some(unsafePathToken)
  ) {
    return false;
  }
  const executable = path.posix.basename(tokens[0]);
  if (!NODE_SCRIPT_EXECUTABLES[action]?.has(executable)) return false;
  if (
    tokens.some((token) => (
      /^--?(?:watch|watchAll|runInBand=false|update|updateSnapshot)$/i.test(token)
      || /^--?(?:watch|watchAll|update|updateSnapshot)=/i.test(token)
    ))
  ) {
    return false;
  }
  if (action === "test" && executable === "node") {
    return tokens[1] === "--test"
      && tokens.slice(2).every((token) => !token.startsWith("-"));
  }
  if (action === "build" && executable === "vite") {
    return tokens[1] === "build";
  }
  return true;
}

async function resolveNodeRecipe(definition, cwd, readTextFile) {
  const packagePath = manifestPath(cwd, "package.json");
  const packageContent = await readOptionalManifest(readTextFile, packagePath);
  if (!packageContent) return null;
  let packageJson;
  try {
    packageJson = JSON.parse(packageContent);
  } catch {
    throw projectWorkError(
      "PROJECT_WORK_VERIFICATION_RECIPE_MANIFEST_INVALID",
      "package.json 无法解析，未生成验证命令",
      409,
    );
  }
  const requestedNames = definition.action === "check"
    ? ["check", "typecheck", "lint"]
    : [definition.action];
  const scriptName = requestedNames.find(
    (name) => typeof packageJson?.scripts?.[name] === "string",
  );
  if (!scriptName && definition.action === "test") {
    return {
      command: commandRecord({
        file: "node",
        args: ["--test"],
        cwd,
      }),
      resolvedScript: null,
      bindings: [{
        path: packagePath,
        hash: sha256(packageContent),
      }],
    };
  }
  if (!scriptName) return null;
  const lifecycleNames = [`pre${scriptName}`, `post${scriptName}`].filter(
    (name) => typeof packageJson?.scripts?.[name] === "string",
  );
  if (lifecycleNames.length > 0) {
    throw projectWorkError(
      "PROJECT_WORK_VERIFICATION_RECIPE_SCRIPT_UNSAFE",
      `${scriptName} 存在未单独审阅的前置或后置生命周期脚本`,
      409,
    );
  }
  const resolvedScript = packageJson.scripts[scriptName]
    .trim()
    .replaceAll(/\s+/g, " ");
  if (!safeNodeScript(resolvedScript, definition.action)) {
    throw projectWorkError(
      "PROJECT_WORK_VERIFICATION_RECIPE_SCRIPT_UNSAFE",
      `${scriptName} 脚本包含未受控的执行、监听、安装或联网行为`,
      409,
    );
  }
  const lockfiles = [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["package-lock.json", "npm"],
  ];
  let packageManager = "npm";
  let lockBinding = null;
  for (const [fileName, candidate] of lockfiles) {
    const filePath = manifestPath(cwd, fileName);
    const content = await readOptionalManifest(readTextFile, filePath);
    if (content !== null) {
      packageManager = candidate;
      lockBinding = {
        path: filePath,
        hash: sha256(content),
      };
      break;
    }
  }
  return {
    command: commandRecord({
      file: packageManager,
      args: ["run", scriptName],
      cwd,
    }),
    resolvedScript,
    bindings: [{
      path: packagePath,
      hash: sha256(packageContent),
    }, ...(lockBinding ? [lockBinding] : [])],
  };
}

async function resolveAndroidRecipe(definition, cwd, readTextFile) {
  const candidates = [
    "settings.gradle",
    "settings.gradle.kts",
    "build.gradle",
    "build.gradle.kts",
    "gradle/libs.versions.toml",
  ];
  const bindings = [];
  let androidMarker = false;
  for (const fileName of candidates) {
    const filePath = manifestPath(cwd, fileName);
    const content = await readOptionalManifest(readTextFile, filePath);
    if (content === null) continue;
    bindings.push({ path: filePath, hash: sha256(content) });
    if (
      /com\.android\.(?:application|library|test)/.test(content)
      || /\balias\s*\(\s*libs\.plugins\.android\./.test(content)
      || /\bandroid\s*\{/.test(content)
    ) {
      androidMarker = true;
    }
  }
  if (!bindings.length || !androidMarker) return null;
  for (const wrapperFile of [
    "gradlew",
    "gradle/wrapper/gradle-wrapper.properties",
  ]) {
    const filePath = manifestPath(cwd, wrapperFile);
    const content = await readOptionalManifest(readTextFile, filePath);
    if (content === null) return null;
    bindings.push({ path: filePath, hash: sha256(content) });
  }
  return {
    command: commandRecord({
      ...FIXED_COMMANDS[definition.id],
      cwd,
    }),
    resolvedScript: null,
    bindings,
  };
}

async function resolveFixedRecipe(definition, cwd, readTextFile) {
  const bindings = [];
  for (const fileName of definition.manifests) {
    const filePath = manifestPath(cwd, fileName);
    const content = await readOptionalManifest(readTextFile, filePath);
    if (content !== null) {
      bindings.push({ path: filePath, hash: sha256(content) });
      break;
    }
  }
  if (!bindings.length) return null;
  return {
    command: commandRecord({
      ...FIXED_COMMANDS[definition.id],
      cwd,
    }),
    resolvedScript: null,
    bindings,
  };
}

function recipeContract(recipe) {
  return {
    schemaVersion: 1,
    id: recipe.id,
    stack: recipe.stack,
    action: recipe.action,
    command: recipe.command,
    resolvedScript: recipe.resolvedScript,
    bindings: recipe.bindings,
    networkPolicy: "offline",
  };
}

export function listVerificationRecipes() {
  return RECIPE_DEFINITIONS.map((recipe) => ({
    id: recipe.id,
    stack: recipe.stack,
    action: recipe.action,
    label: recipe.label,
    manifests: [...recipe.manifests],
    networkPolicy: "offline",
  }));
}

export async function resolveVerificationRecipe({
  recipeId,
  cwd = "",
  readTextFile,
} = {}) {
  const definition = RECIPE_BY_ID.get(String(recipeId ?? ""));
  if (!definition) {
    throw projectWorkError(
      "PROJECT_WORK_VERIFICATION_RECIPE_UNKNOWN",
      "验证配方不在服务端注册表中",
      400,
    );
  }
  if (typeof readTextFile !== "function") {
    throw projectWorkError(
      "PROJECT_WORK_VERIFICATION_RECIPE_READER_REQUIRED",
      "验证配方缺少受控项目读取器",
      500,
    );
  }
  const normalizedCwd = normalizeRecipeCwd(cwd);
  const resolved = definition.stack === "node"
    ? await resolveNodeRecipe(definition, normalizedCwd, readTextFile)
    : definition.stack === "android"
      ? await resolveAndroidRecipe(definition, normalizedCwd, readTextFile)
      : await resolveFixedRecipe(definition, normalizedCwd, readTextFile);
  if (!resolved) {
    throw projectWorkError(
      "PROJECT_WORK_VERIFICATION_RECIPE_UNAVAILABLE",
      `当前目录未识别到 ${definition.label} 所需的项目清单`,
      409,
    );
  }
  const recipe = {
    id: definition.id,
    stack: definition.stack,
    action: definition.action,
    label: definition.label,
    command: resolved.command,
    resolvedScript: resolved.resolvedScript,
    bindings: resolved.bindings,
    networkPolicy: "offline",
  };
  return {
    ...recipe,
    bindingHash: sha256(recipeContract(recipe)),
  };
}

export async function detectVerificationRecipes({
  cwd = "",
  readTextFile,
} = {}) {
  const results = [];
  for (const definition of RECIPE_DEFINITIONS) {
    try {
      const recipe = await resolveVerificationRecipe({
        recipeId: definition.id,
        cwd,
        readTextFile,
      });
      results.push(recipe);
    } catch (error) {
      if (![
        "PROJECT_WORK_VERIFICATION_RECIPE_UNAVAILABLE",
        "PROJECT_WORK_VERIFICATION_RECIPE_SCRIPT_UNSAFE",
      ].includes(error?.code)) {
        throw error;
      }
    }
  }
  return results;
}

export function isSafeResolvedVerificationRecipe(recipe) {
  if (
    !recipe
    || typeof recipe !== "object"
    || Array.isArray(recipe)
    || !RECIPE_BY_ID.has(recipe.id)
    || recipe.networkPolicy !== "offline"
    || !SHA256_PATTERN.test(String(recipe.bindingHash ?? ""))
    || !Array.isArray(recipe.bindings)
    || !recipe.bindings.length
    || recipe.bindings.some((binding) => (
      typeof binding?.path !== "string"
      || !binding.path
      || !SHA256_PATTERN.test(String(binding.hash ?? ""))
    ))
  ) {
    return false;
  }
  const definition = RECIPE_BY_ID.get(recipe.id);
  let normalizedCwd;
  try {
    normalizedCwd = normalizeRecipeCwd(recipe.command?.cwd);
  } catch {
    return false;
  }
  if (
    recipe.stack !== definition.stack
    || recipe.action !== definition.action
    || recipe.bindingHash !== sha256(recipeContract(recipe))
  ) {
    return false;
  }
  if (definition.stack === "node") {
    const command = recipe.command;
    if (
      command?.cwd !== normalizedCwd
      || Object.keys(command?.environment ?? {}).length > 0
    ) {
      return false;
    }
    if (
      definition.action === "test"
      && command.file === "node"
      && JSON.stringify(command.args) === JSON.stringify(["--test"])
    ) {
      return recipe.resolvedScript === null;
    }
    const scriptName = command?.args?.[0] === "run"
      && command.args.length === 2
      ? command.args[1]
      : null;
    return ["npm", "pnpm", "yarn", "bun"].includes(command?.file)
      && scriptName !== null
      && safeNodeScript(recipe.resolvedScript, definition.action);
  }
  const fixed = FIXED_COMMANDS[recipe.id];
  return recipe.command?.cwd === normalizedCwd
    && recipe.resolvedScript === null
    && recipe.command?.file === fixed.file
    && JSON.stringify(recipe.command?.args) === JSON.stringify(fixed.args)
    && JSON.stringify(recipe.command?.environment ?? {})
      === JSON.stringify(fixed.environment);
}
