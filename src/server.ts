import Fastify, {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import cors from "@fastify/cors";
import FastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { AppConfig } from "./config.js";
import { LogStore } from "./persistence/logStore.js";
import { LLMProxyPipeline } from "./core/pipeline.js";
import { ProviderRegistry, LLMProvider } from "./core/providers/types.js";
import { OpenAIProvider } from "./core/providers/openaiProvider.js";
import { OpenRouterProvider } from "./core/providers/openRouterProvider.js";
import { VertexMaaSProvider } from "./core/providers/vertexProvider.js";
import { ConverterRegistry } from "./core/converters/types.js";
import {
  OpenAIChatPassthroughConverter,
  OpenAIResponsesPassthroughConverter,
} from "./core/converters/openaiPassthrough.js";
import { AnthropicToOpenAIConverter } from "./core/converters/anthropicToOpenAI.js";
import { DisableStreamingTransform } from "./core/transforms/request/DisableStreamingTransform.js";
import { ClampMaxTokensTransform } from "./core/transforms/request/ClampMaxTokensTransform.js";
import { EnsureToolCallRequestTransform } from "./core/transforms/request/EnsureToolCallRequestTransform.js";
import { KimiResponseTransform } from "./core/transforms/response/KimiResponseTransform.js";
import { EnsureToolCallResponseTransform } from "./core/transforms/response/EnsureToolCallResponseTransform.js";
import {
  ClientFormat,
  ProxyOperation,
  ProxyRequest,
  JsonObject,
  JsonValue,
} from "./core/types.js";
import {
  openAIStreamFromResponse,
  anthropicStreamFromResponse,
  openAIResponsesStreamFromResponse,
  StreamingOptions,
} from "./services/streaming.js";
import { createRequestId } from "./utils/ids.js";
import { logger } from "./utils/logger.js";
import { resolveEnvVarsDeep } from "./utils/envResolver.js";
import { RequestTransform, ResponseTransform } from "./core/types.js";
import { ModelRegistry, ModelVariant } from "./core/modelRegistry.js";
import {
  createEnsureToolCallState,
  getEnsureToolCallState,
} from "./core/ensureToolCall.js";
import { setPipelineMaxAttempts } from "./core/pipelineControl.js";

interface ProxyHandlerOptions {
  operation: ProxyOperation;
  clientFormat: ClientFormat;
}

interface PipelineContext {
  pipeline: LLMProxyPipeline;
  providerRegistry: ProviderRegistry;
  modelRegistry: ModelRegistry;
  logStore: LogStore;
  config: AppConfig;
}

const TOOL_CALL_ENFORCER_ATTEMPTS = resolveEnsureToolCallAttemptLimit();

export async function createServer(
  config: AppConfig,
): Promise<FastifyInstance> {
  const server = Fastify({ logger: false });
  await server.register(cors, { origin: true });

  const currentDir = dirname(fileURLToPath(import.meta.url));
  const uiDist = join(currentDir, "..", "frontend", "dist");
  const indexPath = join(uiDist, "index.html");
  const hasStaticAssets = existsSync(indexPath);

  if (hasStaticAssets) {
    await server.register(FastifyStatic, {
      root: uiDist,
      prefix: "/",
      wildcard: false,
      decorateReply: true,
      maxAge: 86400000,
    });

    server.get("/*", async (req, reply) => {
      const file = (req.params as Record<string, string>)["*"] ?? "";
      const isAsset = file.includes(".");
      if (!isAsset) {
        reply.sendFile("index.html");
        return;
      }
      reply.sendFile(file);
    });
  } else {
    logger.warn(
      `Static frontend assets not found at ${indexPath}; skipping static serving.`,
    );
  }

  const logStore = new LogStore(config.logging.dbPath);
  const providerRegistry = new ProviderRegistry();

  if (config.providers.openai) {
    providerRegistry.register(new OpenAIProvider(config.providers.openai));
  }

  if (config.providers.openrouter) {
    providerRegistry.register(
      new OpenRouterProvider(config.providers.openrouter),
    );
  }

  if (config.providers.vertex) {
    providerRegistry.register(new VertexMaaSProvider(config.providers.vertex));
  }

  const modelRegistry = new ModelRegistry(
    config.models.definitions,
    config.models.defaultStrategy,
  );

  const converterRegistry = new ConverterRegistry();
  converterRegistry.register(new OpenAIChatPassthroughConverter());
  converterRegistry.register(new OpenAIResponsesPassthroughConverter());
  converterRegistry.register(new AnthropicToOpenAIConverter());

  const requestTransforms: RequestTransform[] = [
    new DisableStreamingTransform(),
    new ClampMaxTokensTransform(),
    new EnsureToolCallRequestTransform(),
  ];
  const responseTransforms: ResponseTransform[] = [
    new KimiResponseTransform(),
    new EnsureToolCallResponseTransform(),
  ];

  const pipeline = new LLMProxyPipeline({
    converterRegistry,
    requestTransforms,
    responseTransforms,
  });

  const pipelineDeps: PipelineContext = {
    pipeline,
    providerRegistry,
    modelRegistry,
    logStore,
    config,
  };

  server.post("/v1/chat/completions", async (req, reply) => {
    const body = requestBodyAsObject(req);
    await handleProxyRequest(req, reply, body, pipelineDeps, {
      operation: ProxyOperation.ChatCompletions,
      clientFormat: ClientFormat.OpenAIChatCompletions,
    });
  });

  server.post("/v1/messages", async (req, reply) => {
    const body = requestBodyAsObject(req);
    await handleAnthropicMessages(req, reply, body, pipelineDeps);
  });

  server.post("/v1/responses", async (req, reply) => {
    const body = requestBodyAsObject(req);
    await handleProxyRequest(req, reply, body, pipelineDeps, {
      operation: ProxyOperation.Responses,
      clientFormat: ClientFormat.OpenAIResponses,
    });
  });

  server.get("/v1/models", (_req, reply) => {
    const summaries = modelRegistry.list();
    const data = summaries.map((summary) => ({
      id: summary.name,
      object: "model",
      owned_by: "system",
      name: summary.name,
      metadata: {
        strategy: summary.strategy,
        variants: summary.variants,
      },
    }));
    reply.send({ object: "list", data });
  });

  server.get("/api/logs", (req, reply) => {
    const {
      page = "1",
      page_size = "20",
      search,
    } = req.query as Record<string, string>;
    const result = logStore.list({
      page: Number(page),
      pageSize: Number(page_size),
      search,
    });
    reply.send(result);
  });

  return server;
}

function requestBodyAsObject(req: FastifyRequest): JsonObject {
  const body = req.body;
  if (!body || typeof body !== "object") {
    return {};
  }
  return body as JsonObject;
}

async function handleProxyRequest(
  req: FastifyRequest,
  reply: FastifyReply,
  body: JsonObject,
  deps: PipelineContext,
  options: ProxyHandlerOptions,
) {
  const model = body.model;
  if (!model || typeof model !== "string") {
    reply.status(400).send({ error: { message: "model is required" } });
    return;
  }

  let provider: LLMProvider;
  let resolvedModel: ModelVariant;
  let providerConfig: JsonObject | undefined;
  try {
    resolvedModel = deps.modelRegistry.resolve(model);
    provider = deps.providerRegistry.get(resolvedModel.provider);

    if (resolvedModel.providerConfig) {
      providerConfig = resolveEnvVarsDeep(
        resolvedModel.providerConfig,
      ) as JsonObject;
    }
  } catch (error) {
    logger.error({ err: error, model }, "Model resolution failed");
    deps.logStore.append({
      method: req.method,
      url: req.url,
      statusCode: 400,
      model: typeof model === "string" ? model : undefined,
      requestBody: body,
      responseBody: { error: { message: (error as Error).message } },
      providerRequestBody: null,
      providerResponseBody: null,
    });
    reply.status(400).send({ error: { message: (error as Error).message } });
    return;
  }

  const effectiveBody = deepClone(body);
  effectiveBody.model = resolvedModel.upstreamModel;

  const request: ProxyRequest = {
    id: createRequestId(),
    operation: options.operation,
    clientFormat: options.clientFormat,
    model,
    body: effectiveBody,
    headers: normalizeHeaders(req.headers),
    stream: Boolean(body.stream),
    state: {
      originalStream: Boolean(body.stream),
    },
  };
  request.state.resolvedModel = serializeResolvedModel(resolvedModel);
  maybeEnableToolCallEnforcement(
    request,
    resolvedModel.ensureToolCall === true,
  );

  try {
    const result = await deps.pipeline.execute(
      provider,
      request,
      providerConfig,
    );

    deps.logStore.append({
      method: req.method,
      url: req.url,
      statusCode: result.statusCode,
      model,
      requestBody: body,
      responseBody: result.responseBody,
      providerRequestBody: result.providerRequestBody,
      providerResponseBody: result.providerResponse?.body,
    });

    if (result.isError) {
      reply.status(result.statusCode).send(result.responseBody);
      return;
    }

    await sendResponse(
      reply,
      request,
      result.responseBody,
      deps.config.streaming,
    );
  } catch (error) {
    logger.error({ err: error }, "Pipeline execution failed");
    reply.status(500).send({ error: { message: "Internal proxy error" } });
  }
}

async function handleAnthropicMessages(
  req: FastifyRequest,
  reply: FastifyReply,
  body: JsonObject,
  deps: PipelineContext,
) {
  const model = body.model;
  if (!model || typeof model !== "string") {
    reply.status(400).send({ error: { message: "model is required" } });
    return;
  }

  let provider: LLMProvider;
  let resolvedModel: ModelVariant;
  let providerConfig: JsonObject | undefined;
  try {
    resolvedModel = deps.modelRegistry.resolve(model);
    provider = deps.providerRegistry.get(resolvedModel.provider);

    if (resolvedModel.providerConfig) {
      providerConfig = resolveEnvVarsDeep(
        resolvedModel.providerConfig,
      ) as JsonObject;
    }
  } catch (error) {
    logger.error({ err: error, model }, "Model resolution failed");
    deps.logStore.append({
      method: req.method,
      url: req.url,
      statusCode: 400,
      model: typeof model === "string" ? model : undefined,
      requestBody: body,
      responseBody: { error: { message: (error as Error).message } },
      providerRequestBody: null,
      providerResponseBody: null,
    });
    reply.status(400).send({ error: { message: (error as Error).message } });
    return;
  }

  const effectiveBody = deepClone(body);
  effectiveBody.model = resolvedModel.upstreamModel;

  const request: ProxyRequest = {
    id: createRequestId(),
    operation: ProxyOperation.Messages,
    clientFormat: ClientFormat.AnthropicMessages,
    model,
    body: effectiveBody,
    headers: normalizeHeaders(req.headers),
    stream: Boolean(body.stream),
    state: {
      originalStream: Boolean(body.stream),
    },
  };
  request.state.resolvedModel = serializeResolvedModel(resolvedModel);
  maybeEnableToolCallEnforcement(
    request,
    resolvedModel.ensureToolCall === true,
  );

  try {
    const result = await deps.pipeline.execute(
      provider,
      request,
      providerConfig,
    );

    deps.logStore.append({
      method: req.method,
      url: req.url,
      statusCode: result.statusCode,
      model,
      requestBody: body,
      responseBody: result.responseBody,
      providerRequestBody: result.providerRequestBody,
      providerResponseBody: result.providerResponse?.body,
    });

    if (result.isError) {
      reply.status(result.statusCode).send(result.responseBody);
      return;
    }

    await sendResponse(
      reply,
      request,
      result.responseBody,
      deps.config.streaming,
    );
  } catch (error) {
    logger.error({ err: error }, "Anthropic messages handling failed");
    reply.status(500).send({ error: { message: "Internal proxy error" } });
  }
}

function serializeResolvedModel(variant: ModelVariant): JsonObject {
  return {
    name: variant.name,
    provider: variant.provider,
    upstreamModel: variant.upstreamModel,
    weight: variant.weight,
    strategy: variant.strategy ?? "first",
    ensureToolCall: variant.ensureToolCall,
  };
}

function maybeEnableToolCallEnforcement(
  request: ProxyRequest,
  enabled: boolean,
) {
  if (!enabled) {
    return;
  }
  if (!getEnsureToolCallState(request.state)) {
    createEnsureToolCallState(request.state);
  }
  setPipelineMaxAttempts(request.state, TOOL_CALL_ENFORCER_ATTEMPTS);
}

async function sendResponse(
  reply: FastifyReply,
  request: Pick<ProxyRequest, "clientFormat" | "state" | "stream">,
  payload: JsonValue,
  streamingOptions: StreamingOptions,
) {
  const shouldStream = Boolean(request.state.originalStream);
  if (!shouldStream) {
    reply.send(payload);
    return;
  }

  if (!isJsonObject(payload)) {
    reply.send(payload);
    return;
  }

  if (request.clientFormat === ClientFormat.AnthropicMessages) {
    reply.header("Content-Type", "text/event-stream");
    reply.header("Cache-Control", "no-cache");
    reply.header("Connection", "keep-alive");
    reply.send(anthropicStreamFromResponse(payload, streamingOptions));
    return;
  }

  if (request.clientFormat === ClientFormat.OpenAIResponses) {
    // Using reply.hijack() to bypass Fastify's default response handling which
    // incorrectly sets Content-Length: 0 for streaming responses in some environments.
    // This allows us to pipe the stream directly to the raw socket.
    reply.hijack();
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.removeHeader("Content-Length");

    const stream = openAIResponsesStreamFromResponse(payload, streamingOptions);
    try {
      await pipeline(stream, reply.raw);
    } catch (error) {
      if (isPrematureCloseError(error)) {
        logger.debug(
          { err: error },
          "Client disconnected before streaming completed",
        );
      } else {
        throw error;
      }
    }
    return;
  }

  reply.header("Content-Type", "text/event-stream");
  reply.header("Cache-Control", "no-cache");
  reply.header("Connection", "keep-alive");
  reply.send(openAIStreamFromResponse(payload, streamingOptions));
}

function normalizeHeaders(
  headers: FastifyRequest["headers"],
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      normalized[key.toLowerCase()] = value;
    }
  }
  return normalized;
}

function deepClone<T>(value: T): T {
  if (value === undefined || value === null) {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}
function isPrematureCloseError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const err = error as { code?: string; message?: string };
  if (err.code === "ERR_STREAM_PREMATURE_CLOSE") {
    return true;
  }
  return (
    typeof err.message === "string" && err.message.includes("Premature close")
  );
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveEnsureToolCallAttemptLimit(): number {
  const raw = Number(process.env.ENSURE_TOOL_CALL_MAX_ATTEMPTS ?? "3");
  if (!Number.isFinite(raw) || raw < 1) {
    return 3;
  }
  return Math.min(5, Math.floor(raw));
}
