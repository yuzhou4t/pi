import {
  CaretDown,
  Check,
  Cloud,
  Sparkle,
} from "@phosphor-icons/react";
import { getModelDisplayName } from "../data.js";

const providerIcons = {
  "codex-subscription": Sparkle,
  "openai-codex": Sparkle,
  deepseek: Cloud,
};

const statusLabels = {
  checking: "检查中",
  available: "可用",
  ready: "可用",
  unavailable: "不可用",
};

const reasonLabels = {
  CATALOG_LOADING: "正在读取本机状态",
  CODEX_CLI_MISSING: "未找到 Codex CLI",
  CODEX_AUTH_NOT_CHATGPT: "Codex 未使用 ChatGPT 订阅登录",
  CODEX_NOT_INSTALLED: "未找到 Codex",
  NOT_CHATGPT_SUBSCRIPTION: "Codex 未使用 ChatGPT 订阅登录",
  CODEX_STATUS_TIMEOUT: "Codex 状态检查超时",
  CODEX_STATUS_FAILED: "Codex 状态检查失败",
  CODEX_NOT_AUTHENTICATED: "Codex 尚未登录",
  CODEX_UNAVAILABLE: "Codex 当前不可用",
  DEEPSEEK_API_KEY_MISSING: "尚未配置 API Key",
  MISSING_DEEPSEEK_API_KEY: "尚未配置 API Key",
  DEEPSEEK_NOT_CONFIGURED: "尚未配置 API Key",
  API_KEY_MISSING: "待填写 API Key",
  PROVIDER_NOT_REPORTED: "本机服务未报告状态",
};

export const THINKING_LEVEL_LABELS = {
  off: "关闭",
  minimal: "极低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "很高",
  max: "最高",
};

function getProviderStatus(item) {
  if (item.available) return statusLabels[item.status] ?? item.status ?? "可用";
  return reasonLabels[item.reasonCode] ?? statusLabels[item.status] ?? item.status ?? "不可用";
}

export function ProviderMenu({
  open,
  onOpenChange,
  providers,
  providerId,
  model,
  onProviderChange,
  onModelChange,
  thinkingLevels = null,
  thinkingLevel = null,
  supportsThinking = false,
  thinkingDisabled = false,
  thinkingHint = "选择下一轮使用的思考强度",
  onThinkingLevelChange,
}) {
  const activeProvider = providers.find((item) => item.id === providerId) ?? providers[0];
  const levels = Array.isArray(thinkingLevels)
    ? thinkingLevels.filter((level) => typeof level === "string" && level)
    : null;
  const showThinking = levels !== null;
  const activeThinkingLevel = levels?.includes(thinkingLevel)
    ? thinkingLevel
    : levels?.[0] ?? "off";
  const thinkingLabel = supportsThinking
    ? THINKING_LEVEL_LABELS[activeThinkingLevel] ?? activeThinkingLevel
    : "不支持";
  const thinkingControlDisabled = !supportsThinking
    || levels?.length === 0
    || thinkingDisabled;
  const triggerLabel = showThinking
    ? `${activeProvider.name} · 思考 · ${thinkingLabel}`
    : activeProvider.name;

  return (
    <div className="provider-menu-wrap">
      {open ? (
        <button
          className="popover-scrim"
          type="button"
          aria-label="关闭服务商菜单"
          onClick={() => onOpenChange(false)}
        />
      ) : null}

      <button
        className="header-meta-pill header-model-pill"
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => onOpenChange(!open)}
      >
        <Sparkle size={13} weight="fill" aria-hidden="true" />
        <span>{triggerLabel}</span>
        <CaretDown size={11} weight="bold" aria-hidden="true" />
      </button>

      {open ? (
        <section className="provider-popover" aria-label="切换模型服务商">
          <header className="popover-header">
            <div>
              <strong>模型服务商</strong>
              <span>配置保留在本机</span>
            </div>
          </header>

          <div className="provider-list">
            {providers.map((item) => {
              const Icon = providerIcons[item.id] ?? Cloud;
              const selected = item.id === providerId && item.available;
              const status = getProviderStatus(item);
              return (
                <button
                  className={`provider-option${selected ? " is-selected" : ""}`}
                  type="button"
                  key={item.id}
                  disabled={!item.available}
                  title={item.available ? undefined : status}
                  onClick={() => onProviderChange(item.id)}
                >
                  <span className="provider-option-icon">
                    <Icon size={17} weight="regular" aria-hidden="true" />
                  </span>
                  <span className="provider-option-copy">
                    <strong>{item.name}</strong>
                    <small>{item.hint}</small>
                  </span>
                  {selected && item.available ? <Check size={15} weight="bold" aria-hidden="true" /> : <span className="provider-option-status">{status}</span>}
                </button>
              );
            })}
          </div>

          <label className="model-select-label" htmlFor="model-select">
            <span>当前模型</span>
            <select
              id="model-select"
              value={model}
              disabled={!activeProvider.available || activeProvider.models.length === 0}
              onChange={(event) => onModelChange(event.target.value)}
            >
              {activeProvider.models.map((item) => (
                <option value={item} key={item}>{getModelDisplayName(item)}</option>
              ))}
            </select>
          </label>

          {showThinking ? (
            <label
              className="model-select-label provider-thinking-select"
              htmlFor="provider-thinking-select"
              title={thinkingHint}
            >
              <span>思考强度</span>
              <select
                id="provider-thinking-select"
                aria-label="GPT 订阅思考强度"
                value={activeThinkingLevel}
                disabled={thinkingControlDisabled}
                onChange={(event) => onThinkingLevelChange?.(event.target.value)}
              >
                {!supportsThinking || levels.length === 0 ? (
                  <option value="off">思考 · 不支持</option>
                ) : levels.map((level) => (
                  <option value={level} key={level}>
                    {`思考 · ${THINKING_LEVEL_LABELS[level] ?? level}`}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <p className="provider-safety-note">
            凭据只由本机服务读取，不会进入浏览器或项目记录。
          </p>
        </section>
      ) : null}
    </div>
  );
}
