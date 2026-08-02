import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDocumentIndex,
  DOCUMENT_INDEX_MAX_BYTES,
} from "./documentIndex.js";

const mineruSample = [
  "# A Paper",
  "",
  "Ada Author",
  "",
  "## Abstract",
  "",
  "First paragraph keeps *all* Markdown.",
  "",
  "## Method",
  "",
  "### Retrieval",
  "",
  "![](images/figure.jpg)  ",
  "Figure 1: Retrieval flow.",
  "",
  "<table><tr><td>Method</td><td>Score</td></tr></table>",
  "",
].join("\n");

test("indexes MinerU-style Markdown into sections and lossless blocks", () => {
  const index = buildDocumentIndex(mineruSample);

  assert.equal(index.title, "A Paper");
  assert.deepEqual(index.sections.map((section) => ({
    title: section.title,
    level: section.level,
    path: section.path,
  })), [
    { title: null, level: 0, path: [] },
    { title: "A Paper", level: 1, path: ["A Paper"] },
    { title: "Abstract", level: 2, path: ["A Paper", "Abstract"] },
    { title: "Method", level: 2, path: ["A Paper", "Method"] },
    { title: "Retrieval", level: 3, path: ["A Paper", "Method", "Retrieval"] },
  ]);
  assert.deepEqual(
    index.blocks.map((block) => block.kind),
    ["heading", "text", "heading", "text", "heading", "heading", "image", "table"],
  );
  assert.equal(index.blocks[6].text, "Figure 1: Retrieval flow.");
  assert.equal(index.blocks.map((block) => block.markdown).join(""), mineruSample);
  assert.deepEqual(index.blocks[6].path, ["A Paper", "Method", "Retrieval"]);
  assert.equal(index.blocks[6].section_id, index.sections[4].section_id);
});

test("produces deterministic, unique identifiers without page metadata", () => {
  const markdown = "# Same\n\nRepeated.\n\nRepeated.\n\n## Same\n\nRepeated.\n";
  const first = buildDocumentIndex(markdown);
  const second = buildDocumentIndex(markdown);

  assert.deepEqual(first, second);
  assert.equal(new Set(first.blocks.map((block) => block.block_id)).size, first.blocks.length);
  assert.equal(
    new Set(first.sections.map((section) => section.section_id)).size,
    first.sections.length,
  );
  assert.match(first.blocks[0].block_id, /^block-[a-f0-9]{20}$/);
  assert.match(first.sections[1].section_id, /^section-[a-f0-9]{20}$/);
  assert.equal(JSON.stringify(first).includes('"page"'), false);
});

test("keeps fenced headings as text and preserves CRLF source bytes", () => {
  const markdown = [
    "# Title\r\n",
    "\r\n",
    "```md\r\n",
    "## Not a section\r\n",
    "```\r\n",
    "\r\n",
    "## Real section\r\n",
  ].join("");
  const index = buildDocumentIndex(markdown);

  assert.deepEqual(index.sections.map((section) => section.title), [
    null,
    "Title",
    "Real section",
  ]);
  assert.deepEqual(index.blocks.map((block) => block.kind), [
    "heading",
    "text",
    "heading",
  ]);
  assert.equal(index.blocks.map((block) => block.markdown).join(""), markdown);
});

test("recognizes pipe tables while leaving formulas in the minimal text kind", () => {
  const markdown = [
    "# Results\n",
    "\n",
    "| Model | Score |\n",
    "| :--- | ---: |\n",
    "| Pi | 1 |\n",
    "\n",
    "$$\n",
    "x = y + 1\n",
    "$$\n",
  ].join("");
  const index = buildDocumentIndex(markdown);

  assert.deepEqual(index.blocks.map((block) => block.kind), [
    "heading",
    "table",
    "text",
  ]);
  assert.equal(index.blocks.map((block) => block.markdown).join(""), markdown);
});

test("rejects invalid, empty, and oversized input before indexing", () => {
  assert.throws(
    () => buildDocumentIndex(null),
    (error) => error instanceof TypeError && /must be a string/.test(error.message),
  );
  assert.throws(
    () => buildDocumentIndex(" \n\t"),
    (error) => error instanceof TypeError && /must not be empty/.test(error.message),
  );
  assert.throws(
    () => buildDocumentIndex("a".repeat(DOCUMENT_INDEX_MAX_BYTES + 1)),
    (error) => error instanceof RangeError && /UTF-8 bytes/.test(error.message),
  );
});

test("enforces the byte limit on UTF-8 input rather than JavaScript length", () => {
  const multibyte = "论".repeat(Math.floor(DOCUMENT_INDEX_MAX_BYTES / 3) + 1);
  assert.ok(multibyte.length < DOCUMENT_INDEX_MAX_BYTES);
  assert.throws(
    () => buildDocumentIndex(multibyte),
    (error) => error instanceof RangeError && /UTF-8 bytes/.test(error.message),
  );
});
