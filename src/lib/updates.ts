import { Channel, invoke, isTauri } from "@tauri-apps/api/core";

// Mirrors src-tauri/src/updates.rs.

export interface UpdateInfo {
  version: string;
  current: string;
  notes: string | null;
  date: string | null;
}

export type UpdateProgress = { kind: "progress"; downloaded: number; total: number | null } | { kind: "installing" };

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error("Updates are handled by the desktop app.");
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw e instanceof Error ? e : new Error(String(e));
  }
}

export interface AppInfo {
  name: string;
  /** As shown to people: 2026.10.9.4821. */
  version: string;
  /** A local build ("k8sview - dev") rather than a release. */
  dev: boolean;
}

let appInfoPromise: Promise<AppInfo> | null = null;
/** Fetched once and shared; it can't change while the app runs. */
export const appInfo = () => (appInfoPromise ??= call<AppInfo>("app_info"));
export const checkForUpdate = () => call<UpdateInfo | null>("check_for_update");
/** Downloads, verifies and installs, then the app restarts itself. */
export const installUpdate = (onProgress: (p: UpdateProgress) => void) =>
  call<void>("install_update", { onProgress: new Channel<UpdateProgress>(onProgress) });
