import {
  RequestTransform,
  RequestTransformContext,
  JsonObject,
  JsonValue,
} from "../../types.js";
import {
  buildBaseInstruction,
  buildReminderInstruction,
  buildFinalAnswerRequirementInstruction,
  createTerminationToolDefinition,
  getEnsureToolCallState,
  EnsureToolCallState,
  getMessagesSinceLastUser,
} from "../../ensureToolCall.js";
import { logger } from "../../../utils/logger.js";
import { requestSyntheticResponse } from "../../pipelineControl.js";

export class EnsureToolCallRequestTransform implements RequestTransform {
  name = "ensure-tool-call-request";
  stage: RequestTransform["stage"] = "post-conversion";
  priority = 100;

  applies(context: RequestTransformContext): boolean {
    return Boolean(
      context.providerRequest?.body &&
        getEnsureToolCallState(context.request.state),
    );
  }

  transform(context: RequestTransformContext): void {
    const ensureState = getEnsureToolCallState(context.request.state);
    if (!ensureState || !context.providerRequest) {
      return;
    }

    const body = asJsonObject(context.providerRequest.body);
    // avoid infinite loops by detecting previous termination in the current session
    if (
      this.shouldSkipEnforcement(
        body.messages,
        context.request.state,
        context.request.id,
      )
    ) {
      logger.debug(
        { requestId: context.request.id },
        "EnsureToolCall skipped: previous turn termination detected",
      );
      return;
    }
    this.ensureToolRegistration(body, ensureState);
    const reminderAttached = this.ensureInstructionMessages(body, ensureState);
    context.providerRequest.body = body;

    if (reminderAttached) {
      logger.info(
        {
          requestId: context.request.id,
          reminderCount: ensureState.reminderCount,
        },
        "EnsureToolCall reminder appended to provider request",
      );
    }
  }

  private ensureToolRegistration(body: JsonObject, state: EnsureToolCallState) {
    const existing = Array.isArray(body.tools) ? [...body.tools] : [];
    const hasTerminationTool = existing.some(
      (tool) => extractToolName(tool) === state.terminationToolName,
    );
    if (!hasTerminationTool) {
      existing.push(createTerminationToolDefinition(state.terminationToolName));
    }
    body.tools = existing;
  }

  private ensureInstructionMessages(
    body: JsonObject,
    state: EnsureToolCallState,
  ): boolean {
    const messages = Array.isArray(body.messages)
      ? body.messages
      : ((body.messages = []) as JsonValue[]);

    const baseInstruction = buildBaseInstruction(state.terminationToolName);
    this.attachInstruction(messages, baseInstruction);

    let reminderAttached = false;
    if (state.pendingReminder) {
      let reminder: string;

      const nextReminderIndex = state.reminderCount + 1;
      if (state.finalAnswerRequired) {
        reminder = buildFinalAnswerRequirementInstruction(
          state.terminationToolName,
        );
        state.finalAnswerRequired = false; // Reset after showing the reminder
      } else {
        reminder = buildReminderInstruction(state.terminationToolName);
      }
      state.reminderCount = nextReminderIndex;

      this.attachInstruction(messages, reminder);
      state.pendingReminder = false;

      if (state.reminderHistory) {
        state.reminderHistory.push(reminder);
      } else {
        state.reminderHistory = [reminder];
      }
      reminderAttached = true;
    }

    return reminderAttached;
  }

  private attachInstruction(messages: JsonValue[], content: string) {
    const systemMessage = messages.find(
      (entry) =>
        isJsonObject(entry) &&
        entry.role === "system" &&
        typeof entry.content === "string",
    ) as JsonObject | undefined;

    if (systemMessage && typeof systemMessage.content === "string") {
      if (!systemMessage.content.includes(content)) {
        systemMessage.content = `${systemMessage.content}\n\n${content}`;
      }
      return;
    }

    messages.unshift({ role: "system", content });
  }

  private shouldSkipEnforcement(
    messages: JsonValue | undefined,
    requestState: Record<string, JsonValue>,
    requestId: string,
  ): boolean {
    if (!Array.isArray(messages)) return false;
    if (messages.length < 2) return false;

    const messagesSinceLastUser = getMessagesSinceLastUser(messages);

    // Search for any assistant message without tool calls
    for (const m of messagesSinceLastUser) {
      if (isJsonObject(m) && m.role === "assistant") {
        const hasToolCalls =
          Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
        if (!hasToolCalls) {
          // Request synthetic response to prevent infinite loops
          requestSyntheticResponse(requestState);
          logger.warn(
            { requestId },
            "Detected previous termination pattern, requesting synthetic response",
          );
          return true;
        }
      }
    }

    return false;
  }
}

function extractToolName(tool: JsonValue): string | null {
  if (!isJsonObject(tool)) {
    return null;
  }
  const functionDef = isJsonObject(tool.function) ? tool.function : null;
  if (!functionDef) {
    return null;
  }
  return typeof functionDef.name === "string" ? functionDef.name : null;
}

function asJsonObject(value: JsonValue | undefined): JsonObject {
  return isJsonObject(value) ? value : {};
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
