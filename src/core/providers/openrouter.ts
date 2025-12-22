import { OpenRouter } from "@openrouter/sdk";
import { HTTPClient } from "@openrouter/sdk/lib/http.js";
import { type JsonObject, type JsonValue } from "../types.js";
import {
  ProviderAdapter,
  ProviderResponse,
  Request,
  Response,
} from "../types.js";
import {
  normalizeOpenAIProviderResponse,
  openAIResponseToUlx,
  toOpenAIMessages,
  toOpenAITool,
} from "./openai.js";
import {
  toProviderErrorBody,
  toProviderErrorStatus,
  toUlxErrorResponse,
} from "./shared.js";
import { createCapturingFetch } from "../../utils/httpCapture.js";

export interface OpenRouterProviderConfig {
  apiKey: string;
}

function toOpenRouterMessages(messages: Request["messages"]): JsonValue {
  const openAIMessages = toOpenAIMessages(messages);
  if (Array.isArray(openAIMessages)) {
    return openAIMessages.map((msg) => {
      const obj = msg as JsonObject;
      if (obj.role === "tool" && typeof obj.tool_call_id === "string") {
        const { tool_call_id, ...rest } = obj;
        return { ...rest, toolCallId: tool_call_id };
      }
      return msg;
    });
  }
  return openAIMessages;
}

export class OpenRouterProviderAdapter implements ProviderAdapter {
  key = "openrouter";
  providerFormat = "openrouter";

  constructor(private readonly config: OpenRouterProviderConfig) {}

  private resolveConfig(overrides?: JsonObject): OpenRouterProviderConfig {
    return {
      apiKey: (overrides?.apiKey as string) ?? this.config.apiKey,
    };
  }

  async invoke(
    request: Request,
    config?: JsonObject,
  ): Promise<ProviderResponse> {
    let payload: JsonObject | undefined;
    const cfg = this.resolveConfig(config);
    const { fetch: trackingFetch, interaction } = createCapturingFetch();

    const httpClient = new HTTPClient({ fetcher: trackingFetch });

    const client = new OpenRouter({
      apiKey: cfg.apiKey,
      httpClient,
    });

    try {
      payload = {
        model: request.model,
        messages: toOpenRouterMessages(request.messages),
        tools: request.tools?.map(toOpenAITool),
        stream: false,
        temperature: request.parameters.temperature,
        topP: request.parameters.top_p,
        maxTokens: request.parameters.max_tokens,
      };

      await client.chat.send(payload as never);
    } catch (error) {
      if (!interaction.response) {
        const status = toProviderErrorStatus(error);
        return {
          status,
          body: toProviderErrorBody(error),
          headers: {},
          requestBody: (interaction.request?.body
            ? interaction.request.body
            : payload) as unknown as JsonValue,
        };
      }
    }

    return {
      status: interaction.response?.status ?? 500,
      body: interaction.response?.body ?? {},
      headers: interaction.response?.headers ?? {},
      requestBody: (interaction.request?.body
        ? interaction.request.body
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

export interface OpenRouterConfig {
  apiKey: string;
  providers?: string;
  sort?: string;
  order?: string[];
  allowFallbacks?: boolean;
  modelShortcut?: string;
}

export interface OpenRouterModelConfig {
  baseUrl?: string;
  apiKey?: string;
  providers?: string;
  sort?: string;
  order?: string[];
  allowFallbacks?: boolean;
  modelShortcut?: string;
}
