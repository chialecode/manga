import { attempt } from "./api.ts";

/**
 * Inside a project, what is opened or made there becomes one of the project's materials (Q-33): the resource a reader opens, a note, a screenshot, a
 * recording. The mark is "auto" so the person can tell it from what they added, and what they removed is not put back. In "最近" nothing is added.
 * A failure is not worth telling: the thing itself was opened or made all the same.
 */
export async function autoAddMaterial(contextId: string | null, kind: "resource" | "note" | "screenshot" | "recording", targetId: string, label?: string): Promise<void> {
  if (!contextId || !targetId) return;
  await attempt("project.addMaterial", { projectId: contextId, kind, targetId, origin: "auto", ...(label ? { label } : {}) });
}
