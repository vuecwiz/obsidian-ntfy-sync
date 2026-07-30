import { randomUUID } from "node:crypto";
import type { PersistedSettingsV1, RuleSetV1, TemplateCatalogV1 } from "../domain/types";

export const DEFAULT_TEMPLATES: TemplateCatalogV1 = {
  schemaVersion: 1,
  entries: {
    inbox: "{{content}}",
  },
};

export const DEFAULT_RULES: RuleSetV1 = {
  schemaVersion: 1,
  matchMode: "first",
  rules: [
    {
      id: "inbox",
      revision: 1,
      name: "Inbox",
      enabled: true,
      when: { all: [] },
      action: {
        notePathTemplate: "Ntfy Sync/Inbox.md",
        contentTemplateId: "inbox",
        attachmentPathTemplate: "Ntfy Sync/Attachments/{{attachment:name}}-{{messageId}}",
        insertion: "append",
      },
    },
  ],
};

export function createDefaultSettings(): PersistedSettingsV1 {
  const deviceId = randomUUID();
  return {
    schemaVersion: 1,
    uiLanguage: "auto",
    enabled: false,
    device: { deviceId, writerDeviceId: deviceId },
    connections: [],
    rules: structuredClone(DEFAULT_RULES),
    templates: structuredClone(DEFAULT_TEMPLATES),
    processing: {
      overlapSeconds: 120,
      maxBodyBytes: 64 * 1024,
      maxAttachmentBytes: 15 * 1024 * 1024,
      maxAttempts: 8,
      concurrency: 2,
      completedRetentionDays: 7,
      completedRetentionCount: 10_000,
      downloadSameOriginAttachments: true,
    },
    diagnostics: { logLevel: "info", redactBodies: true },
  };
}
