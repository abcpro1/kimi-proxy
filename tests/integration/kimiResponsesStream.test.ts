import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import OpenAI from "openai";
import type { AppConfig } from "../../src/config.js";
import { createServer } from "../../src/server.js";

// Real integration test without mocks
// Requires .env variables to be present
describe("integration: kimi responses stream via openai sdk (real)", () => {
  if (process.env.RUN_REAL_VERTEX_TESTS !== "true") {
    console.warn(
      "Skipping real Vertex AI integration test: set RUN_REAL_VERTEX_TESTS=true to enable.",
    );
    it.skip("streams /v1/responses successfully", () => {});
    return;
  }

  const tmpRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "ulx-integ-kimi-responses-stream-real-"),
  );
  const dbPath = path.join(tmpRoot, "logs.db");
  const blobRoot = path.join(tmpRoot, "blobs");

  const rawCredentials = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  const hasCredentials =
    typeof rawCredentials === "string" &&
    rawCredentials.length > 0 &&
    (rawCredentials.startsWith("{") || fs.existsSync(rawCredentials));

  // Skip test if credentials are missing/invalid
  if (!process.env.VERTEX_PROJECT_ID || !rawCredentials || !hasCredentials) {
    console.warn(
      "Skipping real Vertex AI integration test: Missing environment variables.",
    );
    it.skip("streams /v1/responses successfully", () => {});
    return;
  }

  beforeEach(() => {
    fs.mkdirSync(blobRoot, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("streams /v1/responses successfully", async () => {
    const config: AppConfig = {
      server: { host: "127.0.0.1", port: 0 },
      logging: { dbPath, blobRoot },
      streaming: { delay: 10, chunkSize: 5 },
      livestore: { batchSize: 50 },
      providers: {
        vertex: {
          projectId: process.env.VERTEX_PROJECT_ID!,
          location: process.env.VERTEX_LOCATION ?? "us-central1",
          ...(rawCredentials.startsWith("{")
            ? { credentials: JSON.parse(rawCredentials) }
            : { credentialsPath: rawCredentials }),
        },
      },
      models: {
        definitions: [
          {
            name: "kimi-k2-thinking",
            provider: "vertex",
            upstreamModel: "moonshotai/kimi-k2-thinking-maas",
            weight: 1,
            ensureToolCall: false,
          },
        ],
        defaultStrategy: "first",
      },
    };

    const server = await createServer(config);
    await server.ready();
    await server.listen({ port: 0 });
    const address = server.server.address() as AddressInfo;
    const baseURL = `http://localhost:${address.port}/v1`;

    const client = new OpenAI({
      baseURL,
      apiKey: "test-key",
    });

    try {
      const stream = client.responses.stream({
        model: "kimi-k2-thinking",
        input: "Say 'Hello from Kimi' and nothing else.",
      });

      let deltaText = "";
      stream.on("response.output_text.delta", (event) => {
        deltaText += event.delta;
      });

      const response = await stream.finalResponse();
      expect(deltaText).toBeTruthy();
      expect(response.output_text.toLowerCase()).toContain("hello");
    } finally {
      await server.close();
    }
  }, 60000);
});
