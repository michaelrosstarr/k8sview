"use client";

import { useState } from "react";
import { Box, Text } from "@mantine/core";
import { useElementSize } from "@mantine/hooks";
import { niceTicks } from "./charts";
import classes from "./charts.module.css";

export interface Point {
  t: number;
  v: number;
}

const AXIS_W = 52;
const X_AXIS_H = 18;
const timeLabel = (t: number, withSeconds: boolean) =>
  new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", ...(withSeconds ? { second: "2-digit" } : {}) });

/**
 * Single-series line over time: 2px line, ~10% area wash, hairline grid, and a
 * crosshair that snaps to the nearest sample with a value-first tooltip.
 */
export function TimeSeries({
  points,
  format,
  formatTooltip = format,
  tickUnit = 1,
  label,
  height = 170,
}: {
  points: Point[];
  /** Axis labels. */
  format: (v: number) => string;
  /** Tooltip value (defaults to the axis format); include units here. */
  formatTooltip?: (v: number) => string;
  /** Ticks are rounded in this unit, e.g. 1024³ so memory ticks land on whole GiB. */
  tickUnit?: number;
  label: string;
  height?: number;
}) {
  const { ref, width } = useElementSize();
  const [hover, setHover] = useState<number | null>(null);
  const plotW = Math.max(0, width - AXIS_W);
  const ticks = niceTicks(Math.max(0, ...points.map((p) => p.v)) / tickUnit).map((t) => t * tickUnit);
  const top = ticks[ticks.length - 1] || 1;
  const t0 = points[0]?.t ?? 0;
  const t1 = points.at(-1)?.t ?? 1;
  const x = (t: number) => (points.length < 2 ? plotW : ((t - t0) / (t1 - t0)) * plotW);
  const y = (v: number) => height - (v / top) * height;
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  const area = points.length > 1 ? `${line}L${x(t1).toFixed(1)},${height}L${x(t0).toFixed(1)},${height}Z` : "";
  const xTicks = points.length > 1 ? [0, 0.25, 0.5, 0.75, 1].map((f) => t0 + f * (t1 - t0)) : [];
  // Short histories would repeat the same minute on every tick.
  const withSeconds = t1 - t0 < 5 * 60_000;
  const h = hover !== null ? points[hover] : null;

  const nearest = (px: number) => {
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(x(points[i].t) - px) < Math.abs(x(points[best].t) - px)) best = i;
    return best;
  };

  return (
    <Box ref={ref} pos="relative" style={{ height: height + X_AXIS_H }}>
      {width > 0 && (
        <svg width={width} height={height + X_AXIS_H} role="img" aria-label={label} style={{ display: "block", overflow: "visible" }}>
          <g transform={`translate(${AXIS_W},0)`}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={0} x2={plotW} y1={y(t)} y2={y(t)} stroke={t === 0 ? "var(--axis)" : "var(--grid)"} strokeWidth={1} />
                <text x={-6} y={y(t)} dy="0.32em" textAnchor="end" fontSize={10} fill="var(--mantine-color-dimmed)" style={{ fontVariantNumeric: "tabular-nums" }}>
                  {format(t)}
                </text>
              </g>
            ))}
            {xTicks.map((t, i) => (
              <text key={i} x={x(t)} y={height + 13} textAnchor={i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"} fontSize={10} fill="var(--mantine-color-dimmed)">
                {timeLabel(t, withSeconds)}
              </text>
            ))}
            {area && <path d={area} fill="var(--series-1)" opacity={0.1} />}
            {points.length > 1 && <path d={line} fill="none" stroke="var(--series-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
            {points.length === 1 && <circle cx={x(points[0].t)} cy={y(points[0].v)} r={4} fill="var(--series-1)" stroke="var(--mantine-color-body)" strokeWidth={2} />}
            {h && (
              <g pointerEvents="none">
                <line x1={x(h.t)} x2={x(h.t)} y1={0} y2={height} stroke="var(--axis)" strokeWidth={1} />
                <circle cx={x(h.t)} cy={y(h.v)} r={4} fill="var(--series-1)" stroke="var(--mantine-color-body)" strokeWidth={2} />
              </g>
            )}
            {/* Hit layer: the whole plot, so the crosshair finds the X wherever the pointer is. */}
            <rect
              x={0}
              y={0}
              width={plotW}
              height={height}
              fill="transparent"
              tabIndex={0}
              onPointerMove={(e) => points.length && setHover(nearest(e.nativeEvent.offsetX - AXIS_W))}
              onPointerLeave={() => setHover(null)}
              onFocus={() => points.length && setHover(points.length - 1)}
              onBlur={() => setHover(null)}
              onKeyDown={(e) => {
                if (hover === null) return;
                if (e.key === "ArrowLeft") setHover(Math.max(0, hover - 1));
                if (e.key === "ArrowRight") setHover(Math.min(points.length - 1, hover + 1));
              }}
              style={{ outline: "none" }}
            />
          </g>
        </svg>
      )}
      {h && (
        <div
          className={classes.tsTooltip}
          style={{
            left: Math.min(AXIS_W + x(h.t) + 10, width - 130),
            top: Math.max(0, y(h.v) - 44),
          }}
        >
          <Text size="sm" fw={600} style={{ fontVariantNumeric: "tabular-nums" }}>
            {formatTooltip(h.v)}
          </Text>
          <Text size="xs" c="dimmed">
            {label} · {new Date(h.t).toLocaleTimeString()}
          </Text>
        </div>
      )}
    </Box>
  );
}

/** Tiny trend line for table cells: de-emphasised line, accent dot on the latest value. */
export function Sparkline({ values, width = 72, height = 20 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return <Box w={width} h={height} />;
  const max = Math.max(...values) || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * (width - 4) + 2, height - 2 - (v / max) * (height - 4)]);
  const last = pts.at(-1)!;
  return (
    <svg width={width} height={height} aria-hidden style={{ display: "block", flexShrink: 0 }}>
      <polyline points={pts.map((p) => p.join(",")).join(" ")} fill="none" stroke="var(--mantine-color-dimmed)" strokeWidth={1.5} strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r={2.5} fill="var(--series-1)" />
    </svg>
  );
}

/** Used / max meter; the fill turns warning at 80% and critical at 90%. Optional marker (e.g. requests). */
export function Meter({ value, max, marker, w = "100%" }: { value: number; max: number; marker?: number; w?: number | string }) {
  const ratio = max > 0 ? value / max : 0;
  const color = ratio >= 0.9 ? "var(--status-failing)" : ratio >= 0.8 ? "var(--status-pending)" : "var(--series-1)";
  return (
    <div className={classes.meter} style={{ width: w }} role="meter" aria-valuenow={Math.round(ratio * 100)} aria-valuemin={0} aria-valuemax={100}>
      <div className={classes.meterFill} style={{ width: `${Math.min(100, ratio * 100)}%`, background: color }} />
      {marker !== undefined && max > 0 && (
        <div className={classes.meterMarker} style={{ left: `calc(${Math.min(100, (marker / max) * 100)}% - 1px)` }} />
      )}
    </div>
  );
}
