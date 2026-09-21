import type { ModuleManifest, ProfileConfig } from "@manga/contracts";
import type { MangaModule } from "@manga/plugin-sdk";

export class MinimalActivator {
  readonly active = new Set<string>();
  readonly leaked: string[] = [];
  readonly modules: MangaModule[];
  constructor(modules: MangaModule[]) {
    this.modules = modules;
  }

  async apply(profile: ProfileConfig): Promise<void> {
    const wanted = new Set(profile.enabledFeatures);
    for (const module of this.modules) {
      if (wanted.has(module.manifest.featureId) && !this.active.has(module.manifest.moduleId)) {
        await module.activate({
          moduleId: module.manifest.moduleId,
          epoch: 1,
          bindingEpoch: 1,
          facet: "service",
          isCurrent: () => true,
          register: (handle) => {
            this.leaked.push(handle.id);
            return () => undefined;
          },
        });
        this.active.add(module.manifest.moduleId);
      }
    }
    for (const module of this.modules) {
      if (!wanted.has(module.manifest.featureId) && this.active.has(module.manifest.moduleId)) {
        this.active.delete(module.manifest.moduleId);
      }
    }
  }

  stillWritableAfterStop(): boolean {
    return this.leaked.length > 0;
  }
}

export function manifestsOf(modules: MangaModule[]): ModuleManifest[] {
  return modules.map((item) => item.manifest);
}
