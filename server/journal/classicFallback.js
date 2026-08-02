import { CLASSIC_PAPERS, CLASSIC_REVIEW_LABEL } from "./classics.js";

function copyClassic(paper, observedAt) {
  return {
    ...paper,
    authors: [...paper.authors],
    topic_matches: [...paper.topic_matches],
    observed_at: observedAt,
    candidate_origin: "classic_review",
    is_new: false,
    display_label: CLASSIC_REVIEW_LABEL,
  };
}

export function buildCandidateBatch({
  newCandidates = [],
  observedAt = null,
  classicPool = CLASSIC_PAPERS,
  limit = 5,
} = {}) {
  if (!Array.isArray(newCandidates) || !Array.isArray(classicPool)) {
    throw new TypeError("候选和经典论文池必须是数组");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 5) {
    throw new RangeError("经典回顾数量必须在 1 到 5 之间");
  }

  if (newCandidates.length >= limit) {
    return {
      mode: "new_papers",
      fallback_reason: null,
      display_label: null,
      candidates: newCandidates.map((paper) => ({ ...paper })),
    };
  }

  const classicCount = limit - newCandidates.length;
  if (classicPool.length < classicCount) {
    throw new RangeError(`经典论文池不足 ${classicCount} 篇`);
  }

  const classics = classicPool
    .filter((classic) => !newCandidates.some((paper) => paper.paper_id === classic.paper_id))
    .slice(0, classicCount)
    .map((paper) => copyClassic(paper, observedAt));
  if (classics.length < classicCount) {
    throw new RangeError(`经典论文池不足 ${classicCount} 篇`);
  }

  return {
    mode: newCandidates.length === 0 ? "classic_review" : "mixed_review",
    fallback_reason: newCandidates.length === 0 ? "no_new_papers" : "insufficient_new_papers",
    display_label: newCandidates.length === 0 ? CLASSIC_REVIEW_LABEL : null,
    candidates: [
      ...newCandidates.map((paper) => ({ ...paper })),
      ...classics,
    ],
  };
}
