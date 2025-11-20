import { fixKimiResponse } from "../../../services/kimiFixer.js";
import { logger } from "../../../utils/logger.js";
import {
  JsonObject,
  JsonValue,
  ResponseTransform,
  ResponseTransformContext,
} from "../../types.js";

export class KimiResponseTransform implements ResponseTransform {
  name = "kimi-response-transform";
  stage: ResponseTransform["stage"] = "provider";

  applies(context: ResponseTransformContext): boolean {
    const body = context.providerResponse?.body;
    return isJsonObject(body) && Array.isArray(body.choices);
  }

  transform(context: ResponseTransformContext): void {
    const providerResponse = context.providerResponse;
    if (!providerResponse) {
      return;
    }
    const providerBody = providerResponse.body;
    if (isJsonObject(providerBody)) {
      const { response, metadata } = fixKimiResponse(providerBody);
      providerResponse.body = response;

      if (metadata.extractedToolCalls > 0) {
        logger.info(
          {
            requestId: context.request.id,
            extractedFromContent: metadata.extractedFromContent,
            extractedFromReasoning: metadata.extractedFromReasoning,
          },
          "Kimi response transform recovered structured tool calls from text output",
        );
      }
    }
  }
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
