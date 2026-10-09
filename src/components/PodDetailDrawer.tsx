"use client";

import { useEffect, useState } from "react";
import {
  Accordion,
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Center,
  Code,
  Collapse,
  Drawer,
  Group,
  List,
  Loader,
  Paper,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
  UnstyledButton,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconAlertCircle, IconChevronRight, IconFileText, IconPlugConnected, IconTerminal2 } from "@tabler/icons-react";
import {
  getPodDetail,
  localUrl,
  openLocalPort,
  type ContainerDetail,
  type ContainerPort,
  type EnvKind,
  type EnvVarRow,
  type PodDetail,
} from "@/lib/k8s";
import { ConfigMapData } from "./ConfigMapData";
import { openPortForwardDialog, usePortForwards } from "./PortForwards";
import { useLogDock } from "./logs/LogDock";
import { useUsage, type Sample } from "./usage/UsageProvider";
import { Meter, TimeSeries } from "./charts/usageCharts";
import chartClasses from "./charts/charts.module.css";
import {
  formatBytes,
  formatCores,
  formatCoresShort,
  memoryTickUnit,
  type ContainerUsage,
  type PodUsage,
} from "@/lib/metrics";

const KIND_COLOR: Record<EnvKind, string> = {
  value: "gray",
  configmap: "blue",
  secret: "grape",
  field: "teal",
  resource: "orange",
};

interface Props {
  context: string;
  namespace: string;
  /** Pod to show; `null` closes the drawer. */
  pod: string | null;
  onClose: () => void;
}

export function PodDetailDrawer({ context, namespace, pod, onClose }: Props) {
  return (
    <Drawer
      opened={pod !== null}
      onClose={onClose}
      position="right"
      size="xl"
      title={
        <Text fw={600} ff="monospace">
          {pod}
        </Text>
      }
    >
      {pod && <PodDetailBody key={pod} context={context} namespace={namespace} pod={pod} onClose={onClose} />}
    </Drawer>
  );
}

