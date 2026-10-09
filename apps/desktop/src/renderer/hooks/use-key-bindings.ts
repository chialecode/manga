import { useCallback, useEffect, useMemo, useState } from "react";
import { resolveKeys, type KeyOverrides } from "@manga/contracts/keys";
import { attempt } from "../lib/api.ts";

/**
 * The person's own keys. They are kept with the media settings; the table the readers use is the defaults with these laid over them.
 * `save` returns the reason a change was refused (a key two actions would share), or null when it was kept.
 */
export function useKeyBindings() {
  const [overrides, setOverrides] = useState<KeyOverrides>({});
  useEffect(() => {
    let cancelled = false;
    void attempt<{ keys?: KeyOverrides }>("settings.getMedia").then((saved) => {
      if (!cancelled && saved.ok && saved.value.keys) setOverrides(saved.value.keys);
    });
    return () => { cancelled = true; };
  }, []);
  const save = useCallback(async (patch: Record<string, string[] | null>): Promise<string | null> => {
    const result = await attempt<{ keys?: KeyOverrides }>("settings.setMedia", { keys: patch });
    if (!result.ok) return result.error.message;
    setOverrides(result.value.keys ?? {});
    return null;
  }, []);
  const table = useMemo(() => resolveKeys(overrides), [overrides]);
  return { overrides, table, save };
}
