"use client";

import { useMemo, useState } from "react";
import { Badge, Group, Select, Stack, Table, Text, TextInput, Tooltip } from "@mantine/core";
import { IconSearch } from "@tabler/icons-react";
import { formatAge } from "@/lib/k8s";
import { refKey, shortRevision, type FluxObject, type FluxStatus, type ObjectRef } from "@/lib/flux";
import { STATUS, StatusBadge } from "./status";

const STATUS_ORDER: FluxStatus[] = ["failing", "progressing", "unknown", "suspended", "ready"];

interface Props {
  objects: FluxObject[];
  now: number;
  status: string | null;
  onStatusChange: (status: string | null) => void;
  onSelect: (ref: ObjectRef) => void;
}

export function FluxResources({ objects, now, status, onStatusChange, onSelect }: Props) {
  const [kind, setKind] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const kinds = useMemo(() => [...new Set(objects.map((o) => o.kind))].sort(), [objects]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return objects
      .filter((o) => (!kind || o.kind === kind) && (!status || o.status === status))
      .filter((o) => !q || `${o.namespace}/${o.name}`.toLowerCase().includes(q))
      .sort(
        (a, b) =>
          STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
          a.kind.localeCompare(b.kind) ||
          a.namespace.localeCompare(b.namespace) ||
          a.name.localeCompare(b.name),
      );
  }, [objects, kind, status, search]);

  return (
    <Stack>
      <Group justify="space-between">
        <Group gap="sm">
          <TextInput
            placeholder="Filter by name"
            leftSection={<IconSearch size={16} />}
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            w={260}
          />
          <Select
            placeholder="All kinds"
            data={kinds}
            value={kind}
            onChange={setKind}
            clearable
            w={190}
            aria-label="Kind"
          />
          <Select
            placeholder="All statuses"
            data={STATUS_ORDER.map((s) => ({ value: s, label: STATUS[s].label }))}
            value={status}
            onChange={onStatusChange}
            clearable
            w={170}
            aria-label="Status"
          />
        </Group>
        <Text size="sm" c="dimmed">
          {rows.length} of {objects.length} objects
        </Text>
      </Group>

      <Table striped highlightOnHover verticalSpacing="xs" fz="sm">
        <Table.Thead>
          <Table.Tr>
            <Table.Th w={130}>Status</Table.Th>
            <Table.Th>Kind</Table.Th>
            <Table.Th>Name</Table.Th>
            <Table.Th>Revision</Table.Th>
            <Table.Th>Source</Table.Th>
            <Table.Th>Changed</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((o) => (
            <Table.Tr key={refKey(o)} onClick={() => onSelect(o)} style={{ cursor: "pointer" }}>
              <Table.Td>
                <Tooltip
                  label={[o.reason, o.message].filter(Boolean).join(": ") || STATUS[o.status].label}
                  multiline
                  w={420}
                  withArrow
                  openDelay={300}
                >
                  <span>
                    <StatusBadge status={o.status} />
                  </span>
                </Tooltip>
              </Table.Td>
              <Table.Td>
                <Badge variant="outline" color="gray" size="sm">
                  {o.kind}
                </Badge>
              </Table.Td>
              <Table.Td ff="monospace" fz="xs">
                <Text span inherit c="dimmed">
                  {o.namespace}/
                </Text>
                {o.name}
              </Table.Td>
              <Table.Td ff="monospace" fz="xs">
                {o.chart ?? shortRevision(o.revision) ?? "-"}
              </Table.Td>
              <Table.Td fz="xs">{o.source ? `${o.source.kind}/${o.source.name}` : "-"}</Table.Td>
              <Table.Td fz="xs">{formatAge(o.last_transition, now)}</Table.Td>
            </Table.Tr>
          ))}
          {rows.length === 0 && (
            <Table.Tr>
              <Table.Td colSpan={6}>
                <Text c="dimmed" ta="center" py="md">
                  No Flux objects match.
                </Text>
              </Table.Td>
            </Table.Tr>
          )}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}
