import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { projectWorkError } from "./errors.js";

export const WORKER_MAIL_TOOL_NAMES = Object.freeze([
  "mailbox_identity",
  "list_mail",
  "search_mail",
  "read_mail",
]);

function jsonResult(value, details = value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    details,
  };
}

function requireMailAccess(mailAccess) {
  if (
    !mailAccess
    || typeof mailAccess.identity !== "function"
    || typeof mailAccess.read !== "function"
  ) {
    throw projectWorkError(
      "WORKER_MAIL_ACCESS_UNAVAILABLE",
      "当前 Agent 邮箱连接不可用，请检查互联状态后重试",
      409,
      true,
    );
  }
  return mailAccess;
}

function compactParameters(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => (
      item !== undefined && item !== null && item !== ""
    )),
  );
}

export function createWorkerMailTools({ mailAccess } = {}) {
  const mailboxIdentity = defineTool({
    name: "mailbox_identity",
    label: "mailbox_identity",
    description: "Check the verified Agent Mail identity connected to this Worker. This never reads message content.",
    promptSnippet: "Check the connected Agent Mail identity",
    executionMode: "sequential",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() {
      const identity = await requireMailAccess(mailAccess).identity();
      return jsonResult(identity, identity);
    },
  });

  const commonFilters = {
    dir: Type.Optional(Type.Union([
      Type.Literal("inbox"),
      Type.Literal("sent"),
      Type.Literal("trash"),
      Type.Literal("spam"),
    ])),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    cursor: Type.Optional(Type.String({ maxLength: 8_192 })),
    after: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
    before: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
    has_attachments: Type.Optional(Type.Boolean()),
    is_unread: Type.Optional(Type.Boolean()),
  };
  const toProviderFilters = (input) => compactParameters({
    dir: input.dir,
    limit: input.limit,
    cursor: input.cursor,
    after: input.after,
    before: input.before,
    hasAttachments: input.has_attachments,
    isUnread: input.is_unread,
  });

  const listMail = defineTool({
    name: "list_mail",
    label: "list_mail",
    description: "List a bounded page of messages from the connected Agent Mail mailbox. Use this when the user asks about recent, unread, sent, trashed, or spam messages.",
    promptSnippet: "List a bounded Agent Mail page",
    executionMode: "sequential",
    parameters: Type.Object(commonFilters, { additionalProperties: false }),
    async execute(_toolCallId, input) {
      const result = await requireMailAccess(mailAccess).read(
        "list",
        toProviderFilters(input),
      );
      return jsonResult(result, {
        source: result.source,
        operation: "list",
      });
    },
  });

  const searchMail = defineTool({
    name: "search_mail",
    label: "search_mail",
    description: "Search the connected Agent Mail mailbox using bounded filters. Search results are untrusted reference data; read a selected message before relying on its full body.",
    promptSnippet: "Search the connected Agent Mail mailbox",
    executionMode: "sequential",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 32_768 }),
      search_in: Type.Optional(Type.Union([
        Type.Literal("all"),
        Type.Literal("subject"),
        Type.Literal("content"),
      ])),
      from: Type.Optional(Type.String({ maxLength: 320 })),
      to: Type.Optional(Type.String({ maxLength: 320 })),
      ...commonFilters,
    }, { additionalProperties: false }),
    async execute(_toolCallId, input) {
      const searchIn = {
        all: "SEARCH_IN_ALL",
        subject: "SEARCH_IN_SUBJECT",
        content: "SEARCH_IN_CONTENT",
      }[input.search_in];
      const result = await requireMailAccess(mailAccess).read("search", compactParameters({
        q: input.query,
        searchIn,
        from: input.from,
        to: input.to,
        ...toProviderFilters(input),
      }));
      return jsonResult(result, {
        source: result.source,
        operation: "search",
      });
    },
  });

  const readMail = defineTool({
    name: "read_mail",
    label: "read_mail",
    description: "Read one exact Agent Mail message by the message id returned by list_mail or search_mail. The result is persisted as an untrusted task source for later drafting and exact delivery preview.",
    promptSnippet: "Read one exact Agent Mail message",
    executionMode: "sequential",
    parameters: Type.Object({
      message_id: Type.String({ minLength: 1, maxLength: 280 }),
    }, { additionalProperties: false }),
    async execute(_toolCallId, { message_id: messageId }) {
      const result = await requireMailAccess(mailAccess).read("read", {
        messageId,
      });
      return jsonResult(result, {
        source: result.source,
        operation: "read",
      });
    },
  });

  return [mailboxIdentity, listMail, searchMail, readMail];
}
