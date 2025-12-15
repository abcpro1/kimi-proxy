import crypto from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { makeAdapter } from "@livestore/adapter-node";
import {
  Schema,
  State,
  createStorePromise,
  defineEvent,
  defineMaterializer,
  makeSchema,
  type Store,
} from "@livestore/livestore";
import type { HybridLogMetadata } from "../persistence/hybridLogStore.js";

export interface LiveLogDoc {
  id: string;
  numeric_id: number;
  request_id: string;
  timestamp: string;
  method: string;
  url: string;
  status_code: number;
  model: string | null;
  provider: string | null;
  profile: string | null;
  summary: string | null;
}

const logsTable = State.SQLite.table({
  name: "logs",
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    numeric_id: State.SQLite.integer({}),
    request_id: State.SQLite.text({}),
    timestamp: State.SQLite.text({}),
    method: State.SQLite.text({}),
    url: State.SQLite.text({}),
    status_code: State.SQLite.integer({}),
    model: State.SQLite.text({ nullable: true }),
    provider: State.SQLite.text({ nullable: true }),
    profile: State.SQLite.text({ nullable: true }),
    summary: State.SQLite.text({ nullable: true }),
  },
  indexes: [
    { name: "logs_timestamp", columns: ["timestamp"] },
    { name: "logs_status", columns: ["status_code"] },
    { name: "logs_model", columns: ["model"] },
  ],
});

const logUpserted = defineEvent({
  name: "logs/upserted",
  schema: Schema.Struct({
    id: Schema.String,
    numeric_id: Schema.Number,
    request_id: Schema.String,
    timestamp: Schema.String,
    method: Schema.String,
    url: Schema.String,
    status_code: Schema.Number,
    model: Schema.NullOr(Schema.String),
    provider: Schema.NullOr(Schema.String),
    profile: Schema.NullOr(Schema.String),
    summary: Schema.NullOr(Schema.String),
  }),
});

const logUpsertedMaterializer = defineMaterializer(
  logUpserted,
  (event): { sql: string; bindValues: Record<string, unknown> } => ({
    sql: `
      INSERT OR REPLACE INTO logs (
        id,
        numeric_id,
        request_id,
        timestamp,
        method,
        url,
        status_code,
        model,
        provider,
        profile,
        summary
      ) VALUES (
        $id,
        $numeric_id,
        $request_id,
        $timestamp,
        $method,
        $url,
        $status_code,
        $model,
        $provider,
        $profile,
        $summary
      )
    `,
    bindValues: {
      id: event.id,
      numeric_id: event.numeric_id,
      request_id: event.request_id,
      timestamp: event.timestamp,
      method: event.method,
      url: event.url,
      status_code: event.status_code,
      model: event.model,
      provider: event.provider,
      profile: event.profile,
      summary: event.summary,
    },
  }),
);

const state = State.SQLite.makeState({
  tables: [logsTable],
  materializers: {
    [logUpserted.name]: logUpsertedMaterializer,
  },
});

const schema = makeSchema({
  state,
  events: [logUpserted],
});

export interface LiveStoreRuntime {
  store: Store<typeof schema>;
  mirrorLog(log: HybridLogMetadata): Promise<void>;
  seedFromHybrid(
    logStore: {
      pullSince(
        checkpoint: { timestamp?: string; id?: number },
        limit: number,
      ): { items: HybridLogMetadata[] };
    },
    options?: { batchSize?: number },
  ): Promise<number>;
  pullSince(
    checkpoint: { timestamp?: string; id?: number },
    limit: number,
  ): Promise<LiveLogDoc[]>;
  latestCheckpoint(): Promise<{ timestamp: string; id: number } | undefined>;
  close(): Promise<void>;
}

function toLiveDoc(log: HybridLogMetadata): LiveLogDoc {
  return {
    id: String(log.id ?? log.request_id ?? crypto.randomUUID()),
    numeric_id: Number(log.id ?? 0),
    request_id: log.request_id,
    timestamp: log.timestamp,
    method: log.method,
    url: log.url,
    status_code: log.status_code,
    model: log.model ?? null,
    provider: log.provider ?? null,
    profile: log.profile ?? null,
    summary: log.summary ?? null,
  };
}

export async function createLiveStoreRuntime(options: {
  storageDir: string;
  storeId?: string;
}): Promise<LiveStoreRuntime> {
  const baseDir = path.resolve(options.storageDir);
  await mkdir(baseDir, { recursive: true });

  const adapter = makeAdapter({
    storage: { type: "fs", baseDirectory: baseDir },
  });

  const store = await createStorePromise({
    schema,
    adapter,
    storeId: options.storeId ?? "logs",
  });

  return {
    store,
    async mirrorLog(log: HybridLogMetadata) {
      store.commit(logUpserted(toLiveDoc(log)));
    },
    async seedFromHybrid(logStore, options = {}) {
      const batchSize = options.batchSize ?? 500;
      let checkpoint: { timestamp?: string; id?: number } = {};
      let total = 0;

      // Seed in small batches to avoid blocking the event loop during startup
      // and to keep LiveStore refresh work manageable.
      while (true) {
        const { items } = logStore.pullSince(checkpoint, batchSize);
        if (!items.length) break;

        store.commit(
          { skipRefresh: true },
          ...items.map((item) => logUpserted(toLiveDoc(item))),
        );
        store.manualRefresh({ label: "seed-from-hybrid" });

        checkpoint = {
          timestamp: items[items.length - 1]!.timestamp,
          id: items[items.length - 1]!.id,
        };
        total += items.length;
      }

      return total;
    },
    async pullSince(checkpoint, limit) {
      const clauses: string[] = [];
      const params: Record<string, string | number | null> = { limit };
      if (checkpoint.timestamp) {
        clauses.push(
          "(timestamp > $ts OR (timestamp = $ts AND numeric_id > $id))",
        );
        params.ts = checkpoint.timestamp;
        params.id = checkpoint.id ?? 0;
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = store.query<LiveLogDoc[]>({
        query: `
          SELECT * FROM logs
          ${where}
          ORDER BY timestamp, numeric_id
          LIMIT $limit
        `,
        bindValues: params,
      });
      return rows;
    },
    async latestCheckpoint() {
      const rows = store.query<
        Array<{ timestamp: string; numeric_id: number }>
      >({
        query: `
          SELECT timestamp, numeric_id FROM logs
          ORDER BY timestamp DESC, numeric_id DESC
          LIMIT 1
        `,
        bindValues: {},
      });
      const latest = rows[0];
      if (!latest) return undefined;
      return { timestamp: latest.timestamp, id: latest.numeric_id };
    },
    async close() {
      await store.shutdown();
    },
  };
}
