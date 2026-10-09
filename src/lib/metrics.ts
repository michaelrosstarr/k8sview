import { invoke, isTauri } from "@tauri-apps/api/core";

// Mirrors src-tauri/src/metrics.rs. CPU is in cores, memory in bytes.

export interface Resources {
  cpu: number;
  memory: number;
}

export interface NodeUsage {
  name: string;
  ready: boolean;
  usage: Resources | null;
  allocatable: Resources;
  capacity: Resources;
  requests: Resources;
  limits: Resources;
  pods: number;
  pod_capacity: number;
}

export interface ContainerUsage {
  name: string;
  usage: Resources | null;
  requests: Resources;
  cpu_limit: number | null;
  memory_limit: number | null;
}

export interface PodUsage {
  namespace: string;
  name: string;
  node: string | null;
  phase: string;
  usage: Resources | null;
  requests: Resources;
  cpu_limit: number | null;
  memory_limit: number | null;
  containers: ContainerUsage[];
}

export interface MetricsSnapshot {
  metrics_error: string | null;
  nodes: NodeUsage[];
  pods: PodUsage[];
}

export async function metricsSnapshot(): Promise<MetricsSnapshot> {
  if (!isTauri()) throw new Error("Usage comes from the Tauri backend. Start the app with `pnpm tauri dev`.");
  try {
    return await invoke<MetricsSnapshot>("metrics_snapshot");
  } catch (e) {
    throw e instanceof Error ? e : new Error(String(e));
  }
}

/** "943m", "1.26 cores", "24 cores". */
export function formatCores(cores: number): string {
  if (cores < 1) return `${Math.round(cores * 1000)}m`;
  const n = cores < 10 ? cores.toFixed(2).replace(/\.?0+$/, "") : String(Math.round(cores));
  return `${n} ${n === "1" ? "core" : "cores"}`;
}

/** Compact CPU for axes and tight cells: "943m", "1.3". */
export const formatCoresShort = (cores: number) =>
  cores === 0 ? "0" : cores < 1 ? `${Math.round(cores * 1000)}m` : `${+cores.toFixed(1)}`;

/** Unit for rounding memory axis ticks: whole GiB once past 1 GiB, else MiB. */
export const memoryTickUnit = (max: number) => (max >= 1024 ** 3 ? 1024 ** 3 : 1024 ** 2);

/** Binary units, as kubectl shows memory: "98 MiB", "5.1 GiB". */
export function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : +v.toFixed(1)} ${units[i]}`;
}

export const podKey = (p: { namespace: string; name: string }) => `${p.namespace}/${p.name}`;
