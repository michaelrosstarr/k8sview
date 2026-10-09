"use client";

import { useMemo, type ReactNode } from "react";
import { Group, Kbd, Text, UnstyledButton, useComputedColorScheme, useMantineColorScheme } from "@mantine/core";
import { useOs } from "@mantine/hooks";
import { Spotlight, spotlight, type SpotlightActionData, type SpotlightActionGroupData, type SpotlightFilterFunction } from "@mantine/spotlight";
import {
  IconActivity,
  IconBox,
  IconBrandGit,
  IconExternalLink,
  IconFileSettings,
  IconFileText,
  IconFolders,
  IconLayoutGrid,
  IconLayoutList,
  IconLink,
  IconMoon,
  IconPlayerStop,
  IconPlugConnected,
  IconRefresh,
  IconSearch,
  IconServer,
  IconTerminal2,
  IconVersions,
  IconX,
  IconCloudDownload,
  IconChevronDown,
} from "@tabler/icons-react";
import { localUrl, openLocalPort } from "@/lib/k8s";
import { useLogDock } from "./logs/LogDock";
import { openPortForwardDialog, usePortForwards } from "./PortForwards";
import { useUsage } from "./usage/UsageProvider";

export type View = "pods" | "configmaps" | "usage" | "versions" | "flux" | "portforwards";

/** Fired to ask UpdateStatus for a manual update check. */
export const CHECK_UPDATES_EVENT = "k8sview:check-updates";

/** Groups shown before anything is typed; the rest (pods, namespaces, ...) appear when searching. */
const ALWAYS_VISIBLE = new Set(["Go to", "Actions", "Terminals", "Port forwards"]);
const MAX_RESULTS = 40;

interface Props {
  contexts: string[];
  context: string | null;
  namespaces: string[];
  namespace: string | null;
  onView: (view: View) => void;
  onContext: (name: string) => void;
  onNamespace: (namespace: string) => void;
  onRefresh: () => void;
}

/** Every word of the query must appear in the label, description or keywords. */
const filter: SpotlightFilterFunction = (query, actions) => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (a: SpotlightActionData) => {
    const haystack = [a.label, a.description, ...(Array.isArray(a.keywords) ? a.keywords : [a.keywords ?? ""])]
      .join(" ")
      .toLowerCase();
    return words.every((w) => haystack.includes(w));
  };
  return actions
    .map((g) => {
      const group = g as SpotlightActionGroupData;
      if (!words.length && !ALWAYS_VISIBLE.has(group.group)) return null;
      const kept = words.length ? group.actions.filter(matches) : group.actions;
      return kept.length ? { ...group, actions: kept } : null;
    })
    .filter((g): g is SpotlightActionGroupData => g !== null);
};

const icon = (node: ReactNode) => (
  <Text c="dimmed" component="span" style={{ display: "flex" }}>
    {node}
  </Text>
);

