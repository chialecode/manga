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

export function asWorkId(id: string): WorkId {
  return id as WorkId;
}
export function asResourceId(id: string): ResourceId {
  return id as ResourceId;
}
export function asRevisionId(id: string): ResourceRevisionId {
  return id as ResourceRevisionId;
}
export function asObjectId(id: string): ContentObjectId {
  return id as ContentObjectId;
}

export const PROTOCOL_VERSION = 1 as const;
export const SCHEMA_VERSION = 1 as const;
export const KERNEL_API_VERSION = "0.1.0";
export const COMMAND_VERSION = 1 as const;
