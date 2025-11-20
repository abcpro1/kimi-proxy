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
import { EnsureToolCallResponseTransform } from "../src/core/transforms/response/EnsureToolCallResponseTransform.js";
import {
  createEnsureToolCallState,
  DEFAULT_TERMINATION_TOOL_NAME,
} from "../src/core/ensureToolCall.js";
import {
  PIPELINE_RETRY_FLAG_KEY,
  setPipelineMaxAttempts,
} from "../src/core/pipelineControl.js";
import { LLMProxyPipeline } from "../src/core/pipeline.js";
import { Converter, ConverterRegistry } from "../src/core/converters/types.js";
import { LLMProvider } from "../src/core/providers/types.js";

describe("EnsureToolCallRequestTransform", () => {
  it("injects termination tool and base instructions", () => {
    const transform = new EnsureToolCallRequestTransform();
    const request = createRequest();
    createEnsureToolCallState(request.state);

    const providerRequest = {
      body: {
        messages: [{ role: "system", content: "Follow the rules." }],
        tools: [],
      },
      headers: {},
    };

    transform.transform({ request, providerRequest });

    const tools = providerRequest.body.tools as JsonObject[];
    expect(
      tools.some((tool) => {
        const fn = tool.function as JsonObject;
        return fn?.name === DEFAULT_TERMINATION_TOOL_NAME;
      }),
    ).toBe(true);

    const systemMessage = providerRequest.body.messages?.[0] as JsonObject;
    expect(systemMessage.role).toBe("system");
    const content = String(systemMessage.content);
    expect(content).toContain("Always reply with at least one tool call");
  });

  it("skips injection when a prior assistant message lacks tool calls", () => {
    const transform = new EnsureToolCallRequestTransform();
    const request = createRequest();
    createEnsureToolCallState(request.state);

    // Simulate a conversation where an assistant message after the last user message
    // lacks tool calls (meaning the assistant responded without tools when they should have used them)
    const providerRequest = {
      body: {
        messages: [
          { role: "user", content: "Hello" },
          {
            role: "assistant",
            tool_calls: [
              {
                id: "1",
                type: "function",
                function: { name: "some_tool", arguments: "{}" },
              },
            ],
          },
          { role: "user", content: "Follow up" },
          { role: "assistant", content: "I don't need tools" }, // No tool_calls - this should skip
        ],
        tools: [],
      },
      headers: {},
    };

    transform.transform({ request, providerRequest });

    // Should NOT inject termination tool
    const tools = providerRequest.body.tools as JsonObject[];
    expect(
      tools.some((tool) => {
        const fn = tool.function as JsonObject;
        return fn?.name === DEFAULT_TERMINATION_TOOL_NAME;
      }),
    ).toBe(false);

    // Should NOT append base instruction
    const systemMessage = providerRequest.body.messages?.[0] as JsonObject;
    const content = String(systemMessage.content);
    expect(content).not.toContain("Always reply with at least one tool call");
  });

  it("does not skip when assistant after last user message has tool calls", () => {
    const transform = new EnsureToolCallRequestTransform();
    const request = createRequest();
    createEnsureToolCallState(request.state);

    // Simulate a conversation where the last assistant message has tool calls
    const providerRequest = {
      body: {
        messages: [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi there!" }, // No tool_calls, but this is before last user
          { role: "user", content: "Follow up" },
          {
            role: "assistant",
            tool_calls: [
              {
                id: "1",
                type: "function",
                function: { name: "some_tool", arguments: "{}" },
              },
            ],
          },
        ],
        tools: [],
      },
      headers: {},
    };

    transform.transform({ request, providerRequest });

    // SHOULD inject termination tool
    const tools = providerRequest.body.tools as JsonObject[];
    expect(
      tools.some((tool) => {
        const fn = tool.function as JsonObject;
        return fn?.name === DEFAULT_TERMINATION_TOOL_NAME;
      }),
    ).toBe(true);
  });
});

describe("EnsureToolCallResponseTransform", () => {
  it("requests a retry when provider omits tool calls", () => {
    const transform = new EnsureToolCallResponseTransform();
    const request = createRequest();
    const ensureState = createEnsureToolCallState(request.state);
    expect(ensureState.pendingReminder).toBe(false);

    const providerResponse = {
      status: 200,
      body: {
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: "Done" },
          },
        ],
      },
      headers: {},
    };

    transform.transform({ request, providerResponse });

    expect(request.state[PIPELINE_RETRY_FLAG_KEY]).toBe(true);
    expect(ensureState.pendingReminder).toBe(true);
  });
});

describe("Ensure tool call pipeline integration", () => {
  it("retries until the termination tool is observed", async () => {
    const converterRegistry = new ConverterRegistry();
    converterRegistry.register(new IdentityConverter());

    const pipeline = new LLMProxyPipeline({
      converterRegistry,
      requestTransforms: [new EnsureToolCallRequestTransform()],
      responseTransforms: [new EnsureToolCallResponseTransform()],
    });

    const providerCalls: JsonObject[] = [];
    const providerResponses = [
      createProviderResponse(false),
      createProviderResponse(true),
    ];
    let callIndex = 0;
    const provider: LLMProvider = {
      key: "vertex",
      format: ProviderFormat.OpenAIChatCompletions,
      supportedOperations: [ProxyOperation.ChatCompletions],
      async invoke({ body }) {
        providerCalls.push(JSON.parse(JSON.stringify(body)) as JsonObject);
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
    const providerMessages = providerCalls[1].messages as JsonValue[];
    const reminderContainer = Array.isArray(providerMessages)
      ? (providerMessages[0] as JsonObject)
      : ({} as JsonObject);
    expect(String(reminderContainer.content)).toContain(
      "The client will not continue unless you reply with a tool call",
    );
    assertSuccessfulResult(result);

    const choices = (result.responseBody as JsonObject).choices as JsonObject[];
    const finalMessage = choices[0].message as JsonObject;
    expect(finalMessage.tool_calls).toBeUndefined();
    // Content should be the summary converted from the termination tool
    expect(finalMessage.content).toBe("All done");
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

function createProviderResponse(includeTerminationTool: boolean): {
  status: number;
  body: JsonObject;
  headers: Record<string, string>;
} {
  const toolCalls = includeTerminationTool
    ? [
        {
          id: "finish",
          type: "function",
          function: {
            name: DEFAULT_TERMINATION_TOOL_NAME,
            arguments: JSON.stringify({ summary: "All done" }),
          },
        },
      ]
    : [];
  return {
    status: 200,
    body: {
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: "",
            tool_calls: toolCalls,
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
