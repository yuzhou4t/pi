import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  generateExcelArtifact,
  generateWordArtifact,
  OfficeArtifactError,
  probeOfficeArtifactRuntime,
  readOfficeArtifactBytes,
  readOfficeArtifactMetadata,
  validateExcelArtifactRequest,
  validateWordArtifactRequest,
} from "./officeArtifacts.js";

const runtime = await probeOfficeArtifactRuntime();

async function temporaryArtifactDirectory(t, prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function wordRequest(overrides = {}) {
  return {
    fileName: "开发能力简报.docx",
    title: "Pi Agent 开发能力简报",
    subtitle: "受控 Office 产物",
    sections: [
      {
        heading: "结论",
        level: 1,
        paragraphs: ["Pi Agent 可以生成经过结构校验与页面渲染的 Word 文档。"],
        bullets: ["文件留在会话产物目录", "不执行任意 Shell"],
        numbered: [],
        tables: [],
      },
      {
        heading: "能力清单",
        level: 2,
        paragraphs: [],
        bullets: [],
        numbered: [],
        tables: [{
          headers: ["能力", "状态"],
          rows: [["Word 生成", "可用"], ["结构校验", "通过"]],
        }],
      },
    ],
    ...overrides,
  };
}

function excelRequest(overrides = {}) {
  return {
    fileName: "项目跟踪.xlsx",
    title: "项目跟踪表",
    sheets: [{
      name: "任务",
      rows: [
        ["任务", "负责人", "预算", "完成率"],
        ["Word 能力", "Agent", 1_200, null],
        ["Excel 能力", "Agent", 1_800, null],
        ["合计", "", null, null],
      ],
      headerRows: 1,
      freezeRows: 1,
      formulas: [
        { cell: "D2", formula: "=C2/C4" },
        { cell: "D3", formula: "=C3/C4" },
        { cell: "C4", formula: "=SUM(C2:C3)" },
        { cell: "D4", formula: "=SUM(D2:D3)" },
      ],
      numberFormats: [
        { range: "C2:C4", format: '"¥"#,##0' },
        { range: "D2:D4", format: "0.0%" },
      ],
    }],
    ...overrides,
  };
}

test("Office request validators are strict and reject unsafe paths and fields", () => {
  assert.throws(
    () => validateWordArtifactRequest(wordRequest({ fileName: "../brief.docx" })),
    (error) => error instanceof OfficeArtifactError
      && error.code === "OFFICE_ARTIFACT_FILE_NAME_INVALID",
  );
  assert.throws(
    () => validateWordArtifactRequest({ ...wordRequest(), command: "open -a Word" }),
    /包含未支持的字段/u,
  );
  assert.throws(
    () => validateExcelArtifactRequest(excelRequest({ fileName: "macro.xlsm" })),
    /安全的 \.xlsx 名称/u,
  );
  assert.throws(
    () => validateExcelArtifactRequest({ ...excelRequest(), argv: ["--install"] }),
    /包含未支持的字段/u,
  );
});

test("Excel validation rejects external links, network functions, and out-of-bounds cells", () => {
  const unsafeFormulas = [
    "='[other.xlsx]Sheet1'!A1",
    '=WEBSERVICE("https://example.com")',
    '=HYPERLINK("https://example.com","open")',
  ];
  for (const formula of unsafeFormulas) {
    const request = excelRequest();
    request.sheets[0].formulas = [{ cell: "D2", formula }];
    assert.throws(
      () => validateExcelArtifactRequest(request),
      (error) => error instanceof OfficeArtifactError
        && error.code === "OFFICE_ARTIFACT_FORMULA_UNSAFE",
    );
  }

  const outside = excelRequest();
  outside.sheets[0].formulas = [{ cell: "Z99", formula: "=SUM(A1:A2)" }];
  assert.throws(
    () => validateExcelArtifactRequest(outside),
    /公式单元格超出数据范围/u,
  );
});

test("Excel validation enforces the bounded cell budget", () => {
  const row = Array.from({ length: 100 }, (_, index) => index);
  const rows = Array.from({ length: 501 }, () => row);
  assert.throws(
    () => validateExcelArtifactRequest(excelRequest({
      sheets: [{ name: "Too large", rows }],
    })),
    (error) => error instanceof OfficeArtifactError
      && error.code === "OFFICE_ARTIFACT_REQUEST_TOO_LARGE",
  );
});

test("runtime probe reports missing managed dependencies without falling back", async (t) => {
  const directory = await temporaryArtifactDirectory(t, "pi-office-missing-runtime-");
  const capability = await probeOfficeArtifactRuntime({
    env: { PI_OFFICE_RUNTIME_ROOT: directory },
  });
  assert.equal(capability.available, false);
  assert.match(capability.reason, /Word 生成不可用/u);
  assert.equal(capability.word.available, false);
  assert.equal(capability.excel.available, false);
  assert.match(capability.word.reason, /python-docx/u);
  assert.match(capability.excel.reason, /artifact-tool/u);
});

test("Word generation creates a hash-bound, structurally verified DOCX and reuses the same request", {
  skip: runtime.word.available ? false : runtime.word.reason,
}, async (t) => {
  const artifactDirectory = await temporaryArtifactDirectory(t, "pi-office-word-");
  const first = await generateWordArtifact({
    artifactDirectory,
    requestId: "word-operation-1",
    request: wordRequest(),
  });
  assert.equal(first.artifact.kind, "word");
  assert.equal(first.artifact.structureVerified, true);
  assert.equal(first.artifact.renderVerified, runtime.word.rendererAvailable);
  assert.equal(first.artifact.pageCount >= 1, runtime.word.rendererAvailable);
  assert.match(first.artifact.sha256, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(first.artifact.operationId, "word-operation-1");
  assert.ok(first.artifact.previewText.includes("能力清单"));
  assert.ok(first.artifact.previewText.length <= 64_000);

  const artifactPath = path.join(
    artifactDirectory,
    ...first.artifact.fileName.split("/"),
  );
  const bytes = await readFile(artifactPath);
  assert.ok(bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])));
  assert.equal((await stat(artifactPath)).size, first.artifact.byteLength);

  const repeated = await generateWordArtifact({
    artifactDirectory,
    requestId: "word-operation-1",
    request: wordRequest(),
  });
  assert.deepEqual(repeated.artifact, first.artifact);
  const inspected = await readOfficeArtifactMetadata({
    artifactDirectory,
    requestId: "word-operation-1",
  });
  assert.deepEqual(inspected, first.artifact);
  const readBack = await readOfficeArtifactBytes({
    artifactDirectory,
    requestId: "word-operation-1",
    expectedSha256: first.artifact.sha256,
  });
  assert.equal(readBack.bytes.length, first.artifact.byteLength);

  await assert.rejects(
    generateWordArtifact({
      artifactDirectory,
      requestId: "word-operation-1",
      request: wordRequest({ title: "不同内容" }),
    }),
    (error) => error instanceof OfficeArtifactError
      && error.code === "OFFICE_ARTIFACT_OPERATION_CONFLICT",
  );
});

