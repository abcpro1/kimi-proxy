import {
  ClientFormat,
  ProviderFormat,
  ProxyOperation,
  ConversionContext,
  ConvertedRequest,
  JsonValue,
  JsonObject,
} from "../types.js";
import { Converter } from "./types.js";

interface NormalizedMessage extends JsonObject {
  role: string;
  content: JsonValue;
  tool_calls?: NormalizedToolCall[];
  tool_call_id?: string;
}

interface NormalizedToolCall extends JsonObject {
  id?: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface ResponseMessageOutput extends JsonObject {
  content: JsonObject[];
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asJsonObject(value: JsonValue | undefined): JsonObject {
  return isJsonObject(value) ? value : {};
}

function asJsonObjectArray(value: JsonValue | undefined): JsonObject[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is JsonObject => isJsonObject(entry));
}

export class OpenAIChatPassthroughConverter
  implements Converter<JsonValue, JsonValue, JsonValue, JsonValue>
{
  name = "openai-chat";
  sourceFormat = ClientFormat.OpenAIChatCompletions;
  targetFormat = ProviderFormat.OpenAIChatCompletions;
  operations = [ProxyOperation.ChatCompletions];

  convertRequest(
    body: JsonValue,
    _context: ConversionContext<JsonValue>,
  ): ConvertedRequest<JsonValue> {
    void _context;
    return { body };
  }

  convertResponse(
    body: JsonValue,
    _context: ConversionContext<JsonValue>,
  ): JsonValue {
    void _context;
    return ensureChatCompletionResponse(body) ?? body;
  }
}

export class OpenAIResponsesPassthroughConverter implements Converter {
  name = "openai-responses";
  sourceFormat = ClientFormat.OpenAIResponses;
  targetFormat = ProviderFormat.OpenAIChatCompletions;
  operations = [ProxyOperation.Responses];

  convertRequest(
    body: JsonValue,
    _context: ConversionContext<JsonValue>,
  ): ConvertedRequest<JsonValue> {
    void _context;
    const normalized: JsonObject = isJsonObject(body) ? { ...body } : {};
    const messages: JsonValue[] = Array.isArray(normalized.messages)
      ? [...normalized.messages]
      : [];
    const normalizedMessages = messages
      .map((message) => normalizeMessage(message))
      .filter((message): message is NormalizedMessage => Boolean(message));
    const systemInstruction = normalizeInstruction(normalized.instructions);
    const inputMessages = normalizeInput(normalized.input);

    const finalMessages: NormalizedMessage[] = [];
    if (systemInstruction) {
      finalMessages.push(systemInstruction);
    }
    if (normalizedMessages.length) {
      finalMessages.push(...normalizedMessages);
    }
    if (inputMessages.length) {
      finalMessages.push(...inputMessages);
    }

    if (finalMessages.length) {
      normalized.messages = finalMessages;
    }

    const normalizedTools = normalizeTools(normalized.tools);
    if (normalizedTools.length) {
      normalized.tools = normalizedTools;
    } else {
      delete normalized.tools;
    }

    delete normalized.input;
    delete normalized.instructions;
    return { body: normalized };
  }

  convertResponse(body: JsonValue): JsonValue {
    const normalizedBody = ensureChatCompletionResponse(body);
    const normalizedResponse = asJsonObject(normalizedBody);
    const responseId =
      typeof normalizedResponse.id === "string"
        ? normalizedResponse.id
        : undefined;
    const choices = asJsonObjectArray(normalizedResponse.choices);
    const outputs = choices.length
      ? choices.flatMap((choice, index) =>
          convertChoiceToResponseOutputs(choice, index, responseId),
        )
      : [createEmptyOutput(responseId)];
    const outputText = collectOutputText(outputs);

    const response: JsonObject = {
      id: normalizedResponse.id,
      object: "response",
      created: normalizedResponse.created ?? Math.floor(Date.now() / 1000),
      model: normalizedResponse.model,
      usage: normalizeResponseUsage(normalizedResponse.usage),
      status: resolveResponseStatus(),
      output: outputs,
    };

    if (outputText.length) {
      response.output_text = outputText;
    }

    return response;
  }
}

function normalizeInstruction(
  value: JsonValue | undefined,
): NormalizedMessage | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  return { role: "system", content: value.trim() };
}

