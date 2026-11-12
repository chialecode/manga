// Deterministic 16 kHz mono PCM WAV I/O, SNR mixing, fan/pink-hum synthesis, and
// frontend capture DSP stages (spectral kHigh noise suppression, causal AGC, GTCRN dry/wet mix)
// for the offline voice dictation evaluation suite.

export const EVAL_SAMPLE_RATE = 16_000;
export const GTCRN_DEFAULT_WET = 0.75;

/** Deterministic Mulberry32 PRNG returning [0, 1). */
export function createPrng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Encode Float32Array [-1, 1] or Int16Array into a 16-bit mono PCM WAV Buffer. */
export function encodeWavMono16(samples, sampleRate = EVAL_SAMPLE_RATE) {
  let pcm16;
  if (samples instanceof Int16Array) {
    pcm16 = samples;
  } else {
    pcm16 = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i += 1) {
      const clamped = Math.max(-1, Math.min(1, samples[i]));
      pcm16[i] = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
    }
  }
  const dataBytes = Buffer.from(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataBytes.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataBytes.length, 40);
  return Buffer.concat([header, dataBytes]);
}

/** Decode a 16-bit mono PCM WAV Buffer into { sampleRate, int16, float32 }. */
export function decodeWavMono16(buffer) {
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Invalid WAV header");
  }
  let offset = 12;
  let sampleRate = EVAL_SAMPLE_RATE;
  let channels = 1;
  let bitsPerSample = 16;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkId === "fmt ") {
      channels = buffer.readUInt16LE(offset + 10);
      sampleRate = buffer.readUInt32LE(offset + 12);
      bitsPerSample = buffer.readUInt16LE(offset + 22);
    } else if (chunkId === "data") {
      if (channels !== 1 || bitsPerSample !== 16) {
        throw new Error(`Expected 16-bit mono WAV, got ${channels}ch ${bitsPerSample}-bit`);
      }
      const end = Math.min(buffer.length, offset + 8 + chunkSize);
      const byteLen = end - (offset + 8) - ((end - (offset + 8)) % 2);
      const aligned = Buffer.from(buffer.subarray(offset + 8, offset + 8 + byteLen));
      const int16 = new Int16Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 2);
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i += 1) {
        float32[i] = int16[i] / 32768;
      }
      return { sampleRate, int16, float32 };
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  throw new Error("WAV file missing data chunk");
}

/** Locate active voiced bounds [first, last] in Float32 samples using an amplitude threshold. */
export function findVoicedBounds(samples, threshold = 0.01) {
  let first = 0;
  let last = samples.length - 1;
  while (first < samples.length && Math.abs(samples[first]) < threshold) first += 1;
  while (last > first && Math.abs(samples[last]) < threshold) last -= 1;
  if (first >= samples.length) return { first: 0, last: Math.max(0, samples.length - 1), voiced: false };
  return { first, last, voiced: last > first };
}

/** Compute RMS over [start, end] inclusive. */
export function computeRms(samples, start = 0, end = samples.length - 1) {
  if (samples.length === 0 || end < start) return 0;
  const lo = Math.max(0, start);
  const hi = Math.min(samples.length - 1, end);
  let sumSq = 0;
  const count = hi - lo + 1;
  for (let i = lo; i <= hi; i += 1) {
    const s = samples[i];
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / Math.max(1, count));
}

