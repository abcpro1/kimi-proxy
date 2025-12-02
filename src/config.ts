import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import YAML from "yaml";
import type { JWTInput } from "google-auth-library";
import {
  OpenAIConfig,
  type OpenAIModelConfig,
} from "./core/providers/openaiProvider.js";
import {
  OpenRouterConfig,
  type OpenRouterModelConfig,
} from "./core/providers/openRouterProvider.js";
import {
  VertexConfig,
  type VertexModelConfig,
} from "./core/providers/vertexProvider.js";
import {
  LoadBalancingStrategy,
  ModelDefinition,
} from "./core/modelRegistry.js";

dotenv.config();

export interface AppConfig {
  server: {
    host: string;
    port: number;
  };
  logging: {
    dbPath: string;
  };
  streaming: {
    delay: number;
    chunkSize: number;
  };
  providers: {
    openai?: OpenAIConfig;
    openrouter?: OpenRouterConfig;
    vertex?: VertexConfig;
  };
  models: {
    definitions: ModelDefinition[];
    defaultStrategy: LoadBalancingStrategy;
  };
}

function resolveOpenAI(): OpenAIConfig | undefined {
  const baseUrl = process.env.OPENAI_BASE_URL;
  const apiKey = process.env.OPENAI_API_KEY;
  if (baseUrl && apiKey) {
    return { baseUrl, apiKey };
  }
  return undefined;
}

function resolveOpenRouter(): OpenRouterConfig | undefined {
  const baseUrl = process.env.OPENROUTER_BASE_URL;
  const apiKey = process.env.OPENROUTER_API_KEY;

  // Only configure OpenRouter if API key is provided
  if (!apiKey) {
    return undefined;
  }

  const config: OpenRouterConfig = {
    // For baseUrl, use explicit value if provided, otherwise use OpenRouter's default
    baseUrl: baseUrl || "https://openrouter.ai/api",
    apiKey,
  };

  // Only include parameters if explicitly set via env vars
  // (no fallbacks for these - they must be explicitly defined)
  const providers = process.env.OPENROUTER_PROVIDERS;
  if (providers) {
    config.providers = providers;
  }

  const order = process.env.OPENROUTER_ORDER;
  if (order) {
    config.order = order
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
  }

  const sort = process.env.OPENROUTER_SORT;
  if (sort) {
    config.sort = sort;
  }

  const allowFallbacks = process.env.OPENROUTER_ALLOW_FALLBACKS;
  if (allowFallbacks) {
    config.allowFallbacks = allowFallbacks.toLowerCase() === "true";
  }

  const modelShortcut = process.env.OPENROUTER_MODEL_SHORTCUT;
  if (modelShortcut) {
    config.modelShortcut = modelShortcut;
  }

  return config;
}

function resolveVertex(): VertexConfig | undefined {
  const projectId = process.env.VERTEX_PROJECT_ID;
  const location = process.env.VERTEX_LOCATION;
  const rawCredentials = process.env.GOOGLE_APPLICATION_CREDENTIALS;

  if (!projectId || !location || !rawCredentials) {
    return undefined;
  }

  const credentialInfo = parseGoogleCredentials(rawCredentials);

  return {
    projectId,
    location,
    endpointOverride: process.env.VERTEX_CHAT_ENDPOINT,
    ...credentialInfo,
  };
}

function parseGoogleCredentials(value: string): {
  credentialsPath?: string;
  credentials?: JWTInput;
} {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("GOOGLE_APPLICATION_CREDENTIALS is set but empty");
  }
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as JWTInput;
      return { credentials: parsed };
    } catch (error) {
      throw new Error(
        `Failed to parse GOOGLE_APPLICATION_CREDENTIALS JSON: ${(error as Error).message}`,
      );
    }
  }
  return { credentialsPath: trimmed };
}

export function loadConfig(): AppConfig {
  const host = process.env.HOST ?? "0.0.0.0";
  const port = Number(process.env.PORT ?? "8000");
  const dbPath =
    process.env.LOG_DB_PATH ?? path.resolve(process.cwd(), "data", "logs.db");
  const streamDelay = Number(process.env.STREAM_DELAY ?? "10");
  const streamChunkSize = Number(process.env.STREAM_CHUNK_SIZE ?? "5");

  const openai = resolveOpenAI();
  const openrouter = resolveOpenRouter();
  const vertex = resolveVertex();

  if (!openai && !openrouter && !vertex) {
    throw new Error(
      "At least one provider (OpenAI, OpenRouter, or Vertex) must be configured",
    );
  }

  const configuredProviders = new Set<string>();
  if (openai) {
    configuredProviders.add("openai");
  }
  if (openrouter) {
    configuredProviders.add("openrouter");
  }
  if (vertex) {
    configuredProviders.add("vertex");
  }

  const modelRegistry = parseModelRegistryConfig();

  return {
    server: { host, port },
    logging: { dbPath },
    streaming: { delay: streamDelay, chunkSize: streamChunkSize },
    providers: { openai, openrouter, vertex },
    models: modelRegistry,
  };
}

