import assert from "node:assert/strict";
import test from "node:test";
import {
  noteFileName,
  paperIdentityHash,
  parseManagedNote,
  renderManagedNote,
} from "./obsidianNoteFormat.js";

const paper = {
  paper_id: "paper-1",
  dedupe_key: "doi:10.1234/paper",
  title: "A / Managed: Note?",
  authors: ["Ada Author"],
  published_at: "2026-07-01",
};

test("managed note format has a stable paper identity and preserves Agent action blocks", () => {
  const agentMarkdown = [
    "## Agent 补充笔记",
    "",
    "<!-- pi-agent:agent-action:proposal-1:start -->",
    "### 解释",
    "",
    "这是已经确认写入的内容。",
    "<!-- pi-agent:agent-action:proposal-1:end -->",
  ].join("\n");
  const markdown = renderManagedNote({
    paper,
    workflowMarkdown: "# Paper\n\n## 研究问题\n\n内容",
    agentMarkdown,
  });
  const parsed = parseManagedNote(markdown, paper);

  assert.equal(parsed.status, "managed");
  assert.equal(parsed.identity_hash, paperIdentityHash(paper));
  assert.equal(parsed.workflow_markdown, "# Paper\n\n## 研究问题\n\n内容");
  assert.equal(parsed.agent_markdown, agentMarkdown);
  assert.match(noteFileName(paper), /^2026-Ada-Author-A-Managed-Note--[a-f0-9]{8}\.md$/);
});

test("managed note parser rejects unmanaged, mismatched, and malformed envelopes", () => {
  assert.equal(parseManagedNote("# User note", paper).status, "unmanaged");

  const managed = renderManagedNote({
    paper,
    workflowMarkdown: "# Paper",
  });
  assert.equal(
    parseManagedNote(managed, { ...paper, dedupe_key: "doi:10.1234/other" }).status,
    "identity_mismatch",
  );
  assert.equal(
    parseManagedNote(`${managed}\nUnexpected content`, paper).status,
    "malformed",
  );
  assert.throws(
    () => renderManagedNote({
      paper,
      workflowMarkdown: "# Paper\n\n<!-- pi-agent:workflow:end -->",
    }),
    /OBSIDIAN_MANAGED_NOTE_CONTENT_INVALID/,
  );
  assert.throws(
    () => renderManagedNote({
      paper,
      workflowMarkdown: "# Paper",
      agentMarkdown: [
        "## Agent 补充笔记",
        "<!-- pi-agent:agent-action:proposal-1:start -->",
        "<!-- pi-agent:agent-action:proposal-2:start -->",
        "<!-- pi-agent:agent-action:proposal-1:end -->",
        "<!-- pi-agent:agent-action:proposal-2:end -->",
      ].join("\n"),
    }),
    /OBSIDIAN_MANAGED_NOTE_CONTENT_INVALID/,
  );
});
