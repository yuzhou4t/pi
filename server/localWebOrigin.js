const defaultLocalWebOrigins = [
  "http://127.0.0.1:4173",
  "http://localhost:4173",
];

export function normalizeConfiguredLocalWebOrigin(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:") return null;
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== "/") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function createAllowedLocalWebOrigins(configuredUrl) {
  const origins = new Set(defaultLocalWebOrigins);
  const configuredOrigin = normalizeConfiguredLocalWebOrigin(configuredUrl);
  if (configuredOrigin) origins.add(configuredOrigin);
  return origins;
}