function normalizeInput(value: JsonValue | undefined): NormalizedMessage[] {
  if (value === undefined || value === null) {
    return [];
  }

  if (typeof value === "string") {
    return [{ role: "user", content: value }];
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeMessage(entry))
      .filter((entry): entry is NormalizedMessage => Boolean(entry));
  }

  const normalized = normalizeMessage(value);
  return normalized ? [normalized] : [];
}

function normalizeMessage(
  value: JsonValue | undefined,
): NormalizedMessage | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === "string") {
    return { role: "user", content: value };
  }

  if (typeof value === "object") {
    const record = value as JsonObject;

    if (record.type === "function_call") {
      return {
        role: "assistant",
        content: normalizeMessageContent(record.content ?? record.text ?? ""),
        tool_calls: [
          {
            id: typeof record.call_id === "string" ? record.call_id : undefined,
            type: "function",
            function: {
              name: typeof record.name === "string" ? record.name : "",
              arguments:
                typeof record.arguments === "string"
                  ? record.arguments
                  : JSON.stringify(record.arguments ?? {}),
            },
          },
        ],
      };
    }

    if (record.type === "function_call_output") {
      return {
        role: "tool",
        tool_call_id:
          typeof record.call_id === "string" ? record.call_id : undefined,
        content: normalizeMessageContent(
          record.output ?? record.content ?? record.text ?? "",
        ),
      };
    }

    const role = typeof record.role === "string" ? record.role : "user";
    const content = normalizeMessageContent(
      record.content ?? record.text ?? "",
    );
    const normalized: NormalizedMessage = {
      ...record,
      role,
      content,
    };
    const toolCalls = normalizeToolCalls(record.tool_calls);
    if (toolCalls?.length) {
      normalized.tool_calls = toolCalls;
    } else {
      delete normalized.tool_calls;
    }
    return normalized;
  }

  return null;
}

function normalizeMessageContent(value: JsonValue | undefined): JsonValue {
  if (value === undefined || value === null) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => convertInputContentPart(entry))
      .filter((entry): entry is JsonObject => Boolean(entry));
  }

  if (typeof value === "object") {
    const converted = convertInputContentPart(value);
    return converted ? [converted] : "";
  }

  return String(value);
}

function convertInputContentPart(part: JsonValue) {
  if (part === undefined || part === null) {
    return { type: "text", text: "" };
  }

  if (typeof part === "string") {
    return { type: "text", text: part };
  }

  if (typeof part !== "object") {
    return { type: "text", text: String(part) };
  }

  const record = { ...part } as JsonObject;
  const type = record.type;

  if (type === "input_text") {
    return { type: "text", text: record.text ?? "" };
  }

  if (type === "input_image") {
    return {
      type: "image_url",
      image_url: record.image_url ?? record.url ?? record.source ?? null,
    };
  }

  if (type === "text" && typeof record.text === "string") {
    return { type: "text", text: record.text };
  }

  if (type === "image_url") {
    return {
      type: "image_url",
      image_url: record.image_url ?? record.url ?? null,
    };
  }

  if (type === "output_text") {
    return { type: "text", text: record.text ?? "" };
  }

  if (type === "output_image") {
    return {
      type: "image_url",
      image_url: record.image_url ?? record.url ?? null,
    };
  }

  if (type === "reasoning_text") {
    return { type: "text", text: record.text ?? "" };
  }

  if (!type && typeof record.text === "string") {
    return { type: "text", text: record.text };
  }

  return record;
}

function normalizeTools(value: JsonValue | undefined): JsonObject[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((tool) => convertToolDefinition(tool))
    .filter((tool): tool is JsonObject => Boolean(tool));
}

function convertToolDefinition(tool: JsonValue) {
  if (!isJsonObject(tool)) {
    return null;
  }

  const fn = asJsonObject(tool.function);
  const name = typeof fn.name === "string" ? fn.name : tool.name;
  if (!name) {
    return null;
  }

  const description =
    typeof fn.description === "string" ? fn.description : tool.description;
  const parametersValue = fn.parameters ?? tool.parameters;
  const parameters = isJsonObject(parametersValue)
    ? parametersValue
    : undefined;
  const formatValue = fn.format ?? tool.format;
  const format = typeof formatValue === "string" ? formatValue : undefined;
  const strictValue =
    typeof tool.strict === "boolean" ? tool.strict : fn.strict;
  const strict = typeof strictValue === "boolean" ? strictValue : undefined;

  const functionDefinition: JsonObject = {
    name,
    ...(description ? { description } : {}),
    ...(parameters ? { parameters } : {}),
  };

  if (format) {
    functionDefinition.format = format;
  }

  const normalized: JsonObject = {
    type: "function",
    function: functionDefinition,
  };

  if (strict !== undefined) {
    normalized.strict = strict;
  }

  return normalized;
}

