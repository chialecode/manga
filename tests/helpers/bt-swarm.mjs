// A BitTorrent swarm on the loopback address for tests: one tracker and any number of seeds, in a process of their own so a test's own
// process carries none of the network code. It is driven by messages from its parent. Nothing here reaches a public tracker, the DHT or the LAN.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import createTorrent from "create-torrent";
import { Server } from "bittorrent-tracker";
import WebTorrent from "webtorrent";

const net = { dht: false, lsd: false, natUpnp: false, natPmp: false, utp: false, webSeeds: false };
let tracker = null;
let announce = null;
let client = null;
const seeds = new Map();

const reply = (id, ok, value, error) => process.send({ id, ok, ...(ok ? { value } : { error: String(error?.message ?? error) }) });

/** Deterministic bytes, so a test can tell what a file should hold without keeping a copy. */
function content(length, seed) {
  const out = Buffer.allocUnsafe(length);
  let state = crypto.createHash("sha256").update(String(seed)).digest();
  for (let offset = 0; offset < length; offset += state.length) {
    state.copy(out, offset, 0, Math.min(state.length, length - offset));
    state = crypto.createHash("sha256").update(state).digest();
  }
  return out;
}

async function startTracker() {
  tracker = new Server({ udp: false, http: true, ws: false, stats: false, interval: 400 });
  await new Promise((resolve) => tracker.listen(0, "127.0.0.1", resolve));
  announce = `http://127.0.0.1:${tracker.http.address().port}/announce`;
  client = new WebTorrent({ ...net });
  return { announce };
}

/**
 * Makes the files of a torrent under `root/<id>/<name>`, makes the .torrent from them, and seeds them. `corrupt` flips a byte of one file after the
 * torrent is made, so this seed serves a piece that does not match the torrent's hash. `files` is [{ path, bytes } or { path, text }]; one file whose path is the name is a
 * single-file torrent.
 */
async function seed({ id, root, name, files, pieceLength, corrupt, hidePieces }) {
  const base = path.join(root, id);
  const top = path.join(base, name);
  const written = [];
  const single = files.length === 1 && files[0].path === name;
  for (const file of files) {
    const target = single ? top : path.join(top, ...file.path.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const data = file.text !== undefined ? Buffer.from(file.text, "utf8") : content(file.bytes, `${id}:${file.path}`);
    fs.writeFileSync(target, data);
    written.push({ path: single ? name : `${name}/${file.path}`, length: data.length, sha256: crypto.createHash("sha256").update(data).digest("hex") });
  }
  const buffer = await new Promise((resolve, reject) => createTorrent(top, { name, announceList: [[announce]], pieceLength, private: false }, (error, torrent) => (error ? reject(error) : resolve(torrent))));
  const torrentFile = path.join(base, `${id}.torrent`);
  fs.writeFileSync(torrentFile, buffer);
  if (corrupt) {
    const target = single ? top : path.join(top, ...corrupt.file.split("/"));
    const fd = fs.openSync(target, "r+");
    try { const one = Buffer.alloc(1); fs.readSync(fd, one, 0, 1, corrupt.offset); one[0] ^= 0xff; fs.writeSync(fd, one, 0, 1, corrupt.offset); } finally { fs.closeSync(fd); }
  }
  const torrent = await new Promise((resolve, reject) => {
    const added = client.add(buffer, { path: base, skipVerify: true, announce: [announce] });
    added.once("error", reject);
    added.once("ready", () => resolve(added));
  });
  seeds.set(id, torrent);
  const magnet = `magnet:?xt=urn:btih:${torrent.infoHash}&dn=${encodeURIComponent(name)}&tr=${encodeURIComponent(announce)}`;
  return { infoHash: torrent.infoHash, magnet, torrentFile, files: written, totalLength: torrent.length, pieceLength: torrent.pieceLength };
}

const commands = {
  start: () => startTracker(),
  seed: (params) => seed(params),
  stopSeed: async ({ id }) => { const t = seeds.get(id); seeds.delete(id); if (t) await new Promise((resolve) => t.destroy({ destroyStore: false }, resolve)); return {}; },
  stats: ({ id }) => { const t = seeds.get(id); return t ? { uploaded: t.uploaded, peers: t.numPeers, uploadSpeed: t.uploadSpeed } : null; },
  throttle: ({ kbps }) => { client.throttleUpload(kbps > 0 ? kbps * 1024 : -1); return {}; },
  /** A second client that downloads from whoever is seeding: used to see that a finished job is uploading. */
  leech: ({ magnet, dir }) => new Promise((resolve, reject) => {
    const t = client.add(magnet, { path: dir });
    t.once("error", reject);
    t.once("done", () => resolve({ downloaded: t.downloaded }));
  }),
};

process.on("message", async (message) => {
  const handler = commands[message.cmd];
  if (!handler) { reply(message.id, false, undefined, new Error(`no such command: ${message.cmd}`)); return; }
  try { reply(message.id, true, await handler(message.params ?? {})); } catch (error) { reply(message.id, false, undefined, error); }
});
process.send({ ready: true });
