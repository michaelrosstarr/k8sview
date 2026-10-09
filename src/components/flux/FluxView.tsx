"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Badge, Center, Group, Loader, Paper, Select, SimpleGrid, Stack, Tabs, Text, ThemeIcon, Tooltip } from "@mantine/core";
import { useInterval } from "@mantine/hooks";
import { IconAlertCircle, IconBrandGit, IconServer } from "@tabler/icons-react";
import { formatAge } from "@/lib/k8s";
import { fluxSnapshot, refKey, shortRevision, type FluxSnapshot, type ObjectRef } from "@/lib/flux";
import { FluxOverview } from "./FluxOverview";
import { FluxResources } from "./FluxResources";
import { FluxDetailDrawer } from "./FluxDetailDrawer";

const REFRESH_MS = 15_000;

export function FluxView({ refreshKey }: { refreshKey: number }) {
  const [snapshot, setSnapshot] = useState<FluxSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [namespace, setNamespace] = useState<string | null>(null);
  const [tab, setTab] = useState<string | null>("overview");
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [selected, setSelected] = useState<ObjectRef | null>(null);
  const inFlight = useRef(false);

  const load = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    fluxSnapshot()
      .then((s) => {
        setSnapshot(s);
        setError(null);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => {
        inFlight.current = false;
        setNow(Date.now());
      });
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshKey]);
  useInterval(load, REFRESH_MS, { autoInvoke: true });

  const objects = useMemo(
    () => (snapshot?.objects ?? []).filter((o) => !namespace || o.namespace === namespace),
    [snapshot, namespace],
  );
  const namespaces = useMemo(
    () => [...new Set((snapshot?.objects ?? []).map((o) => o.namespace))].sort(),
    [snapshot],
  );
  const selectedObject = useMemo(
    () => (selected && snapshot?.objects.find((o) => refKey(o) === refKey(selected))) || null,
    [selected, snapshot],
  );

  if (!snapshot) {
    return error ? (
      <Alert color="red" icon={<IconAlertCircle size={18} />} title="Could not load Flux">
        {error}
      </Alert>
    ) : (
      <Center p="xl">
        <Loader />
      </Center>
    );
  }

  if (snapshot.kinds.length === 0) {
    return (
      <Center p="xl">
        <Stack align="center" gap="xs" maw={420}>
          <ThemeIcon size={48} radius="xl" variant="light" color="gray">
            <IconBrandGit size={26} />
          </ThemeIcon>
          <Text fw={600}>Flux isn&apos;t installed on this cluster</Text>
          <Text size="sm" c="dimmed" ta="center">
            No Flux CRDs were found. Once Flux is bootstrapped, its sources, Kustomizations and HelmReleases show up here.
          </Text>
        </Stack>
      </Center>
    );
  }

  return (
    <Stack gap="md">
      <ClusterStrip snapshot={snapshot} now={now} onSelect={setSelected} />

      {error && (
        <Alert color="orange" icon={<IconAlertCircle size={18} />} title="Refresh failed; showing the last snapshot">
          {error}
        </Alert>
      )}
      {snapshot.errors.length > 0 && (
        <Alert color="yellow" icon={<IconAlertCircle size={18} />} title="Some Flux objects could not be listed">
          {snapshot.errors.join("\n")}
        </Alert>
      )}

      {/* One filter row; it scopes every tile, chart and table below. */}
      <Group justify="space-between">
        <Select
          aria-label="Namespace filter"
          placeholder="All namespaces"
          data={namespaces}
          value={namespace}
          onChange={setNamespace}
          searchable
          clearable
          w={260}
        />
        <Text size="xs" c="dimmed">
          Updated {new Date(now).toLocaleTimeString()} · refreshes every {REFRESH_MS / 1000}s
        </Text>
      </Group>

      <Tabs value={tab} onChange={setTab}>
        <Tabs.List>
          <Tabs.Tab value="overview">Overview</Tabs.Tab>
          <Tabs.Tab value="resources">Resources ({objects.length})</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="overview" pt="md">
          <FluxOverview
            objects={objects}
            now={now}
            onSelect={setSelected}
            onNamespace={setNamespace}
            onShowFailing={() => {
              setStatusFilter("failing");
              setTab("resources");
            }}
          />
        </Tabs.Panel>
        <Tabs.Panel value="resources" pt="md">
          <FluxResources
            objects={objects}
            now={now}
            status={statusFilter}
            onStatusChange={setStatusFilter}
            onSelect={setSelected}
          />
        </Tabs.Panel>
      </Tabs>

      <FluxDetailDrawer
        object={selectedObject}
        now={now}
        onClose={() => setSelected(null)}
        onChanged={load}
        onSelect={setSelected}
      />
    </Stack>
  );
}

/** Cluster-wide context that the namespace filter doesn't apply to. */
function ClusterStrip({
  snapshot,
  now,
  onSelect,
}: {
  snapshot: FluxSnapshot;
  now: number;
  onSelect: (ref: ObjectRef) => void;
}) {
  const repos = snapshot.objects.filter((o) => o.kind === "GitRepository" || o.kind === "OCIRepository");
  const kustomizations = snapshot.objects.filter((o) => o.kind === "Kustomization");
  const healthy = snapshot.controllers.filter((c) => c.healthy).length;

  return (
    <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
      <Paper withBorder radius="md" p="md">
        <Group gap="xs" mb={6}>
          <IconBrandGit size={18} />
          <Text fw={600}>Sources</Text>
        </Group>
        {repos.length === 0 && (
          <Text size="sm" c="dimmed">
            No Git or OCI repositories.
          </Text>
        )}
        <Stack gap={6}>
          {repos.map((r) => {
            const applied = kustomizations.filter((k) => k.source && refKey(k.source) === refKey(r));
            const lastApplied = applied.map((k) => k.last_transition).sort().at(-1) ?? null;
            return (
              <Group key={refKey(r)} gap="xs" wrap="nowrap" style={{ cursor: "pointer" }} onClick={() => onSelect(r)}>
                <Badge variant="light" color={r.status === "ready" ? "green" : "red"} style={{ textTransform: "none", flexShrink: 0 }}>
                  {shortRevision(r.revision) ?? "no artifact"}
                </Badge>
                <Text size="sm" ff="monospace" truncate="end" title={r.url ?? undefined}>
                  {r.url ?? r.name}
                </Text>
                {applied.length > 0 && (
                  <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
                    applied by {applied.length} Kustomization{applied.length > 1 ? "s" : ""}
                    {lastApplied && `, ${formatAge(lastApplied, now)} ago`}
                  </Text>
                )}
              </Group>
            );
          })}
        </Stack>
      </Paper>

      <Paper withBorder radius="md" p="md">
        <Group gap="xs" mb={6}>
          <IconServer size={18} />
          <Text fw={600}>Controllers</Text>
          <Text size="sm" c="dimmed">
            {healthy} of {snapshot.controllers.length} healthy
          </Text>
        </Group>
        <Group gap="xs">
          {snapshot.controllers.map((c) => (
            <Tooltip key={c.name} label={`${c.namespace}/${c.name} · ${c.ready} ready`} withArrow>
              <Badge variant="light" color={c.healthy ? "green" : "red"} style={{ textTransform: "none" }}>
                {c.name.replace(/-controller$/, "")} {c.version}
              </Badge>
            </Tooltip>
          ))}
        </Group>
      </Paper>
    </SimpleGrid>
  );
}
