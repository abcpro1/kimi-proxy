import { fetch, type Response } from "undici";
import {
  ProviderFormat,
  ProxyOperation,
  ProviderResponsePayload,
  JsonValue,
  JsonObject,
} from "../types.js";
import { LLMProvider, ProviderInvokeArgs } from "./types.js";
import { logger } from "../../utils/logger.js";

export interface OpenRouterConfig {
  baseUrl: string;
  apiKey: string;
  /**
   * Comma-separated list of provider preferences.
   * Examples: "OpenAI", "Anthropic", "OpenAI,Anthropic"
   */
  providers?: string;
  /**
   * Selection strategy for providers.
   * Examples: "price", "throughput", "latency"
   */
  sort?: string;
  /**
   * Prioritized list of provider slugs (overrides sort).
   * Examples: ["anthropic", "openai"]
   */
  order?: string[];
  /**
   * Allow fallbacks to other providers (default: true)
   */
  allowFallbacks?: boolean;
  /**
   * Model slug shortcuts (e.g., ":nitro" for throughput, ":floor" for price)
   */
  modelShortcut?: string;
}

// Model-level configuration for OpenRouter provider
export interface OpenRouterModelConfig {
  baseUrl?: string;
  apiKey?: string;
  providers?: string;
  sort?: string;
  order?: string[];
  allowFallbacks?: boolean;
  modelShortcut?: string;
}

export class OpenRouterProvider implements LLMProvider {
  key = "openrouter";
  format = ProviderFormat.OpenAIChatCompletions;
  supportedOperations = [
    ProxyOperation.ChatCompletions,
    ProxyOperation.Messages,
    ProxyOperation.Responses,
  ];

  constructor(private readonly config: OpenRouterConfig) {}

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
          `Operation ${operation} is not supported by OpenRouter provider`,
        );
    }
  }

  private buildUrl(operation: ProxyOperation): string {
    const baseUrl = this.config.baseUrl;
    const path = this.resolvePath(operation);
    const url = `${baseUrl.replace(/\/+$/, "")}${path}`;

    return url;
  }

  private buildProviderBody(config: OpenRouterConfig): JsonObject {
    const provider: JsonObject = {};

    // Parse comma-separated providers into array if needed
    if (config.providers) {
      const providersList = config.providers
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      if (providersList.length > 0) {
        provider["order"] = providersList;
      }
    }

    // Use explicit order if provided
    if (config.order && config.order.length > 0) {
      provider["order"] = config.order;
    }

    if (config.sort) {
      provider["sort"] = config.sort;
    }

    if (typeof config.allowFallbacks === "boolean") {
      provider["allow_fallbacks"] = config.allowFallbacks;
    }

    return provider;
  }

  private mergeConfig(
    modelProviderConfig?: OpenRouterModelConfig,
  ): OpenRouterConfig {
    if (!modelProviderConfig) {
      return this.config;
    }

    const mergedConfig: OpenRouterConfig = {
      baseUrl:
        modelProviderConfig.baseUrl !== undefined
          ? modelProviderConfig.baseUrl
          : this.config.baseUrl,
      apiKey:
        modelProviderConfig.apiKey !== undefined
          ? modelProviderConfig.apiKey
          : this.config.apiKey,
    };

    // Only add optional properties if explicitly provided
    if (modelProviderConfig.providers !== undefined) {
      mergedConfig.providers = modelProviderConfig.providers;
    } else if (this.config.providers !== undefined) {
      mergedConfig.providers = this.config.providers;
    }

    if (modelProviderConfig.sort !== undefined) {
      mergedConfig.sort = modelProviderConfig.sort;
    } else if (this.config.sort !== undefined) {
      mergedConfig.sort = this.config.sort;
    }

    if (modelProviderConfig.order !== undefined) {
      mergedConfig.order = modelProviderConfig.order;
    } else if (this.config.order !== undefined) {
      mergedConfig.order = this.config.order;
    }

    if (modelProviderConfig.allowFallbacks !== undefined) {
      mergedConfig.allowFallbacks = modelProviderConfig.allowFallbacks;
    } else if (this.config.allowFallbacks !== undefined) {
      mergedConfig.allowFallbacks = this.config.allowFallbacks;
    }

    if (modelProviderConfig.modelShortcut !== undefined) {
      mergedConfig.modelShortcut = modelProviderConfig.modelShortcut;
    } else if (this.config.modelShortcut !== undefined) {
      mergedConfig.modelShortcut = this.config.modelShortcut;
    }

    return mergedConfig;
  }

  async invoke({
    request,
    body,
    headers,
    providerConfig: modelProviderConfig,
  }: ProviderInvokeArgs): Promise<ProviderResponsePayload> {
    const url = this.buildUrl(request.operation);

    // Merge base config with model-level overrides
    const mergedConfig = this.mergeConfig(modelProviderConfig);

    const upstreamHeaders = {
      Authorization: `Bearer ${mergedConfig.apiKey}`,
      "Content-Type": "application/json",
      ...(headers ?? {}),
    };

    // Merge provider configuration into request body
    const routerProviderConfig = this.buildProviderBody(mergedConfig);
    const bodyWithProvider: JsonObject =
      typeof body === "object" && body !== null && !Array.isArray(body)
        ? { ...body }
        : {};

    if (Object.keys(routerProviderConfig).length > 0) {
      bodyWithProvider["provider"] = routerProviderConfig;
    }

    // Handle model shortcuts (append to model name)
    if (
      mergedConfig.modelShortcut &&
      typeof bodyWithProvider["model"] === "string"
    ) {
      bodyWithProvider["model"] =
        `${bodyWithProvider["model"]}${mergedConfig.modelShortcut}`;
    }

    logger.debug(
      { url: url.toString(), provider: this.key, body: bodyWithProvider },
      "Making request to OpenRouter with routing parameters",
    );

    const response = await fetch(url, {
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify(bodyWithProvider),
    });

    const responseBody = await this.safeJson(response);

    if (!response.ok) {
      logger.warn(
        { status: response.status, provider: this.key, body: responseBody },
        "OpenRouter upstream returned non-200",
      );
    }

    return {
      status: response.status,
      body: responseBody,
      headers: Object.fromEntries(response.headers.entries()),
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
    });
    return this.safeJson(response);
  }
}
