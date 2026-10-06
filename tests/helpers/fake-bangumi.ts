import http from "node:http";
import type { AddressInfo } from "node:net";
import sharp from "sharp";

export type FakeRequest = { method: string; path: string; headers: http.IncomingHttpHeaders; body: string };
export type FakeSubject = {
  id: number;
  type: number;
  name: string;
  name_cn: string;
  summary: string;
  date: string;
  platform: string;
  images: { large: string; common: string; medium: string; small: string; grid: string };
  infobox: Array<{ key: string; value: string | Array<{ k?: string; v: string }> }>;
  volumes: number;
  eps: number;
  total_episodes: number;
  rating: { score: number; total: number; rank: number };
  tags: Array<{ name: string; count: number }>;
};
export type FakeRelation = { id: number; type: number; name: string; name_cn: string; images: FakeSubject["images"] | null; relation: string };
export type FakeCharacter = { id: number; name: string; summary: string; type: number; relation: string; images: { large: string; medium: string; small: string; grid: string } | null; actors: Array<{ id: number; name: string; images: { large: string; medium: string; small: string; grid: string } | null }> };
export type FakePerson = { id: number; name: string; type: number; career: string[]; relation: string; eps: string; images: { large: string; medium: string; small: string; grid: string } | null };
export type FakeEpisode = { id: number; type: number; name: string; name_cn: string; sort: number; ep: number; airdate: string; duration: string };
/** One scripted answer, used instead of the normal one the next time `match` fits. */
export type Scripted = { status: number; headers?: Record<string, string>; body?: string; destroy?: boolean; delayMs?: number };

const colors: Record<string, { r: number; g: number; b: number }> = {
  red: { r: 200, g: 40, b: 40 }, green: { r: 40, g: 160, b: 60 }, blue: { r: 40, g: 80, b: 200 }, gold: { r: 220, g: 180, b: 30 },
};

export async function picture(color: keyof typeof colors | { r: number; g: number; b: number } = "red", size: [number, number] = [300, 450], format: "png" | "jpeg" = "png"): Promise<Buffer> {
  const background = typeof color === "string" ? colors[color]! : color;
  const image = sharp({ create: { width: size[0], height: size[1], channels: 3, background } });
  return format === "png" ? image.png().toBuffer() : image.jpeg().toBuffer();
}

/**
 * A stand-in for the Bangumi API and its image host, speaking only the parts of API v0 that MANGA uses and serving
 * synthetic entries. It records every request (to check the User-Agent, the token and the request budget) and lets a
 * test script failures: rate limits, server errors, redirects, a dropped connection.
 */
export class FakeBangumi {
  readonly subjects = new Map<number, FakeSubject>();
  readonly relations = new Map<number, FakeRelation[]>();
  readonly episodes = new Map<number, FakeEpisode[]>();
  readonly characters = new Map<number, FakeCharacter[]>();
  readonly persons = new Map<number, FakePerson[]>();
  readonly images = new Map<string, { bytes: Buffer; mediaType: string }>();
  readonly requests: FakeRequest[] = [];
  private readonly rules: Array<{ match: (request: FakeRequest) => boolean; answers: Scripted[] }> = [];
  private server: http.Server | undefined;
  origin = "";
  host = "";
  offline = false;

