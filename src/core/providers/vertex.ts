import {
  VertexAI,
  type Content,
  type GenerateContentRequest,
  type FunctionDeclaration,
  type FunctionDeclarationSchema,
  type Part,
  type Tool as VertexTool,
} from "@google-cloud/vertexai";
import {
  GoogleAuth,
  type GoogleAuthOptions,
  type JWTInput,
} from "google-auth-library";
import OpenAI from "openai";
import { SignatureCache } from "../../persistence/signatureCache.js";
import { logger } from "../../utils/logger.js";
import { type JsonObject, type JsonValue } from "../types.js";
import { safeJsonParseObject } from "../json.js";
import {
  ContentBlock,
  ProviderAdapter,
  ProviderResponse,
  Request,
  Response,
  Tool,
  ToolCall,
} from "../types.js";
import {
  parseProviderError,
  safeJsonString,
  toProviderErrorBody,
  toProviderErrorStatus,
  toUlxErrorResponse,
} from "./shared.js";
import {
  buildOpenAIPayload,
  normalizeOpenAIProviderResponse,
  openAIResponseToUlx,
} from "./openai.js";

const MAAS_MODEL_PATTERN = /\/.*-maas$/i;

function ulxContentToText(blocks: ContentBlock[]): string {
  if (!blocks.length) return "";
  return blocks
    .map((entry) => {
      if (entry.type === "text") return entry.text ?? "";
      if (entry.type === "image_url") return entry.url ?? "";
      if (entry.type === "json")
        return entry.data ? JSON.stringify(entry.data) : "";
      return entry.text ?? "";
    })
    .join("");
}

function toVertexProviderErrorStatus(error: unknown): number {
  const genericStatus = toProviderErrorStatus(error, 0);
  if (genericStatus) return genericStatus;

  const { message } = parseProviderError(toProviderErrorBody(error));
  const match = message.match(/got status:\s*(\d{3})\b/i);
  if (match?.[1]) {
    const parsed = Number.parseInt(match[1], 10);
    if (Number.isInteger(parsed) && parsed >= 100 && parsed <= 599) {
      return parsed;
    }
  }

  return 500;
}

export class VertexProviderAdapter implements ProviderAdapter {
  key = "vertex";
  providerFormat = "vertex";

  private signatureCache?: SignatureCache;

  constructor(
    private readonly baseConfig?: VertexConfig,
    signatureCache?: SignatureCache,
  ) {
    this.signatureCache = signatureCache;
  }

  private getSignatureCache(): SignatureCache {
    if (!this.signatureCache) {
      this.signatureCache = new SignatureCache();
    }
    return this.signatureCache;
  }

  private requiresThoughtSignatures(model?: string): boolean {
    const normalized = (model ?? "").toLowerCase();
    return normalized.includes("gemini-3") && !normalized.includes("image");
  }

  private resolveConfig(overrides?: JsonObject): VertexConfig {
    const merged: Partial<VertexConfig> = { ...(this.baseConfig ?? {}) };
    const extras = (overrides ?? {}) as Partial<VertexModelConfig>;

    if (typeof extras.projectId === "string")
      merged.projectId = extras.projectId;
    if (typeof extras.location === "string") merged.location = extras.location;
    if (typeof extras.endpointOverride === "string")
      merged.endpointOverride = extras.endpointOverride;
    if (extras.credentials && typeof extras.credentials === "object") {
      merged.credentials = extras.credentials;
      merged.credentialsPath = undefined;
    }
    if (typeof extras.credentialsPath === "string") {
      merged.credentialsPath = extras.credentialsPath;
      merged.credentials = undefined;
    }
    if (extras.thinkingConfig) {
      merged.thinkingConfig = extras.thinkingConfig;
    }

    if (!merged.projectId || !merged.location) {
      throw new Error("Vertex provider requires projectId and location");
    }
    if (!merged.credentials && !merged.credentialsPath) {
      throw new Error(
        "Vertex provider requires credentials (path or inline JSON)",
      );
    }

    return merged as VertexConfig;
  }

