import { Database } from "bun:sqlite";
import path from "node:path";
import { loadConfig } from "../config.js";
import { HybridLogStore } from "./hybridLogStore.js";
import type { JsonValue } from "../core/types.js";
import { logger } from "../utils/logger.js";
import { createLiveStoreRuntime } from "../livestore/runtime.js";

function safeParse(value: string | null): JsonValue {
  if (!value) return null;
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return value;
  }
}

async function migrate() {
  const config = loadConfig();
  const dbPath = config.logging.dbPath;
  const legacy = new Database(dbPath);
  const hasLegacyTable = legacy
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='request_logs'",
    )
    .get() as { name?: string } | undefined;

  if (!hasLegacyTable) {
    logger.info("No legacy request_logs table detected; skipping migration");
    return;
  }

  const rows = legacy
    .prepare("SELECT * FROM request_logs ORDER BY id ASC")
    .all() as Array<{
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
  }>;

  const logStore = new HybridLogStore(dbPath, config.logging.blobRoot);
  const liveStore = await createLiveStoreRuntime({
    storageDir: path.join(path.dirname(dbPath), "livestore"),
    storeId: "logs",
  }).catch((error) => {
    logger.warn(
      { err: error },
      "LiveStore mirror unavailable; skipping LiveStore migration",
    );
    return undefined;
  });

  let migrated = 0;
  for (const row of rows) {
    const stored = logStore.append({
      requestId: `legacy-${row.id}`,
      method: row.method,
      url: row.url,
      statusCode: row.status_code,
      model: row.model ?? undefined,
      requestBody: safeParse(row.request_body),
      responseBody: safeParse(row.response_body),
      providerRequestBody: safeParse(row.provider_request_body),
      providerResponseBody: safeParse(row.provider_response_body),
      summary: "migrated from request_logs",
    });
    if (stored && liveStore) {
      await liveStore.mirrorLog(stored);
    }
    migrated += 1;
  }

  if (liveStore) {
    logger.info(
      { migrated },
      "Legacy logs migrated to hybrid storage and LiveStore mirror",
    );
    await liveStore.close();
  } else {
    logger.info({ migrated }, "Legacy logs migrated to hybrid storage");
  }
}

migrate().catch((error) => {
  logger.error({ err: error }, "Failed to migrate legacy logs");
  process.exit(1);
});
