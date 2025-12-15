import { expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import {
  setupVertexTestServer,
  describeWithVertex,
} from "../test-utils/vertex-test-helper.js";

describeWithVertex("integration: vertex thinking models", () => {
  const { getClient } = setupVertexTestServer([
    {
      name: "gemini-3-pro",
      provider: "vertex",
      upstreamModel: "gemini-3-pro-preview",
    },
  ]);

  it("reasons about a complex logic problem", async () => {
    const { server, baseURL } = await getClient();
    const client = new Anthropic({
      baseURL,
      apiKey: "test-key",
    });

    try {
      const response = await client.messages.create({
        model: "gemini-3-pro",
        max_tokens: 4096,
        messages: [
          {
            role: "user",
            content:
              "A farmer has a wolf, a goat, and a cabbage. He needs to cross a river with them. The boat can only carry the farmer and one other item. If the wolf is left alone with the goat, the wolf will eat the goat. If the goat is left alone with the cabbage, the goat will eat the cabbage. How can the farmer get everything across safely? Explain your reasoning step by step.",
          },
        ],
        // @ts-expect-error - thinking_config is not in SDK types yet
        thinking_config: { include_thoughts: true },
      });

      expect(response.content).toBeDefined();

      // Verify we have a thinking block
      const thinkingBlock = response.content.find((b) => b.type === "thinking");
      expect(thinkingBlock).toBeDefined();
      if (thinkingBlock && thinkingBlock.type === "thinking") {
        expect(thinkingBlock.thinking.length).toBeGreaterThan(0);
        console.log(
          "Thinking content captured:",
          thinkingBlock.thinking.substring(0, 100) + "...",
        );
      }

      // Verify we have a text block
      const textBlock = response.content.find((b) => b.type === "text");
      expect(textBlock).toBeDefined();
      expect(textBlock?.text.length).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  }, 120000);
});
