import fs from "node:fs";
import path from "node:path";
import WebTorrent from "webtorrent";
import parseTorrent from "parse-torrent";

/** What this engine calls itself, and the kind of resume data it leaves: the torrent file under the job's `engine` folder and the data under its `data` folder. A change to either bumps the format, and the host then refuses to reuse what an older engine left. */
export const ENGINE = "bittorrent";
export const RESUME_FORMAT = "bt-v1";

/** A piece that fails its hash this many times is not going to arrive correct from the peers there are: the source's data is bad. */
const PIECE_FAILURES = 8;
const PROGRESS_MS = 1000;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

const coded = (code, message) => Object.assign(new Error(message), { code });

/** Whether a path inside a torrent can be written under a folder on every system: no way out of the folder, no names a system refuses. */
export function unsafeEntry(rel) {
  if (typeof rel !== "string" || !rel || rel.length > 500 || rel.includes("\\") || rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) return true;
  return rel.split("/").some((part) => !part || part === "." || part === ".." || /[<>:"|?*\u0000-\u001f]/.test(part) || /[. ]$/.test(part) || RESERVED.test(part) || part.length > 200);
}

/**
 * The BitTorrent engine behind the acquisition slot. It only moves bytes: it adds a torrent into the folder the host gave, downloads the files the
 * host selected, checks every piece against the torrent's hashes, and says what happened. It publishes nothing and imports nothing; where the
 * files go afterwards is the host's decision. Peers are reached over TCP (and DHT when the host allows it); web seeds, WebRTC and uTP are off.
 */
export class BtEngine {
  constructor({ emit, version }) {
    this.emit = emit;
    this.version = version;
    this.config = { dht: true, lsd: false, natUpnp: false, natPmp: false, maxConns: 55 };
    this.limits = { downKbps: 0, upKbps: 0 };
    this.client = null;
    this.jobs = new Map();
    this.timer = null;
  }

  info() {
    return { engine: ENGINE, resumeFormat: RESUME_FORMAT, version: this.version, library: `webtorrent ${WebTorrent.VERSION ?? ""}`.trim() };
  }

  /** Network settings; allowed only while nothing is running, because a client's sockets are made once. */
  async configure(settings = {}) {
    if (this.jobs.size) throw coded("BUSY", "the network settings cannot change while jobs are running");
    const next = { ...this.config };
    for (const key of ["dht", "lsd", "natUpnp", "natPmp"]) if (typeof settings[key] === "boolean") next[key] = settings[key];
    if (Number.isInteger(settings.maxConns) && settings.maxConns > 0 && settings.maxConns <= 500) next.maxConns = settings.maxConns;
    if (Number.isInteger(settings.torrentPort) && settings.torrentPort >= 0 && settings.torrentPort < 65536) next.torrentPort = settings.torrentPort;
    this.config = next;
    await this.#closeClient();
    return { ok: true };
  }

  setLimits({ downKbps = 0, upKbps = 0 } = {}) {
    this.limits = { downKbps: Math.max(0, Math.floor(downKbps)), upKbps: Math.max(0, Math.floor(upKbps)) };
    this.#applyLimits();
    return { ok: true };
  }

  #applyLimits() {
    if (!this.client) return;
    this.client.throttleDownload(this.limits.downKbps > 0 ? this.limits.downKbps * 1024 : -1);
    this.client.throttleUpload(this.limits.upKbps > 0 ? this.limits.upKbps * 1024 : -1);
  }

  #ensureClient() {
    if (this.client) return this.client;
    const { dht, lsd, natUpnp, natPmp, maxConns, torrentPort } = this.config;
    const client = new WebTorrent({ dht, lsd, natUpnp, natPmp, maxConns, torrentPort: torrentPort ?? 0, dhtPort: 0, utp: false, webSeeds: false });
    client.on("error", (error) => this.emit("acq.engineError", { message: String(error?.message ?? error).slice(0, 300) }));
    this.client = client;
    this.#applyLimits();
    this.timer = setInterval(() => this.#tick(), PROGRESS_MS);
    this.timer.unref?.();
    return client;
  }

  async #closeClient() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    const client = this.client;
    this.client = null;
    if (client) await new Promise((resolve) => client.destroy(() => resolve()));
  }

  /** Parses a magnet link or a torrent file and leaves only the trackers a plain socket can reach: no web seeds and no WebRTC trackers. */
  static async #parse({ magnet, torrentPath }) {
    let parsed;
    try { parsed = await (torrentPath ? parseTorrent(fs.readFileSync(torrentPath)) : parseTorrent(String(magnet ?? ""))); } catch (error) {
      throw coded("INVALID_SOURCE", torrentPath ? "this is not a torrent file" : "this is not a magnet link");
    }
    if (!parsed || typeof parsed !== "object" || !parsed.infoHash) throw coded("INVALID_SOURCE", "the source names no torrent");
    parsed.announce = (parsed.announce ?? []).filter((url) => /^(?:https?|udp):\/\//i.test(String(url)));
    parsed.urlList = [];
    return parsed;
  }

  /**
   * Adds a torrent that downloads into `dir`. With `selected` null the engine only fetches the torrent's metadata and says what files there are; it
   * downloads nothing until files are selected. Adding a torrent whose data is already under `dir` checks the pieces on disk and continues from them.
   */
  async add({ jobId, magnet, torrentPath, dir, stateDir, selected = null }) {
    if (!jobId || typeof jobId !== "string") throw coded("INVALID", "a job id is needed");
    if (this.jobs.has(jobId)) throw coded("DUPLICATE", "that job is already running");
    if (!path.isAbsolute(String(dir)) || !path.isAbsolute(String(stateDir))) throw coded("INVALID", "the folders must be absolute");
    const parsed = await BtEngine.#parse({ magnet, torrentPath });
    const client = this.#ensureClient();
    if (client.torrents.some((torrent) => torrent.infoHash === parsed.infoHash) || [...this.jobs.values()].some((job) => job.infoHash === parsed.infoHash)) throw coded("DUPLICATE", "that torrent is already being downloaded");
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(stateDir, "engine"), { recursive: true });
    const job = { jobId, infoHash: parsed.infoHash, dir, stateDir, selected: selected ? new Set(selected) : null, torrent: null, files: [], watching: new Set(), state: "metadata", bad: new Map(), settled: false, verifying: false, seed: false, ratioLimit: 0 };
    this.jobs.set(jobId, job);
    try {
      job.torrent = client.add(parsed, { path: dir, deselect: true, destroyStoreOnDestroy: false });
    } catch (error) {
      this.jobs.delete(jobId);
      throw coded("ENGINE", String(error?.message ?? error));
    }
    this.#watch(job);
    return { infoHash: parsed.infoHash };
  }

  #watch(job) {
    const { torrent } = job;
    torrent.on("ready", () => this.#onReady(job));
    torrent.on("warning", (warning) => this.#onWarning(job, warning));
    torrent.on("error", (error) => { void this.#fail(job, error?.code === "ENOSPC" ? "DISK_FULL" : "ENGINE", String(error?.message ?? error)); });
  }

  #onReady(job) {
    const { torrent } = job;
    job.files = torrent.files.map((file, index) => ({ index, path: file.path.split(path.sep).join("/"), length: file.length }));
    const bad = job.files.find((file) => unsafeEntry(file.path));
    if (bad) { void this.#fail(job, "PATH_ESCAPE", "the torrent holds a file name that is not allowed"); return; }
    try { fs.writeFileSync(path.join(job.stateDir, "engine", "torrent.torrent"), torrent.torrentFile); } catch (error) { void this.#fail(job, "DISK_FULL", String(error?.message ?? error)); return; }
    job.state = job.selected ? "downloading" : "choosing";
    this.emit("acq.metadata", { jobId: job.jobId, infoHash: job.infoHash, name: torrent.name, totalLength: torrent.length, pieceLength: torrent.pieceLength, files: job.files });
    if (job.seed) { this.#seeding(job); return; }
    if (job.selected) this.#apply(job);
  }

  #onWarning(job, warning) {
    const match = /Piece (\d+) failed verification/.exec(String(warning?.message ?? warning));
    if (!match) return;
    const piece = Number(match[1]);
    const count = (job.bad.get(piece) ?? 0) + 1;
    job.bad.set(piece, count);
    this.emit("acq.pieceFailed", { jobId: job.jobId, piece, count });
    if (count >= PIECE_FAILURES) void this.#fail(job, "PIECE_VERIFY", `piece ${piece} never passed its hash check`);
  }

  /** Selects what the host chose and drops the rest; a file already complete from an earlier run counts at once. */
  #apply(job) {
    if (!job.torrent || job.torrent.destroyed) return;
    // Files share pieces at their edges, and deselecting one file trims the pieces its neighbour needs, so the whole selection is cleared and made again.
    job.torrent.deselect(0, job.torrent.pieces.length - 1);
    for (const index of job.selected) job.torrent.files[index].select();
    for (const index of job.selected) {
      const file = job.torrent.files[index];
      if (file.done) this.emit("acq.fileDone", { jobId: job.jobId, index });
      else if (!job.watching.has(index)) {
        job.watching.add(index);
        file.once("done", () => { this.emit("acq.fileDone", { jobId: job.jobId, index }); this.#finished(job); });
      }
    }
    job.state = "downloading";
    this.#finished(job);
  }

  async select({ jobId, indexes }) {
    const job = this.jobs.get(jobId);
    if (!job || !job.torrent) throw coded("UNKNOWN_JOB", "no such job");
    if (job.state === "metadata") throw coded("NOT_READY", "the torrent's files are not known yet");
    if (!Array.isArray(indexes) || indexes.some((index) => !Number.isInteger(index) || index < 0 || index >= job.files.length)) throw coded("INVALID", "a selected file is not in the torrent");
    if (!indexes.length) throw coded("INVALID", "select at least one file");
    job.selected = new Set(indexes);
    this.#apply(job);
    return { ok: true };
  }

  /** When every selected file is whole, checks all of its pieces once more against the torrent's hashes, then says so. */
  #finished(job) {
    if (job.settled || job.verifying || !job.selected || !job.torrent || job.torrent.destroyed) return;
    if (![...job.selected].every((index) => job.torrent.files[index].done)) return;
    job.verifying = true;
    job.state = "verifying";
    this.emit("acq.verifying", { jobId: job.jobId });
    job.torrent.rescanFiles((error) => {
      if (job.settled || !job.torrent || job.torrent.destroyed) return;
      if (error) { void this.#fail(job, "ENGINE", String(error?.message ?? error)); return; }
      const whole = [...job.selected].every((index) => {
        const file = job.torrent.files[index];
        for (let piece = file._startPiece; piece <= file._endPiece; piece += 1) if (!job.torrent.bitfield.get(piece)) return false;
        return true;
      });
      if (!whole) { void this.#fail(job, "PIECE_VERIFY", "a downloaded file no longer matches the torrent's hashes"); return; }
      job.settled = true;
      job.state = "verified";
      const files = [...job.selected].sort((a, b) => a - b).map((index) => job.files[index]);
      const stats = this.#stats(job);
      // Everything the engine holds for this job is released before the host publishes: an open file cannot be moved or removed on every system.
      void this.#drop(job, false).then(() => this.emit("acq.verified", { jobId: job.jobId, files, downloaded: stats.downloaded, uploaded: stats.uploaded }));
    });
  }

  /**
   * Seeds what a finished job published: the torrent is added again over the published files (their folder is `dir`), checked against its hashes,
   * and uploaded until the ratio is reached (0 = until stopped). Nothing is downloaded: files that are not there are simply not offered.
   */
  async seed({ jobId, torrentPath, dir, stateDir, ratio = 0 }) {
    if (this.jobs.has(jobId)) throw coded("DUPLICATE", "that job is already running");
    const parsed = await BtEngine.#parse({ torrentPath });
    const client = this.#ensureClient();
    if (client.torrents.some((torrent) => torrent.infoHash === parsed.infoHash)) throw coded("DUPLICATE", "that torrent is already running");
    const job = { jobId, infoHash: parsed.infoHash, dir, stateDir, selected: null, torrent: null, files: [], watching: new Set(), state: "seeding", bad: new Map(), settled: false, verifying: false, seed: true, ratioLimit: Math.max(0, Number(ratio) || 0) };
    this.jobs.set(jobId, job);
    job.torrent = client.add(parsed, { path: dir, deselect: true, destroyStoreOnDestroy: false });
    this.#watch(job);
    return { infoHash: parsed.infoHash };
  }

  #seeding(job) {
    job.state = "seeding";
    this.emit("acq.seeding", { jobId: job.jobId });
  }

  #stats(job) {
    const torrent = job.torrent;
    if (!torrent) return { downloaded: 0, uploaded: 0, downloadSpeed: 0, uploadSpeed: 0, peers: 0, ratio: 0 };
    const selected = job.selected ? [...job.selected].reduce((sum, index) => sum + (torrent.files[index]?.downloaded ?? 0), 0) : torrent.downloaded;
    return { downloaded: selected, uploaded: torrent.uploaded, downloadSpeed: torrent.downloadSpeed, uploadSpeed: torrent.uploadSpeed, peers: torrent.numPeers, ratio: torrent.length ? torrent.uploaded / torrent.length : 0 };
  }

  #tick() {
    for (const job of this.jobs.values()) {
      if (job.settled || !job.torrent) continue;
      const stats = this.#stats(job);
      this.emit("acq.progress", { jobId: job.jobId, state: job.state, ...stats });
      if (job.state === "seeding" && job.ratioLimit > 0 && stats.ratio >= job.ratioLimit) {
        job.settled = true;
        void this.#drop(job, false).then(() => this.emit("acq.seedStopped", { jobId: job.jobId, reason: "ratio", uploaded: stats.uploaded, ratio: stats.ratio }));
      }
    }
  }

  async #fail(job, code, message) {
    if (job.settled) return;
    job.settled = true;
    await this.#drop(job, false);
    this.emit("acq.error", { jobId: job.jobId, code, message: String(message).slice(0, 300) });
  }

  /** Stops one job and releases its sockets and files. The data under the job's folder is kept unless asked otherwise. */
  async #drop(job, deleteFiles) {
    this.jobs.delete(job.jobId);
    const torrent = job.torrent;
    job.torrent = null;
    if (torrent && !torrent.destroyed) await new Promise((resolve) => torrent.destroy({ destroyStore: deleteFiles }, () => resolve()));
  }

  async remove({ jobId, deleteFiles = false }) {
    const job = this.jobs.get(jobId);
    if (!job) return { ok: true };
    job.settled = true;
    await this.#drop(job, deleteFiles);
    return { ok: true };
  }

  status() {
    return { jobs: [...this.jobs.values()].map((job) => ({ jobId: job.jobId, infoHash: job.infoHash, state: job.state, ...this.#stats(job) })) };
  }

  async shutdown() {
    for (const job of this.jobs.values()) job.settled = true;
    this.jobs.clear();
    await this.#closeClient();
  }
}
