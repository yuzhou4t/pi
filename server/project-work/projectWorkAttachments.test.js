import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeProjectWorkTextAttachments,
  projectWorkTextAttachmentPrompt,
} from "./projectWorkAttachments.js";

test("temporary text attachments are bounded and become explicit message context", () => {
  const [attachment] = normalizeProjectWorkTextAttachments([{
    file_name: "notes.md",
    mime_type: "text/markdown",
    text: "# Notes\nOnly for this message.",
  }]);

  assert.equal(attachment.metadata.fileName, "notes.md");
  assert.equal(attachment.metadata.mimeType, "text/markdown");
  assert.equal(attachment.metadata.byteLength, 30);
  assert.match(attachment.metadata.contentHash, /^sha256:[a-f0-9]{64}$/);
  assert.match(projectWorkTextAttachmentPrompt([attachment]), /message context only/);
  assert.match(projectWorkTextAttachmentPrompt([attachment]), /Only for this message/);
});

test("temporary text attachments reject binary and oversized input", () => {
  assert.throws(
    () => normalizeProjectWorkTextAttachments([{
      fileName: "archive.zip",
      mimeType: "application/zip",
      text: "not really text",
    }]),
    /暂不支持附件 archive\.zip/,
  );
  assert.throws(
    () => normalizeProjectWorkTextAttachments([{
      fileName: ".env.local",
      mimeType: "text/plain",
      text: "TOKEN=do-not-send",
    }]),
    /暂不支持附件 \.env\.local/,
  );
  assert.throws(
    () => normalizeProjectWorkTextAttachments([{
      fileName: "large.txt",
      mimeType: "text/plain",
      text: "x".repeat(120 * 1024 + 1),
    }]),
    /不能超过 120 KB/,
  );
});
