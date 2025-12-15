import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../src/config.js";
import { createServer } from "../../src/server.js";

const generateContentMock = vi.fn();
const vertexConstructorMock = vi.fn();
const getGenerativeModelMock = vi.fn().mockReturnValue({
  generateContent: generateContentMock,
});

vi.mock("@google-cloud/vertexai", () => {
  class VertexAI {
    preview = {
      getGenerativeModel: getGenerativeModelMock,
    };
    constructor(public options: unknown) {
      vertexConstructorMock(options);
    }
  }
  return { VertexAI };
});

const getAccessTokenMock = vi.fn().mockResolvedValue("mock-access-token");
vi.mock("google-auth-library", () => {
  return {
    GoogleAuth: vi.fn().mockImplementation(() => ({
      getAccessToken: getAccessTokenMock,
    })),
  };
});

describe("integration: vertex models", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ulx-integ-"));
  const dbPath = path.join(tmpRoot, "logs.db");
  const blobRoot = path.join(tmpRoot, "blobs");
  let originalFetch: typeof fetch | undefined;
  const fetchCalls: Array<{ url: string; headers: Headers; body?: string }> =
    [];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchCalls.length = 0;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

      fetchCalls.push({
        url,
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? init.body : undefined,
      });

      if (url.endsWith("/chat/completions")) {
        return new Response(
          JSON.stringify({
            id: "chatcmpl-123",
            object: "chat.completion",
            created: 1234567890,
            model: "moonshotai/kimi-k2-thinking-maas",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "Hello from OpenAI" },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              total_tokens: 15,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      throw new Error(`Unexpected fetch request: ${url}`);
    }) as typeof fetch;

    fs.mkdirSync(blobRoot, { recursive: true });
    getGenerativeModelMock.mockReturnValue({
      generateContent: generateContentMock,
    });
    generateContentMock.mockResolvedValue({
      response: {
        candidates: [
          {
            content: { parts: [{ text: "Hello from Vertex" }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 5,
          candidatesTokenCount: 7,
          totalTokenCount: 12,
        },
      },
    });
  });

  afterEach(() => {
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    }
    generateContentMock.mockReset();
    vertexConstructorMock.mockReset();
    getGenerativeModelMock.mockReset();
    getAccessTokenMock.mockClear();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("routes kimi-k2-thinking to Vertex MaaS (OpenAI) with correct endpoint", async () => {
    const config: AppConfig = {
      server: { host: "127.0.0.1", port: 0 },
      logging: { dbPath, blobRoot },
      streaming: { delay: 10, chunkSize: 5 },
      livestore: { batchSize: 50 },
      providers: {
        vertex: {
          projectId: "test-project",
          location: "us-central1",
          credentials: {
            client_email: "test@test",
            private_key:
              "-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----",
          },
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

    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "kimi-k2-thinking",
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      choices: Array<{ message: { content: string } }>;
      model: string;
    };
    expect(body.choices[0]?.message.content).toContain("Hello from OpenAI");
    expect(fetchCalls.length).toBeGreaterThan(0);
    const [fetchCall] = fetchCalls;
    expect(fetchCall?.url).toContain(
      "https://aiplatform.googleapis.com/v1/projects/test-project/locations/us-central1/endpoints/openapi/chat/completions",
    );
    expect(fetchCall?.headers.get("authorization")).toBe(
      "Bearer mock-access-token",
    );
    expect(fetchCall?.headers.get("x-goog-user-project")).toBe("test-project");

    // Verify VertexAI was NOT called
    expect(vertexConstructorMock).not.toHaveBeenCalled();

    await server.close();
  });

  it("routes gemini-3-pro-preview to Vertex adapter with global location", async () => {
    const config: AppConfig = {
      server: { host: "127.0.0.1", port: 0 },
      logging: { dbPath, blobRoot },
      streaming: { delay: 10, chunkSize: 5 },
      livestore: { batchSize: 50 },
      providers: {
        vertex: {
          projectId: "test-project",
          location: "us-central1",
          credentials: {
            client_email: "test@test",
            private_key:
              "-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----",
          },
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

    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "gemini-3-pro",
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      choices: Array<{ message: { content: string } }>;
      model: string;
    };
    expect(body.choices[0]?.message.content).toContain("Hello from Vertex");
    expect(generateContentMock).toHaveBeenCalled();

    // Verify constructor options
    expect(vertexConstructorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        location: "global",
        apiEndpoint: "aiplatform.googleapis.com",
      }),
    );

    expect(getGenerativeModelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model:
          "projects/test-project/locations/global/publishers/google/models/gemini-3-pro-preview",
      }),
    );

    await server.close();
  });

  it("passes tools to Vertex as a single tool with functionDeclarations", async () => {
    const config: AppConfig = {
      server: { host: "127.0.0.1", port: 0 },
      logging: { dbPath, blobRoot },
      streaming: { delay: 10, chunkSize: 5 },
      livestore: { batchSize: 50 },
      providers: {
        vertex: {
          projectId: "test-project",
          location: "us-central1",
          credentials: {
            client_email: "test@test",
            private_key:
              "-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----",
          },
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

    const response = await server.inject({
      method: "POST",
      url: "/v1/responses",
      payload: {
        model: "gemini-3-pro",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Hello" }],
          },
        ],
        tools: [
          {
            name: "shell",
            description: "Run shell",
            parameters: {
              type: "object",
              properties: { command: { type: "string" } },
              required: ["command"],
            },
          },
          {
            name: "list_mcp_resources",
            description: "List MCP resources",
            parameters: { type: "object", properties: {} },
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(getGenerativeModelMock).toHaveBeenCalledTimes(1);
    expect(generateContentMock).toHaveBeenCalledTimes(1);

    const modelParams = getGenerativeModelMock.mock.calls[0]?.[0] as {
      tools?: Array<{ functionDeclarations?: unknown[] }>;
    };
    expect(modelParams.tools).toHaveLength(1);
    expect(modelParams.tools?.[0]?.functionDeclarations).toHaveLength(2);

    const requestArg = generateContentMock.mock.calls[0]?.[0] as {
      tools?: Array<{ functionDeclarations?: unknown[] }>;
    };
    expect(requestArg.tools).toHaveLength(1);
    expect(requestArg.tools?.[0]?.functionDeclarations).toHaveLength(2);

    await server.close();
  });

  it("propagates Vertex provider status codes (e.g. 400) to the client", async () => {
    generateContentMock.mockRejectedValueOnce(
      new Error(
        `[VertexAI.ClientError]: got status: 400 Bad Request. {"error":{"code":400,"message":"Multiple tools are supported only when they are all search tools.","status":"INVALID_ARGUMENT"}}`,
      ),
    );

    const config: AppConfig = {
      server: { host: "127.0.0.1", port: 0 },
      logging: { dbPath, blobRoot },
      streaming: { delay: 10, chunkSize: 5 },
      livestore: { batchSize: 50 },
      providers: {
        vertex: {
          projectId: "test-project",
          location: "us-central1",
          credentials: {
            client_email: "test@test",
            private_key:
              "-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----",
          },
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

    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "gemini-3-pro",
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json() as {
      error?: { message?: string; code?: string };
    };
    expect(body.error?.code).toBe("400");
    expect(body.error?.message).toContain(
      "Multiple tools are supported only when they are all search tools.",
    );

    await server.close();
  });
});
