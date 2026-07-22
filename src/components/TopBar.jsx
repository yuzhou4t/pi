import {
  Export,
  Package,
  Sparkle,
} from "@phosphor-icons/react";
import { ProviderMenu } from "./ProviderMenu.jsx";

export function TopBar({
  project,
  providers,
  providerId,
  model,
  providerOpen,
  onProviderOpenChange,
  onProviderChange,
  onModelChange,
  onOpenSkills,
  installedSkillCount,
  onExport,
  exportLabel = "导出草稿",
}) {
  return (
    <header className="topbar">
      <div className="brand-lockup">
        <span className="brand-icon">
          <Sparkle size={17} weight="fill" aria-hidden="true" />
        </span>
        <span className="brand-name">Pi Agent</span>
        <span className="brand-name-mobile">Pi</span>
      </div>

      <div className="topbar-project" title={project.name}>
        <span>当前工作区</span>
        <strong>{project.name}</strong>
      </div>

      <div className="topbar-actions">
        <ProviderMenu
          open={providerOpen}
          onOpenChange={onProviderOpenChange}
          providers={providers}
          providerId={providerId}
          model={model}
          onProviderChange={onProviderChange}
          onModelChange={onModelChange}
        />

        <button className="compact-action topbar-skill-button" type="button" onClick={onOpenSkills}>
          <Package size={16} weight="regular" aria-hidden="true" />
          <span>技能</span>
          <b>{installedSkillCount}</b>
        </button>

        <button className="primary-action topbar-export" type="button" onClick={onExport}>
          <Export size={16} weight="bold" aria-hidden="true" />
          <span>{exportLabel}</span>
        </button>
      </div>
    </header>
  );
}
