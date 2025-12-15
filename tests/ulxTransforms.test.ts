import { describe, it, expect } from "vitest";
import {
  UlxOperation,
  type UlxRequest,
  type UlxResponse,
} from "../src/ulx/types.js";
import { NormalizeUlxResponseTransform } from "../src/ulx/transforms.js";

const baseRequest: UlxRequest = {
  id: "req-1",
  model: "model",
  operation: UlxOperation.Chat,
  messages: [],
  stream: false,
  state: {},
  parameters: {},
  metadata: { clientFormat: "openai", headers: {} },
};

describe("NormalizeUlxResponseTransform", () => {
  it("sanitizes tool call arguments and infers finish reason", () => {
    const transform = new NormalizeUlxResponseTransform();
    const response = {
      id: "resp-1",
      model: "model",
      operation: UlxOperation.Chat,
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
    } as unknown as UlxResponse;

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
