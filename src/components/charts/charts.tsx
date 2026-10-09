"use client";

import { useState, type ReactNode } from "react";
import { Box, Group, Paper, SegmentedControl, Stack, Table, Text, Tooltip } from "@mantine/core";
import { IconChartBar, IconTable } from "@tabler/icons-react";
import { BUCKETS, type HealthBucket } from "../flux/status";
import classes from "./charts.module.css";

/**
 * Card with a title, optional legend, and a chart/table toggle: every chart
 * has a table twin so no value is reachable only by hovering.
 */
export function ChartCard({
  title,
  subtitle,
  legend,
  chart,
  table,
}: {
  title: string;
  subtitle?: ReactNode;
  legend?: ReactNode;
  chart: ReactNode;
  table: ReactNode;
}) {
  const [mode, setMode] = useState("chart");
  return (
    <Paper withBorder radius="md" p="md" className={classes.charts}>
      <Stack gap="sm">
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Box>
            <Text fw={600}>{title}</Text>
            {subtitle && (
              <Text size="xs" c="dimmed">
                {subtitle}
              </Text>
            )}
          </Box>
          <SegmentedControl
            size="xs"
            value={mode}
            onChange={setMode}
            data={[
              { value: "chart", label: <IconChartBar size={14} aria-label="Chart view" /> },
              { value: "table", label: <IconTable size={14} aria-label="Table view" /> },
            ]}
          />
        </Group>
        {mode === "chart" && legend}
        {mode === "chart" ? chart : table}
      </Stack>
    </Paper>
  );
}

export interface LegendItem {
  label: string;
  cssVar: string;
  Icon: typeof IconTable;
}

/** Swatch + icon + label, so identity never rests on color alone. */
export function Legend({ items }: { items: LegendItem[] }) {
  return (
    <Group gap="md">
      {items.map(({ label, cssVar, Icon }) => (
        <Group key={label} gap={6}>
          <span className={classes.swatch} style={{ background: cssVar }} />
          <Icon size={14} />
          <Text size="xs" c="dimmed">
            {label}
          </Text>
        </Group>
      ))}
    </Group>
  );
}

export function StatusLegend() {
  return <Legend items={BUCKETS} />;
}

/** Space kept after the longest bar for its value label. */
const VALUE_ROOM = "64px";

/**
 * Bar length as a share of a constant track (minus room for the value), so
 * lengths stay comparable however wide each row's value label is.
 */
const barWidth = (ratio: number) => `calc((100% - ${VALUE_ROOM}) * ${ratio})`;

export interface StackedRow {
  label: string;
  counts: Record<HealthBucket, number>;
}

const total = (r: StackedRow) => BUCKETS.reduce((n, b) => n + r.counts[b.key], 0);

/** Horizontal stacked bars, one per row, lengths comparable across rows. */
export function StackedBars({
  rows,
  unit,
  onRowClick,
}: {
  rows: StackedRow[];
  unit: string;
  onRowClick?: (label: string) => void;
}) {
  const max = Math.max(1, ...rows.map(total));
  return (
    <Stack gap={6}>
      {rows.map((row) => {
        const sum = total(row);
        return (
          <Group
            key={row.label}
            gap="sm"
            wrap="nowrap"
            className={onRowClick ? classes.clickableRow : undefined}
            onClick={onRowClick && (() => onRowClick(row.label))}
            px={4}
          >
            <Text size="xs" c="dimmed" w={150} truncate="end" title={row.label}>
              {row.label}
            </Text>
            <div className={classes.track}>
              <div className={classes.hbar} style={{ width: barWidth(sum / max) }}>
                {BUCKETS.filter((b) => row.counts[b.key] > 0).map((b) => (
                  <Tooltip
                    key={b.key}
                    withArrow
                    label={`${row.counts[b.key]} ${b.label.toLowerCase()} of ${sum} ${unit} in ${row.label}`}
                  >
                    <div
                      className={classes.segment}
                      tabIndex={0}
                      style={{ flex: row.counts[b.key], background: b.cssVar }}
                    />
                  </Tooltip>
                ))}
              </div>
              <Text size="xs" fw={500} style={{ fontVariantNumeric: "tabular-nums" }}>
                {sum}
              </Text>
            </div>
          </Group>
        );
      })}
    </Stack>
  );
}

