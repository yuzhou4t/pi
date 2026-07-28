import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowClockwise,
  ArrowSquareOut,
  CaretDown,
  CaretRight,
  ChartBar,
  CheckCircle,
  Command,
  Cpu,
  Database,
  FolderSimple,
  GearSix,
  Info,
  Key,
  Package,
  Palette,
  ShieldCheck,
  SpinnerGap,
  Trash,
  X,
} from "@phosphor-icons/react";
import { projectWorkApi } from "../api/projectWork.js";

const sections = [
  { id: "general", label: "常规", icon: GearSix },
  { id: "providers", label: "模型服务商", icon: Cpu },
  { id: "usage", label: "模型用量", icon: ChartBar },
  { id: "skills", label: "技能中心", icon: Package },
  { id: "appearance", label: "外观", icon: Palette },
  { id: "data", label: "项目与数据", icon: Database },
  { id: "shortcuts", label: "快捷键", icon: Command },
  { id: "privacy", label: "隐私与权限", icon: ShieldCheck },
];

function QuickSetting({ icon: Icon, label, detail, onClick }) {
  return (
    <button className="quick-setting-row" type="button" onClick={onClick}>
      <span className="quick-setting-icon"><Icon size={17} weight="regular" aria-hidden="true" /></span>
      <span><strong>{label}</strong>{detail ? <small>{detail}</small> : null}</span>
      <CaretRight size={14} aria-hidden="true" />
    </button>
  );
}

export function SettingsQuickPanel({ providerName, model, onOpenFull, onOpenSkills, onClose }) {
  return (
    <div className="settings-popover-layer" role="presentation" onMouseDown={onClose}>
      <section
        className="settings-quick-panel"
        role="dialog"
        aria-labelledby="quick-settings-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="settings-quick-header">
          <div>
            <h2 id="quick-settings-title">设置</h2>
          </div>
          <button className="icon-button" type="button" aria-label="关闭设置" onClick={onClose} autoFocus>
            <X size={17} aria-hidden="true" />
          </button>
        </header>

        <div className="quick-setting-list">
          <QuickSetting icon={Cpu} label="模型与服务商" detail={`${providerName} · ${model}`} onClick={() => onOpenFull("providers")} />
          <QuickSetting icon={ChartBar} label="模型用量" detail="正常工作 + 论文精读" onClick={() => onOpenFull("usage")} />
          <QuickSetting icon={Package} label="技能中心" onClick={onOpenSkills ?? (() => onOpenFull("skills"))} />
          <QuickSetting icon={Palette} label="外观" detail="浅色 · 紧凑界面" onClick={() => onOpenFull("appearance")} />
          <QuickSetting icon={FolderSimple} label="项目与本地数据" detail="仅保存在本机" onClick={() => onOpenFull("data")} />
        </div>

        <footer className="settings-quick-footer">
          <button type="button" onClick={() => onOpenFull("general")}>
            <GearSix size={15} weight="regular" aria-hidden="true" />
            打开全部设置
            <CaretRight size={13} aria-hidden="true" />
          </button>
        </footer>
      </section>
    </div>
  );
}

function SettingRow({ label, detail, value, action, href, disabled = false }) {
  return (
    <div className="setting-row">
      <div><strong>{label}</strong><span>{detail}</span></div>
      {href ? (
        <a className="compact-action" href={href} target="_blank" rel="noreferrer">
          {value}
          <ArrowSquareOut size={13} aria-hidden="true" />
        </a>
      ) : action ? (
        <button className="compact-action" type="button" onClick={action} disabled={disabled}>{value}</button>
      ) : (
        <span className={`setting-value${disabled ? " is-muted" : ""}`}>{value}</span>
      )}
    </div>
  );
}

const usagePeriods = [
  { id: "today", label: "今日" },
  { id: "7d", label: "7 天" },
  { id: "30d", label: "30 天" },
  { id: "all", label: "全部" },
];

