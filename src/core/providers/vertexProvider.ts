import { fetch, type Response } from "undici";
import {
  GoogleAuth,
  type GoogleAuthOptions,
  type JWTInput,
} from "google-auth-library";
import {
  ProviderFormat,
  ProxyOperation,
  ProviderResponsePayload,
  ProxyRequest,
  JsonValue,
  JsonObject,
} from "../types.js";
import { LLMProvider, ProviderInvokeArgs } from "./types.js";
import { logger } from "../../utils/logger.js";

const VERTEX_SCOPES = ["https://www.googleapis.com/auth/cloud-platform"];
const GLOBAL_VERTEX_HOST = "https://aiplatform.googleapis.com";
const MAAS_MODEL_PATTERN = /\/.*-maas$/i;
const GEMINI3_MODELS = new Set([
  "gemini-3-pro-preview",
  "google/gemini-3-pro-preview",
]);

export interface VertexConfig {
  projectId: string;
  location: string;
  endpointOverride?: string;
  credentialsPath?: string;
  credentials?: JWTInput;
}

// Model-level configuration for Vertex provider
export interface VertexModelConfig {
  projectId?: string;
  location?: string;
  endpointOverride?: string;
  credentialsPath?: string;
  credentials?: JWTInput;
}

export class VertexMaaSProvider implements LLMProvider {
  key = "vertex";
  format = ProviderFormat.OpenAIChatCompletions;
  supportedOperations = [
    ProxyOperation.ChatCompletions,
    ProxyOperation.Messages,
    ProxyOperation.Responses,
  ];

  private auth: GoogleAuth;

  constructor(private readonly config: VertexConfig) {
    const authOptions: GoogleAuthOptions = { scopes: VERTEX_SCOPES };
    if (config.credentialsPath) {
      authOptions.keyFilename = config.credentialsPath;
    } else if (config.credentials) {
      authOptions.credentials = config.credentials;
    }
    this.auth = new GoogleAuth(authOptions);
  }

  async invoke({
    request,
    body,
    headers,
    providerConfig,
  }: ProviderInvokeArgs): Promise<ProviderResponsePayload> {
    let providerBody: JsonValue = body;
    let bodyModel: string | undefined;

    if (isJsonObject(body)) {
      providerBody = { ...body };
      const candidate = body.model;
      if (typeof candidate === "string") {
        bodyModel = candidate;
      }
    }

    const normalizedModel = this.normalizeModelId(
      bodyModel ?? this.extractModelFromState(request),
    );
    if (normalizedModel && isJsonObject(providerBody)) {
      providerBody.model = normalizedModel;
    }

    // Merge base config with model-level overrides
    const config = this.mergeConfig(
      providerConfig as Partial<VertexModelConfig> | undefined,
    );

    const upstreamHeaders = await this.buildHeaders(headers, config);
    const endpoint = this.resolveEndpoint(normalizedModel, config);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify(providerBody),
      signal: AbortSignal.timeout(120000),
    });

    const responseBody = await this.safeJson(response);
    if (!response.ok) {
      logger.warn(
        { status: response.status, provider: this.key, body: responseBody },
        "Vertex AI MaaS upstream returned non-200",
      );
    }

    return {
      status: response.status,
      body: responseBody,
      headers: Object.fromEntries(response.headers.entries()),
    };
  }

  private async safeJson(response: Response): Promise<JsonValue> {
    const text = await response.text();
    try {
      return JSON.parse(text) as JsonValue;
    } catch {
      return text as JsonValue;
    }
  }

  private async buildHeaders(
    extra: Record<string, string> | undefined,
    config: VertexConfig,
  ) {
    const token = await this.getAccessToken(config);
    return {
      "Content-Type": "application/json",
      ...(extra ?? {}),
      Authorization: `Bearer ${token}`,
    };
  }

  private async getAccessToken(config: VertexConfig): Promise<string> {
    const token = await this.buildAuth(config).getAccessToken();
    if (!token) {
      throw new Error("Unable to acquire access token for Vertex AI MaaS");
    }
    return token;
  }

  private buildAuth(cfg: VertexConfig): GoogleAuth {
    const authOptions: GoogleAuthOptions = { scopes: VERTEX_SCOPES };
    if (cfg.credentialsPath) {
      authOptions.keyFilename = cfg.credentialsPath;
    } else if (cfg.credentials) {
      authOptions.credentials = cfg.credentials;
    }
    return new GoogleAuth(authOptions);
  }

  private mergeConfig(modelConfig?: Partial<VertexModelConfig>): VertexConfig {
    const merged: VertexConfig = {
      projectId: this.config.projectId,
      location: this.config.location,
      endpointOverride: this.config.endpointOverride,
      credentialsPath: this.config.credentialsPath,
      credentials: this.config.credentials,
    };

    if (!modelConfig) return merged;

    if (typeof modelConfig.projectId === "string")
      merged.projectId = modelConfig.projectId;
    if (typeof modelConfig.location === "string")
      merged.location = modelConfig.location;
    if (typeof modelConfig.endpointOverride === "string")
      merged.endpointOverride = modelConfig.endpointOverride;
    if (typeof modelConfig.credentialsPath === "string")
      merged.credentialsPath = modelConfig.credentialsPath;
    if (modelConfig.credentials) merged.credentials = modelConfig.credentials;

    return merged;
  }

  private resolveEndpoint(
    model: string | undefined,
    config: VertexConfig,
  ): string {
    if (config.endpointOverride) {
      return config.endpointOverride;
    }

    if (model) {
      const location = this.requiresGlobalLocation(model)
        ? "global"
        : config.location;
      if (this.shouldUseGlobalHost(model) || location === "global") {
        return this.buildEndpoint(GLOBAL_VERTEX_HOST, location);
      }
    }

    return this.buildEndpoint(
      `https://${config.location}-aiplatform.googleapis.com`,
      config.location,
    );
  }

  private buildEndpoint(host: string, location: string): string {
    return `${host}/v1/projects/${this.config.projectId}/locations/${location}/endpoints/openapi/chat/completions`;
  }

  private shouldUseGlobalHost(model: string): boolean {
    return MAAS_MODEL_PATTERN.test(model) || GEMINI3_MODELS.has(model);
  }

  private requiresGlobalLocation(model: string): boolean {
    return GEMINI3_MODELS.has(model);
  }

  private normalizeModelId(model?: string): string | undefined {
    if (!model) {
      return undefined;
    }
    if (GEMINI3_MODELS.has(model)) {
      return "google/gemini-3-pro-preview";
    }
    return model;
  }

  private extractModelFromState(
    request: ProxyRequest<JsonValue>,
  ): string | undefined {
    const resolvedModel = request.state?.resolvedModel;
    if (!isJsonObject(resolvedModel)) {
      return undefined;
    }
    const upstreamModel = resolvedModel.upstreamModel;
    return typeof upstreamModel === "string" ? upstreamModel : undefined;
  }
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
