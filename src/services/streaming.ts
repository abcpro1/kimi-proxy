import { Readable, PassThrough } from "node:stream";
import {
  OpenAIChatCompletionResponse,
  AnthropicMessagesResponse,
  OpenAIResponsesResponse,
  type OpenAIStreamChunk,
  type AnthropicStreamEvent,
} from "../core/schemas.js";
import { type JsonObject } from "../core/types.js";
import { logger } from "../utils/logger.js";

export interface StreamingOptions {
  delay: number;
  chunkSize: number;
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunkString(input: string, chunkSize: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < input.length; i += chunkSize) {
    chunks.push(input.slice(i, i + chunkSize));
  }
  return chunks.length ? chunks : [""];
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

// --- OpenAI Chat Completions ---

export function openAIStreamFromResponse(
  response: OpenAIChatCompletionResponse,
  options: StreamingOptions,
): Readable {
  const stream = new PassThrough();
  (async () => {
    try {
      const model = response.model;
      const respId = response.id;
      const created = response.created;

      const choice = response.choices[0];
      if (!choice) {
        stream.end();
        return;
      }

      const message = choice.message;
      const content = message.content;

      const toolCalls = message.tool_calls || [];

      // Base chunk structure without choices, to be spread
      const baseChunkInfo = {
        id: respId,
        object: "chat.completion.chunk" as const,
        created,
        model,
        system_fingerprint: response.system_fingerprint,
      };

      const roleChunk: OpenAIStreamChunk = {
        ...baseChunkInfo,
        choices: [
          { index: 0, delta: { role: "assistant" }, finish_reason: null },
        ],
      };
      stream.write(`data: ${JSON.stringify(roleChunk)}\n\n`);

      if (content) {
        const contentChunks = chunkString(content, options.chunkSize);
        for (let i = 0; i < contentChunks.length; i++) {
          const textChunk = contentChunks[i];
          const chunk: OpenAIStreamChunk = {
            ...baseChunkInfo,
            choices: [
              {
                index: 0,
                delta: { content: textChunk },
                finish_reason: null,
              },
            ],
          };
          stream.write(`data: ${JSON.stringify(chunk)}\n\n`);
          await wait(options.delay);
        }
      }

      if (toolCalls.length) {
        for (const [index, toolCall] of toolCalls.entries()) {
          const startChunk: OpenAIStreamChunk = {
            ...baseChunkInfo,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index,
                      id: toolCall.id,
                      type: "function",
                      function: {
                        name: toolCall.function.name,
                        arguments: "",
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          };
          stream.write(`data: ${JSON.stringify(startChunk)}\n\n`);

          const args = toolCall.function.arguments;
          for (const argChunk of chunkString(args, options.chunkSize)) {
            const argStreamChunk: OpenAIStreamChunk = {
              ...baseChunkInfo,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index,
                        function: {
                          arguments: argChunk,
                        },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            };
            stream.write(`data: ${JSON.stringify(argStreamChunk)}\n\n`);
            await wait(options.delay);
          }
        }
      }

      const finishChunk: OpenAIStreamChunk = {
        ...baseChunkInfo,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: choice.finish_reason ?? null, // ensure null if undefined
          },
        ],
      };
      stream.write(`data: ${JSON.stringify(finishChunk)}\n\n`);

      stream.write("data: [DONE]\n\n");
    } catch (e) {
      logger.error({ err: e }, "Stream error");
      stream.write(
        `data: ${JSON.stringify({ error: getErrorMessage(e) })}\n\n`,
      );
    }
    stream.end();
  })();
  return stream;
}

// --- Anthropic Messages ---

