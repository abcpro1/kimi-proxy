import {
  ClientRequest,
  AnthropicMessagesResponse,
  OpenAIResponsesResponse,
  OpenAIChatCompletionResponse,
  OpenAIChatCompletionRequestSchema,
  AnthropicMessagesRequestSchema,
  OpenAIResponsesRequestSchema,
} from "./core/schemas.js";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import cors from "@fastify/cors";
import FastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import path, { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { pipeline as streamPipeline } from "node:stream/promises";
import { AppConfig } from "./config.js";
import {
  HybridLogStore,
  readBlobFile,
  type HybridLogMetadata,
  type LogBlobKind,
} from "./persistence/hybridLogStore.js";
import { Pipeline, ClientRegistry, ProviderRegistry } from "./core/pipeline.js";
import {
  OpenAIChatClientAdapter,
  AnthropicMessagesClientAdapter,
  OpenAIResponsesClientAdapter,
} from "./core/clientAdapters.js";
import {
  OpenAIProviderAdapter,
  AnthropicProviderAdapter,
  OpenRouterProviderAdapter,
  VertexProviderAdapter,
} from "./core/providerAdapters.js";
import {
  NormalizeTransform,
  NormalizeResponseTransform,
  PropagateFinishReasonsTransform,
  EnsureToolCallRequestTransform,
  EnsureToolCallResponseTransform,
} from "./core/transforms.js";
import { Operation, type Response } from "./core/types.js";
import { ClientFormat, type JsonObject, type JsonValue } from "./core/types.js";
import { ModelRegistry } from "./core/modelRegistry.js";
import { resolveEnvVarsDeep } from "./utils/envResolver.js";
import { createRequestId } from "./utils/ids.js";
import { logger } from "./utils/logger.js";
import {
  anthropicStreamFromResponse,
  openAIResponsesStreamFromResponse,
  openAIStreamFromResponse,
  type StreamingOptions,
} from "./services/streaming.js";
import {
  searchLogBlobs,
  type LogSearchBlobKind,
} from "./services/logSearch.js";
import {
  createLiveStoreRuntime,
  type LiveStoreRuntime,
} from "./livestore/runtime.js";

interface FastifyParamsWithProfile {
  profile: string;
}

export async function createServer(
  config: AppConfig,
): Promise<FastifyInstance> {
  const server = Fastify({ logger: false, bodyLimit: 104857600 });
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

  const logStore = new HybridLogStore(
    config.logging.dbPath,
    config.logging.blobRoot,
  );

  const liveStoreRuntime: LiveStoreRuntime | undefined =
    await createLiveStoreRuntime({
      storageDir: path.join(path.dirname(config.logging.dbPath), "livestore"),
      storeId: "logs",
    }).catch((error) => {
      logger.warn(
        { err: error },
        "Failed to start LiveStore log mirror; dashboard sync will rely on HTTP only",
      );
      return undefined;
    });
  if (liveStoreRuntime) {
    const seeded = await liveStoreRuntime.seedFromHybrid(logStore, {
      batchSize: config.livestore.batchSize,
    });
    logger.info({ seeded }, "Seeded LiveStore log mirror");
    server.addHook("onClose", async () => {
      await liveStoreRuntime.close();
    });
  }
  const clientRegistry = new ClientRegistry();
  clientRegistry.register(new OpenAIChatClientAdapter());
  clientRegistry.register(new AnthropicMessagesClientAdapter());
  clientRegistry.register(new OpenAIResponsesClientAdapter());

  const providerRegistry = new ProviderRegistry();
  const hasVertexModels = config.models.definitions.some(
    (definition) => definition.provider === "vertex",
  );
  if (config.providers.openai) {
    providerRegistry.register(
      new OpenAIProviderAdapter({
        apiKey: config.providers.openai.apiKey,
        baseUrl: config.providers.openai.baseUrl,
      }),
    );
  }

  if (config.providers.anthropic) {
    providerRegistry.register(
      new AnthropicProviderAdapter({
        apiKey: config.providers.anthropic.apiKey,
        baseUrl: config.providers.anthropic.baseUrl,
      }),
    );
  }

  if (config.providers.openrouter) {
    providerRegistry.register(
      new OpenRouterProviderAdapter({
        apiKey: config.providers.openrouter.apiKey,
      }),
    );
  }

  if (config.providers.vertex || hasVertexModels) {
    if (!config.providers.vertex) {
      logger.warn(
        "Vertex models configured without global provider config; provider_config must include project, location, and credentials",
      );
    }
    providerRegistry.register(
      new VertexProviderAdapter(config.providers.vertex),
    );
  }

  const transforms = [
    new NormalizeTransform(),
    new EnsureToolCallRequestTransform(),
    new NormalizeResponseTransform(),
    new EnsureToolCallResponseTransform(),
    new PropagateFinishReasonsTransform(),
  ];

  const pipeline = new Pipeline(clientRegistry, providerRegistry, transforms);

  const modelRegistry = new ModelRegistry(
    config.models.definitions,
    config.models.defaultStrategy,
  );

  server.post("/v1/chat/completions", async (req, reply) => {
    await handleRequest(
      req,
      reply,
      req.body as ClientRequest,
      modelRegistry,
      pipeline,
      logStore,
      liveStoreRuntime,
      config,
      {
        operation: Operation.Chat,
        clientFormat: ClientFormat.OpenAIChatCompletions,
      },
    );
  });

  server.post("/v1/messages", async (req, reply) => {
    await handleRequest(
      req,
      reply,
      req.body as ClientRequest,
      modelRegistry,
      pipeline,
      logStore,
      liveStoreRuntime,
      config,
      {
        operation: Operation.Messages,
        clientFormat: ClientFormat.AnthropicMessages,
      },
    );
  });

  server.post("/v1/responses", async (req, reply) => {
    await handleRequest(
      req,
      reply,
      req.body as ClientRequest,
      modelRegistry,
      pipeline,
      logStore,
      liveStoreRuntime,
      config,
      {
        operation: Operation.Responses,
        clientFormat: ClientFormat.OpenAIResponses,
      },
    );
  });

  server.post<{ Params: FastifyParamsWithProfile }>(
    "/:profile/v1/chat/completions",
    async (req, reply) => {
      await handleRequest(
        req,
        reply,
        req.body as ClientRequest,
        modelRegistry,
        pipeline,
        logStore,
        liveStoreRuntime,
        config,
        {
          operation: Operation.Chat,
          clientFormat: ClientFormat.OpenAIChatCompletions,
          profile: req.params.profile,
        },
      );
    },
  );

  server.post<{ Params: FastifyParamsWithProfile }>(
    "/:profile/v1/messages",
    async (req, reply) => {
      await handleRequest(
        req,
        reply,
        req.body as ClientRequest,
        modelRegistry,
        pipeline,
        logStore,
        liveStoreRuntime,
        config,
        {
          operation: Operation.Messages,
          clientFormat: ClientFormat.AnthropicMessages,
          profile: req.params.profile,
        },
      );
    },
  );

  server.post<{ Params: FastifyParamsWithProfile }>(
    "/:profile/v1/responses",
    async (req, reply) => {
      await handleRequest(
        req,
        reply,
        req.body as ClientRequest,
        modelRegistry,
        pipeline,
        logStore,
        liveStoreRuntime,
        config,
        {
          operation: Operation.Responses,
          clientFormat: ClientFormat.OpenAIResponses,
          profile: req.params.profile,
        },
      );
    },
  );

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
      from,
      to,
    } = req.query as Record<string, string>;
    const result = logStore.list({
      page: Number(page),
      pageSize: Number(page_size),
      search,
      from,
      to,
    });
    reply.send(result);
  });

  server.get("/api/logs/search", async (req, reply) => {
    const {
      q,
      search,
      kinds,
      limit = "200",
      timeout_ms,
    } = req.query as Record<string, string>;

    const query = (q ?? search ?? "").trim();
    if (!query) {
      reply.send({
        ids: [],
        request_ids: [],
        truncated: false,
        engine: "rg",
      });
      return;
    }

    const parsedKinds: LogSearchBlobKind[] | undefined = kinds
      ? (kinds
          .split(",")
          .map((kind) => kind.trim())
          .filter(Boolean) as LogSearchBlobKind[])
      : undefined;

    const limitRaw = Number(limit);
    const limitNum = Number.isFinite(limitRaw)
      ? Math.max(1, Math.min(5000, limitRaw))
      : 200;
    const timeoutRaw = timeout_ms ? Number(timeout_ms) : undefined;
    const timeoutMs =
      timeoutRaw !== undefined && Number.isFinite(timeoutRaw)
        ? timeoutRaw
        : undefined;

    try {
      const blobResult = await searchLogBlobs({
        blobRoot: config.logging.blobRoot,
        query,
        kinds: parsedKinds,
        limit: limitNum,
        timeoutMs,
      });
      const ids = logStore.findIdsByRequestIds(blobResult.requestIds);
      reply.send({
        ids,
        request_ids: blobResult.requestIds,
        truncated: blobResult.truncated,
        engine: blobResult.engine,
      });
    } catch (error) {
      logger.error({ err: error }, "Blob search failed");
      reply.status(500).send({ error: { message: "Blob search failed" } });
    }
  });

  server.get("/api/livestore/pull", async (req, reply) => {
    if (!liveStoreRuntime) {
      reply.status(503).send({
        error: { message: "LiveStore mirror unavailable on this node" },
      });
      return;
    }
    try {
      const { timestamp, id, limit } = req.query as Record<string, string>;
      const batchSize = Math.max(
        1,
        Math.min(500, Number(limit ?? config.livestore.batchSize ?? 200)),
      );
      const checkpoint = {
        timestamp,
        id: id ? Number(id) : undefined,
      };
      const items = await liveStoreRuntime.pullSince(checkpoint, batchSize);
      const next =
        items.length > 0
          ? {
              timestamp: items[items.length - 1]!.timestamp,
              id: items[items.length - 1]!.numeric_id,
            }
          : checkpoint;
      reply.send({ items, next });
    } catch (error) {
      logger.error({ err: error }, "LiveStore pull failed");
      reply.status(500).send({ error: { message: "LiveStore pull failed" } });
    }
  });

  server.get("/api/logs/:id", (req, reply) => {
    const { id } = req.params as Record<string, string>;
    const meta = logStore.readMetadata(Number(id));
    if (!meta) {
      reply.status(404).send({ error: { message: "Log not found" } });
      return;
    }
    reply.send(meta);
  });

  server.get("/api/logs/:id/blobs/:kind", (req, reply) => {
    const { id, kind } = req.params as Record<string, string>;
    const meta = logStore.readMetadata(Number(id));
    if (!meta) {
      reply.status(404).send({ error: { message: "Log not found" } });
      return;
    }

    const blobPath = logStore.resolveBlobPath(meta, kind as LogBlobKind);
    if (!blobPath) {
      reply.status(404).send({ error: { message: "Blob not found" } });
      return;
    }

    const etag = resolveEtag(meta, kind as LogBlobKind);
    if (etag && req.headers["if-none-match"] === etag) {
      reply.status(304).send();
      return;
    }

    const payload = readBlobFile(blobPath);
    reply
      .header("Content-Type", "application/json")
      .header("Cache-Control", "public, max-age=3600")
      .header("ETag", etag)
      .send(payload);
  });

  server.get("/api/logs/:id/summary", (req, reply) => {
    const { id } = req.params as Record<string, string>;
    const meta = logStore.readMetadata(Number(id));
    if (!meta) {
      reply.status(404).send({ error: { message: "Log not found" } });
      return;
    }
    reply.send({
      id: meta.id,
      request_id: meta.request_id,
      status_code: meta.status_code,
      model: meta.model,
      provider: meta.provider,
      summary: meta.summary,
      timestamp: meta.timestamp,
    });
  });

  return server;
}

