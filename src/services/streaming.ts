import { Readable, PassThrough } from "node:stream";
import type { JsonObject, JsonValue } from "../core/types.js";

export interface StreamingOptions {
  delay: number;
  chunkSize: number;
}

interface NormalizedResponseBody extends JsonObject {
  output: JsonObject[];
}

interface NormalizedResponsePayload {
  finalResponse: NormalizedResponseBody;
  startResponse: NormalizedResponseBody;
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractTextContent(value: JsonValue | undefined): string {
  if (value === undefined || value === null) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((part) => extractTextContent(part as JsonValue)).join("");
  }

  if (isJsonObject(value)) {
    if ("text" in value) {
      return extractTextContent(value.text as JsonValue);
    }
    if ("content" in value) {
      return extractTextContent(value.content as JsonValue);
    }
  }

  return "";
}

function chunkString(input: string, chunkSize: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < input.length; i += chunkSize) {
    chunks.push(input.slice(i, i + chunkSize));
  }
  return chunks.length ? chunks : [""];
}

export function openAIStreamFromResponse(
  response: JsonObject,
  options: StreamingOptions,
): Readable {
  const stream = new PassThrough();
  (async () => {
    try {
      const model = response.model ?? "unknown-model";
      const respId = response.id ?? "unknown";
      const created = response.created ?? Math.floor(Date.now() / 1000);
      const choices = Array.isArray(response.choices)
        ? response.choices.filter((entry): entry is JsonObject =>
            isJsonObject(entry),
          )
        : [];
      const [choice] = choices;
      const message = isJsonObject(choice?.message) ? choice.message : {};
      const content = extractTextContent(message.content as JsonValue);
      const reasoning = extractTextContent(
        message.reasoning_content as JsonValue,
      );
      const toolCalls: JsonObject[] = Array.isArray(message.tool_calls)
        ? message.tool_calls.filter((entry): entry is JsonObject =>
            isJsonObject(entry),
          )
        : [];

      const baseChunk = {
        id: respId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {} as JsonObject,
            finish_reason: null as string | null,
          },
        ],
      };

      stream.write(
        `data: ${JSON.stringify({
          ...baseChunk,
          choices: [
            { index: 0, delta: { role: "assistant" }, finish_reason: null },
          ],
        })}\n\n`,
      );

      if (reasoning) {
        for (const textChunk of chunkString(reasoning, options.chunkSize)) {
          stream.write(
            `data: ${JSON.stringify({
              ...baseChunk,
              choices: [
                {
                  index: 0,
                  delta: { reasoning_content: textChunk },
                  finish_reason: null,
                },
              ],
            })}\n\n`,
          );
          await wait(options.delay);
        }
      }

      if (content) {
        for (const textChunk of chunkString(content, options.chunkSize)) {
          stream.write(
            `data: ${JSON.stringify({
              ...baseChunk,
              choices: [
                {
                  index: 0,
                  delta: { content: textChunk },
                  finish_reason: null,
                },
              ],
            })}\n\n`,
          );
          await wait(options.delay);
        }
      }

      if (toolCalls.length) {
        for (const [index, toolCall] of toolCalls.entries()) {
          const fn = isJsonObject(toolCall.function) ? toolCall.function : {};
          stream.write(
            `data: ${JSON.stringify({
              ...baseChunk,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index,
                        id: toolCall.id,
                        type: toolCall.type,
                        function: {
                          name:
                            typeof fn.name === "string" ? fn.name : undefined,
                          arguments: "",
                        },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            })}\n\n`,
          );

          const args = typeof fn.arguments === "string" ? fn.arguments : "";
          for (const argChunk of chunkString(args, options.chunkSize)) {
            stream.write(
              `data: ${JSON.stringify({
                ...baseChunk,
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index,
                          function: { arguments: argChunk },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              })}\n\n`,
            );
            await wait(options.delay);
          }
        }
      }

      stream.write(
        `data: ${JSON.stringify({
          ...baseChunk,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason:
                typeof choice?.finish_reason === "string"
                  ? choice.finish_reason
                  : "stop",
            },
          ],
        })}\n\n`,
      );
      stream.write("data: [DONE]\n\n");
    } catch (error) {
      console.error("Stream error:", error);
    } finally {
      stream.end();
    }
  })();

  return stream;
}

