import { sha256Hex } from "../shared/crypto";
import { SyncError } from "../shared/errors";
import type { AuthConfig } from "../domain/types";
import { authorizationHeader } from "../transport/ntfy/auth";
import type { VaultPort } from "./vault-port";

export interface AttachmentReceipt {
  path: string;
  bytes: number;
  sha256: string;
}

export class AttachmentService {
  constructor(private readonly vault: VaultPort) {}

  async downloadSameOrigin(
    sourceUrl: string,
    serverOrigin: string,
    targetPath: string,
    maxBytes: number,
    auth: AuthConfig,
    signal?: AbortSignal,
  ): Promise<AttachmentReceipt> {
    let current = new URL(sourceUrl);
    if (current.origin !== serverOrigin) {
      throw new SyncError("ATTACHMENT_POLICY", "External attachment is link-only", false);
    }
    let response: Response | undefined;
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      const headers = new Headers();
      const authorization = authorizationHeader(auth);
      if (authorization && current.origin === serverOrigin) {
        headers.set("Authorization", authorization);
      }
      // requestUrl cannot enforce manual redirects, stream byte limits, or AbortSignal cleanup.
      response = await window.fetch(current, { headers, redirect: "manual", signal });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new SyncError("ATTACHMENT_POLICY", "Redirect has no location", false);
        const next = new URL(location, current);
        if (next.origin !== serverOrigin) {
          throw new SyncError("ATTACHMENT_POLICY", "Cross-origin redirect blocked", false);
        }
        current = next;
        continue;
      }
      break;
    }
    if (!response || (response.status >= 300 && response.status < 400)) {
      throw new SyncError("ATTACHMENT_POLICY", "Too many attachment redirects", false);
    }
    if (response.status === 401 || response.status === 403) {
      throw new SyncError("AUTH_FAILED", "Attachment authorization failed", false);
    }
    if (response.status === 404 || response.status === 410) {
      throw new SyncError("ATTACHMENT_EXPIRED", "Attachment is unavailable", false);
    }
    if (!response.ok || !response.body) {
      throw new SyncError("UNKNOWN_RETRYABLE", `Attachment HTTP ${response.status}`, true);
    }
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > maxBytes) {
      throw new SyncError("ATTACHMENT_TOO_LARGE", "Attachment exceeds configured limit", false);
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = response.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new SyncError("ATTACHMENT_TOO_LARGE", "Attachment exceeded configured limit", false);
      }
      chunks.push(value);
    }
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const temporaryPath = `.ntfy-sync-staging/${sha256Hex(targetPath).slice(0, 24)}.part`;
    await this.vault.writeBinary(temporaryPath, combined.buffer);
    try {
      if (await this.vault.exists(targetPath)) {
        const existing = await this.vault.readBinary(targetPath);
        if (existing && sha256Hex(new Uint8Array(existing)) === sha256Hex(combined)) {
          return { path: targetPath, bytes: total, sha256: sha256Hex(combined) };
        }
        throw new SyncError("VAULT_CONFLICT", "Attachment target already exists", false);
      }
      await this.vault.rename(temporaryPath, targetPath);
    } finally {
      await this.vault.remove(temporaryPath);
    }
    return { path: targetPath, bytes: total, sha256: sha256Hex(combined) };
  }
}
