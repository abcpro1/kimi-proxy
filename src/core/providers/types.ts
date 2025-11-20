import {
  ProviderFormat,
  ProxyOperation,
  ProviderResponsePayload,
  ProxyRequest,
  JsonValue,
  JsonObject,
} from "../types.js";

export interface ProviderInvokeArgs<TBody extends JsonValue = JsonValue> {
  request: ProxyRequest<TBody>;
  body: TBody;
  headers?: Record<string, string>;
  stream: boolean;
  /**
   * Model-level provider configuration (optional)
   * Can override base provider configuration
   */
  providerConfig?: JsonObject;
}

export interface LLMProvider {
  key: string;
  format: ProviderFormat;
  supportedOperations: ProxyOperation[];
  invoke(args: ProviderInvokeArgs): Promise<ProviderResponsePayload<JsonValue>>;
  listModels?(): Promise<JsonValue>;
}

export class ProviderRegistry {
  private providers = new Map<string, LLMProvider>();

  register(provider: LLMProvider) {
    this.providers.set(provider.key, provider);
  }

  get(key: string): LLMProvider {
    const provider = this.providers.get(key);
    if (!provider) {
      throw new Error(`Provider ${key} is not registered`);
    }
    return provider;
  }
}
