import type { Translator } from "@manga/i18n";
import { wordDiff } from "./draft-model.ts";

type T = Translator["t"];

/** Two texts as one, with what was added and what was taken out marked, so a change can be judged before it is taken. */
export function DiffText(props: { t: T; before: string; after: string; testId?: string; empty?: string; tooLarge?: string }) {
  const { t } = props;
  const parts = wordDiff(props.before, props.after);
  if (!parts) return <p className="detail-muted" data-testid={props.testId}>{props.tooLarge ?? t("draft.s.diffTooLarge")}</p>;
  if (parts.every((part) => part.kind === "same")) return <p className="detail-muted" data-testid={props.testId}>{props.empty ?? t("draft.s.diffNone")}</p>;
  return (
    <div className="draft-diff" data-testid={props.testId}>
      {parts.map((part, index) => part.kind === "same" ? <span key={index}>{part.text}</span>
        : part.kind === "add" ? <ins key={index} aria-label={t("draft.diffInsert")} data-diff="add">{part.text}</ins>
          : <del key={index} aria-label={t("draft.diffDelete")} data-diff="del">{part.text}</del>)}
    </div>
  );
}
