import {
  MangaError,
  createId,
  type Actor,
  type CommandEnvelope,
  type Facet,
  type ModuleManifest,
  type ModuleState,
  type ProfileConfig,
  type ResourceHandle,
} from "@manga/contracts";
import type { MangaModule, ModuleContext } from "@manga/plugin-sdk";
import { planComposition } from "./planner.ts";
import { CommandGateway, type CommandHandler } from "./gateway.ts";
import { ResourceScope } from "./scope.ts";
import { SequencedBus } from "./bus.ts";

export type RuntimeOptions = {
  trustedScope?: (actor: Actor, requested: string) => boolean;
  isCommandAdmitted?: (commandId: string, envelope: CommandEnvelope) => boolean;
  hostFacets?: Facet[];
};

export type RuntimeSnapshot = {
  registryGeneration: number;
  modules: Record<string, {
    state: ModuleState;
    epoch: number;
    bindingEpoch: number;
    resources: Record<string, number>;
  }>;
  lastValidProfile?: ProfileConfig;
};

type ModuleSlot = {
  module: MangaModule;
  state: ModuleState;
  epoch: number;
  bindingEpoch: number;
  scope: ResourceScope;
  activating?: Promise<void>;
  stopping?: Promise<void>;
  commands: string[];
};

export class MangaRuntime {
  readonly bus = new SequencedBus();
  readonly gateway: CommandGateway;
  private registryGeneration = 1;
  private readonly slots = new Map<string, ModuleSlot>();
  private readonly commandOwner = new Map<string, string>();
  private readonly leases = new Map<string, string>();
  private lastValidProfile: ProfileConfig | undefined;
  private profile: ProfileConfig | undefined;
  private applying: Promise<void> = Promise.resolve();
  private readonly pauseGates = new Map<string, Promise<void>>();
  private readonly pauseResolvers = new Map<string, () => void>();
  private readonly hostFacets: Facet[];
  private readonly extraAdmission?: (commandId: string, envelope: CommandEnvelope) => boolean;

  constructor(modules: MangaModule[], options: RuntimeOptions = {}) {
    this.hostFacets = options.hostFacets ?? ["service"];
    this.extraAdmission = options.isCommandAdmitted;
    for (const module of modules) {
      this.slots.set(module.manifest.moduleId, {
        module,
        state: "discovered",
        epoch: 1,
        bindingEpoch: 1,
        scope: new ResourceScope(),
        commands: [],
      });
    }
    this.gateway = new CommandGateway({
      isCommandAdmitted: (commandId, envelope) => this.isAdmitted(commandId) && (this.extraAdmission?.(commandId, envelope) ?? true),
      getEpoch: (commandId) => this.epochForCommand(commandId),
      trustedScope: options.trustedScope ?? ((actor, scope) => ["user", "agent", "workflow"].includes(actor.kind) && scope === "library"),
      acquireLease: (envelope) => this.acquireLease(envelope),
    });
  }

  getManifests(): ModuleManifest[] {
    return [...this.slots.values()].map((slot) => slot.module.manifest);
  }

  snapshot(): RuntimeSnapshot {
    const modules: RuntimeSnapshot["modules"] = {};
    for (const [id, slot] of this.slots) {
      modules[id] = {
        state: slot.state,
        epoch: slot.epoch,
        bindingEpoch: slot.bindingEpoch,
        resources: slot.scope.activeCounts,
      };
    }
    return {
      registryGeneration: this.registryGeneration,
      modules,
      lastValidProfile: this.lastValidProfile,
    };
  }

  resourceTotals(): Record<string, number> {
    const totals: Record<string, number> = {};
    for (const slot of this.slots.values()) {
      for (const [kind, count] of Object.entries(slot.scope.activeCounts)) {
        totals[kind] = (totals[kind] ?? 0) + count;
      }
    }
    totals.leases = this.leases.size;
    return totals;
  }

  registerCommand(moduleId: string, commandId: string, handler: CommandHandler): void {
    const slot = this.must(moduleId);
    if (slot.state !== "activating" && slot.state !== "active") throw new MangaError("CAPABILITY_UNAVAILABLE", "module cannot register while stopped");
    if (this.commandOwner.has(commandId)) throw new MangaError("VALIDATION_ERROR", `duplicate command ${commandId}`);
    this.commandOwner.set(commandId, moduleId);
    slot.commands.push(commandId);
    this.gateway.register(commandId, handler);
  }

