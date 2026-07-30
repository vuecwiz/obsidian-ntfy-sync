import type {
  ConnectionConfigV1,
  ConnectionTelemetry,
  IncomingMessage,
  TransportFault,
} from "../../domain/types";
import { fullJitterBackoff } from "../../shared/backoff";
import { SyncError } from "../../shared/errors";
import { authHeaders } from "./auth";
import { responseFault } from "./http";
import { canonicalServerOrigin, normalizeMessage } from "./normalizer";
import { NdjsonParser } from "./parser";
import type { ParsedNtfyEvent } from "./dto";

export const DEFAULT_STABLE_STREAM_MS = 120_000;

export interface ConnectionSink {
  accept(message: IncomingMessage): Promise<void>;
  ignored(event: string): Promise<void>;
  watermark(): number | undefined;
  fault(fault: TransportFault): void;
  statusChanged?(status: ConnectionTelemetry["status"]): void;
}

export class NtfyConnectionRunner {
  private controller?: AbortController;
  private stopRequested = false;
  private running?: Promise<void>;
  private usePollFallback = false;
  readonly telemetry: ConnectionTelemetry;

  constructor(
    private readonly config: ConnectionConfigV1,
    private readonly maxBodyBytes: number,
    private readonly overlapSeconds: number,
    private readonly sink: ConnectionSink,
    private readonly stableStreamMs = DEFAULT_STABLE_STREAM_MS,
  ) {
    this.telemetry = {
      connectionId: config.id,
      status: "stopped",
      reconnectAttempts: 0,
    };
  }

  start(parentSignal?: AbortSignal): void {
    if (this.running) return;
    this.stopRequested = false;
    this.controller = new AbortController();
    if (parentSignal) {
      if (parentSignal.aborted) this.controller.abort();
      else parentSignal.addEventListener("abort", () => this.controller?.abort(), { once: true });
    }
    this.running = this.run(this.controller.signal).finally(() => {
      this.running = undefined;
      this.setStatus("stopped");
    });
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.controller?.abort();
    await this.running;
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && !this.stopRequested) {
      try {
        if (this.config.mode === "poll" || this.usePollFallback) await this.runPoll(signal);
        else await this.runStream(signal);
        this.telemetry.reconnectAttempts = 0;
      } catch (error) {
        if (signal.aborted || this.stopRequested) break;
        const fault = normalizeFault(error);
        this.telemetry.lastFault = fault;
        this.sink.fault(fault);
        if (
          this.config.mode === "auto" &&
          !this.usePollFallback &&
          this.telemetry.reconnectAttempts >= 2 &&
          (fault.code === "NETWORK_ERROR" ||
            fault.code === "STREAM_CLOSED" ||
            fault.code === "STREAM_UNAVAILABLE")
        ) {
          this.usePollFallback = true;
        }
        if (fault.code === "AUTH_FAILED" || !fault.retryable) {
          this.setStatus(fault.code === "AUTH_FAILED" ? "auth_failed" : "error");
          return;
        }
        this.setStatus("backoff");
        const waitMs =
          fault.retryAfterMs ??
          fullJitterBackoff(
            this.telemetry.reconnectAttempts,
            this.config.reconnect.minMs,
            this.config.reconnect.maxMs,
          );
        this.telemetry.reconnectAttempts += 1;
        await abortableDelay(waitMs, signal);
      }
    }
  }

  private async runStream(signal: AbortSignal): Promise<void> {
    this.setStatus("connecting");
    const response = await fetch(this.subscriptionUrl(false), {
      headers: authHeaders(this.config.readAuth),
      signal,
    });
    if (!response.ok) throw await responseFault(response);
    if (!response.body) {
      if (this.config.mode === "auto") return this.runPoll(signal);
      throw new SyncError("STREAM_UNAVAILABLE", "Response body is not streamable", true);
    }
    this.setStatus("connected");
    const connectedAtMs = Date.now();
    this.telemetry.lastConnectedAtMs = connectedAtMs;
    const stableTimer = setTimeout(() => {
      this.markStreamStable();
    }, this.stableStreamMs);
    const parser = new NdjsonParser();
    const reader = response.body.getReader();
    try {
      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) await this.dispatch(parser.push(value));
      }
      await this.dispatch(parser.finish());
    } finally {
      clearTimeout(stableTimer);
      if (Date.now() - connectedAtMs >= this.stableStreamMs) {
        this.markStreamStable();
      }
      reader.releaseLock();
    }
    if (!signal.aborted) throw new SyncError("STREAM_CLOSED", "ntfy stream closed", true);
  }

  private async runPoll(signal: AbortSignal): Promise<void> {
    this.setStatus("polling");
    while (!signal.aborted) {
      const response = await fetch(this.subscriptionUrl(true), {
        headers: authHeaders(this.config.readAuth),
        signal,
      });
      if (!response.ok) throw await responseFault(response);
      const parser = new NdjsonParser();
      await this.dispatch(parser.push(new TextEncoder().encode(await response.text())));
      await this.dispatch(parser.finish());
      await abortableDelay(this.config.pollIntervalSeconds * 1000, signal);
    }
  }

  private subscriptionUrl(poll: boolean): string {
    const origin = canonicalServerOrigin(this.config.baseUrl, this.config.allowInsecureHttp);
    const topics = this.config.topics.map(encodeURIComponent).join(",");
    const url = new URL(`${origin}/${topics}/json`);
    url.searchParams.set("since", this.sinceValue());
    if (poll) url.searchParams.set("poll", "1");
    return url.toString();
  }

  private sinceValue(): string {
    const watermark = this.sink.watermark();
    if (watermark) {
      return String(Math.max(0, Math.floor(watermark / 1000) - this.overlapSeconds));
    }
    if (this.config.initialReplay.kind === "all") return "all";
    if (this.config.initialReplay.kind === "duration") {
      return `${this.config.initialReplay.valueSeconds ?? 3600}s`;
    }
    return "latest";
  }

  private async dispatch(events: ParsedNtfyEvent[]): Promise<void> {
    for (const event of events) {
      this.telemetry.lastEventAtMs = Date.now();
      if (event.kind === "message") {
        const origin = canonicalServerOrigin(this.config.baseUrl, this.config.allowInsecureHttp);
        await this.sink.accept(
          normalizeMessage(event.dto, this.config.id, origin, Date.now(), this.maxBodyBytes),
        );
      } else {
        await this.sink.ignored(event.kind === "unknown" ? `unknown:${event.event}` : event.kind);
      }
    }
  }

  private setStatus(status: ConnectionTelemetry["status"]): void {
    if (this.telemetry.status === status) return;
    this.telemetry.status = status;
    this.sink.statusChanged?.(status);
  }

  private markStreamStable(): void {
    if (this.telemetry.reconnectAttempts === 0) return;
    this.telemetry.reconnectAttempts = 0;
    this.sink.statusChanged?.(this.telemetry.status);
  }
}

function normalizeFault(error: unknown): TransportFault {
  if (error && typeof error === "object" && "code" in error && "retryable" in error) {
    return error as TransportFault;
  }
  if (error instanceof SyncError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  return {
    code: "NETWORK_ERROR",
    message: error instanceof Error ? error.message : "Network error",
    retryable: true,
  };
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds <= 0 || signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
