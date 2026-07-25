import { useCallback, useState } from "react";
import { SidebarSimple } from "@phosphor-icons/react";

export function AgentArtifactLayout({
  ariaLabel,
  mobileActive = false,
  mobileView = "run",
  agentMobileView = "evidence",
  title,
  headerActions,
  agent,
  artifact,
  overlay = null,
  artifactOpen: controlledArtifactOpen,
  onArtifactOpenChange,
  initialAgentWidth = 460,
  minAgentWidth = 360,
  maxAgentWidth = 560,
  closedLabel = "打开右侧",
  openLabel = "收起右侧",
  closedTitle = "打开右侧工件",
  openTitle = "收起右侧工件",
  resizeLabel = "拖拽调整对话与工件的宽度",
}) {
  const [agentWidth, setAgentWidth] = useState(initialAgentWidth);
  const [resizing, setResizing] = useState(false);
  const [internalArtifactOpen, setInternalArtifactOpen] = useState(false);
  const artifactOpen = controlledArtifactOpen ?? internalArtifactOpen;
  const setArtifactOpen = onArtifactOpenChange ?? setInternalArtifactOpen;

  const startAgentResizing = useCallback((event) => {
    event.preventDefault();
    setResizing(true);
    const startX = event.clientX;
    const startWidth = agentWidth;
    let rafId = null;

    const onMove = (moveEvent) => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const nextWidth = Math.min(
          maxAgentWidth,
          Math.max(minAgentWidth, startWidth + (moveEvent.clientX - startX)),
        );
        setAgentWidth(nextWidth);
      });
    };

    const onUp = () => {
      if (rafId) cancelAnimationFrame(rafId);
      setResizing(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [agentWidth, maxAgentWidth, minAgentWidth]);

  const agentMobileActive = mobileView === agentMobileView;
  const artifactMobileActive = mobileView !== agentMobileView;

  return (
    <section
      className={`reading-workbench agent-artifact-layout${mobileActive ? " is-mobile-active" : ""}${resizing ? " is-resizing-active" : ""}`}
      aria-label={ariaLabel}
    >
      <header className="reading-workbench-topbar">
        {title}
        <div className="reading-workbench-meta">
          <button
            className={`header-meta-pill reading-agent-toggle${artifactOpen ? "" : " is-collapsed"}`}
            type="button"
            onClick={() => setArtifactOpen(!artifactOpen)}
            aria-pressed={artifactOpen}
            title={artifactOpen ? openTitle : closedTitle}
          >
            <SidebarSimple
              size={13}
              weight="regular"
              style={{ transform: "scaleX(-1)" }}
              aria-hidden="true"
            />
            <span>{artifactOpen ? openLabel : closedLabel}</span>
          </button>
          {headerActions}
        </div>
      </header>

      <div className={`reading-workbench-body${artifactOpen ? " is-artifact-open" : ""}`}>
        <div
          className={`reading-agent-pane${agentMobileActive ? " is-mobile-active" : ""}`}
          style={artifactOpen ? { width: `${agentWidth}px` } : undefined}
        >
          {agent}
        </div>

        {artifactOpen ? (
          <>
            <div
              className={`reading-pane-resizer${resizing ? " is-resizing" : ""}`}
              onMouseDown={startAgentResizing}
              role="separator"
              aria-label={resizeLabel}
              aria-orientation="vertical"
            >
              <span className="resizer-line" />
            </div>

            <div className={`reading-artifact-pane${artifactMobileActive ? " is-mobile-active" : ""}`}>
              {artifact}
            </div>
          </>
        ) : null}
      </div>

      {overlay}
    </section>
  );
}
