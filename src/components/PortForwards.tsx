"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Checkbox,
  CopyButton,
  Group,
  NumberInput,
  Stack,
  Table,
  Text,
  Tooltip,
} from "@mantine/core";
import { useInterval } from "@mantine/hooks";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { IconAlertCircle, IconCheck, IconCopy, IconExternalLink, IconPlayerStop } from "@tabler/icons-react";
import * as k8s from "@/lib/k8s";

const POLL_MS = 2000;
const OPEN_BROWSER_KEY = "k8sview.portForward.openBrowser";

interface PortForwardsValue {
  forwards: k8s.PortForwardInfo[];
  start: (namespace: string, pod: string, port: number, localPort: number | null) => Promise<k8s.PortForwardInfo>;
  stop: (id: number) => Promise<void>;
}

const PortForwardsContext = createContext<PortForwardsValue | null>(null);

export function usePortForwards(): PortForwardsValue {
  const value = useContext(PortForwardsContext);
  if (!value) throw new Error("usePortForwards must be used inside PortForwardsProvider");
  return value;
}

/**
 * Mirrors the backend's list of forwards. It sits above ModalsProvider so the
 * start dialog (rendered by the modals manager) can use it too.
 */
export function PortForwardsProvider({ children }: { children: ReactNode }) {
  const [forwards, setForwards] = useState<k8s.PortForwardInfo[]>([]);

  const refresh = useCallback(() => {
    k8s.listPortForwards().then(setForwards, () => {
      // Outside Tauri there is no backend; the views already report that.
    });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);
  useInterval(refresh, POLL_MS, { autoInvoke: true });

  const start = useCallback<PortForwardsValue["start"]>(
    async (namespace, pod, port, localPort) => {
      const info = await k8s.startPortForward(namespace, pod, port, localPort);
      refresh();
      return info;
    },
    [refresh],
  );

  const stop = useCallback(
    async (id: number) => {
      await k8s.stopPortForward(id);
      refresh();
    },
    [refresh],
  );

  return <PortForwardsContext.Provider value={{ forwards, start, stop }}>{children}</PortForwardsContext.Provider>;
}

/** Open the "start port forward" dialog. `port` pre-fills the pod port. */
export function openPortForwardDialog(namespace: string, pod: string, port?: number) {
  const id = modals.open({
    title: `Port forward ${pod}`,
    children: <PortForwardForm namespace={namespace} pod={pod} port={port} onDone={() => modals.close(id)} />,
  });
}

function PortForwardForm({
  namespace,
  pod,
  port,
  onDone,
}: {
  namespace: string;
  pod: string;
  port?: number;
  onDone: () => void;
}) {
  const { start } = usePortForwards();
  const [podPort, setPodPort] = useState<string | number>(port ?? "");
  // Reuse the pod port locally unless it is privileged.
  const [localPort, setLocalPort] = useState<string | number>(port && port >= 1024 ? port : "");
  const [openBrowser, setOpenBrowser] = useState(() => localStorage.getItem(OPEN_BROWSER_KEY) !== "false");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (typeof podPort !== "number") return;
    setBusy(true);
    setError(null);
    localStorage.setItem(OPEN_BROWSER_KEY, String(openBrowser));
    try {
      const info = await start(namespace, pod, podPort, typeof localPort === "number" ? localPort : null);
      onDone();
      notifications.show({
        color: "green",
        title: "Port forward started",
        message: `${k8s.localUrl(info.local_port)} → ${pod}:${info.pod_port}`,
      });
      if (openBrowser) await k8s.openLocalPort(info.local_port);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Stack>
        <Text size="sm" c="dimmed">
          Namespace {namespace}
        </Text>
        <NumberInput
          label="Pod port"
          required
          min={1}
          max={65535}
          allowDecimal={false}
          allowNegative={false}
          value={podPort}
          onChange={setPodPort}
          data-autofocus={port === undefined || undefined}
        />
        <NumberInput
          label="Local port"
          description="Leave empty to pick a free port"
          placeholder="random"
          min={1}
          max={65535}
          allowDecimal={false}
          allowNegative={false}
          value={localPort}
          onChange={setLocalPort}
          data-autofocus={port !== undefined || undefined}
        />
        <Checkbox
          label="Open in browser"
          checked={openBrowser}
          onChange={(e) => setOpenBrowser(e.currentTarget.checked)}
        />
        {error && (
          <Alert color="red" icon={<IconAlertCircle size={18} />}>
            {error}
          </Alert>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} disabled={typeof podPort !== "number"}>
            Start
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

export function PortForwardsView() {
  const { forwards, stop } = usePortForwards();

  const stopForward = async (f: k8s.PortForwardInfo) => {
    try {
      await stop(f.id);
    } catch (e) {
      notifications.show({ color: "red", title: "Failed to stop port forward", message: (e as Error).message });
    }
  };

  if (forwards.length === 0) {
    return (
      <Text c="dimmed" ta="center" py="xl">
        No active port forwards. Start one from a pod&apos;s menu or from the ports in its detail drawer.
      </Text>
    );
  }

  return (
    <Table striped verticalSpacing="xs">
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Local address</Table.Th>
          <Table.Th>Pod</Table.Th>
          <Table.Th>Pod port</Table.Th>
          <Table.Th>Context</Table.Th>
          <Table.Th>Connections</Table.Th>
          <Table.Th>Status</Table.Th>
          <Table.Th w={110} />
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {forwards.map((f) => {
          const url = k8s.localUrl(f.local_port);
          return (
            <Table.Tr key={f.id}>
              <Table.Td>
                <Anchor ff="monospace" fz="sm" onClick={() => void k8s.openLocalPort(f.local_port)}>
                  {url}
                </Anchor>
              </Table.Td>
              <Table.Td ff="monospace" fz="sm">
                {f.namespace}/{f.pod}
              </Table.Td>
              <Table.Td>{f.pod_port}</Table.Td>
              <Table.Td>
                <Text size="sm" c="dimmed">
                  {f.context}
                </Text>
              </Table.Td>
              <Table.Td>
                {f.active_connections} open / {f.total_connections} total
              </Table.Td>
              <Table.Td>
                {f.last_error ? (
                  <Tooltip label={f.last_error} multiline w={400} withArrow>
                    <Badge color="orange" variant="light">
                      last connection failed
                    </Badge>
                  </Tooltip>
                ) : (
                  <Badge color="green" variant="light">
                    listening
                  </Badge>
                )}
              </Table.Td>
              <Table.Td>
                <Group gap={4} wrap="nowrap">
                  <Tooltip label="Open in browser">
                    <ActionIcon variant="subtle" color="gray" onClick={() => void k8s.openLocalPort(f.local_port)}>
                      <IconExternalLink size={16} />
                    </ActionIcon>
                  </Tooltip>
                  <CopyButton value={url}>
                    {({ copied, copy }) => (
                      <Tooltip label={copied ? "Copied" : "Copy address"}>
                        <ActionIcon variant="subtle" color={copied ? "teal" : "gray"} onClick={copy}>
                          {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                        </ActionIcon>
                      </Tooltip>
                    )}
                  </CopyButton>
                  <Tooltip label="Stop">
                    <ActionIcon variant="subtle" color="red" onClick={() => void stopForward(f)}>
                      <IconPlayerStop size={16} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
              </Table.Td>
            </Table.Tr>
          );
        })}
      </Table.Tbody>
    </Table>
  );
}