export function anthropicStreamFromResponse(
  response: AnthropicMessagesResponse,
  options: StreamingOptions,
): Readable {
  const stream = new PassThrough();
  (async () => {
    try {
      const msgId = response.id;
      const model = response.model;
      const role = response.role;
      const contentBlocks = response.content;
      const usage = response.usage;

      const messageStart: AnthropicStreamEvent = {
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
            input_tokens: usage.input_tokens,
            output_tokens: 0,
          },
        },
      };
      stream.write(
        `event: message_start\ndata: ${JSON.stringify(messageStart)}\n\n`,
      );

      for (const [index, block] of contentBlocks.entries()) {
        if (block.type === "text") {
          const startEvent: AnthropicStreamEvent = {
            type: "content_block_start",
            index,
            content_block: { type: "text", text: "" },
          };
          stream.write(
            `event: content_block_start\ndata: ${JSON.stringify(startEvent)}\n\n`,
          );

          for (const chunk of chunkString(block.text, options.chunkSize)) {
            const deltaEvent: AnthropicStreamEvent = {
              type: "content_block_delta",
              index,
              delta: { type: "text_delta", text: chunk },
            };
            stream.write(
              `event: content_block_delta\ndata: ${JSON.stringify(deltaEvent)}\n\n`,
            );
            await wait(options.delay);
          }

          const stopEvent: AnthropicStreamEvent = {
            type: "content_block_stop",
            index,
          };
          stream.write(
            `event: content_block_stop\ndata: ${JSON.stringify(stopEvent)}\n\n`,
          );
        } else if (block.type === "thinking") {
          const startEvent: AnthropicStreamEvent = {
            type: "content_block_start",
            index,
            content_block: {
              type: "thinking",
              thinking: "",
              signature: block.signature,
            },
          };
          stream.write(
            `event: content_block_start\ndata: ${JSON.stringify(startEvent)}\n\n`,
          );

          for (const chunk of chunkString(block.thinking, options.chunkSize)) {
            const deltaEvent: AnthropicStreamEvent = {
              type: "content_block_delta",
              index,
              delta: { type: "thinking_delta", thinking: chunk },
            };
            stream.write(
              `event: content_block_delta\ndata: ${JSON.stringify(deltaEvent)}\n\n`,
            );
            await wait(options.delay);
          }
          const stopEvent: AnthropicStreamEvent = {
            type: "content_block_stop",
            index,
          };
          stream.write(
            `event: content_block_stop\ndata: ${JSON.stringify(stopEvent)}\n\n`,
          );
        } else if (block.type === "tool_use") {
          const startEvent: AnthropicStreamEvent = {
            type: "content_block_start",
            index,
            content_block: {
              type: "tool_use",
              id: block.id,
              name: block.name,
              input: {},
            },
          };
          stream.write(
            `event: content_block_start\ndata: ${JSON.stringify(startEvent)}\n\n`,
          );

          const inputJson = JSON.stringify(block.input);
          for (const chunk of chunkString(inputJson, options.chunkSize)) {
            const deltaEvent: AnthropicStreamEvent = {
              type: "content_block_delta",
              index,
              delta: { type: "input_json_delta", partial_json: chunk },
            };
            stream.write(
              `event: content_block_delta\ndata: ${JSON.stringify(deltaEvent)}\n\n`,
            );
            await wait(options.delay);
          }
          const stopEvent: AnthropicStreamEvent = {
            type: "content_block_stop",
            index,
          };
          stream.write(
            `event: content_block_stop\ndata: ${JSON.stringify(stopEvent)}\n\n`,
          );
        }
      }

      const msgDelta: AnthropicStreamEvent = {
        type: "message_delta",
        delta: {
          stop_reason: response.stop_reason,
          stop_sequence: response.stop_sequence,
        },
        usage: {
          output_tokens: usage.output_tokens,
        },
      };
      stream.write(
        `event: message_delta\ndata: ${JSON.stringify(msgDelta)}\n\n`,
      );

      const msgStop: AnthropicStreamEvent = { type: "message_stop" };
      stream.write(`event: message_stop\ndata: ${JSON.stringify(msgStop)}\n\n`);
    } catch (e) {
      logger.error({ err: e }, "Stream error");
      // Construct a proper error event if possible, or at least structure it
      stream.write(
        `event: error\ndata: ${JSON.stringify({ error: getErrorMessage(e) })}\n\n`,
      );
    }
    stream.end();
  })();
  return stream;
}

// --- OpenAI Responses ---

