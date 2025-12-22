import OpenAI from "openai";
import { z } from "zod";
import {
  fixKimiResponse,
  type KimiFixMetadata,
} from "../../services/kimiFixer.js";
import { logger } from "../../utils/logger.js";
import { type JsonObject, type JsonValue } from "../types.js";
import {
  ContentBlock,
  Operation,
  ProviderAdapter,
  ProviderResponse,
  Request,
  Response,
  Role,
  Tool,
  ToolCall,
} from "../types.js";
import {
  safeJsonString,
  toProviderErrorBody,
  toProviderErrorStatus,
  toUlxErrorResponse,
} from "./shared.js";
import { createCapturingFetch } from "../../utils/httpCapture.js";

const OpenAIContentPartSchema = z
  .object({
    type: z.string().default("text"),
    text: z.string().optional(),
    image_url: z
      .union([z.string(), z.object({ url: z.string().optional() }).strict()])
      .optional(),
    data: z.unknown().optional(),
  })
  .passthrough();

const OpenAIToolCallSchema = z
  .object({
    id: z.string().optional(),
    type: z.literal("function").optional(),
    function: z
      .object({
        name: z.union([z.string(), z.number()]).transform(String),
        arguments: z.union([z.string(), z.record(z.unknown())]).optional(),
      })
      .passthrough(),
  })
  .passthrough();

const OpenAIMessageSchema = z
  .object({
    role: z.string(),
    content: z
      .union([z.string(), z.array(OpenAIContentPartSchema)])
      .nullable()
      .optional(),
    tool_calls: z.array(OpenAIToolCallSchema).nullable().optional(),
    reasoning_content: z.string().nullable().optional(),
  })
  .passthrough();

const OpenAIChoiceSchema = z
  .object({
    finish_reason: z.string().nullable().optional(),
    message: OpenAIMessageSchema,
  })
  .passthrough();

const OpenAIResponseSchema = z
  .object({
    id: z.string(),
    model: z.string(),
    choices: z.array(OpenAIChoiceSchema).default([]),
    usage: z
      .object({
        prompt_tokens: z.number().optional(),
        completion_tokens: z.number().optional(),
        total_tokens: z.number().optional(),
      })
      .partial()
      .optional(),
  })
  .passthrough();

type OpenAIParsedResponse = z.infer<typeof OpenAIResponseSchema>;

function normalizeToolCalls(
  toolCalls:
    | Array<{
        id?: string | null;
        function?: { name?: unknown; arguments?: unknown } | null;
      }>
    | null
    | undefined,
): ToolCall[] | undefined {
  if (!toolCalls?.length) return undefined;
  const normalized: ToolCall[] = [];
  for (const call of toolCalls) {
    const fn = call?.function;
    if (!fn || (typeof fn.name !== "string" && typeof fn.name !== "number"))
      continue;
    const name = String(fn.name);
    // default to rand id
    const id =
      typeof call.id === "string" && call.id.length
        ? call.id
        : `${name}_call_${Math.random().toString(36).substring(2, 10)}`;
    normalized.push({
      id,
      type: "function",
      name: name,
      arguments: safeJsonString(fn.arguments),
    });
  }
  return normalized.length ? normalized : undefined;
}

function normalizeOpenAIContent(content: unknown): ContentBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) return [];

  const blocks: ContentBlock[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const entry = part as Record<string, unknown>;
    const type = typeof entry.type === "string" ? entry.type : "text";
    if (type === "image_url") {
      const value = entry.image_url;
      const url =
        typeof value === "string"
          ? value
          : typeof value === "object" && value !== null
            ? (value as { url?: string }).url
            : undefined;
      if (url) {
        blocks.push({ type: "image_url", url });
      }
      continue;
    }
    if (type === "json") {
      blocks.push({ type: "json", data: entry.data as JsonValue });
      continue;
    }
    const text =
      typeof entry.text === "string"
        ? entry.text
        : typeof entry.data === "string"
          ? entry.data
          : "";
    blocks.push({ type: "text", text });
  }
  return blocks;
}

function openAIUsageToUlx(
  usage?: OpenAIParsedResponse["usage"],
): Response["usage"] {
  if (!usage) return undefined;
  const input = usage.prompt_tokens ?? undefined;
  const output = usage.completion_tokens ?? undefined;
  const total = usage.total_tokens ?? (input ?? 0) + (output ?? 0);
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: total,
  };
}

function toOpenAIContent(blocks: ContentBlock[]): string | JsonValue {
  if (blocks.every((entry) => entry.type === "text")) {
    return blocks.map((entry) => entry.text ?? "").join("");
  }

  return blocks.map((entry) => {
    if (entry.type === "text") return { type: "text", text: entry.text };
    if (entry.type === "image_url")
      return { type: "image_url", image_url: entry.url };
    if (entry.type === "json") return { type: "json", data: entry.data };
    return entry as JsonObject;
  }) as JsonValue;
}

export function toOpenAITool(tool: Tool): JsonObject {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: tool.strict,
    },
  };
}

export function toOpenAIMessages(messages: Request["messages"]): JsonValue {
  return messages.map((msg) => {
    if (msg.role === "tool") {
      return {
        role: "tool",
        tool_call_id: msg.tool_call_id,
        content: toOpenAIContent(msg.content),
      };
    }
    if (msg.tool_calls) {
      return {
        role: msg.role,
        content: toOpenAIContent(msg.content),
        tool_calls: msg.tool_calls.map((call) => ({
          id: call.id,
          type: "function",
          function: {
            name: call.name,
            arguments: call.arguments,
          },
        })),
      };
    }
    return {
      role: msg.role === "assistant" ? "assistant" : msg.role,
      content: toOpenAIContent(msg.content),
      name: undefined,
    };
  });
}

