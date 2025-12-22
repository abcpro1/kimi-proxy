import {
  Transform,
  TransformContext,
  ContentBlock as ContentBlock,
  ToolCall as ToolCall,
  OutputBlock,
  type Message,
  type Response,
} from "./types.js";
import { safeJsonString } from "./json.js";
import {
  buildBaseInstruction,
  buildFinalAnswerRequirementInstruction,
  buildReminderInstruction,
  createTerminationToolDefinition,
  getEnsureToolCallState,
  getMessagesSinceLastUser,
  type EnsureToolCallState,
} from "./ensureToolCall.js";
import { requestRetry, requestSyntheticResponse } from "./pipelineControl.js";
import { logger } from "../utils/logger.js";

function normalizeContentBlocks(blocks: ContentBlock[]): ContentBlock[] {
  return blocks
    .map((block) => {
      if (block.type === "text") {
        return { type: "text", text: block.text ?? "" } as ContentBlock;
      }
      if (block.type === "image_url") {
        return block.url ? block : undefined;
      }
      if (block.type === "json") {
        return { type: "json", data: block.data } as ContentBlock;
      }
      return block;
    })
    .filter(Boolean) as ContentBlock[];
}

export class NormalizeTransform implements Transform {
  name = "normalize";
  stage: Transform["stage"] = "ingress";
  priority = 0;

  applies(): boolean {
    return true;
  }

  transform(context: TransformContext): void {
    context.request.messages = context.request.messages.map((message) => ({
      ...message,
      content: normalizeContentBlocks(message.content ?? []),
    }));

    if (context.request.tools && !context.request.tools.length) {
      context.request.tools = undefined;
    }
  }
}

function normalizeToolCallArguments(
  toolCalls: ToolCall[] | undefined,
): ToolCall[] | undefined {
  if (!toolCalls?.length) return undefined;
  const normalized: ToolCall[] = [];
  for (const call of toolCalls) {
    if (!call.name) {
      continue;
    }
    normalized.push({
      ...call,
      id: call.id || call.name,
      arguments: safeJsonString(call.arguments),
    });
  }
  return normalized.length ? normalized : undefined;
}

function inferFinishReason(blocks: OutputBlock[]): string | undefined {
  const message = blocks.find((block) => block.type === "message");
  if (message && message.type === "message") {
    if (message.tool_calls?.length) return "tool_calls";
    return message.status === "incomplete" ? "length" : "stop";
  }
  return undefined;
}

export class NormalizeResponseTransform implements Transform {
  name = "normalize-response";
  stage: Transform["stage"] = "egress";
  priority = 0;

  applies(context: TransformContext): boolean {
    return Boolean(context.response);
  }

  transform(context: TransformContext): void {
    const response = context.response;
    if (!response) return;

    response.output = response.output.map((block) => {
      if (block.type === "message") {
        return {
          ...block,
          content: normalizeContentBlocks(block.content ?? []),
          tool_calls: normalizeToolCallArguments(block.tool_calls),
          status:
            block.status ??
            (response.finish_reason === "length" ? "incomplete" : "completed"),
        };
      }
      if (block.type === "reasoning") {
        return {
          ...block,
          content: normalizeContentBlocks(block.content ?? []),
          summary: normalizeContentBlocks(block.summary ?? []),
        };
      }
      return block;
    });

    if (!response.finish_reason) {
      response.finish_reason = inferFinishReason(response.output);
    }
  }
}

export class PropagateFinishReasonsTransform implements Transform {
  name = "propagate-finish-reasons";
  stage: Transform["stage"] = "egress";
  priority = 100;

  applies(context: TransformContext): boolean {
    return Boolean(context.response);
  }

  transform(context: TransformContext): void {
    const response = context.response;
    if (!response) return;
    const messageBlock = response.output.find(
      (entry) => entry.type === "message",
    );
    if (!response.finish_reason && messageBlock?.type === "message") {
      response.finish_reason =
        messageBlock.status === "incomplete" ? "length" : "stop";
    }
  }
}

export class EnsureToolCallRequestTransform implements Transform {
  name = "ensure-tool-call-request";
  stage: Transform["stage"] = "ingress";
  priority = 100;

  applies(context: TransformContext): boolean {
    return Boolean(getEnsureToolCallState(context.request.state));
  }

  transform(context: TransformContext): void {
    const ensureState = getEnsureToolCallState(context.request.state);
    if (!ensureState) return;

    if (this.shouldSkipEnforcement(context.request.messages, context.request)) {
      logger.debug(
        { requestId: context.request.id },
        "EnsureToolCall skipped: termination pattern detected",
      );
      return;
    }

    this.ensureToolRegistration(context, ensureState);
    const reminderAttached = this.ensureInstructionMessages(
      context.request.messages,
      ensureState,
    );

    if (reminderAttached) {
      logger.info(
        {
          requestId: context.request.id,
          reminderCount: ensureState.reminderCount,
        },
        "EnsureToolCall reminder appended to request",
      );
    }
  }

