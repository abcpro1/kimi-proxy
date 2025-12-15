import { describe, expect, it } from "vitest";
import {
  normalizeOpenAIProviderResponse,
  openAIResponseToUlx,
} from "../src/ulx/providers/openai.js";
import { UlxOperation, type UlxProviderResponse } from "../src/ulx/types.js";

describe("OpenAI provider response normalization", () => {
  it("accepts `choices[].message.content: null`", () => {
    const payload: UlxProviderResponse = {
      status: 200,
      headers: {},
      body: {
        id: "chatcmpl-123",
        model: "vertex-openai-compatible",
        choices: [
          {
            finish_reason: null,
            message: {
              role: "assistant",
              content: null,
              reasoning_content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "search", arguments: { query: "docs" } },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      },
    };

    const normalized = normalizeOpenAIProviderResponse(payload);
    expect(normalized).not.toHaveProperty("error");
    if ("error" in normalized) return;

    const ulx = openAIResponseToUlx(normalized.body, {
      id: "req-1",
      model: "vertex-openai-compatible",
      operation: UlxOperation.Chat,
      messages: [],
      stream: false,
      parameters: {},
      metadata: { clientFormat: "openai.chat-completions", headers: {} },
    });

    expect(ulx.output).toHaveLength(1);
    const [first] = ulx.output;
    expect(first?.type).toBe("message");
    if (first?.type !== "message") return;
    expect(first.content).toEqual([]);
    expect(first.tool_calls?.[0]?.name).toBe("search");
  });
});
