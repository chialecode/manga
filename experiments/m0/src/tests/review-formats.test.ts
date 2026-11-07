import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import { parseEpub, buildEpubFixture } from "../domain/epub.ts";
import { normalizeText, decodeTextBuffer } from "../domain/text-locator.ts";
import { probeMedia, planLosslessCut } from "../domain/media.ts";
import { isolateDir, repoRoot } from "../env.ts";
import { sourceFingerprint } from "../report.ts";

test("review: EPUB attribute order, real nav/NCX, expansion limits and original Unicode offsets", () => {
  const files=unzipSync(buildEpubFixture({title:"test",chapters:[{id:"chapter",title:"目录标题",html:"<p>正文</p>"}]}));
  files["OEBPS/content.opf"]=strToU8(strFromU8(files["OEBPS/content.opf"]!).replace('id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"',"media-type='application/xhtml+xml' href='chapter.xhtml' id='chapter'"));
  const result=parseEpub(zipSync(files));assert.equal(result.parts.length,1);assert.equal(result.toc[0]?.label,"目录标题");
  files["OEBPS/content.opf"]=strToU8(strFromU8(files["OEBPS/content.opf"]!).replace('properties="nav"','').replace('href="nav.xhtml" media-type="application/xhtml+xml"', 'href="toc.ncx" media-type="application/x-dtbncx+xml"'));
  files["OEBPS/toc.ncx"]=strToU8("<ncx><navMap><navPoint><navLabel><text>NCX 目录</text></navLabel><content src='chapter.xhtml'/></navPoint></navMap></ncx>");
  assert.equal(parseEpub(zipSync(files)).toc[0]?.label,"NCX 目录");
  const huge:Record<string,Uint8Array>={};for(let i=0;i<5;i++)huge[`entry${i}`]=new Uint8Array(7*1024*1024);
  assert.throws(()=>parseEpub(zipSync(huge,{level:0})),/budget/);
  assert.throws(()=>decodeTextBuffer(Uint8Array.from([0xc0,0xaf]),"utf-8"));
  const normalized=normalizeText("e\u0301\r\n🙂X");
  assert.equal(normalized.normalized,"é\n🙂X");assert.deepEqual(normalized.mapToOriginal,[0,2,4,5]);
});

test("review: real MKV HEVC ASS, fractional FPS, VFR and observed keyframes", () => {
  const dir=isolateDir("media-review");
  const run=(args:string[])=>{const result=spawnSync("ffmpeg",["-v","error","-y",...args],{encoding:"utf8",timeout:30000});assert.equal(result.status,0,result.stderr);};
  const ass=path.join(dir,"marker.ass");
  fs.writeFileSync(ass,"[Script Info]\nScriptType: v4.00+\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,MARKER\n");
  const mkv=path.join(dir,"hevc-ass.mkv");
  run(["-f","lavfi","-i","testsrc=size=160x120:rate=24:duration=1","-f","lavfi","-i","sine=duration=1","-i",ass,"-map","0:v","-map","1:a","-map","2:s","-c:v","libx265","-preset","ultrafast","-x265-params","log-level=error:pools=1","-pix_fmt","yuv420p","-c:a","aac","-c:s","ass",mkv]);
  const mkvProbe=probeMedia(mkv);assert.equal(mkvProbe.video?.codec,"hevc");assert.deepEqual(mkvProbe.subtitle,["ass"]);assert.equal(planLosslessCut(mkvProbe,0,500).compatible,false);
  const fractional=path.join(dir,"fractional.mp4");
  run(["-f","lavfi","-i","testsrc=size=160x120:rate=30000/1001:duration=2","-c:v","libx264","-g","30","-sc_threshold","0","-pix_fmt","yuv420p",fractional]);
  const fractionalProbe=probeMedia(fractional);assert.ok(Math.abs(fractionalProbe.video!.fps!-29.97)<.01);
  assert.equal(planLosslessCut(fractionalProbe,1001,1500).keyframeAligned,true);assert.equal(planLosslessCut(fractionalProbe,1000,999).compatible,false);
  const vfr=path.join(dir,"variable.mp4");
  run(["-f","lavfi","-i","testsrc=size=160x120:rate=30:duration=2","-vf","select=not(mod(n\\,2))+not(mod(n\\,5))","-fps_mode","vfr","-c:v","libx264","-pix_fmt","yuv420p",vfr]);
  const frames=spawnSync("ffprobe",["-v","error","-select_streams","v:0","-show_frames","-show_entries","frame=best_effort_timestamp_time","-of","json",vfr],{encoding:"utf8"});assert.equal(frames.status,0,frames.stderr);
  const times=(JSON.parse(frames.stdout).frames as Array<{best_effort_timestamp_time:string}>).map(frame=>Number(frame.best_effort_timestamp_time));
  const gaps=new Set(times.slice(1).map((time,i)=>Math.round((time-times[i]!)*1000)));assert.ok(gaps.size>1);
  const output=path.resolve(repoRoot(),process.env.M0_EVIDENCE_DIR ?? "docs/evidence/m0-closure","format-matrix.json");
  fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify({status:"passed",sourceFingerprint:sourceFingerprint(repoRoot()),at:new Date().toISOString(),mkv:mkvProbe,fractional: fractionalProbe,vfrFrameIntervalsMs:[...gaps],scope:"FFmpeg generation/probe only; Electron playback is recorded separately in media-electron.json; ASS rendering and multi-track switching remain unverified"},null,2)+"\n");
});
