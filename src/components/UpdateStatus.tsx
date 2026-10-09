"use client";

import { useCallback, useEffect, useState } from "react";
import { Anchor, Button, Group, Modal, Progress, ScrollArea, Stack, Text, Tooltip } from "@mantine/core";
import { useInterval } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { IconDownload, IconRefresh } from "@tabler/icons-react";
import { checkForUpdate, installUpdate, type UpdateInfo } from "@/lib/updates";
import { useAppInfo } from "./useAppInfo";

const FIRST_CHECK_MS = 15_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/** Version + update controls for the bottom of the navbar. */
export function UpdateStatus() {
  const info = useAppInfo();
  const version = info?.version ?? null;
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [open, setOpen] = useState(false);
  const [progress, setProgress] = useState<{ downloaded: number; total: number | null } | "installing" | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);

  /** Background checks stay quiet; a manual check reports what it found. */
  const check = useCallback((manual: boolean) => {
    setChecking(true);
    checkForUpdate()
      .then((found) => {
        setUpdate(found);
        if (manual && !found) notifications.show({ color: "green", title: "You're up to date", message: "No newer version is available." });
        if (manual && found) setOpen(true);
      })
      .catch((e: Error) => {
        if (manual) notifications.show({ color: "red", title: "Couldn't check for updates", message: e.message });
      })
      .finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    const t = setTimeout(() => check(false), FIRST_CHECK_MS);
    return () => clearTimeout(t);
  }, [check]);
  useInterval(() => check(false), CHECK_EVERY_MS, { autoInvoke: true });

  const install = () => {
    setInstallError(null);
    setProgress({ downloaded: 0, total: null });
    installUpdate((p) => setProgress(p.kind === "installing" ? "installing" : { downloaded: p.downloaded, total: p.total })).catch((e: Error) => {
      setProgress(null);
      setInstallError(e.message);
    });
  };

  const percent = progress && progress !== "installing" && progress.total ? (progress.downloaded / progress.total) * 100 : null;

  return (
    <>
      <Stack gap={4} p="xs" style={{ borderTop: "1px solid var(--mantine-color-default-border)" }}>
        {update && (
          <Tooltip label={`Version ${update.version} is ready to install`} withArrow>
            <Button size="compact-xs" color="blue" leftSection={<IconDownload size={14} />} onClick={() => setOpen(true)}>
              Update available
            </Button>
          </Tooltip>
        )}
        <Group justify="space-between" gap={4} wrap="nowrap">
          <Text size="xs" c="dimmed" truncate="end" title={version ?? undefined}>
            {version ? `v${version}` : ""}
          </Text>
          <Anchor component="button" size="xs" onClick={() => check(true)} disabled={checking} aria-label="Check for updates">
            <Group gap={2} wrap="nowrap">
              <IconRefresh size={12} />
              {checking ? "Checking…" : "Updates"}
            </Group>
          </Anchor>
        </Group>
      </Stack>

      <Modal opened={open && update !== null} onClose={() => progress === null && setOpen(false)} title="Update available" centered>
        {update && (
          <Stack>
            <Text size="sm">
              <b>k8sview {update.version}</b> is available. You have {update.current}.
              {update.date && (
                <Text span size="sm" c="dimmed">
                  {" "}
                  Released {new Date(update.date).toLocaleDateString()}.
                </Text>
              )}
            </Text>
            {update.notes && (
              <ScrollArea.Autosize mah={240} type="auto">
                <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
                  {update.notes}
                </Text>
              </ScrollArea.Autosize>
            )}
            <Text size="xs" c="dimmed">
              The update is verified against the app&apos;s signing key before it installs. Port forwards and open terminals close when the app restarts.
            </Text>
            {progress !== null && (
              <Stack gap={4}>
                <Progress value={progress === "installing" ? 100 : (percent ?? 100)} animated={progress === "installing" || percent === null} />
                <Text size="xs" c="dimmed">
                  {progress === "installing"
                    ? "Installing; the app will restart…"
                    : `Downloading ${(progress.downloaded / 1048576).toFixed(1)} MiB${progress.total ? ` of ${(progress.total / 1048576).toFixed(1)} MiB` : ""}`}
                </Text>
              </Stack>
            )}
            {installError && (
              <Text size="sm" c="red">
                {installError}
              </Text>
            )}
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setOpen(false)} disabled={progress !== null}>
                Later
              </Button>
              <Button leftSection={<IconDownload size={16} />} onClick={install} loading={progress !== null}>
                Install & restart
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </>
  );
}
