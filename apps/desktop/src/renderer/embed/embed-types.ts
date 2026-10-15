import type { Translator } from "@manga/i18n";

export type EmbedKind = "note" | "whiteboard" | "mindmap";
export type EmbedState = "valid" | "deleted" | "disabled" | "denied" | "cycle";
export type EmbedRecovery = "open" | "enable" | "remove" | "keepSnapshot" | "refresh";
export type EmbedLocator = { blockId?: string; nodeId?: string };

/** What the page shows for one embed: the state, a readable line even when the target cannot be shown, and what can be done about it. */
export type EmbedItem = {
  id: string; slot: string; sourceKind: EmbedKind; sourceId: string; targetKind: EmbedKind; targetId: string; locator: EmbedLocator;
  mode: "live" | "snapshot"; state: EmbedState; title: string; summary: string; takenAt: string | null; recovery: EmbedRecovery[];
};

/** What a note block of type `embed` carries in its attributes. `label` is only shown until the embed has been resolved. */
export type EmbedAttr = { kind: EmbedKind; targetId: string; locator?: EmbedLocator; mode?: "live" | "snapshot"; label?: string };

export type EmbedHost = {
  t: Translator["t"];
  formatDate: (iso: string) => string;
  items: Record<string, EmbedItem>;
  onOpen: (item: EmbedItem) => void;
  onEnable: (item: EmbedItem) => void;
  onRefresh: (blockId: string) => void;
  onRemove: (blockId: string) => void;
  onKeepSnapshot: (blockId: string, item: EmbedItem) => void;
};
