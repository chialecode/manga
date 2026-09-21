"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
exports.run = async ({ window, profileDir, packaged }) => {
  const js = source => window.webContents.executeJavaScript(source, true);
  const until = async (expression, label) => {
    const start = Date.now();
    while (!(await js(expression))) {
      if (Date.now() - start > 20000) throw new Error(`${label}: ${await js("document.body.innerText")}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  await until('document.body.dataset.ready === "true"', "ready");
  const phase = process.env.M0_SMOKE_PHASE || "initial";
  if (phase.startsWith("bench")) {
    const startupMs = Date.now() - Number(process.env.M0_LAUNCHED_AT);
    const timings = phase === "bench-detail" ? await js(`(async()=>{
      const samples=[];const editor=document.getElementById("editor");
      for(let i=0;i<100;i++) {
        const start=performance.now(); editor.value="性能验证 "+i;
        editor.dispatchEvent(new InputEvent("input",{bubbles:true,data:String(i)}));
        if(!document.getElementById("saveStatus").textContent.includes("未保存")) throw new Error("missing input feedback");
        samples.push(performance.now()-start);
        await new Promise(resolve=>setTimeout(resolve,0));
      }
      const start=performance.now(); editor.value="自动保存验证";editor.dispatchEvent(new InputEvent("input",{bubbles:true}));
      while(!document.getElementById("saveStatus").textContent.startsWith("已保存到本机")) {if(performance.now()-start>10000) throw new Error(document.body.innerText); await new Promise(resolve=>setTimeout(resolve,10));}
      const autoSaveMs=performance.now()-start;
      const ctxStart=performance.now();
      const ws=(await window.mangaM0.command({commandId:"workspace.get",idempotencyKey:"bench-ws",input:{}})).value;
      const resource=ws.resources.find(item=>item.id==="bench-0")||ws.resources[0];
      await window.mangaM0.command({commandId:"library.contextSnapshot",idempotencyKey:"bench-ctx",input:{resourceId:resource.id,resourceRevisionId:resource.revisionId}});
      const contextMs=performance.now()-ctxStart;
      const fsStart=performance.now();
      const full=await window.mangaM0.command({commandId:"library.getResource",idempotencyKey:"bench-fs",input:{resourceId:"bench-0"}});
      const text=(full.value.parts||[]).map(part=>part.normalized).join("\\n");
      document.getElementById("sourceView").textContent=text.slice(0,8000);
      const firstScreenUiMs=performance.now()-fsStart;
      const recStart=performance.now();
      document.getElementById("startRecord").click();
      while(!document.getElementById("recordStatus").textContent.includes("正在录音") && !document.getElementById("recordStatus").textContent.includes("未能录音")) {
        if(performance.now()-recStart>8000) throw new Error("record status timeout");
        await new Promise(resolve=>setTimeout(resolve,5));
      }
      const recordStatusMs=performance.now()-recStart;
      if(document.getElementById("recordStatus").textContent.includes("正在录音")) {
        document.getElementById("stopRecord").click();
        while(!document.getElementById("recordStatus").textContent.startsWith("录音已保存") && !document.getElementById("recordStatus").textContent.includes("失败")) {
          if(performance.now()-recStart>20000) break;
          await new Promise(resolve=>setTimeout(resolve,20));
        }
      }
      return {inputStateMs:samples,autoSaveMs,contextMs,firstScreenUiMs,recordStatusMs};
    })()`) : {};
    fs.writeFileSync(path.join(profileDir, "bench-window.json"), JSON.stringify({ startupMs, ...timings }));
    return;
  }
  const cases = [];
  if (phase === "permission") {
    const denied = await js('navigator.mediaDevices.getUserMedia({audio:true}).then(()=>"granted", e=>e.name)');
    await js('document.getElementById("startRecord").click()');
    await until('document.getElementById("recordStatus").textContent.includes("未能录音") || document.getElementById("recordStatus").textContent.includes("正在录音")', "permission result");
    const status = await js('document.getElementById("recordStatus").textContent');
    assert.notEqual(denied, "granted", `getUserMedia was ${denied}`);
    assert.ok(status.includes("未能录音"), status);
    cases.push("permission-denied");
  } else if (phase === "initial") {
    await js('document.getElementById("importBtn").click()');
    await until('document.getElementById("sourceView").textContent.includes("春が来た")', "import visible");
    await js(`(() => {
      const e = document.getElementById("editor");
      e.focus(); e.value = "保留原文"; e.dispatchEvent(new InputEvent("input", {bubbles:true, data:"保留原文"}));
      e.dispatchEvent(new CompositionEvent("compositionstart", {bubbles:true}));
      e.value += "中文候选";
      e.dispatchEvent(new InputEvent("input", {bubbles:true, isComposing:true}));
      const enter = new KeyboardEvent("keydown", {key:"Enter", isComposing:true, cancelable:true, bubbles:true});
      e.dispatchEvent(enter); if (enter.defaultPrevented) throw new Error("IME Enter intercepted");
      e.dispatchEvent(new CompositionEvent("compositionend", {bubbles:true, data:"中文候选"}));
      e.dispatchEvent(new KeyboardEvent("keydown", {key:"z", ctrlKey:true, cancelable:true, bubbles:true}));
      if(e.value !== "保留原文") throw new Error("undo removed prior text");
      e.dispatchEvent(new KeyboardEvent("keydown", {key:"z", ctrlKey:true, shiftKey:true, cancelable:true, bubbles:true}));
      if(e.value !== "保留原文中文候选") throw new Error("redo did not restore composition");
      document.getElementById("saveBtn").click();
    })()`);
    await until('document.getElementById("saveStatus").textContent.startsWith("已保存到本机")', "save");
    cases.push("import-visible", "composition-event-undo-redo", "save-ack");
    await js(`(() => {
      const view = document.getElementById("sourceView");
      const part = view.firstChild;
      const range = document.createRange();
      range.setStart(part.firstChild, 0);
      range.setEnd(part.firstChild, 5);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
      document.getElementById("saveAnchorBtn").click();
    })()`);
    await until('document.getElementById("anchorStatus").textContent.includes("已保存选区")', "anchor saved");
    await until('Boolean(document.getElementById("sourceHighlight"))', "highlight");
    cases.push("dom-selection-anchor");
    for (const n of [0, 1]) {
      await js('document.getElementById("startRecord").click()');
      await until('document.getElementById("recordStatus").textContent.includes("正在录音")', `fake microphone start ${n}`);
      await new Promise(resolve => setTimeout(resolve, n === 1 ? 1600 : 1100));
      await js('document.getElementById("stopRecord").click()');
      await until('document.getElementById("recordStatus").textContent.startsWith("录音已保存")', `fake microphone save ${n}`);
    }
    await js('document.querySelector("#captures button").click()');
    await until('document.getElementById("playerDock").dataset.ready === "true"', "recording playback ready");
    const playback = await js(`(() => {
      const audio = document.getElementById("playerAudio");
      const seek = document.getElementById("playerSeek");
      const before = audio.outerHTML;
      const duration = audio.duration;
      seek.value = String(Math.min(0.35, duration / 2 || 0.35));
      seek.dispatchEvent(new Event("input", {bubbles:true}));
      return {duration, currentTime: audio.currentTime, exportLabel: document.getElementById("exportCaptureBtn").textContent, playerKept: Boolean(audio.parentElement), before};
    })()`);
    assert.ok(playback.duration > 0 && Number.isFinite(playback.duration), `duration was ${playback.duration}`);
    assert.ok(playback.currentTime > 0, "seek before play did not move currentTime");
    await until('!document.getElementById("playerAudio").seeking', "actual seek completed");
    const advanced=await js(`(async()=>{const audio=document.getElementById("playerAudio");audio.muted=true;const before=audio.currentTime;await audio.play();await new Promise(r=>setTimeout(r,160));const after=audio.currentTime;audio.pause();return after>before;})()`);
    assert.equal(advanced,true,"decoded audio must actually play after seeking");
    assert.equal(playback.exportLabel, "导出录音");
    const srcBefore = await js("document.getElementById('playerAudio').src");
    await js(`(() => { const e=document.getElementById("editor"); e.value = e.value + "自动保存刷新"; e.dispatchEvent(new InputEvent("input",{bubbles:true})); })()`);
    await until('document.getElementById("saveStatus").textContent.startsWith("已保存到本机")', "autosave during playback");
    assert.equal(await js("document.getElementById('playerAudio').src"), srcBefore, "autosave removed player");
    assert.equal(await js("document.getElementById('playerDock').hidden"), false);
    await js('document.getElementById("exportCaptureBtn").click()');
    await until('document.getElementById("recordStatus").textContent.includes("已导出") || document.getElementById("recordStatus").textContent.includes("已取消")', "export result");
    const second = await js('document.querySelectorAll("#captures button").length');
    assert.ok(second >= 2, "two recordings");
    await js('document.querySelectorAll("#captures button")[1].click()');
    await until('document.getElementById("playerDock").dataset.ready === "true"', "second recording");
    await until('document.getElementById("playerTime").textContent.includes(" / ") && Number(document.getElementById("playerSeek").max) > 0', "second recording visible timeline");
    cases.push("fake-audio-capture-save-load", "playback-duration-seek", "player-survives-refresh", "export-control");
    const captureMetadata=await js(`(async()=>{const ws=(await window.mangaM0.command({commandId:"workspace.get",idempotencyKey:"check-capture-timeline",input:{}})).value;return JSON.parse(ws.captures[0].metadata);})()`);
    assert.equal(captureMetadata.positions[0].reason,"start");
    assert.equal(captureMetadata.positions.at(-1).reason,"stop");
    assert.ok(captureMetadata.positions.every(item=>Number.isFinite(item.captureOffsetMs)));
    assert.equal(captureMetadata.positions[0].locator.kind,"text","recording on text must not use the idle player's media position");
    const mediaReport = {};
    if (process.env.M0_MEDIA_VIDEO) {
      await js('document.getElementById("loadVideoBtn").click()');
      await until('document.getElementById("mediaStatus").textContent.includes("duration") || document.getElementById("mediaStatus").textContent.includes("missing-sample")', "h264 video");
      mediaReport.h264 = JSON.parse(await js('document.getElementById("mediaStatus").textContent'));
      assert.equal(mediaReport.h264.status, "played", JSON.stringify(mediaReport.h264));
      cases.push("electron-h264-playback");
    }
    if (process.env.M0_MEDIA_HEVC) {
      await js('document.getElementById("loadHevcBtn").click()');
      await until('document.getElementById("mediaStatus").textContent.includes("hevc") || document.getElementById("mediaStatus").textContent.includes("missing-sample")', "hevc video");
      mediaReport.hevc = JSON.parse(await js('document.getElementById("mediaStatus").textContent'));
      cases.push("electron-hevc-playback");
    }
    if (process.env.M0_MEDIA_IMAGE) {
      await js('document.getElementById("loadImageBtn").click()');
      await until('document.getElementById("mediaStatus").textContent.includes("width") || document.getElementById("mediaStatus").textContent.includes("missing-sample")', "image sample");
      mediaReport.image = JSON.parse(await js('document.getElementById("mediaStatus").textContent'));
      cases.push("electron-image-display");
    }
    if (Object.keys(mediaReport).length) fs.writeFileSync(path.join(profileDir, "media-electron.json"), JSON.stringify({ status: "recorded", ...mediaReport, at: new Date().toISOString() }, null, 2));
  } else {
    assert.equal(await js('document.getElementById("editor").value'), "保留原文中文候选自动保存刷新");
    assert.ok(await js('document.getElementById("sourceView").textContent.includes("春が来た")'));
    assert.ok(await js('document.querySelectorAll("#captures button").length >= 2'));
    await js('document.querySelector("#captures button").click()');
    await until('document.getElementById("playerDock").dataset.ready === "true"', "restart playback");
    assert.ok(await js('Number.isFinite(document.getElementById("playerAudio").duration) && document.getElementById("playerAudio").duration > 0'));
    await js('document.getElementById("jumpAnchorBtn").click()');
    await until('document.getElementById("anchorStatus").textContent.includes("已跳回") || document.getElementById("anchorStatus").textContent.includes("定位结果")', "restart jump");
    if (process.env.M0_EXPORT_CANCEL === "1") {
      await js('document.getElementById("exportCaptureBtn").click()');
      await until('document.getElementById("recordStatus").textContent.includes("已取消")', "export cancel");
    }
    cases.push("process-restart-note-import-audio", "restart-playback-duration");
  }
  const invalid = await js('window.mangaM0.command({commandId:"notes.create",idempotencyKey:"bad-smoke",input:{title:"invalid",text:17}})');
  assert.equal(invalid.status, "error");
  assert.equal(invalid.error.code, "VALIDATION_ERROR");
  assert.equal(await js('typeof require'), "undefined");
  await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  fs.writeFileSync(path.join(profileDir, `smoke-${phase}-wide.png`), (await window.webContents.capturePage()).toPNG());
  window.setContentSize(740, 600);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true, "narrow window horizontal overflow");
  cases.push("schema-rejection", "renderer-no-node", "narrow-layout");
  fs.writeFileSync(path.join(profileDir, `smoke-${phase}.png`), (await window.webContents.capturePage()).toPNG());
  const result = { status:"passed", phase, packaged, devicePixelRatio:await js("devicePixelRatio"),cases, at: new Date().toISOString(), limitations:["Synthetic composition events do not validate the Windows IME candidate window", "Fake microphone does not validate actual acoustics"] };
  fs.writeFileSync(path.join(profileDir, `smoke-${phase}.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
};
