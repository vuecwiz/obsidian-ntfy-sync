import { domainToASCII } from "node:url";
import type { IncomingMessage } from "../../domain/types";
import { sha256Hex } from "../../shared/crypto";
import { SyncError } from "../../shared/errors";
import { KNOWN_FIELDS, type NtfyMessageDto } from "./dto";

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/iu;

export function canonicalServerOrigin(baseUrl: string, allowInsecureHttp = false): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new SyncError("CONFIG_INVALID", "Invalid server URL", false);
  }
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(allowInsecureHttp && loopback)) {
    throw new SyncError(
      "CONFIG_INVALID",
      "Server URL must use HTTPS (HTTP only for loopback)",
      false,
    );
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.origin + (url.pathname === "/" ? "" : url.pathname);
}

export function sourceKey(serverOrigin: string, topic: string, id: string): string {
  return `${sha256Hex(serverOrigin).slice(0, 24)}/${encodeURIComponent(topic)}/${encodeURIComponent(id)}`;
}

export function extractFirstUrl(text: string): IncomingMessage["firstUrl"] {
  const match = text.match(URL_PATTERN);
  if (!match) return undefined;
  try {
    const raw = match[0].replace(/[.,!?;:]+$/u, "");
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    const hostname = domainToASCII(url.hostname).toLowerCase();
    if (!hostname) return undefined;
    return { raw, protocol: url.protocol, hostname };
  } catch {
    return undefined;
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) {
    throw new SyncError("PROTOCOL_INVALID", `Missing or invalid ${field}`, false);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function epochMs(value: unknown, field: string, required: boolean): number | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new SyncError("PROTOCOL_INVALID", `Invalid ${field}`, false);
  }
  return value * 1000;
}

export function normalizeMessage(
  dto: NtfyMessageDto,
  connectionId: string,
  serverOrigin: string,
  receivedAtMs = Date.now(),
  maxBodyBytes = 64 * 1024,
): IncomingMessage {
  const topic = requireString(dto.topic, "topic");
  const messageId = requireString(dto.id, "id");
  const publishedAtMs = epochMs(dto.time, "time", true);
  if (publishedAtMs === undefined) throw new SyncError("PROTOCOL_INVALID", "Missing time", false);
  if (typeof dto.message !== "string") {
    throw new SyncError("PROTOCOL_INVALID", "Missing or invalid message", false);
  }
  const body = dto.message;
  if (Buffer.byteLength(body, "utf8") > maxBodyBytes) {
    throw new SyncError("BODY_TOO_LARGE", "Message body exceeds configured limit", false);
  }
  const priority =
    dto.priority === undefined ? 3 : typeof dto.priority === "number" ? dto.priority : NaN;
  if (!Number.isInteger(priority) || priority < 1 || priority > 5) {
    throw new SyncError("PROTOCOL_INVALID", "Invalid priority", false);
  }
  const tags =
    dto.tags === undefined
      ? []
      : Array.isArray(dto.tags) && dto.tags.every((tag) => typeof tag === "string")
        ? dto.tags
        : undefined;
  if (!tags) throw new SyncError("PROTOCOL_INVALID", "Invalid tags", false);

  let attachment: IncomingMessage["attachment"];
  if (dto.attachment !== undefined) {
    if (!dto.attachment || typeof dto.attachment !== "object" || Array.isArray(dto.attachment)) {
      throw new SyncError("PROTOCOL_INVALID", "Invalid attachment", false);
    }
    const raw = dto.attachment as Record<string, unknown>;
    attachment = {
      name: requireString(raw.name, "attachment.name"),
      url: requireString(raw.url, "attachment.url"),
      type: optionalString(raw.type),
      size: typeof raw.size === "number" && raw.size >= 0 ? raw.size : undefined,
      expiresAtMs: epochMs(raw.expires, "attachment.expires", false),
    };
  }

  const combined = `${typeof dto.title === "string" ? dto.title : ""}\n${body}`;
  return {
    schemaVersion: 1,
    key: sourceKey(serverOrigin, topic, messageId),
    source: {
      connectionId,
      serverOrigin,
      topic,
      messageId,
      sequenceId: optionalString(dto.sequence_id),
    },
    publishedAtMs,
    expiresAtMs: epochMs(dto.expires, "expires", false),
    receivedAtMs,
    title: typeof dto.title === "string" ? dto.title : "",
    body,
    priority: priority as 1 | 2 | 3 | 4 | 5,
    tags,
    clickUrl: optionalString(dto.click),
    contentType: optionalString(dto.content_type),
    firstUrl: extractFirstUrl(combined),
    attachment,
    unknownFields: Object.keys(dto)
      .filter((key) => !KNOWN_FIELDS.has(key))
      .sort(),
  };
}
