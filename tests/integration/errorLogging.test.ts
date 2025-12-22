import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "../../src/server.js";
import { HybridLogStore } from "../../src/persistence/hybridLogStore.js";
import type { AppConfig } from "../../src/config.js";
import type { FastifyInstance } from "fastify";

let tmpDir: string;
let dbPath: string;
let blobRoot: string;
let server: FastifyInstance;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-test-"));
  dbPath = path.join(tmpDir, "logs.db");
  blobRoot = path.join(tmpDir, "blobs");

  const config: AppConfig = {
    server: { host: "localhost", port: 0 },
    logging: { dbPath, blobRoot },
    streaming: { delay: 0, chunkSize: 100 },
    livestore: { batchSize: 10 },
    providers: {
      openai: { apiKey: "test", baseUrl: "http://test" },
    },
    models: {
      definitions: [
        { name: "gpt-4", provider: "openai", upstreamModel: "gpt-4" },
      ],
      defaultStrategy: "first",
    },
  };

  server = await createServer(config);
  await server.ready();
});

afterAll(async () => {
  if (server) await server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("Error Logging Integration", () => {
  it("logs 400 error when request schema is invalid", async () => {
    // Send invalid body (missing model)
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { messages: [] }, // Missing 'model'
    });

    expect(response.statusCode).toBe(400);

    // Check logs
    const store = new HybridLogStore(dbPath, blobRoot);
    const logs = store.list({ page: 1, pageSize: 1 });
    expect(logs.items.length).toBeGreaterThan(0);
    const latest = logs.items[0];
    expect(latest.status_code).toBe(400);
    // We expect the URL to be logged
    expect(latest.url).toBe("/v1/chat/completions");
    // We expect model to be undefined/null in DB for schema validation error
    expect(latest.model).toBeFalsy();
    // Now we have provider field set
    expect(latest.provider).toBe("schema_validation_failed");
    // Now we have error summaries
    expect(latest.summary).toBeTruthy();
    if (latest.summary) {
      const summary = JSON.parse(latest.summary);
      expect(summary.error_type).toBe("schema_validation");
    }
  });

  it("logs 400 error when model resolution fails", async () => {
    // Send valid schema but unknown model
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "unknown-model", messages: [] },
    });

    expect(response.statusCode).toBe(400);

    const store = new HybridLogStore(dbPath, blobRoot);
    const logs = store.list({ page: 1, pageSize: 1 });
    const latest = logs.items[0];

    expect(latest.status_code).toBe(400);
    expect(latest.model).toBe("unknown-model");
    expect(latest.summary).toBeTruthy(); // Now we have error summaries
    if (latest.summary) {
      const summary = JSON.parse(latest.summary);
      expect(summary.error_type).toBe("model_resolution");
      expect(summary.error_message).toContain("unknown-model");
    }
  });
});
