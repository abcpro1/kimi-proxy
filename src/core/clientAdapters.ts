import { z } from "zod";
import { ClientFormat, type JsonValue } from "./types.js";
import { safeJsonString } from "./json.js";
import {
  ClientAdapter,
  ContentBlock,
  Operation,
  Request,
  Response,
  Tool,
  ToolCall,
  Message,
  Role,
} from "./types.js";
import {
  OpenAIChatCompletionRequestSchema,
  AnthropicMessagesRequestSchema,
  OpenAIResponsesRequestSchema,
  OpenAIChatCompletionResponseSchema,
  AnthropicMessagesResponseSchema,
  OpenAIResponsesResponseSchema,
  type OpenAIResponsesOutputItem,
  type AnthropicContentBlock,
  type ClientRequest,
} from "./schemas.js";

function stripTopLevelJsonSchemaMeta(
  schema: Record<string, JsonValue> | undefined,
): Record<string, JsonValue> | undefined {
  if (!schema) return undefined;
  if (!("$schema" in schema)) return schema;
  const sanitized = { ...schema };
  delete sanitized.$schema;
  return sanitized;
}

function normalizeTools(
  tools: z.infer<typeof OpenAIChatCompletionRequestSchema>["tools"],
): Tool[] | undefined {
  if (!tools) return undefined;
  return tools.map((tool) => {
    return {
      type: "function",
      name: tool.function.name,
      description: tool.function.description,
      strict: tool.function.strict,
      parameters: stripTopLevelJsonSchemaMeta(
        tool.function.parameters as Record<string, JsonValue> | undefined,
      ),
    };
  });
}

function normalizeOpenAIFunctions(
  functions: z.infer<typeof OpenAIChatCompletionRequestSchema>["functions"],
): Tool[] | undefined {
  if (!functions) return undefined;
  return functions.map((fn) => ({
    type: "function",
    name: fn.name,
    description: fn.description,
    strict: fn.strict,
    parameters: stripTopLevelJsonSchemaMeta(
      fn.parameters as Record<string, JsonValue> | undefined,
    ),
  }));
}

function normalizeOpenAIChatTools(
  request: z.infer<typeof OpenAIChatCompletionRequestSchema>,
): Tool[] | undefined {
  return (
    normalizeTools(request.tools) ?? normalizeOpenAIFunctions(request.functions)
  );
}

function normalizeAnthropicTools(
  tools: z.infer<typeof AnthropicMessagesRequestSchema>["tools"],
): Tool[] | undefined {
  if (!tools) return undefined;
  const normalized: Tool[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    if (!("input_schema" in tool)) continue;

    const typed = tool as {
      name?: unknown;
      description?: unknown;
      input_schema?: unknown;
    };

    if (typeof typed.name !== "string") continue;
    if (!typed.input_schema || typeof typed.input_schema !== "object") continue;

    normalized.push({
      type: "function",
      name: typed.name,
      description:
        typeof typed.description === "string" ? typed.description : undefined,
      strict: undefined,
      parameters: stripTopLevelJsonSchemaMeta(
        typed.input_schema as Record<string, JsonValue> | undefined,
      ),
    });
  }
  return normalized.length ? normalized : undefined;
}

function normalizeToolsResponses(
  tools: z.infer<typeof OpenAIResponsesRequestSchema>["tools"],
): Tool[] | undefined {
  if (!tools) return undefined;
  return tools.map((tool) => {
    if ("function" in tool) {
      return {
        type: "function",
        name: tool.function.name,
        description: tool.function.description,
        strict: tool.function.strict,
        parameters: stripTopLevelJsonSchemaMeta(
          tool.function.parameters as Record<string, JsonValue> | undefined,
        ),
      };
    } else {
      return {
        type: "function",
        name: tool.name,
        description: tool.description,
        strict: tool.strict,
        parameters: stripTopLevelJsonSchemaMeta(
          tool.parameters as Record<string, JsonValue> | undefined,
        ),
      };
    }
  });
}

