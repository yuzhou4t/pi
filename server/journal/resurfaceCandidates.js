const RESURFACE_LABEL = "近半年优质未读 · 再次推荐";
const MAX_RESURFACE_COUNT = 3;
const RECENT_WINDOW_MS = 180 * 24 * 60 * 60 * 1000;

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

function recentEnough(paper, observedAt) {
  const observed = Date.parse(observedAt);
  if (!Number.isFinite(observed)) return true;
  const evidenceAt = paper?.publication_date_precision === "day"
    ? paper?.published_at
    : paper?.first_seen_at ?? paper?.observed_at ?? paper?.published_at;
  const evidence = Date.parse(evidenceAt);
  const age = observed - evidence;
  return Number.isFinite(age) && age >= 0 && age <= RECENT_WINDOW_MS;
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
      // 经典回顾有自己的补位机制；近期未读论文最多回补三次。
      if (paper.candidate_origin === "classic_review") continue;
      const resurfaceCount = Number.isInteger(paper.resurface_count)
        ? paper.resurface_count
        : paper.candidate_origin === "resurfaced_unread" ? 1 : 0;
      if (resurfaceCount >= MAX_RESURFACE_COUNT || !recentEnough(paper, observedAt)) continue;
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
        recent_pool_eligible: true,
        resurface_count: resurfaceCount + 1,
        resurfaced_from_run_id: run.run_id ?? null,
        observed_at: observedAt ?? paper.observed_at ?? null,
      });
    }
  }
  return picked;
}
