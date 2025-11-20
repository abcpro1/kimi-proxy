import { describe, expect, it } from "vitest";
import { openAIResponsesStreamFromResponse } from "../src/services/streaming.js";
import type { JsonObject, JsonValue } from "../src/core/types.js";

type ParsedEvent = { event: string; data: JsonValue };

function parseSse(chunks: string[]): { events: ParsedEvent[]; done: boolean } {
  const combined = chunks.join("");
  const rawBlocks = combined.split("\n\n").filter((block) => block.trim());
  const events: ParsedEvent[] = [];
  let done = false;

  for (const block of rawBlocks) {
    if (block.trim() === "data: [DONE]") {
      done = true;
      continue;
    }
    let eventName = "message";
    let dataPayload = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) {
        eventName = line.replace("event:", "").trim();
      } else if (line.startsWith("data:")) {
        dataPayload = line.replace("data:", "").trim();
      }
    }
    if (dataPayload) {
      events.push({
        event: eventName,
        data: JSON.parse(dataPayload) as JsonValue,
      });
    }
  }

  return { events, done };
}

describe("openAIResponsesStreamFromResponse", () => {
  it("streams response events with completion signal", async () => {
    const response = {
      id: "resp-123",
      object: "response",
      created: 1234567890,
      model: "gpt-test",
      output: [
        {
          id: "msg-1",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Hello world" }],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    };

    const stream = openAIResponsesStreamFromResponse(response, {
      delay: 0,
      chunkSize: 5,
    });
    const emitted: string[] = [];

    for await (const chunk of stream) {
      emitted.push(chunk.toString());
    }

    const { events, done } = parseSse(emitted);
    expect(done).toBe(true);
    expect(events[0].event).toBe("response.created");
    expect(events.at(-1)?.event).toBe("response.completed");

    const deltas = events
      .filter((evt) => evt.event === "response.output_text.delta")
      .map((evt) => {
        const data = evt.data;
        return isJsonObject(data) && typeof data.delta === "string"
          ? data.delta
          : "";
      })
      .join("");
    expect(deltas).toBe("Hello world");

    const completedEvent = events.find(
      (evt) => evt.event === "response.completed",
    );
    const completedData = isJsonObject(completedEvent?.data)
      ? completedEvent.data
      : undefined;
    const completedResponse =
      completedData && isJsonObject(completedData.response)
        ? completedData.response
        : undefined;
    expect(completedResponse?.status).toBe("completed");
    expect(completedResponse?.usage).toEqual({
      input_tokens: 10,
      output_tokens: 5,
    });
  });

  it("streams function call events with argument chunks", async () => {
    const response = {
      id: "resp-tool",
      object: "response",
      model: "gpt-tool",
      output: [
        {
          id: "call_1",
          type: "function_call",
          name: "search",
          arguments: '{"query":"test"}',
        },
      ],
    };

    const stream = openAIResponsesStreamFromResponse(response, {
      delay: 0,
      chunkSize: 5,
    });
    const emitted: string[] = [];

    for await (const chunk of stream) {
      emitted.push(chunk.toString());
    }

    const { events, done } = parseSse(emitted);
    expect(done).toBe(true);

    const argDeltas = events
      .filter((evt) => evt.event === "response.function_call_arguments.delta")
      .map((evt) => {
        const data = evt.data;
        return isJsonObject(data) && typeof data.delta === "string"
          ? data.delta
          : "";
      })
      .join("");
    expect(argDeltas).toBe('{"query":"test"}');

    const finalArgsEvent = events.find(
      (evt) => evt.event === "response.function_call_arguments.done",
    );
    const finalArgsData = isJsonObject(finalArgsEvent?.data)
      ? finalArgsEvent.data
      : {};
    expect(finalArgsData).toMatchObject({
      item_id: "call_1",
      name: "search",
      arguments: '{"query":"test"}',
    });

    const addedItem = events.find(
      (evt) =>
        evt.event === "response.output_item.added" &&
        evt.data.item.type === "function_call",
    );
    expect(addedItem?.data.item.call_id).toBe("call_1");
  });

  it("emits reasoning events with summary placeholders", async () => {
    const response = {
      id: "resp-reason",
      object: "response",
      model: "gpt-think",
      output: [
        {
          id: "reason-1",
          type: "reasoning",
          status: "completed",
          content: [{ type: "reasoning_text", text: "Chain of thought" }],
        },
      ],
    };

    const stream = openAIResponsesStreamFromResponse(response, {
      delay: 0,
      chunkSize: 8,
    });
    const emitted: string[] = [];

    for await (const chunk of stream) {
      emitted.push(chunk.toString());
    }

    const { events, done } = parseSse(emitted);
    expect(done).toBe(true);

    const reasoningAddedEvent = events.find(
      (evt) => evt.event === "response.output_item.added",
    );
    const reasoningAddedData = isJsonObject(reasoningAddedEvent?.data)
      ? reasoningAddedEvent.data
      : undefined;
    const reasoningSummary =
      reasoningAddedData &&
      reasoningAddedData.item &&
      isJsonObject(reasoningAddedData.item)
        ? reasoningAddedData.item.summary
        : undefined;
    expect(reasoningSummary).toEqual([]);

    const reasoningText = events
      .filter((evt) => evt.event === "response.reasoning_text.delta")
      .map((evt) => {
        const data = evt.data;
        return isJsonObject(data) && typeof data.delta === "string"
          ? data.delta
          : "";
      })
      .join("");
    expect(reasoningText).toBe("Chain of thought");
  });
});

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