async function handleRequest(
  req: FastifyRequest,
  reply: FastifyReply,
  body: ClientRequest,
  modelRegistry: ModelRegistry,
  pipeline: Pipeline,
  logStore: HybridLogStore,
  liveStoreRuntime: LiveStoreRuntime | undefined,
  config: AppConfig,
  options: {
    operation: Operation;
    clientFormat: ClientFormat;
    profile?: string;
  },
) {
  const requestId = createRequestId();
  const startedAt = Date.now();
  let model: string;
  let isStream: boolean;
  let parsedBody: ClientRequest;

  try {
    if (options.clientFormat === ClientFormat.OpenAIChatCompletions) {
      parsedBody = OpenAIChatCompletionRequestSchema.parse(body);
      model = parsedBody.model;
      isStream = Boolean(parsedBody.stream);
    } else if (options.clientFormat === ClientFormat.AnthropicMessages) {
      parsedBody = AnthropicMessagesRequestSchema.parse(body);
      model = parsedBody.model;
      isStream = Boolean(parsedBody.stream);
    } else if (options.clientFormat === ClientFormat.OpenAIResponses) {
      parsedBody = OpenAIResponsesRequestSchema.parse(body);
      model = parsedBody.model;
      isStream = Boolean(parsedBody.stream);
    } else {
      throw new Error("Unknown client format");
    }
  } catch (error) {
    const errorBody = {
      error: { message: "Invalid request schema", details: error },
    };
    logStore.append({
      requestId,
      method: req.method,
      url: req.url,
      statusCode: 400,
      startedAt,
      finishedAt: Date.now(),
      requestBody: req.body as JsonObject,
      responseBody: errorBody as unknown as JsonObject,
      operation: options.operation,
      clientFormat: options.clientFormat,
      profile: options.profile,
    });
    reply.status(400).send(errorBody);
    return;
  }

  const headers = normalizeHeaders(req.headers);

  let providerKey: string;
  let upstreamModel: string | undefined;
  let providerConfig: JsonObject | undefined;
  let ensureToolCall = false;
  try {
    const resolved = modelRegistry.resolve(model, options.profile);
    providerKey = resolved.provider;
    upstreamModel = resolved.upstreamModel;
    ensureToolCall = resolved.ensureToolCall === true;
    providerConfig = resolved.providerConfig
      ? (resolveEnvVarsDeep(resolved.providerConfig) as JsonObject)
      : undefined;
  } catch (error) {
    logger.error(
      { err: error, model, profile: options.profile },
      "Model resolution failed",
    );
    const errorBody = { error: { message: (error as Error).message } };
    logStore.append({
      requestId,
      method: req.method,
      url: req.url,
      statusCode: 400,
      model,
      startedAt,
      finishedAt: Date.now(),
      requestBody: parsedBody as unknown as JsonObject,
      responseBody: errorBody as unknown as JsonObject,
      operation: options.operation,
      clientFormat: options.clientFormat,
      profile: options.profile,
    });
    reply.status(400).send(errorBody);
    return;
  }

  try {
    const result = await pipeline.execute({
      clientFormat: options.clientFormat,
      providerKey,
      providerConfig,
      requestBody: upstreamModel
        ? ({
            ...parsedBody,
            model: upstreamModel,
          } as unknown as ClientRequest)
        : parsedBody,
      requestHeaders: headers,
      operation: options.operation,
      requestId,
      profile: options.profile,
      ensureToolCall,
    });

    const status =
      result.providerResponse.status >= 400
        ? result.providerResponse.status
        : result.response.error
          ? 502
          : 200;

    const stored = logStore.append({
      requestId: result.request.id,
      method: req.method,
      url: req.url,
      statusCode: status,
      model,
      provider: providerKey,
      profile: options.profile,
      operation: options.operation,
      clientFormat: options.clientFormat,
      providerFormat: result.request.metadata.providerFormat,
      startedAt,
      finishedAt: Date.now(),
      requestBody: upstreamModel
        ? ({ ...parsedBody, model: upstreamModel } as unknown as JsonObject)
        : (parsedBody as unknown as JsonObject),
      responseBody: result.clientResponse,
      providerRequestBody: result.providerResponse.requestBody,
      providerResponseBody: result.providerResponse.body,
      summary: summarize(result.response),
    });

    if (stored) {
      if (liveStoreRuntime) {
        void liveStoreRuntime.mirrorLog(stored).catch((error) => {
          logger.warn({ err: error }, "LiveStore mirrorLog failed");
        });
      }
    }

    if (status >= 400) {
      const errorPayload =
        status >= 400 && result.response.error
          ? { error: result.response.error }
          : result.providerResponse.body;
      reply.status(status).send(errorPayload);
      return;
    }

    await sendResponse(
      reply,
      options.clientFormat,
      isStream,
      result.clientResponse,
      config.streaming,
    );
  } catch (error) {
    logger.error({ err: error }, "Pipeline failed");

    const errorDetails = {
      message: "Internal proxy error",
      details: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      cause:
        error instanceof Error && (error as { cause?: unknown }).cause
          ? String((error as { cause?: unknown }).cause)
          : undefined,
    };

    logStore.append({
      requestId,
      method: req.method,
      url: req.url,
      statusCode: 500,
      model,
      provider: providerKey,
      profile: options.profile,
      operation: options.operation,
      clientFormat: options.clientFormat,
      providerFormat: undefined,
      startedAt,
      finishedAt: Date.now(),
      requestBody: upstreamModel
        ? ({ ...parsedBody, model: upstreamModel } as unknown as JsonObject)
        : (parsedBody as unknown as JsonObject),
      responseBody: { error: errorDetails },
      providerRequestBody: null,
      providerResponseBody: null,
    });
    reply.status(500).send({ error: { message: "Internal proxy error" } });
  }
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

async function sendResponse(
  reply: FastifyReply,
  clientFormat: ClientFormat,
  shouldStream: boolean,
  payload: JsonValue,
  streaming: StreamingOptions,
) {
  if (!shouldStream) {
    reply.send(payload);
    return;
  }

  if (clientFormat === ClientFormat.AnthropicMessages) {
    reply.hijack();
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.removeHeader("Content-Length");
    reply.raw.removeHeader("Content-Length");

    const stream = anthropicStreamFromResponse(
      payload as unknown as AnthropicMessagesResponse,
      streaming,
    );
    try {
      await streamPipeline(stream, reply.raw);
    } catch (error) {
      if (!isPrematureCloseError(error)) {
        throw error;
      }
      logger.debug(
        { err: error },
        "Client disconnected during anthropic stream",
      );
    }
    return;
  }

  if (clientFormat === ClientFormat.OpenAIResponses) {
    reply.hijack();
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.removeHeader("Content-Length");
    reply.raw.removeHeader("Content-Length");

    const stream = openAIResponsesStreamFromResponse(
      payload as unknown as OpenAIResponsesResponse,
      streaming,
    );
    try {
      await streamPipeline(stream, reply.raw);
    } catch (error) {
      if (!isPrematureCloseError(error)) {
        throw error;
      }
      logger.debug(
        { err: error },
        "Client disconnected during responses stream",
      );
    }
    return;
  }

  reply.hijack();
  reply.raw.setHeader("Content-Type", "text/event-stream");
  reply.raw.setHeader("Cache-Control", "no-cache");
  reply.raw.setHeader("Connection", "keep-alive");
  reply.removeHeader("Content-Length");
  reply.raw.removeHeader("Content-Length");

  const stream = openAIStreamFromResponse(
    payload as unknown as OpenAIChatCompletionResponse,
    streaming,
  );
  try {
    await streamPipeline(stream, reply.raw);
  } catch (error) {
    if (!isPrematureCloseError(error)) {
      throw error;
    }
    logger.debug({ err: error }, "Client disconnected during stream");
  }
}

function resolveEtag(
  meta: HybridLogMetadata,
  kind: LogBlobKind,
): string | undefined {
  const mapping: Record<LogBlobKind, string | undefined> = {
    request: meta.request_sha256 as string | undefined,
    response: meta.response_sha256 as string | undefined,
    "provider-request": meta.provider_request_sha256 as string | undefined,
    "provider-response": meta.provider_response_sha256 as string | undefined,
  };
  return mapping[kind];
}

function summarize(response: Response): string {
  const message = response.output.find((entry) => entry.type === "message");
  const preview =
    message && message.type === "message"
      ? message.content
          .filter((block) => block.type === "text")
          .map((block) => block.text ?? "")
          .join("")
          .slice(0, 200) || undefined
      : undefined;

  return JSON.stringify({
    finish_reason: response.finish_reason,
    error: response.error,
    preview,
  });
}

function isPrematureCloseError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const err = error as { code?: string; message?: string };
  if (err.code === "ERR_STREAM_PREMATURE_CLOSE") return true;
  return (
    typeof err.message === "string" && err.message.includes("Premature close")
  );
}
