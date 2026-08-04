const MAX_EXPOSURES = 3;

function qualityScore(paper) {
  const rankScore = Number.isFinite(Number(paper?.rank))
    ? Math.max(0, 40 - Number(paper.rank) * 4)
    : 0;
  const topicScore = Math.min(paper?.topic_matches?.length ?? 0, 5) * 8;
  const evidenceScore = (paper?.abstract ? 12 : 0) + (paper?.pdf_url ? 18 : 0);
  const citationScore = Number.isFinite(paper?.cited_by_count)
    ? Math.min(8, Math.log10(Math.max(1, paper.cited_by_count)) * 3)
    : 0;
  const currentScore = paper?.published_this_month ? 18 : 0;
  return rankScore + topicScore + evidenceScore + citationScore + currentScore;
}

function byQuality(left, right) {
  return qualityScore(right) - qualityScore(left)
    || String(right.published_at ?? right.first_seen_at ?? "")
      .localeCompare(String(left.published_at ?? left.first_seen_at ?? ""))
    || String(left.paper_id).localeCompare(String(right.paper_id));
}

function addFrom(output, seen, papers, limit) {
  for (const paper of papers) {
    if (output.length >= limit) return;
    if (!paper?.paper_id || seen.has(paper.paper_id)) continue;
    seen.add(paper.paper_id);
    output.push(paper);
  }
}

function exposureCount(selections, paperId) {
  return selections.reduce(
    (count, selection) => count + (selection.paper_ids?.includes(paperId) ? 1 : 0),
    0,
  );
}

function appearedInLastTwo(selections, paperId) {
  const lastTwo = selections.slice(-2);
  return lastTwo.length === 2
    && lastTwo.every((selection) => selection.paper_ids?.includes(paperId));
}

export function buildWeeklyRecommendation({
  candidates = [],
  paperDecisions = {},
  previousSelections = [],
  weekKey,
  observedAt,
  limit = 5,
} = {}) {
  const history = previousSelections
    .filter((selection) => selection?.week_key && Array.isArray(selection.paper_ids))
    .filter((selection) => selection.week_key !== weekKey)
    .slice(-26);
  const eligible = candidates
    .filter((paper) => !["read", "collect"].includes(paperDecisions?.[paper.paper_id]))
    .filter((paper) => paper.candidate_origin === "classic_review" || paper.recent_pool_eligible !== false)
    .filter((paper) => exposureCount(history, paper.paper_id) < MAX_EXPOSURES)
    .filter((paper) => !appearedInLastTwo(history, paper.paper_id))
    .sort(byQuality);
  const recent = eligible.filter((paper) => paper.candidate_origin !== "classic_review");
  const currentCore = recent.filter((paper) => paper.published_this_month && paper.candidate_scope !== "field");
  const unreadCore = recent.filter((paper) => !paper.published_this_month && paper.candidate_scope !== "field");
  const field = recent.filter((paper) => paper.candidate_scope === "field");
  const classics = eligible.filter((paper) => paper.candidate_origin === "classic_review");
  const selected = [];
  const seen = new Set();
  addFrom(selected, seen, currentCore, Math.min(3, limit));
  addFrom(selected, seen, unreadCore, Math.min(selected.length + 1, limit));
  addFrom(selected, seen, field, Math.min(selected.length + 1, limit));
  addFrom(selected, seen, recent, limit);
  addFrom(selected, seen, classics, limit);
  const selection = {
    week_key: weekKey,
    observed_at: observedAt,
    paper_ids: selected.map((paper) => paper.paper_id),
  };
  return {
    schema_version: 1,
    week_key: weekKey,
    observed_at: observedAt,
    paper_ids: selection.paper_ids,
    selections: [...history, selection].slice(-26),
  };
}
