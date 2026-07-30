import type { ConnectionStatus, ConnectionTelemetry } from "../../src/domain/types";
import { buildNtfyStatusView, deriveNtfyStatusState } from "../../src/status/model";
import { createI18n } from "../../src/i18n";

function connection(
  status: ConnectionStatus,
  overrides: Partial<ConnectionTelemetry> = {},
): ConnectionTelemetry {
  return { connectionId: "primary", status, reconnectAttempts: 0, ...overrides };
}

function context(statuses: ConnectionStatus[] = []) {
  return {
    enabled: true,
    writer: true,
    connections: statuses.map((status) => connection(status)),
    topicCount: 1,
  };
}

describe("Ntfy Sync status indicator model", () => {
  it.each([
    [{ ...context(), enabled: false }, "off", "ntfy-status-off"],
    [{ ...context(), writer: false }, "monitor_only", "ntfy-status-monitor"],
    [context(), "idle", "ntfy-status-idle"],
    [context(["connecting"]), "connecting", "ntfy-status-connecting"],
    [context(["connected"]), "connected", "ntfy-status-connected"],
    [context(["polling"]), "polling", "ntfy-status-polling"],
    [context(["backoff"]), "backoff", "ntfy-status-backoff"],
    [context(["auth_failed"]), "error", "ntfy-status-error"],
  ] as const)("maps runtime context to %s", (input, state, icon) => {
    expect(deriveNtfyStatusState(input)).toBe(state);
    expect(buildNtfyStatusView(input)).toMatchObject({ state, icon });
  });

  it("uses the highest-action connection state for mixed connections", () => {
    expect(deriveNtfyStatusState(context(["connected", "polling"]))).toBe("polling");
    expect(deriveNtfyStatusState(context(["connected", "connecting"]))).toBe("connecting");
    expect(deriveNtfyStatusState(context(["connected", "backoff"]))).toBe("backoff");
    expect(deriveNtfyStatusState(context(["connected", "error"]))).toBe("error");
  });

  it("builds a detailed redacted tooltip with relative activity and queue counts", () => {
    const view = buildNtfyStatusView({
      ...context(["connected"]),
      runtimeError: "primary: NETWORK_ERROR https://private.invalid/secret",
      nowMs: 100_000,
      connections: [
        connection("connected", {
          lastConnectedAtMs: 99_000,
          lastEventAtMs: 40_000,
          reconnectAttempts: 2,
          lastFault: {
            code: "NETWORK_ERROR",
            message: "private endpoint",
            retryable: true,
          },
        }),
      ],
      inbox: { total: 7, pending: 2, deadLetters: 1, outboxPending: 3 },
    });

    expect(view.tooltip).toContain("Ntfy Sync — Connected");
    expect(view.tooltip).toContain("Last connected: just now");
    expect(view.tooltip).toContain("Last message: 1m ago");
    expect(view.tooltip).toContain("Reconnect attempts: 2");
    expect(view.tooltip).toContain("Last fault: NETWORK_ERROR");
    expect(view.tooltip).toContain("Inbox: 7 total · 2 pending · 1 dead letter");
    expect(view.tooltip).toContain("Result outbox: 3 pending");
    expect(view.tooltip).not.toContain("private.invalid");
    expect(view.tooltip).not.toContain("private endpoint");
  });

  it("shows a safe diagnostic hint for initialization and configuration failures", () => {
    expect(
      buildNtfyStatusView({
        ...context(),
        runtimeError: "/Users/private/vault failed",
      }).tooltip,
    ).toContain("Error: See redacted diagnostics");
    expect(
      buildNtfyStatusView({
        ...context(),
        runtimeError: "connections[0].baseUrl: invalid",
      }).tooltip,
    ).toContain("Error: connections[0].baseUrl (see diagnostics)");
  });

  it("builds the same status model with a Simplified Chinese presentation", () => {
    const view = buildNtfyStatusView(
      {
        ...context(["connected"]),
        nowMs: 100_000,
        connections: [connection("connected", { lastConnectedAtMs: 99_000 })],
        inbox: { total: 2, pending: 1, deadLetters: 0, outboxPending: 0 },
      },
      createI18n("zh-CN", "en"),
    );
    expect(view.label).toBe("已连接");
    expect(view.tooltip).toContain("Ntfy Sync — 已连接");
    expect(view.tooltip).toContain("写入设备: 本设备");
    expect(view.tooltip).toContain("收件箱: 2 总计 · 1 待处理 · 0 死信");
  });
});
