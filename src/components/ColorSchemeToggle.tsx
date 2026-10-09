"use client";

import { ActionIcon, Tooltip, useComputedColorScheme, useMantineColorScheme } from "@mantine/core";
import { IconMoon, IconSun } from "@tabler/icons-react";
import classes from "./ColorSchemeToggle.module.css";

/** Shows the scheme you'd switch to: a sun in dark mode, a moon in light mode. */
export function ColorSchemeToggle() {
  const { setColorScheme } = useMantineColorScheme();
  // Only read when clicking, never while rendering: the prerendered HTML can't know
  // the scheme, so rendering from it would break hydration.
  const computed = useComputedColorScheme("light", { getInitialValueInEffect: true });

  return (
    <Tooltip label="Toggle color scheme">
      <ActionIcon
        variant="default"
        size="lg"
        aria-label="Toggle color scheme"
        onClick={() => setColorScheme(computed === "dark" ? "light" : "dark")}
      >
        <IconSun size={18} className={classes.sun} />
        <IconMoon size={18} className={classes.moon} />
      </ActionIcon>
    </Tooltip>
  );
}
