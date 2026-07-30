import { fullJitterBackoff, retryDelayMs } from "../../src/shared/backoff";
import { redactObject, redactText } from "../../src/shared/redact";

describe("backoff and redaction", () => {
  it("uses bounded retry schedules", () => {
    expect(retryDelayMs(1)).toBe(5_000);
    expect(retryDelayMs(5)).toBe(3_600_000);
    expect(retryDelayMs(99)).toBe(6 * 60 * 60 * 1000);
    expect(fullJitterBackoff(4, 1_000, 60_000, () => 0.5)).toBe(8_000);
  });

  it("redacts auth, URL queries and secret object fields", () => {
    expect(redactText("Authorization: Bearer abc.def")).not.toContain("abc.def");
    expect(redactText("https://example.com/path?token=secret")).not.toContain("secret");
    const redacted = redactObject({ token: "value", nested: { password: "value" } });
    expect(JSON.stringify(redacted)).not.toContain("value");
  });
});
