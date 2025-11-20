import React, { useState, useEffect, Suspense, useCallback } from "react";
import { useUIStore } from "./store/uiStore";

// Lazy load the heavy JSON viewer component
const JSONViewer = React.lazy(() => import("./components/JSONViewer"));

interface RequestLog {
  id: number;
  timestamp: string;
  method: string;
  url: string;
  status_code: number;
  model?: string;
  request_body: any;
  response_body: any;
  provider_request_body?: any;
  provider_response_body?: any;
}

interface StatusBadgeProps {
  status: number;
}

const StatusBadge = React.memo(({ status }: StatusBadgeProps) => {
  const isSuccess = status >= 200 && status < 300;
  return (
    <span className={`badge ${isSuccess ? "badge-success" : "badge-error"}`}>
      {status}
    </span>
  );
});

interface Tab {
  label: string;
  content: React.ReactNode;
}

interface TabbedPaneProps {
  tabs: Tab[];
  storageKey: string;
}

const TabbedPane = ({ tabs, storageKey }: TabbedPaneProps) => {
  const activeTab = useUIStore(
    useCallback((state) => state.tabStates[storageKey] || 0, [storageKey]),
  );
  const setTabState = useUIStore(useCallback((state) => state.setTabState, []));

  return (
    <div className="tabbed-pane">
      <div className="tabs-header">
        {tabs.map((tab, index) => (
          <button
            key={index}
            className={`tab-btn ${activeTab === index ? "active" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              setTabState(storageKey, index);
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="tab-content">{tabs[activeTab].content}</div>
    </div>
  );
};

interface LogRowProps {
  log: RequestLog;
  expanded: boolean;
  onToggle: (id: number) => void;
}

const LogRow = React.memo(({ log, expanded, onToggle }: LogRowProps) => {
  return (
    <React.Fragment>
      <tr className="log-row" onClick={() => onToggle(log.id)}>
        <td>{log.id}</td>
        <td>{new Date(log.timestamp).toLocaleString()}</td>
        <td>
          <span className="method-badge">{log.method}</span>
        </td>
        <td>{log.url}</td>
        <td>{log.model || "-"}</td>
        <td>
          <StatusBadge status={log.status_code} />
        </td>
        <td>
          <i className={`fas fa-chevron-${expanded ? "up" : "down"}`}></i>
        </td>
      </tr>
      <tr className="detail-row">
        <td colSpan={7}>
          <div className={`expand-wrapper ${expanded ? "open" : ""}`}>
            <div className="expand-inner">
              <div className="detail-content">
                {expanded && (
                  <Suspense
                    fallback={
                      <div style={{ padding: "1rem", textAlign: "center" }}>
                        Loading viewer...
                      </div>
                    }
                  >
                    <div
                      className="detail-grid"
                      style={{
                        gridTemplateColumns:
                          "repeat(auto-fit, minmax(500px, 1fr))",
                      }}
                    >
                      {/* Request Column */}
                      <div className="detail-col" style={{ minWidth: 0 }}>
                        <TabbedPane
                          storageKey={`log-${log.id}-request`}
                          tabs={[
                            {
                              label: "Original Request",
                              content: <JSONViewer data={log.request_body} />,
                            },
                            {
                              label: "Provider Request",
                              content: log.provider_request_body ? (
                                <JSONViewer data={log.provider_request_body} />
                              ) : (
                                <div
                                  style={{
                                    padding: "2rem",
                                    textAlign: "center",
                                    color: "var(--text-color)",
                                    opacity: 0.5,
                                  }}
                                >
                                  <i
                                    className="fas fa-ban"
                                    style={{
                                      marginBottom: "0.5rem",
                                      display: "block",
                                      fontSize: "1.5rem",
                                    }}
                                  ></i>
                                  Not available
                                </div>
                              ),
                            },
                          ]}
                        />
                      </div>

                      {/* Response Column */}
                      <div className="detail-col" style={{ minWidth: 0 }}>
                        <TabbedPane
                          storageKey={`log-${log.id}-response`}
                          tabs={[
                            {
                              label: "Provider Response",
                              content: log.provider_response_body ? (
                                <JSONViewer data={log.provider_response_body} />
                              ) : (
                                <div
                                  style={{
                                    padding: "2rem",
                                    textAlign: "center",
                                    color: "var(--text-color)",
                                    opacity: 0.5,
                                  }}
                                >
                                  <i
                                    className="fas fa-ban"
                                    style={{
                                      marginBottom: "0.5rem",
                                      display: "block",
                                      fontSize: "1.5rem",
                                    }}
                                  ></i>
                                  Not available
                                </div>
                              ),
                            },
                            {
                              label: "Client Response",
                              content: <JSONViewer data={log.response_body} />,
                            },
                          ]}
                        />
                      </div>
                    </div>
                  </Suspense>
                )}
              </div>
            </div>
          </div>
        </td>
      </tr>
    </React.Fragment>
  );
});

const Dashboard = () => {
  const [logs, setLogs] = useState<RequestLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const { expandedLogId, setExpandedLogId } = useUIStore();
  const [theme, setTheme] = useState<string | null>(null);

  // Pagination & Search State
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  const pageSize = 20;

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1); // Reset to page 1 on search change
    }, 500);
    return () => clearTimeout(timer);
  }, [search]);

  const fetchLogs = async () => {
    // Only set loading if not auto-refreshing to avoid UI flicker
    if (!autoRefresh) setLoading(true);

    try {
      const queryParams = new URLSearchParams({
        page: page.toString(),
        page_size: pageSize.toString(),
      });

      if (debouncedSearch) {
        queryParams.append("search", debouncedSearch);
      }

      const res = await fetch(`/api/logs?${queryParams.toString()}`);
      const data = await res.json();

      setLogs((prevLogs) => {
        // Simple deep check to avoid re-renders if data is identical
        if (JSON.stringify(prevLogs) === JSON.stringify(data.items)) {
          return prevLogs;
        }
        return data.items;
      });
      setTotal(data.total);
    } catch (err) {
      console.error("Failed to fetch logs", err);
    } finally {
      setLoading(false);
    }
  };

  // Initial load & updates
  useEffect(() => {
    fetchLogs();
  }, [page, debouncedSearch]);

  // Auto refresh interval
  useEffect(() => {
    let interval: any;
    if (autoRefresh) {
      interval = setInterval(fetchLogs, 2000);
    }
    return () => clearInterval(interval);
  }, [autoRefresh, page, debouncedSearch]); // Depend on current view state

  // Theme toggle
  useEffect(() => {
    if (theme) {
      document.documentElement.setAttribute("data-theme", theme);
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
  }, [theme]);

  const toggleTheme = () => {
    setTheme((prev: string | null) => {
      if (prev) {
        return prev === "light" ? "dark" : "light";
      }
      // If system, toggle to opposite of system
      const isSystemDark = window.matchMedia
        ? window.matchMedia("(prefers-color-scheme: dark)").matches
        : false;
      return isSystemDark ? "light" : "dark";
    });
  };

  // Memoize toggleExpand to prevent unnecessary re-renders of rows
  const toggleExpand = useCallback(
    (id: number) => {
      setExpandedLogId(expandedLogId === id ? null : id);
    },
    [expandedLogId, setExpandedLogId],
  );

  const totalPages = Math.ceil(total / pageSize);

  return (
    <div>
      <nav className="navbar">
        <div className="logo">
          <i className="fas fa-brain" style={{ marginRight: "10px" }}></i>
          LLM API Logs
        </div>
        <div style={{ flexGrow: 1 }}></div>
        <input
          type="search"
          className="search-box"
          placeholder="Search logs..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="controls" style={{ marginBottom: 0 }}>
          <button className="btn" onClick={() => setAutoRefresh(!autoRefresh)}>
            {autoRefresh ? (
              <span>
                <i className="fas fa-sync spin"></i> Auto-Refresh On
              </span>
            ) : (
              <span>
                <i className="fas fa-sync"></i> Auto-Refresh Off
              </span>
            )}
          </button>
          <button className="btn" onClick={fetchLogs}>
            <i className={`fas fa-redo ${loading ? "spin" : ""}`}></i> Refresh
          </button>
          <button className="btn" onClick={toggleTheme}>
            <i className="fas fa-moon theme-icon-moon"></i>
            <i className="fas fa-sun theme-icon-sun"></i>
          </button>
        </div>
      </nav>

      <div className="container">
        <div className="card">
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Timestamp</th>
                  <th>Method</th>
                  <th>URL</th>
                  <th>Model</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log: RequestLog) => (
                  <LogRow
                    key={log.id}
                    log={log}
                    expanded={expandedLogId === log.id}
                    onToggle={toggleExpand}
                  />
                ))}
                {logs.length === 0 && !loading && (
                  <tr>
                    <td
                      colSpan={7}
                      style={{ textAlign: "center", padding: "2rem" }}
                    >
                      No logs found.
                    </td>
                  </tr>
                )}
                {loading && logs.length === 0 && (
                  <tr>
                    <td
                      colSpan={7}
                      style={{ textAlign: "center", padding: "2rem" }}
                    >
                      Loading...
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="pagination">
          <button
            className="btn"
            disabled={page === 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            &larr; Previous
          </button>
          <span>
            Page {page} of {totalPages || 1} (Total: {total})
          </span>
          <button
            className="btn"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next &rarr;
          </button>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
