"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Center,
  CopyButton,
  Group,
  Loader,
  MultiSelect,
  SegmentedControl,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { IconAlertCircle, IconArrowsDiff, IconCheck, IconCopy, IconSearch } from "@tabler/icons-react";
import { listWorkloadVersions, type WorkloadVersion } from "@/lib/k8s";

type Mode = "image" | "app" | "chart";
type Layout = "matrix" | "list";

const NAMESPACES_KEY = "k8sview.versions.namespaces";
const MODES: { value: Mode; label: string }[] = [
  { value: "image", label: "Image" },
  { value: "app", label: "App version" },
  { value: "chart", label: "Chart" },
];

const shortDigest = (d: string) => d.replace(/^sha256:/, "").slice(0, 7);
/** "docker.io/dnsbusiness/damsr:1.3.13" → "docker.io/dnsbusiness/damsr". */
const repoOf = (image: string) => image.replace(/@.*$/, "").replace(/:[^/]*$/, "");
/** Tags that don't pin a build, so the running digest is the real version. */
const isMutable = (tag: string) => tag === "latest" || tag.startsWith("sha256:");

/** What two workloads must share to count as "the same version" in a mode. */
function compareKey(w: WorkloadVersion, mode: Mode): string {
  if (mode === "app") return w.app_version ?? "—";
  if (mode === "chart") return w.chart_version ?? "—";
  return w.containers.map((c) => (c.running.length ? c.running.join("+") : c.image)).join(" | ");
}

interface Row {
  key: string;
  name: string;
  kind: string;
  /** All namespaces, so `latest` can be resolved against any of them. */
  byNs: Map<string, WorkloadVersion>;
  /** Present cells among the visible namespaces. */
  visible: WorkloadVersion[];
  distinct: number;
  majority: string | null;
}

export function VersionsView({ refreshKey }: { refreshKey: number }) {
  const [data, setData] = useState<WorkloadVersion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [namespaces, setNamespaces] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(NAMESPACES_KEY) ?? "[]");
    } catch {
      return [];
    }
  });
  const [mode, setMode] = useState<Mode>("image");
  const [layout, setLayout] = useState<Layout>("matrix");
  const [onlyDiff, setOnlyDiff] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    let cancelled = false;
    listWorkloadVersions()
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setError(null);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const changeNamespaces = (ns: string[]) => {
    setNamespaces(ns);
    localStorage.setItem(NAMESPACES_KEY, JSON.stringify(ns));
  };

  const allNamespaces = useMemo(() => [...new Set((data ?? []).map((w) => w.namespace))].sort(), [data]);
  // Drop saved namespaces that no longer exist (e.g. after a context switch).
  const selected = namespaces.filter((ns) => allNamespaces.includes(ns));
  const columns = selected.length ? selected : allNamespaces;

  const rows = useMemo<Row[]>(() => {
    const grouped = new Map<string, Row>();
    for (const w of data ?? []) {
      const key = `${w.kind}/${w.name}`;
      const row = grouped.get(key) ?? { key, name: w.name, kind: w.kind, byNs: new Map(), visible: [], distinct: 0, majority: null };
      row.byNs.set(w.namespace, w);
      grouped.set(key, row);
    }
    const q = search.trim().toLowerCase();
    return [...grouped.values()]
      .map((row) => {
        const visible = columns.map((ns) => row.byNs.get(ns)).filter((w): w is WorkloadVersion => !!w);
        const counts = new Map<string, number>();
        for (const w of visible) counts.set(compareKey(w, mode), (counts.get(compareKey(w, mode)) ?? 0) + 1);
        const majority = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
        return { ...row, visible, distinct: counts.size, majority };
      })
      .filter((r) => r.visible.length > 0)
      .filter((r) => !onlyDiff || r.distinct > 1)
      .filter((r) => !q || r.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind));
  }, [data, columns, mode, onlyDiff, search]);

  const differing = rows.filter((r) => r.distinct > 1).length;

  if (!data) {
    return error ? (
      <Alert color="red" icon={<IconAlertCircle size={18} />} title="Could not load workloads">
        {error}
      </Alert>
    ) : (
      <Center p="xl">
        <Loader />
      </Center>
    );
  }

  return (
    <Stack gap="md">
      {/* One filter row; it scopes both layouts. */}
      <Group gap="sm" align="flex-end">
        <MultiSelect
          label="Namespaces"
          placeholder={selected.length ? undefined : "All namespaces"}
          data={allNamespaces}
          value={selected}
          onChange={changeNamespaces}
          searchable
          clearable
          w={420}
          maxDropdownHeight={320}
        />
        <TextInput
          label="App"
          placeholder="Filter by name"
          leftSection={<IconSearch size={16} />}
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          w={220}
        />
        <Stack gap={4}>
          <Text size="sm" fw={500}>
            Compare
          </Text>
          <SegmentedControl value={mode} onChange={(v) => setMode(v as Mode)} data={MODES} />
        </Stack>
        <Switch
          label="Only differences"
          checked={onlyDiff}
          onChange={(e) => setOnlyDiff(e.currentTarget.checked)}
          mb={8}
        />
        <SegmentedControl
          ml="auto"
          value={layout}
          onChange={(v) => setLayout(v as Layout)}
          data={[
            { value: "matrix", label: "Matrix" },
            { value: "list", label: "List" },
          ]}
        />
      </Group>

      {error && (
        <Alert color="orange" icon={<IconAlertCircle size={18} />} title="Refresh failed; showing the last result">
          {error}
        </Alert>
      )}

      <Group justify="space-between">
        <Text size="sm" c="dimmed">
          {rows.length} apps · {columns.length} namespaces ·{" "}
          <Text span inherit c={differing ? "blue" : "dimmed"} fw={differing ? 600 : undefined}>
            {differing} with differing {MODES.find((m) => m.value === mode)!.label.toLowerCase()} versions
          </Text>
        </Text>
        {layout === "list" && <CsvButton rows={rows} columns={columns} />}
      </Group>

      {rows.length === 0 ? (
        <Text c="dimmed" ta="center" py="xl">
          {onlyDiff ? "No differences in the selected namespaces." : "No workloads match."}
        </Text>
      ) : layout === "matrix" ? (
        <Matrix rows={rows} columns={columns} mode={mode} />
      ) : (
        <List rows={rows} columns={columns} />
      )}
    </Stack>
  );
}

