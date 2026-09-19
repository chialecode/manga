// A temporary PCM/WAV playback buffer gives MediaRecorder WebM a finite,
// seekable timeline without changing the saved recording or requiring FFmpeg.
export function pcmWave(audio) {
  const channels = audio.numberOfChannels;
  const bytes = audio.length * channels * 2;
  if (!Number.isSafeInteger(bytes) || !bytes || bytes > 64 * 1024 * 1024 || channels < 1 || channels > 2) throw new Error("录音解码后超过回放预算");
  const buffer = new ArrayBuffer(44 + bytes), view = new DataView(buffer);
  const write = (offset, text) => [...text].forEach((char,i) => view.setUint8(offset+i,char.charCodeAt(0)));
  write(0,"RIFF"); view.setUint32(4,36+bytes,true); write(8,"WAVE"); write(12,"fmt ");
  view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,channels,true);
  view.setUint32(24,audio.sampleRate,true); view.setUint32(28,audio.sampleRate*channels*2,true);
  view.setUint16(32,channels*2,true); view.setUint16(34,16,true); write(36,"data"); view.setUint32(40,bytes,true);
  const data = Array.from({length:channels},(_,i)=>audio.getChannelData(i));
  for(let frame=0;frame<audio.length;frame++) for(let channel=0;channel<channels;channel++) {
    const value=Math.max(-1,Math.min(1,data[channel][frame]));
    view.setInt16(44+(frame*channels+channel)*2,Math.round(value*(value<0?32768:32767)),true);
  }
  return buffer;
}

export async function decodePlayback(bytes) {
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(Uint8Array.from(bytes).buffer);
    return new Blob([pcmWave(decoded)],{type:"audio/wav"});
  } finally { await context.close(); }
}
