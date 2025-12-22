import { describe, expect, it } from "vitest";
import { OpenAIChatClientAdapter } from "../src/core/clientAdapters.js";
import {
  ClientFormat,
  type JsonObject,
  Operation,
  type ProviderAdapter,
  type ProviderResponse,
  type Request,
  type Response,
} from "../src/core/types.js";
import {
  ClientRegistry,
  Pipeline,
  ProviderRegistry,
} from "../src/core/pipeline.js";
import {
  EnsureToolCallRequestTransform,
  EnsureToolCallResponseTransform,
  NormalizeResponseTransform,
  NormalizeTransform,
  PropagateFinishReasonsTransform,
} from "../src/core/transforms.js";
import {
  createEnsureToolCallState,
  DEFAULT_TERMINATION_TOOL_NAME,
} from "../src/core/ensureToolCall.js";
import {
  PIPELINE_RETRY_FLAG_KEY,
  SYNTHETIC_RESPONSE_FLAG_KEY,
} from "../src/core/pipelineControl.js";

describe("EnsureToolCallRequestTransform", () => {
  it("injects termination tool and base instructions", () => {
    const transform = new EnsureToolCallRequestTransform();
    const request = createRequest({
      messages: [
        {
          role: "system",
          content: [{ type: "text", text: "Follow the rules." }],
        },
      ],
      tools: [],
    });
    createEnsureToolCallState(request.state);

    transform.transform({ request });

    expect(
      request.tools?.some(
        (tool) => tool.name === DEFAULT_TERMINATION_TOOL_NAME,
      ),
    ).toBe(true);

    const system = request.messages[0];
    expect(system?.role).toBe("system");
    const systemText = system.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    expect(systemText).toContain("Always reply with at least one tool call");
  });

  it("skips enforcement and requests synthetic response when a prior assistant message lacks tool calls", () => {
    const transform = new EnsureToolCallRequestTransform();
    const request = createRequest({
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
        {
          role: "assistant",
          content: [{ type: "text", text: "" }],
          tool_calls: [
            { id: "1", type: "function", name: "some_tool", arguments: "{}" },
          ],
        },
        { role: "user", content: [{ type: "text", text: "Follow up" }] },
        {
          role: "assistant",
          content: [{ type: "text", text: "I don't need tools" }],
        },
      ],
      tools: [],
    });
    createEnsureToolCallState(request.state);

    transform.transform({ request });

    expect(request.tools?.length ?? 0).toBe(0);
    expect(request.state[SYNTHETIC_RESPONSE_FLAG_KEY]).toBe(true);
    expect(request.messages[0]?.role).toBe("user");
  });

  it("does not skip when assistant after last user message has tool calls", () => {
    const transform = new EnsureToolCallRequestTransform();
    const request = createRequest({
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
        { role: "assistant", content: [{ type: "text", text: "Hi there!" }] },
        { role: "user", content: [{ type: "text", text: "Follow up" }] },
        {
          role: "assistant",
          content: [{ type: "text", text: "" }],
          tool_calls: [
            { id: "1", type: "function", name: "some_tool", arguments: "{}" },
          ],
        },
      ],
      tools: [],
    });
    createEnsureToolCallState(request.state);

    transform.transform({ request });

    expect(
      request.tools?.some(
        (tool) => tool.name === DEFAULT_TERMINATION_TOOL_NAME,
      ),
    ).toBe(true);
    expect(request.state[SYNTHETIC_RESPONSE_FLAG_KEY]).toBeUndefined();
  });

  it("skips enforcement for TodoWrite + summary heuristic and requests synthetic response", () => {
    const transform = new EnsureToolCallRequestTransform();
    const request = createRequest({
      model: "kimi-k2",
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
        {
          role: "assistant",
          content: [{ type: "text", text: "Here is my summary of tasks." }],
          tool_calls: [
            {
              id: "1",
              type: "function",
              name: "TodoWrite",
              arguments: '{"todos":[]}',
            },
          ],
        },
      ],
      tools: [],
    });
    createEnsureToolCallState(request.state);

    transform.transform({ request });

    expect(request.state[SYNTHETIC_RESPONSE_FLAG_KEY]).toBe(true);
    expect(request.tools?.length ?? 0).toBe(0);
  });
});

