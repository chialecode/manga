/** What this machine can decode, asked of the browser once. The player plans playback around the answer. */

let hardwareHevc: Promise<boolean> | null = null;
let failedForGood = false;

/**
 * True when the platform decodes HEVC Main 10 in hardware. Chromium has no software HEVC decoder, so without this the
 * only way to play such a file is a play copy. Main 10 is asked about because it also covers 8-bit.
 */
export function detectHardwareHevc(): Promise<boolean> {
  if (failedForGood) return Promise.resolve(false);
  hardwareHevc ??= (async () => {
    try {
      const capabilities = (navigator as Navigator & { mediaCapabilities?: { decodingInfo: (config: unknown) => Promise<{ supported: boolean; powerEfficient: boolean }> } }).mediaCapabilities;
      if (!capabilities) return false;
      const info = await capabilities.decodingInfo({
        type: "file",
        video: { contentType: 'video/mp4; codecs="hvc1.2.4.L93.B0"', width: 1920, height: 1080, bitrate: 6_000_000, framerate: 24 },
      });
      return info.supported && info.powerEfficient;
    } catch {
      return false;
    }
  })();
  return hardwareHevc;
}

/** The player met a real decode failure although the browser said yes: stop trusting it for the rest of the run. */
export function markHardwareHevcFailed(): void {
  failedForGood = true;
}

/** For tests. */
export function resetVideoSupport(): void {
  hardwareHevc = null;
  failedForGood = false;
}