function contentToText(content: ContentBlock[]): string | JsonValue {
  if (!content.length) return "";
  if (content.every((entry) => entry.type === "text")) {
    return content.map((entry) => entry.text ?? "").join("");
  }
  return content.map((entry) => {
    if (entry.type === "text") return { type: "text", text: entry.text };
    if (entry.type === "image_url")
      return { type: "image_url", image_url: entry.url };
    if (entry.type === "json") return { type: "json", data: entry.data };
    if (entry.type === "reasoning")
      return {
        type: "thinking",
        thinking: entry.text,
        signature: (entry.data as Record<string, unknown>)?.signature as string,
      };
    return entry;
  }) as JsonValue;
}

function usageToOpenAI(
  usage?: Response["usage"],
):
  | { prompt_tokens: number; completion_tokens: number; total_tokens: number }
  | undefined {
  if (!usage) return undefined;
  return {
    prompt_tokens: usage.input_tokens ?? 0,
    completion_tokens: usage.output_tokens ?? 0,
    total_tokens:
      usage.total_tokens ??
      (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
  };
}

export class OpenAIChatClientAdapter implements ClientAdapter {
  clientFormat = ClientFormat.OpenAIChatCompletions;

  toUlx(body: ClientRequest, headers: Record<string, string>): Request {
    const request = OpenAIChatCompletionRequestSchema.parse(body);

    const messages: Message[] = request.messages.map((message) => {
      const content: ContentBlock[] = [];
      if (typeof message.content === "string") {
        content.push({ type: "text", text: message.content });
      } else if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (typeof part.text === "string") {
            content.push({ type: "text", text: part.text });
            continue;
          }

          const imageUrl =
            typeof part.image_url === "string"
              ? part.image_url
              : typeof part.image_url === "object" && part.image_url !== null
                ? (part.image_url as { url?: string }).url
                : undefined;
          if (imageUrl) {
            content.push({ type: "image_url", url: imageUrl });
          }
        }
      }

      const toolCalls: ToolCall[] | undefined = message.tool_calls?.map(
        (tc) => ({
          id: tc.id,
          type: "function",
          name: tc.function.name,
          arguments: safeJsonString(tc.function.arguments),
        }),
      );

      const legacyFunctionCall =
        !toolCalls?.length && message.function_call
          ? message.function_call
          : null;

      const legacyToolCalls: ToolCall[] | undefined =
        legacyFunctionCall && typeof legacyFunctionCall.name === "string"
          ? [
              {
                id: legacyFunctionCall.name,
                type: "function",
                name: legacyFunctionCall.name,
                arguments: safeJsonString(legacyFunctionCall.arguments),
              },
            ]
          : undefined;

      return {
        role: message.role as Role,
        tool_call_id: message.tool_call_id,
        content,
        tool_calls: toolCalls?.length ? toolCalls : legacyToolCalls,
      };
    });

    return {
      id: "",
      model: request.model,
      operation: Operation.Chat,
      messages,
      tools: normalizeOpenAIChatTools(request),
      stream: request.stream ?? false,
      state: {},
      parameters: {
        temperature: request.temperature,
        top_p: request.top_p,
        max_tokens: request.max_completion_tokens ?? request.max_tokens,
      },
      metadata: { clientFormat: this.clientFormat, headers },
    } satisfies Request;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  fromUlx(ulxResponse: Response, _ulxRequest: Request): JsonValue {
    const contentBlocks = ulxResponse.output.find(
      (entry) => entry.type === "message",
    );

    let content: string | null = null;
    let reasoning_content: string | undefined = undefined;

    if (contentBlocks?.type === "message") {
      const textParts: string[] = [];
      const reasoningParts: string[] = [];

      for (const entry of contentBlocks.content) {
        if (entry.type === "text") {
          textParts.push(entry.text ?? "");
        } else if (entry.type === "reasoning") {
          reasoningParts.push(entry.text ?? "");
        }
      }

      if (textParts.length > 0) {
        content = textParts.join("");
      } else if (
        contentBlocks.content.some(
          (c) => c.type === "image_url" || c.type === "json",
        )
      ) {
        const mixed = contentToText(
          contentBlocks.content.filter((c) => c.type !== "reasoning"),
        );
        content = typeof mixed === "string" ? mixed : JSON.stringify(mixed);
      } else {
        content = null;
      }

      if (reasoningParts.length > 0) {
        reasoning_content = reasoningParts.join("\n\n");
      }
    }

    return {
      id: ulxResponse.id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: ulxResponse.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content,
            ...(reasoning_content ? { reasoning_content } : {}),
            tool_calls:
              contentBlocks?.type === "message" && contentBlocks.tool_calls
                ? contentBlocks.tool_calls.map((tc) => ({
                    id: tc.id,
                    type: "function",
                    function: {
                      name: tc.name,
                      arguments: tc.arguments,
                    },
                  }))
                : undefined,
          },
          finish_reason: ulxResponse.finish_reason ?? "stop",
        },
      ],
      usage: usageToOpenAI(ulxResponse.usage),
    } satisfies z.infer<typeof OpenAIChatCompletionResponseSchema> as JsonValue;
  }
}

