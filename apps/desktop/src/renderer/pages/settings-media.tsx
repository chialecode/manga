import { useCallback, useEffect, useRef, useState } from "react";
import type { ReadingStylePatch, ShellPreference } from "@manga/contracts/reading";
import type { MessageKey, Translator } from "@manga/i18n";
import { asArray, attempt } from "../lib/api.ts";
import type { ComicSettings } from "../readers/comic-reader.tsx";
import type { VideoSettings } from "../readers/video-player.tsx";
import { listMicrophones } from "../voice/mic.ts";
import type { RecordingSettings } from "../voice/use-recorder.ts";

type T = Translator["t"];

type ModuleRow = { featureId: string; moduleId: string; displayName: string; wanted: boolean; state: string; core: boolean };
type ProviderRow = { id: string; displayName: string; kind: "online" | "local"; namespace: string; enabled: boolean; credentialConfigured: boolean };

/** The key as a person reads it: the physical key's name without the layout words. */
export function keyLabel(code: string): string {
  return code.replace(/^Key/, "").replace(/^Digit/, "").replace(/^Arrow/, "").replace(/^Numpad/, "小键盘 ");
}

/** A key choice: click it, then press the key to use; Escape leaves it as it was. */
function KeyField(props: { t: T; label: string; value: string; testId: string; onPick: (code: string) => void }) {
  const [waiting, setWaiting] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!waiting) return;
    const onKey = (event: KeyboardEvent) => {
      // While choosing, the key belongs to the choice: nothing else in the window reacts to it.
      event.preventDefault();
      event.stopPropagation();
      setWaiting(false);
      if (event.code === "Escape") return;
      if (["ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight"].includes(event.code)) return;
      props.onPick(event.code);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [waiting, props]);
  return (
    <label className="msettings-field">
      <span>{props.label}</span>
      <button
        ref={button}
        type="button"
        className="secondary-button msettings-key"
        data-testid={props.testId}
        aria-pressed={waiting}
        title={props.t("msettings.keyHint")}
        onClick={() => setWaiting(true)}
        onBlur={() => setWaiting(false)}
      >{waiting ? props.t("msettings.keyPress") : keyLabel(props.value)}</button>
    </label>
  );
}

const moduleName = (t: T, row: ModuleRow): string => {
  const key = `msettings.module.${row.featureId}` as MessageKey;
  const name = t(key);
  return name === key ? row.displayName : name;
};

