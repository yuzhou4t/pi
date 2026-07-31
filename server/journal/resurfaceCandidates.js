const RESURFACE_LABEL = "往期未读回补 · 非本月新论文";

function decisionOf(run, paperId) {
  const decisions = run?.paper_decisions;
  if (!decisions || typeof decisions !== "object") return null;
  const value = decisions[paperId];
  return typeof value === "string" ? value : null;
}

function identityKeys(paper) {
  const keys = [];
  if (typeof paper?.paper_id === "string" && paper.paper_id) keys.push(`id:${paper.paper_id}`);
  if (typeof paper?.dedupe_key === "string" && paper.dedupe_key) keys.push(`key:${paper.dedupe_key}`);
  return keys;
}

export { RESURFACE_LABEL };

/**
 * 从往期 Run 里挑出「用户没有处理过、但当时进入过推荐」的论文，
 * 作为本月候选的回补。只做确定性筛选，不调用模型。
 */
export function selectResurfaceCandidates({
  previousRuns = [],
  currentCandidates = [],
  currentRunId = null,
  limit = 5,
  observedAt = null,
  dismissedKeys = [],
} = {}) {
  if (!Array.isArray(previousRuns) || previousRuns.length === 0) return [];
  if (!Number.isInteger(limit) || limit < 1) return [];
  const seen = new Set(
    currentCandidates.flatMap((paper) => identityKeys(paper)),
  );
  // 用户标记过「不感兴趣」的论文不再回补。
  for (const key of dismissedKeys) {
    if (typeof key === "string" && key) seen.add(`key:${key}`);
  }
  const ordered = previousRuns
    .filter((run) => run && run.run_id !== currentRunId)
    .slice()
    .sort((left, right) => String(right.created_at ?? "").localeCompare(String(left.created_at ?? "")));
  const picked = [];
  for (const run of ordered) {
    const candidates = Array.isArray(run.candidates) ? run.candidates : [];
    const byRank = candidates
      .slice()
      .sort((left, right) => (Number(left.rank) || 99) - (Number(right.rank) || 99));
    for (const paper of byRank) {
      if (picked.length >= limit) return picked;
      // 经典回顾有自己的补位机制，不参与回补；已回补过的也不再套娃。
      if (paper.candidate_origin === "classic_review") continue;
      if (paper.candidate_origin === "resurfaced_unread") continue;
      const decision = decisionOf(run, paper.paper_id);
      if (decision === "read" || decision === "collect") continue;
      const keys = identityKeys(paper);
      if (keys.length === 0 || keys.some((key) => seen.has(key))) continue;
      keys.forEach((key) => seen.add(key));
      picked.push({
        ...paper,
        candidate_origin: "resurfaced_unread",
        is_new: false,
        published_this_month: false,
        display_label: RESURFACE_LABEL,
        resurfaced_from_run_id: run.run_id ?? null,
        observed_at: observedAt ?? paper.observed_at ?? null,
      });
    }
  }
  return picked;
}
