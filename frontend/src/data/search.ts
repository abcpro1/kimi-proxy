const apiBase = import.meta.env.VITE_API_URL ?? window.location.origin;

export interface LogBlobSearchResponse {
  ids: number[];
  request_ids: string[];
  truncated: boolean;
  engine: "rg";
}

export async function searchLogBlobs(
  query: string,
  options: { signal?: AbortSignal; limit?: number; kinds?: string[] } = {},
): Promise<LogBlobSearchResponse> {
  const params = new URLSearchParams();
  params.set("q", query);
  if (options.limit) params.set("limit", String(options.limit));
  if (options.kinds?.length) params.set("kinds", options.kinds.join(","));

  const res = await fetch(`${apiBase}/api/logs/search?${params.toString()}`, {
    signal: options.signal,
  });
  if (!res.ok) {
    throw new Error(`Blob search failed (${res.status})`);
  }
  return (await res.json()) as LogBlobSearchResponse;
}
