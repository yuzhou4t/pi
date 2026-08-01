import { CaretLeft, CaretRight } from "@phosphor-icons/react";

function periodId(period) {
  return typeof period === "string" ? period : period?.id;
}

export function adjacentPeriodId(periods, activeId, direction) {
  const items = Array.isArray(periods) ? periods : [];
  const index = items.findIndex((period) => periodId(period) === activeId);
  if (index < 0) return null;
  const nextIndex = direction === "previous" ? index - 1 : index + 1;
  return periodId(items[nextIndex]) ?? null;
}

export function PeriodNavigator({
  periods,
  activeId,
  activeLabel,
  onSelect,
}) {
  const items = Array.isArray(periods) ? periods : [];
  const activeIndex = items.findIndex((period) => periodId(period) === activeId);
  if (items.length === 0 || activeIndex < 0) return null;

  const previousId = adjacentPeriodId(items, activeId, "previous");
  const nextId = adjacentPeriodId(items, activeId, "next");
  const move = (targetId) => {
    if (targetId) onSelect?.(targetId);
  };

  return (
    <div
      className="period-navigator"
      role="group"
      aria-label="往期记录导航"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" && previousId) {
          event.preventDefault();
          move(previousId);
        }
        if (event.key === "ArrowRight" && nextId) {
          event.preventDefault();
          move(nextId);
        }
      }}
    >
      <button
        type="button"
        disabled={!previousId}
        aria-label="查看上一期"
        onClick={() => move(previousId)}
      >
        <CaretLeft size={14} weight="bold" aria-hidden="true" />
        上一期
      </button>
      <div aria-live="polite">
        <strong>{activeLabel}</strong>
        <span>第 {activeIndex + 1} 期 · 共 {items.length} 期</span>
      </div>
      <button
        type="button"
        disabled={!nextId}
        aria-label="查看下一期"
        onClick={() => move(nextId)}
      >
        下一期
        <CaretRight size={14} weight="bold" aria-hidden="true" />
      </button>
    </div>
  );
}
