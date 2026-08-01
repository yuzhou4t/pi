import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAgentMailReadInvocation,
  buildAgentMailWriteInvocation,
  buildImaReadInvocation,
  buildLarkReadInvocation,
  buildLarkWriteInvocation,
  createCliConnectionAdapter,
  createCliDeliveryExecutor,
  sha256,
} from "./index.js";

const MAIL_DRAFT = Object.freeze({
  id: "draft_1",
  content: "你好，这是本周进展。",
  format: "plain",
});

const MAIL_PROPOSAL = Object.freeze({
  id: "delivery_1",
  workerId: "agent_mail",
  operation: "send",
  parameters: {
    to: ["mentor@example.com"],
    cc: ["team@example.com"],
    bcc: [],
    subject: "本周进展",
    attachments: ["worker_file_report"],
  },
  attachmentBindings: [{
    id: "worker_file_report",
    fileName: "report.pdf",
    mimeType: "application/pdf",
    byteLength: 6,
    sha256: `sha256:${"1".repeat(64)}`,
  }],
  privateAttachmentPaths: [{
    id: "worker_file_report",
    relativePath: "worker_task_1/worker_file_report/report.pdf",
  }],
  baseRevisionId: null,
});

test("Agent Mail argv is fixed, shell-free, and confirmation only appends the native token", () => {
  const preview = buildAgentMailWriteInvocation({
    proposal: MAIL_PROPOSAL,
    draft: MAIL_DRAFT,
  });
  const confirmed = buildAgentMailWriteInvocation({
    proposal: MAIL_PROPOSAL,
    draft: MAIL_DRAFT,
    confirmationToken: "ctk_123",
  });
  assert.equal(preview.connector, "agent_mail");
  assert.deepEqual(confirmed.args.slice(0, preview.args.length), preview.args);
  assert.deepEqual(confirmed.args.slice(-2), ["--confirmation-token", "ctk_123"]);
  assert.deepEqual(preview.args.slice(0, 2), ["message", "+send"]);
  assert.equal(preview.args.includes("sh"), false);
  assert.equal(preview.args.includes("-c"), false);
});

test("Agent Mail attachment downloads stay inside the configured working directory", () => {
  const invocation = buildAgentMailReadInvocation("attachment_download", {
    messageId: "msg_123",
    attachmentId: "att_456",
    output: "./downloads",
  });
  assert.deepEqual(invocation.args, [
    "attachment", "+download",
    "--msg", "msg_123",
    "--att", "att_456",
    "--output", "./downloads",
  ]);
  assert.throws(
    () => buildAgentMailReadInvocation("attachment_download", {
      messageId: "msg_123",
      attachmentId: "att_456",
      output: "../outside",
    }),
    { code: "WORKER_ATTACHMENT_PATH_UNSAFE" },
  );
});

test("Agent Mail reads use fixed fields, enums, dates, and bounded pagination", () => {
  assert.deepEqual(buildAgentMailReadInvocation("list", {
    dir: "inbox",
    limit: 50,
    cursor: "cursor_1",
    after: "2026-07-01",
    before: "2026-07-31",
    hasAttachments: true,
    isUnread: true,
  }).args, [
    "message", "+list",
    "--dir", "inbox",
    "--limit", "50",
    "--cursor", "cursor_1",
    "--after", "2026-07-01",
    "--before", "2026-07-31",
    "--has-attachments",
    "--is-unread",
  ]);
  assert.deepEqual(buildAgentMailReadInvocation("search", {
    q: "周报",
    searchIn: "SEARCH_IN_SUBJECT",
    from: "sender@example.com",
    to: "worker@example.com",
    dir: "sent",
    after: "2024-02-29",
    before: "2026-08-01",
    cursor: "cursor_2",
    limit: "20",
  }).args, [
    "message", "+search", "--q", "周报",
    "--search-in", "SEARCH_IN_SUBJECT",
    "--from", "sender@example.com",
    "--to", "worker@example.com",
    "--dir", "sent",
    "--after", "2024-02-29",
    "--before", "2026-08-01",
    "--cursor", "cursor_2",
    "--limit", "20",
  ]);

  for (const [operation, parameters] of [
    ["list", { unknown: true }],
    ["list", { limit: 0 }],
    ["list", { limit: 51 }],
    ["list", { limit: 1.5 }],
    ["list", { limit: "" }],
    ["list", { dir: "archive" }],
    ["list", { dir: "--sent" }],
    ["list", { after: "2026-02-30" }],
    ["list", { before: "--help" }],
    ["list", { cursor: "--cursor" }],
    ["list", { hasAttachments: "true" }],
    ["search", { q: "周报", searchIn: "SUBJECT" }],
    ["search", { q: "--help" }],
    ["search", { q: "周报", from: "--help" }],
    ["read", { messageId: "msg_1", unexpected: true }],
    ["attachment_download", {
      messageId: "msg_1",
      attachmentId: "att_1",
      output: "./downloads",
      unexpected: true,
    }],
  ]) {
    assert.throws(
      () => buildAgentMailReadInvocation(operation, parameters),
      { code: "WORKER_READ_INPUT_INVALID" },
    );
  }
});

