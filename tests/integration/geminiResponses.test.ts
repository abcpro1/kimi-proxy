import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import OpenAI from "openai";
import type { AppConfig } from "../../src/config.js";
import { createServer } from "../../src/server.js";

// Real integration test without mocks
// Requires .env variables to be present
describe("integration: gemini responses via openai sdk (real)", () => {
  if (process.env.RUN_REAL_VERTEX_TESTS !== "true") {
    console.warn(
      "Skipping real Vertex AI integration test: set RUN_REAL_VERTEX_TESTS=true to enable.",
    );
    it.skip("handles /v1/responses with complex input correctly", () => {});
    return;
  }

  const tmpRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "ulx-integ-gemini-real-"),
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
    it.skip("handles /v1/responses with complex input correctly", () => {});
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

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  it("handles /v1/responses with complex input correctly", async () => {
    const config: AppConfig = {
      server: { host: "127.0.0.1", port: 0 },
      logging: { dbPath, blobRoot },
      streaming: { delay: 10, chunkSize: 5 },
      livestore: { batchSize: 50 },
      providers: {
        vertex: {
          projectId: process.env.VERTEX_PROJECT_ID!,
          location: "us-central1", // Force us-central1 for model availability
          ...(rawCredentials.startsWith("{")
            ? { credentials: JSON.parse(rawCredentials) }
            : { credentialsPath: rawCredentials }),
        },
      },
      models: {
        definitions: [
          {
            name: "gemini-3-pro",
            provider: "vertex",
            upstreamModel: "google/gemini-3-pro-preview",
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
      apiKey: "test-key", // API key is ignored by the local server for now or verified loosely
    });

    try {
      // Send a request using the OpenAI SDK to the /v1/responses endpoint
      const response = await client.responses.create({
        model: "gemini-3-pro",
        input: [
          {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Say 'Hello from Gemini' and nothing else.",
              },
            ],
          },
        ],
      });

      const body = response as unknown;

      const output =
        isRecord(body) && Array.isArray(body.output) ? body.output : [];
      expect(output.length).toBeGreaterThan(0);

      const outputText = output
        .filter(
          (entry): entry is Record<string, unknown> =>
            isRecord(entry) &&
            entry.type === "message" &&
            Array.isArray(entry.content),
        )
        .flatMap((entry) => entry.content as unknown[])
        .filter(
          (entry): entry is { text: string } =>
            isRecord(entry) &&
            entry.type === "output_text" &&
            typeof entry.text === "string",
        )
        .map((entry) => entry.text)
        .join("");

      console.log("Real Vertex Response:", outputText);

      expect(outputText).toBeTruthy();
      expect(typeof outputText).toBe("string");
      // Since we can't guarantee exact output, checking for non-empty string is a good baseline
      // and maybe check if it contains "Hello" since we asked for it.
      expect(outputText.toLowerCase()).toContain("hello");
    } finally {
      await server.close();
    }
  }, 30000); // Increase timeout for real API call
});