  private async getAccessToken(config: VertexConfig): Promise<string> {
    const authOptions: GoogleAuthOptions = {
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    };
    if (config.credentialsPath) {
      authOptions.keyFilename = config.credentialsPath;
    } else if (config.credentials) {
      authOptions.credentials = config.credentials;
    }
    const auth = new GoogleAuth(authOptions);
    const token = await auth.getAccessToken();
    if (!token) {
      throw new Error("Unable to acquire access token for Vertex AI MaaS");
    }
    return token;
  }

  async invoke(
    request: Request,
    config?: JsonObject,
  ): Promise<ProviderResponse> {
    let vertexRequest: GenerateContentRequest | undefined;
    try {
      const resolved = this.resolveConfig(config);
      const modelId = this.normalizeModelId(request.model);
      const location = this.resolveLocation(modelId, resolved.location);

      if (modelId && MAAS_MODEL_PATTERN.test(modelId)) {
        return this.invokeMaaS(request, resolved, modelId, location);
      }

      const modelResource = this.resolveModelResource(
        modelId ?? request.model,
        resolved.projectId,
        location,
      );

      const systemInstruction = this.buildSystemInstruction(
        this.extractSystemParts(request),
      );
      const tools = this.toVertexTools(request.tools);

      const client = new VertexAI({
        project: resolved.projectId,
        location,
        apiEndpoint: this.resolveApiEndpoint(resolved, location, modelId),
        googleAuthOptions: {
          keyFilename: resolved.credentialsPath,
          credentials: resolved.credentials,
        },
      });

      const model = client.preview.getGenerativeModel({
        model: modelResource,
        systemInstruction,
        tools,
      });

      vertexRequest = {
        contents: this.toVertexContents(request.messages, request.model),
        systemInstruction,
        tools,
        generationConfig: {
          ...(resolved.thinkingConfig
            ? { thinkingConfig: resolved.thinkingConfig }
            : {}),
          ...this.toGenerationConfig(request),
        },
      };

      const response = await model.generateContent(vertexRequest);

      return {
        status: 200,
        body: response.response as unknown as JsonValue,
        headers: {},
        requestBody: vertexRequest as unknown as JsonValue,
      };
    } catch (error) {
      logger.error({ err: error }, "Vertex invocation failed");
      const status = toVertexProviderErrorStatus(error);
      return {
        status,
        body: toProviderErrorBody(error),
        headers: {},
        requestBody: (vertexRequest as unknown as JsonValue) ?? undefined,
      };
    }
  }

  private async invokeMaaS(
    request: Request,
    config: VertexConfig,
    model: string,
    location: string,
  ): Promise<ProviderResponse> {
    let payload: JsonObject | undefined;
    try {
      const token = await this.getAccessToken(config);
      const host = this.resolveApiEndpoint(config, location, model);
      const baseURL = `https://${host}/v1/projects/${config.projectId}/locations/${location}/endpoints/openapi`;

      const client = new OpenAI({
        baseURL,
        apiKey: token,
        defaultHeaders: {
          "X-Goog-User-Project": config.projectId,
        },
      });

      payload = buildOpenAIPayload(request);
      // Ensure model is set correctly for MaaS
      payload.model = model;

      const response = await client.chat.completions.create(
        payload as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParams,
      );

      return {
        status: 200,
        body: response as unknown as JsonValue,
        headers: {},
        requestBody: payload as unknown as JsonValue,
      };
    } catch (error) {
      logger.error({ err: error }, "Vertex MaaS invocation failed");
      const status = toProviderErrorStatus(error);
      return {
        status,
        body: toProviderErrorBody(error),
        headers: {},
        requestBody: (payload as unknown as JsonValue) ?? undefined,
      };
    }
  }

