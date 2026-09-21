import {
  MangaError,
  ModuleManifestSchema,
  type Binding,
  type CompositionPlan,
  type ModuleManifest,
  type ProfileConfig,
} from "@manga/contracts";

export type CapabilityIndex = Map<string, ModuleManifest[]>;

export function indexCapabilities(manifests: ModuleManifest[]): CapabilityIndex {
  const index: CapabilityIndex = new Map();
  const ids = new Set<string>();
  for (const manifest of manifests) {
    ModuleManifestSchema.parse(manifest);
    if(ids.has(manifest.moduleId)) throw new MangaError("VALIDATION_ERROR",`duplicate module ${manifest.moduleId}`);
    ids.add(manifest.moduleId);
    for (const cap of manifest.contributes) {
      const list = index.get(cap.capabilityId) ?? [];
      list.push(manifest);
      index.set(cap.capabilityId, list);
    }
  }
  return index;
}

function sortIds(ids: string[]): string[] {
  return [...ids].sort((a, b) => a.localeCompare(b));
}

export function planComposition(
  manifests: ModuleManifest[],
  profile: ProfileConfig,
): CompositionPlan {
  const byId = new Map(manifests.map((item) => [item.moduleId, item]));
  const index = indexCapabilities(manifests);
  const disabled = new Set(profile.disabledFeatures);
  const wantedFeatures = profile.enabledFeatures.filter((id) => !disabled.has(id));
  const selected = new Set<string>();
  const diagnostics: string[] = [];
  const bindings: Binding[] = [];
  const activationOrder: string[] = [];

  const featureModules = manifests.filter((item) => wantedFeatures.includes(item.featureId));
  for (const item of featureModules) selected.add(item.moduleId);

  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (moduleId: string) => {
    if (visited.has(moduleId)) return;
    if (visiting.has(moduleId)) {
      throw new MangaError("DEPENDENCY_UNSATISFIED", `cyclic dependency involving ${moduleId}`, {
        details: { moduleId },
      });
    }
    const manifest = byId.get(moduleId);
    if (!manifest) {
      throw new MangaError("DEPENDENCY_UNSATISFIED", `unknown module ${moduleId}`, {
        details: { moduleId },
      });
    }
    if (disabled.has(manifest.featureId)) {
      throw new MangaError("DEPENDENCY_UNSATISFIED", `required feature ${manifest.featureId} is explicitly disabled`, {
        details: { featureId: manifest.featureId, moduleId },
      });
    }
    visiting.add(moduleId);
    for (const need of manifest.needs ?? []) {
      const providers = (index.get(need.capabilityId) ?? [])
        .filter((item) => !disabled.has(item.featureId))
        .filter((item) => item.contributes.some((cap) => cap.capabilityId === need.capabilityId && cap.version === need.version))
        .sort((a, b) => a.moduleId.localeCompare(b.moduleId));
      const preferred = profile.preferredProviders[need.capabilityId] ?? [];
      if (preferred.some((id) => !providers.some((provider) => provider.moduleId === id))) {
        throw new MangaError("API_INCOMPATIBLE", `selected provider missing, disabled or incompatible: ${need.capabilityId}`);
      }
      const ordered = [
        ...providers.filter((item) => preferred.includes(item.moduleId)),
        ...(preferred.length ? [] : providers),
      ];
      if (need.cardinality === "single") {
        if (ordered.length === 0) {
          if (need.required) {
            throw new MangaError("DEPENDENCY_UNSATISFIED", `missing provider for ${need.capabilityId}`, {
              details: { capabilityId: need.capabilityId, consumer: moduleId },
            });
          }
          diagnostics.push(`optional ${need.capabilityId} missing for ${moduleId}`);
          continue;
        }
        if (ordered.length > 1) {
          throw new MangaError("DEPENDENCY_UNSATISFIED", `ambiguous single provider for ${need.capabilityId}`, {
            details: {
              capabilityId: need.capabilityId,
              providers: ordered.map((item) => item.moduleId),
            },
          });
        }
        const chosen = ordered[0]!;
        selected.add(chosen.moduleId);
        bindings.push({
          capabilityId: need.capabilityId,
          providerModuleId: chosen.moduleId,
          instanceId: `${need.capabilityId}:${chosen.moduleId}`,
        });
        visit(chosen.moduleId);
      } else {
        if (need.required && ordered.length === 0) {
          throw new MangaError("DEPENDENCY_UNSATISFIED", `missing many-provider for ${need.capabilityId}`, {
            details: { capabilityId: need.capabilityId, consumer: moduleId },
          });
        }
        for (const chosen of ordered) {
          selected.add(chosen.moduleId);
          bindings.push({
            capabilityId: need.capabilityId,
            providerModuleId: chosen.moduleId,
            instanceId: `${need.capabilityId}:${chosen.moduleId}`,
          });
          visit(chosen.moduleId);
        }
      }
    }
    visiting.delete(moduleId);
    visited.add(moduleId);
    activationOrder.push(moduleId);
  };

  for (const moduleId of sortIds([...selected])) visit(moduleId);

  for (const moduleId of selected) {
    const manifest = byId.get(moduleId)!;
    for (const other of manifest.conflictsWith ?? []) {
      if (selected.has(other)) {
        throw new MangaError("BUNDLE_CONFLICT", `${moduleId} conflicts with ${other}`, {
          details: { moduleId, other, chain: [moduleId, other] },
        });
      }
    }
  }

  const enabledModules = sortIds([...selected]);
  return {
    activationOrder,
    enabledModules,
    disabledModules: sortIds(manifests.map((item) => item.moduleId).filter((id) => !selected.has(id))),
    bindings,
    diagnostics,
    hotReload: "rebuild",
  };
}