const usageWorkflows = [
  { id: "all", label: "全部消耗" },
  { id: "project_work", label: "正常工作" },
  { id: "paper_reading", label: "论文精读" },
];

const usageStepLabels = {
  candidate_summaries: "候选解释",
  candidate_ranking: "候选排序",
  five_minute_guide: "五分钟导读",
  reading_stage: "精读整理",
  reading_question: "阶段追问",
  paper_agent: "论文 Agent",
  translation: "全文翻译",
  paper_model_call: "未完成的论文调用",
};

const integerFormatter = new Intl.NumberFormat("zh-CN", {
  maximumFractionDigits: 0,
});

function formatInteger(value) {
  return integerFormatter.format(Number(value) || 0);
}

function formatUsd(value) {
  if (!Number.isFinite(value)) return "暂无费用证据";
  const digits = Math.abs(value) < 10 ? 4 : 2;
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

function formatRate(value) {
  if (!Number.isFinite(value)) return "—";
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 4,
  })}`;
}

export function UsageSummary({ values, costNote = "基于调用时保存的费用证据" }) {
  return (
    <div className="usage-summary-strip" aria-label="模型用量汇总">
      <div>
        <span>调用</span>
        <strong>{formatInteger(values.calls)} 次</strong>
        <small>{formatInteger(values.tasks)} 项任务</small>
      </div>
      <div>
        <span>总 Tokens</span>
        <strong>{formatInteger(values.totalTokens)}</strong>
        <small>输入、输出与缓存合计</small>
      </div>
      <div>
        <span>API 等价估算</span>
        <strong>{formatUsd(values.apiEquivalentCostUsd)}</strong>
        <small>
          {values.unpricedCallCount > 0
            ? `${formatInteger(values.unpricedCallCount)} 次调用缺少费用证据`
            : costNote}
        </small>
      </div>
    </div>
  );
}

function PricingDetail({ pricing }) {
  if (!pricing) {
    return (
      <p className="usage-pricing-empty">当前模型目录没有可展示的参考单价。</p>
    );
  }
  return (
    <div className="usage-pricing">
      <strong>当前基础参考单价</strong>
      <span>每百万 Tokens</span>
      <dl>
        <div><dt>输入</dt><dd>{formatRate(pricing.input)}</dd></div>
        <div><dt>输出</dt><dd>{formatRate(pricing.output)}</dd></div>
        <div><dt>缓存读取</dt><dd>{formatRate(pricing.cacheRead)}</dd></div>
        <div><dt>缓存写入</dt><dd>{formatRate(pricing.cacheWrite)}</dd></div>
      </dl>
      {(pricing.tiers ?? []).map((tier) => (
        <div className="usage-pricing-tier" key={tier.inputTokensAbove}>
          <p>
            单次请求输入用量（含缓存读写）超过{" "}
            {formatInteger(tier.inputTokensAbove)} Tokens
          </p>
          <dl>
            <div><dt>阶梯输入</dt><dd>{formatRate(tier.input)}</dd></div>
            <div><dt>阶梯输出</dt><dd>{formatRate(tier.output)}</dd></div>
            <div><dt>阶梯缓存读取</dt><dd>{formatRate(tier.cacheRead)}</dd></div>
            <div><dt>阶梯缓存写入</dt><dd>{formatRate(tier.cacheWrite)}</dd></div>
          </dl>
        </div>
      ))}
    </div>
  );
}

function billingKindLabel(billingKind) {
  if (billingKind === "chatgpt_subscription") return "ChatGPT 订阅";
  if (billingKind === "api") return "API";
  return "计费通道未确认";
}

function workflowLabel(workflowScope) {
  return usageWorkflows.find((item) => item.id === workflowScope)?.label
    ?? "其他工作";
}

function modelFilterKey(model) {
  return `${model.workflowScope}:${model.providerId}/${model.modelId}`;
}

export function UsageModelRow({ model }) {
  const isSubscription = model.billingKind === "chatgpt_subscription";
  const hasCost = Number.isFinite(model.apiEquivalentCostUsd);
  let costNote = "金额与费率来自调用时保存的用量证据。";
  if (model.historicalBackfilledCallCount > 0) {
    costNote = `其中 ${formatInteger(model.historicalBackfilledCallCount)} 次历史调用按当前官方费率回算，只作参考，不代表调用时实际金额。`;
  } else if (isSubscription && hasCost) {
    costNote = "金额按 Pi 调用时记录的 API 参考价估算，不是 ChatGPT 订阅的实际扣款。";
  } else if (isSubscription) {
    costNote = "此订阅通道保留 Token 证据，但没有可核验的逐次 API 金额。";
  }
  return (
    <details className="usage-model-row">
      <summary>
        <span className="usage-model-identity">
          <strong>{model.modelName}</strong>
          <small>
            <span className="usage-workflow-badge">
              {workflowLabel(model.workflowScope)}
            </span>
            {model.providerName} · {billingKindLabel(model.billingKind)}
          </small>
        </span>
        <span><small>调用</small><strong>{formatInteger(model.calls)}</strong></span>
        <span><small>Tokens</small><strong>{formatInteger(model.totalTokens)}</strong></span>
        <span>
          <small>等价估算</small>
          <strong>{formatUsd(model.apiEquivalentCostUsd)}</strong>
        </span>
        <CaretDown className="usage-model-caret" size={14} aria-hidden="true" />
      </summary>
      <div className="usage-model-detail">
        <dl className="usage-token-breakdown">
          <div><dt>输入</dt><dd>{formatInteger(model.inputTokens)}</dd></div>
          <div><dt>输出</dt><dd>{formatInteger(model.outputTokens)}</dd></div>
          <div><dt>缓存读取</dt><dd>{formatInteger(model.cacheReadTokens)}</dd></div>
          <div><dt>缓存写入</dt><dd>{formatInteger(model.cacheWriteTokens)}</dd></div>
        </dl>
        {model.stepBreakdown?.length ? (
          <div className="usage-step-breakdown">
            <strong>调用环节</strong>
            <div>
              {model.stepBreakdown.map((item) => (
                <span key={item.step}>
                  {usageStepLabels[item.step] ?? item.step}
                  {" · "}
                  {formatInteger(item.calls)} 次
                </span>
              ))}
            </div>
          </div>
        ) : null}
        <PricingDetail pricing={model.currentPricing} />
        <p className="usage-cost-note">{costNote}</p>
      </div>
    </details>
  );
}

export function beginUsageLoadState(current, period, workflow = "all") {
  const keepCurrentData = (
    current.loadedPeriod === period
    && (current.loadedWorkflow ?? "all") === workflow
  );
  return {
    status: keepCurrentData && current.data ? "refreshing" : "loading",
    data: keepCurrentData ? current.data : null,
    error: null,
    loadedPeriod: keepCurrentData ? current.loadedPeriod : null,
    loadedWorkflow: keepCurrentData ? workflow : null,
  };
}

export function failUsageLoadState(current, period, workflow, error) {
  const keepCurrentData = (
    current.loadedPeriod === period
    && (current.loadedWorkflow ?? "all") === workflow
  );
  return {
    status: "error",
    data: keepCurrentData ? current.data : null,
    error,
    loadedPeriod: keepCurrentData ? current.loadedPeriod : null,
    loadedWorkflow: keepCurrentData ? workflow : null,
  };
}

function UsageSettingsContent() {
  const [period, setPeriod] = useState("30d");
  const [workflow, setWorkflow] = useState("all");
  const [modelFilter, setModelFilter] = useState("all");
  const [reloadVersion, setReloadVersion] = useState(0);
  const [state, setState] = useState({
    status: "loading",
    data: null,
    error: null,
    loadedPeriod: null,
    loadedWorkflow: null,
  });
  const reload = useCallback(() => {
    setReloadVersion((current) => current + 1);
  }, []);
  const changePeriod = useCallback((nextPeriod) => {
    if (nextPeriod === period) return;
    setModelFilter("all");
    setState({
      status: "loading",
      data: null,
      error: null,
      loadedPeriod: null,
      loadedWorkflow: null,
    });
    setPeriod(nextPeriod);
  }, [period]);
  const changeWorkflow = useCallback((nextWorkflow) => {
    if (nextWorkflow === workflow) return;
    setModelFilter("all");
    setState({
      status: "loading",
      data: null,
      error: null,
      loadedPeriod: null,
      loadedWorkflow: null,
    });
    setWorkflow(nextWorkflow);
  }, [workflow]);

  useEffect(() => {
    const controller = new AbortController();
    setState((current) => beginUsageLoadState(current, period, workflow));
    projectWorkApi.getUsage({
      period,
      workflow,
      signal: controller.signal,
    }).then((data) => {
      if (controller.signal.aborted) return;
      setState({
        status: "ready",
        data,
        error: null,
        loadedPeriod: period,
        loadedWorkflow: workflow,
      });
    }).catch((error) => {
      if (controller.signal.aborted) return;
      setState((current) => failUsageLoadState(
        current,
        period,
        workflow,
        error.message,
      ));
    });
    return () => controller.abort();
  }, [period, reloadVersion, workflow]);

  const filteredModels = useMemo(() => {
    if (!state.data) return [];
    if (modelFilter === "all") return state.data.models;
    return state.data.models.filter(
      (model) => modelFilterKey(model) === modelFilter,
    );
  }, [modelFilter, state.data]);
  useEffect(() => {
    if (
      state.data
      && modelFilter !== "all"
      && filteredModels.length === 0
    ) {
      setModelFilter("all");
    }
  }, [filteredModels.length, modelFilter, state.data]);
  const visibleTotals = modelFilter === "all"
    ? state.data?.totals
    : filteredModels[0];
  const summaryCostNote = filteredModels.some(
    (model) => model.billingKind === "chatgpt_subscription",
  )
    ? "不代表订阅实际扣费"
    : "基于调用时保存的费用证据";

  return (
    <>
      <div className="settings-section-heading usage-heading">
        <span className="eyebrow">本机记录</span>
        <h2>模型用量</h2>
        <p>统一查看正常工作与论文精读中已持久化的调用、Token 分项与 API 等价估算。</p>
      </div>

      <div className="usage-workflow-control" aria-label="统计工作类型">
        {usageWorkflows.map((item) => (
          <button
            className={workflow === item.id ? "is-active" : ""}
            type="button"
            key={item.id}
            aria-pressed={workflow === item.id}
            onClick={() => changeWorkflow(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="usage-toolbar">
        <div className="usage-period-control" aria-label="统计时间范围">
          {usagePeriods.map((item) => (
            <button
              className={period === item.id ? "is-active" : ""}
              type="button"
              key={item.id}
              aria-pressed={period === item.id}
              onClick={() => changePeriod(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="usage-toolbar-actions">
          <label>
            <span className="sr-only">筛选模型</span>
            <select
              value={modelFilter}
              onChange={(event) => setModelFilter(event.target.value)}
            >
              <option value="all">全部模型</option>
              {(state.data?.models ?? []).map((item) => (
                <option
                  key={modelFilterKey(item)}
                  value={modelFilterKey(item)}
                >
                  {workflowLabel(item.workflowScope)} · {item.modelName}
                </option>
              ))}
            </select>
          </label>
          <button
            className={`usage-refresh-button${
              state.status === "refreshing" ? " is-refreshing" : ""
            }`}
            type="button"
            aria-label="刷新模型用量"
            title="刷新模型用量"
            onClick={reload}
            disabled={state.status === "loading" || state.status === "refreshing"}
          >
            <ArrowClockwise size={15} aria-hidden="true" />
          </button>
        </div>
      </div>

      {state.status === "refreshing" ? (
        <span className="sr-only" role="status">正在刷新模型用量</span>
      ) : null}

      {state.status === "loading" ? (
        <div className="settings-card usage-status" role="status">
          正在读取本机用量记录…
        </div>
      ) : null}

      {state.status === "error" && !state.data ? (
        <div className="settings-card usage-status is-error" role="alert">
          <strong>暂时无法读取模型用量</strong>
          <span>{state.error}</span>
          <button className="compact-action" type="button" onClick={reload}>重试</button>
        </div>
      ) : null}

      {state.status === "error" && state.data ? (
        <div className="usage-refresh-error" role="alert">
          刷新失败，仍显示
          {" "}
          {usagePeriods.find((item) => item.id === state.loadedPeriod)?.label
            ?? "上一次"}
          {" · "}
          {workflowLabel(state.loadedWorkflow)}
          {" "}
          的本机记录。{state.error}
        </div>
      ) : null}

      {state.data && visibleTotals ? (
        <>
          <UsageSummary values={visibleTotals} costNote={summaryCostNote} />
          <div className="usage-scope-note">
            <Info size={16} aria-hidden="true" />
            <span>
              统一统计本机正常工作与论文精读中已有调用证据的模型消耗；账户真实剩余额度不可获取。
            </span>
          </div>

          {state.data.coverage.accessIssues.length ? (
            <div className="usage-refresh-error" role="status">
              {state.data.coverage.accessIssues.map((issue) => issue.message).join("；")}
            </div>
          ) : null}

          {filteredModels.length ? (
            <div className="usage-model-list">
              {filteredModels.map((item) => (
                <UsageModelRow
                  key={modelFilterKey(item)}
                  model={item}
                />
              ))}
            </div>
          ) : (
            <div className="settings-card usage-status">
              这个时间范围内还没有可计量的模型调用。
            </div>
          )}

          <p className="usage-coverage-note">
            {state.data.coverage.legacyMessagesWithoutUsage > 0
              ? `另有 ${formatInteger(state.data.coverage.legacyMessagesWithoutUsage)} 条旧回复没有用量证据，未计入。`
              : "正常工作中已识别的模型回复都有用量证据。"}
            {state.data.coverage.historicalLowerBound
              ? " 论文精读历史显示当前仍可核验的消耗下限。"
              : ""}
            {state.data.coverage.historicalTestCallCount > 0
              ? ` 已计入 ${formatInteger(state.data.coverage.historicalTestCallCount)} 次曾写入本机数据目录的真实模型测试调用。`
              : ""}
            {state.data.coverage.historicalBackfilledCallCount > 0
              ? ` 其中 ${formatInteger(state.data.coverage.historicalBackfilledCallCount)} 次历史 API 调用按当前官方费率回算。`
              : ""}
            {state.data.coverage.legacyTranslationArtifactsWithoutUsage > 0
              ? ` 另有 ${formatInteger(state.data.coverage.legacyTranslationArtifactsWithoutUsage)} 份旧翻译工件缺少批次用量，无法精确补回。`
              : ""}
          </p>
        </>
      ) : null}
    </>
  );
}

function ProviderSettingsContent({
  providerName,
  model,
  onOpenProvider,
  onConnectionsChanged,
}) {
  const [state, setState] = useState({
    status: "loading",
    providers: [],
    error: null,
  });
  const [selectedId, setSelectedId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [notice, setNotice] = useState(null);
  const load = useCallback(async (signal) => {
    setState((current) => ({
      status: current.providers.length ? "refreshing" : "loading",
      providers: current.providers,
      error: null,
    }));
    try {
      const providers = await projectWorkApi.listProviderConnections({ signal });
      if (signal?.aborted) return;
      setState({ status: "ready", providers, error: null });
      setSelectedId((current) => (
        providers.some((provider) => provider.id === current)
          ? current
          : providers.find((provider) => provider.configured)?.id
            ?? providers.find((provider) => provider.apiKeySupported)?.id
            ?? providers[0]?.id
            ?? ""
      ));
    } catch (error) {
      if (signal?.aborted) return;
      setState((current) => ({
        status: "error",
        providers: current.providers,
        error: error.message,
      }));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const selected = state.providers.find((provider) => provider.id === selectedId);
  const busy = state.status === "saving" || state.status === "removing";

  const save = async (event) => {
    event.preventDefault();
    if (!selected?.apiKeySupported || !apiKey.trim() || busy) return;
    setNotice(null);
    setState((current) => ({ ...current, status: "saving", error: null }));
    try {
      const providers = await projectWorkApi.saveProviderApiKey({
        providerId: selected.id,
        apiKey,
      });
      setApiKey("");
      setState({ status: "ready", providers, error: null });
      setNotice({ type: "success", text: `${selected.name} 已连接` });
      onConnectionsChanged?.();
    } catch (error) {
      setState((current) => ({
        ...current,
        status: "error",
        error: error.message,
      }));
    }
  };

  const remove = async () => {
    if (!selected?.stored || busy) return;
    setNotice(null);
    setState((current) => ({ ...current, status: "removing", error: null }));
    try {
      const providers = await projectWorkApi.removeProviderCredential({
        providerId: selected.id,
      });
      setApiKey("");
      setState({ status: "ready", providers, error: null });
      setNotice({ type: "success", text: `${selected.name} 的本机凭据已移除` });
      onConnectionsChanged?.();
    } catch (error) {
      setState((current) => ({
        ...current,
        status: "error",
        error: error.message,
      }));
    }
  };

  return (
    <>
      <div className="settings-section-heading">
        <span className="eyebrow">连接</span>
        <h2>模型服务商</h2>
        <p>凭据只交给本机 Pi 服务保存；保存后不会返回到界面。</p>
      </div>

      <div className="settings-card">
        <SettingRow label="当前服务商" detail="用于此工作区的新请求" value={providerName} />
        <SettingRow label="当前模型" detail="由服务商菜单切换" value={model} />
        <SettingRow label="服务商菜单" detail="连接后回到主界面选择模型" value="切换" action={onOpenProvider} />
      </div>

      <form className="provider-credential-card" onSubmit={save}>
        <div className="provider-credential-heading">
          <span className="provider-credential-icon">
            <Key size={18} aria-hidden="true" />
          </span>
          <div>
            <strong>连接 API 服务商</strong>
            <span>选择服务商，填写一次 API Key 并保存。</span>
          </div>
        </div>

        {state.status === "loading" ? (
          <div className="provider-credential-status" role="status">
            <SpinnerGap className="spin" size={16} aria-hidden="true" />
            正在读取 Pi 服务商目录…
          </div>
        ) : (
          <>
            <label className="provider-field">
              <span>服务商</span>
              <select
                value={selectedId}
                onChange={(event) => {
                  setSelectedId(event.target.value);
                  setApiKey("");
                  setNotice(null);
                }}
                disabled={busy}
              >
                {state.providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name}{provider.configured ? " · 已连接" : ""}
                  </option>
                ))}
              </select>
            </label>

            {selected?.apiKeySupported ? (
              <label className="provider-field">
                <span>{selected.apiKeyLabel || "API Key"}</span>
                <input
                  type="password"
                  value={apiKey}
                  autoComplete="new-password"
                  spellCheck="false"
                  placeholder={selected.configured ? "填写新 Key 以替换" : "粘贴 API Key"}
                  onChange={(event) => setApiKey(event.target.value)}
                  disabled={busy}
                />
              </label>
            ) : (
              <div className="provider-credential-note">
                {selected?.oauthSupported
                  ? "这个服务商使用账户登录，当前仍需通过 Pi 的登录流程连接。"
                  : "这个服务商需要额外的本机环境配置，不能只填写一个 API Key。"}
              </div>
            )}

            {selected ? (
              <div className="provider-connection-summary">
                <span className={selected.configured ? "is-connected" : ""}>
                  {selected.configured
                    ? <CheckCircle size={15} weight="fill" aria-hidden="true" />
                    : <Info size={15} aria-hidden="true" />}
                  {selected.configured
                    ? `${selected.availableModelCount} 个模型可用`
                    : "尚未连接"}
                </span>
                {selected.configuredSource ? <small>{selected.configuredSource}</small> : null}
              </div>
            ) : null}

            {state.error ? (
              <div className="provider-credential-error" role="alert">{state.error}</div>
            ) : null}
            {notice ? (
              <div className={`provider-credential-notice is-${notice.type}`} role="status">
                {notice.text}
              </div>
            ) : null}

            <div className="provider-credential-actions">
              {selected?.stored ? (
                <button
                  className="provider-remove-button"
                  type="button"
                  onClick={remove}
                  disabled={busy}
                >
                  <Trash size={14} aria-hidden="true" />
                  移除连接
                </button>
              ) : <span />}
              <button
                className="primary-action"
                type="submit"
                disabled={!selected?.apiKeySupported || !apiKey.trim() || busy}
              >
                {state.status === "saving"
                  ? <SpinnerGap className="spin" size={15} aria-hidden="true" />
                  : null}
                {selected?.configured ? "保存新 Key" : "保存并连接"}
              </button>
            </div>
          </>
        )}
      </form>
    </>
  );
}

function SettingsContent({
  section,
  providerName,
  model,
  onOpenProvider,
  onConnectionsChanged,
  onOpenSkills,
  installedSkillCount,
}) {
  if (section === "providers") {
    return (
      <ProviderSettingsContent
        providerName={providerName}
        model={model}
        onOpenProvider={onOpenProvider}
        onConnectionsChanged={onConnectionsChanged}
      />
    );
  }

  if (section === "appearance") {
    return (
      <>
        <div className="settings-section-heading">
          <span className="eyebrow">界面</span>
          <h2>外观</h2>
          <p>先锁定当前浅色、紧凑的基础风格，再决定是否扩展主题。</p>
        </div>
        <div className="settings-card">
          <SettingRow label="颜色模式" detail="当前唯一提供的主题" value="浅色" />
          <SettingRow label="深色模式" detail="等整体界面稳定后再设计" value="稍后开放" disabled />
          <SettingRow label="界面密度" detail="保持信息紧凑，不做大卡片堆叠" value="紧凑" />
        </div>
      </>
    );
  }

  if (section === "usage") {
    return <UsageSettingsContent />;
  }

  if (section === "skills") {
    return (
      <>
        <div className="settings-section-heading">
          <span className="eyebrow">按需能力</span>
          <h2>技能中心</h2>
          <p>同步 Pi 官方目录，只安装经过静态检查的纯 Skill 包。</p>
        </div>
        <div className="settings-card">
          <SettingRow
            label="已安装 Skill"
            detail="安装后默认停用；启用不开放 Extension"
            value={`${installedSkillCount ?? 0} 个`}
          />
          <SettingRow
            label="Pi Skill 目录"
            detail="搜索、检查、安装和启停"
            value="打开"
            action={onOpenSkills}
          />
          <SettingRow
            label="Pi 官方 Skill 网站"
            detail="在官网查看完整的 Skill 与包详情"
            value="前往官网"
            href="https://pi.dev/packages?type=skill"
          />
        </div>
      </>
    );
  }

  if (section === "data") {
    return (
      <>
        <div className="settings-section-heading">
          <span className="eyebrow">本地优先</span>
          <h2>项目与数据</h2>
          <p>管理论文工作流、项目工作会话与本机产物。</p>
        </div>
        <div className="settings-card">
          <SettingRow label="项目路径" detail="真实绝对路径只保存在本机服务端" value="受保护" />
          <SettingRow label="本地数据" detail="会话、Run、事件与工作快照保存在本地" value="已启用" />
          <SettingRow label="浏览器状态" detail="只保存工作类型、当前会话和界面偏好" value="已启用" />
        </div>
      </>
    );
  }

  if (section === "shortcuts") {
    return (
      <>
        <div className="settings-section-heading">
          <span className="eyebrow">键盘</span>
          <h2>快捷键</h2>
          <p>目前只登记已经可用的基础操作。</p>
        </div>
        <div className="settings-card shortcut-card">
          <SettingRow label="打开全部设置" detail="在主界面随时使用" value="⌘ ," />
          <SettingRow label="关闭当前浮层" detail="服务商、Skills、设置与比较窗口" value="Esc" />
          <SettingRow label="命令菜单" detail="待主流程确定后再设计" value="稍后开放" disabled />
        </div>
      </>
    );
  }

  if (section === "privacy") {
    return (
      <>
        <div className="settings-section-heading">
          <span className="eyebrow">边界</span>
          <h2>隐私与权限</h2>
          <p>写入外部工具前都会展示预览并要求显式确认。</p>
        </div>
        <div className="settings-card">
          <SettingRow label="读取真实项目" detail="只读取用户明确绑定的项目" value="已启用" />
          <SettingRow label="模型凭据" detail="只由本机服务或 Pi 配置读取，不进入浏览器" value="受保护" />
          <SettingRow label="正式写入" detail="写入 Zotero、Obsidian 或项目状态前必须展示预览并显式确认" value="需确认" />
        </div>
      </>
    );
  }

  return (
    <>
      <div className="settings-section-heading">
        <span className="eyebrow">Pi Agent</span>
        <h2>常规</h2>
        <p>当前设置同时适用于项目工作与论文工作流。</p>
      </div>
      <div className="settings-card">
        <SettingRow label="界面语言" detail="所有用户界面使用简体中文" value="简体中文" />
        <SettingRow label="产品阶段" detail="论文闭环与真实项目工作纵向切片" value="V1" />
        <SettingRow
          label="技能"
          detail="内置流程与已安装的 Pi Skill"
          value={`${installedSkillCount ?? 0} 个`}
        />
      </div>
    </>
  );
}

export function SettingsDialog({
  section,
  onSectionChange,
  providerName,
  model,
  onOpenProvider,
  onConnectionsChanged,
  onOpenSkills,
  installedSkillCount,
  onClose,
}) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="all-settings-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="settings-dialog-header">
          <div>
            <span className="eyebrow">偏好设置</span>
            <h2 id="all-settings-title">全部设置</h2>
          </div>
          <button className="icon-button" type="button" aria-label="关闭全部设置" onClick={onClose} autoFocus>
            <X size={19} aria-hidden="true" />
          </button>
        </header>

        <div className="settings-dialog-body">
          <nav className="settings-nav" aria-label="设置分类">
            {sections.map(({ id, label, icon: Icon }) => (
              <button
                className={section === id ? "is-active" : ""}
                type="button"
                key={id}
                aria-current={section === id ? "page" : undefined}
                onClick={() => onSectionChange(id)}
              >
                <Icon size={17} weight="regular" aria-hidden="true" />
                <span>{label}</span>
              </button>
            ))}
          </nav>

          <div className="settings-content">
            <SettingsContent
              section={section}
              providerName={providerName}
              model={model}
              onOpenProvider={onOpenProvider}
              onConnectionsChanged={onConnectionsChanged}
              onOpenSkills={onOpenSkills}
              installedSkillCount={installedSkillCount}
            />
          </div>
        </div>

        <footer className="settings-dialog-footer">
          <span>未实现的选项会明确标为“稍后开放”。</span>
          <button className="primary-action" type="button" onClick={onClose}>完成</button>
        </footer>
      </section>
    </div>
  );
}
