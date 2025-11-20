import {
  ConversionContext,
  PipelineResult,
  ProviderRequestPayload,
  ProxyRequest,
  ProviderResponsePayload,
  RequestTransform,
  ResponseTransform,
  JsonValue,
  JsonObject,
} from "./types.js";
import { ConverterRegistry } from "./converters/types.js";
import { LLMProvider } from "./providers/types.js";
import {
  clearRetryRequest,
  isRetryRequested,
  isSyntheticResponseRequested,
  clearSyntheticResponseRequest,
  resolvePipelineMaxAttempts,
} from "./pipelineControl.js";
import { createSyntheticProviderResponse } from "./syntheticResponse.js";
import { logger } from "../utils/logger.js";

interface PipelineDeps {
  converterRegistry: ConverterRegistry;
  requestTransforms: RequestTransform[];
  responseTransforms: ResponseTransform[];
}

const enum RequestStage {
  Source = "source",
  PostConversion = "post-conversion",
}

const enum ResponseStage {
  Provider = "provider",
  PostConversion = "post-conversion",
}

export class LLMProxyPipeline {
  constructor(private readonly deps: PipelineDeps) {}

  async execute(
    provider: LLMProvider,
    request: ProxyRequest,
    providerConfig?: JsonObject,
  ): Promise<PipelineResult> {
    const conversionContext: ConversionContext = {
      request,
      providerFormat: provider.format,
    };

    const converter = this.deps.converterRegistry.resolve(
      request.clientFormat,
      provider.format,
      request.operation,
    );
    const maxAttempts = resolvePipelineMaxAttempts(request.state);
    let attempt = 0;

    while (true) {
      attempt += 1;
      await this.applyRequestTransforms(RequestStage.Source, { request });

      const convertedRequest = await converter.convertRequest(
        request.body,
        conversionContext,
      );

      const providerRequest: ProviderRequestPayload = {
        body: convertedRequest.body,
        headers: convertedRequest.headers ?? {},
      };

      await this.applyRequestTransforms(RequestStage.PostConversion, {
        request,
        providerRequest,
      });

      // Check if request transforms requested a synthetic response to abort provider call
      const useSyntheticResponse = isSyntheticResponseRequested(request.state);
      let providerResponse: ProviderResponsePayload;

      if (useSyntheticResponse) {
        logger.warn(
          { requestId: request.id },
          "Synthetic response requested, bypassing provider invocation",
        );
        providerResponse = createSyntheticProviderResponse();
        clearSyntheticResponseRequest(request.state);
      } else {
        providerResponse = await provider.invoke({
          request,
          body: providerRequest.body,
          headers: providerRequest.headers,
          stream: request.stream,
          providerConfig,
        });

        if (providerResponse.status >= 400) {
          return {
            statusCode: providerResponse.status,
            responseBody: providerResponse.body,
            providerResponse,
            providerRequestBody: providerRequest.body,
            request,
            isError: true,
          };
        }

        await this.applyResponseTransforms(ResponseStage.Provider, {
          request,
          providerResponse,
        });
      }

      const clientResponse = await converter.convertResponse(
        providerResponse.body,
        conversionContext,
      );

      const responseContext = { request, providerResponse, clientResponse };
      await this.applyResponseTransforms(
        ResponseStage.PostConversion,
        responseContext,
      );

      const result: PipelineResult = {
        statusCode: 200,
        responseBody: responseContext.clientResponse,
        providerResponse,
        providerRequestBody: providerRequest.body,
        request,
        isError: false,
      };

      const shouldRetry =
        attempt < maxAttempts && isRetryRequested(request.state);
      if (!shouldRetry) {
        clearRetryRequest(request.state);
        return result;
      }

      clearRetryRequest(request.state);
    }
  }

  private async applyRequestTransforms(
    stage: RequestStage,
    context: {
      request: ProxyRequest;
      providerRequest?: ProviderRequestPayload;
    },
  ) {
    const transforms = this.transformsByStage(
      this.deps.requestTransforms,
      stage,
    );
    for (const transform of transforms) {
      if (transform.applies(context)) {
        await transform.transform(context);
      }
    }
  }

  private async applyResponseTransforms(
    stage: ResponseStage,
    context: {
      request: ProxyRequest;
      providerResponse?: ProviderResponsePayload;
      clientResponse?: JsonValue;
    },
  ) {
    const transforms = this.transformsByStage(
      this.deps.responseTransforms,
      stage,
    );
    for (const transform of transforms) {
      if (transform.applies(context)) {
        await transform.transform(context);
      }
    }
  }

  private transformsByStage<T extends { stage: string; priority?: number }>(
    transforms: T[],
    stage: string,
  ): T[] {
    return transforms
      .map((transform, index) => ({ transform, index }))
      .filter((entry) => entry.transform.stage === stage)
      .sort((a, b) => {
        const priorityDelta =
          (a.transform.priority ?? 0) - (b.transform.priority ?? 0);
        if (priorityDelta !== 0) {
          return priorityDelta;
        }
        return a.index - b.index;
      })
      .map((entry) => entry.transform);
  }
}
