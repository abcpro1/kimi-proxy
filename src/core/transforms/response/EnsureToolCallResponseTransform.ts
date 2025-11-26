import {
  ResponseTransform,
  ResponseTransformContext,
  JsonObject,
  JsonValue,
} from "../../types.js";
import {
  getEnsureToolCallState,
  getMessagesSinceLastUser,
} from "../../ensureToolCall.js";
import { requestRetry } from "../../pipelineControl.js";
import { logger } from "../../../utils/logger.js";

export class EnsureToolCallResponseTransform implements ResponseTransform {
  name = "ensure-tool-call-response";
  stage: ResponseTransform["stage"] = "provider";
  priority = 100;

  applies(context: ResponseTransformContext): boolean {
    // Skip if synthetic response
    const headers = context.providerResponse?.headers || {};
    if (headers["x-synthetic-response"] === "true") {
      return false;
    }
    return Boolean(
      context.providerResponse?.body &&
        getEnsureToolCallState(context.request.state),
    );
  }

  transform(context: ResponseTransformContext): void {
    const ensureState = getEnsureToolCallState(context.request.state);
    if (!ensureState || !context.providerResponse) {
      return;
    }

    // Skip enforcement for synthetic responses to prevent loops
    const headers = context.providerResponse.headers || {};
    const isSyntheticResponse = headers["x-synthetic-response"] === "true";
    if (isSyntheticResponse) {
      logger.debug(
        { requestId: context.request.id },
        "Synthetic response detected, skipping EnsureToolCall enforcement",
      );
      return;
    }

    // Check for TodoWrite + keyword heuristics
    if (this.checkTerminationHeuristic(context)) {
      console.log(
        "[EnsureToolCall] TodoWrite + keyword heuristics detected. Accepting as termination.",
      );
      ensureState.pendingReminder = false;
      logger.info(
        {
          requestId: context.request.id,
        },
        "EnsureToolCall satisfied by TodoWrite + keyword heuristics",
      );
      return;
    }

    const body = asJsonObject(context.providerResponse.body);
    const choices = Array.isArray(body.choices)
      ? body.choices
      : ((body.choices = []) as JsonValue[]);

    let sawToolCall = false;
    let totalToolCalls = 0;

    for (const choice of choices) {
      if (!isJsonObject(choice)) {
        continue;
      }
      const message = asJsonObject(choice.message);
      const toolCalls = Array.isArray(message.tool_calls)
        ? message.tool_calls
        : [];
      totalToolCalls += toolCalls.length;
      if (!toolCalls.length) {
        continue;
      }

      sawToolCall = true;

      let sawOnlyTermination = false;
      const remaining = [];
      for (const toolCall of toolCalls) {
        const toolName = extractToolName(toolCall);

        if (
          toolName?.toLowerCase() === ensureState.terminationToolName ||
          toolName?.toLowerCase() === "final" ||
          /(call_*)?[0-9]+/.test(toolName ?? "")
        ) {
          console.log(`[EnsureToolCall] Termination tool "${toolName}" used.`);

          // Extract final_answer parameter
          const finalAnswer = extractFinalAnswer(toolCall);

          // Check if any previous assistant messages have meaningful content
          // or if the current response message has meaningful content
          const stateMessages = context.request.state.messages;
          const previousMessages = Array.isArray(stateMessages)
            ? stateMessages
            : [];
          const hasPreviousContent =
            this.hasMeaningfulAssistantContent(previousMessages);

          const firstChoice = choices[0];
          const currentMessage =
            isJsonObject(firstChoice) && isJsonObject(firstChoice.message)
              ? firstChoice.message
              : null;
          const hasCurrentContent = currentMessage
            ? hasMeaningfulContent(currentMessage.content)
            : false;

          const hasContent = hasPreviousContent || hasCurrentContent;

          // Check if final_answer is required
          if (!hasContent && !finalAnswer) {
            console.log(
              `[EnsureToolCall] Termination tool used without meaningful content or final_answer. Requesting retry.`,
            );
            ensureState.pendingReminder = true;
            ensureState.finalAnswerRequired = true;
            requestRetry(context.request.state);
            logger.warn(
              {
                requestId: context.request.id,
                reminderCount: ensureState.reminderCount,
              },
              "Termination tool called without final_answer when required; scheduling retry",
            );
            return;
          }

          // If we have no content but have final_answer, convert final_answer to message content
          if (!hasContent && finalAnswer && currentMessage) {
            console.log(
              `[EnsureToolCall] No meaningful content but final_answer provided. Converting to message content.`,
            );
            currentMessage.content = finalAnswer;
          }
          continue;
        }
        remaining.push(toolCall);
      }

      if (remaining.length) {
        message.tool_calls = remaining;
      } else {
        delete message.tool_calls;
      }

      // If the response only contained the termination tool and lacks meaningful
      // assistant content, clear content and any reasoning artifacts.
      sawOnlyTermination = toolCalls.length > 0 && remaining.length === 0;
      if (sawOnlyTermination && !hasMeaningfulContent(message.content)) {
        message.content = null;
        message.reasoning_content = null;
        delete message.reasoning_summary;
      }

      choice.message = message;
    }

    if (!sawToolCall) {
      console.log(
        `[EnsureToolCall] No tool calls found in response. Requesting retry (Attempt ${
          ensureState.reminderCount + 1
        }).`,
      );
      ensureState.pendingReminder = true;
      requestRetry(context.request.state);
      logger.warn(
        {
          requestId: context.request.id,
          reminderCount: ensureState.reminderCount,
        },
        "Provider response omitted tool calls; scheduling retry",
      );
      context.providerResponse.body = body;
      return;
    }

    ensureState.pendingReminder = false;
    logger.info(
      {
        requestId: context.request.id,
        observedToolCalls: totalToolCalls,
      },
      "EnsureToolCall satisfied by provider response",
    );
    context.providerResponse.body = body;
  }

