const PUBLIC_TEXT_PHASES = new Set(["commentary", "final_answer"]);

function parsedObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  if (typeof value !== "string" || !value.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export function publicTextPhase(block) {
  if (!block || block.type !== "text") return null;
  const signature = parsedObject(block.textSignature);
  return PUBLIC_TEXT_PHASES.has(signature?.phase)
    ? signature.phase
    : null;
}

function joinedText(values) {
  return values
    .filter((value) => typeof value === "string" && value.length > 0)
    .join("")
    .trim();
}

export function publicCommentaryText(message) {
  return joinedText(
    (Array.isArray(message?.content) ? message.content : [])
      .filter((block) => publicTextPhase(block) === "commentary")
      .map((block) => block.text),
  );
}

export function publicFinalAnswerText(message) {
  if (typeof message?.content === "string") return message.content;
  const blocks = (Array.isArray(message?.content) ? message.content : [])
    .filter((block) => block?.type === "text");
  const finalBlocks = blocks.filter(
    (block) => publicTextPhase(block) === "final_answer",
  );
  if (finalBlocks.length > 0) {
    return joinedText(finalBlocks.map((block) => block.text));
  }
  return joinedText(
    blocks
      .filter((block) => publicTextPhase(block) !== "commentary")
      .map((block) => block.text),
  );
}

function signedReasoningSummary(block) {
  const signature = parsedObject(block?.thinkingSignature);
  if (signature?.type !== "reasoning" || !Array.isArray(signature.summary)) {
    return "";
  }
  return signature.summary
    .map((item) => (
      item && typeof item === "object" && typeof item.text === "string"
        ? item.text
        : ""
    ))
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

export function publicReasoningSummary(block) {
  if (!block || block.type !== "thinking" || block.redacted === true) {
    return "";
  }
  const signedSummary = signedReasoningSummary(block);
  if (signedSummary) return signedSummary;
  if (block.public === true || block.visibility === "public") {
    return typeof block.thinking === "string" ? block.thinking.trim() : "";
  }
  return "";
}
