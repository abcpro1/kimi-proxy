import React, {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ColumnDef,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useThemeStore } from "./store/themeStore";
import SearchFilters from "./components/SearchFilters";
import {
  createLogsStore,
  tables,
  type LogsStore,
  type LogDocType,
} from "./data/db";
import { syncLogs } from "./data/sync";
import { fetchBlob } from "./data/blobs";
import { searchLogBlobs } from "./data/search";
import "./index.css";
import { RefreshCw, Pause, Sun, Moon, SunMoon, FolderOpen } from "lucide-react";

import { CopyButton } from "./components/CopyButton";
const JSONViewer = React.lazy(() => import("./components/JSONViewer"));

type BlobKind =
  | "request"
  | "response"
  | "provider-request"
  | "provider-response";

function parseJson(value?: string) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function extractBlobSearchQuery(query: string) {
  const tokens = query.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  const parts: string[] = [];

  for (const token of tokens) {
    const cleanToken = token.replace(/^"(.*)"$/, "$1").trim();
    if (!cleanToken) continue;
    if (/^(and|or|not)$/i.test(cleanToken)) continue;
    if (/^\w+:.+/.test(cleanToken)) continue;
    parts.push(token);
  }

  return parts.join(" ");
}

function StatusBadge({ status }: { status: number }) {
  const isSuccess = status >= 200 && status < 300;
  const isWarning = status >= 300 && status < 400;
  const isError = status >= 400;

  return (
    <span
      className={`badge ${
        isSuccess
          ? "badge-success"
          : isWarning
            ? "badge-warning"
            : "badge-error"
      }`}
      title={`HTTP ${status}`}
    >
      {status}
    </span>
  );
}

function MethodPill({ method }: { method: string }) {
  return <span className="method-pill">{method}</span>;
}

