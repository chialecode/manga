import type { CommandResult, ScopeGrant } from "@manga/contracts";

/** The tools that read the resources of a task's scope (LOOP-20, 计划 4.9). */
const SCOPED_READ_COMMANDS = new Set(["library.find", "library.list", "library.read", "library.getResource", "library.contextSnapshot", "comic.pages", "material.subtitleWindow", "semantic.search"]);

/**
 * A task whose scope has no resource to read gets, with the empty answer of a tool that reads them, why and what to do (AT-129): the model can then tell
 * the person instead of asking again. A scope with resources in it answers as it always did, found or not; the owner's own calls are not tasks.
 */
export function withEmptyScopeNote(grant: ScopeGrant, commandId: string, result: CommandResult): CommandResult {
  if (result.status !== "ok" || grant.access === "owner" || grant.readResourceIds.length > 0 || !SCOPED_READ_COMMANDS.has(commandId)) return result;
  if (commandId === "semantic.search" && Array.isArray((result.value as { results?: unknown[] } | undefined)?.results) && (result.value as { results: unknown[] }).results.length > 0) return result;
  return {
    ...result,
    value: {
      result: result.value,
      scope: {
        readable: 0,
        reason: "这次任务没有勾选可读的资源，所以读不到任何书、漫画或视频的内容。",
        advice: "请告诉用户：在对话栏的“材料”里勾选要读的资源后再问，或者在作品主页、阅读器里提问（那里会带上正在看的资源）。不要再次调用查找。",
      },
    },
  };
}
