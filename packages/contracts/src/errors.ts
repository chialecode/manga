import { z } from "zod";

export const ERROR_CODES = [
  "VALIDATION_ERROR",
  "FORBIDDEN",
  "CAPABILITY_UNAVAILABLE",
  "REVISION_CONFLICT",
  "RESOURCE_UNRESOLVED",
  "UNSUPPORTED_FORMAT",
  "MODEL_CAPABILITY_MISSING",
  "AUTHENTICATION_FAILED",
  "PROVIDER_UNAVAILABLE",
  "RATE_LIMITED",
  "BUDGET_EXCEEDED",
  "CANCELLED",
  "EPOCH_MISMATCH",
  "HOST_CONFLICT",
  "SCOPE_DENIED",
  "NOT_FOUND",
  "IDEMPOTENT_REPLAY",
  "DEPENDENCY_UNSATISFIED",
  "BUNDLE_CONFLICT",
  "ACTIVATION_FAILED",
  "API_INCOMPATIBLE",
  "RESTART_REQUIRED",
  "PATH_ESCAPE",
  "QUOTA_EXCEEDED",
  "ETAG_CHANGED",
  "DISK_FULL",
  "PUBLISH_CONFLICT",
  "NEEDS_REVIEW",
  "INTERRUPTED",
  "LOCATION_UNAVAILABLE",
  "CREDENTIAL_UNAVAILABLE",
  "GRANT_REVOKED",
  "PROPOSAL_DECIDED",
  "PROPOSAL_STALE",
  "PROPOSAL_LIMIT",
  "UPDATE_VERIFY_FAILED",
  "UPDATE_UNAVAILABLE",
] as const;

export const ErrorCodeSchema = z.enum(ERROR_CODES);

export type ErrorCode = (typeof ERROR_CODES)[number];

export const UPDATE_ERROR_MESSAGES = {
  UPDATE_VERIFY_FAILED: "更新包校验失败，已保留当前版本",
  UPDATE_UNAVAILABLE: "开发版由本机构建自动更新，不检查联网更新",
  UPDATE_OFFLINE: "无法连接更新源，请检查网络后重试",
} as const;

export class MangaError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, options: {
    retryable?: boolean;
    details?: Record<string, unknown>;
    cause?: unknown;
  } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "MangaError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? {};
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      details: this.details,
    };
  }
}

export function isMangaError(value: unknown): value is MangaError {
  return value instanceof MangaError;
}