/** Trim excessive SAPI head/tail silence and normalize clean speech to a safe headroom peak (-5 dBFS ~ 0.562). */
export function prepareCleanUtterance(rawFloat32, sampleRate = EVAL_SAMPLE_RATE, padSeconds = 0.25, targetPeak = 0.56) {
  const bounds = findVoicedBounds(rawFloat32, 0.008);
  const padSamples = Math.round(padSeconds * sampleRate);
  const sliceStart = Math.max(0, bounds.first - padSamples);
  const sliceEnd = Math.min(rawFloat32.length, bounds.last + padSamples + 1);
  const trimmed = rawFloat32.slice(sliceStart, sliceEnd);

  let peak = 1e-9;
  for (let i = 0; i < trimmed.length; i += 1) {
    const a = Math.abs(trimmed[i]);
    if (a > peak) peak = a;
  }
  const scale = targetPeak / peak;
  const out = new Float32Array(trimmed.length);
  for (let i = 0; i < trimmed.length; i += 1) {
    out[i] = Math.max(-0.99, Math.min(0.99, trimmed[i] * scale));
  }
  return out;
}

/**
 * Deterministic fan + pink-airflow hum noise generator.
 * Combines Paul Kellet's pink noise filter with subtle cooling-fan blade harmonics (118 Hz, 236 Hz, 354 Hz)
 * and slow amplitude flutter.
 */
export function synthesizeFanNoise(length, seed, sampleRate = EVAL_SAMPLE_RATE) {
  const rand = createPrng(seed);
  const out = new Float32Array(length);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  const phase1 = rand() * 2 * Math.PI;
  const phase2 = rand() * 2 * Math.PI;
  const phase3 = rand() * 2 * Math.PI;
  const baseFreq = 116 + rand() * 8;

  for (let n = 0; n < length; n += 1) {
    const white = rand() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.96900 * b2 + white * 0.1538520;
    b3 = 0.86650 * b3 + white * 0.3104856;
    b4 = 0.55000 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.0168980;
    const pink = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
    b6 = white * 0.115926;

    const t = n / sampleRate;
    const flutter = 1 + 0.08 * Math.sin(2 * Math.PI * 2.3 * t + phase1);
    const hum =
      0.22 * Math.sin(2 * Math.PI * baseFreq * t + phase1) +
      0.11 * Math.sin(2 * Math.PI * baseFreq * 2 * t + phase2) +
      0.05 * Math.sin(2 * Math.PI * baseFreq * 3 * t + phase3);
    out[n] = (0.78 * pink + hum) * flutter;
  }
  return out;
}

/**
 * Mix clean speech with an interference buffer at an exact target SNR (dB),
 * measured over the active voiced span of the clean signal.
 * If combined peak exceeds 0.98, scales both signals equally so exact SNR is preserved without clipping.
 */
export function mixAtSnrDb(clean, interference, snrDb = 10) {
  const out = new Float32Array(clean.length);
  const bounds = findVoicedBounds(clean, 0.01);
  const sigRms = computeRms(clean, bounds.first, bounds.last);

  const alignedInterf = new Float32Array(clean.length);
  if (interference.length > 0) {
    for (let i = 0; i < clean.length; i += 1) {
      alignedInterf[i] = interference[i % interference.length];
    }
  }
  const noiseRms = computeRms(alignedInterf, bounds.first, bounds.last) || computeRms(alignedInterf, 0, alignedInterf.length - 1);
  const desiredNoiseRms = sigRms / Math.pow(10, snrDb / 20);
  const noiseScale = noiseRms > 1e-9 ? desiredNoiseRms / noiseRms : 0;

  let peak = 1e-9;
  for (let i = 0; i < clean.length; i += 1) {
    const mixed = clean[i] + alignedInterf[i] * noiseScale;
    out[i] = mixed;
    const a = Math.abs(mixed);
    if (a > peak) peak = a;
  }
  if (peak > 0.98) {
    const headroomScale = 0.98 / peak;
    for (let i = 0; i < out.length; i += 1) {
      out[i] *= headroomScale;
    }
  }
  return out;
}

