import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowSquareOut,
  Check,
  CheckCircle,
  DownloadSimple,
  FileText,
  MagnifyingGlass,
  Package,
  ShieldCheck,
  SpinnerGap,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { projectWorkApi } from "../api/projectWork.js";

const PI_SKILL_CATALOG_URL = "https://pi.dev/packages?type=skill";
const REVIEWED_SKILL_CANDIDATES = [
  "@counterposition/skill-pi",
  "@firstpick/pi-skill-html-report",
  "@pi-agent/project-orientation",
  "@pi-agent/git-closeout",
];

export function installedSkillRow(skill) {
  return {
    ...skill,
    installed: true,
    installSupported: true,
    kind: "package",
  };
}

function formatDownloads(value) {
  const count = Number(value) || 0;
  if (count >= 100_000) return `${(count / 1_000).toFixed(0)}K/月`;
  if (count >= 10_000) return `${(count / 1_000).toFixed(1)}K/月`;
  return `${count.toLocaleString("zh-CN")}/月`;
}

export function packageStateLine(skill) {
  if (skill.kind === "workflow") return "内置流程，仅在当前一轮选择后使用";
  if (!skill.installSupported) return skill.unsupportedReason;
  if (skill.runtimeCompatible === false) {
    if (skill.enabledPreference) {
      return `已配置启用，但当前不会加载；${skill.compatibilityReason}`;
    }
    return skill.compatibilityReason || "当前运行时不兼容";
  }
  if (!skill.installed) {
    return skill.bundled
      ? "Pi Agent 内置受审 Skill，安装前会核对精确内容"
      : "来自 Pi 官方目录，安装前会先检查包内容";
  }
  return skill.enabled
    ? "已安装并启用；下一次 Agent 运行会加载"
    : "已安装，当前停用";
}

function runtimeRequirementText(preview) {
  if (!preview.requiredRuntimeCapabilities?.length) return "不要求额外 Runtime 工具";
  return preview.requiredRuntimeCapabilities
    .map((capability) => capability.label || capability.id)
    .join("、");
}

export function SkillInstallReview({
  preview,
  status,
  error,
  onConfirm,
  onCancel,
}) {
  if (!preview) return null;
  const isUpgrade = preview.reviewMode === "upgrade";
  const reviewItems = isUpgrade
    ? preview.skillDiffs || []
    : preview.skillDocuments || [];
  return (
    <div
      className="skill-review-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <section
        className="skill-install-review"
        role="dialog"
        aria-modal="true"
        aria-labelledby="skill-install-review-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span className="eyebrow">{isUpgrade ? "升级预览" : "安装预览"}</span>
            <h3 id="skill-install-review-title">{preview.name}</h3>
            <p>
              {isUpgrade ? `${preview.installedVersion} → ` : ""}
              {preview.version} · {preview.skillCount} 个 Skill
            </p>
          </div>
          <button className="icon-button" type="button" aria-label="关闭安装预览" onClick={onCancel}>
            <X size={17} aria-hidden="true" />
          </button>
        </header>

        {preview.runtimeCompatible ? (
          <div className="skill-review-safe">
            <ShieldCheck size={18} weight="fill" aria-hidden="true" />
            <div>
              <strong>包检查与运行时要求均已通过</strong>
              <span>不含 Extension、安装脚本或运行时依赖；安装后默认停用。</span>
            </div>
          </div>
        ) : (
          <div className="skill-catalog-error" role="status">
            <WarningCircle size={18} weight="fill" aria-hidden="true" />
            <span>
              <strong>当前运行时不兼容。</strong>
              {" "}
              {preview.compatibilityReason}
              你仍可检查并安装，但它不会被启用或加载。
            </span>
          </div>
        )}

        <dl className="skill-review-facts">
          <div><dt>来源</dt><dd>{preview.source}</dd></div>
          <div><dt>归档</dt><dd>{preview.archiveFileCount} 个文件 · {(preview.archiveBytes / 1024).toFixed(1)} KB</dd></div>
          <div><dt>完整性</dt><dd>{preview.integrity?.split("-")[0] || "已校验"}</dd></div>
          <div><dt>运行能力</dt><dd>{runtimeRequirementText(preview)}</dd></div>
        </dl>

        <div className="skill-review-files">
          <strong>将安装的 Skill</strong>
          {preview.skillFiles.map((file) => (
            <span key={file}><FileText size={14} aria-hidden="true" />{file}</span>
          ))}
        </div>

        <div className="skill-review-files">
          <strong>效果范围</strong>
          {preview.effectScopes?.length ? preview.effectScopes.map((effect) => (
            <span key={effect.id}>
              <ShieldCheck size={14} aria-hidden="true" />
              {effect.label}
              {effect.confirmationRequired ? " · 需要明确确认" : ""}
            </span>
          )) : (
            <span>
              <WarningCircle size={14} aria-hidden="true" />
              尚未建立受审效果范围
            </span>
          )}
        </div>

        <details className="workflow-proposal-exact">
          <summary>
            {isUpgrade ? "查看完整升级差异" : "查看完整 SKILL.md"}
          </summary>
          <div>
            {reviewItems.length ? reviewItems.map((item) => (
              <section key={item.path}>
                <h4>
                  {item.path}
                  {isUpgrade && item.changeKind ? ` · ${item.changeKind}` : ""}
                </h4>
                <pre className="workflow-markdown-preview">
                  <code>{isUpgrade ? item.patch : item.content}</code>
                </pre>
              </section>
            )) : (
              <section>
                <h4>{isUpgrade ? "Skill 内容没有变化" : "未返回可审查内容"}</h4>
              </section>
            )}
          </div>
        </details>

        {error ? <div className="skill-action-error" role="alert">{error}</div> : null}

        <footer>
          <button type="button" onClick={onCancel} disabled={status === "installing"}>取消</button>
          <button
            className="primary-action"
            type="button"
            onClick={onConfirm}
            disabled={status === "installing"}
          >
            {status === "installing"
              ? <SpinnerGap className="spin" size={15} aria-hidden="true" />
              : <DownloadSimple size={15} aria-hidden="true" />}
            {status === "installing"
              ? isUpgrade ? "正在升级" : "正在安装"
              : isUpgrade ? "确认升级" : "确认安装"}
          </button>
        </footer>
      </section>
    </div>
  );
}