  async start(): Promise<this> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const port = (this.server.address() as AddressInfo).port;
    this.host = `127.0.0.1:${port}`;
    this.origin = `http://${this.host}`;
    return this;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }

  /** The options to hand to `MangaProductApp` so its Bangumi client talks to this server only. */
  get clientOptions() {
    return { apiOrigin: this.origin, allowedHosts: [this.host], allowHttp: true, allowPrivate: true, sleep: async () => undefined, maxRetries: 2, timeoutMs: 4000 };
  }

  /** Scripted answers for the next requests that match, in order; once used up, requests are served normally again. */
  script(match: (request: FakeRequest) => boolean, ...answers: Scripted[]): void {
    this.rules.push({ match, answers: [...answers] });
  }

  /** Back to an empty, online server; the listening port stays. */
  reset(): void {
    this.subjects.clear(); this.relations.clear(); this.episodes.clear(); this.characters.clear(); this.persons.clear(); this.images.clear();
    this.requests.length = 0; this.rules.length = 0; this.offline = false;
  }

  count(filter: (request: FakeRequest) => boolean = () => true): number {
    return this.requests.filter(filter).length;
  }

  imageUrl(name: string): string {
    return `${this.origin}/img/${name}`;
  }

  async addImage(name: string, color: keyof typeof colors = "red", size: [number, number] = [300, 450]): Promise<string> {
    this.images.set(name, { bytes: await picture(color, size), mediaType: "image/png" });
    return this.imageUrl(name);
  }

  /** A synthetic entry; `imageName` must have been added with `addImage`. */
  subject(id: number, over: Partial<FakeSubject> & { imageName?: string } = {}): FakeSubject {
    const { imageName, ...rest } = over;
    const url = imageName ? this.imageUrl(imageName) : "";
    const entry: FakeSubject = {
      id, type: 2, name: `Synthetic Entry ${id}`, name_cn: `合成条目 ${id}`, summary: `Invented summary of entry ${id}.`, date: "2020-04-01", platform: "TV",
      images: { large: url, common: url, medium: url, small: url, grid: url },
      infobox: [{ key: "导演", value: "A. Director" }, { key: "动画制作", value: "Synthetic Studio" }],
      volumes: 0, eps: 12, total_episodes: 12, rating: { score: 7.5, total: 120, rank: 321 }, tags: [{ name: "synthetic", count: 20 }, { name: "demo", count: 10 }],
      ...rest,
    };
    this.subjects.set(id, entry);
    return entry;
  }

  /** Avatar addresses in the sizes the source offers; only `grid` and `small` should ever be requested. */
  avatars(name: string): FakeCharacter["images"] {
    return { large: this.imageUrl(`large-${name}`), medium: this.imageUrl(`medium-${name}`), small: this.imageUrl(`small-${name}`), grid: this.imageUrl(`grid-${name}`) };
  }

  /** A character with a voice actor, and a person on the staff, both with small pictures that `addAvatars` serves. */
  character(subjectId: number, id: number, over: Partial<FakeCharacter> = {}): FakeCharacter {
    const entry: FakeCharacter = { id, name: `Synthetic Character ${id}`, summary: `Invented character ${id}.`, type: 1, relation: "主角", images: this.avatars(`c${id}`), actors: [{ id: id + 5000, name: `Synthetic Actor ${id}`, images: null }], ...over };
    this.characters.set(subjectId, [...(this.characters.get(subjectId) ?? []), entry]);
    return entry;
  }

  person(subjectId: number, id: number, over: Partial<FakePerson> = {}): FakePerson {
    const entry: FakePerson = { id, name: `Synthetic Staff ${id}`, type: 1, career: ["producer"], relation: "导演", eps: "", images: this.avatars(`p${id}`), ...over };
    this.persons.set(subjectId, [...(this.persons.get(subjectId) ?? []), entry]);
    return entry;
  }

  /** Serve the small sizes of the avatars of every character and person added so far (large sizes are left out on purpose: asking for them is a fault). */
  async addAvatars(): Promise<void> {
    const names = new Set<string>();
    for (const list of this.characters.values()) for (const item of list) { if (item.images) names.add(item.images.grid.split("/img/")[1]!); if (item.images) names.add(item.images.small.split("/img/")[1]!); }
    for (const list of this.persons.values()) for (const item of list) { if (item.images) names.add(item.images.grid.split("/img/")[1]!); if (item.images) names.add(item.images.small.split("/img/")[1]!); }
    for (const name of names) if (!this.images.has(name)) this.images.set(name, { bytes: await picture("blue", [100, 100]), mediaType: "image/png" });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const request: FakeRequest = { method: req.method ?? "GET", path: req.url ?? "/", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
    this.requests.push(request);
    if (this.offline) { req.socket.destroy(); return; }
    for (const rule of this.rules) {
      if (!rule.answers.length || !rule.match(request)) continue;
      const answer = rule.answers.shift()!;
      if (answer.delayMs) await new Promise((resolve) => setTimeout(resolve, answer.delayMs));
      if (answer.destroy) { req.socket.destroy(); return; }
      res.writeHead(answer.status, answer.headers ?? {});
      res.end(answer.body ?? "");
      return;
    }
    const url = new URL(request.path, this.origin);
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (url.pathname.startsWith("/img/")) {
      const image = this.images.get(decodeURIComponent(url.pathname.slice(5)));
      if (!image) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": image.mediaType, "content-length": image.bytes.length });
      res.end(image.bytes);
      return;
    }
    if (request.method === "POST" && url.pathname === "/v0/search/subjects") {
      const input = JSON.parse(request.body || "{}") as { keyword?: string; filter?: { type?: number[] } };
      const keyword = (input.keyword ?? "").toLowerCase();
      const limit = Number(url.searchParams.get("limit") ?? 10);
      const found = [...this.subjects.values()].filter((subject) => (!input.filter?.type?.length || input.filter.type.includes(subject.type))
        && (!keyword || subject.name.toLowerCase().includes(keyword) || subject.name_cn.toLowerCase().includes(keyword)));
      json({ total: found.length, limit, offset: 0, data: found.slice(0, limit) });
      return;
    }
    const creditsMatch = /^\/v0\/subjects\/(\d+)\/(characters|persons)$/.exec(url.pathname);
    if (creditsMatch) {
      const id = Number(creditsMatch[1]);
      if (!this.subjects.has(id)) { json({ title: "Not Found", description: "synthetic" }, 404); return; }
      json(creditsMatch[2] === "characters" ? this.characters.get(id) ?? [] : this.persons.get(id) ?? []);
      return;
    }
    const subjectMatch = /^\/v0\/subjects\/(\d+)(\/subjects)?$/.exec(url.pathname);
    if (subjectMatch) {
      const id = Number(subjectMatch[1]);
      const subject = this.subjects.get(id);
      if (!subject) { json({ title: "Not Found", description: "synthetic" }, 404); return; }
      json(subjectMatch[2] ? this.relations.get(id) ?? [] : subject);
      return;
    }
    if (url.pathname === "/v0/episodes") {
      const id = Number(url.searchParams.get("subject_id"));
      const all = this.episodes.get(id) ?? [];
      const limit = Number(url.searchParams.get("limit") ?? 100);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      json({ total: all.length, limit, offset, data: all.slice(offset, offset + limit) });
      return;
    }
    json({ title: "Not Found", description: "synthetic" }, 404);
  }
}

export async function startFakeBangumi(): Promise<FakeBangumi> {
  return new FakeBangumi().start();
}
