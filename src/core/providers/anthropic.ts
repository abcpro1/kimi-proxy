import Anthropic from "@anthropic-ai/sdk";
import type { MessageCreateParams } from "@anthropic-ai/sdk/resources/messages/messages.js";
import { z } from "zod";
import { type JsonObject, type JsonValue } from "../types.js";
import { safeJsonParseObject } from "../json.js";
import {
  ContentBlock,
  ProviderAdapter,
  ProviderResponse,
  Request,
  Response,
  ToolCall,
} from "../types.js";
import {
  toProviderErrorBody,
  toProviderErrorStatus,
  toUlxErrorResponse,
} from "./shared.js";
import { createCapturingFetch } from "../../utils/httpCapture.js";

const AnthropicContentSchema = z
  .object({
    type: z.string(),
    text: z.string().optional(),
  })
  .passthrough();

const AnthropicResponseSchema = z
  .object({
    id: z.string(),
    model: z.string(),
    content: z.array(AnthropicContentSchema).default([]),
    stop_reason: z.string().nullable().optional(),
    usage: z
      .object({
        input_tokens: z.number().optional(),
        output_tokens: z.number().optional(),
      })
      .partial()
      .optional(),
  })
  .passthrough();

type AnthropicParsedResponse = z.infer<typeof AnthropicResponseSchema>;

function ulxContentToText(blocks: ContentBlock[]): string {
  if (!blocks.length) return "";
  return blocks
    .map((entry) => {
      if (entry.type === "text") return entry.text ?? "";
      if (entry.type === "image_url") return entry.url ?? "";
      if (entry.type === "json")
        return entry.data ? JSON.stringify(entry.data) : "";
      return String((entry as JsonObject).text ?? "");
    })
    .join("");
}

function toolCallsToAnthropic(toolCalls: ToolCall[] | undefined): JsonObject[] {
  if (!toolCalls?.length) return [];
  return toolCalls
    .filter((call) => call && call.name && call.id)
    .map((call) => ({
      type: "tool_use",
      id: call.id,
      name: call.name,
      input: safeJsonParseObject(call.arguments),
    }));
}

function toAnthropicContent(blocks: ContentBlock[]): JsonObject[] {
  if (!blocks.length) return [{ type: "text", text: "" }];
  return blocks.map((entry) => {
    if (entry.type === "text") return { type: "text", text: entry.text ?? "" };
    if (entry.type === "image_url")
      if (typeof entry.url === "string") {
        const match = entry.url.match(/^data:([^;]+);base64,(.+)$/);
        if (match?.[1] && match?.[2]) {
          return {
            type: "image",
            source: {
              type: "base64",
              media_type: match[1],
              data: match[2],
            },
          } as JsonObject;
        }
        return { type: "text", text: entry.url };
      }
    if (entry.type === "json")
      return { type: "text", text: JSON.stringify(entry.data) };
    return { type: "text", text: String((entry as JsonObject).text ?? "") };
  });
}

function anthropicResponseToUlx(
  body: AnthropicParsedResponse,
  request: Request,
): Response {
  const reasoning = body.content.filter((entry) => entry.type === "thinking");
  const messageBlocks = body.content.filter(
    (entry) => entry.type !== "thinking",
  );

  const outputs: Response["output"] = [
    {
      type: "message",
      role: "assistant",
      content: messageBlocks.map((part) => ({
        type: "text",
        text: part.text ?? "",
      })),
      status: body.stop_reason === "max_tokens" ? "incomplete" : "completed",
    },
  ];

  if (reasoning.length) {
    outputs.push({
      type: "reasoning",
      content: reasoning.map((part) => ({
        type: "reasoning",
        text: part.text ?? "",
      })),
      summary: [],
    });
  }

  return {
    id: body.id,
    model: body.model,
    operation: request.operation,
    finish_reason: body.stop_reason ?? undefined,
    output: outputs,
    usage: body.usage
      ? {
          input_tokens: body.usage.input_tokens,
          output_tokens: body.usage.output_tokens,
          total_tokens:
            (body.usage.input_tokens ?? 0) + (body.usage.output_tokens ?? 0),
        }
      : undefined,
    metadata: {
      providerResponse: body as unknown as JsonValue,
    },
  };
}

export interface AnthropicProviderConfig {
  apiKey: string;
  baseUrl?: string;
}

export class AnthropicProviderAdapter implements ProviderAdapter {
  key = "anthropic";
  providerFormat = "anthropic";

  constructor(private readonly config: AnthropicProviderConfig) {}

  private resolveConfig(overrides?: JsonObject): AnthropicProviderConfig {
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
    const client = new Anthropic({
      apiKey: cfg.apiKey,
      baseURL: cfg.baseUrl,
      fetch: trackingFetch,
    });

    let payload: MessageCreateParams | undefined;
    try {
      payload = this.buildAnthropicPayload(request);
      await client.messages.create(payload);
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

    const parsed = AnthropicResponseSchema.safeParse(payload.body);
    if (!parsed.success) {
      return {
        id: request.id,
        model: request.model,
        operation: request.operation,
        output: [],
        error: {
          message:
            parsed.error.issues[0]?.message ??
            "Invalid provider response payload",
          code: "invalid_response",
        },
      };
    }

    return anthropicResponseToUlx(parsed.data, request);
  }

  private buildAnthropicPayload(request: Request): MessageCreateParams {
    const systemParts: string[] = [];
    if (request.system?.length) systemParts.push(...request.system);

    const messages: Array<{ role: "user" | "assistant"; content: unknown }> =
      [];

    for (const message of request.messages) {
      if (message.role === "system" || message.role === "developer") {
        const text = ulxContentToText(message.content);
        if (text) systemParts.push(text);
        continue;
      }

      if (message.role === "tool") {
        if (message.tool_call_id) {
          messages.push({
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: message.tool_call_id,
                content: ulxContentToText(message.content),
              },
            ],
          });
          continue;
        }

        messages.push({
          role: "user",
          content: toAnthropicContent(message.content),
        });
        continue;
      }

      const role: "user" | "assistant" =
        message.role === "assistant" ? "assistant" : "user";

      let content = toAnthropicContent(message.content);
      if (role === "assistant") {
        const toolUses = toolCallsToAnthropic(message.tool_calls);
        if (toolUses.length) {
          if (
            content.length === 1 &&
            content[0]?.type === "text" &&
            content[0]?.text === ""
          ) {
            content = [];
          }
          content = [...content, ...toolUses];
        }
      }

      messages.push({ role, content });
    }

    return {
      model: request.model,
      messages,
      system: systemParts.length ? systemParts.join("\n") : undefined,
      stream: false,
      temperature: request.parameters.temperature,
      top_p: request.parameters.top_p,
      max_tokens: request.parameters.max_tokens,
      tools: request.tools?.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: (tool.parameters as JsonObject) ?? {},
        type: "function",
      })),
    } as unknown as MessageCreateParams;
  }
}
