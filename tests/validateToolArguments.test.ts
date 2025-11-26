import { describe, it, expect } from "vitest";
import {
  ClientFormat,
  JsonObject,
  JsonValue,
  PipelineResult,
  ProviderFormat,
  ProxyOperation,
  ProxyRequest,
} from "../src/core/types.js";
import { EnsureToolCallRequestTransform } from "../src/core/transforms/request/EnsureToolCallRequestTransform.js";
import { ValidateToolArgumentsTransform } from "../src/core/transforms/response/ValidateToolArgumentsTransform.js";
import { createEnsureToolCallState } from "../src/core/ensureToolCall.js";
import {
  PIPELINE_RETRY_FLAG_KEY,
  setPipelineMaxAttempts,
} from "../src/core/pipelineControl.js";
import { LLMProxyPipeline } from "../src/core/pipeline.js";
import { Converter, ConverterRegistry } from "../src/core/converters/types.js";
import { LLMProvider } from "../src/core/providers/types.js";

describe("ValidateToolArgumentsTransform", () => {
  it("requests a retry when tool arguments contain invalid JSON", () => {
    const transform = new ValidateToolArgumentsTransform();
    const request = createRequest();
    createEnsureToolCallState(request.state);

    const providerResponse = {
      status: 200,
      body: {
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "1",
                  type: "function",
                  function: {
                    name: "some_tool",
                    arguments: "{invalid json, missing quotes around key}",
                  },
                },
              ],
            },
          },
        ],
      },
      headers: {},
    };

    transform.transform({ request, providerResponse });

    expect(request.state[PIPELINE_RETRY_FLAG_KEY]).toBe(true);
  });

  it("does not request retry when tool arguments contain valid JSON", () => {
    const transform = new ValidateToolArgumentsTransform();
    const request = createRequest();
    createEnsureToolCallState(request.state);

    const providerResponse = {
      status: 200,
      body: {
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "1",
                  type: "function",
                  function: {
                    name: "some_tool",
                    arguments: JSON.stringify({ key: "value" }),
                  },
                },
              ],
            },
          },
        ],
      },
      headers: {},
    };

    transform.transform({ request, providerResponse });

    expect(request.state[PIPELINE_RETRY_FLAG_KEY]).toBeUndefined();
  });

  it("validates multiple tool calls and detects any invalid JSON", () => {
    const transform = new ValidateToolArgumentsTransform();
    const request = createRequest();
    createEnsureToolCallState(request.state);

    const providerResponse = {
      status: 200,
      body: {
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "1",
                  type: "function",
                  function: {
                    name: "valid_tool",
                    arguments: JSON.stringify({ key: "value" }),
                  },
                },
                {
                  id: "2",
                  type: "function",
                  function: {
                    name: "invalid_tool",
                    arguments: "[not valid json",
                  },
                },
              ],
            },
          },
        ],
      },
      headers: {},
    };

    transform.transform({ request, providerResponse });

    expect(request.state[PIPELINE_RETRY_FLAG_KEY]).toBe(true);
  });

  it("handles responses without tool calls", () => {
    const transform = new ValidateToolArgumentsTransform();
    const request = createRequest();
    createEnsureToolCallState(request.state);

    const providerResponse = {
      status: 200,
      body: {
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: "Hello",
              tool_calls: [],
            },
          },
        ],
      },
      headers: {},
    };

    transform.transform({ request, providerResponse });

    expect(request.state[PIPELINE_RETRY_FLAG_KEY]).toBeUndefined();
  });
});

describe("ValidateToolArguments pipeline integration", () => {
  it("retries when provider returns invalid JSON in tool arguments", async () => {
    const converterRegistry = new ConverterRegistry();
    converterRegistry.register(new IdentityConverter());

    const pipeline = new LLMProxyPipeline({
      converterRegistry,
      requestTransforms: [new EnsureToolCallRequestTransform()],
      responseTransforms: [new ValidateToolArgumentsTransform()],
    });

    const providerResponses = [
      createProviderResponseWithInvalidArgs(),
      createProviderResponseWithValidArgs(),
    ];
    let callIndex = 0;
    const provider: LLMProvider = {
      key: "vertex",
      format: ProviderFormat.OpenAIChatCompletions,
      supportedOperations: [ProxyOperation.ChatCompletions],
      async invoke() {
        const response =
          providerResponses[Math.min(callIndex, providerResponses.length - 1)];
        callIndex += 1;
        return response;
      },
    };

    const request = createRequest();
    createEnsureToolCallState(request.state);
    setPipelineMaxAttempts(request.state, 3);

    const result = await pipeline.execute(provider, request);

    expect(callIndex).toBe(2);
    assertSuccessfulResult(result);

    const choices = (result.responseBody as JsonObject).choices as JsonObject[];
    const finalMessage = choices[0].message as JsonObject;
    expect(Array.isArray(finalMessage.tool_calls)).toBe(true);
    expect((finalMessage.tool_calls as JsonValue[]).length).toBe(1);
  });
});

function createRequest(): ProxyRequest<JsonObject> {
  return {
    id: "req",
    operation: ProxyOperation.ChatCompletions,
    clientFormat: ClientFormat.OpenAIChatCompletions,
    model: "kimi-k2-thinking",
    body: {
      messages: [{ role: "user", content: "Hello" }],
    },
    headers: {},
    stream: false,
    state: {
      originalStream: false,
    },
  };
}

class IdentityConverter implements Converter<JsonObject> {
  name = "identity";
  sourceFormat = ClientFormat.OpenAIChatCompletions;
  targetFormat = ProviderFormat.OpenAIChatCompletions;
  operations = [ProxyOperation.ChatCompletions];

  convertRequest(body: JsonObject) {
    return { body };
  }

  convertResponse(body: JsonValue) {
    return body;
  }
}

function createProviderResponseWithInvalidArgs(): {
  status: number;
  body: JsonObject;
  headers: Record<string, string>;
} {
  return {
    status: 200,
    body: {
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "1",
                type: "function",
                function: {
                  name: "some_tool",
                  arguments: "{bad json, no quotes missing}",
                },
              },
            ],
          },
        },
      ],
    },
    headers: {},
  };
}

function createProviderResponseWithValidArgs(): {
  status: number;
  body: JsonObject;
  headers: Record<string, string>;
} {
  return {
    status: 200,
    body: {
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "2",
                type: "function",
                function: {
                  name: "some_tool",
                  arguments: JSON.stringify({ key: "value" }),
                },
              },
            ],
          },
        },
      ],
    },
    headers: {},
  };
}

function assertSuccessfulResult(result: PipelineResult) {
  expect(result.isError).toBe(false);
  expect(result.statusCode).toBe(200);
  expect(result.providerResponse.status).toBe(200);
}
