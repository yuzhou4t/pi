import fs from "node:fs/promises";
import path from "node:path";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const MAX_STDIN_BYTES = 1_500_000;

function fail(message) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
  process.exitCode = 1;
}

async function readPayload() {
  const chunks = [];
  let byteLength = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += bytes.length;
    if (byteLength > MAX_STDIN_BYTES) throw new Error("invalid request size");
    chunks.push(bytes);
  }
  if (!byteLength) throw new Error("invalid request size");
  const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (
    !payload
    || typeof payload !== "object"
    || Array.isArray(payload)
    || Object.keys(payload).length !== 1
    || !("request" in payload)
  ) {
    throw new Error("invalid request envelope");
  }
  return payload.request;
}

function columnLetters(index) {
  let current = index + 1;
  let result = "";
  while (current > 0) {
    const remainder = (current - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    current = Math.floor((current - 1) / 26);
  }
  return result;
}

function rangeAddress(rowCount, columnCount) {
  return `A1:${columnLetters(columnCount - 1)}${rowCount}`;
}

function computedColumnWidth(rows, columnIndex) {
  let longest = 8;
  for (const row of rows.slice(0, 200)) {
    const value = row[columnIndex];
    const display = value === null ? "" : String(value);
    longest = Math.max(longest, ...display.split(/\r?\n/u).map((line) => line.length));
  }
  return Math.max(8, Math.min(42, longest + 2));
}

function resultCount(ndjson) {
  if (typeof ndjson !== "string" || !ndjson.trim()) return 0;
  return ndjson.trim().split("\n").filter(Boolean).reduce((count, line) => {
    try {
      const record = JSON.parse(line);
      return record?.kind === "notice" ? count : count + 1;
    } catch {
      return count + 1;
    }
  }, 0);
}

async function buildWorkbook(request) {
  const expectedKeys = ["fileName", "title", "sheets"];
  if (
    !request
    || typeof request !== "object"
    || Array.isArray(request)
    || Object.keys(request).sort().join("|") !== expectedKeys.sort().join("|")
  ) {
    throw new Error("request was not normalized");
  }

  const workbook = Workbook.create();
  const worksheets = new Map();
  for (const sheetRequest of request.sheets) {
    worksheets.set(sheetRequest.name, workbook.worksheets.add(sheetRequest.name));
  }

  let formulaCount = 0;
  const sheetSummaries = [];
  const previewFiles = [];
  for (let sheetIndex = 0; sheetIndex < request.sheets.length; sheetIndex += 1) {
    const sheetRequest = request.sheets[sheetIndex];
    const sheet = worksheets.get(sheetRequest.name);
    const rowCount = sheetRequest.rows.length;
    const columnCount = sheetRequest.rows[0].length;
    const usedAddress = rangeAddress(rowCount, columnCount);
    const usedRange = sheet.getRange(usedAddress);
    usedRange.values = sheetRequest.rows;
    usedRange.format = {
      font: { name: "Aptos", size: 11, color: "#27313A" },
      verticalAlignment: "center",
    };

    if (sheetRequest.headerRows > 0) {
      const headerAddress = `A1:${columnLetters(columnCount - 1)}${sheetRequest.headerRows}`;
      const headerRange = sheet.getRange(headerAddress);
      headerRange.format = {
        fill: "#0F766E",
        font: { name: "Aptos Display", size: 11, bold: true, color: "#FFFFFF" },
        verticalAlignment: "center",
        horizontalAlignment: "left",
        wrapText: true,
        borders: { preset: "outside", style: "thin", color: "#0B5F59" },
      };
      headerRange.format.rowHeight = 24;
    }

    if (rowCount > sheetRequest.headerRows) {
      const bodyStart = sheetRequest.headerRows + 1;
      const bodyRange = sheet.getRange(
        `A${bodyStart}:${columnLetters(columnCount - 1)}${rowCount}`,
      );
      bodyRange.format.borders = {
        bottom: { style: "thin", color: "#E5E1D8" },
      };
    }

    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      const width = sheetRequest.columnWidths[columnIndex]
        ?? computedColumnWidth(sheetRequest.rows, columnIndex);
      sheet.getRangeByIndexes(0, columnIndex, rowCount, 1).format.columnWidth = width;
    }

    for (const formula of sheetRequest.formulas) {
      sheet.getRange(formula.cell).formulas = [[formula.formula]];
      formulaCount += 1;
    }
    for (const numberFormat of sheetRequest.numberFormats) {
      sheet.getRange(numberFormat.range).setNumberFormat(numberFormat.format);
    }

    if (sheetRequest.freezeRows > 0) {
      sheet.freezePanes.freezeRows(sheetRequest.freezeRows);
    }
    if (sheetRequest.freezeColumns > 0) {
      sheet.freezePanes.freezeColumns(sheetRequest.freezeColumns);
    }
    sheet.showGridLines = false;

    const inspection = await workbook.inspect({
      kind: "region",
      sheetId: sheetRequest.name,
      range: usedAddress,
      maxChars: 4_000,
      tableMaxRows: Math.min(rowCount, 12),
      tableMaxCols: Math.min(columnCount, 12),
      tableMaxCellChars: 120,
    });
    sheetSummaries.push({
      name: sheetRequest.name,
      rowCount,
      columnCount,
      formulaCount: sheetRequest.formulas.length,
      inspectionAvailable: Boolean(inspection?.ndjson),
    });

    const preview = await workbook.render({
      sheetName: sheetRequest.name,
      autoCrop: "all",
      scale: 1,
      format: "png",
    });
    const previewFileName = `preview-sheet-${String(sheetIndex + 1).padStart(3, "0")}.png`;
    await fs.writeFile(
      path.join(process.cwd(), previewFileName),
      new Uint8Array(await preview.arrayBuffer()),
      { mode: 0o600 },
    );
    previewFiles.push({ fileName: previewFileName, sheetName: sheetRequest.name });
  }

  const formulaErrors = await workbook.inspect({
    kind: "match",
    searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!",
    options: { useRegex: true, maxResults: 300 },
    summary: "final formula error scan",
    maxChars: 8_000,
  });
  const formulaErrorCount = resultCount(formulaErrors?.ndjson);
  if (formulaErrorCount > 0) {
    throw new Error("formula verification found an error value");
  }

  const output = await SpreadsheetFile.exportXlsx(workbook);
  await output.save(path.join(process.cwd(), request.fileName));
  await fs.chmod(path.join(process.cwd(), request.fileName), 0o600);

  return {
    ok: true,
    fileName: request.fileName,
    structure: {
      sheetCount: request.sheets.length,
      formulaCount,
      formulaErrorCount,
      sheets: sheetSummaries,
    },
    previewFiles,
  };
}

try {
  const request = await readPayload();
  const result = await buildWorkbook(request);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  fail(`XLSX build failed: ${error?.name ?? "Error"}: ${String(error?.message ?? "unknown").slice(0, 240)}`);
}
