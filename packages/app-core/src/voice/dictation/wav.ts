import { decodePcm16MonoWav, wavFromPcm } from "../audio-files.ts";

/** Encodes raw 16-bit little-endian mono PCM into a standard 44-byte RIFF/WAVE buffer. */
export const encodePcm16MonoWav = wavFromPcm;

export { decodePcm16MonoWav };
