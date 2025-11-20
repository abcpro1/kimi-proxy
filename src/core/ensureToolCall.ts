import { JsonObject, JsonValue } from "./types.js";

export const ENSURE_TOOL_CALL_STATE_KEY = "__ensureToolCall";
export const DEFAULT_TERMINATION_TOOL_NAME = "done";

export interface EnsureToolCallState extends JsonObject {
  enabled: boolean;
  terminationToolName: string;
  reminderCount: number;
  pendingReminder: boolean;
  finalAnswerRequired?: boolean;
  reminderHistory?: string[];
}

const BASE_INSTRUCTION_TEMPLATE = (toolName: string) =>
  `Always reply with at least one tool call so the client can continue orchestrating actions. When you have completely finished and are ready to hand back the final result, call the "${toolName}" function to signal completion.`;

const REMINDER_TEMPLATE = (toolName: string) =>
  `The client will not continue unless you reply with a tool call. Use the available tools for work and call "${toolName}" when you are done.`;

const FINAL_ANSWER_REQUIREMENT_TEMPLATE = (toolName: string) =>
  `Please use the tool "${toolName}" with a final answer. You must include a final_answer with your response.`;

export function createEnsureToolCallState(
  state: Record<string, JsonValue>,
  options?: { terminationToolName?: string },
): EnsureToolCallState {
  const terminationToolName =
    options?.terminationToolName ?? DEFAULT_TERMINATION_TOOL_NAME;
  const ensureState: EnsureToolCallState = {
    enabled: true,
    terminationToolName,
    reminderCount: 0,
    pendingReminder: false,
  };
  state[ENSURE_TOOL_CALL_STATE_KEY] = ensureState;
  return ensureState;
}

export function getEnsureToolCallState(
  state: Record<string, JsonValue>,
): EnsureToolCallState | null {
  const raw = state[ENSURE_TOOL_CALL_STATE_KEY];
  if (!isJsonObject(raw)) {
    return null;
  }
  const ensureState = raw as EnsureToolCallState;
  if (ensureState.enabled !== true) {
    return null;
  }
  ensureState.terminationToolName =
    typeof ensureState.terminationToolName === "string"
      ? ensureState.terminationToolName
      : DEFAULT_TERMINATION_TOOL_NAME;
  ensureState.reminderCount =
    typeof ensureState.reminderCount === "number"
      ? ensureState.reminderCount
      : 0;
  ensureState.pendingReminder = Boolean(ensureState.pendingReminder);
  return ensureState;
}

export function buildBaseInstruction(toolName: string): string {
  return BASE_INSTRUCTION_TEMPLATE(toolName);
}

export function buildReminderInstruction(toolName: string): string {
  return REMINDER_TEMPLATE(toolName);
}

export function buildFinalAnswerRequirementInstruction(
  toolName: string,
): string {
  return FINAL_ANSWER_REQUIREMENT_TEMPLATE(toolName);
}

export function createTerminationToolDefinition(name: string): JsonObject {
  return {
    type: "function",
    function: {
      name,
      description:
        "Call this tool exactly once when you have fully completed all reasoning and actions.",
      parameters: {
        type: "object",
        properties: {
          final_answer: {
            type: "string",
            description: "Optional final answer to provide when terminating.",
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
  };
}

/**
 * Get messages from the last user message to the end of the array.
 * Returns empty array if no user message is found.
 */
export function getMessagesSinceLastUser(messages: JsonValue[]): JsonValue[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    return [];
  }

  // Find the index of the last user message by searching backward
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (isJsonObject(m) && m.role === "user") {
      lastUserIndex = i;
      break;
    }
  }

  // If no user message found, return empty array
  if (lastUserIndex === -1) {
    return [];
  }

  // Return messages from lastUserIndex to end (inclusive)
  return messages.slice(lastUserIndex);
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
