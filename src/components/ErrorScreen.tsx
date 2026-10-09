"use client";

import type { ReactNode } from "react";
import { Badge, Box, Center, Group, Paper, ScrollArea, Stack, Text, ThemeIcon, Title } from "@mantine/core";
import { Logo } from "./Logo";

export interface TerminalEntry {
  command: string;
  /** Printed in red before `output`. */
  error?: string;
  output?: string;
}

interface Props {
  icon: ReactNode;
  /** Pod-style status shown in the badge, e.g. "Error" or "NotFound". */
  status: string;
  title: string;
  description: ReactNode;
  /** kubectl-style transcript explaining what happened. */
  terminal: TerminalEntry[];
  actions: ReactNode;
}

/**
 * Full-page error state styled after the rest of the app: the k8sview header,
 * a red status badge like the pods table, and a kubectl-style transcript.
 * It only depends on MantineProvider, so global-error can render it too.
 */
export function ErrorScreen({ icon, status, title, description, terminal, actions }: Props) {
  return (
    <Center mih="100vh" p="md">
      <Stack maw={720} w="100%" gap="lg">
        <Group gap="xs">
          <Logo />
          <Title order={4}>k8sview</Title>
        </Group>

        <Paper withBorder radius="md" p="xl">
          <Stack gap="lg">
            <Group gap="md" wrap="nowrap" align="flex-start">
              <ThemeIcon size={48} radius="xl" color="red" variant="light">
                {icon}
              </ThemeIcon>
              <Stack gap={6}>
                <Group gap="xs">
                  <Title order={3}>{title}</Title>
                  <Badge color="red" variant="light">
                    {status}
                  </Badge>
                </Group>
                <Text c="dimmed" size="sm">
                  {description}
                </Text>
              </Stack>
            </Group>

            <Terminal entries={terminal} />

            <Group justify="flex-end" gap="sm">
              {actions}
            </Group>
          </Stack>
        </Paper>
      </Stack>
    </Center>
  );
}

/** Always-dark terminal block, regardless of the app's color scheme. */
function Terminal({ entries }: { entries: TerminalEntry[] }) {
  return (
    <Box
      bg="dark.8"
      c="gray.3"
      p="md"
      style={{ borderRadius: "var(--mantine-radius-md)", border: "1px solid var(--mantine-color-dark-5)" }}
    >
      <ScrollArea.Autosize mah={280} type="auto">
        <Box component="pre" ff="monospace" fz="xs" m={0} style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {entries.map((e, i) => (
            <Box component="span" key={i} display="block" mt={i ? "sm" : 0}>
              <Text span inherit c="teal.4">
                $
              </Text>{" "}
              <Text span inherit c="gray.0" fw={600}>
                {e.command}
              </Text>
              {"\n"}
              {e.error && (
                <Text span inherit c="red.5">
                  {e.output ? `${e.error}\n` : e.error}
                </Text>
              )}
              {e.output && <TerminalOutput text={e.output} />}
            </Box>
          ))}
        </Box>
      </ScrollArea.Autosize>
    </Box>
  );
}

const ERROR_WORDS = /\b(Error|CrashLoopBackOff|NotFound|0\/1)\b/g;

/** Colour status words red, like failing pods in the table. */
function TerminalOutput({ text }: { text: string }) {
  return text.split(ERROR_WORDS).map((part, i) =>
    i % 2 ? (
      <Text span inherit c="red.5" key={i}>
        {part}
      </Text>
    ) : (
      part
    ),
  );
}
