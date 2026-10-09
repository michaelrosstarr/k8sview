import { Badge } from "@mantine/core";
import { IconCircleCheck, IconCircleX, IconHelpCircle, IconPlayerPause, IconProgress } from "@tabler/icons-react";
import type { FluxStatus } from "@/lib/flux";

type IconType = typeof IconCircleCheck;

/** Badge styling for exact statuses (tables, drawer). */
export const STATUS: Record<FluxStatus, { label: string; color: string; Icon: IconType }> = {
  ready: { label: "Ready", color: "green", Icon: IconCircleCheck },
  failing: { label: "Failing", color: "red", Icon: IconCircleX },
  progressing: { label: "Progressing", color: "yellow", Icon: IconProgress },
  suspended: { label: "Suspended", color: "gray", Icon: IconPlayerPause },
  unknown: { label: "Unknown", color: "gray", Icon: IconHelpCircle },
};

/**
 * Chart buckets. Progressing and unknown share "Pending" so the status palette
 * stays at four colors; tables still show the exact status.
 */
export type HealthBucket = "ready" | "pending" | "failing" | "suspended";

export const BUCKETS: { key: HealthBucket; label: string; cssVar: string; Icon: IconType }[] = [
  { key: "ready", label: "Ready", cssVar: "var(--status-ready)", Icon: IconCircleCheck },
  { key: "pending", label: "Pending", cssVar: "var(--status-pending)", Icon: IconProgress },
  { key: "failing", label: "Failing", cssVar: "var(--status-failing)", Icon: IconCircleX },
  { key: "suspended", label: "Suspended", cssVar: "var(--status-suspended)", Icon: IconPlayerPause },
];

export function bucketOf(status: FluxStatus): HealthBucket {
  return status === "progressing" || status === "unknown" ? "pending" : status;
}

export function StatusBadge({ status }: { status: FluxStatus }) {
  const { label, color, Icon } = STATUS[status];
  return (
    <Badge color={color} variant="light" leftSection={<Icon size={12} />}>
      {label}
    </Badge>
  );
}
