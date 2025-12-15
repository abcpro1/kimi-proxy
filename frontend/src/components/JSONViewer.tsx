import React, { useState } from "react";
import { JSONTree } from "react-json-tree";
import { useThemeStore } from "../store/themeStore";

interface JSONViewerProps {
  data: unknown;
}

// Theme definitions for JSON tree
const lightTheme = {
  scheme: "light",
  author: "chris kempson (http://chriskempson.com)",
  base00: "#ffffff",
  base01: "#e0e0e0",
  base02: "#d0d0d0",
  base03: "#b0b0b0",
  base04: "#000000",
  base05: "#101010",
  base06: "#202020",
  base07: "#303030",
  base08: "#ac4142",
  base09: "#d28445",
  base0A: "#f4bf75",
  base0B: "#90a959",
  base0C: "#75b5aa",
  base0D: "#6a9fb5",
  base0E: "#aa759f",
  base0F: "#8f5536",
};

const darkTheme = {
  scheme: "monokai",
  author: "wimer hazenberg (http://www.monokai.nl)",
  base00: "#272822",
  base01: "#383830",
  base02: "#49483e",
  base03: "#75715e",
  base04: "#a59f85",
  base05: "#f8f8f2",
  base06: "#f5f4f1",
  base07: "#f9f8f5",
  base08: "#f92672",
  base09: "#fd971f",
  base0A: "#f4bf75",
  base0B: "#a6e22e",
  base0C: "#a1efe4",
  base0D: "#66d9ef",
  base0E: "#ae81ff",
  base0F: "#cc6633",
};

const JSONViewer = ({ data }: JSONViewerProps) => {
  const [copied, setCopied] = useState(false);
  const { resolvedTheme } = useThemeStore();

  const keyCount =
    data != null && typeof data === "object" ? Object.keys(data).length : null;

  const handleCopy = async () => {
    try {
      const text = JSON.stringify(data, null, 2);
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy to clipboard:", err);
    }
  };

  const isDark = resolvedTheme === "dark";
  const theme = isDark ? darkTheme : lightTheme;

  return (
    <div className="json-viewer-wrapper">
      <div className="json-viewer-header">
        <div className="json-viewer-title">
          <span>JSON Data</span>
          {keyCount != null && (
            <span className="json-meta">
              {keyCount} {keyCount === 1 ? "key" : "keys"}
            </span>
          )}
        </div>
        <div className="json-viewer-actions">
          <button
            className="json-copy-btn"
            onClick={handleCopy}
            title={copied ? "Copied!" : "Copy to clipboard"}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              {copied ? (
                <>
                  <polyline points="20 6 9 17 4 12"></polyline>
                </>
              ) : (
                <>
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </>
              )}
            </svg>
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
      </div>
      <div className="json-tree-container">
        <JSONTree
          data={data}
          theme={theme}
          invertTheme={false}
          shouldExpandNodeInitially={(keyPath, data, level) => level !== 2}
          hideRoot={false}
          getItemString={(
            type: string,
            data: unknown,
            itemType: React.ReactNode,
            itemString: string,
          ) => (
            <span className="json-item-string">
              {itemType} {itemString}
            </span>
          )}
          valueRenderer={(raw: unknown) => {
            const text =
              typeof raw === "string"
                ? `"${raw}"`
                : raw === null ||
                    typeof raw === "number" ||
                    typeof raw === "boolean" ||
                    typeof raw === "bigint"
                  ? String(raw)
                  : (() => {
                      try {
                        return JSON.stringify(raw) ?? String(raw);
                      } catch {
                        return String(raw);
                      }
                    })();

            return <span className="json-value">{text}</span>;
          }}
          labelRenderer={(raw: readonly (string | number)[]) => (
            <span className="json-label">{raw[0]}</span>
          )}
        />
      </div>
    </div>
  );
};

export default JSONViewer;
