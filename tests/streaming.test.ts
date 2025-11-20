import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonObject, JsonValue } from "../src/core/types.js";

function parseSseChunks(chunks: string[]): JsonValue[] {
  return chunks
    .join("")
    .split("\n\n")
    .filter((block) => {
      const trimmed = block.trim();
      return trimmed.startsWith("data: ") && trimmed !== "data: [DONE]";
    })
    .map((block) => {
      const trimmed = block.trim();
      return JSON.parse(trimmed.slice(6)) as JsonValue;
    });
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("openAIStreamFromResponse", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("streams array-based message content as incremental chunks", async () => {
    const { openAIStreamFromResponse } = await import(
      "../src/services/streaming.js"
    );

    const response = {
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 123,
      model: "gpt-test",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "Hello" },
              { type: "text", text: " world!" },
            ],
          },
        },
      ],
    };

    const stream = openAIStreamFromResponse(response, {
      delay: 0,
      chunkSize: 5,
    });
    const emitted: string[] = [];

    for await (const chunk of stream) {
      emitted.push(chunk.toString());
    }

    const events = parseSseChunks(emitted);
    const combined = events
      .map((payload) => {
        if (
          isJsonObject(payload) &&
          Array.isArray(payload.choices) &&
          payload.choices[0] &&
          isJsonObject(payload.choices[0]) &&
          isJsonObject(payload.choices[0].delta) &&
          typeof payload.choices[0].delta.content === "string"
        ) {
          return payload.choices[0].delta.content;
        }
        return "";
      })
      .filter((value): value is string => value.length > 0)
      .join("");

    expect(combined).toBe("Hello world!");
    expect(emitted.join("").includes("data: [DONE]")).toBe(true);
  });
});
