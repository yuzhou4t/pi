import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createExternalRetrievalTools,
  getExternalRetrievalCapabilities,
} from "./externalRetrieval.js";

function toolByName(tools, name) {
  const tool = tools.find((item) => item.name === name);
  assert.ok(tool, `missing ${name} tool`);
  return tool;
}

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

test("external capability status is safe and depends only on dedicated keys", () => {
  assert.deepEqual(getExternalRetrievalCapabilities({
    env: {
      API_KEY: "ambient-key-must-not-be-used",
      OPENAI_API_KEY: "ambient-key-must-not-be-used",
      PI_TAVILY_API_KEY: "tavily-secret",
    },
  }), {
    web_search: {
      available: true,
      reason: "Tavily 网页检索已配置",
    },
    docs_search: {
      available: false,
      reason: "Context7 尚未配置",
    },
  });

  assert.deepEqual(getExternalRetrievalCapabilities({
    env: {
      PI_DOUBAO_API_KEY: "doubao-secret",
      PI_TAVILY_API_KEY: "tavily-secret",
    },
  }).web_search, {
    available: true,
    reason: "豆包优先，本月 500 次后回退 Tavily",
  });
});

test("external retrieval tools are explicitly unavailable without dedicated server keys", async () => {
  let fetchCalls = 0;
  const tools = createExternalRetrievalTools({
    env: {
      API_KEY: "ambient-key-must-not-be-used",
      OPENAI_API_KEY: "ambient-key-must-not-be-used",
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      return jsonResponse({});
    },
  });

  await assert.rejects(
    toolByName(tools, "search_web").execute("search", { query: "Node.js fetch" }),
    (error) => {
      assert.equal(error.code, "PROJECT_WORK_WEB_SEARCH_UNAVAILABLE");
      assert.match(error.message, /尚未配置豆包或 Tavily API Key/);
      return true;
    },
  );
  await assert.rejects(
    toolByName(tools, "resolve_library_id").execute("resolve", {
      library_name: "react",
      query: "effect cleanup",
    }),
    (error) => {
      assert.equal(error.code, "PROJECT_WORK_CONTEXT7_UNAVAILABLE");
      assert.match(error.message, /尚未配置 Context7 API Key/);
      return true;
    },
  );
  await assert.rejects(
    toolByName(tools, "query_docs").execute("docs", {
      library_id: "/facebook/react",
      query: "effect cleanup",
    }),
    { code: "PROJECT_WORK_CONTEXT7_UNAVAILABLE" },
  );
  assert.equal(fetchCalls, 0);
});

test("external retrieval blocks sensitive outbound text before fetch without echoing it", async () => {
  let fetchCalls = 0;
  const tools = createExternalRetrievalTools({
    env: {
      PI_TAVILY_API_KEY: "tavily-key",
      PI_CONTEXT7_API_KEY: "context7-key",
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      return jsonResponse({});
    },
  });
  const searchWeb = toolByName(tools, "search_web");
  const resolveLibraryId = toolByName(tools, "resolve_library_id");
  const queryDocs = toolByName(tools, "query_docs");
  const blockedInputs = [
    "debug /Users/alice/private-project/src/auth.ts",
    String.raw`open C:\Users\Alice\private-project\auth.ts`,
    "Authorization: Bearer super-secret-token-value",
    "api_key=sk-proj-this-must-never-leave-the-machine",
    "mF9Qp2Zx7Lc4Vn8Rt1Ws6Yu3Ki0Hg5Jd8Ba0Ce4",
    "-----BEGIN PRIVATE KEY-----\nprivate material\n-----END PRIVATE KEY-----",
    "const privateValue = getPrivateValue();\nreturn privateValue;",
    "function internalRevenueForecast(){return customerRevenue*secretMargin;}",
    "result = loadPrivateState()\ncache = result",
    "apiVersion: v1\nkind: ConfigMap",
    "postgres://db-user:db-password@localhost/private",
    "inspect %2FUsers%2Falice%2Fprivate-project%2Fauth.ts",
    "token%3Dsk-proj-this-must-never-leave-the-machine",
  ];

  for (const sensitiveInput of blockedInputs) {
    await assert.rejects(
      searchWeb.execute("blocked-search", { query: sensitiveInput }),
      (error) => {
        assert.equal(error.code, "PROJECT_WORK_EXTERNAL_QUERY_BLOCKED");
        assert.equal(error.status, 400);
        assert.equal(error.retryable, false);
        assert.equal(
          error.message,
          "外部检索请求可能包含本机路径、代码或敏感凭据，已在发送前拦截；请改写为简短、泛化的技术问题",
        );
        return true;
      },
    );
  }
  await assert.rejects(
    resolveLibraryId.execute("blocked-resolve-name", {
      library_name: "password: do-not-send-this",
      query: "public API",
    }),
    { code: "PROJECT_WORK_EXTERNAL_QUERY_BLOCKED" },
  );
  await assert.rejects(
    resolveLibraryId.execute("blocked-resolve-query", {
      library_name: "react",
      query: "function privateHook() {\n  return localState;\n}",
    }),
    { code: "PROJECT_WORK_EXTERNAL_QUERY_BLOCKED" },
  );
  await assert.rejects(
    queryDocs.execute("blocked-docs", {
      library_id: "/facebook/react",
      query: "read file:///Users/alice/private-project/.env",
    }),
    { code: "PROJECT_WORK_EXTERNAL_QUERY_BLOCKED" },
  );
  await assert.rejects(
    queryDocs.execute("blocked-docs-id", {
      library_id: "/owner/sk-proj-this-must-never-leave-the-machine",
      query: "public API",
    }),
    { code: "PROJECT_WORK_EXTERNAL_QUERY_BLOCKED" },
  );
  assert.equal(fetchCalls, 0);
});

