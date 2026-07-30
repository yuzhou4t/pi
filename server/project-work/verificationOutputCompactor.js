import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_INPUT_BYTES = 256 * 1024;
const DEFAULT_MIN_SAVINGS_BYTES = 32;
const DEFAULT_MIN_SAVINGS_RATIO = 0.05;
const DEFAULT_EVIDENCE_TAIL_CHARACTERS = 8_000;
const DEFAULT_DIAGNOSTIC_CHARACTERS = 4_000;
const ERROR_LINE_PATTERN =
  /(?:error|failed?|failure|assert|exception|timeout|timed out|not found|cannot|invalid|mismatch|expected|received)/i;
const LOCATION_LINE_PATTERN =
  /\b(?:src|test|tests|server|app)\/\S+:\d+/i;
const WARNING_LINE_PATTERN = /(?:warning|warn)/i;
const MISLEADING_ZERO_FAILURE_PATTERN =
  /\b0\s+(?:errors?|fail(?:ed|ures?)?|failing|failed tests?)\b/i;
const MAX_DIAGNOSTIC_LINE_CHARACTERS = 1_000;

function safeEnvironment(temporaryDirectory) {
  const environment = Object.fromEntries(
    ["PATH", "LANG", "LC_ALL", "TMPDIR"].flatMap((name) => (
      typeof process.env[name] === "string" ? [[name, process.env[name]]] : []
    )),
  );
  return {
    ...environment,
    HOME: path.join(temporaryDirectory, "home"),
    XDG_DATA_HOME: path.join(temporaryDirectory, "data"),
    XDG_CONFIG_HOME: path.join(temporaryDirectory, "config"),
    XDG_CACHE_HOME: path.join(temporaryDirectory, "cache"),
    RTK_TELEMETRY_DISABLED: "1",
    DO_NOT_TRACK: "1",
    CI: "1",
    NO_COLOR: "1",
  };
}

