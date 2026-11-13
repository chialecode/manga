/**
 * Runs on the audio thread. Plays the 16-bit PCM the page hands over (the context runs at 24 kHz, the rate of the speech service), in order, and says how many
 * samples it has played, so the page knows which paragraph is being heard. Pausing outputs silence and keeps the place; clearing drops what waits.
 */

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void;

type Message = { type: "push"; pcm: ArrayBuffer } | { type: "pause" } | { type: "resume" } | { type: "clear"; generation: number };

class SpeechPlayback extends AudioWorkletProcessor {
  private queue: Int16Array[] = [];
  private offset = 0;
  private played = 0;
  private paused = false;
  private sinceReport = 0;
  private starved = true;
  private generation = 0;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<Message>) => {
      const message = event.data;
      if (message.type === "push") this.queue.push(new Int16Array(message.pcm));
      else if (message.type === "pause") this.paused = true;
      else if (message.type === "resume") this.paused = false;
      else if (message.type === "clear") { this.queue = []; this.offset = 0; this.played = 0; this.generation = message.generation; this.starved = true; }
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const channel = outputs[0]?.[0];
    if (!channel) return true;
    let index = 0;
    if (!this.paused) {
      while (index < channel.length && this.queue.length) {
        const head = this.queue[0]!;
        const take = Math.min(channel.length - index, head.length - this.offset);
        for (let i = 0; i < take; i += 1) {
          const sample = head[this.offset + i]!;
          channel[index + i] = sample < 0 ? sample / 0x8000 : sample / 0x7fff;
        }
        index += take;
        this.offset += take;
        this.played += take;
        if (this.offset >= head.length) { this.queue.shift(); this.offset = 0; }
      }
    }
    channel.fill(0, index);
    this.sinceReport += channel.length;
    const empty = !this.paused && !this.queue.length;
    // About every 50 ms, and at once when what was queued has all been played.
    if (this.sinceReport >= 1200 || (empty && !this.starved)) {
      this.port.postMessage({ played: this.played, empty, generation: this.generation });
      this.sinceReport = 0;
    }
    this.starved = empty;
    return true;
  }
}

registerProcessor("manga-speech", SpeechPlayback as unknown as new () => AudioWorkletProcessor);

export {};