describe("EnsureToolCallResponseTransform", () => {
  it("requests a retry when provider omits tool calls", () => {
    const transform = new EnsureToolCallResponseTransform();
    const request = createRequest({
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    });
    const ensureState = createEnsureToolCallState(request.state);
    expect(ensureState.pendingReminder).toBe(false);

    const response: Response = {
      id: "resp-1",
      model: "model",
      operation: Operation.Chat,
      finish_reason: "stop",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Done" }],
          status: "completed",
        },
      ],
    };

    transform.transform({ request, response });

    expect(request.state[PIPELINE_RETRY_FLAG_KEY]).toBe(true);
    expect(ensureState.pendingReminder).toBe(true);
  });

  it("accepts 'Final' tool name (case-insensitive) as termination and converts final_answer to content", () => {
    const transform = new EnsureToolCallResponseTransform();
    const request = createRequest({
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    });
    createEnsureToolCallState(request.state);

    const response: Response = {
      id: "resp-1",
      model: "model",
      operation: Operation.Chat,
      finish_reason: "tool_calls",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [],
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              name: "Final",
              arguments: JSON.stringify({ final_answer: "Relaxed match" }),
            },
          ],
          status: "completed",
        },
      ],
    };

    transform.transform({ request, response });

    expect(request.state[PIPELINE_RETRY_FLAG_KEY]).toBeUndefined();

    const message = response.output.find((b) => b.type === "message");
    expect(
      message && message.type === "message" ? message.tool_calls : undefined,
    ).toBeUndefined();
    const text =
      message && message.type === "message"
        ? message.content
            .filter((b) => b.type === "text")
            .map((b) => b.text ?? "")
            .join("")
        : "";
    expect(text).toBe("Relaxed match");
    expect(response.finish_reason).toBe("stop");
  });

  it("accepts response with summary keyword and exactly one TodoWrite tool call as termination heuristic", () => {
    const transform = new EnsureToolCallResponseTransform();
    const request = createRequest({
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    });
    const ensureState = createEnsureToolCallState(request.state);
    expect(ensureState.pendingReminder).toBe(false);

    const response: Response = {
      id: "resp-1",
      model: "model",
      operation: Operation.Chat,
      finish_reason: "tool_calls",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Here is my summary of tasks." }],
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              name: "TodoWrite",
              arguments: JSON.stringify({ todos: [] }),
            },
          ],
          status: "completed",
        },
      ],
    };

    transform.transform({ request, response });

    expect(request.state[PIPELINE_RETRY_FLAG_KEY]).toBeUndefined();
    expect(ensureState.pendingReminder).toBe(false);

    const message = response.output.find((b) => b.type === "message");
    expect(
      message && message.type === "message" ? message.tool_calls : undefined,
    ).toBeDefined();
  });

  it("does not treat tool names containing digits as termination tools", () => {
    const transform = new EnsureToolCallResponseTransform();
    const request = createRequest({
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    });
    createEnsureToolCallState(request.state);

    const response: Response = {
      id: "resp-1",
      model: "model",
      operation: Operation.Chat,
      finish_reason: "tool_calls",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [],
          tool_calls: [
            {
              id: "64",
              type: "function",
              name: "mcp__context7__resolve-library-id",
              arguments: JSON.stringify({ libraryName: "react" }),
            },
          ],
          status: "completed",
        },
        {
          type: "reasoning",
          content: [{ type: "reasoning", text: "Thinking..." }],
          summary: [],
        },
      ],
    };

    transform.transform({ request, response });

    expect(request.state[PIPELINE_RETRY_FLAG_KEY]).toBeUndefined();

    const message = response.output.find((b) => b.type === "message");
    expect(
      message && message.type === "message" ? message.tool_calls : undefined,
    ).toBeDefined();
    expect(response.output.some((b) => b.type === "reasoning")).toBe(true);
    expect(response.finish_reason).toBe("tool_calls");
  });
});