function PodDetailBody({
  context,
  namespace,
  pod,
  onClose,
}: {
  context: string;
  namespace: string;
  pod: string;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<PodDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const usage = useUsage();
  const startUsage = usage.start;
  useEffect(() => startUsage(), [startUsage]);
  const podUsage = usage.snapshot?.pods.find((p) => p.namespace === namespace && p.name === pod);

  useEffect(() => {
    let cancelled = false;
    getPodDetail(namespace, pod)
      .then((d) => !cancelled && setDetail(d))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [namespace, pod]);

  if (error) {
    return (
      <Alert color="red" icon={<IconAlertCircle size={18} />} title="Could not load pod">
        {error}
      </Alert>
    );
  }
  if (!detail) {
    return (
      <Center p="xl">
        <Loader />
      </Center>
    );
  }

  return (
    <Stack gap="lg">
      <PodUsageSection
        usage={podUsage}
        samples={usage.samples}
        podKey={`${namespace}/${pod}`}
        note={usage.snapshot?.metrics_error ?? usage.error ?? (usage.snapshot ? null : "Loading usage…")}
      />

      <Stack gap="sm">
        <Title order={5}>Containers</Title>
        {detail.containers.map((c) => (
          <ContainerCard
            key={c.name}
            container={c}
            usage={podUsage?.containers.find((u) => u.name === c.name)}
            context={context}
            namespace={namespace}
            pod={pod}
            onClose={onClose}
          />
        ))}
      </Stack>

      <Stack gap="sm">
        <Title order={5}>Linked ConfigMaps ({detail.configmaps.length})</Title>
        {detail.configmaps.length === 0 ? (
          <Text c="dimmed" size="sm">
            This pod does not reference any ConfigMaps.
          </Text>
        ) : (
          <Accordion multiple variant="separated">
            {detail.configmaps.map((cm) => (
              <Accordion.Item key={cm.name} value={cm.name}>
                <Accordion.Control>
                  <Group gap="xs">
                    <Text ff="monospace" size="sm">
                      {cm.name}
                    </Text>
                    {cm.status !== "found" && (
                      <Badge color={cm.status === "missing" ? "red" : "yellow"} variant="light" size="sm">
                        {cm.status}
                      </Badge>
                    )}
                  </Group>
                </Accordion.Control>
                <Accordion.Panel>
                  <Stack>
                    <List size="sm">
                      {cm.usages.map((u) => (
                        <List.Item key={u}>{u}</List.Item>
                      ))}
                    </List>
                    {cm.status === "found" && <ConfigMapData data={cm.data} />}
                    {cm.status === "missing" && (
                      <Text c="red" size="sm">
                        This ConfigMap does not exist in {namespace}.
                      </Text>
                    )}
                    {cm.error && (
                      <Text c="yellow" size="sm">
                        {cm.error}
                      </Text>
                    )}
                  </Stack>
                </Accordion.Panel>
              </Accordion.Item>
            ))}
          </Accordion>
        )}
      </Stack>
    </Stack>
  );
}

function ContainerCard({
  container: c,
  usage,
  context,
  namespace,
  pod,
  onClose,
}: {
  container: ContainerDetail;
  /** Live usage, when metrics-server reports this container. */
  usage?: ContainerUsage;
  context: string;
  namespace: string;
  pod: string;
  /** Close the drawer; it would otherwise cover the terminal dock. */
  onClose: () => void;
}) {
  const [envOpen, { toggle: toggleEnv }] = useDisclosure(false);
  const { openLogs, openShell } = useLogDock();

  return (
    <Paper withBorder p="md">
      <Stack gap="sm">
        <Group gap="xs">
          <Text fw={600} ff="monospace">
            {c.name}
          </Text>
          {c.init && (
            <Badge variant="light" color="gray" size="sm">
              init
            </Badge>
          )}
          <Button
            size="compact-xs"
            variant="light"
            ml="auto"
            leftSection={<IconFileText size={14} />}
            onClick={() => {
              openLogs({ context, namespace, pod, container: c.name });
              onClose();
            }}
          >
            Logs
          </Button>
          {!c.init && (
            <Button
              size="compact-xs"
              variant="light"
              color="gray"
              leftSection={<IconTerminal2 size={14} />}
              onClick={() => {
                openShell({ context, namespace, pod, container: c.name });
                onClose();
              }}
            >
              Shell
            </Button>
          )}
        </Group>
        <Table variant="vertical" withTableBorder={false} layout="fixed">
          <Table.Tbody>
            <Table.Tr>
              <Table.Th w={110}>Image</Table.Th>
              <Table.Td>
                <Code style={{ wordBreak: "break-all" }}>{c.image}</Code>
              </Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Th>Version</Table.Th>
              <Table.Td>
                <Badge variant="outline" style={{ textTransform: "none" }}>
                  {c.version}
                </Badge>
              </Table.Td>
            </Table.Tr>
            {usage?.usage && (
              <>
                <Table.Tr>
                  <Table.Th>CPU</Table.Th>
                  <Table.Td className={chartClasses.charts}>
                    <ResourceLine used={usage.usage.cpu} request={usage.requests.cpu} limit={usage.cpu_limit} format={formatCores} />
                  </Table.Td>
                </Table.Tr>
                <Table.Tr>
                  <Table.Th>Memory</Table.Th>
                  <Table.Td className={chartClasses.charts}>
                    <ResourceLine used={usage.usage.memory} request={usage.requests.memory} limit={usage.memory_limit} format={formatBytes} />
                  </Table.Td>
                </Table.Tr>
              </>
            )}
            {c.ports.length > 0 && (
              <Table.Tr>
                <Table.Th>Ports</Table.Th>
                <Table.Td>
                  <Stack gap={6}>
                    {c.ports.map((p) => (
                      <PortRow key={`${p.port}/${p.protocol}`} namespace={namespace} pod={pod} port={p} />
                    ))}
                  </Stack>
                </Table.Td>
              </Table.Tr>
            )}
            {c.image_id && (
              <Table.Tr>
                <Table.Th>Running</Table.Th>
                <Table.Td>
                  <Text size="xs" c="dimmed" ff="monospace" style={{ wordBreak: "break-all" }}>
                    {c.image_id}
                  </Text>
                </Table.Td>
              </Table.Tr>
            )}
          </Table.Tbody>
        </Table>

        {c.env.length === 0 ? (
          <Text c="dimmed" size="sm">
            No environment variables.
          </Text>
        ) : (
          <>
            <UnstyledButton onClick={toggleEnv} aria-expanded={envOpen}>
              <Group gap={6}>
                <IconChevronRight
                  size={16}
                  style={{ transform: envOpen ? "rotate(90deg)" : undefined, transition: "transform 150ms ease" }}
                />
                <Text fw={600} size="sm">
                  Environment ({c.env.length})
                </Text>
              </Group>
            </UnstyledButton>
            <Collapse expanded={envOpen}>
              <Table striped layout="fixed" verticalSpacing={4}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th w="30%">Name</Table.Th>
                    <Table.Th w="40%">Value</Table.Th>
                    <Table.Th>Source</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {c.env.map((e) => (
                    <Table.Tr key={e.name}>
                      <Table.Td ff="monospace" fz="xs" style={{ wordBreak: "break-all" }}>
                        {e.name}
                      </Table.Td>
                      <Table.Td>
                        <EnvValue env={e} />
                      </Table.Td>
                      <Table.Td>
                        <Badge color={KIND_COLOR[e.kind]} variant="light" size="xs" style={{ textTransform: "none" }}>
                          {e.kind}
                        </Badge>{" "}
                        <Text span size="xs" c="dimmed">
                          {e.source}
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Collapse>
          </>
        )}
      </Stack>
    </Paper>
  );
}

function PortRow({ namespace, pod, port: p }: { namespace: string; pod: string; port: ContainerPort }) {
  const { forwards } = usePortForwards();
  const active = forwards.filter((f) => f.namespace === namespace && f.pod === pod && f.pod_port === p.port);
  return (
    <Group gap="xs">
      <Code>
        {p.name ? `${p.name}: ` : ""}
        {p.port}/{p.protocol}
      </Code>
      {/* Kubernetes port-forward only carries TCP. */}
      {p.protocol === "TCP" && (
        <Button
          size="compact-xs"
          variant="light"
          leftSection={<IconPlugConnected size={14} />}
          onClick={() => openPortForwardDialog(namespace, pod, p.port)}
        >
          Forward
        </Button>
      )}
      {active.map((f) => (
        <Anchor key={f.id} size="xs" ff="monospace" onClick={() => void openLocalPort(f.local_port)}>
          {localUrl(f.local_port)}
        </Anchor>
      ))}
    </Group>
  );
}

function EnvValue({ env }: { env: EnvVarRow }) {
  if (env.kind === "secret") {
    return (
      <Text size="xs" c="dimmed" fs="italic">
        hidden (Secret)
      </Text>
    );
  }
  if (env.value === null) {
    return (
      <Text size="xs" c="dimmed" fs="italic">
        unresolved
      </Text>
    );
  }
  return (
    <Code fz="xs" style={{ wordBreak: "break-all", whiteSpace: "pre-wrap" }}>
      {env.value}
    </Code>
  );
}

/** "12m · request 100m · limit 500m (2%)" with a meter against the limit when there is one. */
function ResourceLine({
  used,
  request,
  limit,
  format,
}: {
  used: number;
  request: number;
  limit: number | null;
  format: (v: number) => string;
}) {
  return (
    <Group gap="sm" wrap="nowrap" style={{ fontVariantNumeric: "tabular-nums" }}>
      {limit ? <Meter value={used} max={limit} w={90} /> : null}
      <Text size="sm" fw={500} style={{ whiteSpace: "nowrap" }}>
        {format(used)}
      </Text>
      <Text size="xs" c="dimmed">
        {request ? `request ${format(request)}` : "no request"} ·{" "}
        {limit ? `limit ${format(limit)} (${Math.round((used / limit) * 100)}%)` : "no limit"}
      </Text>
    </Group>
  );
}

/** Pod-level CPU and memory: current value vs limit, plus the sampled trend. */
function PodUsageSection({
  usage,
  samples,
  podKey,
  note,
}: {
  usage: PodUsage | undefined;
  samples: Sample[];
  podKey: string;
  note: string | null;
}) {
  if (!usage?.usage) {
    return (
      <Text size="sm" c="dimmed">
        {note ?? "No CPU or memory usage reported for this pod (it may not be running yet)."}
      </Text>
    );
  }
  const series = (i: 0 | 1) => samples.filter((s) => s.pods[podKey]).map((s) => ({ t: s.t, v: s.pods[podKey][i] }));
  const cpu = series(0);
  const memory = series(1);
  return (
    <Stack gap="sm" className={chartClasses.charts}>
      <Group justify="space-between">
        <Title order={5}>Resource usage</Title>
        <Text size="xs" c="dimmed">
          {cpu.length} sample{cpu.length === 1 ? "" : "s"} · every 15s
        </Text>
      </Group>
      <SimpleGrid cols={2} spacing="md">
        {(
          [
            ["CPU", usage.usage.cpu, usage.requests.cpu, usage.cpu_limit, formatCores, cpu, formatCoresShort, 1],
            ["Memory", usage.usage.memory, usage.requests.memory, usage.memory_limit, formatBytes, memory, formatBytes, memoryTickUnit(Math.max(0, ...memory.map((p) => p.v)))],
          ] as const
        ).map(([label, used, request, limit, format, points, axis, tickUnit]) => (
          <Paper key={label} withBorder radius="md" p="sm">
            <Text size="xs" c="dimmed">
              {label}
            </Text>
            <Text fz={22} fw={600} lh={1.2}>
              {format(used)}
            </Text>
            <Text size="xs" c="dimmed" mb={6}>
              {request ? `request ${format(request)}` : "no request"} ·{" "}
              {limit ? `limit ${format(limit)} · ${Math.round((used / limit) * 100)}% used` : "no limit"}
            </Text>
            {limit ? <Meter value={used} max={limit} marker={request || undefined} /> : null}
            <Box mt="md">
              <TimeSeries points={points} format={axis} formatTooltip={format} tickUnit={tickUnit} label={label} height={90} />
            </Box>
          </Paper>
        ))}
      </SimpleGrid>
    </Stack>
  );
}
