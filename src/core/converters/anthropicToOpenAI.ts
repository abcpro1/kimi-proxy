import {
  anthropicToOpenAIRequest,
  openaiToAnthropicResponse,
  type AnthropicMessageRequest,
  type AnthropicMessageResponse,
  type OpenAIChatRequest,
  type OpenAIChatResponse,
} from "../../adapters/anthropicAdapter.js";
import {
  ClientFormat,
  ProviderFormat,
  ProxyOperation,
  ConversionContext,
  ConvertedRequest,
} from "../types.js";
import { Converter } from "./types.js";

export class AnthropicToOpenAIConverter
  implements
    Converter<
      AnthropicMessageRequest,
      OpenAIChatRequest,
      OpenAIChatResponse,
      AnthropicMessageResponse
    >
{
  name = "anthropic-to-openai";
  sourceFormat = ClientFormat.AnthropicMessages;
  targetFormat = ProviderFormat.OpenAIChatCompletions;
  operations = [ProxyOperation.Messages];

  convertRequest(
    body: AnthropicMessageRequest,
    _context: ConversionContext<AnthropicMessageRequest>,
  ): ConvertedRequest<OpenAIChatRequest> {
    void _context;
    const converted = anthropicToOpenAIRequest(body);
    return { body: converted };
  }

  convertResponse(
    body: OpenAIChatResponse,
    _context: ConversionContext<AnthropicMessageRequest>,
  ): AnthropicMessageResponse {
    void _context;

    // Validate response body before conversion
    if (!body) {
      throw new Error("Cannot convert response: body is null or undefined");
    }

    return openaiToAnthropicResponse(body);
  }
}
