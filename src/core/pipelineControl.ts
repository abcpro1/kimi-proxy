import type { JsonValue } from "./types.js";

export const PIPELINE_MAX_ATTEMPTS_KEY = "__pipelineMaxAttempts";
export const PIPELINE_RETRY_FLAG_KEY = "__pipelineRetryRequested";
export const SYNTHETIC_RESPONSE_FLAG_KEY = "__syntheticResponseRequested";

const DEFAULT_MAX_ATTEMPTS = 1;
const MAX_ALLOWED_ATTEMPTS = 5;

export function resolvePipelineMaxAttempts(
  state: Record<string, JsonValue>,
): number {
  const normalized = normalizeAttempts(state[PIPELINE_MAX_ATTEMPTS_KEY]);
  return normalized ?? DEFAULT_MAX_ATTEMPTS;
}

export function setPipelineMaxAttempts(
  state: Record<string, JsonValue>,
  attempts: number,
): number {
  const normalized = normalizeAttempts(attempts) ?? DEFAULT_MAX_ATTEMPTS;
  state[PIPELINE_MAX_ATTEMPTS_KEY] = normalized;
  return normalized;
}

export function isRetryRequested(state: Record<string, JsonValue>): boolean {
  return state[PIPELINE_RETRY_FLAG_KEY] === true;
}

export function requestRetry(state: Record<string, JsonValue>): void {
  state[PIPELINE_RETRY_FLAG_KEY] = true;
}

export function clearRetryRequest(state: Record<string, JsonValue>): void {
  delete state[PIPELINE_RETRY_FLAG_KEY];
}

export function isSyntheticResponseRequested(
  state: Record<string, JsonValue>,
): boolean {
  return state[SYNTHETIC_RESPONSE_FLAG_KEY] === true;
}

export function requestSyntheticResponse(
  state: Record<string, JsonValue>,
): void {
  state[SYNTHETIC_RESPONSE_FLAG_KEY] = true;
}

export function clearSyntheticResponseRequest(
  state: Record<string, JsonValue>,
): void {
  delete state[SYNTHETIC_RESPONSE_FLAG_KEY];
}

function normalizeAttempts(value: unknown): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(numeric)) {
    return null;
  }
  const floored = Math.floor(numeric);
  if (floored < 1) {
    return null;
  }
  return Math.min(floored, MAX_ALLOWED_ATTEMPTS);
}
