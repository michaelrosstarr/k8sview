"use client";

import "@mantine/core/styles.css";

import { ColorSchemeScript, MantineProvider, mantineHtmlProps } from "@mantine/core";
import { CrashScreen } from "@/components/CrashScreen";

// Replaces the root layout when it crashes, so it brings its own document and theme.
// Mantine keeps the chosen color scheme in localStorage, so this still matches the app.
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="en" {...mantineHtmlProps}>
      <head>
        <title>k8sview – error</title>
        <ColorSchemeScript defaultColorScheme="auto" />
      </head>
      <body>
        <MantineProvider defaultColorScheme="auto">
          <CrashScreen error={error} retry={retry} />
        </MantineProvider>
      </body>
    </html>
  );
}
