import React, { useState } from "react";
import { Copy, Check, Icon } from "lucide-react";

interface CopyButtonProps {
  textToCopy: string;
  className?: string;
  label?: string;
  icon?: React.ReactNode;
  title?: string;
  onCopy?: () => void;
}

/**
 * Reusable copy button component with consistent UI effects
 * Shows feedback on copy success with checkmark icon
 */
export function CopyButton({
  textToCopy,
  className = "json-copy-btn",
  label,
  icon = <Copy size={14} />,
  title = "Copy to clipboard",
  onCopy,
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    try {
      await navigator.clipboard.writeText(textToCopy);
      setCopied(true);
      if (onCopy) onCopy();
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy to clipboard:", err);
    }
  };

  return (
    <button
      className={className}
      onClick={handleCopy}
      title={copied ? "Copied!" : title}
    >
      {copied ? <Check size={14} /> : icon}
      {label && <span>{copied ? "Copied!" : label}</span>}
    </button>
  );
}
