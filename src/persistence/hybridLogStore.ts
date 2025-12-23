import { Database, type Statement } from "bun:sqlite";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { logger } from "../utils/logger.js";
import type { JsonValue } from "../core/types.js";

export type LogBlobKind =
  | "request"
  | "response"
  | "provider-request"
  | "provider-response";

export interface HybridLogMetadata {
  id: number;
  request_id: string;
  timestamp: string;
  method: string;
  url: string;
  status_code: number;
  model?: string | null;
  provider?: string | null;
  profile?: string | null;
  operation?: string | null;
  client_format?: string | null;
  provider_format?: string | null;
  latency_ms?: number | null;
  request_path?: string | null;
  response_path?: string | null;
  provider_request_path?: string | null;
  provider_response_path?: string | null;
  request_sha256?: string | null;
  response_sha256?: string | null;
  provider_request_sha256?: string | null;
  provider_response_sha256?: string | null;
  blob_bytes?: number | null;
  summary?: string | null;
}

export interface HybridLogListQuery {
  page: number;
  pageSize: number;
  search?: string;
  from?: string;
  to?: string;
}

export interface HybridLogListResult {
  items: HybridLogMetadata[];
  total: number;
  page: number;
  pageSize: number;
}

export interface HybridLogAppendInput {
  requestId: string;
  method: string;
  url: string;
  statusCode: number;
  model?: string;
  provider?: string;
  profile?: string;
  operation?: string;
  clientFormat?: string;
  providerFormat?: string;
  startedAt?: number;
  finishedAt?: number;
  requestBody: JsonValue;
  responseBody: JsonValue;
  providerRequestBody?: JsonValue;
  providerResponseBody?: JsonValue;
  summary?: string;
}

type InsertableLogRow = HybridLogMetadata;

export class HybridLogStore {
  private db: Database;
  private insertStmt: Statement<InsertableLogRow>;

  constructor(
    private readonly dbPath: string,
    private readonly blobRoot: string,
  ) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    mkdirSync(blobRoot, { recursive: true });

