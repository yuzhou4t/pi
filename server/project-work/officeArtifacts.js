import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  chmod,
  constants as fsConstants,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { unzipSync } from "fflate";

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const WORD_WORKER_PATH = path.join(
  MODULE_DIRECTORY,
  "workers",
  "officeWordWorker.py",
);
const EXCEL_WORKER_PATH = path.join(
  MODULE_DIRECTORY,
  "workers",
  "officeExcelWorker.mjs",
);

const DEFAULT_RUNTIME_ROOT = path.join(
  homedir(),
  ".cache",
  "codex-runtimes",
  "codex-primary-runtime",
  "dependencies",
);
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;
const SAFE_PREVIEW_FILE_PATTERN = /^(?:preview-sheet-\d{3}|page-\d+)\.png$/;
const MAX_PROCESS_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_PROCESS_STDERR_BYTES = 512 * 1024;
const PROCESS_TIMEOUT_MS = 120_000;
const MAX_OFFICE_ARTIFACT_BYTES = 25 * 1024 * 1024;
const MAX_PREVIEW_TEXT_CHARACTERS = 64_000;
const MAX_WORD_CHARACTERS = 250_000;
const MAX_WORD_SECTIONS = 40;
const MAX_WORD_TABLES = 30;
const MAX_WORD_TABLE_CELLS = 4_000;
const MAX_EXCEL_SHEETS = 8;
const MAX_EXCEL_ROWS_PER_SHEET = 2_000;
const MAX_EXCEL_COLUMNS_PER_SHEET = 100;
const MAX_EXCEL_TOTAL_CELLS = 50_000;
const MAX_EXCEL_TOTAL_CHARACTERS = 500_000;
const MAX_EXCEL_FORMULAS = 2_000;
const A1_CELL_PATTERN = /^([A-Z]{1,3})([1-9][0-9]{0,5})$/;
const A1_RANGE_PATTERN = /^([A-Z]{1,3})([1-9][0-9]{0,5})(?::([A-Z]{1,3})([1-9][0-9]{0,5}))?$/;
const DANGEROUS_FORMULA_FUNCTION_PATTERN = /\b(?:CALL|DDE|ENCODEURL|EXEC|FILTERXML|HYPERLINK|IMPORTXML|REGISTER(?:\.ID)?|RTD|SHELL|STOCKHISTORY|WEBSERVICE)\s*\(/iu;
const OOXML_FORBIDDEN_ENTRY_PATTERN = /(?:^|\/)(?:activex|embeddings|externallinks|macrosheets)(?:\/|$)|vbaproject|oleobject/iu;
const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const PNG_SIGNATURE = Buffer.from([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
]);

export class OfficeArtifactError extends Error {
  constructor(code, message, { retryable = false, status = 422 } = {}) {
    super(message);
    this.name = "OfficeArtifactError";
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

function officeError(code, message, options) {
  return new OfficeArtifactError(code, message, options);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertStrictObject(value, allowedKeys, label) {
  if (!isPlainObject(value)) {
    throw officeError(
      "OFFICE_ARTIFACT_REQUEST_INVALID",
      `${label}必须是对象`,
      { status: 400 },
    );
  }
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unexpected.length > 0) {
    throw officeError(
      "OFFICE_ARTIFACT_REQUEST_INVALID",
      `${label}包含未支持的字段：${unexpected.join("、")}`,
      { status: 400 },
    );
  }
}

function boundedText(value, {
  label,
  maxLength,
  required = false,
  normalizeWhitespace = false,
} = {}) {
  if (value === undefined || value === null) {
    if (!required) return "";
    throw officeError(
      "OFFICE_ARTIFACT_REQUEST_INVALID",
      `${label}不能为空`,
      { status: 400 },
    );
  }
  if (typeof value !== "string") {
    throw officeError(
      "OFFICE_ARTIFACT_REQUEST_INVALID",
      `${label}必须是文本`,
      { status: 400 },
    );
  }
  let text = value.normalize("NFC").trim();
  if (normalizeWhitespace) text = text.replaceAll(/\s+/gu, " ");
  if ((required && !text) || text.length > maxLength || /\u0000/u.test(text)) {
    throw officeError(
      "OFFICE_ARTIFACT_REQUEST_INVALID",
      `${label}长度或内容无效`,
      { status: 400 },
    );
  }
  return text;
}

function safeOfficeFileName(value, extension) {
  const fileName = boundedText(value, {
    label: "文件名",
    maxLength: 120,
    required: true,
  });
  const baseName = path.basename(fileName);
  const stem = fileName.slice(0, -extension.length);
  const windowsReserved = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/iu;
  if (
    baseName !== fileName
    || fileName === "."
    || fileName === ".."
    || !fileName.toLowerCase().endsWith(extension)
    || !stem
    || stem.startsWith(".")
    || stem.endsWith(".")
    || /[\u0000-\u001f\u007f<>:"|?*\\/]/u.test(fileName)
    || windowsReserved.test(stem)
  ) {
    throw officeError(
      "OFFICE_ARTIFACT_FILE_NAME_INVALID",
      `文件名必须是安全的 ${extension} 名称`,
      { status: 400 },
    );
  }
  return fileName;
}

function stringArray(value, { label, maxItems, maxItemLength }) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw officeError(
      "OFFICE_ARTIFACT_REQUEST_INVALID",
      `${label}数量无效`,
      { status: 400 },
    );
  }
  return value.map((entry, index) => boundedText(entry, {
    label: `${label}第 ${index + 1} 项`,
    maxLength: maxItemLength,
    required: true,
  }));
}

function normalizeWordTable(value, index) {
  assertStrictObject(
    value,
    new Set(["headers", "rows"]),
    `表格 ${index + 1}`,
  );
  if (
    !Array.isArray(value.headers)
    || value.headers.length < 1
    || value.headers.length > 8
  ) {
    throw officeError(
      "OFFICE_ARTIFACT_REQUEST_INVALID",
      `表格 ${index + 1} 必须有 1–8 个表头`,
      { status: 400 },
    );
  }
  const headers = value.headers.map((entry, headerIndex) => boundedText(entry, {
    label: `表格 ${index + 1} 表头 ${headerIndex + 1}`,
    maxLength: 500,
    required: true,
  }));
  if (!Array.isArray(value.rows) || value.rows.length > 100) {
    throw officeError(
      "OFFICE_ARTIFACT_REQUEST_INVALID",
      `表格 ${index + 1} 行数无效`,
      { status: 400 },
    );
  }
  const rows = value.rows.map((row, rowIndex) => {
    if (!Array.isArray(row) || row.length !== headers.length) {
      throw officeError(
        "OFFICE_ARTIFACT_REQUEST_INVALID",
        `表格 ${index + 1} 第 ${rowIndex + 1} 行列数不一致`,
        { status: 400 },
      );
    }
    return row.map((entry, columnIndex) => boundedText(entry, {
      label: `表格 ${index + 1} 第 ${rowIndex + 1} 行第 ${columnIndex + 1} 列`,
      maxLength: 4_000,
    }));
  });
  return { headers, rows };
}

export function validateWordArtifactRequest(request) {
  assertStrictObject(
    request,
    new Set(["fileName", "title", "subtitle", "sections"]),
    "Word 请求",
  );
  const fileName = safeOfficeFileName(request.fileName, ".docx");
  const title = boundedText(request.title, {
    label: "Word 标题",
    maxLength: 240,
    required: true,
  });
  const subtitle = boundedText(request.subtitle, {
    label: "Word 副标题",
    maxLength: 500,
  });
  if (
    !Array.isArray(request.sections)
    || request.sections.length < 1
    || request.sections.length > MAX_WORD_SECTIONS
  ) {
    throw officeError(
      "OFFICE_ARTIFACT_REQUEST_INVALID",
      `Word 文档必须包含 1–${MAX_WORD_SECTIONS} 个章节`,
      { status: 400 },
    );
  }

  let tableCount = 0;
  let tableCellCount = 0;
  let characterCount = title.length + subtitle.length;
  const sections = request.sections.map((section, sectionIndex) => {
    assertStrictObject(
      section,
      new Set(["heading", "level", "paragraphs", "bullets", "numbered", "tables"]),
      `章节 ${sectionIndex + 1}`,
    );
    const heading = boundedText(section.heading, {
      label: `章节 ${sectionIndex + 1} 标题`,
      maxLength: 300,
    });
    const level = section.level === undefined ? 1 : Number(section.level);
    if (!Number.isInteger(level) || level < 1 || level > 3) {
      throw officeError(
        "OFFICE_ARTIFACT_REQUEST_INVALID",
        `章节 ${sectionIndex + 1} 标题级别必须为 1、2 或 3`,
        { status: 400 },
      );
    }
    const paragraphs = stringArray(section.paragraphs, {
      label: `章节 ${sectionIndex + 1} 段落`,
      maxItems: 100,
      maxItemLength: 8_000,
    });
    const bullets = stringArray(section.bullets, {
      label: `章节 ${sectionIndex + 1} 项目符号`,
      maxItems: 100,
      maxItemLength: 4_000,
    });
    const numbered = stringArray(section.numbered, {
      label: `章节 ${sectionIndex + 1} 编号项`,
      maxItems: 100,
      maxItemLength: 4_000,
    });
    const rawTables = section.tables ?? [];
    if (!Array.isArray(rawTables) || rawTables.length > 10) {
      throw officeError(
        "OFFICE_ARTIFACT_REQUEST_INVALID",
        `章节 ${sectionIndex + 1} 表格数量无效`,
        { status: 400 },
      );
    }
    const tables = rawTables.map((table, tableIndex) => normalizeWordTable(
      table,
      tableCount + tableIndex,
    ));
    tableCount += tables.length;
    tableCellCount += tables.reduce(
      (sum, table) => sum + table.headers.length * (table.rows.length + 1),
      0,
    );
    characterCount += [heading, ...paragraphs, ...bullets, ...numbered]
      .reduce((sum, text) => sum + text.length, 0);
    characterCount += tables.reduce(
      (sum, table) => sum + [...table.headers, ...table.rows.flat()]
        .reduce((tableSum, text) => tableSum + text.length, 0),
      0,
    );
    if (!heading && !paragraphs.length && !bullets.length && !numbered.length && !tables.length) {
      throw officeError(
        "OFFICE_ARTIFACT_REQUEST_INVALID",
        `章节 ${sectionIndex + 1} 不能为空`,
        { status: 400 },
      );
    }
    return { heading, level, paragraphs, bullets, numbered, tables };
  });
  if (
    tableCount > MAX_WORD_TABLES
    || tableCellCount > MAX_WORD_TABLE_CELLS
    || characterCount > MAX_WORD_CHARACTERS
  ) {
    throw officeError(
      "OFFICE_ARTIFACT_REQUEST_TOO_LARGE",
      "Word 文档内容超过当前安全上限",
      { status: 413 },
    );
  }
  return { fileName, title, subtitle, sections };
}

function excelColumnIndex(letters) {
  let value = 0;
  for (const letter of letters) {
    value = value * 26 + letter.charCodeAt(0) - 64;
  }
  return value;
}

function parsedCellAddress(value, label) {
  if (typeof value !== "string") {
    throw officeError(
      "OFFICE_ARTIFACT_REQUEST_INVALID",
      `${label}必须使用 A1 单元格地址`,
      { status: 400 },
    );
  }
  const normalized = value.trim().toUpperCase();
  const match = A1_CELL_PATTERN.exec(normalized);
  if (!match) {
    throw officeError(
      "OFFICE_ARTIFACT_REQUEST_INVALID",
      `${label}必须使用 A1 单元格地址`,
      { status: 400 },
    );
  }
  return {
    address: normalized,
    column: excelColumnIndex(match[1]),
    row: Number(match[2]),
  };
}

function parsedRangeAddress(value, label) {
  if (typeof value !== "string") {
    throw officeError(
      "OFFICE_ARTIFACT_REQUEST_INVALID",
      `${label}必须使用 A1 范围`,
      { status: 400 },
    );
  }
  const normalized = value.trim().toUpperCase();
  const match = A1_RANGE_PATTERN.exec(normalized);
  if (!match) {
    throw officeError(
      "OFFICE_ARTIFACT_REQUEST_INVALID",
      `${label}必须使用 A1 范围`,
      { status: 400 },
    );
  }
  const start = {
    column: excelColumnIndex(match[1]),
    row: Number(match[2]),
  };
  const end = {
    column: excelColumnIndex(match[3] ?? match[1]),
    row: Number(match[4] ?? match[2]),
  };
  if (end.column < start.column || end.row < start.row) {
    throw officeError(
      "OFFICE_ARTIFACT_REQUEST_INVALID",
      `${label}范围顺序无效`,
      { status: 400 },
    );
  }
  return { address: normalized, start, end };
}

function normalizeSheetName(value, index) {
  const name = boundedText(value, {
    label: `工作表 ${index + 1} 名称`,
    maxLength: 31,
    required: true,
  });
  if (
    /[\[\]:*?/\\]/u.test(name)
    || name.startsWith("'")
    || name.endsWith("'")
    || name.toLowerCase() === "history"
  ) {
    throw officeError(
      "OFFICE_ARTIFACT_REQUEST_INVALID",
      `工作表 ${index + 1} 名称无效`,
      { status: 400 },
    );
  }
  return name;
}

function normalizeExcelCell(value, label) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw officeError(
        "OFFICE_ARTIFACT_REQUEST_INVALID",
        `${label}必须是有限数字`,
        { status: 400 },
      );
    }
    return value;
  }
  if (typeof value === "string") {
    if (value.length > 10_000 || /\u0000/u.test(value)) {
      throw officeError(
        "OFFICE_ARTIFACT_REQUEST_INVALID",
        `${label}文本过长或无效`,
        { status: 400 },
      );
    }
    if (value.startsWith("=") || value.startsWith("+")) {
      throw officeError(
        "OFFICE_ARTIFACT_REQUEST_INVALID",
        `${label}中的公式必须放入 formulas；公式样文本请以单引号开头`,
        { status: 400 },
      );
    }
    return value;
  }
  throw officeError(
    "OFFICE_ARTIFACT_REQUEST_INVALID",
    `${label}只支持文本、数字、布尔值或空值`,
    { status: 400 },
  );
}

