import { MangaError, type Actor, type ScopeGrant } from "@manga/contracts";
import { createId } from "@manga/contracts";
import type { DrizzleStore } from "@manga/storage-drizzle";

export class GrantRegistry {
  private readonly store: DrizzleStore;
  constructor(store: DrizzleStore) {
    this.store = store;
  }

  issue(input: Omit<ScopeGrant, "handle" | "createdAt" | "revoked"> & { handle?: string }): ScopeGrant {
    const grant: ScopeGrant = {
      ...input,
      handle: input.handle ?? createId("grant"),
      revoked: false,
      createdAt: new Date().toISOString(),
    };
    this.save(grant);
    return grant;
  }

  save(grant: ScopeGrant): void {
    this.store.sqlite.prepare(`INSERT INTO grants(handle, actor_json, session_id, run_id, allowed_commands_json, access, read_resource_ids_json, write_resource_ids_json, write_object_ids_json, allow_create_objects, path_handles_json, module_epoch, binding_epoch, registry_generation, revoked, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(handle) DO UPDATE SET actor_json=excluded.actor_json, session_id=excluded.session_id, run_id=excluded.run_id, allowed_commands_json=excluded.allowed_commands_json, access=excluded.access, read_resource_ids_json=excluded.read_resource_ids_json, write_resource_ids_json=excluded.write_resource_ids_json, write_object_ids_json=excluded.write_object_ids_json, allow_create_objects=excluded.allow_create_objects, path_handles_json=excluded.path_handles_json, module_epoch=excluded.module_epoch, binding_epoch=excluded.binding_epoch, registry_generation=excluded.registry_generation, revoked=excluded.revoked`).run(
      grant.handle,
      JSON.stringify(grant.actor),
      grant.sessionId ?? null,
      grant.runId ?? null,
      JSON.stringify(grant.allowedCommands),
      grant.access,
      JSON.stringify(grant.readResourceIds),
      JSON.stringify(grant.writeResourceIds),
      JSON.stringify(grant.writeObjectIds),
      grant.allowCreateObjects ? 1 : 0,
      JSON.stringify(grant.pathHandles),
      grant.moduleEpoch,
      grant.bindingEpoch,
      grant.registryGeneration,
      grant.revoked ? 1 : 0,
      grant.createdAt,
    );
  }

  get(handle: string): ScopeGrant | undefined {
    const row = this.store.sqlite.prepare("SELECT * FROM grants WHERE handle = ?").get(handle) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      handle: String(row.handle),
      actor: JSON.parse(String(row.actor_json)) as Actor,
      sessionId: row.session_id ? String(row.session_id) : undefined,
      runId: row.run_id ? String(row.run_id) : undefined,
      allowedCommands: JSON.parse(String(row.allowed_commands_json)) as string[],
      access: row.access as ScopeGrant["access"],
      readResourceIds: JSON.parse(String(row.read_resource_ids_json)) as string[],
      writeResourceIds: JSON.parse(String(row.write_resource_ids_json)) as string[],
      writeObjectIds: JSON.parse(String(row.write_object_ids_json)) as string[],
      allowCreateObjects: Boolean(row.allow_create_objects),
      pathHandles: JSON.parse(String(row.path_handles_json)) as string[],
      moduleEpoch: Number(row.module_epoch),
      bindingEpoch: Number(row.binding_epoch),
      registryGeneration: Number(row.registry_generation),
      revoked: Boolean(row.revoked),
      createdAt: String(row.created_at),
    };
  }

  revoke(handle: string): void {
    this.store.sqlite.prepare("UPDATE grants SET revoked = 1 WHERE handle = ?").run(handle);
  }

  trustedScope(actor: Actor, handle: string): boolean {
    const grant = this.get(handle);
    if (!grant || grant.revoked) return false;
    return grant.actor.kind === actor.kind && grant.actor.id === actor.id;
  }

  assertCommand(grant: ScopeGrant, commandId: string): void {
    if (grant.revoked) throw new MangaError("GRANT_REVOKED", "authorization has been revoked");
    if (!grant.allowedCommands.includes(commandId)) throw new MangaError("FORBIDDEN", `command ${commandId} is not authorized`);
  }

  canRead(grant: ScopeGrant, resourceId: string): boolean {
    if (grant.revoked) return false;
    if (grant.access === "owner") return true;
    return grant.readResourceIds.includes(resourceId);
  }

  canWriteResource(grant: ScopeGrant, resourceId: string): boolean {
    if (grant.revoked) return false;
    if (grant.access === "owner") return true;
    return grant.writeResourceIds.includes(resourceId);
  }

  canWriteObject(grant: ScopeGrant, objectId: string): boolean {
    if (grant.revoked) return false;
    if (grant.access === "owner") return true;
    return grant.writeObjectIds.includes(objectId);
  }

  intersectRead(grant: ScopeGrant, requested?: string[]): string[] | undefined {
    if (grant.access === "owner") return requested;
    if (!grant.readResourceIds.length) return [];
    if (!requested) return grant.readResourceIds;
    return requested.filter((id) => grant.readResourceIds.includes(id));
  }
}
