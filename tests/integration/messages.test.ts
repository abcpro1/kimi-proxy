import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import type { AppConfig } from "../../src/config.js";
import { createServer } from "../../src/server.js";

describe("integration: /v1/messages (anthropic sdk)", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ulx-integ-messages-"));
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

  it("handles non-streaming messages request", async () => {
    // Mock OpenAI upstream
    const upstream = Fastify({ logger: false });
    upstream.post("/v1/chat/completions", async (_req, reply) => {
      reply.send({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 1234567890,
        model: "gpt-4",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Hello from OpenAI upstream",
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    });

    await upstream.listen({ host: "127.0.0.1", port: 0 });
    const upstreamAddress = upstream.server.address() as AddressInfo;
    const upstreamBaseUrl = `http://127.0.0.1:${upstreamAddress.port}/v1`;

    const config: AppConfig = {
      server: { host: "127.0.0.1", port: 0 },
      logging: { dbPath, blobRoot },
      streaming: { delay: 0, chunkSize: 2 },
      livestore: { batchSize: 50 },
      providers: {
        openai: { apiKey: "test", baseUrl: upstreamBaseUrl },
      },
      models: {
        definitions: [
          {
            name: "test-model",
            provider: "openai",
            upstreamModel: "gpt-4",
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
        model: "test-model",
        max_tokens: 1024,
        messages: [{ role: "user", content: "Hello" }],
      });

      expect(message.content[0].type).toBe("text");
      if (message.content[0].type === "text") {
        expect(message.content[0].text).toContain("Hello from OpenAI upstream");
      }
      expect(message.role).toBe("assistant");
      expect(message.usage.input_tokens).toBe(10);
      expect(message.usage.output_tokens).toBe(5);
    } finally {
      await server.close();
      await upstream.close();
    }
  });

  it("handles streaming messages request", async () => {
    // Mock OpenAI upstream - returns full JSON, Proxy handles streaming
    const upstream = Fastify({ logger: false });
    upstream.post("/v1/chat/completions", async (_req, reply) => {
      reply.send({
        id: "chatcmpl-stream-src",
        object: "chat.completion",
        created: 1234567890,
        model: "gpt-4",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Hello World",
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      });
    });

    await upstream.listen({ host: "127.0.0.1", port: 0 });
    const upstreamAddress = upstream.server.address() as AddressInfo;
    const upstreamBaseUrl = `http://127.0.0.1:${upstreamAddress.port}/v1`;

    const config: AppConfig = {
      server: { host: "127.0.0.1", port: 0 },
      logging: { dbPath, blobRoot },
      streaming: { delay: 1, chunkSize: 2 }, // Small delay to ensure chunks
      livestore: { batchSize: 50 },
      providers: {
        openai: { apiKey: "test", baseUrl: upstreamBaseUrl },
      },
      models: {
        definitions: [
          {
            name: "test-model",
            provider: "openai",
            upstreamModel: "gpt-4",
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
      const stream = await client.messages.create({
        model: "test-model",
        max_tokens: 1024,
        messages: [{ role: "user", content: "Hello" }],
        stream: true,
      });

      let fullText = "";
      for await (const chunk of stream) {
        if (
          chunk.type === "content_block_delta" &&
          chunk.delta.type === "text_delta"
        ) {
          fullText += chunk.delta.text;
        }
      }

      expect(fullText).toBe("Hello World");
    } finally {
      await server.close();
      await upstream.close();
    }
  });
});