  setPauseGate(name: string): Promise<void> {
    const existing = this.pauseGates.get(name);
    if (existing) return existing;
    const gate = new Promise<void>((resolve) => this.pauseResolvers.set(name, resolve));
    this.pauseGates.set(name, gate);
    return gate;
  }

  releasePauseGate(name: string): void {
    this.pauseResolvers.get(name)?.();
    this.pauseResolvers.delete(name);
    this.pauseGates.delete(name);
  }

  async applyProfile(profile: ProfileConfig): Promise<void> {
    const work = this.applying.then(() => this.applyProfileNow(profile));
    this.applying = work.catch(() => undefined);
    return work;
  }

  private async applyProfileNow(profile: ProfileConfig, rollback = true): Promise<void> {
    const plan = planComposition(this.getManifests(), profile);
    const previous = this.profile;
    const oldPlan = previous ? planComposition(this.getManifests(), previous) : undefined;
    const bindingsFor = (bindings: typeof plan.bindings, capability: string) => bindings.filter(item => item.capabilityId === capability).map(item => item.providerModuleId).sort().join("|");
    const changed = new Set(plan.bindings.concat(oldPlan?.bindings ?? []).map(item => item.capabilityId).filter(capability => bindingsFor(plan.bindings, capability) !== bindingsFor(oldPlan?.bindings ?? [], capability)));
    const rebound = new Set<string>();
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const [id, slot] of this.slots) {
        if (!rebound.has(id) && (slot.module.manifest.needs ?? []).some(need => changed.has(need.capabilityId))) {
          rebound.add(id); expanded = true;
          for (const cap of slot.module.manifest.contributes) changed.add(cap.capabilityId);
        }
      }
    }
    const wanted = new Set(plan.enabledModules);
    const currentActive = [...this.slots.entries()]
      .filter(([, slot]) => slot.state === "active" || slot.state === "activating")
      .map(([id]) => id);
    const stopOrder = currentActive.filter((id) => !wanted.has(id) || rebound.has(id));
    const oldOrder = this.profile ? planComposition(this.getManifests(), this.profile).activationOrder : currentActive;
    stopOrder.sort((a, b) => oldOrder.indexOf(b) - oldOrder.indexOf(a));
    for (const id of stopOrder) await this.deactivate(id);
    for (const id of rebound) this.must(id).bindingEpoch += 1;
    const startOrder = plan.enabledModules.filter((id) => this.must(id).state !== "active");
    startOrder.sort((a, b) => plan.activationOrder.indexOf(a) - plan.activationOrder.indexOf(b));
    try {
      for (const id of startOrder) await this.activate(id);
      this.profile = profile;
      this.lastValidProfile = profile;
    } catch (error) {
      for (const id of [...startOrder].reverse()) {
        const slot = this.must(id);
        if (slot.state !== "disabled" && slot.state !== "discovered") {
          await this.deactivate(id).catch(() => undefined);
        }
      }
      if (rollback && previous) {
        try { await this.applyProfileNow(previous, false); }
        catch (recoveryError) { throw new AggregateError([error, recoveryError], "profile switch and rollback failed"); }
      }
      throw error;
    }
  }

  async restoreLastValid(): Promise<void> {
    if (!this.lastValidProfile) {
      throw new MangaError("ACTIVATION_FAILED", "no last valid profile");
    }
    await this.applyProfile(this.lastValidProfile);
  }

  async activate(moduleId: string): Promise<void> {
    const slot = this.must(moduleId);
    if (slot.state === "failed" && slot.scope.size > 0) throw new MangaError("RESTART_REQUIRED","failed cleanup left resources; restart required");
    if (slot.stopping) await slot.stopping;
    if (slot.state === "active") return;
    if (slot.activating) return slot.activating;
    slot.state = "activating";
    const work = this.runActivate(slot);
    slot.activating = work;
    try {
      await work;
      slot.state = "active";
    } catch (error) {
      slot.state = "failed";
      this.removeCommands(slot);
      let cleanupError;
      try { await slot.scope.stop(); } catch (failure) { cleanupError = failure; }
      if (!cleanupError) slot.scope = new ResourceScope();
      if (cleanupError) throw new AggregateError([error, cleanupError], "activation and cleanup failed");
      throw error;
    } finally {
      slot.activating = undefined;
    }
  }

  async deactivate(moduleId: string): Promise<void> {
    const slot = this.must(moduleId);
    if (slot.activating) { try { await slot.activating; } catch { /* cleanup below */ } }
    if (slot.state === "disabled" || slot.state === "discovered") return;
    if (slot.stopping) return slot.stopping;
    slot.state = "draining";
    this.gateway.cancelCommands(slot.commands);
    slot.epoch += 1;
    this.registryGeneration += 1;
    const work = this.runDeactivate(slot);
    slot.stopping = work;
    try {
      await work;
      slot.state = "disabled";
    } catch (error) {
      slot.state = "failed";
      throw error;
    } finally {
      slot.stopping = undefined;
    }
  }

  bumpUnrelatedRegistry(): void {
    this.registryGeneration += 1;
  }

  private async runActivate(slot: ModuleSlot): Promise<void> {
    const ctx = this.context(slot);
    await slot.module.activate(ctx);
  }

  private async runDeactivate(slot: ModuleSlot): Promise<void> {
    await this.drainLeases(slot.module.manifest.moduleId);
    const ctx = this.context(slot);
    const errors: unknown[] = [];
    try { await slot.module.deactivate(ctx); } catch (error) { errors.push(error); }
    try { await slot.scope.stop(); } catch (error) { errors.push(error); }
    this.removeCommands(slot);
    if (errors.length) throw new AggregateError(errors, "module cleanup failed; restart required");
    slot.scope = new ResourceScope();
  }

  private removeCommands(slot: ModuleSlot): void {
    for (const commandId of slot.commands) {
      this.gateway.unregister(commandId);
      this.commandOwner.delete(commandId);
    }
    slot.commands = [];
  }

  private context(slot: ModuleSlot): ModuleContext {
    const epoch = slot.epoch;
    const bindingEpoch = slot.bindingEpoch;
    const scope = slot.scope;
    return {
      moduleId: slot.module.manifest.moduleId,
      epoch: slot.epoch,
      bindingEpoch: slot.bindingEpoch,
      facet: "service",
      hostFacets: this.hostFacets,
      isCurrent: () => this.must(slot.module.manifest.moduleId).epoch === epoch
        && this.must(slot.module.manifest.moduleId).bindingEpoch === bindingEpoch
        && this.must(slot.module.manifest.moduleId).state === "active",
      register: (handle: ResourceHandle) => {
        if (slot.epoch !== epoch || !["activating", "active"].includes(slot.state)) throw new Error("stale activation scope");
        return scope.register(handle);
      },
    };
  }

  private isAdmitted(commandId: string): boolean {
    const owner = this.commandOwner.get(commandId);
    if (!owner) return false;
    const slot = this.slots.get(owner);
    return slot?.state === "active";
  }

  private epochForCommand(commandId: string) {
    const owner = this.commandOwner.get(commandId);
    const slot = owner ? this.slots.get(owner) : undefined;
    return {
      moduleEpoch: slot?.epoch ?? 0,
      bindingEpoch: slot?.bindingEpoch ?? 0,
      registryGeneration: this.registryGeneration,
    };
  }

  private acquireLease(envelope: CommandEnvelope): { release: () => void } {
    const owner = this.commandOwner.get(envelope.commandId);
    const slot = owner ? this.slots.get(owner) : undefined;
    if (!slot || slot.state !== "active") {
      throw new MangaError("CAPABILITY_UNAVAILABLE", "module is not active");
    }
    if (envelope.moduleEpoch !== undefined && envelope.moduleEpoch !== slot.epoch) {
      throw new MangaError("EPOCH_MISMATCH", "lease refused for stale epoch");
    }
    const id = envelope.requestId || createId("lease");
    if (this.leases.has(id)) throw new MangaError("VALIDATION_ERROR", "duplicate request id");
    this.leases.set(id, owner!);
    return {
      release: () => {
        this.leases.delete(id);
      },
    };
  }

  private async drainLeases(moduleId: string): Promise<void> {
    const gate = this.pauseGates.get(`drain:${moduleId}`);
    if (gate) await gate;
    const started = Date.now();
    while ([...this.leases.values()].includes(moduleId)) {
      if (Date.now() - started >= 5_000) throw new MangaError("RESTART_REQUIRED", "active invocation did not stop; module is not disabled");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  private must(moduleId: string): ModuleSlot {
    const slot = this.slots.get(moduleId);
    if (!slot) throw new MangaError("NOT_FOUND", `unknown module ${moduleId}`);
    return slot;
  }
}

export { planComposition } from "./planner.ts";
export { CommandGateway } from "./gateway.ts";
export { SequencedBus } from "./bus.ts";
export { ResourceScope } from "./scope.ts";
