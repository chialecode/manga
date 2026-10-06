import { METADATA_FIELD_KEYS, type MetadataFieldKey, type MetadataFieldValue } from "@manga/contracts";

/**
 * Field projection for a work. Every field keeps all candidates and the source that won, so the detail page can
 * answer "where does this value come from" and a refresh can never replace what the user decided.
 *
 * Priority (external-providers 4.3): user override or lock → confirmed online source → file-embedded data →
 * file name → detached (unlinked) snapshot. A source that lacks a field never clears a value another source has.
 */
export type ProjectionSourceId = "user" | "online" | "file" | "filename" | "detached";

export type ProjectionSource = {
  id: ProjectionSourceId;
  /** Provider that produced the values, e.g. `bangumi` or `local-file`; absent for user and file name. */
  providerId?: string;
  fetchedAt?: string;
  fields: Partial<Record<MetadataFieldKey, MetadataFieldValue | null>>;
};

export type FieldCandidate = {
  source: ProjectionSourceId;
  providerId?: string;
  value: MetadataFieldValue;
  fetchedAt?: string;
  selected: boolean;
};

export type ProjectedField = {
  value: MetadataFieldValue | null;
  source: ProjectionSourceId | null;
  providerId?: string;
  fetchedAt?: string;
  /** `locked` when the user pinned it, `user` when typed, `empty` when the user cleared it on purpose. */
  policy: "provider" | "user" | "locked" | "empty" | "none";
  candidates: FieldCandidate[];
};

export type WorkProjection = Partial<Record<MetadataFieldKey, ProjectedField>>;

export type FieldOverride = {
  fields: Partial<Record<MetadataFieldKey, MetadataFieldValue>>;
  locked: MetadataFieldKey[];
  cleared: MetadataFieldKey[];
};

const ORDER: ProjectionSourceId[] = ["online", "file", "filename", "detached"];

function present(value: MetadataFieldValue | null | undefined): value is MetadataFieldValue {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

export function projectWork(sources: ProjectionSource[], override: FieldOverride): WorkProjection {
  const result: WorkProjection = {};
  const lockedSet = new Set(override.locked);
  const clearedSet = new Set(override.cleared);
  const ranked = [...sources].sort((left, right) => ORDER.indexOf(left.id as never) - ORDER.indexOf(right.id as never)).filter((source) => source.id !== "user");
  for (const key of METADATA_FIELD_KEYS) {
    const candidates: FieldCandidate[] = [];
    for (const source of ranked) {
      const value = source.fields[key];
      if (present(value)) candidates.push({ source: source.id, providerId: source.providerId, value, fetchedAt: source.fetchedAt, selected: false });
    }
    const typed = override.fields[key];
    if (clearedSet.has(key) && !present(typed)) {
      result[key] = { value: null, source: "user", policy: "empty", candidates };
      continue;
    }
    if (present(typed)) {
      result[key] = {
        value: typed,
        source: "user",
        policy: lockedSet.has(key) ? "locked" : "user",
        candidates: [{ source: "user", value: typed, selected: true }, ...candidates],
      };
      continue;
    }
    const winner = candidates[0];
    if (winner) {
      winner.selected = true;
      result[key] = { value: winner.value, source: winner.source, providerId: winner.providerId, fetchedAt: winner.fetchedAt, policy: "provider", candidates };
    } else {
      result[key] = { value: null, source: null, policy: "none", candidates };
    }
  }
  return result;
}

/** The plain value of a projected field, for lists and context where provenance is not needed. */
export function projectedValue(projection: WorkProjection | undefined, key: MetadataFieldKey): MetadataFieldValue | null {
  return projection?.[key]?.value ?? null;
}

export function parseOverride(row: { fields_json: string; locked_json: string; cleared_json: string } | undefined): FieldOverride {
  if (!row) return { fields: {}, locked: [], cleared: [] };
  const valid = new Set<string>(METADATA_FIELD_KEYS);
  const fields = JSON.parse(row.fields_json) as Record<string, MetadataFieldValue>;
  const filtered: FieldOverride["fields"] = {};
  for (const [key, value] of Object.entries(fields)) if (valid.has(key)) filtered[key as MetadataFieldKey] = value;
  const keys = (json: string) => (JSON.parse(json) as string[]).filter((key): key is MetadataFieldKey => valid.has(key));
  return { fields: filtered, locked: keys(row.locked_json), cleared: keys(row.cleared_json) };
}
