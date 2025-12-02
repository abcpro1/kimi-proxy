import {
  RequestTransform,
  RequestTransformContext,
  JsonObject,
  JsonValue,
} from "../../types.js";
import { SignatureCache } from "../../../persistence/signatureCache.js";
import { logger } from "../../../utils/logger.js";

export class RestoreThoughtSignaturesTransform implements RequestTransform {
  name = "restore-thought-signatures";
  stage: RequestTransform["stage"] = "post-conversion";
  priority = 90;

  applies(context: RequestTransformContext): boolean {
    // Only apply to gemini-3 models
    return Boolean(
      context.request.model && context.request.model.includes("gemini-3"),
    );
  }

  async transform(context: RequestTransformContext): Promise<void> {
    const providerRequest = context.providerRequest;
    if (!providerRequest) {
      return;
    }

    const body = providerRequest.body;
    if (!isJsonObject(body) || !Array.isArray(body.messages)) {
      return;
    }

    // Collect all tool call IDs from conversation history
    const toolCallIds: string[] = [];
    const toolCalls: Array<{ toolCall: JsonObject; message: JsonObject }> = [];

    for (const [, message] of body.messages.entries()) {
      if (!isJsonObject(message) || message.role !== "assistant") {
        continue;
      }

      const calls = message.tool_calls;
      if (!Array.isArray(calls)) {
        continue;
      }

      for (const [, toolCall] of calls.entries()) {
        if (
          isJsonObject(toolCall) &&
          toolCall.id &&
          typeof toolCall.id === "string"
        ) {
          toolCallIds.push(toolCall.id);
          toolCalls.push({ toolCall, message });
        }
      }
    }

    if (toolCallIds.length === 0) {
      return;
    }

    // Batch retrieve signatures from cache
    const signatures = await this.retrieveSignatures(toolCallIds);

    if (Object.keys(signatures).length === 0) {
      logger.debug(
        { requestId: context.request.id },
        "No thought signatures found in cache",
      );
      return;
    }

    // Inject missing signatures into tool calls
    this.injectSignatures(toolCalls, signatures, context.request.id);
  }

  private async retrieveSignatures(
    toolCallIds: string[],
  ): Promise<Record<string, string>> {
    try {
      const cache = new SignatureCache();
      const signatures = await cache.batchRetrieve(toolCallIds);

      logger.debug(
        { count: Object.keys(signatures).length },
        "Retrieved thought signatures from cache",
      );

      return signatures;
    } catch (error) {
      logger.error(
        { err: error, toolCallIdsCount: toolCallIds.length },
        "Failed to retrieve thought signatures from cache",
      );
      return {};
    }
  }

  private injectSignatures(
    toolCalls: Array<{ toolCall: JsonObject; message: JsonObject }>,
    signatures: Record<string, string>,
    requestId: string,
  ): void {
    let injectedCount = 0;

    for (const { toolCall } of toolCalls) {
      const toolCallId = toolCall.id as string;

      if (!signatures[toolCallId]) {
        continue;
      }

      // Only inject if extra_content is missing
      if (toolCall.extra_content) {
        logger.debug(
          { toolCallId, requestId },
          "Tool call already has extra_content, skipping signature injection",
        );
        continue;
      }

      // Inject signature
      toolCall.extra_content = {
        google: {
          thought_signature: signatures[toolCallId],
        },
      };

      injectedCount++;
      logger.debug(
        { toolCallId, requestId },
        "Injected thought signature into tool call",
      );
    }

    if (injectedCount > 0) {
      logger.info(
        { injectedCount, requestId },
        "Injected thought signatures into tool calls",
      );
    }
  }
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
