"use client";

import { useEffect, useState } from "react";
import {
  Accordion,
  Alert,
  Badge,
  Button,
  Center,
  Drawer,
  Group,
  Loader,
  Stack,
  Table,
  Text,
  Timeline,
  Title,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { IconAlertCircle, IconPlayerPause, IconPlayerPlay, IconRefresh, IconRefreshDot } from "@tabler/icons-react";
import YAML from "yaml";
import { formatAge } from "@/lib/k8s";
import {
  fluxDetail,
  fluxReconcile,
  fluxSetSuspended,
  formatDuration,
  refKey,
  type FluxDetail,
  type FluxObject,
  type ObjectRef,
} from "@/lib/flux";
import { CodeViewer } from "../CodeViewer";
import { ChartCard, ValueBars } from "../charts/charts";
import { STATUS, StatusBadge } from "./status";

const INVENTORY_KINDS = 10;

interface Props {
  /** Latest snapshot entry for the selected object; null closes the drawer. */
  object: FluxObject | null;
  now: number;
  onClose: () => void;
  /** Called after an action so the caller refreshes its snapshot. */
  onChanged: () => void;
  onSelect: (ref: ObjectRef) => void;
}

export function FluxDetailDrawer({ object, now, onClose, onChanged, onSelect }: Props) {
  return (
    <Drawer
      opened={object !== null}
      onClose={onClose}
      position="right"
      size="xl"
      title={
        object && (
          <Group gap="xs">
            <Badge variant="outline" color="gray">
              {object.kind}
            </Badge>
            <Text fw={600} ff="monospace">
              {object.namespace}/{object.name}
            </Text>
          </Group>
        )
      }
    >
      {object && <DetailBody key={refKey(object)} object={object} now={now} onChanged={onChanged} onSelect={onSelect} />}
    </Drawer>
  );
}

function DetailBody({
  object: o,
  now,
  onChanged,
  onSelect,
}: {
  object: FluxObject;
  now: number;
  onChanged: () => void;
  onSelect: (ref: ObjectRef) => void;
}) {
  const [detail, setDetail] = useState<FluxDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fluxDetail(o)
      .then((d) => !cancelled && setDetail(d))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
    // `o` is a fresh object on every snapshot; refetch only for a new target or after actions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.kind, o.namespace, o.name, version]);

  const run = async (label: string, action: () => Promise<string>) => {
    setBusy(label);
    try {
      const message = await action();
      notifications.show({ color: "green", title: label, message });
    } catch (e) {
      notifications.show({ color: "red", title: `${label} failed`, message: (e as Error).message });
    }
    setBusy(null);
    onChanged();
    setVersion((v) => v + 1);
  };

  const reconcile = (withSource: boolean) =>
    run(withSource ? "Reconcile with source" : "Reconcile", async () => {
      const requested = await fluxReconcile(o, withSource);
      return `Requested reconciliation of ${requested.map((r) => `${r.kind}/${r.name}`).join(", ")}`;
    });

  const suspend = () =>
    modals.openConfirmModal({
      title: `Suspend ${o.kind} ${o.name}?`,
      children: (
        <Text size="sm">
          Flux stops reconciling this {o.kind} until it is resumed, so changes in Git won&apos;t be applied to it. This
          is set on the cluster, not in Git.
        </Text>
      ),
      labels: { confirm: "Suspend", cancel: "Cancel" },
      confirmProps: { color: "orange" },
      onConfirm: () =>
        run("Suspend", async () => {
          await fluxSetSuspended(o, true);
          return `${o.kind}/${o.name} is suspended`;
        }),
    });

  const resume = () =>
    run("Resume", async () => {
      await fluxSetSuspended(o, false);
      return `${o.kind}/${o.name} resumed and queued for reconciliation`;
    });

  const statusColor = STATUS[o.status].color;
  const info: [string, React.ReactNode][] = [
    ["Source", o.source && <RefLink r={o.source} onSelect={onSelect} />],
    ["Revision", o.revision && <Text ff="monospace" fz="xs" style={{ wordBreak: "break-all" }}>{o.revision}</Text>],
    ["Chart", o.chart],
    ["App version", o.app_version],
    ["URL", o.url && <Text ff="monospace" fz="xs" style={{ wordBreak: "break-all" }}>{o.url}</Text>],
    ["Interval", o.interval],
    [
      "Depends on",
      o.depends_on.length > 0 && (
        <Group gap="xs">
          {o.depends_on.map((d) => (
            <RefLink key={refKey(d)} r={d} onSelect={onSelect} />
          ))}
        </Group>
      ),
    ],
    [
      "Last Helm action",
      o.last_action && `${o.last_action.action}, took ${formatDuration(o.last_action.duration_secs)}`,
    ],
    ["Status changed", o.last_transition && `${formatAge(o.last_transition, now)} ago`],
    ["Created", o.created && `${formatAge(o.created, now)} ago`],
  ];

  return (
    <Stack gap="lg">
      <Group justify="space-between" wrap="nowrap" align="flex-start">
        <Group gap="xs">
          <StatusBadge status={o.status} />
          {o.reason && (
            <Text size="sm" c="dimmed">
              {o.reason}
            </Text>
          )}
        </Group>
        <Group gap="xs" wrap="nowrap">
          <Button size="xs" variant="light" leftSection={<IconRefresh size={14} />} loading={busy === "Reconcile"} disabled={!!busy || o.suspended} onClick={() => reconcile(false)}>
            Reconcile
          </Button>
          {o.source && (
            <Button size="xs" variant="light" leftSection={<IconRefreshDot size={14} />} loading={busy === "Reconcile with source"} disabled={!!busy || o.suspended} onClick={() => reconcile(true)}>
              With source
            </Button>
          )}
          {o.suspended ? (
            <Button size="xs" color="green" variant="light" leftSection={<IconPlayerPlay size={14} />} loading={busy === "Resume"} disabled={!!busy} onClick={resume}>
              Resume
            </Button>
          ) : (
            <Button size="xs" color="orange" variant="light" leftSection={<IconPlayerPause size={14} />} loading={busy === "Suspend"} disabled={!!busy} onClick={suspend}>
              Suspend
            </Button>
          )}
        </Group>
      </Group>

      {o.status !== "ready" && o.message && (
        <Alert color={statusColor} variant="light" icon={<IconAlertCircle size={18} />} title={o.reason ?? STATUS[o.status].label}>
          <Text size="sm" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {o.message}
          </Text>
        </Alert>
      )}

      <Table variant="vertical" layout="fixed" withTableBorder={false}>
        <Table.Tbody>
          {info
            .filter(([, v]) => v)
            .map(([k, v]) => (
              <Table.Tr key={k}>
                <Table.Th w={150}>{k}</Table.Th>
                <Table.Td>{v}</Table.Td>
              </Table.Tr>
            ))}
        </Table.Tbody>
      </Table>

      {o.history.length > 0 && (
        <Stack gap="sm">
          <Title order={5}>Helm history</Title>
          <Timeline bulletSize={14} lineWidth={2} active={0} color={statusColor}>
            {o.history.map((h, i) => (
              <Timeline.Item
                key={h.version ?? i}
                title={
                  <Group gap="xs">
                    <Text size="sm" fw={600}>
                      v{h.version}
                    </Text>
                    <Text size="sm" ff="monospace">
                      chart {h.chart_version}
                    </Text>
                    {h.app_version && (
                      <Text size="sm" c="dimmed">
                        app {h.app_version}
                      </Text>
                    )}
                    <Badge size="xs" variant="light" color={h.status === "failed" ? "red" : h.status === "deployed" ? "green" : "gray"}>
                      {h.status}
                    </Badge>
                  </Group>
                }
              >
                <Text size="xs" c="dimmed">
                  Deployed {h.last_deployed ? `${formatAge(h.last_deployed, now)} ago` : "-"}
                  {h.first_deployed && h.first_deployed !== h.last_deployed && ` · first deployed ${formatAge(h.first_deployed, now)} ago`}
                </Text>
              </Timeline.Item>
            ))}
          </Timeline>
        </Stack>
      )}

      {error && (
        <Alert color="red" icon={<IconAlertCircle size={18} />} title="Could not load details">
          {error}
        </Alert>
      )}
      {!detail && !error && (
        <Center p="md">
          <Loader size="sm" />
        </Center>
      )}

      {detail && detail.inventory.length > 0 && <Inventory inventory={detail.inventory} />}

      {o.conditions.length > 0 && (
        <Stack gap="sm">
          <Title order={5}>Conditions</Title>
          <Table fz="xs" striped>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Type</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Reason</Table.Th>
                <Table.Th>Message</Table.Th>
                <Table.Th>Changed</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {o.conditions.map((c) => (
                <Table.Tr key={c.type}>
                  <Table.Td>{c.type}</Table.Td>
                  <Table.Td>{c.status}</Table.Td>
                  <Table.Td>{c.reason}</Table.Td>
                  <Table.Td style={{ wordBreak: "break-word" }}>{c.message}</Table.Td>
                  <Table.Td>{formatAge(c.last_transition, now)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Stack>
      )}

      {detail && (
        <Stack gap="sm">
          <Title order={5}>Events ({detail.events.length})</Title>
          {detail.events.length === 0 ? (
            <Text size="sm" c="dimmed">
              No recent events. Kubernetes keeps events for about an hour.
            </Text>
          ) : (
            <Stack gap={6}>
              {detail.events.map((e, i) => (
                <Group key={i} gap="xs" wrap="nowrap" align="flex-start">
                  <Badge size="xs" variant="light" color={e.type === "Warning" ? "orange" : "gray"} style={{ flexShrink: 0 }}>
                    {e.reason}
                  </Badge>
                  <Text size="xs" style={{ flex: 1, wordBreak: "break-word" }}>
                    {e.message}
                  </Text>
                  <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
                    {e.count && e.count > 1 ? `×${e.count} · ` : ""}
                    {formatAge(e.last_seen, now)}
                  </Text>
                </Group>
              ))}
            </Stack>
          )}
        </Stack>
      )}

      {detail && (
        <Accordion variant="separated">
          <Accordion.Item value="manifest">
            <Accordion.Control>Manifest (YAML)</Accordion.Control>
            <Accordion.Panel>
              <CodeViewer value={YAML.stringify(detail.object)} language="yaml" />
            </Accordion.Panel>
          </Accordion.Item>
        </Accordion>
      )}
    </Stack>
  );
}

function RefLink({ r, onSelect }: { r: ObjectRef; onSelect: (ref: ObjectRef) => void }) {
  return (
    <Badge
      variant="light"
      color="blue"
      style={{ cursor: "pointer", textTransform: "none" }}
      onClick={() => onSelect(r)}
    >
      {r.kind}/{r.namespace}/{r.name}
    </Badge>
  );
}

/** What a Kustomization manages, as a single-series bar chart (top kinds + Other). */
function Inventory({ inventory }: { inventory: FluxDetail["inventory"] }) {
  const total = inventory.reduce((n, k) => n + k.count, 0);
  const top = inventory.slice(0, INVENTORY_KINDS);
  const rest = inventory.slice(INVENTORY_KINDS).reduce((n, k) => n + k.count, 0);
  const rows = rest ? [...top, { kind: "Other", count: rest }] : top;
  return (
    <ChartCard
      title={`Managed objects (${total})`}
      subtitle="This Kustomization's inventory by kind"
      chart={
        <ValueBars
          format={(v) => v.toLocaleString()}
          rows={rows.map((k) => ({
            key: k.kind,
            value: k.count,
            tooltip: `${k.count} ${k.kind}`,
            label: (
              <Text size="xs" truncate="end">
                {k.kind}
              </Text>
            ),
          }))}
        />
      }
      table={
        <Table striped fz="xs" style={{ fontVariantNumeric: "tabular-nums" }}>
          <Table.Tbody>
            {inventory.map((k) => (
              <Table.Tr key={k.kind}>
                <Table.Td>{k.kind}</Table.Td>
                <Table.Td ta="right">{k.count}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      }
    />
  );
}
