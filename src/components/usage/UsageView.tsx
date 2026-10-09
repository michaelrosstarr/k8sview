"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Center,
  Group,
  Loader,
  Paper,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { IconAlertCircle, IconAlertTriangle, IconCircleX, IconCpu, IconDatabase, IconFileText, IconSearch, IconServer2, IconBox } from "@tabler/icons-react";
import { formatBytes, formatCores, formatCoresShort, memoryTickUnit, podKey, type PodUsage } from "@/lib/metrics";
import { ChartCard, ValueBars } from "../charts/charts";
import { Meter, Sparkline, TimeSeries } from "../charts/usageCharts";
import classes from "../charts/charts.module.css";
import { useLogDock } from "../logs/LogDock";
import { SAMPLE_MS, useUsage, type Sample } from "./UsageProvider";

type Sort = "cpu" | "memory" | "memlimit";
const TOP_NAMESPACES = 10;
const WARN = 0.9;

const pct = (v: number, max: number) => (max > 0 ? `${Math.round((v / max) * 100)}%` : "–");

export function UsageView({ context }: { context: string }) {
  const { snapshot, samples, error, start } = useUsage();
  const { openLogs } = useLogDock();
  const [namespace, setNamespace] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<Sort>("cpu");

  useEffect(() => start(), [start]);

  const nodes = useMemo(() => snapshot?.nodes ?? [], [snapshot]);
  const cluster = useMemo(() => {
    const sum = (f: (n: (typeof nodes)[number]) => number) => nodes.reduce((a, n) => a + f(n), 0);
    return {
      cpu: sum((n) => n.usage?.cpu ?? 0),
      memory: sum((n) => n.usage?.memory ?? 0),
      cpuAlloc: sum((n) => n.allocatable.cpu),
      memAlloc: sum((n) => n.allocatable.memory),
      cpuReq: sum((n) => n.requests.cpu),
      memReq: sum((n) => n.requests.memory),
      pods: sum((n) => n.pods),
      podCap: sum((n) => n.pod_capacity),
      ready: nodes.filter((n) => n.ready).length,
    };
  }, [nodes]);

  const namespaces = useMemo(() => [...new Set((snapshot?.pods ?? []).map((p) => p.namespace))].sort(), [snapshot]);

  // Everything below the filter row uses these.
  const pods = useMemo(() => {
    const q = search.trim().toLowerCase();
    const memRatio = (p: PodUsage) => (p.usage && p.memory_limit ? p.usage.memory / p.memory_limit : -1);
    return (snapshot?.pods ?? [])
      .filter((p) => p.phase === "Running" || p.usage)
      .filter((p) => !namespace || p.namespace === namespace)
      .filter((p) => !q || p.name.toLowerCase().includes(q))
      .sort((a, b) =>
        sort === "cpu"
          ? (b.usage?.cpu ?? 0) - (a.usage?.cpu ?? 0)
          : sort === "memory"
            ? (b.usage?.memory ?? 0) - (a.usage?.memory ?? 0)
            : memRatio(b) - memRatio(a),
      );
  }, [snapshot, namespace, search, sort]);

  const byNamespace = useMemo(() => {
    const totals = new Map<string, [number, number]>();
    for (const p of pods) {
      const t = totals.get(p.namespace) ?? [0, 0];
      t[0] += p.usage?.cpu ?? 0;
      t[1] += p.usage?.memory ?? 0;
      totals.set(p.namespace, t);
    }
    return [...totals.entries()];
  }, [pods]);

  if (!snapshot) {
    return error ? (
      <Alert color="red" icon={<IconAlertCircle size={18} />} title="Could not load usage">
        {error}
      </Alert>
    ) : (
      <Center p="xl">
        <Loader />
      </Center>
    );
  }

  const since = samples[0] ? new Date(samples[0].t).toLocaleTimeString() : null;
  const series = (pick: (s: Sample) => number) => samples.map((s) => ({ t: s.t, v: pick(s) }));
  const podSeries = (key: string, i: 0 | 1) => samples.map((s) => s.pods[key]?.[i] ?? 0);
  const nodeSeries = (name: string, i: 0 | 1) => samples.map((s) => s.nodes[name]?.[i] ?? 0);

  return (
    <Stack gap="md" className={classes.charts}>
      {snapshot.metrics_error && (
        <Alert color="yellow" icon={<IconAlertTriangle size={18} />} title="No live usage">
          {snapshot.metrics_error}. Requests, limits and capacity are still shown. Install metrics-server for usage.
        </Alert>
      )}
      {error && (
        <Alert color="orange" icon={<IconAlertCircle size={18} />} title="Last refresh failed; showing the previous sample">
          {error}
        </Alert>
      )}

      <Group justify="space-between">
        <Text fw={600}>Cluster</Text>
        <Text size="xs" c="dimmed">
          Sampling every {SAMPLE_MS / 1000}s · {samples.length} sample{samples.length === 1 ? "" : "s"}
          {since && ` since ${since}`} · history is kept while the app is open
        </Text>
      </Group>

      <SimpleGrid cols={{ base: 2, lg: 4 }} spacing="md">
        <Tile
          icon={<IconCpu size={16} />}
          label="CPU in use"
          value={formatCores(cluster.cpu)}
          sub={`of ${formatCores(cluster.cpuAlloc)} allocatable · ${pct(cluster.cpu, cluster.cpuAlloc)}`}
          meter={<Meter value={cluster.cpu} max={cluster.cpuAlloc} marker={cluster.cpuReq} />}
          note={`${formatCores(cluster.cpuReq)} requested (${pct(cluster.cpuReq, cluster.cpuAlloc)}) · marker`}
        />
        <Tile
          icon={<IconDatabase size={16} />}
          label="Memory in use"
          value={formatBytes(cluster.memory)}
          sub={`of ${formatBytes(cluster.memAlloc)} allocatable · ${pct(cluster.memory, cluster.memAlloc)}`}
          meter={<Meter value={cluster.memory} max={cluster.memAlloc} marker={cluster.memReq} />}
          note={`${formatBytes(cluster.memReq)} requested (${pct(cluster.memReq, cluster.memAlloc)}) · marker`}
        />
        <Tile
          icon={<IconBox size={16} />}
          label="Pods scheduled"
          value={cluster.pods.toLocaleString()}
          sub={`of ${cluster.podCap.toLocaleString()} pod slots · ${pct(cluster.pods, cluster.podCap)}`}
          meter={<Meter value={cluster.pods} max={cluster.podCap} />}
        />
        <Tile
          icon={<IconServer2 size={16} />}
          label="Nodes ready"
          value={`${cluster.ready} / ${nodes.length}`}
          sub={cluster.ready === nodes.length ? "All nodes ready" : `${nodes.length - cluster.ready} not ready`}
        />
      </SimpleGrid>

      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
        <ChartCard
          title="Cluster CPU usage"
          subtitle={`Cores in use, of ${formatCores(cluster.cpuAlloc)} allocatable`}
          chart={<TimeSeries points={series((s) => s.cluster[0])} format={formatCoresShort} formatTooltip={formatCores} label="CPU" />}
          table={<SampleTable rows={series((s) => s.cluster[0])} format={formatCores} />}
        />
        <ChartCard
          title="Cluster memory usage"
          subtitle={`Working set, of ${formatBytes(cluster.memAlloc)} allocatable`}
          chart={
            <TimeSeries
              points={series((s) => s.cluster[1])}
              format={formatBytes}
              tickUnit={memoryTickUnit(Math.max(0, ...samples.map((s) => s.cluster[1])))}
              label="Memory"
            />
          }
          table={<SampleTable rows={series((s) => s.cluster[1])} format={formatBytes} />}
        />
      </SimpleGrid>

      <Paper withBorder radius="md" p="md">
        <Text fw={600} mb="xs">
          Nodes
        </Text>
        <Table verticalSpacing={8} fz="sm" style={{ fontVariantNumeric: "tabular-nums" }}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Node</Table.Th>
              <Table.Th w="30%">CPU (tick = requested)</Table.Th>
              <Table.Th w="30%">Memory (tick = requested)</Table.Th>
              <Table.Th w={170}>Pods</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {nodes.map((n) => {
              const podsFull = n.pod_capacity > 0 && n.pods / n.pod_capacity >= WARN;
              return (
                <Table.Tr key={n.name}>
                  <Table.Td>
                    <Group gap="xs" wrap="nowrap">
                      <Text size="sm" ff="monospace">
                        {n.name}
                      </Text>
                      {!n.ready && (
                        <Badge color="red" variant="light" size="xs" leftSection={<IconCircleX size={10} />}>
                          Not ready
                        </Badge>
                      )}
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <UsageCell
                      meter={<Meter value={n.usage?.cpu ?? 0} max={n.allocatable.cpu} marker={n.requests.cpu} />}
                      text={`${formatCoresShort(n.usage?.cpu ?? 0)} / ${formatCoresShort(n.allocatable.cpu)} · ${pct(n.usage?.cpu ?? 0, n.allocatable.cpu)}`}
                      trend={nodeSeries(n.name, 0)}
                    />
                  </Table.Td>
                  <Table.Td>
                    <UsageCell
                      meter={<Meter value={n.usage?.memory ?? 0} max={n.allocatable.memory} marker={n.requests.memory} />}
                      text={`${formatBytes(n.usage?.memory ?? 0)} / ${formatBytes(n.allocatable.memory)} · ${pct(n.usage?.memory ?? 0, n.allocatable.memory)}`}
                      trend={nodeSeries(n.name, 1)}
                    />
                  </Table.Td>
                  <Table.Td>
                    <Stack gap={4}>
                      <Meter value={n.pods} max={n.pod_capacity} />
                      <Group gap={4} wrap="nowrap">
                        {podsFull && <IconAlertTriangle size={12} color="var(--mantine-color-orange-6)" aria-label="Nearly full" />}
                        <Text size="xs" c={podsFull ? undefined : "dimmed"} fw={podsFull ? 600 : undefined}>
                          {n.pods} / {n.pod_capacity}
                          {podsFull && " · nearly full"}
                        </Text>
                      </Group>
                    </Stack>
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </Paper>

      {/* One filter row; it scopes everything below it. */}
      <Group gap="sm" mt="xs">
        <Select
          aria-label="Namespace filter"
          placeholder="All namespaces"
          data={namespaces}
          value={namespace}
          onChange={setNamespace}
          searchable
          clearable
          w={240}
        />
        <TextInput placeholder="Filter pods" leftSection={<IconSearch size={16} />} value={search} onChange={(e) => setSearch(e.currentTarget.value)} w={240} />
        <SegmentedControl
          value={sort}
          onChange={(v) => setSort(v as Sort)}
          data={[
            { value: "cpu", label: "Top CPU" },
            { value: "memory", label: "Top memory" },
            { value: "memlimit", label: "Nearest memory limit" },
          ]}
        />
      </Group>

      {!namespace && byNamespace.length > 1 && (
        <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
          <NamespaceBars title="CPU by namespace" rows={byNamespace.map(([ns, [cpu]]) => [ns, cpu])} format={formatCores} onPick={setNamespace} />
          <NamespaceBars title="Memory by namespace" rows={byNamespace.map(([ns, [, mem]]) => [ns, mem])} format={formatBytes} onPick={setNamespace} />
        </SimpleGrid>
      )}

      <Paper withBorder radius="md" p="md">
        <Group justify="space-between" mb="xs">
          <Text fw={600}>Pods</Text>
          <Text size="xs" c="dimmed">
            {pods.length} pods · {pods.filter((p) => p.memory_limit === null).length} without a memory limit
          </Text>
        </Group>
        <Table.ScrollContainer minWidth={1000}>
          <Table striped verticalSpacing={6} fz="xs" style={{ fontVariantNumeric: "tabular-nums" }}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Pod</Table.Th>
                <Table.Th>CPU</Table.Th>
                <Table.Th>Request / limit</Table.Th>
                <Table.Th>Memory</Table.Th>
                <Table.Th>Request / limit</Table.Th>
                <Table.Th w={150}>Of memory limit</Table.Th>
                <Table.Th w={36} />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {pods.slice(0, 200).map((p) => {
                const key = podKey(p);
                const memRatio = p.usage && p.memory_limit ? p.usage.memory / p.memory_limit : null;
                const cpuRatio = p.usage && p.cpu_limit ? p.usage.cpu / p.cpu_limit : null;
                return (
                  <Table.Tr key={key}>
                    <Table.Td>
                      <Text size="xs" ff="monospace">
                        <Text span inherit c="dimmed">
                          {p.namespace}/
                        </Text>
                        {p.name}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Group gap="xs" wrap="nowrap">
                        <Text size="xs" w={48} ta="right">
                          {p.usage ? formatCoresShort(p.usage.cpu) : "–"}
                        </Text>
                        <Sparkline values={podSeries(key, 0)} />
                        {cpuRatio !== null && cpuRatio >= WARN && (
                          <Tooltip label={`At ${Math.round(cpuRatio * 100)}% of its CPU limit; likely throttled`} withArrow>
                            <Badge size="xs" color="yellow" variant="light" leftSection={<IconAlertTriangle size={10} />}>
                              throttling
                            </Badge>
                          </Tooltip>
                        )}
                      </Group>
                    </Table.Td>
                    <Table.Td c="dimmed" style={{ whiteSpace: "nowrap" }}>
                      {formatCoresShort(p.requests.cpu)} / {p.cpu_limit !== null ? formatCoresShort(p.cpu_limit) : "none"}
                    </Table.Td>
                    <Table.Td>
                      <Group gap="xs" wrap="nowrap">
                        <Text size="xs" w={60} ta="right">
                          {p.usage ? formatBytes(p.usage.memory) : "–"}
                        </Text>
                        <Sparkline values={podSeries(key, 1)} />
                      </Group>
                    </Table.Td>
                    <Table.Td c="dimmed" style={{ whiteSpace: "nowrap" }}>
                      {formatBytes(p.requests.memory)} / {p.memory_limit !== null ? formatBytes(p.memory_limit) : "none"}
                    </Table.Td>
                    <Table.Td>
                      {memRatio === null ? (
                        <Text size="xs" c="dimmed">
                          {p.memory_limit === null ? "no limit" : "–"}
                        </Text>
                      ) : (
                        <Group gap={6} wrap="nowrap">
                          <Meter value={p.usage!.memory} max={p.memory_limit!} w={70} />
                          <Text size="xs" fw={memRatio >= WARN ? 600 : undefined}>
                            {Math.round(memRatio * 100)}%
                          </Text>
                          {memRatio >= WARN && (
                            <Tooltip label="Close to its memory limit; at risk of being OOM-killed" withArrow>
                              <IconCircleX size={14} color="var(--mantine-color-red-6)" aria-label="Near OOM" />
                            </Tooltip>
                          )}
                        </Group>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Tooltip label="Logs" withArrow>
                        <ActionIcon size="sm" variant="subtle" color="gray" aria-label={`Logs for ${p.name}`} onClick={() => openLogs({ context, namespace: p.namespace, pod: p.name, container: null })}>
                          <IconFileText size={14} />
                        </ActionIcon>
                      </Tooltip>
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
        {pods.length > 200 && (
          <Text size="xs" c="dimmed" mt="xs">
            Showing the top 200 of {pods.length}; filter by namespace or name to narrow it down.
          </Text>
        )}
      </Paper>
    </Stack>
  );
}

function Tile({ icon, label, value, sub, meter, note }: { icon: React.ReactNode; label: string; value: string; sub: string; meter?: React.ReactNode; note?: string }) {
  return (
    <Paper withBorder radius="md" p="md">
      <Group gap={6} mb={6} c="dimmed">
        {icon}
        <Text size="sm">{label}</Text>
      </Group>
      <Text fz={26} fw={600} lh={1.15}>
        {value}
      </Text>
      <Text size="xs" c="dimmed" mb={meter ? 8 : 0}>
        {sub}
      </Text>
      {meter}
      {note && (
        <Text size="10px" c="dimmed" mt={6}>
          {note}
        </Text>
      )}
    </Paper>
  );
}

function UsageCell({ meter, text, trend }: { meter: React.ReactNode; text: string; trend: number[] }) {
  return (
    <Group gap="sm" wrap="nowrap">
      <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
        {meter}
        <Text size="xs" c="dimmed">
          {text}
        </Text>
      </Stack>
      <Sparkline values={trend} />
    </Group>
  );
}

function NamespaceBars({
  title,
  rows,
  format,
  onPick,
}: {
  title: string;
  rows: [string, number][];
  format: (v: number) => string;
  onPick: (ns: string) => void;
}) {
  const sorted = [...rows].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, TOP_NAMESPACES);
  const rest = sorted.slice(TOP_NAMESPACES).reduce((n, [, v]) => n + v, 0);
  const shown: [string, number][] = rest > 0 ? [...top, ["Other", rest]] : top;
  return (
    <ChartCard
      title={title}
      subtitle="Current usage · click a namespace to filter"
      chart={
        <ValueBars
          format={format}
          rows={shown.map(([ns, v]) => ({
            key: ns,
            value: v,
            tooltip: `${ns}: ${format(v)}`,
            label:
              ns === "Other" ? (
                <Text size="xs" c="dimmed">
                  Other ({sorted.length - TOP_NAMESPACES} namespaces)
                </Text>
              ) : (
                <Text size="xs" truncate="end" style={{ cursor: "pointer" }} onClick={() => onPick(ns)}>
                  {ns}
                </Text>
              ),
          }))}
        />
      }
      table={
        <Table striped fz="xs" style={{ fontVariantNumeric: "tabular-nums" }}>
          <Table.Tbody>
            {sorted.map(([ns, v]) => (
              <Table.Tr key={ns}>
                <Table.Td>{ns}</Table.Td>
                <Table.Td ta="right">{format(v)}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      }
    />
  );
}

function SampleTable({ rows, format }: { rows: { t: number; v: number }[]; format: (v: number) => string }) {
  return (
    <Table striped fz="xs" style={{ fontVariantNumeric: "tabular-nums" }}>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Time</Table.Th>
          <Table.Th ta="right">Value</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {[...rows].reverse().map((r) => (
          <Table.Tr key={r.t}>
            <Table.Td>{new Date(r.t).toLocaleTimeString()}</Table.Td>
            <Table.Td ta="right">{format(r.v)}</Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}
