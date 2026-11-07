import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MangaError } from "@manga/contracts";

export type WebmIndexResult = {
  originalBytes: number;
  playbackBytes: number;
  durationMs: number;
  method: "ffmpeg-copy-cues";
  originalFingerprint: string;
  playbackFingerprint: string;
  ffprobeDurationMs: number | null;
};

function fingerprint(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function readVint(buf: Buffer, offset: number): { value: number; length: number } {
  if (offset >= buf.length) throw new MangaError("UNSUPPORTED_FORMAT", "webm vint overrun");
  const first = buf[offset]!;
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && (first & mask) === 0) {
    length += 1;
    mask >>= 1;
  }
  if (length > 8 || offset + length > buf.length) throw new MangaError("UNSUPPORTED_FORMAT", "invalid webm vint");
  let value = first & (mask - 1);
  const unknown = (mask - 1) === value && [...buf.subarray(offset + 1, offset + length)].every((byte) => byte === 0xff);
  if (unknown) return { value: Number.POSITIVE_INFINITY, length };
  for (let i = 1; i < length; i += 1) value = value * 256 + buf[offset + i]!;
  return { value, length };
}

type Element = { id:number; offset:number; start:number; end:number };
function elements(buf:Buffer,start:number,end:number):Element[] {
  const result:Element[]=[];
  for(let offset=start;offset<end;) {
    const idLength=readVint(buf,offset).length;
    if(idLength>4) throw new MangaError("UNSUPPORTED_FORMAT","invalid EBML element ID");
    const id=buf.readUIntBE(offset,idLength);
    const size=readVint(buf,offset+idLength);
    const content=offset+idLength+size.length;
    const next=Number.isFinite(size.value)?content+size.value:end;
    if(next>end || next<content || (size.value===Infinity && id!==0x18538067)) throw new MangaError("UNSUPPORTED_FORMAT","invalid EBML element bounds");
    result.push({id,offset,start:content,end:next});
    offset=next;
  }
  return result;
}
function infoElements(buf:Buffer):Element[] {
  const segment=elements(buf,0,buf.length).find(item=>item.id===0x18538067);
  if(!segment) return [];
  // Only walk top-level elements until Info; never scan encoded audio for IDs.
  let offset=segment.start;
  while(offset<segment.end) {
    const idLength=readVint(buf,offset).length;
    if(idLength>4) throw new MangaError("UNSUPPORTED_FORMAT","invalid EBML element ID");
    const id=buf.readUIntBE(offset,idLength),size=readVint(buf,offset+idLength);
    const start=offset+idLength+size.length,end=start+size.value;
    if(!Number.isFinite(end) || end>segment.end) return [];
    if(id===0x1549a966) return elements(buf,start,end);
    offset=end;
  }
  return [];
}
export function readWebmDurationMs(buffer:Uint8Array):number|undefined {
  const buf=Buffer.from(buffer),info=infoElements(buf);
  const duration=info.find(item=>item.id===0x4489);
  if(!duration) return undefined;
  const bytes=duration.end-duration.start;
  const value=bytes===4?buf.readFloatBE(duration.start):bytes===8?buf.readDoubleBE(duration.start):NaN;
  const scale=info.find(item=>item.id===0x2ad7b1);
  const scaleBytes=scale ? scale.end-scale.start : 0;
  if(scale && (scaleBytes<1 || scaleBytes>6)) throw new MangaError("UNSUPPORTED_FORMAT","unsupported timecode scale");
  const nanos=scale?buf.readUIntBE(scale.start,scaleBytes):1_000_000;
  const ms=value*nanos/1_000_000;
  return Number.isFinite(ms) && ms>0 ? ms : undefined;
}
export function stripWebmDuration(buffer:Uint8Array):Buffer {
  const buf=Buffer.from(buffer),duration=infoElements(buf).find(item=>item.id===0x4489);
  if(!duration) return buf;
  // Same-length Void preserves Segment/Info sizes and all seek/cue offsets.
  const length=duration.end-duration.offset,payload=length-2;
  if(payload<0 || payload>=127) throw new MangaError("UNSUPPORTED_FORMAT","unexpected duration size");
  buf[duration.offset]=0xec;
  buf[duration.offset+1]=0x80|payload;
  buf.fill(0,duration.offset+2,duration.end);
  return buf;
}

