import { X } from "lucide-react";
import type { Translator } from "@manga/i18n";
import type { Elsewhere } from "./elsewhere.ts";

/**
 * The line at the top of a reader that was opened in a context where the resource has not been started but another context has been in it (Q-33): where
 * it was seen, a button to go there, and a button to put the line away. Going there is the person's choice; the position is then this context's own.
 */
export function ElsewhereBar(props: { t: Translator["t"]; elsewhere: Elsewhere; onJump: () => void; onDismiss: () => void }) {
  const { t, elsewhere } = props;
  const percent = Math.max(0, Math.min(100, Math.round(elsewhere.percent * 100)));
  return (
    <div className="elsewhere-bar" role="status" data-testid="elsewhere-bar">
      <span className="truncate" data-testid="elsewhere-text">{t("elsewhere.seen", { context: elsewhere.contextName, position: `${percent}%` })}</span>
      <button type="button" className="link-button" data-testid="elsewhere-jump" onClick={props.onJump}>{t("elsewhere.jump")}</button>
      <button type="button" className="icon-button" data-testid="elsewhere-dismiss" aria-label={t("elsewhere.dismiss")} title={t("elsewhere.dismiss")} onClick={props.onDismiss}><X size={14} aria-hidden="true" /></button>
    </div>
  );
}
