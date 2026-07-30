export type SourceKey = string;

export type UiLanguageSetting = "auto" | "en" | "zh-CN";

export type AuthConfig =
  | { kind: "none" }
  | { kind: "basic"; username: string; password: string }
  | { kind: "bearer"; token: string };

export interface ConnectionConfigV1 {
  id: string;
  name: string;
  baseUrl: string;
  topics: string[];
  readAuth: AuthConfig;
  result?: {
    topic: string;
    writeAuth: AuthConfig;
    privacy: "minimal" | "paths";
    cache: boolean;
  };
  mode: "auto" | "stream" | "poll";
  pollIntervalSeconds: number;
  allowInsecureHttp: boolean;
  initialReplay: { kind: "latest" | "duration" | "all"; valueSeconds?: number };
  reconnect: { minMs: number; maxMs: number; jitterRatio: number };
}

export interface ProcessingConfigV1 {
  overlapSeconds: number;
  maxBodyBytes: number;
  maxAttachmentBytes: number;
  maxAttempts: number;
  concurrency: number;
  completedRetentionDays: number;
  completedRetentionCount: number;
  downloadSameOriginAttachments: boolean;
}

export interface PersistedSettingsV1 {
  schemaVersion: 1;
  uiLanguage: UiLanguageSetting;
  enabled: boolean;
  device: { deviceId: string; writerDeviceId: string };
  connections: ConnectionConfigV1[];
  rules: RuleSetV1;
  templates: TemplateCatalogV1;
  processing: ProcessingConfigV1;
  diagnostics: { logLevel: "error" | "info" | "debug"; redactBodies: boolean };
}

export interface AttachmentDescriptor {
  name: string;
  url: string;
  type?: string;
  size?: number;
  expiresAtMs?: number;
}

export interface IncomingMessage {
  schemaVersion: 1;
  key: SourceKey;
  source: {
    connectionId: string;
    serverOrigin: string;
    topic: string;
    messageId: string;
    sequenceId?: string;
  };
  publishedAtMs: number;
  expiresAtMs?: number;
  receivedAtMs: number;
  title: string;
  body: string;
  priority: 1 | 2 | 3 | 4 | 5;
  tags: string[];
  clickUrl?: string;
  contentType?: string;
  firstUrl?: { raw: string; protocol: "http:" | "https:"; hostname: string };
  attachment?: AttachmentDescriptor;
  unknownFields: string[];
}

export interface RuleSetV1 {
  schemaVersion: 1;
  matchMode: "first";
  rules: RuleV1[];
}

export interface RuleV1 {
  id: string;
  revision: number;
  name: string;
  enabled: boolean;
  when: { all: ConditionV1[] };
  action: {
    notePathTemplate: string;
    contentTemplateId: string;
    attachmentPathTemplate?: string;
    insertion: "append" | "prepend" | "after-heading";
    heading?: string;
  };
}

export type ConditionV1 =
  | {
      field: "topic" | "title" | "body";
      op: "equals" | "contains" | "startsWith";
      value: string;
    }
  | { field: "tag"; op: "contains"; value: string }
  | { field: "priority"; op: "equals" | "gte"; value: number }
  | { field: "hasAttachment" | "hasHttpUrl"; op: "equals"; value: boolean }
  | { field: "attachmentMime"; op: "equals" | "startsWith"; value: string }
  | {
      field: "firstUrlHost";
      op: "hostEquals" | "hostOrSubdomainOf";
      value: string;
    };

export interface TemplateCatalogV1 {
  schemaVersion: 1;
  entries: Record<string, string>;
}

export interface EffectPlanV1 {
  schemaVersion: 1;
  sourceKey: SourceKey;
  ruleId: string;
  ruleRevision: number;
  notePath: string;
  marker: string;
  renderedBlock: string;
  insertion: { mode: "append" | "prepend" | "after-heading"; heading?: string };
  attachment?: {
    mode: "download" | "link-only" | "reject";
    sourceUrl: string;
    targetPath?: string;
    expectedMaxBytes: number;
  };
}

export interface EffectReceiptV1 {
  notePath: string;
  markerFound: boolean;
  alreadyApplied: boolean;
  attachmentPath?: string;
  attachmentBytes?: number;
  attachmentSha256?: string;
  committedAtMs: number;
}

export type InboxStatus =
  | "accepted"
  | "planned"
  | "applying"
  | "committed"
  | "complete"
  | "retry_wait"
  | "dead_letter"
  | "ignored";

export interface SafeErrorV1 {
  code: string;
  message: string;
  retryable: boolean;
  atMs: number;
}

export interface InboxRecordV1 {
  schemaVersion: 1;
  message: IncomingMessage;
  status: InboxStatus;
  attempts: number;
  nextAttemptAtMs?: number;
  plan?: EffectPlanV1;
  receipt?: EffectReceiptV1;
  resultStatus?: "none" | "pending" | "sent" | "failed";
  lastError?: SafeErrorV1;
  errorHistory: SafeErrorV1[];
  createdAtMs: number;
  updatedAtMs: number;
  lastSeenAtMs: number;
}

export interface OutboxRecordV1 {
  sourceKey: SourceKey;
  connectionId: string;
  payload: ResultPayloadV1;
  attempts: number;
  nextAttemptAtMs: number;
  status: "pending" | "sent" | "failed";
  lastError?: SafeErrorV1;
}

export interface ResultPayloadV1 {
  schema: "obsidian.ntfy-sync.result.v1";
  correlation: { topic: string; messageId: string };
  outcome: "succeeded" | "failed" | "ignored";
  processedAt: string;
  targetCount: number;
  targets?: string[];
  error?: { code: string; retryable: boolean; attempt: number };
}

export interface TopicStateV1 {
  replayWatermarkMs: number;
}

export interface DurableStatePayloadV1 {
  schemaVersion: 1;
  records: Record<SourceKey, InboxRecordV1>;
  outbox: Record<SourceKey, OutboxRecordV1>;
  topics: Record<string, TopicStateV1>;
  telemetry: {
    ignoredEvents: Record<string, number>;
    protocolErrors: number;
    duplicates: number;
  };
  updatedAtMs: number;
}

export interface DurableStateFileV1 {
  schemaVersion: 1;
  checksum: string;
  payload: DurableStatePayloadV1;
}

export interface TransportFault {
  code: string;
  message: string;
  retryable: boolean;
  status?: number;
  retryAfterMs?: number;
}

export type ConnectionStatus =
  | "disabled"
  | "monitor_only"
  | "connecting"
  | "connected"
  | "polling"
  | "backoff"
  | "auth_failed"
  | "stopped"
  | "error";

export interface ConnectionTelemetry {
  connectionId: string;
  status: ConnectionStatus;
  lastConnectedAtMs?: number;
  lastEventAtMs?: number;
  lastFault?: TransportFault;
  reconnectAttempts: number;
}
