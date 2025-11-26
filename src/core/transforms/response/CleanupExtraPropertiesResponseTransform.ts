import { logger } from "../../../utils/logger.js";
import {
  JsonObject,
  JsonValue,
  ResponseTransform,
  ResponseTransformContext,
} from "../../types.js";

export class CleanupExtraPropertiesResponseTransform
  implements ResponseTransform
{
  name = "cleanup-extra-properties-transform";
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
      providerResponse.body = cleanupExtraProperties(providerBody);
    }
  }
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanupExtraProperties(body: JsonObject): JsonObject {
  if (isJsonObject(body.usage) && isJsonObject(body.usage.extra_properties)) {
    delete body.usage.extra_properties;
    logger.info("Cleaned up extra_properties from usage");
  }
  return body;
}
