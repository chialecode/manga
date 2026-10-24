import type { DockviewApi, DockviewGroupPanel } from "dockview-react";
import { PRESET_COLUMNS, type WorkspacePreset } from "@manga/contracts";
import { distribute, groupPanels } from "./model.ts";

/** The narrowest a column may be (A-95), and the most columns there can be. */
export const MIN_COLUMN_WIDTH = 320;
export const MIN_COLUMN_HEIGHT = 160;
export const MAX_COLUMNS = 4;

/** The preset a number of columns is: the layout menu marks the one that matches what is on screen. */
export function presetOfCount(count: number): WorkspacePreset {
  return count >= 4 ? "quad" : count === 3 ? "three" : count === 2 ? "two" : "single";
}

/** The columns in reading order: left to right, then top to bottom. */
export function columnsOf(api: DockviewApi): DockviewGroupPanel[] {
  const ordered = groupPanels(api.toJSON()).map((entry) => api.groups.find((group) => group.id === entry.id)).filter((group): group is DockviewGroupPanel => Boolean(group));
  const known = new Set(ordered.map((group) => group.id));
  return [...ordered, ...api.groups.filter((group) => !known.has(group.id))];
}

/** Every panel in reading order: the tabs of the first column, then the second, … */
export function panelsInOrder(api: DockviewApi): string[] {
  return groupPanels(api.toJSON()).flatMap((entry) => entry.panels);
}

/**
 * Puts the panels into the shape of a preset (A-95): they are moved between groups, never made again, so a playing video keeps playing. All panels
 * first go into the first column; the columns of the preset are then made around it and the panels are dealt out over them in order — four tabs over
 * three columns are 2, 1, 1. A preset with more columns than tabs leaves the last columns empty.
 */
export function applyPreset(api: DockviewApi, preset: WorkspacePreset): void {
  const columns = PRESET_COLUMNS[preset];
  const before = groupPanels(api.toJSON());
  const sequence = before.flatMap((entry) => entry.panels);
  const active = api.activePanel?.id ?? null;
  const anchor = (before[0] && api.groups.find((group) => group.id === before[0]!.id)) ?? api.addGroup();
  // 1. Everything in one column.
  for (const entry of before.slice(1)) {
    const group = api.groups.find((item) => item.id === entry.id);
    if (!group) continue;
    for (const id of entry.panels) api.getPanel(id)?.api.moveTo({ group: anchor, skipSetActive: true });
    if (api.groups.includes(group) && group.panels.length === 0) api.removeGroup(group);
  }
  // 2. The columns of the preset, in reading order.
  const groups: DockviewGroupPanel[] = [anchor];
  if (preset === "two") groups.push(api.addGroup({ referenceGroup: anchor, direction: "right" }));
  else if (preset === "three") {
    const second = api.addGroup({ referenceGroup: anchor, direction: "right" });
    groups.push(second, api.addGroup({ referenceGroup: second, direction: "right" }));
  } else if (preset === "quad") {
    const bottom = api.addGroup({ referenceGroup: anchor, direction: "below" });
    const topRight = api.addGroup({ referenceGroup: anchor, direction: "right" });
    const bottomRight = api.addGroup({ referenceGroup: bottom, direction: "right" });
    groups.push(topRight, bottom, bottomRight);
  }
  // 3. The panels, dealt out in order.
  const dealt = distribute(sequence, columns);
  dealt.forEach((ids, column) => {
    const group = groups[column];
    if (!group || column === 0) return;
    ids.forEach((id, index) => api.getPanel(id)?.api.moveTo({ group, index, skipSetActive: true }));
  });
  // 4. Equal columns and rows.
  const cols = preset === "single" ? 1 : preset === "quad" ? 2 : columns;
  const width = Math.floor(api.width / cols);
  const height = Math.floor(api.height / (preset === "quad" ? 2 : 1));
  if (preset !== "single" && width > 0) for (const group of groups) group.api.setSize({ width, ...(preset === "quad" && height > 0 ? { height } : {}) });
  // Each column shows the tab it showed, or its first; the tab that was in front stays the one in front.
  for (const group of groups) if (!group.activePanel && group.panels[0]) group.panels[0].api.setActive();
  if (active) api.getPanel(active)?.api.setActive();
}

/** Whether a drop would make a column of its own: onto the edge of the window, or onto the side of a column. */
export function dropMakesColumn(kind: string, position: string | undefined): boolean {
  return kind === "edge" || (kind === "content" && position !== undefined && position !== "center");
}