export function anthropicStreamFromResponse(
  response: JsonObject,
  options: StreamingOptions,
): Readable {
  const stream = new PassThrough();
  (async () => {
    try {
      const msgId = response.id ?? "msg_unknown";
      const model = response.model ?? "unknown-model";
      const role = response.role ?? "assistant";
      const contentBlocks: JsonObject[] = Array.isArray(response.content)
        ? response.content.filter((entry): entry is JsonObject =>
            isJsonObject(entry),
          )
        : [];
      const usage = isJsonObject(response.usage)
        ? response.usage
        : { input_tokens: 0, output_tokens: 0 };

      const messageStart = {
        type: "message_start",
        message: {
          id: msgId,
          type: "message",
          role,
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: usage.input_tokens ?? 0,
            output_tokens: 0,
          },
        },
      };
      stream.write(
        `event: message_start\ndata: ${JSON.stringify(messageStart)}\n\n`,
      );

      for (const [index, block] of contentBlocks.entries()) {
        if (block.type === "text") {
          stream.write(
            `event: content_block_start\ndata: ${JSON.stringify({
              type: "content_block_start",
              index,
              content_block: { type: "text", text: "" },
            })}\n\n`,
          );
          for (const chunk of chunkString(
            typeof block.text === "string" ? block.text : "",
            options.chunkSize,
          )) {
            stream.write(
              `event: content_block_delta\ndata: ${JSON.stringify({
                type: "content_block_delta",
                index,
                delta: { type: "text_delta", text: chunk },
              })}\n\n`,
            );
            await wait(options.delay);
          }
          stream.write(
            `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index })}\n\n`,
          );
        } else if (block.type === "thinking") {
          stream.write(
            `event: content_block_start\ndata: ${JSON.stringify({
              type: "content_block_start",
              index,
              content_block: {
                type: "thinking",
                thinking: "",
                signature:
                  typeof block.signature === "string"
                    ? block.signature
                    : undefined,
              },
            })}\n\n`,
          );
          for (const chunk of chunkString(
            typeof block.thinking === "string" ? block.thinking : "",
            options.chunkSize,
          )) {
            stream.write(
              `event: content_block_delta\ndata: ${JSON.stringify({
                type: "content_block_delta",
                index,
                delta: { type: "thinking_delta", thinking: chunk },
              })}\n\n`,
            );
            await wait(options.delay);
          }
          stream.write(
            `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index })}\n\n`,
          );
        } else if (block.type === "tool_use") {
          stream.write(
            `event: content_block_start\ndata: ${JSON.stringify({
              type: "content_block_start",
              index,
              content_block: {
                type: "tool_use",
                id: typeof block.id === "string" ? block.id : undefined,
                name: typeof block.name === "string" ? block.name : undefined,
                input: {},
              },
            })}\n\n`,
          );
          const inputPayload = isJsonObject(block.input) ? block.input : {};
          const inputJson = JSON.stringify(inputPayload);
          for (const chunk of chunkString(inputJson, options.chunkSize)) {
            stream.write(
              `event: content_block_delta\ndata: ${JSON.stringify({
                type: "content_block_delta",
                index,
                delta: { type: "input_json_delta", partial_json: chunk },
              })}\n\n`,
            );
            await wait(options.delay);
          }
          stream.write(
            `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index })}\n\n`,
          );
        }
      }

      stream.write(
        `event: message_delta\ndata: ${JSON.stringify({
          type: "message_delta",
          delta: {
            stop_reason: response.stop_reason,
            stop_sequence: response.stop_sequence,
          },
          usage: { output_tokens: usage.output_tokens ?? 0 },
        })}\n\n`,
      );
      stream.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    } catch (e) {
      console.error("Stream error:", e);
    } finally {
      stream.end();
    }
  })();
  return stream;
}

async function* openAIResponsesGenerator(
  response: JsonObject,
  options: StreamingOptions,
) {
  try {
    const normalized = normalizeResponseForStreaming(response);
    let sequence = 0;

    const emit = (eventType: string, payload: JsonObject) =>
      `event: ${eventType}\ndata: ${JSON.stringify({
        type: eventType,
        sequence_number: ++sequence,
        ...payload,
      })}\n\n`;

    yield emit("response.created", { response: normalized.startResponse });
    yield emit("response.in_progress", { response: normalized.startResponse });

    const outputs = normalized.finalResponse.output;

    for (const [outputIndex, outputItem] of outputs.entries()) {
      const itemStart = createOutputItemStart(outputItem);
      yield emit("response.output_item.added", {
        output_index: outputIndex,
        item: itemStart,
      });

      if (outputItem.type === "function_call") {
        const args =
          typeof outputItem.arguments === "string"
            ? outputItem.arguments
            : JSON.stringify(outputItem.arguments ?? "");
        for (const chunk of chunkString(args, options.chunkSize)) {
          yield emit("response.function_call_arguments.delta", {
            item_id: outputItem.id,
            output_index: outputIndex,
            name: outputItem.name,
            delta: chunk,
          });
          await wait(options.delay);
        }
        yield emit("response.function_call_arguments.done", {
          item_id: outputItem.id,
          output_index: outputIndex,
          name: outputItem.name,
          arguments: args,
        });
      } else {
        const content = Array.isArray(outputItem.content)
          ? outputItem.content
          : [];
        for (const [contentIndex, part] of content.entries()) {
          const baseEvent = {
            item_id: outputItem.id,
            output_index: outputIndex,
            content_index: contentIndex,
          };
          yield emit("response.content_part.added", {
            ...baseEvent,
            part: createContentPartPlaceholder(part),
          });

          const textMeta = resolveTextStreamingMeta(part);
          if (textMeta) {
            for (const chunk of chunkString(textMeta.text, options.chunkSize)) {
              yield emit(textMeta.deltaEvent, {
                ...baseEvent,
                delta: chunk,
              });
              await wait(options.delay);
            }
            yield emit(textMeta.doneEvent, {
              ...baseEvent,
              text: textMeta.text,
            });
          }

          yield emit("response.content_part.done", {
            ...baseEvent,
            part,
          });
        }
      }

      yield emit("response.output_item.done", {
        output_index: outputIndex,
        item: outputItem,
      });
    }

    yield emit("response.completed", {
      response: normalized.finalResponse,
    });
    yield "data: [DONE]\n\n";
  } catch (e) {
    console.error("Generator error:", e);
    yield `data: {"error": "${(e as Error).message}"}\n\n`;
  }
}