export class AnthropicMessagesClientAdapter implements ClientAdapter {
  clientFormat = ClientFormat.AnthropicMessages;

  toUlx(body: ClientRequest, headers: Record<string, string>): Request {
    const request = AnthropicMessagesRequestSchema.parse(body);

    const messages: Message[] = [];

    function isRecord(value: unknown): value is Record<string, unknown> {
      return (
        Boolean(value) && typeof value === "object" && !Array.isArray(value)
      );
    }

    function anthropicSourceToUrl(source: unknown): string | undefined {
      if (!isRecord(source)) return undefined;

      if (typeof source.url === "string" && source.url) return source.url;

      const type = typeof source.type === "string" ? source.type : undefined;
      const mediaType =
        typeof source.media_type === "string" ? source.media_type : undefined;
      const data = typeof source.data === "string" ? source.data : undefined;

      if (type === "base64" && mediaType && data) {
        return `data:${mediaType};base64,${data}`;
      }

      if (type === "text" && mediaType && data) {
        return `data:${mediaType},${encodeURIComponent(data)}`;
      }

      return undefined;
    }

    function flushUserContent(blocks: ContentBlock[]) {
      if (!blocks.length) return;
      messages.push({
        role: "user",
        content: [...blocks],
        tool_calls: undefined,
      });
      blocks.length = 0;
    }

    function toolResultContentToText(content: unknown): string {
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        return content
          .map((entry) => {
            if (typeof entry === "string") return entry;
            if (!isRecord(entry)) return JSON.stringify(entry);

            if (typeof entry.text === "string") return entry.text;
            const url = anthropicSourceToUrl(entry.source);
            if (url) return url;

            return JSON.stringify(entry);
          })
          .join("");
      }

      if (content === undefined) return "";
      try {
        return JSON.stringify(content);
      } catch {
        return String(content);
      }
    }

    function flushAssistantMessage(
      content: ContentBlock[],
      toolCalls: ToolCall[],
    ) {
      if (!content.length && !toolCalls.length) return;
      messages.push({
        role: "assistant",
        content: [...content],
        tool_calls: toolCalls.length ? [...toolCalls] : undefined,
      });
      content.length = 0;
      toolCalls.length = 0;
    }

    function anthropicBlockToUlxContent(block: Record<string, unknown>) {
      const declaredType = typeof block.type === "string" ? block.type : "";
      if (
        declaredType === "thinking" ||
        declaredType === "redacted_thinking" ||
        typeof block.thinking === "string"
      ) {
        return undefined;
      }

      if (typeof block.text === "string") {
        return { type: "text" as const, text: block.text };
      }

      const url = anthropicSourceToUrl(block.source);
      const mediaType =
        isRecord(block.source) && typeof block.source.media_type === "string"
          ? block.source.media_type
          : undefined;

      const isImage =
        declaredType === "image" ||
        (typeof mediaType === "string" && mediaType.startsWith("image/"));

      if (url && isImage) {
        return { type: "image_url" as const, url };
      }

      if (url) {
        return { type: "text" as const, text: url };
      }

      return {
        type: "text" as const,
        text: JSON.stringify(block),
      };
    }

