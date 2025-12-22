import { describe, it, expect } from "vitest";
import { AnthropicMessagesClientAdapter } from "../src/core/clientAdapters.js";

describe("AnthropicMessagesClientAdapter (SDK compatibility)", () => {
  type ToUlxInput = Parameters<AnthropicMessagesClientAdapter["toUlx"]>[0];

  it("accepts image blocks with URL sources (@ai-sdk/anthropic)", () => {
    const adapter = new AnthropicMessagesClientAdapter();
    const ulx = adapter.toUlx(
      {
        model: "claude-test",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "url", url: "https://example.com/image.png" },
                cache_control: { type: "ephemeral" },
              },
            ],
          },
        ],
      } as unknown as ToUlxInput,
      {},
    );

    expect(ulx.messages).toHaveLength(1);
    expect(ulx.messages[0].role).toBe("user");
    expect(ulx.messages[0].content[0]).toMatchObject({
      type: "image_url",
      url: "https://example.com/image.png",
    });
  });

  it("accepts document blocks and preserves source URL as text", () => {
    const adapter = new AnthropicMessagesClientAdapter();
    const ulx = adapter.toUlx(
      {
        model: "claude-test",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: { type: "url", url: "https://example.com/file.pdf" },
                title: "File",
              },
            ],
          },
        ],
      } as unknown as ToUlxInput,
      {},
    );

    expect(ulx.messages).toHaveLength(1);
    expect(ulx.messages[0].content[0]?.text).toContain(
      "https://example.com/file.pdf",
    );
  });

  it("accepts provider-defined tools without `input_schema` (@ai-sdk/anthropic)", () => {
    const adapter = new AnthropicMessagesClientAdapter();
    const ulx = adapter.toUlx(
      {
        model: "claude-test",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "code_execution_20250522", name: "code_execution" }],
        max_tokens: 16,
      } as unknown as ToUlxInput,
      {},
    );

    expect(ulx.tools).toBeUndefined();
  });

  it("maps server tool calls and tool result variants into ULX tool history", () => {
    const adapter = new AnthropicMessagesClientAdapter();
    const ulx = adapter.toUlx(
      {
        model: "claude-test",
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "server_tool_use",
                id: "call_1",
                name: "web_search",
                input: { query: "hello" },
              },
              {
                type: "web_search_tool_result",
                tool_use_id: "call_1",
                content: [{ type: "text", text: "result" }],
              },
            ],
          },
        ],
      } as unknown as ToUlxInput,
      {},
    );

    expect(ulx.messages).toHaveLength(2);
    expect(ulx.messages[0]).toMatchObject({
      role: "assistant",
      tool_calls: [{ id: "call_1", name: "web_search" }],
    });
    expect(ulx.messages[1]).toMatchObject({
      role: "tool",
      tool_call_id: "call_1",
    });
    expect(ulx.messages[1].content[0]?.text).toContain("result");
  });

  it("accepts content blocks without `type` fields", () => {
    const adapter = new AnthropicMessagesClientAdapter();
    const ulx = adapter.toUlx(
      {
        model: "claude-test",
        messages: [{ role: "user", content: [{ text: "hello" }] }],
        max_tokens: 16,
      } as unknown as ToUlxInput,
      {},
    );

    expect(ulx.messages[0].content[0]?.text).toBe("hello");
  });
});
