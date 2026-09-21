export type SearchHit = {
  fragmentId: string;
  resourceId?: string;
  objectId?: string;
  kind: "title" | "alias" | "body" | "note";
  text: string;
  score: number;
};

export type SearchQuery = {
  text: string;
  kinds?: Array<SearchHit["kind"]>;
  resourceIds?: string[];
  readAllowlist?: string[];
  limit?: number;
};