function normalizeToolCalls(
  value: JsonValue | undefined,
): NormalizedToolCall[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const calls = value
    .map((entry) => normalizeToolCallEntry(entry))
    .filter((entry): entry is NormalizedToolCall => Boolean(entry));
  return calls.length ? calls : undefined;
}

function normalizeToolCallEntry(entry: JsonValue): NormalizedToolCall | null {
  if (!isJsonObject(entry)) {
    return null;
  }

  const fn = asJsonObject(entry.function);
  const fnName = typeof fn.name === "string" ? fn.name : undefined;
  const recordName = typeof entry.name === "string" ? entry.name : undefined;
  const name = fnName ?? recordName;
  if (!name) {
    return null;
  }

  const args = normalizeArguments(fn.arguments ?? entry.arguments ?? "");

  return {
    id: typeof entry.id === "string" ? entry.id : undefined,
    type: "function",
    function: {
      name,
      arguments: args,
    },
  };
}

function normalizeArguments(value: JsonValue | undefined): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value ?? "");
  } catch {
    return "";
  }
}

function ensureChatCompletionResponse(payload: JsonValue): JsonValue {
  if (typeof payload === "string") {
    return parseOpenAIChatStream(payload) ?? { object: "stream", payload };
  }
  return payload;
}

function parseOpenAIChatStream(payload: string): JsonObject | null {
  const events = extractSSEEvents(payload);
  if (!events.length) {
    return null;
  }
  return consolidateChatCompletionChunks(events);
}

function extractSSEEvents(payload: string): JsonObject[] {
  const events: JsonObject[] = [];
  const lines = payload.split(/\n/);
  let buffer: string[] = [];

  const flush = () => {
    if (!buffer.length) {
      return;
    }
    const data = buffer.join("\n").trim();
    buffer = [];
    if (!data || data === "[DONE]") {
      return;
    }
    try {
      const parsed = JSON.parse(data);
      if (isJsonObject(parsed)) {
        events.push(parsed);
      }
    } catch {
      // ignore invalid chunks
    }
  };

  for (const raw of lines) {
    if (raw.startsWith("data:")) {
      buffer.push(raw.slice(5).trimStart());
    } else if (raw.trim() === "") {
      flush();
    }
  }
  flush();
  return events;
}

interface ChoiceAggregationState {
  index: number;
  role?: string;
  textBuffer: string;
  contentMode: "string" | "array";
  contentParts: JsonValue[];
  toolCalls?: Array<{
    id?: string;
    type?: string;
    function: { name?: string; arguments?: string };
  }>;
  finishReason?: string | null;
}

function consolidateChatCompletionChunks(chunks: JsonObject[]): JsonObject {
  const result: JsonObject = {
    id: chunks[0]?.id ?? "streamed-response",
    object: "chat.completion",
    created: chunks[0]?.created ?? Math.floor(Date.now() / 1000),
    model: chunks[0]?.model,
    usage: {},
    choices: [],
  };

  const choiceStates = new Map<number, ChoiceAggregationState>();

  for (const chunk of chunks) {
    if (!chunk || typeof chunk !== "object") {
      continue;
    }
    if (chunk.id) {
      result.id = chunk.id;
    }
    if (chunk.created) {
      result.created = chunk.created;
    }
    if (chunk.model) {
      result.model = chunk.model;
    }
    if (chunk.usage) {
      result.usage = chunk.usage;
    }

    const choices = asJsonObjectArray(chunk.choices);
    for (const choice of choices) {
      const index = typeof choice.index === "number" ? choice.index : 0;
      let state = choiceStates.get(index);
      if (!state) {
        state = {
          index,
          textBuffer: "",
          contentMode: "string",
          contentParts: [],
        };
        choiceStates.set(index, state);
      }

      const delta = asJsonObject(choice.delta);
      if (typeof delta.role === "string") {
        state.role = delta.role;
      }
      appendDeltaContent(state, delta.content);
      appendDeltaToolCalls(state, delta.tool_calls);

      if (typeof choice.finish_reason === "string") {
        state.finishReason = choice.finish_reason;
      }
    }
  }

  result.choices = Array.from(choiceStates.values())
    .sort((a, b) => a.index - b.index)
    .map((state) => ({
      index: state.index,
      finish_reason: state.finishReason ?? null,
      message: {
        role: state.role ?? "assistant",
        content: finalizeContent(state),
        ...(state.toolCalls?.length ? { tool_calls: state.toolCalls } : {}),
      },
    }));

  return result;
}

