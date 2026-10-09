"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Center,
  Group,
  Loader,
  Menu,
  Stack,
  Table,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { useInterval } from "@mantine/hooks";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconDots,
  IconFileText,
  IconLink,
  IconTerminal2,
  IconPlugConnected,
  IconRotateClockwise,
  IconSearch,
  IconTrash,
} from "@tabler/icons-react";
import { deletePod, formatAge, listPods, restartPod, type PodRow } from "@/lib/k8s";
import { PodDetailDrawer } from "./PodDetailDrawer";
import { openPortForwardDialog } from "./PortForwards";
import { useLogDock } from "./logs/LogDock";
import { useUsage } from "./usage/UsageProvider";
import { Meter } from "./charts/usageCharts";
import chartClasses from "./charts/charts.module.css";
import { formatBytes, formatCores, formatCoresShort, type PodUsage } from "@/lib/metrics";

const REFRESH_MS = 5000;

function statusColor(status: string): string {
  if (status === "Running") return "green";
  if (["Terminating", "Succeeded", "Completed"].includes(status)) return "gray";
  if (["Pending", "ContainerCreating", "PodInitializing"].includes(status) || /^Init:\d+\/\d+$/.test(status)) {
    return "yellow";
  }
  // Failed, CrashLoopBackOff, Error, ImagePullBackOff, OOMKilled, Unknown, ...
  return "red";
}

interface Props {
  /** Kube context, pinned into log terminals opened from here. */
  context: string;
  namespace: string;
  /** Bumped by the header refresh button. */
  refreshKey: number;
}

