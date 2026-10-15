import { MangaError, createId, type PackageImportStrategy } from "@manga/contracts";
import type { DrizzleStore } from "@manga/storage-drizzle";
import { applyBundle, bundleConflicts, checkBundle, checkRows, collectBundle, rowExists, selectRows, type BundleHooks, type ProjectBundle, type Row } from "./bundle.ts";

/**
 * The creative part of a whole-library package (CRE-01, DATA-01): every project as a bundle, and what is kept outside any project, the pages
 * kept for later and the excerpts of no project. It reuses the project bundle, so a project means the same in a library package and in a
 * project package. Conversations, undo history and search indexes are not carried: the indexes are rebuilt, and the history belongs to the profile.
 */
export type CreativeSection = { projects: ProjectBundle[]; loose: { pages: Row[]; excerpts: Row[] } };

export const CREATIVE_LIMITS = { projects: 5000, jsonBytes: 40 * 1024 * 1024 } as const;
const bad = (message: string, extra: Record<string, unknown> = {}) => new MangaError("VALIDATION_ERROR", message, { details: { reason: "schema", ...extra } });

export const creativeIsEmpty = (section: CreativeSection | undefined): boolean => !section || (section.projects.length === 0 && section.loose.pages.length === 0 && section.loose.excerpts.length === 0);

/** Reads everything creative: the projects, and the pages and excerpts that no project carries. */
export function collectCreative(store: DrizzleStore, now = new Date().toISOString()): CreativeSection {
  const ids = (store.sqlite.prepare("SELECT id FROM projects ORDER BY created_at, rowid").all() as Array<{ id: string }>).map((row) => row.id);
  const projects = ids.map((id) => collectBundle(store, id, now));
  const carried = new Set(projects.flatMap((bundle) => bundle.tables.excerpt_pages.map((page) => String(page.id))));
  const pages = selectRows(store, "excerpt_pages", "ORDER BY url, version", []).filter((page) => !carried.has(String(page.id)));
  const excerpts = selectRows(store, "excerpts", "WHERE project_id IS NULL ORDER BY created_at, id", []);
  const section: CreativeSection = { projects, loose: { pages, excerpts } };
  if (!creativeIsEmpty(section) && JSON.stringify(section).length > CREATIVE_LIMITS.jsonBytes) {
    throw new MangaError("QUOTA_EXCEEDED", "the projects and pages are too large for one package; export some of the projects on their own", { details: { reason: "size" } });
  }
  return section;
}

/** Checks the section read from a manifest as strictly as a project package is checked. */
export function checkCreative(raw: unknown): CreativeSection {
  if (!raw || typeof raw !== "object") throw bad("the creative data is not an object");
  const value = raw as { projects?: unknown; loose?: { pages?: unknown; excerpts?: unknown } };
  if (!Array.isArray(value.projects) || value.projects.length > CREATIVE_LIMITS.projects) throw bad("the projects are not a list of a fitting size");
  const projects = value.projects.map((item) => checkBundle(item));
  const seen = new Set<string>();
  for (const bundle of projects) {
    const id = String(bundle.project.id);
    if (seen.has(id)) throw bad("the package holds a project twice");
    seen.add(id);
  }
  const pages = checkRows("excerpt_pages", value.loose?.pages ?? []);
  const excerpts = checkRows("excerpts", value.loose?.excerpts ?? []);
  const known = new Set([...pages.map((page) => String(page.id)), ...projects.flatMap((bundle) => bundle.tables.excerpt_pages.map((page) => String(page.id)))]);
  for (const row of excerpts) {
    if (row.project_id !== null) throw bad("an excerpt of no project belongs to a project");
    if (!known.has(String(row.page_id))) throw bad("an excerpt points at a page the package does not hold", { table: "excerpts" });
  }
  return { projects, loose: { pages, excerpts } };
}

export type CreativeHooks = BundleHooks & {
  /** Takes a project and what it owns out of the profile, for a project that is replaced. */
  removeProject: (projectId: string) => void;
};

export type CreativeOutcome = { projects: number; replaced: number; skipped: number; excerpts: number; pages: number; missing: number };

/**
 * Writes the section into the profile. The caller owns the transaction (a library import is one), so a failure anywhere leaves nothing of it.
 * `actionFor` decides for each project that meets one already here: `skip` keeps the one here, `replace` takes it out and restores the
 * packaged one under its own ids, `duplicate` makes a copy. Pages are kept first, oldest version first, so each address keeps its history in order.
 */
export function applyCreative(
  store: DrizzleStore, section: CreativeSection, hooks: CreativeHooks,
  actionFor: (projectId: string) => PackageImportStrategy, looseAction: PackageImportStrategy, now = new Date().toISOString(),
): CreativeOutcome {
  const outcome: CreativeOutcome = { projects: 0, replaced: 0, skipped: 0, excerpts: 0, pages: 0, missing: 0 };
  const run = () => {
    const pagesById = new Map<string, Row>();
    for (const bundle of section.projects) for (const page of bundle.tables.excerpt_pages) pagesById.set(String(page.id), page);
    for (const page of section.loose.pages) pagesById.set(String(page.id), page);
    const adopted = new Map<string, string>();
    const ordered = [...pagesById.values()].sort((a, b) => String(a.url).localeCompare(String(b.url)) || Number(a.version) - Number(b.version));
    for (const page of ordered) {
      adopted.set(String(page.id), hooks.adoptPage({ url: String(page.url), title: String(page.title), fetched_at: String(page.fetched_at), content_hash: String(page.content_hash), body_text: String(page.body_text), created_at: String(page.created_at) }, String(page.id)));
    }
    outcome.pages = adopted.size;
    const bundleHooks: BundleHooks = { ...hooks, adoptPage: (row, preferred) => adopted.get(preferred) ?? hooks.adoptPage(row, preferred) };

    for (const bundle of section.projects) {
      const id = String(bundle.project.id);
      const present = rowExists(store, "projects", id);
      const action = actionFor(id);
      if (action === "skip" && (present || bundleConflicts(store, bundle))) { outcome.skipped += 1; continue; }
      if (action === "replace" && present) { hooks.removeProject(id); outcome.replaced += 1; }
      const result = applyBundle(store, bundle, bundleHooks, now);
      outcome.projects += 1;
      outcome.missing += result.missing.length;
    }

    for (const source of section.loose.excerpts) {
      const id = String(source.id);
      const present = rowExists(store, "excerpts", id);
      if (looseAction === "skip" && present) { outcome.skipped += 1; continue; }
      if (looseAction === "replace" && present) store.sqlite.prepare("DELETE FROM excerpts WHERE id = ?").run(id);
      const row: Row = { ...source, id: looseAction === "duplicate" && present ? createId("exc") : id, page_id: adopted.get(String(source.page_id)) ?? String(source.page_id) };
      const columns = Object.keys(row);
      store.sqlite.prepare(`INSERT INTO excerpts(${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...columns.map((column) => row[column]));
      hooks.indexExcerpt({ id: String(row.id), title: String(row.title), text: String(row.text), note: String(row.note) });
      outcome.excerpts += 1;
    }
  };
  // Nested inside the caller's transaction this is a savepoint; on its own it is a transaction.
  store.sqlite.transaction(run)();
  return outcome;
}
