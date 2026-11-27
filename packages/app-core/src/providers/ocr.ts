import fs from "node:fs";
import path from "node:path";
import { MangaError, type CommandEnvelope, type OcrPurpose, type OcrResult } from "@manga/contracts";
import { ocrDeepSeekDocument } from "@manga/model-protocol";
import type { MangaProductApp } from "../product-app.ts";
import type { ConnectionRow } from "../product-helpers.ts";
import { resolveLocation } from "../library-locations.ts";
import { connectionAccess, providerAbortReason } from "./access.ts";
import { recordServiceUse } from "./usage.ts";

export type OcrHost = Pick<
  MangaProductApp,
  "comics" | "grantOf" | "grants" | "providers" | "requireModule" | "resolvePathFor" | "store" | "vault"
>;

const OCR_MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function mimeOfFile(filename: string): string {
  return OCR_MIME_BY_EXT[path.extname(filename).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Recognizes text or rich layout from a picked file handle or an authorized library resource / comic page
 * via a configured OCR provider service (`deepseek-ocr@1`), enforcing the provider access gate and recording usage.
 */
export async function recognizeOcrDocument(
  app: OcrHost,
  envelope: CommandEnvelope,
  signal: AbortSignal,
): Promise<OcrResult> {
  const grant = app.grantOf(envelope);
  const input = envelope.input as {
    pathHandle?: string;
    resourceId?: string;
    resourceRevisionId?: string;
    pageId?: string;
    purpose?: OcrPurpose;
    connectionId?: string;
  };
  const purpose: OcrPurpose = input.purpose ?? "text_recognition";

  const row = (input.connectionId
    ? app.store.sqlite.prepare("SELECT * FROM provider_connections WHERE id = ? AND purpose = 'ocr'").get(input.connectionId)
    : app.store.sqlite.prepare("SELECT * FROM provider_connections WHERE purpose = 'ocr' ORDER BY created_at, rowid LIMIT 1").get()) as ConnectionRow | undefined;
  if (!row) {
    throw new MangaError("MODEL_CAPABILITY_MISSING", "没有配置文档识别 (OCR) 服务：在“设置 › 模型”里从 DeepSeek 加入“文档识别 (OCR)”", {
      details: { reason: "no_ocr_service" },
    });
  }

  let filename: string;
  let mimeType: string;
  let data: Uint8Array;

  if (input.pathHandle) {
    const filePath = app.resolvePathFor(input.pathHandle, ["file", "import"]);
    if (!fs.existsSync(filePath)) throw new MangaError("NOT_FOUND", "OCR file is missing");
    data = fs.readFileSync(filePath);
    filename = path.basename(filePath);
    mimeType = mimeOfFile(filename);
  } else if (input.resourceId) {
    if (!app.grants.canRead(grant, input.resourceId)) {
      throw new MangaError("SCOPE_DENIED", "resource is outside the authorized set");
    }
    const revisionId = input.resourceRevisionId ?? (app.store.sqlite.prepare(
      "SELECT id FROM resource_revisions WHERE resource_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
    ).get(input.resourceId) as { id: string } | undefined)?.id;
    if (!revisionId) throw new MangaError("NOT_FOUND", "resource revision missing");

    if (input.pageId) {
      app.requireModule("comic.pages", "comic reading");
      const rendered = await app.comics.pageImage({
        resourceId: input.resourceId,
        revisionId,
        pageId: input.pageId,
        maxEdge: 2048,
        format: "png",
        signal,
      });
      data = rendered.bytes;
      filename = `${input.pageId}.png`;
      mimeType = "image/png";
    } else {
      const loc = resolveLocation(app.store, revisionId);
      if (!loc?.path || !fs.existsSync(loc.path)) {
        throw new MangaError("NOT_FOUND", "resource file is not available locally");
      }
      data = fs.readFileSync(loc.path);
      filename = path.basename(loc.path);
      mimeType = mimeOfFile(filename);
    }
  } else {
    throw new MangaError("VALIDATION_ERROR", "provide either a path handle or a library resource");
  }

  const access = await connectionAccess(app, row, signal);
  try {
    if (!access.apiKey) throw new MangaError("AUTHENTICATION_FAILED", "the OCR connection has no key");
    const result = await ocrDeepSeekDocument({
      baseUrl: row.base_url,
      apiKey: access.apiKey,
      filename,
      mimeType,
      data,
      purpose,
      signal: access.signal ?? signal,
      timeoutMs: row.timeout_ms,
    });
    const pages = result.usage?.pages ?? result.pages.length;
    recordServiceUse(app, {
      connectionId: row.id,
      service: "ocr",
      task: "ocr",
      unit: "page",
      quantity: pages,
      status: "ok",
    });
    return result;
  } catch (error) {
    const pluginOff = providerAbortReason(access.signal);
    if (pluginOff || !signal.aborted) {
      const cause = pluginOff ?? error;
      recordServiceUse(app, {
        connectionId: row.id,
        service: "ocr",
        task: "ocr",
        unit: "page",
        quantity: 0,
        status: "error",
        errorCode: cause instanceof MangaError ? cause.code : "UNKNOWN",
      });
    }
    throw pluginOff ?? error;
  } finally {
    access.release();
  }
}
