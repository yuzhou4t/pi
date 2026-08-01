import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { Readable } from "node:stream";
import { deflateRawSync } from "node:zlib";
import { strToU8, zipSync } from "fflate";
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
    conversationRoot,
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

function officeArchive(entries) {
  return Buffer.from(zipSync(Object.fromEntries(
    Object.entries(entries).map(([name, value]) => [name, strToU8(value)]),
  )));
}

function baseOfficeEntries(kind) {
  const word = kind === "word";
  const mainPart = word ? "word/document.xml" : "xl/workbook.xml";
  const contentType = word
    ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
    : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";
  return {
    "[Content_Types].xml": [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
      `  <Override PartName="/${mainPart}" ContentType="${contentType}"/>`,
      "</Types>",
    ].join("\n"),
    "_rels/.rels": [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
      `  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${mainPart}"/>`,
      "</Relationships>",
    ].join("\n"),
  };
}

async function uploadOfficeAttachment(harness, {
  fileName,
  mimeType,
  bytes,
}) {
  const created = await harness.service.createAttachment(harness.state.id, {
    fileName,
    mimeType,
    byteLength: bytes.length,
  });
  return harness.service.uploadContent(
    harness.state.id,
    created.id,
    Readable.from([bytes]),
    {
      contentType: mimeType,
      declaredLength: String(bytes.length),
    },
  );
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

  const controlled = Buffer.from("safe\u0001looking");
  const controlledAttachment = await harness.service.createAttachment(
    harness.state.id,
    {
      fileName: "control.unknown",
      mimeType: "application/octet-stream",
      byteLength: controlled.length,
    },
  );
  await assert.rejects(
    harness.service.uploadContent(
      harness.state.id,
      controlledAttachment.id,
      Readable.from([controlled]),
      {
        contentType: "application/octet-stream",
        declaredLength: String(controlled.length),
      },
    ),
    /包含不安全的控制字符/,
  );
});

