import { describe, it, expect } from "vitest";
import { Operation, type Request, type Response } from "../src/core/types.js";
import { NormalizeResponseTransform } from "../src/core/transforms.js";

const baseRequest: Request = {
  id: "req-1",
  model: "model",
  operation: Operation.Chat,
  messages: [],
  stream: false,
  state: {},
  parameters: {},
  metadata: { clientFormat: "openai", headers: {} },
};

describe("NormalizeResponseTransform", () => {
  it("sanitizes tool call arguments and infers finish reason", () => {
    const transform = new NormalizeResponseTransform();
    const response = {
      id: "resp-1",
      model: "model",
      operation: Operation.Chat,
      output: [
        {
          type: "message",
          role: "assistant",
          content: [],
          tool_calls: [
            {
              id: "",
              type: "function",
              name: "search",
              arguments: { query: "docs" },
            },
            {
              id: "call-2",
              type: "function",
              name: "broken",
              arguments: "{",
            },
          ],
        },
      ],
    } as unknown as Response;

    transform.transform({ request: baseRequest, response });

    const [first, second] =
      response.output[0]?.type === "message"
        ? (response.output[0].tool_calls ?? [])
        : [];

    expect(first?.arguments).toBe('{"query":"docs"}');
    expect(second?.arguments).toBe('{"_raw":"{"}');
    expect(response.finish_reason).toBe("tool_calls");
  });
});
