import assert from "node:assert/strict";
import test from "node:test";
import {
  createAllowedLocalWebOrigins,
  normalizeConfiguredLocalWebOrigin,
} from "./localWebOrigin.js";

test("accepts only an exact loopback HTTP web URL", () => {
  assert.equal(
    normalizeConfiguredLocalWebOrigin("http://127.0.0.1:4317/"),
    "http://127.0.0.1:4317",
  );
  assert.equal(
    normalizeConfiguredLocalWebOrigin("http://localhost:4317/"),
    "http://localhost:4317",
  );
  for (const unsafe of [
    "https://127.0.0.1:4317/",
    "http://example.com:4317/",
    "http://127.0.0.1:4317/private",
    "http://user:secret@127.0.0.1:4317/",
    "http://127.0.0.1:4317/?redirect=https://example.com",
  ]) {
    assert.equal(normalizeConfiguredLocalWebOrigin(unsafe), null);
  }
});

test("adds a validated custom port without dropping the default origins", () => {
  const origins = createAllowedLocalWebOrigins("http://127.0.0.1:4317/");
  assert.equal(origins.has("http://127.0.0.1:4173"), true);
  assert.equal(origins.has("http://localhost:4173"), true);
  assert.equal(origins.has("http://127.0.0.1:4317"), true);
  assert.equal(origins.has("http://example.com:4317"), false);
});
