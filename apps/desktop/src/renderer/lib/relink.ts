import type { Translator } from "@manga/i18n";
import { attempt, type CommandError } from "./api.ts";

/**
 * Pointing a resource at its file again (A-80). The file picker opens at the resource's library path, and only a file inside a library path is
 * taken: a file anywhere else comes back as `outside` with the folder the person has to add as a library path first.
 */
export type RelinkOutcome =
  | { kind: "done"; pointersKept: number }
  | { kind: "cancelled" }
  | { kind: "outside"; folder: string; mediaKind: LibraryKind }
  | { kind: "different" }
  | { kind: "failed"; message: string };

export type LibraryKind = "novel" | "comic" | "video";

const FILTER = { novel: "book", comic: "comic", video: "video" } as const;
const kindOf = (value: string | undefined): LibraryKind => (value === "comic" || value === "video" ? value : "novel");

type Placement = { resource: { kind: string; libraryRoot: string | null; folderToAdd: string | null } };

/** Ask for the file, then re-point the resource at it. */
export async function relinkResource(resourceId: string): Promise<RelinkOutcome> {
  const content = await attempt<Placement>("library.resourceContent", { resourceId });
  const resource = content.ok ? content.value.resource : undefined;
  const mediaKind = kindOf(resource?.kind);
  const defaultPath = resource?.libraryRoot ?? resource?.folderToAdd ?? undefined;
  const picked = window.manga.pick
    ? await window.manga.pick({ mode: "file", filter: FILTER[mediaKind], ...(defaultPath ? { defaultPath } : {}) })
    : await window.manga.choosePath().then((pathHandle) => (pathHandle ? { pathHandle } : null));
  if (!picked) return { kind: "cancelled" };
  const result = await attempt<{ pointersKept?: number }>("library.repairSource", { resourceId, pathHandle: picked.pathHandle });
  if (result.ok) return { kind: "done", pointersKept: Number(result.value.pointersKept ?? 0) };
  const details = (result.error as CommandError).details as { reason?: string; folder?: string } | undefined;
  if (details?.reason === "outside-library" && details.folder) return { kind: "outside", folder: details.folder, mediaKind };
  if (details?.reason === "different-file") return { kind: "different" };
  return { kind: "failed", message: result.error.message };
}

/** Add the folder as a library path: the picker opens at the folder, and the person confirms it by choosing it. */
export async function addLibraryFolder(folder: string, mediaKind: LibraryKind): Promise<{ kind: "added" } | { kind: "cancelled" } | { kind: "failed"; message: string }> {
  if (!window.manga.pick) return { kind: "failed", message: "no folder picker" };
  const picked = await window.manga.pick({ mode: "directory", defaultPath: folder });
  if (!picked) return { kind: "cancelled" };
  const added = await attempt("library.paths.add", { pathHandle: picked.pathHandle, mediaKind });
  return added.ok ? { kind: "added" } : { kind: "failed", message: added.error.message };
}

/** The notice a reader shows for an outcome, with the button that adds the folder when the file was outside. */
export function relinkNotice(t: Translator["t"], outcome: RelinkOutcome, after: () => void): { error?: string; notice?: string; action?: { label: string; onClick: () => void } } {
  switch (outcome.kind) {
    case "done": return { notice: outcome.pointersKept > 0 ? t("reading.sourceRepairKept", { count: outcome.pointersKept }) : t("reading.sourceRepairDone") };
    case "outside": return {
      notice: t("reading.relinkOutside", { folder: outcome.folder }),
      action: { label: t("reading.relinkAddFolder"), onClick: () => { void addLibraryFolder(outcome.folder, outcome.mediaKind).then((added) => { if (added.kind === "added") after(); }); } },
    };
    case "different": return { error: t("reading.relinkDifferent") };
    case "failed": return { error: outcome.message };
    default: return {};
  }
}
