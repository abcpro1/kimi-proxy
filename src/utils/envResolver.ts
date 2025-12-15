import { JsonValue, JsonObject } from "../core/types.js";

function parseEnvVarReference(
  value: string,
): { name: string; suffix: string } | null {
  if (!value.startsWith("$")) return null;

  const match = value.slice(1).match(/^([A-Za-z_][A-Za-z0-9_]*)(.*)$/);
  if (!match?.[1]) return null;

  return { name: match[1], suffix: match[2] ?? "" };
}

/**
 * Resolves environment variable references in a value.
 * Supports:
 * - Simple reference: "$VAR_NAME" -> value of VAR_NAME
 * - Prefix reference: "$VAR_NAME/suffix" -> "value/suffix" (suffix can be any string)
 * - No reference: "value" -> "value"
 *
 * @param value The value to resolve
 * @returns The resolved value
 */
export function resolveEnvVar(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const ref = parseEnvVarReference(value);
  if (!ref) return value;

  const envValue = process.env[ref.name];
  if (envValue === undefined) {
    throw new Error(`Environment variable ${ref.name} is not set`);
  }

  return `${envValue}${ref.suffix}`;

  // NOTE: Any further string interpolation is intentionally unsupported.
}

/**
 * Recursively resolves environment variable references in an object.
 * Handles nested objects and arrays.
 *
 * @param obj The object to resolve
 * @returns A new object with environment variables resolved
 */
export function resolveEnvVarsDeep(obj: unknown): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === "string") {
    return resolveEnvVar(obj);
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => resolveEnvVarsDeep(item));
  }

  if (typeof obj === "object") {
    const resolved: JsonObject = {};
    for (const [key, value] of Object.entries(obj as JsonObject)) {
      resolved[key] = resolveEnvVarsDeep(value) as JsonValue;
    }
    return resolved;
  }

  return obj;
}

/**
 * Checks if a value contains an environment variable reference.
 *
 * @param value The value to check
 * @returns True if the value contains an environment variable reference
 */
export function hasEnvVarReference(value: unknown): boolean {
  if (typeof value === "string") {
    return parseEnvVarReference(value) !== null;
  }
  return false;
}
