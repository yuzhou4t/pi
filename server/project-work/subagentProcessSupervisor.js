#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SUBAGENT_FORCE_KILL_AFTER_MS = 1_000;

const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
const SIGNAL_EXIT_CODES = new Map([
  ["SIGHUP", 129],
  ["SIGINT", 130],
  ["SIGTERM", 143],
  ["SIGKILL", 137],
]);
const PRIVATE_SERVICE_PREFIX = /^(?:CODEX_|ANTHROPIC_|ARK_|AZURE_OPENAI_|DEEPSEEK_|FEISHU_|GEMINI_|GOOGLE_AI_|LARK_|MISTRAL_|NOTIFICATION_|OPENAI_|SLACK_|TAVILY_|TEAMS_|VOLCENGINE_)/iu;
const PRIVATE_SECRET_NAME = /(?:^|_)(?:API_?KEY|AUTH(?:ORIZATION)?|CREDENTIALS?|PASSWORD|SECRET|TOKEN|WEBHOOK)(?:_|$)/iu;
const SUBAGENT_CONTROL_NAME = /^(?:PI_SUBAGENT|PI_SUBAGENTS|PI_INTERCOM_)/u;
const SAFE_PI_NAMES = new Set([
  "PI_CODING_AGENT_DIR",
  "PI_OFFLINE",
]);
const TRUSTED_AUTH_NAMES = new Set([
  "SSH_AGENT_PID",
  "SSH_AUTH_SOCK",
]);

export function createSupervisedSubagentEnvironment(baseEnvironment) {
  return Object.fromEntries(
    Object.entries(baseEnvironment ?? {}).filter(([name, value]) => {
      if (
        typeof value !== "string"
        || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)
      ) {
        return false;
      }
      if (SUBAGENT_CONTROL_NAME.test(name) || SAFE_PI_NAMES.has(name)) {
        return true;
      }
      if (name.startsWith("PI_") || PRIVATE_SERVICE_PREFIX.test(name)) {
        return false;
      }
      return TRUSTED_AUTH_NAMES.has(name) || !PRIVATE_SECRET_NAME.test(name);
    }),
  );
}

function findPackageRoot(entryPoint) {
  let directory = path.dirname(realpathSync(entryPoint));
  while (directory !== path.dirname(directory)) {
    const packageJsonPath = path.join(directory, "package.json");
    try {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
      if (packageJson?.name === PI_CODING_AGENT_PACKAGE) return directory;
    } catch {
      // Continue toward the filesystem root until the exact package is found.
    }
    directory = path.dirname(directory);
  }
  throw new Error("The bundled Pi CLI package could not be resolved");
}

export function resolveSupervisedPiCliPath() {
  const entryPoint = fileURLToPath(import.meta.resolve(PI_CODING_AGENT_PACKAGE));
  const packageRoot = findPackageRoot(entryPoint);
  const packageJson = JSON.parse(
    readFileSync(path.join(packageRoot, "package.json"), "utf8"),
  );
  const binary = typeof packageJson.bin === "string"
    ? packageJson.bin
    : packageJson.bin?.pi;
  if (typeof binary !== "string" || !binary.trim()) {
    throw new Error("The bundled Pi CLI entry point is unavailable");
  }
  const cliPath = realpathSync(path.resolve(packageRoot, binary));
  if (!cliPath.endsWith(".js") && !cliPath.endsWith(".mjs") && !cliPath.endsWith(".cjs")) {
    throw new Error("The bundled Pi CLI entry point is not a Node.js script");
  }
  return cliPath;
}

export function startSupervisedSubagentProcess({
  command,
  args = [],
  cwd = process.cwd(),
  env = process.env,
  stdio = ["inherit", "inherit", "inherit"],
  forceKillAfterMs = SUBAGENT_FORCE_KILL_AFTER_MS,
  spawnProcess = spawn,
} = {}) {
  if (typeof command !== "string" || !command) {
    throw new TypeError("A child command is required");
  }
  if (
    !Number.isSafeInteger(forceKillAfterMs)
    || forceKillAfterMs < 1
    || forceKillAfterMs > 30_000
  ) {
    throw new TypeError("forceKillAfterMs must be between 1 and 30000 milliseconds");
  }

  const child = spawnProcess(command, args, {
    cwd,
    env,
    stdio,
    windowsHide: true,
  });
  let finished = false;
  let forceKillTimer = null;
  let requestedSignal = null;
  let forced = false;
  let resolveCompletion;
  const completion = new Promise((resolve) => {
    resolveCompletion = resolve;
  });

  function clearForceKillTimer() {
    if (!forceKillTimer) return;
    clearTimeout(forceKillTimer);
    forceKillTimer = null;
  }

  function finish(outcome) {
    if (finished) return;
    finished = true;
    clearForceKillTimer();
    resolveCompletion({
      ...outcome,
      requestedSignal,
      forced,
    });
  }

  function signalChild(signal) {
    if (finished || child.exitCode !== null || child.signalCode !== null) return false;
    try {
      return child.kill(signal);
    } catch {
      return false;
    }
  }

  function terminate(signal = "SIGTERM") {
    if (finished) return false;
    requestedSignal ??= signal;
    signalChild(signal);
    if (!forceKillTimer) {
      forceKillTimer = setTimeout(() => {
        forceKillTimer = null;
        if (finished || child.exitCode !== null || child.signalCode !== null) return;
        forced = true;
        signalChild("SIGKILL");
      }, forceKillAfterMs);
    }
    return true;
  }

  child.once("error", (error) => {
    finish({ code: 1, signal: null, error });
  });
  child.once("exit", (code, signal) => {
    finish({ code, signal, error: null });
  });
  child.once("close", (code, signal) => {
    finish({ code, signal, error: null });
  });

  return {
    child,
    completion,
    terminate,
  };
}

function isDirectInvocation() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

export async function runSupervisedSubagentCommand({
  command,
  args = [],
  cwd = process.cwd(),
  env = process.env,
  stdio = ["inherit", "inherit", "inherit"],
  forceKillAfterMs = SUBAGENT_FORCE_KILL_AFTER_MS,
  signalTarget = process,
} = {}) {
  let receivedSignal = null;
  let supervised = null;
  const handlers = new Map();
  for (const signal of FORWARDED_SIGNALS) {
    const handler = () => {
      receivedSignal ??= signal;
      supervised?.terminate(signal);
    };
    handlers.set(signal, handler);
    signalTarget.on(signal, handler);
  }

  try {
    supervised = startSupervisedSubagentProcess({
      command,
      args,
      cwd,
      env: createSupervisedSubagentEnvironment(env),
      stdio,
      forceKillAfterMs,
    });
    if (receivedSignal) supervised.terminate(receivedSignal);
    const outcome = await supervised.completion;
    return {
      ...outcome,
      exitCode: receivedSignal
        ? SIGNAL_EXIT_CODES.get(receivedSignal) ?? 1
        : outcome.signal
          ? SIGNAL_EXIT_CODES.get(outcome.signal) ?? 1
          : outcome.code ?? 1,
    };
  } finally {
    for (const [signal, handler] of handlers) {
      signalTarget.off(signal, handler);
    }
  }
}

async function main() {
  const outcome = await runSupervisedSubagentCommand({
    command: process.execPath,
    args: [resolveSupervisedPiCliPath(), ...process.argv.slice(2)],
  });
  if (outcome.error) throw outcome.error;
  process.exitCode = outcome.exitCode;
}

if (isDirectInvocation()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
