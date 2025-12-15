import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { logger } from "../utils/logger.js";

export interface CachedSignature {
  tool_call_id: string;
  signature: string;
  timestamp: number;
}

export class SignatureCache {
  private db: Database;
  private memoryCache = new Map<string, CachedSignature>();
  private dbPath: string;

  constructor(cacheDir?: string) {
    // Determine cache directory
    const dir =
      cacheDir ||
      process.env.CACHE_DIR ||
      path.join(os.homedir(), ".cache", "gemini-proxy");

    // Create directory if it doesn't exist
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.dbPath = path.join(dir, "signatures.db");
    this.db = new Database(this.dbPath, { create: true, strict: true });

    // Initialize database schema
    this.initSchema();

    // Run periodic cleanup
    this.scheduleCleanup();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS signatures (
        tool_call_id TEXT PRIMARY KEY,
        signature TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_signatures_timestamp ON signatures(timestamp);
    `);
  }

  private scheduleCleanup(): void {
    // Run cleanup periodically (every 100 operations)
    const timer = setInterval(() => {
      try {
        this.cleanup();
      } catch (err) {
        logger.error({ err }, "Failed to cleanup signature cache");
      }
    }, 60000); // Check every minute
    timer.unref?.();
  }

  store(toolCallId: string, signature: string): void {
    const cached: CachedSignature = {
      tool_call_id: toolCallId,
      signature,
      timestamp: Date.now(),
    };

    // Update memory cache
    this.memoryCache.set(toolCallId, cached);

    // Write to database
    try {
      this.db
        .prepare(
          "INSERT OR REPLACE INTO signatures (tool_call_id, signature, timestamp) VALUES (?, ?, ?)",
        )
        .run(toolCallId, signature, Math.floor(Date.now() / 1000));
    } catch (error) {
      logger.error(
        { err: error, toolCallId },
        "Failed to store signature in database",
      );
    }
  }

  retrieve(toolCallId: string): string | null {
    // Check memory cache first (fast path)
    const cached = this.memoryCache.get(toolCallId);
    if (cached) {
      return cached.signature;
    }

    // Fallback to database
    try {
      const row = this.db
        .prepare("SELECT signature FROM signatures WHERE tool_call_id = ?")
        .get(toolCallId) as { signature: string } | undefined;

      if (row) {
        // Update memory cache
        const cached: CachedSignature = {
          tool_call_id: toolCallId,
          signature: row.signature,
          timestamp: Date.now(),
        };
        this.memoryCache.set(toolCallId, cached);
        return row.signature;
      }
    } catch (error) {
      logger.error(
        { err: error, toolCallId },
        "Failed to retrieve signature from database",
      );
    }

    return null;
  }

  batchRetrieve(toolCallIds: string[]): Record<string, string> {
    const result: Record<string, string> = {};

    // Check memory cache first
    for (const id of toolCallIds) {
      const cached = this.memoryCache.get(id);
      if (cached) {
        result[id] = cached.signature;
      }
    }

    // Get remaining IDs from database
    const remainingIds = toolCallIds.filter((id) => !result[id]);
    if (remainingIds.length === 0) {
      return result;
    }

    try {
      const placeholders = remainingIds.map(() => "?").join(",");
      const rows = this.db
        .prepare(
          `SELECT tool_call_id, signature FROM signatures WHERE tool_call_id IN (${placeholders})`,
        )
        .all(...remainingIds) as Array<{
        tool_call_id: string;
        signature: string;
      }>;

      // Update memory cache and result
      for (const row of rows) {
        result[row.tool_call_id] = row.signature;
        this.memoryCache.set(row.tool_call_id, {
          tool_call_id: row.tool_call_id,
          signature: row.signature,
          timestamp: Date.now(),
        });
      }
    } catch (error) {
      logger.error(
        { err: error, toolCallIds: remainingIds },
        "Failed to batch retrieve signatures from database",
      );
    }

    return result;
  }

  cleanup(daysOld: number = 30): void {
    try {
      const cutoff = Math.floor(
        (Date.now() - daysOld * 24 * 60 * 60 * 1000) / 1000,
      );

      // Delete old signatures
      const info = this.db
        .prepare("DELETE FROM signatures WHERE timestamp < ?")
        .run(cutoff);

      if (info.changes && info.changes > 0) {
        logger.info({ deleted: info.changes }, "Cleaned up old signatures");

        // Clean up memory cache
        const cutoffTime = Date.now() - daysOld * 24 * 60 * 60 * 1000;
        for (const [id, cached] of this.memoryCache.entries()) {
          if (cached.timestamp < cutoffTime) {
            this.memoryCache.delete(id);
          }
        }
      }
    } catch (error) {
      logger.error({ err: error }, "Failed to cleanup signatures");
    }
  }

  close(): void {
    this.db.close();
  }
}
