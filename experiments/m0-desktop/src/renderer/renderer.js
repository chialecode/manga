import { EditHistory } from "./history.js";
import { decodePlayback } from "./playback.js";
const $ = id => document.getElementById(id);
const api = window.mangaM0;
const editor = $("editor");
const history = new EditHistory();
let noteId, revision, editingBlockId, savedText = "", source, state;
let sourceGeneration = 0;
let timer, saving, ready = false;
let capture, recorder, stream, recordingBusy = false;
let recoveredBlob;
let sourceSize = 15;
let currentLocator;
let captureSaveKey;
let audioContext, processor, capturedSamples = 0;
let joint = false;
const player = {
  attachmentId: undefined,
  objectUrl: undefined,
  generation: 0,
  duration: NaN,
  resumeAt: undefined,
};
const key = () => crypto.randomUUID();
const error = cause => { $("errorStatus").textContent = cause?.message ?? String(cause); };
function status(message, kind = "") { $("saveStatus").textContent = message; $("saveStatus").className = `status ${kind}`; }
function codePoints(text) { return [...text]; }
function utf16RangeToCodePoints(text, start, end) {
  return { start: codePoints(text.slice(0, start)).length, end: codePoints(text.slice(0, start)).length + codePoints(text.slice(start, end)).length };
}
function sliceCodePoints(text, start, end) { return codePoints(text).slice(start, end).join(""); }
async function command(commandId, input, idempotencyKey = key()) {
  const result = await api.command({ commandId, input, idempotencyKey });
  if (result?.status !== "ok") throw new Error(result?.error?.message ?? "操作未完成");
  return result.value;
}
function formatTime(value) {
  if (!Number.isFinite(value)) return "--";
  return value.toFixed(2);
}
function captureOffsetMs() {
  if (capture?.sampleRate) return (capturedSamples / capture.sampleRate) * 1000;
  if (capture) return Math.max(0, performance.now() - capture.startedAt);
  return 0;
}
function recordCaptureEvent(reason, extra = {}) {
  if (!capture) return;
  const media = extra.media;
  const textLocator = currentLocator ?? (source?.parts?.[0] ? {kind:"text",partId:source.parts[0].id,representationId:source.revisionId,normalizationVersion:"text-nfc-lf-v1",range:{start:0,end:0}} : undefined);
  capture.positions.push({
    captureOffsetMs: captureOffsetMs(),
    monotonicMs: performance.now() - capture.startedAt,
    resourceId: media ? media.dataset.resourceId : extra.resourceId ?? source?.id,
    resourceRevisionId: media ? media.dataset.revisionId : extra.resourceRevisionId ?? source?.revisionId,
    reason,
    clockDomainId: "capture-samples",
    playing: extra.playing ?? (media ? !media.paused : undefined),
    playbackRate: extra.playbackRate ?? media?.playbackRate,
    locator: extra.locator ?? (media && Number.isFinite(media.currentTime) ? { kind: "temporal", startMs: Math.round(media.currentTime * 1000) } : textLocator),
  });
  logJoint(`${reason} sampleMs=${captureOffsetMs().toFixed(1)}`);
}
function sourceChanged(resource, options = {}) {
  sourceGeneration++;
  currentLocator = undefined;
  source = resource;
  $("sourceTitle").textContent = resource.title + (resource.previewOnly ? " · 列表预览，正在读取全文" : "");
  recordCaptureEvent("resource_change", { resourceId: source.id, resourceRevisionId: source.revisionId, locator: currentLocator });
  if (!options.skipLoad) loadSource(resource.id).catch(error);
}
async function loadSource(resourceId) {
  const generation = sourceGeneration;
  const full = await command("library.getResource", { resourceId });
  if(generation !== sourceGeneration || source?.id !== resourceId) return;
  source = { ...source, ...full, previewOnly: false, text: (full.parts ?? []).map(part => part.normalized).join("\n\n") };
  $("sourceTitle").textContent = `${full.title} · ${full.length} 字符`;
  renderSource(full.progress);
  currentLocator = full.progress;
}
function renderSource(locator) {
  const root = $("sourceView");
  root.replaceChildren();
  const DISPLAY_LIMIT = 8000;
  if (!source?.parts?.length && source?.text) {
    const chars = codePoints(source.text);
    root.textContent = chars.length > DISPLAY_LIMIT ? chars.slice(0, DISPLAY_LIMIT).join("") : source.text;
    return;
  }
  let truncated = false;
  for (const part of source.parts ?? []) {
    const block = document.createElement("div");
    block.dataset.partId = part.id;
    const text = part.normalized;
    const total = codePoints(text).length;
    const focused = locator?.partId === part.id && locator.range;
    let display = text;
    if (!focused && total > DISPLAY_LIMIT) {
      display = sliceCodePoints(text, 0, DISPLAY_LIMIT);
      truncated = true;
    }
    if (focused) {
      const utf = (() => {
        const chars = codePoints(text);
        const prefix = chars.slice(0, locator.range.start).join("");
        const inner = chars.slice(locator.range.start, locator.range.end).join("");
        return { start: prefix.length, end: prefix.length + inner.length };
      })();
      block.append(text.slice(0, utf.start), Object.assign(document.createElement("mark"), { id: "sourceHighlight", textContent: text.slice(utf.start, utf.end) }), text.slice(utf.end));
    } else {
      block.textContent = display;
    }
    root.append(block);
  }
  if (truncated) {
    const note = document.createElement("p");
    note.className = "muted";
    note.textContent = "全文已加载供定位；首屏仅渲染代表性开头。";
    root.append(note);
  }
  $("sourceHighlight")?.scrollIntoView({ block: "center" });
}
function listButton(text, action, attrs = {}) {
  const li = document.createElement("li"), button = document.createElement("button");
  button.textContent = text;
  button.type = "button";
  Object.assign(button.dataset, attrs);
  button.onclick = () => Promise.resolve(action()).catch(error);
  li.append(button);
  return li;
}
function captureLabel(item) {
  const time = new Date(item.createdAt).toLocaleTimeString();
  const dur = Number.isFinite(item.durationMs) ? ` · ${formatTime(item.durationMs / 1000)}s` : "";
  return `回放录音 · ${time}${dur}`;
}
function refreshCaptureList() {
  const items = state.captures ?? [];
  const existing = new Map([...$("captures").querySelectorAll("li")].map(li => [li.dataset.attachmentId, li]));
  const next = [];
  for (const item of items) {
    let li = existing.get(item.attachmentId);
    if (!li) {
      li = listButton(captureLabel(item), () => openCapture(item), { attachmentId: item.attachmentId });
      li.dataset.attachmentId = item.attachmentId;
    } else {
      li.querySelector("button").textContent = captureLabel(item);
      existing.delete(item.attachmentId);
    }
    next.push(li);
  }
  $("captures").replaceChildren(...next);
}
async function refresh() {
  state = await command("workspace.get", {});
  $("noteList").replaceChildren(...state.notes.map(note => listButton(note.text.slice(0, 28) || "空白笔记", async () => { await save(); loadNote(state.notes.find(item => item.id === note.id)); })));
  $("resourceList").replaceChildren(...state.resources.map(resource => listButton(resource.title, () => sourceChanged(resource))));
  if (!source && state.resources[0]) sourceChanged(state.resources[0]);
  refreshCaptureList();
  renderBlocks(state.notes.find(note => note.id === noteId));
}
function renderBlocks(note) {
  const blocks = note?.blocks ?? [];
  $("blockList").replaceChildren(...blocks.map(block => {
    const li = document.createElement("li");
    const button=document.createElement("button");
    button.textContent = `${block.id} · ${block.type} · ${block.text.slice(0, 24)}`;
    button.disabled=block.type === "embed";
    button.onclick=async()=>{try{await save();loadNote(state.notes.find(item=>item.id===note.id),block.id);}catch(cause){error(cause);}};
    li.append(button);
    return li;
  }));
}
function loadNote(note, blockId) {
  const block=note?.blocks?.find(item=>item.id===blockId) ?? note?.blocks?.find(item=>item.type!=="embed");
  editingBlockId=block?.id;
  noteId = note?.id; revision = note?.revision; savedText = block?.text ?? note?.text ?? "";
  editor.value = savedText; history.reset(savedText);
  status(note ? "已从本机恢复 · 已保存到本机" : "新笔记 · 输入后自动保存", note ? "ok" : "");
  renderBlocks(note);
  if (note?.id) {
    command("workspace.get", {}).then(snapshot => {
      const fresh = snapshot.notes.find(item => item.id === note.id);
      if (fresh?.blocks && noteId===note.id) renderBlocks(fresh);
    }).catch(() => undefined);
  }
}
async function save() {
  clearTimeout(timer);
  if (!ready || history.composing) return;
  if (saving) { await saving; if (editor.value !== savedText) return save(); return; }
  const text = editor.value;
  if (text === savedText) return;
  const target = noteId;
  status("保存中…");
  saving = (async () => {
    const result = target
      ? await command("notes.update", { objectId: target, expectedRevision: revision, blockId:editingBlockId, text })
      : await command("notes.create", { title: "验证笔记", text });
    noteId = result.objectId; revision = result.revision; savedText = text;
    editingBlockId ??= "b1";
    status(editor.value === text ? "已保存到本机 · 可关闭后重新打开验证" : "还有新修改待保存", editor.value === text ? "ok" : "");
    await refresh();
  })();
  try { await saving; } catch (cause) { status(`保存失败：${cause.message}（正文仍保留，请重试）`, "error"); throw cause; } finally { saving = undefined; }
}
function changed() {
  if (!ready || history.composing) return;
  history.record(editor.value);
  status(editor.value === savedText ? "已保存到本机" : "未保存 · 即将自动保存", editor.value === savedText ? "ok" : "");
  clearTimeout(timer); timer = setTimeout(() => save().catch(error), 400);
}
editor.addEventListener("compositionstart", () => { clearTimeout(timer); history.begin(); status("输入法组合中"); });
editor.addEventListener("compositionend", () => { history.end(editor.value); changed(); });
editor.addEventListener("input", changed);
function moveHistory(direction) {
  if (history.composing) return;
  editor.value = history[direction]();
  editor.focus(); editor.setSelectionRange(editor.value.length, editor.value.length);
  status("已撤销/重做 · 即将保存");
  clearTimeout(timer); timer = setTimeout(() => save().catch(error), 400);
}
editor.addEventListener("keydown", event => {
  if (history.composing || event.isComposing || event.keyCode === 229) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); moveHistory(event.shiftKey ? "redo" : "undo"); }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); save().catch(error); }
});
$("saveBtn").onclick = () => save().catch(error);
$("undoBtn").onclick = () => moveHistory("undo");
$("redoBtn").onclick = () => moveHistory("redo");
$("newBtn").onclick = async () => { try { await save(); loadNote(); editor.focus(); } catch (cause) { error(cause); } };
$("importBtn").onclick = async () => {
  try { await command("library.importText", { title: "内置定位样本", bytes: [...new TextEncoder().encode("春が来た。\n中文、日文与 emoji 🌸。\n同一句。同一句。\n可以在这里核对导入和重启恢复。\n")] }, "builtin-text-v2"); await refresh(); sourceChanged(state.resources.find(item => item.title === "内置定位样本")); $("libraryStatus").textContent = "已导入到本机，可在来源区域阅读"; }
  catch (cause) { error(cause); }
};
$("openFileBtn").onclick = async () => {
  try { const result = await api.openFile(); if (!result) return; if (result.status !== "ok") throw new Error(result.error.message); await refresh(); sourceChanged(state.resources.find(item => item.id === result.value.resourceId)); $("libraryStatus").textContent = "文件已导入到本机"; } catch (cause) { error(cause); }
};
$("exportPkgBtn").onclick = async () => {
  try { const result = await api.exportPackage(); if (!result) return; if (result.status !== "ok") throw new Error(result.error?.message ?? "导出失败"); $("libraryStatus").textContent = "资料包已导出"; } catch (cause) { error(cause); }
};
$("importPkgBtn").onclick = async () => {
  try { const result = await api.importPackage(); if (!result) return; if (result.status !== "ok") throw new Error(result.error?.message ?? "导入失败"); await refresh(); $("libraryStatus").textContent = "资料包已导入"; } catch (cause) { error(cause); }
};
function selectionLocator() {
  const sel = getSelection();
  if (!sel || sel.rangeCount === 0 || !$("sourceView").contains(sel.anchorNode)) return null;
  const range = sel.getRangeAt(0);
  if (!$("sourceView").contains(range.endContainer)) throw new Error("选区必须位于来源正文内");
  const partNode = range.startContainer.nodeType === 1 ? range.startContainer.closest("[data-part-id]") : range.startContainer.parentElement?.closest("[data-part-id]");
  const part = partNode ?? $("sourceView").firstElementChild;
  if (!part) return null;
  if(!part.contains(range.endContainer)) throw new Error("原型一次保存一个章节内的选区，请分段选择");
  const pre = document.createRange();
  pre.selectNodeContents(part);
  pre.setEnd(range.startContainer, range.startOffset);
  const utfStart = pre.toString().length;
  const exact = range.toString();
  if (!exact) return null;
  const text = part.textContent ?? "";
  const cp = utf16RangeToCodePoints(text, utfStart, utfStart + exact.length);
  return {
    kind: "text",
    partId: part.dataset.partId || "body",
    representationId: source.revisionId,
    normalizationVersion: "text-nfc-lf-v1",
    range: cp,
    quote: { exact: sliceCodePoints(text, cp.start, cp.end), prefix: sliceCodePoints(text, Math.max(0, cp.start - 8), cp.start), suffix: sliceCodePoints(text, cp.end, Math.min(codePoints(text).length, cp.end + 8)) },
  };
}
$("saveAnchorBtn").onclick = async () => {
  try {
    const locator = selectionLocator();
    if (!locator || !source) throw new Error("请先在来源正文中选择一段文字");
    currentLocator = locator;
    const created = await command("notes.create", { title: "选区锚点", text: locator.quote.exact, resourceId: source.id, resourceRevisionId: source.revisionId, locator });
    await command("progress.set", { resourceId: source.id, resourceRevisionId: source.revisionId, locator });
    $("anchorStatus").textContent = `已保存选区：${locator.quote.exact}`;
    await refresh();
    renderSource(locator);
  } catch (cause) { error(cause); }
};
$("jumpAnchorBtn").onclick = async () => {
  try {
    if (!currentLocator || !source) throw new Error("没有可跳转的选区");
    const resolved = await command("reader.resolveAnchor", { resourceRevisionId: source.revisionId, locator: currentLocator });
    $("anchorStatus").textContent = resolved.status === "resolved" ? `已跳回：${resolved.text}` : `定位结果：${resolved.status}`;
    if (resolved.status === "resolved") renderSource(currentLocator);
  } catch (cause) { error(cause); }
};
$("smallerType").onclick = () => { sourceSize = Math.max(12, sourceSize - 2); document.documentElement.style.setProperty("--source-size", `${sourceSize}px`); };
$("largerType").onclick = () => { sourceSize = Math.min(28, sourceSize + 2); document.documentElement.style.setProperty("--source-size", `${sourceSize}px`); };
$("splitBtn").onclick = async () => {
  try {
    if (!noteId) throw new Error("没有笔记可分拆");
    const offset = editor.selectionStart ?? 0;
    await save();
    const blockId=editingBlockId;
    const result = await command("notes.split", { objectId: noteId, expectedRevision: revision, blockId, offset: [...editor.value.slice(0, offset)].length });
    revision = result.revision;
    await refresh();
    loadNote(state.notes.find(item=>item.id===noteId),blockId);
  } catch (cause) { error(cause); }
};
$("mergeBtn").onclick = async () => {
  try {
    if (!noteId) throw new Error("没有笔记可合并");
    await save();
    const blockId=editingBlockId;
    const result = await command("notes.merge", { objectId: noteId, expectedRevision: revision, blockId });
    revision = result.revision;
    await refresh();
    loadNote(state.notes.find(item=>item.id===noteId),blockId);
  } catch (cause) { error(cause); }
};
function revokePlayerUrl() {
  if (player.objectUrl) URL.revokeObjectURL(player.objectUrl);
  player.objectUrl = undefined;
}
function persistPlaybackPosition() {
  if (!player.attachmentId || !Number.isFinite($("playerAudio").currentTime)) return;
  command("capture.markPlayback", { attachmentId: player.attachmentId, positionMs: Math.round($("playerAudio").currentTime * 1000) }).catch(() => undefined);
}
function bindPlayer() {
  const audio = $("playerAudio");
  audio.addEventListener("loadedmetadata", () => {
    const duration = audio.duration;
    if (Number.isFinite(duration) && duration > 0) {
      player.duration = duration;
      $("playerSeek").max = String(duration);
      $("playerTime").textContent = `${formatTime(audio.currentTime)} / ${formatTime(duration)}`;
      $("playerDock").dataset.ready = "true";
      if (Number.isFinite(player.resumeAt)) {
        audio.currentTime = Math.min(player.resumeAt, duration);
        player.resumeAt = undefined;
      }
    }
  });
  audio.addEventListener("timeupdate", () => {
    if (!Number.isFinite(player.duration)) return;
    if (!$("playerSeek").dataset.dragging) $("playerSeek").value = String(audio.currentTime);
    $("playerTime").textContent = `${formatTime(audio.currentTime)} / ${formatTime(player.duration)}`;
    $("playPauseBtn").textContent = audio.paused ? "播放" : "暂停";
  });
  audio.addEventListener("play", () => recordCaptureEvent("resume", { media:audio, playing: true, playbackRate: audio.playbackRate, locator: { kind: "temporal", startMs: Math.round(audio.currentTime * 1000) } }));
  audio.addEventListener("pause", () => {
    recordCaptureEvent("pause", { media:audio, playing: false, playbackRate: audio.playbackRate, locator: { kind: "temporal", startMs: Math.round(audio.currentTime * 1000) } });
    persistPlaybackPosition();
  });
  audio.addEventListener("seeked", () => {
    recordCaptureEvent("seek", { media:audio, playing: !audio.paused, playbackRate: audio.playbackRate, locator: { kind: "temporal", startMs: Math.round(audio.currentTime * 1000) } });
    persistPlaybackPosition();
  });
  audio.addEventListener("ratechange", () => recordCaptureEvent("rate_change", { media:audio, playing: !audio.paused, playbackRate: audio.playbackRate, locator: { kind: "temporal", startMs: Math.round(audio.currentTime * 1000) } }));
  audio.addEventListener("ended", () => { $("playPauseBtn").textContent = "重播"; persistPlaybackPosition(); });
  $("playerSeek").addEventListener("pointerdown", () => { $("playerSeek").dataset.dragging = "1"; });
  $("playerSeek").addEventListener("pointerup", () => { delete $("playerSeek").dataset.dragging; });
  $("playerSeek").addEventListener("input", () => {
    const next = Number($("playerSeek").value);
    if (Number.isFinite(next)) audio.currentTime = next;
  });
  $("playPauseBtn").onclick = () => {
    if (audio.paused) audio.play().catch(error); else audio.pause();
  };
  $("playerRate").onchange = () => { audio.playbackRate = Number($("playerRate").value) || 1; };
  $("exportCaptureBtn").onclick = () => exportCurrent().catch(error);
}
async function openCapture(item) {
  if (player.attachmentId === item.attachmentId && $("playerAudio").src) {
    $("playerDock").hidden = false;
    return;
  }
  const generation = ++player.generation;
  persistPlaybackPosition();
  const audio = $("playerAudio");
  audio.pause();
  revokePlayerUrl();
  audio.removeAttribute("src");
  audio.load();
  player.attachmentId = undefined;
  player.duration = NaN;
  $("playerDock").hidden = false;
  $("playerTitle").textContent = captureLabel(item);
  $("exportCaptureBtn").dataset.attachmentId = item.attachmentId;
  $("playerSeek").max = "0";
  $("playerTime").textContent = "正在准备回放…";
  delete $("playerDock").dataset.ready;
  const data = await api.readCapture(item.attachmentId, "play");
  if (generation !== player.generation) return;
  const bytes = data.bytes ?? data;
  let playbackBlob;
  try { playbackBlob = await decodePlayback(bytes); }
  catch(cause) {
    if(generation===player.generation) $("playerTime").textContent="暂不能回放，仍可导出原始录音";
    throw cause;
  }
  if (generation !== player.generation) return;
  player.attachmentId = item.attachmentId;
  player.duration = NaN;
  player.resumeAt = Number(data.lastPlaybackMs) > 0 ? data.lastPlaybackMs / 1000 : undefined;
  player.objectUrl = URL.createObjectURL(playbackBlob);
  audio.src = player.objectUrl;
  $("playerDock").hidden = false;
  $("playerTitle").textContent = captureLabel(item);
  $("exportCaptureBtn").dataset.attachmentId = item.attachmentId;
  $("playerSeek").max = "0";
  $("playerTime").textContent = "正在准备回放…";
  audio.load();
}
async function exportCurrent() {
  const attachmentId = $("exportCaptureBtn").dataset.attachmentId || player.attachmentId;
  if (!attachmentId) throw new Error("没有可导出的录音");
  const result = await api.exportCapture(attachmentId);
  if (result?.status === "cancelled") { $("recordStatus").textContent = "已取消导出"; return; }
  if (result?.status !== "ok") throw new Error(result?.error?.message ?? "导出失败");
  $("recordStatus").textContent = `已导出 ${result.name}（${result.bytes} 字节）`;
}
async function devices() {
  const selected = $("device").value;
  const options = [new Option("系统默认麦克风", "")];
  for (const device of await navigator.mediaDevices.enumerateDevices()) if (device.kind === "audioinput" && device.deviceId) options.push(new Option(device.label || "麦克风", device.deviceId));
  $("device").replaceChildren(...options); $("device").value = selected;
}
async function persistRecording(blob, metadata) {
  recoveredBlob = { blob, metadata, key: recoveredBlob?.key ?? captureSaveKey ?? key() };
  captureSaveKey = recoveredBlob.key;
  await command("capture.save", { bytes: [...new Uint8Array(await blob.arrayBuffer())], mimeType: "audio/webm", metadata }, recoveredBlob.key);
  recoveredBlob = undefined;
  captureSaveKey = undefined;
  await refresh();
}
function logJoint(line) {
  if(!joint) return;
  $("jointLog").hidden = false;
  $("jointLog").textContent += `${new Date().toISOString()} ${line}\n`;
}
$("startJoint").onclick = () => {
  joint = true;
  $("jointLog").hidden = false;
  $("jointLog").textContent = "联合测试已开始。将记录采样时钟、来源切换、播放/暂停/倍速/跳转。停止录音后自动保存。请用户主动开始真实麦克风。\n";
};
$("startRecord").onclick = async () => {
  if (recordingBusy || recorder?.state === "recording") return;
  recordingBusy = true; $("startRecord").disabled = true;
  const requestedAt = performance.now();
  $("recordStatus").textContent = "正在请求麦克风…";
  try {
    if (recoveredBlob) await persistRecording(recoveredBlob.blob, recoveredBlob.metadata);
    await api.armRecording();
    const deviceId = $("device").value;
    stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), echoCancellation: true, noiseSuppression: true } });
    await devices();
    const track = stream.getAudioTracks()[0];
    const settings = track.getSettings();
    audioContext = new AudioContext({ sampleRate: settings.sampleRate });
    const sourceNode = audioContext.createMediaStreamSource(stream);
    processor = audioContext.createScriptProcessor(4096, 1, 1);
    capturedSamples = 0;
    processor.onaudioprocess = event => { if(recorder?.state === "recording") capturedSamples += event.inputBuffer.length; };
    sourceNode.connect(processor);
    const mute = audioContext.createGain();
    mute.gain.value = 0;
    processor.connect(mute);
    mute.connect(audioContext.destination);
    const chunks = []; let totalBytes = 0;
    recorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
    const firstSampleAt = performance.now();
    capture = {
      requestedAt,
      startedAt: firstSampleAt,
      permissionMs: firstSampleAt - requestedAt,
      clock: "audio-samples",
      sampleRate: audioContext.sampleRate,
      blockFrames:4096,
      timingAccuracy: "captureOffset uses processed audio frames after the stream is live; hardware analog offset is not calibrated",
      settings: { sampleRate: settings.sampleRate, channelCount: settings.channelCount, echoCancellation: settings.echoCancellation },
      positions: [],
    };
    recorder.ondataavailable = event => { if (event.data.size) { chunks.push(event.data); totalBytes += event.data.size; if (totalBytes > 12 * 1024 * 1024 && recorder.state === "recording") recorder.stop(); } };
    recorder.onstart = () => { capturedSamples=0;capture.startedAt=performance.now();recordCaptureEvent("start");$("recordStatus").textContent = "正在录音 · 点击停止并保存"; $("stopRecord").disabled = false; logJoint("recorder-start"); };
    const stopOnDisconnect = () => { $("recordStatus").textContent = "设备已断开，正在保留录音"; if (recorder?.state === "recording") recorder.stop(); };
    track.onended = stopOnDisconnect;
    recorder.onerror = event => { $("recordStatus").textContent = `录音错误：${event.error?.message ?? "设备失败"}`; if (recorder?.state === "recording") recorder.stop(); };
    recorder.onstop = async () => {
      recordCaptureEvent("stop");
      const durationFromSamples = capture.sampleRate ? (capturedSamples / capture.sampleRate) * 1000 : undefined;
      const metadata = { ...capture, durationMs: durationFromSamples, bytes: totalBytes, samples: capturedSamples };
      processor?.disconnect(); audioContext?.close().catch(() => undefined);
      stream.getTracks().forEach(item => item.stop()); capture = undefined;
      $("recordStatus").textContent = "采集已停止，正在保存到本机…";
      $("stopRecord").disabled = true;
      try { if (!totalBytes) throw new Error("没有采集到音频"); await persistRecording(new Blob(chunks, { type: "audio/webm" }), metadata); $("recordStatus").textContent = "录音已保存到本机 · 使用下方播放器回放或导出"; }
      catch (cause) { $("recordStatus").textContent = `保存失败：${cause.message}；请保留窗口，点击开始可先重试保存`; error(cause); }
      finally { recordingBusy = false; $("startRecord").disabled = false; $("device").disabled = false; }
    };
    $("device").disabled = true;
    recorder.start(250);
    const current = recorder; setTimeout(() => { if (current.state === "recording") current.stop(); }, 120000);
  } catch (cause) {
    processor?.disconnect(); audioContext?.close().catch(()=>undefined);
    stream?.getTracks().forEach(item => item.stop()); capture = undefined;
    $("recordStatus").textContent = `未能录音：${cause.message}`;
    recordingBusy = false; $("startRecord").disabled = false; $("device").disabled = false;
  }
};
$("stopRecord").onclick = () => { if (recorder?.state === "recording") { $("recordStatus").textContent = "正在停止采集…"; recorder.stop(); } };
async function showMedia(kind) {
  const sample = await api.readMediaSample(kind);
  $("mediaStage").replaceChildren();
  if (!sample) { $("mediaStatus").textContent = JSON.stringify({ kind, status: "missing-sample" }); return; }
  const blob = new Blob([Uint8Array.from(sample.bytes)], { type: sample.mime });
  const url = URL.createObjectURL(blob);
  if (kind === "image") {
    const image = document.createElement("img");
    image.alt = sample.name; image.src = url;
    $("mediaStage").append(image);
    await new Promise(resolve => { image.onload = resolve; image.onerror = resolve; });
    $("mediaStatus").textContent = JSON.stringify({ kind, name: sample.name, width: image.naturalWidth, height: image.naturalHeight, status: image.naturalWidth ? "played" : "error" });
    return;
  }
  const video = document.createElement("video");
  video.controls = true; video.muted = true; video.playsInline = true; video.src = url;
  const canPlay = video.canPlayType(sample.mime || "video/mp4");
  $("mediaStage").append(video);
  await new Promise(resolve => {
    video.addEventListener("loadedmetadata", resolve, { once: true });
    video.addEventListener("error", resolve, { once: true });
    setTimeout(resolve, 4000);
  });
  let playError;
  try { await video.play(); } catch (cause) { playError = cause.message; }
  await new Promise(resolve => setTimeout(resolve, 280));
  video.addEventListener("play", () => recordCaptureEvent("resume", { media:video, playing: true, playbackRate: video.playbackRate, locator: { kind: "temporal", startMs: Math.round(video.currentTime * 1000) } }));
  video.addEventListener("pause", () => recordCaptureEvent("pause", { media:video, playing: false, playbackRate: video.playbackRate, locator: { kind: "temporal", startMs: Math.round(video.currentTime * 1000) } }));
  video.addEventListener("seeked", () => recordCaptureEvent("seek", { media:video, playing: !video.paused, playbackRate: video.playbackRate, locator: { kind: "temporal", startMs: Math.round(video.currentTime * 1000) } }));
  const played = Number.isFinite(video.duration) && video.duration > 0 && !video.error && !playError;
  $("mediaStatus").textContent = JSON.stringify({
    kind, name: sample.name, mime: sample.mime, canPlay, duration: video.duration, currentTime: video.currentTime,
    paused: video.paused, playError, mediaError: video.error?.message, status: played ? "played" : "rejected",
  });
}
$("loadVideoBtn").onclick = () => showMedia("video").catch(error);
$("loadHevcBtn").onclick = () => showMedia("hevc").catch(error);
$("loadImageBtn").onclick = () => showMedia("image").catch(error);
window.addEventListener("beforeunload", event => { if (editor.value !== savedText || saving || recordingBusy || recoveredBlob) { event.preventDefault(); event.returnValue = "仍有未保存内容或录音，请先保存/停止"; } });
window.addEventListener("pagehide", revokePlayerUrl);
bindPlayer();
(async () => {
  try { const host = await api.status(); $("hostStatus").textContent = host.packaged ? "独立打包原型 · 本地运行" : "开发原型 · 本地运行"; $("diagnostics").textContent = `进程 ${host.pid}；数据目录 ${host.profileDir}`; await refresh(); loadNote(state.notes[0]); ready = true; document.body.dataset.ready = "true"; await devices(); }
  catch (cause) { error(cause); status("本地数据服务连接失败，暂不能保存", "error"); }
})();
