"use client";

import { useEffect, useMemo, useState } from "react";
import { Alert, Center, Drawer, Group, Loader, Stack, Table, Text, TextInput } from "@mantine/core";
import { IconAlertCircle, IconSearch } from "@tabler/icons-react";
import { formatAge, listConfigMaps, type ConfigMapRow } from "@/lib/k8s";
import { ConfigMapData } from "./ConfigMapData";

interface Props {
  namespace: string;
  /** Bumped by the header refresh button. */
  refreshKey: number;
}

export function ConfigMapsView({ namespace, refreshKey }: Props) {
  const [items, setItems] = useState<ConfigMapRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<ConfigMapRow | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    listConfigMaps(namespace)
      .then((rows) => {
        if (cancelled) return;
        setItems(rows);
        setError(null);
      })
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setNow(Date.now()));
    return () => {
      cancelled = true;
    };
  }, [namespace, refreshKey]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (items ?? []).filter((cm) => cm.name.toLowerCase().includes(q));
  }, [items, search]);

  return (
    <Stack>
      <Group justify="space-between">
        <TextInput
          placeholder="Filter ConfigMaps"
          leftSection={<IconSearch size={16} />}
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          w={320}
        />
        <Text size="sm" c="dimmed">
          {items ? `${filtered.length} of ${items.length} ConfigMaps` : ""}
        </Text>
      </Group>

      {error && (
        <Alert color="red" icon={<IconAlertCircle size={18} />} title="Could not list ConfigMaps">
          {error}
        </Alert>
      )}

      {items === null && !error ? (
        <Center p="xl">
          <Loader />
        </Center>
      ) : (
        <Table striped highlightOnHover verticalSpacing="xs">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Name</Table.Th>
              <Table.Th>Keys</Table.Th>
              <Table.Th>Age</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {filtered.map((cm) => (
              <Table.Tr key={cm.name} onClick={() => setSelected(cm)} style={{ cursor: "pointer" }}>
                <Table.Td ff="monospace" fz="sm">
                  {cm.name}
                </Table.Td>
                <Table.Td>{cm.keys}</Table.Td>
                <Table.Td>{formatAge(cm.created, now)}</Table.Td>
              </Table.Tr>
            ))}
            {items !== null && filtered.length === 0 && (
              <Table.Tr>
                <Table.Td colSpan={3}>
                  <Text c="dimmed" ta="center" py="md">
                    {items.length === 0 ? `No ConfigMaps in ${namespace}` : "No ConfigMaps match the filter"}
                  </Text>
                </Table.Td>
              </Table.Tr>
            )}
          </Table.Tbody>
        </Table>
      )}

      <Drawer
        opened={selected !== null}
        onClose={() => setSelected(null)}
        position="right"
        size="xl"
        title={
          <Text fw={600} ff="monospace">
            {selected?.name}
          </Text>
        }
      >
        {selected && <ConfigMapData data={selected.data} />}
      </Drawer>
    </Stack>
  );
}