test("Lark update argv binds the reviewed base revision and precise block ids", () => {
  const invocation = buildLarkWriteInvocation({
    proposal: {
      workerId: "lark_doc",
      operation: "block_move_after",
      baseRevisionId: 42,
      parameters: {
        document: "docx_token",
        anchorBlockId: "blk_anchor",
        sourceBlockIds: ["blk_a", "blk_b"],
      },
    },
    draft: null,
  });
  assert.deepEqual(invocation.args.slice(0, 4), ["docs", "+update", "--as", "user"]);
  assert.equal(invocation.args[invocation.args.indexOf("--revision-id") + 1], "42");
  assert.equal(invocation.args[invocation.args.indexOf("--block-id") + 1], "blk_anchor");
  assert.equal(
    invocation.args[invocation.args.indexOf("--src-block-ids") + 1],
    "blk_a,blk_b",
  );
});

test("IMA note reads use the fixed wrapper and bounded OpenAPI payloads", () => {
  const wrapperPath = "/fixed/ima/ima_api.cjs";
  const search = buildImaReadInvocation("search_note", {
    query: "项目排期",
    searchType: "content",
    start: 20,
    end: 30,
  }, { wrapperPath });
  assert.equal(search.connector, "ima");
  assert.equal(search.args[0], wrapperPath);
  assert.equal(search.args[1], "openapi/note/v1/search_note");
  assert.deepEqual(JSON.parse(search.args[2]), {
    search_type: 1,
    query_info: { content: "项目排期" },
    start: 20,
    end: 30,
  });

  const content = buildImaReadInvocation("get_doc_content", {
    noteId: "note_123",
    targetContentFormat: 0,
  }, { wrapperPath });
  assert.deepEqual(JSON.parse(content.args[2]), {
    note_id: "note_123",
    target_content_format: 0,
  });
  for (const [operation, parameters] of [
    ["search_note", { query: "" }],
    ["list_note", { limit: 21 }],
    ["search_note", { query: "排期", start: 20, end: 41 }],
    ["get_doc_content", { noteId: "note_123", targetContentFormat: 2 }],
    ["list_note", { unexpected: true }],
    ["get_doc_content", { noteId: "--help" }],
    ["import_doc", { content: "不得写入" }],
  ]) {
    assert.throws(
      () => buildImaReadInvocation(operation, parameters, { wrapperPath }),
      { code: operation === "import_doc"
        ? "WORKER_IMA_OPERATION_NOT_ALLOWED"
        : "WORKER_READ_INPUT_INVALID" },
    );
  }
});

test("Lark document search uses the fixed read-only CLI contract", async () => {
  const calls = [];
  const adapter = createCliConnectionAdapter({
    runner: {
      async run(invocation) {
        calls.push(structuredClone(invocation));
        return {
          exitCode: 0,
          stdout: JSON.stringify({ ok: true, data: { items: [{ title: "周报" }] } }),
          stderr: "",
        };
      },
    },
  });
  const result = await adapter.read({
    workerId: "lark_doc",
    operation: "search",
    parameters: {
      query: "本周周报",
      filter: { owner_id: "me" },
      pageSize: 10,
      pageToken: "next_page",
    },
  });
  assert.deepEqual(calls, [{
    connector: "lark",
    args: [
      "docs", "+search", "--as", "user",
      "--query", "本周周报",
      "--page-size", "10",
      "--filter", "{\"owner_id\":\"me\"}",
      "--page-token", "next_page",
    ],
  }]);
  assert.equal(result.untrustedExternalContent, true);
  assert.deepEqual(result.data, { items: [{ title: "周报" }] });
});

