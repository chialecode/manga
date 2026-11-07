import { useEffect, useState } from "react";
import { KEY_ACTIONS, MAX_CHORDS, chordLabel, chordOf, conflictsWith, keyAction, type KeyGroup } from "@manga/contracts/keys";
import type { MessageKey, Translator } from "@manga/i18n";
import type { useKeyBindings } from "../../hooks/use-key-bindings.ts";
import { keyLabel } from "../settings-media.tsx";
import { SettingsPage, SettingsRow, SettingsSection } from "./rows.tsx";

type T = Translator["t"];
type KeyBindings = ReturnType<typeof useKeyBindings>;

const GROUPS: readonly KeyGroup[] = ["global", "video", "comic", "novel"];
const nameOf = (t: T, id: string) => t(`keys.${id}` as MessageKey);

/** Waits for the next key and hands its chord over; Esc gives up. While it waits, the key belongs to it and nothing else in the window reacts. */
function useKeyCapture(waiting: boolean, onChord: (chord: string) => void, onCancel: () => void) {
  useEffect(() => {
    if (!waiting) return;
    const onKey = (event: KeyboardEvent) => {
      const chord = chordOf(event);
      // Tab moves the focus on and is never a reader's key.
      if (chord === "Tab") { onCancel(); return; }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.repeat || chord === null) return;
      if (chord === "Esc") { onCancel(); return; }
      onChord(chord);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [waiting, onChord, onCancel]);
}

function ActionRow(props: { t: T; id: string; keys: KeyBindings; adding: string | null; setAdding: (id: string | null) => void; message: (text: string) => void }) {
  const { t, id, keys } = props;
  const entry = keyAction(id)!;
  const chords = keys.table[id] ?? [];
  const changed = !entry.fixed && keys.overrides[id] !== undefined;
  const waiting = props.adding === id;

  const set = async (next: string[] | null) => {
    const refused = await keys.save({ [id]: next });
    props.message(refused ? t("shortcuts.refused", { reason: refused }) : "");
  };
  const onChord = (chord: string) => {
    props.setAdding(null);
    if (chords.includes(chord)) return;
    const other = conflictsWith(keys.table, id, chord)[0];
    if (other) { props.message(t("shortcuts.conflict", { key: chordLabel(chord), action: nameOf(t, other) })); return; }
    void set([...chords, chord]);
  };
  useKeyCapture(waiting, onChord, () => props.setAdding(null));

  const reset = () => {
    const withDefaults = { ...keys.table, [id]: [...entry.defaults] };
    for (const chord of entry.defaults) {
      const other = conflictsWith(withDefaults, id, chord)[0];
      if (other) { props.message(t("shortcuts.resetConflict", { key: chordLabel(chord), action: nameOf(t, other) })); return; }
    }
    void set(null);
  };

  return (
    <SettingsRow label={nameOf(t, id)} testId={`key-row-${id}`}>
      <div className="key-chips">
        {chords.length === 0 ? <span className="detail-muted" data-testid={`key-none-${id}`}>{t("shortcuts.none")}</span> : null}
        {chords.map((chord, index) => (
          <span key={chord} className="key-chip">
            <kbd data-testid={`key-chord-${id}-${index}`}>{chordLabel(chord)}</kbd>
            {entry.fixed ? null : (
              <button type="button" className="key-chip-remove" data-testid={`key-remove-${id}-${index}`} aria-label={t("shortcuts.remove", { key: chordLabel(chord) })} title={t("shortcuts.remove", { key: chordLabel(chord) })} onClick={() => void set(chords.filter((other) => other !== chord))}>×</button>
            )}
          </span>
        ))}
        {entry.fixed ? <span className="detail-muted">{t("shortcuts.fixed")}</span> : (
          <>
            <button type="button" className="secondary-button key-add" data-testid={`key-add-${id}`} aria-pressed={waiting} disabled={!waiting && chords.length >= MAX_CHORDS} title={chords.length >= MAX_CHORDS ? t("shortcuts.max", { count: MAX_CHORDS }) : undefined} onClick={() => props.setAdding(waiting ? null : id)} onBlur={() => { if (waiting) props.setAdding(null); }}>{waiting ? t("shortcuts.pressKey") : t("shortcuts.add")}</button>
            {changed ? <button type="button" className="link-button" data-testid={`key-reset-${id}`} onClick={reset}>{t("shortcuts.reset")}</button> : null}
          </>
        )}
      </div>
    </SettingsRow>
  );
}

/**
 * Settings › Shortcuts (A-78, Q-26): every key of the readers and the window, grouped by reader, from the same table the key handling reads.
 * A key is added by clicking Add and pressing it; a key two actions would share is refused with the name of the action that has it.
 */
export function ShortcutsPage(props: { t: T; keys: KeyBindings; recording: { holdKey: string; toggleKey: string }; onGoto: () => void }) {
  const { t, keys } = props;
  const [adding, setAdding] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const changed = Object.keys(keys.overrides).length;
  return (
    <SettingsPage id="shortcuts" title={t("settings.page.shortcuts")} hint={t("shortcuts.hint")}>
      <SettingsSection title={t("shortcuts.recording")} testId="shortcuts-recording">
        <SettingsRow label={t("msettings.holdKey")}><kbd data-testid="shortcut-hold">{keyLabel(props.recording.holdKey, t)}</kbd></SettingsRow>
        <SettingsRow label={t("msettings.toggleKey")}><kbd data-testid="shortcut-toggle">{keyLabel(props.recording.toggleKey, t)}</kbd></SettingsRow>
        <SettingsRow label={t("shortcuts.recordingChange")}>
          <button type="button" className="link-button" data-testid="shortcuts-goto-recording" onClick={props.onGoto}>{t("settings.page.recording")}</button>
        </SettingsRow>
      </SettingsSection>
      {message ? <p className="key-message" role="alert" data-testid="key-message">{message}</p> : null}
      {GROUPS.map((group, position) => (
        <SettingsSection
          key={group}
          title={t(`shortcuts.group.${group}`)}
          testId={`shortcuts-${group}`}
          actions={position === 0 ? <button type="button" className="secondary-button" data-testid="keys-reset-all" disabled={changed === 0} onClick={() => { void keys.save(Object.fromEntries(Object.keys(keys.overrides).map((id) => [id, null]))).then((refused) => setMessage(refused ? t("shortcuts.refused", { reason: refused }) : "")); }}>{t("shortcuts.resetAll")}</button> : undefined}
        >
          {KEY_ACTIONS.filter((entry) => entry.group === group).map((entry) => (
            <ActionRow key={entry.id} t={t} id={entry.id} keys={keys} adding={adding} setAdding={setAdding} message={setMessage} />
          ))}
        </SettingsSection>
      ))}
    </SettingsPage>
  );
}
