import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { AGENT_COMMANDS, AGENT_OPT_IN_COMMANDS, NOTE_CONTENT_COMMANDS, OWNER_COMMANDS } from "@manga/app-core";
import { LIST_CHANGING_COMMANDS } from "@manga/contracts/sidebar";
import { AGENT_PROJECT_COMMANDS } from "../../packages/app-core/src/creative/agent-access.ts";
import { startApp } from "../helpers/app.ts";

/**
 * The command registry of an app with every module active: which module registers each command and which access lists it is on. The snapshot was
 * written before the command registrations moved out of `product-app.ts`; a change here is a change of the command surface and has to be deliberate.
 * Run with `MANGA_WRITE_COMMAND_SNAPSHOT=1` to rewrite it.
 */
const SNAPSHOT = path.join(import.meta.dirname, "command-registry.snapshot.json");

type App = Awaited<ReturnType<typeof startApp>>;
const apps: App[] = [];
afterEach(() => { while (apps.length) apps.pop()!.app.close(); });

describe("command registry", () => {
  it("registers the same commands, in the same modules and on the same access lists, as the snapshot", async () => {
    const ctx = await startApp();
    apps.push(ctx);
    const owner = new Set(OWNER_COMMANDS);
    const agent = new Set(AGENT_COMMANDS);
    const project = new Set(AGENT_PROJECT_COMMANDS);
    const optIn = new Set(AGENT_OPT_IN_COMMANDS);
    const rows = ctx.app.runtime.commandOwners()
      .map(({ commandId, moduleId }) => ({
        commandId,
        moduleId,
        owner: owner.has(commandId),
        agent: agent.has(commandId),
        agentProject: project.has(commandId),
        agentOptIn: optIn.has(commandId),
        noteContent: NOTE_CONTENT_COMMANDS.has(commandId),
      }))
      .sort((a, b) => a.commandId.localeCompare(b.commandId));
    const registered = new Set(rows.map((row) => row.commandId));
    // Commands on a list that no module registers would be grants for nothing; keep them visible in the snapshot too.
    const unregistered = [...owner, ...agent, ...project, ...optIn, ...NOTE_CONTENT_COMMANDS].filter((commandId) => !registered.has(commandId));
    const actual = { commands: rows, onListsOnly: [...new Set(unregistered)].sort() };
    if (process.env.MANGA_WRITE_COMMAND_SNAPSHOT === "1") fs.writeFileSync(SNAPSHOT, `${JSON.stringify(actual, null, 2)}\n`);
    const expected = JSON.parse(fs.readFileSync(SNAPSHOT, "utf8"));
    expect(actual).toEqual(expected);
  });

  it("names every command that makes, renames, deletes or restores a listed thing among the commands the sidebar reads again after", async () => {
    const ctx = await startApp();
    apps.push(ctx);
    const exceptions = new Map<string, string>([
      ["notes.restore", "restores an earlier body; title and list place stay"],
      ["draft.restore", "restores an earlier version; title and list place stay"],
    ]);
    const listed = new Set<string>(LIST_CHANGING_COMMANDS);
    const kinds = /^(notes|whiteboard|mindmap|draft|roughcut)\.(create|rename|delete|undelete|restore)$|^project\.(addMaterial|removeMaterial)$/;
    const missing = ctx.app.runtime.commandOwners().map((row) => row.commandId).filter((commandId) => kinds.test(commandId) && !listed.has(commandId) && !exceptions.has(commandId));
    expect(missing).toEqual([]);
    const registered = new Set(ctx.app.runtime.commandOwners().map((row) => row.commandId));
    expect(LIST_CHANGING_COMMANDS.filter((commandId) => !registered.has(commandId))).toEqual([]);
  });

  it("never lets an agent grant run an owner-only command", async () => {
    const ctx = await startApp();
    apps.push(ctx);
    const agentActor = { kind: "agent" as const, id: "agent-probe" };
    const grant = ctx.app.issueAgentGrant(ctx.grant, agentActor, { readResourceIds: [] });
    const allowed = new Set([...AGENT_COMMANDS, ...AGENT_OPT_IN_COMMANDS]);
    const ownerOnly = ctx.app.runtime.commandOwners().map((row) => row.commandId).filter((commandId) => !allowed.has(commandId) && !AGENT_PROJECT_COMMANDS.includes(commandId));
    expect(ownerOnly.length).toBeGreaterThan(100);
    expect(ownerOnly.filter((commandId) => grant.allowedCommands.includes(commandId))).toEqual([]);
    const leaked: string[] = [];
    let n = 0;
    for (const commandId of ownerOnly) {
      n += 1;
      const result = await ctx.app.call(agentActor, { commandId, idempotencyKey: `agent-probe-${n}`, input: {} }, grant.handle);
      // Input is checked before the grant, so an empty input may be refused as invalid first; either way it must not run.
      if (result.status === "ok" || !["FORBIDDEN", "VALIDATION_ERROR"].includes(String(result.error?.code))) leaked.push(`${commandId}:${result.status}:${result.error?.code ?? ""}`);
    }
    expect(leaked).toEqual([]);
  });
});
