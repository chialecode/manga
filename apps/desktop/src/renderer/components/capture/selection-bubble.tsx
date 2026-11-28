import type { CSSProperties, ReactNode } from "react";

export type SelectionBubbleAction = {
  id: string;
  testId: string;
  label: string;
  icon?: ReactNode;
  accent?: boolean;
  disabled?: boolean;
  onClick: () => void;
};

/**
 * Unified floating action bubble for reader selections and intervals:
 * - Novel text selection (记笔记 / 问 Agent / 复制)
 * - Comic drawn region (记笔记 / 问 Agent / 保存截图 / 取消)
 * - Video A-B interval (记笔记 / 问 Agent / 加入粗剪 / 清除区间)
 */
export function SelectionBubble(props: {
  kind: "novel" | "comic" | "video";
  label: string;
  badge?: string;
  /** Viewport coordinates for floating placement; omitted when `inline` is true. */
  anchor?: { x: number; y: number };
  /** Inline positioning (e.g. centered above video controls, lifted by `--player-lift`). */
  inline?: boolean;
  actions: readonly SelectionBubbleAction[];
  extra?: ReactNode;
}) {
  const style: CSSProperties | undefined = (() => {
    if (props.inline || !props.anchor) return undefined;
    const vw = typeof window !== "undefined" ? (window.innerWidth || 1280) : 1280;
    const vh = typeof window !== "undefined" ? (window.innerHeight || 720) : 720;
    const x = Math.max(120, Math.min(vw - 120, Math.round(props.anchor.x)));
    const y = Math.max(48, Math.min(vh - 56, Math.round(props.anchor.y)));
    return { left: x, top: y };
  })();

  return (
    <div
      className={`selection-bubble ${props.inline ? "selection-bubble-inline" : "selection-bubble-floating"}`}
      data-testid="selection-bubble"
      data-kind={props.kind}
      role="toolbar"
      aria-label={props.label}
      style={style}
      onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
    >
      {props.badge ? <span className="selection-bubble-badge" data-testid="selection-bubble-badge">{props.badge}</span> : null}
      {props.actions.map((action) => (
        <button
          key={action.id}
          type="button"
          className={`selection-bubble-btn ${action.accent ? "selection-bubble-btn-accent" : ""}`}
          data-testid={action.testId}
          disabled={action.disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={action.onClick}
        >
          {action.icon}
          <span>{action.label}</span>
        </button>
      ))}
      {props.extra}
    </div>
  );
}
