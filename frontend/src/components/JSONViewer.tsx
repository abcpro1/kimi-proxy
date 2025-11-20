import React, { useState } from "react";
import { JSONTree } from "react-json-tree";

interface JSONViewerProps {
  data: any;
}

const JSONViewer = ({ data }: JSONViewerProps) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    const text = JSON.stringify(data, null, 2);
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  // Monokai based theme
  const theme = {
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

  return (
    <div className="json-viewer-wrapper" style={{ position: "relative" }}>
      <div
        style={{
          position: "absolute",
          top: "0.5rem",
          right: "0.5rem",
          zIndex: 10,
        }}
      >
        <button
          className="btn"
          onClick={handleCopy}
          title="Copy to clipboard"
          style={{
            padding: "0.25rem 0.5rem",
            fontSize: "0.75rem",
            backgroundColor: "rgba(255,255,255,0.1)",
            color: "#fff",
            border: "1px solid rgba(255,255,255,0.2)",
          }}
        >
          {copied ? (
            <i className="fas fa-check"></i>
          ) : (
            <i className="fas fa-copy"></i>
          )}
          {copied ? " Copied" : " Copy"}
        </button>
      </div>
      <div
        style={{
          backgroundColor: "#272822",
          padding: "1rem",
          overflowX: "auto",
          overflowY: "auto",
          maxHeight: "70vh",
          fontFamily: "monospace",
          fontSize: "14px",
        }}
      >
        <JSONTree
          data={data}
          theme={theme}
          invertTheme={false}
          shouldExpandNodeInitially={() => true}
          hideRoot={false}
          getItemString={(
            type: string,
            data: unknown,
            itemType: React.ReactNode,
            itemString: string,
          ) => (
            <span>
              {itemType} {itemString}
            </span>
          )}
        />
      </div>
    </div>
  );
};

export default JSONViewer;
