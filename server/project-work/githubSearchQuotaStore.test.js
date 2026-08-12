import assert from "node:assert/strict";
import test from "node:test";
import {
  createGitHubSearchQuotaStore,
  createGitHubSearchQuotaStoreFromEnv,
} from "./githubSearchQuotaStore.js";

function encodedState(used, { schemaVersion = 1, leases } = {}) {
  return Buffer.from(JSON.stringify({
    schema_version: schemaVersion,
    period: "2026-08",
    updated_at: "2026-08-11T00:00:00.000Z",
    providers: {
      doubao: {
        limit: 500,
        used,
        projects: { "pi-agent": used },
        ...(leases ? { leases } : {}),
      },
    },
  })).toString("base64");
}

test("GitHub quota store atomically advances the shared branch", async () => {
  const calls = [];
  const client = {
    source: "test",
    async request(request) {
      calls.push(request);
      const { method = "GET", endpoint } = request;
      if (endpoint.includes("/git/ref/heads/")) {
        return { status: 200, data: { object: { sha: "head-1" } } };
      }
      if (endpoint.includes("/git/commits/head-1")) {
        return { status: 200, data: { tree: { sha: "tree-0" } } };
      }
      if (endpoint.includes("/contents/search-quota/")) {
        return { status: 200, data: { content: encodedState(8) } };
      }
      if (method === "POST" && endpoint.endsWith("/git/blobs")) {
        return { status: 201, data: { sha: "blob-1" } };
      }
      if (method === "POST" && endpoint.endsWith("/git/trees")) {
        return { status: 201, data: { sha: "tree-1" } };
      }
      if (method === "POST" && endpoint.endsWith("/git/commits")) {
        return { status: 201, data: { sha: "commit-1" } };
      }
      if (method === "PATCH" && endpoint.includes("/git/refs/heads/")) {
        return { status: 200, data: { object: { sha: "commit-1" } } };
      }
      throw new Error(`unexpected request: ${method} ${endpoint}`);
    },
  };
  const store = createGitHubSearchQuotaStore({
    repository: "yuzhou4t/pi",
    client,
    now: () => new Date("2026-08-11T01:00:00.000Z"),
  });

  const quota = await store.reserve({
    providerId: "doubao",
    projectId: "pi-agent",
    period: "2026-08",
    limit: 500,
  });

  assert.deepEqual(quota, {
    granted: true,
    period: "2026-08",
    limit: 500,
    used: 9,
    remaining: 491,
  });
  const blobCall = calls.find((call) => call.endpoint.endsWith("/git/blobs"));
  const nextState = JSON.parse(Buffer.from(blobCall.body.content, "base64").toString("utf8"));
  assert.equal(nextState.providers.doubao.used, 9);
  assert.equal(nextState.providers.doubao.projects["pi-agent"], 9);
  const refCall = calls.at(-1);
  assert.equal(refCall.method, "PATCH");
  assert.deepEqual(refCall.body, { sha: "commit-1", force: false });
});

test("GitHub quota store preserves compatible v2 lease metadata", async () => {
  const calls = [];
  const leases = {
    "windows-lease": {
      project_id: "windows-assistant",
      state: "returned",
      granted: 10,
      consumed: 1,
      returned: 9,
    },
  };
  const client = {
    async request(request) {
      calls.push(request);
      const { method = "GET", endpoint } = request;
      if (endpoint.includes("/git/ref/heads/")) {
        return { status: 200, data: { object: { sha: "head-v2" } } };
      }
      if (endpoint.includes("/git/commits/head-v2")) {
        return { status: 200, data: { tree: { sha: "tree-v2" } } };
      }
      if (endpoint.includes("/contents/search-quota/")) {
        return {
          status: 200,
          data: { content: encodedState(8, { schemaVersion: 2, leases }) },
        };
      }
      if (method === "POST" && endpoint.endsWith("/git/blobs")) {
        return { status: 201, data: { sha: "blob-v2" } };
      }
      if (method === "POST" && endpoint.endsWith("/git/trees")) {
        return { status: 201, data: { sha: "tree-next" } };
      }
      if (method === "POST" && endpoint.endsWith("/git/commits")) {
        return { status: 201, data: { sha: "commit-next" } };
      }
      if (method === "PATCH" && endpoint.includes("/git/refs/heads/")) {
        return { status: 200, data: {} };
      }
      throw new Error(`unexpected request: ${method} ${endpoint}`);
    },
  };
  const store = createGitHubSearchQuotaStore({ repository: "yuzhou4t/pi", client });

  const quota = await store.reserve({
    providerId: "doubao",
    projectId: "pi-agent",
    period: "2026-08",
    limit: 500,
  });

  assert.equal(quota.used, 9);
  const blobCall = calls.find((call) => call.endpoint.endsWith("/git/blobs"));
  const nextState = JSON.parse(Buffer.from(blobCall.body.content, "base64").toString("utf8"));
  assert.equal(nextState.schema_version, 2);
  assert.deepEqual(nextState.providers.doubao.leases, leases);
});

test("GitHub quota store refuses an exhausted shared quota without writing", async () => {
  let writes = 0;
  const store = createGitHubSearchQuotaStore({
    repository: "yuzhou4t/pi",
    client: {
      async request({ method = "GET", endpoint }) {
        if (method !== "GET") writes += 1;
        if (endpoint.includes("/git/ref/heads/")) {
          return { status: 200, data: { object: { sha: "head-1" } } };
        }
        if (endpoint.includes("/git/commits/head-1")) {
          return { status: 200, data: { tree: { sha: "tree-0" } } };
        }
        return { status: 200, data: { content: encodedState(500) } };
      },
    },
  });

  const quota = await store.reserve({
    providerId: "doubao",
    projectId: "windows-assistant",
    period: "2026-08",
    limit: 500,
  });

  assert.equal(quota.granted, false);
  assert.equal(quota.remaining, 0);
  assert.equal(writes, 0);
});

test("GitHub quota sharing stays opt-in when no repository is configured", () => {
  assert.equal(createGitHubSearchQuotaStoreFromEnv({ env: {} }), null);
});
