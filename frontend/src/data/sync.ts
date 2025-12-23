import type { LogsStore, LogDocType } from "./db";
import { events } from "./db";

const apiBase = import.meta.env.VITE_API_URL ?? window.location.origin;

export async function syncLogs(
  store: LogsStore,
  options: { batchSize?: number } = {},
): Promise<number> {
  const batchSize = options.batchSize ?? 200;
  // Always start from the latest (empty checkpoint) to catch new logs,
  // then work backwards.
  let checkpoint: { timestamp?: string; id?: number } = {};
  let synced = 0;

  for (;;) {
    const params = new URLSearchParams();
    if (checkpoint.timestamp) params.set("timestamp", checkpoint.timestamp);
    if (checkpoint.id !== undefined) params.set("id", String(checkpoint.id));
    params.set("limit", String(batchSize));

    const res = await fetch(
      `${apiBase}/api/livestore/pull?${params.toString()}`,
    );
    if (!res.ok) {
      throw new Error(`LiveStore pull failed (${res.status})`);
    }

    const payload = (await res.json()) as { items: LogDocType[] };
    if (!payload.items.length) break;

    // Optimization: If we already have all items in this batch, we've likely
    // connected with our local history, so we can stop.
    if (payload.items.length > 0) {
      const ids = payload.items.map((i) => `'${i.id}'`).join(",");
      const countRes = store.query<Array<{ count: number }>>({
        query: `SELECT COUNT(*) as count FROM logs WHERE id IN (${ids})`,
        bindValues: {},
      });
      if ((countRes[0]?.count ?? 0) === payload.items.length) {
        break;
      }
    }

    store.commit(
      { skipRefresh: true },
      ...payload.items.map((item) => events.logUpserted(item)),
    );
    store.manualRefresh({ label: "sync-logs" });

    checkpoint = {
      timestamp: payload.items[payload.items.length - 1]!.timestamp,
      id: payload.items[payload.items.length - 1]!.numeric_id,
    };
    synced += payload.items.length;

    if (payload.items.length < batchSize) break;
  }

  return synced;
}

function latestCheckpoint(store: LogsStore): {
  timestamp?: string;
  id?: number;
} {
  const rows = store.query<Array<{ timestamp: string; numeric_id: number }>>({
    query: `
      SELECT timestamp, numeric_id FROM logs
      ORDER BY timestamp DESC, numeric_id DESC
      LIMIT 1
    `,
    bindValues: {},
  });
  const latest = rows[0];
  if (!latest) return {};
  return { timestamp: latest.timestamp, id: latest.numeric_id };
}
