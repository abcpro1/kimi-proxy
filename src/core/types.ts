import { z } from "zod";
import {
  OpenAIChatCompletionRequestSchema,
  AnthropicMessagesRequestSchema,
  OpenAIResponsesRequestSchema,
  type ClientRequest,
} from "./schemas.js";

export enum ClientFormat {
  OpenAIChatCompletions = "openai.chat-completions",
  AnthropicMessages = "anthropic.messages",
  OpenAIResponses = "openai.responses",
}

export enum ProviderFormat {
  OpenAIChatCompletions = "openai.chat-completions",
  VertexChatCompletions = "vertex.chat-completions",
  OpenRouterChatCompletions = "openrouter.chat-completions",
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonArray = JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue | undefined;
}
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

export function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export enum Operation {
  Chat = "chat",
  Messages = "messages",
  Responses = "responses",
}

export type Role = string;

export const ContentSchema = z.object({
  type: z.enum(["text", "image_url", "json", "reasoning", "metadata", "blob"]),
  text: z.string().optional(),
  data: z.custom<JsonValue>().optional(),
  url: z.string().optional(),
  mime: z.string().optional(),
});

export type ContentBlock = z.infer<typeof ContentSchema> & {
  data?: JsonValue;
};

export const ToolCallSchema = z.object({
  id: z.string(),
  type: z.literal("function"),
  name: z.string(),
  arguments: z.string().default("{}"),
});

export type ToolCall = z.infer<typeof ToolCallSchema>;

export const MessageSchema = z.object({
  role: z.string(),
  tool_call_id: z.string().optional(),
  content: z.array(ContentSchema).default([]),
  tool_calls: z.array(ToolCallSchema).optional(),
  annotations: z.record(z.unknown()).optional(),
  thinking: z.union([z.string(), z.array(ContentSchema)]).optional(),
});

export type Message = z.infer<typeof MessageSchema>;

export const ToolSchema = z.object({
  type: z.literal("function"),
  name: z.string(),
  description: z.string().optional(),
  strict: z.boolean().optional(),
  parameters: z.record(z.custom<JsonValue>()).optional(),
});

export type Tool = z.infer<typeof ToolSchema>;

export const UsageSchema = z.object({
  input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative().optional(),
  total_tokens: z.number().int().nonnegative().optional(),
});

export type Usage = z.infer<typeof UsageSchema>;

export const RequestSchema = z.object({
  id: z.string(),
  model: z.string(),
  profile: z.string().optional(),
  operation: z.nativeEnum(Operation),
  system: z.array(z.string()).optional(),
  messages: z.array(MessageSchema),
  tools: z.array(ToolSchema).optional(),
  stream: z.boolean().default(false),
  state: z.record(z.custom<JsonValue>()).default({}),
  parameters: z
    .object({
      temperature: z.number().optional(),
      top_p: z.number().optional(),
      top_k: z.number().optional(),
      max_tokens: z.number().optional(),
      thinking: z.unknown().optional(),
      thinking_config: z.unknown().optional(),
    })
    .partial()
    .default({}),
  metadata: z
    .object({
      headers: z.record(z.string()).default({}),
      clientFormat: z.string(),
      providerFormat: z.string().optional(),
      clientRequest: z
        .union([
          OpenAIChatCompletionRequestSchema,
          AnthropicMessagesRequestSchema,
          OpenAIResponsesRequestSchema,
        ])
        .optional(),
    })
    .default({ clientFormat: "", headers: {} }),
});

export type Request = z.infer<typeof RequestSchema>;

export const OutputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message"),
    role: z.string(),
    content: z.array(ContentSchema).default([]),
    tool_calls: z.array(ToolCallSchema).optional(),
    status: z.string().optional(),
  }),
  z.object({
    type: z.literal("tool_call"),
    call_id: z.string(),
    name: z.string(),
    arguments: z.string(),
    status: z.string().optional(),
  }),
  z.object({
    type: z.literal("reasoning"),
    content: z.array(ContentSchema).default([]),
    summary: z.array(ContentSchema).default([]),
  }),
  z.object({
    type: z.literal("delta"),
    content: z.array(ContentSchema).default([]),
  }),
]);

export type OutputBlock = z.infer<typeof OutputSchema>;

export const ResponseSchema = z.object({
  id: z.string(),
  model: z.string(),
  operation: z.nativeEnum(Operation),
  output: z.array(OutputSchema).default([]),
  usage: UsageSchema.optional(),
  finish_reason: z.string().optional(),
  error: z
    .object({
      message: z.string(),
      code: z.string().optional(),
    })
    .optional(),
  metadata: z
    .object({
      provider: z.string().optional(),
      providerFormat: z.string().optional(),
      clientFormat: z.string().optional(),
      providerResponse: z.unknown().optional(),
      requestHeaders: z.record(z.string()).optional(),
      normalization: z.record(z.unknown()).optional(),
      synthetic: z.boolean().optional(),
    })
    .optional(),
});

export type Response = z.infer<typeof ResponseSchema>;

export interface Envelope {
  request: Request;
  response?: Response;
}

export interface TransformContext {
  request: Request;
  response?: Response;
}

export interface Transform {
  name: string;
  stage: "ingress" | "egress";
  priority?: number;
  applies(context: TransformContext): boolean;
  transform(context: TransformContext): Promise<void> | void;
}

export interface ProviderRequest {
  body: JsonValue;
  headers: Record<string, string>;
}

export interface ProviderResponse {
  status: number;
  body: JsonValue;
  headers: Record<string, string>;
  requestBody?: JsonValue;
}

export interface ProviderAdapter {
  key: string;
  providerFormat: string;
  invoke(request: Request, config?: JsonObject): Promise<ProviderResponse>;
  toUlxResponse(
    payload: ProviderResponse,
    request: Request,
  ): Promise<Response> | Response;
}

export interface ClientAdapter {
  clientFormat: string;
  toUlx(body: ClientRequest, headers: Record<string, string>): Request;
  fromUlx(response: Response, request: Request): JsonValue;
}

export interface PipelineResult {
  request: Request;
  response: Response;
  providerResponse: ProviderResponse;
  providerAdapter: string;
  clientResponse: JsonValue;
}

export type Json = JsonValue;

export const isMessage = (value: unknown): value is Message =>
  MessageSchema.safeParse(value).success;
