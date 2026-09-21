import {
  CommandEnvelopeSchema,
  MangaError,
  UntrustedCommandSchema,
  createId,
  PROTOCOL_VERSION,
  COMMAND_VERSION,
  type Actor,
  type CommandEnvelope,
  type CommandResult,
} from "@manga/contracts";

export type CommandHandler = (envelope: CommandEnvelope, signal: AbortSignal) => Promise<unknown> | unknown;

export type GatewayHooks = {
  isCommandAdmitted: (commandId: string, envelope: CommandEnvelope) => boolean;
  getEpoch: (commandId: string) => { moduleEpoch: number; bindingEpoch: number; registryGeneration: number };
  loadIdempotent?: (key: string) => Promise<CommandResult | undefined> | CommandResult | undefined;
  saveIdempotent?: (key: string, result: CommandResult) => Promise<void> | void;
  acquireLease: (envelope: CommandEnvelope) => { release: () => void };
  trustedScope: (actor: Actor, requested: string) => boolean;
};

export class CommandGateway {
  private readonly handlers = new Map<string, CommandHandler>();
  private readonly inflight = new Map<string, AbortController>();
  private readonly inflightCommands = new Map<string, string>();
  private readonly hooks: GatewayHooks;

  constructor(hooks: GatewayHooks) {
    this.hooks = hooks;
  }

  register(commandId: string, handler: CommandHandler): void {
    this.handlers.set(commandId, handler);
  }

  unregister(commandId: string): void {
    this.handlers.delete(commandId);
  }

  has(commandId: string): boolean {
    return this.handlers.has(commandId);
  }

  admits(envelope: CommandEnvelope): boolean {
    return this.hooks.trustedScope(envelope.actor, envelope.scopeHandle) && this.hooks.isCommandAdmitted(envelope.commandId, envelope);
  }

  cancel(requestId: string): boolean {
    const controller = this.inflight.get(requestId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  cancelCommands(commandIds: string[]): void {
    for (const [requestId, commandId] of this.inflightCommands) {
      if (commandIds.includes(commandId)) this.cancel(requestId);
    }
  }

  sealFromTrusted(input: {
    untrusted: unknown;
    actor: Actor;
    scopeHandle: string;
    requestId?: string;
  }): CommandEnvelope {
    const parsed = UntrustedCommandSchema.parse(input.untrusted);
    const epochs = this.hooks.getEpoch(parsed.commandId);
    const envelope: CommandEnvelope = {
      protocolVersion: PROTOCOL_VERSION,
      requestId: input.requestId ?? createId("req"),
      commandId: parsed.commandId,
      commandVersion: parsed.commandVersion ?? COMMAND_VERSION,
      actor: input.actor,
      scopeHandle: input.scopeHandle,
      contextSnapshotId: parsed.contextSnapshotId,
      registryGeneration: epochs.registryGeneration,
      moduleEpoch: epochs.moduleEpoch,
      bindingEpoch: epochs.bindingEpoch,
      idempotencyKey: parsed.idempotencyKey,
      expectedRevisions: parsed.expectedRevisions,
      input: parsed.input,
    };
    return CommandEnvelopeSchema.parse(envelope);
  }

  async execute(envelope: CommandEnvelope): Promise<CommandResult> {
    CommandEnvelopeSchema.parse(envelope);
    if (!this.hooks.trustedScope(envelope.actor, envelope.scopeHandle)) {
      return fail("FORBIDDEN", "untrusted actor or scope");
    }
    if (!this.hooks.isCommandAdmitted(envelope.commandId, envelope)) {
      return fail("CAPABILITY_UNAVAILABLE", `command ${envelope.commandId} is not admitted`);
    }
    const current = this.hooks.getEpoch(envelope.commandId);
    if (
      envelope.moduleEpoch !== undefined && envelope.moduleEpoch !== current.moduleEpoch
      || envelope.bindingEpoch !== undefined && envelope.bindingEpoch !== current.bindingEpoch
    ) {
      return fail("EPOCH_MISMATCH", "stale module or binding epoch");
    }
    const existing = await this.hooks.loadIdempotent?.(envelope.idempotencyKey);
    if (existing) {
      return { ...existing, idempotentReplay: true };
    }
    const handler = this.handlers.get(envelope.commandId);
    if (!handler) {
      return fail("CAPABILITY_UNAVAILABLE", `no handler for ${envelope.commandId}`);
    }
    const controller = new AbortController();
    let lease: { release: () => void } | undefined;
    try {
      lease = this.hooks.acquireLease(envelope);
      this.inflight.set(envelope.requestId, controller);
      this.inflightCommands.set(envelope.requestId, envelope.commandId);
      const value = await handler(envelope, controller.signal);
      if (controller.signal.aborted) {
        return fail("CANCELLED", "request cancelled", true);
      }
      const result: CommandResult = { status: "ok", value };
      await this.hooks.saveIdempotent?.(envelope.idempotencyKey, result);
      return result;
    } catch (error) {
      if (error instanceof MangaError) {
        return {
          status: "error",
          error: error.toJSON(),
        };
      }
      if (controller.signal.aborted) {
        return fail("CANCELLED", "request cancelled", true);
      }
      const message = error instanceof Error ? error.message : String(error);
      return fail("VALIDATION_ERROR", message);
    } finally {
      lease?.release();
      this.inflight.delete(envelope.requestId);
      this.inflightCommands.delete(envelope.requestId);
    }
  }
}

function fail(code: string, message: string, retryable = false): CommandResult {
  return {
    status: "error",
    error: { code, message, retryable, details: {} },
  };
}
