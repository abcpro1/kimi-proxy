import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SignatureCache } from "../src/persistence/signatureCache.js";
import { AnthropicMessagesClientAdapter } from "../src/ulx/clientAdapters.js";
import { AnthropicProviderAdapter } from "../src/ulx/providers/anthropic.js";
import { VertexProviderAdapter } from "../src/ulx/providers/vertex.js";
import { UlxOperation, type UlxRequest } from "../src/ulx/types.js";

describe("request conversion fidelity", () => {
  it("AnthropicMessagesClientAdapter preserves tool_result blocks", () => {
    const adapter = new AnthropicMessagesClientAdapter();
    const ulx = adapter.toUlx(
      {
        model: "claude-test",
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "call_1",
                name: "doThing",
                input: { x: 1 },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "call_1",
                content: '{"ok":true}',
              },
              { type: "text", text: "thanks" },
            ],
          },
        ],
      },
      {},
    );

    expect(ulx.messages).toHaveLength(3);
    expect(ulx.messages[0]).toMatchObject({
      role: "assistant",
      tool_calls: [
        {
          id: "call_1",
          name: "doThing",
          arguments: '{"x":1}',
        },
      ],
    });

    expect(ulx.messages[1]).toMatchObject({
      role: "tool",
      tool_call_id: "call_1",
    });
    expect(ulx.messages[1].content[0]?.text).toBe('{"ok":true}');

    expect(ulx.messages[2]).toMatchObject({ role: "user" });
    expect(ulx.messages[2].content[0]?.text).toBe("thanks");
  });

  it("AnthropicMessagesClientAdapter strips $schema from tool schemas", () => {
    const adapter = new AnthropicMessagesClientAdapter();
    const ulx = adapter.toUlx(
      {
        model: "claude-test",
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            name: "doThing",
            description: "does the thing",
            input_schema: {
              $schema: "http://json-schema.org/draft-07/schema#",
              type: "object",
              properties: { x: { type: "number" } },
              required: ["x"],
            },
          },
        ],
        max_tokens: 16,
      },
      {},
    );

    expect(ulx.tools?.[0]?.parameters).toEqual({
      type: "object",
      properties: { x: { type: "number" } },
      required: ["x"],
    });
  });

  it("AnthropicProviderAdapter maps tool calls/results into tool_use/tool_result", () => {
    const adapter = new AnthropicProviderAdapter({ apiKey: "test" });

    const ulx: UlxRequest = {
      id: "req-1",
      model: "claude-test",
      operation: UlxOperation.Chat,
      messages: [
        { role: "system", content: [{ type: "text", text: "sys" }] },
        { role: "user", content: [{ type: "text", text: "hi" }] },
        {
          role: "assistant",
          content: [{ type: "text", text: "calling" }],
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              name: "doThing",
              arguments: '{"x":1}',
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_1",
          content: [{ type: "text", text: '{"ok":true}' }],
        },
      ],
      tools: [
        {
          type: "function",
          name: "doThing",
          description: "does the thing",
          parameters: { type: "object" },
        },
      ],
      stream: false,
      state: {},
      parameters: {},
      metadata: { clientFormat: "openai.chat-completions", headers: {} },
    };

    const payload = (
      adapter as unknown as {
        buildAnthropicPayload: (ulx: UlxRequest) => Record<string, unknown>;
      }
    ).buildAnthropicPayload(ulx);

    expect(payload.system).toBe("sys");
    expect(payload.messages).toHaveLength(3);

    const assistant = (payload.messages as Array<Record<string, unknown>>)[1];
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toEqual([
      { type: "text", text: "calling" },
      { type: "tool_use", id: "call_1", name: "doThing", input: { x: 1 } },
    ]);

    const toolResult = (payload.messages as Array<Record<string, unknown>>)[2];
    expect(toolResult.role).toBe("user");
    expect(toolResult.content).toEqual([
      { type: "tool_result", tool_use_id: "call_1", content: '{"ok":true}' },
    ]);
  });

  it("VertexProviderAdapter maps tool calls/results into functionCall/functionResponse", () => {
    const adapter = new VertexProviderAdapter();

    const ulx: UlxRequest = {
      id: "req-1",
      model: "gemini-test",
      operation: UlxOperation.Chat,
      messages: [
        { role: "system", content: [{ type: "text", text: "sys" }] },
        { role: "user", content: [{ type: "text", text: "hi" }] },
        {
          role: "assistant",
          content: [{ type: "text", text: "calling" }],
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              name: "doThing",
              arguments: '{"x":1}',
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_1",
          content: [{ type: "text", text: '{"ok":true}' }],
        },
      ],
      tools: [],
      stream: false,
      state: {},
      parameters: {},
      metadata: { clientFormat: "openai.chat-completions", headers: {} },
    };

    const contents = (
      adapter as unknown as {
        toVertexContents: (messages: UlxRequest["messages"]) => Array<{
          role: string;
          parts: Array<Record<string, unknown>>;
        }>;
      }
    ).toVertexContents(ulx.messages);

    expect(contents).toHaveLength(3);
    expect(contents[0]?.role).toBe("user");

    const functionCallPart = contents[1]?.parts.find(
      (part) => typeof part.functionCall === "object" && part.functionCall,
    );
    expect(contents[1]?.role).toBe("model");
    expect(functionCallPart?.functionCall).toEqual({
      name: "doThing",
      args: { x: 1 },
    });

    const functionResponsePart = contents[2]?.parts.find(
      (part) =>
        typeof part.functionResponse === "object" && part.functionResponse,
    );
    expect(contents[2]?.role).toBe("user");
    expect(functionResponsePart?.functionResponse).toEqual({
      name: "doThing",
      response: { name: "doThing", content: { ok: true } },
    });
  });

  it("VertexProviderAdapter groups parallel tool results into one user content", () => {
    const adapter = new VertexProviderAdapter();

    const messages: UlxRequest["messages"] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            name: "toolA",
            arguments: '{"a":1}',
          },
          {
            id: "call_2",
            type: "function",
            name: "toolB",
            arguments: '{"b":2}',
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: [{ type: "text", text: '{"okA":true}' }],
      },
      {
        role: "tool",
        tool_call_id: "call_2",
        content: [{ type: "text", text: '{"okB":true}' }],
      },
    ];

    const contents = (
      adapter as unknown as {
        toVertexContents: (
          messages: UlxRequest["messages"],
          model?: string,
        ) => Array<{
          role: string;
          parts: Array<Record<string, unknown>>;
        }>;
      }
    ).toVertexContents(messages);

    expect(contents).toHaveLength(3);
    expect(contents[0]?.role).toBe("user");
    expect(contents[1]?.role).toBe("model");
    expect(contents[2]?.role).toBe("user");
    expect(contents[2]?.parts).toHaveLength(2);

    expect(contents[2]?.parts[0]?.functionResponse).toEqual({
      name: "toolA",
      response: { name: "toolA", content: { okA: true } },
    });
    expect(contents[2]?.parts[1]?.functionResponse).toEqual({
      name: "toolB",
      response: { name: "toolB", content: { okB: true } },
    });
  });

  it("VertexProviderAdapter reapplies Gemini thought signatures for tool calls", () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "sig-cache-"));
    const signatureCache = new SignatureCache(cacheDir);
    const adapter = new VertexProviderAdapter(undefined, signatureCache);

    const ulxRequest: UlxRequest = {
      id: "req-1",
      model: "google/gemini-3-pro-preview",
      operation: UlxOperation.Chat,
      messages: [],
      tools: [],
      stream: false,
      state: {},
      parameters: {},
      metadata: { clientFormat: "openai.chat-completions", headers: {} },
    };

    const ulxResponse = (
      adapter as unknown as {
        vertexResponseToUlx: (
          body: Record<string, unknown>,
          ulx: UlxRequest,
        ) => { output: Array<Record<string, unknown>> };
      }
    ).vertexResponseToUlx(
      {
        candidates: [
          {
            finishReason: "STOP",
            content: {
              parts: [
                {
                  functionCall: { name: "doThing", args: { x: 1 } },
                  thoughtSignature: "SIG_A",
                },
              ],
            },
          },
        ],
      },
      ulxRequest,
    );

    const toolCallId =
      (ulxResponse.output[0] as { tool_calls?: Array<{ id: string }> })
        .tool_calls?.[0]?.id ?? "";
    expect(toolCallId).toBe("call_req-1_0");

    const messages: UlxRequest["messages"] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        tool_calls: [
          {
            id: toolCallId,
            type: "function",
            name: "doThing",
            arguments: '{"x":1}',
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: toolCallId,
        content: [{ type: "text", text: '{"ok":true}' }],
      },
    ];

    const contents = (
      adapter as unknown as {
        toVertexContents: (
          messages: UlxRequest["messages"],
          model?: string,
        ) => Array<{
          role: string;
          parts: Array<Record<string, unknown>>;
        }>;
      }
    ).toVertexContents(messages, "google/gemini-3-pro-preview");

    const functionCallPart = contents[1]?.parts.find(
      (part) => typeof part.functionCall === "object" && part.functionCall,
    );
    expect(functionCallPart?.thoughtSignature).toBe("SIG_A");

    signatureCache.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });
});
