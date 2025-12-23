import { logger } from "../utils/logger.js";
import {
  isJsonObject,
  type JsonObject,
  type Request,
  getToolSchemas,
  findMatchingTool,
} from "../core/types.js";

const TOOL_BLOCK_RE =
  /<\|tool_call_begin\|>\s*(?<name>[^\s]+)\s*<\|tool_call_argument_begin\|>\s*(?<args>.*?)\s*<\|tool_call_end\|>/gs;

const TOOL_SECTION_BEGIN = "<|tool_calls_section_begin|>";
const TOOL_SECTION_END = "<|tool_calls_section_end|>";

function cleanText(text: string): string {
  if (!text) return "";
  return text
    .replaceAll("(no content)", "")
    .replace(/<tool_call>[a-zA-Z0-9_:-]+/g, "")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

interface CleanThinkingResult {
  cleaned: string;
  extractedThinking: string;
}

function cleanThinking(text: string, extract = false): CleanThinkingResult {
  if (!text) return { cleaned: "", extractedThinking: "" };

  text = cleanText(text);

  if (!extract) {
    // For reasoning content: keep inner text in place
    const tags = /<\/?think(?:ing)?\s*\/?>/gi;
    const cleaned = text.replace(tags, "");
    return { cleaned, extractedThinking: "" };
  }

  const extracted: string[] = [];
  let cleaned = text;

  // Balanced <think>...</think> / <thinking>...</thinking>
  cleaned = cleaned.replace(
    /<(think|thinking)\s*>([\s\S]*?)<\/\1\s*>/gi,
    (_match, _tag, inner: string) => {
      const trimmed = inner.trim();
      if (trimmed) extracted.push(trimmed);
      return "";
    },
  );

  // Orphan closing tags: "thinking...</think> actual"
  while (true) {
    const match = cleaned.match(/<\/(think|thinking)\s*>/i);
    if (!match || match.index === undefined) break;

    const before = cleaned.slice(0, match.index).trim();
    if (before) extracted.push(before);

    cleaned = cleaned.slice(match.index + match[0].length);
  }

  // Orphan opening tags: "<think>thinking..." (no close)
  while (true) {
    const match = cleaned.match(/<(think|thinking)\s*>/i);
    if (!match || match.index === undefined) break;

    const afterStart = match.index + match[0].length;
    const after = cleaned.slice(afterStart).trim();
    if (after) extracted.push(after);

    cleaned = cleaned.slice(0, match.index);
  }

  return {
    cleaned: cleaned.replace(/<\/?think(?:ing)?\s*\/?>/gi, "").trim(),
    extractedThinking: extracted.join("\n\n").trim(),
  };
}

interface KimiToolCall extends JsonObject {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

function parseToolCalls(section: string): KimiToolCall[] {
  const toolCalls: KimiToolCall[] = [];
  const matches = section.matchAll(TOOL_BLOCK_RE);
  let index = 0;

  for (const match of matches) {
    const rawName = match.groups?.name?.trim() ?? "";
    const argsStr = match.groups?.args?.trim() ?? "";

    let functionName = rawName;
    let callId = `call_${index}`;

    if (rawName.includes(".")) {
      const [, rest] = rawName.split(".", 2);
      functionName = rest;
    }

    if (functionName.includes(":")) {
      const [name, idPart] = functionName.split(":", 2);
      functionName = name;
      if (idPart) {
        callId = idPart;
      }
    }

    const argumentsJson = argsStr;

    toolCalls.push({
      id: callId,
      type: "function",
      function: {
        name: functionName,
        arguments: argumentsJson,
      },
    });

    index += 1;
  }

  return toolCalls;
}

export interface KimiFixMetadata extends JsonObject {
  extractedToolCalls: number;
  extractedFromReasoning: number;
  extractedFromContent: number;
  cleanedReasoningContent: boolean;
  cleanedMessageContent: boolean;
  repairedToolNames: number;
}

export interface KimiFixResult {
  response: JsonObject;
  metadata: KimiFixMetadata;
}

export function repairToolNames(
  toolCalls: JsonObject[],
  request: Request,
): number {
  const schemas = getToolSchemas(request);
  const toolNames = new Set(Object.keys(schemas));
  let repairedCount = 0;

  for (const call of toolCalls) {
    if (call.type !== "function" || !isJsonObject(call.function)) continue;

    const fn = call.function as JsonObject;
    if (typeof fn.name === "number") {
      fn.name = String(fn.name);
    }
    const name = fn.name;
    if (typeof name !== "string") continue;

    // If name is already valid, skip
    if (toolNames.has(name)) continue;

    // Try to find a match
    const match = findMatchingTool(request, fn.arguments);
    if (match) {
      logger.debug(`[KimiFixer] Repaired tool name: ${name} -> ${match}`);
      fn.name = match;
      repairedCount++;
    }
  }

  return repairedCount;
}

export function fixKimiResponse(
  response: JsonObject,
  request: Request,
): KimiFixResult {
  const metadata: KimiFixMetadata = {
    extractedToolCalls: 0,
    extractedFromReasoning: 0,
    extractedFromContent: 0,
    cleanedReasoningContent: false,
    cleanedMessageContent: false,
    repairedToolNames: 0,
  };

  try {
    const choices = response?.choices;
    if (!Array.isArray(choices) || !choices.length) {
      return { response, metadata };
    }

    for (const choice of choices) {
      if (!isJsonObject(choice)) {
        continue;
      }

      const message =
        choice.message !== undefined && isJsonObject(choice.message)
          ? choice.message
          : ((choice.message = {}) as JsonObject);

      const rawToolCalls = message.tool_calls;
      let aggregatedToolCalls = Array.isArray(rawToolCalls)
        ? [...(rawToolCalls as unknown as JsonObject[])]
        : [];

      // Handle 'reasoning' field if 'reasoning_content' is missing
      if (typeof message.reasoning === "string" && !message.reasoning_content) {
        message.reasoning_content = message.reasoning;
      }

      // Handle 'reasoning_details' if reasoning_content is still missing
      if (
        Array.isArray(message.reasoning_details) &&
        !message.reasoning_content
      ) {
        const details = message.reasoning_details as Array<{
          type?: string;
          text?: string;
        }>;
        const text = details
          .filter(
            (d) => d.type === "reasoning.text" && typeof d.text === "string",
          )
          .map((d) => d.text as string)
          .join("\n\n");
        if (text) {
          message.reasoning_content = text;
        }
      }

      if (typeof message.reasoning_content === "string") {
        const original = message.reasoning_content;
        const { cleanedText, extracted } = extractToolCallSections(original);
        const cleanedReasoning = cleanThinking(cleanedText, false).cleaned;
        if (cleanedReasoning !== original) {
          logger.debug(
            "[KimiFixer] Cleaned reasoning content (thinking tags).",
          );
          metadata.cleanedReasoningContent = true;
          message.reasoning_content = cleanedReasoning;
        }
        if (extracted.length) {
          logger.debug(
            `[KimiFixer] Extracted ${extracted.length} tool calls from reasoning content.`,
          );
          aggregatedToolCalls = aggregatedToolCalls.concat(extracted);
          metadata.extractedFromReasoning += extracted.length;
          metadata.extractedToolCalls += extracted.length;
        }
      }

      if (typeof message.content === "string") {
        const original = message.content;
        const { cleanedText, extracted } = extractToolCallSections(original);

        // Extract thinking tags from content and move to reasoning_content
        // Handle multiple formats:
        // 1. <thinking>thinking content</thinking> actual content
        // 2. thinking content</think> actual content
        // 3. thinking content... actual content (self-closing or incomplete tag)

        const { cleaned, extractedThinking } = cleanThinking(cleanedText, true);
        const normalizedContent = cleaned;
        const thinkingContent = extractedThinking;

        if (normalizedContent !== original) {
          logger.debug(
            "[KimiFixer] Cleaned message content (thinking tags and normalization).",
          );
          metadata.cleanedMessageContent = true;
          message.content = normalizedContent;
        }

        if (thinkingContent) {
          // Add extracted thinking content to reasoning_content
          const existingReasoning =
            typeof message.reasoning_content === "string"
              ? message.reasoning_content
              : "";
          message.reasoning_content = existingReasoning
            ? `${existingReasoning}\n\n${thinkingContent}`
            : thinkingContent;
          logger.debug(
            "[KimiFixer] Extracted thinking content from message.content to reasoning_content.",
          );
          metadata.extractedFromContent += 1;
        }

        if (extracted.length) {
          logger.debug(
            `[KimiFixer] Extracted ${extracted.length} tool calls from message content.`,
          );
          aggregatedToolCalls = aggregatedToolCalls.concat(extracted);
          metadata.extractedFromContent += extracted.length;
          metadata.extractedToolCalls += extracted.length;
        }
      }

      if (aggregatedToolCalls.length) {
        const repaired = repairToolNames(aggregatedToolCalls, request);
        if (repaired > 0) {
          metadata.repairedToolNames =
            (metadata.repairedToolNames || 0) + repaired;
        }
        message.tool_calls = aggregatedToolCalls;
        choice.finish_reason = "tool_calls";
      } else if ("tool_calls" in message) {
        delete message.tool_calls;
      }
    }

    return { response, metadata };
  } catch (error) {
    logger.error({ err: error }, "Failed to fix Kimi response");
    return { response, metadata };
  }
}

function extractToolCallSections(text: string): {
  cleanedText: string;
  extracted: KimiToolCall[];
} {
  if (!text || !text.includes(TOOL_SECTION_BEGIN)) {
    return { cleanedText: text ?? "", extracted: [] };
  }

  let remaining = text;
  const extracted: KimiToolCall[] = [];

  while (remaining.includes(TOOL_SECTION_BEGIN)) {
    const start = remaining.indexOf(TOOL_SECTION_BEGIN);
    if (start === -1) {
      break;
    }
    const afterStart = start + TOOL_SECTION_BEGIN.length;
    const end = remaining.indexOf(TOOL_SECTION_END, afterStart);
    const section =
      end === -1
        ? remaining.slice(afterStart)
        : remaining.slice(afterStart, end);
    extracted.push(...parseToolCalls(section));
    remaining =
      end === -1
        ? remaining.slice(0, start)
        : `${remaining.slice(0, start)}${remaining.slice(
            end + TOOL_SECTION_END.length,
          )}`;
  }

  return { cleanedText: remaining.trim(), extracted };
}
