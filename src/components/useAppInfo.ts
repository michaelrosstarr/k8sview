"use client";

import { useEffect, useState } from "react";
import { appInfo, type AppInfo } from "@/lib/updates";

/** Name, version and dev flag of the running build (null until loaded). */
export function useAppInfo(): AppInfo | null {
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    appInfo().then(setInfo, () => {});
  }, []);
  return info;
}