test("ordinary attachments sniff safe UTF-8 content instead of requiring a known suffix", async (t) => {
  const harness = await createHarness(t);
  const content = Buffer.from([
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<mxfile host="app.diagrams.net" compressed="false">',
    '  <diagram id="architecture" name="机制图">',
    "    <mxGraphModel><root>",
    '      <mxCell id="0"/>',
    '      <mxCell id="node-a" parent="1" vertex="1" value="&lt;div&gt;&lt;b&gt;采集层&lt;/b&gt;&lt;img src=&quot;data:image/png;base64,AAAABBBBCCCC&quot;&gt;&lt;/div&gt;">',
    '        <mxGeometry x="12" y="24" width="160" height="80" as="geometry"/>',
    "      </mxCell>",
    '      <mxCell id="node-b" parent="1" vertex="1" value="分析层"/>',
    '      <mxCell id="edge-a-b" parent="1" edge="1" source="node-a" target="node-b" value="数据流">',
    '        <mxGeometry x="0" y="0" width="40" height="20" as="geometry"/>',
    "      </mxCell>",
    "    </root></mxGraphModel>",
    "  </diagram>",
    "</mxfile>",
  ].join("\n"));
  const created = await harness.service.createAttachment(harness.state.id, {
    fileName: "architecture.drawio",
    mimeType: "application/octet-stream",
    byteLength: content.length,
  });
  const ready = await harness.service.uploadContent(
    harness.state.id,
    created.id,
    Readable.from([content]),
    {
      contentType: "application/octet-stream",
      declaredLength: String(content.length),
    },
  );

  assert.equal(ready.status, "ready");
  assert.equal(ready.mimeType, "application/octet-stream");
  assert.equal(ready.detectedMimeType, "application/xml");
  assert.equal(ready.contentKind, "drawio_xml");
  assert.match(ready.readingHint, /mxCell/);
  assert.equal(ready.representation, "drawio_projection");

  const attachmentDirectory = path.join(
    harness.conversationRoot,
    "attachments",
    ready.id,
  );
  const storedSource = await readFile(path.join(attachmentDirectory, "source.txt"));
  assert.deepEqual(storedSource, content);
  assert.equal(
    ready.revision,
    `sha256:${createHash("sha256").update(content).digest("hex")}`,
  );
  const storedProjection = await readFile(
    path.join(attachmentDirectory, "projection.txt"),
    "utf8",
  );
  assert.match(storedProjection, /diagram name="机制图"/);
  assert.match(storedProjection, /id="node-a"/);
  assert.match(storedProjection, /value="采集层"/);
  assert.match(storedProjection, /geometry\.x="12"/);
  assert.match(storedProjection, /geometry\.height="80"/);
  assert.match(storedProjection, /edge="1"/);
  assert.match(storedProjection, /source="node-a"/);
  assert.match(storedProjection, /target="node-b"/);
  assert.doesNotMatch(storedProjection, /data:image|base64|AAAABBBB/iu);

  const bound = bindProjectWorkMessageAttachments(
    harness.state,
    [{ attachmentId: ready.id, attachmentRevision: ready.revision }],
    {
      messageId: "message-drawio",
      boundAt: "2026-07-29T00:03:00.000Z",
    },
  );
  harness.state = { ...harness.state, attachments: bound.attachments };
  const manifest = projectWorkAttachmentManifestPrompt(bound.messageAttachments);
  assert.match(manifest, /"mime_type":"application\/xml"/);
  assert.match(manifest, /"declared_mime_type":"application\/octet-stream"/);
  assert.match(manifest, /"content_kind":"drawio_xml"/);
  assert.match(manifest, /"representation":"drawio_projection"/);
  assert.match(manifest, /mxCell/);
  assert.doesNotMatch(manifest, /base64/iu);

  const listed = await harness.service.listForAgent(harness.state.id);
  assert.equal(listed[0].mime_type, "application/xml");
  assert.equal(listed[0].content_kind, "drawio_xml");
  assert.equal(listed[0].representation, "drawio_projection");
  assert.doesNotMatch(JSON.stringify(listed), /base64|AAAABBBB/iu);
  const read = await harness.service.readForAgent(harness.state.id, {
    attachmentId: ready.id,
    revision: ready.revision,
  });
  assert.equal(read.representation, "drawio_projection");
  assert.equal(read.content, storedProjection);
  assert.match(read.content, /value="采集层"/);
  assert.doesNotMatch(read.content, /data:image|base64|AAAABBBB/iu);
  const labelMatches = await harness.service.searchForAgent(harness.state.id, {
    query: "采集层",
  });
  assert.equal(labelMatches.length, 1);
  assert.equal(labelMatches[0].representation, "drawio_projection");
  assert.doesNotMatch(JSON.stringify(labelMatches), /base64|AAAABBBB/iu);
  assert.deepEqual(
    await harness.service.searchForAgent(harness.state.id, { query: "base64" }),
    [],
  );
});

test("ordinary attachments accept JSON and YAML stored under unfamiliar suffixes", async (t) => {
  const harness = await createHarness(t);
  for (const fixture of [
    {
      fileName: "settings.payload",
      content: '{"enabled":true}',
      detectedMimeType: "application/json",
      contentKind: "json",
    },
    {
      fileName: "pipeline.recipe",
      content: "name: verify\nsteps:\n  - test",
      detectedMimeType: "text/yaml",
      contentKind: "yaml",
    },
  ]) {
    const bytes = Buffer.from(fixture.content);
    const created = await harness.service.createAttachment(harness.state.id, {
      fileName: fixture.fileName,
      mimeType: "application/octet-stream",
      byteLength: bytes.length,
    });
    const ready = await harness.service.uploadContent(
      harness.state.id,
      created.id,
      Readable.from([bytes]),
      {
        contentType: "application/octet-stream",
        declaredLength: String(bytes.length),
      },
    );
    assert.equal(ready.detectedMimeType, fixture.detectedMimeType);
    assert.equal(ready.contentKind, fixture.contentKind);
  }
});

