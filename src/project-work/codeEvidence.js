const CODE_EVIDENCE_FRAGMENT = "#pi-code-evidence?";

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizedEvidence(items) {
  if (!Array.isArray(items)) return [];
  return items.filter((item) => (
    item
    && typeof item.path === "string"
    && item.path
    && typeof item.contentHash === "string"
    && item.contentHash
    && Number.isSafeInteger(item.startLine)
    && item.startLine > 0
    && Number.isSafeInteger(item.endLine)
    && item.endLine >= item.startLine
  ));
}

export function codeEvidenceHref(evidence, startLine, endLine = startLine) {
  const query = new URLSearchParams({
    path: evidence.path,
    hash: evidence.contentHash,
    line: String(startLine),
    end: String(endLine),
  });
  return `${CODE_EVIDENCE_FRAGMENT}${query.toString()}`;
}

export function parseCodeEvidenceHref(href) {
  if (typeof href !== "string" || !href.startsWith(CODE_EVIDENCE_FRAGMENT)) {
    return null;
  }
  const query = new URLSearchParams(href.slice(CODE_EVIDENCE_FRAGMENT.length));
  const path = query.get("path") ?? "";
  const contentHash = query.get("hash") ?? "";
  const startLine = Number(query.get("line"));
  const endLine = Number(query.get("end"));
  if (
    !path
    || !contentHash
    || !Number.isSafeInteger(startLine)
    || startLine < 1
    || !Number.isSafeInteger(endLine)
    || endLine < startLine
  ) {
    return null;
  }
  return {
    path,
    contentHash,
    startLine,
    endLine,
  };
}

function evidenceForReference(items, path, startLine, endLine) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (
      item.path === path
      && startLine >= item.startLine
      && endLine <= item.endLine
    ) {
      return item;
    }
  }
  return null;
}

function referenceExpression(evidence, { exact = false } = {}) {
  const paths = [...new Set(evidence.map((item) => item.path))]
    .sort((left, right) => right.length - left.length);
  if (paths.length === 0) return null;
  const reference = `(${paths.map(escapeRegExp).join("|")}):(\\d+)(?:-(\\d+))?`;
  return exact
    ? new RegExp(`^${reference}$`, "u")
    : new RegExp(`(^|[\\s(（\\[{'"])${reference}`, "gu");
}

function linkedTextNodes(value, evidence) {
  const expression = referenceExpression(evidence);
  if (!expression) return null;
  const nodes = [];
  let cursor = 0;
  let changed = false;
  for (const match of value.matchAll(expression)) {
    const boundary = match[1] ?? "";
    const path = match[2];
    const startLine = Number(match[3]);
    const endLine = Number(match[4] ?? match[3]);
    const binding = evidenceForReference(
      evidence,
      path,
      startLine,
      endLine,
    );
    if (!binding) continue;
    const referenceStart = match.index + boundary.length;
    if (referenceStart > cursor) {
      nodes.push({ type: "text", value: value.slice(cursor, referenceStart) });
    }
    const label = value.slice(referenceStart, match.index + match[0].length);
    nodes.push({
      type: "link",
      url: codeEvidenceHref(binding, startLine, endLine),
      title: `打开 ${path} 第 ${startLine}${endLine === startLine ? "" : `-${endLine}`} 行`,
      children: [{ type: "text", value: label }],
    });
    cursor = match.index + match[0].length;
    changed = true;
  }
  if (!changed) return null;
  if (cursor < value.length) {
    nodes.push({ type: "text", value: value.slice(cursor) });
  }
  return nodes;
}

function linkedInlineCode(node, evidence) {
  const expression = referenceExpression(evidence, { exact: true });
  const match = expression?.exec(node.value);
  if (!match) return null;
  const path = match[1];
  const startLine = Number(match[2]);
  const endLine = Number(match[3] ?? match[2]);
  const binding = evidenceForReference(
    evidence,
    path,
    startLine,
    endLine,
  );
  if (!binding) return null;
  return {
    type: "link",
    url: codeEvidenceHref(binding, startLine, endLine),
    title: `打开 ${path} 第 ${startLine}${endLine === startLine ? "" : `-${endLine}`} 行`,
    children: [node],
  };
}

function visitText(parent, evidence, blocked = false) {
  if (!parent || !Array.isArray(parent.children)) return;
  for (let index = 0; index < parent.children.length; index += 1) {
    const child = parent.children[index];
    if (child?.type === "inlineCode" && !blocked) {
      const replacement = linkedInlineCode(child, evidence);
      if (replacement) {
        parent.children.splice(index, 1, replacement);
      }
      continue;
    }
    const childBlocked = blocked || [
      "code",
      "link",
      "linkReference",
    ].includes(child?.type);
    if (child?.type === "text" && !childBlocked) {
      const replacement = linkedTextNodes(child.value, evidence);
      if (replacement) {
        parent.children.splice(index, 1, ...replacement);
        index += replacement.length - 1;
      }
      continue;
    }
    visitText(child, evidence, childBlocked);
  }
}

export function remarkCodeEvidence({ evidence } = {}) {
  const safeEvidence = normalizedEvidence(evidence);
  return (tree) => visitText(tree, safeEvidence);
}
