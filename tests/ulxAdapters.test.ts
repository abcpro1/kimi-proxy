import { describe, it, expect } from "vitest";
import {
  OpenAIChatClientAdapter,
  OpenAIResponsesClientAdapter,
} from "../src/core/clientAdapters.js";
import { Operation, type Request, type Response } from "../src/core/types.js";

describe("OpenAIChatClientAdapter", () => {
  it("normalizes chat requests into ULX", () => {
    const adapter = new OpenAIChatClientAdapter();
    const ulx = adapter.toUlx(
      {
        model: "gpt-4",
        messages: [{ role: "user", content: "hello" }],
      },
      {},
    );

    expect(ulx.operation).toBe(Operation.Chat);
    expect(ulx.messages[0].content[0]).toMatchObject({
      type: "text",
      text: "hello",
    });
  });

  it("renders ULX responses back to chat completions", () => {
    const adapter = new OpenAIChatClientAdapter();
    const ulxResponse: Response = {
      id: "resp-1",
      model: "gpt-4",
      operation: Operation.Chat,
      finish_reason: "stop",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Hello" }],
          status: "completed",
        },
      ],
    };

    const mockRequest: Request = {
      id: "req-1",
      model: "gpt-4",
      operation: Operation.Chat,
      messages: [],
      metadata: { clientFormat: "openai.chat-completions", headers: {} },
      parameters: {},
      stream: false,
      state: {},
    };

    const payload = adapter.fromUlx(ulxResponse, mockRequest) as {
      choices: Array<{ message: { content: string | unknown[] } }>;
    };

    expect(payload.choices[0].message.content as string).toContain("Hello");
  });
});

describe("OpenAIResponsesClientAdapter", () => {
  it("normalizes requests with nested tool format", () => {
    const adapter = new OpenAIResponsesClientAdapter();
    const ulx = adapter.toUlx(
      {
        model: "gpt-4",
        tools: [
          {
            type: "function",
            function: {
              name: "nested_tool",
              description: "Nested tool",
              parameters: { type: "object" },
            },
          },
        ],
      },
      {},
    );

    expect(ulx.operation).toBe(Operation.Responses);
    expect(ulx.tools).toBeDefined();
    expect(ulx.tools![0]).toMatchObject({
      type: "function",
      name: "nested_tool",
      description: "Nested tool",
      parameters: { type: "object" },
    });
  });

  it("normalizes requests with flat tool format", () => {
    const adapter = new OpenAIResponsesClientAdapter();
    const ulx = adapter.toUlx(
      {
        model: "gpt-4",
        tools: [
          {
            name: "flat_tool",
            description: "Flat tool",
            parameters: { type: "object" },
          },
        ],
      },
      {},
    );

    expect(ulx.operation).toBe(Operation.Responses);
    expect(ulx.tools).toBeDefined();
    expect(ulx.tools![0]).toMatchObject({
      type: "function",
      name: "flat_tool",
      description: "Flat tool",
      parameters: { type: "object" },
    });
  });
});
