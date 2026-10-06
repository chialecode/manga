import { z } from "zod";
import { SourceLocatorSchema } from "./location.ts";

/** Visual shell preference. Distinct from storage-location layout (`settings.setLayout`). */
export const ShellPanelSchema = z.object({
  visible: z.boolean(),
  width: z.number().int().min(160).max(480),
}).strict();

export const ShellModeLayoutSchema = z.object({
  focus: z.boolean(),
  left: ShellPanelSchema,
  right: ShellPanelSchema,
}).strict();

/** Reader backgrounds: white, book yellow, eye-care green, teal and dark. Only the reading column takes the color, never the app shell. */
export const READING_THEMES = ["white", "paper", "green", "teal", "night"] as const;
export const FONT_PRESETS = ["sans", "serif", "mono"] as const;
export const READING_PAGE_MODES = ["single", "double"] as const;
export const READING_PAGE_RATIOS = ["book", "free"] as const;

/**
 * A preset name or the family name of an installed font. The name goes into a CSS font stack, so it may not carry
 * quotes, backslashes, braces, semicolons or control characters.
 */
export const FontFamilySchema = z.string().min(1).max(64).regex(/^[^"'`\\;{}<>()\x00-\x1f]+$/, "a font family name has no quotes or markup");

/** Reader typography (READ-01 and the M2 reader): old saved values stay valid because every added field has a default. */
export const ReadingPreferenceSchema = z.object({
  measurePx: z.number().int().min(320).max(1200),
  fontSizePx: z.number().int().min(14).max(32),
  fontFamily: FontFamilySchema.default("sans"),
  lineHeight: z.number().min(1.2).max(2.4),
  /** Side padding of the reading column, independent of the measure. */
  marginPx: z.number().int().min(0).max(96).default(24),
  /** Space between paragraphs. */
  paragraphSpacingPx: z.number().int().min(0).max(40).default(0),
  theme: z.enum(READING_THEMES),
  pageMode: z.enum(READING_PAGE_MODES).default("single"),
  pageRatio: z.enum(READING_PAGE_RATIOS).default("book"),
}).strict();

export const ShellPreferenceSchema = z.object({
  version: z.literal(1),
  mode: z.enum(["enthusiast", "creator"]),
  spoilerGuard: z.boolean(),
  layouts: z.object({
    enthusiast: ShellModeLayoutSchema,
    creator: ShellModeLayoutSchema,
  }).strict(),
  reading: ReadingPreferenceSchema,
}).strict();

export type ShellPreference = z.infer<typeof ShellPreferenceSchema>;
export type WorkMode = ShellPreference["mode"];

export const NOTE_BLOCK_TYPES = ["paragraph", "heading", "list", "quote", "code", "plaintext"] as const;
export type NoteBlockType = (typeof NOTE_BLOCK_TYPES)[number];

export const NoteBlockSchema = z.object({
  id: z.string().min(1).max(256),
  type: z.string().min(1).max(64),
  text: z.string().max(200_000),
  level: z.number().int().min(1).max(3).optional(),
  ordered: z.boolean().optional(),
  anchorId: z.string().min(1).max(256).optional(),
  /** Unknown node payload from a newer editor build; preserved verbatim instead of being dropped. */
  attrs: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const NOTE_TAG_MAX = 32;

export const NoteDocumentSchema = z.object({
  schemaVersion: z.literal(2),
  blocks: z.array(NoteBlockSchema).min(1).max(500),
  tags: z.array(z.string().min(1).max(64)).max(NOTE_TAG_MAX).optional(),
}).strict();

export type NoteBlock = z.infer<typeof NoteBlockSchema>;
export type NoteDocument = z.infer<typeof NoteDocumentSchema>;

export const NoteSummarySchema = z.object({
  objectId: z.string().min(1),
  revision: z.number().int().positive(),
  title: z.string(),
  tags: z.array(z.string()),
  preview: z.string(),
  resourceId: z.string().nullable(),
  anchorId: z.string().nullable(),
  sourceStatus: z.enum(["unresolved", "linked", "missing_resource", "missing_revision"]).optional(),
  updatedAt: z.string(),
}).strict();

export type NoteSummary = z.infer<typeof NoteSummarySchema>;

export const NoteRevisionSchema = z.object({
  revision: z.number().int().positive(),
  createdAt: z.string(),
  blockCount: z.number().int().nonnegative(),
  preview: z.string(),
}).strict();

export type NoteRevision = z.infer<typeof NoteRevisionSchema>;

export const BookmarkSchema = z.object({
  id: z.string().min(1),
  resourceId: z.string().min(1),
  resourceRevisionId: z.string().min(1),
  label: z.string().max(160),
  locator: SourceLocatorSchema,
  createdAt: z.string(),
}).strict();

export type Bookmark = z.infer<typeof BookmarkSchema>;

export const ReadingStylePatchSchema = z.object({
  measurePx: z.number().int().min(320).max(1200).optional(),
  fontSizePx: z.number().int().min(14).max(32).optional(),
  fontFamily: FontFamilySchema.optional(),
  lineHeight: z.number().min(1.2).max(2.4).optional(),
  marginPx: z.number().int().min(0).max(96).optional(),
  paragraphSpacingPx: z.number().int().min(0).max(40).optional(),
  theme: z.enum(READING_THEMES).optional(),
  pageMode: z.enum(READING_PAGE_MODES).optional(),
  pageRatio: z.enum(READING_PAGE_RATIOS).optional(),
}).strict();

export type ReadingStylePatch = z.infer<typeof ReadingStylePatchSchema>;

export const DEFAULT_SHELL_PREFERENCE: ShellPreference = {
  version: 1,
  mode: "enthusiast",
  spoilerGuard: false,
  layouts: {
    enthusiast: { focus: false, left: { visible: true, width: 224 }, right: { visible: true, width: 360 } },
    creator: { focus: false, left: { visible: true, width: 224 }, right: { visible: true, width: 360 } },
  },
  reading: { measurePx: 680, fontSizePx: 18, fontFamily: "sans", lineHeight: 1.7, marginPx: 24, paragraphSpacingPx: 0, theme: "white", pageMode: "single", pageRatio: "book" },
};

/** Candidate parsers are reversible adapters. `accepted` stays false until a separate decision. */
export const PARSER_CANDIDATES = [
  {
    id: "candidate:text-nfc-lf-v1",
    format: "txt",
    license: "in-repo adapter, Apache-2.0",
    offline: true,
    sourceMap: "unicode code points after NFC/LF",
    replaceable: true,
    accepted: false,
  },
  {
    id: "candidate:epub-zip-html-v1",
    format: "epub",
    license: "in-repo ZIP/HTML adapter using Node zlib; no third-party parser package",
    offline: true,
    sourceMap: "spine part id plus code points of extracted text; author CSS is not applied",
    replaceable: true,
    accepted: false,
  },
  {
    id: "candidate:mobi-palmdoc-v1",
    format: "mobi",
    license: "in-repo PalmDOC/MOBI adapter, Apache-2.0",
    offline: true,
    sourceMap: "body plus page-N parts split on page breaks; recindex and kindle:embed image references; uncompressed and PalmDOC compression; encrypted MOBI rejected",
    replaceable: true,
    accepted: false,
  },
  {
    id: "pdfjs-dist@6.3.289",
    format: "pdf",
    license: "Apache-2.0",
    offline: true,
    sourceMap: "page-N from the PDF page tree; PDF.js text layer mapped to NFC/LF code points; scanned pages have no OCR",
    replaceable: true,
    accepted: true,
  },
] as const;
