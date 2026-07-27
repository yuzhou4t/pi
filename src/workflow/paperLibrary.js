const DEFAULT_PROJECT_ID = "pi-agent-product";

function timestamp(value) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function readingProgress(reading) {
  const readyStages = Object.values(reading?.stages ?? {})
    .filter((stage) => stage?.status === "ready").length;
  const turnCount = reading?.chat?.turns?.length ?? 0;
  return (
    (reading?.status === "complete" ? 100 : 0)
    + readyStages * 10
    + turnCount * 2
    + (reading?.position?.blockId ? 1 : 0)
  );
}

function isArchived(run, paperId) {
  return (run?.obsidian?.proposals ?? []).some(
    (proposal) => proposal?.paperId === paperId && proposal?.status === "committed",
  );
}

function resumeRank(occurrence) {
  return (
    (occurrence.archived ? 1_000 : 0)
    + readingProgress(occurrence.reading)
  );
}

function compareResumeTarget(left, right) {
  return (
    resumeRank(right) - resumeRank(left)
    || timestamp(right.reading?.updatedAt) - timestamp(left.reading?.updatedAt)
    || timestamp(right.run.updatedAt) - timestamp(left.run.updatedAt)
    || timestamp(left.run.createdAt) - timestamp(right.run.createdAt)
    || left.run.id.localeCompare(right.run.id)
  );
}

function statusLabel(entry) {
  if (entry.archived) return "已归档";
  if (entry.reading?.status === "complete") return "研读完成";
  if (entry.reading?.status === "failed") return "需要继续";
  if (
    entry.reading?.status === "reading"
    || entry.reading?.position?.blockId
    || (entry.reading?.chat?.turns?.length ?? 0) > 0
  ) {
    return "研读中";
  }
  return "待开始";
}

export function buildPaperReadingLibrary(
  runs,
  { projectId = DEFAULT_PROJECT_ID } = {},
) {
  const byPaperId = new Map();
  for (const run of Array.isArray(runs) ? runs : []) {
    if (!run?.id || (run.projectId ?? DEFAULT_PROJECT_ID) !== projectId) continue;
    for (const [paperId, decision] of Object.entries(run.paperDecisions ?? {})) {
      if (decision !== "read") continue;
      const paper = (run.candidates ?? []).find((candidate) => candidate?.id === paperId);
      if (!paper) continue;
      const occurrence = {
        run,
        paper,
        reading: run.readings?.papers?.[paperId] ?? null,
        archived: isArchived(run, paperId),
      };
      const group = byPaperId.get(paperId) ?? [];
      group.push(occurrence);
      byPaperId.set(paperId, group);
    }
  }

  return [...byPaperId.entries()].map(([paperId, occurrences]) => {
    const sorted = [...occurrences].sort(compareResumeTarget);
    const resume = sorted[0];
    const sourceRuns = [...occurrences]
      .sort((left, right) => (
        timestamp(right.run.createdAt) - timestamp(left.run.createdAt)
        || right.run.id.localeCompare(left.run.id)
      ))
      .map(({ run }) => ({
        runId: run.id,
        createdAt: run.createdAt ?? null,
        updatedAt: run.updatedAt ?? null,
      }));
    const updatedAt = occurrences
      .flatMap(({ run, reading }) => [reading?.updatedAt, run.updatedAt])
      .sort((left, right) => timestamp(right) - timestamp(left))[0] ?? null;
    const entry = {
      id: `paper:${paperId}`,
      paperId,
      projectId,
      runId: resume.run.id,
      paper: resume.paper,
      reading: resume.reading,
      position: resume.reading?.position ?? null,
      activeConversationId: resume.reading?.activeConversationId
        ?? resume.reading?.chat?.id
        ?? "current",
      archived: occurrences.some((occurrence) => occurrence.archived),
      sourceRuns,
      updatedAt,
    };
    return {
      ...entry,
      statusLabel: statusLabel(entry),
    };
  }).sort((left, right) => (
    timestamp(right.updatedAt) - timestamp(left.updatedAt)
    || left.paper.title.localeCompare(right.paper.title, "zh-CN")
    || left.paperId.localeCompare(right.paperId)
  ));
}
