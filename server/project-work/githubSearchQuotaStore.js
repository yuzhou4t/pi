import { execFile as nodeExecFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { projectWorkError } from "./errors.js";

const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const DEFAULT_BRANCH = "quota-state";
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_RETRIES = 6;
const REPOSITORY_PATTERN = /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9_.-]{1,100})$/u;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;

function quotaError(message, retryable = true) {
  return projectWorkError(
    "PROJECT_WORK_SEARCH_QUOTA_SYNC_FAILED",
    message,
    503,
    retryable,
  );
}

function parseRepository(value) {
  const match = REPOSITORY_PATTERN.exec(String(value ?? "").trim());
  if (!match || match[2] === "." || match[2] === "..") return null;
  return { owner: match[1], repo: match[2], fullName: `${match[1]}/${match[2]}` };
}

function normalizeBranch(value) {
  const branch = String(value ?? DEFAULT_BRANCH).trim() || DEFAULT_BRANCH;
  return BRANCH_PATTERN.test(branch) ? branch : null;
}

function normalizeId(value, fallback) {
  const id = String(value ?? fallback).trim();
  return ID_PATTERN.test(id) ? id : fallback;
}

function cliEnvironment(env) {
  const childEnv = { ...(env ?? {}) };
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) {
    delete childEnv[key];
  }
  return {
    ...childEnv,
    GH_PROMPT_DISABLED: "1",
    GH_PAGER: "cat",
    NO_COLOR: "1",
    NO_UPDATE_NOTIFIER: "1",
    PAGER: "cat",
  };
}

function apiToken(env) {
  for (const key of ["PI_SEARCH_QUOTA_GITHUB_TOKEN", "PI_GITHUB_TOKEN"]) {
    const value = typeof env?.[key] === "string" ? env[key].trim() : "";
    if (value) return value;
  }
  return "";
}

async function boundedResponse(response) {
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw quotaError("GitHub 共享额度返回内容过大");
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw quotaError("GitHub 共享额度返回格式无效");
  }
}

export function createGitHubQuotaApiClient({
  env = process.env,
  fetchImpl = globalThis.fetch,
  execFileImpl = nodeExecFile,
  cwd = process.cwd(),
  timeoutMs = 10_000,
} = {}) {
  const token = apiToken(env);
  if (token) {
    return Object.freeze({
      source: "dedicated_token",
      async request({ method = "GET", endpoint, body }) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        timer.unref?.();
        try {
          const response = await fetchImpl(new URL(endpoint, GITHUB_API_ORIGIN), {
            method,
            headers: {
              accept: "application/vnd.github+json",
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
              "x-github-api-version": GITHUB_API_VERSION,
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: controller.signal,
          });
          return { status: response.status, data: await boundedResponse(response) };
        } catch (error) {
          if (error?.name === "AbortError") throw quotaError("GitHub 共享额度同步超时");
          if (error?.code === "PROJECT_WORK_SEARCH_QUOTA_SYNC_FAILED") throw error;
          throw quotaError("GitHub 共享额度暂时无法连接");
        } finally {
          clearTimeout(timer);
        }
      },
    });
  }

  return Object.freeze({
    source: "gh_keychain",
    async request({ method = "GET", endpoint, body }) {
      let temporaryDirectory = null;
      const args = [
        "api",
        "--method",
        method,
        "--hostname",
        "github.com",
        "--header",
        "Accept: application/vnd.github+json",
        "--header",
        `X-GitHub-Api-Version: ${GITHUB_API_VERSION}`,
        endpoint,
      ];
      if (body !== undefined) {
        temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "pi-search-quota-"));
        const inputPath = path.join(temporaryDirectory, "request.json");
        await writeFile(inputPath, JSON.stringify(body), { encoding: "utf8", mode: 0o600 });
        args.push("--input", inputPath);
      }
      try {
        const result = await new Promise((resolve) => {
          execFileImpl("gh", args, {
            cwd,
            env: cliEnvironment(env),
            timeout: timeoutMs,
            maxBuffer: MAX_RESPONSE_BYTES,
            windowsHide: true,
            shell: false,
          }, (error, stdout = "", stderr = "") => resolve({ error, stdout, stderr }));
        });
        const statusMatch = String(result.stderr).match(/(?:HTTP|status(?: code)?)\s*[: ]\s*(\d{3})/iu);
        const status = statusMatch
          ? Number(statusMatch[1])
          : (result.error ? 503 : (method === "POST" ? 201 : 200));
        let data = null;
        if (String(result.stdout).trim()) {
          try {
            data = JSON.parse(String(result.stdout));
          } catch {
            throw quotaError("GitHub 共享额度返回格式无效");
          }
        }
        return { status, data };
      } catch (error) {
        if (error?.code === "PROJECT_WORK_SEARCH_QUOTA_SYNC_FAILED") throw error;
        throw quotaError("GitHub CLI 无法同步共享额度");
      } finally {
        if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
      }
    },
  });
}

function requireStatus(result, allowed, message) {
  if (!allowed.includes(result?.status)) throw quotaError(message);
  return result?.data;
}

function decodeState(data, period) {
  if (data?.status === 404 || data == null) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(data.content ?? ""), "base64").toString("utf8"));
    if (![1, 2].includes(parsed?.schema_version)
      || parsed.period !== period
      || typeof parsed.providers !== "object") {
      throw new Error("invalid quota state");
    }
    return parsed;
  } catch {
    throw quotaError("GitHub 共享额度文件格式无效", false);
  }
}

function emptyState(period, timestamp) {
  return {
    schema_version: 1,
    period,
    updated_at: timestamp,
    providers: {},
  };
}

