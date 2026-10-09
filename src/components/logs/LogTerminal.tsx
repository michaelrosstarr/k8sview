"use client";

import "@xterm/xterm/css/xterm.css";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ActionIcon,
  Badge,
  Box,
  Chip,
  Group,
  Select,
  Text,
  TextInput,
  Tooltip,
  useComputedColorScheme,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import {
  IconArrowDown,
  IconArrowUp,
  IconCheck,
  IconCopy,
  IconEraser,
  IconFilter,
  IconLetterCase,
  IconRefresh,
  IconRegex,
  IconSearch,
} from "@tabler/icons-react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { ISearchOptions, SearchAddon } from "@xterm/addon-search";
import {
  podContainers,
  startLogStream,
  stopLogStream,
  targetKey,
  type ContainerInfo,
  type LogTarget,
} from "@/lib/logs";

/** Lines kept per terminal; older ones fall off the top. */
export const MAX_LINES = 50_000;
const TAILS = [
  { value: "100", label: "Last 100" },
  { value: "500", label: "Last 500" },
  { value: "2000", label: "Last 2,000" },
  { value: "10000", label: "Last 10,000" },
  { value: "all", label: "Everything" },
];

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const TIMESTAMP = /^(\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:\d\d)) /;

export const THEMES = {
  dark: { background: "#1a1b1e", foreground: "#d4d4d4", cursor: "#1a1b1e", selectionBackground: "#3a5a8c" },
  light: { background: "#fbfbfa", foreground: "#1f1f1f", cursor: "#fbfbfa", selectionBackground: "#b7d3f6" },
};

const DECORATIONS = {
  matchBackground: "#fab21955",
  matchOverviewRuler: "#fab219",
  activeMatchBackground: "#ec835a",
  activeMatchColorOverviewRuler: "#ec835a",
};

type Status = "connecting" | "streaming" | "ended" | "error";

interface Props {
  target: LogTarget;
  /** Called when the user picks another container, so a dock can retitle its tab. */
  onContainerChange?: (container: string) => void;
  /** Extra buttons for the toolbar (pop out, close, ...). */
  actions?: ReactNode;
}

function buildMatcher(query: string, regex: boolean, caseSensitive: boolean): RegExp | null | "invalid" {
  if (!query) return null;
  try {
    return new RegExp(regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseSensitive ? "" : "i");
  } catch {
    return "invalid";
  }
}

/** Dim the RFC 3339 timestamp kubectl-style `--timestamps` puts in front of each line. */
const decorate = (line: string) => line.replace(TIMESTAMP, "\x1b[2m$1\x1b[22m ");

/**
 * Clear the terminal through its write queue (ESC c, full reset). `term.reset()`
 * runs immediately, so lines still queued from earlier writes would land after it.
 */
export const clearTerminal = (term: Terminal) => term.write("\x1bc");