function appendDeltaContent(
  state: ChoiceAggregationState,
  content: JsonValue | undefined,
) {
  if (content === undefined || content === null) {
    return;
  }

  if (typeof content === "string") {
    if (state.contentMode === "array") {
      state.contentParts.push({ type: "text", text: content });
    } else {
      state.textBuffer += content;
    }
    return;
  }

  if (Array.isArray(content)) {
    ensureArrayContent(state);
    for (const part of content) {
      if (part === undefined || part === null) {
        continue;
      }
      if (typeof part === "string") {
        state.contentParts.push({ type: "text", text: part });
      } else {
        state.contentParts.push(part);
      }
    }
    return;
  }

  if (typeof content === "object") {
    ensureArrayContent(state);
    state.contentParts.push(content);
  }
}

function ensureArrayContent(state: ChoiceAggregationState) {
  if (state.contentMode === "array") {
    return;
  }
  state.contentMode = "array";
  if (state.textBuffer) {
    state.contentParts.push({ type: "text", text: state.textBuffer });
    state.textBuffer = "";
  }
}

function appendDeltaToolCalls(
  state: ChoiceAggregationState,
  toolCalls: JsonValue | undefined,
) {
  if (!Array.isArray(toolCalls)) {
    return;
  }
  state.toolCalls = state.toolCalls ?? [];
  for (const call of toolCalls) {
    if (!isJsonObject(call)) {
      continue;
    }
    const index =
      typeof call.index === "number" ? call.index : state.toolCalls.length;
    if (!state.toolCalls[index]) {
      state.toolCalls[index] = {
        id: typeof call.id === "string" ? call.id : undefined,
        type: typeof call.type === "string" ? call.type : "function",
        function: {
          name: undefined,
          arguments: "",
        },
      };
    }
    const target = state.toolCalls[index];
    if (typeof call.id === "string") {
      target.id = call.id;
    }
    if (typeof call.type === "string") {
      target.type = call.type;
    }
    const fn = isJsonObject(call.function) ? call.function : undefined;
    if (fn && typeof fn.name === "string") {
      target.function.name = fn.name;
    }
    if (fn && typeof fn.arguments === "string") {
      target.function.arguments =
        (target.function.arguments ?? "") + fn.arguments;
    }
  }
}

function finalizeContent(state: ChoiceAggregationState): JsonValue {
  if (state.contentMode === "array") {
    if (state.textBuffer) {
      state.contentParts.push({ type: "text", text: state.textBuffer });
      state.textBuffer = "";
    }
    return state.contentParts;
  }
  return state.textBuffer;
}

