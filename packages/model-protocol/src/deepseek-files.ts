import { MangaError, type FileUploadPurpose, type ProviderFileRef } from "@manga/contracts";
import {
  createRequestSignal,
  joinApiPath,
  mapHttpError,
  networkError,
  parseJsonAnswer,
  protocolError,
  requireMachineAnswer,
} from "./http.ts";
import type { DeepSeekFileDeleteOptions, DeepSeekFileUploadOptions } from "./types.ts";

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif"]);
const RICH_LAYOUT_EXTS = new Set([".pdf", ".doc", ".docx", ".ppt", ".pptx"]);
const RICH_LAYOUT_MIMES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

/** Maximum file upload sizes enforced by DeepSeek Files API (64 MiB rich layout, 32 MiB text/user_data). */
export const DEEPSEEK_FILE_LIMITS = {
  richLayoutBytes: 64 * 1024 * 1024,
  userDataBytes: 32 * 1024 * 1024,
} as const;

function fileExt(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot).toLowerCase() : "";
}

/**
 * Infers the DeepSeek `/v1/files` multipart `purpose` field from filename and MIME type:
 * - Images omit `purpose` (`undefined`).
 * - PDF / Word / PowerPoint use `rich_layout_recognition`.
 * - Text, code, spreadsheets, and ebooks use `user_data`.
 */
export function inferDeepSeekFilePurpose(filename: string, mimeType?: string): FileUploadPurpose | undefined {
  const mime = (mimeType ?? "").toLowerCase().trim();
  const ext = fileExt(filename);
  if (mime.startsWith("image/") || IMAGE_EXTS.has(ext)) return undefined;
  if (RICH_LAYOUT_MIMES.has(mime) || RICH_LAYOUT_EXTS.has(ext)) return "rich_layout_recognition";
  return "user_data";
}

function toTimestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return new Date(value > 1e12 ? value : value * 1000).toISOString();
  }
  if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

/**
 * Uploads a document, text file, or image to DeepSeek's Files API (`POST /v1/files`).
 * Multipart field order places `purpose` strictly before `file` as required by the service.
 */
export async function uploadDeepSeekFile(options: DeepSeekFileUploadOptions): Promise<ProviderFileRef> {
  if (options.signal?.aborted) throw new MangaError("CANCELLED", "request cancelled", { retryable: true, details: { errorCode: "cancelled" } });
  const filename = options.filename.trim();
  if (!filename) throw new MangaError("VALIDATION_ERROR", "filename is required", { details: { errorCode: "file_invalid" } });
  if (!options.data.byteLength) throw new MangaError("VALIDATION_ERROR", "file is empty", { details: { errorCode: "file_invalid" } });

  const resolvedPurpose = options.purpose === null ? undefined : (options.purpose ?? inferDeepSeekFilePurpose(filename, options.mimeType));
  const maxBytes = resolvedPurpose === "user_data" ? DEEPSEEK_FILE_LIMITS.userDataBytes : DEEPSEEK_FILE_LIMITS.richLayoutBytes;
  if (options.data.byteLength > maxBytes) {
    throw new MangaError("VALIDATION_ERROR", "file exceeds the provider upload size limit", {
      details: { kind: "file_invalid", errorCode: "file_invalid", bytes: options.data.byteLength, maxBytes },
    });
  }

  const form = new FormData();
  // DeepSeek requires `purpose` to appear before `file` in multipart uploads (omitted for images).
  if (resolvedPurpose) form.append("purpose", resolvedPurpose);
  const copy = new Uint8Array(options.data.byteLength);
  copy.set(options.data);
  form.append("file", new Blob([copy], { type: options.mimeType ?? "application/octet-stream" }), filename);

  const req = createRequestSignal(options.timeoutMs ?? 120_000, options.signal);
  try {
    const response = await (options.fetchImpl ?? fetch)(joinApiPath(options.baseUrl, "/v1/files"), {
      method: "POST",
      headers: { authorization: `Bearer ${options.apiKey}` },
      body: form,
      redirect: "error",
      signal: req.signal,
    }).catch((error) => { throw networkError(error, options.signal); });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw mapHttpError(response.status, body);
    }
    try {
      requireMachineAnswer(response);
    } catch (error) {
      void response.body?.cancel().catch(() => undefined);
      throw error;
    }
    const raw = await response.text().catch((error) => {
      if (req.isTimedOut()) throw networkError(new DOMException("request timed out", "TimeoutError"), options.signal);
      throw networkError(error, options.signal);
    });
    const json = parseJsonAnswer<{
      id?: unknown;
      filename?: unknown;
      bytes?: unknown;
      size_bytes?: unknown;
      purpose?: unknown;
      mime_type?: unknown;
      created_at?: unknown;
    }>(raw, "JSON");

    if (typeof json.id !== "string" || !json.id.trim()) throw protocolError("no file id");
    const size = typeof json.bytes === "number" ? json.bytes : typeof json.size_bytes === "number" ? json.size_bytes : options.data.byteLength;
    const purpose = json.purpose === "user_data" || json.purpose === "text_recognition" || json.purpose === "rich_layout_recognition"
      ? json.purpose
      : resolvedPurpose;
    const createdAt = toTimestamp(json.created_at);
    const mimeType = typeof json.mime_type === "string" && json.mime_type ? json.mime_type : options.mimeType;

    return {
      fileId: json.id,
      filename: typeof json.filename === "string" && json.filename.trim() ? json.filename.trim() : filename,
      bytes: size,
      ...(purpose ? { purpose } : {}),
      ...(mimeType ? { mimeType } : {}),
      ...(createdAt ? { createdAt } : {}),
    };
  } finally {
    req.clear();
  }
}

/** Deletes a previously uploaded file from DeepSeek's Files API (`DELETE /v1/files/{fileId}`). */
export async function deleteDeepSeekFile(options: DeepSeekFileDeleteOptions): Promise<{ deleted: boolean; fileId: string }> {
  if (options.signal?.aborted) throw new MangaError("CANCELLED", "request cancelled", { retryable: true, details: { errorCode: "cancelled" } });
  const fileId = options.fileId.trim();
  if (!fileId) throw new MangaError("VALIDATION_ERROR", "fileId is required", { details: { errorCode: "file_invalid" } });

  const req = createRequestSignal(options.timeoutMs ?? 30_000, options.signal);
  try {
    const response = await (options.fetchImpl ?? fetch)(joinApiPath(options.baseUrl, `/v1/files/${encodeURIComponent(fileId)}`), {
      method: "DELETE",
      headers: { authorization: `Bearer ${options.apiKey}` },
      redirect: "error",
      signal: req.signal,
    }).catch((error) => { throw networkError(error, options.signal); });

    if (response.status === 404) {
      void response.body?.cancel().catch(() => undefined);
      return { deleted: false, fileId };
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw mapHttpError(response.status, body);
    }
    void response.body?.cancel().catch(() => undefined);
    return { deleted: true, fileId };
  } finally {
    req.clear();
  }
}
