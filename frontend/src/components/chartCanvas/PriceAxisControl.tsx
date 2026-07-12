import { useEffect, useRef } from "react";
import type { Locale } from "../../i18n";
import { shellText } from "../../i18n/shell";

export const MIN_PRICE_ZOOM = 0.25;
export const MAX_PRICE_ZOOM = 4;

export function PriceAxisControl({ locale, onZoomChange, zoom }: {
  locale: Locale;
  onZoomChange: (zoom: number) => void;
  zoom: number;
}) {
  const controlRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ clientY: number; zoom: number }>();
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  useEffect(() => {
    const control = controlRef.current;
    if (!control) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onZoomChange(priceZoomFromWheel(zoomRef.current, event.deltaY));
    };
    control.addEventListener("wheel", onWheel, { passive: false });
    return () => control.removeEventListener("wheel", onWheel);
  }, [onZoomChange]);

  const percent = Math.round(zoom * 100);
  const label = shellText(locale, "priceAxisZoom");
  return (
    <div
      ref={controlRef}
      className={`price-axis-control ${zoom === 1 ? "" : "manual"}`}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={25}
      aria-valuemax={400}
      aria-valuenow={percent}
      aria-valuetext={zoom === 1 ? (locale === "ru" ? "Автоматически" : "Automatic") : `${percent}%`}
      title={label}
      onDoubleClick={() => onZoomChange(1)}
      onKeyDown={(event) => {
        const next = priceZoomFromKey(zoom, event.key);
        if (next === undefined) return;
        event.preventDefault();
        onZoomChange(next);
      }}
      onPointerDown={(event) => {
        if (!event.isPrimary || event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = { clientY: event.clientY, zoom };
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
        onZoomChange(priceZoomFromDrag(drag.zoom, drag.clientY - event.clientY));
      }}
      onPointerUp={(event) => {
        dragRef.current = undefined;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => { dragRef.current = undefined; }}
      onLostPointerCapture={() => { dragRef.current = undefined; }}
    />
  );
}

export function priceZoomFromWheel(current: number, deltaY: number) {
  return normalizePriceZoom(current * Math.exp(-clamp(deltaY, -120, 120) * 0.0025));
}

export function priceZoomFromDrag(start: number, upwardPixels: number) {
  return normalizePriceZoom(start * Math.exp(clamp(upwardPixels, -240, 240) * 0.007));
}

export function priceZoomFromKey(current: number, key: string) {
  if (key === "Home" || key === "0") return 1;
  if (key === "ArrowUp") return normalizePriceZoom(current * 1.1);
  if (key === "ArrowDown") return normalizePriceZoom(current / 1.1);
  if (key === "PageUp") return normalizePriceZoom(current * 1.25);
  if (key === "PageDown") return normalizePriceZoom(current / 1.25);
  return undefined;
}

function normalizePriceZoom(value: number) {
  return Number(clamp(value, MIN_PRICE_ZOOM, MAX_PRICE_ZOOM).toFixed(4));
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
