import { useCallback, useEffect, useRef, useState } from "react";
import { asArray, attempt } from "../lib/api.ts";
import type { EmbedItem } from "./embed-types.ts";

/** The embeds one note holds, by block id. `reload` is called after the note was saved, since saving is what registers them. */
export function useNoteEmbeds(objectId: string | null, enabled: boolean) {
  const [items, setItems] = useState<Record<string, EmbedItem>>({});
  const current = useRef(objectId);
  current.current = objectId;

  const reload = useCallback(async () => {
    const id = current.current;
    if (!enabled || !id) { setItems({}); return; }
    const result = await attempt<{ embeds: EmbedItem[] }>("embed.list", { sourceKind: "note", sourceId: id });
    // A reply for a note that is no longer open is dropped.
    if (current.current !== id) return;
    setItems(result.ok ? Object.fromEntries(asArray<EmbedItem>(result.value.embeds).map((item) => [item.slot, item])) : {});
  }, [enabled]);

  useEffect(() => { void reload(); }, [reload, objectId]);
  return { items, reload };
}