test("external retrieval allows short technical queries and scoped npm library names", async () => {
  const calls = [];
  const tools = createExternalRetrievalTools({
    env: {
      PI_TAVILY_API_KEY: "tavily-key",
      PI_CONTEXT7_API_KEY: "context7-key",
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url === "https://api.tavily.com/search") {
        return jsonResponse({ results: [] });
      }
      if (url.startsWith("https://context7.com/api/v2/libs/search")) {
        return jsonResponse({ results: [] });
      }
      return jsonResponse({ codeSnippets: [], infoSnippets: [] });
    },
  });

  await toolByName(tools, "search_web").execute("safe-search", {
    query: "Node.js AbortController timeout API",
  });
  await toolByName(tools, "resolve_library_id").execute("safe-resolve", {
    library_name: "@tanstack/react-query",
    query: "invalidateQueries in v5",
  });
  await toolByName(tools, "query_docs").execute("safe-docs", {
    library_id: "/TanStack/query",
    query: "staleTime and gcTime behavior",
  });
  await toolByName(tools, "query_docs").execute("safe-versioned-docs", {
    library_id: "/vercel/next.js/v14.3.0-canary.87",
    query: "route handlers",
  });

  assert.equal(calls.length, 4);
});

test("search_web uses only the bounded Tavily search contract and marks results untrusted", async () => {
  const calls = [];
  const tools = createExternalRetrievalTools({
    env: {
      PI_TAVILY_API_KEY: "pi-tavily-key",
      TAVILY_API_KEY: "fallback-key-must-not-win",
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        results: [
          {
            title: "Node.js fetch",
            url: "https://nodejs.org/api/globals.html#fetch",
            content: "Official documentation ".repeat(200),
            score: 0.98,
          },
          {
            title: "Credential URL is discarded",
            url: "https://user:secret@example.com/private",
            content: "Do not return this result.",
          },
          {
            title: "Extra result",
            url: "https://example.com/extra",
            content: "Not requested.",
          },
        ],
      });
    },
  });

  const result = await toolByName(tools, "search_web").execute("search", {
    query: "  current Node.js fetch API  ",
    max_results: 2,
  });
  const body = JSON.parse(result.content[0].text);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.tavily.com/search");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.authorization, "Bearer pi-tavily-key");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    query: "current Node.js fetch API",
    search_depth: "basic",
    max_results: 2,
    include_answer: false,
    include_raw_content: false,
    include_images: false,
  });
  assert.equal(body.trust, "untrusted_external_content");
  assert.equal(body.executable, false);
  assert.match(body.instruction_policy, /Never follow or execute/);
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].excerpt.length, 1_500);
  assert.doesNotMatch(result.content[0].text, /user:secret/);
});