  toUlxResponse(payload: ProviderResponse, request: Request): Response {
    if (payload.status >= 400) {
      return toUlxErrorResponse(payload, request);
    }

    if (request.model && MAAS_MODEL_PATTERN.test(request.model)) {
      const normalized = normalizeOpenAIProviderResponse(payload);
      if ("error" in normalized) {
        return {
          id: request.id,
          model: request.model,
          operation: request.operation,
          output: [],
          error: {
            message: normalized.error,
            code: "invalid_response",
          },
        };
      }
      return openAIResponseToUlx(normalized.body, request, normalized.kimi);
    }

    if (!payload.body || typeof payload.body !== "object") {
      return {
        id: request.id,
        model: request.model,
        operation: request.operation,
        output: [],
        error: {
          message: "Invalid provider response payload",
          code: "invalid_response",
        },
      };
    }

    return this.vertexResponseToUlx(
      payload.body as Record<string, unknown>,
      request,
    );
  }

  private vertexResponseToUlx(
    body: Record<string, unknown>,
    request: Request,
  ): Response {
    const candidates =
      (body.candidates as Array<Record<string, unknown>>) ?? [];
    const candidate = candidates[0];

    if (!candidate) {
      if (body.usageMetadata) {
        const usage = body.usageMetadata as {
          promptTokenCount?: number;
          candidatesTokenCount?: number;
          totalTokenCount?: number;
        };

        return {
          id: request.id,
          model: request.model,
          operation: request.operation,
          output: [],
          usage: {
            input_tokens: usage.promptTokenCount,
            output_tokens: usage.candidatesTokenCount,
            total_tokens: usage.totalTokenCount,
          },
        };
      }

      return {
        id: request.id,
        model: request.model,
        operation: request.operation,
        output: [],
        error: {
          message: "Vertex response missing candidates",
          code: "invalid_response",
        },
      };
    }

    const content =
      (candidate.content as { parts?: Array<Record<string, unknown>> })
        ?.parts ?? [];
    const messageBlocks: ContentBlock[] = [];
    const toolCalls: ToolCall[] = [];
    let toolCallIndex = 0;

    for (const part of content) {
      const text = part?.text;
      const isThought = part?.thought === true;
      const functionCall = part?.functionCall as
        | { name?: string; args?: unknown }
        | undefined;
      const thoughtSignature =
        typeof part.thoughtSignature === "string"
          ? part.thoughtSignature
          : typeof part.thought_signature === "string"
            ? part.thought_signature
            : undefined;

      if (typeof text === "string") {
        if (isThought) {
          messageBlocks.push({
            type: "reasoning",
            text,
            data: thoughtSignature
              ? { signature: thoughtSignature }
              : undefined,
          });
        } else {
          messageBlocks.push({ type: "text", text });
        }
      }

      if (functionCall?.name) {
        const id = `call_${request.id}_${toolCallIndex++}`;
        toolCalls.push({
          id,
          type: "function",
          name: functionCall.name,
          arguments: safeJsonString(functionCall.args ?? {}),
        });

        if (thoughtSignature) {
          this.getSignatureCache().store(id, thoughtSignature);
        }
      }
    }

    const usage = body.usageMetadata as
      | {
          promptTokenCount?: number;
          candidatesTokenCount?: number;
          totalTokenCount?: number;
        }
      | undefined;

    return {
      id: request.id,
      model: request.model,
      operation: request.operation,
      finish_reason:
        (candidate.finishReason as string | undefined) ?? undefined,
      output: [
        {
          type: "message",
          role: "assistant",
          content: messageBlocks,
          tool_calls: toolCalls.length ? toolCalls : undefined,
          status:
            candidate.finishReason === "MAX_TOKENS"
              ? "incomplete"
              : "completed",
        },
      ],
      usage: usage
        ? {
            input_tokens: usage.promptTokenCount,
            output_tokens: usage.candidatesTokenCount,
            total_tokens: usage.totalTokenCount,
          }
        : undefined,
      metadata: {
        providerResponse: body as unknown as JsonValue,
      },
    };
  }

