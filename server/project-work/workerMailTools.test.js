import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorkerMailTools,
  WORKER_MAIL_TOOL_NAMES,
} from "./workerMailTools.js";

function toolByName(tools, name) {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `missing ${name}`);
  return tool;
}

test("Agent Mail tools expose only bounded identity and read operations", async () => {
  const calls = [];
  const tools = createWorkerMailTools({
    mailAccess: {
      async identity() {
        return {
          status: "connected",
          verified: true,
          identity: "worker@example.com",
        };
      },
      async read(operation, parameters) {
        calls.push({ operation, parameters });
        return {
          workerId: "agent_mail",
          operation,
          untrustedExternalContent: true,
          data: { messages: [{ id: "msg_1", subject: "周报" }] },
          source: { id: `source_${operation}`, operation },
        };
      },
    },
  });

  assert.deepEqual(tools.map((tool) => tool.name), WORKER_MAIL_TOOL_NAMES);
  assert.equal(tools.some((tool) => /send|reply|forward|trash/u.test(tool.name)), false);

  const identity = await toolByName(tools, "mailbox_identity").execute(
    "mail-identity",
    {},
  );
  assert.equal(identity.details.identity, "worker@example.com");

  const listed = await toolByName(tools, "list_mail").execute("mail-list", {
    dir: "inbox",
    limit: 10,
    is_unread: true,
  });
  assert.equal(listed.details.source.id, "source_list");

  await toolByName(tools, "search_mail").execute("mail-search", {
    query: "项目周报",
    search_in: "subject",
    from: "sender@example.com",
    has_attachments: false,
  });
  await toolByName(tools, "read_mail").execute("mail-read", {
    message_id: "msg_1",
  });

  assert.deepEqual(calls, [
    {
      operation: "list",
      parameters: { dir: "inbox", limit: 10, isUnread: true },
    },
    {
      operation: "search",
      parameters: {
        q: "项目周报",
        searchIn: "SEARCH_IN_SUBJECT",
        from: "sender@example.com",
        hasAttachments: false,
      },
    },
    {
      operation: "read",
      parameters: { messageId: "msg_1" },
    },
  ]);
});

test("Agent Mail tools fail closed without a bound Worker connector", async () => {
  const tools = createWorkerMailTools();
  await assert.rejects(
    toolByName(tools, "list_mail").execute("mail-list", { limit: 5 }),
    { code: "WORKER_MAIL_ACCESS_UNAVAILABLE" },
  );
});
