"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActionIcon,
  Alert,
  AppShell,
  Badge,
  Button,
  Group,
  NavLink,
  Select,
  Title,
  Tooltip,
} from "@mantine/core";
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconBox,
  IconFileSettings,
  IconBrandGit,
  IconPlugConnected,
  IconVersions,
  IconActivity,
  IconRefresh,
} from "@tabler/icons-react";
import * as k8s from "@/lib/k8s";
import { PodsTable } from "@/components/PodsTable";
import { ConfigMapsView } from "@/components/ConfigMapsView";
import { FluxView } from "@/components/flux/FluxView";
import { VersionsView } from "@/components/VersionsView";
import { UsageProvider } from "@/components/usage/UsageProvider";
import { UsageView } from "@/components/usage/UsageView";
import { ColorSchemeToggle } from "@/components/ColorSchemeToggle";
import { Logo } from "@/components/Logo";
import { UpdateStatus } from "@/components/UpdateStatus";
import { useAppInfo } from "@/components/useAppInfo";
import { DOCK_HEADER, LogDock, useLogDock } from "@/components/logs/LogDock";
import { PortForwardsView, usePortForwards } from "@/components/PortForwards";

type View = "pods" | "configmaps" | "usage" | "versions" | "flux" | "portforwards";

const CONTEXT_KEY = "k8sview.context";
const namespaceKey = (context: string) => `k8sview.namespace.${context}`;

