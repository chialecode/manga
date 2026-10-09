import { createTranslator } from "@manga/i18n";
import type { startApp } from "./app.ts";
import type { ProjectTabContext } from "../../apps/desktop/src/renderer/pages/projects/project-page.tsx";

type Started = Awaited<ReturnType<typeof startApp>>;

/**
 * Lets a page under test talk to a real application: `window.manga.command` goes to the same command layer the desktop host uses, and the
 * notices the application publishes reach the page. Pages then run against real data, not a script of canned answers.
 */
export function bridgeToApp(ctx: Started, extra: Record<string, unknown> = {}): { calls: Array<{ commandId: string; input: unknown }>; notices: Array<{ topic: string; payload: Record<string, unknown> }>; dispose: () => void } {
  const calls: Array<{ commandId: string; input: unknown }> = [];
  const notices: Array<{ topic: string; payload: Record<string, unknown> }> = [];
  const listeners = new Set<(notice: { topic: string; payload: Record<string, unknown> }) => void>();
  const off = ctx.app.onNotice((notice) => { notices.push(notice); for (const listener of listeners) listener(notice); });
  (window as unknown as { manga: unknown }).manga = {
    async command(payload: { commandId: string; idempotencyKey: string; input: unknown }) {
      calls.push({ commandId: payload.commandId, input: payload.input });
      return ctx.app.call(ctx.actor, { commandId: payload.commandId, idempotencyKey: payload.idempotencyKey, input: payload.input }, ctx.grant.handle);
    },
    onNotice(listener: (notice: { topic: string; payload: Record<string, unknown> }) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    ...extra,
  };
  return { calls, notices, dispose: () => { off(); Reflect.deleteProperty(window, "manga"); } };
}

/** What a project tab is given, with the errors and notices collected for the test to look at. */
export function tabContext(projectId: string, extra: Partial<ProjectTabContext> = {}): { ctx: ProjectTabContext; errors: string[]; notices: string[] } {
  const i18n = createTranslator("zh-CN");
  const errors: string[] = [];
  const notices: string[] = [];
  const ctx: ProjectTabContext = {
    t: i18n.t, formatDate: (iso) => iso.slice(0, 10),
    detail: { project: { id: projectId, name: "项目", goal: "", status: "active", modelConnectionId: null, counts: {} }, materials: [], terms: [], sessions: [] },
    reload: () => undefined, onError: (message) => { errors.push(message); }, onNotice: (message) => { notices.push(message); },
    focus: null, onFocus: () => undefined, onTab: () => undefined, onOpenMaterial: () => undefined, facets: new Set(["research", "semantic"]), ...extra,
  };
  return { ctx, errors, notices };
}