  private hasMeaningfulAssistantContent(messages: JsonValue[]): boolean {
    if (!Array.isArray(messages)) return false;

    const messagesSinceLastUser = getMessagesSinceLastUser(messages);

    for (const m of messagesSinceLastUser) {
      if (isJsonObject(m) && m.role === "assistant") {
        if (hasMeaningfulContent(m.content)) {
          return true;
        }
      }
    }

    return false;
  }

  private checkTerminationHeuristic(
    context: ResponseTransformContext,
  ): boolean {
    if (!context.providerResponse?.body) return false;

    const body = asJsonObject(context.providerResponse.body);
    const choices = Array.isArray(body.choices) ? body.choices : [];
    if (choices.length === 0) return false;

    const firstChoice = choices[0];
    if (!isJsonObject(firstChoice)) return false;

    const message = asJsonObject(firstChoice.message);

    // Check message content termination keywords
    if (!hasCaseInsensitiveTerminationKeywords(message.content)) {
      return false;
    }

    // Check exactly one tool call and it's TodoWrite
    const toolCalls = Array.isArray(message.tool_calls)
      ? message.tool_calls
      : [];
    if (toolCalls.length !== 1) {
      return false;
    }

    const toolName = extractToolName(toolCalls[0]);
    if (!toolName || toolName.toLowerCase() !== "todowrite") {
      return false;
    }

    return true;
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

function extractFinalAnswer(tool: JsonValue): string | null {
  if (!isJsonObject(tool)) {
    return null;
  }
  const fn = isJsonObject(tool.function) ? tool.function : null;
  if (!fn) {
    return null;
  }

  let args: JsonObject | null = null;

  // Parse JSON string arguments
  if (typeof fn.arguments === "string") {
    try {
      const parsed = JSON.parse(fn.arguments);
      if (isJsonObject(parsed)) {
        args = parsed;
      }
    } catch {
      // Invalid JSON, skip
      return null;
    }
  } else if (isJsonObject(fn.arguments)) {
    args = fn.arguments;
  }

  if (!args) {
    return null;
  }

  if (isJsonObject(args.raw)) {
    args = args.raw;
  }

  const argName = /final[_-\s]?answer|final|answer|summary/i;

  const argKeys = Object.keys(args);
  for (const argKey of argKeys) {
    if (
      argName.test(argKey) &&
      typeof args[argKey] === "string" &&
      (args[argKey] as string).trim()
    ) {
      return args[argKey] as string;
    }
  }

  return null;
}

function asJsonObject(value: JsonValue | undefined): JsonObject {
  return isJsonObject(value) ? value : {};
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasMeaningfulContent(content: JsonValue | undefined): boolean {
  if (content === undefined || content === null) {
    return false;
  }
  if (typeof content === "string") {
    return Boolean(content.trim());
  }
  if (Array.isArray(content)) {
    return content.some((entry) => {
      if (typeof entry === "string") {
        return Boolean(entry.trim());
      }
      if (isJsonObject(entry) && typeof entry.text === "string") {
        return Boolean(entry.text.trim());
      }
      return true;
    });
  }
  if (isJsonObject(content)) {
    return Object.keys(content).length > 0;
  }
  return true;
}

function hasCaseInsensitiveTerminationKeywords(
  content: JsonValue | undefined,
): boolean {
  if (content === undefined || content === null) {
    return false;
  }
  if (typeof content === "string") {
    return /summary|changes/i.test(content);
  }
  if (Array.isArray(content)) {
    return content.some((entry) => {
      if (typeof entry === "string") {
        return /summary|changes/i.test(entry);
      }
      if (isJsonObject(entry) && typeof entry.text === "string") {
        return /summary|changes/i.test(entry.text);
      }
      return false;
    });
  }
  return false;
}
