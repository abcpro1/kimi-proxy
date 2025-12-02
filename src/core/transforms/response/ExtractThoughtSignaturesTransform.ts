import {
  ResponseTransform,
  ResponseTransformContext,
  JsonObject,
  JsonValue,
} from "../../types.js";
import { SignatureCache } from "../../../persistence/signatureCache.js";
import { logger } from "../../../utils/logger.js";

export class ExtractThoughtSignaturesTransform implements ResponseTransform {
  name = "extract-thought-signatures";
  stage: ResponseTransform["stage"] = "provider";
  priority = 50;

  applies(context: ResponseTransformContext): boolean {
    // Only apply to gemini-3 models
    return Boolean(
      context.request.model && context.request.model.includes("gemini-3"),
    );
  }

  transform(context: ResponseTransformContext): void {
    const providerResponse = context.providerResponse;
    if (!providerResponse) {
      return;
    }

    const body = providerResponse.body;
    if (!isJsonObject(body) || !Array.isArray(body.choices)) {
      return;
    }

    // Extract signatures from tool calls
    const signatures: Record<string, string> = {};

    for (const choice of body.choices) {
      if (!isJsonObject(choice)) {
        continue;
      }

      const message = choice.message;
      if (!isJsonObject(message)) {
        continue;
      }

      const toolCalls = message.tool_calls;
      if (!Array.isArray(toolCalls)) {
        continue;
      }

      for (const toolCall of toolCalls) {
        this.extractSignatureFromToolCall(
          toolCall,
          signatures,
          context.request.id,
        );
      }
    }

    // Store signatures in cache
    if (Object.keys(signatures).length > 0) {
      this.storeSignatures(signatures);
    }
  }

  private extractSignatureFromToolCall(
    toolCall: JsonValue,
    signatures: Record<string, string>,
    requestId: string,
  ): void {
    if (!isJsonObject(toolCall)) {
      return;
    }

    const toolCallId = toolCall.id;
    if (!toolCallId || typeof toolCallId !== "string") {
      return;
    }

    // Check for signature in extra_content.google.thought_signature
    const extraContent = toolCall.extra_content;
    if (isJsonObject(extraContent)) {
      const google = extraContent.google;
      if (isJsonObject(google)) {
        const signature = google.thought_signature;
        if (typeof signature === "string" && signature.length > 0) {
          signatures[toolCallId] = signature;
          logger.debug(
            { toolCallId, requestId },
            "Extracted thought signature from tool call",
          );
        }
      }
    }
  }

  private async storeSignatures(
    signatures: Record<string, string>,
  ): Promise<void> {
    try {
      const cache = new SignatureCache();

      for (const [toolCallId, signature] of Object.entries(signatures)) {
        await cache.store(toolCallId, signature);
      }

      logger.info(
        { count: Object.keys(signatures).length },
        "Stored thought signatures in cache",
      );
    } catch (error) {
      logger.error(
        { err: error, signaturesCount: Object.keys(signatures).length },
        "Failed to store thought signatures",
      );
    }
  }
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