describe("Ensure tool call ULX pipeline integration", () => {
  it("retries until termination tool is observed and converts summary into assistant content", async () => {
    const clientRegistry = new ClientRegistry();
    clientRegistry.register(new OpenAIChatClientAdapter());

    const providerCalls: Request[] = [];
    const provider = new SequenceProviderAdapter((request) => {
      providerCalls.push(structuredClone(request));
    });

    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(provider);

    const pipeline = new Pipeline(clientRegistry, providerRegistry, [
      new NormalizeTransform(),
      new EnsureToolCallRequestTransform(),
      new NormalizeResponseTransform(),
      new EnsureToolCallResponseTransform(),
      new PropagateFinishReasonsTransform(),
    ]);

    const result = await pipeline.execute({
      clientFormat: ClientFormat.OpenAIChatCompletions,
      providerKey: provider.key,
      requestBody: {
        model: "test-model",
        messages: [{ role: "user", content: "Hello" }],
      },
      requestHeaders: {},
      operation: Operation.Chat,
      ensureToolCall: true,
    });

    expect(providerCalls.length).toBe(2);

    const systemText = providerCalls[1]!.messages[0]!.content.filter(
      (b) => b.type === "text",
    )
      .map((b) => b.text ?? "")
      .join("");
    expect(systemText).toContain(
      "The client will not continue unless you reply with a tool call",
    );

    const body = result.clientResponse as JsonObject;
    const choices = body.choices as JsonObject[];
    const finalMessage = (choices[0]!.message ?? {}) as JsonObject;
    expect(finalMessage.tool_calls).toBeUndefined();
    expect(finalMessage.content).toBe("All done");
  });

  it("returns a synthetic response when termination pattern already exists in the prompt", async () => {
    const clientRegistry = new ClientRegistry();
    clientRegistry.register(new OpenAIChatClientAdapter());

    let providerCallCount = 0;
    const provider: ProviderAdapter = {
      key: "never",
      providerFormat: "mock",
      async invoke() {
        providerCallCount += 1;
        throw new Error(
          "Provider should not be invoked for synthetic response",
        );
      },
      toUlxResponse() {
        throw new Error("unreachable");
      },
    };

    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(provider);

    const pipeline = new Pipeline(clientRegistry, providerRegistry, [
      new NormalizeTransform(),
      new EnsureToolCallRequestTransform(),
      new NormalizeResponseTransform(),
      new EnsureToolCallResponseTransform(),
      new PropagateFinishReasonsTransform(),
    ]);

    const result = await pipeline.execute({
      clientFormat: ClientFormat.OpenAIChatCompletions,
      providerKey: provider.key,
      requestBody: {
        model: "test-model",
        messages: [
          { role: "user", content: "Hello" },
          {
            role: "assistant",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "some_tool", arguments: "{}" },
              },
            ],
          },
          { role: "user", content: "Follow up" },
          { role: "assistant", content: "I don't need tools" },
        ],
      },
      requestHeaders: {},
      operation: Operation.Chat,
      ensureToolCall: true,
    });

    expect(providerCallCount).toBe(0);
    const body = result.clientResponse as JsonObject;
    const choices = body.choices as JsonObject[];
    const message = (choices[0]!.message ?? {}) as JsonObject;
    expect(message.role).toBe("assistant");
    expect(message.content).toBe(null);
  });
});

class SequenceProviderAdapter implements ProviderAdapter {
  key = "sequence";
  providerFormat = "mock";

  private callIndex = 0;

  constructor(private readonly onInvoke: (request: Request) => void) {}

  async invoke(ulx: Request): Promise<ProviderResponse> {
    this.onInvoke(ulx);
    this.callIndex += 1;
    return { status: 200, body: {}, headers: {} };
  }

  async toUlxResponse(
    _payload: ProviderResponse,
    ulx: Request,
  ): Promise<Response> {
    const index = this.callIndex - 1;
    if (index === 0) {
      return {
        id: "resp-0",
        model: ulx.model,
        operation: ulx.operation,
        finish_reason: "stop",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "Done" }],
            status: "completed",
          },
        ],
      };
    }
    return {
      id: "resp-1",
      model: ulx.model,
      operation: ulx.operation,
      finish_reason: "tool_calls",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [],
          tool_calls: [
            {
              id: "finish",
              type: "function",
              name: DEFAULT_TERMINATION_TOOL_NAME,
              arguments: JSON.stringify({ summary: "All done" }),
            },
          ],
          status: "completed",
        },
      ],
    };
  }
}

function createRequest(overrides: Partial<Request> = {}): Request {
  return {
    id: "req",
    model: "model",
    operation: Operation.Chat,
    messages: [],
    tools: undefined,
    stream: false,
    state: {},
    parameters: {},
    metadata: { clientFormat: "openai.chat-completions", headers: {} },
    ...overrides,
  };
}