function convertChoiceToResponseOutputs(
  choice: JsonObject,
  index: number,
  responseId?: string,
): JsonObject[] {
  const message = asJsonObject(choice?.message);
  const content = buildResponseContent(message);
  const outputs: JsonObject[] = [];
  const finishReason =
    typeof choice?.finish_reason === "string" ? choice.finish_reason : "stop";

  const resolvedResponseId = responseId ?? "resp";
  const messageId =
    typeof message.id === "string" && message.id.length
      ? message.id
      : `${resolvedResponseId}_msg_${index}`;
  const role = typeof message.role === "string" ? message.role : "assistant";
  const messageOutput: ResponseMessageOutput = {
    id: messageId,
    object: "message",
    type: "message",
    role,
    status: resolveItemStatus(finishReason),
    content,
  };

  if (isJsonObject(message.metadata)) {
    messageOutput.metadata = message.metadata;
  }

  if (message.refusal) {
    messageOutput.content.push(createRefusalBlock(message.refusal));
  }

  outputs.push(messageOutput);

  const reasoningBlocks = normalizeReasoningContent(
    message.reasoning_content ?? [],
  );
  const reasoningRecord = asJsonObject(message.reasoning);
  const reasoningSummarySource =
    message.reasoning_summary ?? reasoningRecord.summary;
  const reasoningSummary = normalizeReasoningSummary(reasoningSummarySource);

  if (reasoningBlocks.length || reasoningSummary.length) {
    outputs.push({
      id: `${messageId}_reasoning`,
      object: "reasoning",
      type: "reasoning",
      status: "completed",
      summary: reasoningSummary,
      content: reasoningBlocks,
    });
  }

  const toolCalls = asJsonObjectArray(message.tool_calls);
  if (toolCalls.length) {
    for (const [toolIndex, toolCall] of toolCalls.entries()) {
      outputs.push(
        convertToolCallOutput(toolCall, {
          responseId,
          choiceIndex: index,
          toolIndex,
        }),
      );
    }
  }

  return outputs;
}

function buildResponseContent(message: JsonObject): JsonObject[] {
  const content = message?.content;
  const blocks: JsonObject[] = [];

  if (Array.isArray(content)) {
    for (const part of content) {
      blocks.push(convertContentPart(part));
    }
  } else if (typeof content === "string") {
    blocks.push({ type: "output_text", text: content });
  } else if (content && typeof content === "object") {
    blocks.push(convertContentPart(content));
  }

  return blocks.length ? blocks : [{ type: "output_text", text: "" }];
}

function convertContentPart(part: JsonValue) {
  if (part === undefined || part === null) {
    return { type: "output_text", text: "" };
  }

  if (typeof part === "string") {
    return { type: "output_text", text: part };
  }

  if (typeof part === "object") {
    const record = part as JsonObject;
    const type = record.type ?? "text";

    if (type === "text" || type === "output_text") {
      return { type: "output_text", text: String(record.text ?? "") };
    }

    if (type === "image_url") {
      return {
        type: "output_image",
        image_url: record.image_url ?? record.url ?? null,
      };
    }

    if (record.text !== undefined) {
      return { type: "output_text", text: String(record.text) };
    }

    return { ...record };
  }

  return { type: "output_text", text: String(part) };
}

function convertToolCallOutput(
  toolCall: JsonValue,
  params: { responseId?: string; choiceIndex: number; toolIndex: number },
): JsonObject {
  const record = isJsonObject(toolCall) ? toolCall : {};
  const fn = isJsonObject(record.function) ? record.function : {};
  const toolId =
    typeof record.id === "string"
      ? record.id
      : `${params.responseId ?? "resp"}_tool_${params.choiceIndex}_${params.toolIndex}`;
  const callId =
    typeof fn.call_id === "string"
      ? fn.call_id
      : typeof record.id === "string"
        ? record.id
        : `${params.responseId ?? "resp"}_call_${params.choiceIndex}_${params.toolIndex}`;
  const resolvedArgs =
    typeof fn.arguments === "string"
      ? fn.arguments
      : fn.arguments !== undefined
        ? JSON.stringify(fn.arguments)
        : "";
  return {
    id: toolId,
    object: "function_call",
    type: "function_call",
    status: "completed",
    name: typeof fn.name === "string" ? fn.name : undefined,
    call_id: callId,
    arguments: resolvedArgs,
  };
}

function resolveItemStatus(
  finishReason: string | null | undefined,
): "completed" | "incomplete" {
  if (
    !finishReason ||
    finishReason === "stop" ||
    finishReason === "tool_calls"
  ) {
    return "completed";
  }
  return "incomplete";
}

function createRefusalBlock(refusal: JsonValue) {
  if (typeof refusal === "string") {
    return { type: "output_refusal", text: refusal };
  }
  if (isJsonObject(refusal)) {
    const text = typeof refusal.text === "string" ? refusal.text : "";
    const reason =
      typeof refusal.reason === "string" ? refusal.reason : undefined;
    return {
      type: "output_refusal",
      text,
      reason,
      content: refusal.content,
    };
  }
  return { type: "output_refusal", text: "" };
}