function validateFormula(value, sheetNames, label) {
  const formula = boundedText(value, {
    label,
    maxLength: 1_024,
    required: true,
  });
  if (
    !formula.startsWith("=")
    || formula.length < 2
    || /[\[\]{}\u0000-\u001f\u007f]/u.test(formula)
    || /(?:https?|ftp|file|mailto):|\\\\/iu.test(formula)
    || /#REF!/iu.test(formula)
    || DANGEROUS_FORMULA_FUNCTION_PATTERN.test(formula)
  ) {
    throw officeError(
      "OFFICE_ARTIFACT_FORMULA_UNSAFE",
      `${label}包含外部引用、网络函数或不安全内容`,
      { status: 400 },
    );
  }
  const matchedReferences = [];
  const referencePattern = /(?:'((?:[^']|'')+)'|([A-Za-z_][A-Za-z0-9_.]*))!/gu;
  for (const match of formula.matchAll(referencePattern)) {
    const rawName = match[1]?.replaceAll("''", "'") ?? match[2];
    matchedReferences.push(match[0]);
    if (!sheetNames.has(rawName.toLocaleLowerCase("en-US"))) {
      throw officeError(
        "OFFICE_ARTIFACT_FORMULA_UNSAFE",
        `${label}引用了未包含的工作表`,
        { status: 400 },
      );
    }
  }
  const withoutReferences = matchedReferences.reduce(
    (text, reference) => text.replace(reference, ""),
    formula,
  );
  if (withoutReferences.includes("!")) {
    throw officeError(
      "OFFICE_ARTIFACT_FORMULA_UNSAFE",
      `${label}包含无法验证的工作表引用`,
      { status: 400 },
    );
  }
  return formula;
}

