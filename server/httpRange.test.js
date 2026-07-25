import assert from "node:assert/strict";
import test from "node:test";
import { HttpRangeError, parseByteRange } from "./httpRange.js";

test("parses closed, open, suffix, and clamped byte ranges", () => {
  assert.deepEqual(parseByteRange("bytes=0-0", 100), { start: 0, end: 0 });
  assert.deepEqual(parseByteRange("bytes=10-", 100), { start: 10, end: 99 });
  assert.deepEqual(parseByteRange("bytes=-10", 100), { start: 90, end: 99 });
  assert.deepEqual(parseByteRange("bytes=-200", 100), { start: 0, end: 99 });
  assert.deepEqual(parseByteRange("bytes=90-200", 100), { start: 90, end: 99 });
  assert.equal(parseByteRange(undefined, 100), null);
});

test("rejects malformed, multi, and unsatisfiable ranges", () => {
  for (const value of [
    "items=0-1",
    "bytes=-",
    "bytes=0-1,3-4",
    "bytes=100-",
    "bytes=10-9",
    "bytes=-0",
    "bytes= 0-1",
  ]) {
    assert.throws(
      () => parseByteRange(value, 100),
      (error) => error instanceof HttpRangeError,
    );
  }
});
