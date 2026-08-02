import { useCallback, useRef, useState } from "react";
import { SidebarSimple } from "@phosphor-icons/react";
import { usePersistentState } from "../hooks/usePersistentState.js";

const MIN_AGENT_RATIO = 0.25;
const MAX_AGENT_RATIO = 0.75;

function clampRatio(value, fallback = 0.5) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(MAX_AGENT_RATIO, Math.max(MIN_AGENT_RATIO, value));
}

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
  closedLabel = "打开右侧",
  openLabel = "收起右侧",
  closedTitle = "打开右侧工件",
  openTitle = "收起右侧工件",
  resizeLabel = "拖拽调整对话与工件的宽度",
}) {
  // The agent/artifact split is a free ratio (25%–75%) so the reader can give
  // either column roughly half of the workspace; it persists across sessions.
  const [agentRatio, setAgentRatio] = usePersistentState("pi-agent-artifact-ratio", 0.5);
  const [resizing, setResizing] = useState(false);
  const [internalArtifactOpen, setInternalArtifactOpen] = useState(false);
  const bodyRef = useRef(null);
  const artifactOpen = controlledArtifactOpen ?? internalArtifactOpen;
  const setArtifactOpen = onArtifactOpenChange ?? setInternalArtifactOpen;

  const startAgentResizing = useCallback((event) => {
    event.preventDefault();
    const bodyWidth = bodyRef.current?.getBoundingClientRect()?.width;
    if (!bodyWidth) return;
    setResizing(true);
    const startX = event.clientX;
    const startRatio = clampRatio(agentRatio);
    let rafId = null;

    const onMove = (moveEvent) => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        setAgentRatio(clampRatio(startRatio + (moveEvent.clientX - startX) / bodyWidth));
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
  }, [agentRatio, setAgentRatio]);

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

      <div
        ref={bodyRef}
        className={`reading-workbench-body${artifactOpen ? " is-artifact-open" : ""}`}
      >
        <div
          className={`reading-agent-pane${agentMobileActive ? " is-mobile-active" : ""}`}
          style={artifactOpen ? { width: `${clampRatio(agentRatio) * 100}%` } : undefined}
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