    for (const message of request.messages) {
      if (typeof message.content === "string") {
        messages.push({
          role: message.role as Role,
          content: [{ type: "text", text: message.content }],
          tool_calls: undefined,
        });
        continue;
      }

      if (message.role === "assistant") {
        const content: ContentBlock[] = [];
        const toolCalls: ToolCall[] = [];

        for (const part of message.content) {
          if (!isRecord(part)) continue;

          const toolUseId =
            typeof part.tool_use_id === "string" ? part.tool_use_id : undefined;
          if (toolUseId) {
            flushAssistantMessage(content, toolCalls);
            messages.push({
              role: "tool",
              tool_call_id: toolUseId,
              content: [
                {
                  type: "text",
                  text: toolResultContentToText(part.content),
                },
              ],
              tool_calls: undefined,
            });
            continue;
          }

          const id = typeof part.id === "string" ? part.id : undefined;
          const name = typeof part.name === "string" ? part.name : undefined;
          if (id && name) {
            toolCalls.push({
              id,
              type: "function",
              name,
              arguments: JSON.stringify(part.input ?? {}),
            });
            continue;
          }

          const normalized = anthropicBlockToUlxContent(part);
          if (normalized) content.push(normalized);
        }

        flushAssistantMessage(content, toolCalls);
        continue;
      }

      const bufferedUserContent: ContentBlock[] = [];
      for (const part of message.content) {
        if (!isRecord(part)) continue;

        const toolUseId =
          typeof part.tool_use_id === "string" ? part.tool_use_id : undefined;
        if (toolUseId) {
          flushUserContent(bufferedUserContent);
          messages.push({
            role: "tool",
            tool_call_id: toolUseId,
            content: [
              {
                type: "text",
                text: toolResultContentToText(part.content),
              },
            ],
            tool_calls: undefined,
          });
          continue;
        }

        const normalized = anthropicBlockToUlxContent(part);
        if (normalized) bufferedUserContent.push(normalized);
      }
      flushUserContent(bufferedUserContent);
    }

    const system = request.system;
    const systemArr = Array.isArray(system)
      ? system.map((s) => s.text)
      : system
        ? [system]
        : undefined;

    return {
      id: "",
      model: request.model,
      operation: Operation.Messages,
      system: systemArr,
      messages,
      tools: normalizeAnthropicTools(request.tools),
      stream: request.stream ?? false,
      state: {},
      parameters: {
        temperature: request.temperature,
        top_p: request.top_p,
        max_tokens: request.max_tokens,
        top_k: request.top_k,
        thinking: request.thinking,
        thinking_config: request.thinking_config,
      },
      metadata: { clientFormat: this.clientFormat, headers },
    } satisfies Request;
  }

  fromUlx(ulxResponse: Response): JsonValue {
    const contentBlocks = ulxResponse.output.find(
      (entry) => entry.type === "message",
    );

    const messageContent =
      contentBlocks?.type === "message"
        ? contentToText(contentBlocks.content)
        : "";

    const content: AnthropicContentBlock[] = [];
    if (typeof messageContent === "string") {
      if (messageContent) content.push({ type: "text", text: messageContent });
    } else if (Array.isArray(messageContent)) {
      for (const item of messageContent) {
        if (item && typeof item === "object") {
          const block = item as AnthropicContentBlock;
          if (block.type === "thinking") {
            content.push(block);
          } else if (block.type === "text") {
            content.push(block);
          }
        }
      }
    } else if (
      typeof messageContent === "object" &&
      messageContent !== null &&
      "text" in messageContent
    ) {
      content.push(messageContent as unknown as AnthropicContentBlock);
    }

    if (contentBlocks?.type === "message" && contentBlocks.tool_calls) {
      for (const tc of contentBlocks.tool_calls) {
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: JSON.parse(tc.arguments),
        });
      }
    }

    return {
      id: ulxResponse.id,
      type: "message",
      role: "assistant",
      model: ulxResponse.model,
      stop_reason:
        ulxResponse.finish_reason === "tool_calls"
          ? "tool_use"
          : ((ulxResponse.finish_reason as
              | "end_turn"
              | "max_tokens"
              | "stop_sequence") ?? "end_turn"),
      stop_sequence: null,
      usage: {
        input_tokens: ulxResponse.usage?.input_tokens ?? 0,
        output_tokens: ulxResponse.usage?.output_tokens ?? 0,
      },
      content: content,
    } satisfies z.infer<typeof AnthropicMessagesResponseSchema> as JsonValue;
  }
}

const OpenAIResponsesToolCallLikeSchema = z
  .object({
    id: z.string().optional(),
    type: z.string().optional(),
    function: z
      .object({
        name: z.string(),
        arguments: z.unknown().optional(),
      })
      .passthrough(),
  })
  .passthrough();

