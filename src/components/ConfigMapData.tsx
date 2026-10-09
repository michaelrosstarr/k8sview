"use client";

import { ActionIcon, CopyButton, Group, Stack, Text, Tooltip } from "@mantine/core";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import { CodeViewer, languageFor } from "./CodeViewer";

/** Each key of a ConfigMap with its value in a read-only Monaco editor. */
export function ConfigMapData({ data }: { data: Record<string, string> }) {
  const entries = Object.entries(data);
  if (entries.length === 0) return <Text c="dimmed">This ConfigMap has no data.</Text>;
  return (
    <Stack>
      {entries.map(([key, value]) => {
        const language = languageFor(key, value);
        return (
          <Stack key={key} gap={4}>
            <Group justify="space-between">
              <Group gap="xs">
                <Text fw={600} ff="monospace" size="sm">
                  {key}
                </Text>
                <Text size="xs" c="dimmed">
                  {language}
                </Text>
              </Group>
              <CopyButton value={value}>
                {({ copied, copy }) => (
                  <Tooltip label={copied ? "Copied" : "Copy value"} withArrow>
                    <ActionIcon variant="subtle" color={copied ? "teal" : "gray"} onClick={copy}>
                      {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                    </ActionIcon>
                  </Tooltip>
                )}
              </CopyButton>
            </Group>
            <CodeViewer value={value} language={language} />
          </Stack>
        );
      })}
    </Stack>
  );
}
