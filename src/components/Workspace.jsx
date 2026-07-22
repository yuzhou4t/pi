import {
  ArrowClockwise,
  Check,
  Copy,
  Eye,
  FloppyDisk,
  GitDiff,
  MagicWand,
  PaperPlaneTilt,
  PencilSimple,
  SpinnerGap,
} from "@phosphor-icons/react";

const taskTypes = ["交接稿", "研究简报", "实现计划"];

function ArtifactDocument({ artifact, generatedExtra }) {
  return (
    <article className="artifact-document" aria-label={artifact.title}>
      {artifact.sections.map((section) => (
        <section className="document-section" key={section.title}>
          <h3>{section.title}</h3>
          {section.paragraphs?.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
          {section.bullets ? (
            <ul>
              {section.bullets.map((item) => <li key={item}>{item}</li>)}
            </ul>
          ) : null}
          {section.ordered ? (
            <ol>
              {section.ordered.map(([label, detail]) => (
                <li key={label}><strong>{label}：</strong>{detail}</li>
              ))}
            </ol>
          ) : null}
        </section>
      ))}

      {generatedExtra ? (
        <section className="document-section generated-section">
          <div className="generated-section-label"><MagicWand size={14} weight="fill" aria-hidden="true" /> 本轮补充</div>
          <h3>{generatedExtra.type}补充说明</h3>
          <p>{generatedExtra.summary}</p>
          <p className="generated-meta">根据本轮输入生成 · {generatedExtra.time} · 尚未写回项目</p>
        </section>
      ) : null}
    </article>
  );
}

export function Workspace({
  project,
  restoreValues,
  restoreEditing,
  onRestoreChange,
  onToggleRestoreEdit,
  onSaveRestore,
  onRefresh,
  refreshing,
  artifactStatus,
  generatedExtra,
  onCopy,
  onCompare,
  prompt,
  onPromptChange,
  taskType,
  onTaskTypeChange,
  previewOnly,
  onPreviewOnlyChange,
  onGenerate,
  generating,
  mobileActive,
}) {
  const focusComposer = () => document.getElementById("task-composer")?.focus();

  return (
    <main className={`workspace${mobileActive ? " is-mobile-active" : ""}`}>
      <header className="workspace-header">
        <div className="workspace-title">
          <span className="eyebrow">工作区草稿</span>
          <h1>{project.name}</h1>
          <p>{project.sourceCount} 个资料源 · 最近核验 {project.lastChecked} · 主流程仍待讨论</p>
        </div>
        <div className="workspace-header-actions">
          <button className="compact-action" type="button" onClick={onRefresh} disabled={refreshing}>
            {refreshing ? <SpinnerGap className="spin" size={15} aria-hidden="true" /> : <ArrowClockwise size={15} aria-hidden="true" />}
            <span>{refreshing ? "刷新中" : "刷新资料"}</span>
          </button>
          <button className="primary-action" type="button" onClick={focusComposer}>
            <MagicWand size={15} weight="bold" aria-hidden="true" />
            <span>开始输入</span>
          </button>
        </div>
      </header>

      <section className={`restore-strip${restoreEditing ? " is-editing" : ""}`} aria-label="当前工作摘要">
        {project.restore.map((item, index) => (
          <div className={`restore-column${item.accent ? " is-accent" : ""}`} key={item.label}>
            <div className="restore-label-row">
              <span>{item.label}</span>
              {item.accent ? <span className="recommended-label">推荐</span> : null}
            </div>
            {restoreEditing ? (
              <textarea
                aria-label={`编辑${item.label}`}
                value={restoreValues[index]}
                onChange={(event) => onRestoreChange(index, event.target.value)}
              />
            ) : (
              <p>{restoreValues[index]}</p>
            )}
          </div>
        ))}
        <div className="restore-edit-actions">
          {restoreEditing ? (
            <button className="mini-icon-action" type="button" onClick={onSaveRestore} title="保存恢复结果">
              <FloppyDisk size={15} weight="regular" aria-hidden="true" />
              <span>保存</span>
            </button>
          ) : (
            <button className="mini-icon-action" type="button" onClick={onToggleRestoreEdit} title="修正恢复结果">
              <PencilSimple size={15} weight="regular" aria-hidden="true" />
              <span>修正</span>
            </button>
          )}
        </div>
      </section>

      <section className="artifact-card">
        <header className="artifact-toolbar">
          <div className="artifact-title-block">
            <span className="artifact-type">{project.artifact.type}</span>
            <div>
              <h2>{project.artifact.title}</h2>
              <p>{artifactStatus}</p>
            </div>
          </div>
          <div className="artifact-actions">
            <button className="text-action" type="button" aria-label="比较版本" onClick={onCompare}>
              <GitDiff size={15} weight="regular" aria-hidden="true" />
              <span>比较版本</span>
            </button>
            <button className="text-action" type="button" aria-label="复制主成果" onClick={onCopy}>
              <Copy size={15} weight="regular" aria-hidden="true" />
              <span>复制</span>
            </button>
          </div>
        </header>
        <ArtifactDocument artifact={project.artifact} generatedExtra={generatedExtra} />
      </section>

      <section className="composer" aria-label="本轮任务输入">
        <textarea
          id="task-composer"
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
          placeholder="告诉 Pi 你现在想处理什么……"
        />
        <div className="composer-footer">
          <div className="type-chips" aria-label="成果类型">
            {taskTypes.map((type) => (
              <button
                className={`type-chip${taskType === type ? " is-selected" : ""}`}
                type="button"
                key={type}
                onClick={() => onTaskTypeChange(type)}
              >
                {taskType === type ? <Check size={12} weight="bold" aria-hidden="true" /> : null}
                {type}
              </button>
            ))}
          </div>
          <span className="composer-source-note">将使用当前项目的 {project.sourceCount} 个已选资料源</span>
          <div className="composer-actions">
            <button
              className={`preview-toggle${previewOnly ? " is-active" : ""}`}
              type="button"
              aria-pressed={previewOnly}
              onClick={() => onPreviewOnlyChange(!previewOnly)}
            >
              <Eye size={14} weight="regular" aria-hidden="true" />
              只预览
            </button>
            <button className="generate-button" type="button" onClick={onGenerate} disabled={generating || !prompt.trim()}>
              {generating ? <SpinnerGap className="spin" size={15} aria-hidden="true" /> : <PaperPlaneTilt size={15} weight="fill" aria-hidden="true" />}
              {generating ? "生成中" : "生成"}
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}
