import { BUILTIN_QUICK_TASKS, MangaError, QUICK_PAGES, QUICK_PLACEHOLDERS, createId, unknownPlaceholders, type QuickPage, type QuickTask, type QuickTaskDraft } from "@manga/contracts";
import type { DrizzleStore } from "@manga/storage-drizzle";

type Row = {
  id: string; builtin_key: string | null; name: string; template: string; pages_json: string; include_frame: number; include_library: number;
  send_mode: "send" | "fill"; sort_order: number; enabled: number; builtin: number;
};

const SEEDED = "quickTasks.seeded";
const MAX_TASKS = 100;

const taskOf = (row: Row): QuickTask => ({
  id: row.id, builtinKey: row.builtin_key, name: row.name, template: row.template,
  pages: (JSON.parse(row.pages_json) as string[]).filter((page): page is QuickPage => (QUICK_PAGES as readonly string[]).includes(page)),
  includeFrame: row.include_frame === 1, includeLibrary: row.include_library === 1, sendMode: row.send_mode, enabled: row.enabled === 1, builtin: row.builtin === 1, order: row.sort_order,
});

/**
 * The user's quick tasks (A-52). The built-in ones are ordinary rows the user may change or delete; "restore defaults" brings
 * back what is missing and puts the built-in ones back as shipped. A task is only a prompt template: it cannot change what a task
 * is allowed to use, which stays with the grant the send creates.
 */
export class QuickTaskService {
  private readonly store: DrizzleStore;

  constructor(store: DrizzleStore) {
    this.store = store;
  }

  /** Built-in tasks are written once, the first time the list is read, so a task the user deleted stays deleted until they restore it. */
  private seed(): void {
    if (this.store.getMeta(SEEDED) === "1") return;
    const now = new Date().toISOString();
    const insert = this.store.sqlite.prepare("INSERT INTO quick_tasks(id, builtin_key, name, template, pages_json, include_frame, include_library, send_mode, sort_order, enabled, builtin, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,1,1,?,?)");
    this.store.sqlite.transaction(() => {
      BUILTIN_QUICK_TASKS.forEach((task, index) => insert.run(createId("qt"), task.builtinKey, task.name, task.template, JSON.stringify(task.pages), task.includeFrame ? 1 : 0, task.includeLibrary ? 1 : 0, task.sendMode, index, now, now));
      this.store.setMeta(SEEDED, "1");
    })();
  }

  list(filter: { page?: QuickPage; includeDisabled?: boolean } = {}): { tasks: QuickTask[]; placeholders: readonly string[] } {
    this.seed();
    const rows = this.store.sqlite.prepare("SELECT * FROM quick_tasks ORDER BY sort_order, created_at, id").all() as Row[];
    const tasks = rows.map(taskOf).filter((task) => (filter.includeDisabled || task.enabled) && (!filter.page || task.pages.includes(filter.page)));
    return { tasks, placeholders: QUICK_PLACEHOLDERS };
  }

  private validate(draft: QuickTaskDraft): void {
    const unknown = unknownPlaceholders(draft.template);
    if (unknown.length) throw new MangaError("VALIDATION_ERROR", `the template uses placeholders that do not exist: ${unknown.join("、")}`, { details: { reason: "unknown-placeholder", unknown } });
    if (draft.includeFrame && !draft.pages.some((page) => page === "comic" || page === "video")) throw new MangaError("VALIDATION_ERROR", "only a comic or video page has a picture to attach", { details: { reason: "frame-without-page" } });
  }

