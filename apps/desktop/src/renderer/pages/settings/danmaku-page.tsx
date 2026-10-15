import { useEffect, useState } from "react";
import { DANMAKU_AREAS, validPattern, type DanmakuSettings } from "@manga/contracts/danmaku";
import type { MessageKey, Translator } from "@manga/i18n";
import { attempt } from "../../lib/api.ts";
import { setDanmakuCredentialSource, useDanmakuSettings } from "../../hooks/use-danmaku-settings.ts";
import { crossingSeconds } from "../../readers/danmaku-model.ts";
import { SettingsEmpty, SettingsPage, SettingsRow, SettingsSection } from "./rows.tsx";

type T = Translator["t"];

const lines = (text: string): string[] => text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
const SHAPE = /^[A-Za-z0-9_-]{4,128}$/;

function Switch(props: { id: string; label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <input id={props.id} type="checkbox" role="switch" data-testid={props.id} aria-label={props.label} checked={props.checked} onChange={(event) => props.onChange(event.target.checked)} />;
}

function Slider(props: { id: string; label: string; min: number; max: number; step: number; value: number; text: string; onChange: (value: number) => void }) {
  return (
    <span className="danmaku-slider">
      <input id={props.id} type="range" data-testid={props.id} aria-label={props.label} min={props.min} max={props.max} step={props.step} value={props.value} onChange={(event) => props.onChange(Number(event.target.value))} />
      <output data-testid={`${props.id}-value`}>{props.text}</output>
    </span>
  );
}

/** A list the person types, one entry to a line; it is kept when the field is left, and a line that cannot be kept stops the save with its number. */
function ListField(props: { id: string; label: string; value: readonly string[]; check?: (line: string) => boolean; invalid?: (line: number, text: string) => string; onSave: (value: string[]) => void }) {
  const [draft, setDraft] = useState(props.value.join("\n"));
  const [problem, setProblem] = useState("");
  useEffect(() => { setDraft(props.value.join("\n")); }, [props.value]);
  const commit = () => {
    const next = lines(draft);
    const bad = props.check ? next.findIndex((line) => !props.check!(line)) : -1;
    if (bad >= 0) { setProblem(props.invalid!(bad + 1, next[bad]!)); return; }
    setProblem("");
    if (JSON.stringify(next) !== JSON.stringify(props.value)) props.onSave(next);
  };
  return (
    <>
      <textarea id={props.id} data-testid={props.id} aria-label={props.label} rows={4} value={draft} aria-invalid={problem ? true : undefined} onChange={(event) => setDraft(event.target.value)} onBlur={commit} spellCheck={false} />
      {problem ? <p className="review-error" role="alert" data-testid={`${props.id}-error`}>{problem}</p> : null}
    </>
  );
}

function Credentials(props: { t: T; source: "custom" | "built-in" | "none"; onError: (message: string) => void; onNotice: (message: string) => void }) {
  const { t } = props;
  const [appId, setAppId] = useState("");
  const [secret, setSecret] = useState("");
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const valid = SHAPE.test(appId.trim()) && SHAPE.test(secret.trim());

  async function save() {
    if (!valid) { setProblem(t("dsettings.credentialsInvalid")); return; }
    setBusy(true);
    setProblem("");
    try {
      const handle = await window.manga.stashSecret(JSON.stringify({ appId: appId.trim(), secret: secret.trim() }));
      // The values leave the fields at once; only the main process keeps them.
      setAppId("");
      setSecret("");
      if (!handle) { props.onError(t("status.error")); return; }
      const result = await attempt<{ credentials: "custom" | "built-in" | "none" }>("danmaku.setCredentials", { credentialHandle: handle });
      if (!result.ok) { setProblem(result.error.message); return; }
      setDanmakuCredentialSource(result.value.credentials);
      props.onNotice(t("dsettings.credentialsSaved"));
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setBusy(true);
    const result = await attempt<{ credentials: "custom" | "built-in" | "none" }>("danmaku.setCredentials", { clear: true });
    setBusy(false);
    if (!result.ok) { props.onError(result.error.message); return; }
    setDanmakuCredentialSource(result.value.credentials);
    props.onNotice(t("dsettings.credentialsCleared"));
  }

  return (
    <SettingsSection title={t("dsettings.credentials")} hint={t("dsettings.credentialsHint")} testId="danmaku-credentials">
      <p role="status" data-testid="danmaku-credential-state" data-source={props.source}>{t(`dsettings.credentials.${props.source}` as MessageKey)}</p>
      <SettingsRow label={t("dsettings.appId")} htmlFor="danmaku-app-id">
        <input id="danmaku-app-id" data-testid="danmaku-app-id" type="text" autoComplete="off" spellCheck={false} value={appId} onChange={(event) => setAppId(event.target.value)} />
      </SettingsRow>
      <SettingsRow label={t("dsettings.appSecret")} htmlFor="danmaku-app-secret">
        <input id="danmaku-app-secret" data-testid="danmaku-app-secret" type="password" autoComplete="off" spellCheck={false} value={secret} onChange={(event) => setSecret(event.target.value)} />
      </SettingsRow>
      {problem ? <p className="review-error" role="alert" data-testid="danmaku-credential-error">{problem}</p> : null}
      <div className="settings-row-actions">
        <button type="button" className="primary-button" data-testid="danmaku-credentials-save" disabled={busy || appId.trim() === "" || secret.trim() === ""} onClick={() => void save()}>{t("dsettings.credentialsSave")}</button>
        {props.source === "custom" ? <button type="button" className="secondary-button" data-testid="danmaku-credentials-clear" disabled={busy} onClick={() => void clear()}>{t("dsettings.credentialsClear")}</button> : null}
      </div>
    </SettingsSection>
  );
}

/**
 * The danmaku page of the settings (A-81, Q-28): what is shown and how, what is blocked, whose credentials are used, and the cache. A change applies
 * at once to the player behind it; switching the module off keeps all of it.
 */
export function DanmakuPage(props: { t: T; moduleOn: boolean; onError: (message: string) => void; onNotice: (message: string) => void }) {
  const { t } = props;
  const store = useDanmakuSettings(props.moduleOn);
  const { settings } = store;

  const change = (patch: Partial<DanmakuSettings>) => {
    void store.save(patch).then((refused) => { if (refused) props.onError(refused); });
  };
  const clearCache = async () => {
    const result = await attempt<{ removed: number }>("danmaku.clearCache");
    if (!result.ok) { props.onError(result.error.message); return; }
    props.onNotice(t("dsettings.cacheCleared", { count: result.value.removed }));
  };

  if (!props.moduleOn) {
    return (
      <SettingsPage id="danmaku" title={t("dsettings.title")}>
        <SettingsEmpty text={t("dsettings.off")} testId="danmaku-off" />
      </SettingsPage>
    );
  }

  const sources = [...new Set([...store.sources.map((entry) => entry.source), ...settings.sourcesOff])];
  const counts = new Map(store.sources.map((entry) => [entry.source, entry.count]));
  const toggleSource = (source: string, on: boolean) => change({ sourcesOff: on ? settings.sourcesOff.filter((item) => item !== source) : [...settings.sourcesOff, source] });

  return (
    <SettingsPage id="danmaku" title={t("dsettings.title")} hint={t("dsettings.lead")}>
      <SettingsSection testId="danmaku-source">
        <p data-testid="danmaku-source-note">{t("dsettings.attribution")}</p>
        <SettingsRow label={t("dsettings.enabled")} hint={t("dsettings.enabledHint")} htmlFor="danmaku-enabled">
          <Switch id="danmaku-enabled" label={t("dsettings.enabled")} checked={settings.enabled} onChange={(enabled) => change({ enabled })} />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title={t("dsettings.display")} testId="danmaku-display">
        <SettingsRow label={t("dsettings.opacity")} htmlFor="danmaku-opacity">
          <Slider id="danmaku-opacity" label={t("dsettings.opacity")} min={10} max={100} step={5} value={Math.round(settings.opacity * 100)} text={`${Math.round(settings.opacity * 100)}%`} onChange={(value) => change({ opacity: value / 100 })} />
        </SettingsRow>
        <SettingsRow label={t("dsettings.size")} htmlFor="danmaku-size">
          <Slider id="danmaku-size" label={t("dsettings.size")} min={50} max={200} step={10} value={settings.size} text={`${settings.size}%`} onChange={(size) => change({ size })} />
        </SettingsRow>
        <SettingsRow label={t("dsettings.speed")} htmlFor="danmaku-speed">
          <Slider id="danmaku-speed" label={t("dsettings.speed")} min={60} max={400} step={10} value={settings.speed} text={t("dsettings.speedValue", { seconds: crossingSeconds(settings.speed) })} onChange={(speed) => change({ speed })} />
        </SettingsRow>
        <SettingsRow label={t("dsettings.followRate")} hint={t("dsettings.followRateHint")} htmlFor="danmaku-follow-rate">
          <Switch id="danmaku-follow-rate" label={t("dsettings.followRate")} checked={settings.followRate} onChange={(followRate) => change({ followRate })} />
        </SettingsRow>
        <SettingsRow label={t("dsettings.area")} htmlFor="danmaku-area">
          <select id="danmaku-area" data-testid="danmaku-area" value={settings.area} onChange={(event) => change({ area: Number(event.target.value) })}>
            {DANMAKU_AREAS.map((area) => <option key={area} value={area}>{t(`dsettings.area.${Math.round(area * 100)}` as MessageKey)}</option>)}
          </select>
        </SettingsRow>
        <SettingsRow label={t("dsettings.types")}>
          <span className="danmaku-types">
            {(["scroll", "top", "bottom"] as const).map((kind) => (
              <label key={kind}>
                <input type="checkbox" data-testid={`danmaku-type-${kind}`} checked={settings[kind]} onChange={(event) => change({ [kind]: event.target.checked })} />
                <span>{t(`dsettings.${kind}` as MessageKey)}</span>
              </label>
            ))}
          </span>
        </SettingsRow>
        <SettingsRow label={t("dsettings.color")} hint={t("dsettings.colorHint")} htmlFor="danmaku-color">
          <Switch id="danmaku-color" label={t("dsettings.color")} checked={settings.color} onChange={(color) => change({ color })} />
        </SettingsRow>
        <SettingsRow label={t("dsettings.merge")} hint={t("dsettings.mergeHint")} htmlFor="danmaku-merge">
          <Switch id="danmaku-merge" label={t("dsettings.merge")} checked={settings.merge} onChange={(merge) => change({ merge })} />
        </SettingsRow>
        <SettingsRow label={t("dsettings.convert")} hint={t("dsettings.convertHint")} htmlFor="danmaku-convert">
          <select id="danmaku-convert" data-testid="danmaku-convert" value={settings.convert} onChange={(event) => change({ convert: event.target.value as DanmakuSettings["convert"] })}>
            {(["none", "simplified", "traditional"] as const).map((kind) => <option key={kind} value={kind}>{t(`dsettings.convert.${kind}` as MessageKey)}</option>)}
          </select>
        </SettingsRow>
        <SettingsRow label={t("dsettings.shotWith")} hint={t("dsettings.shotWithHint")} htmlFor="danmaku-shot-with">
          <Switch id="danmaku-shot-with" label={t("dsettings.shotWith")} checked={settings.shotWith} onChange={(shotWith) => change({ shotWith })} />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title={t("dsettings.filter")} testId="danmaku-filter">
        <SettingsRow label={t("dsettings.blockWords")} hint={t("dsettings.blockWordsHint")} htmlFor="danmaku-block-words" stacked>
          <ListField id="danmaku-block-words" label={t("dsettings.blockWords")} value={settings.blockWords} onSave={(blockWords) => change({ blockWords })} />
        </SettingsRow>
        <SettingsRow label={t("dsettings.blockPatterns")} hint={t("dsettings.blockPatternsHint")} htmlFor="danmaku-block-patterns" stacked>
          <ListField
            id="danmaku-block-patterns"
            label={t("dsettings.blockPatterns")}
            value={settings.blockPatterns}
            check={validPattern}
            invalid={(line, text) => t("dsettings.patternInvalid", { line, pattern: text })}
            onSave={(blockPatterns) => change({ blockPatterns })}
          />
        </SettingsRow>
        <SettingsRow label={t("dsettings.sources")} hint={t("dsettings.sourcesHint")} stacked>
          {sources.length === 0 ? <span className="detail-muted" data-testid="danmaku-sources-none">{t("dsettings.sourcesNone")}</span> : (
            <ul className="danmaku-sources" data-testid="danmaku-sources">
              {sources.map((source) => (
                <li key={source || "own"}>
                  <label>
                    <input type="checkbox" data-testid={`danmaku-source-${source || "own"}`} checked={!settings.sourcesOff.includes(source)} onChange={(event) => toggleSource(source, event.target.checked)} />
                    <span>{source === "" ? t("dsettings.sourceOwn") : source}</span>
                    {counts.has(source) ? <span className="detail-muted"> · {counts.get(source)}</span> : null}
                  </label>
                </li>
              ))}
            </ul>
          )}
        </SettingsRow>
      </SettingsSection>

      <Credentials t={t} source={store.credentials} onError={props.onError} onNotice={props.onNotice} />

      <SettingsSection title={t("dsettings.cache")} hint={t("dsettings.cacheHint")} testId="danmaku-cache">
        <div className="settings-row-actions">
          <button type="button" className="secondary-button" data-testid="danmaku-cache-clear" onClick={() => void clearCache()}>{t("dsettings.cacheClear")}</button>
        </div>
      </SettingsSection>
    </SettingsPage>
  );
}
