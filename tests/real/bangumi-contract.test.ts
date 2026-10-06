import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { BangumiClient, SUBJECT_TYPE, bangumiUserAgent, normalizeSubject } from "../../packages/app-core/src/metadata/bangumi.ts";
import { evidenceRunDir } from "../../scripts/desktop-paths.ts";

/**
 * Contract check against the real Bangumi API (plan section 3.2). It runs only when MANGA_LIVE_BANGUMI=1 and never in CI.
 *
 * - read only, no credentials, at most 10 requests per run;
 * - it looks the entries up by a generic keyword and follows the first answer, so no title, summary or picture of any entry
 *   is written into the repository: the evidence file carries endpoint names, outcomes and counts only;
 * - a network that cannot reach Bangumi makes the result `blocked` (with the reason), not failed;
 * - behind a proxy, run it with NODE_USE_ENV_PROXY=1 HTTPS_PROXY=<proxy> so Node's fetch honours the proxy.
 */
const enabled = process.env.MANGA_LIVE_BANGUMI === "1" && !process.env.CI;
const BUDGET = 10;
/** An entry with many characters, voice actors and pictures, used only when the searched entry has none. */
const REFERENCE_SUBJECT = 253;

type Step = { endpoint: string; outcome: "ok" | "failed"; detail?: string };

describe.skipIf(!enabled)("Bangumi API contract (live, read only)", () => {
  it("search, entry, relations, episodes, characters, staff and a cover still have the shape MANGA depends on", async (context) => {
    const client = new BangumiClient({ fetch: (url, init) => fetch(url, init as RequestInit), userAgent: bangumiUserAgent("contract-test"), timeoutMs: 20_000, maxRetries: 1 });
    const steps: Step[] = [];
    const out = path.join(evidenceRunDir("m2", "live-bangumi"), "summary.json");
    const write = (status: "passed" | "blocked" | "failed", extra: Record<string, unknown> = {}) => {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), status, requests: client.requests, budget: BUDGET, steps, ...extra }, null, 2));
    };
    const attempt = async <T>(endpoint: string, work: () => Promise<T>): Promise<T> => {
      try {
        const value = await work();
        steps.push({ endpoint, outcome: "ok" });
        return value;
      } catch (error) {
        const code = (error as { code?: string }).code ?? "ERROR";
        const reason = (error as { details?: { reason?: string } }).details?.reason;
        steps.push({ endpoint, outcome: "failed", detail: `${code}${reason ? `:${reason}` : ""}` });
        throw error;
      }
    };

    let anime;
    try {
      anime = await attempt("POST /v0/search/subjects (anime)", () => client.search({ keyword: "春", types: [SUBJECT_TYPE.anime], limit: 3 }));
    } catch (error) {
      const reason = (error as { details?: { reason?: string } }).details?.reason;
      if ((error as { code?: string }).code === "PROVIDER_UNAVAILABLE" && (reason === "network" || reason === "timeout")) {
        write("blocked", { reason: "the network cannot reach the Bangumi API from this machine", retest: "run again with a working route, e.g. NODE_USE_ENV_PROXY=1 HTTPS_PROXY=<proxy>" });
        context.skip();
        return;
      }
      write("failed");
      throw error;
    }
    try {
      expect(anime.total).toBeGreaterThan(0);
      expect(anime.subjects.length).toBeGreaterThan(0);
      const first = anime.subjects[0]!;
      expect(first.type).toBe(SUBJECT_TYPE.anime);

      const books = await attempt("POST /v0/search/subjects (book)", () => client.search({ keyword: "春", types: [SUBJECT_TYPE.book], limit: 3 }));
      expect(books.subjects.every((item) => item.type === SUBJECT_TYPE.book)).toBe(true);

      const subject = await attempt("GET /v0/subjects/{id}", () => client.subject(first.id));
      const normalized = normalizeSubject(subject);
      expect(normalized.fields.title).toBeTruthy();
      expect(normalized.externalId).toBe(String(first.id));
      expect(normalized.sourceUrl).toBe(`https://bgm.tv/subject/${first.id}`);

      const related = await attempt("GET /v0/subjects/{id}/subjects", () => client.related(first.id));
      expect(Array.isArray(related)).toBe(true);
      const episodes = await attempt("GET /v0/episodes", () => client.episodes(first.id, 100));
      expect(Array.isArray(episodes)).toBe(true);

      // The preview's character and staff lists (A-49). The client's schemas already reject a changed shape; these checks add what the
      // interface relies on: every row has an id and a name, a character carries its relation and voice actors, a person its careers.
      // The first entry of a generic search often lists no characters; then a long-running public entry (its numeric id only) is the shape reference.
      let characters = await attempt("GET /v0/subjects/{id}/characters", () => client.characters(first.id));
      let charactersFrom: "search-result" | "reference-entry" = "search-result";
      if (characters.length === 0) {
        characters = await attempt("GET /v0/subjects/{id}/characters (reference entry)", () => client.characters(REFERENCE_SUBJECT));
        charactersFrom = "reference-entry";
      }
      expect(Array.isArray(characters)).toBe(true);
      expect(characters.every((item) => Number.isInteger(item.id) && item.name.length > 0 && typeof item.relation === "string" && Array.isArray(item.actors))).toBe(true);
      const persons = await attempt("GET /v0/subjects/{id}/persons", () => client.persons(first.id));
      expect(Array.isArray(persons)).toBe(true);
      expect(persons.every((item) => Number.isInteger(item.id) && item.name.length > 0 && typeof item.relation === "string" && Array.isArray(item.career))).toBe(true);

      const imageUrl = normalized.images.large || normalized.images.common || normalized.images.medium;
      let imageChecked = false;
      if (imageUrl) {
        expect(new URL(imageUrl).hostname.endsWith("bgm.tv") || new URL(imageUrl).hostname.endsWith("bangumi.tv")).toBe(true);
        const image = await attempt("GET cover image", () => client.image(imageUrl));
        expect(image.mediaType).toMatch(/^image\//);
        const meta = await sharp(image.bytes).metadata();
        expect(meta.width ?? 0).toBeGreaterThan(0);
        imageChecked = true;
      }
      expect(client.requests).toBeLessThanOrEqual(BUDGET);
      write("passed", {
        shape: {
          searchHasTotal: true, subjectHasTitle: true, relationCount: related.length > 0 ? "some" : "none", episodeCount: episodes.length > 0 ? "some" : "none", imageChecked,
          characterCount: characters.length > 0 ? "some" : "none", charactersFrom, voiceActorsListed: characters.some((item) => item.actors.length > 0), personCount: persons.length > 0 ? "some" : "none", careersListed: persons.some((item) => item.career.length > 0),
          characterImagesListed: characters.some((item) => Boolean(item.images?.grid || item.images?.small || item.images?.medium)),
          infoboxPresent: Boolean(subject.infobox?.length),
        },
      });
    } catch (error) {
      write("failed", { error: (error as { code?: string }).code ?? "assertion" });
      throw error;
    }
  });
});
