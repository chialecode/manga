import { z } from "zod";
import { PLUGIN_PERMISSIONS } from "./plugin.ts";

const id = z.string().min(1).max(256);
const pluginId = z.string().min(2).max(64);

/** Where a package comes from: a file the person chose, or one the application carries. Exactly one. */
const source = z.object({ pathHandle: id.optional(), bundledId: pluginId.optional() }).strict()
  .refine((value) => Number(Boolean(value.pathHandle)) + Number(Boolean(value.bundledId)) === 1, { message: "name a file or a bundled plugin, not both and not neither" });

/** Input schemas for plugin packages (PLUG-04) and the keys the host trusts them by. */
export const PluginCommandInputs = {
  "plugin.list": z.object({}).strict(),
  "plugin.bundled": z.object({}).strict(),
  /** Reads a package and says what installing it would do, without changing anything. */
  "plugin.inspect": source,
  /** `grant` is what the person confirmed: it must cover every permission the package declares. */
  "plugin.install": z.object({ pathHandle: id.optional(), bundledId: pluginId.optional(), grant: z.array(z.enum(PLUGIN_PERMISSIONS)).max(PLUGIN_PERMISSIONS.length), enable: z.boolean().optional() }).strict()
    .refine((value) => Number(Boolean(value.pathHandle)) + Number(Boolean(value.bundledId)) === 1, { message: "name a file or a bundled plugin, not both and not neither" }),
  "plugin.enable": z.object({ pluginId }).strict(),
  "plugin.disable": z.object({ pluginId }).strict(),
  /** Goes back to the version kept from before the last upgrade. */
  "plugin.rollback": z.object({ pluginId }).strict(),
  /** Removes the plugin; what it kept stays unless the person says otherwise. */
  "plugin.uninstall": z.object({ pluginId, deleteData: z.boolean().optional() }).strict(),
  "plugin.exportData": z.object({ pluginId, pathHandle: id }).strict(),
  "plugin.deleteData": z.object({ pluginId }).strict(),
  "plugin.trust.list": z.object({}).strict(),
  /** `publicKey` is the 32 raw bytes in base64, as the publisher gives them. */
  "plugin.trust.add": z.object({ publicKey: z.string().min(40).max(200), label: z.string().trim().min(1).max(80) }).strict(),
  "plugin.trust.remove": z.object({ keyId: z.string().regex(/^[a-f0-9]{16}$/) }).strict(),
};
