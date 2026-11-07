import { z } from "zod";

export const FacetSchema = z.enum(["service", "ui", "worker"]);
export type Facet = z.infer<typeof FacetSchema>;

export const CapabilityRefSchema = z.object({
  capabilityId: z.string().min(1),
  version: z.string().min(1),
  cardinality: z.enum(["single", "many"]).default("single"),
  required: z.boolean().default(true),
});

export type CapabilityRef = z.input<typeof CapabilityRefSchema>;

export const ModuleManifestSchema = z.object({
  moduleId: z.string().min(1),
  version: z.string().min(1),
  displayName: z.string().min(1),
  featureId: z.string().min(1),
  contributes: z.array(z.object({
    capabilityId: z.string().min(1),
    version: z.string().min(1),
    cardinality: z.enum(["single", "many"]).default("single"),
  })),
  needs: z.array(CapabilityRefSchema).default([]),
  facets: z.array(FacetSchema).default(["service"]),
  conflictsWith: z.array(z.string()).default([]),
  ownerModuleIds: z.array(z.string()).default([]),
});

export type ModuleManifest = z.input<typeof ModuleManifestSchema>;

export type ModuleState =
  | "discovered"
  | "disabled"
  | "resolving"
  | "blocked"
  | "activating"
  | "active"
  | "draining"
  | "failed";

export type Binding = {
  capabilityId: string;
  providerModuleId: string;
  instanceId: string;
};

export type CompositionPlan = {
  activationOrder: string[];
  enabledModules: string[];
  disabledModules: string[];
  bindings: Binding[];
  diagnostics: string[];
  hotReload: "none" | "rebuild" | "restart-required";
};

export type ProfileConfig = {
  profileId: string;
  revision: number;
  enabledFeatures: string[];
  disabledFeatures: string[];
  preferredProviders: Record<string, string[]>;
  bundleId?: string;
};

export const ProfileConfigSchema = z.object({
  profileId:z.string().min(1), revision:z.number().int().positive(),
  enabledFeatures:z.array(z.string().min(1)), disabledFeatures:z.array(z.string().min(1)),
  preferredProviders:z.record(z.array(z.string().min(1))), bundleId:z.string().optional(),
}).strict();

export type ResourceHandle = {
  kind: "subscription" | "timer" | "thread" | "task" | "device" | "ipc" | "worker";
  id: string;
  dispose: () => Promise<void> | void;
};
