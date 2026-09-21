import type {
  ModuleManifest,
  ResourceHandle,
  Facet,
} from "@manga/contracts";

export type Disposer = () => Promise<void> | void;

export interface ModuleContext {
  moduleId: string;
  epoch: number;
  bindingEpoch: number;
  facet: Facet;
  register(handle: ResourceHandle): Disposer;
  isCurrent(): boolean;
}

export interface MangaModule {
  manifest: ModuleManifest;
  activate(ctx: ModuleContext): Promise<void> | void;
  deactivate(ctx: ModuleContext): Promise<void> | void;
  contribute?(capabilityId: string): unknown;
}

export function defineModule(module: MangaModule): MangaModule {
  return module;
}