test("Excel generation uses artifact-tool formulas, verifies every sheet render, and exports XLSX", {
  skip: runtime.excel.available ? false : runtime.excel.reason,
}, async (t) => {
  const artifactDirectory = await temporaryArtifactDirectory(t, "pi-office-excel-");
  const result = await generateExcelArtifact({
    artifactDirectory,
    requestId: "excel-operation-1",
    request: excelRequest(),
  });
  const artifact = result.artifact;
  assert.equal(artifact.kind, "excel");
  assert.equal(artifact.sheetCount, 1);
  assert.equal(artifact.structureVerified, true);
  assert.equal(artifact.renderVerified, true);
  assert.equal(artifact.previewImages.length, 1);
  assert.equal(artifact.previewImages[0].sheetName, "任务");
  assert.equal(artifact.verification.structure.worker.formulaCount, 4);
  assert.equal(artifact.verification.structure.worker.formulaErrorCount, 0);
  assert.match(artifact.previewText, /C4\t=SUM\(C2:C3\)/u);

  const { bytes } = await readOfficeArtifactBytes({
    artifactDirectory,
    requestId: "excel-operation-1",
    expectedSha256: artifact.sha256,
  });
  assert.ok(bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])));
});

test("an already-aborted request leaves no claimed Office operation", {
  skip: runtime.word.available ? false : runtime.word.reason,
}, async (t) => {
  const artifactDirectory = await temporaryArtifactDirectory(t, "pi-office-abort-");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    generateWordArtifact({
      artifactDirectory,
      requestId: "aborted-operation",
      request: wordRequest(),
      signal: controller.signal,
    }),
    (error) => error instanceof OfficeArtifactError
      && error.code === "OFFICE_ARTIFACT_ABORTED",
  );
  await assert.rejects(
    stat(path.join(artifactDirectory, "aborted-operation")),
    { code: "ENOENT" },
  );
});
