import type { LogsStore } from "./db";
import { events } from "./db";

const apiBase = import.meta.env.VITE_API_URL ?? "";

export async function fetchBlob(
  store: LogsStore,
  logId: string,
  kind: "request" | "response" | "provider-request" | "provider-response",
): Promise<string> {
  const key = `${logId}-${kind}`;
  const existing = store.query<
    Array<{ etag: string | null; body: string | null }>
  >({
    query: "SELECT etag, body FROM blobs WHERE key = $key LIMIT 1",
    bindValues: { key },
  })[0];

  const headers: Record<string, string> = {};
  if (existing?.etag) headers["If-None-Match"] = existing.etag;

  const res = await fetch(`${apiBase}/api/logs/${logId}/blobs/${kind}`, {
    headers,
  });

  if (res.status === 304 && existing) {
    return existing.body ?? "";
  }

  if (!res.ok) {
    throw new Error(`Blob fetch failed (${res.status})`);
  }

  const text = await res.text();
  const etag = res.headers.get("etag") ?? null;

  store.commit(
    events.blobCached({
      key,
      log_id: String(logId),
      kind,
      etag,
      body: text,
      updated_at: new Date().toISOString(),
    }),
  );

  return text;
}
