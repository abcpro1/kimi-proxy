import { describe, it, expect, beforeEach, vi } from "vitest";
import type { GoogleAuthOptions } from "google-auth-library";
import { VertexMaaSProvider } from "../src/core/providers/vertexProvider.js";
import {
  ClientFormat,
  ProxyOperation,
  ProxyRequest,
  type JsonObject,
} from "../src/core/types.js";
import type { ProviderInvokeArgs } from "../src/core/providers/types.js";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("undici", () => ({ fetch: fetchMock }));

const { googleAuthMock, getAccessTokenMock } = vi.hoisted(() => ({
  googleAuthMock: vi.fn(),
  getAccessTokenMock: vi.fn().mockResolvedValue("token"),
}));

interface MockAuthInstance {
  getAccessToken: () => Promise<string>;
}

vi.mock("google-auth-library", () => ({
  GoogleAuth: function MockAuth(
    this: MockAuthInstance,
    options?: GoogleAuthOptions,
  ) {
    googleAuthMock(options);
    this.getAccessToken = getAccessTokenMock;
  },
}));

interface MockFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<JsonObject | string>;
  text(): Promise<string>;
  headers: Map<string, string>;
}

function createResponse(
  body: JsonObject | string = { choices: [] },
): MockFetchResponse {
  const textBody = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: true,
    status: 200,
    json: async () => JSON.parse(textBody) as JsonObject | string,
    text: async () => textBody,
    headers: new Map<string, string>(),
  };
}

function createRequest(model: string): ProxyRequest<JsonObject> {
  return {
    id: "req",
    operation: ProxyOperation.ChatCompletions,
    clientFormat: ClientFormat.OpenAIChatCompletions,
    model,
    body: {},
    headers: {},
    stream: false,
    state: { resolvedModel: { upstreamModel: model } },
  };
}

function createArgs(model: string): ProviderInvokeArgs<JsonObject> {
  return {
    request: createRequest(model),
    body: { model },
    headers: {},
    stream: false,
  };
}

describe("VertexMaaSProvider endpoint selection", () => {
  const config = { projectId: "proj", location: "europe-west2" };

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(createResponse());
    getAccessTokenMock.mockClear();
    googleAuthMock.mockClear();
  });

  it("uses the regional endpoint by default", async () => {
    const provider = new VertexMaaSProvider(config);
    await provider.invoke(createArgs("generic-model"));
    expect(fetchMock).toHaveBeenCalledWith(
      "https://europe-west2-aiplatform.googleapis.com/v1/projects/proj/locations/europe-west2/endpoints/openapi/chat/completions",
      expect.objectContaining({}),
    );
  });

  it("uses the global host for MaaS models like Kimi", async () => {
    const provider = new VertexMaaSProvider(config);
    await provider.invoke(createArgs("moonshotai/kimi-k2-thinking-maas"));
    expect(fetchMock).toHaveBeenCalledWith(
      "https://aiplatform.googleapis.com/v1/projects/proj/locations/europe-west2/endpoints/openapi/chat/completions",
      expect.objectContaining({}),
    );
  });

  it("forces the global location for Gemini 3 Pro Preview", async () => {
    const provider = new VertexMaaSProvider(config);
    await provider.invoke(createArgs("gemini-3-pro-preview"));
    expect(fetchMock).toHaveBeenCalledWith(
      "https://aiplatform.googleapis.com/v1/projects/proj/locations/global/endpoints/openapi/chat/completions",
      expect.objectContaining({}),
    );
    const payload = fetchMock.mock.calls[0][1];
    expect(JSON.parse(payload.body).model).toBe("google/gemini-3-pro-preview");
  });

  it("handles non-JSON error responses gracefully", async () => {
    const provider = new VertexMaaSProvider(config);
    const errorText = "Service Unavailable";
    fetchMock.mockResolvedValue(createResponse(errorText));

    const response = await provider.invoke(createArgs("generic-model"));

    expect(response.body).toBe(errorText);
  });
});
