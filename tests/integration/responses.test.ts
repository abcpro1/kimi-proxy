import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import http from "node:http";
import os from "node:os";
import path from "path";
import { FastifyInstance } from "fastify";
import { createServer } from "../../src/server";
import { loadConfig } from "../../src/config";
import { LogStore } from "../../src/persistence/logStore";
import type { JsonValue } from "../../src/core/types";

type ParsedEvent = { event: string; data: JsonValue };

function parseSseBuffer(buffer: string): {
  events: ParsedEvent[];
  done: boolean;
} {
  const chunks = buffer.split("\n\n").filter((entry) => entry.trim().length);
  const events: ParsedEvent[] = [];
  let done = false;
  for (const chunk of chunks) {
    if (chunk.trim() === "data: [DONE]") {
      done = true;
      continue;
    }
    let eventName = "message";
    let dataPayload = "";
    for (const line of chunk.split("\n")) {
      if (line.startsWith("event:")) {
        eventName = line.replace("event:", "").trim();
      } else if (line.startsWith("data:")) {
        dataPayload = line.replace("data:", "").trim();
      }
    }
    if (dataPayload) {
      events.push({
        event: eventName,
        data: JSON.parse(dataPayload) as JsonValue,
      });
    }
  }
  return { events, done };
}

describe("Integration: /v1/responses", () => {
  let server: FastifyInstance;
  let baseUrl: string;
  let mockServer: http.Server;
  let tmpDir: string;
  const originalEnv = {
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    MODEL_CONFIG: process.env.MODEL_CONFIG,
    LOG_DB_PATH: process.env.LOG_DB_PATH,
  };

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "responses-test-"));
    const mockResponse = {
      id: "chatcmpl-mock",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "gpt-mock",
      choices: [
        {
          finish_reason: "stop",
          message: {
            id: "msg-mock",
            role: "assistant",
            content: "Hello friend",
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    };

    mockServer = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/v1/responses") {
        req.resume();
        req.on("end", () => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(mockResponse));
        });
        return;
      }
      res.writeHead(404).end();
    });

    await new Promise<void>((resolve) =>
      mockServer.listen(0, "127.0.0.1", resolve),
    );
    const address = mockServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to start mock provider server");
    }
    const mockUrl = `http://${address.address}:${address.port}`;

    process.env.OPENAI_BASE_URL = mockUrl;
    process.env.OPENAI_API_KEY = "test-key";
    process.env.MODEL_CONFIG = `
default_strategy: first
models:
  - name: test-model
    provider: openai
    model: gpt-mock
`;
    process.env.LOG_DB_PATH = path.join(tmpDir, "logs.db");

    const config = loadConfig();
    config.server.port = 0;

    server = await createServer(config);
    const listenAddress = await server.listen({ port: 0, host: "127.0.0.1" });
    baseUrl = listenAddress;
  });

  afterAll(async () => {
    if (server) {
      await server.close();
    }
    if (mockServer) {
      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    }
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    const entries = Object.entries(originalEnv);
    for (const [key, value] of entries) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("streams response events and logs completed status", async () => {
    const reqData = {
      model: "test-model",
      stream: true,
      input: "Hello!",
    };

    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reqData),
    });

    expect(response.ok).toBe(true);

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const events: ParsedEvent[] = [];
    let doneSignal = false;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let delimiterIndex = buffer.indexOf("\n\n");
      while (delimiterIndex !== -1) {
        const rawChunk = buffer.slice(0, delimiterIndex);
        buffer = buffer.slice(delimiterIndex + 2);
        const trimmed = rawChunk.trim();
        if (!trimmed) {
          delimiterIndex = buffer.indexOf("\n\n");
          continue;
        }
        if (trimmed === "data: [DONE]") {
          doneSignal = true;
        } else {
          const parsed = parseSseBuffer(rawChunk);
          events.push(...parsed.events);
          if (parsed.done) {
            doneSignal = true;
          }
        }
        delimiterIndex = buffer.indexOf("\n\n");
      }
    }

    expect(doneSignal).toBe(true);
    expect(events.some((evt) => evt.event === "response.created")).toBe(true);
    expect(
      events.some((evt) => evt.event === "response.output_text.delta"),
    ).toBe(true);
    const completed = events.find((evt) => evt.event === "response.completed");
    expect(completed?.data.response.status).toBe("completed");

    const logStore = new LogStore(process.env.LOG_DB_PATH!);
    const logs = logStore.list({ page: 1, pageSize: 5 });
    expect(logs.items.length).toBeGreaterThan(0);
    const latest = logs.items[0];
    expect(latest.response_body?.status).toBe("completed");
    expect(latest.status_code).toBe(200);
  }, 20000);
});
