import { createHash } from "node:crypto";

export const WORKFLOW_START = "<!-- pi-agent:workflow:start -->";
export const WORKFLOW_END = "<!-- pi-agent:workflow:end -->";
export const AGENT_NOTES_START = "<!-- pi-agent:agent-notes:start -->";
export const AGENT_NOTES_END = "<!-- pi-agent:agent-notes:end -->";

function sha256(value) {
  return `sha256:${createHash("sha256").update(String(value)).digest("hex")}`;
}

function compactLine(value, fallback = "") {
  const normalized = String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replaceAll(/\s+/g, " ");
  return normalized || fallback;
}

function filenamePart(value, fallback, maxLength) {
  const normalized = compactLine(value)
    .replaceAll(/[\/\\:*?"<>|\u0000-\u001f\u007f]+/g, "-")
    .replaceAll(/[^\p{L}\p{N}]+/gu, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replaceAll(/-+$/g, "");
  return normalized || fallback;
}

function publicationYear(publishedAt) {
  const match = compactLine(publishedAt).match(/(?:^|\D)((?:19|20)\d{2})(?:\D|$)/);
  return match?.[1] ?? "UnknownYear";
}

function paperIdentity(paper) {
  return compactLine(
    paper?.dedupe_key
      ?? (paper?.doi ? `doi:${String(paper.doi).toLowerCase()}` : null)
      ?? paper?.official_id
      ?? paper?.paper_id,
  );
}

export function paperIdentityHash(paper) {
  return sha256(paperIdentity(paper));
}

export function paperIdentityMarker(paper) {
  return `<!-- pi-agent:paper-note:v1:${paperIdentityHash(paper)} -->`;
}

export function noteFileName(paper) {
  const year = publicationYear(paper?.published_at);
  const firstAuthor = filenamePart(paper?.authors?.[0], "UnknownAuthor", 48);
  const title = filenamePart(paper?.title, "Untitled", 80);
  const identity8 = paperIdentityHash(paper).slice(7, 15);
  return `${year}-${firstAuthor}-${title}--${identity8}.md`;
}

function controlLines(markdown) {
  return String(markdown ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("<!-- pi-agent:"));
}

function validAgentActionControls(lines) {
  const seen = new Set();
  let activeId = null;
  for (const line of lines) {
    const match = line.match(
      /^<!-- pi-agent:agent-action:([A-Za-z0-9][A-Za-z0-9._-]{0,159}):(start|end) -->$/,
    );
    if (!match) return false;
    const [, id, boundary] = match;
    if (boundary === "start") {
      if (activeId !== null || seen.has(id)) return false;
      activeId = id;
      seen.add(id);
    } else {
      if (activeId !== id) return false;
      activeId = null;
    }
  }
  return activeId === null;
}

function normalizedRegion(value) {
  return String(value ?? "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .trim();
}

export function renderManagedNote({
  paper,
  workflowMarkdown,
  agentMarkdown = "",
}) {
  const workflow = normalizedRegion(workflowMarkdown);
  const agent = normalizedRegion(agentMarkdown) || "## Agent 补充笔记\n\n- 暂无";
  if (
    !workflow
    || controlLines(workflow).length > 0
    || !validAgentActionControls(controlLines(agent))
  ) {
    throw new Error("OBSIDIAN_MANAGED_NOTE_CONTENT_INVALID");
  }
  return [
    paperIdentityMarker(paper),
    "",
    WORKFLOW_START,
    workflow,
    WORKFLOW_END,
    "",
    AGENT_NOTES_START,
    agent,
    AGENT_NOTES_END,
    "",
  ].join("\n");
}

function exactCount(markdown, marker) {
  return markdown.split(marker).length - 1;
}

function extractRegion(markdown, startMarker, endMarker) {
  const start = markdown.indexOf(startMarker) + startMarker.length;
  const end = markdown.indexOf(endMarker, start);
  return markdown.slice(start, end).replace(/^\n/, "").replace(/\n$/, "");
}

export function parseManagedNote(value, paper) {
  const markdown = String(value ?? "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n");
  const identityMatches = [...markdown.matchAll(
    /<!-- pi-agent:paper-note:v1:(sha256:[a-f0-9]{64}) -->/g,
  )];
  if (identityMatches.length === 0) {
    return {
      status: controlLines(markdown).length > 0 ? "malformed" : "unmanaged",
      identity_hash: null,
      workflow_markdown: null,
      agent_markdown: null,
    };
  }
  const identityHash = identityMatches[0][1];
  if (identityMatches.length !== 1) {
    return {
      status: "malformed",
      identity_hash: identityHash,
      workflow_markdown: null,
      agent_markdown: null,
    };
  }
  if (identityHash !== paperIdentityHash(paper)) {
    return {
      status: "identity_mismatch",
      identity_hash: identityHash,
      workflow_markdown: null,
      agent_markdown: null,
    };
  }
  const markers = [
    paperIdentityMarker(paper),
    WORKFLOW_START,
    WORKFLOW_END,
    AGENT_NOTES_START,
    AGENT_NOTES_END,
  ];
  if (markers.some((marker) => exactCount(markdown, marker) !== 1)) {
    return {
      status: "malformed",
      identity_hash: identityHash,
      workflow_markdown: null,
      agent_markdown: null,
    };
  }
  const positions = markers.map((marker) => markdown.indexOf(marker));
  if (positions.some((position, index) => index > 0 && position <= positions[index - 1])) {
    return {
      status: "malformed",
      identity_hash: identityHash,
      workflow_markdown: null,
      agent_markdown: null,
    };
  }
  const before = markdown.slice(0, positions[0]).trim();
  const betweenIdentityAndWorkflow = markdown
    .slice(positions[0] + markers[0].length, positions[1])
    .trim();
  const betweenWorkflowAndAgent = markdown
    .slice(positions[2] + WORKFLOW_END.length, positions[3])
    .trim();
  const after = markdown.slice(positions[4] + AGENT_NOTES_END.length).trim();
  const knownControls = new Set(markers);
  const agentMarkdown = extractRegion(markdown, AGENT_NOTES_START, AGENT_NOTES_END);
  const extraControls = controlLines(markdown)
    .filter((line) => !knownControls.has(line));
  if (
    before
    || betweenIdentityAndWorkflow
    || betweenWorkflowAndAgent
    || after
    || !validAgentActionControls(extraControls)
    || controlLines(extractRegion(markdown, WORKFLOW_START, WORKFLOW_END)).length > 0
    || controlLines(agentMarkdown).some((line) => (
      !/^<!-- pi-agent:agent-action:[A-Za-z0-9][A-Za-z0-9._-]{0,159}:(start|end) -->$/.test(line)
    ))
  ) {
    return {
      status: "malformed",
      identity_hash: identityHash,
      workflow_markdown: null,
      agent_markdown: null,
    };
  }
  return {
    status: "managed",
    identity_hash: identityHash,
    workflow_markdown: extractRegion(markdown, WORKFLOW_START, WORKFLOW_END),
    agent_markdown: agentMarkdown,
  };
}
