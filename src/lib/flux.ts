import { invoke, isTauri } from "@tauri-apps/api/core";

// These mirror the serde DTOs in src-tauri/src/flux.rs.

export type FluxStatus = "ready" | "failing" | "progressing" | "suspended" | "unknown";

export interface ObjectRef {
  kind: string;
  namespace: string;
  name: string;
}

export interface Condition {
  type: string;
  status: string;
  reason: string | null;
  message: string | null;
  last_transition: string | null;
}

export interface HelmHistoryEntry {
  version: number | null;
  chart_version: string | null;
  app_version: string | null;
  status: string | null;
  first_deployed: string | null;
  last_deployed: string | null;
}

export interface FluxObject {
  kind: string;
  namespace: string;
  name: string;
  status: FluxStatus;
  suspended: boolean;
  reason: string | null;
  message: string | null;
  revision: string | null;
  source: ObjectRef | null;
  depends_on: ObjectRef[];
  interval: string | null;
  url: string | null;
  chart: string | null;
  app_version: string | null;
  last_transition: string | null;
  created: string | null;
  last_action: { action: string; duration_secs: number } | null;
  history: HelmHistoryEntry[];
  inventory: number | null;
  conditions: Condition[];
}

export interface Controller {
  name: string;
  namespace: string;
  version: string | null;
  ready: string;
  healthy: boolean;
}

export interface FluxSnapshot {
  kinds: string[];
  controllers: Controller[];
  objects: FluxObject[];
  errors: string[];
}

export interface EventRow {
  type: string | null;
  reason: string | null;
  message: string | null;
  count: number | null;
  last_seen: string | null;
}

export interface FluxDetail {
  object: Record<string, unknown>;
  events: EventRow[];
  inventory: { kind: string; count: number }[];
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error("Flux data comes from the Tauri backend. Start the app with `pnpm tauri dev`.");
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw e instanceof Error ? e : new Error(String(e));
  }
}

export const fluxSnapshot = () => call<FluxSnapshot>("flux_snapshot");
export const fluxDetail = (ref: ObjectRef) =>
  call<FluxDetail>("flux_detail", { kind: ref.kind, ns: ref.namespace, name: ref.name });
export const fluxReconcile = (ref: ObjectRef, withSource: boolean) =>
  call<ObjectRef[]>("flux_reconcile", { kind: ref.kind, ns: ref.namespace, name: ref.name, withSource });
export const fluxSetSuspended = (ref: ObjectRef, suspend: boolean) =>
  call<void>("flux_set_suspended", { kind: ref.kind, ns: ref.namespace, name: ref.name, suspend });

export const refKey = (r: ObjectRef) => `${r.kind}/${r.namespace}/${r.name}`;

/** Kinds that deploy things, as opposed to sources and notification plumbing. */
export const WORKLOAD_KINDS = ["HelmRelease", "Kustomization"];

/** "main@sha1:9230802c…" → "main@9230802"; chart versions pass through. */
export function shortRevision(rev: string | null): string | null {
  if (!rev) return null;
  const m = rev.match(/^(?:(.+)@)?(?:sha1|sha256):([0-9a-f]{7})[0-9a-f]*$/);
  if (!m) return rev;
  return m[1] ? `${m[1]}@${m[2]}` : m[2];
}

export function formatDuration(secs: number): string {
  if (secs < 1) return `${Math.round(secs * 1000)}ms`;
  if (secs < 60) return `${secs.toFixed(secs < 10 ? 1 : 0)}s`;
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return s ? `${m}m ${s}s` : `${m}m`;
}