/** The switches for the optional modules. A switch that cannot turn (another module needs it, or its start failed) says why and stays as it was. */
export function Modules(props: { t: T; onChanged: () => Promise<void> | void }) {
  const { t } = props;
  const [rows, setRows] = useState<ModuleRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string>();
  const load = useCallback(async () => {
    const result = await attempt<{ modules: ModuleRow[] }>("settings.getModules");
    if (result.ok) setRows(asArray<ModuleRow>(result.value.modules));
    else setProblem(result.error.message);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function toggle(row: ModuleRow) {
    setBusy(row.featureId);
    setProblem(undefined);
    const result = await attempt<{ modules: ModuleRow[] }>("settings.setModule", { featureId: row.featureId, enabled: !row.wanted });
    if (result.ok) setRows(asArray<ModuleRow>(result.value.modules));
    else { setProblem(result.error.message); await load(); }
    setBusy(null);
    await props.onChanged();
  }

  return (
    <section className="msettings-section" data-testid="msettings-modules" aria-labelledby="msettings-modules-title">
      <h3 id="msettings-modules-title">{t("msettings.modules")}</h3>
      <p className="detail-muted">{t("msettings.modulesHint")}</p>
      {rows === null && !problem ? <p role="status" className="detail-muted">{t("msettings.loading")}</p> : null}
      <ul className="msettings-list">
        {(rows ?? []).filter((row) => !row.core).map((row) => (
          <li key={row.featureId} className="msettings-row">
            <label>
              <input type="checkbox" role="switch" data-testid={`module-${row.featureId}`} checked={row.wanted} disabled={busy !== null} aria-busy={busy === row.featureId} onChange={() => void toggle(row)} />
              <span>{moduleName(t, row)}</span>
            </label>
            <span className="detail-muted" data-testid={`module-state-${row.featureId}`}>{busy === row.featureId ? t("msettings.moduleSwitching") : row.wanted && row.state === "active" ? t("msettings.moduleOn") : row.wanted ? row.state : t("msettings.moduleOff")}</span>
          </li>
        ))}
      </ul>
      {problem ? <p role="alert" className="review-error" data-testid="msettings-module-error">{t("msettings.moduleFailed", { message: problem })}</p> : null}
    </section>
  );
}

export function Recording(props: { t: T; settings: RecordingSettings; save: (patch: Partial<RecordingSettings>) => Promise<void>; onNotice: (message: string) => void }) {
  const { t, settings } = props;
  const [devices, setDevices] = useState<Array<{ id: string; label: string }>>([]);
  const [clash, setClash] = useState(false);
  const refresh = useCallback(() => { void listMicrophones().then(setDevices); }, []);
  useEffect(() => { refresh(); }, [refresh]);
  const missing = settings.deviceId !== null && !devices.some((device) => device.id === settings.deviceId);

  function pickKey(field: "holdKey" | "toggleKey", code: string) {
    const other = field === "holdKey" ? settings.toggleKey : settings.holdKey;
    if (code === other) { setClash(true); return; }
    setClash(false);
    void props.save({ [field]: code });
  }

  return (
    <section className="msettings-section" data-testid="msettings-recording" aria-labelledby="msettings-recording-title">
      <h3 id="msettings-recording-title">{t("msettings.recording")}</h3>
      <label className="msettings-field">
        <span>{t("msettings.device")}</span>
        <select data-testid="msettings-device" value={settings.deviceId ?? ""} onChange={(event) => void props.save({ deviceId: event.target.value || null })} onFocus={refresh}>
          <option value="">{t("msettings.deviceDefault")}</option>
          {missing ? <option value={settings.deviceId ?? ""}>{settings.deviceId}</option> : null}
          {devices.map((device) => <option key={device.id} value={device.id}>{device.label}</option>)}
        </select>
      </label>
      <KeyField t={t} label={t("msettings.holdKey")} value={settings.holdKey} testId="msettings-hold-key" onPick={(code) => pickKey("holdKey", code)} />
      <KeyField t={t} label={t("msettings.toggleKey")} value={settings.toggleKey} testId="msettings-toggle-key" onPick={(code) => pickKey("toggleKey", code)} />
      <p className="detail-muted">{t("msettings.keyScope")}</p>
      {clash ? <p role="alert" className="review-error" data-testid="msettings-key-clash">{t("msettings.keyClash")}</p> : null}
      <label className="msettings-field">
        <span>{t("msettings.retention")}</span>
        <select data-testid="msettings-retention" value={settings.retention} onChange={(event) => void props.save({ retention: event.target.value as "keep" | "discard" })}>
          <option value="keep">{t("msettings.retentionKeep")}</option>
          <option value="discard">{t("msettings.retentionDiscard")}</option>
        </select>
      </label>
      <label className="msettings-field">
        <span>{t("msettings.duck")}</span>
        <select data-testid="msettings-duck" value={settings.duckPlayback} onChange={(event) => void props.save({ duckPlayback: event.target.value as RecordingSettings["duckPlayback"] })}>
          <option value="none">{t("msettings.duckNone")}</option>
          <option value="lower">{t("msettings.duckLower")}</option>
          <option value="pause">{t("msettings.duckPause")}</option>
        </select>
      </label>
      <label className="msettings-field">
        <span>{t("msettings.margin")}</span>
        <input type="number" min={0} max={2000} step={50} data-testid="msettings-margin" value={settings.boundaryMarginMs} onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value)) void props.save({ boundaryMarginMs: Math.max(0, Math.min(2000, Math.round(value))) }); }} />
      </label>
      <div>
        <button type="button" className="secondary-button" data-testid="msettings-overlay-reset" onClick={() => { void props.save({ overlay: { width: 280, height: 84 } }).then(() => props.onNotice(t("msettings.overlayDone"))); }}>{t("msettings.overlayReset")}</button>
      </div>
    </section>
  );
}