const OpenAIResponsesInputContentPartSchema = z
  .object({
    type: z.string().optional(),
    text: z.union([z.string(), z.number()]).optional(),
    image_url: z
      .union([
        z.string(),
        z.object({ url: z.string().optional() }).passthrough(),
      ])
      .optional(),
    file_url: z.string().optional(),
    file_id: z.string().nullable().optional(),
    file_data: z.string().optional(),
    filename: z.string().optional(),
    data: z.unknown().optional(),
  })
  .passthrough();

const OpenAIResponsesInputMessageLikeSchema = z
  .object({
    role: z.string(),
    content: z.union([z.string(), z.array(z.unknown())]).optional(),
    tool_calls: z.array(OpenAIResponsesToolCallLikeSchema).optional(),
    tool_call_id: z.string().optional(),
  })
  .passthrough();

const OpenAIResponsesInputFunctionCallLikeSchema = z
  .object({
    name: z.string(),
    arguments: z.unknown().optional(),
    call_id: z.string().optional(),
    callId: z.string().optional(),
    id: z.string().optional(),
  })
  .passthrough();

const OpenAIResponsesInputFunctionCallOutputLikeSchema = z
  .object({
    call_id: z.string().optional(),
    callId: z.string().optional(),
    output: z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.null(),
      z.array(z.unknown()),
      z.record(z.unknown()),
    ]),
  })
  .passthrough();

const OpenAIResponsesInputTextLikeSchema = z
  .object({
    text: z.union([z.string(), z.number()]),
  })
  .passthrough();

function normalizeOpenAIResponsesToolCalls(
  toolCalls: unknown,
): ToolCall[] | undefined {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return undefined;
  const normalized: ToolCall[] = [];

  for (const call of toolCalls) {
    const parsed = OpenAIResponsesToolCallLikeSchema.safeParse(call);
    if (!parsed.success) continue;
    const fn = parsed.data.function;
    const name = fn.name;
    const id =
      typeof parsed.data.id === "string" && parsed.data.id.length
        ? parsed.data.id
        : name;
    const args = safeJsonString(fn.arguments);

    normalized.push({ id, type: "function", name, arguments: args });
  }

  return normalized.length ? normalized : undefined;
}

function normalizeOpenAIResponsesMessageContent(
  content: unknown,
): ContentBlock[] {
  if (typeof content === "string") {
    return content.length ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];

  const blocks: ContentBlock[] = [];
  for (const entry of content) {
    const parsed = OpenAIResponsesInputContentPartSchema.safeParse(entry);
    if (!parsed.success) continue;

    const part = parsed.data;
    if (typeof part.text === "string" || typeof part.text === "number") {
      const text = String(part.text);
      if (text) blocks.push({ type: "text", text });
      continue;
    }

    const imageUrlValue = part.image_url;
    const imageUrl =
      typeof imageUrlValue === "string"
        ? imageUrlValue
        : typeof imageUrlValue === "object" && imageUrlValue !== null
          ? (imageUrlValue as { url?: string }).url
          : undefined;
    if (imageUrl) {
      blocks.push({ type: "image_url", url: imageUrl });
      continue;
    }

    if (part.type === "json") {
      blocks.push({ type: "json", data: part.data as JsonValue });
      continue;
    }

    const fileRef =
      (typeof part.file_url === "string" && part.file_url) ||
      (typeof part.file_id === "string" && part.file_id) ||
      (typeof part.file_data === "string" && part.file_data)
        ? JSON.stringify({
            type: part.type ?? "input_file",
            file_url: part.file_url,
            file_id: part.file_id,
            filename: part.filename,
          })
        : undefined;
    if (fileRef) {
      blocks.push({ type: "text", text: fileRef });
    }
  }

  return blocks;
}

export class OpenAIResponsesClientAdapter implements ClientAdapter {
  clientFormat = ClientFormat.OpenAIResponses;