export function normalizeOpenAIProviderResponse(
  payload: ProviderResponse,
  request: Request,
): { body: OpenAIParsedResponse; kimi?: KimiFixMetadata } | { error: string } {
  const parsed = OpenAIResponseSchema.safeParse(payload.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]?.message ?? "Invalid provider payload";
    logger.error(
      { issues: parsed.error.issues },
      "Failed to parse OpenAI payload",
    );
    return { error: issue };
  }

  const cloned = structuredClone(parsed.data) as JsonObject;
  const { response, metadata } = fixKimiResponse(cloned, request);
  const normalized = OpenAIResponseSchema.safeParse(response);
  if (!normalized.success) {
    const issue =
      normalized.error.issues[0]?.message ??
      "Provider payload invalid after normalization";
    logger.error(
      { issues: normalized.error.issues },
      "OpenAI payload invalid after normalization",
    );
    return { error: issue };
  }

  return { body: normalized.data, kimi: metadata };
}

export function openAIResponseToUlx(
  body: OpenAIParsedResponse,
  request: Request,
  kimi?: KimiFixMetadata,
): Response {
  const [choice] = body.choices;
  const message = choice?.message;
  const contentBlocks = normalizeOpenAIContent(message?.content);
  const toolCalls = normalizeToolCalls(message?.tool_calls);

  const outputs: Response["output"] = [];
  outputs.push({
    type: "message",
    role: (message?.role as Role) ?? "assistant",
    content: contentBlocks,
    tool_calls: toolCalls,
    status: choice?.finish_reason === "length" ? "incomplete" : "completed",
  });

  if (typeof message?.reasoning_content === "string") {
    const text = message.reasoning_content.trim();
    if (text) {
      outputs.push({
        type: "reasoning",
        content: [{ type: "reasoning", text }],
        summary: [],
      });
    }
  }

  const response: Response = {
    id: body.id,
    model: body.model,
    operation: request.operation,
    finish_reason: choice?.finish_reason ?? undefined,
    output: outputs,
    usage: openAIUsageToUlx(body.usage),
    metadata: {
      providerResponse: body as unknown as JsonValue,
    },
  };

  if (toolCalls?.length && !response.finish_reason) {
    response.finish_reason = "tool_calls";
  }

  if (kimi) {
    response.metadata = {
      ...(response.metadata ?? {}),
      normalization: { kimi },
    };
  }

  return response;
}

export function buildOpenAIPayload(request: Request): JsonObject {
  return {
    model: request.model,
    messages: toOpenAIMessages(request.messages),
    tools: request.tools?.map(toOpenAITool),
    stream: false,
    temperature: request.parameters.temperature,
    top_p: request.parameters.top_p,
    top_k: request.parameters.top_k,
    max_tokens: request.parameters.max_tokens,
    response_format:
      request.operation === Operation.Responses ? { type: "text" } : undefined,
  };
}

export interface OpenAIProviderConfig {
  apiKey: string;
  baseUrl?: string;
}

export class OpenAIProviderAdapter implements ProviderAdapter {
  key = "openai";
  providerFormat = "openai";

  constructor(private readonly config: OpenAIProviderConfig) {}

  private resolveConfig(overrides?: JsonObject): OpenAIProviderConfig {
    return {
      apiKey: (overrides?.apiKey as string) ?? this.config.apiKey,
      baseUrl: (overrides?.baseUrl as string) ?? this.config.baseUrl,
    };
  }

  async invoke(
    request: Request,
    config?: JsonObject,
  ): Promise<ProviderResponse> {
    const cfg = this.resolveConfig(config);
    const { fetch: trackingFetch, interaction } = createCapturingFetch();
    const client = new OpenAI({
      apiKey: cfg.apiKey,
      baseURL: cfg.baseUrl,
      fetch: trackingFetch,
    });

    let payload: JsonObject | undefined;
    try {
      payload = buildOpenAIPayload(request);
      await client.chat.completions.create(
        payload as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParams,
      );
    } catch (error) {
      if (!interaction.response) {
        const status = toProviderErrorStatus(error);
        return {
          status,
          body: toProviderErrorBody(error),
          headers: {},
          requestBody: (interaction.request
            ? interaction.request
            : payload) as unknown as JsonValue,
        };
      }
    }

    return {
      status: interaction.response?.status ?? 500,
      body: interaction.response?.body ?? {},
      headers: interaction.response?.headers ?? {},
      requestBody: (interaction.request
        ? interaction.request
        : payload) as unknown as JsonValue,
    };
  }

  toUlxResponse(payload: ProviderResponse, request: Request): Response {
    if (payload.status >= 400) {
      return toUlxErrorResponse(payload, request);
    }

    const normalized = normalizeOpenAIProviderResponse(payload, request);
    if ("error" in normalized) {
      return {
        id: request.id,
        model: request.model,
        operation: request.operation,
        output: [],
        error: {
          message: normalized.error,
          code: "invalid_response",
        },
      };
    }

    return openAIResponseToUlx(normalized.body, request, normalized.kimi);
  }
}

export type OpenAIConfig = OpenAIProviderConfig;
export interface OpenAIModelConfig {
  baseUrl?: string;
  apiKey?: string;
}
