import assert from "node:assert/strict";
import test from "node:test";
import {
  SOURCE_REGISTRY,
  getSourceById,
  validateSourceRegistry,
} from "./sourceRegistry.js";

test("registry contains the four journals and seven conferences exactly once", () => {
  assert.equal(SOURCE_REGISTRY.length, 11);
  assert.equal(new Set(SOURCE_REGISTRY.map((source) => source.source_id)).size, 11);
  assert.equal(SOURCE_REGISTRY.filter((source) => source.source_type === "journal").length, 4);
  assert.equal(SOURCE_REGISTRY.filter((source) => source.source_type === "conference").length, 7);
  assert.deepEqual(validateSourceRegistry(), { valid: true, errors: [] });
});

test("every source has primary, fallback, adapter, and a DBLP path", () => {
  for (const source of SOURCE_REGISTRY) {
    assert.match(source.primary.url, /^https:\/\//);
    assert.match(source.fallback.url, /^https:\/\//);
    assert.ok(source.primary.kind);
    assert.ok(source.fallback.kind);
    assert.ok(source.adapter);
    assert.match(source.dblp_path, /^(?:journals|conf)\//);
    assert.equal(source.id, source.source_id);
    assert.equal(source.name, source.venue);
    assert.equal(source.type, source.source_type);
  }
  assert.equal(
    SOURCE_REGISTRY.filter((source) => source.fallback.kind === "crossref-api").length,
    3,
  );
  assert.equal(
    SOURCE_REGISTRY.filter((source) => source.fallback.kind === "dblp-index").length,
    8,
  );
});

test("source lookup is explicit and unknown ids do not silently fall back", () => {
  assert.equal(getSourceById("conference-iclr")?.short_name, "ICLR");
  assert.equal(getSourceById("missing"), null);
});