  toUlx(body: ClientRequest, headers: Record<string, string>): Request {
    const request = OpenAIResponsesRequestSchema.parse(body);

    const messages: Message[] = request.messages
      ? request.messages.map((message) => {
          const content: ContentBlock[] = [];
          if (typeof message.content === "string") {
            content.push({ type: "text", text: message.content });
          } else if (Array.isArray(message.content)) {
            for (const part of message.content) {
              if (part.type === "text") {
                content.push({ type: "text", text: part.text });
              } else if (part.type === "image_url") {
                const url =
                  typeof part.image_url === "string"
                    ? part.image_url
                    : part.image_url.url;
                content.push({ type: "image_url", url });
              }
            }
          }

          const toolCalls: ToolCall[] | undefined = message.tool_calls?.map(
            (tc) => ({
              id: tc.id,
              type: "function",
              name: tc.function.name,
              arguments: safeJsonString(tc.function.arguments),
            }),
          );

          return {
            role: message.role as Role,
            tool_call_id: message.tool_call_id,
            content,
            tool_calls: toolCalls,
          };
        })
      : [];

    if (request.input) {
      if (typeof request.input === "string") {
        messages.push({
          role: "user",
          content: [{ type: "text", text: request.input }],
          tool_calls: undefined,
        });
      } else if (Array.isArray(request.input)) {
        const inputContent: ContentBlock[] = [];

        function flushInputContent() {
          if (inputContent.length === 0) return;
          messages.push({
            role: "user",
            content: [...inputContent],
            tool_calls: undefined,
          });
          inputContent.length = 0;
        }

        function appendToolCall(toolCall: ToolCall) {
          const last = messages[messages.length - 1];
          if (last && last.role === "assistant") {
            last.tool_calls = [...(last.tool_calls ?? []), toolCall];
            return;
          }

          messages.push({
            role: "assistant",
            content: [],
            tool_calls: [toolCall],
          });
        }

        for (const part of request.input) {
          if (typeof part === "string" || typeof part === "number") {
            const text = String(part);
            if (text) inputContent.push({ type: "text", text });
            continue;
          }

          const messageLike =
            OpenAIResponsesInputMessageLikeSchema.safeParse(part);
          if (messageLike.success) {
            flushInputContent();
            const role = messageLike.data.role as Role;
            const content = normalizeOpenAIResponsesMessageContent(
              messageLike.data.content,
            );
            const toolCalls = normalizeOpenAIResponsesToolCalls(
              messageLike.data.tool_calls,
            );

            messages.push({
              role,
              tool_call_id: messageLike.data.tool_call_id,
              content,
              tool_calls: toolCalls,
            });
            continue;
          }

          const functionCallOutputLike =
            OpenAIResponsesInputFunctionCallOutputLikeSchema.safeParse(part);
          if (functionCallOutputLike.success) {
            flushInputContent();
            const toolCallId =
              functionCallOutputLike.data.call_id ??
              functionCallOutputLike.data.callId ??
              "";

            const outputText =
              typeof functionCallOutputLike.data.output === "string"
                ? functionCallOutputLike.data.output
                : JSON.stringify(functionCallOutputLike.data.output ?? "");

            messages.push({
              role: "tool",
              tool_call_id: toolCallId,
              content: [{ type: "text", text: outputText }],
              tool_calls: undefined,
            });
            continue;
          }

          const functionCallLike =
            OpenAIResponsesInputFunctionCallLikeSchema.safeParse(part);
          if (functionCallLike.success) {
            flushInputContent();
            const callId =
              functionCallLike.data.call_id ??
              functionCallLike.data.callId ??
              functionCallLike.data.id ??
              functionCallLike.data.name;
            appendToolCall({
              id: callId,
              type: "function",
              name: functionCallLike.data.name,
              arguments: safeJsonString(functionCallLike.data.arguments),
            });
            continue;
          }

          const textLike = OpenAIResponsesInputTextLikeSchema.safeParse(part);
          if (textLike.success) {
            const text = String(textLike.data.text);
            if (text) inputContent.push({ type: "text", text });
            continue;
          }
        }

        flushInputContent();
      }
    }

    return {
      id: "",
      model: request.model,
      operation: Operation.Responses,
      messages,
      tools: normalizeToolsResponses(request.tools),
      stream: request.stream ?? false,
      state: {},
      parameters: {
        temperature: request.temperature,
        top_p: request.top_p,
      },
      metadata: {
        headers,
        clientFormat: this.clientFormat,
      },
    } satisfies Request;
  }