  private toGenerationConfig(
    request: Request,
  ): GenerateContentRequest["generationConfig"] {
    const config: GenerateContentRequest["generationConfig"] = {};
    if (typeof request.parameters.temperature === "number")
      config.temperature = request.parameters.temperature;
    if (typeof request.parameters.top_p === "number")
      config.topP = request.parameters.top_p;
    if (typeof request.parameters.max_tokens === "number")
      config.maxOutputTokens = request.parameters.max_tokens;
    if (typeof request.parameters.top_k === "number")
      config.topK = request.parameters.top_k;
    if (request.parameters.thinking_config)
      (config as unknown as Record<string, unknown>).thinkingConfig =
        request.parameters.thinking_config;
    return config;
  }

  private buildSystemInstruction(system?: string[]): Content | undefined {
    if (!system?.length) return undefined;
    return {
      role: "system",
      parts: [{ text: system.join("\n") }],
    };
  }

  private extractSystemParts(request: Request): string[] | undefined {
    const parts: string[] = [];
    if (request.system?.length) parts.push(...request.system);
    for (const message of request.messages) {
      if (message.role !== "system" && message.role !== "developer") continue;
      const text = ulxContentToText(message.content);
      if (text) parts.push(text);
    }
    return parts.length ? parts : undefined;
  }

  private toVertexContents(
    messages: Request["messages"],
    model?: string,
  ): Content[] {
    const toolNamesByCallId = new Map<string, string>();
    for (const message of messages) {
      if (message.role !== "assistant" || !message.tool_calls?.length) continue;
      for (const call of message.tool_calls) {
        if (call.id && call.name) toolNamesByCallId.set(call.id, call.name);
      }
    }

    const shouldAttachThoughtSignatures = this.requiresThoughtSignatures(model);

    const contents: Content[] = [];
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      if (message.role === "system" || message.role === "developer") {
        continue;
      }

      if (message.role === "assistant") {
        let parts = this.toVertexParts(message.content);

        const toolCalls = message.tool_calls ?? [];
        if (toolCalls.length) {
          const toolCallParts = toolCalls.map((call, index) => {
            const part: Record<string, unknown> = {
              functionCall: {
                name: call.name,
                args: safeJsonParseObject(call.arguments),
              },
            };

            if (shouldAttachThoughtSignatures && index === 0) {
              const cached = this.getSignatureCache().retrieve(call.id);
              if (cached) {
                part.thoughtSignature = cached;
              } else {
                logger.warn(
                  { tool_call_id: call.id, tool: call.name, model },
                  "Missing thought signature; using skip_thought_signature_validator",
                );
                part.thoughtSignature = "skip_thought_signature_validator";
              }
            }

            return part as unknown as Part;
          });

          if (
            parts.length === 1 &&
            (parts[0] as { text?: string }).text === ""
          ) {
            parts = [];
          }
          parts = [...parts, ...toolCallParts];
        }

        contents.push({ role: "model", parts });

        if (toolCalls.length) {
          const callIds = new Set(toolCalls.map((call) => call.id));
          const outputByCallId = new Map<string, string>();

          let j = i + 1;
          while (j < messages.length) {
            const next = messages[j];
            if (next.role !== "tool") break;

            const toolCallId = next.tool_call_id;
            if (typeof toolCallId !== "string" || !toolCallId) break;
            if (!callIds.has(toolCallId)) break;

            const prev = outputByCallId.get(toolCallId) ?? "";
            outputByCallId.set(
              toolCallId,
              prev + ulxContentToText(next.content),
            );
            j++;
          }

          if (outputByCallId.size) {
            const responseParts: Part[] = toolCalls
              .filter((call) => outputByCallId.has(call.id))
              .map((call) => {
                const rawOutput = outputByCallId.get(call.id) ?? "";
                const parsedOutput = safeJsonParseObject(rawOutput);
                return {
                  functionResponse: {
                    name: call.name,
                    response: {
                      name: call.name,
                      content: parsedOutput,
                    },
                  },
                } as unknown as Part;
              });

            if (responseParts.length) {
              contents.push({ role: "user", parts: responseParts });
              i = j - 1;
            }
          }
        }

        continue;
      }

      if (message.role === "tool") {
        const toolCallId = message.tool_call_id;
        const toolName =
          typeof toolCallId === "string" && toolCallId.length
            ? toolNamesByCallId.get(toolCallId)
            : undefined;

        if (toolName) {
          const rawOutput = ulxContentToText(message.content);
          const parsedOutput = safeJsonParseObject(rawOutput);

          contents.push({
            role: "user",
            parts: [
              {
                functionResponse: {
                  name: toolName,
                  response: {
                    name: toolName,
                    content: parsedOutput,
                  },
                },
              } as unknown as Part,
            ],
          });
          continue;
        }

        contents.push({
          role: "user",
          parts: this.toVertexParts(message.content),
        });
        continue;
      }

      contents.push({
        role: "user",
        parts: this.toVertexParts(message.content),
      });
    }

