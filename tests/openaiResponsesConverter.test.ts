import { describe, it, expect } from "vitest";
import {
  OpenAIResponsesPassthroughConverter,
  OpenAIChatPassthroughConverter,
} from "../src/core/converters/openaiPassthrough.js";
import {
  ClientFormat,
  ProxyOperation,
  ProviderFormat,
  type ConversionContext,
  type JsonObject,
  type JsonValue,
} from "../src/core/types.js";

function createConverter() {
  return new OpenAIResponsesPassthroughConverter();
}

function createContext(
  clientFormat: ClientFormat = ClientFormat.OpenAIResponses,
  operation: ProxyOperation = ProxyOperation.Responses,
): ConversionContext<JsonObject> {
  return {
    request: {
      id: "test",
      operation,
      clientFormat,
      model: "test-model",
      body: {},
      headers: {},
      stream: false,
      state: {},
    },
    providerFormat: ProviderFormat.OpenAIChatCompletions,
  };
}

function buildStreamPayload(chunks: JsonObject[]): string {
  return (
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
    "data: [DONE]\n\n"
  );
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("OpenAIChatPassthroughConverter", () => {
  it("reassembles streamed chat completions for logging", () => {
    const converter = new OpenAIChatPassthroughConverter();
    const chunk = (
      delta: JsonObject,
      finish_reason: string | null = null,
    ): JsonObject => ({
      id: "chatcmpl-stream",
      object: "chat.completion.chunk",
      created: 123,
      model: "gpt-test",
      choices: [
        {
          index: 0,
          delta,
          finish_reason,
        },
      ],
    });
    const streamPayload = buildStreamPayload([
      chunk({ role: "assistant" }),
      chunk({ content: "Hello" }),
      chunk({ content: " world" }),
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "lookup", arguments: '{"city":' },
          },
        ],
      }),
      chunk({
        tool_calls: [
          {
            index: 0,
            function: { arguments: '"Paris"}' },
          },
        ],
      }),
      chunk({}, "stop"),
    ]);

    const reconstructed = converter.convertResponse(
      streamPayload,
      createContext(
        ClientFormat.OpenAIChatCompletions,
        ProxyOperation.ChatCompletions,
      ),
    );

    expect(reconstructed.choices).toHaveLength(1);
    const [choice] = reconstructed.choices;
    expect(choice.message.content).toBe("Hello world");
    expect(choice.message.tool_calls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "lookup", arguments: '{"city":"Paris"}' },
      },
    ]);
    expect(choice.finish_reason).toBe("stop");
  });
});

