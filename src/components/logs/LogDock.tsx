"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { ActionIcon, Box, CloseButton, Group, SegmentedControl, Text, Tooltip, UnstyledButton } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconAppWindow,
  IconChevronDown,
  IconChevronUp,
  IconFileText,
  IconLayoutGrid,
  IconLayoutList,
  IconTerminal2,
  IconX,
} from "@tabler/icons-react";
import { openTerminalWindow, targetKey, type LogTarget } from "@/lib/logs";
import type { ExecMode } from "@/lib/exec";
import { LogTerminal } from "./LogTerminal";
import { ShellTerminal } from "./ShellTerminal";

export const DOCK_HEADER = 36;
const HEIGHT_KEY = "k8sview.logDock.height";
const MIN_HEIGHT = 180;

interface Session {
  id: string;
  kind: "logs" | "shell";
  /** Shells only: exec (run a command) or attach (main process). */
  mode: ExecMode;
  target: LogTarget;
  /** Container currently shown, which the terminal may have switched since opening. */
  container: string | null;
}

interface LogDockValue {
  sessions: Session[];
  activeId: string | null;
  layout: "tabs" | "split";
  collapsed: boolean;
  height: number;
  openLogs: (target: LogTarget) => void;
  /** Open an interactive terminal into the container (always a new session). */
  openShell: (target: LogTarget, mode?: ExecMode) => void;
  close: (id: string) => void;
  closeAll: () => void;
  popOut: (id: string) => void;
  setActive: (id: string) => void;
  setLayout: (layout: "tabs" | "split") => void;
  setCollapsed: (collapsed: boolean) => void;
  setHeight: (height: number) => void;
  setContainer: (id: string, container: string) => void;
  setMode: (id: string, mode: ExecMode) => void;
}

const LogDockContext = createContext<LogDockValue | null>(null);

export function useLogDock(): LogDockValue {
  const value = useContext(LogDockContext);
  if (!value) throw new Error("useLogDock must be used inside LogDockProvider");
  return value;
}

export function LogDockProvider({ children }: { children: ReactNode }) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [layout, setLayout] = useState<"tabs" | "split">("tabs");
  const [collapsed, setCollapsed] = useState(false);
  const [height, setHeightState] = useState(() => {
    const saved = typeof window === "undefined" ? NaN : Number(localStorage.getItem(HEIGHT_KEY));
    return Number.isFinite(saved) && saved >= MIN_HEIGHT ? saved : 340;
  });

  const openLogs = useCallback(
    (target: LogTarget) => {
      const existing = sessions.find(
        (s) => s.kind === "logs" && targetKey({ ...s.target, container: s.container }) === targetKey(target),
      );
      if (existing) {
        setActiveId(existing.id);
      } else {
        const id = crypto.randomUUID();
        setSessions([...sessions, { id, kind: "logs", mode: "exec", target, container: target.container }]);
        setActiveId(id);
      }
      setCollapsed(false);
    },
    [sessions],
  );

  const openShell = useCallback(
    (target: LogTarget, mode: ExecMode = "exec") => {
      const id = crypto.randomUUID();
      setSessions([...sessions, { id, kind: "shell", mode, target, container: target.container }]);
      setActiveId(id);
      setCollapsed(false);
    },
    [sessions],
  );

  const close = useCallback(
    (id: string) => {
      const next = sessions.filter((s) => s.id !== id);
      setSessions(next);
      if (activeId === id) setActiveId(next.at(-1)?.id ?? null);
    },
    [sessions, activeId],
  );

  const closeAll = useCallback(() => {
    setSessions([]);
    setActiveId(null);
  }, []);

  const popOut = useCallback(
    (id: string) => {
      const session = sessions.find((s) => s.id === id);
      if (!session) return;
      openTerminalWindow(session.kind, { ...session.target, container: session.container }, session.kind === "shell" ? session.mode : undefined)
        .then(() => close(id))
        .catch((e: Error) => notifications.show({ color: "red", title: "Could not open a window", message: e.message }));
    },
    [sessions, close],
  );

  const setHeight = useCallback((h: number) => {
    setHeightState(h);
    localStorage.setItem(HEIGHT_KEY, String(Math.round(h)));
  }, []);

  const setMode = useCallback((id: string, mode: ExecMode) => {
    setSessions((list) =>
      list.some((s) => s.id === id && s.mode !== mode) ? list.map((s) => (s.id === id ? { ...s, mode } : s)) : list,
    );
  }, []);

  const setContainer = useCallback((id: string, container: string) => {
    setSessions((list) =>
      list.some((s) => s.id === id && s.container !== container)
        ? list.map((s) => (s.id === id ? { ...s, container } : s))
        : list,
    );
  }, []);

  return (
    <LogDockContext.Provider
      value={{
        sessions,
        activeId,
        layout,
        collapsed,
        height,
        openLogs,
        openShell,
        close,
        closeAll,
        popOut,
        setActive: setActiveId,
        setLayout,
        setCollapsed,
        setHeight,
        setContainer,
        setMode,
      }}
    >
      {children}
    </LogDockContext.Provider>
  );
}