function boundedInteger(value, { label, minimum, maximum, defaultValue }) {
  const parsed = value === undefined ? defaultValue : value;
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw officeError(
      "OFFICE_ARTIFACT_REQUEST_INVALID",
      `${label}必须在 ${minimum}–${maximum} 之间`,
      { status: 400 },
    );
  }
  return parsed;
}

export function validateExcelArtifactRequest(request) {
  assertStrictObject(
    request,
    new Set(["fileName", "title", "sheets"]),
    "Excel 请求",
  );
  const fileName = safeOfficeFileName(request.fileName, ".xlsx");
  const title = boundedText(request.title, {
    label: "Excel 标题",
    maxLength: 240,
    required: true,
  });
  if (
    !Array.isArray(request.sheets)
    || request.sheets.length < 1
    || request.sheets.length > MAX_EXCEL_SHEETS
  ) {
    throw officeError(
      "OFFICE_ARTIFACT_REQUEST_INVALID",
      `Excel 必须包含 1–${MAX_EXCEL_SHEETS} 个工作表`,
      { status: 400 },
    );
  }
  const sheetNames = new Set();
  const baseSheets = request.sheets.map((sheet, sheetIndex) => {
    assertStrictObject(
      sheet,
      new Set([
        "name",
        "rows",
        "headerRows",
        "freezeRows",
        "freezeColumns",
        "columnWidths",
        "formulas",
        "numberFormats",
      ]),
      `工作表 ${sheetIndex + 1}`,
    );
    const name = normalizeSheetName(sheet.name, sheetIndex);
    const foldedName = name.toLocaleLowerCase("en-US");
    if (sheetNames.has(foldedName)) {
      throw officeError(
        "OFFICE_ARTIFACT_REQUEST_INVALID",
        "工作表名称不能重复",
        { status: 400 },
      );
    }
    sheetNames.add(foldedName);
    if (
      !Array.isArray(sheet.rows)
      || sheet.rows.length < 1
      || sheet.rows.length > MAX_EXCEL_ROWS_PER_SHEET
    ) {
      throw officeError(
        "OFFICE_ARTIFACT_REQUEST_INVALID",
        `工作表“${name}”行数无效`,
        { status: 400 },
      );
    }
    const columnCount = Array.isArray(sheet.rows[0]) ? sheet.rows[0].length : 0;
    if (columnCount < 1 || columnCount > MAX_EXCEL_COLUMNS_PER_SHEET) {
      throw officeError(
        "OFFICE_ARTIFACT_REQUEST_INVALID",
        `工作表“${name}”列数无效`,
        { status: 400 },
      );
    }
    const rows = sheet.rows.map((row, rowIndex) => {
      if (!Array.isArray(row) || row.length !== columnCount) {
        throw officeError(
          "OFFICE_ARTIFACT_REQUEST_INVALID",
          `工作表“${name}”第 ${rowIndex + 1} 行列数不一致`,
          { status: 400 },
        );
      }
      return row.map((cell, columnIndex) => normalizeExcelCell(
        cell,
        `工作表“${name}”第 ${rowIndex + 1} 行第 ${columnIndex + 1} 列`,
      ));
    });
    const headerRows = boundedInteger(sheet.headerRows, {
      label: `工作表“${name}”表头行数`,
      minimum: 0,
      maximum: Math.min(3, rows.length),
      defaultValue: 1,
    });
    const freezeRows = boundedInteger(sheet.freezeRows, {
      label: `工作表“${name}”冻结行数`,
      minimum: 0,
      maximum: Math.min(10, rows.length),
      defaultValue: headerRows,
    });
    const freezeColumns = boundedInteger(sheet.freezeColumns, {
      label: `工作表“${name}”冻结列数`,
      minimum: 0,
      maximum: Math.min(10, columnCount),
      defaultValue: 0,
    });
    let columnWidths = [];
    if (sheet.columnWidths !== undefined) {
      if (!Array.isArray(sheet.columnWidths) || sheet.columnWidths.length !== columnCount) {
        throw officeError(
          "OFFICE_ARTIFACT_REQUEST_INVALID",
          `工作表“${name}”列宽数量必须与列数一致`,
          { status: 400 },
        );
      }
      columnWidths = sheet.columnWidths.map((width, columnIndex) => {
        if (!Number.isFinite(width) || width < 6 || width > 80) {
          throw officeError(
            "OFFICE_ARTIFACT_REQUEST_INVALID",
            `工作表“${name}”第 ${columnIndex + 1} 列宽无效`,
            { status: 400 },
          );
        }
        return width;
      });
    }
    return {
      name,
      rows,
      headerRows,
      freezeRows,
      freezeColumns,
      columnWidths,
      rawFormulas: sheet.formulas ?? [],
      rawNumberFormats: sheet.numberFormats ?? [],
    };
  });

  let totalCells = 0;
  let totalCharacters = title.length;
  let totalFormulas = 0;
  const sheets = baseSheets.map((sheet) => {
    const rowCount = sheet.rows.length;
    const columnCount = sheet.rows[0].length;
    totalCells += rowCount * columnCount;
    totalCharacters += sheet.rows.flat().reduce(
      (sum, value) => sum + (typeof value === "string" ? value.length : 0),
      0,
    );
    if (!Array.isArray(sheet.rawFormulas) || sheet.rawFormulas.length > MAX_EXCEL_FORMULAS) {
      throw officeError(
        "OFFICE_ARTIFACT_REQUEST_INVALID",
        `工作表“${sheet.name}”公式数量无效`,
        { status: 400 },
      );
    }
    const formulaCells = new Set();
    const formulas = sheet.rawFormulas.map((formula, formulaIndex) => {
      assertStrictObject(
        formula,
        new Set(["cell", "formula"]),
        `工作表“${sheet.name}”公式 ${formulaIndex + 1}`,
      );
      const cell = parsedCellAddress(
        formula.cell,
        `工作表“${sheet.name}”公式 ${formulaIndex + 1} 单元格`,
      );
      if (cell.row > rowCount || cell.column > columnCount) {
        throw officeError(
          "OFFICE_ARTIFACT_REQUEST_INVALID",
          `工作表“${sheet.name}”公式单元格超出数据范围`,
          { status: 400 },
        );
      }
      if (formulaCells.has(cell.address)) {
        throw officeError(
          "OFFICE_ARTIFACT_REQUEST_INVALID",
          `工作表“${sheet.name}”公式单元格不能重复`,
          { status: 400 },
        );
      }
      formulaCells.add(cell.address);
      const formulaText = validateFormula(
        formula.formula,
        sheetNames,
        `工作表“${sheet.name}”公式 ${formulaIndex + 1}`,
      );
      totalCharacters += formulaText.length;
      return { cell: cell.address, formula: formulaText };
    });
    totalFormulas += formulas.length;

    if (!Array.isArray(sheet.rawNumberFormats) || sheet.rawNumberFormats.length > 100) {
      throw officeError(
        "OFFICE_ARTIFACT_REQUEST_INVALID",
        `工作表“${sheet.name}”数字格式数量无效`,
        { status: 400 },
      );
    }
    const numberFormats = sheet.rawNumberFormats.map((format, formatIndex) => {
      assertStrictObject(
        format,
        new Set(["range", "format"]),
        `工作表“${sheet.name}”数字格式 ${formatIndex + 1}`,
      );
      const range = parsedRangeAddress(
        format.range,
        `工作表“${sheet.name}”数字格式 ${formatIndex + 1} 范围`,
      );
      if (range.end.row > rowCount || range.end.column > columnCount) {
        throw officeError(
          "OFFICE_ARTIFACT_REQUEST_INVALID",
          `工作表“${sheet.name}”数字格式范围超出数据范围`,
          { status: 400 },
        );
      }
      const formatText = boundedText(format.format, {
        label: `工作表“${sheet.name}”数字格式 ${formatIndex + 1}`,
        maxLength: 80,
        required: true,
      });
      if (/[\u0000-\u001f\u007f]/u.test(formatText)) {
        throw officeError(
          "OFFICE_ARTIFACT_REQUEST_INVALID",
          `工作表“${sheet.name}”数字格式无效`,
          { status: 400 },
        );
      }
      return { range: range.address, format: formatText };
    });
    return {
      name: sheet.name,
      rows: sheet.rows,
      headerRows: sheet.headerRows,
      freezeRows: sheet.freezeRows,
      freezeColumns: sheet.freezeColumns,
      columnWidths: sheet.columnWidths,
      formulas,
      numberFormats,
    };
  });
  if (
    totalCells > MAX_EXCEL_TOTAL_CELLS
    || totalCharacters > MAX_EXCEL_TOTAL_CHARACTERS
    || totalFormulas > MAX_EXCEL_FORMULAS
  ) {
    throw officeError(
      "OFFICE_ARTIFACT_REQUEST_TOO_LARGE",
      "Excel 工作簿内容超过当前安全上限",
      { status: 413 },
    );
  }
  return { fileName, title, sheets };
}