const loadBalancingStrategySchema = z
  .enum(["first", "round_robin", "random", "weighted_random"])
  .default("first");

const modelDefinitionSchema = z.object({
  name: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  weight: z.number().optional(),
  strategy: loadBalancingStrategySchema.optional(),
  ensure_tool_call: z.boolean().optional(),
  profile: z.string().optional(),
  provider_config: z.record(z.unknown()).optional(),
});

const modelRegistrySchema = z.object({
  default_strategy: loadBalancingStrategySchema.optional(),
  models: z.array(modelDefinitionSchema).min(1),
});

function parseModelRegistryConfig(): {
  definitions: ModelDefinition[];
  defaultStrategy: LoadBalancingStrategy;
} {
  const rawConfig = loadModelConfigText();
  let rawParsed: unknown;
  try {
    rawParsed = YAML.parse(rawConfig);
  } catch (error) {
    throw new Error(
      `Failed to parse model configuration YAML: ${(error as Error).message}`,
    );
  }
  let parsed;
  try {
    parsed = modelRegistrySchema.parse(rawParsed);
  } catch (error) {
    throw new Error(
      `Invalid model registry config: ${(error as Error).message}`,
    );
  }
  const definitions: ModelDefinition[] = parsed.models.map((entry) => ({
    name: entry.name,
    provider: entry.provider,
    upstreamModel: entry.model,
    weight: entry.weight,
    strategy: entry.strategy,
    ensureToolCall: entry.ensure_tool_call,
    profile: entry.profile,
    providerConfig: entry.provider_config,
  }));
  for (const def of definitions) {
    validateModelProviderConfig(def);
  }
  return {
    definitions,
    defaultStrategy: parsed.default_strategy ?? "first",
  };
}

function loadModelConfigText(): string {
  const inline = process.env.MODEL_CONFIG;
  if (inline && inline.trim()) {
    return inline;
  }

  const configPath =
    process.env.MODEL_CONFIG_PATH ??
    path.resolve(process.cwd(), "model-config.yaml");
  if (!fs.existsSync(configPath)) {
    throw new Error(
      "Model configuration is missing. Provide MODEL_CONFIG (YAML string) or MODEL_CONFIG_PATH pointing to a YAML file.",
    );
  }
  return fs.readFileSync(configPath, "utf-8");
}

function validateModelProviderConfig(definition: ModelDefinition): void {
  const { name, provider, providerConfig } = definition;

  if (provider === "openai") {
    const cfg = (providerConfig || {}) as Partial<OpenAIModelConfig>;
    const hasApiKey = Boolean(cfg.apiKey || process.env.OPENAI_API_KEY);
    const hasBaseUrl = Boolean(cfg.baseUrl || process.env.OPENAI_BASE_URL);
    if (!hasApiKey || !hasBaseUrl) {
      const missing: string[] = [];
      if (!hasApiKey) missing.push("apiKey");
      if (!hasBaseUrl) missing.push("baseUrl");
      throw new Error(
        `Model "${name}" (provider: ${provider}) is missing required configuration: ${missing.join(", ")}. ` +
          `Set ${missing
            .map((k) =>
              k === "apiKey"
                ? "provider_config.apiKey or env OPENAI_API_KEY"
                : "provider_config.baseUrl or env OPENAI_BASE_URL",
            )
            .join(", ")}.`,
      );
    }
    return;
  }

  if (provider === "openrouter") {
    const cfg = (providerConfig || {}) as Partial<OpenRouterModelConfig>;
    const hasApiKey = Boolean(cfg.apiKey || process.env.OPENROUTER_API_KEY);
    if (!hasApiKey) {
      throw new Error(
        `Model "${name}" (provider: ${provider}) is missing required configuration: apiKey. ` +
          `Set provider_config.apiKey or env OPENROUTER_API_KEY.`,
      );
    }
    return;
  }

  if (provider === "vertex") {
    const cfg = (providerConfig || {}) as Partial<VertexModelConfig>;
    const hasProject = Boolean(process.env.VERTEX_PROJECT_ID || cfg.projectId);
    const hasLocation = Boolean(process.env.VERTEX_LOCATION || cfg.location);
    // Credentials can be via env var, credentialsPath, or inline credentials
    const hasCreds = Boolean(
      process.env.GOOGLE_APPLICATION_CREDENTIALS ||
        cfg.credentialsPath ||
        cfg.credentials,
    );
    const missing: string[] = [];
    if (!hasProject)
      missing.push("provider_config.projectId or env VERTEX_PROJECT_ID");
    if (!hasLocation)
      missing.push("provider_config.location or env VERTEX_LOCATION");
    if (!hasCreds)
      missing.push(
        "provider_config.credentialsPath or provider_config.credentials or env GOOGLE_APPLICATION_CREDENTIALS",
      );
    if (missing.length) {
      throw new Error(
        `Model "${name}" (provider: ${provider}) is missing required configuration: ${missing.join("; ")}.`,
      );
    }
    return;
  }
}
