import { describe, it, expect } from "vitest";
import { fixKimiResponse } from "../src/services/kimiFixer.js";

const sampleResponse = {
  id: "cnseaZOLBJLowbkPkNvH4AU",
  model: "moonshotai/kimi-k2-thinking-maas",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: "",
        tool_calls: null,
        reasoning_content:
          '  (no content)(no content) <|tool_calls_section_begin|> <|tool_call_begin|> functions.Grep:6 <|tool_call_argument_begin|> {"pattern": "test query", "output_mode": "content", "-n": true} <|tool_call_end|> <|tool_call_begin|> functions.Grep:7 <|tool_call_argument_begin|> {"pattern": "hello", "output_mode": "content", "-i": true} <|tool_call_end|>',
        provider_specific_fields: null,
      },
      finish_reason: "stop",
    },
  ],
};

describe("fixKimiResponse", () => {
  it("extracts tool calls", () => {
    const { response } = fixKimiResponse(
      JSON.parse(JSON.stringify(sampleResponse)),
    );
    const msg = response.choices?.[0]?.message;
    expect(Array.isArray(msg.tool_calls)).toBe(true);
    expect(msg.tool_calls).toHaveLength(2);
    expect(msg.tool_calls?.[0].function?.name).toBe("Grep");
    expect(msg.tool_calls?.[0].id).toBe("6");
  });

  it("cleans reasoning content", () => {
    const resp = {
      choices: [
        {
          message: {
            role: "assistant",
            reasoning_content:
              "<thinking>This is my thought</thinking> Let's do this.",
            content: "Hello",
          },
        },
      ],
    };
    const { response } = fixKimiResponse(resp);
    const reasoning = response.choices?.[0]?.message?.reasoning_content;
    expect(reasoning).toBe("This is my thought Let's do this.");
  });

  it("handles malformed tags", () => {
    const resp = {
      choices: [
        {
          message: {
            role: "assistant",
            reasoning_content: "Let me check </think> update provider",
            content: "Hi",
          },
        },
      ],
    };
    const { response } = fixKimiResponse(resp);
    const reasoning = response.choices?.[0]?.message?.reasoning_content;
    expect(reasoning.includes("</think>")).toBe(false);
  });

  it("extracts tool calls embedded in message content and cleans it", () => {
    const resp = {
      choices: [
        {
          message: {
            role: "assistant",
            content:
              '<|tool_calls_section_begin|> <|tool_call_begin|> functions.lookup:42 <|tool_call_argument_begin|> {"term":"express"} <|tool_call_end|> <|tool_calls_section_end|>',
          },
          finish_reason: "stop",
        },
      ],
    };

    const { response, metadata } = fixKimiResponse(resp);
    const message = response.choices?.[0]?.message;
    expect(metadata.extractedFromContent).toBe(1);
    expect(Array.isArray(message.tool_calls)).toBe(true);
    expect(message.tool_calls).toHaveLength(1);
    expect(message.tool_calls?.[0].function?.name).toBe("lookup");
    expect(message.content).toBe("");
    expect(response.choices?.[0]?.finish_reason).toBe("tool_calls");
  });
});