const LogRow = React.memo(
  function LogRow({
    log,
    expanded,
    activeTab,
    onToggle,
    onTabChange,
    blobBody,
    ensureBlob,
    loadingBlob,
  }: {
    log: LogDocType;
    expanded: boolean;
    activeTab: BlobKind;
    onToggle: (id: string) => void;
    onTabChange: (id: string, tab: BlobKind) => void;
    blobBody: string | undefined;
    ensureBlob: (logId: string, kind: BlobKind) => Promise<void>;
    loadingBlob: boolean;
  }) {
    const [logDirectoryPath, setLogDirectoryPath] = useState<string | null>(
      null,
    );

    const summary = log.summary ? parseJson(log.summary) : null;
    const preview =
      summary && typeof summary === "object" && "preview" in summary
        ? (summary as { preview?: string }).preview
        : undefined;
    const finish =
      summary && typeof summary === "object" && "finish_reason" in summary
        ? (summary as { finish_reason?: string }).finish_reason
        : undefined;

    const tabs: { id: BlobKind; label: string }[] = [
      { id: "request", label: "Request" },
      { id: "response", label: "Response" },
      { id: "provider-request", label: "Provider Request" },
      { id: "provider-response", label: "Provider Response" },
    ];

    // Fetch log directory path when expanded
    useEffect(() => {
      if (expanded) {
        void ensureBlob(log.id, activeTab);
        // Fetch the absolute path from the backend
        const apiBase = import.meta.env.VITE_API_URL ?? "";
        fetch(`${apiBase}/api/logs/${log.id}/path`)
          .then((res) => res.json())
          .then((data) => {
            if (data.directory) {
              setLogDirectoryPath(data.directory);
            }
          })
          .catch((err) => {
            console.error("Could not fetch log path:", err);
            setLogDirectoryPath(null);
          });
      } else {
        // Clear path when collapsed
        setLogDirectoryPath(null);
      }
    }, [expanded, activeTab, log.id, log.timestamp, log.request_id]);

    const CopyIcon = <FolderOpen size={14} />;

    return (
      <div className={`log-card ${expanded ? "expanded" : ""}`}>
        <div className="log-card-header" onClick={() => onToggle(log.id)}>
          <div className="log-card-meta">
            <MethodPill method={log.method} />
            <span className="log-url">{log.url}</span>
            <StatusBadge status={log.status_code} />
          </div>
          <div className="log-card-details">
            <span>{new Date(log.timestamp).toLocaleString()}</span>
            <span className="muted">Model: {log.model ?? "-"}</span>
            <span className="muted">Provider: {log.provider ?? "-"}</span>
            {finish && <span className="muted">Finish: {finish}</span>}
          </div>
          {preview && <div className="log-preview">{preview}</div>}
        </div>

        {expanded && (
          <div className="log-card-body">
            <div className="tabs-container">
              <div className="tabs">
                {tabs.map((tab) => (
                  <button
                    key={tab.id}
                    className={`tab-btn ${activeTab === tab.id ? "active" : ""}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onTabChange(log.id, tab.id);
                      void ensureBlob(log.id, tab.id);
                    }}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
              {logDirectoryPath && (
                <CopyButton
                  textToCopy={logDirectoryPath}
                  className="copy-path-btn"
                  icon={CopyIcon}
                  label="Copy Path"
                  title="Copy log directory path"
                />
              )}
            </div>
            <div className="tab-content">
              <Suspense
                fallback={<div className="skeleton">Loading viewer…</div>}
              >
                {loadingBlob && <div className="skeleton">Fetching blob…</div>}
                {!loadingBlob && <JSONViewer data={parseJson(blobBody)} />}
              </Suspense>
            </div>
          </div>
        )}
      </div>
    );
  },
  (prev, next) => {
    return (
      prev.expanded === next.expanded &&
      prev.activeTab === next.activeTab &&
      prev.blobBody === next.blobBody &&
      prev.loadingBlob === next.loadingBlob &&
      prev.log.id === next.log.id &&
      prev.log.timestamp === next.log.timestamp &&
      prev.log.status_code === next.log.status_code &&
      prev.log.method === next.log.method &&
      prev.log.url === next.log.url
    );
  },
);

function ThemeToggle() {
  const { theme, setTheme, resolvedTheme } = useThemeStore();

  const cycleTheme = () => {
    if (theme === "light") setTheme("dark");
    else if (theme === "dark") setTheme("system");
    else setTheme("light");
  };

  const getIcon = () => {
    if (theme === "system") return <SunMoon size={16} />;
    if (resolvedTheme === "dark") return <Moon size={16} />;
    return <Sun size={16} />;
  };

  return (
    <button
      className="btn theme-toggle"
      onClick={cycleTheme}
      title={`Current: ${theme} (${resolvedTheme})\nClick to cycle theme`}
    >
      <span className="theme-icon">{getIcon()}</span>
      <span className="theme-text">{theme}</span>
    </button>
  );
}

export default function App() {
  const [store, setStore] = useState<LogsStore | null>(null);
  const [logs, setLogs] = useState<LogDocType[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [tabState, setTabState] = useState<Record<string, BlobKind>>({});
  const [blobBodies, setBlobBodies] = useState<Record<string, string>>({});
  const [loadingBlobs, setLoadingBlobs] = useState<Record<string, boolean>>({});
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [selectedModel, setSelectedModel] = useState("");
  const [selectedProvider, setSelectedProvider] = useState("");
  const [selectedStatus, setSelectedStatus] = useState("");
  const [blobSearch, setBlobSearch] = useState<{
    query: string;
    ids: string[];
    truncated: boolean;
    engine: "rg";
  } | null>(null);
  const [blobSearchLoading, setBlobSearchLoading] = useState(false);
  const [blobSearchError, setBlobSearchError] = useState<string | null>(null);
  const syncingRef = useRef(false);
  const blobSearchSeqRef = useRef(0);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const { theme, initTheme } = useThemeStore();

  // Initialize theme on mount
  useEffect(() => {
    initTheme();
  }, [initTheme]);

  // Debounce search
  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedSearch(search);
    }, 300);
    return () => clearTimeout(handler);
  }, [search]);

  // Listen for system theme changes
  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleThemeChange = () => {
      if (theme === "system") {
        initTheme();
      }
    };

    mediaQuery.addEventListener("change", handleThemeChange);
    return () => mediaQuery.removeEventListener("change", handleThemeChange);
  }, [theme, initTheme]);

  // Enhanced search with field parsing
  const parseSearchQuery = useCallback((query: string) => {
    const terms: { [key: string]: string } = {};
    const textParts: string[] = [];

    // Split by spaces but respect quoted strings
    const tokens = query.match(/(?:[^\s"]+|"[^"]*")+/g) || [];

    for (const token of tokens) {
      // Remove quotes from quoted strings
      const cleanToken = token.replace(/^"(.*)"$/, "$1");
      if (/^(and|or|not)$/i.test(cleanToken)) continue;

      // Check for field-specific searches (field:value)
      const fieldMatch = cleanToken.match(/^(\w+):(.+)$/);
      if (fieldMatch) {
        const [, field, value] = fieldMatch;
        terms[field] = value;
      } else {
        textParts.push(cleanToken);
      }
    }

    return { terms, text: textParts.join(" "), textParts };
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Focus search with Ctrl+K or Cmd+K
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }

      // Clear search with Escape
      if (
        e.key === "Escape" &&
        document.activeElement === searchInputRef.current
      ) {
        if (search) {
          e.preventDefault();
          setSearch("");
        } else {
          searchInputRef.current?.blur();
        }
        return;
      }

      // Toggle theme with Ctrl+Shift+T
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "T") {
        e.preventDefault();
        const { setTheme, theme } = useThemeStore.getState();
        const newTheme =
          theme === "light" ? "dark" : theme === "dark" ? "system" : "light";
        setTheme(newTheme);
        return;
      }

      // Toggle auto refresh with Ctrl+R
      if ((e.ctrlKey || e.metaKey) && e.key === "r") {
        e.preventDefault();
        setAutoRefresh((prev) => !prev);
        return;
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [search]);

  const syncNow = useCallback(async () => {
    if (!store || syncingRef.current) return;
    syncingRef.current = true;
    try {
      await syncLogs(store, { batchSize: 200 });
    } finally {
      syncingRef.current = false;
    }
  }, [store]);

  useEffect(() => {
    let cancelled = false;

    createLogsStore().then((created) => {
      if (cancelled) return;
      setStore(created);

      if (syncingRef.current) return;
      syncingRef.current = true;
      void syncLogs(created, { batchSize: 200 })
        .catch((error) => {
          console.warn("Initial LiveStore sync failed; will retry", error);
        })
        .finally(() => {
          syncingRef.current = false;
        });
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!store) return;
    const runQuery = () => {
      // Snapshot scroll position relative to the expanded item
      if (parentRef.current) {
        const expandedEl =
          parentRef.current.querySelector(".log-card.expanded");
        if (expandedEl) {
          const logId = expandedEl
            .closest("[data-log-id]")
            ?.getAttribute("data-log-id");
          if (logId) {
            const rect = expandedEl.getBoundingClientRect();
            const parentRect = parentRef.current.getBoundingClientRect();
            scrollSnapshotRef.current = {
              id: logId,
              offset: rect.top - parentRect.top,
            };
          }
        }
      }

      const res = store.query(
        tables.logs.orderBy([
          { col: "timestamp", direction: "desc" },
          { col: "numeric_id", direction: "desc" },
        ]),
      );
      setLogs([...(res as LogDocType[])]);
    };
    runQuery();
    const timer = setInterval(runQuery, 1000);
    return () => clearInterval(timer);
  }, [store]);

  useEffect(() => {
    if (!store) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let consecutiveFailures = 0;
    const baseDelayMs = 2500;
    const maxDelayMs = 30000;

    const nextDelayMs = () =>
      Math.min(maxDelayMs, baseDelayMs * 2 ** consecutiveFailures);

    const tick = async () => {
      if (cancelled) return;
      try {
        await syncNow();
        consecutiveFailures = 0;
      } catch (error) {
        consecutiveFailures = Math.min(10, consecutiveFailures + 1);
        console.warn("LiveStore sync failed; retrying", error);
      } finally {
        if (!cancelled && autoRefresh) {
          timer = setTimeout(tick, nextDelayMs());
        }
      }
    };

    if (autoRefresh) {
      void tick();
    }

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [store, autoRefresh, syncNow]);

  const blobQuery = useMemo(
    () => extractBlobSearchQuery(debouncedSearch),
    [debouncedSearch],
  );

  useEffect(() => {
    const seq = blobSearchSeqRef.current + 1;
    blobSearchSeqRef.current = seq;

    if (!blobQuery) {
      setBlobSearch(null);
      setBlobSearchLoading(false);
      setBlobSearchError(null);
      return;
    }

    setBlobSearch(null);
    setBlobSearchError(null);

    const controller = new AbortController();
    const debounce = setTimeout(() => {
      setBlobSearchLoading(true);
      void searchLogBlobs(blobQuery, { signal: controller.signal, limit: 200 })
        .then((res) => {
          if (blobSearchSeqRef.current !== seq) return;
          setBlobSearch({
            query: blobQuery,
            ids: res.ids.map(String),
            truncated: res.truncated,
            engine: res.engine,
          });
        })
        .catch((error) => {
          if (blobSearchSeqRef.current !== seq) return;
          if (controller.signal.aborted) return;
          setBlobSearchError(
            error instanceof Error ? error.message : String(error),
          );
          setBlobSearch({
            query: blobQuery,
            ids: [],
            truncated: false,
            engine: "rg",
          });
        })
        .finally(() => {
          if (blobSearchSeqRef.current === seq) setBlobSearchLoading(false);
        });
    }, 250);

    return () => {
      controller.abort();
      clearTimeout(debounce);
    };
  }, [blobQuery]);

  const ensureBlob = async (logId: string, kind: BlobKind) => {
    if (!store) return;
    const key = `${logId}-${kind}`;
    if (blobBodies[key]) return;
    const existing = store.query<Array<{ body: string | null }>>({
      query: "SELECT body FROM blobs WHERE key = $key LIMIT 1",
      bindValues: { key },
    })[0];
    if (existing?.body) {
      setBlobBodies((prev) => ({ ...prev, [key]: existing.body ?? "" }));
      return;
    }
    setLoadingBlobs((prev) => ({ ...prev, [key]: true }));
    try {
      const blob = await fetchBlob(store, logId, kind);
      setBlobBodies((prev) => ({ ...prev, [key]: blob }));
    } finally {
      setLoadingBlobs((prev) => ({ ...prev, [key]: false }));
    }
  };

  // Get unique values for filters
  const availableModels = useMemo(() => {
    const models = new Set(logs.map((log) => log.model).filter(Boolean));
    return Array.from(models) as string[];
  }, [logs]);

  const availableProviders = useMemo(() => {
    const providers = new Set(logs.map((log) => log.provider).filter(Boolean));
    return Array.from(providers) as string[];
  }, [logs]);

  // Enhanced filtering with search query parsing
  const filteredLogs = useMemo(() => {
    let filtered = logs;
    const { terms, textParts } = parseSearchQuery(debouncedSearch);
    const blobIdSet =
      blobQuery && blobSearch?.query === blobQuery
        ? new Set(blobSearch.ids)
        : null;

    // Text search - now searches in blob content too (for FTS simulation)
    if (textParts.length) {
      const searchTerms = textParts.map((part) => part.toLowerCase());
      filtered = filtered.filter((log) => {
        const blobMatch = blobIdSet ? blobIdSet.has(log.id) : false;
        const metaMatch = searchTerms.some((term) =>
          [
            log.request_id,
            log.url,
            log.method,
            log.model ?? "",
            log.provider ?? "",
            log.summary ?? "",
          ]
            .filter(Boolean)
            .some((value) => String(value).toLowerCase().includes(term)),
        );
        return metaMatch || blobMatch;
      });
    }

    // Field-specific searches
    if (terms.status) {
      const statusRange = terms.status.match(/^(\d{3})$/);
      if (statusRange) {
        const statusCode = parseInt(statusRange[1]);
        filtered = filtered.filter((log) => log.status_code === statusCode);
      } else if (terms.status.includes("2")) {
        filtered = filtered.filter(
          (log) => log.status_code >= 200 && log.status_code < 300,
        );
      } else if (terms.status.includes("4") || terms.status.includes("5")) {
        filtered = filtered.filter((log) => log.status_code >= 400);
      }
    }

    if (terms.method) {
      filtered = filtered.filter(
        (log) => log.method.toLowerCase() === terms.method.toLowerCase(),
      );
    }

    if (terms.model) {
      filtered = filtered.filter((log) =>
        log.model?.toLowerCase().includes(terms.model.toLowerCase()),
      );
    }

    if (terms.provider) {
      filtered = filtered.filter((log) =>
        log.provider?.toLowerCase().includes(terms.provider.toLowerCase()),
      );
    }

    // Date/time filtering
    if (terms.timestamp) {
      const dateMatch = terms.timestamp.match(/^([><])(\d{4}-\d{2}-\d{2})$/);
      if (dateMatch) {
        const [, operator, dateStr] = dateMatch;
        const targetDate = new Date(dateStr);
        filtered = filtered.filter((log) => {
          const logDate = new Date(log.timestamp);
          if (operator === ">") {
            return logDate > targetDate;
          } else if (operator === "<") {
            return logDate < targetDate;
          }
          return true;
        });
      }
    }

    // Dropdown filters
    if (selectedModel) {
      filtered = filtered.filter((log) => log.model === selectedModel);
    }

    if (selectedProvider) {
      filtered = filtered.filter((log) => log.provider === selectedProvider);
    }

    if (selectedStatus === "success") {
      filtered = filtered.filter(
        (log) => log.status_code >= 200 && log.status_code < 300,
      );
    } else if (selectedStatus === "error") {
      filtered = filtered.filter((log) => log.status_code >= 400);
    }

    return filtered;
  }, [
    logs,
    debouncedSearch,
    selectedModel,
    selectedProvider,
    selectedStatus,
    blobQuery,
    blobSearch,
    parseSearchQuery,
  ]);

  const columns = useMemo<ColumnDef<LogDocType>[]>(
    () => [
      {
        header: "ID",
        accessorKey: "numeric_id",
        cell: (info) => info.getValue() as number,
      },
      {
        header: "When",
        accessorKey: "timestamp",
        cell: (info) => new Date(String(info.getValue())).toLocaleString(),
      },
      {
        header: "URL",
        accessorKey: "url",
      },
      {
        header: "Model",
        accessorKey: "model",
      },
      {
        header: "Status",
        accessorKey: "status_code",
      },
    ],
    [],
  );

  const table = useReactTable({
    data: filteredLogs,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  const rows = table.getRowModel().rows;
  const parentRef = useRef<HTMLDivElement | null>(null);
  const scrollSnapshotRef = useRef<{ id: string; offset: number } | null>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) =>
      rows[index]?.original.id === expandedId ? 520 : 120,
    overscan: 10,
    getItemKey: (index) => rows[index]?.original.id,
  });

  const virtualItems = virtualizer.getVirtualItems();

  useLayoutEffect(() => {
    if (!scrollSnapshotRef.current || !parentRef.current) return;

    const { id, offset } = scrollSnapshotRef.current;
    scrollSnapshotRef.current = null;

    const index = rows.findIndex((r) => r.original.id === id);
    if (index !== -1) {
      // Restore scroll position relative to the item
      const itemOffset = virtualizer.getOffsetForIndex(index);
      parentRef.current.scrollTop =
        ((itemOffset || 0) as number) - (offset as number);
    }
  }, [rows, virtualizer]);

  const manualRefresh = () => {
    void syncNow().catch((error) => {
      console.warn("Manual LiveStore sync failed", error);
    });
  };

  // Get search stats
  const getSearchStats = useMemo(() => {
    if (!search) return null;
    const { terms, textParts } = parseSearchQuery(search);
    const hasFieldSearch = Object.keys(terms).length > 0;
    const hasTextSearch = textParts.length > 0;

    return {
      total: logs.length,
      filtered: filteredLogs.length,
      hasFieldSearch,
      hasTextSearch,
      query: search,
      blobQuery,
    };
  }, [search, logs.length, filteredLogs.length, blobQuery, parseSearchQuery]);

  const searchStats = getSearchStats;

  return (
    <div className="app">
      <nav className="navbar">
        <div className="logo">LLM Logs</div>
        <div className="controls">
          <ThemeToggle />
          <SearchFilters
            ref={searchInputRef}
            search={search}
            onSearchChange={setSearch}
            selectedModel={selectedModel}
            onModelChange={setSelectedModel}
            selectedProvider={selectedProvider}
            onProviderChange={setSelectedProvider}
            selectedStatus={selectedStatus}
            onStatusChange={setSelectedStatus}
            models={availableModels}
            providers={availableProviders}
          />
          <button
            className={`btn ${autoRefresh ? "btn-primary" : ""}`}
            onClick={() => setAutoRefresh((v) => !v)}
            title={`${autoRefresh ? "Disable" : "Enable"} auto refresh (Ctrl+R)`}
          >
            {autoRefresh ? (
              <>
                <RefreshCw size={14} className="icon-spin" /> Auto Refresh: On
              </>
            ) : (
              <>
                <Pause size={14} /> Auto Refresh: Off
              </>
            )}
          </button>
          <button
            className="btn"
            onClick={manualRefresh}
            title="Manual refresh"
          >
            <RefreshCw size={14} /> Refresh now
          </button>
        </div>
      </nav>

      {/* Search Stats */}
      {searchStats && (
        <div className="search-stats">
          <span className="search-stats-text">
            Found {searchStats.filtered} of {searchStats.total} logs
            {searchStats.hasFieldSearch && " (field search)"}
            {searchStats.hasTextSearch && " (text search)"}
          </span>
          {searchStats.blobQuery && (
            <span className="search-stats-text muted">
              {blobSearchLoading && "Searching blobs…"}
              {!blobSearchLoading &&
                blobSearchError &&
                `Blob search: ${blobSearchError}`}
              {!blobSearchLoading &&
                !blobSearchError &&
                blobSearch?.engine &&
                `Blob search: ${blobSearch.engine}${
                  blobSearch.truncated ? " (truncated)" : ""
                }`}
            </span>
          )}
        </div>
      )}

      <div className="table-container" ref={parentRef}>
        <div
          style={{ height: virtualizer.getTotalSize(), position: "relative" }}
        >
          {virtualItems.map((virtualRow) => {
            const row = rows[virtualRow.index];
            if (!row) return null;
            const expanded = expandedId === row.original.id;
            const activeTab =
              tabState[row.original.id] ?? ("request" as BlobKind);
            return (
              <div
                key={row.id}
                ref={(node) => virtualizer.measureElement(node)}
                data-log-id={row.original.id}
                data-index={virtualRow.index}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                <LogRow
                  log={row.original}
                  expanded={expanded}
                  activeTab={activeTab}
                  onToggle={(id) =>
                    setExpandedId((prev) => (prev === id ? null : id))
                  }
                  onTabChange={(id, tab) =>
                    setTabState((prev) => ({ ...prev, [id]: tab }))
                  }
                  blobBody={blobBodies[`${row.original.id}-${activeTab}`]}
                  ensureBlob={ensureBlob}
                  loadingBlob={
                    !!loadingBlobs[`${row.original.id}-${activeTab}`]
                  }
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
