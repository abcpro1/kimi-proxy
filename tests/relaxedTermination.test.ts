import { describe, it, expect } from "vitest";
import {
  JsonObject,
  ProxyOperation,
  ProxyRequest,
  ClientFormat,
} from "../src/core/types.js";
import { EnsureToolCallResponseTransform } from "../src/core/transforms/response/EnsureToolCallResponseTransform.js";
import { EnsureToolCallRequestTransform } from "../src/core/transforms/request/EnsureToolCallRequestTransform.js";
import { createEnsureToolCallState } from "../src/core/ensureToolCall.js";
import {
  PIPELINE_RETRY_FLAG_KEY,
  SYNTHETIC_RESPONSE_FLAG_KEY,
} from "../src/core/pipelineControl.js";

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

describe("TodoWrite Summary Heuristic", () => {
  it("accepts response with summary in content and exactly one TodoWrite tool call as termination", () => {
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
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: "Here is my summary of the tasks.",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "TodoWrite",
                    arguments: JSON.stringify({
                      todos: [
                        {
                          content: "Task 1",
                          status: "completed",
                          activeForm: "Doing task 1",
                        },
                      ],
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

    // Should NOT request retry - heuristic should accept this
    expect(request.state[PIPELINE_RETRY_FLAG_KEY]).toBeUndefined();
    expect(ensureState.pendingReminder).toBe(false);

    // tool_calls should remain
    const body = providerResponse.body as JsonObject;
    const choices = body.choices as JsonObject[];
    const message = choices[0].message as JsonObject;
    expect(message.tool_calls).toBeDefined();
    expect(Array.isArray(message.tool_calls)).toBe(true);
  });

  it("does not trigger heuristic with summary but multiple tool calls (uses normal processing)", () => {
    const transform = new EnsureToolCallResponseTransform();
    const request = createRequest();
    const ensureState = createEnsureToolCallState(request.state);

    const providerResponse = {
      status: 200,
      body: {
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: "Here is my summary.",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "TodoWrite",
                    arguments: JSON.stringify({
                      todos: [],
                    }),
                  },
                },
                {
                  id: "call_2",
                  type: "function",
                  function: {
                    name: "Bash",
                    arguments: JSON.stringify({
                      command: "echo test",
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

    // Should not request retry - normal processing handles multiple tool calls without issues
    expect(request.state[PIPELINE_RETRY_FLAG_KEY]).toBeUndefined();
    expect(ensureState.pendingReminder).toBe(false);
  });

  it("does not trigger heuristic with summary but tool is not TodoWrite (uses normal processing)", () => {
    const transform = new EnsureToolCallResponseTransform();
    const request = createRequest();
    const ensureState = createEnsureToolCallState(request.state);

    const providerResponse = {
      status: 200,
      body: {
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: "Here is my summary.",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "Bash",
                    arguments: JSON.stringify({
                      command: "echo test",
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

    // Should not request retry - normal processing accepts one tool call
    expect(request.state[PIPELINE_RETRY_FLAG_KEY]).toBeUndefined();
    expect(ensureState.pendingReminder).toBe(false);
  });

  it("does not trigger heuristic without summary even with TodoWrite tool call (uses normal processing)", () => {
    const transform = new EnsureToolCallResponseTransform();
    const request = createRequest();
    const ensureState = createEnsureToolCallState(request.state);

    const providerResponse = {
      status: 200,
      body: {
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: "Here is my update.", // No "summary" keyword
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "TodoWrite",
                    arguments: JSON.stringify({
                      todos: [],
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

    // Should not request retry - normal processing accepts TodoWrite without summary
    expect(request.state[PIPELINE_RETRY_FLAG_KEY]).toBeUndefined();
    expect(ensureState.pendingReminder).toBe(false);
  });

  it("accepts summary in different cases (case-insensitive)", () => {
    const transform = new EnsureToolCallResponseTransform();
    const request = createRequest();
    const ensureState = createEnsureToolCallState(request.state);

    const providerResponse = {
      status: 200,
      body: {
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: "Here is my SUMMARY of tasks.",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "TodoWrite",
                    arguments: JSON.stringify({
                      todos: [],
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

    // Should NOT request retry - case-insensitive match
    expect(request.state[PIPELINE_RETRY_FLAG_KEY]).toBeUndefined();
    expect(ensureState.pendingReminder).toBe(false);
  });

  it("accepts TodoWrite in different cases (case-insensitive)", () => {
    const transform = new EnsureToolCallResponseTransform();
    const request = createRequest();
    const ensureState = createEnsureToolCallState(request.state);

    const providerResponse = {
      status: 200,
      body: {
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: "Here is my summary of tasks.",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "todowrite", // lowercase
                    arguments: JSON.stringify({
                      todos: [],
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

    // Should NOT request retry - case-insensitive tool name match
    expect(request.state[PIPELINE_RETRY_FLAG_KEY]).toBeUndefined();
    expect(ensureState.pendingReminder).toBe(false);
  });

  it("request transform prevents future enforcement when heuristic is detected", () => {
    const responseTransform = new EnsureToolCallResponseTransform();
    const requestTransform = new EnsureToolCallRequestTransform();

    // First, simulate a response that triggers the heuristic
    const request1 = createRequest();
    const ensureState1 = createEnsureToolCallState(request1.state);

    const providerResponse = {
      status: 200,
      body: {
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: "Here is my summary of tasks.",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "TodoWrite",
                    arguments: JSON.stringify({
                      todos: [
                        {
                          content: "Task 1",
                          status: "completed",
                          activeForm: "Doing task 1",
                        },
                      ],
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

    responseTransform.transform({ request: request1, providerResponse });

    // Verify response was accepted
    expect(request1.state[PIPELINE_RETRY_FLAG_KEY]).toBeUndefined();
    expect(ensureState1.pendingReminder).toBe(false);

    // Now simulate a follow-up request (e.g., from tool execution)
    // Add the assistant message from the response to the request messages
    const messages = [{ role: "user", content: "Hello" }];
    const body = providerResponse.body as JsonObject;
    const choices = body.choices as JsonObject[];
    const message = choices[0].message as JsonObject;
    messages.push(message); // Add the assistant message with TodoWrite

    const request2 = {
      ...createRequest(),
      state: request1.state, // Reuse the same state
      body: { messages },
    };

    const providerRequest = {
      body: {
        messages: [...messages],
        tools: [],
      },
      headers: {},
    };

    requestTransform.transform({ request: request2, providerRequest });

    // Verify that enforcement was skipped (tools should not be injected)
    const tools = providerRequest.body.tools as JsonObject[];
    expect(tools.length).toBe(0);

    // Verify synthetic response was requested
    expect(request2.state[SYNTHETIC_RESPONSE_FLAG_KEY]).toBe(true);
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
