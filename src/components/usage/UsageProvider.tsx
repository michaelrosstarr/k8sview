"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { metricsSnapshot, podKey, type MetricsSnapshot } from "@/lib/metrics";

export const SAMPLE_MS = 15_000;
/** 30 minutes of history at one sample per 15s. */
const MAX_SAMPLES = 120;

/** One poll, reduced to what the charts need: [cpu cores, memory bytes]. */
export interface Sample {
  t: number;
  cluster: [number, number];
  nodes: Record<string, [number, number]>;
  pods: Record<string, [number, number]>;
}

interface UsageValue {
  snapshot: MetricsSnapshot | null;
  samples: Sample[];
  error: string | null;
  /** Begin sampling (idempotent); history accumulates from then on. */
  start: () => void;
}

const UsageContext = createContext<UsageValue | null>(null);

export function useUsage(): UsageValue {
  const value = useContext(UsageContext);
  if (!value) throw new Error("useUsage must be used inside UsageProvider");
  return value;
}

function toSample(s: MetricsSnapshot): Sample {
  const nodes: Sample["nodes"] = {};
  let cpu = 0;
  let memory = 0;
  for (const n of s.nodes) {
    if (!n.usage) continue;
    nodes[n.name] = [n.usage.cpu, n.usage.memory];
    cpu += n.usage.cpu;
    memory += n.usage.memory;
  }
  const pods: Sample["pods"] = {};
  for (const p of s.pods) if (p.usage) pods[podKey(p)] = [p.usage.cpu, p.usage.memory];
  return { t: Date.now(), cluster: [cpu, memory], nodes, pods };
}

/**
 * Samples metrics-server every 15s once started and keeps a rolling history,
 * so graphs survive switching views. Key it by kube context to reset on switch.
 */
export function UsageProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState(false);
  const [snapshot, setSnapshot] = useState<MetricsSnapshot | null>(null);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(() => setActive(true), []);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let inFlight = false;
    const poll = () => {
      if (inFlight) return;
      inFlight = true;
      metricsSnapshot()
        .then((s) => {
          if (cancelled) return;
          setSnapshot(s);
          setError(null);
          if (!s.metrics_error) setSamples((prev) => [...prev, toSample(s)].slice(-MAX_SAMPLES));
        })
        .catch((e: Error) => !cancelled && setError(e.message))
        .finally(() => {
          inFlight = false;
        });
    };
    poll();
    const timer = setInterval(poll, SAMPLE_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [active]);

  return <UsageContext.Provider value={{ snapshot, samples, error, start }}>{children}</UsageContext.Provider>;
}
