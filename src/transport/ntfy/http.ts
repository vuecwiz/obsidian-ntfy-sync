import type { AuthConfig, TransportFault } from "../../domain/types";
import { authHeaders } from "./auth";

interface FaultResponse {
  status: number;
  headers: Headers | Record<string, string>;
}

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
  return ntfyPublishMessage(baseUrl, topic, auth, JSON.stringify(body), cache, signal);
}

export async function ntfyPublishMessage(
  baseUrl: string,
  topic: string,
  auth: AuthConfig,
  message: string,
  cache: boolean,
  signal?: AbortSignal,
): Promise<void> {
  const headers = authHeaders(auth);
  headers.set("Content-Type", "application/json");
  const body = JSON.stringify({ topic, message, cache: cache ? "yes" : "no" });
  await send(baseUrl, "POST", headers, body, signal);
}

export async function ntfyPublishTestMessage(
  baseUrl: string,
  topic: string,
  auth: AuthConfig,
  message: string,
  priority: 1 | 2 | 3 | 4 | 5,
  attachment?: { name: string; data: ArrayBuffer },
  signal?: AbortSignal,
): Promise<void> {
  return ntfyPublishUserMessage(baseUrl, topic, auth, { message, priority, attachment }, signal);
}

export interface NtfyUserPublishRequest {
  message: string;
  title?: string;
  priority?: 1 | 2 | 3 | 4 | 5;
  tags?: string[];
  clickUrl?: string;
  email?: string;
  delay?: string;
  markdown?: boolean;
  attachmentUrl?: string;
  filename?: string;
  attachment?: { name: string; data: ArrayBuffer };
}

export async function ntfyPublishUserMessage(
  baseUrl: string,
  topic: string,
  auth: AuthConfig,
  request: NtfyUserPublishRequest,
  signal?: AbortSignal,
): Promise<void> {
  const title = request.title?.trim();
  const tags = request.tags?.map((tag) => tag.trim()).filter(Boolean) ?? [];
  const attachment = request.attachment;
  if (!attachment) {
    const headers = authHeaders(auth);
    headers.set("Content-Type", "application/json");
    const body = {
      topic,
      message: request.message,
      cache: "yes",
      ...(request.priority ? { priority: request.priority } : {}),
      ...(title ? { title } : {}),
      ...(tags.length ? { tags } : {}),
      ...(request.clickUrl ? { click: request.clickUrl } : {}),
      ...(request.email ? { email: request.email } : {}),
      ...(request.delay ? { delay: request.delay } : {}),
      ...(request.markdown ? { markdown: true } : {}),
      ...(request.attachmentUrl ? { attach: request.attachmentUrl } : {}),
      ...(request.filename ? { filename: request.filename } : {}),
    };
    await send(baseUrl, "POST", headers, JSON.stringify(body), signal);
    return;
  }
  const headers = authHeaders(auth);
  headers.set("Content-Type", "application/octet-stream");
  headers.set("X-Filename", encodeHeaderValue(request.filename || attachment.name));
  if (request.priority) headers.set("X-Priority", String(request.priority));
  headers.set("X-Cache", "yes");
  if (request.message.trim()) headers.set("X-Message", encodeHeaderValue(request.message));
  if (title) headers.set("X-Title", encodeHeaderValue(title));
  if (tags.length) headers.set("X-Tags", encodeHeaderValue(tags.join(",")));
  if (request.clickUrl) headers.set("X-Click", request.clickUrl);
  if (request.email) headers.set("X-Email", request.email);
  if (request.delay) headers.set("X-Delay", request.delay);
  if (request.markdown) headers.set("X-Markdown", "true");
  await send(
    `${baseUrl.replace(/\/+$/u, "")}/${encodeURIComponent(topic)}`,
    "PUT",
    headers,
    attachment.data,
    signal,
  );
}

async function send(
  url: string,
  method: "POST" | "PUT",
  headers: Headers,
  body: string | ArrayBuffer,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(url, {
    method,
    headers,
    body,
    redirect: "error",
    signal,
  });
  if (!response.ok) throw responseFault(response);
}

function encodeHeaderValue(value: string): string {
  const safe = value.replace(/[\r\n]+/gu, " ");
  return /^[\x20-\x7e]*$/u.test(safe)
    ? safe
    : `=?UTF-8?B?${Buffer.from(safe, "utf8").toString("base64")}?=`;
}

function responseHeader(headers: Headers | Record<string, string>, name: string): string | null {
  if (headers instanceof Headers) return headers.get(name);
  const expected = name.toLocaleLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLocaleLowerCase() === expected) return value;
  }
  return null;
}
