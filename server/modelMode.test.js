import assert from "node:assert/strict";
import test from "node:test";
import { resolveModelMode } from "./modelMode.js";

test("model mode fails closed to live unless fixtures are explicitly requested", () => {
  assert.equal(resolveModelMode({}), "live");
  assert.equal(resolveModelMode({ PI_MODEL_MODE: "live" }), "live");
  assert.equal(resolveModelMode({ PI_MODEL_MODE: "unknown" }), "live");
  assert.equal(resolveModelMode({ PI_MODEL_MODE: "fixture" }), "fixture");
});