function normalizeReasoningContent(value: JsonValue | undefined): JsonObject[] {
  const parts = Array.isArray(value) ? value : [value];
  const blocks: JsonObject[] = [];
  for (const entry of parts) {
    if (typeof entry === "string") {
      blocks.push({ type: "reasoning_text", text: entry });
      continue;
    }
    if (isJsonObject(entry)) {
      const textValue =
        typeof entry.text === "string"
          ? entry.text
          : typeof entry.thinking === "string"
            ? entry.thinking
            : "";
      const block: JsonObject = {
        type: "reasoning_text",
        text: textValue,
      };
      if (entry.signature) {
        block.signature = entry.signature;
      }
      blocks.push(block);
      continue;
    }
    if (entry !== undefined && entry !== null) {
      blocks.push({ type: "reasoning_text", text: String(entry) });
    }
  }
  return blocks;
}

function normalizeReasoningSummary(value: JsonValue | undefined): JsonObject[] {
  if (value === undefined || value === null) {
    return [];
  }
  const parts = Array.isArray(value) ? value : [value];
  const summaries: JsonObject[] = [];
  for (const entry of parts) {
    if (typeof entry === "string") {
      const text = entry.trim();
      if (text) {
        summaries.push({ type: "summary_text", text });
      }
      continue;
    }
    if (!isJsonObject(entry)) {
      continue;
    }
    const textValue =
      typeof entry.text === "string"
        ? entry.text
        : typeof entry.summary === "string"
          ? entry.summary
          : undefined;
    if (textValue && textValue.trim()) {
      summaries.push({ type: "summary_text", text: textValue.trim() });
    }
  }
  return summaries;
}

function createEmptyOutput(responseId?: string) {
  return {
    id: `${responseId ?? "resp"}_msg_0`,
    object: "message",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "" }],
  };
}

function resolveResponseStatus(): string {
  return "completed";
}

function collectOutputText(outputs: JsonObject[]): string[] {
  const collected = outputs
    .flatMap((output) => asJsonObjectArray(output.content))
    .filter((content) => content?.type === "output_text")
    .map((content) => {
      const textValue = content?.text;
      return typeof textValue === "string" ? textValue : "";
    })
    .filter((text): text is string => text.length > 0);
  return collected;
}

function normalizeResponseUsage(
  rawUsage: JsonValue | undefined,
): JsonObject | null {
  if (!isJsonObject(rawUsage)) {
    return null;
  }

  const toNumber = (value: JsonValue | undefined): number | undefined => {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (
      typeof value === "string" &&
      value.trim().length &&
      Number.isFinite(Number(value))
    ) {
      return Number(value);
    }
    return undefined;
  };

  const inputTokens =
    toNumber(rawUsage.input_tokens) ?? toNumber(rawUsage.prompt_tokens);
  const outputTokens =
    toNumber(rawUsage.output_tokens) ?? toNumber(rawUsage.completion_tokens);
  const totalTokens =
    toNumber(rawUsage.total_tokens) ?? (inputTokens ?? 0) + (outputTokens ?? 0);

  const normalized: JsonObject = {
    input_tokens: inputTokens ?? 0,
    output_tokens: outputTokens ?? 0,
    total_tokens: totalTokens ?? 0,
  };

  const inputDetails = isJsonObject(rawUsage.input_tokens_details)
    ? rawUsage.input_tokens_details
    : isJsonObject(rawUsage.prompt_tokens_details)
      ? rawUsage.prompt_tokens_details
      : null;
  if (inputDetails) {
    const cached =
      toNumber(inputDetails.cached_tokens) ??
      toNumber(inputDetails.cached) ??
      0;
    normalized.input_tokens_details = { cached_tokens: cached };
  }

  const outputDetails = isJsonObject(rawUsage.output_tokens_details)
    ? rawUsage.output_tokens_details
    : null;
  if (outputDetails) {
    const reasoning =
      toNumber(outputDetails.reasoning_tokens) ??
      toNumber(outputDetails.cached_tokens) ??
      0;
    normalized.output_tokens_details = { reasoning_tokens: reasoning };
  } else if (rawUsage.reasoning_tokens !== undefined) {
    normalized.output_tokens_details = {
      reasoning_tokens: toNumber(rawUsage.reasoning_tokens) ?? 0,
    };
  }

  if (rawUsage.extra_properties) {
    normalized.extra_properties = rawUsage.extra_properties;
  }

  return normalized;
}
