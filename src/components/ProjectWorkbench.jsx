import { useEffect, useMemo, useState } from "react";
import {
  CaretDown,
  CaretLeft,
  CaretRight,
  Check,
  CheckCircle,
  CircleNotch,
  Code,
  Desktop,
  DeviceMobile,
  FileCode,
  Files,
  GitDiff,
  Package,
  PaperPlaneTilt,
  Play,
  SidebarSimple,
  TestTube,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { AgentArtifactLayout } from "./AgentArtifactLayout.jsx";
import { ProviderMenu } from "./ProviderMenu.jsx";
import {
  PROJECT_WORK_ACTIONS,
  PROJECT_WORK_ARTIFACTS,
  PROJECT_WORK_FIXTURE,
  PROJECT_WORK_STATUS,
} from "../project-work/projectWorkState.js";

const STATUS_LABELS = {
  [PROJECT_WORK_STATUS.READY]: "等待任务",
  [PROJECT_WORK_STATUS.PLANNED]: "计划待开始",
  [PROJECT_WORK_STATUS.EXECUTING]: "正在执行",
  [PROJECT_WORK_STATUS.AWAITING_CONFIRMATION]: "修改待审阅",
  [PROJECT_WORK_STATUS.CHANGES_APPLIED]: "修改已确认",
  [PROJECT_WORK_STATUS.TEST_FAILED]: "验证待重试",
  [PROJECT_WORK_STATUS.COMPLETED]: "任务已完成",
};

const EVENT_COPY = {
  plan_created: {
    title: "计划已建立",
    detail: "已把目标拆成读取、修改和验证三个公开步骤。",
  },
  plan_step_started: {
    title: "读取相关文件",
    detail: "已定位设置页组件和移动端样式。",
    artifactId: PROJECT_WORK_ARTIFACTS.FILES,
    actionLabel: "查看文件",
  },
  changes_ready: {
    title: "修改已准备",
    detail: "精确差异已放到右侧“更改”，等待确认。",
    artifactId: PROJECT_WORK_ARTIFACTS.CHANGES,
    actionLabel: "查看更改",
  },
  confirmation_cancelled: {
    title: "本次修改已取消",
    detail: "文件没有进入已应用状态，可以继续调整选择。",
    artifactId: PROJECT_WORK_ARTIFACTS.CHANGES,
    actionLabel: "查看更改",
  },
  changes_confirmed: {
    title: "所选修改已确认",
    detail: "已记录目标版本和前后内容哈希。",
    artifactId: PROJECT_WORK_ARTIFACTS.PREVIEW,
    actionLabel: "打开预览",
  },
  validation_failed: {
    title: "第一次验证未通过",
    detail: "移动端安全底距仍不足，失败证据已保留。",
    artifactId: PROJECT_WORK_ARTIFACTS.RUN_RESULT,
    actionLabel: "查看测试",
  },
  validation_passed: {
    title: "验证通过",
    detail: "桌面布局和移动端底部操作区均已核对。",
    artifactId: PROJECT_WORK_ARTIFACTS.RUN_RESULT,
    actionLabel: "查看测试",
  },
};

function getEventCopy(event) {
  if (event.kind !== "plan_step_completed") {
    return EVENT_COPY[event.kind] ?? {
      title: "活动已记录",
      detail: event.kind,
    };
  }
  if (event.stepId === "inspect") {
    return {
      title: "文件结构已检查",
      detail: "设置页主体和底部操作区的关系已经核对。",
      artifactId: PROJECT_WORK_ARTIFACTS.FILES,
      actionLabel: "查看文件",
    };
  }
  return {
    title: "移动端样式已检查",
    detail: "确认遮挡来自内容区与固定操作区缺少安全间距。",
  };
}

function ArtifactLink({ artifactId, children, onOpenArtifact }) {
  return (
    <button
      className="project-agent-link"
      type="button"
      onClick={() => onOpenArtifact(artifactId)}
    >
      {children}
      <CaretRight size={13} weight="bold" aria-hidden="true" />
    </button>
  );
}

function PlanCard({ state, dispatch }) {
  if (state.status === PROJECT_WORK_STATUS.READY) return null;
  return (
    <section className="project-plan-card" aria-label="任务计划">
      <header>
        <span>执行计划</span>
        <small>{state.plan.filter((step) => step.status === "completed").length}/{state.plan.length}</small>
      </header>
      <ol>
        {state.plan.map((step) => (
          <li className={`is-${step.status}`} key={step.id}>
            <span className="project-plan-status" aria-hidden="true">
              {step.status === "completed" ? (
                <Check size={12} weight="bold" />
              ) : step.status === "in_progress" ? (
                <CircleNotch size={12} weight="bold" />
              ) : null}
            </span>
            <span>{step.title}</span>
          </li>
        ))}
      </ol>
      {state.status === PROJECT_WORK_STATUS.PLANNED ? (
        <button
          className="project-agent-primary"
          type="button"
          onClick={() => dispatch({ type: PROJECT_WORK_ACTIONS.START_EXECUTION })}
        >
          <Play size={14} weight="fill" aria-hidden="true" />
          开始执行
        </button>
      ) : null}
    </section>
  );
}

function ActivityTimeline({ events, onOpenArtifact }) {
  if (events.length === 0) return null;
  return (
    <section className="project-activity" aria-label="Agent 活动">
      <header>
        <span>活动</span>
        <small>{events.length} 条记录</small>
      </header>
      <div>
        {events.map((event, index) => (
          <ActivityEvent
            event={event}
            isLatest={index === events.length - 1}
            key={event.seq}
            onOpenArtifact={onOpenArtifact}
          />
        ))}
      </div>
    </section>
  );
}

function ActivityEvent({ event, isLatest, onOpenArtifact }) {
  const [open, setOpen] = useState(isLatest);
  const copy = getEventCopy(event);

  useEffect(() => {
    setOpen(isLatest);
  }, [isLatest]);

  return (
    <details open={open} onToggle={(toggleEvent) => setOpen(toggleEvent.currentTarget.open)}>
      <summary>
        <span className="project-activity-dot" aria-hidden="true" />
        <span>{copy.title}</span>
        <small>#{event.seq}</small>
        <CaretDown size={12} aria-hidden="true" />
      </summary>
      <p>
        <span>{copy.detail}</span>
        {copy.artifactId ? (
          <button
            type="button"
            onClick={() => onOpenArtifact(copy.artifactId)}
          >
            {copy.actionLabel}
            <CaretRight size={12} weight="bold" aria-hidden="true" />
          </button>
        ) : null}
      </p>
    </details>
  );
}

function ProjectAgentPane({
  state,
  dispatch,
  onOpenArtifact,
}) {
  useEffect(() => {
    if (state.status !== PROJECT_WORK_STATUS.EXECUTING) return undefined;
    const currentStep = state.plan.find((step) => step.status === "in_progress");
    if (!currentStep) return undefined;
    const timer = window.setTimeout(() => {
      dispatch({
        type: PROJECT_WORK_ACTIONS.ADVANCE_PLAN,
        stepId: currentStep.id,
      });
    }, 620);
    return () => window.clearTimeout(timer);
  }, [dispatch, state.plan, state.status]);

  const submitTask = (event) => {
    event.preventDefault();
    dispatch({ type: PROJECT_WORK_ACTIONS.SEND_TASK });
  };

  return (
    <div className="project-agent">
      <header className="project-agent-header">
        <div>
          <span>项目 Agent</span>
          <strong>{STATUS_LABELS[state.status]}</strong>
        </div>
        <span className={`project-agent-status is-${state.status}`}>
          <span aria-hidden="true" />
          {STATUS_LABELS[state.status]}
        </span>
      </header>

      <div className="project-agent-stream">
        {state.messages.length === 0 ? (
          <section className="project-agent-welcome">
            <Code size={24} weight="regular" aria-hidden="true" />
            <div>
              <h2>从一个明确任务开始</h2>
              <p>Agent 会先给出计划；文件、修改、预览和验证证据会留在右侧。</p>
            </div>
            <div className="project-agent-scope">
              <span>项目内读取</span>
              <span>修改先审阅</span>
              <span>只展示运行证据</span>
            </div>
          </section>
        ) : (
          state.messages.map((message) => (
            <article
              className={`project-agent-message is-${message.role} is-${message.kind}`}
              key={message.id}
            >
              <small>{message.role === "user" ? "你" : "Pi Agent"}</small>
              <div>{message.content}</div>
            </article>
          ))
        )}

        <PlanCard state={state} dispatch={dispatch} />
        <ActivityTimeline events={state.events} onOpenArtifact={onOpenArtifact} />

        {state.status === PROJECT_WORK_STATUS.AWAITING_CONFIRMATION ? (
          <section className="project-agent-decision">
            <GitDiff size={18} aria-hidden="true" />
            <div>
              <strong>修改已准备，尚未应用</strong>
              <p>确认按钮和精确差异放在同一个工件里，取消不会推进状态。</p>
            </div>
            <ArtifactLink
              artifactId={PROJECT_WORK_ARTIFACTS.CHANGES}
              onOpenArtifact={onOpenArtifact}
            >
              查看精确更改
            </ArtifactLink>
          </section>
        ) : null}

        {state.status === PROJECT_WORK_STATUS.CHANGES_APPLIED ? (
          <section className="project-agent-decision">
            <TestTube size={18} aria-hidden="true" />
            <div>
              <strong>所选修改已确认</strong>
              <p>下一步运行结构化验证，结果和退出码会保留在右侧。</p>
            </div>
            <button
              className="project-agent-link"
              type="button"
              onClick={() => dispatch({ type: PROJECT_WORK_ACTIONS.RUN_TESTS })}
            >
              运行验证
              <CaretRight size={13} weight="bold" aria-hidden="true" />
            </button>
          </section>
        ) : null}

        {state.status === PROJECT_WORK_STATUS.TEST_FAILED ? (
          <section className="project-agent-decision is-warning">
            <WarningCircle size={18} weight="fill" aria-hidden="true" />
            <div>
              <strong>第一次验证未通过</strong>
              <p>失败证据已保留；重试会追加新记录，不覆盖上一次结果。</p>
            </div>
            <ArtifactLink
              artifactId={PROJECT_WORK_ARTIFACTS.RUN_RESULT}
              onOpenArtifact={onOpenArtifact}
            >
              查看并重试
            </ArtifactLink>
          </section>
        ) : null}

        {state.status === PROJECT_WORK_STATUS.COMPLETED ? (
          <section className="project-agent-complete">
            <CheckCircle size={20} weight="fill" aria-hidden="true" />
            <div>
              <strong>任务已经完成并通过验证</strong>
              <p>修改、移动端预览以及两次运行记录都可以继续核对。</p>
            </div>
            <div>
              <ArtifactLink
                artifactId={PROJECT_WORK_ARTIFACTS.CHANGES}
                onOpenArtifact={onOpenArtifact}
              >
                最终更改
              </ArtifactLink>
              <ArtifactLink
                artifactId={PROJECT_WORK_ARTIFACTS.RUN_RESULT}
                onOpenArtifact={onOpenArtifact}
              >
                验证结果
              </ArtifactLink>
            </div>
          </section>
        ) : null}
      </div>

      <form className="project-agent-composer" onSubmit={submitTask}>
        {state.contextChips.length > 0 ? (
          <div className="project-context-chips" aria-label="本条消息的文件上下文">
            {state.contextChips.map((context) => (
              <span key={context.id}>
                <FileCode size={13} aria-hidden="true" />
                {context.label}
                <button
                  type="button"
                  onClick={() => dispatch({
                    type: PROJECT_WORK_ACTIONS.REMOVE_CONTEXT,
                    contextId: context.id,
                  })}
                  aria-label={`移除上下文：${context.label}`}
                >
                  <X size={12} weight="bold" aria-hidden="true" />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <label>
          <span className="sr-only">给项目 Agent 的任务</span>
          <textarea
            value={state.draft}
            disabled={state.status !== PROJECT_WORK_STATUS.READY}
            onChange={(event) => dispatch({
              type: PROJECT_WORK_ACTIONS.SET_DRAFT,
              draft: event.target.value,
            })}
            placeholder={state.status === PROJECT_WORK_STATUS.READY
              ? "描述你希望 Agent 完成的项目任务"
              : "当前任务正在这个会话中推进"}
          />
        </label>
        <footer>
          <div>
            <span className="project-composer-model">{state.modelId || "跟随项目默认模型"}</span>
            <small>打开与切换不会调用模型</small>
          </div>
          <button
            type="submit"
            disabled={state.status !== PROJECT_WORK_STATUS.READY || !state.draft.trim()}
            aria-label="发送任务"
          >
            <PaperPlaneTilt size={16} weight="fill" aria-hidden="true" />
          </button>
        </footer>
      </form>
    </div>
  );
}

function FileArtifact({ state, dispatch }) {
  const [selectedFileId, setSelectedFileId] = useState(PROJECT_WORK_FIXTURE.files[0].id);
  const [mobileFileOpen, setMobileFileOpen] = useState(false);
  const selectedFile = PROJECT_WORK_FIXTURE.files.find((file) => file.id === selectedFileId)
    ?? PROJECT_WORK_FIXTURE.files[0];

  const addFileContext = () => {
    dispatch({
      type: PROJECT_WORK_ACTIONS.ADD_CONTEXT,
      context: {
        id: `file:${selectedFile.id}`,
        label: `${selectedFile.path} · 全文`,
        path: selectedFile.path,
        startLine: 1,
        endLine: selectedFile.content.length,
      },
    });
  };

  return (
    <div className={`project-file-artifact${mobileFileOpen ? " is-file-open" : ""}`}>
      <aside aria-label="项目文件">
        <header><Files size={15} aria-hidden="true" />项目文件</header>
        {PROJECT_WORK_FIXTURE.files.map((file) => (
          <button
            className={file.id === selectedFile.id ? "is-active" : ""}
            type="button"
            key={file.id}
            onClick={() => {
              setSelectedFileId(file.id);
              setMobileFileOpen(true);
            }}
          >
            <FileCode size={15} aria-hidden="true" />
            <span>{file.path}</span>
          </button>
        ))}
      </aside>
      <section className="project-code-viewer">
        <header>
          <button
            className="project-file-back"
            type="button"
            onClick={() => setMobileFileOpen(false)}
          >
            <CaretLeft size={14} weight="bold" aria-hidden="true" />
            返回文件
          </button>
          <div>
            <strong>{selectedFile.path}</strong>
            <small>
              {selectedFile.language.toUpperCase()} · 只读 · Agent 定位 L
              {selectedFile.focusLines.at(0)}–{selectedFile.focusLines.at(-1)}
            </small>
          </div>
          <button type="button" onClick={addFileContext}>加入上下文</button>
        </header>
        <ol>
          {selectedFile.content.map((line, index) => (
            <li
              className={selectedFile.focusLines.includes(index + 1) ? "is-agent-located" : ""}
              key={`${selectedFile.id}-${index + 1}`}
            >
              <button
                type="button"
                onClick={() => dispatch({
                  type: PROJECT_WORK_ACTIONS.ADD_CONTEXT,
                  context: {
                    id: `${selectedFile.id}:${index + 1}`,
                    label: `${selectedFile.path} · L${index + 1}`,
                    path: selectedFile.path,
                    startLine: index + 1,
                    endLine: index + 1,
                  },
                })}
                aria-label={`将 ${selectedFile.path} 第 ${index + 1} 行加入上下文`}
              >
                <span>{index + 1}</span>
                <code>{line || " "}</code>
              </button>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function ChangeArtifact({ state, dispatch }) {
  const [activeFileId, setActiveFileId] = useState(state.changeSet.files[0].id);
  const activeFile = state.changeSet.files.find((file) => file.id === activeFileId)
    ?? state.changeSet.files[0];
  const selectedFileIds = state.changeSet.files
    .filter((file) => file.selected)
    .map((file) => file.id);
  const canDecide = state.status === PROJECT_WORK_STATUS.AWAITING_CONFIRMATION;

  const confirmChanges = () => {
    dispatch({
      type: PROJECT_WORK_ACTIONS.CONFIRM_CHANGES,
      changeSetId: state.changeSet.id,
      baseHash: state.changeSet.baseHash,
      afterHash: state.changeSet.afterHash,
      selectedFileIds,
    });
  };

  return (
    <div className="project-change-artifact">
      <aside>
        <header>
          <span>修改文件</span>
          <small>+{state.changeSet.files.reduce((sum, file) => sum + file.additions, 0)} / −{state.changeSet.files.reduce((sum, file) => sum + file.deletions, 0)}</small>
        </header>
        {state.changeSet.files.map((file) => (
          <div className={`project-change-file${file.id === activeFile.id ? " is-active" : ""}`} key={file.id}>
            <label>
              <input
                type="checkbox"
                checked={file.selected}
                disabled={!canDecide}
                onChange={() => dispatch({
                  type: PROJECT_WORK_ACTIONS.TOGGLE_CHANGE_FILE,
                  fileId: file.id,
                })}
              />
              <button type="button" onClick={() => setActiveFileId(file.id)}>
                <GitDiff size={14} aria-hidden="true" />
                <span>
                  <strong>{file.path}</strong>
                  <small>+{file.additions} −{file.deletions}</small>
                </span>
              </button>
            </label>
          </div>
        ))}
      </aside>
      <section className="project-diff-viewer">
        <header>
          <div>
            <strong>{activeFile.path}</strong>
            <small>修改 · unified diff</small>
          </div>
          <span>{state.changeSet.status === "applied" ? "已确认" : "待确认"}</span>
        </header>
        <pre>
          {activeFile.diff.map((line, index) => {
            const tone = line.startsWith("+")
              ? "is-added"
              : line.startsWith("-")
                ? "is-removed"
                : line.startsWith("@@")
                  ? "is-hunk"
                  : "";
            return <code className={tone} key={`${activeFile.id}-${index}`}>{line}{"\n"}</code>;
          })}
        </pre>
        <div className="project-change-hashes">
          <span>基础版本 <code>{state.changeSet.baseHash}</code></span>
          <span>目标版本 <code>{state.changeSet.afterHash}</code></span>
        </div>
        <footer className="project-change-confirmation">
          <div>
            <strong>{selectedFileIds.length} 个文件待应用</strong>
            <small>确认与当前文件集合、基础版本和目标哈希绑定。</small>
            {state.confirmation?.status === "cancelled" ? (
              <span className="project-change-cancelled">已取消，本次修改仍未应用。</span>
            ) : null}
          </div>
          {canDecide ? (
            <div>
              <button
                className="project-change-cancel"
                type="button"
                onClick={() => dispatch({ type: PROJECT_WORK_ACTIONS.CANCEL_CHANGES })}
              >
                取消
              </button>
              <button
                className="project-change-confirm"
                type="button"
                disabled={selectedFileIds.length === 0}
                onClick={confirmChanges}
              >
                确认应用所选修改
              </button>
            </div>
          ) : (
            <span className="project-change-applied">
              <CheckCircle size={15} weight="fill" aria-hidden="true" />
              {state.changeSet.status === "applied" ? "所选修改已确认" : "完成计划后可确认"}
            </span>
          )}
        </footer>
      </section>
    </div>
  );
}

function PreviewArtifact({ state, dispatch }) {
  const [viewport, setViewport] = useState("mobile");
  const changesApplied = [
    PROJECT_WORK_STATUS.CHANGES_APPLIED,
    PROJECT_WORK_STATUS.TEST_FAILED,
    PROJECT_WORK_STATUS.COMPLETED,
  ].includes(state.status);

  return (
    <div className="project-preview-artifact">
      <header>
        <div>
          <strong>设置页预览</strong>
          <small>{changesApplied ? "已确认修改" : "拟议修改预览"}</small>
        </div>
        <div className="project-preview-viewport" role="group" aria-label="预览宽度">
          <button
            className={viewport === "desktop" ? "is-active" : ""}
            type="button"
            onClick={() => setViewport("desktop")}
          >
            <Desktop size={14} aria-hidden="true" />
            桌面
          </button>
          <button
            className={viewport === "mobile" ? "is-active" : ""}
            type="button"
            onClick={() => setViewport("mobile")}
          >
            <DeviceMobile size={14} aria-hidden="true" />
            移动
          </button>
        </div>
      </header>
      <div className="project-preview-canvas">
        <section className={`project-settings-preview is-${viewport}`}>
          <header>
            <span>设置</span>
            <button type="button" aria-label="关闭设置预览"><X size={16} /></button>
          </header>
          <div className="project-settings-preview-body">
            <h3>通用</h3>
            <label><span>界面语言<small>用于按钮和系统提示</small></span><b>简体中文</b></label>
            <label><span>默认工作方式<small>每个项目独立保存</small></span><b>先计划后执行</b></label>
            <label><span>修改确认<small>应用项目文件前显示精确差异</small></span><b>始终询问</b></label>
            <label><span>运行结果<small>保留测试、构建和退出码</small></span><b>结构化摘要</b></label>
            <label><span>会话恢复<small>打开时不重新生成内容</small></span><b>已开启</b></label>
          </div>
          <footer>
            <button type="button">取消</button>
            <button type="button">{PROJECT_WORK_FIXTURE.preview.footerLabel}</button>
          </footer>
        </section>
      </div>
      {changesApplied ? (
        <footer className="project-preview-footer">
          <span>移动端底部操作区保持可见，内容区可滚动至最后一项。</span>
          {state.status === PROJECT_WORK_STATUS.CHANGES_APPLIED ? (
            <button
              type="button"
              onClick={() => dispatch({ type: PROJECT_WORK_ACTIONS.RUN_TESTS })}
            >
              运行验证
            </button>
          ) : null}
        </footer>
      ) : null}
    </div>
  );
}

function RunArtifact({ state, dispatch }) {
  return (
    <div className="project-run-artifact">
      <header>
        <div>
          <strong>运行结果</strong>
          <small>结构化证据，不提供自由终端</small>
        </div>
        {state.status === PROJECT_WORK_STATUS.CHANGES_APPLIED ? (
          <button
            type="button"
            onClick={() => dispatch({ type: PROJECT_WORK_ACTIONS.RUN_TESTS })}
          >
            <Play size={14} weight="fill" aria-hidden="true" />
            运行验证
          </button>
        ) : null}
      </header>

      {state.testRuns.length === 0 ? (
        <section className="project-run-empty">
          <TestTube size={24} aria-hidden="true" />
          <h3>还没有运行记录</h3>
          <p>确认修改后，可以在这里运行并保留测试结果。</p>
        </section>
      ) : (
        <div className="project-run-history">
          {state.testRuns.map((run, index) => (
            <article className={`is-${run.status}`} key={run.id}>
              <header>
                {run.status === "passed" ? (
                  <CheckCircle size={18} weight="fill" aria-hidden="true" />
                ) : (
                  <WarningCircle size={18} weight="fill" aria-hidden="true" />
                )}
                <div>
                  <strong>{index === 0 ? "首次验证" : "修正后重试"}</strong>
                  <code>{run.command}</code>
                </div>
                <span>{run.status === "passed" ? "通过" : "失败"}</span>
              </header>
              <p>{run.summary}</p>
              <ul>
                {run.checks.map((check) => (
                  <li key={check.id}>
                    {check.status === "passed" ? (
                      <Check size={13} weight="bold" aria-hidden="true" />
                    ) : (
                      <X size={13} weight="bold" aria-hidden="true" />
                    )}
                    <span>{check.label}</span>
                  </li>
                ))}
              </ul>
              <details className="project-run-log">
                <summary>
                  查看日志
                  <CaretDown size={12} aria-hidden="true" />
                </summary>
                <pre>{Array.isArray(run.logs) && run.logs.length > 0
                  ? run.logs.join("\n")
                  : "暂无日志"}</pre>
              </details>
              <footer>
                <span>退出码 {run.exitCode}</span>
                <span>{run.durationMs} ms</span>
              </footer>
            </article>
          ))}
        </div>
      )}

      {state.status === PROJECT_WORK_STATUS.TEST_FAILED ? (
        <button
          className="project-run-retry"
          type="button"
          onClick={() => dispatch({ type: PROJECT_WORK_ACTIONS.RETRY_TESTS })}
        >
          重试修正后的检查
        </button>
      ) : null}
    </div>
  );
}

function ProjectArtifactPane({ state, dispatch }) {
  const panels = useMemo(() => ({
    [PROJECT_WORK_ARTIFACTS.FILES]: <FileArtifact state={state} dispatch={dispatch} />,
    [PROJECT_WORK_ARTIFACTS.CHANGES]: <ChangeArtifact state={state} dispatch={dispatch} />,
    [PROJECT_WORK_ARTIFACTS.PREVIEW]: <PreviewArtifact state={state} dispatch={dispatch} />,
    [PROJECT_WORK_ARTIFACTS.RUN_RESULT]: <RunArtifact state={state} dispatch={dispatch} />,
  }), [dispatch, state]);

  return (
    <>
      <nav className="reading-artifact-tabs project-artifact-tabs" role="tablist" aria-label="项目工件">
        {PROJECT_WORK_FIXTURE.artifacts.map((artifact) => (
          <button
            className={state.activeArtifactId === artifact.id ? "is-active" : ""}
            type="button"
            role="tab"
            aria-selected={state.activeArtifactId === artifact.id}
            key={artifact.id}
            onClick={() => dispatch({
              type: PROJECT_WORK_ACTIONS.SET_ACTIVE_ARTIFACT,
              artifactId: artifact.id,
            })}
          >
            {artifact.label}
            {artifact.badge ? <span>{artifact.badge}</span> : null}
          </button>
        ))}
      </nav>
      <div className="reading-artifact-panels project-artifact-panels">
        <div className="reading-artifact-panel project-artifact-panel">
          {panels[state.activeArtifactId]}
        </div>
      </div>
    </>
  );
}

export function ProjectWorkbench({
  project,
  state,
  dispatch,
  providers = [],
  providerId,
  modelId,
  providerOpen = false,
  onProviderOpenChange,
  onOpenSkills,
  installedSkillCount = 0,
  sidebarOpen = true,
  onToggleSidebar,
  mobileActive = false,
  mobileView = "agent",
  onMobileViewChange,
  initialArtifactOpen = false,
}) {
  const [artifactOpen, setArtifactOpen] = useState(initialArtifactOpen);
  const activeProviderId = state.providerId || providerId;
  const activeProvider = providers.find((provider) => provider.id === activeProviderId)
    ?? providers.find((provider) => provider.available)
    ?? providers[0];
  const activeModelId = state.modelId || modelId || activeProvider?.models?.[0] || "";

  const openArtifact = (artifactId) => {
    setArtifactOpen(true);
    dispatch({
      type: PROJECT_WORK_ACTIONS.SET_ACTIVE_ARTIFACT,
      artifactId,
    });
    if (window.matchMedia?.("(max-width: 860px)").matches) {
      onMobileViewChange?.("artifact");
    }
  };

  return (
    <AgentArtifactLayout
      ariaLabel="项目工作会话"
      mobileActive={mobileActive}
      mobileView={mobileView}
      agentMobileView="agent"
      artifactOpen={artifactOpen}
      onArtifactOpenChange={setArtifactOpen}
      closedLabel="打开工件"
      openLabel="收起工件"
      closedTitle="打开右侧项目工件"
      openTitle="收起右侧项目工件"
      resizeLabel="拖拽调整 Agent 与项目工件的宽度"
      title={(
        <div className="workflow-title-block">
          <button
            className={`column-toggle-btn${!sidebarOpen ? " is-collapsed" : ""}`}
            type="button"
            aria-label={sidebarOpen ? "收起左边栏" : "展开左边栏"}
            title={sidebarOpen ? "收起左边栏" : "展开左边栏"}
            onClick={onToggleSidebar}
          >
            <SidebarSimple size={18} weight="regular" />
          </button>
          <div>
            <span className="workflow-kicker">{project?.name ?? state.rootLabel}</span>
            <h1>{state.title}</h1>
          </div>
        </div>
      )}
      headerActions={(
        <>
          {providers.length > 0 ? (
            <ProviderMenu
              open={providerOpen}
              onOpenChange={onProviderOpenChange}
              providers={providers}
              providerId={activeProvider?.id}
              model={activeModelId}
              onProviderChange={(nextProviderId) => {
                const nextProvider = providers.find((provider) => provider.id === nextProviderId);
                dispatch({
                  type: PROJECT_WORK_ACTIONS.SET_MODEL,
                  providerId: nextProviderId,
                  modelId: nextProvider?.models?.[0] ?? "",
                });
              }}
              onModelChange={(nextModelId) => dispatch({
                type: PROJECT_WORK_ACTIONS.SET_MODEL,
                providerId: activeProvider?.id ?? "",
                modelId: nextModelId,
              })}
            />
          ) : null}
          {onOpenSkills ? (
            <button className="header-meta-pill header-skill-pill" type="button" onClick={onOpenSkills}>
              <Package size={13} weight="regular" aria-hidden="true" />
              <span>技能 · {installedSkillCount}</span>
            </button>
          ) : null}
        </>
      )}
      agent={(
        <ProjectAgentPane
          state={state}
          dispatch={dispatch}
          onOpenArtifact={openArtifact}
        />
      )}
      artifact={<ProjectArtifactPane state={state} dispatch={dispatch} />}
    />
  );
}
