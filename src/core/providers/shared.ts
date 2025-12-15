import { z } from "zod";
import type { JsonValue } from "../types.js";
import type { ProviderResponse, Request, Response } from "../types.js";

export { safeJsonString } from "../json.js";

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema.optional()),
  ]),
);

const ProviderErrorSchema = z
  .object({
    error: z.object({
      message: z.string(),
      code: z.union([z.string(), z.number()]).optional(),
    }),
  })
  .passthrough();

const UnknownErrorSchema = z
  .object({
    message: z.string().optional(),
    status: z.number().optional(),
    statusCode: z.number().optional(),
    code: z.union([z.string(), z.number()]).optional(),
    error: z.unknown().optional(),
    response: z
      .object({
        status: z.number().optional(),
        statusCode: z.number().optional(),
        data: z.unknown().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export function parseProviderError(body: JsonValue | undefined): {
  message: string;
  code?: string;
} {
  const parsed = ProviderErrorSchema.safeParse(body ?? {});
  if (parsed.success) {
    return {
      message: parsed.data.error.message,
      code:
        typeof parsed.data.error.code === "number"
          ? String(parsed.data.error.code)
          : parsed.data.error.code,
    };
  }
  return { message: "Provider returned an error response" };
}

export function toProviderErrorBody(error: unknown): JsonValue {
  const parsed = UnknownErrorSchema.safeParse(error);
  if (parsed.success) {
    const upstream = JsonValueSchema.safeParse(parsed.data.error);
    if (upstream.success) return upstream.data;

    const responseData = JsonValueSchema.safeParse(parsed.data.response?.data);
    if (responseData.success) return responseData.data;

    if (typeof parsed.data.message === "string" && parsed.data.message.length) {
      return { error: { message: parsed.data.message } };
    }
  }

  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Provider request failed";

  return { error: { message } };
}

export function toProviderErrorStatus(
  error: unknown,
  fallback: number = 500,
): number {
  const isValidHttpStatus = (value: number) =>
    Number.isInteger(value) && value >= 100 && value <= 599;

  const parsed = UnknownErrorSchema.safeParse(error);
  if (parsed.success) {
    const statusCandidates = [
      parsed.data.status,
      parsed.data.statusCode,
      parsed.data.response?.status,
      parsed.data.response?.statusCode,
    ];
    for (const candidate of statusCandidates) {
      if (typeof candidate === "number" && isValidHttpStatus(candidate)) {
        return candidate;
      }
    }

    const { code } = parsed.data;
    if (typeof code === "number" && isValidHttpStatus(code)) return code;
    if (typeof code === "string") {
      const parsedCode = Number.parseInt(code, 10);
      if (String(parsedCode) === code && isValidHttpStatus(parsedCode)) {
        return parsedCode;
      }
    }
  }

  const providerBody = toProviderErrorBody(error);
  const providerParsed = ProviderErrorSchema.safeParse(providerBody);
  if (providerParsed.success) {
    const providerCode = providerParsed.data.error.code;
    if (typeof providerCode === "number" && isValidHttpStatus(providerCode)) {
      return providerCode;
    }
    if (typeof providerCode === "string") {
      const parsedCode = Number.parseInt(providerCode, 10);
      if (
        String(parsedCode) === providerCode &&
        isValidHttpStatus(parsedCode)
      ) {
        return parsedCode;
      }
    }
  }

  return fallback;
}

export function toUlxErrorResponse(
  payload: ProviderResponse,
  request: Request,
): Response {
  const providerError = parseProviderError(payload.body);
  return {
    id: request.id,
    model: request.model,
    operation: request.operation,
    output: [],
    error: {
      message: providerError.message || `Provider error (${payload.status})`,
      code: providerError.code ?? String(payload.status),
    },
  };
}
