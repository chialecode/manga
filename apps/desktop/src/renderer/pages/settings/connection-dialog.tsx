import { useEffect, useMemo, useRef, useState } from "react";
import type { ConnectionTestResult, ModelProfile } from "@manga/contracts/models";
import type { MessageKey, Translator } from "@manga/i18n";
import { Modal } from "../../components/modal.tsx";
import { MODEL_CAPABILITIES, MODEL_INPUT_TYPES, REASONING_EFFORTS, profileProblem, type ProfileForm } from "../../lib/model-profile.ts";
import type { ConnectionForm } from "../../lib/types.ts";

type T = Translator["t"];

/** What saving a connection answered: its id, or why not (shown in the dialog, which stays open). */
export type SaveConnectionResult = { ok: true; id: string } | { ok: false; message: string };
/** What a test of a connection that is not asked questions (transcription, vectors) answered. */
export type PlainTestResult = { ok: boolean; message: string };

export type FieldName = "label" | "baseUrl" | "modelId" | "secret" | "timeout" | "window" | "output";
type Errors = Partial<Record<FieldName, string>>;

const FIELD_ORDER: FieldName[] = ["label", "baseUrl", "modelId", "secret", "timeout", "window", "output"];
const MAX_TIMEOUT_SECONDS = 300;

export const protocolName = (t: T, protocol: string) => (protocol === "openai-responses" ? t("models.protocol.openai-responses") : t("models.protocol.openai-chat-completions"));
const PURPOSE_KEY = { text: "settings.purposeText", vision: "settings.purposeVision", transcription: "settings.purposeTranscription", embedding: "settings.purposeEmbedding" } as const;
export const purposeName = (t: T, purpose: string) => t(PURPOSE_KEY[purpose as keyof typeof PURPOSE_KEY] ?? PURPOSE_KEY.text);
export const runtimeName = (t: T, runtime: string) => (runtime === "pi" ? t("settings.runtimePi") : t("settings.runtimeNative"));

/** What is wrong with the form, field by field, before anything is sent. A connection without a stored secret cannot be used, so one is asked for. */
export function validateConnection(t: T, form: ConnectionForm, timeoutText: string, profileApplies: boolean, secretStored: boolean): Errors {
  const errors: Errors = {};
  if (!secretStored && !form.secret.trim()) errors.secret = t("models.error.secretEmpty");
  if (form.label.trim().length > 120) errors.label = t("models.error.labelLong");
  const address = form.baseUrl.trim();
  if (!address) errors.baseUrl = t("models.error.baseUrlEmpty");
  else {
    let parsed: URL | null = null;
    try { parsed = new URL(address); } catch { parsed = null; }
    if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) errors.baseUrl = t("models.error.baseUrlShape");
    else if (parsed.username || parsed.password) errors.baseUrl = t("models.error.baseUrlCredentials");
  }
  if (!form.modelId.trim()) errors.modelId = t("models.error.modelEmpty");
  const seconds = Number(timeoutText);
  if (!timeoutText.trim() || !Number.isInteger(seconds) || seconds < 1 || seconds > MAX_TIMEOUT_SECONDS) errors.timeout = t("models.error.timeout", { max: MAX_TIMEOUT_SECONDS });
  if (profileApplies && form.profile) {
    const problem = profileProblem(form.profile);
    if (problem === "window") errors.window = t("models.problem.window");
    else if (problem === "output") errors.output = t("models.problem.output");
    else if (problem === "order") errors.output = t("models.problem.order");
  }
  return errors;
}

const secondsOf = (timeoutMs: string) => String(Math.max(1, Math.round((Number(timeoutMs) || 60_000) / 1000)));

/** What the dialog shows of a test: the saved result of a model that is asked questions, or the plain answer for one that is not. */
function TestSummary(props: { t: T; result: ConnectionTestResult | null; plain: PlainTestResult | null; running: boolean; formatDate: (value: string) => string }) {
  const { t, result, plain } = props;
  if (props.running) return <p role="status" className="detail-muted" data-testid="connection-dialog-testing">{t("models.probing")}</p>;
  if (plain) return <p role="status" className={plain.ok ? "connection-test connection-test-ok" : "connection-test connection-test-fail"} data-testid="connection-dialog-test" data-state={plain.ok ? "ok" : "fail"}>{plain.message}</p>;
  if (!result) return null;
  if (!result.ok) {
    const category = result.failure?.category ?? "other";
    return (
      <div className="connection-test connection-test-fail" role="status" data-testid="connection-dialog-test" data-state="fail" data-category={category}>
        <strong>{t("models.probeFail")}：{t(`models.fail.${category}` as MessageKey)}</strong>
        <div>{t(`models.fail.${category}.fix` as MessageKey)}</div>
      </div>
    );
  }
  return (
    <div className="connection-test connection-test-ok" role="status" data-testid="connection-dialog-test" data-state="ok">
      <strong>{t("models.probeOk")}</strong>
      <div className="detail-muted">{t("models.testedAt", { time: props.formatDate(result.at) })}</div>
    </div>
  );
}