test("Word attachments retain their private OOXML source and expose a bounded text projection", async (t) => {
  const harness = await createHarness(t);
  const bytes = officeArchive({
    ...baseOfficeEntries("word"),
    "word/document.xml": [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
      "  <w:body>",
      '    <w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>季度复盘</w:t></w:r></w:p>',
      '    <w:p><w:r><w:t>收入同比增长 18%</w:t><w:tab/><w:t>仍需关注留存。</w:t></w:r></w:p>',
      "    <w:tbl>",
      "      <w:tr>",
      "        <w:tc><w:p><w:r><w:t>指标</w:t></w:r></w:p></w:tc>",
      "        <w:tc><w:p><w:r><w:t>结果</w:t></w:r></w:p></w:tc>",
      "      </w:tr>",
      "      <w:tr>",
      "        <w:tc><w:p><w:r><w:t>活跃用户</w:t></w:r></w:p></w:tc>",
      "        <w:tc><w:p><w:r><w:t>12,400</w:t></w:r></w:p></w:tc>",
      "      </w:tr>",
      "    </w:tbl>",
      "  </w:body>",
      "</w:document>",
    ].join("\n"),
  });
  const ready = await uploadOfficeAttachment(harness, {
    fileName: "季度复盘.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    bytes,
  });

  assert.equal(ready.status, "ready");
  assert.equal(ready.detectedMimeType, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.equal(ready.contentKind, "office_word");
  assert.equal(ready.representation, "office_projection");
  assert.match(ready.readingHint, /段落和表格文字/);
  assert.equal(ready.lineCount, null);
  assert.equal(
    ready.revision,
    `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  );
  const attachmentDirectory = path.join(
    harness.conversationRoot,
    "attachments",
    ready.id,
  );
  assert.deepEqual(
    await readFile(path.join(attachmentDirectory, "source.bin")),
    bytes,
  );
  const projection = await readFile(
    path.join(attachmentDirectory, "projection.txt"),
    "utf8",
  );
  assert.match(projection, /^representation=office_projection\noffice_kind=word/mu);
  assert.match(projection, /paragraph 1 style="Title": "季度复盘"/u);
  assert.match(projection, /收入同比增长 18% 仍需关注留存/u);
  assert.match(projection, /table 1 row 1: "指标" \| "结果"/u);
  assert.match(projection, /table 1 row 2: "活跃用户" \| "12,400"/u);
  assert.doesNotMatch(projection, /<w:|word\/document/u);

  const bound = bindProjectWorkMessageAttachments(
    harness.state,
    [{ attachmentId: ready.id, attachmentRevision: ready.revision }],
    { messageId: "message-word", boundAt: "2026-07-29T00:05:00.000Z" },
  );
  harness.state = { ...harness.state, attachments: bound.attachments };
  const manifest = projectWorkAttachmentManifestPrompt(bound.messageAttachments);
  assert.match(manifest, /"content_kind":"office_word"/u);
  assert.match(manifest, /"representation":"office_projection"/u);
  assert.doesNotMatch(manifest, /收入同比|12,400/u);
  const listed = await harness.service.listForAgent(harness.state.id);
  assert.equal(listed[0].representation, "office_projection");
  assert.equal(listed[0].line_count, ready.projectionLineCount);
  const read = await harness.service.readForAgent(harness.state.id, {
    attachmentId: ready.id,
    revision: ready.revision,
  });
  assert.equal(read.representation, "office_projection");
  assert.equal(read.content, projection);
  const matches = await harness.service.searchForAgent(harness.state.id, {
    query: "活跃用户",
  });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].representation, "office_projection");
});

test("Excel attachments project typed cells, shared strings, and formula text without calculating", async (t) => {
  const harness = await createHarness(t);
  const bytes = officeArchive({
    ...baseOfficeEntries("workbook"),
    "xl/workbook.xml": [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
      '  <sheets><sheet name="经营数据" sheetId="1" r:id="rIdSheet1"/></sheets>',
      "</workbook>",
    ].join("\n"),
    "xl/_rels/workbook.xml.rels": [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
      '  <Relationship Id="rIdSheet1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>',
      "</Relationships>",
    ].join("\n"),
    "xl/sharedStrings.xml": [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2">',
      "  <si><t>月份</t></si><si><r><t>收入</t></r><r><t>（万元）</t></r></si>",
      "</sst>",
    ].join("\n"),
    "xl/worksheets/sheet1.xml": [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
      "  <sheetData>",
      '    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>',
      '    <row r="2"><c r="A2" t="inlineStr"><is><t>一月</t></is></c><c r="B2"><v>120</v></c><c r="C2" t="b"><v>1</v></c></row>',
      '    <row r="3"><c r="A3" t="inlineStr"><is><t>合计</t></is></c><c r="B3"><f>SUM(B2:B2)</f><v>120</v></c></row>',
      "  </sheetData>",
      "</worksheet>",
    ].join("\n"),
  });
  const ready = await uploadOfficeAttachment(harness, {
    fileName: "经营数据.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    bytes,
  });

  assert.equal(ready.contentKind, "office_workbook");
  assert.equal(ready.representation, "office_projection");
  assert.match(ready.readingHint, /不计算公式/);
  const projection = await readFile(path.join(
    harness.conversationRoot,
    "attachments",
    ready.id,
    "projection.txt",
  ), "utf8");
  assert.match(projection, /^representation=office_projection\noffice_kind=workbook/mu);
  assert.match(projection, /sheet 1 name="经营数据"/u);
  assert.match(projection, /A1 value="月份"/u);
  assert.match(projection, /B1 value="收入（万元）"/u);
  assert.match(projection, /C2 value="TRUE"/u);
  assert.match(projection, /B3 formula="SUM\(B2:B2\)" value="120"/u);
});

test("Office attachments reject legacy, macro-enabled, malformed, external-link, and oversized packages", async (t) => {
  const harness = await createHarness(t);
  for (const fileName of ["legacy.doc", "legacy.xls", "macro.docm", "macro.xlsm"]) {
    await assert.rejects(
      harness.service.createAttachment(harness.state.id, {
        fileName,
        mimeType: "application/octet-stream",
        byteLength: 1,
      }),
      /请另存为 \.docx 或 \.xlsx/u,
    );
  }

  await assert.rejects(
    uploadOfficeAttachment(harness, {
      fileName: "fake.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      bytes: Buffer.from("not a zip"),
    }),
    /不是有效的 OOXML ZIP 包/u,
  );

  const missingMainPart = officeArchive(baseOfficeEntries("word"));
  await assert.rejects(
    uploadOfficeAttachment(harness, {
      fileName: "missing-main.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      bytes: missingMainPart,
    }),
    /缺少必要包条目 word\/document\.xml/u,
  );

  const macroBytes = officeArchive({
    ...baseOfficeEntries("word"),
    "word/document.xml": '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>',
    "word/vbaProject.bin": "not executable",
  });
  await assert.rejects(
    uploadOfficeAttachment(harness, {
      fileName: "renamed-macro.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      bytes: macroBytes,
    }),
    /宏、ActiveX、外部连接或嵌入对象/u,
  );

  const externalBytes = officeArchive({
    ...baseOfficeEntries("workbook"),
    "xl/workbook.xml": '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/worksheets/sheet1.xml": '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>',
    "xl/externalLinks/externalLink1.xml": "<externalLink/>",
  });
  await assert.rejects(
    uploadOfficeAttachment(harness, {
      fileName: "external.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      bytes: externalBytes,
    }),
    /宏、ActiveX、外部连接或嵌入对象/u,
  );

  const excessiveEntries = {
    ...baseOfficeEntries("word"),
    "word/document.xml": '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>',
  };
  for (let index = 0; index < 510; index += 1) {
    excessiveEntries[`customXml/item${index}.xml`] = `<item>${index}</item>`;
  }
  const excessiveBytes = officeArchive(excessiveEntries);
  await assert.rejects(
    uploadOfficeAttachment(harness, {
      fileName: "too-many.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      bytes: excessiveBytes,
    }),
    /过多包条目/u,
  );
});

test("Office projections cap decompressed text exposed to the Agent", async (t) => {
  const harness = await createHarness(t);
  const paragraphs = Array.from(
    { length: 10_000 },
    (_, index) => `<w:p><w:r><w:t>第 ${index} 段 ${"内容".repeat(20)}</w:t></w:r></w:p>`,
  ).join("");
  const bytes = officeArchive({
    ...baseOfficeEntries("word"),
    "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}</w:body></w:document>`,
  });
  const ready = await uploadOfficeAttachment(harness, {
    fileName: "long.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    bytes,
  });
  const projection = await readFile(path.join(
    harness.conversationRoot,
    "attachments",
    ready.id,
    "projection.txt",
  ), "utf8");

  assert.ok(projection.length <= 256_000);
  assert.match(projection, /projection_truncated=true$/u);
});

