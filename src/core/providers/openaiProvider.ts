import { fetch, type Response } from "undici";
import {
  ProviderFormat,
  ProxyOperation,
  ProviderResponsePayload,
  JsonValue,
} from "../types.js";
import { LLMProvider, ProviderInvokeArgs } from "./types.js";
import { logger } from "../../utils/logger.js";

export interface OpenAIConfig {
  baseUrl: string;
  apiKey: string;
}

// Model-level configuration for OpenAI provider
export interface OpenAIModelConfig {
  baseUrl?: string;
  apiKey?: string;
}

export class OpenAIProvider implements LLMProvider {
  key = "openai";
  format = ProviderFormat.OpenAIChatCompletions;
  supportedOperations = [
    ProxyOperation.ChatCompletions,
    ProxyOperation.Messages,
    ProxyOperation.Responses,
  ];

  constructor(private readonly config: OpenAIConfig) {}

  private resolvePath(operation: ProxyOperation): string {
    switch (operation) {
      case ProxyOperation.ChatCompletions:
        return "/v1/chat/completions";
      case ProxyOperation.Messages:
        return "/v1/messages";
      case ProxyOperation.Responses:
        return "/v1/responses";
      default:
        throw new Error(
          `Operation ${operation} is not supported by OpenAI provider`,
        );
    }
  }

  async invoke({
    request,
    body,
    headers,
    providerConfig,
  }: ProviderInvokeArgs): Promise<ProviderResponsePayload> {
    // Resolve configuration with model-level overrides
    const config = this.resolveConfig(providerConfig);

    const url = new URL(this.resolvePath(request.operation), config.baseUrl);
    const upstreamHeaders = {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      ...(headers ?? {}),
    };

    const response = await fetch(url, {
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });

    const responseBody = await this.safeJson(response);

    if (!response.ok) {
      logger.warn(
        { status: response.status, provider: this.key, body: responseBody },
        "OpenAI upstream returned non-200",
      );
    }

    return {
      status: response.status,
      body: responseBody,
      headers: Object.fromEntries(response.headers.entries()),
    };
  }

  private resolveConfig(providerConfig?: OpenAIModelConfig): OpenAIConfig {
    if (!providerConfig) {
      return this.config;
    }

    return {
      baseUrl: providerConfig.baseUrl ?? this.config.baseUrl,
      apiKey: providerConfig.apiKey ?? this.config.apiKey,
    };
  }

  private async safeJson(response: Response): Promise<JsonValue> {
    try {
      return (await response.json()) as JsonValue;
    } catch {
      return (await response.text()) as JsonValue;
    }
  }

  async listModels(): Promise<JsonValue> {
    const url = new URL("/v1/models", this.config.baseUrl);
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
      signal: AbortSignal.timeout(120000),
    });
    return this.safeJson(response);
  }
}
