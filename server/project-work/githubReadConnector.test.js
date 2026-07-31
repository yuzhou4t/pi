import assert from "node:assert/strict";
import test from "node:test";
import {
  GITHUB_READ_TOOL_NAMES,
  createGitHubReadConnector,
  createGitHubReadTools,
  getGitHubReadCapability,
} from "./githubReadConnector.js";

const TOKEN = "github-test-token-that-must-never-be-returned";

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers ?? {}),
    },
  });
}

function connectorWith(fetchImpl, options = {}) {
  return createGitHubReadConnector({
    env: { PI_GITHUB_TOKEN: TOKEN },
    enabledForTurn: true,
    fetchImpl,
    ...options,
  });
}

test("GitHub capability is dedicated, read-only, and disabled until this turn enables it", () => {
  const ambientOnly = getGitHubReadCapability({
    env: {
      GITHUB_TOKEN: "ambient-token",
      GH_TOKEN: "ambient-token",
    },
    enabledForTurn: true,
  });
  assert.equal(ambientOnly.available, false);
  assert.equal(ambientOnly.enabledForTurn, false);

  const configured = getGitHubReadCapability({
    env: { PI_GITHUB_TOKEN: TOKEN },
  });
  assert.deepEqual(configured, {
    id: "github_read",
    label: "GitHub 只读",
    available: true,
    enabledForTurn: false,
    defaultEnabled: false,
    activation: "per_turn",
    access: "read_only",
    effects: ["network_read"],
    toolNames: GITHUB_READ_TOOL_NAMES,
    reason: "GitHub 只读连接已配置，需逐回合启用",
  });
  assert.equal(createGitHubReadTools({
    env: { PI_GITHUB_TOKEN: TOKEN },
    enabledForTurn: false,
  }).length, 0);
  assert.deepEqual(
    createGitHubReadTools({
      env: { PI_GITHUB_TOKEN: TOKEN },
      enabledForTurn: true,
      fetchImpl: async () => jsonResponse({}),
    }).map((tool) => tool.name),
    GITHUB_READ_TOOL_NAMES,
  );
});

test("GitHub connector blocks missing configuration and missing per-turn enablement before fetch", async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    return jsonResponse({});
  };
  await assert.rejects(
    createGitHubReadConnector({
      env: {},
      enabledForTurn: true,
      fetchImpl,
    }).readIssue({ owner: "openai", repo: "codex", number: 1 }),
    { code: "PROJECT_WORK_GITHUB_UNAVAILABLE" },
  );
  await assert.rejects(
    createGitHubReadConnector({
      env: { PI_GITHUB_TOKEN: TOKEN },
      enabledForTurn: false,
      fetchImpl,
    }).readIssue({ owner: "openai", repo: "codex", number: 1 }),
    { code: "PROJECT_WORK_GITHUB_DISABLED" },
  );
  assert.equal(fetchCalls, 0);
});

test("GitHub connector validates owner, repo, number, ref, and pagination before fetch", async () => {
  let fetchCalls = 0;
  const connector = connectorWith(async () => {
    fetchCalls += 1;
    return jsonResponse({});
  });
  const invalidCalls = [
    () => connector.readIssue({ owner: "../openai", repo: "codex", number: 1 }),
    () => connector.readIssue({ owner: "openai", repo: "..", number: 1 }),
    () => connector.readIssue({ owner: "openai", repo: "codex", number: 0 }),
    () => connector.readPullRequest({ owner: "openai", repo: "codex", pull_number: "1" }),
    () => connector.readCheckRuns({ owner: "openai", repo: "codex", ref: "../main" }),
    () => connector.readCheckRuns({ owner: "openai", repo: "codex", ref: "main", max_pages: 4 }),
    () => connector.readReviewComments({
      owner: "openai",
      repo: "codex",
      pull_number: 1,
      per_page: 31,
    }),
  ];
  for (const call of invalidCalls) {
    await assert.rejects(call(), {
      code: "PROJECT_WORK_GITHUB_INPUT_INVALID",
      status: 400,
    });
  }
  assert.equal(fetchCalls, 0);
});

test("GitHub connector accepts a valid one-character ref", async () => {
  const connector = connectorWith(async () => jsonResponse({
    total_count: 0,
    check_runs: [],
  }));
  const result = await connector.readCheckRuns({
    owner: "openai",
    repo: "codex",
    ref: "x",
  });
  assert.equal(result.ref, "x");
});

