"use client";

import { Suspense, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { Box, Center, Text } from "@mantine/core";
import { ShellTerminal } from "@/components/logs/ShellTerminal";

/** A popped-out shell window: one interactive terminal filling the window. */
export default function ShellPage() {
  return (
    <Suspense fallback={null}>
      <ShellWindow />
    </Suspense>
  );
}

function ShellWindow() {
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
      <ShellTerminal
        target={target}
        initialMode={params.get("mode") === "attach" ? "attach" : "exec"}
        actions={
          <Text size="xs" c="dimmed" ff="monospace" title={target.context}>
            {target.namespace}/{target.pod}
          </Text>
        }
      />
    </Box>
  );
}
