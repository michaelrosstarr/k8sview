"use client";

import { useState } from "react";
import { Box, Center, Loader, useComputedColorScheme } from "@mantine/core";
import Editor, { loader } from "@monaco-editor/react";

// Served from public/monaco (see scripts/copy-monaco.mjs) rather than the default CDN.
loader.config({ paths: { vs: "/monaco/vs" } });

const LINE_HEIGHT = 18;
const MAX_HEIGHT = 480;

const EXTENSIONS: Record<string, string> = {
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  xml: "xml",
  html: "html",
  css: "css",
  js: "javascript",
  ts: "typescript",
  py: "python",
  sh: "shell",
  bash: "shell",
  sql: "sql",
  md: "markdown",
  lua: "lua",
  ini: "ini",
  properties: "ini",
  toml: "ini",
};

/** Guess a Monaco language from a ConfigMap key's extension, else from the value itself. */
export function languageFor(key: string, value: string): string {
  const ext = key.includes(".") ? key.split(".").pop()!.toLowerCase() : "";
  if (EXTENSIONS[ext]) return EXTENSIONS[ext];
  const text = value.trimStart();
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      JSON.parse(text);
      return "json";
    } catch {
      // not JSON
    }
  }
  const firstLine = text.split("\n").find((l) => l.trim() && !l.trimStart().startsWith("#")) ?? "";
  if (text.includes("\n") && /^[\w.-]+:(\s|$)/.test(firstLine)) return "yaml";
  return "plaintext";
}

const clamp = (h: number) => Math.min(MAX_HEIGHT, Math.max(LINE_HEIGHT * 2, h));

/** Read-only Monaco editor that grows with its content up to MAX_HEIGHT. */
export function CodeViewer({ value, language }: { value: string; language: string }) {
  const scheme = useComputedColorScheme("light");
  // Estimate from the line count so the layout doesn't jump once Monaco measures.
  const [height, setHeight] = useState(() => clamp(value.split("\n").length * LINE_HEIGHT + 8));

  return (
    <Box style={{ border: "1px solid var(--mantine-color-default-border)", borderRadius: "var(--mantine-radius-sm)", overflow: "hidden" }}>
      <Editor
        height={height}
        value={value}
        language={language}
        theme={scheme === "dark" ? "vs-dark" : "light"}
        loading={
          <Center h="100%">
            <Loader size="sm" />
          </Center>
        }
        options={{
          readOnly: true,
          domReadOnly: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          wordWrap: "on",
          fontSize: 12,
          lineHeight: LINE_HEIGHT,
          lineNumbersMinChars: 3,
          renderLineHighlight: "none",
          overviewRulerLanes: 0,
          automaticLayout: true,
          padding: { top: 4, bottom: 4 },
          // Let the drawer scroll when the wheel passes over a short editor.
          scrollbar: { alwaysConsumeMouseWheel: false },
        }}
        onMount={(editor) => {
          const fit = () => setHeight(clamp(editor.getContentHeight()));
          editor.onDidContentSizeChange(fit);
          fit();
        }}
      />
    </Box>
  );
}
