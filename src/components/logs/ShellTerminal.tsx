"use client";

import "@xterm/xterm/css/xterm.css";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ActionIcon, Badge, Box, Group, SegmentedControl, Select, TextInput, Tooltip, useComputedColorScheme } from "@mantine/core";
import { IconEraser, IconPlayerPlay, IconRefresh, IconTerminal2 } from "@tabler/icons-react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { execInput, execResize, execStart, execStop, splitCommand, type ExecMode } from "@/lib/exec";
import { podContainers, targetKey, type ContainerInfo, type LogTarget } from "@/lib/logs";
import { THEMES, clearTerminal } from "./LogTerminal";

type Status = { key: string; state: "connecting" | "connected" | "exited" | "error"; code?: number | null };

const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const red = (s: string) => `\x1b[31m${s}\x1b[39m`;

interface Props {
  target: LogTarget;
  initialMode?: ExecMode;
  onContainerChange?: (container: string) => void;
  onModeChange?: (mode: ExecMode) => void;
  actions?: ReactNode;
}

/** Interactive terminal into a container: `exec -it` (a shell by default) or `attach -it`. */
export function ShellTerminal({ target, initialMode = "exec", onContainerChange, onModeChange, actions }: Props) {
  const scheme = useComputedColorScheme("dark");
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<number | null>(null);
  const exitedRef = useRef(false);
  const reconnectRef = useRef<() => void>(() => {});

  const [ready, setReady] = useState(false);
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [containersFor, setContainersFor] = useState<string | null>(null);
  const [container, setContainer] = useState<string | null>(target.container);
  const [mode, setMode] = useState<ExecMode>(initialMode);
  const [commandInput, setCommandInput] = useState("");
  const [command, setCommand] = useState("");
  const [reconnect, setReconnect] = useState(0);
  const [status, setStatus] = useState<Status>({ key: "", state: "connecting" });

  const effectiveContainer = container ?? containers.find((c) => !c.init)?.name ?? null;
  const sessionKey = `${targetKey(target)}|${effectiveContainer}|${mode}|${mode === "exec" ? command : ""}|${reconnect}`;
  const state = status.key === sessionKey ? status.state : "connecting";
  const canConnect = ready && (target.container !== null || containersFor === targetKey(target));

  useEffect(() => {
    reconnectRef.current = () => setReconnect((n) => n + 1);
  });

  useEffect(() => {
    let disposed = false;
    let observer: ResizeObserver | null = null;
    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      if (disposed || !hostRef.current) return;
      const term = new Terminal({
        cursorBlink: true,
        scrollback: 10_000,
        fontSize: 12,
        lineHeight: 1.2,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
        theme: { ...THEMES[scheme], cursor: THEMES[scheme].foreground },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(hostRef.current);
      term.onData((data) => {
        if (exitedRef.current) {
          if (data === "\r") reconnectRef.current();
          return;
        }
        if (sessionRef.current !== null) void execInput(sessionRef.current, data).catch(() => {});
      });
      term.onResize(({ cols, rows }) => {
        if (sessionRef.current !== null) void execResize(sessionRef.current, cols, rows);
      });
      // ⌘C copies a selection (Ctrl-C still goes to the shell as an interrupt).
      term.attachCustomKeyEventHandler((e) => {
        if (e.type === "keydown" && e.metaKey && e.key === "c" && term.hasSelection()) {
          void navigator.clipboard.writeText(term.getSelection());
          return false;
        }
        return true;
      });
      termRef.current = term;
      fitRef.current = fit;
      observer = new ResizeObserver(() => {
        if (hostRef.current?.offsetWidth) fit.fit();
      });
      observer.observe(hostRef.current);
      if (hostRef.current.offsetWidth) fit.fit();
      setReady(true);
    })();
    return () => {
      disposed = true;
      observer?.disconnect();
      termRef.current?.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = { ...THEMES[scheme], cursor: THEMES[scheme].foreground };
  }, [scheme, ready]);

  useEffect(() => {
    let cancelled = false;
    podContainers(target)
      .then((list) => !cancelled && setContainers(list))
      .catch(() => {})
      .finally(() => !cancelled && setContainersFor(targetKey(target)));
    return () => {
      cancelled = true;
    };
  }, [target]);

  const onContainerChangeRef = useRef(onContainerChange);
  const onModeChangeRef = useRef(onModeChange);
  useEffect(() => {
    onContainerChangeRef.current = onContainerChange;
    onModeChangeRef.current = onModeChange;
  });
  useEffect(() => {
    if (effectiveContainer) onContainerChangeRef.current?.(effectiveContainer);
  }, [effectiveContainer]);
  useEffect(() => {
    onModeChangeRef.current?.(mode);
  }, [mode]);

  // One session per sessionKey; anything that changes it reconnects.
  useEffect(() => {
    if (!canConnect) return;
    const term = termRef.current!;
    let cancelled = false;
    let id: number | null = null;
    exitedRef.current = false;
    sessionRef.current = null;
    clearTerminal(term);
    const where = `${target.namespace}/${target.pod}${effectiveContainer ? ` (${effectiveContainer})` : ""}`;
    term.write(dim(mode === "attach" ? `Attaching to ${where}…` : `Connecting to ${where}…`) + "\r\n");
    if (mode === "attach") {
      term.write(dim("Attached to the main process: output appears when it writes; input goes to its stdin.") + "\r\n");
    }
    execStart(
      { ...target, container: effectiveContainer },
      mode,
      mode === "exec" && command.trim() ? splitCommand(command) : null,
      (data) => !cancelled && term.write(data),
      (event) => {
        if (cancelled || event.kind !== "exit") return;
        exitedRef.current = true;
        sessionRef.current = null;
        const how = event.code === null ? "Session ended" : `Process exited with code ${event.code}`;
        term.write(`\r\n${event.code ? red(how) : dim(how)}${event.code && event.message ? dim(`: ${event.message}`) : ""}\r\n`);
        term.write(dim("Press Enter to reconnect.") + "\r\n");
        setStatus({ key: sessionKey, state: "exited", code: event.code });
      },
    )
      .then((sessionId) => {
        if (cancelled) {
          void execStop(sessionId);
          return;
        }
        id = sessionId;
        sessionRef.current = sessionId;
        void execResize(sessionId, term.cols, term.rows);
        term.focus();
        setStatus((s) => (s.key === sessionKey && s.state === "exited" ? s : { key: sessionKey, state: "connected" }));
      })
      .catch((e: Error) => {
        if (cancelled) return;
        exitedRef.current = true;
        term.write(red(e.message) + "\r\n" + dim("Press Enter to retry.") + "\r\n");
        setStatus({ key: sessionKey, state: "error" });
      });
    return () => {
      cancelled = true;
      sessionRef.current = null;
      if (id !== null) void execStop(id);
    };
    // sessionKey captures every input to the session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canConnect, sessionKey]);

  const badge = {
    connecting: { color: "gray", label: "connecting" },
    connected: { color: "green", label: mode === "attach" ? "attached" : "connected" },
    exited: { color: status.code ? "red" : "gray", label: status.code === null || status.code === undefined ? "ended" : `exit ${status.code}` },
    error: { color: "red", label: "error" },
  }[state];

  return (
    <Box style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <Group gap={6} px="xs" py={6} wrap="wrap" style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}>
        <Select
          size="xs"
          w={170}
          aria-label="Container"
          data={containers.map((c) => ({ value: c.name, label: c.init ? `${c.name} (init)` : c.name }))}
          value={effectiveContainer}
          onChange={(v) => v && setContainer(v)}
          allowDeselect={false}
          placeholder="container"
        />
        <SegmentedControl
          size="xs"
          value={mode}
          onChange={(v) => setMode(v as ExecMode)}
          data={[
            { value: "exec", label: "Shell" },
            { value: "attach", label: "Attach" },
          ]}
        />
        {mode === "exec" && (
          <TextInput
            size="xs"
            w={300}
            placeholder="Command (default: bash, else sh)"
            leftSection={<IconTerminal2 size={14} />}
            value={commandInput}
            onChange={(e) => setCommandInput(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                // The terminal takes focus when the session starts; without this the
                // same Enter's keypress would land there and be sent to the new shell.
                e.preventDefault();
                setCommand(commandInput);
                setReconnect((n) => n + 1);
              }
            }}
            rightSection={
              <Tooltip label="Run (Enter)" withArrow>
                <ActionIcon size="sm" variant="subtle" color="gray" aria-label="Run command" onClick={() => {
                  setCommand(commandInput);
                  setReconnect((n) => n + 1);
                }}>
                  <IconPlayerPlay size={12} />
                </ActionIcon>
              </Tooltip>
            }
          />
        )}
        <Group gap={6} ml="auto" wrap="nowrap">
          <Badge size="sm" variant="light" color={badge.color} style={{ textTransform: "none" }}>
            {badge.label}
          </Badge>
          <Tooltip label="Clear screen" withArrow>
            <ActionIcon size="sm" variant="subtle" color="gray" aria-label="Clear screen" onClick={() => termRef.current?.clear()}>
              <IconEraser size={14} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Reconnect" withArrow>
            <ActionIcon size="sm" variant="subtle" color="gray" aria-label="Reconnect" onClick={() => setReconnect((n) => n + 1)}>
              <IconRefresh size={14} />
            </ActionIcon>
          </Tooltip>
          {actions}
        </Group>
      </Group>
      <Box
        ref={hostRef}
        onClick={() => termRef.current?.focus()}
        style={{ flex: 1, minHeight: 0, padding: "4px 0 0 6px", background: THEMES[scheme].background }}
      />
    </Box>
  );
}
