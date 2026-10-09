"use client";

import { useEffect } from "react";
import { Button, CopyButton } from "@mantine/core";
import { IconBug, IconCheck, IconCopy, IconRefresh, IconRotateClockwise } from "@tabler/icons-react";
import { ErrorScreen } from "./ErrorScreen";

/** Shared body of error.tsx and global-error.tsx. */
export function CrashScreen({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  const head = `${error.name}: ${error.message}`;
  // V8 stacks start with the "Name: message" line; WebKit (Tauri on macOS) only lists frames.
  const frames = error.stack?.startsWith(head) ? error.stack.slice(head.length).replace(/^\n/, "") : (error.stack ?? "");
  const rest = [frames, error.digest && `digest: ${error.digest}`].filter(Boolean).join("\n");
  const details = `k8sview UI error\n\n${head}\n${rest}`;

  return (
    <ErrorScreen
      icon={<IconBug size={26} />}
      status="Error"
      title="The UI crashed"
      description={
        <>
          k8sview hit an unexpected error while rendering. Your cluster was not touched, and active port forwards
          keep running in the background. Restarting usually gets you going again.
        </>
      }
      terminal={[
        {
          command: "kubectl get pod k8sview-ui",
          output: "NAME         READY   STATUS   RESTARTS\nk8sview-ui   0/1     Error    0",
        },
        { command: "kubectl logs k8sview-ui", error: head, output: rest },
      ]}
      actions={
        <>
          <CopyButton value={details}>
            {({ copied, copy }) => (
              <Button
                variant="subtle"
                color={copied ? "teal" : "gray"}
                leftSection={copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                onClick={copy}
              >
                {copied ? "Copied" : "Copy details"}
              </Button>
            )}
          </CopyButton>
          <Button variant="default" leftSection={<IconRefresh size={16} />} onClick={() => window.location.reload()}>
            Reload app
          </Button>
          <Button leftSection={<IconRotateClockwise size={16} />} onClick={retry}>
            Restart
          </Button>
        </>
      }
    />
  );
}
