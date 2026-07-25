import { useEffect, useState } from "react";
import {
  ArrowRight,
  CheckCircle,
  FolderOpen,
  FolderSimplePlus,
  ShieldCheck,
  X,
} from "@phosphor-icons/react";
import { projectWorkApi } from "../api/projectWork.js";

const PAPER_SELECTED_FOLDER = {
  id: "agent-ui-lab",
  name: "Agent UI 实验",
  rootLabel: "~/Public/agent-ui-lab",
  source: "bound_folder",
};

function createProjectFolder(name) {
  const normalizedName = name.trim() || "未命名项目";
  return {
    id: `created-project:${Date.now()}`,
    name: normalizedName,
    rootLabel: `~/Public/${normalizedName}`,
    source: "created_project",
  };
}

export function BindProjectDialog({
  open,
  workspaceKind = "project_work",
  onClose,
  onBind,
  api = projectWorkApi,
}) {
  const [step, setStep] = useState("choose");
  const [selection, setSelection] = useState(null);
  const [projectName, setProjectName] = useState("新的 Pi Agent 项目");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setStep("choose");
    setSelection(null);
    setProjectName("新的 Pi Agent 项目");
    setBusy(false);
    setError("");
  }, [open]);

  if (!open) return null;

  const kindLabel = workspaceKind === "paper_reading" ? "论文精读" : "正常工作";

  const confirmBinding = async () => {
    if (!selection) return;
    setBusy(true);
    setError("");
    try {
      const project = workspaceKind === "project_work"
        ? await api.registerProject({
            rootToken: selection.rootToken,
            workspaceKind,
            name: selection.source === "created_project" ? undefined : selection.name,
            newFolderName: selection.source === "created_project"
              ? selection.newFolderName
              : undefined,
          })
        : selection;
      await onBind?.({
        ...project,
        workspaceKinds: [workspaceKind],
        updated: "刚刚",
      });
      setStep("done");
    } catch (nextError) {
      setError(nextError?.message || "项目添加失败，请重试");
    } finally {
      setBusy(false);
    }
  };

  const chooseExistingFolder = async () => {
    setBusy(true);
    setError("");
    try {
      if (workspaceKind !== "project_work") {
        setSelection(PAPER_SELECTED_FOLDER);
      } else {
        const picked = await api.pickRoot({ purpose: "existing" });
        setSelection({
          rootToken: picked.selectionId ?? picked.rootToken ?? picked.root_token,
          name: picked.name ?? picked.rootLabel ?? "本地项目",
          rootLabel: picked.rootLabel ?? picked.root_label ?? "本地项目",
          source: "bound_folder",
        });
      }
      setStep("review");
    } catch (nextError) {
      if (nextError?.code !== "PROJECT_WORK_PICKER_CANCELLED") {
        setError(nextError?.message || "无法打开本地文件夹选择器");
      }
    } finally {
      setBusy(false);
    }
  };

  const prepareNewProject = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (workspaceKind !== "project_work") {
        setSelection(createProjectFolder(projectName));
      } else {
        const picked = await api.pickRoot({ purpose: "create" });
        const normalizedName = projectName.trim();
        setSelection({
          rootToken: picked.selectionId ?? picked.rootToken ?? picked.root_token,
          name: normalizedName,
          newFolderName: normalizedName,
          rootLabel: `${picked.rootLabel ?? picked.root_label ?? "所选位置"} / ${normalizedName}`,
          source: "created_project",
        });
      }
      setStep("review");
    } catch (nextError) {
      if (nextError?.code !== "PROJECT_WORK_PICKER_CANCELLED") {
        setError(nextError?.message || "无法选择新项目的位置");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bind-project-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="bind-project-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bind-project-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span className="workflow-kicker">{kindLabel}</span>
            <h2 id="bind-project-title">添加项目</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭添加项目">
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        {step === "choose" ? (
          <div className="bind-project-step">
            <p>选择已有文件夹，或从一个新的项目文件夹开始。</p>
            <div className="bind-project-choice-list">
              <button
                className="bind-project-picker"
                type="button"
                onClick={chooseExistingFolder}
                disabled={busy}
              >
                <FolderOpen size={22} weight="regular" aria-hidden="true" />
                <span>
                  <strong>选择本地文件夹</strong>
                  <small>把电脑中的现有项目加入当前工作类型</small>
                </span>
                <ArrowRight size={17} aria-hidden="true" />
              </button>
              <button
                className="bind-project-picker"
                type="button"
                onClick={() => setStep("create")}
                disabled={busy}
              >
                <FolderSimplePlus size={22} weight="regular" aria-hidden="true" />
                <span>
                  <strong>新建项目文件夹</strong>
                  <small>创建一个空项目，再让 Agent 从这里开始工作</small>
                </span>
                <ArrowRight size={17} aria-hidden="true" />
              </button>
            </div>
          </div>
        ) : null}

        {step === "create" ? (
          <form className="bind-project-step bind-project-create" onSubmit={prepareNewProject}>
            <p>给新项目一个名称，然后选择它要创建在哪个本地文件夹中。</p>
            <label htmlFor="new-project-name">
              <span>项目名称</span>
              <input
                id="new-project-name"
                type="text"
                value={projectName}
                onChange={(event) => setProjectName(event.target.value)}
                autoFocus
              />
            </label>
            <small className="bind-project-path-preview">下一步会打开本机文件夹选择器；界面只保存安全标签。</small>
            <footer>
              <button className="secondary-button" type="button" onClick={() => setStep("choose")}>
                返回
              </button>
              <button className="primary-button" type="submit" disabled={!projectName.trim() || busy}>
                {busy ? "正在打开选择器…" : "选择创建位置"}
              </button>
            </footer>
          </form>
        ) : null}

        {step === "review" && selection ? (
          <div className="bind-project-step">
            <div className="bind-project-selection">
              <FolderOpen size={20} weight="fill" aria-hidden="true" />
              <span>
                <strong>{selection.name}</strong>
                <small>{selection.rootLabel}</small>
              </span>
            </div>
            <div className="bind-project-permissions">
              <div>
                <ShieldCheck size={17} aria-hidden="true" />
                <span><strong>项目内读取</strong><small>可用于理解文件与生成计划</small></span>
              </div>
              <div>
                <ShieldCheck size={17} aria-hidden="true" />
                <span><strong>修改先审阅</strong><small>显示精确 Diff 与哈希后才可确认</small></span>
              </div>
              <div>
                <ShieldCheck size={17} aria-hidden="true" />
                <span><strong>只保存安全标签</strong><small>界面不显示本机绝对路径</small></span>
              </div>
            </div>
            <footer>
              <button className="secondary-button" type="button" onClick={() => setStep(selection.source === "created_project" ? "create" : "choose")}>
                返回修改
              </button>
              <button className="primary-button" type="button" onClick={confirmBinding} disabled={busy}>
                {busy ? "正在添加…" : `添加到${kindLabel}`}
              </button>
            </footer>
          </div>
        ) : null}

        {error ? <p className="bind-project-error" role="alert">{error}</p> : null}

        {step === "done" ? (
          <div className="bind-project-step is-done">
            <CheckCircle size={30} weight="fill" aria-hidden="true" />
            <div>
              <h3>项目已添加</h3>
              <p>项目已经出现在“{kindLabel}”下，可以直接开始新会话。</p>
            </div>
            <button className="primary-button" type="button" onClick={onClose}>
              查看项目
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
