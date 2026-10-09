"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button } from "@mantine/core";
import { IconArrowLeft, IconMapQuestion } from "@tabler/icons-react";
import { ErrorScreen } from "@/components/ErrorScreen";

export default function NotFound() {
  const path = usePathname() ?? "/";
  return (
    <ErrorScreen
      icon={<IconMapQuestion size={26} />}
      status="NotFound"
      title="Page not found"
      description="k8sview is a single-page app, so this address doesn't lead anywhere."
      terminal={[
        {
          command: `kubectl get page ${path}`,
          output: `Error from server (NotFound): pages "${path}" not found`,
        },
      ]}
      actions={
        <Button component={Link} href="/" leftSection={<IconArrowLeft size={16} />}>
          Back to k8sview
        </Button>
      }
    />
  );
}
