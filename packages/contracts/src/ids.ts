import { randomUUID } from "node:crypto";

export type Brand<T, B extends string> = T & { readonly __brand: B };

export type WorkId = Brand<string, "WorkId">;
export type ResourceId = Brand<string, "ResourceId">;
export type ResourceRevisionId = Brand<string, "ResourceRevisionId">;
export type ContentObjectId = Brand<string, "ContentObjectId">;
export type AnchorId = Brand<string, "AnchorId">;
export type ReferenceId = Brand<string, "ReferenceId">;
export type JobId = Brand<string, "JobId">;
export type ScopeHandle = Brand<string, "ScopeHandle">;
export type RequestId = Brand<string, "RequestId">;

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export const PROTOCOL_VERSION = 1 as const;
export const COMMAND_VERSION = 1 as const;