function quotaPath(period) {
  return `search-quota/${period}.json`;
}

function contentEndpoint(repository, period, branch) {
  return `/repos/${repository.owner}/${repository.repo}/contents/${quotaPath(period)}?ref=${encodeURIComponent(branch)}`;
}

export function createGitHubSearchQuotaStore({
  repository,
  branch = DEFAULT_BRANCH,
  client,
  now = () => new Date(),
  maxRetries = MAX_RETRIES,
} = {}) {
  const parsedRepository = parseRepository(repository);
  const normalizedBranch = normalizeBranch(branch);
  if (!parsedRepository || !normalizedBranch || !client?.request) return null;

  async function readState(period) {
    const result = await client.request({
      endpoint: contentEndpoint(parsedRepository, period, normalizedBranch),
    });
    if (result.status === 404) return null;
    return decodeState(requireStatus(result, [200], "无法读取 GitHub 共享额度"), period);
  }

  return Object.freeze({
    configured: true,
    repository: parsedRepository.fullName,
    branch: normalizedBranch,
    source: client.source ?? "github",
    async read({ providerId, limit, period }) {
      const id = normalizeId(providerId, "provider");
      const state = await readState(period);
      const used = Math.min(limit, Math.max(0, Number(state?.providers?.[id]?.used) || 0));
      return { period, limit, used, remaining: Math.max(0, limit - used) };
    },
    async reserve({ providerId, limit, period, projectId, minimumUsed = 0 }) {
      const id = normalizeId(providerId, "provider");
      const project = normalizeId(projectId, "unknown-project");
      for (let attempt = 0; attempt < maxRetries; attempt += 1) {
        const refData = requireStatus(await client.request({
          endpoint: `/repos/${parsedRepository.owner}/${parsedRepository.repo}/git/ref/heads/${normalizedBranch}`,
        }), [200], "GitHub 共享额度分支不可用");
        const headSha = String(refData?.object?.sha ?? "");
        const commitData = requireStatus(await client.request({
          endpoint: `/repos/${parsedRepository.owner}/${parsedRepository.repo}/git/commits/${headSha}`,
        }), [200], "GitHub 共享额度提交不可用");
        const contentResult = await client.request({
          endpoint: contentEndpoint(parsedRepository, period, normalizedBranch),
        });
        const state = contentResult.status === 404
          ? emptyState(period, now().toISOString())
          : decodeState(requireStatus(contentResult, [200], "无法读取 GitHub 共享额度"), period);
        const providerState = state.providers[id] ?? {};
        const used = Math.min(limit, Math.max(
          Number(providerState.used) || 0,
          Number.isSafeInteger(minimumUsed) ? minimumUsed : 0,
        ));
        if (used >= limit) {
          return { granted: false, period, limit, used: limit, remaining: 0 };
        }
        const nextUsed = used + 1;
        const nextState = {
          ...state,
          updated_at: now().toISOString(),
          providers: {
            ...state.providers,
            [id]: {
              ...providerState,
              limit,
              used: nextUsed,
              projects: {
                ...(providerState.projects ?? {}),
                [project]: (Number(providerState.projects?.[project]) || 0) + 1,
              },
            },
          },
        };
        const blob = requireStatus(await client.request({
          method: "POST",
          endpoint: `/repos/${parsedRepository.owner}/${parsedRepository.repo}/git/blobs`,
          body: {
            content: Buffer.from(`${JSON.stringify(nextState, null, 2)}\n`).toString("base64"),
            encoding: "base64",
          },
        }), [201], "无法保存 GitHub 共享额度内容");
        const tree = requireStatus(await client.request({
          method: "POST",
          endpoint: `/repos/${parsedRepository.owner}/${parsedRepository.repo}/git/trees`,
          body: {
            base_tree: commitData?.tree?.sha,
            tree: [{ path: quotaPath(period), mode: "100644", type: "blob", sha: blob?.sha }],
          },
        }), [201], "无法保存 GitHub 共享额度目录");
        const commit = requireStatus(await client.request({
          method: "POST",
          endpoint: `/repos/${parsedRepository.owner}/${parsedRepository.repo}/git/commits`,
          body: {
            message: `quota: reserve ${id} ${period}`,
            tree: tree?.sha,
            parents: [headSha],
          },
        }), [201], "无法创建 GitHub 共享额度记录");
        const update = await client.request({
          method: "PATCH",
          endpoint: `/repos/${parsedRepository.owner}/${parsedRepository.repo}/git/refs/heads/${normalizedBranch}`,
          body: { sha: commit?.sha, force: false },
        });
        if (update.status === 200) {
          return {
            granted: true,
            period,
            limit,
            used: nextUsed,
            remaining: limit - nextUsed,
          };
        }
        if (update.status !== 409 && update.status !== 422) {
          throw quotaError("无法提交 GitHub 共享额度记录");
        }
      }
      throw quotaError("两台设备同时更新额度，请重试本次搜索");
    },
  });
}

export function createGitHubSearchQuotaStoreFromEnv({
  env = process.env,
  fetchImpl = globalThis.fetch,
  execFileImpl = nodeExecFile,
  cwd = process.cwd(),
  now,
  client,
} = {}) {
  const repository = String(env?.PI_SEARCH_QUOTA_GITHUB_REPOSITORY ?? "").trim();
  if (!repository) return null;
  return createGitHubSearchQuotaStore({
    repository,
    branch: env?.PI_SEARCH_QUOTA_GITHUB_BRANCH,
    client: client ?? createGitHubQuotaApiClient({ env, fetchImpl, execFileImpl, cwd }),
    now,
  });
}
