import { copyFile, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DurableStateFileV1, DurableStatePayloadV1 } from "../domain/types";
import { sha256Hex } from "../shared/crypto";
import { SyncError } from "../shared/errors";

export function emptyState(now = Date.now()): DurableStatePayloadV1 {
  return {
    schemaVersion: 1,
    records: {},
    outbox: {},
    topics: {},
    telemetry: { ignoredEvents: {}, protocolErrors: 0, duplicates: 0 },
    updatedAtMs: now,
  };
}

export function stateChecksum(payload: DurableStatePayloadV1): string {
  return sha256Hex(JSON.stringify(payload));
}

export function encodeState(payload: DurableStatePayloadV1): string {
  const file: DurableStateFileV1 = {
    schemaVersion: 1,
    checksum: stateChecksum(payload),
    payload,
  };
  return JSON.stringify(file, null, 2);
}

export function decodeState(raw: string): DurableStatePayloadV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SyncError("STATE_IO", "State file is not valid JSON", false);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SyncError("STATE_IO", "State file is not an object", false);
  }
  const file = parsed as Partial<DurableStateFileV1>;
  if (file.schemaVersion !== 1 || !file.payload || typeof file.checksum !== "string") {
    throw new SyncError("STATE_IO", "Unsupported state schema", false);
  }
  if (file.payload.schemaVersion !== 1 || stateChecksum(file.payload) !== file.checksum) {
    throw new SyncError("STATE_IO", "State checksum mismatch", false);
  }
  return file.payload;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export class JsonStateStore {
  readonly primaryPath: string;
  readonly backupPath: string;
  private payload: DurableStatePayloadV1 = emptyState();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(pluginDirectory: string) {
    this.primaryPath = join(pluginDirectory, "state-v1.json");
    this.backupPath = join(pluginDirectory, "state-v1.backup.json");
  }

  async load(): Promise<DurableStatePayloadV1> {
    await mkdir(dirname(this.primaryPath), { recursive: true });
    if (!(await exists(this.primaryPath))) {
      this.payload = emptyState();
      await this.persistNow();
      return this.payload;
    }
    try {
      this.payload = decodeState(await readFile(this.primaryPath, "utf8"));
      return this.payload;
    } catch (primaryError) {
      const corruptPath = `${this.primaryPath}.corrupt-${Date.now()}`;
      await rename(this.primaryPath, corruptPath);
      if (await exists(this.backupPath)) {
        try {
          this.payload = decodeState(await readFile(this.backupPath, "utf8"));
          await this.persistNow();
          return this.payload;
        } catch {
          // The primary error is more actionable and must not be hidden.
        }
      }
      throw primaryError;
    }
  }

  snapshot(): DurableStatePayloadV1 {
    return structuredClone(this.payload);
  }

  async mutate(mutator: (payload: DurableStatePayloadV1) => void): Promise<void> {
    const operation = this.writeQueue.then(async () => {
      mutator(this.payload);
      this.payload.updatedAtMs = Date.now();
      await this.persistNow();
    });
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private async persistNow(): Promise<void> {
    const temporaryPath = `${this.primaryPath}.tmp-${process.pid}-${Date.now()}`;
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(encodeState(this.payload), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      if (await exists(this.primaryPath)) {
        await copyFile(this.primaryPath, this.backupPath);
      }
      await rename(temporaryPath, this.primaryPath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw new SyncError(
        "STATE_IO",
        error instanceof Error ? error.message : "Unable to persist state",
        true,
      );
    }
  }
}
