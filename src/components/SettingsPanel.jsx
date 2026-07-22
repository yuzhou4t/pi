import {
  CaretRight,
  Command,
  Cpu,
  Database,
  FolderSimple,
  GearSix,
  Package,
  Palette,
  ShieldCheck,
  X,
} from "@phosphor-icons/react";

const sections = [
  { id: "general", label: "常规", icon: GearSix },
  { id: "providers", label: "模型服务商", icon: Cpu },
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
      <span><strong>{label}</strong><small>{detail}</small></span>
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
            <span className="eyebrow">快速入口</span>
            <h2 id="quick-settings-title">设置</h2>
          </div>
          <button className="icon-button" type="button" aria-label="关闭设置" onClick={onClose} autoFocus>
            <X size={17} aria-hidden="true" />
          </button>
        </header>

        <div className="quick-setting-list">
          <QuickSetting icon={Cpu} label="模型与服务商" detail={`${providerName} · ${model}`} onClick={() => onOpenFull("providers")} />
          <QuickSetting icon={Package} label="技能中心" detail="管理 Agent 能力扩展包" onClick={onOpenSkills ?? (() => onOpenFull("skills"))} />
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

function SettingRow({ label, detail, value, action, disabled = false }) {
  return (
    <div className="setting-row">
      <div><strong>{label}</strong><span>{detail}</span></div>
      {action ? (
        <button className="compact-action" type="button" onClick={action} disabled={disabled}>{value}</button>
      ) : (
        <span className={`setting-value${disabled ? " is-muted" : ""}`}>{value}</span>
      )}
    </div>
  );
}

function SettingsContent({ section, providerName, model, onOpenProvider }) {
  if (section === "providers") {
    return (
      <>
        <div className="settings-section-heading">
          <span className="eyebrow">连接</span>
          <h2>模型服务商</h2>
          <p>当前只保留服务商与模型选择；API 密钥不会写进这个前端原型。</p>
        </div>
        <div className="settings-card">
          <SettingRow label="当前服务商" detail="用于此工作区的新请求" value={providerName} />
          <SettingRow label="当前模型" detail="由服务商菜单切换" value={model} />
          <SettingRow label="服务商菜单" detail="回到主界面的真实切换入口" value="切换" action={onOpenProvider} />
        </div>
      </>
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
          <SettingRow label="颜色模式" detail="当前原型的唯一完成主题" value="浅色" />
          <SettingRow label="深色模式" detail="等整体界面稳定后再设计" value="稍后开放" disabled />
          <SettingRow label="界面密度" detail="保持信息紧凑，不做大卡片堆叠" value="紧凑" />
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
          <p>V1 只演示期刊追踪与精读的项目、Run 和产物流转，尚未读取真实项目。</p>
        </div>
        <div className="settings-card">
          <SettingRow label="工作目录" detail="Pi Agent 的正式开发位置" value="/Users/yuzhou4tc/Public/pi Agent" />
          <SettingRow label="V1 演示数据" detail="项目、Run 与产物均使用本地 fixture" value="已启用" />
          <SettingRow label="本地存储" detail="原型配置只存浏览器本地" value="已启用" />
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
          <p>V1 只演示权限与确认交互，不会读取真实项目或执行正式写入。</p>
        </div>
        <div className="settings-card">
          <SettingRow label="读取真实项目" detail="当前界面只使用演示数据" value="关闭" />
          <SettingRow label="保存 API 密钥" detail="密钥应由未来的安全配置层管理" value="关闭" />
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
        <p>当前设置对应“期刊追踪与精读”V1 交互演示，尚未接入真实数据与外部写入。</p>
      </div>
      <div className="settings-card">
        <SettingRow label="界面语言" detail="所有用户界面使用简体中文" value="简体中文" />
        <SettingRow label="产品阶段" detail="验证首个完整工作流的按钮、状态与确认路径" value="V1 演示" />
        <SettingRow label="技能" detail="工作流内部能力暂不作为市场条目展示" value="0 个" />
      </div>
    </>
  );
}

export function SettingsDialog({ section, onSectionChange, providerName, model, onOpenProvider, onClose }) {
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
            <span className="eyebrow">V1 演示设置</span>
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
            <SettingsContent section={section} providerName={providerName} model={model} onOpenProvider={onOpenProvider} />
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
