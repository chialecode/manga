import { describe, expect, it } from "vitest";
import { CommandInputs, MediaCommandInputs, validateCommandInput } from "@manga/contracts";

const region = { x: 0.1, y: 0.1, width: 0.5, height: 0.5 };

/**
 * One valid input per media command, so adding a command without a schema example fails here.
 * Each command also gets counterexamples below: a wrong type, a value out of range, an unknown field.
 */
const VALID: Record<keyof typeof MediaCommandInputs, Record<string, unknown>> = {
  "library.inspectFile": { pathHandle: "h1" },
  "works.list": { limit: 50, sort: "title", kind: "comic", shelf: "reading", linked: false, query: "a" },
  "works.get": { workId: "w1" },
  "works.importDirectory": { pathHandle: "h1", kind: "comic", title: "t" },
  "works.setKind": { resourceId: "r1", kind: "video" },
  "works.moveResource": { resourceId: "r1", newWorkTitle: "新作品" },
  "works.setOrdinal": { resourceId: "r1", ordinal: { type: "episode", number: 3 } },
  "works.setShelf": { workId: "w1", state: "reading" },
  "works.setOverride": { workId: "w1", fields: { title: "x" }, locked: ["author"], cleared: [] },
  "works.open": { resourceId: "r1" },
  "covers.list": { workId: "w1" },
  "covers.select": { workId: "w1", coverId: "c1" },
  "covers.lock": { workId: "w1", locked: true },
  "covers.fromImage": { workId: "w1", pathHandle: "h1" },
  "covers.handles": { coverIds: ["c1"], size: "grid" },
  "metadata.providers": {},
  "metadata.setProvider": { providerId: "bangumi", enabled: true },
  "metadata.search": { query: "勇者", kind: "video", limit: 10 },
  "metadata.candidates": { workId: "w1" },
  "metadata.link": { workId: "w1", providerId: "bangumi", externalId: "12" },
  "metadata.unlink": { workId: "w1", providerId: "bangumi" },
  "metadata.refresh": { workId: "w1" },
  "metadata.related": { workId: "w1" },
  "metadata.findMissing": { limit: 20 },
  "comic.pages": { resourceId: "r1" },
  "comic.pageHandle": { resourceId: "r1", revisionId: "v1", pageId: "p1", variant: "display", maxEdge: 1200 },
  "comic.pageHandles": { resourceId: "r1", revisionId: "v1", pageIds: ["p1", "p2"] },
  "video.probe": { resourceId: "r1" },
  "video.subtitles": { resourceId: "r1" },
  "video.audioTracks": { resourceId: "r1" },
  "video.frameIndex": { resourceId: "r1", timeMs: 1000, delta: 1 },
  "video.playbackPlan": { resourceId: "r1", hardwareHevc: false },
  "video.playCopy": { resourceId: "r1", revisionId: "v1", action: "create", reason: "unsupported_audio" },
  "video.handle": { resourceId: "r1", revisionId: "v1", source: "original" },
  "video.subtitleHandle": { resourceId: "r1", revisionId: "v1", trackId: "s0" },
  "video.fonts": { resourceId: "r1", revisionId: "v1" },
  "progress.setPage": { resourceId: "r1", resourceRevisionId: "v1", pageId: "p1" },
  "progress.setTime": { resourceId: "r1", resourceRevisionId: "v1", timeMs: 1000, played: [{ startMs: 0, endMs: 1000 }] },
  "progress.get": { resourceId: "r1" },
  "settings.getRecording": {},
  "settings.setRecording": { holdKey: "F8", retention: "discard", duckPlayback: "lower", boundaryMarginMs: 300 },
  "settings.getMedia": {},
  "settings.getModules": {},
  "settings.setModule": { featureId: "voice", enabled: false },
  "settings.setMedia": { comic: { direction: "rtl", layout: "double", zoom: 1.5 }, video: { rate: 1.25, volume: 0.5 } },
  "capture.start": { mode: "hold", resourceId: "r1", resourceRevisionId: "v1", locator: { kind: "temporal", startMs: 0 } },
  "capture.append": { sessionId: "s1", seq: 0, data: "AAAA" },
  "capture.event": { sessionId: "s1", offsetMs: 100, reason: "seek", locator: { kind: "temporal", startMs: 5000 } },
  "capture.stop": { sessionId: "s1", reason: "user", durationMs: 5000 },
  "capture.status": {},
  "capture.list": { limit: 10 },
  "capture.transcribe": { sessionId: "s1" },
  "capture.retry": { sessionId: "s1" },
  "capture.cancel": { sessionId: "s1" },
  "capture.organize": { sessionId: "s1" },
  "capture.editDraft": { draftId: "d1", editedText: "改过" },
  "capture.acceptDraft": { draftId: "d1", editedText: "改过" },
  "capture.retain": { sessionId: "s1", action: "keep" },
  "capture.review": { sessionId: "s1" },
  "capture.reviseSegment": { segmentId: "g1", text: "修正" },
  "capture.calibrate": { segmentId: "g1", resourceId: "r1", resourceRevisionId: "v1", locator: { kind: "image", pageId: "p1", region } },
  "capture.terms": { workId: "w1" },
  "capture.addTerm": { workId: "w1", term: "魔王" },
  "capture.removeTerm": { workId: "w1", term: "魔王" },
  "capture.audioHandle": { sessionId: "s1" },
  "material.region": { resourceId: "r1", resourceRevisionId: "v1", pageId: "p1", region },
  "material.frame": { resourceId: "r1", resourceRevisionId: "v1", timeMs: 1000 },
  "material.subtitleWindow": { resourceId: "r1", resourceRevisionId: "v1", centerMs: 5000, beforeMs: 30_000 },
};

