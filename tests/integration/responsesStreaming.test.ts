import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import OpenAI from "openai";
import type { AppConfig } from "../../src/config.js";
import { createServer } from "../../src/server.js";

describe("integration: /v1/responses streaming (openai sdk)", () => {
  const tmpRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "ulx-integ-responses-stream-"),
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

  it("streams Response events and completes cleanly", async () => {
    const upstream = Fastify({ logger: false });
    upstream.post("/v1/chat/completions", async (_req, reply) => {
      reply.send({
        id: "chatcmpl-123",
        object: "chat.completion",
        created: 1234567890,
        model: "gpt-4",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Hello from upstream",
              reasoning_content: "I reasoned about the best greeting.",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "do_thing", arguments: '{"x":1}' },
                },
              ],
            },
            finish_reason: "tool_calls",
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
    const baseURL = `http://127.0.0.1:${address.port}/v1`;

    const client = new OpenAI({ baseURL, apiKey: "test-key" });

    try {
      const stream = client.responses.stream({
        model: "test-model",
        input: "Say hello.",
      });

      let deltaText = "";
      stream.on("response.output_text.delta", (event) => {
        deltaText += event.delta;
      });

      let argsDelta = "";
      stream.on("response.function_call_arguments.delta", (event) => {
        argsDelta += event.delta;
      });

      let reasoningDelta = "";
      stream.on("response.reasoning_text.delta", (event) => {
        reasoningDelta += event.delta;
      });

      const response = await stream.finalResponse();
      expect(deltaText).toContain("Hello");
      expect(response.output_text).toContain("Hello from upstream");
      expect(argsDelta).toContain('"x"');
      expect(reasoningDelta).toContain("reasoned");
      expect(response.usage?.input_tokens).toBe(10);
      expect(response.usage?.output_tokens).toBe(5);
      expect(response.usage?.total_tokens).toBe(15);
      expect(
        response.output.some((item) => item.type === "function_call"),
      ).toBe(true);
      expect(response.output.some((item) => item.type === "reasoning")).toBe(
        true,
      );
    } finally {
      await server.close();
      await upstream.close();
    }
  });

  it("returns a canonical Response object (non-stream)", async () => {
    const upstream = Fastify({ logger: false });
    upstream.post("/v1/chat/completions", async (_req, reply) => {
      reply.send({
        id: "chatcmpl-456",
        object: "chat.completion",
        created: 1234567890,
        model: "gpt-4",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Hello (non-stream)",
              reasoning_content: "I thought about saying hello.",
              tool_calls: [
                {
                  id: "call_2",
                  type: "function",
                  function: { name: "do_thing", arguments: '{"y":2}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
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
    const baseURL = `http://127.0.0.1:${address.port}/v1`;

    const client = new OpenAI({ baseURL, apiKey: "test-key" });

    try {
      const response = await client.responses.create({
        model: "test-model",
        input: "Say hello.",
      });

      expect(response.output_text).toContain("Hello (non-stream)");
      expect(response.usage?.input_tokens).toBe(7);
      expect(response.usage?.output_tokens).toBe(3);
      expect(response.usage?.total_tokens).toBe(10);
      expect(
        response.output.some((item) => item.type === "function_call"),
      ).toBe(true);
      expect(response.output.some((item) => item.type === "reasoning")).toBe(
        true,
      );
    } finally {
      await server.close();
      await upstream.close();
    }
  });
});
