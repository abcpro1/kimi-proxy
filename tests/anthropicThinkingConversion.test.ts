import { describe, it, expect } from "vitest";
import {
  AnthropicMessagesClientAdapter,
  OpenAIChatClientAdapter,
  OpenAIResponsesClientAdapter,
} from "../src/core/clientAdapters.js";
import { Operation, type Request, type Response } from "../src/core/types.js";

describe("AnthropicMessagesClientAdapter thinking conversion", () => {
  it("should convert ULX reasoning blocks to Anthropic thinking blocks", () => {
    const adapter = new AnthropicMessagesClientAdapter();

    const ulxResponse: Response = {
      id: "resp-1",
      model: "kimi-k2-thinking",
      operation: Operation.Messages,
      finish_reason: "end_turn",
      output: [
        {
          type: "reasoning",
          content: [
            { type: "reasoning", text: "I am thinking about the answer." },
          ],
          summary: [],
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "The answer is 42." }],
          status: "completed",
        },
      ],
    };

    const mockRequest: Request = {
      id: "req-1",
      model: "kimi-k2-thinking",
      operation: Operation.Messages,
      messages: [],
      metadata: { clientFormat: "anthropic.messages", headers: {} },
      parameters: {},
      stream: false,
      state: {},
    };

    const payload = adapter.fromUlx(ulxResponse, mockRequest) as Record<
      string,
      unknown
    >;

    expect(payload.content).toBeDefined();
    const content = payload.content as Array<Record<string, unknown>>;
    const thinkingBlock = content.find((b) => b.type === "thinking");
    const textBlock = content.find((b) => b.type === "text");

    expect(thinkingBlock).toBeDefined();
    expect(thinkingBlock?.thinking).toBe("I am thinking about the answer.");
    expect(textBlock).toBeDefined();
    expect(textBlock?.text).toBe("The answer is 42.");

    // Verify order
    const thinkingIndex = content.findIndex((b) => b.type === "thinking");
    const textIndex = content.findIndex((b) => b.type === "text");
    expect(thinkingIndex).toBeLessThan(textIndex);
  });

  it("should maintain correct order: reasoning -> message -> tool_use", () => {
    const adapter = new AnthropicMessagesClientAdapter();

    const ulxResponse: Response = {
      id: "resp-order",
      model: "kimi-k2-thinking",
      operation: Operation.Messages,
      finish_reason: "tool_calls",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "I will call a tool." }],
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              name: "test_tool",
              arguments: "{}",
            },
          ],
          status: "completed",
        },
        {
          type: "reasoning",
          content: [{ type: "reasoning", text: "Thinking last in ULX." }],
          summary: [],
        },
      ],
    };

    const mockRequest: Request = {
      id: "req-order",
      model: "kimi-k2-thinking",
      operation: Operation.Messages,
      messages: [],
      metadata: { clientFormat: "anthropic.messages", headers: {} },
      parameters: {},
      stream: false,
      state: {},
    };

    const payload = adapter.fromUlx(ulxResponse, mockRequest) as Record<
      string,
      unknown
    >;
    const content = payload.content as Array<Record<string, unknown>>;

    expect(content[0].type).toBe("thinking");
    expect(content[1].type).toBe("text");
    expect(content[2].type).toBe("tool_use");
  });

  it("should handle multiple reasoning blocks", () => {
    const adapter = new AnthropicMessagesClientAdapter();

    const ulxResponse: Response = {
      id: "resp-2",
      model: "kimi-k2-thinking",
      operation: Operation.Messages,
      finish_reason: "end_turn",
      output: [
        {
          type: "reasoning",
          content: [{ type: "reasoning", text: "First thought." }],
          summary: [],
        },
        {
          type: "reasoning",
          content: [{ type: "reasoning", text: "Second thought." }],
          summary: [],
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Done." }],
          status: "completed",
        },
      ],
    };

    const mockRequest: Request = {
      id: "req-2",
      model: "kimi-k2-thinking",
      operation: Operation.Messages,
      messages: [],
      metadata: { clientFormat: "anthropic.messages", headers: {} },
      parameters: {},
      stream: false,
      state: {},
    };

    const payload = adapter.fromUlx(ulxResponse, mockRequest) as Record<
      string,
      unknown
    >;

    const content = payload.content as Array<Record<string, unknown>>;
    const thinkingBlocks = content.filter((b) => b.type === "thinking");
    expect(thinkingBlocks).toHaveLength(2);
    expect(thinkingBlocks[0].thinking).toBe("First thought.");
    expect(thinkingBlocks[1].thinking).toBe("Second thought.");
  });

  it("should convert Anthropic thinking blocks in request to ULX reasoning content", () => {
    const adapter = new AnthropicMessagesClientAdapter();

    const request = {
      model: "kimi-k2-thinking",
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "I am thinking...",
              signature: "sig123",
            },
            {
              type: "text",
              text: "Hello",
            },
          ],
        },
      ],
    };

    const ulx = adapter.toUlx(request as never, {});

    const assistantMsg = ulx.messages.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    const reasoningPart = assistantMsg!.content.find(
      (c) => c.type === "reasoning",
    );
    expect(reasoningPart).toBeDefined();
    expect(reasoningPart!.text).toBe("I am thinking...");
    const data = reasoningPart!.data as Record<string, unknown>;
    expect(data.signature).toBe("sig123");
  });
});

