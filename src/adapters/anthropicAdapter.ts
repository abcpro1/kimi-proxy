import { Buffer } from "node:buffer";
import type { JsonObject, JsonValue } from "../core/types.js";

export interface AnthropicContentBlock extends JsonObject {
  type: "thinking" | "text" | "tool_use" | "tool_result";
  thinking?: string;
  text?: string;
  signature?: string;
  id?: string;
  name?: string;
  input?: JsonObject;
  tool_use_id?: string;
  content?: string | Array<JsonObject>;
  is_error?: boolean;
}

export interface AnthropicToolDefinition extends JsonObject {
  name: string;
  description?: string;
  input_schema: JsonObject;
}

export interface AnthropicCustomToolChoice extends JsonObject {
  type: string;
  name?: string;
}

export type AnthropicToolChoice =
  | { type: "auto" }
  | { type: "tool"; name: string }
  | AnthropicCustomToolChoice;

export interface AnthropicMessageRequest extends JsonObject {
  model: string;
  messages: Array<{ role: string; content: string | AnthropicContentBlock[] }>;
  system?: string | AnthropicContentBlock[];
  tools?: AnthropicToolDefinition[];
  tool_choice?: AnthropicToolChoice;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}

export interface AnthropicMessageResponse extends JsonObject {
  id: string;
  type: "message";
  role: "assistant";
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

export interface OpenAIChatMessagePart extends JsonObject {
  type: string;
  text?: string;
}

export interface OpenAIChatRequest extends JsonObject {
  model: string;
  messages: Array<{
    role: string;
    content: string | OpenAIChatMessagePart[];
    tool_calls?: OpenAIToolCall[];
    tool_call_id?: string;
  }>;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  tools?: OpenAIToolDefinition[];
  tool_choice?: OpenAIToolChoice;
}

export interface OpenAIUsage extends JsonObject {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface OpenAIReasoningBlock extends JsonObject {
  text?: string;
  thinking?: string;
  signature?: string;
}

export interface OpenAIFunctionCall extends JsonObject {
  name: string;
  arguments: string;
}

export interface OpenAIToolCall extends JsonObject {
  id?: string;
  type: "function";
  function?: OpenAIFunctionCall;
}

export interface OpenAIChatMessage extends JsonObject {
  role?: string;
  content?: string | OpenAIChatMessagePart[];
  reasoning_content?: string | OpenAIReasoningBlock[];
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  reasoning_summary?: Array<{ type: string; text: string }> | string;
  metadata?: JsonObject;
  refusal?: { text?: string; reason?: string; content?: JsonValue };
}

export interface OpenAIToolDefinition extends JsonObject {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: JsonObject;
  };
  strict?: boolean;
  format?: string;
}

export type OpenAIToolChoice =
  | "auto"
  | {
      type: "function";
      function: { name: string };
    };

export interface OpenAIChatResponse extends JsonObject {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    message: OpenAIChatMessage;
    finish_reason: string;
    index: number;
  }>;
  usage?: OpenAIUsage;
}

