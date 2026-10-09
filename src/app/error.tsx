"use client";

import { CrashScreen } from "@/components/CrashScreen";

// Catches render errors in the page; the root layout (theme, providers) stays mounted.
export default function ErrorPage({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <CrashScreen error={error} retry={retry} />;
}
