export function resolveModelMode(env = {}) {
  return env.PI_MODEL_MODE === "fixture" ? "fixture" : "live";
}