test("readIssue uses fixed GitHub GET contract, returns bounded fields, and redacts the server token", async () => {
  const calls = [];
  const connector = connectorWith(async (url, options) => {
    calls.push({ url, options });
    return jsonResponse({
      number: 42,
      title: `Bug ${TOKEN}`,
      state: "open",
      state_reason: "reopened",
      locked: false,
      user: {
        login: "octocat",
        type: "User",
        html_url: "https://github.com/octocat",
      },
      assignees: [],
      labels: [{ name: "bug", color: "d73a4a" }],
      body: `Please inspect ${TOKEN}`,
      comments: 3,
      created_at: "2026-07-29T10:00:00Z",
      updated_at: "2026-07-30T10:00:00Z",
      closed_at: null,
      html_url: "https://github.com/openai/codex/issues/42",
      unexpected_secret_field: TOKEN,
    });
  });
  const result = await connector.readIssue({
    owner: "openai",
    repo: "codex",
    number: 42,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.github.com/repos/openai/codex/issues/42");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.body, undefined);
  assert.equal(calls[0].options.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].options.headers["x-github-api-version"], "2022-11-28");
  assert.equal(result.access, "read_only");
  assert.equal(result.trust, "untrusted_external_content");
  assert.equal(result.issue.number, 42);
  assert.equal(result.issue.title, "Bug [redacted]");
  assert.equal(result.issue.body, "Please inspect [redacted]");
  assert.equal(result.issue.labels[0].name, "bug");
  assert.doesNotMatch(JSON.stringify(result), new RegExp(TOKEN));
  assert.equal(result.issue.unexpected_secret_field, undefined);
});

test("readIssue rejects a Pull Request returned by the shared GitHub issues endpoint", async () => {
  const connector = connectorWith(async () => jsonResponse({
    number: 7,
    pull_request: { url: "https://api.github.com/repos/openai/codex/pulls/7" },
  }));
  await assert.rejects(
    connector.readIssue({ owner: "openai", repo: "codex", number: 7 }),
    { code: "PROJECT_WORK_GITHUB_EXPECTED_ISSUE" },
  );
});

test("readPullRequest returns bounded review and branch metadata", async () => {
  const connector = connectorWith(async (url, options) => {
    assert.equal(url, "https://api.github.com/repos/openai/codex/pulls/9");
    assert.equal(options.method, "GET");
    return jsonResponse({
      number: 9,
      title: "Improve connector",
      state: "open",
      draft: true,
      merged: false,
      mergeable: null,
      user: { login: "octocat", type: "User" },
      body: "A bounded body.",
      head: {
        label: "octocat:feature",
        ref: "feature",
        sha: "a".repeat(40),
        repo: { full_name: "octocat/codex" },
      },
      base: {
        label: "openai:main",
        ref: "main",
        sha: "b".repeat(40),
        repo: { full_name: "openai/codex" },
      },
      commits: 2,
      changed_files: 3,
      additions: 40,
      deletions: 4,
      comments: 1,
      review_comments: 2,
      created_at: "2026-07-29T10:00:00Z",
      updated_at: "2026-07-30T10:00:00Z",
      html_url: "https://github.com/openai/codex/pull/9",
    });
  });
  const result = await connector.readPullRequest({
    owner: "openai",
    repo: "codex",
    pull_number: 9,
  });
  assert.equal(result.pull_request.number, 9);
  assert.equal(result.pull_request.draft, true);
  assert.equal(result.pull_request.mergeable, null);
  assert.equal(result.pull_request.head.sha, "a".repeat(40));
  assert.equal(result.pull_request.review_comments_count, 2);
});

test("readCheckRuns uses bounded page-number pagination and encodes refs as one path segment", async () => {
  const calls = [];
  const connector = connectorWith(async (url, options) => {
    calls.push({ url, options });
    const page = Number(new URL(url).searchParams.get("page"));
    return jsonResponse({
      total_count: 3,
      check_runs: page === 1
        ? [
          {
            id: 1,
            name: "test",
            status: "completed",
            conclusion: "success",
            head_sha: "a".repeat(40),
            output: { title: "Tests", summary: "All passed", annotations_count: 0 },
          },
          {
            id: 2,
            name: "lint",
            status: "completed",
            conclusion: "success",
            head_sha: "a".repeat(40),
          },
        ]
        : [{
          id: 3,
          name: "build",
          status: "in_progress",
          conclusion: null,
          head_sha: "a".repeat(40),
        }],
    });
  });
  const result = await connector.readCheckRuns({
    owner: "openai",
    repo: "codex",
    ref: "feature/read-only",
    per_page: 2,
    max_pages: 2,
  });
  assert.equal(calls.length, 2);
  assert.equal(
    new URL(calls[0].url).pathname,
    "/repos/openai/codex/commits/feature%2Fread-only/check-runs",
  );
  assert.equal(calls[0].options.method, "GET");
  assert.equal(result.returned_count, 3);
  assert.equal(result.total_count, 3);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.check_runs.map((run) => run.name), ["test", "lint", "build"]);
});

