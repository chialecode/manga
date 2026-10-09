import { useEffect, useState } from "react";
import type { Translator } from "@manga/i18n";
import { parseListRate, RATE_LIST_MAX, RATE_PRESETS } from "../readers/video-model.ts";

type T = Translator["t"];

/**
 * A rate in a text field. It keeps what is typed until Enter or the field is left, then hands the text over; `onCommit` answers with the reason
 * it was refused (the field stays marked and shows the text again) or null. Esc puts the old value back.
 */
function RateInput(props: { label: string; testId: string; value: number | null; onCommit: (text: string) => string | null }) {
  const shown = props.value === null ? "" : String(props.value);
  const [draft, setDraft] = useState(shown);
  const [refused, setRefused] = useState(false);
  useEffect(() => { setDraft(shown); setRefused(false); }, [shown]);
  const commit = () => {
    if (draft.trim() === shown) { setRefused(false); return; }
    if (props.value === null && draft.trim() === "") return;
    const reason = props.onCommit(draft);
    setRefused(reason !== null);
    if (reason === null && props.value === null) setDraft("");
  };
  return (
    <input
      type="text"
      inputMode="decimal"
      className="rate-input"
      data-testid={props.testId}
      aria-label={props.label}
      aria-invalid={refused || undefined}
      value={draft}
      placeholder={props.value === null ? "1.75" : undefined}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") { event.preventDefault(); commit(); }
        else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setDraft(shown); setRefused(false); }
      }}
    />
  );
}

/** The list of rates the player offers (A-78): add, change, remove; 1× stays. Each change is checked here and again where it is saved. */
export function RateList(props: { t: T; rates: readonly number[]; onChange: (rates: number[]) => void }) {
  const { t } = props;
  const [message, setMessage] = useState("");
  const fail = (text: string) => { setMessage(text); return text; };
  const sorted = (rates: number[]) => [...rates].sort((a, b) => a - b);

  /** `old` is the rate being changed, or null for a new one. */
  const commit = (old: number | null, text: string): string | null => {
    const rate = parseListRate(text);
    if (rate === null) return fail(t("msettings.videoRateInvalid"));
    if (props.rates.some((other) => other === rate && other !== old)) return fail(t("msettings.videoRateDuplicate", { rate }));
    if (old === null && props.rates.length >= RATE_LIST_MAX) return fail(t("msettings.videoRateFull"));
    props.onChange(sorted(old === null ? [...props.rates, rate] : props.rates.map((other) => (other === old ? rate : other))));
    setMessage("");
    return null;
  };

  return (
    <div className="rate-list" data-testid="msettings-rates">
      <ul className="rate-chips">
        {props.rates.map((rate) => (
          <li key={rate} className="rate-chip" data-testid={`msettings-rate-${String(rate).replace(".", "_")}`}>
            {rate === 1 ? (
              <span className="rate-fixed" title={t("msettings.videoRateFixed")}>1×</span>
            ) : (
              <>
                <RateInput label={t("video.rate")} testId={`msettings-rate-input-${String(rate).replace(".", "_")}`} value={rate} onCommit={(text) => commit(rate, text)} />
                <span aria-hidden="true">×</span>
                <button type="button" className="key-chip-remove" data-testid={`msettings-rate-remove-${String(rate).replace(".", "_")}`} aria-label={t("msettings.videoRateRemove", { rate })} title={t("msettings.videoRateRemove", { rate })} onClick={() => { props.onChange(props.rates.filter((other) => other !== rate)); setMessage(""); }}>−</button>
              </>
            )}
          </li>
        ))}
        <li className="rate-chip rate-new">
          <RateInput label={t("msettings.videoRateAddLabel")} testId="msettings-rate-new" value={null} onCommit={(text) => commit(null, text)} />
        </li>
      </ul>
      {message ? <p className="key-message" role="alert" data-testid="msettings-rate-error">{message}</p> : null}
      <button type="button" className="link-button" data-testid="msettings-rate-reset" onClick={() => { props.onChange([...RATE_PRESETS]); setMessage(""); }}>{t("msettings.videoRateReset")}</button>
    </div>
  );
}

/** The custom rate the switch key goes to from 1×. */
export function CustomRate(props: { t: T; value: number; onChange: (rate: number) => void }) {
  const [message, setMessage] = useState("");
  return (
    <>
      <RateInput
        label={props.t("msettings.videoCustomRate")}
        testId="msettings-video-custom"
        value={props.value}
        onCommit={(text) => {
          const rate = parseListRate(text);
          if (rate === null) { const reason = props.t("msettings.videoRateInvalid"); setMessage(reason); return reason; }
          setMessage("");
          props.onChange(rate);
          return null;
        }}
      />
      {message ? <p className="key-message" role="alert" data-testid="msettings-custom-error">{message}</p> : null}
    </>
  );
}