/** Radix-2 Cooley-Tukey in-place FFT (`dir = 1` forward, `dir = -1` inverse). */
function fftRadix2(re, im, dir) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((2 * Math.PI) / len) * (dir === 1 ? -1 : 1);
    const wlenRe = Math.cos(ang);
    const wlenIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wRe = 1;
      let wIm = 0;
      const half = len >> 1;
      for (let j = 0; j < half; j += 1) {
        const uRe = re[i + j];
        const uIm = im[i + j];
        const vRe = re[i + j + half] * wRe - im[i + j + half] * wIm;
        const vIm = re[i + j + half] * wIm + im[i + j + half] * wRe;
        re[i + j] = uRe + vRe;
        im[i + j] = uIm + vIm;
        re[i + j + half] = uRe - vRe;
        im[i + j + half] = uIm - vIm;
        const nextWRe = wRe * wlenRe - wIm * wlenIm;
        wIm = wRe * wlenIm + wIm * wlenRe;
        wRe = nextWRe;
      }
    }
  }
  if (dir === -1) {
    for (let i = 0; i < n; i += 1) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

/**
 * Simulates Chromium's fixed aggressive single-channel WebRTC NoiseSuppression (`kHigh` in `mic.ts` before M12):
 * 32 ms (512-sample) Hann STFT with 50% overlap, quantile/minimum-statistics stationary noise floor estimation,
 * aggressive over-subtraction (`alpha = 2.6`) and spectral floor (`-22 dB`), which suppresses stationary hum
 * while inevitably eroding low-energy consonant onsets/codas and distorting non-stationary competing speech.
 */
export function applyBrowserHighNoiseSuppression(samples) {
  if (samples.length === 0) return new Float32Array(0);
  const fftSize = 512;
  const hop = 256;
  const bins = (fftSize >> 1) + 1;
  const win = new Float32Array(fftSize);
  for (let i = 0; i < fftSize; i += 1) {
    win[i] = Math.sin((Math.PI * (i + 0.5)) / fftSize);
  }

  const paddedLen = samples.length + fftSize;
  const out = new Float32Array(paddedLen);
  const norm = new Float32Array(paddedLen);
  const noisePsd = new Float64Array(bins);
  let initialized = false;

  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  const initFrames = Math.min(8, Math.max(1, Math.floor(samples.length / hop)));

  // Seed initial noise PSD from the leading frames (~128 ms).
  for (let f = 0; f < initFrames; f += 1) {
    const start = f * hop;
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < fftSize; i += 1) {
      const idx = start + i;
      re[i] = (idx < samples.length ? samples[idx] : 0) * win[i];
    }
    fftRadix2(re, im, 1);
    for (let k = 0; k < bins; k += 1) {
      noisePsd[k] += (re[k] * re[k] + im[k] * im[k]) / initFrames;
    }
    initialized = true;
  }

  const overSubtract = 2.6;
  const spectralFloor = 0.08; // ~ -22 dB (`kHigh`)
  let prevGain = new Float64Array(bins).fill(1);

  for (let start = 0; start < samples.length; start += hop) {
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < fftSize; i += 1) {
      const idx = start + i;
      re[i] = (idx < samples.length ? samples[idx] : 0) * win[i];
    }
    fftRadix2(re, im, 1);

    let framePower = 0;
    for (let k = 0; k < bins; k += 1) {
      framePower += re[k] * re[k] + im[k] * im[k];
    }
    let noisePowerSum = 1e-12;
    for (let k = 0; k < bins; k += 1) noisePowerSum += noisePsd[k];
    const snrFrame = framePower / noisePowerSum;

    for (let k = 0; k < bins; k += 1) {
      const p = re[k] * re[k] + im[k] * im[k];
      if (!initialized) {
        noisePsd[k] = p;
      } else if (snrFrame < 2.2 || p < noisePsd[k] * 1.35) {
        noisePsd[k] = 0.90 * noisePsd[k] + 0.10 * p;
      } else {
        noisePsd[k] = 0.996 * noisePsd[k] + 0.004 * Math.min(p, noisePsd[k] * 2.0);
      }
      const postSnr = p / Math.max(1e-12, noisePsd[k]);
      const rawGain = Math.max(spectralFloor, 1 - Math.sqrt(overSubtract / Math.max(overSubtract, postSnr)));
      const gain = 0.35 * prevGain[k] + 0.65 * rawGain;
      prevGain[k] = gain;

      re[k] *= gain;
      im[k] *= gain;
      if (k > 0 && k < bins - 1) {
        re[fftSize - k] = re[k];
        im[fftSize - k] = -im[k];
      }
    }
    initialized = true;
    fftRadix2(re, im, -1);

    for (let i = 0; i < fftSize; i += 1) {
      out[start + i] += re[i] * win[i];
      norm[start + i] += win[i] * win[i];
    }
  }

  const trimmed = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const w = norm[i] > 1e-6 ? out[i] / norm[i] : out[i];
    trimmed[i] = Math.max(-1, Math.min(1, w));
  }
  return trimmed;
}

