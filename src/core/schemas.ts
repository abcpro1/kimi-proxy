import { z } from "zod";

// --- Shared Schemas ---

export const FunctionSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  parameters: z.record(z.unknown()).optional(),
  strict: z.boolean().optional(),
});

export const ToolSchema = z.object({
  type: z.literal("function").default("function"),
  function: FunctionSchema,
});

export const ToolCallSchema = z.object({
  id: z.string(),
  type: z.literal("function").default("function"),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
});

const ToolCallLikeSchema = z.object({
  id: z.string(),
  type: z.literal("function").default("function"),
  function: z.object({
    name: z.string(),
    arguments: z.union([z.string(), z.record(z.unknown())]).optional(),
  }),
});

// --- OpenAI Chat Completions ---

const OpenAIChatContentPartSchema = z.union([
  z
    .object({
      type: z.literal("text").optional(),
      text: z.string(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("image_url").optional(),
      image_url: z.union([
        z.string(),
        z
          .object({
            url: z.string(),
            detail: z.string().optional(),
          })
          .passthrough(),
      ]),
    })
    .passthrough(),
]);

export const OpenAIChatMessageSchema = z.object({
  role: z.string(),
  content: z
    .union([z.string(), z.array(OpenAIChatContentPartSchema)])
    .optional()
    .nullable(),
  name: z.string().optional(),
  tool_calls: z.array(ToolCallLikeSchema).optional(),
  function_call: z
    .object({
      name: z.string(),
      arguments: z.union([z.string(), z.record(z.unknown())]).optional(),
    })
    .nullable()
    .optional(),
  tool_call_id: z.string().optional(),
});

export const OpenAIChatCompletionRequestSchema = z.object({
  model: z.string(),
  messages: z.array(OpenAIChatMessageSchema),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  n: z.number().optional(),
  stream: z.boolean().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  max_completion_tokens: z.number().optional(),
  max_tokens: z.number().optional(),
  presence_penalty: z.number().optional(),
  frequency_penalty: z.number().optional(),
  logit_bias: z.record(z.number()).optional(),
  user: z.string().optional(),
  functions: z.array(FunctionSchema).optional(),
  function_call: z
    .union([z.string(), z.object({ name: z.string() })])
    .optional(),
  tools: z.array(ToolSchema).optional(),
  tool_choice: z
    .union([
      z.string(),
      z.object({ type: z.string(), function: z.object({ name: z.string() }) }),
    ])
    .optional(),
});

export type OpenAIChatCompletionRequest = z.infer<
  typeof OpenAIChatCompletionRequestSchema
>;

export const OpenAIChatCompletionResponseSchema = z.object({
  id: z.string(),
  object: z.literal("chat.completion"),
  created: z.number(),
  model: z.string(),
  system_fingerprint: z.string().optional(),
  choices: z.array(
    z.object({
      index: z.number(),
      message: z.object({
        role: z.string(),
        content: z.string().nullable(),
        reasoning_content: z.string().optional(),
        tool_calls: z.array(ToolCallSchema).optional(),
      }),
      finish_reason: z.string().nullable(),
    }),
  ),
  usage: z
    .object({
      prompt_tokens: z.number(),
      completion_tokens: z.number(),
      total_tokens: z.number(),
    })
    .optional(),
});

export type OpenAIChatCompletionResponse = z.infer<
  typeof OpenAIChatCompletionResponseSchema
>;

// --- Anthropic Messages ---

const AnthropicInputContentBlockSchema = z
  .object({
    type: z.string().optional(),
    text: z.string().optional(),
    thinking: z.string().optional(),
    signature: z.string().optional(),
    source: z.unknown().optional(),
    id: z.string().optional(),
    name: z.string().optional(),
    input: z.unknown().optional(),
    tool_use_id: z.string().optional(),
    content: z.unknown().optional(),
    is_error: z.boolean().optional(),
    data: z.unknown().optional(),
  })
  .passthrough();

export const AnthropicContentBlockSchema = z.union([
  z.object({
    type: z.literal("text"),
    text: z.string(),
  }),
  z.object({
    type: z.literal("image"),
    source: z.object({
      type: z.literal("base64"),
      media_type: z.string(),
      data: z.string(),
    }),
  }),
  z.object({
    type: z.literal("tool_use"),
    id: z.string(),
    name: z.string(),
    input: z.record(z.unknown()),
  }),
  z.object({
    type: z.literal("tool_result"),
    tool_use_id: z.string(),
    content: z.union([z.string(), z.array(z.any())]).optional(),
    is_error: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("thinking"),
    thinking: z.string(),
    signature: z.string().optional(),
  }),
]);

export const AnthropicMessageSchema = z.object({
  role: z.string(),
  content: z.union([z.string(), z.array(AnthropicInputContentBlockSchema)]),
});

const AnthropicFunctionToolSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    input_schema: z.record(z.unknown()),
  })
  .passthrough();