export default function Home() {
  const [contexts, setContexts] = useState<k8s.ContextInfo[]>([]);
  const [context, setContext] = useState<string | null>(null);
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [namespace, setNamespace] = useState<string | null>(null);
  const [view, setView] = useState<View>("pods");
  const [refreshKey, setRefreshKey] = useState(0);
  const [switching, setSwitching] = useState(false);
  const [connError, setConnError] = useState<string | null>(null);
  const [nsWarning, setNsWarning] = useState<string | null>(null);
  const started = useRef(false);
  const { forwards } = usePortForwards();
  const dock = useLogDock();
  const appInfo = useAppInfo();

  /** Point the backend at `name`, then load its namespaces and pick one. */
  const activate = useCallback(async (name: string, known: k8s.ContextInfo[]) => {
    setSwitching(true);
    setConnError(null);
    setNsWarning(null);
    setContext(name);
    setNamespace(null);
    localStorage.setItem(CONTEXT_KEY, name);
    try {
      await k8s.setContext(name);
    } catch (e) {
      setConnError((e as Error).message);
      setNamespaces([]);
      setSwitching(false);
      return;
    }

    const preferred = [
      localStorage.getItem(namespaceKey(name)),
      known.find((c) => c.name === name)?.namespace,
      "default",
    ].filter((ns): ns is string => !!ns);
    try {
      const list = await k8s.listNamespaces();
      setNamespaces(list);
      setNamespace(preferred.find((ns) => list.includes(ns)) ?? list[0] ?? preferred[0]);
    } catch (e) {
      // Often RBAC: the user may be allowed into a namespace without being able to list them all.
      setNsWarning((e as Error).message);
      setNamespaces([preferred[0]]);
      setNamespace(preferred[0]);
    }
    setSwitching(false);
  }, []);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    k8s
      .listContexts()
      .then(({ contexts: list, current }) => {
        setContexts(list);
        const saved = localStorage.getItem(CONTEXT_KEY);
        const initial = list.some((c) => c.name === saved) ? saved : current;
        if (!initial) {
          setConnError("No contexts found in your kubeconfig.");
          return;
        }
        void activate(initial, list);
      })
      .catch((e: Error) => setConnError(e.message));
  }, [activate]);

  const changeNamespace = (ns: string | null) => {
    if (!ns || !context) return;
    setNamespace(ns);
    localStorage.setItem(namespaceKey(context), ns);
  };

  const ready = context && namespace && !connError && !switching;

  return (
    // Usage history belongs to one cluster; a new context starts a fresh sampler.
    <UsageProvider key={context ?? ""}>
    <AppShell
      header={{ height: 60 }}
      navbar={{ width: 200, breakpoint: 0 }}
      footer={dock.sessions.length ? { height: dock.collapsed ? DOCK_HEADER : dock.height } : undefined}
      padding="md"
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap="xs" wrap="nowrap">
            <Logo />
            <Title order={4}>k8sview</Title>
            {appInfo?.dev && (
              <Tooltip label="A local build (pnpm tauri dev / tauri build), not a release" withArrow>
                <Badge color="orange" variant="light" size="sm">
                  dev
                </Badge>
              </Tooltip>
            )}
          </Group>
          <Group gap="sm" wrap="nowrap">
            <Select
              aria-label="Context"
              placeholder="Context"
              data={contexts.map((c) => c.name)}
              value={context}
              onChange={(name) => name && name !== context && void activate(name, contexts)}
              allowDeselect={false}
              searchable
              disabled={switching}
              w={300}
            />
            <Select
              aria-label="Namespace"
              placeholder="Namespace"
              data={namespaces}
              value={namespace}
              onChange={changeNamespace}
              allowDeselect={false}
              searchable
              nothingFoundMessage="No such namespace"
              // Usage, Versions, Flux and port forwards are cluster-wide; they have their own scope.
              disabled={switching || namespaces.length === 0 || ["usage", "versions", "flux", "portforwards"].includes(view)}
              w={220}
            />
            <Tooltip label="Refresh">
              <ActionIcon
                variant="default"
                size="lg"
                aria-label="Refresh"
                onClick={() => setRefreshKey((k) => k + 1)}
                disabled={!ready}
              >
                <IconRefresh size={18} />
              </ActionIcon>
            </Tooltip>
            <ColorSchemeToggle />
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar>
        <AppShell.Section grow p="xs">
        <NavLink
          label="Pods"
          leftSection={<IconBox size={18} />}
          active={view === "pods"}
          onClick={() => setView("pods")}
        />
        <NavLink
          label="ConfigMaps"
          leftSection={<IconFileSettings size={18} />}
          active={view === "configmaps"}
          onClick={() => setView("configmaps")}
        />
        <NavLink
          label="Usage"
          leftSection={<IconActivity size={18} />}
          active={view === "usage"}
          onClick={() => setView("usage")}
        />
        <NavLink
          label="Versions"
          leftSection={<IconVersions size={18} />}
          active={view === "versions"}
          onClick={() => setView("versions")}
        />
        <NavLink
          label="Flux"
          leftSection={<IconBrandGit size={18} />}
          active={view === "flux"}
          onClick={() => setView("flux")}
        />
        <NavLink
          label="Port Forwards"
          leftSection={<IconPlugConnected size={18} />}
          rightSection={
            forwards.length > 0 && (
              <Badge size="sm" variant="filled" circle>
                {forwards.length}
              </Badge>
            )
          }
          active={view === "portforwards"}
          onClick={() => setView("portforwards")}
        />
        </AppShell.Section>
        <AppShell.Section>
          <UpdateStatus />
        </AppShell.Section>
      </AppShell.Navbar>

      <AppShell.Main>
        {connError && (
          <Alert color="red" icon={<IconAlertCircle size={18} />} title="Cannot connect to the cluster" mb="md">
            <pre style={{ whiteSpace: "pre-wrap", margin: 0, fontFamily: "inherit" }}>{connError}</pre>
            {context && (
              <Button mt="sm" size="xs" variant="light" color="red" onClick={() => activate(context, contexts)}>
                Retry
              </Button>
            )}
          </Alert>
        )}
        {nsWarning && (
          <Alert
            color="yellow"
            icon={<IconAlertTriangle size={18} />}
            title="Could not list namespaces"
            mb="md"
            withCloseButton
            onClose={() => setNsWarning(null)}
          >
            {nsWarning}
          </Alert>
        )}
        {/* Forwards span contexts, so they don't depend on the current one being healthy. */}
        {view === "portforwards" ? (
          <PortForwardsView />
        ) : view === "usage" ? (
          ready && <UsageView context={context} />
        ) : view === "versions" ? (
          ready && <VersionsView key={context} refreshKey={refreshKey} />
        ) : view === "flux" ? (
          ready && <FluxView key={context} refreshKey={refreshKey} />
        ) : (
          ready &&
          (view === "pods" ? (
            <PodsTable key={`${context}/${namespace}`} context={context} namespace={namespace} refreshKey={refreshKey} />
          ) : (
            <ConfigMapsView key={`${context}/${namespace}`} namespace={namespace} refreshKey={refreshKey} />
          ))
        )}
      </AppShell.Main>
      {dock.sessions.length > 0 && (
        <AppShell.Footer>
          <LogDock />
        </AppShell.Footer>
      )}
    </AppShell>
    </UsageProvider>
  );
}
