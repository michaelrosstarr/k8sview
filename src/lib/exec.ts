import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import type { LogTarget } from "./logs";

// Mirrors src-tauri/src/exec.rs.

export type ExecMode = "exec" | "attach";
export type ExecEvent = { kind: "exit"; code: number | null; message: string | null };

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error("Shells run through the Tauri backend. Start the app with `pnpm tauri dev`.");
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw e instanceof Error ? e : new Error(String(e));
  }
}

const toBytes = (data: unknown): Uint8Array =>
  data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : data instanceof Uint8Array
      ? data
      : new Uint8Array(data as number[]);

/** Start a session; output arrives as raw bytes (xterm decodes UTF-8 across chunks). */
export async function execStart(
  t: LogTarget,
  mode: ExecMode,
  command: string[] | null,
  onOutput: (data: Uint8Array) => void,
  onEvent: (e: ExecEvent) => void,
): Promise<number> {
  return call<number>("exec_start", {
    context: t.context,
    ns: t.namespace,
    pod: t.pod,
    container: t.container,
    mode,
    command,
    onOutput: new Channel<unknown>((d) => onOutput(toBytes(d))),
    onEvent: new Channel<ExecEvent>(onEvent),
  });
}

export const execInput = (id: number, data: string) => call<void>("exec_input", { id, data });
export const execResize = (id: number, cols: number, rows: number) => call<void>("exec_resize", { id, cols, rows });
export const execStop = (id: number) => call<void>("exec_stop", { id });

/** Split a command line like a shell would for simple cases: whitespace, '…' and "…" quoting. */
export function splitCommand(line: string): string[] {
  const out: string[] = [];
  const re = /'([^']*)'|"((?:\\.|[^"\\])*)"|(\S+)/g;
  for (const m of line.matchAll(re)) out.push(m[1] ?? m[2]?.replace(/\\(.)/g, "$1") ?? m[3]);
  return out;
}