function runExecFile(execFileImpl, file, args, options) {
  return new Promise((resolve) => {
    try {
      execFileImpl(file, args, options, (error, stdout = "", stderr = "") => {
        resolve({
          error,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      });
    } catch (error) {
      resolve({ error, stdout: "", stderr: "" });
    }
  });
}

function failureReason(error, signal, fallback) {
  if (signal?.aborted || error?.name === "AbortError") return "aborted";
  if (error?.code === "ENOENT") return "binary_missing";
  if (error?.killed === true || error?.code === "ETIMEDOUT") return "timeout";
  return fallback;
}

function result({
  output,
  rawBytes,
  applied = false,
  version = null,
  reason = null,
}) {
  const compactBytes = Buffer.byteLength(output, "utf8");
  return {
    output,
    applied,
    rawBytes,
    compactBytes,
    ratio: rawBytes > 0 ? compactBytes / rawBytes : 1,
    command: ["rtk", "log"],
    version,
    reason,
  };
}

function diagnosticExcerpt(rawOutput, maximumCharacters) {
  if (maximumCharacters <= 0) return "";
  const seen = new Set();
  const buckets = [[], [], [], []];
  const perLineLimit = Math.min(
    MAX_DIAGNOSTIC_LINE_CHARACTERS,
    Math.max(120, Math.floor(maximumCharacters / 4)),
  );
  for (const rawLine of rawOutput.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line || seen.has(line)) continue;
    const bucket = ERROR_LINE_PATTERN.test(line)
      ? line.length <= perLineLimit
        ? buckets[0]
        : buckets[2]
      : LOCATION_LINE_PATTERN.test(line)
        ? buckets[1]
        : WARNING_LINE_PATTERN.test(line)
          ? buckets[3]
          : null;
    if (!bucket) continue;
    seen.add(line);
    bucket.push(line.slice(0, perLineLimit));
  }
  for (const bucket of buckets) {
    bucket.sort((left, right) => left.length - right.length);
  }

  const selected = [];
  let length = 0;
  for (const line of buckets.flat()) {
    const separatorLength = selected.length > 0 ? 1 : 0;
    const remaining = maximumCharacters - length - separatorLength;
    if (remaining <= 0) break;
    const boundedLine = line.slice(0, remaining);
    if (!boundedLine) continue;
    selected.push(boundedLine);
    length += boundedLine.length + separatorLength;
  }
  return selected.join("\n");
}

function safeRtkSummary(compactOutput, failed) {
  if (!failed) return compactOutput;
  return compactOutput
    .split(/\r?\n/)
    .filter((line) => !MISLEADING_ZERO_FAILURE_PATTERN.test(line))
    .join("\n")
    .trim();
}

function modelProjection({
  rawOutput,
  compactOutput,
  failed,
  evidenceTailCharacters,
  diagnosticCharacters,
}) {
  const tail = evidenceTailCharacters > 0
    ? rawOutput.slice(-evidenceTailCharacters)
    : "";
  const diagnostics = diagnosticExcerpt(rawOutput, diagnosticCharacters)
    .split(/\r?\n/)
    .filter((line) => line && !tail.includes(line))
    .join("\n");
  const rtkSummary = safeRtkSummary(compactOutput, failed);
  return [
    diagnostics
      ? `Diagnostic lines preserved from the complete log:\n${diagnostics}`
      : "",
    tail
      ? `Final excerpt preserved from the complete log:\n${tail}`
      : "",
    rtkSummary
      ? `RTK heuristic summary (non-authoritative):\n${rtkSummary}`
      : "",
  ].filter(Boolean).join("\n\n");
}

export function createVerificationOutputCompactor({
  execFileImpl = execFile,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxInputBytes = DEFAULT_MAX_INPUT_BYTES,
  minSavingsBytes = DEFAULT_MIN_SAVINGS_BYTES,
  minSavingsRatio = DEFAULT_MIN_SAVINGS_RATIO,
  evidenceTailCharacters = DEFAULT_EVIDENCE_TAIL_CHARACTERS,
  diagnosticCharacters = DEFAULT_DIAGNOSTIC_CHARACTERS,
  temporaryRoot = os.tmpdir(),
} = {}) {
  let cachedVersion = null;

  return async function compactVerificationOutput({
    output,
    signal,
    failed = false,
  } = {}) {
    const rawOutput = typeof output === "string" ? output : String(output ?? "");
    const rawBytes = Buffer.byteLength(rawOutput, "utf8");
    const unchanged = (reason, version = cachedVersion) => result({
      output: rawOutput,
      rawBytes,
      version,
      reason,
    });

    if (rawBytes === 0) return unchanged("empty");
    if (rawBytes > maxInputBytes) return unchanged("input_too_large");
    if (signal?.aborted) return unchanged("aborted");

    let temporaryDirectory;
    try {
      temporaryDirectory = await mkdtemp(
        path.join(temporaryRoot, "pi-rtk-log-"),
      );
      const environment = safeEnvironment(temporaryDirectory);
      await Promise.all([
        mkdir(environment.HOME, { recursive: true }),
        mkdir(environment.XDG_DATA_HOME, { recursive: true }),
        mkdir(environment.XDG_CONFIG_HOME, { recursive: true }),
        mkdir(environment.XDG_CACHE_HOME, { recursive: true }),
      ]);

      if (!cachedVersion) {
        const versionResult = await runExecFile(
          execFileImpl,
          "rtk",
          ["--version"],
          {
            cwd: temporaryDirectory,
            env: environment,
            encoding: "utf8",
            maxBuffer: 16 * 1024,
            shell: false,
            timeout: timeoutMs,
            signal,
            windowsHide: true,
          },
        );
        if (versionResult.error) {
          return unchanged(
            failureReason(versionResult.error, signal, "version_failed"),
            null,
          );
        }
        cachedVersion = versionResult.stdout.trim() || null;
      }

      const inputPath = path.join(temporaryDirectory, "verification.log");
      await writeFile(inputPath, rawOutput, {
        encoding: "utf8",
        mode: 0o600,
      });
      const compacted = await runExecFile(
        execFileImpl,
        "rtk",
        ["log", inputPath],
        {
          cwd: temporaryDirectory,
          env: environment,
          encoding: "utf8",
          maxBuffer: maxInputBytes + 4 * 1024,
          shell: false,
          timeout: timeoutMs,
          signal,
          windowsHide: true,
        },
      );
      if (compacted.error) {
        return unchanged(
          failureReason(compacted.error, signal, "process_failed"),
        );
      }
      if (compacted.stderr.trim()) return unchanged("process_stderr");

      const compactOutput = compacted.stdout.trim();
      if (!compactOutput) return unchanged("empty_compact_output");
      const projection = modelProjection({
        rawOutput,
        compactOutput,
        failed: failed === true,
        evidenceTailCharacters,
        diagnosticCharacters,
      });
      const compactBytes = Buffer.byteLength(projection, "utf8");
      const savedBytes = rawBytes - compactBytes;
      const savedRatio = savedBytes / rawBytes;
      if (
        savedBytes < minSavingsBytes
        || savedRatio < minSavingsRatio
      ) {
        return unchanged("reduction_too_small");
      }

      return result({
        output: projection,
        rawBytes,
        applied: true,
        version: cachedVersion,
      });
    } catch (error) {
      return unchanged(failureReason(error, signal, "internal_error"));
    } finally {
      if (temporaryDirectory) {
        await rm(temporaryDirectory, { recursive: true, force: true })
          .catch(() => undefined);
      }
    }
  };
}