/** The novel reader's defaults: what a book opens with until the reader's own settings change it. */
function NovelPrefs(props: { t: T; reading: ShellPreference["reading"]; onReading: (patch: ReadingStylePatch) => void }) {
  const { t, reading } = props;
  return (
    <section className="msettings-section" data-testid="msettings-novel" aria-labelledby="msettings-novel-title">
      <h3 id="msettings-novel-title">{t("msettings.novel")}</h3>
      <label className="msettings-field">
        <span>{t("reading.fontFamily")}</span>
        <select data-testid="msettings-novel-font" value={reading.fontFamily} onChange={(event) => props.onReading({ fontFamily: event.target.value })}>
          <option value="sans">{t("reading.fontSans")}</option>
          <option value="serif">{t("reading.fontSerif")}</option>
          <option value="mono">{t("reading.fontMono")}</option>
        </select>
      </label>
      <label className="msettings-field">
        <span>{t("reading.fontSize")}</span>
        <input type="number" min={14} max={32} data-testid="msettings-novel-size" value={reading.fontSizePx} onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value) && value >= 14 && value <= 32) props.onReading({ fontSizePx: Math.round(value) }); }} />
      </label>
      <label className="msettings-field">
        <span>{t("reading.lineHeight")}</span>
        <input type="number" min={1.2} max={2.4} step={0.1} data-testid="msettings-novel-line" value={reading.lineHeight} onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value) && value >= 1.2 && value <= 2.4) props.onReading({ lineHeight: Math.round(value * 10) / 10 }); }} />
      </label>
      <label className="msettings-field">
        <span>{t("reader.pageMode")}</span>
        <select data-testid="msettings-novel-page" value={reading.pageMode ?? "single"} onChange={(event) => props.onReading({ pageMode: event.target.value as "single" | "double" })}>
          <option value="single">{t("reader.single")}</option>
          <option value="double">{t("reader.double")}</option>
        </select>
      </label>
    </section>
  );
}

export function MediaPrefs(props: { t: T; facets: Set<string>; reading: ShellPreference["reading"]; onReading: (patch: ReadingStylePatch) => void; comic: ComicSettings; onComic: (patch: Partial<ComicSettings>) => void; video: VideoSettings; onVideo: (patch: Partial<VideoSettings>) => void }) {
  const { t } = props;
  return (
    <>
      <NovelPrefs t={t} reading={props.reading} onReading={props.onReading} />
      {props.facets.has("comic") ? (
        <section className="msettings-section" data-testid="msettings-comic" aria-labelledby="msettings-comic-title">
          <h3 id="msettings-comic-title">{t("msettings.comic")}</h3>
          <label className="msettings-field">
            <span>{t("msettings.comicDirection")}</span>
            <select data-testid="msettings-comic-direction" value={props.comic.direction} onChange={(event) => props.onComic({ direction: event.target.value as ComicSettings["direction"] })}>
              <option value="rtl">{t("msettings.comicRtl")}</option>
              <option value="ltr">{t("msettings.comicLtr")}</option>
            </select>
          </label>
          <label className="msettings-field">
            <span>{t("msettings.comicLayout")}</span>
            <select data-testid="msettings-comic-layout" value={props.comic.layout} onChange={(event) => props.onComic({ layout: event.target.value as ComicSettings["layout"] })}>
              <option value="single">{t("msettings.comicSingle")}</option>
              <option value="double">{t("msettings.comicDouble")}</option>
              <option value="strip">{t("msettings.comicStrip")}</option>
            </select>
          </label>
          <label className="msettings-check"><input type="checkbox" data-testid="msettings-comic-cover" checked={props.comic.coverAlone} onChange={(event) => props.onComic({ coverAlone: event.target.checked })} />{t("msettings.comicCover")}</label>
        </section>
      ) : null}
      {props.facets.has("video") ? (
        <section className="msettings-section" data-testid="msettings-video" aria-labelledby="msettings-video-title">
          <h3 id="msettings-video-title">{t("msettings.video")}</h3>
          <label className="msettings-field">
            <span>{t("msettings.videoStep")}</span>
            <input type="number" min={1} max={120} data-testid="msettings-video-step" value={props.video.seekStepSeconds} onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value) && value >= 1 && value <= 120) props.onVideo({ seekStepSeconds: Math.round(value) }); }} />
          </label>
          <label className="msettings-field">
            <span>{t("msettings.videoHold")}</span>
            <select data-testid="msettings-video-hold" value={String(props.video.holdRate)} onChange={(event) => props.onVideo({ holdRate: Number(event.target.value) })}>
              {[1.5, 2, 3, 4].map((rate) => <option key={rate} value={String(rate)}>{rate}×</option>)}
            </select>
          </label>
          <label className="msettings-check"><input type="checkbox" data-testid="msettings-video-autonext" checked={props.video.autoNext} onChange={(event) => props.onVideo({ autoNext: event.target.checked })} />{t("msettings.videoAutoNext")}</label>
        </section>
      ) : null}
    </>
  );
}