function runtimeRoot(env) {
  const configured = String(env?.PI_OFFICE_RUNTIME_ROOT ?? "").trim();
  return path.resolve(configured || DEFAULT_RUNTIME_ROOT);
}

async function executableAvailable(filePath) {
  try {
    await access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function fileAvailable(filePath) {
  try {
    const information = await stat(filePath);
    return information.isFile();
  } catch {
    return false;
  }
}

async function findPythonDocx(root) {
  const libRoot = path.join(root, "python", "lib");
  try {
    const entries = await readdir(libRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("python")) continue;
      const packagePath = path.join(
        libRoot,
        entry.name,
        "site-packages",
        "docx",
        "__init__.py",
      );
      if (await fileAvailable(packagePath)) return packagePath;
    }
  } catch {
    return null;
  }
  return null;
}

export async function probeOfficeArtifactRuntime({ env = process.env } = {}) {
  const root = runtimeRoot(env);
  const pythonPath = path.join(root, "python", "bin", "python3");
  const nodePath = path.join(root, "node", "bin", "node");
  const nodeModulesPath = path.join(root, "node", "node_modules");
  const artifactToolPackagePath = path.join(
    nodeModulesPath,
    "@oai",
    "artifact-tool",
    "package.json",
  );
  const sofficePath = path.join(root, "bin", "override", "soffice");
  const pdftoppmPath = path.join(root, "bin", "override", "pdftoppm");
  const [
    pythonAvailable,
    pythonDocxPath,
    nodeAvailable,
    artifactToolPackageAvailable,
    sofficeAvailable,
    pdftoppmAvailable,
  ] = await Promise.all([
    executableAvailable(pythonPath),
    findPythonDocx(root),
    executableAvailable(nodePath),
    fileAvailable(artifactToolPackagePath),
    executableAvailable(sofficePath),
    executableAvailable(pdftoppmPath),
  ]);
  let artifactToolVersion = null;
  if (artifactToolPackageAvailable) {
    try {
      const packageJson = JSON.parse(await readFile(artifactToolPackagePath, "utf8"));
      artifactToolVersion = typeof packageJson.version === "string"
        ? packageJson.version
        : null;
    } catch {
      artifactToolVersion = null;
    }
  }
  const wordBuilderAvailable = pythonAvailable && Boolean(pythonDocxPath);
  const excelAvailable = nodeAvailable && artifactToolPackageAvailable;
  const renderAvailable = sofficeAvailable && pdftoppmAvailable;
  const wordAvailable = wordBuilderAvailable && renderAvailable;
  const reason = !wordBuilderAvailable
    ? "缺少 Codex 工作区 Python 或 python-docx，Word 生成不可用"
    : !renderAvailable
      ? "缺少受管 LibreOffice 或 pdftoppm，Word 无法完成渲染验证"
      : !excelAvailable
        ? "缺少 Codex 工作区 Node.js 或 @oai/artifact-tool，Excel 生成不可用"
        : null;
  return {
    available: wordAvailable && excelAvailable,
    reason,
    runtimeRoot: root,
    word: {
      available: wordAvailable,
      builderAvailable: wordBuilderAvailable,
      reason: wordAvailable ? null : reason,
      rendererAvailable: renderAvailable,
      rendererReason: renderAvailable
        ? null
        : "缺少受管 LibreOffice 或 pdftoppm",
    },
    excel: {
      available: excelAvailable,
      reason: excelAvailable
        ? null
        : "缺少 Codex 工作区 Node.js 或 @oai/artifact-tool",
      artifactToolVersion,
      rendererAvailable: excelAvailable,
    },
    paths: {
      pythonPath,
      nodePath,
      nodeModulesPath,
      sofficePath,
      pdftoppmPath,
    },
  };
}

function safeProcessEnvironment({ runtime, workDirectory }) {
  return {
    HOME: workDirectory,
    TMPDIR: tmpdir(),
    PATH: [
      path.join(runtime.runtimeRoot, "bin", "override"),
      "/usr/bin",
      "/bin",
    ].join(path.delimiter),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    NODE_NO_WARNINGS: "1",
    ...(process.platform === "darwin"
      ? {
        SAL_FONTPATH: [
          "/System/Library/Fonts",
          "/System/Library/Fonts/Supplemental",
          "/Library/Fonts",
        ].join(path.delimiter),
      }
      : {}),
  };
}

function processFailureMessage(stderr, fallback) {
  const detail = Buffer.concat(stderr)
    .toString("utf8")
    .replaceAll(/[\u0000-\u001f\u007f]+/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim()
    .slice(0, 400);
  return detail ? `${fallback}（${detail}）` : fallback;
}

function workerFailureDetail(stdout) {
  const lines = Buffer.concat(stdout).toString("utf8").trim().split("\n").filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const result = JSON.parse(lines[index]);
      if (result?.ok === false && typeof result.error === "string") {
        return result.error
          .replaceAll(/[\u0000-\u001f\u007f]+/gu, " ")
          .replaceAll(/\s+/gu, " ")
          .trim()
          .slice(0, 300);
      }
    } catch {
      // Ignore non-JSON progress output.
    }
  }
  return "";
}

