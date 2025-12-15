import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import type { AppConfig } from "../../src/config.js";
import { createServer } from "../../src/server.js";

// Load .env file
dotenv.config();

const hasVertexCreds =
  process.env.VERTEX_PROJECT_ID &&
  process.env.VERTEX_LOCATION &&
  process.env.GOOGLE_APPLICATION_CREDENTIALS;

// Simple condition wrapper
const describeRun = hasVertexCreds ? describe : describe.skip;

describeRun("integration: real vertex requests", () => {
  const tmpRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "ulx-integ-vertex-real-"),
  );
  const dbPath = path.join(tmpRoot, "logs.db");
  const blobRoot = path.join(tmpRoot, "blobs");

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

  it("chats with minimaxai/minimax-m2-maas on Vertex", async () => {
    const rawCreds = process.env.GOOGLE_APPLICATION_CREDENTIALS!;
    let credentials;
    let credentialsPath;

    if (rawCreds.trim().startsWith("{")) {
      try {
        credentials = JSON.parse(rawCreds);
      } catch (e) {
        console.error("Failed to parse GOOGLE_APPLICATION_CREDENTIALS JSON", e);
        throw e;
      }
    } else {
      credentialsPath = rawCreds;
    }

    const config: AppConfig = {
      server: { host: "127.0.0.1", port: 0 },
      logging: { dbPath, blobRoot },
      streaming: { delay: 0, chunkSize: 10 },
      livestore: { batchSize: 50 },
      providers: {
        vertex: {
          projectId: process.env.VERTEX_PROJECT_ID!,
          location: process.env.VERTEX_LOCATION!,
          credentials,
          credentialsPath,
        },
      },
      models: {
        definitions: [
          {
            name: "minimax-m2",
            provider: "vertex",
            upstreamModel: "minimaxai/minimax-m2-maas",
          },
        ],
        defaultStrategy: "first",
      },
    };

    const server = await createServer(config);
    await server.ready();
    await server.listen({ port: 0 });
    const address = server.server.address() as AddressInfo;
    const baseURL = `http://127.0.0.1:${address.port}/v1`;

    const client = new Anthropic({
      baseURL,
      apiKey: "test-key",
    });

    try {
      const message = await client.messages.create({
        model: "minimax-m2",
        max_tokens: 1024,
        messages: [{ role: "user", content: "Say hello!" }],
      });

      expect(message.content).toBeDefined();
      expect(message.content.length).toBeGreaterThan(0);
      const textBlock = message.content.find((b) => b.type === "text");
      expect(textBlock).toBeDefined();
      expect(textBlock?.text.length).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  }, 30000);

  it("supports tool calling with minimaxai/minimax-m2-maas", async () => {
    const rawCreds = process.env.GOOGLE_APPLICATION_CREDENTIALS!;
    let credentials;
    let credentialsPath;

    if (rawCreds.trim().startsWith("{")) {
      try {
        credentials = JSON.parse(rawCreds);
      } catch (e) {
        console.error("Failed to parse GOOGLE_APPLICATION_CREDENTIALS JSON", e);
        throw e;
      }
    } else {
      credentialsPath = rawCreds;
    }

    const config: AppConfig = {
      server: { host: "127.0.0.1", port: 0 },
      logging: { dbPath, blobRoot },
      streaming: { delay: 0, chunkSize: 10 },
      livestore: { batchSize: 50 },
      providers: {
        vertex: {
          projectId: process.env.VERTEX_PROJECT_ID!,
          location: process.env.VERTEX_LOCATION!,
          credentials,
          credentialsPath,
        },
      },
      models: {
        definitions: [
          {
            name: "minimax-m2",
            provider: "vertex",
            upstreamModel: "minimaxai/minimax-m2-maas",
          },
        ],
        defaultStrategy: "first",
      },
    };

    const server = await createServer(config);
    await server.ready();
    await server.listen({ port: 0 });
    const address = server.server.address() as AddressInfo;
    const baseURL = `http://127.0.0.1:${address.port}/v1`;

    const client = new Anthropic({
      baseURL,
      apiKey: "test-key",
    });

    try {
      // 1. Ask model to use a tool
      const response1 = await client.messages.create({
        model: "minimax-m2",
        max_tokens: 1024,
        messages: [
          {
            role: "user",
            content:
              "What is the weather in San Francisco? Please use the get_weather tool.",
          },
        ],
        tools: [
          {
            name: "get_weather",
            description: "Get the current weather for a location",
            input_schema: {
              type: "object",
              properties: {
                location: {
                  type: "string",
                  description: "City and state, e.g. San Francisco, CA",
                },
                unit: { type: "string", enum: ["celsius", "fahrenheit"] },
              },
              required: ["location"],
            },
          },
        ],
        tool_choice: { type: "auto" },
      });

      // 2. Verify tool call
      expect(response1.stop_reason).toBe("tool_use");
      const toolUseBlock = response1.content.find((b) => b.type === "tool_use");
      expect(toolUseBlock).toBeDefined();
      if (toolUseBlock?.type === "tool_use") {
        expect(toolUseBlock.name).toBe("get_weather");
        expect(toolUseBlock.input).toHaveProperty("location");
        expect(
          (toolUseBlock.input as Record<string, unknown>).location,
        ).toContain("San Francisco");
      } else {
        throw new Error("Expected tool_use block");
      }

      // 3. Submit tool result
      const toolResultPayload = {
        temperature: 65,
        condition: "Sunny",
        location: "San Francisco, CA",
      };

      const response2 = await client.messages.create({
        model: "minimax-m2",
        max_tokens: 1024,
        messages: [
          {
            role: "user",
            content:
              "What is the weather in San Francisco? Please use the get_weather tool.",
          },
          { role: "assistant", content: response1.content },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: toolUseBlock.id,
                content: JSON.stringify(toolResultPayload),
              },
            ],
          },
        ],
        tools: [
          {
            name: "get_weather",
            description: "Get the current weather for a location",
            input_schema: {
              type: "object",
              properties: {
                location: {
                  type: "string",
                  description: "City and state, e.g. San Francisco, CA",
                },
                unit: { type: "string", enum: ["celsius", "fahrenheit"] },
              },
              required: ["location"],
            },
          },
        ],
      });

      // 4. Verify final answer
      expect(response2.content).toBeDefined();
      const textBlock = response2.content.find((b) => b.type === "text");
      expect(textBlock).toBeDefined();
      if (textBlock?.type === "text") {
        // We expect it to mention the weather data we provided
        expect(textBlock.text.toLowerCase()).toContain("sunny");
        expect(textBlock.text).toContain("65");
      }
    } finally {
      await server.close();
    }
  }, 45000);
});