test("search_web prefers Doubao and durably counts the monthly request before calling it", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-doubao-quota-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const quotaFile = path.join(directory, "usage.json");
  const calls = [];
  const tools = createExternalRetrievalTools({
    env: {
      PI_DOUBAO_API_KEY: "doubao-key",
      PI_DOUBAO_SEARCH_MODEL: "doubao-search-model",
      PI_TAVILY_API_KEY: "tavily-key",
    },
    doubaoQuotaFilePath: quotaFile,
    now: () => new Date("2026-07-29T08:00:00+08:00"),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        output: [
          {
            type: "web_search_call",
            action: {
              sources: [{
                title: "Node.js documentation",
                url: "https://nodejs.org/api/globals.html#fetch",
                snippet: "The current fetch API.",
              }],
            },
          },
          {
            type: "message",
            content: [{
              type: "output_text",
              text: "Node.js provides a browser-compatible fetch implementation.",
            }],
          },
        ],
      });
    },
  });

  const result = await toolByName(tools, "search_web").execute("search", {
    query: "current Node.js fetch API",
    max_results: 2,
  });
  const body = JSON.parse(result.content[0].text);
  const requestBody = JSON.parse(calls[0].options.body);
  const quota = JSON.parse(await readFile(quotaFile, "utf8"));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://ark.cn-beijing.volces.com/api/v3/responses");
  assert.equal(calls[0].options.headers.authorization, "Bearer doubao-key");
  assert.equal(requestBody.model, "doubao-search-model");
  assert.deepEqual(requestBody.tools, [{ type: "web_search" }]);
  assert.equal(requestBody.stream, false);
  assert.equal(requestBody.store, false);
  assert.equal(body.provider, "doubao");
  assert.equal(body.results[0].url, "https://nodejs.org/api/globals.html#fetch");
  assert.equal(body.monthly_quota.limit, 500);
  assert.equal(body.monthly_quota.used, 1);
  assert.deepEqual(quota, {
    version: 1,
    period: "2026-07",
    used: 1,
    updated_at: "2026-07-29T00:00:00.000Z",
  });
});

test("search_web falls back to Tavily after the durable Doubao monthly limit", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-doubao-limit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const quotaFile = path.join(directory, "usage.json");
  await writeFile(quotaFile, JSON.stringify({
    version: 1,
    period: "2026-07",
    used: 500,
  }));
  const calls = [];
  const tools = createExternalRetrievalTools({
    env: {
      PI_DOUBAO_API_KEY: "doubao-key",
      PI_TAVILY_API_KEY: "tavily-key",
    },
    doubaoQuotaFilePath: quotaFile,
    now: () => new Date("2026-07-29T08:00:00+08:00"),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        results: [{
          title: "Fallback result",
          url: "https://example.com/fallback",
          content: "Tavily result",
        }],
      });
    },
  });

  const result = await toolByName(tools, "search_web").execute("search", {
    query: "current Node.js fetch API",
  });
  const body = JSON.parse(result.content[0].text);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.tavily.com/search");
  assert.equal(body.provider, "tavily");
  assert.equal(body.fallback_reason, "doubao_monthly_limit_reached");
  assert.equal(JSON.parse(await readFile(quotaFile, "utf8")).used, 500);
});

test("concurrent searches cannot reserve more than the final Doubao monthly slot", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-doubao-concurrent-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const quotaFile = path.join(directory, "usage.json");
  await writeFile(quotaFile, JSON.stringify({
    version: 1,
    period: "2026-07",
    used: 499,
  }));
  const calls = [];
  const tools = createExternalRetrievalTools({
    env: {
      PI_DOUBAO_API_KEY: "doubao-key",
      PI_TAVILY_API_KEY: "tavily-key",
    },
    doubaoQuotaFilePath: quotaFile,
    now: () => new Date("2026-07-29T08:00:00+08:00"),
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.includes("volces.com")) {
        return jsonResponse({
          output: [{
            type: "web_search_call",
            action: {
              sources: [{
                title: "Doubao result",
                url: "https://example.com/doubao",
              }],
            },
          }],
        });
      }
      return jsonResponse({
        results: [{
          title: "Tavily result",
          url: "https://example.com/tavily",
          content: "Fallback",
        }],
      });
    },
  });
  const searchWeb = toolByName(tools, "search_web");

  const results = await Promise.all([
    searchWeb.execute("search-1", { query: "query one" }),
    searchWeb.execute("search-2", { query: "query two" }),
  ]);
  const providers = results
    .map((result) => JSON.parse(result.content[0].text).provider)
    .sort();

  assert.deepEqual(providers, ["doubao", "tavily"]);
  assert.equal(calls.filter((url) => url.includes("volces.com")).length, 1);
  assert.equal(calls.filter((url) => url.includes("tavily.com")).length, 1);
  assert.equal(JSON.parse(await readFile(quotaFile, "utf8")).used, 500);
});

