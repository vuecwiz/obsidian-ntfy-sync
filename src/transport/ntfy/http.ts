import { requestUrl, type RequestUrlResponse } from "obsidian";
import type { AuthConfig, TransportFault } from "../../domain/types";
import { authHeaders, headersRecord } from "./auth";

type FaultResponse =
  | Pick<Response, "status" | "headers">
  | Pick<RequestUrlResponse, "status" | "headers">;

export class TransportFaultError extends Error implements TransportFault {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "TransportFaultError";
  }
}

export function responseFault(response: FaultResponse): TransportFaultError {
  const status = response.status;
  const retryAfter = responseHeader(response.headers, "retry-after");
  const retryAfterMs = retryAfter
    ? /^\d+$/.test(retryAfter)
      ? Number(retryAfter) * 1000
      : Math.max(0, Date.parse(retryAfter) - Date.now())
    : undefined;
  const retryable = status === 429 || status >= 500;
  const code =
    status === 401 || status === 403
      ? "AUTH_FAILED"
      : status === 429
        ? "RATE_LIMITED"
        : status >= 500
          ? "SERVER_ERROR"
          : "HTTP_PERMANENT";
  return new TransportFaultError(code, `ntfy HTTP ${status}`, retryable, status, retryAfterMs);
}

export async function ntfyPublish(
  baseUrl: string,
  topic: string,
  auth: AuthConfig,
  body: unknown,
  cache: boolean,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
  const headers = authHeaders(auth);
  headers.set("Content-Type", "application/json");
  const response = await requestUrl({
    url: baseUrl,
    method: "POST",
    headers: headersRecord(headers),
    body: JSON.stringify({ topic, message: JSON.stringify(body), cache: cache ? "yes" : "no" }),
    throw: false,
  });
  if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
  if (response.status < 200 || response.status >= 300) throw responseFault(response);
}

function responseHeader(headers: Headers | Record<string, string>, name: string): string | null {
  if (headers instanceof Headers) return headers.get(name);
  const expected = name.toLocaleLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLocaleLowerCase() === expected) return value;
  }
  return null;
}
