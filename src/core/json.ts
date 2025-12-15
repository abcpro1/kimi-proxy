import type { JsonObject, JsonValue } from "./types.js";

export function safeJsonString(value: unknown): string {
  if (typeof value === "string") {
    try {
      JSON.parse(value);
      return value;
    } catch {
      return JSON.stringify({ _raw: value });
    }
  }

  if (value === undefined || value === null) return "{}";

  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ _raw: String(value) });
  }
}

export function safeJsonParseObject(value: string | undefined): JsonObject {
  const raw = typeof value === "string" ? value : "";
  if (!raw.trim()) return {};

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as JsonObject;
    }
    return { _raw: parsed as JsonValue };
  } catch {
    return { _raw: raw };
  }
}
