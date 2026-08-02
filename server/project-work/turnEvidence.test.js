import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTurnUsage } from "./turnEvidence.js";

test("normalizes Pi 0.82 usage and preserves explicit cost evidence", () => {
  assert.deepEqual(
    normalizeTurnUsage({
      input: 1_200,
      output: 300,
      cacheRead: 400,
      cacheWrite: 50,
      totalTokens: 1_950,
      cost: { total: 0.0123 },
    }),
    {
      inputTokens: 1_200,
      outputTokens: 300,
      cacheReadTokens: 400,
      cacheWriteTokens: 50,
      totalTokens: 1_950,
      costUsd: 0.0123,
    },
  );
});

test("accepts provider-style usage but never invents absent cost", () => {
  assert.deepEqual(
    normalizeTurnUsage({
      input_tokens: 10,
      output_tokens: 5,
    }),
    {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      totalTokens: 15,
      costUsd: null,
    },
  );
  assert.equal(normalizeTurnUsage({}), null);
  assert.equal(normalizeTurnUsage(null), null);
  assert.equal(
    normalizeTurnUsage({ totalTokens: 15, costUsd: 0.004 }).costUsd,
    0.004,
  );
});
