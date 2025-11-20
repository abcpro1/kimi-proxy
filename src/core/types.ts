export enum ClientFormat {
  OpenAIChatCompletions = "openai.chat-completions",
  AnthropicMessages = "anthropic.messages",
  OpenAIResponses = "openai.responses",
}

export enum ProviderFormat {
  OpenAIChatCompletions = "openai.chat-completions",
  VertexChatCompletions = "vertex.chat-completions",
}

export enum ProxyOperation {
  ChatCompletions = "chat.completions",
  Messages = "messages",
  Responses = "responses",
}

export type JsonPrimitive = string | number | boolean | null;

export type JsonArray = JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

export interface ProxyRequest<TBody extends JsonValue = JsonObject> {
  id: string;
  operation: ProxyOperation;
  clientFormat: ClientFormat;
  model: string;
  body: TBody;
  headers: Record<string, string>;
  stream: boolean;
  state: Record<string, JsonValue>;
}

export interface ConvertedRequest<TBody extends JsonValue = JsonValue> {
  body: TBody;
  headers?: Record<string, string>;
}

export interface ConversionContext<TBody extends JsonValue = JsonValue> {
  request: ProxyRequest<TBody>;
  providerFormat: ProviderFormat;
}

export interface ProviderRequestPayload<TBody extends JsonValue = JsonValue> {
  body: TBody;
  headers: Record<string, string>;
}

export interface ProviderResponsePayload<TBody extends JsonValue = JsonValue> {
  status: number;
  body: TBody;
  headers: Record<string, string>;
}

export interface PipelineResult {
  statusCode: number;
  responseBody: JsonValue;
  providerResponse: ProviderResponsePayload;
  providerRequestBody: JsonValue;
  request: ProxyRequest;
  isError: boolean;
}

export type RequestTransformStage = "source" | "post-conversion";
export type ResponseTransformStage = "provider" | "post-conversion";

export interface RequestTransformContext {
  request: ProxyRequest;
  providerRequest?: ProviderRequestPayload;
}

export interface ResponseTransformContext {
  request: ProxyRequest;
  providerResponse?: ProviderResponsePayload;
  clientResponse?: JsonValue;
}

export interface RequestTransform {
  name: string;
  stage: RequestTransformStage;
  priority?: number;
  applies(context: RequestTransformContext): boolean;
  transform(context: RequestTransformContext): Promise<void> | void;
}

export interface ResponseTransform {
  name: string;
  stage: ResponseTransformStage;
  priority?: number;
  applies(context: ResponseTransformContext): boolean;
  transform(context: ResponseTransformContext): Promise<void> | void;
}
