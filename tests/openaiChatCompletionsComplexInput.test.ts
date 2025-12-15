import { describe, it, expect } from "vitest";
import { OpenAIChatClientAdapter } from "../src/ulx/clientAdapters.js";

describe("OpenAIChatClientAdapter (input compatibility)", () => {
  it("accepts content parts without `type` fields", () => {
    const adapter = new OpenAIChatClientAdapter();
    const ulx = adapter.toUlx(
      {
        model: "gpt-4",
        messages: [
          {
            role: "user",
            content: [{ text: "hello" }],
          },
          {
            role: "user",
            content: [{ image_url: { url: "https://example.com/image.png" } }],
          },
        ],
      } as unknown as Parameters<OpenAIChatClientAdapter["toUlx"]>[0],
      {},
    );

    expect(ulx.messages[0].content[0]).toMatchObject({
      type: "text",
      text: "hello",
    });
    expect(ulx.messages[1].content[0]).toMatchObject({
      type: "image_url",
      url: "https://example.com/image.png",
    });
  });

  it("stringifies non-string tool call arguments", () => {
    const adapter = new OpenAIChatClientAdapter();
    const ulx = adapter.toUlx(
      {
        model: "gpt-4",
        messages: [
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_1",
                function: { name: "doThing", arguments: { x: 1 } },
              },
            ],
          },
        ],
      } as unknown as Parameters<OpenAIChatClientAdapter["toUlx"]>[0],
      {},
    );

    expect(ulx.messages[0].tool_calls?.[0]).toMatchObject({
      id: "call_1",
      name: "doThing",
      arguments: '{"x":1}',
    });
  });

  it("maps legacy `functions` to ULX tools", () => {
    const adapter = new OpenAIChatClientAdapter();
    const ulx = adapter.toUlx(
      {
        model: "gpt-4",
        messages: [{ role: "user", content: "hi" }],
        functions: [
          {
            name: "legacy_fn",
            description: "Legacy function",
            parameters: { type: "object" },
          },
        ],
      } as unknown as Parameters<OpenAIChatClientAdapter["toUlx"]>[0],
      {},
    );

    expect(ulx.tools?.[0]).toMatchObject({
      type: "function",
      name: "legacy_fn",
      description: "Legacy function",
      parameters: { type: "object" },
    });
  });

  it("maps legacy `message.function_call` to ULX tool_calls", () => {
    const adapter = new OpenAIChatClientAdapter();
    const ulx = adapter.toUlx(
      {
        model: "gpt-4",
        messages: [
          {
            role: "assistant",
            content: null,
            function_call: { name: "legacyCall", arguments: { ok: true } },
          },
        ],
      } as unknown as Parameters<OpenAIChatClientAdapter["toUlx"]>[0],
      {},
    );

    expect(ulx.messages[0].tool_calls?.[0]).toMatchObject({
      id: "legacyCall",
      name: "legacyCall",
      arguments: '{"ok":true}',
    });
  });

  it("maps `max_completion_tokens` to ULX max_tokens", () => {
    const adapter = new OpenAIChatClientAdapter();
    const ulx = adapter.toUlx(
      {
        model: "gpt-4",
        max_completion_tokens: 123,
        messages: [{ role: "user", content: "hi" }],
      } as unknown as Parameters<OpenAIChatClientAdapter["toUlx"]>[0],
      {},
    );

    expect(ulx.parameters.max_tokens).toBe(123);
  });
});
