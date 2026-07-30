import type { AuthConfig, TransportFault } from "../../domain/types";
import { authHeaders } from "./auth";

export async function responseFault(response: Response): Promise<TransportFault> {
  const status = response.status;
  const retryAfter = response.headers.get("retry-after");
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
  return { code, message: `ntfy HTTP ${status}`, retryable, status, retryAfterMs };
}

export async function ntfyPublish(
  baseUrl: string,
  topic: string,
  auth: AuthConfig,
  body: unknown,
  cache: boolean,
  signal?: AbortSignal,
): Promise<void> {
  const headers = authHeaders(auth);
  headers.set("Content-Type", "application/json");
  const response = await fetch(baseUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ topic, message: JSON.stringify(body), cache: cache ? "yes" : "no" }),
    signal,
  });
  if (!response.ok) throw await responseFault(response);
}
