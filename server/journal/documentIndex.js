import { createHash } from "node:crypto";

export const DOCUMENT_INDEX_MAX_BYTES = 5 * 1024 * 1024;

const MAX_LINES = 50_000;
const MAX_BLOCKS = 20_000;

function digest(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function lineBody(line) {
  if (line.endsWith("\r\n")) return line.slice(0, -2);
  if (line.endsWith("\n") || line.endsWith("\r")) return line.slice(0, -1);
  return line;
}

function splitLines(markdown) {
  const lines = [];
  let start = 0;

  for (let index = 0; index < markdown.length; index += 1) {
    const character = markdown[index];
    if (character !== "\n" && character !== "\r") continue;

    const end = character === "\r" && markdown[index + 1] === "\n"
      ? index + 2
      : index + 1;
    lines.push(markdown.slice(start, end));
    if (lines.length > MAX_LINES) {
      throw new RangeError(`paper Markdown exceeds ${MAX_LINES} lines`);
    }
    start = end;
    if (end === index + 2) index += 1;
  }

  if (start < markdown.length) lines.push(markdown.slice(start));
  return lines;
}

function isBlankLine(line) {
  return /^[\t ]*$/.test(lineBody(line));
}

function headingFromLine(line, firstLine) {
  let body = lineBody(line);
  if (firstLine && body.startsWith("\uFEFF")) body = body.slice(1);

  const match = body.match(/^ {0,3}(#{1,6})(?:[\t ]+|$)(.*)$/);
  if (!match) return null;

  return {
    level: match[1].length,
    title: match[2].replace(/[\t ]+#+[\t ]*$/, "").trim(),
  };
}

function fenceFromLine(line) {
  const match = lineBody(line).match(/^ {0,3}(`{3,}|~{3,})/);
  return match ? { character: match[1][0], length: match[1].length } : null;
}

function closesFence(line, fence) {
  const body = lineBody(line).trimStart();
  let length = 0;
  while (body[length] === fence.character) length += 1;
  return length >= fence.length;
}

function startsHtmlTable(line) {
  return /^ {0,3}<table(?:[\t >]|$)/i.test(lineBody(line));
}

function endsHtmlTable(line) {
  return /<\/table\s*>/i.test(lineBody(line));
}

function startsImage(line) {
  const body = lineBody(line).trimStart();
  return body.startsWith("![") || /^<img(?:[\t >]|$)/i.test(body);
}

function isMarkdownTable(markdown) {
  const lines = markdown
    .split(/\r\n|\n|\r/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2 || !lines[0].includes("|")) return false;

  const cells = lines[1]
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function blockKind(rawBlock) {
  if (rawBlock.type === "heading") return "heading";
  if (rawBlock.type === "image") return "image";
  if (rawBlock.type === "table" || isMarkdownTable(rawBlock.markdown)) return "table";
  return "text";
}

function blockText(rawBlock, kind) {
  if (kind === "heading") return rawBlock.heading.title;

  const content = rawBlock.markdown.trim();
  if (kind !== "image") return content;

  return content
    .replace(/!\[([^\]]*)\]\([^)\r\n]*\)/g, "$1")
    .replace(/<img(?:\s[^>]*)?>/gi, "")
    .trim();
}

function rawBlocksFromMarkdown(markdown) {
  const lines = splitLines(markdown);
  const blocks = [];
  let current = null;
  let pending = "";

  function finishCurrent() {
    if (!current) return;
    blocks.push(current);
    if (blocks.length > MAX_BLOCKS) {
      throw new RangeError(`paper Markdown exceeds ${MAX_BLOCKS} blocks`);
    }
    current = null;
  }

  function startCurrent(type, content, heading = null) {
    current = {
      type,
      markdown: pending + content,
      heading,
    };
    pending = "";
  }

  for (let index = 0; index < lines.length;) {
    const line = lines[index];

    if (isBlankLine(line)) {
      let blanks = "";
      while (index < lines.length && isBlankLine(lines[index])) {
        blanks += lines[index];
        index += 1;
      }
      if (current) {
        current.markdown += blanks;
        finishCurrent();
      } else {
        pending += blanks;
      }
      continue;
    }

    const heading = headingFromLine(line, index === 0);
    if (heading) {
      finishCurrent();
      startCurrent("heading", line, heading);
      index += 1;
      continue;
    }

    const fence = fenceFromLine(line);
    if (fence) {
      finishCurrent();
      let content = line;
      index += 1;
      while (index < lines.length) {
        const next = lines[index];
        content += next;
        index += 1;
        if (closesFence(next, fence)) break;
      }
      startCurrent("verbatim", content);
      continue;
    }

    if (lineBody(line).trim() === "$$") {
      finishCurrent();
      let content = line;
      index += 1;
      while (index < lines.length) {
        const next = lines[index];
        content += next;
        index += 1;
        if (lineBody(next).trim() === "$$") break;
      }
      startCurrent("verbatim", content);
      continue;
    }

    if (startsHtmlTable(line)) {
      finishCurrent();
      let content = line;
      index += 1;
      while (index < lines.length && !endsHtmlTable(content)) {
        content += lines[index];
        index += 1;
      }
      startCurrent("table", content);
      continue;
    }

    if (startsImage(line)) {
      finishCurrent();
      startCurrent("image", line);
      index += 1;
      continue;
    }

    if (current && current.type !== "paragraph" && current.type !== "image") {
      finishCurrent();
    }
    if (!current) startCurrent("paragraph", line);
    else current.markdown += line;
    index += 1;
  }

  if (pending) {
    if (current) current.markdown += pending;
    else startCurrent("paragraph", "");
  }
  finishCurrent();
  return blocks;
}

export function buildDocumentIndex(markdown) {
  if (typeof markdown !== "string") {
    throw new TypeError("paper Markdown must be a string");
  }
  if (!markdown.trim()) {
    throw new TypeError("paper Markdown must not be empty");
  }

  const byteLength = Buffer.byteLength(markdown, "utf8");
  if (byteLength > DOCUMENT_INDEX_MAX_BYTES) {
    throw new RangeError(
      `paper Markdown exceeds ${DOCUMENT_INDEX_MAX_BYTES} UTF-8 bytes`,
    );
  }

  const rawBlocks = rawBlocksFromMarkdown(markdown);
  const rootSection = {
    section_id: "section-root",
    parent_section_id: null,
    path: [],
    ordinal: 0,
    level: 0,
    title: null,
  };
  const sections = [rootSection];
  const blocks = [];
  const sectionStack = [];
  const sectionOccurrences = new Map();
  const blockOccurrences = new Map();
  let currentSection = rootSection;
  let firstHeadingTitle = "";
  let title = "";

  for (const rawBlock of rawBlocks) {
    if (rawBlock.heading) {
      const { level, title: headingTitle } = rawBlock.heading;
      if (!firstHeadingTitle) firstHeadingTitle = headingTitle;
      if (!title && level === 1) title = headingTitle;

      while (sectionStack.length && sectionStack.at(-1).level >= level) {
        sectionStack.pop();
      }
      const parent = sectionStack.at(-1) ?? rootSection;
      const occurrenceKey = `${parent.section_id}\0${level}\0${headingTitle}`;
      const occurrence = (sectionOccurrences.get(occurrenceKey) ?? 0) + 1;
      sectionOccurrences.set(occurrenceKey, occurrence);

      currentSection = {
        section_id: `section-${digest(`${occurrenceKey}\0${occurrence}`)}`,
        parent_section_id: parent.section_id,
        path: [...parent.path, headingTitle],
        ordinal: sections.length,
        level,
        title: headingTitle,
      };
      sections.push(currentSection);
      sectionStack.push(currentSection);
    }

    const kind = blockKind(rawBlock);
    const occurrenceKey = `${currentSection.section_id}\0${kind}\0${rawBlock.markdown}`;
    const occurrence = (blockOccurrences.get(occurrenceKey) ?? 0) + 1;
    blockOccurrences.set(occurrenceKey, occurrence);

    blocks.push({
      block_id: `block-${digest(`${occurrenceKey}\0${occurrence}`)}`,
      section_id: currentSection.section_id,
      path: [...currentSection.path],
      ordinal: blocks.length + 1,
      kind,
      text: blockText(rawBlock, kind),
      markdown: rawBlock.markdown,
    });
  }

  return {
    title: title || firstHeadingTitle,
    sections,
    blocks,
  };
}
