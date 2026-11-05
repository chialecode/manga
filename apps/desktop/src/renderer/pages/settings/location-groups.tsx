import type { Translator } from "@manga/i18n";
import type { HostState } from "../../lib/api.ts";
import { SettingsRow } from "./rows.tsx";

type T = Translator["t"];

/** The three places data lives (A-118, 计划 4.9): what the application keeps for itself, what the person makes, and downloads. */
export const LOCATION_GROUPS = [
  { id: "app", partitions: ["data", "backups", "logs", "cache", "runtime"] },
  { id: "files", partitions: ["works", "projects", "attachments", "resources", "exports"] },
  { id: "downloads", partitions: ["downloads"] },
] as const;

/**
 * Every partition's actual folder, grouped. A partition that stayed where an older version kept it (or that the person moved) says so: it is named
 * by the pointer, not under the group's own root.
 */
export function LocationGroups(props: { t: T; layout: HostState["layout"] }) {
  const { t, layout } = props;
  const overrides = layout.overrides ?? {};
  return (
    <>
      {LOCATION_GROUPS.map((group) => (
        <div key={group.id} className="settings-location-group" role="group" aria-labelledby={`location-group-${group.id}`} data-testid={`location-group-${group.id}`}>
          <h4 id={`location-group-${group.id}`}>{t(`general.group.${group.id}`)}</h4>
          {group.partitions.map((name) => (
            <SettingsRow key={name} label={t(`general.partition.${name}`)} hint={overrides[name] ? t("general.partitionElsewhere") : undefined}>
              <span className="settings-path" data-testid={`location-path-${name}`} data-override={overrides[name] ? "true" : undefined}>{layout.partitions[name]}</span>
            </SettingsRow>
          ))}
        </div>
      ))}
    </>
  );
}