    this.db = new Database(dbPath, { create: true, strict: true });
    this.db.prepare("PRAGMA journal_mode = WAL").get();
    this.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          request_id TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          method TEXT NOT NULL,
          url TEXT NOT NULL,
          status_code INTEGER NOT NULL,
          model TEXT,
          provider TEXT,
          profile TEXT,
          operation TEXT,
          client_format TEXT,
          provider_format TEXT,
          latency_ms INTEGER,
          request_path TEXT,
          response_path TEXT,
          provider_request_path TEXT,
          provider_response_path TEXT,
          request_sha256 TEXT,
          response_sha256 TEXT,
          provider_request_sha256 TEXT,
          provider_response_sha256 TEXT,
          blob_bytes INTEGER,
          summary TEXT
        )`,
      )
      .run();

    this.db
      .prepare(
        `CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp DESC)`,
      )
      .run();
    this.db
      .prepare(
        `CREATE INDEX IF NOT EXISTS idx_logs_status ON logs(status_code)`,
      )
      .run();
    this.db
      .prepare(`CREATE INDEX IF NOT EXISTS idx_logs_model ON logs(model)`)
      .run();

    this.insertStmt = this.db.prepare(`
      INSERT INTO logs (
        request_id,
        timestamp,
        method,
        url,
        status_code,
        model,
        provider,
        profile,
        operation,
        client_format,
        provider_format,
        latency_ms,
        request_path,
        response_path,
        provider_request_path,
        provider_response_path,
        request_sha256,
        response_sha256,
        provider_request_sha256,
        provider_response_sha256,
        blob_bytes,
        summary
      ) VALUES (
        @request_id,
        @timestamp,
        @method,
        @url,
        @status_code,
        @model,
        @provider,
        @profile,
        @operation,
        @client_format,
        @provider_format,
        @latency_ms,
        @request_path,
        @response_path,
        @provider_request_path,
        @provider_response_path,
        @request_sha256,
        @response_sha256,
        @provider_request_sha256,
        @provider_response_sha256,
        @blob_bytes,
        @summary
      )
    `);
  }

  append(input: HybridLogAppendInput): HybridLogMetadata | undefined {
    try {
      const timestamp = new Date().toISOString();
      const dir = this.resolveBlobDir(timestamp, input.requestId);
      const record = this.writeBlobs(dir, {
        request: input.requestBody,
        response: input.responseBody,
        providerRequest: input.providerRequestBody,
        providerResponse: input.providerResponseBody,
      });

      const latency =
        input.startedAt && input.finishedAt
          ? Math.max(0, input.finishedAt - input.startedAt)
          : null;

      const row: InsertableLogRow = {
        id: 0,
        request_id: input.requestId,
        timestamp,
        method: input.method,
        url: input.url,
        status_code: input.statusCode,
        model: input.model,
        provider: input.provider,
        profile: input.profile,
        operation: input.operation,
        client_format: input.clientFormat,
        provider_format: input.providerFormat,
        latency_ms: latency,
        request_path: record.request.path,
        response_path: record.response.path,
        provider_request_path: record.providerRequest?.path,
        provider_response_path: record.providerResponse?.path,
        request_sha256: record.request.hash,
        response_sha256: record.response.hash,
        provider_request_sha256: record.providerRequest?.hash,
        provider_response_sha256: record.providerResponse?.hash,
        blob_bytes: record.totalBytes,
        summary: input.summary,
      };

      const result = this.insertStmt.run(row);
      return { ...row, id: Number(result.lastInsertRowid) };
    } catch (error) {
      logger.error({ err: error }, "Failed to append hybrid log entry");
      return undefined;
    }
  }

  list(query: HybridLogListQuery): HybridLogListResult {
    const page = Math.max(1, query.page);
    const pageSize = Math.min(200, Math.max(1, query.pageSize));
    const offset = (page - 1) * pageSize;

    const clauses: string[] = [];
    const params: Record<string, unknown> = { limit: pageSize, offset };

    if (query.search) {
      clauses.push(
        `(method LIKE @search OR url LIKE @search OR model LIKE @search OR provider LIKE @search OR client_format LIKE @search OR provider_format LIKE @search)`,
      );
      params.search = `%${query.search}%`;
    }

    if (query.from) {
      clauses.push(`timestamp >= @from`);
      params.from = query.from;
    }

    if (query.to) {
      clauses.push(`timestamp <= @to`);
      params.to = query.to;
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    const totalRow = this.db
      .prepare(`SELECT COUNT(*) as count FROM logs ${where}`)
      .get(params as never) as { count?: number } | undefined;

    const rows = this.db
      .prepare(
        `SELECT * FROM logs ${where} ORDER BY timestamp DESC, id DESC LIMIT @limit OFFSET @offset`,
      )
      .all(params as never) as HybridLogMetadata[];

    return { items: rows, total: Number(totalRow?.count ?? 0), page, pageSize };
  }

  latestCheckpoint(): { timestamp: string; id: number } | undefined {
    const row = this.db
      .prepare(
        "SELECT id, timestamp FROM logs ORDER BY datetime(timestamp) DESC LIMIT 1",
      )
      .get() as { id?: number; timestamp?: string } | undefined;
    if (!row?.id || !row.timestamp) return undefined;
    return { id: row.id, timestamp: row.timestamp };
  }

  pullSince(
    checkpoint: { timestamp?: string; id?: number },
    limit: number,
  ): HybridLogListResult {
    const clauses: string[] = [];
    const params: Record<string, unknown> = { limit };
    if (checkpoint.timestamp) {
      clauses.push(`(timestamp < @ts OR (timestamp = @ts AND id < @id))`);
      params.ts = checkpoint.timestamp;
      params.id = checkpoint.id ?? Number.MAX_SAFE_INTEGER;
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT * FROM logs ${where} ORDER BY datetime(timestamp) DESC, id DESC LIMIT @limit`,
      )
      .all(params as never) as HybridLogMetadata[];
    return { items: rows, total: rows.length, page: 1, pageSize: rows.length };
  }

  resolveBlobPath(record: HybridLogMetadata, kind: LogBlobKind): string | null {
    const mapping: Record<LogBlobKind, string | null | undefined> = {
      request: record.request_path,
      response: record.response_path,
      "provider-request": record.provider_request_path,
      "provider-response": record.provider_response_path,
    };
    const resolved = mapping[kind];
    if (!resolved) return null;
    const full = path.isAbsolute(resolved)
      ? resolved
      : path.join(this.blobRoot, resolved);
    return existsSync(full) ? full : null;
  }

  readMetadata(id: number): HybridLogMetadata | undefined {
    const row = this.db
      .prepare("SELECT * FROM logs WHERE id = @id")
      .get({ id }) as HybridLogMetadata | undefined;
    return row;
  }

  findIdsByRequestIds(requestIds: string[]): number[] {
    if (!requestIds.length) return [];
    const ids: number[] = [];
    const chunkSize = 900;
    for (let offset = 0; offset < requestIds.length; offset += chunkSize) {
      const chunk = requestIds.slice(offset, offset + chunkSize);
      const params: Record<string, string> = {};
      const placeholders = chunk
        .map((requestId, index) => {
          const key = `id${index}`;
          params[key] = requestId;
          return `@${key}`;
        })
        .join(", ");
      const rows = this.db
        .prepare(`SELECT id FROM logs WHERE request_id IN (${placeholders})`)
        .all(params as never) as Array<{ id: number }>;
      ids.push(...rows.map((row) => Number(row.id)));
    }
    return ids;
  }

  private resolveBlobDir(timestamp: string, requestId: string): string {
    const date = new Date(timestamp);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    return path.join(this.blobRoot, `${year}`, `${month}`, `${day}`, requestId);
  }

  private writeBlobs(
    dir: string,
    payloads: {
      request: JsonValue;
      response: JsonValue;
      providerRequest?: JsonValue;
      providerResponse?: JsonValue;
    },
  ) {
    mkdirSync(dir, { recursive: true });

    const write = (
      filename: string,
      content: JsonValue | undefined,
    ): { path: string; hash: string; bytes: number } => {
      const serialized = JSON.stringify(content ?? null, null, 2);
      const fullPath = path.join(dir, filename);
      writeFileSync(fullPath, serialized);
      const hash = createHash("sha256").update(serialized).digest("hex");
      return {
        path: path.relative(this.blobRoot, fullPath),
        hash,
        bytes: Buffer.byteLength(serialized),
      };
    };

    const request = write("request.json", payloads.request);
    const response = write("response.json", payloads.response);
    const providerRequest = payloads.providerRequest
      ? write("provider-request.json", payloads.providerRequest)
      : undefined;
    const providerResponse = payloads.providerResponse
      ? write("provider-response.json", payloads.providerResponse)
      : undefined;

    const totalBytes =
      request.bytes +
      response.bytes +
      (providerRequest?.bytes ?? 0) +
      (providerResponse?.bytes ?? 0);

    return { request, response, providerRequest, providerResponse, totalBytes };
  }
}

export function readBlobFile(pathname: string): string {
  return readFileSync(pathname, "utf-8");
}