    return contents;
  }

  private toVertexParts(blocks: ContentBlock[]): Part[] {
    if (!blocks.length) return [{ text: "" }];
    return blocks.map((block) => {
      if (block.type === "text") return { text: block.text ?? "" } as Part;
      if (block.type === "json")
        return { text: JSON.stringify(block.data) } as Part;
      if (block.type === "image_url") {
        return {
          fileData: {
            mimeType: block.mime ?? "application/octet-stream",
            fileUri: block.url ?? "",
          },
        } as Part;
      }
      return { text: block.text ?? "" } as Part;
    });
  }

  private toVertexTools(tools?: Tool[]): VertexTool[] | undefined {
    if (!tools?.length) return undefined;
    return [
      {
        functionDeclarations: tools.map(
          (tool) =>
            ({
              name: tool.name,
              description: tool.description,
              parameters:
                tool.parameters as unknown as FunctionDeclarationSchema,
            }) as FunctionDeclaration,
        ),
      },
    ] as VertexTool[];
  }

  private normalizeModelId(model?: string): string | undefined {
    if (!model) return undefined;
    if (model.includes("gemini") && !model.includes("/")) {
      return `google/${model}`;
    }
    return model;
  }

  private resolveModelResource(
    model: string,
    project: string,
    location: string,
  ): string {
    if (model.startsWith("projects/") || model.startsWith("models/")) {
      return model;
    }

    if (model.includes("/")) {
      if (model.startsWith("publishers/")) {
        return `projects/${project}/locations/${location}/${model}`;
      }

      const parts = model.split("/");
      if (parts.length === 2) {
        const [publisher, modelName] = parts;
        return `projects/${project}/locations/${location}/publishers/${publisher}/models/${modelName}`;
      }
    }

    return model;
  }

  private resolveLocation(
    model: string | undefined,
    configured: string,
  ): string {
    if (model && (model.includes("google/") || model.includes("gemini"))) {
      return "global";
    }
    return configured;
  }

  private resolveApiEndpoint(
    config: VertexConfig,
    location: string,
    model?: string,
  ): string | undefined {
    if (config.endpointOverride) {
      try {
        return new URL(config.endpointOverride).host || config.endpointOverride;
      } catch {
        return config.endpointOverride;
      }
    }

    if (location === "global") {
      return "aiplatform.googleapis.com";
    }

    if (model && MAAS_MODEL_PATTERN.test(model)) {
      return "aiplatform.googleapis.com";
    }

    return `${location}-aiplatform.googleapis.com`;
  }
}

export interface VertexConfig {
  projectId: string;
  location: string;
  endpointOverride?: string;
  credentialsPath?: string;
  credentials?: JWTInput;
  thinkingConfig?: unknown;
}

export interface VertexModelConfig {
  projectId?: string;
  location?: string;
  endpointOverride?: string;
  credentialsPath?: string;
  credentials?: JWTInput;
  thinkingConfig?: unknown;
}
