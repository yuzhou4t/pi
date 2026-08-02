function nonNegativeNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return null;
}

function tokenCount(...values) {
  const number = nonNegativeNumber(...values);
  return number === null ? null : Math.floor(number);
}

export function normalizeTurnUsage(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const inputTokens = tokenCount(raw.input, raw.input_tokens, raw.inputTokens);
  const outputTokens = tokenCount(raw.output, raw.output_tokens, raw.outputTokens);
  const cacheReadTokens = tokenCount(
    raw.cacheRead,
    raw.cache_read,
    raw.cache_read_tokens,
    raw.cacheReadTokens,
  );
  const cacheWriteTokens = tokenCount(
    raw.cacheWrite,
    raw.cache_write,
    raw.cache_write_tokens,
    raw.cacheWriteTokens,
  );
  const computedTotal = [
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  ].every((value) => value === null)
    ? null
    : [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens]
        .reduce((sum, value) => sum + (value ?? 0), 0);
  const totalTokens = tokenCount(
    raw.totalTokens,
    raw.total_tokens,
    computedTotal,
  );
  const costUsd = nonNegativeNumber(
    raw.cost?.total,
    raw.cost_total,
    raw.costTotal,
    raw.costUsd,
    typeof raw.cost === "number" ? raw.cost : null,
  );
  if (totalTokens === null && costUsd === null) return null;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    costUsd,
  };
}