test("Lark reads reject unbounded or unsupported parameters before the runner", async () => {
  let calls = 0;
  const adapter = createCliConnectionAdapter({
    runner: {
      async run() {
        calls += 1;
        return { exitCode: 0, stdout: "{}", stderr: "" };
      },
    },
  });
  for (const context of [
    { operation: "search", parameters: { query: "" } },
    { operation: "search", parameters: { query: "a".repeat(4_097) } },
    { operation: "search", parameters: { query: "周报", pageSize: 0 } },
    { operation: "search", parameters: { query: "周报", pageSize: 21 } },
    { operation: "search", parameters: { query: "周报", pageSize: 1.5 } },
    { operation: "search", parameters: { query: "周报", pageToken: "a".repeat(8_193) } },
    { operation: "search", parameters: { query: "周报", unexpected: true } },
    { operation: "search", parameters: { query: "周报", filter: "owner_id=me" } },
    { operation: "fetch", parameters: { document: "docx_token", detail: "raw" } },
    { operation: "history_list", parameters: { document: "docx_token", pageSize: 100 } },
  ]) {
    await assert.rejects(
      adapter.read({ workerId: "lark_doc", ...context }),
      { code: "WORKER_READ_INPUT_INVALID" },
    );
  }
  assert.equal(calls, 0);
  assert.deepEqual(
    buildLarkReadInvocation("fetch", { document: "docx_token", detail: "with-ids" }).args,
    ["docs", "+fetch", "--as", "user", "--doc", "docx_token", "--detail", "with-ids"],
  );
});

test("CLI executor preserves Agent Mail two-phase confirmation semantics", async () => {
  const calls = [];
  const runner = {
    async run(invocation) {
      calls.push(structuredClone(invocation));
      if (calls.length === 1) {
        return {
          exitCode: 8,
          stdout: JSON.stringify({
            ok: false,
            data: {
              confirmation_required: true,
              confirmation_token: "ctk_abc",
              summary: { to: ["mentor@example.com"] },
            },
          }),
          stderr: "",
        };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          ok: true,
          data: { message_id: "msg_sent_1", status: "queued" },
        }),
        stderr: "",
      };
    },
  };
  const executor = createCliDeliveryExecutor({
    runner,
    now: () => new Date("2026-08-01T00:00:00.000Z"),
  });
  const prepared = await executor.prepare({ proposal: MAIL_PROPOSAL, draft: MAIL_DRAFT });
  assert.equal(prepared.privateState.confirmationToken, "ctk_abc");
  assert.equal(calls[0].args.includes("--confirmation-token"), false);
  const result = await executor.execute({
    proposal: MAIL_PROPOSAL,
    draft: MAIL_DRAFT,
    privateState: prepared.privateState,
  });
  assert.equal(result.deliveryStatus, "queued");
  assert.equal(result.externalId, "msg_sent_1");
  assert.equal(
    calls[1].args[calls[1].args.indexOf("--confirmation-token") + 1],
    "ctk_abc",
  );
  assert.deepEqual(
    calls[1].args.slice(0, calls[0].args.length),
    calls[0].args,
  );
});

test("CLI executor checks the live Lark revision before any write", async () => {
  const calls = [];
  const runner = {
    async run(invocation) {
      calls.push(structuredClone(invocation));
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          ok: true,
          data: { document: { revision_id: 43 } },
        }),
        stderr: "",
      };
    },
  };
  const executor = createCliDeliveryExecutor({
    runner,
    historyPollAttempts: 2,
    historyPollIntervalMs: 0,
  });
  await assert.rejects(
    executor.execute({
      proposal: {
        id: "delivery_lark",
        workerId: "lark_doc",
        operation: "append",
        baseRevisionId: 42,
        parameters: { document: "docx_token" },
      },
      draft: { content: "<p>追加内容</p>", format: "xml" },
      privateState: null,
    }),
    { code: "WORKER_LARK_BASE_REVISION_STALE" },
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(0, 2), ["docs", "+fetch"]);
});

test("an asynchronous Lark history restore remains queued until provider completion", async () => {
  const calls = [];
  const runner = {
    async run(invocation) {
      calls.push(structuredClone(invocation));
      if (calls.length === 1) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            ok: true,
            data: { document: { revision_id: 9 } },
          }),
          stderr: "",
        };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          ok: true,
          data: {
            result: "success",
            status: "running",
            task_id: "revert_task_1",
          },
        }),
        stderr: "",
      };
    },
  };
  const executor = createCliDeliveryExecutor({
    runner,
    historyPollAttempts: 2,
    historyPollIntervalMs: 0,
  });
  const result = await executor.execute({
    proposal: {
      id: "delivery_revert",
      workerId: "lark_doc",
      operation: "history_revert",
      baseRevisionId: 9,
      parameters: {
        document: "docx_token",
        historyVersionId: "history_1",
      },
    },
    draft: null,
  });
  assert.equal(result.deliveryStatus, "queued");
  assert.equal(result.providerState, "running");
  assert.equal(result.externalId, "revert_task_1");
  assert.deepEqual(result.verification, {
    status: "pending_provider_completion",
    taskId: "revert_task_1",
    revisionId: null,
  });
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[2].args.slice(0, 2), ["docs", "+history-revert-status"]);
  assert.deepEqual(calls[3].args.slice(0, 2), ["docs", "+history-revert-status"]);
});

