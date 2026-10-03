import { useEffect, useRef, useState } from "react";
import { ArrowUp, Bookmark, Captions, Check, Maximize, NotebookPen, Pause, Play, Sparkles, VolumeX } from "lucide-react";
import { createTranslator } from "@manga/i18n";
import { MangaMark } from "./brand.tsx";

const scene = new URL("./assets/anime-demo-scene.jpg", import.meta.url).href;
const poster = new URL("./assets/anime-demo-poster.jpg", import.meta.url).href;
const t = createTranslator("zh-CN").t;
const duration = 23 * 60 + 40;
const initialTime = 18 * 60 + 42;
const time = (seconds: number) => `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
type DemoNote = { id: string; episode: number; seconds: number; text: string };
export type AnimationDemoState = ReturnType<typeof useAnimationDemo>;

/** In-memory demonstration only: never creates a resource, real Agent run or source anchor. */
export function useAnimationDemo(active: boolean) {
  const [episode, setEpisode] = useState(7);
  const [seconds, setSeconds] = useState(initialTime);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [subtitles, setSubtitles] = useState(false);
  const [bookmarks, setBookmarks] = useState<Record<number, number>>({});
  const [notes, setNotes] = useState<DemoNote[]>([]);
  const [draft, setDraft] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [notice, setNotice] = useState("");
  const [summary, setSummary] = useState(false);
  useEffect(() => {
    if (!active || !playing) return;
    const timer = window.setInterval(() => setSeconds((current) => Math.min(duration, current + speed)), 1000);
    return () => window.clearInterval(timer);
  }, [active, playing, speed]);
  useEffect(() => { if (seconds >= duration) setPlaying(false); }, [seconds]);
  const chooseEpisode = (next: number) => { setEpisode(next); setSeconds(next === 7 ? initialTime : 0); setPlaying(false); setSummary(false); setNotice(""); };
  const save = (text: string) => {
    if (!text.trim()) return;
    setNotes((current) => [...current, { id: crypto.randomUUID(), episode, seconds, text: text.trim() }]);
    setDraft(""); setExpanded(false); setNotice(t("demo.saved"));
  };
  return { episode, seconds, setSeconds, playing, setPlaying, speed, setSpeed, subtitles, setSubtitles, bookmarks, setBookmarks, notes, draft, setDraft, expanded, setExpanded, notice, setNotice, summary, setSummary, chooseEpisode, save };
}

export function AnimationDemo({ state: s }: { state: AnimationDemoState }) {
  const player = useRef<HTMLDivElement>(null);
  const names = Array.from({ length: 7 }, (_, index) => t(`demo.episode${index + 1}` as "demo.episode1"));
  const progress = Math.round(s.seconds / duration * 100);
  const marked = s.bookmarks[s.episode] !== undefined;
  return <section className="animation-page" data-testid="page-animation">
    <div className="content-heading"><div><Play size={17} /><h1>{t("demo.title")} <span>· {t("demo.episode", { number: String(s.episode).padStart(2, "0") })}</span></h1></div><span className="demo-label">{t("demo.badge")}</span></div>
    <div className="demo-player" ref={player} data-testid="demo-player">
      <img className="demo-scene" src={scene} alt={t("demo.sceneAlt")} />
      <span className="demo-still-label">{t("demo.still")}</span>
      {s.subtitles ? <p className="demo-subtitle" data-testid="demo-subtitle">{t("demo.subtitle")}</p> : null}
      <div className="demo-controls">
        <input type="range" min={0} max={duration} value={s.seconds} aria-label={t("demo.seek")} data-testid="demo-seek" onChange={(event) => s.setSeconds(Number(event.target.value))} style={{ "--demo-progress": `${progress}%` } as React.CSSProperties} />
        <div className="demo-control-row">
          <button type="button" aria-label={s.playing ? t("demo.pause") : t("demo.play")} data-testid="demo-play" onClick={() => { if (s.seconds >= duration) s.setSeconds(0); s.setPlaying(!s.playing); }}>{s.playing ? <Pause size={21} /> : <Play size={21} />}</button>
          <span title={t("demo.silent")}><VolumeX size={18} /></span>
          <span className="demo-time" data-testid="demo-time">{time(s.seconds)} / {time(duration)}</span>
          <span className="flex-1" />
          <button type="button" aria-label={t("demo.captions")} aria-pressed={s.subtitles} data-testid="demo-captions" onClick={() => s.setSubtitles(!s.subtitles)}><Captions size={20} /></button>
          <select aria-label={t("demo.speed")} value={s.speed} onChange={(event) => s.setSpeed(Number(event.target.value))}>{[0.5, 1, 1.5, 2].map((value) => <option key={value} value={value}>{value.toFixed(1)}×</option>)}</select>
          <button type="button" aria-label={t("demo.fullscreen")} onClick={() => { const request = document.fullscreenElement ? document.exitFullscreen() : player.current?.requestFullscreen(); void request?.catch(() => s.setNotice(t("demo.fullscreenFailed"))); }}><Maximize size={19} /></button>
        </div>
      </div>
    </div>
    <div className="demo-metadata">
      <img className="demo-poster" src={poster} alt={t("demo.title")} />
      <div className="demo-description"><h2>{t("demo.title")} <span>· {t("demo.episode", { number: String(s.episode).padStart(2, "0") })}</span></h2><div className="demo-tags"><span>{t("demo.genre1")}</span><span>{t("demo.genre2")}</span><span>{t("demo.genre3")}</span></div><p>{t("demo.position")} {time(s.seconds)} / {time(duration)}</p><progress value={s.seconds} max={duration} aria-label={t("demo.position")} /></div>
      <div className="demo-actions"><button type="button" data-testid="demo-note" onClick={() => s.setExpanded(!s.expanded)}><NotebookPen size={17} />{t("nav.notes")}</button><button type="button" data-testid="demo-bookmark" aria-pressed={marked} onClick={() => s.setBookmarks((current) => { const next = { ...current }; if (marked) delete next[s.episode]; else next[s.episode] = s.seconds; return next; })}>{marked ? <Check size={17} /> : <Bookmark size={17} />}{marked ? t("demo.marked") : t("demo.mark")}</button><button type="button" onClick={() => s.setSubtitles(!s.subtitles)} aria-pressed={s.subtitles}><Captions size={17} />{t("demo.captions")}</button></div>
    </div>
    {s.expanded ? <form className="demo-note-form" onSubmit={(event) => { event.preventDefault(); s.save(s.draft); }}><label htmlFor="demo-note-input">{t("demo.noteAt", { time: time(s.seconds) })}</label><textarea id="demo-note-input" data-testid="demo-note-input" value={s.draft} onChange={(event) => s.setDraft(event.target.value)} autoFocus /><button type="submit" data-testid="demo-note-save" disabled={!s.draft.trim()}>{t("demo.save")}</button><button type="button" onClick={() => s.setExpanded(false)}>{t("demo.close")}</button></form> : null}
    {s.notice ? <p role="status" className="demo-notice">{s.notice}</p> : null}
    <section className="episode-section"><div className="section-heading"><h2>{t("demo.episodes")}</h2><span>{t("demo.seven")}</span></div><div className="episode-grid">{names.map((name, index) => <button type="button" key={name} data-testid={`demo-episode-${index + 1}`} aria-pressed={s.episode === index + 1} onClick={() => s.chooseEpisode(index + 1)}><div className={`episode-image episode-look-${index}`}><img src={scene} alt="" /><span><Play size={15} /></span></div><p><span>{String(index + 1).padStart(2, "0")}</span>{name}</p></button>)}</div></section>
    <p className="demo-disclosure">{t("demo.disclosure")}</p>
  </section>;
}

export function AnimationDemoAgent({ state: s }: { state: AnimationDemoState }) {
  const [prompt, setPrompt] = useState("");
  const currentNotes = s.notes.filter((note) => note.episode === s.episode);
  return <div className="demo-agent" data-testid="demo-agent">
    <div className="context-chips"><span><Play size={13} />{t("demo.context")}</span><span>{t("demo.episode", { number: String(s.episode).padStart(2, "0") })}</span><span>{t("demo.script")}</span></div>
    <div className="demo-conversation">
      <div className="demo-user-message">{t("demo.question")}</div>
      <div className="demo-assistant-message"><span className="assistant-avatar"><Sparkles size={20} /></span><div><p>{t("demo.answer")}</p><h3>{t("demo.keyMoments")}</h3><ol><li><strong>12:37</strong>　{t("demo.moment1")}</li><li><strong>18:02</strong>　{t("demo.moment2")}</li><li><strong>21:15</strong>　{t("demo.moment3")}</li></ol><p className="demo-script-label">{t("demo.scriptDisclosure")}</p></div></div>
      {s.summary ? <div className="demo-assistant-message"><span className="assistant-avatar"><MangaMark size={19} /></span><div>{t("demo.summaryNotice")}</div></div> : null}
      {currentNotes.map((note) => <div className="demo-assistant-message" key={note.id}><span className="assistant-avatar"><Sparkles size={20} /></span><div><p>{t("demo.saved")}</p><button type="button" className="demo-source-card" data-testid="demo-source-card" onClick={() => s.setSeconds(note.seconds)}><Bookmark size={18} /><span><strong>{time(note.seconds)} · {t("demo.temporaryNote")}</strong><span>{note.text}</span></span></button></div></div>)}
    </div>
    <form className="agent-compose demo-compose" onSubmit={(event) => { event.preventDefault(); s.save(prompt); setPrompt(""); }}>
      <label className="sr-only" htmlFor="demo-agent-input">{t("demo.localPrompt")}</label><textarea id="demo-agent-input" data-testid="demo-agent-input" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={t("demo.promptPlaceholder")} />
      <div className="compose-actions"><button type="button" onClick={() => s.setSummary(true)}>{t("demo.showScript")}</button><span className="flex-1" /><button type="submit" className="send-circle" aria-label={t("demo.save")} data-testid="demo-agent-save" disabled={!prompt.trim()}><ArrowUp size={20} /></button></div>
    </form><p className="agent-footnote">{t("demo.localOnly")}</p>
  </div>;
}