const AnthropicProviderDefinedToolSchema = z
  .object({
    type: z.string(),
    name: z.string(),
  })
  .passthrough();

export const AnthropicMessagesRequestSchema = z.object({
  model: z.string(),
  messages: z.array(AnthropicMessageSchema),
  system: z
    .union([
      z.string(),
      z.array(
        z
          .object({ type: z.literal("text").optional(), text: z.string() })
          .passthrough(),
      ),
    ])
    .optional(),
  max_tokens: z.number().optional(), // Anthropic usually requires this, but we can make it optional and default it
  metadata: z.object({ user_id: z.string().optional() }).optional(),
  stop_sequences: z.array(z.string()).optional(),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  top_k: z.number().optional(),
  thinking: z.unknown().optional(),
  thinking_config: z.unknown().optional(),
  tools: z
    .array(
      z.union([
        AnthropicFunctionToolSchema,
        AnthropicProviderDefinedToolSchema,
      ]),
    )
    .optional(),
  tool_choice: z
    .union([
      z.object({ type: z.literal("auto") }),
      z.object({ type: z.literal("any") }),
      z.object({ type: z.literal("tool"), name: z.string() }),
      z.object({ type: z.literal("none") }),
    ])
    .optional(),
});

export type AnthropicMessagesRequest = z.infer<
  typeof AnthropicMessagesRequestSchema
>;

export const AnthropicMessagesResponseSchema = z.object({
  id: z.string(),
  type: z.literal("message"),
  role: z.literal("assistant"),
  content: z.array(AnthropicContentBlockSchema),
  model: z.string(),
  stop_reason: z.string().nullable(),
  stop_sequence: z.string().nullable(),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
  }),
});

export type AnthropicMessagesResponse = z.infer<
  typeof AnthropicMessagesResponseSchema
>;

// --- OpenAI Responses (Custom) ---

export const OpenAIResponsesRequestSchema = z.object({
  model: z.string(),
  messages: z.array(OpenAIChatMessageSchema).optional(),
  input: z.union([z.string(), z.array(z.any())]).optional(),
  tools: z.array(z.union([ToolSchema, FunctionSchema])).optional(),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
});

export type OpenAIResponsesRequest = z.infer<
  typeof OpenAIResponsesRequestSchema
>;

const OpenAIResponsesUsageSchema = z.object({
  input_tokens: z.number(),
  input_tokens_details: z.object({ cached_tokens: z.number() }),
  output_tokens: z.number(),
  output_tokens_details: z.object({ reasoning_tokens: z.number() }),
  total_tokens: z.number(),
});

const OpenAIResponsesFunctionToolSchema = z.object({
  type: z.literal("function"),
  name: z.string(),
  description: z.string().nullable().optional(),
  parameters: z.record(z.unknown()).nullable(),
  strict: z.boolean().nullable(),
});

export const OpenAIResponsesResponseSchema = z.object({
  id: z.string(),
  object: z.literal("response"),
  created_at: z.number(),
  model: z.string(),
  status: z.string().optional(),
  error: z.unknown().nullable(),
  incomplete_details: z.unknown().nullable(),
  instructions: z.unknown().nullable(),
  metadata: z.record(z.string()).nullable(),
  output: z.array(z.lazy(() => OpenAIResponsesOutputItemSchema)),
  output_text: z.string(),
  parallel_tool_calls: z.boolean(),
  temperature: z.number().nullable(),
  tool_choice: z.unknown(),
  tools: z.array(OpenAIResponsesFunctionToolSchema).optional(),
  top_p: z.number().nullable(),
  truncation: z
    .union([z.literal("auto"), z.literal("disabled")])
    .nullable()
    .optional(),
  usage: OpenAIResponsesUsageSchema.optional(),
});

