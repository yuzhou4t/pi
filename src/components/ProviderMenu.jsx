import {
  CaretDown,
  Check,
  Cloud,
  Cpu,
  Database,
  HardDrives,
} from "@phosphor-icons/react";

const providerIcons = {
  deepseek: Cloud,
  "openai-compatible": Database,
  openrouter: HardDrives,
  ollama: Cpu,
};

export function ProviderMenu({
  open,
  onOpenChange,
  providers,
  providerId,
  model,
  onProviderChange,
  onModelChange,
}) {
  const activeProvider = providers.find((item) => item.id === providerId) ?? providers[0];

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
        className="compact-action header-provider-pill"
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => onOpenChange(!open)}
      >
        <Cpu size={14} weight="regular" aria-hidden="true" />
        <span>{activeProvider.name}</span>
        <CaretDown size={12} weight="bold" aria-hidden="true" />
      </button>

      {open ? (
        <section className="provider-popover" aria-label="切换模型服务商">
          <header className="popover-header">
            <div>
              <strong>模型服务商</strong>
              <span>配置保留在本机</span>
            </div>
            <span className="demo-badge">演示配置</span>
          </header>

          <div className="provider-list">
            {providers.map((item) => {
              const Icon = providerIcons[item.id] ?? Cloud;
              const selected = item.id === providerId;
              return (
                <button
                  className={`provider-option${selected ? " is-selected" : ""}`}
                  type="button"
                  key={item.id}
                  onClick={() => onProviderChange(item.id)}
                >
                  <span className="provider-option-icon">
                    <Icon size={17} weight="regular" aria-hidden="true" />
                  </span>
                  <span className="provider-option-copy">
                    <strong>{item.name}</strong>
                    <small>{item.hint}</small>
                  </span>
                  {selected ? <Check size={15} weight="bold" aria-hidden="true" /> : <span className="provider-option-status">{item.status}</span>}
                </button>
              );
            })}
          </div>

          <label className="model-select-label" htmlFor="model-select">
            <span>当前模型</span>
            <select
              id="model-select"
              value={model}
              onChange={(event) => onModelChange(event.target.value)}
            >
              {activeProvider.models.map((item) => (
                <option value={item} key={item}>{item}</option>
              ))}
            </select>
          </label>

          <p className="provider-safety-note">
            初版不保存 API Key；正式接入时从系统钥匙串或 PI 配置读取。
          </p>
        </section>
      ) : null}
    </div>
  );
}