/** ⌘K / Ctrl+K command palette with navigation and quick actions. */
export function CommandPalette({ contexts, context, namespaces, namespace, onView, onContext, onNamespace, onRefresh }: Props) {
  const { forwards, stop } = usePortForwards();
  const dock = useLogDock();
  const { snapshot } = useUsage();
  const { setColorScheme } = useMantineColorScheme();
  const scheme = useComputedColorScheme("light", { getInitialValueInEffect: true });

  const actions = useMemo<SpotlightActionGroupData[]>(() => {
    const go = (view: View, label: string, leftIcon: ReactNode, keywords: string[]): SpotlightActionData => ({
      id: `go-${view}`,
      label,
      keywords,
      leftSection: icon(leftIcon),
      onClick: () => onView(view),
    });

    const groups: SpotlightActionGroupData[] = [
      {
        group: "Go to",
        actions: [
          go("pods", "Pods", <IconBox size={18} />, ["workloads", "containers"]),
          go("configmaps", "ConfigMaps", <IconFileSettings size={18} />, ["config", "cm"]),
          go("usage", "Usage", <IconActivity size={18} />, ["cpu", "memory", "metrics", "nodes", "top"]),
          go("versions", "Versions", <IconVersions size={18} />, ["images", "tags", "charts", "drift"]),
          go("flux", "Flux", <IconBrandGit size={18} />, ["gitops", "helmrelease", "kustomization", "reconcile"]),
          go("portforwards", "Port Forwards", <IconPlugConnected size={18} />, ["tunnel", "localhost"]),
        ],
      },
      {
        group: "Actions",
        actions: [
          {
            id: "refresh",
            label: "Refresh",
            description: "Reload the current view",
            leftSection: icon(<IconRefresh size={18} />),
            onClick: onRefresh,
          },
          {
            id: "theme",
            label: scheme === "dark" ? "Switch to light mode" : "Switch to dark mode",
            keywords: ["theme", "color scheme", "dark", "light"],
            leftSection: icon(<IconMoon size={18} />),
            onClick: () => setColorScheme(scheme === "dark" ? "light" : "dark"),
          },
          {
            id: "updates",
            label: "Check for updates",
            keywords: ["update", "version", "upgrade"],
            leftSection: icon(<IconCloudDownload size={18} />),
            onClick: () => window.dispatchEvent(new Event(CHECK_UPDATES_EVENT)),
          },
        ],
      },
    ];

    if (dock.sessions.length) {
      groups.push({
        group: "Terminals",
        actions: [
          {
            id: "dock-layout",
            label: dock.layout === "split" ? "Show terminals as tabs" : "Show terminals side by side",
            keywords: ["split", "tabs", "layout", "logs", "shell"],
            leftSection: icon(dock.layout === "split" ? <IconLayoutList size={18} /> : <IconLayoutGrid size={18} />),
            onClick: () => dock.setLayout(dock.layout === "split" ? "tabs" : "split"),
          },
          {
            id: "dock-collapse",
            label: dock.collapsed ? "Expand terminals" : "Collapse terminals",
            leftSection: icon(<IconChevronDown size={18} />),
            onClick: () => dock.setCollapsed(!dock.collapsed),
          },
          {
            id: "dock-close",
            label: `Close all terminals (${dock.sessions.length})`,
            leftSection: icon(<IconX size={18} />),
            onClick: dock.closeAll,
          },
        ],
      });
    }

    if (forwards.length) {
      groups.push({
        group: "Port forwards",
        actions: forwards.flatMap((f) => [
          {
            id: `pf-open-${f.id}`,
            label: `Open ${localUrl(f.local_port)}`,
            description: `${f.namespace}/${f.pod}:${f.pod_port}`,
            keywords: ["browser", "port forward"],
            leftSection: icon(<IconExternalLink size={18} />),
            onClick: () => void openLocalPort(f.local_port),
          },
          {
            id: `pf-stop-${f.id}`,
            label: `Stop forward ${localUrl(f.local_port)}`,
            description: `${f.namespace}/${f.pod}:${f.pod_port}`,
            keywords: ["port forward", "close"],
            leftSection: icon(<IconPlayerStop size={18} />),
            onClick: () => void stop(f.id),
          },
        ]),
      });
    }

    // Pods from the metrics sampler cover every namespace; the current one sorts first.
    if (context && snapshot) {
      const pods = snapshot.pods
        .filter((p) => p.phase === "Running")
        .sort((a, b) => Number(b.namespace === namespace) - Number(a.namespace === namespace) || a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name));
      const target = (ns: string, pod: string) => ({ context, namespace: ns, pod, container: null });
      groups.push({
        group: "Pods",
        actions: pods.flatMap((p) => {
          const where = `${p.namespace}/${p.name}`;
          return [
            {
              id: `logs-${where}`,
              label: `Logs: ${p.name}`,
              description: p.namespace,
              keywords: ["logs", p.namespace],
              leftSection: icon(<IconFileText size={18} />),
              onClick: () => dock.openLogs(target(p.namespace, p.name)),
            },
            {
              id: `shell-${where}`,
              label: `Shell: ${p.name}`,
              description: p.namespace,
              keywords: ["shell", "exec", "terminal", "bash", p.namespace],
              leftSection: icon(<IconTerminal2 size={18} />),
              onClick: () => dock.openShell(target(p.namespace, p.name)),
            },
            {
              id: `attach-${where}`,
              label: `Attach: ${p.name}`,
              description: p.namespace,
              keywords: ["attach", p.namespace],
              leftSection: icon(<IconLink size={18} />),
              onClick: () => dock.openShell(target(p.namespace, p.name), "attach"),
            },
            {
              id: `pf-${where}`,
              label: `Port forward: ${p.name}`,
              description: p.namespace,
              keywords: ["port forward", "tunnel", p.namespace],
              leftSection: icon(<IconPlugConnected size={18} />),
              onClick: () => openPortForwardDialog(p.namespace, p.name),
            },
          ];
        }),
      });
    }

    groups.push({
      group: "Namespaces",
      actions: namespaces
        .filter((ns) => ns !== namespace)
        .map((ns) => ({
          id: `ns-${ns}`,
          label: `Namespace: ${ns}`,
          description: "Switch namespace and show its pods",
          keywords: ["switch", "namespace"],
          leftSection: icon(<IconFolders size={18} />),
          onClick: () => {
            onNamespace(ns);
            onView("pods");
          },
        })),
    });

    groups.push({
      group: "Contexts",
      actions: contexts
        .filter((c) => c !== context)
        .map((c) => ({
          id: `ctx-${c}`,
          label: `Context: ${c}`,
          description: "Switch cluster",
          keywords: ["switch", "context", "cluster", "kubeconfig"],
          leftSection: icon(<IconServer size={18} />),
          onClick: () => onContext(c),
        })),
    });

    return groups;
  }, [contexts, context, namespaces, namespace, forwards, stop, dock, snapshot, scheme, setColorScheme, onView, onContext, onNamespace, onRefresh]);

  return (
    <Spotlight
      actions={actions}
      filter={filter}
      limit={MAX_RESULTS}
      shortcut={["mod + K"]}
      // Work from inside terminals and inputs too: ⌘K isn't something people type.
      tagsToIgnore={[]}
      highlightQuery
      scrollable
      maxHeight={480}
      nothingFound="Nothing found"
      searchProps={{
        leftSection: <IconSearch size={18} />,
        placeholder: "Search pods, namespaces, views and actions…",
      }}
    />
  );
}

/** Header button that opens the palette and shows its shortcut. */
export function CommandPaletteButton() {
  const os = useOs();
  const mod = os === "macos" ? "⌘" : os === "undetermined" ? "" : "Ctrl";
  return (
    <UnstyledButton
      onClick={() => spotlight.open()}
      aria-label="Open command palette"
      px="sm"
      h={36}
      w={260}
      style={{
        border: "1px solid var(--mantine-color-default-border)",
        borderRadius: "var(--mantine-radius-sm)",
        background: "var(--mantine-color-default)",
      }}
    >
      <Group justify="space-between" wrap="nowrap">
        <Group gap={8} wrap="nowrap">
          <IconSearch size={16} color="var(--mantine-color-dimmed)" />
          <Text size="sm" c="dimmed">
            Search or jump to…
          </Text>
        </Group>
        {mod && <Kbd size="xs">{mod} K</Kbd>}
      </Group>
    </UnstyledButton>
  );
}
