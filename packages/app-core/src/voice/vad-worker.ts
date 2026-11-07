import fs from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { parentPort, workerData } from "node:worker_threads";

/**
 * Runs the Silero voice-activity model (ONNX, WebAssembly execution provider) off the main thread. It speaks only in
 * numbers: 16-bit PCM in, one speech probability per 512-sample frame out. Deciding what counts as speech, merging,
 * margins and block planning all happen in the main process on these numbers (vad-segmenter.ts, chunks.ts), so the
 * filter can be tested without this worker and the worker can be replaced without touching the product's decisions.
 */
const FRAME = 512;
const CONTEXT = 64;
const SAMPLE_RATE = 16_000;
const ANALYZE_BLOCK_FRAMES = 2048;

type OrtTensor = { data: Float32Array | BigInt64Array };
type Ort = {
  env: { wasm: { numThreads: number; wasmPaths?: string } };
  Tensor: new (type: string, data: Float32Array | BigInt64Array, dims: number[]) => OrtTensor;
  InferenceSession: { create(model: Uint8Array, options: Record<string, unknown>): Promise<Session> };
};
type Session = { run(inputs: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>; release?(): Promise<void> };

type Stream = {
  state: OrtTensor;
  context: Float32Array;
  /** Samples that did not fill a frame yet; they wait for the next push. */
  rest: Int16Array;
  /** Pushes to one stream run one after another: the model state is a chain, not a set. */
  chain: Promise<void>;
};

const options = workerData as { modelPath: string; ortEntry: string; wasmDir?: string };
const port = parentPort;
if (!port) throw new Error("vad-worker must run in a worker thread");

let ort: Ort | null = null;
let session: Session | null = null;
let sampleRate: OrtTensor | null = null;
const streams = new Map<number, Stream>();
const cancelled = new Set<number>();
let shuttingDown = false;

function zeroState(): OrtTensor {
  return new ort!.Tensor("float32", new Float32Array(2 * 1 * 128), [2, 1, 128]);
}

async function load(): Promise<void> {
  const requireFrom = createRequire(options.ortEntry);
  ort = requireFrom(options.ortEntry) as Ort;
  ort.env.wasm.numThreads = 1;
  // The runtime imports its loader from this location, and on Windows only a file URL is a valid module location.
  if (options.wasmDir) ort.env.wasm.wasmPaths = `${pathToFileURL(options.wasmDir).href.replace(/\/$/, "")}/`;
  session = await ort.InferenceSession.create(fs.readFileSync(options.modelPath), { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
  sampleRate = new ort.Tensor("int64", BigInt64Array.from([BigInt(SAMPLE_RATE)]), []);
}

/** Probabilities for the whole frames in `samples`; whatever is left over stays in the stream. */
async function infer(stream: Stream, incoming: Int16Array, isCancelled: () => boolean): Promise<Float32Array> {
  let samples = incoming;
  if (stream.rest.length) {
    samples = new Int16Array(stream.rest.length + incoming.length);
    samples.set(stream.rest, 0);
    samples.set(incoming, stream.rest.length);
  }
  const frames = Math.floor(samples.length / FRAME);
  const out = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    // The model runs without ever waiting on I/O, so without this the thread would not read a cancel until it was done.
    if (frame % 64 === 63) await new Promise<void>((resolve) => setImmediate(resolve));
    if (isCancelled() || shuttingDown) throw new Error("cancelled");
    const input = new Float32Array(CONTEXT + FRAME);
    input.set(stream.context, 0);
    const base = frame * FRAME;
    for (let i = 0; i < FRAME; i += 1) input[CONTEXT + i] = samples[base + i]! / 32768;
    const result = await session!.run({ input: new ort!.Tensor("float32", input, [1, CONTEXT + FRAME]), state: stream.state, sr: sampleRate! });
    stream.state = result.stateN!;
    stream.context = input.slice(input.length - CONTEXT);
    out[frame] = (result.output!.data as Float32Array)[0]!;
  }
  stream.rest = samples.slice(frames * FRAME);
  return out;
}

async function analyze(id: number, file: string): Promise<Float32Array> {
  const stream: Stream = { state: zeroState(), context: new Float32Array(CONTEXT), rest: new Int16Array(0), chain: Promise.resolve() };
  const size = fs.statSync(file).size;
  const totalFrames = Math.floor(size / 2 / FRAME);
  const probabilities = new Float32Array(totalFrames);
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(ANALYZE_BLOCK_FRAMES * FRAME * 2);
    let at = 0;
    for (;;) {
      if (cancelled.has(id) || shuttingDown) throw new Error("cancelled");
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read < 2) break;
      const usable = read - (read % 2);
      const block = new Int16Array(usable / 2);
      for (let i = 0; i < block.length; i += 1) block[i] = buffer.readInt16LE(i * 2);
      const probs = await infer(stream, block, () => cancelled.has(id));
      probabilities.set(probs.subarray(0, Math.max(0, Math.min(probs.length, totalFrames - at))), at);
      at += probs.length;
      port!.postMessage({ type: "progress", id, fraction: Math.min(1, (at * FRAME * 2) / Math.max(1, size)) });
    }
    return probabilities;
  } finally {
    fs.closeSync(fd);
  }
}

port.on("message", (message: { type: string; id?: number; stream?: number; pcm?: Int16Array; file?: string }) => {
  void (async () => {
    try {
      if (message.type === "init") {
        await load();
        port.postMessage({ type: "ready" });
      } else if (message.type === "open") {
        streams.set(message.stream!, { state: zeroState(), context: new Float32Array(CONTEXT), rest: new Int16Array(0), chain: Promise.resolve() });
      } else if (message.type === "close") {
        streams.delete(message.stream!);
      } else if (message.type === "push") {
        const stream = streams.get(message.stream!);
        if (!stream) throw new Error("unknown stream");
        const run = stream.chain.then(() => infer(stream, message.pcm!, () => false));
        stream.chain = run.then(() => undefined, () => undefined);
        const probs = await run;
        port.postMessage({ type: "result", id: message.id, probs }, [probs.buffer as ArrayBuffer]);
      } else if (message.type === "analyze") {
        const probs = await analyze(message.id!, message.file!);
        port.postMessage({ type: "result", id: message.id, probs }, [probs.buffer as ArrayBuffer]);
      } else if (message.type === "cancel") {
        cancelled.add(message.id!);
      } else if (message.type === "shutdown") {
        // Leave the runtime in an orderly way: ending the thread in the middle of a WebAssembly call can take the process down with it.
        shuttingDown = true;
        streams.clear();
        await session?.release?.().catch(() => undefined);
        session = null;
        port.postMessage({ type: "bye" });
        port.close();
      }
    } catch (error) {
      port.postMessage({ type: message.type === "init" ? "init-error" : "error", id: message.id, message: error instanceof Error ? error.message : String(error) });
    } finally {
      if (message.type === "analyze") cancelled.delete(message.id!);
    }
  })();
});