test("readReviewComments stops at max_pages and reports truncation without following links", async () => {
  const calls = [];
  const connector = connectorWith(async (url, options) => {
    calls.push({ url, options });
    const page = Number(new URL(url).searchParams.get("page"));
    return jsonResponse([
      {
        id: page,
        user: { login: "reviewer" },
        body: `Comment ${page}`,
        path: "src/app.js",
        line: page,
        side: "RIGHT",
        commit_id: "a".repeat(40),
        created_at: "2026-07-30T10:00:00Z",
        html_url: `https://github.com/openai/codex/pull/5#discussion_r${page}`,
      },
    ], {
      headers: {
        link: '<https://evil.example/steal>; rel="next"',
      },
    });
  });
  const result = await connector.readReviewComments({
    owner: "openai",
    repo: "codex",
    pull_number: 5,
    per_page: 1,
    max_pages: 2,
  });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(({ url }) => new URL(url).origin === "https://api.github.com"));
  assert.ok(calls.every(({ options }) => options.method === "GET"));
  assert.equal(result.returned_count, 2);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.review_comments.map((comment) => comment.line), [1, 2]);
});

test("GitHub connector enforces response size, content type, timeout, and safe upstream errors", async () => {
  const oversized = connectorWith(async () => jsonResponse({ number: 1 }, {
    headers: { "content-length": String(512 * 1024 + 1) },
  }));
  await assert.rejects(
    oversized.readIssue({ owner: "openai", repo: "codex", number: 1 }),
    { code: "PROJECT_WORK_GITHUB_RESPONSE_TOO_LARGE" },
  );

  const invalidType = connectorWith(async () => new Response("<html></html>", {
    status: 200,
    headers: { "content-type": "text/html" },
  }));
  await assert.rejects(
    invalidType.readIssue({ owner: "openai", repo: "codex", number: 1 }),
    { code: "PROJECT_WORK_GITHUB_RESPONSE_INVALID" },
  );

  const timeout = connectorWith((_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => {
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    }, { once: true });
  }), { timeoutMs: 5 });
  await assert.rejects(
    timeout.readIssue({ owner: "openai", repo: "codex", number: 1 }),
    { code: "PROJECT_WORK_GITHUB_TIMEOUT", retryable: true },
  );

  const bodyTimeout = connectorWith(async (_url, { signal }) => new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
        signal.addEventListener("abort", () => {
          controller.error(Object.assign(
            new Error("aborted while reading body"),
            { name: "AbortError" },
          ));
        }, { once: true });
      },
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  ), { timeoutMs: 5 });
  await assert.rejects(
    bodyTimeout.readIssue({ owner: "openai", repo: "codex", number: 1 }),
    { code: "PROJECT_WORK_GITHUB_TIMEOUT", retryable: true },
  );

  for (const [status, code] of [
    [401, "PROJECT_WORK_GITHUB_AUTH_FAILED"],
    [403, "PROJECT_WORK_GITHUB_AUTH_FAILED"],
    [404, "PROJECT_WORK_GITHUB_NOT_FOUND"],
    [429, "PROJECT_WORK_GITHUB_RATE_LIMITED"],
    [500, "PROJECT_WORK_GITHUB_UPSTREAM_FAILED"],
  ]) {
    const failed = connectorWith(async () => jsonResponse({
      message: `upstream included ${TOKEN}`,
    }, { status }));
    await assert.rejects(
      failed.readIssue({ owner: "openai", repo: "codex", number: 1 }),
      (error) => {
        assert.equal(error.code, code);
        assert.doesNotMatch(error.message, new RegExp(TOKEN));
        return true;
      },
    );
  }
});

test("GitHub tools expose only four read actions and return tool-compatible details", async () => {
  const tools = createGitHubReadTools({
    env: { PI_GITHUB_TOKEN: TOKEN },
    enabledForTurn: true,
    fetchImpl: async () => jsonResponse({
      number: 1,
      title: "Read only",
      state: "open",
    }),
  });
  assert.deepEqual(tools.map((tool) => tool.name), GITHUB_READ_TOOL_NAMES);
  assert.ok(tools.every(
    (tool) => !/^(?:write|create|push|merge|github_comment)/u.test(tool.name),
  ));
  const result = await tools[0].execute("tool-call", {
    owner: "openai",
    repo: "codex",
    number: 1,
  });
  assert.equal(result.details.issue.number, 1);
  assert.deepEqual(JSON.parse(result.content[0].text), result.details);
});
