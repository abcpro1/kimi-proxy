import {
  ClientFormat,
  ProviderFormat,
  ProxyOperation,
  ConversionContext,
  ConvertedRequest,
  JsonValue,
} from "../types.js";

export interface Converter<
  TClientRequest extends JsonValue = JsonValue,
  TProviderRequest extends JsonValue = JsonValue,
  TProviderResponse extends JsonValue = JsonValue,
  TClientResponse extends JsonValue = JsonValue,
> {
  name: string;
  sourceFormat: ClientFormat;
  targetFormat: ProviderFormat;
  operations: ProxyOperation[];
  convertRequest(
    body: TClientRequest,
    context: ConversionContext<TClientRequest>,
  ):
    | Promise<ConvertedRequest<TProviderRequest>>
    | ConvertedRequest<TProviderRequest>;
  convertResponse(
    body: TProviderResponse,
    context: ConversionContext<TClientRequest>,
  ): Promise<TClientResponse> | TClientResponse;
}

export class ConverterRegistry {
  private converters: Converter[] = [];

  register(converter: Converter) {
    this.converters.push(converter);
  }

  resolve(
    source: ClientFormat,
    target: ProviderFormat,
    operation: ProxyOperation,
  ): Converter {
    const match = this.converters.find(
      (converter) =>
        converter.sourceFormat === source &&
        converter.targetFormat === target &&
        converter.operations.includes(operation),
    );
    if (!match) {
      throw new Error(
        `No converter registered for ${source} -> ${target} (${operation})`,
      );
    }
    return match;
  }
}