  fromUlx(ulxResponse: Response, ulxRequest: Request): JsonValue {
    const outputBlocks = ulxResponse.output;
    const output: OpenAIResponsesOutputItem[] = [];
    const textParts: string[] = [];

    const createdAt = Math.floor(Date.now() / 1000);

    let messageIndex = 0;
    let functionCallIndex = 0;
    let reasoningIndex = 0;

    for (const block of outputBlocks) {
      if (block.type === "message") {
        const messageId = `msg_${ulxResponse.id}_${messageIndex++}`;
        const status: "completed" | "incomplete" =
          block.status === "incomplete" ? "incomplete" : "completed";

        const content: Array<{
          type: "output_text";
          text: string;
          annotations: unknown[];
        }> = [];

        const reasoningContent: Array<{
          type: "reasoning_text";
          text: string;
        }> = [];

        for (const entry of block.content) {
          if (entry.type === "text") {
            const text = entry.text ?? "";
            textParts.push(text);
            content.push({ type: "output_text", text, annotations: [] });
          } else if (entry.type === "image_url") {
            const text = entry.url ?? "";
            if (text) {
              textParts.push(text);
            }
            content.push({ type: "output_text", text, annotations: [] });
          } else if (entry.type === "json") {
            const text = entry.data ? JSON.stringify(entry.data) : "";
            if (text) {
              textParts.push(text);
            }
            content.push({ type: "output_text", text, annotations: [] });
          } else if (entry.type === "reasoning") {
            reasoningContent.push({
              type: "reasoning_text",
              text: entry.text ?? "",
            });
          }
        }

        if (reasoningContent.length > 0) {
          output.push({
            type: "reasoning",
            id: `rsn_${ulxResponse.id}_${reasoningIndex++}`,
            status: "completed",
            content: reasoningContent,
            summary: [],
          });
        }

        output.push({
          type: "message",
          id: messageId,
          role: "assistant",
          content,
          status,
        });

        if (block.tool_calls) {
          for (const call of block.tool_calls) {
            output.push({
              type: "function_call",
              id: `fc_${ulxResponse.id}_${functionCallIndex++}`,
              call_id: call.id,
              name: call.name,
              arguments: call.arguments,
              status: "completed",
            });
          }
        }
      } else if (block.type === "tool_call") {
        output.push({
          type: "function_call",
          id: `fc_${ulxResponse.id}_${functionCallIndex++}`,
          call_id: block.call_id,
          name: block.name,
          arguments: block.arguments,
          status: block.status === "pending" ? "in_progress" : "completed",
        });
      } else if (block.type === "reasoning") {
        output.push({
          type: "reasoning",
          id: `rsn_${ulxResponse.id}_${reasoningIndex++}`,
          status: "completed",
          content: block.content
            .filter((entry) => entry.type === "reasoning")
            .map((entry) => ({
              type: "reasoning_text",
              text: entry.text ?? "",
            })),
          summary:
            block.summary?.map((entry) => ({
              type: "summary_text",
              text: entry.text ?? "",
            })) ?? [],
        });
      }
    }

    const inputTokens = ulxResponse.usage?.input_tokens ?? 0;
    const outputTokens = ulxResponse.usage?.output_tokens ?? 0;
    const totalTokens =
      ulxResponse.usage?.total_tokens ?? inputTokens + outputTokens;

    const responseStatus =
      ulxResponse.finish_reason === "length" ? "incomplete" : "completed";

    return {
      id: ulxResponse.id,
      object: "response",
      created_at: createdAt,
      status: responseStatus,
      error: null,
      incomplete_details:
        responseStatus === "incomplete"
          ? { reason: "max_output_tokens" }
          : null,
      instructions: null,
      metadata: {},
      model: ulxResponse.model,
      output,
      output_text: textParts.join(""),
      parallel_tool_calls: true,
      temperature: ulxRequest.parameters.temperature ?? null,
      tool_choice: "auto",
      top_p: ulxRequest.parameters.top_p ?? null,
      usage: {
        input_tokens: inputTokens,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: outputTokens,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: totalTokens,
      },
    } satisfies z.infer<typeof OpenAIResponsesResponseSchema> as JsonValue;
  }
}
