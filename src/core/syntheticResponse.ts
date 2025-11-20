import {
  JsonObject,
  ProviderFormat,
  ProviderResponsePayload,
} from "./types.js";

export interface SyntheticResponseOptions {
  status?: number;
  providerFormat?: ProviderFormat;
}

export function createSyntheticProviderResponse(
  options: SyntheticResponseOptions = {},
): ProviderResponsePayload<JsonObject> {
  const status = options.status ?? 200;

  // Currently using OpenAI format only
  const body: JsonObject = {
    id: "synth_" + Date.now(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "synthetic",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
        },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
    system_fingerprint: "synthetic_response",
  };

  return {
    status,
    body,
    headers: {
      "content-type": "application/json",
      "x-synthetic-response": "true",
    },
  };
}
