export const WORKER_DEFINITION_SCHEMA_VERSION = 1;

const BUILTIN_WORKER_DEFINITIONS = Object.freeze([
  Object.freeze({
    schemaVersion: WORKER_DEFINITION_SCHEMA_VERSION,
    id: "lark_doc",
    version: 1,
    name: "飞书文档 Worker",
    purpose: "读取、起草并在确认后精确修改飞书文档",
    connectorId: "lark",
    immutable: true,
    readCapabilities: Object.freeze([
      "search",
      "fetch",
      "history_list",
    ]),
    writeCapabilities: Object.freeze([
      Object.freeze({ operation: "create", risk: "low" }),
      Object.freeze({ operation: "append", risk: "low" }),
      Object.freeze({ operation: "overwrite", risk: "high" }),
      Object.freeze({ operation: "str_replace", risk: "medium" }),
      Object.freeze({ operation: "block_insert_after", risk: "low" }),
      Object.freeze({ operation: "block_replace", risk: "medium" }),
      Object.freeze({ operation: "block_delete", risk: "high" }),
      Object.freeze({ operation: "block_move_after", risk: "medium" }),
      Object.freeze({ operation: "history_revert", risk: "high" }),
    ]),
    toolProfile: Object.freeze({
      allowProjectContextRead: true,
      allowAttachmentRead: true,
      allowExternalRead: true,
      allowDeliveryProposal: true,
      allowShell: false,
      allowGit: false,
      allowProjectWrite: false,
      allowDirectExternalWrite: false,
      allowArbitraryMcp: false,
    }),
  }),
  Object.freeze({
    schemaVersion: WORKER_DEFINITION_SCHEMA_VERSION,
    id: "agent_mail",
    version: 1,
    name: "Agent 邮箱 Worker",
    purpose: "读取、起草并在确认后发送或整理 Agent 邮箱邮件",
    connectorId: "agent_mail",
    immutable: true,
    readCapabilities: Object.freeze([
      "list",
      "search",
      "read",
      "attachment_download",
    ]),
    writeCapabilities: Object.freeze([
      Object.freeze({ operation: "send", risk: "medium" }),
      Object.freeze({ operation: "reply", risk: "medium" }),
      Object.freeze({ operation: "reply_all", risk: "medium" }),
      Object.freeze({ operation: "forward", risk: "medium" }),
      Object.freeze({ operation: "trash", risk: "high" }),
    ]),
    toolProfile: Object.freeze({
      allowProjectContextRead: true,
      allowAttachmentRead: true,
      allowExternalRead: true,
      allowDeliveryProposal: true,
      allowShell: false,
      allowGit: false,
      allowProjectWrite: false,
      allowDirectExternalWrite: false,
      allowArbitraryMcp: false,
    }),
  }),
  Object.freeze({
    schemaVersion: WORKER_DEFINITION_SCHEMA_VERSION,
    id: "ima_note",
    version: 1,
    name: "IMA 笔记 Worker",
    purpose: "查询、读取并基于 IMA 笔记整理文字草稿",
    connectorId: "ima",
    immutable: true,
    readCapabilities: Object.freeze([
      "list_notebook",
      "list_note",
      "search_note",
      "get_doc_content",
    ]),
    writeCapabilities: Object.freeze([]),
    toolProfile: Object.freeze({
      allowProjectContextRead: true,
      allowAttachmentRead: true,
      allowExternalRead: true,
      allowDeliveryProposal: false,
      allowShell: false,
      allowGit: false,
      allowProjectWrite: false,
      allowDirectExternalWrite: false,
      allowArbitraryMcp: false,
    }),
  }),
]);

export function getBuiltinWorkerDefinitions() {
  return structuredClone(BUILTIN_WORKER_DEFINITIONS);
}

export function getWorkerOperation(definition, operation) {
  return definition?.writeCapabilities?.find(
    (candidate) => candidate.operation === operation,
  ) ?? null;
}
