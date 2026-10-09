import { invoke, isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

// These mirror the serde DTOs in src-tauri/src/k8s.rs.

export interface ContextInfo {
  name: string;
  namespace: string | null;
}

export interface ContextList {
  contexts: ContextInfo[];
  current: string | null;
}

export interface PodRow {
  name: string;
  status: string;
  ready: string;
  restarts: number;
  created: string | null;
  node: string | null;
  owner_kind: string | null;
}

export interface RestartResult {
  had_controller: boolean;
}

export interface ConfigMapRow {
  name: string;
  keys: number;
  created: string | null;
  data: Record<string, string>;
}

export type EnvKind = "value" | "configmap" | "secret" | "field" | "resource";

export interface EnvVarRow {
  /** `PREFIX*` stands for every key of a source that could not be expanded. */
  name: string;
  /** null for Secrets (never fetched) and anything that could not be resolved. */
  value: string | null;
  kind: EnvKind;
  source: string;
}

export interface ContainerDetail {
  name: string;
  init: boolean;
  image: string;
  version: string;
  image_id: string | null;
  ports: ContainerPort[];
  env: EnvVarRow[];
}

export interface ContainerPort {
  name: string | null;
  port: number;
  protocol: string;
}

export interface ConfigMapLink {
  name: string;
  usages: string[];
  status: "found" | "missing" | "unreadable";
  error: string | null;
  data: Record<string, string>;
}

export interface PodDetail {
  name: string;
  containers: ContainerDetail[];
  configmaps: ConfigMapLink[];
}

export interface ContainerVersion {
  name: string;
  image: string;
  version: string;
  /** Distinct image digests the pods are running. */
  running: string[];
}

export interface WorkloadVersion {
  kind: string;
  namespace: string;
  name: string;
  containers: ContainerVersion[];
  chart: string | null;
  chart_version: string | null;
  app_version: string | null;
  helm_release: string | null;
  ready: string | null;
}

export interface PortForwardInfo {
  id: number;
  context: string;
  namespace: string;
  pod: string;
  pod_port: number;
  local_port: number;
  active_connections: number;
  total_connections: number;
  last_error: string | null;
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw new Error("k8sview talks to Kubernetes through its Tauri backend. Start it with `pnpm tauri dev`.");
  }
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    // Rust commands reject with a plain string.
    throw e instanceof Error ? e : new Error(String(e));
  }
}

export const listContexts = () => call<ContextList>("list_contexts");
export const setContext = (name: string) => call<void>("set_context", { name });
export const listNamespaces = () => call<string[]>("list_namespaces");
export const listPods = (ns: string) => call<PodRow[]>("list_pods", { ns });
export const getPodDetail = (ns: string, name: string) => call<PodDetail>("get_pod_detail", { ns, name });
export const deletePod = (ns: string, name: string) => call<void>("delete_pod", { ns, name });
export const restartPod = (ns: string, name: string) => call<RestartResult>("restart_pod", { ns, name });
export const listConfigMaps = (ns: string) => call<ConfigMapRow[]>("list_configmaps", { ns });
export const listWorkloadVersions = () => call<WorkloadVersion[]>("list_workload_versions");
export const startPortForward = (ns: string, pod: string, port: number, localPort: number | null) =>
  call<PortForwardInfo>("start_port_forward", { ns, pod, port, localPort });
export const stopPortForward = (id: number) => call<void>("stop_port_forward", { id });
export const listPortForwards = () => call<PortForwardInfo[]>("list_port_forwards");

export const localUrl = (port: number) => `http://localhost:${port}`;
/** Open a forwarded port in the system browser (the capability only allows localhost). */
export const openLocalPort = (port: number) => openUrl(localUrl(port));

/** kubectl-style age ("45s", "5m12s", "3h", "2d4h", "120d") from an RFC 3339 timestamp. */
export function formatAge(created: string | null, now = Date.now()): string {
  if (!created) return "-";
  const s = Math.max(0, Math.floor((now - Date.parse(created)) / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (s < 120) return `${s}s`;
  if (m < 10) return s % 60 ? `${m}m${s % 60}s` : `${m}m`;
  if (h < 3) return `${m}m`;
  if (h < 8) return m % 60 ? `${h}h${m % 60}m` : `${h}h`;
  if (h < 48) return `${h}h`;
  if (d < 8) return h % 24 ? `${d}d${h % 24}h` : `${d}d`;
  if (d < 365 * 2) return `${d}d`;
  return `${Math.floor(d / 365)}y`;
}