describe("OpenAIResponsesPassthroughConverter", () => {
  it("merges instructions and input into chat messages", () => {
    const converter = createConverter();
    const requestBody = {
      instructions: "You are a helpful assistant.",
      messages: [{ role: "system", content: "Existing context" }],
      input: "Hello there",
    };

    const { body } = converter.convertRequest(requestBody, createContext());

    expect(body.messages).toEqual([
      { role: "system", content: "You are a helpful assistant." },
      { role: "system", content: "Existing context" },
      { role: "user", content: "Hello there" },
    ]);
    expect(body.instructions).toBeUndefined();
    expect(body.input).toBeUndefined();
  });

  it("converts input content blocks to chat-friendly formats", () => {
    const converter = createConverter();
    const requestBody = {
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "Describe the image" },
            {
              type: "input_image",
              image_url: { url: "https://example.com/cat.png" },
            },
          ],
        },
      ],
    };

    const { body } = converter.convertRequest(requestBody, createContext());

    expect(body.messages).toHaveLength(1);
    const [message] = body.messages;
    expect(Array.isArray(message.content)).toBe(true);
    expect(message.content).toEqual([
      { type: "text", text: "Describe the image" },
      { type: "image_url", image_url: { url: "https://example.com/cat.png" } },
    ]);
  });

  it("normalizes existing message arrays that contain input_* parts", () => {
    const converter = createConverter();
    const requestBody = {
      messages: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "Explain the code" },
            { type: "input_image", url: "https://example.com/chart.png" },
          ],
        },
      ],
    };

    const { body } = converter.convertRequest(requestBody, createContext());

    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Explain the code" },
          { type: "image_url", image_url: "https://example.com/chart.png" },
        ],
      },
    ]);
  });

  it("wraps assistant tool calls in function objects", () => {
    const converter = createConverter();
    const requestBody = {
      messages: [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_1",
              type: "tool_call",
              name: "shell",
              arguments: { command: ["pwd"] },
            },
          ],
        },
      ],
    };

    const { body } = converter.convertRequest(requestBody, createContext());

    expect(body.messages[0].tool_calls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: {
          name: "shell",
          arguments: JSON.stringify({ command: ["pwd"] }),
        },
      },
    ]);
  });

  it("normalizes tool definitions into OpenAI-compatible schema", () => {
    const converter = createConverter();
    const requestBody = {
      tools: [
        {
          type: "function",
          name: "shell",
          description: "Run shell commands",
          strict: false,
          parameters: {
            type: "object",
            properties: { command: { type: "array" } },
          },
        },
      ],
    };

    const { body } = converter.convertRequest(requestBody, createContext());

    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "shell",
          description: "Run shell commands",
          parameters: {
            type: "object",
            properties: { command: { type: "array" } },
          },
        },
        strict: false,
      },
    ]);
  });

  it("forces non-function tool types into function schema", () => {
    const converter = createConverter();
    const requestBody = {
      tools: [
        {
          type: "custom",
          function: {
            name: "web_search",
            description: "Search the web",
          },
        },
      ],
    };

    const { body } = converter.convertRequest(requestBody, createContext());

    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "web_search",
          description: "Search the web",
        },
      },
    ]);
  });

  it("drops tool entries that lack a function name", () => {
    const converter = createConverter();
    const requestBody = {
      tools: [
        {
          type: "function",
          description: "Missing name",
        },
      ],
    };

    const { body } = converter.convertRequest(requestBody, createContext());

    expect(body.tools).toBeUndefined();
  });

  it("produces response output blocks with tool calls and text content", () => {
    const converter = createConverter();
    const upstreamResponse = {
      id: "chatcmpl-test",
      created: 123,
      model: "gpt-test",
      choices: [
        {
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "Hello" },
              { type: "text", text: " world!" },
            ],
            tool_calls: [
              {
                id: "tool_1",
                type: "function",
                function: { name: "lookup", arguments: '{"city":"Paris"}' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    };

    const converted = converter.convertResponse(upstreamResponse);

    expect(converted.object).toBe("response");
    expect(converted.status).toBe("completed");
    expect(converted.output).toHaveLength(2);
    const [messageOutput, functionCallOutput] = converted.output;
    expect(messageOutput.type).toBe("message");
    expect(messageOutput.role).toBe("assistant");
    expect(messageOutput.content).toEqual([
      { type: "output_text", text: "Hello" },
      { type: "output_text", text: " world!" },
    ]);
    expect(functionCallOutput).toMatchObject({
      type: "function_call",
      name: "lookup",
      call_id: "tool_1",
      arguments: '{"city":"Paris"}',
    });
    expect(converted.output_text).toEqual(["Hello", " world!"]);
    expect(converted.usage).toEqual({
      input_tokens: 5,
      output_tokens: 3,
      total_tokens: 8,
    });
  });

  it("parses streaming payloads before mapping to responses schema", () => {
    const converter = createConverter();
    const chunk = (
      delta: JsonObject,
      finish_reason: string | null = null,
    ): JsonObject => ({
      id: "chatcmpl-stream",
      object: "chat.completion.chunk",
      created: 456,
      model: "gpt-test",
      choices: [
        {
          index: 0,
          delta,
          finish_reason,
        },
      ],
    });
    const streamPayload = buildStreamPayload([
      chunk({ role: "assistant" }),
      chunk({ content: "Streamed " }),
      chunk({ content: "response" }),
      chunk({}, "stop"),
    ]);

    const converted = converter.convertResponse(streamPayload);

    expect(converted.status).toBe("completed");
    expect(converted.output_text).toEqual(["Streamed response"]);
    expect(converted.output[0].content[0]).toEqual({
      type: "output_text",
      text: "Streamed response",
    });
  });

  it("creates reasoning outputs with empty summary placeholder", () => {
    const converter = createConverter();
    const upstreamResponse = {
      id: "chatcmpl-thinking",
      created: 456,
      model: "gpt-think",
      choices: [
        {
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Final answer" }],
            reasoning_content: [
              { type: "text", text: "First thought." },
              { type: "text", text: "Second thought." },
            ],
          },
        },
      ],
    };

    const converted = converter.convertResponse(upstreamResponse);
    const reasoningOutput = converted.output.find(
      (entry): entry is JsonObject =>
        typeof entry === "object" &&
        entry !== null &&
        "type" in entry &&
        (entry as JsonObject).type === "reasoning",
    );

    expect(reasoningOutput).toBeTruthy();
    expect(reasoningOutput.summary).toEqual([]);
    expect(reasoningOutput.content).toEqual([
      { type: "reasoning_text", text: "First thought." },
      { type: "reasoning_text", text: "Second thought." },
    ]);
  });

  it("normalizes usage fields when upstream only includes prompt/completion tokens", () => {
    const converter = createConverter();
    const upstreamResponse = {
      id: "chatcmpl-usage",
      created: 789,
      model: "gpt-usage",
      usage: {
        prompt_tokens: 10,
        completion_tokens: 4,
        total_tokens: 14,
      },
      choices: [
        {
          finish_reason: "stop",
          message: { role: "assistant", content: "Usage test" },
        },
      ],
    };

    const converted = converter.convertResponse(upstreamResponse);
    expect(converted.usage).toEqual({
      input_tokens: 10,
      output_tokens: 4,
      total_tokens: 14,
    });
  });

  it("marks message outputs completed for stop/tool_calls reasons", () => {
    const converter = createConverter();
    const upstreamResponse = {
      id: "chatcmpl-status",
      created: 987,
      model: "gpt-status",
      choices: [
        {
          finish_reason: "stop",
          message: { role: "assistant", content: "Done" },
        },
        {
          finish_reason: "length",
          message: { role: "assistant", content: "Truncated" },
        },
      ],
    };

    const converted = converter.convertResponse(upstreamResponse);
    const statuses = converted.output
      .filter(
        (entry): entry is JsonObject =>
          isJsonObject(entry) && entry.type === "message",
      )
      .map((entry) => entry.status);
    expect(statuses).toEqual(["completed", "incomplete"]);
  });

  it("converts response-style content blocks back to chat-friendly schema", () => {
    const converter = createConverter();
    const requestBody = {
      messages: [
        {
          role: "user",
          content: [
            { type: "output_text", text: "Legacy text" },
            { type: "output_image", image_url: "https://example.com/img.png" },
            { type: "reasoning_text", text: "internal note" },
          ],
        },
      ],
    };

    const { body } = converter.convertRequest(requestBody, createContext());
    expect(body.messages[0].content).toEqual([
      { type: "text", text: "Legacy text" },
      { type: "image_url", image_url: "https://example.com/img.png" },
      { type: "text", text: "internal note" },
    ]);
  });
});