/** Metadata sources: each can be turned off, and the online one takes an optional token that is kept in the system's credential protection and never shown again. */
export function Providers(props: { t: T; onError: (message: string) => void; onNotice: (message: string) => void }) {
  const { t } = props;
  const [rows, setRows] = useState<ProviderRow[] | null>(null);
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const load = useCallback(async () => {
    const result = await attempt<{ providers: ProviderRow[] }>("metadata.providers");
    if (result.ok) setRows(asArray<ProviderRow>(result.value.providers));
    else props.onError(result.error.message);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function save(row: ProviderRow, patch: { enabled?: boolean; token?: string; clear?: boolean }) {
    let credentialHandle: string | undefined;
    if (patch.token) {
      const handle = await window.manga.stashSecret(patch.token);
      if (!handle) { props.onError(t("msettings.failed", { message: "credential" })); return; }
      credentialHandle = handle;
    }
    const result = await attempt("metadata.setProvider", { providerId: row.id, enabled: patch.enabled ?? row.enabled, ...(credentialHandle ? { credentialHandle } : {}), ...(patch.clear ? { clearCredential: true } : {}) });
    if (!result.ok) { props.onError(result.error.message); return; }
    setTokens((current) => ({ ...current, [row.id]: "" }));
    props.onNotice(t("msettings.saved"));
    await load();
  }

  const online = (rows ?? []).filter((row) => row.kind === "online");
  return (
    <section className="msettings-section" data-testid="msettings-metadata" aria-labelledby="msettings-metadata-title">
      <h3 id="msettings-metadata-title">{t("msettings.metadata")}</h3>
      <p className="detail-muted">{t("msettings.metadataLocal")}</p>
      {rows === null ? <p role="status" className="detail-muted">{t("msettings.loading")}</p> : null}
      {online.map((row) => (
        <div key={row.id} className="msettings-provider" data-testid={`provider-${row.id}`}>
          <label className="msettings-check"><input type="checkbox" role="switch" data-testid={`provider-enabled-${row.id}`} checked={row.enabled} onChange={(event) => void save(row, { enabled: event.target.checked })} />{row.displayName} · {t("msettings.providerEnabled")}</label>
          <p className="detail-muted">{t("msettings.providerOnline")}</p>
          <label className="msettings-field">
            <span>{t("msettings.providerToken")}</span>
            <input type="password" autoComplete="off" data-testid={`provider-token-${row.id}`} value={tokens[row.id] ?? ""} onChange={(event) => setTokens((current) => ({ ...current, [row.id]: event.target.value }))} />
          </label>
          <p className="detail-muted">{t("msettings.providerTokenHint")}</p>
          <div className="msettings-actions">
            <button type="button" className="secondary-button" data-testid={`provider-token-save-${row.id}`} disabled={!tokens[row.id]} onClick={() => void save(row, { token: tokens[row.id] })}>{t("msettings.providerTokenSave")}</button>
            {row.credentialConfigured ? (
              <>
                <span className="detail-muted" data-testid={`provider-token-set-${row.id}`}>{t("msettings.providerTokenSet")}</span>
                <button type="button" className="link-button" data-testid={`provider-token-clear-${row.id}`} onClick={() => void save(row, { clear: true })}>{t("msettings.providerTokenClear")}</button>
              </>
            ) : null}
          </div>
        </div>
      ))}
    </section>
  );
}
