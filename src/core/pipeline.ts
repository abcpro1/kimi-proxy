import { type ClientRequest } from "./schemas.js";
import { createRequestId } from "../utils/ids.js";
import { logger } from "../utils/logger.js";
import type { JsonObject, JsonValue } from "./types.js";
import {
  ClientAdapter,
  PipelineResult as PipelineResult,
  ProviderAdapter,
  ProviderResponse,
  Response,
  Transform as Transform,
  Operation as Operation,
  TransformContext,
} from "./types.js";
import {
  clearRetryRequest,
  clearSyntheticResponseRequest,
  isRetryRequested,
  isSyntheticResponseRequested,
  resolvePipelineMaxAttempts,
  setPipelineMaxAttempts,
} from "./pipelineControl.js";
import {
  createEnsureToolCallState,
  getEnsureToolCallState,
} from "./ensureToolCall.js";

export class ClientRegistry {
  private adapters = new Map<string, ClientAdapter>();

  register(adapter: ClientAdapter) {
    this.adapters.set(adapter.clientFormat, adapter);
  }

  resolve(clientFormat: string): ClientAdapter {
    const adapter = this.adapters.get(clientFormat);
    if (!adapter) {
      throw new Error(`No client adapter registered for ${clientFormat}`);
    }
    return adapter;
  }
}

export class ProviderRegistry {
  private adapters = new Map<string, ProviderAdapter>();

  register(adapter: ProviderAdapter) {
    this.adapters.set(adapter.key, adapter);
  }

  resolve(key: string): ProviderAdapter {
    const adapter = this.adapters.get(key);
    if (!adapter) {
      throw new Error(`No provider adapter registered for ${key}`);
    }
    return adapter;
  }
}

export interface PipelineOptions {
  clientFormat: string;
  providerKey: string;
  providerConfig?: JsonObject;
  requestBody: ClientRequest;
  requestHeaders: Record<string, string>;
  operation: Operation;
  requestId?: string;
  profile?: string;
  ensureToolCall?: boolean;
}

export class Pipeline {
  constructor(
    private readonly clients: ClientRegistry,
    private readonly providers: ProviderRegistry,
    private readonly transforms: Transform[] = [],
  ) {}

  async execute(options: PipelineOptions): Promise<PipelineResult> {
    const clientAdapter = this.clients.resolve(options.clientFormat);
    const providerAdapter = this.providers.resolve(options.providerKey);

    const context = clientAdapter.toUlx(
      options.requestBody,
      options.requestHeaders,
    );

    context.operation = options.operation;
    context.profile = options.profile;
    context.id = options.requestId ?? context.id ?? createRequestId();
    context.metadata.clientFormat = options.clientFormat;
    context.metadata.providerFormat = providerAdapter.providerFormat;
    context.metadata.clientRequest = options.requestBody;

    if (options.ensureToolCall === true) {
      if (!getEnsureToolCallState(context.state)) {
        createEnsureToolCallState(context.state);
      }
      setPipelineMaxAttempts(
        context.state,
        resolveEnsureToolCallAttemptLimit(),
      );
    }

    const maxAttempts = resolvePipelineMaxAttempts(context.state);
    let attempt = 0;

    let lastProviderResponse: ProviderResponse = {
      status: 500,
      body: {},
      headers: {},
    };
    let lastResponse: Response | undefined;
    let lastClientResponse: JsonValue | undefined;

    while (true) {
      attempt += 1;
      await this.runTransforms("ingress", { request: context });

      if (isSyntheticResponseRequested(context.state)) {
        clearSyntheticResponseRequest(context.state);
        lastProviderResponse = createSyntheticProviderResponse();
        lastResponse = createSyntheticResponse(context);
        lastResponse.metadata = {
          ...(lastResponse.metadata ?? {}),
          provider: providerAdapter.key,
          providerFormat: providerAdapter.providerFormat,
          clientFormat: options.clientFormat,
          synthetic: true,
        };
      } else {
        lastProviderResponse = await providerAdapter.invoke(
          context,
          options.providerConfig,
        );

        if (lastProviderResponse.status >= 400) {
          lastResponse = await providerAdapter.toUlxResponse(
            lastProviderResponse,
            context,
          );
          lastResponse.metadata = {
            ...(lastResponse.metadata ?? {}),
            provider: providerAdapter.key,
            providerFormat: providerAdapter.providerFormat,
            clientFormat: options.clientFormat,
          };

          lastClientResponse = lastResponse.error
            ? { error: lastResponse.error }
            : clientAdapter.fromUlx(lastResponse, context);

          clearRetryRequest(context.state);
          return {
            request: context,
            response: lastResponse,
            providerResponse: lastProviderResponse,
            providerAdapter: providerAdapter.key,
            clientResponse: lastClientResponse,
          };
        }

        lastResponse = await providerAdapter.toUlxResponse(
          lastProviderResponse,
          context,
        );

        lastResponse.metadata = {
          ...(lastResponse.metadata ?? {}),
          provider: providerAdapter.key,
          providerFormat: providerAdapter.providerFormat,
          clientFormat: options.clientFormat,
        };
      }

      await this.runTransforms("egress", {
        request: context,
        response: lastResponse,
      });

      lastClientResponse = lastResponse.error
        ? { error: lastResponse.error }
        : clientAdapter.fromUlx(lastResponse, context);

      const shouldRetry =
        attempt < maxAttempts && isRetryRequested(context.state);
      if (!shouldRetry) {
        clearRetryRequest(context.state);
        return {
          request: context,
          response: lastResponse,
          providerResponse: lastProviderResponse,
          providerAdapter: providerAdapter.key,
          clientResponse: lastClientResponse,
        };
      }

      clearRetryRequest(context.state);
    }
  }

  private async runTransforms(
    stage: Transform["stage"],
    context: TransformContext,
  ) {
    const transforms = this.transforms
      .map((transform, index) => ({ transform, index }))
      .filter((entry) => entry.transform.stage === stage)
      .sort((a, b) => {
        const priorityDelta =
          (a.transform.priority ?? 0) - (b.transform.priority ?? 0);
        if (priorityDelta !== 0) return priorityDelta;
        return a.index - b.index;
      })
      .map((entry) => entry.transform);

    for (const transform of transforms) {
      try {
        if (transform.applies(context)) {
          await transform.transform(context);
        }
      } catch (error) {
        logger.error(
          { err: error, stage, transform: transform.name },
          "Transform failed",
        );
        throw error;
      }
    }
  }
}

function createSyntheticProviderResponse(): ProviderResponse {
  return {
    status: 200,
    body: {},
    headers: {
      "x-synthetic-response": "true",
    },
  };
}

function resolveEnsureToolCallAttemptLimit(): number {
  const raw = Number(process.env.ENSURE_TOOL_CALL_MAX_ATTEMPTS ?? "3");
  if (!Number.isFinite(raw) || raw < 1) {
    return 3;
  }
  return Math.min(5, Math.floor(raw));
}

function createSyntheticResponse(context: {
  id: string;
  operation: Operation;
}): Response {
  return {
    id: `synth_${context.id}`,
    model: "synthetic",
    operation: context.operation,
    finish_reason: "stop",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [],
        status: "completed",
      },
    ],
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    metadata: { synthetic: true },
  };
}
