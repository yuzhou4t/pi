import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
} from "node:fs/promises";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  bindProjectWorkMessageAttachments,
  createConversationAttachmentService,
  MAX_PROJECT_WORK_TEXT_ATTACHMENT_BYTES,
  projectWorkAttachmentManifestPrompt,
} from "./projectWorkAttachments.js";

async function createHarness(t) {
  let state = {
    id: "conversation-attachment-1",
    attachments: [],
  };
  const events = [];
  let idSequence = 0;
  let tick = 0;
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-attachments-"));
  const conversationRoot = path.join(root, state.id);
  await mkdir(conversationRoot, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = createConversationAttachmentService({
    getConversation: async () => structuredClone(state),
    updateConversation: async (_conversationId, updater) => {
      const patch = typeof updater === "function"
        ? await updater(structuredClone(state))
        : updater;
      state = { ...state, ...patch };
      return structuredClone(state);
    },
    appendEvent: async (_conversationId, type, data) => {
      events.push({ type, data });
    },
    directoryForConversation: () => conversationRoot,
    idFactory: () => `fixture-${++idSequence}`,
    now: () => new Date(Date.UTC(2026, 6, 29, 0, 0, tick++)),
  });
  return {
    events,
    service,
    get state() {
      return structuredClone(state);
    },
    set state(next) {
      state = structuredClone(next);
    },
  };
}

test("ordinary attachments stay private until the Agent reads bounded ranges", async (t) => {
  const harness = await createHarness(t);
  const content = [
    "# Review",
    "Inspect the current route.",
    "The primary button should remain visible.",
  ].join("\n");
  const bytes = Buffer.from(content);
  const created = await harness.service.createAttachment(harness.state.id, {
    fileName: "review.md",
    mimeType: "text/markdown",
    byteLength: bytes.length,
  });
  const ready = await harness.service.uploadContent(
    harness.state.id,
    created.id,
    Readable.from([bytes.subarray(0, 8), bytes.subarray(8)]),
    {
      contentType: "text/markdown",
      declaredLength: String(bytes.length),
    },
  );

  assert.equal(ready.status, "ready");
  assert.match(ready.revision, /^sha256:[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(harness.state), /primary button/);
  assert.deepEqual(await harness.service.listForAgent(harness.state.id), []);

  const bound = bindProjectWorkMessageAttachments(
    harness.state,
    [{
      attachment_id: ready.id,
      attachment_revision: ready.revision,
    }],
    {
      messageId: "message-1",
      boundAt: "2026-07-29T00:01:00.000Z",
    },
  );
  harness.state = {
    ...harness.state,
    attachments: bound.attachments,
  };
  const manifest = projectWorkAttachmentManifestPrompt(
    bound.messageAttachments,
  );
  assert.match(manifest, /read_attachment/);
  assert.match(manifest, /review\.md/);
  assert.doesNotMatch(manifest, /primary button/);

  const listed = await harness.service.listForAgent(harness.state.id);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].attachment_id, ready.id);
  const matches = await harness.service.searchForAgent(harness.state.id, {
    query: "primary button",
  });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].line, 3);

  const first = await harness.service.readForAgent(harness.state.id, {
    attachmentId: ready.id,
    revision: ready.revision,
    offset: 0,
    limit: 16,
  });
  assert.equal(first.content, content.slice(0, 16));
  assert.equal(first.has_more, true);
  assert.equal(first.next_offset, 16);
  const rest = await harness.service.readForAgent(harness.state.id, {
    attachmentId: ready.id,
    revision: ready.revision,
    offset: first.next_offset,
  });
  assert.equal(first.content + rest.content, content);
  assert.equal(rest.has_more, false);
  assert.equal(rest.next_offset, null);
});

test("ordinary attachments reject sensitive, oversized, and non-UTF-8 files", async (t) => {
  const harness = await createHarness(t);
  await assert.rejects(
    harness.service.createAttachment(harness.state.id, {
      fileName: ".env.local",
      mimeType: "text/plain",
      byteLength: 12,
    }),
    /暂不支持附件 \.env\.local/,
  );
  await assert.rejects(
    harness.service.createAttachment(harness.state.id, {
      fileName: "large.txt",
      mimeType: "text/plain",
      byteLength: MAX_PROJECT_WORK_TEXT_ATTACHMENT_BYTES + 1,
    }),
    /不超过 5 MB/,
  );

  const created = await harness.service.createAttachment(harness.state.id, {
    fileName: "invalid.txt",
    mimeType: "text/plain",
    byteLength: 2,
  });
  await assert.rejects(
    harness.service.uploadContent(
      harness.state.id,
      created.id,
      Readable.from([Buffer.from([0xc3, 0x28])]),
      {
        contentType: "text/plain",
        declaredLength: "2",
      },
    ),
    /不是 UTF-8 文本文件/,
  );
});

test("unbound attachments can be removed but sent attachments remain durable", async (t) => {
  const harness = await createHarness(t);
  const content = Buffer.from("temporary");
  const removable = await harness.service.createAttachment(harness.state.id, {
    fileName: "remove-me.txt",
    mimeType: "text/plain",
    byteLength: content.length,
  });
  await harness.service.uploadContent(
    harness.state.id,
    removable.id,
    Readable.from([content]),
    {
      contentType: "text/plain",
      declaredLength: String(content.length),
    },
  );
  const removed = await harness.service.removeAttachment(
    harness.state.id,
    removable.id,
  );
  assert.equal(removed.removed, true);
  assert.equal(
    harness.state.attachments.some((attachment) => attachment.id === removable.id),
    false,
  );

  const created = await harness.service.createAttachment(harness.state.id, {
    fileName: "temporary.txt",
    mimeType: "text/plain",
    byteLength: content.length,
  });
  const ready = await harness.service.uploadContent(
    harness.state.id,
    created.id,
    Readable.from([content]),
    {
      contentType: "text/plain",
      declaredLength: String(content.length),
    },
  );
  const bound = bindProjectWorkMessageAttachments(
    harness.state,
    [{
      attachmentId: ready.id,
      attachmentRevision: ready.revision,
    }],
    {
      messageId: "message-1",
      boundAt: "2026-07-29T00:02:00.000Z",
    },
  );
  harness.state = {
    ...harness.state,
    attachments: bound.attachments,
  };
  await assert.rejects(
    harness.service.removeAttachment(harness.state.id, ready.id),
    /会话记录保留/,
  );
});