function normalizeResponseForStreaming(
  response: JsonObject,
): NormalizedResponsePayload {
  const id = response?.id ?? `resp_${Date.now()}`;
  const created = response?.created ?? Math.floor(Date.now() / 1000);
  const model = response?.model ?? "unknown-model";
  const status = response?.status ?? "completed";
  const output = Array.isArray(response?.output) ? response.output : [];
  const normalizedOutput = normalizeOutputItems(output);
  const finalResponse = {
    ...response,
    id,
    object: response?.object ?? "response",
    created,
    model,
    status,
    output: normalizedOutput,
    usage: response?.usage ?? null,
  } as NormalizedResponseBody;
  const startResponse = {
    ...finalResponse,
    status: "in_progress",
    output: [],
    usage: null,
  } as NormalizedResponseBody;
  return { finalResponse, startResponse };
}

function normalizeOutputItems(items: JsonValue[]): JsonObject[] {
  return items.map((item, index) => {
    if (!isJsonObject(item)) {
      return {
        id: `output_${index}`,
        object: "message",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: String(item ?? "") }],
      };
    }
    const normalized: JsonObject = { ...item };
    if (item.type === "reasoning") {
      const summary = Array.isArray(item.summary)
        ? item.summary
        : item.summary
          ? [{ type: "summary_text", text: String(item.summary) }]
          : [];
      const content = Array.isArray(item.content)
        ? item.content
        : [{ type: "reasoning_text", text: "" }];
      normalized.summary = summary;
      normalized.content = content;
      return normalized;
    }
    if (item.type === "function_call") {
      const callId =
        (typeof item.call_id === "string" && item.call_id) ||
        (typeof item.id === "string" && item.id) ||
        `resp_tool_call_${index}_${Math.random().toString(16).slice(2)}`;
      normalized.call_id = callId;
      return normalized;
    }
    if (!Array.isArray(item.content)) {
      normalized.content = [];
    }
    return normalized;
  });
}

function createOutputItemStart(outputItem: JsonObject) {
  const base: JsonObject = {
    id: outputItem.id,
    object: outputItem.object ?? outputItem.type,
    type: outputItem.type,
    status: "in_progress",
  };
  if (outputItem.type === "function_call") {
    base.name = outputItem.name;
    base.arguments = "";
    if (outputItem.call_id) {
      base.call_id = outputItem.call_id;
    }
    return base;
  }
  if (outputItem.type === "reasoning") {
    base.content = [];
    base.summary = Array.isArray(outputItem.summary) ? outputItem.summary : [];
    return base;
  }
  base.role = outputItem.role ?? "assistant";
  base.content = [];
  return base;
}

function createContentPartPlaceholder(part: JsonValue) {
  if (!part || typeof part !== "object") {
    return { type: "output_text", text: "" };
  }
  if (!isJsonObject(part)) {
    return { type: "output_text", text: "" };
  }
  if (part.type === "output_text") {
    return {
      type: "output_text",
      text: "",
      annotations: Array.isArray(part.annotations) ? part.annotations : [],
    };
  }
  if (part.type === "reasoning_text") {
    const placeholder: JsonObject = {
      type: "reasoning_text",
      text: "",
    };
    if (part.signature) {
      placeholder.signature = part.signature;
    }
    return placeholder;
  }
  return { ...part };
}

function resolveTextStreamingMeta(
  part: JsonValue,
): { text: string; deltaEvent: string; doneEvent: string } | null {
  if (!isJsonObject(part)) {
    return null;
  }
  if (part.type === "output_text") {
    const text = typeof part.text === "string" ? part.text : "";
    return {
      text,
      deltaEvent: "response.output_text.delta",
      doneEvent: "response.output_text.done",
    };
  }
  if (part.type === "reasoning_text") {
    const text = typeof part.text === "string" ? part.text : "";
    return {
      text,
      deltaEvent: "response.reasoning_text.delta",
      doneEvent: "response.reasoning_text.done",
    };
  }
  return null;
}

export function openAIResponsesStreamFromResponse(
  response: JsonObject,
  options: StreamingOptions,
): Readable {
  const stream = new PassThrough();

  Readable.from(openAIResponsesGenerator(response, options), {
    objectMode: false,
  }).pipe(stream);

  return stream;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