  private ensureToolRegistration(
    context: TransformContext,
    state: EnsureToolCallState,
  ) {
    const existing = context.request.tools ? [...context.request.tools] : [];
    const termination = state.terminationToolName.toLowerCase();
    const hasTerminationTool = existing.some(
      (tool) => tool.name.toLowerCase() === termination,
    );
    if (!hasTerminationTool) {
      existing.push(createTerminationToolDefinition(state.terminationToolName));
    }
    context.request.tools = existing;
  }

  private ensureInstructionMessages(
    messages: Message[],
    state: EnsureToolCallState,
  ): boolean {
    const baseInstruction = buildBaseInstruction(state.terminationToolName);
    this.attachInstruction(messages, baseInstruction);

    let reminderAttached = false;
    if (state.pendingReminder) {
      const reminder = state.finalAnswerRequired
        ? buildFinalAnswerRequirementInstruction(state.terminationToolName)
        : buildReminderInstruction(state.terminationToolName);

      state.finalAnswerRequired = false;
      state.reminderCount += 1;
      state.pendingReminder = false;

      this.attachInstruction(messages, reminder);
      if (state.reminderHistory) {
        state.reminderHistory.push(reminder);
      } else {
        state.reminderHistory = [reminder];
      }

      reminderAttached = true;
    }

    return reminderAttached;
  }

  private attachInstruction(messages: Message[], content: string) {
    const systemMessage = messages.find((entry) => entry.role === "system") as
      | Message
      | undefined;

    if (systemMessage) {
      const combinedText = (systemMessage.content ?? [])
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("");

      if (combinedText.includes(content)) {
        return;
      }

      const blocks = systemMessage.content ?? (systemMessage.content = []);
      for (let i = blocks.length - 1; i >= 0; i--) {
        if (blocks[i]?.type === "text") {
          blocks[i] = {
            ...blocks[i],
            text: `${blocks[i].text ?? ""}\n\n${content}`,
          };
          return;
        }
      }

      blocks.push({ type: "text", text: content });
      return;
    }

    messages.unshift({
      role: "system",
      content: [{ type: "text", text: content }],
      tool_calls: undefined,
    });
  }

  private shouldSkipEnforcement(
    messages: Message[] | undefined,
    request: TransformContext["request"],
  ): boolean {
    if (!Array.isArray(messages) || messages.length < 2) return false;

    const messagesSinceLastUser = getMessagesSinceLastUser(messages);
    for (const message of messagesSinceLastUser) {
      if (message.role !== "assistant") continue;

      const toolCalls = message.tool_calls ?? [];
      if (toolCalls.length === 0) {
        requestSyntheticResponse(request.state);
        logger.warn(
          { requestId: request.id },
          "Detected prior assistant termination; requesting synthetic response",
        );
        return true;
      }

      if (
        toolCalls.length === 1 &&
        this.checkTerminationHeuristic(message, toolCalls[0], request)
      ) {
        requestSyntheticResponse(request.state);
        logger.warn(
          { requestId: request.id },
          "Detected TodoWrite termination heuristic; requesting synthetic response",
        );
        return true;
      }
    }

    return false;
  }

  private checkTerminationHeuristic(
    message: Message,
    toolCall: ToolCall,
    request: TransformContext["request"],
  ): boolean {
    // Only apply heuristic to models with "kimi" in their name
    if (!request.model.toLowerCase().includes("kimi")) {
      return false;
    }

    if (!hasCaseInsensitiveTerminationKeywords(message.content)) {
      return false;
    }

    return toolCall.name.toLowerCase() === "todowrite";
  }
}

function hasCaseInsensitiveTerminationKeywords(content: ContentBlock[]) {
  return content.some(
    (entry) =>
      entry.type === "text" && /summary|changes/i.test(entry.text ?? ""),
  );
}

export class EnsureToolCallResponseTransform implements Transform {
  name = "ensure-tool-call-response";
  stage: Transform["stage"] = "egress";
  priority = 50;

  applies(context: TransformContext): boolean {
    if (!context.response) return false;
    if (context.response.error) return false;
    if (context.response.metadata?.synthetic === true) return false;
    return Boolean(getEnsureToolCallState(context.request.state));
  }

