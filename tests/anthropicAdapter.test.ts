import { describe, it, expect } from "vitest";
import {
  anthropicToOpenAIRequest,
  openaiToAnthropicResponse,
} from "../src/adapters/anthropicAdapter.js";

describe("anthropicToOpenAIRequest", () => {
  it("converts system, messages, and tool definitions", () => {
    const request = {
      model: "claude-3",
      system: [{ type: "text", text: "System rules" }],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Hello" },
            { type: "thinking", thinking: "ignored" },
          ],
        },
      ],
      tools: [
        {
          name: "lookup",
          description: "Find things",
          input_schema: { type: "object" },
        },
      ],
      tool_choice: { type: "tool", name: "lookup" },
    };

    const converted = anthropicToOpenAIRequest(request);
    expect(converted.model).toBe("claude-3");
    expect(converted.messages[0]).toEqual({
      role: "system",
      content: "System rules",
    });
    expect(converted.messages[1]).toEqual({ role: "user", content: "Hello" });
    expect(converted.tools?.[0].function?.name).toBe("lookup");
    expect(converted.tool_choice).toEqual({
      type: "function",
      function: { name: "lookup" },
    });
  });

  it("aggregates only text blocks from message content", () => {
    const request = {
      model: "claude-3",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "part one" },
            { type: "thinking", thinking: "internal" },
            { type: "text", text: "part two" },
          ],
        },
      ],
    };

    const converted = anthropicToOpenAIRequest(request);
    expect(converted.messages[0]).toEqual({
      role: "assistant",
      content: "part onepart two",
    });
  });

  it("converts assistant tool_use blocks to tool_calls", () => {
    const request = {
      model: "claude-4.5",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "I will call the tool." },
            {
              type: "tool_use",
              id: "call_1",
              name: "get_weather",
              input: { location: "London" },
            },
          ],
        },
      ],
    };

    const converted = anthropicToOpenAIRequest(request);
    const msg = converted.messages[0];
    expect(msg.role).toBe("assistant");
    expect(msg.content).toBe("I will call the tool.");
    expect(msg.tool_calls).toHaveLength(1);
    expect(msg.tool_calls![0]).toEqual({
      id: "call_1",
      type: "function",
      function: {
        name: "get_weather",
        arguments: JSON.stringify({ location: "London" }),
      },
    });
  });

  it("converts user tool_result blocks to tool messages", () => {
    const request = {
      model: "claude-3",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_1",
              content: "Sunny, 20C",
            },
            { type: "text", text: "What about Paris?" },
          ],
        },
      ],
    };

    const converted = anthropicToOpenAIRequest(request);
    // Should be expanded into 2 messages: one tool result, one user text
    expect(converted.messages).toHaveLength(2);

    const toolMsg = converted.messages[0];
    expect(toolMsg.role).toBe("tool");
    expect(toolMsg.tool_call_id).toBe("call_1");
    expect(toolMsg.content).toBe("Sunny, 20C");

    const userMsg = converted.messages[1];
    expect(userMsg.role).toBe("user");
    expect(userMsg.content).toBe("What about Paris?");
  });
});

describe("openaiToAnthropicResponse", () => {
  it("maps reasoning, text, and tool calls to Anthropic blocks", () => {
    const response = {
      id: "resp_123",
      object: "chat.completion",
      created: 0,
      model: "gpt",
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: {
            content: "Final answer",
            reasoning_content: "reasoning trace",
            tool_calls: [
              {
                id: "call_0",
                type: "function",
                function: {
                  name: "lookup",
                  arguments: JSON.stringify({ query: "value" }),
                },
              },
            ],
          },
        },
      ],
    };

    const converted = openaiToAnthropicResponse(response);
    expect(converted.id).toBe("msg_resp_123");
    expect(converted.model).toBe("gpt");
    expect(converted.stop_reason).toBe("tool_use");
    expect(converted.content[0].type).toBe("thinking");
    expect(converted.content[1]).toEqual({
      type: "text",
      text: "Final answer",
    });
    expect(converted.content[2]).toMatchObject({
      type: "tool_use",
      name: "lookup",
      input: { query: "value" },
    });
  });

  it("falls back to end_turn when no tool calls exist", () => {
    const response = {
      id: "msg_456",
      object: "chat.completion",
      created: 0,
      model: "gpt",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: {
            content: "Plain text",
          },
        },
      ],
    };

    const converted = openaiToAnthropicResponse(response);
    expect(converted.id).toBe("msg_456");
    expect(converted.stop_reason).toBe("end_turn");
    expect(converted.content).toEqual([{ type: "text", text: "Plain text" }]);
  });

  it("emits a thinking block for each reasoning entry", () => {
    const response = {
      id: "resp_array",
      object: "chat.completion",
      created: 0,
      model: "gpt",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: {
            reasoning_content: [
              { thinking: "plan", signature: "sig1" },
              { text: "detail" },
            ],
            content: "answer",
          },
        },
      ],
    };

    const converted = openaiToAnthropicResponse(response);
    const thinkingBlocks = converted.content.filter(
      (block) => block.type === "thinking",
    );
    expect(thinkingBlocks).toHaveLength(2);
    expect(thinkingBlocks[0]).toMatchObject({
      thinking: "plan",
      signature: "sig1",
    });
    expect(thinkingBlocks[1]).toMatchObject({ thinking: "detail" });
  });
});