function runFixedProcess({
  command,
  args,
  cwd,
  env,
  input = null,
  signal,
  timeoutMs = PROCESS_TIMEOUT_MS,
  failureMessage,
}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(officeError(
        "OFFICE_ARTIFACT_ABORTED",
        "Office 文件生成已停止",
        { status: 409 },
      ));
      return;
    }
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env,
        shell: false,
        stdio: [input === null ? "ignore" : "pipe", "pipe", "pipe"],
      });
    } catch {
      reject(officeError(
        "OFFICE_ARTIFACT_RUNTIME_FAILED",
        failureMessage,
        { retryable: true, status: 503 },
      ));
      return;
    }
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const stop = (error) => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The child may already be gone.
      }
      finish(reject, error);
    };
    const abort = () => stop(officeError(
      "OFFICE_ARTIFACT_ABORTED",
      "Office 文件生成已停止",
      { status: 409 },
    ));
    child.stdout?.on("data", (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += bytes.length;
      if (stdoutBytes > MAX_PROCESS_STDOUT_BYTES) {
        stop(officeError(
          "OFFICE_ARTIFACT_OUTPUT_TOO_LARGE",
          "Office 生成进程输出超过安全上限",
          { status: 422 },
        ));
        return;
      }
      stdout.push(bytes);
    });
    child.stderr?.on("data", (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrBytes += bytes.length;
      if (stderrBytes > MAX_PROCESS_STDERR_BYTES) {
        stop(officeError(
          "OFFICE_ARTIFACT_OUTPUT_TOO_LARGE",
          "Office 生成进程日志超过安全上限",
          { status: 422 },
        ));
        return;
      }
      stderr.push(bytes);
    });
    child.once("error", () => finish(reject, officeError(
      "OFFICE_ARTIFACT_RUNTIME_FAILED",
      failureMessage,
      { retryable: true, status: 503 },
    )));
    child.once("close", (exitCode) => {
      if (exitCode !== 0) {
        const workerDetail = workerFailureDetail(stdout);
        finish(reject, officeError(
          "OFFICE_ARTIFACT_GENERATION_FAILED",
          workerDetail
            ? `${failureMessage}（${workerDetail}）`
            : processFailureMessage(stderr, failureMessage),
          { retryable: true, status: 422 },
        ));
        return;
      }
      finish(resolve, {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => stop(officeError(
      "OFFICE_ARTIFACT_TIMEOUT",
      "Office 文件生成超时",
      { retryable: true, status: 504 },
    )), timeoutMs);
    if (input !== null) child.stdin?.end(input);
  });
}

function parseWorkerResult(stdout, label) {
  const lines = String(stdout ?? "").trim().split("\n").filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const result = JSON.parse(lines[index]);
      if (result?.ok === true) return result;
      if (result?.ok === false) {
        throw officeError(
          "OFFICE_ARTIFACT_GENERATION_FAILED",
          `${label}生成失败`,
          { retryable: true, status: 422 },
        );
      }
    } catch (error) {
      if (error instanceof OfficeArtifactError) throw error;
    }
  }
  throw officeError(
    "OFFICE_ARTIFACT_RESULT_INVALID",
    `${label}生成结果无效`,
    { retryable: true, status: 422 },
  );
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function stableRequestHash(request) {
  return sha256(Buffer.from(JSON.stringify(request), "utf8"));
}

function checkedRequestId(value) {
  if (typeof value !== "string" || !REQUEST_ID_PATTERN.test(value)) {
    throw officeError(
      "OFFICE_ARTIFACT_REQUEST_ID_INVALID",
      "Office 生成请求标识无效",
      { status: 400 },
    );
  }
  return value;
}

async function resolvedArtifactDirectory(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw officeError(
      "OFFICE_ARTIFACT_DIRECTORY_INVALID",
      "Office 产物目录无效",
      { status: 500 },
    );
  }
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) {
    throw officeError(
      "OFFICE_ARTIFACT_DIRECTORY_INVALID",
      "Office 产物目录不能是文件系统根目录",
      { status: 500 },
    );
  }
  await mkdir(resolved, { recursive: true, mode: 0o700 });
  return realpath(resolved);
}

