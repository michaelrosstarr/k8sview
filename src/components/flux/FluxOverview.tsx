"use client";

import { useMemo } from "react";
import { Anchor, Badge, Group, Paper, SimpleGrid, Stack, Table, Text, ThemeIcon } from "@mantine/core";
import { IconCircleCheck, IconCircleX } from "@tabler/icons-react";
import { formatAge } from "@/lib/k8s";
import { WORKLOAD_KINDS, formatDuration, type FluxObject, type ObjectRef } from "@/lib/flux";
import { BUCKETS, STATUS, StatusBadge, bucketOf, type HealthBucket } from "./status";
import {
  ChartCard,
  Columns,
  Legend,
  StackedBars,
  StackedTable,
  StatusLegend,
  ValueBars,
  type ColumnDatum,
  type StackedRow,
} from "../charts/charts";
import classes from "../charts/charts.module.css";

const DAYS = 30;
const SLOWEST = 8;
const ATTENTION_LIMIT = 8;

const emptyCounts = (): Record<HealthBucket, number> => ({ ready: 0, pending: 0, failing: 0, suspended: 0 });

interface Props {
  objects: FluxObject[];
  now: number;
  onSelect: (ref: ObjectRef) => void;
  onNamespace: (ns: string) => void;
  onShowFailing: () => void;
}

