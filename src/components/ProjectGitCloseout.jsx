import {
  ArrowClockwise,
  CheckCircle,
  GitCommit,
  WarningCircle,
} from "@phosphor-icons/react";

function shortHash(value) {
  return typeof value === "string" && value
    ? value.replace(/^sha256:/, "").slice(0, 12)
    : "—";
}

function statusLabel(status) {
  if (status === "ready") return "等待精确确认";
  if (status === "staging") return "正在暂存精确路径";
  if (status === "staged") return "精确路径已暂存";
  if (status === "commit_created") return "提交对象已创建，正在核对引用";
  if (status === "ref_updated") return "本地引用已更新，正在读回核验";
  if (status === "committed") return "本地提交已创建并读回核验";
  if (status === "recovery_blocked") return "恢复已停止，需人工检查";
  if (status === "rolled_back") return "中断后已安全回退";
  if (status === "stale") return "分支或 HEAD 已变化";
  if (status === "failed") return "本地提交失败，未继续执行";
  return "Git 收尾未完成";
}

const RECOVERY_RELEVANT_STATUSES = new Set([
  "staging",
  "staged",
  "commit_created",
  "ref_updated",
  "recovery_blocked",
]);

export function selectGitCloseoutProposal(records = []) {
  return records.find((record) => record?.status === "ready")
    ?? records.find((record) => RECOVERY_RELEVANT_STATUSES.has(record?.status))
    ?? records[0]
    ?? null;
}

export function ProjectGitCloseout({
  records = [],
  status = "idle",
  onRefresh,
  onConfirm,
  confirming = false,
  running = false,
  error = null,
}) {
  const proposal = selectGitCloseoutProposal(records);
  const history = proposal
    ? records.filter((record) => record?.id !== proposal.id)
    : [];
  return (
    <section className="project-git-evidence" aria-label="受控 Git 收尾">
      <header>
        <div>
          <GitCommit size={15} aria-hidden="true" />
          <strong>本地 Git 收尾</strong>
          {proposal ? <span>{statusLabel(proposal.status)}</span> : null}
        </div>
        <button
          type="button"
          disabled={status === "loading" || status === "refreshing"}
          onClick={onRefresh}
        >
          <ArrowClockwise
            className={status === "loading" || status === "refreshing"
              ? "spin"
              : ""}
            size={13}
            aria-hidden="true"
          />
          刷新
        </button>
      </header>
      {status === "loading" || status === "idle" ? (
        <p className="project-change-evidence-state">正在读取 Git 收尾记录…</p>
      ) : status === "error" ? (
        <p className="project-change-evidence-state is-error">
          Git 收尾记录暂时无法读取；没有执行提交。
        </p>
      ) : !proposal ? (
        <p className="project-change-evidence-state">
          当前没有待确认的 Git 收尾。应用修改并通过绑定验证后，可让 Pi 准备本地提交预览。
        </p>
      ) : (
        <>
          <dl>
            <div>
              <dt>提交信息</dt>
              <dd>{proposal.commitMessage}</dd>
            </div>
            <div>
              <dt>分支与 HEAD</dt>
              <dd>{proposal.branch} · {shortHash(proposal.head)}</dd>
            </div>
            <div>
              <dt>验证证据</dt>
              <dd>{proposal.verificationEvidence.length} 项已通过</dd>
            </div>
          </dl>
          <div className="project-git-groups">
            <section>
              <header>
                <strong>精确提交路径</strong>
                <span>{proposal.files.length}</span>
              </header>
              <ul>
                {proposal.files.map((file) => (
                  <li key={file.path}>
                    {file.path}
                    {" · 基线 "}
                    {file.baseExists ? shortHash(file.baseHash) : "不存在"}
                    {" → "}
                    {file.exists ? shortHash(file.hash) : "删除"}
                  </li>
                ))}
              </ul>
            </section>
          </div>
          {proposal.status === "ready" ? (
            <button
              type="button"
              disabled={confirming || running}
              onClick={() => onConfirm?.(proposal)}
            >
              {confirming ? "正在创建本地提交" : "确认创建这一笔本地提交"}
            </button>
          ) : proposal.status === "committed" ? (
            <p className="project-change-evidence-state">
              <CheckCircle size={14} weight="fill" aria-hidden="true" />
              提交 {shortHash(proposal.commitHash)} 已创建；未推送、未建 PR。
            </p>
          ) : (
            <p className="project-change-evidence-state is-error">
              <WarningCircle size={14} weight="fill" aria-hidden="true" />
              {proposal.error?.message ?? statusLabel(proposal.status)}
            </p>
          )}
          {history.length > 0 ? (
            <div className="project-git-groups">
              <section>
                <header>
                  <strong>历史记录</strong>
                  <span>{history.length}</span>
                </header>
                <ul>
                  {history.slice(0, 10).map((record) => (
                    <li key={record.id}>
                      {statusLabel(record.status)}
                      {" · "}
                      {record.commitMessage || record.id}
                      {record.status === "committed" && record.commitHash
                        ? ` · ${shortHash(record.commitHash)}`
                        : ""}
                    </li>
                  ))}
                </ul>
              </section>
            </div>
          ) : null}
        </>
      )}
      {error ? (
        <p className="project-change-evidence-state is-error">{error.message}</p>
      ) : null}
      <small>
        仅提交上方精确路径；不会使用 git add .，不会 push、建 PR 或改写历史。
      </small>
    </section>
  );
}