export function anthropicToOpenAIRequest(
  request: AnthropicMessageRequest,
): OpenAIChatRequest {
  const openaiMessages: OpenAIChatRequest["messages"] = [];

  if (request.system) {
    if (typeof request.system === "string") {
      openaiMessages.push({ role: "system", content: request.system });
    } else if (Array.isArray(request.system)) {
      const content = request.system
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("\n");
      openaiMessages.push({ role: "system", content });
    }
  }

  for (const msg of request.messages ?? []) {
    const { role, content } = msg;

    if (Array.isArray(content)) {
      const textBlocks = content.filter((b) => b.type === "text");
      const textContent = textBlocks.map((b) => b.text ?? "").join("");

      if (role === "assistant") {
        const toolUses = content.filter((b) => b.type === "tool_use");
        const toolCalls: OpenAIToolCall[] = toolUses.map((u) => ({
          id: u.id,
          type: "function",
          function: {
            name: u.name ?? "",
            arguments: JSON.stringify(u.input ?? {}),
          },
        }));

        const message: OpenAIChatRequest["messages"][0] = {
          role,
          content: textContent,
        };
        if (toolCalls.length > 0) {
          (message as OpenAIChatMessage).tool_calls = toolCalls;
        }
        openaiMessages.push(message);
      } else if (role === "user") {
        const toolResults = content.filter((b) => b.type === "tool_result");

        // 1. Emit tool results as separate 'tool' messages
        for (const res of toolResults) {
          let resultContent = "";
          if (typeof res.content === "string") {
            resultContent = res.content;
          } else if (Array.isArray(res.content)) {
            resultContent = res.content
              .map((b) =>
                typeof b.text === "string" ? b.text : JSON.stringify(b),
              )
              .join("");
          }

          openaiMessages.push({
            role: "tool", // OpenAI uses 'tool' role for function results
            content: resultContent,
            tool_call_id: res.tool_use_id,
          });
        }

        // 2. Emit the user text as a 'user' message
        if (textContent || toolResults.length === 0) {
          if (textContent) {
            openaiMessages.push({ role, content: textContent });
          }
        }
      } else {
        openaiMessages.push({ role, content: textContent });
      }
    } else {
      openaiMessages.push({ role, content });
    }
  }

  const tools: OpenAIToolDefinition[] = (request.tools ?? []).map(
    (tool): OpenAIToolDefinition => ({
      type: "function",
      function: {
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        parameters: tool.input_schema,
      },
    }),
  );

  const openaiReq: OpenAIChatRequest = {
    model: request.model,
    messages: openaiMessages,
    stream: request.stream ?? false,
    temperature: request.temperature ?? 1,
    max_tokens: request.max_tokens ?? 4096,
  };

  if (tools.length) {
    openaiReq.tools = tools;
    if (request.tool_choice) {
      if (request.tool_choice.type === "auto") {
        openaiReq.tool_choice = "auto";
      } else if (
        request.tool_choice.type === "tool" &&
        typeof request.tool_choice.name === "string"
      ) {
        openaiReq.tool_choice = {
          type: "function",
          function: { name: request.tool_choice.name },
        };
      }
    }
  }

  return openaiReq;
}

export function openaiToAnthropicResponse(
  openaiResp: OpenAIChatResponse,
): AnthropicMessageResponse {
  const [choice] = openaiResp.choices;
  const message: OpenAIChatMessage = choice.message ?? {};
  const contentBlocks: AnthropicContentBlock[] = [];

  const reasoning = message.reasoning_content;
  const reasoningSignature = Buffer.from("signature_placeholder").toString(
    "base64",
  );
  if (typeof reasoning === "string" && reasoning.trim()) {
    contentBlocks.push({
      type: "thinking",
      thinking: reasoning,
      signature: reasoningSignature,
    });
  } else if (Array.isArray(reasoning)) {
    for (const block of reasoning) {
      const thought =
        typeof block.thinking === "string"
          ? block.thinking
          : typeof block.text === "string"
            ? block.text
            : undefined;
      if (thought) {
        contentBlocks.push({
          type: "thinking",
          thinking: thought,
          signature: block.signature ?? reasoningSignature,
        });
      }
    }
  }

  const textContent = message.content;
  if (typeof textContent === "string" && textContent.trim()) {
    contentBlocks.push({ type: "text", text: textContent.trim() });
  } else if (Array.isArray(textContent)) {
    for (const part of textContent) {
      if (part.type === "text" && typeof part.text === "string") {
        contentBlocks.push({ type: "text", text: part.text });
      }
    }
  }

  const toolCalls = message.tool_calls;
  let stopReason = "end_turn";
  if (Array.isArray(toolCalls) && toolCalls.length) {
    stopReason = "tool_use";
    for (const toolCall of toolCalls) {
      let parsedArgs: JsonObject;
      try {
        parsedArgs = JSON.parse(
          toolCall.function?.arguments ?? "{}",
        ) as JsonObject;
      } catch {
        parsedArgs = { raw_arguments: toolCall.function?.arguments };
      }
      contentBlocks.push({
        type: "tool_use",
        id: toolCall.id,
        name: toolCall.function?.name,
        input: parsedArgs,
      });
    }
  }

  let responseId = openaiResp.id ?? "";
  if (!responseId.startsWith("msg_")) {
    responseId = `msg_${responseId}`;
  }

  return {
    id: responseId,
    type: "message",
    role: "assistant",
    content: contentBlocks,
    model: openaiResp.model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: openaiResp.usage?.prompt_tokens ?? 0,
      output_tokens: openaiResp.usage?.completion_tokens ?? 0,
    },
  };
}
