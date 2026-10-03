export type SearchHit = {
  fragmentId: string;
  resourceId?: string;
  objectId?: string;
  revisionId?: string;
  kind: "title" | "alias" | "body" | "note";
  text: string;
  score: number;
  locator?: {
    kind: "text";
    partId: string;
    representationId: string;
    range: { start: number; end: number };
  } | null;
};

export type SearchQuery = {
  text: string;
  kinds?: Array<SearchHit["kind"]>;
  resourceIds?: string[];
  readAllowlist?: string[];
  limit?: number;
};
