import { describe, it, expect } from "vitest";
import { OpenAIResponsesClientAdapter } from "../src/core/clientAdapters.js";
import { buildOpenAIPayload } from "../src/core/providers/openai.js";

describe("OpenAIResponsesClientAdapter Issue Reproduction", () => {
  type ToUlxInput = Parameters<OpenAIResponsesClientAdapter["toUlx"]>[0];

  it("handles input array with message objects and input_text", () => {
    const adapter = new OpenAIResponsesClientAdapter();
    const inputPayload = {
      model: "google/gemini-3-pro-preview",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "Context...",
            },
          ],
        },
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "Instruction...",
            },
          ],
        },
      ],
    };

    const ulx = adapter.toUlx(inputPayload as unknown as ToUlxInput, {});

    expect(ulx.messages).toHaveLength(2);
    expect(ulx.messages[0].role).toBe("user");
    expect(ulx.messages[0].content[0].type).toBe("text");
    expect(ulx.messages[0].content[0].text).toBe("Context...");
    expect(ulx.messages[1].role).toBe("user");
    expect(ulx.messages[1].content[0].type).toBe("text");
    expect(ulx.messages[1].content[0].text).toBe("Instruction...");
  });

  it("handles input array message objects without `type` fields (@ai-sdk/openai)", () => {
    const adapter = new OpenAIResponsesClientAdapter();
    const inputPayload = {
      model: "test-model",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "Hello" }],
        },
        {
          role: "assistant",
          content: [{ type: "output_text", text: "Hi!" }],
        },
      ],
    };

    const ulx = adapter.toUlx(inputPayload as unknown as ToUlxInput, {});

    expect(ulx.messages).toHaveLength(2);
    expect(ulx.messages[0].role).toBe("user");
    expect(ulx.messages[0].content[0].text).toBe("Hello");
    expect(ulx.messages[1].role).toBe("assistant");
    expect(ulx.messages[1].content[0].text).toBe("Hi!");
  });

  it("handles mixed input array with plain text and message objects", () => {
    const adapter = new OpenAIResponsesClientAdapter();
    const inputPayload = {
      model: "test-model",
      input: [
        { type: "text", text: "Simple text" },
        {
          type: "message",
          role: "assistant",
          content: "Assistant message",
        },
      ],
    };

    const ulx = adapter.toUlx(inputPayload as unknown as ToUlxInput, {});

    expect(ulx.messages).toHaveLength(2);
    expect(ulx.messages[0].role).toBe("user"); // buffered text becomes user message
    expect(ulx.messages[0].content[0].text).toBe("Simple text");
    expect(ulx.messages[1].role).toBe("assistant");
    expect(ulx.messages[1].content[0].text).toBe("Assistant message");
  });

  it("handles `function_call` and `function_call_output` without `type` fields", () => {
    const adapter = new OpenAIResponsesClientAdapter();
    const inputPayload = {
      model: "test-model",
      input: [
        {
          role: "assistant",
          content: [{ type: "output_text", text: "Calling tool..." }],
        },
        {
          name: "doThing",
          arguments: '{"x":1}',
          call_id: "call_1",
        },
        {
          call_id: "call_1",
          output: '{"ok":true}',
        },
      ],
    };

    const ulx = adapter.toUlx(inputPayload as unknown as ToUlxInput, {});

    expect(ulx.messages).toHaveLength(2);
    expect(ulx.messages[0].role).toBe("assistant");
    expect(ulx.messages[0].tool_calls?.[0]).toMatchObject({
      id: "call_1",
      name: "doThing",
      arguments: '{"x":1}',
    });
    expect(ulx.messages[1].role).toBe("tool");
    expect(ulx.messages[1].tool_call_id).toBe("call_1");
    expect(ulx.messages[1].content[0]?.text).toBe('{"ok":true}');
  });

  it("handles string entries inside the `input` array", () => {
    const adapter = new OpenAIResponsesClientAdapter();
    const inputPayload = {
      model: "test-model",
      input: ["Hello", { role: "assistant", content: "World" }],
    };

    const ulx = adapter.toUlx(inputPayload as unknown as ToUlxInput, {});

    expect(ulx.messages).toHaveLength(2);
    expect(ulx.messages[0].role).toBe("user");
    expect(ulx.messages[0].content[0].text).toBe("Hello");
    expect(ulx.messages[1].role).toBe("assistant");
    expect(ulx.messages[1].content[0].text).toBe("World");
  });

  it("normalizes `input_image` message content parts to ULX `image_url`", () => {
    const adapter = new OpenAIResponsesClientAdapter();
    const inputPayload = {
      model: "test-model",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_image",
              image_url: "https://example.com/image.png",
              detail: "auto",
            },
          ],
        },
      ],
    };

    const ulx = adapter.toUlx(inputPayload as unknown as ToUlxInput, {});

    expect(ulx.messages).toHaveLength(1);
    expect(ulx.messages[0].role).toBe("user");
    expect(ulx.messages[0].content[0]).toMatchObject({
      type: "image_url",
      url: "https://example.com/image.png",
    });
  });

  it("preserves output_text and tool call history", () => {
    const adapter = new OpenAIResponsesClientAdapter();
    const inputPayload = {
      model: "test-model",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Hi" }],
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Calling tool..." }],
        },
        {
          type: "function_call",
          name: "doThing",
          arguments: '{"x":1}',
          call_id: "call_1",
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: '{"ok":true}',
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Done" }],
        },
      ],
    };

    const ulx = adapter.toUlx(inputPayload as unknown as ToUlxInput, {});

    expect(ulx.messages).toHaveLength(4);
    expect(ulx.messages[1].role).toBe("assistant");
    expect(ulx.messages[1].content[0]?.text).toBe("Calling tool...");
    expect(ulx.messages[1].tool_calls?.[0]).toMatchObject({
      id: "call_1",
      name: "doThing",
      arguments: '{"x":1}',
    });

    expect(ulx.messages[2].role).toBe("tool");
    expect(ulx.messages[2].tool_call_id).toBe("call_1");
    expect(ulx.messages[2].content[0]?.text).toBe('{"ok":true}');

    const payload = buildOpenAIPayload(ulx) as {
      messages: Array<Record<string, unknown>>;
    };
    expect(payload.messages[1]?.content).toBe("Calling tool...");
    expect(payload.messages[1]?.tool_calls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "doThing", arguments: '{"x":1}' },
      },
    ]);
    expect(payload.messages[2]?.role).toBe("tool");
    expect(payload.messages[2]?.tool_call_id).toBe("call_1");
    expect(payload.messages[2]?.content).toBe('{"ok":true}');
  });
});
