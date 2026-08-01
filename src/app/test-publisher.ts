import type { AuthConfig, ConnectionConfigV1, PersistedSettingsV1 } from "../domain/types";
import type { ValidationIssue } from "../rules/engine";
import { canonicalServerOrigin } from "../transport/ntfy/normalizer";
import { ntfyPublishUserMessage } from "../transport/ntfy/http";
import { isValidNtfyTopic, validateSettings } from "../settings/validate";

export type TestPublishValidationCode =
  | "CONFIG_INVALID"
  | "CONNECTION_MISSING"
  | "CONNECTION_INVALID"
  | "TOPIC_INVALID"
  | "PRIORITY_INVALID"
  | "TITLE_TOO_LARGE"
  | "TAGS_INVALID"
  | "CLICK_URL_INVALID"
  | "EMAIL_INVALID"
  | "DELAY_INVALID"
  | "ATTACHMENT_URL_INVALID"
  | "ATTACHMENT_CONFLICT"
  | "FILENAME_INVALID"
  | "MESSAGE_REQUIRED"
  | "MESSAGE_TOO_LARGE"
  | "FILE_INVALID"
  | "FILE_TOO_LARGE";

export interface TestPublishDraft {
  baseUrl?: string;
  topic: string;
  message: string;
  priority?: 1 | 2 | 3 | 4 | 5;
  title?: string;
  tags?: string[];
  clickUrl?: string;
  email?: string;
  delay?: string;
  markdown?: boolean;
  attachmentUrl?: string;
  filename?: string;
  attachment?: { name: string; data: ArrayBuffer };
}

export class TestPublishValidationError extends Error {
  constructor(
    readonly code: TestPublishValidationCode,
    readonly issue?: ValidationIssue,
  ) {
    super(code);
    this.name = "TestPublishValidationError";
  }
}

export async function publishConfiguredTestMessage(
  settings: PersistedSettingsV1,
  draft: TestPublishDraft,
  signal?: AbortSignal,
): Promise<void> {
  return publishConfiguredMessage(settings, draft, { configuredTopicsOnly: true }, signal);
}

export interface ConfiguredPublishOptions {
  configuredTopicsOnly?: boolean;
}

export async function publishConfiguredMessage(
  settings: PersistedSettingsV1,
  draft: TestPublishDraft,
  options: ConfiguredPublishOptions = {},
  signal?: AbortSignal,
): Promise<void> {
  const issue = validateSettings(settings)[0];
  if (issue) throw new TestPublishValidationError("CONFIG_INVALID", issue);
  const target = resolvePublishTarget(settings, draft.baseUrl, options.configuredTopicsOnly);
  if (
    !isValidNtfyTopic(draft.topic) ||
    (options.configuredTopicsOnly && !target.connection?.topics.includes(draft.topic))
  ) {
    throw new TestPublishValidationError("TOPIC_INVALID");
  }
  if (draft.priority !== undefined && ![1, 2, 3, 4, 5].includes(draft.priority)) {
    throw new TestPublishValidationError("PRIORITY_INVALID");
  }
  if (Buffer.byteLength(draft.title?.trim() ?? "", "utf8") > 4 * 1024) {
    throw new TestPublishValidationError("TITLE_TOO_LARGE");
  }
  const tags = draft.tags?.map((tag) => tag.trim()).filter(Boolean) ?? [];
  if (tags.length > 20 || tags.some((tag) => tag.length > 64 || /[,\r\n]/u.test(tag))) {
    throw new TestPublishValidationError("TAGS_INVALID");
  }
  const clickUrl = draft.clickUrl?.trim();
  if (clickUrl && !isSafeClickUrl(clickUrl)) {
    throw new TestPublishValidationError("CLICK_URL_INVALID");
  }
  const email = draft.email?.trim();
  if (email && !isValidForwardEmail(email)) {
    throw new TestPublishValidationError("EMAIL_INVALID");
  }
  const delay = draft.delay?.trim();
  if (delay && (delay.length > 256 || !/^[\x20-\x7e]+$/u.test(delay))) {
    throw new TestPublishValidationError("DELAY_INVALID");
  }
  const attachmentUrl = draft.attachmentUrl?.trim();
  if (attachmentUrl && !isHttpUrl(attachmentUrl)) {
    throw new TestPublishValidationError("ATTACHMENT_URL_INVALID");
  }
  if (attachmentUrl && draft.attachment) {
    throw new TestPublishValidationError("ATTACHMENT_CONFLICT");
  }
  const filename = draft.filename?.trim();
  if (filename && (filename.length > 255 || /[\r\n/\\]/u.test(filename))) {
    throw new TestPublishValidationError("FILENAME_INVALID");
  }
  if (!draft.message.trim() && !draft.attachment && !attachmentUrl) {
    throw new TestPublishValidationError("MESSAGE_REQUIRED");
  }
  if (Buffer.byteLength(draft.message, "utf8") > settings.processing.maxBodyBytes) {
    throw new TestPublishValidationError("MESSAGE_TOO_LARGE");
  }
  if (
    draft.attachment &&
    draft.attachment.data.byteLength > settings.processing.maxAttachmentBytes
  ) {
    throw new TestPublishValidationError("FILE_TOO_LARGE");
  }
  await ntfyPublishUserMessage(
    target.baseUrl,
    draft.topic,
    target.auth,
    {
      message: draft.message,
      title: draft.title,
      priority: draft.priority,
      tags,
      clickUrl,
      email,
      delay,
      markdown: draft.markdown,
      attachmentUrl,
      filename,
      attachment: draft.attachment,
    },
    signal,
  );
}

function resolvePublishTarget(
  settings: PersistedSettingsV1,
  requestedBaseUrl: string | undefined,
  configuredTopicsOnly = false,
): { baseUrl: string; auth: AuthConfig; connection?: ConnectionConfigV1 } {
  const primary = settings.connections[0];
  if (configuredTopicsOnly) {
    if (!primary) throw new TestPublishValidationError("CONNECTION_MISSING");
    return {
      baseUrl: canonicalServerOrigin(primary.baseUrl, primary.allowInsecureHttp),
      auth: primary.readAuth,
      connection: primary,
    };
  }
  const rawBaseUrl = requestedBaseUrl?.trim() || primary?.baseUrl;
  if (!rawBaseUrl) throw new TestPublishValidationError("CONNECTION_MISSING");
  let baseUrl: string;
  try {
    // canonicalServerOrigin still restricts insecure HTTP to loopback when this flag is true.
    baseUrl = canonicalServerOrigin(rawBaseUrl, true);
  } catch {
    throw new TestPublishValidationError("CONNECTION_INVALID");
  }
  const connection = settings.connections.find((candidate) => {
    try {
      return canonicalServerOrigin(candidate.baseUrl, candidate.allowInsecureHttp) === baseUrl;
    } catch {
      return false;
    }
  });
  return { baseUrl, auth: connection?.readAuth ?? { kind: "none" }, connection };
}

function isSafeClickUrl(value: string): boolean {
  if (Buffer.byteLength(value, "utf8") > 2_048) return false;
  try {
    const protocol = new URL(value).protocol.toLocaleLowerCase();
    return !["javascript:", "data:", "file:"].includes(protocol);
  } catch {
    return false;
  }
}

function isValidForwardEmail(value: string): boolean {
  if (["yes", "true", "1"].includes(value.toLocaleLowerCase())) return true;
  return value.length <= 320 && /^[^\s@,\r\n]+@[^\s@,\r\n]+\.[^\s@,\r\n]+$/u.test(value);
}

function isHttpUrl(value: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
