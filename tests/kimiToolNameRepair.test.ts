import { describe, expect, it } from "vitest";
import { fixKimiResponse } from "../src/services/kimiFixer.js";
import { Request, Operation, JsonObject } from "../src/core/types.js";
import { normalizeOpenAIProviderResponse } from "../src/core/providers/openai.js";

describe("Kimi Tool Name Repair", () => {
  const mockRequest: Request = {
    id: "test-req",
    model: "test-model",
    operation: Operation.Chat,
    messages: [],
    tools: [
      {
        type: "function",
        name: "get_weather",
        parameters: {
          type: "object",
          properties: {
            location: { type: "string" },
          },
          required: ["location"],
        },
      },
      {
        type: "function",
        name: "get_stock_price",
        parameters: {
          type: "object",
          properties: {
            symbol: { type: "string" },
          },
          required: ["symbol"],
        },
      },
    ],
    stream: false,
    state: {},
    parameters: {},
    metadata: { clientFormat: "openai", headers: {} },
  };

  it("should repair a numeric tool name when it matches exactly one tool", () => {
    const response = {
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: 15,
                  arguments: JSON.stringify({ location: "San Francisco" }),
                },
              },
            ],
          },
        },
      ],
    };

    const result = fixKimiResponse(response as JsonObject, mockRequest);
    const toolCall = (result.response.choices as JsonObject[])[0].message!
      .tool_calls![0];

    expect(toolCall.function.name).toBe("get_weather");
    expect(result.metadata.repairedToolNames).toBe(1);
  });

  it("should repair a numeric string tool name", () => {
    const response = {
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "15",
                  arguments: JSON.stringify({ location: "San Francisco" }),
                },
              },
            ],
          },
        },
      ],
    };

    const result = fixKimiResponse(response as JsonObject, mockRequest);
    const toolCall = (result.response.choices as JsonObject[])[0].message!
      .tool_calls![0];

    expect(toolCall.function.name).toBe("get_weather");
  });

  it("should NOT repair when multiple tools match parameters", () => {
    const multiMatchRequest: Request = {
      ...mockRequest,
      tools: [
        {
          type: "function",
          name: "tool_a",
          parameters: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
          },
        },
        {
          type: "function",
          name: "tool_b",
          parameters: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
          },
        },
      ],
    };

    const response = {
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "99",
                  arguments: JSON.stringify({ id: "123" }),
                },
              },
            ],
          },
        },
      ],
    };

    const result = fixKimiResponse(response as JsonObject, multiMatchRequest);
    const toolCall = (result.response.choices as JsonObject[])[0].message!
      .tool_calls![0];

    expect(toolCall.function.name).toBe("99");
    expect(result.metadata.repairedToolNames).toBe(0);
  });

  it("should passthrough numeric tool names if no request is provided", () => {
    const response = {
      id: "resp-1",
      model: "model-1",
      choices: [
        {
          message: {
            role: "assistant",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: 15,
                  arguments: JSON.stringify({ location: "San Francisco" }),
                },
              },
            ],
          },
        },
      ],
    };

    const result = normalizeOpenAIProviderResponse({
      status: 200,
      body: response,
      headers: {},
    });

    if ("error" in result) {
      throw new Error(result.error);
    }

    expect(result.body.choices[0].message.tool_calls![0].function.name).toBe(
      "15",
    );
  });

  it("should repair tool names extracted from reasoning content", () => {
    const response = {
      choices: [
        {
          message: {
            reasoning_content:
              '<|tool_calls_section_begin|><|tool_call_begin|>15<|tool_call_argument_begin|>{"location": "New York"}<|tool_call_end|><|tool_calls_section_end|>',
          },
        },
      ],
    };

    const result = fixKimiResponse(response as JsonObject, mockRequest);
    const toolCall = (result.response.choices as JsonObject[])[0].message!
      .tool_calls![0];

    expect(toolCall.function.name).toBe("get_weather");
    expect(result.metadata.repairedToolNames).toBe(1);
    expect(result.metadata.extractedFromReasoning).toBe(1);
  });
});
