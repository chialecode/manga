import { useState, type CSSProperties } from "react";
import { Check, ChevronDown, ChevronUp, RotateCcw, X } from "lucide-react";
import type { DictationReplacement, DictionarySuggestionItem } from "@manga/contracts";
import type { Translator } from "@manga/i18n";

type T = Translator["t"];

export type PillState = {
  id: string;
  polished: boolean;
  canRevert: boolean;
  rawText: string;
  finalText: string;
  replacements: DictationReplacement[];
  suggestion: DictionarySuggestionItem | null;
  anchorRect: { left: number; bottom: number } | null;
};

/**
 * Post-insert inline pill shown near the insertion target for 10 seconds after dictation completes (U1, H1):
 * offers one-click revert to raw ASR text, expandable dictionary replacement attributions, and inline confirmation
 * for terms learned from user edits. Suppresses mousedown focus steal so active editors never blur.
 */
export function DictationPill(props: {
  t: T;
  pill: PillState | null;
  onRevert: () => void;
  onDecideSuggestion: (suggestionId: string, action: "accept" | "ignore") => void;
  onDismiss: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { t, pill } = props;
  if (!pill) return null;

  const hasRevertOrTerms = pill.canRevert || pill.replacements.length > 0;
  if (!hasRevertOrTerms && !pill.suggestion) return null;

  const style: CSSProperties = pill.anchorRect
    ? { left: `${Math.round(pill.anchorRect.left)}px`, bottom: `${Math.round(pill.anchorRect.bottom)}px` }
    : { left: "50%", bottom: "64px", transform: "translateX(-50%)" };

  const statusText = pill.polished ? t("dictation.pill.polished") : t("dictation.pill.replaced");

  return (
    <div
      className="dictation-pill"
      style={style}
      role="status"
      aria-live="polite"
      data-testid="dictation-pill"
      onMouseDown={(event) => event.preventDefault()}
    >
      {hasRevertOrTerms ? (
        <div className="dictation-pill-row">
          <span className="dictation-pill-label" data-testid="dictation-pill-status">{statusText}</span>
          {pill.canRevert ? (
            <>
              <span aria-hidden="true">·</span>
              <button
                type="button"
                className="dictation-pill-link"
                data-testid="dictation-pill-revert"
                onMouseDown={(event) => event.preventDefault()}
                onClick={props.onRevert}
              >
                <RotateCcw size={12} />
                {t("dictation.pill.revert")}
              </button>
            </>
          ) : null}
          {pill.replacements.length > 0 ? (
            <button
              type="button"
              className="dictation-pill-link"
              data-testid="dictation-pill-terms-toggle"
              aria-expanded={expanded}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setExpanded((current) => !current)}
            >
              {t("dictation.pill.replacements", { count: pill.replacements.length })}
              {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </button>
          ) : null}
          <button
            type="button"
            className="dictation-pill-close"
            data-testid="dictation-pill-dismiss"
            aria-label={t("dictation.pill.dismiss")}
            title={t("dictation.pill.dismiss")}
            onMouseDown={(event) => event.preventDefault()}
            onClick={props.onDismiss}
          >
            <X size={13} />
          </button>
        </div>
      ) : null}

      {expanded && pill.replacements.length > 0 ? (
        <ul className="dictation-pill-terms" data-testid="dictation-pill-terms">
          {pill.replacements.map((item, index) => (
            <li key={`${item.termId ?? index}:${item.start}`} data-testid={`dictation-pill-term-${index}`}>
              <span className="detail-muted">{item.original}</span>
              <span aria-hidden="true"> → </span>
              <strong>{item.replacement}</strong>
              {item.term !== item.replacement ? <span className="detail-muted">{` (${item.term})`}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}

      {pill.suggestion ? (
        <div className="dictation-pill-suggestion" data-testid="dictation-pill-suggestion">
          <span>{t("dictation.pill.suggestion", { term: pill.suggestion.term, heard: pill.suggestion.heard })}</span>
          <button
            type="button"
            className="dictation-pill-link"
            data-testid="dictation-pill-suggestion-accept"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => props.onDecideSuggestion(pill.suggestion!.id, "accept")}
          >
            <Check size={12} />
            {t("dictation.pill.accept")}
          </button>
          <button
            type="button"
            className="dictation-pill-link"
            data-testid="dictation-pill-suggestion-ignore"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => props.onDecideSuggestion(pill.suggestion!.id, "ignore")}
          >
            {t("dictation.pill.ignore")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
