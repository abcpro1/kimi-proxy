import { describe, it, expect } from "vitest";
import {
  JsonObject,
  ProxyOperation,
  ProxyRequest,
  ClientFormat,
} from "../src/core/types.js";
import { EnsureToolCallResponseTransform } from "../src/core/transforms/response/EnsureToolCallResponseTransform.js";
import { createEnsureToolCallState } from "../src/core/ensureToolCall.js";
import { PIPELINE_RETRY_FLAG_KEY } from "../src/core/pipelineControl.js";

describe("Relaxed Termination Tool Detection", () => {
  it("accepts 'Final' tool name (case-insensitive) as termination without requiring summary", () => {
    const transform = new EnsureToolCallResponseTransform();
    const request = createRequest();
    const ensureState = createEnsureToolCallState(request.state);

    // Ensure initial state
    expect(ensureState.pendingReminder).toBe(false);

    const providerResponse = {
      status: 200,
      body: {
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "Final",
                    arguments: JSON.stringify({
                      final_answer: "Relaxed match",
                    }),
                  },
                },
              ],
            },
          },
        ],
      },
      headers: {},
    };

    transform.transform({ request, providerResponse });

    // Should NOT request retry
    expect(request.state[PIPELINE_RETRY_FLAG_KEY]).toBeUndefined();
    expect(ensureState.pendingReminder).toBe(false);

    // Check if message content was updated with summary
    const body = providerResponse.body as JsonObject;
    const choices = body.choices as JsonObject[];
    const message = choices[0].message as JsonObject;
    // The final_answer is converted to content
    expect(message.content).toBe("Relaxed match");
    // tool_calls should be removed
    expect(message.tool_calls).toBeUndefined();
  });
});

function createRequest(): ProxyRequest<JsonObject> {
  return {
    id: "req",
    operation: ProxyOperation.ChatCompletions,
    clientFormat: ClientFormat.OpenAIChatCompletions,
    model: "kimi-k2-thinking",
    body: {
      messages: [{ role: "user", content: "Hello" }],
    },
    headers: {},
    stream: false,
    state: {
      originalStream: false,
    },
  };
}
