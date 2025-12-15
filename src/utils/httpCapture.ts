import { type JsonValue } from "../core/types.js";

export interface CapturedInteraction {
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: JsonValue | undefined;
  };
  response: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: JsonValue | undefined;
  };
}

function headersToObject(headers: Headers): Record<string, string> {
  const obj: Record<string, string> = {};
  headers.forEach((value, key) => {
    obj[key] = value;
  });
  return obj;
}

export function createCapturingFetch(
  originalFetch: typeof fetch = globalThis.fetch,
) {
  const interaction: Partial<CapturedInteraction> = {};

  type FetchCall = (
    ...args: Parameters<typeof originalFetch>
  ) => ReturnType<typeof originalFetch>;

  const trackingFetch: FetchCall = async (input, init) => {
    let url = input.toString();
    let method = init?.method ?? "GET";
    let headers = new Headers(init?.headers);
    let reqBody: JsonValue | undefined;

    if (input instanceof Request) {
      url = input.url;
      method = input.method;
      // Merge headers if needed, but usually init headers override or merge
      // For simplicity, lets look at init headers first as that is what we usually see
      if (!init?.headers) {
        headers = input.headers;
      }
    }

    if (init?.body && typeof init.body === "string") {
      try {
        reqBody = JSON.parse(init.body);
      } catch {
        reqBody = init.body;
      }
    } else if (input instanceof Request && !reqBody) {
      // Try to read body from request if possible, but it might be consumed
      // Since we are proxying, we might not want to consume it before fetch
      // But for logging, we want it.
      // Reading body from Request object that is about to be fetched is tricky because of streams.
      // For now, let's stick to init.body which is what usually happens in these SDKs
    }

    interaction.request = {
      url,
      method,
      headers: headersToObject(headers),
      body: reqBody,
    };

    const response = await originalFetch(input, init);

    const cloned = response.clone();
    // We assume JSON response for these providers usually
    const text = await cloned.text();
    let resBody: JsonValue | undefined;
    try {
      resBody = JSON.parse(text);
    } catch {
      resBody = text;
    }

    interaction.response = {
      status: response.status,
      statusText: response.statusText,
      headers: headersToObject(response.headers),
      body: resBody,
    };

    return response;
  };

  const wrappedFetch = Object.assign(trackingFetch, originalFetch);

  const maybePreconnect = (originalFetch as unknown as { preconnect?: unknown })
    .preconnect;
  if (typeof maybePreconnect === "function") {
    Object.assign(wrappedFetch, {
      preconnect: maybePreconnect.bind(originalFetch),
    });
  }

  return { fetch: wrappedFetch, interaction };
}
