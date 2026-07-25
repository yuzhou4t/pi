import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

const MAX_PROJECT_CONTEXT_CHARS = 12_000;
const MAX_PROJECT_STATE_BYTES = 256 * 1024;
const RELEVANT_HEADING = /当前目标|产品定位|首个闭环|成果与事实源|权限|精读体验|项目状态|当前状态|已确认决定|下一实现|下一步|开放问题|项目影响|阶段更新/i;

export class ProjectContextError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = "ProjectContextError";
    this.code = code;
    this.status = status;
    this.retryable = false;
  }
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function markdownSections(markdown) {
  const lines = markdown.split(/\r\n|\n|\r/);
  const sections = [];
  let current = [];
  for (const line of lines) {
    if (/^#{1,6}\s+\S/.test(line) && current.length > 0) {
      sections.push(current.join("\n").trim());
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) sections.push(current.join("\n").trim());
  return sections.filter(Boolean);
}

function headingText(section) {
  return section.split("\n", 1)[0].replace(/^#{1,6}\s+/, "").trim();
}

function cleanListItem(value) {
  return String(value ?? "")
    .replace(/^\[[ xX]\]\s*/, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
    .trim();
}

function sectionListItems(section) {
  return section
    .split("\n")
    .slice(1)
    .map((line) => line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.+)$/)?.[1])
    .filter(Boolean)
    .map(cleanListItem)
    .filter(Boolean);
}

function firstSectionParagraph(section) {
  return section
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .find((line) => line && !/^(?:[-*+]|\d+[.)])\s+/.test(line)) ?? "";
}

export function summarizeProjectState(markdown) {
  const sections = markdownSections(markdown);
  const title = headingText(sections[0] ?? "") || "项目状态";
  const byHeading = new Map(sections.map((section) => [headingText(section), section]));
  const goalSection = byHeading.get("当前目标");
  const decisionsSection = byHeading.get("已确认决定");
  const questionsSection = byHeading.get("开放问题");
  const nextSection = byHeading.get("下一步");
  const goal = goalSection ? firstSectionParagraph(goalSection) : "";
  const decisions = decisionsSection ? sectionListItems(decisionsSection).slice(0, 8) : [];
  const openQuestions = questionsSection ? sectionListItems(questionsSection).slice(0, 8) : [];
  const nextActions = nextSection ? sectionListItems(nextSection).slice(0, 4) : [];
  const missingSections = [
    ["当前目标", goal],
    ["已确认决定", decisions.length > 0],
    ["开放问题", openQuestions.length > 0],
    ["下一步", nextActions.length > 0],
  ].filter(([, present]) => !present).map(([heading]) => heading);
  return {
    title,
    goal,
    decisions,
    open_questions: openQuestions,
    next_action: nextActions[0] ?? "",
    next_actions: nextActions,
    missing_sections: missingSections,
  };
}

function boundedContext(markdown) {
  const sections = markdownSections(markdown);
  const relevant = sections.filter((section) => RELEVANT_HEADING.test(section.split("\n", 1)[0]));
  const candidates = relevant.length > 0 ? relevant : sections;
  const selected = [];
  let length = 0;
  for (const section of candidates) {
    const remaining = MAX_PROJECT_CONTEXT_CHARS - length;
    if (remaining <= 0) break;
    const content = section.slice(0, remaining);
    if (!content) continue;
    selected.push(content);
    length += content.length + 2;
  }
  const result = selected.join("\n\n").trim();
  if (!result) {
    throw new ProjectContextError("PROJECT_STATE_EMPTY", "项目状态 Markdown 为空");
  }
  return result;
}

export function createProjectContextReader({
  projectRoot = path.resolve("."),
  projectStatePath = "project_state.md",
} = {}) {
  const configuredRoot = path.resolve(projectRoot);
  const configuredState = path.resolve(
    configuredRoot,
    projectStatePath || "project_state.md",
  );

  async function read() {
    let root;
    let target;
    let stat;
    try {
      [root, target, stat] = await Promise.all([
        realpath(configuredRoot),
        realpath(configuredState),
        lstat(configuredState),
      ]);
    } catch {
      throw new ProjectContextError(
        "PROJECT_STATE_NOT_CONFIGURED",
        "尚未配置可读取的项目状态 Markdown",
      );
    }
    const relative = path.relative(root, target);
    if (
      !relative
      || relative.startsWith("..")
      || path.isAbsolute(relative)
      || !stat.isFile()
      || path.extname(target).toLowerCase() !== ".md"
      || stat.size > MAX_PROJECT_STATE_BYTES
    ) {
      throw new ProjectContextError(
        "PROJECT_STATE_OUT_OF_SCOPE",
        "项目状态文件必须是项目目录内的 Markdown 文件",
      );
    }
    const markdown = await readFile(target, "utf8");
    return {
      source_path: relative.split(path.sep).join("/"),
      revision: sha256(markdown),
      byte_length: Buffer.byteLength(markdown, "utf8"),
      content: boundedContext(markdown),
      state: summarizeProjectState(markdown),
    };
  }

  return Object.freeze({
    read,
  });
}