function assertOoxmlStructure(bytes, kind) {
  if (
    bytes.length < 100
    || bytes.length > MAX_OFFICE_ARTIFACT_BYTES
    || !bytes.subarray(0, ZIP_SIGNATURE.length).equals(ZIP_SIGNATURE)
  ) {
    throw officeError(
      "OFFICE_ARTIFACT_STRUCTURE_INVALID",
      "生成的 Office 文件结构无效",
      { status: 422 },
    );
  }
  let entries;
  try {
    entries = unzipSync(new Uint8Array(bytes));
  } catch {
    throw officeError(
      "OFFICE_ARTIFACT_STRUCTURE_INVALID",
      "生成的 Office 文件无法完成结构校验",
      { status: 422 },
    );
  }
  const names = Object.keys(entries);
  if (
    names.some((name) => (
      !name
      || name.startsWith("/")
      || name.includes("\\")
      || name.split("/").includes("..")
      || OOXML_FORBIDDEN_ENTRY_PATTERN.test(name)
    ))
  ) {
    throw officeError(
      "OFFICE_ARTIFACT_UNSAFE",
      "Office 文件包含宏、嵌入对象或外部连接",
      { status: 422 },
    );
  }
  const required = kind === "word"
    ? [
      "[Content_Types].xml",
      "_rels/.rels",
      "word/document.xml",
      "word/styles.xml",
      "word/numbering.xml",
    ]
    : [
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/styles.xml",
    ];
  if (required.some((name) => !entries[name])) {
    throw officeError(
      "OFFICE_ARTIFACT_STRUCTURE_INVALID",
      "生成的 Office 文件缺少必要结构",
      { status: 422 },
    );
  }
  const xmlEntries = names.filter((name) => /(?:\.xml|\.rels)$/iu.test(name));
  for (const name of xmlEntries) {
    const text = Buffer.from(entries[name]).toString("utf8");
    if (
      /TargetMode\s*=\s*["']External["']/iu.test(text)
      || /macroEnabled|application\/vnd\.ms-office\.vbaProject/iu.test(text)
      || /<externalLink\b/iu.test(text)
    ) {
      throw officeError(
        "OFFICE_ARTIFACT_UNSAFE",
        "Office 文件包含宏或外部链接",
        { status: 422 },
      );
    }
  }
  if (kind === "excel") {
    const worksheets = names.filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/u.test(name));
    if (!worksheets.length) {
      throw officeError(
        "OFFICE_ARTIFACT_STRUCTURE_INVALID",
        "Excel 文件没有有效工作表",
        { status: 422 },
      );
    }
  }
  return { entryCount: names.length };
}

function pngMetadata(bytes) {
  if (
    bytes.length < 33
    || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    || bytes.toString("ascii", 12, 16) !== "IHDR"
  ) {
    throw officeError(
      "OFFICE_ARTIFACT_RENDER_INVALID",
      "Office 预览图片无效",
      { status: 422 },
    );
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height || width > 20_000 || height > 20_000) {
    throw officeError(
      "OFFICE_ARTIFACT_RENDER_INVALID",
      "Office 预览图片尺寸无效",
      { status: 422 },
    );
  }
  return { width, height };
}

function wordPreviewText(request) {
  const parts = [request.title];
  if (request.subtitle) parts.push(request.subtitle);
  for (const section of request.sections) {
    if (section.heading) parts.push(`\n${"#".repeat(section.level)} ${section.heading}`);
    parts.push(...section.paragraphs);
    parts.push(...section.bullets.map((item) => `- ${item}`));
    parts.push(...section.numbered.map((item, index) => `${index + 1}. ${item}`));
    for (const table of section.tables) {
      parts.push(table.headers.join(" | "));
      parts.push(...table.rows.map((row) => row.join(" | ")));
    }
  }
  return parts.join("\n").slice(0, MAX_PREVIEW_TEXT_CHARACTERS);
}

function excelPreviewText(request) {
  const parts = [request.title];
  for (const sheet of request.sheets) {
    parts.push(`\n# ${sheet.name}`);
    parts.push(...sheet.rows.map((row) => row.map((value) => (
      value === null ? "" : String(value)
    )).join("\t")));
    if (sheet.formulas.length) {
      parts.push("\n公式：");
      parts.push(...sheet.formulas.map((formula) => `${formula.cell}\t${formula.formula}`));
    }
    if (parts.join("\n").length >= MAX_PREVIEW_TEXT_CHARACTERS) break;
  }
  return parts.join("\n").slice(0, MAX_PREVIEW_TEXT_CHARACTERS);
}

async function renderWord({ runtime, workDirectory, fileName, signal }) {
  if (!runtime.word.rendererAvailable) {
    return {
      renderVerified: false,
      pageCount: null,
      previewFiles: [],
      renderStatus: "unavailable",
      renderReason: runtime.word.rendererReason,
    };
  }
  const renderDirectory = path.join(workDirectory, "render");
  const profileDirectory = path.join(workDirectory, "libreoffice-profile");
  await mkdir(renderDirectory, { recursive: true, mode: 0o700 });
  await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
  const environment = safeProcessEnvironment({ runtime, workDirectory });
  if (process.platform === "darwin") {
    const sourceFont = "/System/Library/Fonts/Hiragino Sans GB.ttc";
    const defaultFontConfig = path.join(
      runtime.runtimeRoot,
      "native",
      "libreoffice-headless",
      "libreoffice",
      "LibreOfficeDev.app",
      "Contents",
      "Resources",
      "fontconfig",
      "fonts.conf",
    );
    if (await fileAvailable(sourceFont) && await fileAvailable(defaultFontConfig)) {
      const localFontDirectory = path.join(workDirectory, "fonts");
      const fontCacheDirectory = path.join(workDirectory, "font-cache");
      await mkdir(localFontDirectory, { recursive: true, mode: 0o700 });
      await mkdir(fontCacheDirectory, { recursive: true, mode: 0o700 });
      await copyFile(
        sourceFont,
        path.join(localFontDirectory, "Hiragino Sans GB.ttc"),
        fsConstants.COPYFILE_EXCL,
      );
      const xml = (value) => String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&apos;");
      const localFontConfig = path.join(workDirectory, "fonts.conf");
      await writeFile(
        localFontConfig,
        [
          '<?xml version="1.0"?>',
          '<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">',
          "<fontconfig>",
          `  <include ignore_missing="no">${xml(defaultFontConfig)}</include>`,
          `  <dir>${xml(localFontDirectory)}</dir>`,
          `  <cachedir>${xml(fontCacheDirectory)}</cachedir>`,
          "</fontconfig>",
          "",
        ].join("\n"),
        { encoding: "utf8", mode: 0o600 },
      );
      environment.FONTCONFIG_FILE = localFontConfig;
      environment.FONTCONFIG_PATH = path.dirname(defaultFontConfig);
      environment.SAL_FONTPATH = localFontDirectory;
    }
  }
  await runFixedProcess({
    command: runtime.paths.sofficePath,
    args: [
      "--headless",
      `-env:UserInstallation=${pathToFileURL(profileDirectory).href}`,
      "--convert-to",
      "pdf",
      "--outdir",
      renderDirectory,
      path.join(workDirectory, fileName),
    ],
    cwd: workDirectory,
    env: environment,
    signal,
    failureMessage: "Word 文件无法完成版面渲染",
  });
  const pdfPath = path.join(
    renderDirectory,
    `${path.basename(fileName, path.extname(fileName))}.pdf`,
  );
  if (!(await fileAvailable(pdfPath))) {
    throw officeError(
      "OFFICE_ARTIFACT_RENDER_FAILED",
      "Word 文件没有生成可验证的页面",
      { retryable: true, status: 422 },
    );
  }
  await runFixedProcess({
    command: runtime.paths.pdftoppmPath,
    args: ["-png", "-r", "144", pdfPath, path.join(renderDirectory, "page")],
    cwd: workDirectory,
    env: environment,
    signal,
    failureMessage: "Word 页面预览生成失败",
  });
  const entries = (await readdir(renderDirectory))
    .filter((name) => /^page-\d+\.png$/u.test(name))
    .sort((left, right) => Number(left.match(/\d+/u)[0]) - Number(right.match(/\d+/u)[0]));
  if (!entries.length) {
    throw officeError(
      "OFFICE_ARTIFACT_RENDER_FAILED",
      "Word 文件没有生成页面预览",
      { retryable: true, status: 422 },
    );
  }
  return {
    renderVerified: true,
    pageCount: entries.length,
    previewFiles: entries.map((fileName) => ({
      fileName,
      sourcePath: path.join(renderDirectory, fileName),
    })),
    renderStatus: "passed",
    renderReason: null,
  };
}

