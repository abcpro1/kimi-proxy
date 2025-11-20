import {
  JsonObject,
  JsonValue,
  RequestTransform,
  RequestTransformContext,
} from "../../types.js";

const MAX_TOKENS_CAP = Number(process.env.MAX_TOKENS_CAP ?? "4096");

export class ClampMaxTokensTransform implements RequestTransform {
  name = "clamp-max-tokens";
  stage: RequestTransform["stage"] = "post-conversion";

  applies(context: RequestTransformContext): boolean {
    const providerBody = getProviderBody(context);
    if (!providerBody) {
      return false;
    }
    const maxTokens = providerBody.max_tokens;
    return typeof maxTokens === "number" && maxTokens > MAX_TOKENS_CAP;
  }

  transform(context: RequestTransformContext): void {
    const providerBody = getProviderBody(context);
    if (!providerBody) {
      return;
    }
    providerBody.max_tokens = MAX_TOKENS_CAP;
    context.request.state.maxTokensClamped = true;
  }
}

function getProviderBody(context: RequestTransformContext): JsonObject | null {
  const body = context.providerRequest?.body;
  return isJsonObject(body) ? body : null;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
