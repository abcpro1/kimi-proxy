export type LoadBalancingStrategy =
  | "first"
  | "round_robin"
  | "random"
  | "weighted_random";

export interface ModelDefinition {
  name: string;
  provider: string;
  upstreamModel: string;
  weight?: number;
  strategy?: LoadBalancingStrategy;
  ensureToolCall?: boolean;
  /**
   * Profile identifier for alias routing.
   * When specified, this model can be accessed via the profile prefix in the URL.
   * Models without a profile are available globally.
   */
  profile?: string;
  /**
   * Provider-specific configuration (e.g., api_key, base_url, routing params)
   * Supports environment variable substitution with $ prefix (e.g., "$API_KEY")
   * Each provider defines its own typed interface (OpenAIModelConfig, OpenRouterModelConfig, etc.)
   * and validates this configuration during invocation.
   */
  providerConfig?: Record<string, unknown>;
}

export interface ModelVariant extends ModelDefinition {
  weight: number;
  ensureToolCall: boolean;
  profile?: string;
}

export interface ResolvedModelRoute {
  name: string;
  provider: string;
  upstreamModel: string;
  weight: number;
  strategy: LoadBalancingStrategy;
  ensureToolCall: boolean;
  profile?: string;
}

export interface ModelSummary {
  name: string;
  strategy: LoadBalancingStrategy;
  variants: ModelVariant[];
}

export class ModelRegistry {
  private readonly groups = new Map<string, ModelVariant[]>();
  private readonly roundRobinIndices = new Map<string, number>();
  private readonly summaries: ModelSummary[];

  constructor(
    definitions: ModelDefinition[],
    private readonly defaultStrategy: LoadBalancingStrategy = "first",
  ) {
    if (!definitions.length) {
      throw new Error("Model registry requires at least one model definition");
    }

    for (const def of definitions) {
      const entry: ModelVariant = {
        ...def,
        weight:
          typeof def.weight === "number" && def.weight > 0 ? def.weight : 1,
        ensureToolCall: Boolean(def.ensureToolCall),
      };
      const list = this.groups.get(def.name) ?? [];
      list.push(entry);
      this.groups.set(def.name, list);
    }

    this.summaries = Array.from(this.groups.entries()).map(
      ([name, variants]) => ({
        name,
        strategy: this.resolveStrategy(variants),
        variants,
      }),
    );
  }

  resolve(modelName: string, profile?: string): ModelVariant {
    let variants = this.groups.get(modelName);

    if (variants && variants.length > 0 && profile) {
      const filtered = variants.filter((v) => v.profile === profile);
      if (filtered.length > 0) {
        variants = filtered;
      }
    }

    if (!variants || variants.length === 0) {
      throw new Error(
        `Model "${modelName}" is not configured${profile ? ` in profile "${profile}"` : ""}`,
      );
    }

    const strategy = this.resolveStrategy(variants);
    let selectedVariant: ModelVariant | undefined;
    switch (strategy) {
      case "round_robin":
        selectedVariant = this.pickRoundRobin(modelName, variants);
        break;
      case "random":
        selectedVariant = variants[Math.floor(Math.random() * variants.length)];
        break;
      case "weighted_random":
        selectedVariant = this.pickWeighted(variants);
        break;
      case "first":
      default:
        selectedVariant = variants[0];
        break;
    }

    if (!selectedVariant) {
      throw new Error(
        `Failed to select variant for model "${modelName}"${profile ? ` in profile "${profile}"` : ""}`,
      );
    }
    return selectedVariant;
  }

  list(): ModelSummary[] {
    return this.summaries.map((summary) => ({
      name: summary.name,
      strategy: summary.strategy,
      variants: summary.variants.map((variant) => ({ ...variant })),
    }));
  }

  listRoutes(): ResolvedModelRoute[] {
    const routes: ResolvedModelRoute[] = [];
    for (const [name, variants] of this.groups.entries()) {
      const strategy = this.resolveStrategy(variants);
      for (const variant of variants) {
        routes.push({
          name,
          provider: variant.provider,
          upstreamModel: variant.upstreamModel,
          weight: variant.weight,
          strategy: variant.strategy ?? strategy,
          ensureToolCall: Boolean(variant.ensureToolCall),
          profile: variant.profile,
        });
      }
    }
    return routes;
  }

  private resolveStrategy(variants: ModelVariant[]): LoadBalancingStrategy {
    const explicit = variants.find((variant) => variant.strategy)?.strategy;
    return explicit ?? this.defaultStrategy;
  }

  private pickRoundRobin(
    modelName: string,
    variants: ModelVariant[],
  ): ModelVariant {
    const current = this.roundRobinIndices.get(modelName) ?? 0;
    const next = (current + 1) % variants.length;
    this.roundRobinIndices.set(modelName, next);
    return variants[current];
  }

  private pickWeighted(variants: ModelVariant[]): ModelVariant {
    const total = variants.reduce((sum, variant) => sum + variant.weight, 0);
    const needle = Math.random() * total;
    let cumulative = 0;
    for (const variant of variants) {
      cumulative += variant.weight;
      if (needle < cumulative) {
        return variant;
      }
    }
    return variants[variants.length - 1];
  }
}
