import { z } from "zod";

export const TextRangeSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
}).refine((range) => range.end >= range.start, { message: "text range must be half-open" });

export const TextLocatorSchema = z.object({
  kind: z.literal("text"),
  partId: z.string().min(1),
  representationId: z.string().min(1),
  normalizationVersion: z.string().min(1),
  range: TextRangeSchema,
  quote: z.object({
    exact: z.string(),
    prefix: z.string().optional(),
    suffix: z.string().optional(),
  }).optional(),
  sourceCfi: z.string().optional(),
});

export const ImageLocatorSchema = z.object({
  kind: z.literal("image"),
  pageId: z.string().min(1),
  region: z.object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  }).optional(),
});

export const TemporalLocatorSchema = z.object({
  kind: z.literal("temporal"),
  startMs: z.number().nonnegative(),
  endMs: z.number().nonnegative().optional(),
  trackId: z.string().optional(),
});

export const SourceLocatorSchema = z.discriminatedUnion("kind", [
  TextLocatorSchema,
  ImageLocatorSchema,
  TemporalLocatorSchema,
]);

export type TextLocator = z.infer<typeof TextLocatorSchema>;
export type ImageLocator = z.infer<typeof ImageLocatorSchema>;
export type TemporalLocator = z.infer<typeof TemporalLocatorSchema>;
export type SourceLocator = z.infer<typeof SourceLocatorSchema>;

export const AnchorResolveStatus = [
  "resolved",
  "needs_review",
  "missing_resource",
  "missing_revision",
  "missing_capability",
  "unresolved",
] as const;

export type AnchorResolveStatus = (typeof AnchorResolveStatus)[number];

export type AnchorResolveResult = {
  status: AnchorResolveStatus;
  text?: string;
  utf16Range?: { start: number; end: number };
  candidates?: Array<{ start: number; end: number; text: string }>;
  reason?: string;
};

export const NORMALIZATION_V1 = "text-nfc-lf-v1";
export const PARSER_V1 = "novel-parser-v1";
export const PARSER_V2_SPACING = "novel-parser-v2-spacing";