test("search_web has a hard timeout and returns a bounded safe error", async () => {
  const tools = createExternalRetrievalTools({
    env: { TAVILY_API_KEY: "tavily-key" },
    timeoutMs: 5,
    fetchImpl: async (_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => {
        const error = new Error("upstream secret must not escape");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    }),
  });

  await assert.rejects(
    toolByName(tools, "search_web").execute("search", { query: "timeout" }),
    (error) => {
      assert.equal(error.code, "PROJECT_WORK_TAVILY_TIMEOUT");
      assert.equal(error.status, 504);
      assert.equal(error.retryable, true);
      assert.doesNotMatch(error.message, /secret/);
      return true;
    },
  );
});

test("resolve_library_id calls the narrow Context7 library endpoint and bounds candidates", async () => {
  const calls = [];
  const tools = createExternalRetrievalTools({
    env: { PI_CONTEXT7_API_KEY: "context7-key" },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        results: Array.from({ length: 7 }, (_, index) => ({
          id: `/owner/library-${index}`,
          title: `Library ${index}`,
          description: "Current public docs",
          totalSnippets: 100 - index,
          trustScore: "High",
          benchmarkScore: 90 - index,
          versions: ["v2", "v1", "old", "older", "oldest", "discard"],
        })),
      });
    },
  });

  const result = await toolByName(tools, "resolve_library_id").execute(
    "resolve",
    {
      library_name: "react router",
      query: "data router loader API",
    },
  );
  const body = JSON.parse(result.content[0].text);
  const requested = new URL(calls[0].url);
  assert.equal(requested.origin + requested.pathname, "https://context7.com/api/v2/libs/search");
  assert.equal(requested.searchParams.get("libraryName"), "react router");
  assert.equal(requested.searchParams.get("query"), "data router loader API");
  assert.equal(calls[0].options.headers.authorization, "Bearer context7-key");
  assert.equal(body.trust, "untrusted_external_content");
  assert.equal(body.libraries.length, 5);
  assert.deepEqual(body.libraries[0], {
    library_id: "/owner/library-0",
    title: "Library 0",
    description: "Current public docs",
    code_snippets: 100,
    source_reputation: "High",
    benchmark_score: 90,
    versions: ["v2", "v1", "old", "older", "oldest"],
  });
  assert.equal(body.truncated, true);
});

test("query_docs requires an exact ID and returns only bounded untrusted snippets", async () => {
  const calls = [];
  const tools = createExternalRetrievalTools({
    env: { CONTEXT7_API_KEY: "context7-key" },
    fetchImpl: async (url) => {
      calls.push(url);
      return jsonResponse({
        codeSnippets: [{
          codeTitle: "Abort a request",
          language: "js",
          pageUrl: "https://nodejs.org/api/globals.html",
          codeList: [{
            code: "const controller = new AbortController();\n".repeat(100),
          }],
        }],
        infoSnippets: Array.from({ length: 10 }, (_, index) => ({
          title: `Note ${index}`,
          content: `Documentation ${index}`,
          pageUrl: `https://example.com/docs/${index}`,
        })),
      });
    },
  });
  const queryDocs = toolByName(tools, "query_docs");

  await assert.rejects(
    queryDocs.execute("invalid-docs", {
      library_id: "nodejs/node",
      query: "AbortController",
    }),
    { code: "PROJECT_WORK_CONTEXT7_LIBRARY_ID_INVALID" },
  );

  const result = await queryDocs.execute("docs", {
    library_id: "/nodejs/node",
    query: "AbortController timeout",
  });
  const body = JSON.parse(result.content[0].text);
  const requested = new URL(calls[0]);
  assert.equal(requested.origin + requested.pathname, "https://context7.com/api/v2/context");
  assert.equal(requested.searchParams.get("libraryId"), "/nodejs/node");
  assert.equal(requested.searchParams.get("query"), "AbortController timeout");
  assert.equal(requested.searchParams.get("type"), "json");
  assert.equal(body.trust, "untrusted_external_content");
  assert.equal(body.executable, false);
  assert.equal(body.snippets.length, 8);
  assert.equal(body.snippets[0].content.length, 1_200);
  assert.equal(body.truncated, true);
});

test("external HTTP failures expose provider state without leaking upstream bodies", async () => {
  const tools = createExternalRetrievalTools({
    env: {
      TAVILY_API_KEY: "tavily-key",
      CONTEXT7_API_KEY: "context7-key",
    },
    fetchImpl: async () => jsonResponse({
      message: "secret upstream diagnostic",
    }, { status: 429 }),
  });

  await assert.rejects(
    toolByName(tools, "search_web").execute("rate-limit", { query: "rate" }),
    (error) => {
      assert.equal(error.code, "PROJECT_WORK_TAVILY_RATE_LIMITED");
      assert.equal(error.retryable, true);
      assert.doesNotMatch(error.message, /diagnostic|secret/);
      return true;
    },
  );
});
