import { logger } from "../utils/logger.js";
import type { JsonObject, JsonValue } from "../core/types.js";

const TOOL_BLOCK_RE =
  /<\|tool_call_begin\|>\s*(?<name>[^\s]+)\s*<\|tool_call_argument_begin\|>\s*(?<args>.*?)\s*<\|tool_call_end\|>/gs;

const TOOL_SECTION_BEGIN = "<|tool_calls_section_begin|>";
const TOOL_SECTION_END = "<|tool_calls_section_end|>";

function cleanThinkingTags(text: string): string {
  if (!text) {
    return "";
  }

  let cleaned = text.replaceAll("(no content)", "");

  cleaned = cleaned.replace(
    /<thinking\s*>(.*?)<\/thinking\s*>/gis,
    (_, inner) => inner,
  );
  cleaned = cleaned.replace(
    /<think\s*>(.*?)<\/think\s*>/gis,
    (_, inner) => inner,
  );
  cleaned = cleaned.replace(/<\/think(?:ing)?\s*>/gi, "");
  cleaned = cleaned.replace(/<think(?:ing)?\s*>/gi, "");
  cleaned = cleaned.replace(/\n\s*\n\s*\n+/g, "\n\n");

  return cleaned.trim();
}

interface KimiToolCall extends JsonObject {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

    let argumentsJson = argsStr;
    try {
      JSON.parse(argsStr);
    } catch (error) {
      logger.warn({ err: error }, "Invalid JSON detected in tool arguments");
      argumentsJson = JSON.stringify({ raw: argsStr });
    }

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
}

export interface KimiFixResult {
  response: JsonObject;
  metadata: KimiFixMetadata;
}

export function fixKimiResponse(response: JsonObject): KimiFixResult {
  const metadata: KimiFixMetadata = {
    extractedToolCalls: 0,
    extractedFromReasoning: 0,
    extractedFromContent: 0,
    cleanedReasoningContent: false,
    cleanedMessageContent: false,
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

      const message = isJsonObject(choice.message)
        ? choice.message
        : ((choice.message = {}) as JsonObject);

      let aggregatedToolCalls = Array.isArray(message.tool_calls)
        ? [...(message.tool_calls as JsonObject[])]
        : [];

      if (typeof message.reasoning_content === "string") {
        const original = message.reasoning_content;
        const { cleanedText, extracted } = extractToolCallSections(original);
        const cleanedReasoning = cleanThinkingTags(cleanedText);
        if (cleanedReasoning !== original) {
          console.log("[KimiFixer] Cleaned reasoning content (thinking tags).");
          metadata.cleanedReasoningContent = true;
          message.reasoning_content = cleanedReasoning;
        }
        if (extracted.length) {
          console.log(
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
        const normalizedContent = normalizeContentText(cleanedText);
        if (normalizedContent !== original) {
          console.log(
            "[KimiFixer] Cleaned message content (text normalization).",
          );
          metadata.cleanedMessageContent = true;
          message.content = normalizedContent;
        }

        if (extracted.length) {
          console.log(
            `[KimiFixer] Extracted ${extracted.length} tool calls from message content.`,
          );
          aggregatedToolCalls = aggregatedToolCalls.concat(extracted);
          metadata.extractedFromContent += extracted.length;
          metadata.extractedToolCalls += extracted.length;
        }
      }

      if (aggregatedToolCalls.length) {
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

function normalizeContentText(text: string): string {
  if (!text) {
    return "";
  }
  return text.replaceAll("(no content)", "").trim();
}