const title = (s: Session) =>
  `${s.target.pod}${s.container ? ` / ${s.container}` : ""}${s.kind === "shell" && s.mode === "attach" ? " (attach)" : ""}`;

/** Bottom dock holding every open log terminal, as tabs or a split grid. */
export function LogDock() {
  const dock = useLogDock();
  const { sessions, activeId, layout, collapsed } = dock;
  if (sessions.length === 0) return null;

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    // Without this the drag doubles as a text selection across the page.
    e.preventDefault();
    window.getSelection()?.removeAllRanges();
    e.currentTarget.setPointerCapture(e.pointerId);
    const body = document.body.style;
    const previous = { userSelect: body.userSelect, cursor: body.cursor };
    body.userSelect = "none";
    body.cursor = "row-resize";

    // One resize per frame; pointermove can fire far more often than we can render.
    let frame = 0;
    let lastY = e.clientY;
    const move = (ev: PointerEvent) => {
      lastY = ev.clientY;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const max = window.innerHeight - 160;
        dock.setHeight(Math.min(max, Math.max(MIN_HEIGHT, window.innerHeight - lastY)));
      });
    };
    const up = () => {
      cancelAnimationFrame(frame);
      body.userSelect = previous.userSelect;
      body.cursor = previous.cursor;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    if (collapsed) dock.setCollapsed(false);
  };

  const actionsFor = (s: Session) => (
    <>
      <Tooltip label="Open in its own window" withArrow>
        <ActionIcon size="sm" variant="subtle" color="gray" aria-label="Pop out" onClick={() => dock.popOut(s.id)}>
          <IconAppWindow size={14} />
        </ActionIcon>
      </Tooltip>
      <Tooltip label="Close" withArrow>
        <ActionIcon size="sm" variant="subtle" color="gray" aria-label="Close" onClick={() => dock.close(s.id)}>
          <IconX size={14} />
        </ActionIcon>
      </Tooltip>
    </>
  );

  const split = layout === "split" && sessions.length > 1;
  const cols = sessions.length <= 1 ? 1 : sessions.length <= 4 ? 2 : 3;

  return (
    <Box style={{ height: "100%", display: "flex", flexDirection: "column", position: "relative" }}>
      <Box
        onPointerDown={startResize}
        title="Drag to resize"
        style={{ position: "absolute", top: -3, left: 0, right: 0, height: 6, cursor: "row-resize", zIndex: 5 }}
      />
      <Group h={DOCK_HEADER} px="xs" gap="xs" wrap="nowrap" style={{ borderBottom: collapsed ? undefined : "1px solid var(--mantine-color-default-border)", flexShrink: 0 }}>
        <Group gap={6} wrap="nowrap" style={{ flexShrink: 0 }}>
          <IconTerminal2 size={16} />
          <Text size="sm" fw={600}>
            Terminals
          </Text>
        </Group>
        <Group gap={2} wrap="nowrap" style={{ flex: 1, minWidth: 0, overflowX: "auto" }}>
          {sessions.map((s) => {
            const active = s.id === activeId && !split;
            return (
              <Group
                key={s.id}
                gap={2}
                wrap="nowrap"
                pl={8}
                pr={2}
                style={{
                  borderRadius: "var(--mantine-radius-sm)",
                  background: active ? "var(--mantine-color-default-hover)" : undefined,
                  flexShrink: 0,
                }}
              >
                <UnstyledButton
                  onClick={() => {
                    dock.setActive(s.id);
                    dock.setCollapsed(false);
                    if (split) dock.setLayout("tabs");
                  }}
                  title={`${s.target.namespace}/${title(s)} · ${s.target.context}`}
                >
                  <Group gap={4} wrap="nowrap">
                    {s.kind === "logs" ? <IconFileText size={12} /> : <IconTerminal2 size={12} />}
                    <Text size="xs" ff="monospace" maw={240} truncate="end" fw={active ? 600 : 400}>
                      {title(s)}
                    </Text>
                  </Group>
                </UnstyledButton>
                <CloseButton size="xs" aria-label={`Close ${title(s)}`} onClick={() => dock.close(s.id)} />
              </Group>
            );
          })}
        </Group>
        <Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
          <SegmentedControl
            size="xs"
            value={layout}
            onChange={(v) => dock.setLayout(v as "tabs" | "split")}
            data={[
              { value: "tabs", label: <IconLayoutList size={14} aria-label="Tabs" /> },
              { value: "split", label: <IconLayoutGrid size={14} aria-label="Split view" /> },
            ]}
          />
          <Tooltip label={collapsed ? "Expand" : "Collapse"} withArrow>
            <ActionIcon variant="subtle" color="gray" onClick={() => dock.setCollapsed(!collapsed)} aria-label={collapsed ? "Expand logs" : "Collapse logs"}>
              {collapsed ? <IconChevronUp size={16} /> : <IconChevronDown size={16} />}
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Close all" withArrow>
            <ActionIcon variant="subtle" color="gray" onClick={dock.closeAll} aria-label="Close all logs">
              <IconX size={16} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>

      {/* Every terminal stays mounted (streams keep running); layout only changes what's visible. */}
      <Box
        style={{
          flex: 1,
          minHeight: 0,
          display: collapsed ? "none" : "grid",
          gridTemplateColumns: split ? `repeat(${cols}, minmax(0, 1fr))` : "minmax(0, 1fr)",
          gridAutoRows: "minmax(0, 1fr)",
          gap: split ? 1 : 0,
          background: "var(--mantine-color-default-border)",
        }}
      >
        {sessions.map((s) => (
          <Box
            key={s.id}
            style={{
              display: split || s.id === activeId ? "flex" : "none",
              flexDirection: "column",
              minHeight: 0,
              background: "var(--mantine-color-body)",
            }}
          >
            {split && (
              <Text size="xs" ff="monospace" fw={600} px="xs" pt={4} truncate="end">
                {s.target.namespace}/{title(s)}
              </Text>
            )}
            <Box style={{ flex: 1, minHeight: 0 }}>
              {s.kind === "logs" ? (
                <LogTerminal target={s.target} onContainerChange={(c) => dock.setContainer(s.id, c)} actions={actionsFor(s)} />
              ) : (
                <ShellTerminal
                  target={s.target}
                  initialMode={s.mode}
                  onContainerChange={(c) => dock.setContainer(s.id, c)}
                  onModeChange={(m) => dock.setMode(s.id, m)}
                  actions={actionsFor(s)}
                />
              )}
            </Box>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
