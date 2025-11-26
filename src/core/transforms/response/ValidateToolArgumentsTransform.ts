import {
  ResponseTransform,
  ResponseTransformContext,
  JsonValue,
} from "../../types.js";
import { requestRetry } from "../../pipelineControl.js";
import { logger } from "../../../utils/logger.js";

export class ValidateToolArgumentsTransform implements ResponseTransform {
  name = "validate-tool-arguments";
  stage: ResponseTransform["stage"] = "provider";
  priority = 90;

  applies(context: ResponseTransformContext): boolean {
    // Skip if synthetic response
    const headers = context.providerResponse?.headers || {};
    if (headers["x-synthetic-response"] === "true") {
      return false;
    }
    return Boolean(context.providerResponse?.body);
  }

  transform(context: ResponseTransformContext): void {
    if (!context.providerResponse) {
      return;
    }

    // Skip validation for synthetic responses
    const headers = context.providerResponse.headers || {};
    const isSyntheticResponse = headers["x-synthetic-response"] === "true";
    if (isSyntheticResponse) {
      logger.debug(
        { requestId: context.request.id },
        "Synthetic response detected, skipping tool arguments validation",
      );
      return;
    }

    const body = asJsonObject(context.providerResponse.body);
    const choices = Array.isArray(body.choices)
      ? body.choices
      : ((body.choices = []) as JsonValue[]);

    let hasInvalidArguments = false;
    const invalidToolNames: string[] = [];

    for (const choice of choices) {
      if (!isJsonObject(choice)) {
        continue;
      }
      const message = asJsonObject(choice.message);
      const toolCalls = Array.isArray(message.tool_calls)
        ? message.tool_calls
        : [];

      if (!toolCalls.length) {
        continue;
      }

      // Validate each tool call's arguments
      for (const toolCall of toolCalls) {
        const toolName = extractToolName(toolCall);
        const argsValid = this.validateToolArguments(toolCall);

        if (!argsValid) {
          hasInvalidArguments = true;
          invalidToolNames.push(toolName || "unknown");
          logger.warn(
            {
              requestId: context.request.id,
              toolName: toolName || "unknown",
            },
            "Invalid JSON in tool arguments",
          );
        }
      }
    }

    if (hasInvalidArguments) {
      console.log(
        `[ValidateToolArguments] Invalid JSON detected in tool arguments for: ${invalidToolNames.join(", ")}. Requesting retry.`,
      );
      requestRetry(context.request.state);
      logger.warn(
        {
          requestId: context.request.id,
          invalidToolNames,
        },
        "Tool calls contain invalid JSON arguments; scheduling retry",
      );
      return;
    }

    // All arguments are valid
    logger.debug(
      { requestId: context.request.id },
      "All tool arguments are valid",
    );
  }

  private validateToolArguments(toolCall: JsonValue): boolean {
    if (!isJsonObject(toolCall)) {
      return false;
    }

    const fn = isJsonObject(toolCall.function) ? toolCall.function : null;
    if (!fn) {
      return false;
    }

    // Arguments field must exist and be a string
    if (typeof fn.arguments !== "string") {
      return false;
    }

    // Attempt to parse as JSON
    try {
      JSON.parse(fn.arguments);
      return true;
    } catch {
      return false;
    }
  }
}

function extractToolName(tool: JsonValue): string | null {
  if (!isJsonObject(tool)) {
    return null;
  }
  const fn = isJsonObject(tool.function) ? tool.function : null;
  if (!fn) {
    return null;
  }
  return typeof fn.name === "string" ? fn.name : null;
}

function asJsonObject(value: JsonValue | undefined): Record<string, JsonValue> {
  return isJsonObject(value) ? value : {};
}

function isJsonObject(
  value: JsonValue | undefined,
): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