describe("OpenAIChatClientAdapter reasoning conversion", () => {
  it("should convert ULX reasoning blocks to OpenAI reasoning_content", () => {
    const adapter = new OpenAIChatClientAdapter();

    const ulxResponse: Response = {
      id: "resp-3",
      model: "kimi-k2-thinking",
      operation: Operation.Chat,
      finish_reason: "stop",
      output: [
        {
          type: "reasoning",
          content: [{ type: "reasoning", text: "Reasoning about the query." }],
          summary: [],
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Hello!" }],
          status: "completed",
        },
      ],
    };

    const mockRequest: Request = {
      id: "req-3",
      model: "kimi-k2-thinking",
      operation: Operation.Chat,
      messages: [],
      metadata: { clientFormat: "openai.chat-completions", headers: {} },
      parameters: {},
      stream: false,
      state: {},
    };

    const payload = adapter.fromUlx(ulxResponse, mockRequest) as Record<
      string,
      unknown
    >;

    const choices = payload.choices as Array<{
      message: { reasoning_content: string; content: string };
    }>;
    expect(choices[0].message.reasoning_content).toBe(
      "Reasoning about the query.",
    );
    expect(choices[0].message.content).toBe("Hello!");
  });
});

describe("OpenAIResponsesClientAdapter reasoning conversion", () => {
  it("should maintain correct order in output array: reasoning -> message -> function_call", () => {
    const adapter = new OpenAIResponsesClientAdapter();

    const ulxResponse: Response = {
      id: "resp-resp-order",
      model: "kimi-k2-thinking",
      operation: Operation.Responses,
      finish_reason: "tool_calls",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Calling tool..." }],
          tool_calls: [
            {
              id: "call_resp_1",
              type: "function",
              name: "test_tool",
              arguments: "{}",
            },
          ],
          status: "completed",
        },
        {
          type: "reasoning",
          content: [{ type: "reasoning", text: "Reasoning later in ULX." }],
          summary: [],
        },
      ],
    };

    const mockRequest: Request = {
      id: "req-resp-order",
      model: "kimi-k2-thinking",
      operation: Operation.Responses,
      messages: [],
      metadata: { clientFormat: "openai.responses", headers: {} },
      parameters: {},
      stream: false,
      state: {},
    };

    const payload = adapter.fromUlx(ulxResponse, mockRequest) as Record<
      string,
      unknown
    >;
    const output = payload.output as Array<{ type: string }>;

    expect(output[0].type).toBe("reasoning");
    expect(output[1].type).toBe("message");
    expect(output[2].type).toBe("function_call");
  });
});
