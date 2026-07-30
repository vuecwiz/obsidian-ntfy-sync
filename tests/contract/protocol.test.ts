import { authorizationHeader } from "../../src/transport/ntfy/auth";
import { responseFault } from "../../src/transport/ntfy/http";

describe("ntfy HTTP contract", () => {
  it("builds Basic and Bearer auth without query credentials", () => {
    expect(authorizationHeader({ kind: "basic", username: "u", password: "p" })).toBe("Basic dTpw");
    expect(authorizationHeader({ kind: "bearer", token: "value" })).toBe("Bearer value");
    expect(authorizationHeader({ kind: "none" })).toBeUndefined();
  });

  it.each([
    [401, "AUTH_FAILED", false],
    [403, "AUTH_FAILED", false],
    [429, "RATE_LIMITED", true],
    [500, "SERVER_ERROR", true],
    [404, "HTTP_PERMANENT", false],
  ])("classifies HTTP %i", async (status, code, retryable) => {
    const fault = await responseFault(
      new Response("", { status, headers: status === 429 ? { "retry-after": "3" } : {} }),
    );
    expect(fault).toMatchObject({ code, retryable, status });
    if (status === 429) expect(fault.retryAfterMs).toBe(3000);
  });
});