export type OpenAIResponsesResponse = z.infer<
  typeof OpenAIResponsesResponseSchema
>;

// --- Request Union Alias ---
export type ClientRequest =
  | OpenAIChatCompletionRequest
  | AnthropicMessagesRequest
  | OpenAIResponsesRequest;

// --- Streaming Schemas ---

export const OpenAIStreamChunkSchema = z.object({
  id: z.string(),
  object: z.literal("chat.completion.chunk"),
  created: z.number(),
  model: z.string(),
  system_fingerprint: z.string().optional(),
  choices: z.array(
    z.object({
      index: z.number(),
      delta: z.object({
        role: z.string().optional(),
        content: z.string().optional(),
        tool_calls: z
          .array(
            z.object({
              index: z.number(),
              id: z.string().optional(),
              type: z.literal("function").optional(),
              function: z.object({
                name: z.string().optional(),
                arguments: z.string().optional(),
              }),
            }),
          )
          .optional(),
      }),
      finish_reason: z.string().nullable(),
    }),
  ),
});

export type OpenAIStreamChunk = z.infer<typeof OpenAIStreamChunkSchema>;

export const AnthropicStreamEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message_start"),
    message: AnthropicMessagesResponseSchema,
  }),
  z.object({
    type: z.literal("content_block_start"),
    index: z.number(),
    content_block: AnthropicContentBlockSchema,
  }),
  z.object({
    type: z.literal("content_block_delta"),
    index: z.number(),
    delta: z.union([
      z.object({ type: z.literal("text_delta"), text: z.string() }),
      z.object({
        type: z.literal("input_json_delta"),
        partial_json: z.string(),
      }),
      z.object({ type: z.literal("thinking_delta"), thinking: z.string() }),
    ]),
  }),
  z.object({
    type: z.literal("content_block_stop"),
    index: z.number(),
  }),
  z.object({
    type: z.literal("message_delta"),
    delta: z.object({
      stop_reason: z.string().nullable(),
      stop_sequence: z.string().nullable(),
    }),
    usage: z.object({ output_tokens: z.number() }),
  }),
  z.object({
    type: z.literal("message_stop"),
  }),
  z.object({
    type: z.literal("ping").optional(),
  }),
  z.object({
    type: z.literal("error"),
    error: z.object({
      type: z.string(),
      message: z.string(),
    }),
  }),
]);

export type AnthropicStreamEvent = z.infer<typeof AnthropicStreamEventSchema>;

// --- Response Union Alias ---
export type ClientResponse =
  | OpenAIChatCompletionResponse
  | AnthropicMessagesResponse
  | OpenAIResponsesResponse;

// --- OpenAI Responses Output Items ---

export const OpenAIResponsesOutputItemSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message"),
    id: z.string(),
    role: z.literal("assistant"),
    content: z.array(
      z.union([
        z.object({
          type: z.literal("output_text"),
          text: z.string(),
          annotations: z.array(z.unknown()).default([]),
        }),
        z.object({ type: z.literal("refusal"), refusal: z.string() }),
      ]),
    ),
    status: z.string(),
  }),
  z.object({
    type: z.literal("function_call"),
    id: z.string(),
    call_id: z.string(),
    name: z.string(),
    arguments: z.string(),
    status: z.string().optional(),
  }),
  z.object({
    type: z.literal("reasoning"),
    id: z.string(),
    status: z.string().optional(),
    content: z
      .array(z.object({ type: z.literal("reasoning_text"), text: z.string() }))
      .optional(),
    summary: z.array(
      z.object({ type: z.literal("summary_text"), text: z.string() }),
    ),
    encrypted_content: z.string().nullable().optional(),
  }),
]);

export type OpenAIResponsesOutputItem = z.infer<
  typeof OpenAIResponsesOutputItemSchema
>;

export type AnthropicContentBlock = z.infer<typeof AnthropicContentBlockSchema>;
