"use client";

import { Suspense, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { Box, Center, Text } from "@mantine/core";
import { LogTerminal } from "@/components/logs/LogTerminal";

/** A popped-out log window: one terminal filling the window. */
export default function LogsPage() {
  return (
    <Suspense fallback={null}>
      <LogsWindow />
    </Suspense>
  );
}

function LogsWindow() {
  const params = useSearchParams();
  const target = useMemo(
    () => ({
      context: params.get("context") ?? "",
      namespace: params.get("ns") ?? "",
      pod: params.get("pod") ?? "",
      container: params.get("container"),
    }),
    [params],
  );

  if (!target.pod) {
    return (
      <Center h="100vh">
        <Text c="dimmed">No pod selected.</Text>
      </Center>
    );
  }

  return (
    <Box h="100vh">
      <LogTerminal
        target={target}
        actions={
          <Text size="xs" c="dimmed" ff="monospace" title={target.context}>
            {target.namespace}/{target.pod}
          </Text>
        }
      />
    </Box>
  );
}