export function PodsTable({ context, namespace, refreshKey }: Props) {
  // Live CPU / memory from the shared metrics sampler (also feeds the Usage view).
  const usage = useUsage();
  const startUsage = usage.start;
  useEffect(() => startUsage(), [startUsage]);
  const usageByPod = useMemo(
    () => new Map((usage.snapshot?.pods ?? []).filter((p) => p.namespace === namespace).map((p) => [p.name, p])),
    [usage.snapshot, namespace],
  );
  const metricsNote = usage.snapshot?.metrics_error ?? usage.error ?? (usage.snapshot ? null : "Loading usage…");
  const { openLogs, openShell } = useLogDock();
  const showLogs = (pod: string) => openLogs({ context, namespace, pod, container: null });
  const showShell = (pod: string, mode: "exec" | "attach" = "exec") => openShell({ context, namespace, pod, container: null }, mode);
  const [pods, setPods] = useState<PodRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [selected, setSelected] = useState<string | null>(null);
  const inFlight = useRef(false);

  const load = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    listPods(namespace)
      .then((rows) => {
        setPods(rows);
        setError(null);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => {
        inFlight.current = false;
        setNow(Date.now());
      });
  }, [namespace]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  useInterval(load, REFRESH_MS, { autoInvoke: true });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (pods ?? []).filter((p) => p.name.toLowerCase().includes(q));
  }, [pods, search]);

  const confirmRestart = (pod: PodRow) =>
    modals.openConfirmModal({
      title: `Restart ${pod.name}?`,
      children: pod.owner_kind ? (
        <Text size="sm">
          The pod will be deleted and its {pod.owner_kind} will create a replacement.
        </Text>
      ) : (
        <Alert color="red" icon={<IconAlertTriangle size={18} />} title="This pod has no controller">
          Restarting deletes it, and nothing will recreate it. The pod will be gone for good.
        </Alert>
      ),
      labels: { confirm: pod.owner_kind ? "Restart" : "Delete anyway", cancel: "Cancel" },
      confirmProps: { color: pod.owner_kind ? "blue" : "red" },
      onConfirm: async () => {
        try {
          const res = await restartPod(namespace, pod.name);
          notifications.show({
            color: res.had_controller ? "green" : "yellow",
            title: res.had_controller ? "Pod restarting" : "Pod deleted",
            message: res.had_controller
              ? `${pod.name} was deleted; its controller will recreate it.`
              : `${pod.name} had no controller and will not come back.`,
          });
        } catch (e) {
          notifications.show({ color: "red", title: `Failed to restart ${pod.name}`, message: (e as Error).message });
        }
        load();
      },
    });

  const confirmDelete = (pod: PodRow) =>
    modals.openConfirmModal({
      title: `Delete ${pod.name}?`,
      children: (
        <Text size="sm">
          {pod.owner_kind
            ? `Its ${pod.owner_kind} will create a replacement pod.`
            : "This pod has no controller, so it will not be recreated."}
        </Text>
      ),
      labels: { confirm: "Delete", cancel: "Cancel" },
      confirmProps: { color: "red" },
      onConfirm: async () => {
        try {
          await deletePod(namespace, pod.name);
          notifications.show({ color: "green", title: "Pod deleted", message: pod.name });
        } catch (e) {
          notifications.show({ color: "red", title: `Failed to delete ${pod.name}`, message: (e as Error).message });
        }
        load();
      },
    });

  return (
    <Stack>
      <Group justify="space-between">
        <TextInput
          placeholder="Filter pods"
          leftSection={<IconSearch size={16} />}
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          w={320}
        />
        <Text size="sm" c="dimmed">
          {pods ? `${filtered.length} of ${pods.length} pods` : ""}
        </Text>
      </Group>

      {error && (
        <Alert color="red" icon={<IconAlertCircle size={18} />} title="Could not list pods">
          {error}
        </Alert>
      )}

      {pods === null && !error ? (
        <Center p="xl">
          <Loader />
        </Center>
      ) : (
        <Table striped highlightOnHover verticalSpacing="xs" className={chartClasses.charts}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Name</Table.Th>
              <Table.Th miw={130}>Status</Table.Th>
              <Table.Th>Ready</Table.Th>
              <Table.Th>Restarts</Table.Th>
              <Table.Th w={110}>CPU</Table.Th>
              <Table.Th w={110}>Memory</Table.Th>
              <Table.Th>Age</Table.Th>
              <Table.Th>Node</Table.Th>
              <Table.Th>Owner</Table.Th>
              <Table.Th w={110} />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {filtered.map((pod) => (
              <Table.Tr key={pod.name} onClick={() => setSelected(pod.name)} style={{ cursor: "pointer" }}>
                <Table.Td ff="monospace" fz="sm">
                  {pod.name}
                </Table.Td>
                <Table.Td>
                  <Badge color={statusColor(pod.status)} variant="light" style={{ overflow: "visible" }}>
                    {pod.status}
                  </Badge>
                </Table.Td>
                <Table.Td>{pod.ready}</Table.Td>
                <Table.Td>{pod.restarts}</Table.Td>
                <Table.Td>
                  <ResourceCell kind="cpu" usage={usageByPod.get(pod.name)} note={metricsNote} />
                </Table.Td>
                <Table.Td>
                  <ResourceCell kind="memory" usage={usageByPod.get(pod.name)} note={metricsNote} />
                </Table.Td>
                <Table.Td>{formatAge(pod.created, now)}</Table.Td>
                <Table.Td>{pod.node ?? "-"}</Table.Td>
                <Table.Td>{pod.owner_kind ?? <Text span c="dimmed" size="sm">none</Text>}</Table.Td>
                {/* Menu clicks (even from its portal) bubble through React to the row; keep them here. */}
                <Table.Td onClick={(e) => e.stopPropagation()}>
                  <Group gap={2} wrap="nowrap">
                  <Tooltip label="Logs" withArrow>
                    <ActionIcon variant="subtle" color="gray" aria-label={`Logs for ${pod.name}`} onClick={() => showLogs(pod.name)}>
                      <IconFileText size={16} />
                    </ActionIcon>
                  </Tooltip>
                  <Tooltip label="Shell" withArrow>
                    <ActionIcon variant="subtle" color="gray" aria-label={`Shell into ${pod.name}`} onClick={() => showShell(pod.name)}>
                      <IconTerminal2 size={16} />
                    </ActionIcon>
                  </Tooltip>
                  <Menu position="bottom-end" withinPortal>
                    <Menu.Target>
                      <ActionIcon variant="subtle" color="gray" aria-label={`Actions for ${pod.name}`}>
                        <IconDots size={16} />
                      </ActionIcon>
                    </Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Item leftSection={<IconFileText size={14} />} onClick={() => showLogs(pod.name)}>
                        Logs
                      </Menu.Item>
                      <Menu.Item leftSection={<IconTerminal2 size={14} />} onClick={() => showShell(pod.name)}>
                        Shell
                      </Menu.Item>
                      <Menu.Item leftSection={<IconLink size={14} />} onClick={() => showShell(pod.name, "attach")}>
                        Attach
                      </Menu.Item>
                      <Menu.Item leftSection={<IconRotateClockwise size={14} />} onClick={() => confirmRestart(pod)}>
                        Restart
                      </Menu.Item>
                      <Menu.Item
                        leftSection={<IconPlugConnected size={14} />}
                        onClick={() => openPortForwardDialog(namespace, pod.name)}
                      >
                        Port forward…
                      </Menu.Item>
                      <Menu.Divider />
                      <Menu.Item color="red" leftSection={<IconTrash size={14} />} onClick={() => confirmDelete(pod)}>
                        Delete
                      </Menu.Item>
                    </Menu.Dropdown>
                  </Menu>
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
            {pods !== null && filtered.length === 0 && (
              <Table.Tr>
                <Table.Td colSpan={10}>
                  <Text c="dimmed" ta="center" py="md">
                    {pods.length === 0 ? `No pods in ${namespace}` : "No pods match the filter"}
                  </Text>
                </Table.Td>
              </Table.Tr>
            )}
          </Table.Tbody>
        </Table>
      )}

      <PodDetailDrawer context={context} namespace={namespace} pod={selected} onClose={() => setSelected(null)} />
    </Stack>
  );
}

/**
 * Current CPU or memory use. The meter is against the limit (severity color at
 * 80% / 90%); without a limit there's nothing to fill, so only the value shows.
 */
function ResourceCell({ kind, usage, note }: { kind: "cpu" | "memory"; usage?: PodUsage; note: string | null }) {
  if (!usage?.usage) {
    return (
      <Tooltip label={note ?? "No usage reported (pod not running, or metrics not collected yet)"} withArrow multiline maw={320}>
        <Text size="sm" c="dimmed">
          –
        </Text>
      </Tooltip>
    );
  }
  const used = usage.usage[kind];
  const request = usage.requests[kind];
  const limit = kind === "cpu" ? usage.cpu_limit : usage.memory_limit;
  const fmt = kind === "cpu" ? formatCores : formatBytes;
  const pct = limit ? Math.round((used / limit) * 100) : null;
  const label = [
    `${fmt(used)} in use`,
    request ? `request ${fmt(request)}` : "no request",
    limit ? `limit ${fmt(limit)} (${pct}% used)` : "no limit",
  ].join(" · ");
  return (
    <Tooltip label={label} withArrow>
      <Stack gap={3} style={{ fontVariantNumeric: "tabular-nums" }}>
        <Text size="sm">{kind === "cpu" ? formatCoresShort(used) : formatBytes(used)}</Text>
        {limit ? <Meter value={used} max={limit} w={72} /> : null}
      </Stack>
    </Tooltip>
  );
}
