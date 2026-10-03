import { describe, expect, it } from "vitest";
import { exportLibraryPackage, previewLibraryPackage } from "../../packages/app-core/src/domain/library-package.ts";
import { startApp, tempProfile } from "./helpers.ts";
import { DEFAULT_SHELL_PREFERENCE } from "@manga/contracts";
import { readShell } from "../../packages/app-core/src/reading-service.ts";

describe("A recheck package preview", () => {
  it("keeps legacy reading preferences and persists a font change", async () => {
    const { app, actor, grant } = await startApp();
    try {
      const legacy = JSON.parse(JSON.stringify(DEFAULT_SHELL_PREFERENCE));
      delete legacy.reading.fontFamily;
      legacy.reading.fontSizePx = 26;
      app.store.sqlite.prepare("INSERT OR REPLACE INTO config(key, revision, value_json) VALUES ('shell.layout', 1, ?)").run(JSON.stringify(legacy));
      expect(readShell(app.store).reading).toMatchObject({ fontFamily: "sans", fontSizePx: 26 });
      const result = await app.call(actor, { commandId: "settings.setShell", idempotencyKey: "font-choice", input: { reading: { fontFamily: "serif" } } }, grant.handle);
      expect(result.status).toBe("ok");
      expect(readShell(app.store).reading).toMatchObject({ fontFamily: "serif", fontSizePx: 26 });
    } finally { app.close(); }
  });

  it("previews a package with reading progress and identifies the exact conflict", async () => {
    const { app, actor, grant } = await startApp();
    try {
      const book = await app.call(actor, { commandId: "library.importDocument", idempotencyKey: "progress-book", input: { title: "进度合成书", format: "txt", bytes: [...new TextEncoder().encode("合成正文")] } }, grant.handle);
      expect(book.status).toBe("ok");
      const { resourceId, revisionId } = book.value!;
      app.store.sqlite.prepare("INSERT INTO progress(resource_id, resource_revision_id, last_locator_json, consumed_ranges_json, completion_state, last_interaction_at) VALUES (?,?,?,?,?,?)")
        .run(resourceId, revisionId, null, "[]", "in_progress", new Date().toISOString());
      const destination = tempProfile();
      exportLibraryPackage(app.store, destination);
      const preview = previewLibraryPackage(app.store, destination);
      expect(preview.conflicts).toContainEqual(expect.objectContaining({ kind: "progress", id: `${resourceId}:${revisionId}` }));
      app.store.sqlite.prepare("DELETE FROM progress").run();
      expect(previewLibraryPackage(app.store, destination).conflicts.some((row) => row.kind === "progress")).toBe(false);
    } finally { app.close(); }
  });
});