const stickyCol = {
  position: "sticky" as const,
  left: 0,
  zIndex: 2,
  background: "var(--mantine-color-body)",
  borderRight: "1px solid var(--mantine-color-default-border)",
};

function Matrix({ rows, columns, mode }: { rows: Row[]; columns: string[]; mode: Mode }) {
  return (
    <Table.ScrollContainer minWidth={240 + columns.length * 120} maxHeight="calc(100vh - 260px)">
      <Table stickyHeader withColumnBorders verticalSpacing={6} fz="xs">
        <Table.Thead>
          <Table.Tr>
            <Table.Th style={{ ...stickyCol, zIndex: 3 }} w={240}>
              App
            </Table.Th>
            {columns.map((ns) => (
              <Table.Th key={ns} miw={120} ta="center" style={{ whiteSpace: "nowrap" }}>
                {ns}
              </Table.Th>
            ))}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((row) => (
            <Table.Tr key={row.key}>
              <Table.Td style={stickyCol}>
                <Group gap={6} wrap="nowrap">
                  <Text size="sm" fw={500} truncate="end">
                    {row.name}
                  </Text>
                  <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
                    {row.kind}
                  </Text>
                  {row.distinct > 1 && (
                    <Tooltip label={`${row.distinct} different versions across ${row.visible.length} namespaces`} withArrow>
                      <IconArrowsDiff size={14} color="var(--mantine-color-blue-6)" style={{ flexShrink: 0 }} aria-label="Versions differ" />
                    </Tooltip>
                  )}
                </Group>
              </Table.Td>
              {columns.map((ns) => {
                const w = row.byNs.get(ns);
                return (
                  <Table.Td key={ns} ta="center">
                    {w ? <Cell w={w} row={row} mode={mode} /> : <Text c="dimmed">—</Text>}
                  </Table.Td>
                );
              })}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

function Cell({ w, row, mode }: { w: WorkloadVersion; row: Row; mode: Mode }) {
  // Emphasis, not a palette: the row's majority version stays plain ink; anything else is the accent.
  const outlier = row.distinct > 1 && compareKey(w, mode) !== row.majority;
  const main = w.containers[0];

  let label: string;
  let sub: string | null = null;
  if (mode === "app") label = w.app_version ?? "—";
  else if (mode === "chart") label = w.chart_version ?? "—";
  else {
    label = main?.version ?? "—";
    const digest = main?.running[0];
    if (digest) {
      sub = shortDigest(digest);
      if (isMutable(label)) {
        // Resolve `latest` to a pinned tag running the same build in any namespace.
        const alias = [...row.byNs.values()]
          .map((o) => o.containers[0])
          .find((c) => c && !isMutable(c.version) && c.running.includes(digest));
        if (alias) label = `${label} = ${alias.version}`;
      }
      if (main.running.length > 1) sub = `${main.running.length} builds`;
    }
    // Same app name, different image repository: say which one.
    const repos = new Set([...row.byNs.values()].map((o) => o.containers[0] && repoOf(o.containers[0].image)));
    if (main && repos.size > 1) {
      const repo = repoOf(main.image).split("/").pop();
      sub = sub ? `${repo} · ${sub}` : repo ?? null;
    }
  }

  return (
    <Tooltip label={<CellDetails w={w} />} multiline w={420} withArrow openDelay={150}>
      <Stack gap={0} align="center" tabIndex={0} style={{ cursor: "default" }}>
        {outlier ? (
          <Badge variant="light" color="blue" size="sm" style={{ textTransform: "none", fontFamily: "var(--mantine-font-family-monospace)" }}>
            {label}
          </Badge>
        ) : (
          <Text size="xs" ff="monospace">
            {label}
          </Text>
        )}
        {sub && (
          <Text size="10px" c="dimmed" ff="monospace">
            {sub}
          </Text>
        )}
      </Stack>
    </Tooltip>
  );
}

function CellDetails({ w }: { w: WorkloadVersion }) {
  return (
    <Stack gap={4}>
      <Text size="xs" fw={600}>
        {w.kind} {w.namespace}/{w.name}
        {w.ready && ` · ${w.ready} ready`}
      </Text>
      {w.containers.map((c) => (
        <Text key={c.name} size="xs" ff="monospace" style={{ wordBreak: "break-all" }}>
          {c.name}: {c.image}
          {c.running.map((d) => (
            <span key={d}>
              <br />
              {"  running "}
              {d.slice(0, 19)}…
            </span>
          ))}
        </Text>
      ))}
      {(w.chart || w.app_version) && (
        <Text size="xs">
          {w.chart && `chart ${w.chart}`}
          {w.chart && w.app_version && " · "}
          {w.app_version && `app ${w.app_version}`}
        </Text>
      )}
      {w.helm_release && <Text size="xs">HelmRelease {w.helm_release}</Text>}
    </Stack>
  );
}

/** One row per container in the visible namespaces. */
function listRows(rows: Row[], columns: string[]) {
  return rows.flatMap((r) =>
    columns
      .map((ns) => r.byNs.get(ns))
      .filter((w): w is WorkloadVersion => !!w)
      .flatMap((w) => w.containers.map((c) => ({ w, c, differs: r.distinct > 1 }))),
  );
}

function List({ rows, columns }: { rows: Row[]; columns: string[] }) {
  return (
    <Table.ScrollContainer minWidth={1100} maxHeight="calc(100vh - 260px)">
      <Table stickyHeader striped verticalSpacing={6} fz="xs">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>App</Table.Th>
            <Table.Th>Namespace</Table.Th>
            <Table.Th>Container</Table.Th>
            <Table.Th>Image</Table.Th>
            <Table.Th>Tag</Table.Th>
            <Table.Th>Running</Table.Th>
            <Table.Th>App version</Table.Th>
            <Table.Th>Chart</Table.Th>
            <Table.Th>Ready</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {listRows(rows, columns).map(({ w, c, differs }) => (
            <Table.Tr key={`${w.kind}/${w.namespace}/${w.name}/${c.name}`}>
              <Table.Td>
                <Group gap={4} wrap="nowrap">
                  {w.name}
                  {differs && <IconArrowsDiff size={12} color="var(--mantine-color-blue-6)" aria-label="Versions differ" />}
                </Group>
              </Table.Td>
              <Table.Td>{w.namespace}</Table.Td>
              <Table.Td>{c.name}</Table.Td>
              <Table.Td ff="monospace" style={{ wordBreak: "break-all" }}>
                {c.image.split(/[:@]/)[0]}
              </Table.Td>
              <Table.Td ff="monospace">{c.version}</Table.Td>
              <Table.Td ff="monospace">{c.running.map(shortDigest).join(", ") || "—"}</Table.Td>
              <Table.Td ff="monospace">{w.app_version ?? "—"}</Table.Td>
              <Table.Td ff="monospace">{w.chart_version ?? "—"}</Table.Td>
              <Table.Td>{w.ready ?? "—"}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

function CsvButton({ rows, columns }: { rows: Row[]; columns: string[] }) {
  const quote = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const header = ["app", "kind", "namespace", "container", "image", "tag", "running", "app_version", "chart_version", "ready"];
  const csv = [
    header.join(","),
    ...listRows(rows, columns).map(({ w, c }) =>
      [w.name, w.kind, w.namespace, c.name, c.image, c.version, c.running.join(" "), w.app_version ?? "", w.chart_version ?? "", w.ready ?? ""]
        .map(quote)
        .join(","),
    ),
  ].join("\n");
  return (
    <CopyButton value={csv}>
      {({ copied, copy }) => (
        <Button size="xs" variant="default" leftSection={copied ? <IconCheck size={14} /> : <IconCopy size={14} />} onClick={copy}>
          {copied ? "Copied" : "Copy as CSV"}
        </Button>
      )}
    </CopyButton>
  );
}
