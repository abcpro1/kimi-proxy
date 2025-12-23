import { describe, expect, it } from "vitest";
import { fixKimiResponse } from "../src/services/kimiFixer.js";
import { Request, Operation, JsonObject } from "../src/core/types.js";

describe("Reasoning and Cleanup", () => {
  const mockRequest: Request = {
    id: "test-req",
    model: "test-model",
    operation: Operation.Chat,
    messages: [],
    tools: [],
    stream: false,
    state: {},
    parameters: {},
    metadata: { clientFormat: "openai", headers: {} },
  };

  it("should handle 'reasoning' field by moving it to 'reasoning_content'", () => {
    const response = {
      choices: [
        {
          message: {
            role: "assistant",
            content: "Hello",
            reasoning: "I am thinking",
          },
        },
      ],
    };

    const result = fixKimiResponse(response as JsonObject, mockRequest);
    const message = (result.response.choices as JsonObject[])[0].message!;

    expect(message.reasoning_content).toBe("I am thinking");
  });

  it("should clean up <tool_call> keywords from content", () => {
    const response = {
      choices: [
        {
          message: {
            role: "assistant",
            content: "Searching now.<tool_call>Web<tool_call>mcp__per",
          },
        },
      ],
    };

    const result = fixKimiResponse(response as JsonObject, mockRequest);
    const message = (result.response.choices as JsonObject[])[0].message!;

    expect(message.content).toBe("Searching now.");
  });

  it("should handle both reasoning field and <tool_call> cleanup simultaneously", () => {
    const response = {
      choices: [
        {
          message: {
            role: "assistant",
            content: "Let me search.<tool_call>search",
            reasoning: "Thinking about searching",
          },
        },
      ],
    };

    const result = fixKimiResponse(response as JsonObject, mockRequest);
    const message = (result.response.choices as JsonObject[])[0].message!;

    expect(message.content).toBe("Let me search.");
    expect(message.reasoning_content).toBe("Thinking about searching");
  });

  it("should handle 'reasoning_details' when other reasoning fields are missing", () => {
    const response = {
      choices: [
        {
          message: {
            role: "assistant",
            content: "Hello",
            reasoning_details: [
              {
                type: "reasoning.text",
                text: "Thinking via details",
              },
            ],
          },
        },
      ],
    };

    const result = fixKimiResponse(response as JsonObject, mockRequest);
    const message = (result.response.choices as JsonObject[])[0].message!;

    expect(message.reasoning_content).toBe("Thinking via details");
  });
});