const COUNTEREXAMPLES: Array<[string, Record<string, unknown>]> = [
  ["works.list", { limit: 0 }],
  ["works.list", { limit: 201 }],
  ["works.list", { kind: "audio" }],
  ["works.list", { shelf: "dropped" }],
  ["works.list", { sort: "random" }],
  ["works.list", { linked: "yes" }],
  ["works.get", { workId: "" }],
  ["works.get", {}],
  ["works.importDirectory", { pathHandle: "h", kind: "podcast" }],
  ["works.moveResource", { resourceId: "r1" }],
  ["works.moveResource", { resourceId: "r1", toWorkId: "w", newWorkTitle: "t" }],
  ["works.setOrdinal", { resourceId: "r1", ordinal: { type: "season", number: 1 } }],
  ["works.setOrdinal", { resourceId: "r1" }],
  ["works.setShelf", { workId: "w1", state: "none-of-these" }],
  ["works.setOverride", { workId: "w1", fields: { rating: "10" }, locked: [], cleared: [] }],
  ["works.setOverride", { workId: "w1", fields: {}, locked: ["nope"], cleared: [] }],
  ["covers.handles", { coverIds: [], size: "grid" }],
  ["covers.handles", { coverIds: ["c"], size: "huge" }],
  ["covers.lock", { workId: "w1", locked: "true" }],
  ["metadata.setProvider", { providerId: "Not A Slug!", enabled: true }],
  ["metadata.search", { query: "" }],
  ["metadata.search", { query: "x", limit: 26 }],
  ["metadata.search", { query: "x", mode: "everything" }],
  ["metadata.link", { workId: "w1", providerId: "bangumi", externalId: "" }],
  ["comic.pageHandle", { resourceId: "r1", revisionId: "v1", pageId: "p1", maxEdge: 63 }],
  ["comic.pageHandle", { resourceId: "r1", revisionId: "v1", pageId: "p1", maxEdge: 4097 }],
  ["comic.pageHandle", { resourceId: "r1", revisionId: "v1", pageId: "p1", variant: "raw" }],
  ["comic.pageHandle", { resourceId: "r1", pageId: "p1" }],
  ["comic.pageHandles", { resourceId: "r1", revisionId: "v1", pageIds: [] }],
  ["comic.pageHandles", { resourceId: "r1", revisionId: "v1", pageIds: Array.from({ length: 13 }, (_, index) => `p${index}`) }],
  ["video.frameIndex", { resourceId: "r1", timeMs: -1 }],
  ["video.frameIndex", { resourceId: "r1", timeMs: 1000, frame: 3 }],
  ["video.frameIndex", { resourceId: "r1", delta: 1001 }],
  ["video.frameIndex", { resourceId: "r1", timeMs: 1.5 }],
  ["video.playbackPlan", { resourceId: "r1", audioStreamIndex: -1 }],
  ["video.playCopy", { resourceId: "r1", revisionId: "v1", action: "delete" }],
  ["video.handle", { resourceId: "r1", revisionId: "v1", source: "remote" }],
  ["progress.setPage", { resourceId: "r1", pageId: "p1" }],
  ["progress.setTime", { resourceId: "r1", resourceRevisionId: "v1", timeMs: -5 }],
  ["progress.setTime", { resourceId: "r1", resourceRevisionId: "v1", timeMs: 10 ** 12 }],
  ["progress.setTime", { resourceId: "r1", resourceRevisionId: "v1", timeMs: 1, played: [{ startMs: 9, endMs: 1 }] }],
  ["progress.setTime", { resourceId: "r1", resourceRevisionId: "v1", timeMs: 1, played: Array.from({ length: 65 }, () => ({ startMs: 0, endMs: 1 })) }],
  ["settings.setRecording", { boundaryMarginMs: 2001 }],
  ["settings.setRecording", { retention: "forever" }],
  ["settings.setRecording", { overlay: { width: 10 } }],
  ["settings.setMedia", { comic: { zoom: 5 } }],
  ["settings.setMedia", { comic: { direction: "up" } }],
  ["settings.setMedia", { video: { rate: 0.1 } }],
  ["settings.setMedia", { video: { volume: 1.5 } }],
  ["settings.setModule", { featureId: "voice" }],
  ["settings.setModule", { featureId: "", enabled: true }],
  ["capture.start", { mode: "push" }],
  ["capture.start", { mode: "hold", sampleRate: 44_100 }],
  ["capture.append", { sessionId: "s1", seq: -1, data: "AA" }],
  ["capture.append", { sessionId: "s1", seq: 0, data: "" }],
  ["capture.append", { sessionId: "s1", seq: 0, data: "A".repeat(1_400_001) }],
  ["capture.event", { sessionId: "s1", offsetMs: 0, reason: "teleport" }],
  ["capture.event", { sessionId: "s1", offsetMs: 0, reason: "seek", playbackRate: 9 }],
  ["capture.event", { sessionId: "s1", offsetMs: 0, reason: "seek", locator: { kind: "temporal", startMs: 9, endMs: 1 } }],
  ["capture.stop", { sessionId: "s1", reason: "boredom" }],
  ["capture.retain", { sessionId: "s1", action: "archive" }],
  ["capture.reviseSegment", { segmentId: "g", text: "x".repeat(20_001) }],
  ["capture.addTerm", { workId: "w1", term: "" }],
  ["capture.addTerm", { workId: "w1", term: "x".repeat(129) }],
  ["material.region", { resourceId: "r1", resourceRevisionId: "v1", pageId: "p1", region: { x: 0.9, y: 0, width: 0.5, height: 1 } }],
  ["material.region", { resourceId: "r1", resourceRevisionId: "v1", pageId: "p1", region: { x: 0, y: 0, width: 0, height: 1 } }],
  ["material.frame", { resourceId: "r1", resourceRevisionId: "v1", timeMs: "5" }],
  ["material.subtitleWindow", { resourceId: "r1", resourceRevisionId: "v1", centerMs: 0, beforeMs: 600_001 }],
];