export function SkillCenter({
  onStateChange,
  onClose,
}) {
  const [query, setQuery] = useState("");
  const [view, setView] = useState("installed");
  const [catalogState, setCatalogState] = useState({
    status: "idle",
    packages: [],
    error: null,
  });
  const [installedState, setInstalledState] = useState({
    status: "loading",
    packages: [],
    error: null,
  });
  const [action, setAction] = useState({
    id: null,
    status: "idle",
    preview: null,
    error: null,
  });

  const loadInstalled = useCallback(async (signal) => {
    try {
      const result = await projectWorkApi.listInstalledSkills({ signal });
      if (signal?.aborted) return;
      setInstalledState({ status: "ready", packages: result.packages, error: null });
      onStateChange?.({
        installedCount: result.packages.length,
        enabledCount: result.packages.filter((item) => item.enabled).length,
      });
    } catch (error) {
      if (signal?.aborted) return;
      setInstalledState({ status: "error", packages: [], error: error.message });
    }
  }, [onStateChange]);

  useEffect(() => {
    const controller = new AbortController();
    void loadInstalled(controller.signal);
    return () => controller.abort();
  }, [loadInstalled]);

  useEffect(() => {
    if (view !== "candidates") return undefined;
    const controller = new AbortController();
    setCatalogState((current) => ({
      status: current.packages.length ? "refreshing" : "loading",
      packages: current.packages,
      error: null,
    }));
    Promise.all(REVIEWED_SKILL_CANDIDATES.map((name) => (
      projectWorkApi.listSkillCatalog({
        query: name,
        sort: "downloads",
        signal: controller.signal,
      })
    ))).then((results) => {
        if (controller.signal.aborted) return;
        const packages = REVIEWED_SKILL_CANDIDATES.flatMap((name) => {
          const match = results
            .flatMap((result) => result.packages)
            .find((item) => item.name === name);
          return match ? [match] : [];
        });
        setCatalogState({
          status: "ready",
          packages,
          error: null,
        });
      }).catch((error) => {
        if (controller.signal.aborted) return;
        setCatalogState((current) => ({
          status: "error",
          packages: current.packages,
          error: error.message,
        }));
      });
    return () => {
      controller.abort();
    };
  }, [view]);

  const installedByName = useMemo(
    () => new Map(installedState.packages.map((item) => [item.name, item])),
    [installedState.packages],
  );
  const visibleSkills = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (view === "installed") {
      return installedState.packages
        .filter((skill) => (
          !normalized
          || `${skill.name} ${skill.source}`.toLowerCase().includes(normalized)
        ))
        .map(installedSkillRow);
    }
    return catalogState.packages
      .filter((skill) => (
        !normalized
        || `${skill.name} ${skill.description}`.toLowerCase().includes(normalized)
      ))
      .map((skill) => {
        const installed = installedByName.get(skill.name);
        return {
          ...skill,
          installed: Boolean(installed),
          installedVersion: installed?.version ?? null,
          installedAt: installed?.installedAt ?? null,
          enabled: installed?.enabled === true,
          enabledPreference: installed?.enabledPreference === true,
          active: installed?.active === true,
          kind: "package",
        };
      });
  }, [
    catalogState.packages,
    installedByName,
    installedState.packages,
    query,
    view,
  ]);

  const inspect = async (skill) => {
    if (!skill.installSupported || action.status !== "idle") return;
    setAction({ id: skill.id, status: "inspecting", preview: null, error: null });
    try {
      const preview = await projectWorkApi.inspectSkillPackage({
        name: skill.name,
        version: skill.version,
      });
      setAction({ id: skill.id, status: "review", preview, error: null });
    } catch (error) {
      setAction({ id: skill.id, status: "idle", preview: null, error: error.message });
    }
  };

  const install = async () => {
    if (!action.preview) return;
    setAction((current) => ({ ...current, status: "installing", error: null }));
    try {
      await projectWorkApi.installSkillPackage({
        previewId: action.preview.previewId,
        previewHash: action.preview.previewHash,
      });
      setAction({ id: null, status: "idle", preview: null, error: null });
      await loadInstalled();
    } catch (error) {
      setAction((current) => ({ ...current, status: "review", error: error.message }));
    }
  };

  const toggle = async (skill) => {
    if (action.status !== "idle") return;
    setAction({ id: skill.id, status: "toggling", preview: null, error: null });
    try {
      await projectWorkApi.setSkillEnabled({
        name: skill.name,
        enabled: !(skill.enabledPreference ?? skill.enabled),
      });
      setAction({ id: null, status: "idle", preview: null, error: null });
      await loadInstalled();
    } catch (error) {
      setAction({ id: skill.id, status: "idle", preview: null, error: error.message });
    }
  };

  const installedCount = installedState.packages.length;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="skill-dialog" role="dialog" aria-modal="true" aria-labelledby="skill-center-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="skill-dialog-header">
          <div className="skill-dialog-title">
            <span className="skill-dialog-icon"><Package size={20} weight="regular" aria-hidden="true" /></span>
            <div>
              <span className="eyebrow">Pi Package Catalog</span>
              <h2 id="skill-center-title">技能中心</h2>
              <p>只显示本机安装项和已经确认的候选。</p>
            </div>
          </div>
          <div className="skill-dialog-header-actions">
            <a
              className="skill-official-link"
              href={PI_SKILL_CATALOG_URL}
              target="_blank"
              rel="noreferrer"
            >
              查看 Pi 官方 Skill
              <ArrowSquareOut size={14} aria-hidden="true" />
            </a>
            <button className="icon-button" type="button" aria-label="关闭 Skill 中心" onClick={onClose}>
              <X size={19} aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className="skill-toolbar">
          <label className="search-field skill-search" htmlFor="skill-search">
            <MagnifyingGlass size={15} aria-hidden="true" />
            <input id="skill-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索当前列表" />
          </label>
          <div className="segmented-control" aria-label="筛选 Skill">
            <button className={view === "installed" ? "is-active" : ""} type="button" onClick={() => setView("installed")}>已安装 {installedCount}</button>
            <button className={view === "candidates" ? "is-active" : ""} type="button" onClick={() => setView("candidates")}>已确认候选 {REVIEWED_SKILL_CANDIDATES.length}</button>
          </div>
        </div>

        <div className="skill-list">
          {catalogState.status === "loading" && view === "candidates" ? (
            <div className="skill-loading" role="status">
              <SpinnerGap className="spin" size={17} aria-hidden="true" />
              正在核对已确认候选…
            </div>
          ) : null}
          {catalogState.error && view === "candidates" ? (
            <div className="skill-catalog-error" role="alert">
              <WarningCircle size={17} aria-hidden="true" />
              <span>{catalogState.error}</span>
            </div>
          ) : null}
          {installedState.error && view === "installed" ? (
            <div className="skill-catalog-error" role="alert">
              <WarningCircle size={17} aria-hidden="true" />
              <span>{installedState.error}</span>
            </div>
          ) : null}

          {visibleSkills.map((skill) => {
            const installing = action.id === skill.id && action.status === "inspecting";
            const toggling = action.id === skill.id && action.status === "toggling";
            const enabledPreference = skill.enabledPreference ?? skill.enabled;
            const canUpgrade = Boolean(
              skill.installed
              && skill.version
              && skill.installedVersion
              && skill.version !== skill.installedVersion,
            );
            const actionError = action.id === skill.id && action.status === "idle"
              ? action.error
              : null;
            return (
              <article
                className={`skill-row${skill.kind === "workflow" || skill.enabled ? " is-enabled" : ""}`}
                key={`${skill.kind}:${skill.id}`}
              >
                <span className="skill-row-icon"><Package size={19} weight="regular" aria-hidden="true" /></span>
                <div className="skill-row-copy">
                  <div className="skill-row-title">
                    <h3>{skill.name}</h3>
                    <span>{skill.kind === "workflow" ? skill.category : "Skill"}</span>
                    {skill.runtimeCompatible === false ? <span>不兼容</span> : null}
                    <small>
                      {skill.kind === "workflow"
                        ? skill.source
                        : skill.bundled || skill.source?.startsWith("bundled:")
                          ? `${skill.version || "最新"} · Pi Agent 内置`
                          : `${skill.version || "最新"} · ${formatDownloads(skill.downloads)}`}
                    </small>
                  </div>
                  <p>{skill.description || "这个包没有提供说明。"}</p>
                  <div className="skill-state-line">
                    {skill.installed
                      ? <CheckCircle size={14} weight="fill" aria-hidden="true" />
                      : <DownloadSimple size={14} aria-hidden="true" />}
                    <span>{packageStateLine(skill)}</span>
                    {skill.catalogUrl ? (
                      <a href={skill.catalogUrl} target="_blank" rel="noreferrer" aria-label={`查看 ${skill.name} 的 Pi 目录页面`}>
                        <ArrowSquareOut size={13} aria-hidden="true" />
                      </a>
                    ) : null}
                  </div>
                  {skill.effectScopes?.length ? (
                    <div className="skill-state-line">
                      <ShieldCheck size={14} aria-hidden="true" />
                      <span>
                        效果：
                        {skill.effectScopes.map((effect) => effect.label).join("；")}
                      </span>
                    </div>
                  ) : null}
                  {actionError ? <div className="skill-action-error" role="alert">{actionError}</div> : null}
                </div>
                <div className="skill-row-action">
                  {skill.kind === "workflow" ? (
                    <span className="skill-builtin-label">按需</span>
                  ) : skill.installed ? (
                    <>
                      {canUpgrade ? (
                        <button
                          className="download-button"
                          type="button"
                          onClick={() => inspect(skill)}
                          disabled={installing}
                        >
                          {installing
                            ? <SpinnerGap className="spin" size={15} aria-hidden="true" />
                            : <DownloadSimple size={15} weight="bold" aria-hidden="true" />}
                          {installing ? "检查中" : "检查升级"}
                        </button>
                      ) : null}
                      <button
                        className={`switch-control${enabledPreference ? " is-on" : ""}`}
                        type="button"
                        role="switch"
                        aria-checked={enabledPreference}
                        aria-label={`${enabledPreference ? "停用" : "启用"}${skill.name}`}
                        onClick={() => toggle(skill)}
                        disabled={
                          toggling
                          || (skill.runtimeCompatible === false && !enabledPreference)
                        }
                        title={skill.runtimeCompatible === false
                          ? skill.compatibilityReason
                          : undefined}
                      >
                        <span>
                          {toggling
                            ? <SpinnerGap className="spin" size={11} aria-hidden="true" />
                            : enabledPreference
                              ? <Check size={12} weight="bold" aria-hidden="true" />
                              : null}
                        </span>
                      </button>
                    </>
                  ) : (
                    <button
                      className="download-button"
                      type="button"
                      onClick={() => inspect(skill)}
                      disabled={installing || !skill.installSupported}
                      title={skill.unsupportedReason || undefined}
                    >
                      {installing
                        ? <SpinnerGap className="spin" size={15} aria-hidden="true" />
                        : <DownloadSimple size={15} weight="bold" aria-hidden="true" />}
                      {installing ? "检查中" : skill.installSupported ? "检查并安装" : "暂不支持"}
                    </button>
                  )}
                </div>
              </article>
            );
          })}

          {visibleSkills.length === 0 && catalogState.status !== "loading" ? (
            <div className="skill-empty-state">
              <span><Package size={25} weight="regular" aria-hidden="true" /></span>
              <h3>{view === "installed" ? "没有安装任何 Skill" : "没有匹配的已确认候选"}</h3>
              <p>{view === "installed" ? "候选安装后会先保持停用。" : "换一个关键词再试试。"}</p>
            </div>
          ) : null}
        </div>

        <footer className="skill-dialog-footer">
          <div>
            <ShieldCheck size={17} weight="regular" aria-hidden="true" />
            <p>
              <strong>保持上下文清爽</strong>
              <span>安装不会自动启用；启用后只加载 Skill 描述与按需说明，不开放 Extension。</span>
            </p>
          </div>
          <button className="primary-action" type="button" onClick={onClose}>完成</button>
        </footer>
      </section>

      <SkillInstallReview
        preview={action.preview}
        status={action.status}
        error={action.error}
        onConfirm={install}
        onCancel={() => {
          if (action.status !== "installing") {
            setAction({ id: null, status: "idle", preview: null, error: null });
          }
        }}
      />
    </div>
  );
}
