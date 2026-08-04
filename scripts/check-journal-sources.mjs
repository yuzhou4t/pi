import { fetchRegisteredSource } from "../server/journal/sourceDispatcher.js";
import { SOURCE_REGISTRY } from "../server/journal/sourceRegistry.js";

const results = [];

for (const source of SOURCE_REGISTRY) {
  const startedAt = Date.now();
  try {
    const fetched = await fetchRegisteredSource(source);
    results.push({
      id: source.source_id,
      name: source.short_name,
      status: fetched.dispatch?.status ?? "primary",
      route: fetched.dispatch?.selected_route ?? "primary",
      papers: fetched.papers.length,
      milliseconds: Date.now() - startedAt,
      primary: fetched.dispatch?.attempts?.find((attempt) => attempt.role === "primary")?.error?.code
        ?? "ok",
    });
  } catch (error) {
    const attempts = Array.isArray(error?.attempts)
      ? error.attempts.map((attempt) => (
          `${attempt.role}:${attempt.error?.code ?? attempt.status}`
        )).join(", ")
      : "";
    results.push({
      id: source.source_id,
      name: source.short_name,
      status: "failed",
      route: "-",
      papers: 0,
      milliseconds: Date.now() - startedAt,
      primary: attempts || error?.code || error?.message || "SOURCE_CHECK_FAILED",
    });
  }
}

console.table(results);
const failed = results.filter((result) => result.status === "failed");
if (failed.length > 0) {
  process.exitCode = 1;
} else {
  const degraded = results.filter((result) => result.status === "degraded").length;
  console.log(`来源检查通过：${results.length}/${results.length} 可查询，${degraded} 个使用备用路线。`);
}
