import { describe, it, expect } from "vitest";
import { OpenAIResponsesPassthroughConverter } from "../src/core/converters/openaiPassthrough.js";
import {
  ClientFormat,
  ProxyOperation,
  ProviderFormat,
  type ConversionContext,
  type JsonObject,
} from "../src/core/types.js";

function createConverter() {
  return new OpenAIResponsesPassthroughConverter();
}

function createContext(): ConversionContext<JsonObject> {
  return {
    request: {
      id: "test",
      operation: ProxyOperation.Responses,
      clientFormat: ClientFormat.OpenAIResponses,
      model: "test-model",
      body: {},
      headers: {},
      stream: false,
      state: {},
    },
    providerFormat: ProviderFormat.OpenAIChatCompletions,
  };
}

describe("OpenAIResponsesPassthroughConverter - Functions", () => {
  it("converts function_call and function_call_output to tool calls", () => {
    const converter = createConverter();
    const requestBody = {
      messages: [
        {
          role: "user",
          content: "Run a task",
        },
        {
          type: "function_call",
          role: "user",
          call_id: "call_123",
          name: "TodoWrite",
          arguments: JSON.stringify({ todos: [] }),
          content: "",
        },
        {
          type: "function_call_output",
          role: "user",
          call_id: "call_123",
          output: "Success",
          content: "",
        },
      ],
    };

    const { body } = converter.convertRequest(requestBody, createContext());

    const messages = body.messages as Array<JsonObject>;
    expect(messages).toHaveLength(3);

    // 1. User message
    expect(messages[0]).toEqual({
      role: "user",
      content: "Run a task",
    });

    // 2. Assistant message with tool calls
    expect(messages[1].role).toBe("assistant");
    const toolCalls = messages[1].tool_calls as Array<JsonObject>;
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toEqual({
      id: "call_123",
      type: "function",
      function: {
        name: "TodoWrite",
        arguments: JSON.stringify({ todos: [] }),
      },
    });

    // 3. Tool output message
    expect(messages[2]).toEqual({
      role: "tool",
      content: "Success",
      tool_call_id: "call_123",
    });
  });
});
