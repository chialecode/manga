import { createHash } from "node:crypto";

export type DandanCredentials = { appId: string; secret: string };

/**
 * The signature of one request to the DanDanPlay open API (v2): `base64(sha256(AppId + Timestamp + Path + AppSecret))`.
 * `path` is the part of the address after the host without the query string; the service wants it in lower case.
 * The secret is never sent: only the digest is.
 */
export function dandanSignature(credentials: DandanCredentials, timestamp: number, path: string): string {
  return createHash("sha256").update(`${credentials.appId}${timestamp}${path.toLowerCase()}${credentials.secret}`).digest("base64");
}

/** The headers a signed request carries. `timestamp` is in whole seconds, UTC. */
export function dandanHeaders(credentials: DandanCredentials, timestamp: number, path: string): Record<string, string> {
  return {
    "X-AppId": credentials.appId,
    "X-Timestamp": String(timestamp),
    "X-Signature": dandanSignature(credentials, timestamp, path),
  };
}