describe("media command contracts", () => {
  it("declares a schema for every media command and registers each in the product command map", () => {
    expect(Object.keys(VALID).sort()).toEqual(Object.keys(MediaCommandInputs).sort());
    for (const commandId of Object.keys(MediaCommandInputs)) expect(CommandInputs, commandId).toHaveProperty([commandId]);
  });

  it.each(Object.entries(VALID))("accepts a well-formed %s", (commandId, input) => {
    expect(() => validateCommandInput(commandId, input), commandId).not.toThrow();
  });

  it.each(Object.keys(VALID))("rejects an unknown field on %s", (commandId) => {
    expect(() => validateCommandInput(commandId, { ...VALID[commandId as keyof typeof VALID], surprise: 1 }), commandId).toThrow();
  });

  it.each(COUNTEREXAMPLES.map((entry, index) => [index, ...entry] as const))("rejects counterexample %i for %s", (_index, commandId, input) => {
    expect(() => validateCommandInput(commandId, input), `${commandId} ${JSON.stringify(input).slice(0, 80)}`).toThrow();
  });

  it("refuses every media command that drops a required field", () => {
    let checked = 0;
    for (const [commandId, input] of Object.entries(VALID)) {
      const schema = MediaCommandInputs[commandId as keyof typeof MediaCommandInputs] as unknown as { shape: Record<string, { safeParse(value: unknown): { success: boolean } }> };
      for (const key of Object.keys(input)) {
        if (schema.shape[key]!.safeParse(undefined).success) continue;
        const { [key]: _dropped, ...rest } = input;
        expect(() => validateCommandInput(commandId, rest), `${commandId} without ${key}`).toThrow();
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(60);
  });

  it("keeps a capture audio chunk under the message budget", () => {
    // 100 ms of 16 kHz mono 16-bit PCM is 3200 bytes, 4268 characters of base64; the limit leaves room for batching ~30 s per call.
    const chunk = Buffer.alloc(3200).toString("base64");
    expect(chunk.length).toBeLessThan(5000);
    expect(() => validateCommandInput("capture.append", { sessionId: "s", seq: 1, data: chunk })).not.toThrow();
    expect(MediaCommandInputs["capture.append"].shape.data.maxLength).toBeGreaterThanOrEqual(chunk.length * 300);
  });
});