test("Draw.io projections bound each value and the complete projection", async (t) => {
  const harness = await createHarness(t);
  const oversizedValue = "x".repeat(3_000);
  const cells = Array.from(
    { length: 200 },
    (_, index) => `<mxCell id="node-${index}" value="${oversizedValue}"/>`,
  );
  const source = Buffer.from([
    '<mxfile><diagram name="large"><mxGraphModel><root>',
    ...cells,
    "</root></mxGraphModel></diagram></mxfile>",
  ].join("\n"));
  const created = await harness.service.createAttachment(harness.state.id, {
    fileName: "large.custom-diagram",
    mimeType: "application/octet-stream",
    byteLength: source.length,
  });
  const ready = await harness.service.uploadContent(
    harness.state.id,
    created.id,
    Readable.from([source]),
    {
      contentType: "application/octet-stream",
      declaredLength: String(source.length),
    },
  );
  const projection = await readFile(path.join(
    harness.conversationRoot,
    "attachments",
    ready.id,
    "projection.txt",
  ), "utf8");

  assert.ok(projection.length <= 256_000);
  assert.match(projection, /projection_truncated=true$/u);
  const firstValue = /value="(x+…)"/u.exec(projection)?.[1];
  assert.equal(firstValue?.length, 2_000);
});

test("compressed Draw.io diagrams are safely inflated without exposing their payload", async (t) => {
  const harness = await createHarness(t);
  const graph = [
    "<mxGraphModel><root>",
    '<mxCell id="compressed-node" parent="1" vertex="1" value="压缩节点">',
    '  <mxGeometry x="20" y="30" width="180" height="90" as="geometry"/>',
    "</mxCell>",
    '<mxCell id="compressed-target" parent="1" vertex="1" value="目标节点"/>',
    '<mxCell id="compressed-edge" parent="1" edge="1" source="compressed-node" target="compressed-target" value="压缩连线"/>',
    "</root></mxGraphModel>",
  ].join("\n");
  const compressed = deflateRawSync(
    Buffer.from(encodeURIComponent(graph), "utf8"),
  ).toString("base64");
  const expansionLimitPayload = deflateRawSync(Buffer.from(
    `<mxGraphModel><root><!--${"x".repeat(2 * 1024 * 1024)}--></root></mxGraphModel>`,
  )).toString("base64");
  const source = Buffer.from([
    '<mxfile compressed="true">',
    `  <diagram name="压缩机制图">${compressed}</diagram>`,
    '  <diagram name="损坏页">not-valid-compressed-content</diagram>',
    `  <diagram name="膨胀超限页">${expansionLimitPayload}</diagram>`,
    "</mxfile>",
  ].join("\n"));
  const created = await harness.service.createAttachment(harness.state.id, {
    fileName: "compressed.drawio",
    mimeType: "application/octet-stream",
    byteLength: source.length,
  });
  const ready = await harness.service.uploadContent(
    harness.state.id,
    created.id,
    Readable.from([source]),
    {
      contentType: "application/octet-stream",
      declaredLength: String(source.length),
    },
  );
  const bound = bindProjectWorkMessageAttachments(
    harness.state,
    [{ attachmentId: ready.id, attachmentRevision: ready.revision }],
    {
      messageId: "message-compressed",
      boundAt: "2026-07-29T00:04:00.000Z",
    },
  );
  harness.state = { ...harness.state, attachments: bound.attachments };
  const read = await harness.service.readForAgent(harness.state.id, {
    attachmentId: ready.id,
    revision: ready.revision,
  });

  assert.equal(read.representation, "drawio_projection");
  assert.match(read.content, /diagram name="压缩机制图" encoding="compressed"/u);
  assert.match(read.content, /id="compressed-node"/u);
  assert.match(read.content, /value="压缩节点"/u);
  assert.match(read.content, /geometry\.width="180"/u);
  assert.match(read.content, /id="compressed-edge"/u);
  assert.match(read.content, /source="compressed-node"/u);
  assert.match(read.content, /target="compressed-target"/u);
  assert.match(read.content, /diagram name="损坏页" encoding="compressed"/u);
  assert.match(read.content, /diagram name="膨胀超限页" encoding="compressed"/u);
  assert.equal(
    read.content.match(/projection_warning=compressed_diagram_unsupported/gu)?.length,
    2,
  );
  assert.doesNotMatch(read.content, new RegExp(compressed.slice(0, 32), "u"));
  assert.doesNotMatch(
    read.content,
    new RegExp(expansionLimitPayload.slice(0, 32), "u"),
  );
  assert.doesNotMatch(read.content, /not-valid-compressed-content/u);
  const matches = await harness.service.searchForAgent(harness.state.id, {
    query: "压缩连线",
  });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].representation, "drawio_projection");
  assert.deepEqual(
    await harness.service.searchForAgent(harness.state.id, {
      query: compressed.slice(0, 24),
    }),
    [],
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