test("Agent Mail preparation treats ambiguous exit-0 success as an unknown outcome", async () => {
  const executor = createCliDeliveryExecutor({
    runner: {
      async run() {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            ok: true,
            data: {
              confirmation_token: "ctk_must_not_be_accepted",
              summary: { to: ["mentor@example.com"] },
            },
          }),
          stderr: "",
        };
      },
    },
  });
  await assert.rejects(
    executor.prepare({ proposal: MAIL_PROPOSAL, draft: MAIL_DRAFT }),
    { code: "WORKER_MAIL_OUTCOME_UNKNOWN" },
  );
});

test("exit-0 malformed JSON never becomes a successful read or delivery", async () => {
  const malformedRunner = {
    async run() {
      return { exitCode: 0, stdout: "not-json", stderr: "" };
    },
  };
  const connection = createCliConnectionAdapter({ runner: malformedRunner });
  await assert.rejects(
    connection.read({
      workerId: "lark_doc",
      operation: "search",
      parameters: { query: "周报" },
    }),
    { code: "WORKER_LARK_RESPONSE_INVALID" },
  );
  const executor = createCliDeliveryExecutor({ runner: malformedRunner });
  await assert.rejects(
    executor.execute({
      proposal: {
        id: "delivery_create",
        workerId: "lark_doc",
        operation: "create",
        baseRevisionId: null,
        parameters: { title: "周报" },
      },
      draft: { content: "<p>正文</p>", format: "xml" },
    }),
    { code: "WORKER_LARK_OUTCOME_UNKNOWN", unknownOutcome: true },
  );
});

test("Lark health accepts the current direct auth-status envelope and requires a verified user", async () => {
  const calls = [];
  const adapter = createCliConnectionAdapter({
    runner: {
      async run(invocation) {
        calls.push(structuredClone(invocation));
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            appId: "cli_test",
            identities: {
              bot: { status: "ready", verified: true },
              user: {
                status: "ready",
                verified: true,
                userName: "Worker User",
                tokenStatus: "valid",
              },
            },
            verified: true,
          }),
          stderr: "",
        };
      },
    },
  });
  assert.deepEqual(await adapter.health({ workerId: "lark_doc" }), {
    workerId: "lark_doc",
    status: "connected",
    verified: true,
    identity: "Worker User",
    aliases: [],
    reason: null,
  });
  assert.deepEqual(calls, [{
    connector: "lark",
    args: ["auth", "status", "--json", "--verify"],
  }]);

  const botOnly = createCliConnectionAdapter({
    runner: {
      async run() {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            identities: {
              bot: { status: "ready", verified: true },
              user: { status: "missing", verified: false },
            },
            verified: false,
          }),
          stderr: "",
        };
      },
    },
  });
  assert.deepEqual(await botOnly.health({ workerId: "lark_doc" }), {
    workerId: "lark_doc",
    status: "unavailable",
    verified: false,
    identity: null,
    aliases: [],
    reason: "connection_check_failed",
  });
});

test("Agent Mail health uses +me and requires a verified mailbox identity", async () => {
  const calls = [];
  const adapter = createCliConnectionAdapter({
    runner: {
      async run(invocation) {
        calls.push(structuredClone(invocation));
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            ok: true,
            data: {
              aliases: [{
                email: "secondary@example.com",
                is_primary: false,
                status: "active",
              }, {
                email: "worker@example.com",
                is_primary: true,
                status: "active",
              }],
            },
          }),
          stderr: "",
        };
      },
    },
  });
  const health = await adapter.health({ workerId: "agent_mail" });
  assert.deepEqual(calls, [{ connector: "agent_mail", args: ["+me"] }]);
  assert.equal(health.status, "connected");
  assert.equal(health.verified, true);
  assert.equal(health.identity, "worker@example.com");
  assert.deepEqual(health.aliases, ["secondary@example.com", "worker@example.com"]);

  const invalid = createCliConnectionAdapter({
    runner: {
      async run() {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ ok: true, data: { aliases: [] } }),
          stderr: "",
        };
      },
    },
  });
  assert.deepEqual(await invalid.health({ workerId: "agent_mail" }), {
    workerId: "agent_mail",
    status: "unavailable",
    verified: false,
    identity: null,
    aliases: [],
    reason: "connection_check_failed",
  });
});

