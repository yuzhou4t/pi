import assert from "node:assert/strict";
import test from "node:test";
import { workerApi } from "./worker.js";

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("Worker action proposal sends only persisted source bindings, never browser before/after content", async () => {
  const originalFetch = globalThis.fetch;
  let request = null;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return jsonResponse({ action: { id: "delivery-1" } }, 201);
  };
  try {
    await workerApi.proposeAction("task-1", {
      operation: "history_revert",
      parameters: { document: "doc-token", historyVersionId: "history-1" },
      beforeSourceId: "source-current",
      afterSourceId: "source-history",
      historySourceId: "source-list",
      before: "must-not-leave-browser",
      after: "must-not-leave-browser",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const body = JSON.parse(request.options.body);
  assert.equal(request.url, "/api/v1/worker/tasks/task-1/actions");
  assert.equal(body.before_source_id, "source-current");
  assert.equal(body.after_source_id, "source-history");
  assert.equal(body.history_source_id, "source-list");
  assert.equal("before" in body, false);
  assert.equal("after" in body, false);
});

test("Worker mail attachment upload registers metadata then sends bytes to its controlled file id", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    if (requests.length === 1) {
      return jsonResponse({ file: { id: "worker-file-1", status: "awaiting_content" } }, 201);
    }
    return jsonResponse({
      file: {
        id: "worker-file-1",
        fileName: "report.pdf",
        status: "ready",
        sha256: "sha256:file",
      },
    }, 201);
  };
  const file = {
    name: "report.pdf",
    type: "application/pdf",
    size: 4096,
  };
  try {
    const uploaded = await workerApi.uploadTaskFile("task-1", file);
    assert.equal(uploaded.status, "ready");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "/api/v1/worker/tasks/task-1/files");
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    schema_version: 1,
    file_name: "report.pdf",
    mime_type: "application/pdf",
    byte_length: 4096,
  });
  assert.equal(
    requests[1].url,
    "/api/v1/worker/tasks/task-1/files/worker-file-1/content",
  );
  assert.equal(requests[1].options.method, "PUT");
  assert.equal(requests[1].options.body, file);
});

test("starting a draft edit invalidates the exact current revision on the server", async () => {
  const originalFetch = globalThis.fetch;
  let request = null;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return jsonResponse({ result: { invalidatedProposalIds: ["proposal-1"] } });
  };
  try {
    await workerApi.invalidateDraft("task-1", "draft-revision-3");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(request.url, "/api/v1/worker/tasks/task-1/drafts/invalidate");
  assert.deepEqual(JSON.parse(request.options.body), {
    schema_version: 1,
    draft_revision_id: "draft-revision-3",
  });
});

test("manual resolution of an unknown result is explicit and never sent as retry", async () => {
  const originalFetch = globalThis.fetch;
  let request = null;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return jsonResponse({ result: { status: "abandoned" } });
  };
  try {
    await workerApi.abandonAction("task-1", "proposal-1", {
      manualCheckCompleted: true,
      reason: "已在飞书中人工核对",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(request.url, "/api/v1/worker/tasks/task-1/actions/proposal-1/abandon");
  assert.deepEqual(JSON.parse(request.options.body), {
    schema_version: 1,
    reason: "已在飞书中人工核对",
    manual_check_completed: true,
  });
});
