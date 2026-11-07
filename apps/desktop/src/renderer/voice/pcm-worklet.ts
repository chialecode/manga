/**
 * Runs on the audio thread. Collects the microphone's samples into 100 ms blocks of 16-bit PCM (the context runs at
 * 16 kHz, so a block is 1600 samples) and hands each block, with its peak level, to the page. Nothing else happens here.
 */

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void;

const BLOCK = 1600;

class PcmCapture extends AudioWorkletProcessor {
  private block = new Int16Array(BLOCK);
  private filled = 0;
  private peak = 0;

  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (let index = 0; index < channel.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, channel[index]!));
      const abs = Math.abs(sample);
      if (abs > this.peak) this.peak = abs;
      this.block[this.filled++] = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
      if (this.filled === BLOCK) {
        const pcm = this.block;
        this.port.postMessage({ pcm: pcm.buffer, peak: this.peak }, [pcm.buffer]);
        this.block = new Int16Array(BLOCK);
        this.filled = 0;
        this.peak = 0;
      }
    }
    return true;
  }
}

registerProcessor("manga-pcm", PcmCapture as unknown as new () => AudioWorkletProcessor);