/**
 * Simulates causal WebRTC AGC2 digital adaptive gain + soft limiter:
 * Tracks short-term speech RMS (10 ms frames), boosts low-level speech toward -16 dBFS (RMS ~0.158, max +15 dB gain)
 * while holding gain during unvoiced/noise-floor frames and soft-limiting peaks at 0.95.
 */
export function applyAutoGainControl(samples, sampleRate = EVAL_SAMPLE_RATE) {
  if (samples.length === 0) return new Float32Array(0);
  const frameLen = Math.max(1, Math.round(0.01 * sampleRate)); // 160 samples @ 16 kHz
  const targetRms = 0.158; // ~ -16 dBFS
  const maxGain = 5.62; // +15 dB
  const minGain = 0.35; // -9 dB
  const gateRms = 0.012; // -38 dBFS noise gate so silence isn't pumped

  const out = new Float32Array(samples.length);
  let currentGain = 1.0;

  for (let offset = 0; offset < samples.length; offset += frameLen) {
    const end = Math.min(samples.length, offset + frameLen);
    let sumSq = 0;
    for (let i = offset; i < end; i += 1) {
      sumSq += samples[i] * samples[i];
    }
    const rms = Math.sqrt(sumSq / (end - offset));
    let desiredGain = currentGain;
    if (rms >= gateRms) {
      desiredGain = Math.max(minGain, Math.min(maxGain, targetRms / rms));
    }
    // Smooth attack / slower release
    const alpha = desiredGain < currentGain ? 0.25 : 0.06;
    const nextGain = currentGain + alpha * (desiredGain - currentGain);

    for (let i = offset; i < end; i += 1) {
      const t = (i - offset) / (end - offset);
      const g = currentGain + t * (nextGain - currentGain);
      const v = samples[i] * g;
      // Soft knee limiter above 0.88
      const absV = Math.abs(v);
      if (absV <= 0.88) {
        out[i] = v;
      } else {
        const sign = v < 0 ? -1 : 1;
        out[i] = sign * (0.88 + 0.09 * Math.tanh((absV - 0.88) / 0.09));
      }
    }
    currentGain = nextGain;
  }
  return out;
}

/** Linear dry/wet mix matching `mixDenoisedSamples` (`wet * denoised + (1 - wet) * raw`). */
export function mixWetDry(raw, denoised, wet = GTCRN_DEFAULT_WET) {
  const clampedWet = Math.min(1, Math.max(0, Number.isFinite(wet) ? wet : GTCRN_DEFAULT_WET));
  const dry = 1 - clampedWet;
  const out = new Float32Array(raw.length);
  const common = Math.min(raw.length, denoised.length);
  for (let i = 0; i < common; i += 1) {
    out[i] = Math.max(-1, Math.max(-1, Math.min(1, clampedWet * denoised[i] + dry * raw[i])));
  }
  for (let i = common; i < raw.length; i += 1) {
    out[i] = Math.max(-1, Math.min(1, raw[i]));
  }
  return out;
}
