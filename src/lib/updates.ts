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

export const appVersion = () => call<string>("app_version");
export const checkForUpdate = () => call<UpdateInfo | null>("check_for_update");
/** Downloads, verifies and installs, then the app restarts itself. */
export const installUpdate = (onProgress: (p: UpdateProgress) => void) =>
  call<void>("install_update", { onProgress: new Channel<UpdateProgress>(onProgress) });
