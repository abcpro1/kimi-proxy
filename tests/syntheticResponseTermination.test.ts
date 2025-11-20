import { describe, it, expect } from "vitest";
import {
  JsonObject,
  ProxyOperation,
  ProxyRequest,
  ClientFormat,
  ProviderFormat,
} from "../src/core/types.js";
import { EnsureToolCallRequestTransform } from "../src/core/transforms/request/EnsureToolCallRequestTransform.js";
import { EnsureToolCallResponseTransform } from "../src/core/transforms/response/EnsureToolCallResponseTransform.js";
import { createEnsureToolCallState } from "../src/core/ensureToolCall.js";
import { LLMProxyPipeline } from "../src/core/pipeline.js";
import { Converter, ConverterRegistry } from "../src/core/converters/types.js";
import { LLMProvider } from "../src/core/providers/types.js";
import { SYNTHETIC_RESPONSE_FLAG_KEY } from "../src/core/pipelineControl.js";

describe("Synthetic Response Termination", () => {
  it("returns synthetic response when previous assistant message lacks tool calls", async () => {
    const converterRegistry = new ConverterRegistry();
    converterRegistry.register(new IdentityConverter());

    const pipeline = new LLMProxyPipeline({
      converterRegistry,
      requestTransforms: [new EnsureToolCallRequestTransform()],
      responseTransforms: [new EnsureToolCallResponseTransform()],
    });

    let providerCallCount = 0;
    const provider: LLMProvider = {
      key: "test",
      format: ProviderFormat.OpenAIChatCompletions,
      supportedOperations: [ProxyOperation.ChatCompletions],
      async invoke() {
        providerCallCount++;
        throw new Error(
          "Should not be invoked when synthetic response is used",
        );
      },
    };

    // Create a conversation where the assistant responded without tool calls
    // This should trigger synthetic response generation
    const request = createRequestWithNonToolAssistantMessage();
    createEnsureToolCallState(request.state);

    const result = await pipeline.execute(provider, request);

    // Provider should not have been called
    expect(providerCallCount).toBe(0);

    // Should have synthetic response flag set during processing
    expect(result.request.state[SYNTHETIC_RESPONSE_FLAG_KEY]).toBeUndefined();

    // Should return a valid response with empty assistant message
    expect(result.isError).toBe(false);
    expect(result.statusCode).toBe(200);

    const responseBody = result.responseBody as JsonObject;
    const choices = responseBody.choices as JsonObject[];
    expect(choices).toBeDefined();
    expect(choices.length).toBeGreaterThan(0);

    const message = choices[0].message as JsonObject;
    expect(message.role).toBe("assistant");
    expect(message.content).toBe(null);
  });
});

function createRequestWithNonToolAssistantMessage(): ProxyRequest<JsonObject> {
  return {
    id: "test-synthetic",
    operation: ProxyOperation.ChatCompletions,
    clientFormat: ClientFormat.OpenAIChatCompletions,
    model: "test-model",
    body: {
      messages: [
        { role: "user", content: "Hello" },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "some_tool", arguments: "{}" },
            },
          ],
        },
        { role: "user", content: "Follow up" },
        { role: "assistant", content: "I don't need tools" }, // No tool_calls - triggers synthetic response
      ],
    },
    headers: {},
    stream: false,
    state: {},
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