function run(command: string, args: string[], timeout = 30_000): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command, args, { encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export function probeContainerDurationMs(file: string): number | null {
  const result = run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file]);
  if (result.status !== 0) return null;
  const value = Number(result.stdout.trim());
  return Number.isFinite(value) && value > 0 ? value * 1000 : null;
}

export function indexWebmForPlayback(srcPath:string,destPath:string):WebmIndexResult {
  if(path.resolve(srcPath)===path.resolve(destPath)) throw new MangaError("VALIDATION_ERROR","playback derivative must not overwrite the original recording");
  const original=fs.readFileSync(srcPath);
  fs.mkdirSync(path.dirname(destPath),{recursive:true});
  const staging=fs.mkdtempSync(path.join(path.dirname(destPath),".webm-index-"));
  const tmp=path.join(staging,"playback.webm");
  try {
    // Optional engineering utility. Desktop playback uses Web Audio decoding.
    const remux=run("ffmpeg",["-nostdin","-fflags","+genpts","-i",srcPath,"-c","copy","-f","webm",tmp]);
    if(remux.status!==0) throw new MangaError("UNSUPPORTED_FORMAT","FFmpeg playback remux failed");
    const playback=fs.readFileSync(tmp),durationMs=readWebmDurationMs(playback),probed=probeContainerDurationMs(tmp);
    if(!durationMs || !probed || Math.abs(durationMs-probed)>2) throw new MangaError("UNSUPPORTED_FORMAT","remux has no validated duration");
    if(!fs.readFileSync(srcPath).equals(original)) throw new MangaError("VALIDATION_ERROR","original recording changed during remux");
    fs.copyFileSync(tmp,destPath,fs.constants.COPYFILE_EXCL);
    return {originalBytes:original.length,playbackBytes:playback.length,durationMs,method:"ffmpeg-copy-cues",originalFingerprint:fingerprint(original),playbackFingerprint:fingerprint(playback),ffprobeDurationMs:probed};
  } finally { fs.rmSync(staging,{recursive:true,force:true}); }
}

export function writeDurationlessFixture(dest: string, durationSec = 1.14): { path: string; bytes: number } {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.raw.webm`;
  const generated = run("ffmpeg", [
    "-y", "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${durationSec}`,
    "-c:a", "libopus", "-application", "voip", "-f", "webm", tmp,
  ]);
  if (generated.status !== 0) throw new MangaError("UNSUPPORTED_FORMAT", generated.stderr || "failed to synthesize webm fixture");
  const stripped = stripWebmDuration(fs.readFileSync(tmp));
  fs.writeFileSync(dest, stripped);
  fs.rmSync(tmp, { force: true });
  return { path: dest, bytes: stripped.length };
}

export function playbackPathFor(originalPath: string): string {
  return originalPath.replace(/\.webm$/i, ".playback.webm");
}

export function ensurePlaybackDerivative(originalPath: string): WebmIndexResult {
  const dest = playbackPathFor(originalPath);
  if (fs.existsSync(dest)) {
    const durationMs = probeContainerDurationMs(dest) ?? readWebmDurationMs(fs.readFileSync(dest));
    if (durationMs && durationMs > 0) {
      const original = fs.readFileSync(originalPath);
      const playback = fs.readFileSync(dest);
      return {
        originalBytes: original.length,
        playbackBytes: playback.length,
        durationMs,
        method: "ffmpeg-copy-cues",
        originalFingerprint: fingerprint(original),
        playbackFingerprint: fingerprint(playback),
        ffprobeDurationMs: probeContainerDurationMs(dest),
      };
    }
  }
  return indexWebmForPlayback(originalPath, dest);
}
