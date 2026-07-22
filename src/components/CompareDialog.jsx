import { CheckCircle, ClockCounterClockwise, X } from "@phosphor-icons/react";

export function CompareDialog({ project, generatedExtra, onClose }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="compare-dialog" role="dialog" aria-modal="true" aria-labelledby="compare-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="dialog-header">
          <div>
            <span className="eyebrow">版本比较</span>
            <h2 id="compare-title">{project.artifact.title}</h2>
          </div>
          <button className="icon-button" type="button" aria-label="关闭版本比较" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <div className="compare-grid">
          <article>
            <div className="compare-label"><ClockCounterClockwise size={16} aria-hidden="true" /> 上一版</div>
            <h3>固定角色架构草案</h3>
            <p>以五个常驻角色覆盖检索、规划、分析、审查与写作，角色之间通过完整消息转交。</p>
            <ul>
              <li>职责边界不够清晰；</li>
              <li>并行与汇合没有显式规则；</li>
              <li>输出状态容易与证据状态混在一起。</li>
            </ul>
          </article>
          <article className="compare-current">
            <div className="compare-label"><CheckCircle size={16} weight="fill" aria-hidden="true" /> 当前版</div>
            <h3>{project.artifact.title}</h3>
            <p>收敛为一个协调器和按需创建的动态专业池，把证据核对与人工确认作为明确门槛。</p>
            <ul>
              <li>只保留一个主成果；</li>
              <li>用结构化阶段结果汇合；</li>
              <li>区分生成、写入与导出状态。</li>
            </ul>
            {generatedExtra ? <p className="compare-added">已包含刚刚生成的“本轮补充”。</p> : null}
          </article>
        </div>
        <footer className="dialog-footer">
          <span>比较用于人工审阅，不会自动覆盖上一版。</span>
          <button className="primary-action" type="button" onClick={onClose}>返回当前版</button>
        </footer>
      </section>
    </div>
  );
}