export function FluxOverview({ objects, now, onSelect, onNamespace, onShowFailing }: Props) {
  const counts = useMemo(() => {
    const c = emptyCounts();
    for (const o of objects) c[bucketOf(o.status)]++;
    return c;
  }, [objects]);

  const failing = useMemo(
    () =>
      objects
        .filter((o) => o.status === "failing")
        .sort((a, b) => (b.last_transition ?? "").localeCompare(a.last_transition ?? "")),
    [objects],
  );

  const healthRows = useMemo<StackedRow[]>(() => {
    const byNs = new Map<string, Record<HealthBucket, number>>();
    for (const o of objects) {
      if (!WORKLOAD_KINDS.includes(o.kind)) continue;
      const c = byNs.get(o.namespace) ?? emptyCounts();
      c[bucketOf(o.status)]++;
      byNs.set(o.namespace, c);
    }
    const total = (c: Record<HealthBucket, number>) => c.ready + c.pending + c.failing + c.suspended;
    return [...byNs.entries()]
      .map(([label, c]) => ({ label, counts: c }))
      .sort((a, b) => b.counts.failing - a.counts.failing || total(b.counts) - total(a.counts) || a.label.localeCompare(b.label));
  }, [objects]);

  const deploys = useMemo(() => deployDays(objects, now), [objects, now]);
  const deployTotals = deploys.reduce(
    (t, d) => ({ ok: t.ok + d.ok, failed: t.failed + d.failed }),
    { ok: 0, failed: 0 },
  );

  const slowest = useMemo(
    () =>
      objects
        .filter((o) => o.kind === "HelmRelease" && o.last_action)
        .sort((a, b) => b.last_action!.duration_secs - a.last_action!.duration_secs)
        .slice(0, SLOWEST),
    [objects],
  );

  const total = objects.length;

  return (
    <Stack gap="md">
      <SimpleGrid cols={{ base: 2, md: 4 }} spacing="md">
        {BUCKETS.map((b) => {
          const meta = b.key === "pending" ? STATUS.progressing : STATUS[b.key];
          return (
            <Paper key={b.key} withBorder radius="md" p="md">
              <Group gap="xs" mb={6}>
                <ThemeIcon variant="light" color={meta.color} size="sm" radius="xl">
                  <b.Icon size={14} />
                </ThemeIcon>
                <Text size="sm" c="dimmed">
                  {b.label}
                </Text>
              </Group>
              <Text fz={28} fw={600} lh={1.1}>
                {counts[b.key].toLocaleString()}
              </Text>
              <Text size="xs" c="dimmed">
                of {total.toLocaleString()} Flux objects
              </Text>
            </Paper>
          );
        })}
      </SimpleGrid>

      <Paper withBorder radius="md" p="md">
        <Group justify="space-between" mb="xs">
          <Text fw={600}>Needs attention</Text>
          {failing.length > ATTENTION_LIMIT && (
            <Anchor size="sm" onClick={onShowFailing}>
              Show all {failing.length} failing
            </Anchor>
          )}
        </Group>
        {failing.length === 0 ? (
          <Group gap="xs">
            <IconCircleCheck size={18} color="var(--mantine-color-green-6)" />
            <Text size="sm" c="dimmed">
              Nothing is failing.
            </Text>
          </Group>
        ) : (
          <Stack gap={2}>
            {failing.slice(0, ATTENTION_LIMIT).map((o) => (
              <Group
                key={`${o.kind}/${o.namespace}/${o.name}`}
                gap="sm"
                wrap="nowrap"
                align="flex-start"
                p={6}
                className={classes.clickableRow}
                onClick={() => onSelect(o)}
              >
                <IconCircleX size={18} color="var(--mantine-color-red-6)" style={{ flexShrink: 0, marginTop: 2 }} />
                <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
                  <Group gap="xs" wrap="nowrap">
                    <Badge variant="outline" color="gray" size="xs" style={{ flexShrink: 0 }}>
                      {o.kind}
                    </Badge>
                    <Text size="sm" ff="monospace" truncate="end">
                      {o.namespace}/{o.name}
                    </Text>
                    {o.reason && (
                      <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
                        {o.reason}
                      </Text>
                    )}
                  </Group>
                  {o.message && (
                    <Text size="xs" c="dimmed" lineClamp={2}>
                      {o.message}
                    </Text>
                  )}
                </Stack>
                <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
                  {formatAge(o.last_transition, now)}
                </Text>
              </Group>
            ))}
          </Stack>
        )}
      </Paper>

      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
        <ChartCard
          title="Release health by namespace"
          subtitle="HelmReleases and Kustomizations · click a namespace to filter"
          legend={<StatusLegend />}
          chart={
            healthRows.length ? (
              <StackedBars rows={healthRows} unit="releases" onRowClick={onNamespace} />
            ) : (
              <Text size="sm" c="dimmed">
                No HelmReleases or Kustomizations.
              </Text>
            )
          }
          table={<StackedTable rows={healthRows} first="Namespace" />}
        />

        <Stack gap="md">
          <ChartCard
            title={`Helm deploys, last ${DAYS} days`}
            subtitle={`${deployTotals.ok} succeeded · ${deployTotals.failed} failed · from each release's recorded Helm history`}
            legend={
              <Legend
                items={[
                  { label: "Succeeded", cssVar: "var(--status-ready)", Icon: IconCircleCheck },
                  { label: "Failed", cssVar: "var(--status-failing)", Icon: IconCircleX },
                ]}
              />
            }
            chart={<Columns data={deploys.map(toColumn)} />}
            table={<DeployTable days={deploys} />}
          />

          <ChartCard
            title="Slowest Helm actions"
            subtitle="Duration of each release's most recent install, upgrade or rollback · ⊗ currently failing"
            chart={
              slowest.length ? (
                <ValueBars
                  format={formatDuration}
                  rows={slowest.map((o) => ({
                    key: `${o.namespace}/${o.name}`,
                    value: o.last_action!.duration_secs,
                    tooltip: `${o.last_action!.action} of ${o.namespace}/${o.name} took ${formatDuration(o.last_action!.duration_secs)} · ${STATUS[o.status].label}`,
                    label: (
                      <Group gap={4} wrap="nowrap">
                        {o.status === "failing" && (
                          <IconCircleX size={14} color="var(--mantine-color-red-6)" aria-label="Failing" style={{ flexShrink: 0 }} />
                        )}
                        <Anchor size="xs" c="var(--mantine-color-text)" truncate="end" display="block" onClick={() => onSelect(o)}>
                          {o.name}{" "}
                          <Text span size="xs" c="dimmed">
                            {o.namespace}
                          </Text>
                        </Anchor>
                      </Group>
                    ),
                  }))}
                />
              ) : (
                <Text size="sm" c="dimmed">
                  No Helm actions recorded.
                </Text>
              )
            }
            table={
              <Table striped fz="xs" style={{ fontVariantNumeric: "tabular-nums" }}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Release</Table.Th>
                    <Table.Th>Action</Table.Th>
                    <Table.Th ta="right">Duration</Table.Th>
                    <Table.Th>Status</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {slowest.map((o) => (
                    <Table.Tr key={`${o.namespace}/${o.name}`}>
                      <Table.Td>
                        {o.namespace}/{o.name}
                      </Table.Td>
                      <Table.Td>{o.last_action!.action}</Table.Td>
                      <Table.Td ta="right">{formatDuration(o.last_action!.duration_secs)}</Table.Td>
                      <Table.Td>
                        <StatusBadge status={o.status} />
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            }
          />
        </Stack>
      </SimpleGrid>
    </Stack>
  );
}

interface DeployDay {
  date: Date;
  ok: number;
  failed: number;
}

/** Helm history entries bucketed by local day over the last DAYS days. */
function deployDays(objects: FluxObject[], now: number): DeployDay[] {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const days: DeployDay[] = Array.from({ length: DAYS }, (_, i) => {
    const date = new Date(today);
    date.setDate(today.getDate() - (DAYS - 1 - i));
    return { date, ok: 0, failed: 0 };
  });
  const first = days[0].date.getTime();
  for (const o of objects) {
    for (const h of o.history) {
      if (!h.last_deployed) continue;
      const t = new Date(h.last_deployed);
      t.setHours(0, 0, 0, 0);
      const index = Math.round((t.getTime() - first) / 86_400_000);
      if (index < 0 || index >= DAYS) continue;
      if (h.status === "failed") days[index].failed++;
      else if (h.status === "deployed" || h.status === "superseded") days[index].ok++;
    }
  }
  return days;
}

const dayLabel = (d: Date) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });

function toColumn(d: DeployDay, i: number): ColumnDatum {
  const fromEnd = DAYS - 1 - i;
  return {
    key: d.date.toISOString(),
    label: fromEnd === 0 ? "Today" : dayLabel(d.date),
    showLabel: fromEnd % 7 === 0,
    tooltip: `${dayLabel(d.date)}: ${d.ok} succeeded, ${d.failed} failed`,
    segments: [
      { value: d.ok, cssVar: "var(--status-ready)" },
      { value: d.failed, cssVar: "var(--status-failing)" },
    ],
  };
}

function DeployTable({ days }: { days: DeployDay[] }) {
  const active = days.filter((d) => d.ok || d.failed).reverse();
  if (!active.length)
    return (
      <Text size="sm" c="dimmed">
        No deploys in the last {DAYS} days.
      </Text>
    );
  return (
    <Table striped fz="xs" style={{ fontVariantNumeric: "tabular-nums" }}>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Day</Table.Th>
          <Table.Th ta="right">Succeeded</Table.Th>
          <Table.Th ta="right">Failed</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {active.map((d) => (
          <Table.Tr key={d.date.toISOString()}>
            <Table.Td>{dayLabel(d.date)}</Table.Td>
            <Table.Td ta="right">{d.ok}</Table.Td>
            <Table.Td ta="right">{d.failed}</Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}