export function StackedTable({ rows, first }: { rows: StackedRow[]; first: string }) {
  return (
    <Table striped fz="xs" style={{ fontVariantNumeric: "tabular-nums" }}>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>{first}</Table.Th>
          {BUCKETS.map((b) => (
            <Table.Th key={b.key} ta="right">
              {b.label}
            </Table.Th>
          ))}
          <Table.Th ta="right">Total</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {rows.map((r) => (
          <Table.Tr key={r.label}>
            <Table.Td>{r.label}</Table.Td>
            {BUCKETS.map((b) => (
              <Table.Td key={b.key} ta="right">
                {r.counts[b.key]}
              </Table.Td>
            ))}
            <Table.Td ta="right" fw={600}>
              {total(r)}
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

/** Single-series horizontal bars with the value at the tip. */
export function ValueBars({
  rows,
  format,
}: {
  rows: { key: string; label: ReactNode; value: number; tooltip: string }[];
  format: (v: number) => string;
}) {
  const max = Math.max(1e-9, ...rows.map((r) => r.value));
  return (
    <Stack gap={6}>
      {rows.map((r) => (
        <Group key={r.key} gap="sm" wrap="nowrap" px={4}>
          <Box w={190} style={{ minWidth: 0 }}>
            {r.label}
          </Box>
          <div className={classes.track}>
            <Tooltip label={r.tooltip} withArrow>
              <div className={classes.hbar} style={{ width: barWidth(r.value / max) }}>
                <div className={classes.segment} tabIndex={0} style={{ flex: 1, background: "var(--series-1)" }} />
              </div>
            </Tooltip>
            <Text size="xs" fw={500} style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
              {format(r.value)}
            </Text>
          </div>
        </Group>
      ))}
    </Stack>
  );
}

/** Round a max up to a clean axis value and return ~4 evenly spaced ticks. */
export function niceTicks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const rough = max / 4;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= rough) ?? 10 * pow;
  const top = Math.ceil(max / step) * step;
  return Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
}

export interface ColumnDatum {
  key: string;
  /** Axis label, shown for a few columns only. */
  label: string;
  showLabel: boolean;
  tooltip: string;
  segments: { value: number; cssVar: string }[];
}

/** Stacked column chart with a clean y-axis and a per-column hover target. */
export function Columns({ data, height = 160 }: { data: ColumnDatum[]; height?: number }) {
  const max = Math.max(0, ...data.map((d) => d.segments.reduce((n, s) => n + s.value, 0)));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1];
  return (
    <Box>
      <Group gap={6} wrap="nowrap" align="stretch">
        <Box h={height} pos="relative" w={24}>
          {ticks.map((t) => (
            <Text
              key={t}
              size="10px"
              c="dimmed"
              ta="right"
              pos="absolute"
              right={0}
              style={{ bottom: `calc(${(t / top) * 100}% - 7px)`, fontVariantNumeric: "tabular-nums" }}
            >
              {t.toLocaleString()}
            </Text>
          ))}
        </Box>
        <Box style={{ flex: 1 }}>
          <div className={classes.plot} style={{ height }}>
            {ticks.slice(1).map((t) => (
              <div key={t} className={classes.gridline} style={{ bottom: `${(t / top) * 100}%` }} />
            ))}
            <div className={classes.columns}>
              {data.map((d) => (
                <Tooltip key={d.key} label={d.tooltip} withArrow multiline>
                  <div className={classes.slot} tabIndex={0}>
                    {d.segments
                      .filter((s) => s.value > 0)
                      .map((s, i) => (
                        <div
                          key={i}
                          className={classes.column}
                          style={{ height: `calc(${(s.value / top) * 100}% - 2px)`, background: s.cssVar }}
                        />
                      ))}
                  </div>
                </Tooltip>
              ))}
            </div>
          </div>
          <Box pos="relative" h={18}>
            {data.map((d, i) =>
              d.showLabel ? (
                <Text
                  key={d.key}
                  size="10px"
                  c="dimmed"
                  pos="absolute"
                  top={4}
                  style={{ left: `${((i + 0.5) / data.length) * 100}%`, transform: "translateX(-50%)", whiteSpace: "nowrap" }}
                >
                  {d.label}
                </Text>
              ) : null,
            )}
          </Box>
        </Box>
      </Group>
    </Box>
  );
}