export function LogTerminal({ target, onContainerChange, actions }: Props) {
  const scheme = useComputedColorScheme("dark");
  const hostRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const linesRef = useRef<string[]>([]);
  const matcherRef = useRef<RegExp | null>(null);
  const filterRef = useRef(false);
  const followRef = useRef(true);
  const refreshSearchRef = useRef<() => void>(() => {});

  const [ready, setReady] = useState(false);
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  /** targetKey of the pod whose container list has loaded (or failed to). */
  const [containersFor, setContainersFor] = useState<string | null>(null);
  const [container, setContainer] = useState<string | null>(target.container);
  const [tail, setTail] = useState("500");
  const [timestamps, setTimestamps] = useState(false);
  const [previous, setPrevious] = useState(false);
  const [follow, setFollow] = useState(true);
  const [reconnect, setReconnect] = useState(0);
  // Keyed by the stream it describes, so a restarted stream starts from "connecting" / 0 lines.
  const [stream, setStream] = useState<{ key: string; status: Status; count: number; error?: string }>({
    key: "",
    status: "connecting",
    count: 0,
  });

  const [query, setQuery] = useState("");
  const [debouncedQuery] = useDebouncedValue(query, 200);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [filter, setFilter] = useState(false);
  const [results, setResults] = useState<{ index: number; count: number } | null>(null);

  const matcher = useMemo(() => buildMatcher(debouncedQuery, regex, caseSensitive), [debouncedQuery, regex, caseSensitive]);
  const effectiveContainer = container ?? containers.find((c) => !c.init)?.name ?? null;
  const streamKey = `${targetKey(target)}|${effectiveContainer}|${tail}|${timestamps}|${previous}|${reconnect}`;
  const status: Status = stream.key === streamKey ? stream.status : "connecting";
  const lineCount = stream.key === streamKey ? stream.count : 0;

  // Create the terminal once. xterm touches `window`, so load it lazily on the client.
  useEffect(() => {
    let disposed = false;
    let observer: ResizeObserver | null = null;
    (async () => {
      const [{ Terminal }, { FitAddon }, { SearchAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-search"),
      ]);
      if (disposed || !hostRef.current) return;
      const term = new Terminal({
        allowProposedApi: true,
        disableStdin: true,
        convertEol: false,
        scrollback: MAX_LINES,
        fontSize: 12,
        lineHeight: 1.2,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
        cursorInactiveStyle: "none",
        theme: THEMES[scheme],
      });
      const fit = new FitAddon();
      const search = new SearchAddon({ highlightLimit: 2000 });
      term.loadAddon(fit);
      term.loadAddon(search);
      term.open(hostRef.current);
      search.onDidChangeResults((r) => setResults(r.resultCount > 0 || r.resultIndex >= 0 ? { index: r.resultIndex, count: r.resultCount } : { index: -1, count: 0 }));
      // Cmd/Ctrl+F inside the terminal jumps to the search box.
      term.attachCustomKeyEventHandler((e) => {
        if (e.type === "keydown" && e.key === "f" && (e.metaKey || e.ctrlKey)) {
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
          return false;
        }
        return true;
      });
      termRef.current = term;
      fitRef.current = fit;
      searchRef.current = search;
      // Hidden tabs have no size; refit whenever the host becomes visible or resizes.
      observer = new ResizeObserver(() => {
        if (hostRef.current?.offsetWidth) fit.fit();
      });
      observer.observe(hostRef.current);
      if (hostRef.current.offsetWidth) fit.fit();
      setReady(true);
    })();
    return () => {
      disposed = true;
      observer?.disconnect();
      termRef.current?.dispose();
      termRef.current = null;
    };
    // The theme is applied by its own effect; recreating the terminal would drop its buffer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = THEMES[scheme];
  }, [scheme, ready]);

  useEffect(() => {
    let cancelled = false;
    podContainers(target)
      .then((list) => !cancelled && setContainers(list))
      .catch(() => {
        // The stream reports pod errors itself.
      })
      .finally(() => !cancelled && setContainersFor(targetKey(target)));
    return () => {
      cancelled = true;
    };
  }, [target]);

  const runSearch = useCallback(
    (direction: "next" | "previous", incremental = false) => {
      const search = searchRef.current;
      if (!search) return;
      if (!debouncedQuery || matcher === "invalid") {
        // The match counter is hidden without a valid query, so only the highlights need clearing.
        search.clearDecorations();
        return;
      }
      const options: ISearchOptions = { regex, caseSensitive, incremental, decorations: DECORATIONS };
      if (direction === "next") search.findNext(debouncedQuery, options);
      else search.findPrevious(debouncedQuery, options);
    },
    [debouncedQuery, matcher, regex, caseSensitive],
  );

  // Throttled: re-highlight matches as new lines arrive.
  useEffect(() => {
    let pending: ReturnType<typeof setTimeout> | null = null;
    refreshSearchRef.current = () => {
      if (pending || !debouncedQuery) return;
      pending = setTimeout(() => {
        pending = null;
        runSearch("next", true);
      }, 500);
    };
    return () => {
      if (pending) clearTimeout(pending);
    };
  }, [runSearch, debouncedQuery]);

  const visible = useCallback((line: string) => {
    const m = matcherRef.current;
    return !filterRef.current || !m || m.test(line.replace(ANSI, ""));
  }, []);

  const writeLines = useCallback((lines: string[]) => {
    const term = termRef.current;
    if (!term || lines.length === 0) return;
    term.write(lines.map(decorate).join("\r\n") + "\r\n", () => {
      if (followRef.current) term.scrollToBottom();
    });
  }, []);

  /** Redraw from the buffer, e.g. when the filter changes. */
  const redraw = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    clearTerminal(term);
    writeLines(linesRef.current.filter(visible));
  }, [visible, writeLines]);

  // Filter / search changes: redraw if filtering, then highlight matches.
  useEffect(() => {
    const wasFiltering = filterRef.current;
    matcherRef.current = matcher instanceof RegExp ? matcher : null;
    filterRef.current = filter;
    if (filter || wasFiltering) redraw();
    runSearch("next");
  }, [matcher, filter, redraw, runSearch]);

  // Tell the owner which container is showing, including the default it resolved to.
  const onContainerChangeRef = useRef(onContainerChange);
  useEffect(() => {
    onContainerChangeRef.current = onContainerChange;
  });
  useEffect(() => {
    if (effectiveContainer) onContainerChangeRef.current?.(effectiveContainer);
  }, [effectiveContainer]);

  // Without an explicit container, wait for the list so multi-container pods get a valid one.
  const canStream = ready && (target.container !== null || containersFor === targetKey(target));

  // The stream itself: restarts whenever what we're showing changes.
  useEffect(() => {
    if (!canStream) return;
    const term = termRef.current!;
    clearTerminal(term);
    linesRef.current = [];
    let id: number | null = null;
    let cancelled = false;
    let count = 0;
    startLogStream(
      { ...target, container: effectiveContainer },
      { container: effectiveContainer, previous, timestamps, tail_lines: tail === "all" ? null : Number(tail) },
      (event) => {
        if (cancelled) return;
        if (event.kind === "lines") {
          const buffer = linesRef.current;
          buffer.push(...event.lines);
          if (buffer.length > MAX_LINES) buffer.splice(0, buffer.length - MAX_LINES);
          count += event.lines.length;
          writeLines(event.lines.filter(visible));
          setStream({ key: streamKey, status: "streaming", count });
          refreshSearchRef.current();
        } else if (event.kind === "end") {
          setStream({ key: streamKey, status: "ended", count });
        } else {
          setStream({ key: streamKey, status: "error", count, error: event.message });
        }
      },
    )
      .then((streamId) => {
        if (cancelled) void stopLogStream(streamId);
        else {
          id = streamId;
          // Lines may already have arrived; only fill in a status if none did.
          setStream((s) => (s.key === streamKey ? s : { key: streamKey, status: "streaming", count: 0 }));
        }
      })
      .catch((e: Error) => !cancelled && setStream({ key: streamKey, status: "error", count: 0, error: e.message }));
    return () => {
      cancelled = true;
      if (id !== null) void stopLogStream(id);
    };
    // streamKey captures every input to the stream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canStream, streamKey]);

  const toggleFollow = () => {
    followRef.current = !follow;
    setFollow(!follow);
    if (!follow) termRef.current?.scrollToBottom();
  };

  const pickContainer = (name: string | null) => {
    if (!name) return;
    setContainer(name);
    setPrevious(false);
  };

  const current = containers.find((c) => c.name === effectiveContainer);
  const statusBadge = {
    connecting: { color: "gray", label: "connecting" },
    streaming: { color: "green", label: previous ? "previous container" : "live" },
    ended: { color: "gray", label: "ended" },
    error: { color: "red", label: "error" },
  }[status];

  return (
    <Box style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <Group gap={6} px="xs" py={6} wrap="wrap" style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}>
        <Select
          size="xs"
          w={170}
          aria-label="Container"
          data={containers.map((c) => ({ value: c.name, label: c.init ? `${c.name} (init)` : c.name }))}
          value={effectiveContainer}
          onChange={pickContainer}
          allowDeselect={false}
          placeholder="container"
        />
        <Select size="xs" w={120} aria-label="Lines to load" data={TAILS} value={tail} onChange={(v) => v && setTail(v)} allowDeselect={false} />
        <Chip size="xs" checked={follow} onChange={toggleFollow}>
          Follow
        </Chip>
        <Chip size="xs" checked={timestamps} onChange={setTimestamps}>
          Timestamps
        </Chip>
        <Tooltip
          label={current?.restart_count ? `Logs from before the last restart (${current.restart_count} restarts)` : "No restarts, so no previous container"}
          withArrow
        >
          <span>
            <Chip size="xs" checked={previous} onChange={setPrevious} disabled={!current?.restart_count}>
              Previous
            </Chip>
          </span>
        </Tooltip>

        <TextInput
          ref={searchInputRef}
          size="xs"
          w={240}
          placeholder="Search (⌘F)"
          leftSection={<IconSearch size={14} />}
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") runSearch(e.shiftKey ? "previous" : "next");
            if (e.key === "Escape") setQuery("");
          }}
          error={matcher === "invalid"}
          rightSectionWidth={64}
          rightSection={
            debouncedQuery && matcher !== "invalid" ? (
              <Text size="10px" c="dimmed" style={{ whiteSpace: "nowrap" }}>
                {results && results.count > 0 ? `${results.index + 1}/${results.count}` : "0/0"}
              </Text>
            ) : null
          }
        />
        <Group gap={2}>
          <Tooltip label="Match case" withArrow>
            <ActionIcon size="sm" variant={caseSensitive ? "filled" : "subtle"} color="gray" onClick={() => setCaseSensitive(!caseSensitive)} aria-pressed={caseSensitive} aria-label="Match case">
              <IconLetterCase size={14} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Regular expression" withArrow>
            <ActionIcon size="sm" variant={regex ? "filled" : "subtle"} color="gray" onClick={() => setRegex(!regex)} aria-pressed={regex} aria-label="Regular expression">
              <IconRegex size={14} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Only show matching lines" withArrow>
            <ActionIcon size="sm" variant={filter ? "filled" : "subtle"} color="gray" onClick={() => setFilter(!filter)} aria-pressed={filter} aria-label="Only show matching lines">
              <IconFilter size={14} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Previous match (⇧Enter)" withArrow>
            <ActionIcon size="sm" variant="subtle" color="gray" onClick={() => runSearch("previous")} disabled={!debouncedQuery} aria-label="Previous match">
              <IconArrowUp size={14} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Next match (Enter)" withArrow>
            <ActionIcon size="sm" variant="subtle" color="gray" onClick={() => runSearch("next")} disabled={!debouncedQuery} aria-label="Next match">
              <IconArrowDown size={14} />
            </ActionIcon>
          </Tooltip>
        </Group>

        <Group gap={6} ml="auto" wrap="nowrap">
          <Tooltip label={stream.key === streamKey && stream.error ? stream.error : `${lineCount.toLocaleString()} lines received`} multiline maw={420} withArrow>
            <Badge size="sm" variant="light" color={statusBadge.color} style={{ textTransform: "none" }}>
              {statusBadge.label} · {lineCount.toLocaleString()}
            </Badge>
          </Tooltip>
          <Tooltip label="Clear" withArrow>
            <ActionIcon size="sm" variant="subtle" color="gray" aria-label="Clear" onClick={() => {
              linesRef.current = [];
              if (termRef.current) clearTerminal(termRef.current);
            }}>
              <IconEraser size={14} />
            </ActionIcon>
          </Tooltip>
          <CopyLogs linesRef={linesRef} visible={visible} />
          <Tooltip label="Reconnect" withArrow>
            <ActionIcon size="sm" variant="subtle" color="gray" aria-label="Reconnect" onClick={() => setReconnect((n) => n + 1)}>
              <IconRefresh size={14} />
            </ActionIcon>
          </Tooltip>
          {actions}
        </Group>
      </Group>
      {status === "error" && stream.error && (
        <Text size="xs" c="red" px="xs" py={4} style={{ wordBreak: "break-word" }}>
          {stream.error}
        </Text>
      )}
      <Box ref={hostRef} style={{ flex: 1, minHeight: 0, padding: "4px 0 0 6px", background: THEMES[scheme].background }} />
    </Box>
  );
}

function CopyLogs({ linesRef, visible }: { linesRef: React.RefObject<string[]>; visible: (line: string) => boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <Tooltip label={copied ? "Copied" : "Copy shown lines"} withArrow>
      <ActionIcon
        size="sm"
        variant="subtle"
        color={copied ? "teal" : "gray"}
        aria-label="Copy shown lines"
        onClick={async () => {
          await navigator.clipboard.writeText(linesRef.current.filter(visible).map((l) => l.replace(ANSI, "")).join("\n"));
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
      </ActionIcon>
    </Tooltip>
  );
}
