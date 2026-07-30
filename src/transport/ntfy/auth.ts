import type { AuthConfig } from "../../domain/types";

export function authorizationHeader(auth: AuthConfig): string | undefined {
  if (auth.kind === "basic") {
    return `Basic ${Buffer.from(`${auth.username}:${auth.password}`, "utf8").toString("base64")}`;
  }
  if (auth.kind === "bearer") return `Bearer ${auth.token}`;
  return undefined;
}

export function authHeaders(auth: AuthConfig): Headers {
  const headers = new Headers({ Accept: "application/x-ndjson, application/json" });
  const value = authorizationHeader(auth);
  if (value) headers.set("Authorization", value);
  return headers;
}
