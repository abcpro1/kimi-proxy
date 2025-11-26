import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import http from "node:http";
import os from "node:os";
import path from "path";
import { FastifyInstance } from "fastify";
import { createServer } from "../src/server";
import { loadConfig } from "../src/config";
import type { JsonValue } from "../src/core/types";

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
    if (dataPayload && dataPayload !== "[DONE]") {
      try {
        const data = JSON.parse(dataPayload) as JsonValue;
        events.push({ event: eventName, data });
      } catch {
        // Skip invalid JSON
      }
    }
  }
  return { events, done };
}

describe("Chat Completions Streaming", () => {
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-completions-test-"));

    const mockResponse = {
      id: "chatcmpl-test",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "gpt-test",
      choices: [
        {
          finish_reason: "stop",
          message: {
            id: "msg-test",
            role: "assistant",
            content: "This is a test streaming message",
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
    };

    mockServer = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
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
    model: gpt-test
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

  it("should properly stream chat completions with finish_reason and [DONE] marker", async () => {
    const reqData = {
      model: "test-model",
      stream: true,
      messages: [{ role: "user", content: "Hello, test streaming" }],
    };

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reqData),
    });

    expect(response.ok).toBe(true);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const events: ParsedEvent[] = [];
    let doneSignal = false;
    let chunkCount = 0;
    let hasFinishReason = false;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunkCount++;
      buffer += decoder.decode(value, { stream: true });

      let delimiterIndex = buffer.indexOf("\n\n");
      while (delimiterIndex !== -1) {
        const rawChunk = buffer.slice(0, delimiterIndex);
        buffer = buffer.slice(delimiterIndex + 2);
        const trimmed = rawChunk.trim();

        if (!trimmed || trimmed === "data: [DONE]") {
          if (trimmed === "data: [DONE]") {
            doneSignal = true;
          }
          delimiterIndex = buffer.indexOf("\n\n");
          continue;
        }

        const parsed = parseSseBuffer(rawChunk);
        events.push(...parsed.events);

        // Check for finish_reason in any chunk
        for (const evt of parsed.events) {
          if (
            typeof evt.data === "object" &&
            evt.data !== null &&
            "choices" in evt.data
          ) {
            const dataObj = evt.data as {
              choices: Array<{ finish_reason?: string }>;
            };
            if (Array.isArray(dataObj.choices) && dataObj.choices[0]) {
              const choice = dataObj.choices[0];
              if (
                choice &&
                typeof choice === "object" &&
                "finish_reason" in choice &&
                choice.finish_reason !== null &&
                choice.finish_reason !== undefined
              ) {
                hasFinishReason = true;
              }
            }
          }
        }

        delimiterIndex = buffer.indexOf("\n\n");
      }
    }

    // Verify stream completes properly
    expect(doneSignal, "Stream should end with [DONE] marker").toBe(true);
    expect(chunkCount, "Should receive chunks").toBeGreaterThan(0);
    expect(hasFinishReason, "Stream should include finish_reason").toBe(true);
    expect(events.length, "Should have parsed events").toBeGreaterThan(0);

    // Verify the first chunk has the role
    if (events.length > 0) {
      const firstEvent = events[0];
      if (
        typeof firstEvent.data === "object" &&
        firstEvent.data !== null &&
        "choices" in firstEvent.data
      ) {
        const dataObj = firstEvent.data as {
          choices: Array<{ delta?: { role: string } }>;
        };
        if (Array.isArray(dataObj.choices)) {
          const firstChoice = dataObj.choices[0];
          if (
            firstChoice &&
            typeof firstChoice === "object" &&
            "delta" in firstChoice
          ) {
            const delta = firstChoice.delta;
            if (delta && typeof delta === "object" && "role" in delta) {
              expect(delta.role).toBe("assistant");
            }
          }
        }
      }
    }
  });
});