  save(draft: QuickTaskDraft): QuickTask {
    this.seed();
    this.validate(draft);
    const now = new Date().toISOString();
    if (draft.id) {
      const existing = this.store.sqlite.prepare("SELECT * FROM quick_tasks WHERE id = ?").get(draft.id) as Row | undefined;
      if (!existing) throw new MangaError("NOT_FOUND", "that quick task does not exist");
      this.store.sqlite.prepare("UPDATE quick_tasks SET name = ?, template = ?, pages_json = ?, include_frame = ?, include_library = ?, send_mode = ?, enabled = ?, updated_at = ? WHERE id = ?")
        .run(draft.name, draft.template, JSON.stringify(draft.pages), draft.includeFrame ? 1 : 0, draft.includeLibrary ? 1 : 0, draft.sendMode, (draft.enabled ?? existing.enabled === 1) ? 1 : 0, now, draft.id);
      return taskOf(this.store.sqlite.prepare("SELECT * FROM quick_tasks WHERE id = ?").get(draft.id) as Row);
    }
    const count = (this.store.sqlite.prepare("SELECT COUNT(*) AS n FROM quick_tasks").get() as { n: number }).n;
    if (count >= MAX_TASKS) throw new MangaError("VALIDATION_ERROR", "there are already too many quick tasks; delete some first", { details: { reason: "limit" } });
    const id = createId("qt");
    const next = ((this.store.sqlite.prepare("SELECT COALESCE(MAX(sort_order), -1) AS n FROM quick_tasks").get() as { n: number }).n) + 1;
    this.store.sqlite.prepare("INSERT INTO quick_tasks(id, builtin_key, name, template, pages_json, include_frame, include_library, send_mode, sort_order, enabled, builtin, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?)")
      .run(id, null, draft.name, draft.template, JSON.stringify(draft.pages), draft.includeFrame ? 1 : 0, draft.includeLibrary ? 1 : 0, draft.sendMode, next, draft.enabled === false ? 0 : 1, now, now);
    return taskOf(this.store.sqlite.prepare("SELECT * FROM quick_tasks WHERE id = ?").get(id) as Row);
  }

  delete(id: string): { id: string } {
    this.seed();
    if (!this.store.sqlite.prepare("DELETE FROM quick_tasks WHERE id = ?").run(id).changes) throw new MangaError("NOT_FOUND", "that quick task does not exist");
    return { id };
  }

  /** Put the tasks in the order of `ids`; tasks not named keep their relative order after them. */
  reorder(ids: string[]): { tasks: QuickTask[] } {
    this.seed();
    const all = (this.store.sqlite.prepare("SELECT id FROM quick_tasks ORDER BY sort_order, created_at, id").all() as Array<{ id: string }>).map((row) => row.id);
    const known = new Set(all);
    const first = ids.filter((id, at) => known.has(id) && ids.indexOf(id) === at);
    const order = [...first, ...all.filter((id) => !first.includes(id))];
    const update = this.store.sqlite.prepare("UPDATE quick_tasks SET sort_order = ? WHERE id = ?");
    this.store.sqlite.transaction(() => order.forEach((id, at) => update.run(at, id)))();
    return { tasks: this.list({ includeDisabled: true }).tasks };
  }

  /** Bring back built-in tasks (all of them, or one by key): a missing one is added, a changed one is put back as shipped. */
  restore(builtinKey?: string): { tasks: QuickTask[]; restored: string[] } {
    this.seed();
    const defaults = BUILTIN_QUICK_TASKS.filter((task) => !builtinKey || task.builtinKey === builtinKey);
    if (builtinKey && !defaults.length) throw new MangaError("NOT_FOUND", "that is not a built-in quick task");
    const now = new Date().toISOString();
    const restored: string[] = [];
    this.store.sqlite.transaction(() => {
      for (const task of defaults) {
        const index = BUILTIN_QUICK_TASKS.findIndex((item) => item.builtinKey === task.builtinKey);
        const row = this.store.sqlite.prepare("SELECT * FROM quick_tasks WHERE builtin_key = ?").get(task.builtinKey) as Row | undefined;
        if (!row) {
          this.store.sqlite.prepare("INSERT INTO quick_tasks(id, builtin_key, name, template, pages_json, include_frame, include_library, send_mode, sort_order, enabled, builtin, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,1,1,?,?)")
            .run(createId("qt"), task.builtinKey, task.name, task.template, JSON.stringify(task.pages), task.includeFrame ? 1 : 0, task.includeLibrary ? 1 : 0, task.sendMode, 1000 + index, now, now);
          restored.push(task.builtinKey);
        } else if (row.name !== task.name || row.template !== task.template || row.pages_json !== JSON.stringify(task.pages) || (row.include_frame === 1) !== task.includeFrame || (row.include_library === 1) !== task.includeLibrary || row.send_mode !== task.sendMode || row.enabled !== 1) {
          this.store.sqlite.prepare("UPDATE quick_tasks SET name = ?, template = ?, pages_json = ?, include_frame = ?, include_library = ?, send_mode = ?, enabled = 1, updated_at = ? WHERE id = ?")
            .run(task.name, task.template, JSON.stringify(task.pages), task.includeFrame ? 1 : 0, task.includeLibrary ? 1 : 0, task.sendMode, now, row.id);
          restored.push(task.builtinKey);
        }
      }
    })();
    return { tasks: this.list({ includeDisabled: true }).tasks, restored };
  }
}
