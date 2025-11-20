import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { logger } from "../utils/logger.js";
import type { JsonValue } from "../core/types.js";

export interface AppendLogInput {
  method: string;
  url: string;
  statusCode: number;
  model?: string;
  requestBody: JsonValue;
  responseBody: JsonValue;
  providerRequestBody?: JsonValue;
  providerResponseBody?: JsonValue;
}

export interface ListLogsQuery {
  page: number;
  pageSize: number;
  search?: string;
}

export interface LogRecord {
  id: number;
  timestamp: string;
  method: string;
  url: string;
  status_code: number;
  model: string | null;
  request_body: JsonValue;
  response_body: JsonValue;
  provider_request_body: JsonValue;
  provider_response_body: JsonValue;
}

export interface ListLogsResult {
  items: LogRecord[];
  total: number;
  page: number;
  pageSize: number;
}

interface LogRow {
  id: number;
  timestamp: string;
  method: string;
  url: string;
  status_code: number;
  model: string | null;
  request_body: string | null;
  response_body: string | null;
  provider_request_body: string | null;
  provider_response_body: string | null;
}

export class LogStore {
  private db: Database.Database;
  private insertStmt: Database.Statement;

  constructor(private readonly dbPath: string) {
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db
      .prepare(
        `
        CREATE TABLE IF NOT EXISTS request_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT DEFAULT (datetime('now')),
          method TEXT NOT NULL,
          url TEXT NOT NULL,
          status_code INTEGER NOT NULL,
          model TEXT,
          request_body TEXT,
          response_body TEXT,
          provider_request_body TEXT,
          provider_response_body TEXT
        )
      `,
      )
      .run();

    this.ensureColumn("provider_request_body");
    this.ensureColumn("provider_response_body");

    this.insertStmt = this.db.prepare(`
      INSERT INTO request_logs (timestamp, method, url, status_code, model, request_body, response_body, provider_request_body, provider_response_body)
      VALUES (@timestamp, @method, @url, @statusCode, @model, @requestBody, @responseBody, @providerRequestBody, @providerResponseBody)
    `);
  }

  append(entry: AppendLogInput) {
    try {
      this.insertStmt.run({
        timestamp: new Date().toISOString(),
        method: entry.method,
        url: entry.url,
        statusCode: entry.statusCode,
        model: entry.model ?? null,
        requestBody: JSON.stringify(entry.requestBody ?? null),
        responseBody: JSON.stringify(entry.responseBody ?? null),
        providerRequestBody: JSON.stringify(entry.providerRequestBody ?? null),
        providerResponseBody: JSON.stringify(
          entry.providerResponseBody ?? null,
        ),
      });
    } catch (error) {
      logger.error({ err: error }, "Failed to append log entry");
    }
  }

  list(query: ListLogsQuery): ListLogsResult {
    const page = Math.max(1, query.page);
    const pageSize = Math.max(1, Math.min(200, query.pageSize));
    const offset = (page - 1) * pageSize;

    const params: Record<string, string | number> = {};
    let whereClause = "";

    if (query.search) {
      whereClause = `WHERE method LIKE @search OR url LIKE @search OR model LIKE @search OR CAST(status_code AS TEXT) LIKE @search OR request_body LIKE @search OR response_body LIKE @search`;
      params.search = `%${query.search}%`;
    }

    const totalRow = this.db
      .prepare(`SELECT COUNT(*) as count FROM request_logs ${whereClause}`)
      .get(params) as { count?: number } | undefined;
    const total = totalRow?.count ?? 0;

    const rows = this.db
      .prepare(
        `
        SELECT * FROM request_logs
        ${whereClause}
        ORDER BY datetime(timestamp) DESC
        LIMIT @limit OFFSET @offset
      `,
      )
      .all({ ...params, limit: pageSize, offset }) as LogRow[];

    const items = rows.map((row) => ({
      id: row.id,
      timestamp: new Date(row.timestamp).toISOString(),
      method: row.method,
      url: row.url,
      status_code: row.status_code,
      model: row.model,
      request_body: safeJsonParse(row.request_body),
      response_body: safeJsonParse(row.response_body),
      provider_request_body: safeJsonParse(row.provider_request_body),
      provider_response_body: safeJsonParse(row.provider_response_body),
    }));

    return { items, total: Number(total) || 0, page, pageSize };
  }

  private ensureColumn(column: string) {
    const info = this.db
      .prepare(`PRAGMA table_info(request_logs)`)
      .all() as Array<{ name?: string }>;
    const hasColumn = info.some((entry) => entry.name === column);
    if (!hasColumn) {
      this.db
        .prepare(`ALTER TABLE request_logs ADD COLUMN ${column} TEXT`)
        .run();
    }
  }
}

function safeJsonParse(payload: string | null): JsonValue | null {
  if (!payload) {
    return null;
  }
  try {
    return JSON.parse(payload) as JsonValue;
  } catch {
    return payload;
  }
}