export function openAIResponsesStreamFromResponse(
  response: OpenAIResponsesResponse,
  options: StreamingOptions,
): Readable {
  const stream = new PassThrough();

  (async () => {
    const writeEvent = (event: string, data: unknown) => {
      stream.write(`event: ${event}\n`);
      stream.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const finalResponse = response as unknown as JsonObject;
    let sequenceNumber = 0;
    const finalOutputItems: JsonObject[] = [];
    let failed = false;

    try {
      writeEvent("response.created", {
        type: "response.created",
        sequence_number: sequenceNumber++,
        response: {
          ...finalResponse,
          status: "in_progress",
          output: [],
        },
      });

      const items = Array.isArray(finalResponse.output)
        ? finalResponse.output
        : [];
      for (const [outputIndex, rawItem] of items.entries()) {
        const objItem = rawItem as JsonObject;
        const type = objItem.type;

        const itemId =
          typeof objItem.id === "string" && objItem.id.length
            ? objItem.id
            : `${finalResponse.id ?? "resp"}_output_${outputIndex}`;

        if (type === "message") {
          const finalItem: JsonObject = {
            ...objItem,
            id: itemId,
            status: objItem.status ?? "completed",
            content: Array.isArray(objItem.content) ? objItem.content : [],
          };
          finalOutputItems.push(finalItem);

          writeEvent("response.output_item.added", {
            type: "response.output_item.added",
            sequence_number: sequenceNumber++,
            output_index: outputIndex,
            item: {
              ...finalItem,
              status: "in_progress",
              content: [],
            },
          });

          const parts = Array.isArray(objItem.content) ? objItem.content : [];
          let contentIndex = 0;
          for (const part of parts) {
            const partObj = part as JsonObject;
            const partType = partObj.type;

            if (partType === "output_text") {
              const fullText =
                typeof partObj.text === "string" ? partObj.text : "";
              const partAdded: JsonObject = {
                ...partObj,
                type: "output_text",
                text: "",
                annotations: Array.isArray(partObj.annotations)
                  ? partObj.annotations
                  : [],
              };

              writeEvent("response.content_part.added", {
                type: "response.content_part.added",
                sequence_number: sequenceNumber++,
                output_index: outputIndex,
                item_id: itemId,
                content_index: contentIndex,
                part: partAdded,
              });

              for (const chunk of chunkString(fullText, options.chunkSize)) {
                writeEvent("response.output_text.delta", {
                  type: "response.output_text.delta",
                  sequence_number: sequenceNumber++,
                  output_index: outputIndex,
                  item_id: itemId,
                  content_index: contentIndex,
                  delta: chunk,
                  logprobs: [],
                });
                await wait(options.delay);
              }

              writeEvent("response.output_text.done", {
                type: "response.output_text.done",
                sequence_number: sequenceNumber++,
                output_index: outputIndex,
                item_id: itemId,
                content_index: contentIndex,
                text: fullText,
                logprobs: [],
              });

              writeEvent("response.content_part.done", {
                type: "response.content_part.done",
                sequence_number: sequenceNumber++,
                output_index: outputIndex,
                item_id: itemId,
                content_index: contentIndex,
                part: {
                  ...partAdded,
                  text: fullText,
                },
              });
            } else {
              writeEvent("response.content_part.added", {
                type: "response.content_part.added",
                sequence_number: sequenceNumber++,
                output_index: outputIndex,
                item_id: itemId,
                content_index: contentIndex,
                part: partObj,
              });

              writeEvent("response.content_part.done", {
                type: "response.content_part.done",
                sequence_number: sequenceNumber++,
                output_index: outputIndex,
                item_id: itemId,
                content_index: contentIndex,
                part: partObj,
              });
            }

            contentIndex += 1;
          }

          writeEvent("response.output_item.done", {
            type: "response.output_item.done",
            sequence_number: sequenceNumber++,
            output_index: outputIndex,
            item: finalItem,
          });
          continue;
        }

        if (type === "function_call") {
          const args =
            typeof objItem.arguments === "string" ? objItem.arguments : "";
          const name =
            typeof objItem.name === "string" && objItem.name.length
              ? objItem.name
              : "tool";
          const callId =
            typeof objItem.call_id === "string" && objItem.call_id.length
              ? objItem.call_id
              : itemId;

          const finalItem: JsonObject = {
            ...objItem,
            id: itemId,
            type: "function_call",
            call_id: callId,
            name,
            arguments: args,
            status: objItem.status ?? "completed",
          };
          finalOutputItems.push(finalItem);

          writeEvent("response.output_item.added", {
            type: "response.output_item.added",
            sequence_number: sequenceNumber++,
            output_index: outputIndex,
            item: {
              ...finalItem,
              status: "in_progress",
              arguments: "",
            },
          });

          for (const chunk of chunkString(args, options.chunkSize)) {
            writeEvent("response.function_call_arguments.delta", {
              type: "response.function_call_arguments.delta",
              sequence_number: sequenceNumber++,
              output_index: outputIndex,
              item_id: itemId,
              delta: chunk,
            });
            await wait(options.delay);
          }

          writeEvent("response.function_call_arguments.done", {
            type: "response.function_call_arguments.done",
            sequence_number: sequenceNumber++,
            output_index: outputIndex,
            item_id: itemId,
            name,
            arguments: args,
          });

          writeEvent("response.output_item.done", {
            type: "response.output_item.done",
            sequence_number: sequenceNumber++,
            output_index: outputIndex,
            item: finalItem,
          });
          continue;
        }

        if (type === "reasoning") {
          const contentParts = Array.isArray(objItem.content)
            ? (objItem.content as JsonObject[])
            : [];
          const summaryParts = Array.isArray(objItem.summary)
            ? (objItem.summary as JsonObject[])
            : [];

          const finalItem: JsonObject = {
            ...objItem,
            id: itemId,
            type: "reasoning",
            status: objItem.status ?? "completed",
            summary: summaryParts,
            content: contentParts,
          };
          finalOutputItems.push(finalItem);

          writeEvent("response.output_item.added", {
            type: "response.output_item.added",
            sequence_number: sequenceNumber++,
            output_index: outputIndex,
            item: {
              ...finalItem,
              status: "in_progress",
              summary: [],
              content: [],
            },
          });

          let contentIndex = 0;
          for (const partObj of contentParts) {
            if (partObj.type !== "reasoning_text") {
              contentIndex += 1;
              continue;
            }

            const fullText =
              typeof partObj.text === "string" ? partObj.text : "";
            const partAdded: JsonObject = {
              type: "reasoning_text",
              text: "",
            };

            writeEvent("response.content_part.added", {
              type: "response.content_part.added",
              sequence_number: sequenceNumber++,
              output_index: outputIndex,
              item_id: itemId,
              content_index: contentIndex,
              part: partAdded,
            });

            for (const chunk of chunkString(fullText, options.chunkSize)) {
              writeEvent("response.reasoning_text.delta", {
                type: "response.reasoning_text.delta",
                sequence_number: sequenceNumber++,
                output_index: outputIndex,
                item_id: itemId,
                content_index: contentIndex,
                delta: chunk,
              });
              await wait(options.delay);
            }

            writeEvent("response.reasoning_text.done", {
              type: "response.reasoning_text.done",
              sequence_number: sequenceNumber++,
              output_index: outputIndex,
              item_id: itemId,
              content_index: contentIndex,
              text: fullText,
            });

            writeEvent("response.content_part.done", {
              type: "response.content_part.done",
              sequence_number: sequenceNumber++,
              output_index: outputIndex,
              item_id: itemId,
              content_index: contentIndex,
              part: {
                ...partAdded,
                text: fullText,
              },
            });

            contentIndex += 1;
          }

          writeEvent("response.output_item.done", {
            type: "response.output_item.done",
            sequence_number: sequenceNumber++,
            output_index: outputIndex,
            item: finalItem,
          });

          continue;
        }

        const finalItem: JsonObject = {
          ...objItem,
          id: itemId,
          status: objItem.status ?? "completed",
        };
        finalOutputItems.push(finalItem);

        writeEvent("response.output_item.added", {
          type: "response.output_item.added",
          sequence_number: sequenceNumber++,
          output_index: outputIndex,
          item: {
            ...finalItem,
            status: "in_progress",
          },
        });

        writeEvent("response.output_item.done", {
          type: "response.output_item.done",
          sequence_number: sequenceNumber++,
          output_index: outputIndex,
          item: finalItem,
        });
      }
    } catch (e) {
      failed = true;
      logger.error({ err: e }, "Stream error");
      try {
        writeEvent("error", {
          error: { message: getErrorMessage(e) },
        });
      } catch {
        // ignore write errors
      }
    }

    if (!failed) {
      const outputText = finalOutputItems
        .filter(
          (item) => item.type === "message" && Array.isArray(item.content),
        )
        .flatMap((item) => item.content as JsonObject[])
        .filter((part) => part.type === "output_text")
        .map((part) => (typeof part.text === "string" ? part.text : ""))
        .join("");

      writeEvent("response.completed", {
        type: "response.completed",
        sequence_number: sequenceNumber++,
        response: {
          ...finalResponse,
          status: finalResponse.status ?? "completed",
          output: finalOutputItems,
          output_text: outputText,
        },
      });
    }

    stream.write("data: [DONE]\n\n");
    stream.end();
  })();

  return stream;
}