  transform(context: TransformContext): void {
    const ensureState = getEnsureToolCallState(context.request.state);
    const response = context.response;
    if (!ensureState || !response) return;

    if (this.checkTerminationHeuristic(response, context.request)) {
      ensureState.pendingReminder = false;
      logger.info(
        { requestId: context.request.id },
        "EnsureToolCall satisfied by TodoWrite + keyword heuristics",
      );
      return;
    }

    const messageBlock = response.output.find(
      (block) => block.type === "message",
    );
    if (!messageBlock || messageBlock.type !== "message") {
      ensureState.pendingReminder = true;
      requestRetry(context.request.state);
      logger.warn(
        {
          requestId: context.request.id,
          reminderCount: ensureState.reminderCount,
        },
        "Provider response omitted message block; scheduling retry",
      );
      return;
    }

    const toolCalls = messageBlock.tool_calls ?? [];
    if (toolCalls.length === 0) {
      ensureState.pendingReminder = true;
      requestRetry(context.request.state);
      logger.warn(
        {
          requestId: context.request.id,
          reminderCount: ensureState.reminderCount,
        },
        "Provider response omitted tool calls; scheduling retry",
      );
      return;
    }

    const hasPreviousContent = this.hasMeaningfulAssistantContent(
      context.request.messages,
    );
    const hasCurrentContent = hasMeaningfulNonReasoningContent(
      messageBlock.content,
    );
    const hasContent = hasPreviousContent || hasCurrentContent;

    const remaining: typeof toolCalls = [];
    for (const toolCall of toolCalls) {
      if (this.isTerminationTool(toolCall.name, ensureState)) {
        const finalAnswer = extractFinalAnswer(toolCall.arguments);

        if (!hasContent && !finalAnswer) {
          ensureState.pendingReminder = true;
          ensureState.finalAnswerRequired = true;
          requestRetry(context.request.state);
          logger.warn(
            {
              requestId: context.request.id,
              reminderCount: ensureState.reminderCount,
            },
            "Termination tool called without final_answer; scheduling retry",
          );
          return;
        }

        if (!hasContent && finalAnswer) {
          messageBlock.content = [{ type: "text", text: finalAnswer }];
        } else if (hasContent && finalAnswer) {
          messageBlock.content.push({ type: "text", text: finalAnswer });
        }

        continue;
      }

      remaining.push(toolCall);
    }

    messageBlock.tool_calls = remaining.length ? remaining : undefined;

    const sawOnlyTermination =
      toolCalls.length > 0 && (messageBlock.tool_calls?.length ?? 0) === 0;
    if (
      sawOnlyTermination &&
      !hasMeaningfulNonReasoningContent(messageBlock.content)
    ) {
      messageBlock.content = [];
      response.output = response.output.filter(
        (block) => block.type !== "reasoning",
      );
    }

    if (
      (messageBlock.tool_calls?.length ?? 0) === 0 &&
      response.finish_reason === "tool_calls"
    ) {
      response.finish_reason = "stop";
    }

    ensureState.pendingReminder = false;
    logger.info(
      { requestId: context.request.id, observedToolCalls: toolCalls.length },
      "EnsureToolCall satisfied by provider response",
    );
  }

  private hasMeaningfulAssistantContent(messages: Message[]): boolean {
    const messagesSinceLastUser = getMessagesSinceLastUser(messages);
    for (const message of messagesSinceLastUser) {
      if (message.role !== "assistant") continue;
      if (hasMeaningfulNonReasoningContent(message.content)) {
        return true;
      }
    }
    return false;
  }

  private checkTerminationHeuristic(
    response: Response,
    request: TransformContext["request"],
  ): boolean {
    // Only apply heuristic to models with "kimi" in their name
    if (!request.model.toLowerCase().includes("kimi")) {
      return false;
    }

    const messageBlock = response.output.find(
      (block) => block.type === "message",
    );
    if (!messageBlock || messageBlock.type !== "message") return false;

    if (!hasCaseInsensitiveTerminationKeywords(messageBlock.content)) {
      return false;
    }

    const toolCalls = messageBlock.tool_calls ?? [];
    if (toolCalls.length !== 1) return false;

    return toolCalls[0].name.toLowerCase() === "todowrite";
  }

  private isTerminationTool(
    toolName: string,
    state: EnsureToolCallState,
  ): boolean {
    const normalized = toolName.toLowerCase();
    if (normalized === state.terminationToolName.toLowerCase()) return true;
    if (normalized === "final") return true;
    return /^(call_*)?[0-9]+$/.test(normalized);
  }
}

function hasMeaningfulNonReasoningContent(content: ContentBlock[]): boolean {
  if (!content.length) return false;
  for (const entry of content) {
    if (entry.type === "reasoning") continue;
    if (entry.type === "text") {
      if ((entry.text ?? "").trim()) return true;
      continue;
    }
    if (entry.type === "image_url") {
      if ((entry.url ?? "").trim()) return true;
      continue;
    }
    if (entry.type === "json") {
      if (entry.data !== undefined && entry.data !== null) return true;
      continue;
    }
    return true;
  }
  return false;
}

function extractFinalAnswer(argumentsJson: string | undefined): string | null {
  if (!argumentsJson) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  let args = parsed as Record<string, unknown>;
  if (
    typeof args.raw === "object" &&
    args.raw !== null &&
    !Array.isArray(args.raw)
  ) {
    args = args.raw as Record<string, unknown>;
  }

  const argName = /final[_-\s]?answer|final|answer|summary/i;
  for (const [key, value] of Object.entries(args)) {
    if (!argName.test(key)) continue;
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }

  return null;
}