/**
 * Adding or changing a model connection in one dialog (MODEL-01, A-90). The fields are in two groups: the connection, and what the model can do
 * (asked only for the models that are asked questions). Every field is checked before saving and says what is wrong beside itself; a refusal
 * from the main process stays in the dialog too. Once saved, the connection can be tested without leaving, and the result is shown here
 * and in the list. Closing with unsaved changes asks first.
 */
export function ConnectionDialog(props: {
  i18n: Translator;
  /** The form the dialog starts from: empty for a new connection, the stored values for an existing one. */
  initial: ConnectionForm;
  /** The connection already has a secret stored; a blank secret keeps it. */
  secretStored: boolean;
  /** The saved connection as the settings now hold it, for its last test. */
  saved: (id: string) => { lastTest?: ConnectionTestResult | null; profile?: ModelProfile } | undefined;
  onSave: (form: ConnectionForm) => Promise<SaveConnectionResult>;
  onProbe: (id: string) => Promise<void>;
  onTest: (id: string, capability: string) => Promise<PlainTestResult>;
  onClose: () => void;
}) {
  const { i18n } = props;
  const t = i18n.t;
  const [form, setForm] = useState<ConnectionForm>(props.initial);
  const [timeoutText, setTimeoutText] = useState(() => secondsOf(props.initial.timeoutMs));
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedId, setSavedId] = useState<string | null>(props.initial.id ?? null);
  const [baseline, setBaseline] = useState(() => JSON.stringify({ form: props.initial, timeout: secondsOf(props.initial.timeoutMs) }));
  const [testing, setTesting] = useState(false);
  const [plain, setPlain] = useState<PlainTestResult | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [secretKept, setSecretKept] = useState(props.secretStored);
  const body = useRef<HTMLDivElement>(null);

  const profileApplies = form.purpose === "text" || form.purpose === "vision";
  const dirty = useMemo(() => JSON.stringify({ form, timeout: timeoutText }) !== baseline, [form, timeoutText, baseline]);
  const adding = !props.initial.id;
  const live = savedId ? props.saved(savedId) : undefined;

  // The first field with a problem is where the person is taken.
  useEffect(() => {
    const first = FIELD_ORDER.find((name) => errors[name]);
    if (first) body.current?.querySelector<HTMLElement>(`[data-field="${first}"]`)?.focus();
  }, [errors]);

  const change = (next: Partial<ConnectionForm>, clears?: FieldName[]) => {
    setForm((current) => ({ ...current, ...next }));
    setFailure(null);
    if (clears?.length) setErrors((current) => { const rest = { ...current }; for (const name of clears) delete rest[name]; return rest; });
  };
  const changeProfile = (next: ProfileForm) => {
    setForm((current) => ({ ...current, profile: next }));
    setFailure(null);
    setErrors((current) => { const { window: _w, output: _o, ...rest } = current; return rest; });
  };
  const toggle = (field: "inputTypes" | "capabilities", item: string, on: boolean) => {
    if (!form.profile) return;
    const current = form.profile[field];
    changeProfile({ ...form.profile, [field]: on ? [...new Set([...current, item])] : current.filter((entry) => entry !== item) });
  };

  async function save() {
    const found = validateConnection(t, form, timeoutText, profileApplies, secretKept);
    setErrors(found);
    if (Object.keys(found).length) return;
    setSaving(true);
    setFailure(null);
    const outcome = await props.onSave({ ...form, label: form.label.trim() || form.modelId.trim(), baseUrl: form.baseUrl.trim(), modelId: form.modelId.trim(), timeoutMs: String(Number(timeoutText) * 1000), ...(savedId ? { id: savedId } : {}) });
    setSaving(false);
    if (!outcome.ok) { setFailure(outcome.message); return; }
    // What was typed is now what is stored: nothing is unsaved, a new secret is kept, the profile's "before" is what was just saved.
    const stored: ConnectionForm = { ...form, id: outcome.id, secret: "", profileBefore: form.profile };
    setForm(stored);
    if (form.secret) setSecretKept(true);
    setSavedId(outcome.id);
    setPlain(null);
    setBaseline(JSON.stringify({ form: stored, timeout: timeoutText }));
  }

  async function test() {
    if (!savedId || dirty) return;
    setTesting(true);
    setPlain(null);
    try {
      if (profileApplies) await props.onProbe(savedId);
      else setPlain(await props.onTest(savedId, form.purpose === "transcription" ? "transcription" : "embedding"));
    } finally { setTesting(false); }
  }

  const requestClose = () => { if (saving) return; if (dirty) setDiscarding(true); else props.onClose(); };
  const field = (name: FieldName) => ({ "data-field": name, "aria-invalid": errors[name] ? true : undefined, "aria-describedby": errors[name] ? `field-error-${name}` : undefined });
  const problem = (name: FieldName) => (errors[name] ? <span className="field-error" id={`field-error-${name}`} role="alert" data-testid={`field-error-${name}`}>{errors[name]}</span> : null);
  const profile = form.profile;

  return (
    <>
      <Modal
        variant="dialog"
        className="connection-dialog"
        testId="connection-dialog"
        title={adding && !savedId ? t("models.dialog.addTitle") : t("models.dialog.editTitle")}
        description={t("models.dialog.lead")}
        closeLabel={t("common.close")}
        onClose={requestClose}
        footer={(
          <>
            <button type="button" className="secondary-button" data-testid="connection-dialog-cancel" onClick={requestClose}>{savedId && !dirty ? t("models.dialog.done") : t("common.cancel")}</button>
            <button type="submit" form="connection-form" className="primary-button" data-testid="connection-dialog-save" disabled={saving || (!dirty && Boolean(savedId))}>{saving ? t("models.dialog.saving") : t("settings.saveConnection")}</button>
          </>
        )}
      >
        <form id="connection-form" className="connection-form" noValidate onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <div ref={body} className="connection-dialog-body">
            {failure ? <p className="review-error" role="alert" data-testid="connection-dialog-error">{failure}</p> : null}
            <fieldset className="connection-group" data-testid="connection-group-connection">
              <legend>{t("models.dialog.groupConnection")}</legend>
              <label className="msettings-field">
                <span>{t("models.dialog.label")}</span>
                <input {...field("label")} data-testid="connection-label" value={form.label} placeholder={t("models.dialog.labelPlaceholder")} onChange={(event) => change({ label: event.target.value }, ["label"])} />
                {problem("label")}
              </label>
              <label className="msettings-field">
                <span>{t("settings.baseUrl")}</span>
                <input {...field("baseUrl")} data-testid="connection-base-url" inputMode="url" autoComplete="off" value={form.baseUrl} placeholder="https://api.example.com/v1" onChange={(event) => change({ baseUrl: event.target.value }, ["baseUrl"])} />
                {problem("baseUrl")}
              </label>
              <label className="msettings-field">
                <span>{t("models.dialog.modelId")}</span>
                <input {...field("modelId")} data-testid="connection-model-id" autoComplete="off" value={form.modelId} onChange={(event) => change({ modelId: event.target.value }, ["modelId"])} />
                {problem("modelId")}
              </label>
              <label className="msettings-field">
                <span>{t("settings.apiKey")}</span>
                <input {...field("secret")} data-testid="connection-secret" type="password" autoComplete="off" value={form.secret} placeholder={secretKept ? t("models.dialog.secretKept") : ""} onChange={(event) => change({ secret: event.target.value }, ["secret"])} />
                <span className="detail-muted" data-testid="connection-secret-hint">{secretKept ? t("models.dialog.secretHintEdit") : t("models.dialog.secretHintNew")}</span>
                {problem("secret")}
              </label>
              <label className="msettings-field">
                <span>{t("settings.protocol")}</span>
                <select data-testid="connection-protocol" value={form.protocol} onChange={(event) => change({ protocol: event.target.value })}>
                  <option value="openai-chat-completions">{protocolName(t, "openai-chat-completions")}</option>
                  <option value="openai-responses">{protocolName(t, "openai-responses")}</option>
                </select>
              </label>
              <label className="msettings-field">
                <span>{t("settings.purpose")}</span>
                <select data-testid="connection-purpose" value={form.purpose} onChange={(event) => { change({ purpose: event.target.value }); setPlain(null); }}>
                  {(["text", "vision", "transcription", "embedding"] as const).map((purpose) => <option key={purpose} value={purpose}>{purposeName(t, purpose)}</option>)}
                </select>
                <span className="detail-muted">{t(`models.purposeHint.${form.purpose}` as MessageKey)}</span>
              </label>
              <label className="msettings-field">
                <span>{t("settings.connectionRuntime")}</span>
                <select data-testid="connection-runtime" value={form.runtime} onChange={(event) => change({ runtime: event.target.value })}>
                  <option value="native">{runtimeName(t, "native")}</option>
                  <option value="pi">{runtimeName(t, "pi")}</option>
                </select>
              </label>
              <label className="msettings-field">
                <span>{t("models.dialog.timeout")}</span>
                <input {...field("timeout")} data-testid="connection-timeout" inputMode="numeric" value={timeoutText} onChange={(event) => { setTimeoutText(event.target.value); setFailure(null); setErrors((current) => { const { timeout: _t, ...rest } = current; return rest; }); }} />
                {problem("timeout")}
              </label>
            </fieldset>

            {profileApplies && profile ? (
              <fieldset className="connection-group profile-fields" data-testid="profile-fields">
                <legend>{t("models.dialog.groupModel")}</legend>
                <p className="detail-muted">{t("models.profileLead")}</p>
                <label className="msettings-field" title={t("models.windowHint")}>
                  <span>{t("models.window")}</span>
                  <input {...field("window")} type="number" inputMode="numeric" min={4096} data-testid="profile-window" aria-label={t("models.window")} value={profile.contextWindow} onChange={(event) => changeProfile({ ...profile, contextWindow: event.target.value })} />
                  {problem("window")}
                </label>
                <label className="msettings-field" title={t("models.maxOutputHint")}>
                  <span>{t("models.maxOutput")}</span>
                  <input {...field("output")} type="number" inputMode="numeric" min={256} data-testid="profile-output" aria-label={t("models.maxOutput")} value={profile.maxOutput} onChange={(event) => changeProfile({ ...profile, maxOutput: event.target.value })} />
                  {problem("output")}
                </label>
                <div className="msettings-field">
                  <span>{t("models.inputs")}</span>
                  <span className="profile-checks">
                    {MODEL_INPUT_TYPES.map((item) => (
                      <label key={item} className="profile-check">
                        <input type="checkbox" data-testid={`profile-input-${item}`} checked={profile.inputTypes.includes(item)} disabled={item === "text"} onChange={(event) => toggle("inputTypes", item, event.target.checked)} />
                        {t(`models.input.${item}` as MessageKey)}
                      </label>
                    ))}
                  </span>
                </div>
                <p className="detail-muted">{t("models.inputsHint")}</p>
                <div className="msettings-field">
                  <span>{t("models.caps")}</span>
                  <span className="profile-checks">
                    {MODEL_CAPABILITIES.map((item) => (
                      <label key={item} className="profile-check">
                        <input type="checkbox" data-testid={`profile-cap-${item}`} checked={profile.capabilities.includes(item)} onChange={(event) => toggle("capabilities", item, event.target.checked)} />
                        {t(`models.cap.${item}` as MessageKey)}
                      </label>
                    ))}
                  </span>
                </div>
                <p className="detail-muted">{t("models.capsHint")}</p>
                <label className="msettings-field" title={t("models.effortHint")}>
                  <span>{t("models.effort")}</span>
                  <select data-testid="profile-effort" aria-label={t("models.effort")} value={profile.reasoningEffort} disabled={!profile.capabilities.includes("reasoning")} onChange={(event) => changeProfile({ ...profile, reasoningEffort: event.target.value })}>
                    <option value="">{t("models.effort.none")}</option>
                    {REASONING_EFFORTS.map((item) => <option key={item} value={item}>{t(`models.effort.${item}` as MessageKey)}</option>)}
                  </select>
                </label>
              </fieldset>
            ) : null}

            <section className="connection-testing" data-testid="connection-dialog-testing-area">
              <div className="msettings-actions">
                <button type="button" className="secondary-button" data-testid="connection-dialog-test-button" disabled={!savedId || dirty || testing || saving} onClick={() => void test()}>{testing ? t("models.probing") : t("settings.testConnection")}</button>
                <span className="detail-muted" data-testid="connection-dialog-test-hint">{!savedId ? t("models.dialog.testAfterSave") : dirty ? t("models.dialog.testDirty") : savedId && adding ? t("models.dialog.savedNotice") : t("models.dialog.testReady")}</span>
              </div>
              <TestSummary t={t} result={live?.lastTest ?? null} plain={plain} running={testing} formatDate={i18n.formatDate} />
            </section>
          </div>
        </form>
      </Modal>
      {discarding ? (
        <Modal
          variant="dialog"
          testId="connection-discard"
          title={t("models.dialog.discardTitle")}
          description={t("models.dialog.discardBody")}
          closeLabel={t("common.close")}
          onClose={() => setDiscarding(false)}
          footer={(
            <>
              <button type="button" className="secondary-button" data-testid="connection-discard-keep" onClick={() => setDiscarding(false)}>{t("models.dialog.keepEditing")}</button>
              <button type="button" className="danger-button" data-testid="connection-discard-confirm" onClick={props.onClose}>{t("models.dialog.discard")}</button>
            </>
          )}
        ><span /></Modal>
      ) : null}
    </>
  );
}
