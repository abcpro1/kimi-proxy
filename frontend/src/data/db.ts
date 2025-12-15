import { makeInMemoryAdapter } from "@livestore/adapter-web";
import {
  Schema,
  State,
  createStorePromise,
  defineEvent,
  defineMaterializer,
  makeSchema,
  type Store,
} from "@livestore/livestore";

export interface LogDocType {
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

export interface BlobDocType {
  key: string;
  log_id: string;
  kind: string;
  etag: string | null;
  body: string | null;
  updated_at: string;
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

const blobsTable = State.SQLite.table({
  name: "blobs",
  columns: {
    key: State.SQLite.text({ primaryKey: true }),
    log_id: State.SQLite.text({}),
    kind: State.SQLite.text({}),
    etag: State.SQLite.text({ nullable: true }),
    body: State.SQLite.text({ nullable: true }),
    updated_at: State.SQLite.text({}),
  },
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

const blobCached = defineEvent({
  name: "blobs/cached",
  schema: Schema.Struct({
    key: Schema.String,
    log_id: Schema.String,
    kind: Schema.String,
    etag: Schema.NullOr(Schema.String),
    body: Schema.NullOr(Schema.String),
    updated_at: Schema.String,
  }),
});

const state = State.SQLite.makeState({
  tables: [logsTable, blobsTable],
  materializers: {
    [logUpserted.name]: defineMaterializer(
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
        bindValues: event,
      }),
    ),
    [blobCached.name]: defineMaterializer(
      blobCached,
      (event): { sql: string; bindValues: Record<string, unknown> } => ({
        sql: `
          INSERT OR REPLACE INTO blobs (
            key,
            log_id,
            kind,
            etag,
            body,
            updated_at
          ) VALUES (
            $key,
            $log_id,
            $kind,
            $etag,
            $body,
            $updated_at
          )
        `,
        bindValues: event,
      }),
    ),
  },
});

const schema = makeSchema({
  state,
  events: [logUpserted, blobCached],
});

export type LogsStore = Store<typeof schema>;
export const tables = { logs: logsTable, blobs: blobsTable };
export const events = { logUpserted, blobCached };

export async function createLogsStore(): Promise<LogsStore> {
  const adapter = makeInMemoryAdapter();
  return createStorePromise({
    schema,
    adapter,
    storeId: "ulx-logs-web",
    disableDevtools: true,
  });
}
