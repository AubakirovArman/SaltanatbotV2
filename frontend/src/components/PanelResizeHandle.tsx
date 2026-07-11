import { useRef } from "react";

interface PanelResizeHandleProps {
  side: "left" | "right";
  value: number;
  min: number;
  max: number;
  label: string;
  onResize: (value: number) => void;
}

/** Pointer and keyboard-operable separator for terminal side panels. */
export function PanelResizeHandle({ side, value, min, max, label, onResize }: PanelResizeHandleProps) {
  const origin = useRef<{ x: number; value: number }>();
  const clamp = (next: number) => Math.min(max, Math.max(min, next));
  return (
    <div
      className={`panel-resize-handle ${side}`}
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      tabIndex={0}
      onKeyDown={(event) => {
        const direction = side === "left" ? 1 : -1;
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          onResize(clamp(value - 16 * direction));
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          onResize(clamp(value + 16 * direction));
        } else if (event.key === "Home") {
          event.preventDefault();
          onResize(min);
        } else if (event.key === "End") {
          event.preventDefault();
          onResize(max);
        }
      }}
      onPointerDown={(event) => {
        origin.current = { x: event.clientX, value };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!origin.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const direction = side === "left" ? 1 : -1;
        onResize(clamp(origin.current.value + (event.clientX - origin.current.x) * direction));
      }}
      onPointerUp={(event) => {
        origin.current = undefined;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }}
    />
  );
}