async function copyVerifiedPreviews({
  previewFiles,
  operationDirectory,
  requestId,
}) {
  if (!previewFiles.length) return [];
  const previewDirectory = path.join(operationDirectory, "previews");
  await mkdir(previewDirectory, { recursive: true, mode: 0o700 });
  const result = [];
  for (const preview of previewFiles) {
    if (!SAFE_PREVIEW_FILE_PATTERN.test(preview.fileName)) {
      throw officeError(
        "OFFICE_ARTIFACT_RENDER_INVALID",
        "Office 预览文件名无效",
        { status: 422 },
      );
    }
    const bytes = await readFile(preview.sourcePath);
    const dimensions = pngMetadata(bytes);
    const destination = path.join(previewDirectory, preview.fileName);
    await copyFile(preview.sourcePath, destination, fsConstants.COPYFILE_EXCL);
    await chmod(destination, 0o600);
    result.push({
      fileName: path.posix.join(requestId, "previews", preview.fileName),
      ...(preview.sheetName ? { sheetName: preview.sheetName } : {}),
      byteLength: bytes.length,
      sha256: sha256(bytes),
      ...dimensions,
    });
  }
  return result;
}

async function writeJsonExclusive(filePath, value) {
  await writeFile(
    filePath,
    `${JSON.stringify(value, null, 2)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
}

async function existingOperationResult({ operationDirectory, requestId, requestHash, kind }) {
  const metadataPath = path.join(operationDirectory, "metadata.json");
  if (!(await fileAvailable(metadataPath))) return null;
  let metadata;
  try {
    metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  } catch {
    throw officeError(
      "OFFICE_ARTIFACT_METADATA_INVALID",
      "Office 产物记录无法读取",
      { status: 409 },
    );
  }
  if (
    metadata?.version !== 1
    || metadata?.requestId !== requestId
    || metadata?.requestHash !== requestHash
    || metadata?.artifact?.kind !== kind
  ) {
    throw officeError(
      "OFFICE_ARTIFACT_OPERATION_CONFLICT",
      "同一 Office 请求标识已绑定到另一份内容",
      { status: 409 },
    );
  }
  return readOfficeArtifactMetadata({
    artifactDirectory: path.dirname(operationDirectory),
    requestId,
  });
}

async function claimOperation({ operationDirectory, requestId, requestHash, kind }) {
  const claimPath = path.join(operationDirectory, "claim.json");
  const exists = await lstat(operationDirectory).then(() => true).catch(() => false);
  if (exists) {
    if (!(await fileAvailable(claimPath))) {
      throw officeError(
        "OFFICE_ARTIFACT_OPERATION_CONFLICT",
        "Office 请求目录中已有未识别内容",
        { status: 409 },
      );
    }
    let claim;
    try {
      claim = JSON.parse(await readFile(claimPath, "utf8"));
    } catch {
      throw officeError(
        "OFFICE_ARTIFACT_OPERATION_CONFLICT",
        "Office 请求恢复记录无效",
        { status: 409 },
      );
    }
    if (
      claim?.requestId !== requestId
      || claim?.requestHash !== requestHash
      || claim?.kind !== kind
    ) {
      throw officeError(
        "OFFICE_ARTIFACT_OPERATION_CONFLICT",
        "同一 Office 请求标识已绑定到另一份内容",
        { status: 409 },
      );
    }
    await rm(operationDirectory, { recursive: true, force: true });
  }
  await mkdir(operationDirectory, { recursive: false, mode: 0o700 });
  await writeJsonExclusive(claimPath, {
    version: 1,
    requestId,
    requestHash,
    kind,
  });
}

async function finalizeArtifact({
  artifactDirectory,
  operationDirectory,
  workDirectory,
  requestId,
  requestHash,
  kind,
  mimeType,
  title,
  summary,
  previewText,
  normalizedRequest,
  workerResult,
  renderResult,
}) {
  const sourcePath = path.join(workDirectory, normalizedRequest.fileName);
  const bytes = await readFile(sourcePath);
  const ooxml = assertOoxmlStructure(bytes, kind);
  const destinationPath = path.join(operationDirectory, normalizedRequest.fileName);
  await copyFile(sourcePath, destinationPath, fsConstants.COPYFILE_EXCL);
  const previews = await copyVerifiedPreviews({
    previewFiles: renderResult.previewFiles,
    operationDirectory,
    requestId,
  });
  const artifact = {
    kind,
    fileName: path.posix.join(requestId, normalizedRequest.fileName),
    mimeType,
    byteLength: bytes.length,
    sha256: sha256(bytes),
    title,
    summary,
    previewText: previewText.slice(0, MAX_PREVIEW_TEXT_CHARACTERS),
    renderVerified: renderResult.renderVerified,
    structureVerified: true,
    operationId: requestId,
    ...(kind === "word"
      ? { pageCount: renderResult.pageCount }
      : { sheetCount: normalizedRequest.sheets.length }),
    previewImages: previews,
    verification: {
      structure: {
        status: "passed",
        ooxmlEntryCount: ooxml.entryCount,
        worker: workerResult.structure,
      },
      render: {
        status: renderResult.renderStatus,
        reason: renderResult.renderReason,
      },
    },
  };
  const metadata = {
    version: 1,
    requestId,
    requestHash,
    createdAt: new Date().toISOString(),
    artifact,
  };
  await writeJsonExclusive(path.join(operationDirectory, "metadata.json"), metadata);
  await rm(path.join(operationDirectory, "claim.json"), { force: true });
  return { artifact };
}

async function prepareGeneration({
  request,
  artifactDirectory,
  requestId,
  kind,
  validate,
  env,
}) {
  const normalizedRequest = validate(request);
  const checkedId = checkedRequestId(requestId);
  const root = await resolvedArtifactDirectory(artifactDirectory);
  const operationDirectory = path.join(root, checkedId);
  const requestHash = stableRequestHash(normalizedRequest);
  const existing = await existingOperationResult({
    operationDirectory,
    requestId: checkedId,
    requestHash,
    kind,
  });
  if (existing) return { existing, ownsOperationDirectory: false };
  await claimOperation({
    operationDirectory,
    requestId: checkedId,
    requestHash,
    kind,
  });
  const runtime = await probeOfficeArtifactRuntime({ env });
  return {
    normalizedRequest,
    requestId: checkedId,
    requestHash,
    artifactDirectory: root,
    operationDirectory,
    runtime,
    ownsOperationDirectory: true,
  };
}

export async function generateWordArtifact({
  request,
  artifactDirectory,
  requestId,
  signal,
  env = process.env,
}) {
  const prepared = await prepareGeneration({
    request,
    artifactDirectory,
    requestId,
    kind: "word",
    validate: validateWordArtifactRequest,
    env,
  });
  if (prepared.existing) return { artifact: prepared.existing };
  const {
    normalizedRequest,
    operationDirectory,
    runtime,
  } = prepared;
  if (!runtime.word.available) {
    await rm(operationDirectory, { recursive: true, force: true });
    throw officeError(
      "OFFICE_WORD_RUNTIME_UNAVAILABLE",
      runtime.word.reason,
      { status: 503 },
    );
  }
  const workDirectory = await mkdtemp(path.join(prepared.artifactDirectory, ".office-word-"));
  try {
    const worker = await runFixedProcess({
      command: runtime.paths.pythonPath,
      args: [WORD_WORKER_PATH],
      cwd: workDirectory,
      env: safeProcessEnvironment({ runtime, workDirectory }),
      input: JSON.stringify({ request: normalizedRequest }),
      signal,
      failureMessage: "Word 文件生成失败",
    });
    const workerResult = parseWorkerResult(worker.stdout, "Word 文件");
    const renderResult = await renderWord({
      runtime,
      workDirectory,
      fileName: normalizedRequest.fileName,
      signal,
    });
    return await finalizeArtifact({
      ...prepared,
      workDirectory,
      kind: "word",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      title: normalizedRequest.title,
      summary: `${normalizedRequest.sections.length} 个章节的 Word 文档`,
      previewText: wordPreviewText(normalizedRequest),
      workerResult,
      renderResult,
    });
  } catch (error) {
    if (prepared.ownsOperationDirectory) {
      await rm(operationDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  } finally {
    await rm(workDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function generateExcelArtifact({
  request,
  artifactDirectory,
  requestId,
  signal,
  env = process.env,
}) {
  const prepared = await prepareGeneration({
    request,
    artifactDirectory,
    requestId,
    kind: "excel",
    validate: validateExcelArtifactRequest,
    env,
  });
  if (prepared.existing) return { artifact: prepared.existing };
  const {
    normalizedRequest,
    operationDirectory,
    runtime,
  } = prepared;
  if (!runtime.excel.available) {
    await rm(operationDirectory, { recursive: true, force: true });
    throw officeError(
      "OFFICE_EXCEL_RUNTIME_UNAVAILABLE",
      runtime.excel.reason,
      { status: 503 },
    );
  }
  const workDirectory = await mkdtemp(path.join(prepared.artifactDirectory, ".office-excel-"));
  try {
    await symlink(runtime.paths.nodeModulesPath, path.join(workDirectory, "node_modules"), "dir");
    const localWorkerPath = path.join(workDirectory, "officeExcelWorker.mjs");
    await copyFile(EXCEL_WORKER_PATH, localWorkerPath, fsConstants.COPYFILE_EXCL);
    const worker = await runFixedProcess({
      command: runtime.paths.nodePath,
      args: [localWorkerPath],
      cwd: workDirectory,
      env: safeProcessEnvironment({ runtime, workDirectory }),
      input: JSON.stringify({ request: normalizedRequest }),
      signal,
      failureMessage: "Excel 文件生成失败",
    });
    const workerResult = parseWorkerResult(worker.stdout, "Excel 文件");
    const previewFiles = (workerResult.previewFiles ?? []).map((preview) => {
      if (!isPlainObject(preview) || typeof preview.fileName !== "string") {
        throw officeError(
          "OFFICE_ARTIFACT_RENDER_INVALID",
          "Excel 预览记录无效",
          { status: 422 },
        );
      }
      return {
        fileName: preview.fileName,
        sheetName: boundedText(preview.sheetName, {
          label: "Excel 预览工作表",
          maxLength: 31,
          required: true,
        }),
        sourcePath: path.join(workDirectory, preview.fileName),
      };
    });
    if (previewFiles.length !== normalizedRequest.sheets.length) {
      throw officeError(
        "OFFICE_ARTIFACT_RENDER_FAILED",
        "Excel 没有完成全部工作表的渲染验证",
        { status: 422 },
      );
    }
    return await finalizeArtifact({
      ...prepared,
      workDirectory,
      kind: "excel",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      title: normalizedRequest.title,
      summary: `${normalizedRequest.sheets.length} 个工作表的 Excel 工作簿`,
      previewText: excelPreviewText(normalizedRequest),
      workerResult,
      renderResult: {
        renderVerified: true,
        previewFiles,
        renderStatus: "passed",
        renderReason: null,
      },
    });
  } catch (error) {
    if (prepared.ownsOperationDirectory) {
      await rm(operationDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  } finally {
    await rm(workDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function readOfficeArtifactMetadata({
  artifactDirectory,
  requestId,
  verifyFiles = true,
}) {
  const root = await resolvedArtifactDirectory(artifactDirectory);
  const checkedId = checkedRequestId(requestId);
  const operationDirectory = path.join(root, checkedId);
  let metadata;
  try {
    metadata = JSON.parse(await readFile(path.join(operationDirectory, "metadata.json"), "utf8"));
  } catch {
    throw officeError(
      "OFFICE_ARTIFACT_NOT_FOUND",
      "当前会话中没有这份 Office 文件",
      { status: 404 },
    );
  }
  const artifact = metadata?.artifact;
  if (
    metadata?.version !== 1
    || metadata?.requestId !== checkedId
    || !isPlainObject(artifact)
    || artifact.operationId !== checkedId
    || !["word", "excel"].includes(artifact.kind)
  ) {
    throw officeError(
      "OFFICE_ARTIFACT_METADATA_INVALID",
      "Office 产物记录无效",
      { status: 409 },
    );
  }
  const expectedPrefix = `${checkedId}/`;
  if (
    typeof artifact.fileName !== "string"
    || !artifact.fileName.startsWith(expectedPrefix)
    || artifact.fileName.slice(expectedPrefix.length).includes("/")
  ) {
    throw officeError(
      "OFFICE_ARTIFACT_METADATA_INVALID",
      "Office 产物路径无效",
      { status: 409 },
    );
  }
  if (verifyFiles) {
    const filePath = path.join(root, ...artifact.fileName.split("/"));
    const bytes = await readFile(filePath).catch(() => null);
    if (
      !bytes
      || bytes.length !== artifact.byteLength
      || sha256(bytes) !== artifact.sha256
    ) {
      throw officeError(
        "OFFICE_ARTIFACT_STALE",
        "Office 文件已变化，不能继续使用旧记录",
        { status: 409 },
      );
    }
    assertOoxmlStructure(bytes, artifact.kind);
  }
  return structuredClone(artifact);
}

export async function readOfficeArtifactBytes({
  artifactDirectory,
  requestId,
  expectedSha256 = null,
}) {
  const artifact = await readOfficeArtifactMetadata({
    artifactDirectory,
    requestId,
    verifyFiles: true,
  });
  if (expectedSha256 !== null && expectedSha256 !== artifact.sha256) {
    throw officeError(
      "OFFICE_ARTIFACT_STALE",
      "Office 文件版本已变化",
      { status: 409 },
    );
  }
  const root = await resolvedArtifactDirectory(artifactDirectory);
  const bytes = await readFile(path.join(root, ...artifact.fileName.split("/")));
  return { artifact, bytes };
}
