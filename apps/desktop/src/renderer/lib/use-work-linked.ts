import { useEffect, useState } from "react";
import { attempt } from "./api.ts";

/**
 * Whether a work is linked to an online entry: true or false once known, null while unknown (no work, the lookup is off, or it
 * has not answered). `version` changes when something may have linked it, so the answer is asked again.
 */
export function useWorkLinked(workId: string | null | undefined, enabled: boolean, version: number): boolean | null {
  const [state, setState] = useState<{ workId: string; linked: boolean } | null>(null);
  useEffect(() => {
    if (!workId || !enabled) return;
    let cancelled = false;
    void attempt<{ linked?: boolean }>("works.get", { workId }).then((result) => {
      if (!cancelled && result.ok) setState({ workId, linked: result.value.linked === true });
    });
    return () => { cancelled = true; };
  }, [workId, enabled, version]);
  return workId && enabled && state?.workId === workId ? state.linked : null;
}
