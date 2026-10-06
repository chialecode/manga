import type { Translator } from "@manga/i18n";
import type { SourceCard } from "../lib/types.ts";

type T = Translator["t"];

/** Where a note's source landed: the status of the jump and the way back to the note. Shared by every reader. */
export function SourceBanner(props: { t: T; card: SourceCard; testPrefix: string; onBackToNote: () => void; onRepair: () => void }) {
  const { t, card } = props;
  const status = card.status === "resolved" ? t("reading.sourceResolved") : card.status === "needs_review" ? t("reading.sourceNeedsReview") : t("reading.sourceMissing");
  return (
    <section className="reader-source" data-testid={`${props.testPrefix}-source-card`} data-source-status={card.status}>
      <h2>{t("reading.sourceCard")}</h2>
      <p data-testid={`${props.testPrefix}-source-status`}>{status}</p>
      {card.title ? <p>{card.title}{card.partTitle ? ` · ${card.partTitle}` : ""}</p> : null}
      {card.quote ? <blockquote data-testid={`${props.testPrefix}-source-quote`}>{card.quote}</blockquote> : null}
      <div className="reader-source-actions">
        <button type="button" className="secondary-button" data-testid={`${props.testPrefix}-source-back`} onClick={props.onBackToNote}>{t("reading.sourceBack")}</button>
        {card.available === false || card.status !== "resolved" ? (
          <button type="button" className="secondary-button" data-testid={`${props.testPrefix}-source-repair`} onClick={props.onRepair}>{t("reading.sourceRepair")}</button>
        ) : null}
      </div>
    </section>
  );
}
