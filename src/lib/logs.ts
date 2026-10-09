import { Channel, invoke, isTauri } from "@tauri-apps/api/core";

// Mirrors src-tauri/src/logs.rs.

export type LogEvent = { kind: "lines"; lines: string[] } | { kind: "end" } | { kind: "error"; message: string };

export interface ContainerInfo {
  name: string;
  init: boolean;
  restart_count: number;
  state: string;
}

/** What a log terminal shows. `context` is pinned so popped-out windows survive context switches. */
export interface LogTarget {
  context: string;
  namespace: string;
  pod: string;
  container: string | null;
}

export interface LogOptions {
  container: string | null;
  previous: boolean;
  timestamps: boolean;
  tail_lines: number | null;
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error("Logs stream from the Tauri backend. Start the app with `pnpm tauri dev`.");
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw e instanceof Error ? e : new Error(String(e));
  }
}

export const podContainers = (t: LogTarget) =>
  call<ContainerInfo[]>("pod_containers", { context: t.context, ns: t.namespace, pod: t.pod });

/** Start streaming; resolves to a stream id for `stopLogStream`. */
export async function startLogStream(t: LogTarget, options: LogOptions, onEvent: (e: LogEvent) => void): Promise<number> {
  const channel = new Channel<LogEvent>(onEvent);
  return call<number>("start_log_stream", {
    context: t.context,
    ns: t.namespace,
    pod: t.pod,
    options,
    onEvent: channel,
  });
}

export const stopLogStream = (id: number) => call<void>("stop_log_stream", { id });

/** Pop a log viewer or shell out into its own native window. */
export const openTerminalWindow = (kind: "logs" | "shell", t: LogTarget, mode?: string) =>
  call<void>("open_terminal_window", {
    kind,
    context: t.context,
    ns: t.namespace,
    pod: t.pod,
    container: t.container,
    mode: mode ?? null,
  });

export const targetKey = (t: LogTarget) => `${t.context}|${t.namespace}|${t.pod}|${t.container ?? ""}`;
