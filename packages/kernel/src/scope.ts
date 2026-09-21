import type { ResourceHandle } from "@manga/contracts";

export class ResourceScope {
  private readonly handles = new Map<string, ResourceHandle>();
  private stopping = false;
  private stopPromise: Promise<void> | undefined;
  private readonly counts = new Map<ResourceHandle["kind"], number>();

  get activeCounts(): Record<string, number> {
    return Object.fromEntries(this.counts);
  }

  get size(): number {
    return this.handles.size;
  }

  register(handle: ResourceHandle): () => Promise<void> {
    if (this.stopping) {
      throw new Error(`scope is stopping; cannot register ${handle.kind}:${handle.id}`);
    }
    if (this.handles.has(handle.id)) throw new Error(`duplicate resource ${handle.id}`);
    this.handles.set(handle.id, handle);
    this.counts.set(handle.kind, (this.counts.get(handle.kind) ?? 0) + 1);
    let releasePromise: Promise<void> | undefined;
    return () => {
      return releasePromise ??= this.release(handle.id);
    };
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.stopPromise = this.releaseAll();
    return this.stopPromise;
  }

  private async release(id: string): Promise<void> {
    const handle = this.handles.get(id);
    if (!handle) return;
    await handle.dispose();
    this.handles.delete(id);
    this.counts.set(handle.kind, Math.max(0, (this.counts.get(handle.kind) ?? 1) - 1));
  }

  private async releaseAll(): Promise<void> {
    const errors: unknown[] = [];
    for (const handle of [...this.handles.values()].reverse()) {
      try { await this.release(handle.id); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "resource cleanup failed; restart required");
  }
}
