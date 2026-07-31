import {
  CheckCircle,
  CircleNotch,
  WarningCircle,
} from "@phosphor-icons/react";

function statusCopy(run) {
  if (run.status === "running") return "页面验收正在运行";
  if (run.status === "completed" && run.verdict === "passed") {
    return "页面验收通过";
  }
  if (run.status === "completed" && run.verdict === "issues") {
    return "页面证据已采集，发现需处理的问题";
  }
  if (run.status === "completed") return "页面证据采集已完成";
  return run.error?.message ?? "页面验收未完成";
}

function runClassName(run) {
  if (run.status === "failed") return "is-failed";
  if (run.status === "running") return "is-running";
  if (run.verdict === "passed") return "is-passed";
  if (run.verdict === "issues") return "is-issues";
  return "is-completed";
}

function issueSummary(capture) {
  const count = capture.accessibility?.issueCount ?? 0;
  return count === 0 ? "未发现基础可访问性问题" : `${count} 项基础可访问性问题`;
}

export function ProjectBrowserQaResults({
  conversationId,
  runs = [],
  screenshotUrl,
  running = false,
  error = null,
}) {
  if (runs.length === 0 && !running && !error) return null;
  return (
    <section className="project-browser-qa-results" aria-label="受控页面验收结果">
      <header>
        <div>
          <strong>受控页面验收</strong>
          <small>仅检查当前受管的本机页面；不交互、不下载，也不建立 WebSocket</small>
        </div>
        {running ? (
          <span>
            <CircleNotch className="spin" size={14} aria-hidden="true" />
            正在验收
          </span>
        ) : null}
      </header>
      {error ? (
        <p className="project-browser-qa-error" role="alert">
          <WarningCircle size={15} weight="fill" aria-hidden="true" />
          {error.message}
        </p>
      ) : null}
      {runs.map((run) => (
        <article
          className={runClassName(run)}
          data-verdict={run.verdict ?? undefined}
          key={run.id}
        >
          <header>
            {run.status === "completed" && run.verdict === "passed" ? (
              <CheckCircle size={18} weight="fill" aria-hidden="true" />
            ) : run.status === "running" ? (
              <CircleNotch className="spin" size={18} aria-hidden="true" />
            ) : (
              <WarningCircle size={18} weight="fill" aria-hidden="true" />
            )}
            <div>
              <strong>{statusCopy(run)}</strong>
              <small>
                {run.status === "completed"
                  ? run.verdict === "passed"
                    ? `${run.captures.length} 个固定视口 · 未发现阻断问题`
                    : `${run.captures.length} 个固定视口 · 请检查下方证据`
                  : "没有执行外部导航或页面交互"}
              </small>
            </div>
          </header>
          {run.status === "completed" ? (
            <>
              <div className="project-browser-qa-captures">
                {run.captures.map((capture) => (
                  <figure key={capture.profile.id}>
                    <img
                      alt={`${capture.profile.label}页面验收截图`}
                      src={screenshotUrl?.({
                        conversationId,
                        runId: run.id,
                        profileId: capture.profile.id,
                      })}
                    />
                    <figcaption>
                      <strong>
                        {capture.profile.label} · {capture.profile.width}×{capture.profile.height}
                      </strong>
                      <span>
                        {capture.dom.nodeCount} 个节点 · {capture.dom.interactiveCount} 个交互元素
                      </span>
                      <span>{issueSummary(capture)}</span>
                    </figcaption>
                  </figure>
                ))}
              </div>
              <dl className="project-browser-qa-summary">
                <div>
                  <dt>Console 错误</dt>
                  <dd>
                    {run.console.entries.filter((entry) => entry.level === "error").length}
                  </dd>
                </div>
                <div>
                  <dt>失败请求</dt>
                  <dd>{run.failedRequests.entries.length}</dd>
                </div>
                <div>
                  <dt>可访问性问题</dt>
                  <dd>
                    {run.issueSummary?.accessibilityIssueCount
                      ?? run.captures.reduce(
                        (total, capture) => (
                          total + (capture.accessibility?.issueCount ?? 0)
                        ),
                        0,
                      )}
                  </dd>
                </div>
                <div>
                  <dt>被阻止请求</dt>
                  <dd>{run.security?.blockedRequests ?? 0}</dd>
                </div>
                <div>
                  <dt>被阻止导航</dt>
                  <dd>{run.security?.blockedNavigations ?? 0}</dd>
                </div>
                <div>
                  <dt>被阻止操作</dt>
                  <dd>{run.issueSummary?.blockedActionCount ?? 0}</dd>
                </div>
              </dl>
              {run.console.entries.length > 0 || run.failedRequests.entries.length > 0 ? (
                <details className="project-run-log">
                  <summary>查看 Console 与失败请求</summary>
                  <pre>{[
                    ...run.console.entries.map(
                      (entry) => `[console:${entry.level}] ${entry.text}`,
                    ),
                    ...run.failedRequests.entries.map(
                      (entry) => `[request:${entry.method}] ${entry.reason}`,
                    ),
                  ].join("\n")}</pre>
                </details>
              ) : null}
            </>
          ) : run.status === "failed" ? (
            <p>{run.error?.message ?? "请确认受管预览仍在运行后重试。"}</p>
          ) : null}
        </article>
      ))}
    </section>
  );
}
