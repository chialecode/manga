import { SEMANTIC_KINDS, SEMANTIC_SEGMENTATIONS, type SemanticKind, type SemanticSegmentation } from "@manga/contracts/semantic";

export { SEMANTIC_KINDS, SEMANTIC_SEGMENTATIONS };
export type { SemanticKind, SemanticSegmentation };

export type SemanticVersionView = { id: number; model: string; dim: number | null; segmentation: string; engine: "vec0" | "blob"; chunks: number; createdAt: string; activatedAt: string | null };
export type SemanticStatusView = {
  enabled: boolean;
  connectionId: string | null;
  segmentation: SemanticSegmentation;
  connections: Array<{ id: string; label: string; model: string }>;
  active: SemanticVersionView | null;
  building: { id: number; model: string; segmentation: string; status: string; done: number; total: number; kind: "build" | "update" } | null;
  failed: { id: number; model: string; error: { code: string; message: string } } | null;
  stale: boolean;
  pending: number;
  engine: "vec0" | "blob";
  estimate: { chars: number; chunks: number };
};
export type SemanticHitView = {
  kind: SemanticKind; score: number; text: string; title: string;
  resourceId?: string; workId?: string; mediaKind?: string; revisionId?: string;
  locator?: { kind: "text"; partId: string; representationId: string; range: { start: number; end: number } };
  objectId?: string; blockId?: string; sessionId?: string; startMs?: number; excerptId?: string;
};
export type SemanticSearchView = {
  state: "ok" | "off" | "building" | "needsRebuild" | "unavailable";
  results: SemanticHitView[];
  version: { id: number; model: string; segmentation: string; dim: number | null } | null;
};

/** The words for the state a search found the index in, when it could not be answered. */
export function searchStateKey(state: SemanticSearchView["state"]): "semantic.search.state.off" | "semantic.search.state.building" | "semantic.search.state.needsRebuild" | "semantic.search.state.unavailable" | null {
  switch (state) {
    case "off": return "semantic.search.state.off";
    case "building": return "semantic.search.state.building";
    case "needsRebuild": return "semantic.search.state.needsRebuild";
    case "unavailable": return "semantic.search.state.unavailable";
    default: return null;
  }
}

/** A score as the person reads it: how close the passage is to what they asked, in whole percent. */
export const scorePercent = (score: number): number => Math.max(0, Math.min(100, Math.round(score * 100)));
