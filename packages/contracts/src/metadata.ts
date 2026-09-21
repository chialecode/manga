export type MetadataFieldPolicy = "provider" | "user" | "locked" | "empty";

export type MetadataField = {
  key: string;
  value: unknown;
  sourceProviderId?: string;
  policy: MetadataFieldPolicy;
};

export type MetadataSnapshot = {
  providerId: string;
  externalId: string;
  fetchedAt: string;
  fields: Record<string, unknown>;
  partial: boolean;
};

export type ProviderQueryMode = "single" | "fallback" | "multi";