test("IMA health and reads require code zero without exposing credentials", async () => {
  const calls = [];
  const adapter = createCliConnectionAdapter({
    imaWrapperPath: "/fixed/ima/ima_api.cjs",
    runner: {
      async run(invocation) {
        calls.push(structuredClone(invocation));
        return {
          exitCode: 0,
          stdout: JSON.stringify({ code: 0, msg: "ok", data: { note_list: [] } }),
          stderr: "",
        };
      },
    },
  });
  const health = await adapter.health({ workerId: "ima_note" });
  assert.deepEqual(health, {
    workerId: "ima_note",
    status: "connected",
    verified: true,
    identity: null,
    aliases: [],
    reason: null,
  });
  const read = await adapter.read({
    workerId: "ima_note",
    operation: "list_note",
    parameters: { cursor: "", limit: 1 },
  });
  assert.equal(read.untrustedExternalContent, true);
  assert.deepEqual(read.data, { note_list: [] });
  assert.equal(calls.every((call) => call.connector === "ima"), true);

  const unauthorized = createCliConnectionAdapter({
    imaWrapperPath: "/fixed/ima/ima_api.cjs",
    runner: {
      async run() {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ code: 200002, msg: "skill auth failed", data: null }),
          stderr: "",
        };
      },
    },
  });
  assert.deepEqual(await unauthorized.health({ workerId: "ima_note" }), {
    workerId: "ima_note",
    status: "unavailable",
    verified: false,
    identity: null,
    aliases: [],
    reason: "skill auth failed",
  });
});

test("queued history restore retry polls status and verifies content without reissuing revert", async () => {
  const calls = [];
  const expectedContent = '<p id="blk_old">历史正文</p>';
  const executor = createCliDeliveryExecutor({
    runner: {
      async run(invocation) {
        calls.push(structuredClone(invocation));
        if (invocation.args[1] === "+history-revert-status") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              ok: true,
              data: { status: "done", task_id: "revert_task_1" },
            }),
            stderr: "",
          };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            ok: true,
            data: {
              document: {
                document_id: "docx_token",
                revision_id: 10,
                content: expectedContent,
              },
            },
          }),
          stderr: "",
        };
      },
    },
    historyPollAttempts: 2,
    historyPollIntervalMs: 0,
  });
  const result = await executor.resume({
    proposal: {
      id: "delivery_revert",
      workerId: "lark_doc",
      operation: "history_revert",
      baseRevisionId: 9,
      parameters: { document: "docx_token", historyVersionId: "history_1" },
      sourceBindings: {
        after: { exactContentSha256: sha256(expectedContent) },
      },
    },
    receipt: {
      externalId: "revert_task_1",
      verification: { taskId: "revert_task_1" },
    },
  });
  assert.equal(result.deliveryStatus, "completed");
  assert.deepEqual(calls.map((call) => call.args[1]), [
    "+history-revert-status",
    "+fetch",
  ]);
  assert.equal(calls.some((call) => call.args[1] === "+history-revert"), false);
});

test("completed history restore with malformed read-back becomes unknown", async () => {
  let call = 0;
  const executor = createCliDeliveryExecutor({
    runner: {
      async run() {
        call += 1;
        if (call === 1) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ ok: true, data: { document: { revision_id: 9 } } }),
            stderr: "",
          };
        }
        if (call === 2) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              ok: true,
              data: { status: "done", task_id: "revert_task_1" },
            }),
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "{}", stderr: "" };
      },
    },
    historyPollIntervalMs: 0,
  });
  await assert.rejects(
    executor.execute({
      proposal: {
        id: "delivery_revert",
        workerId: "lark_doc",
        operation: "history_revert",
        baseRevisionId: 9,
        parameters: { document: "docx_token", historyVersionId: "history_1" },
        sourceBindings: { after: { exactContentSha256: sha256("历史正文") } },
      },
      draft: null,
    }),
    { code: "WORKER_LARK_OUTCOME_UNKNOWN", unknownOutcome: true },
  );
});
