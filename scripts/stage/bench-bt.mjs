import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import bencode from "bencode";
import { addLibrary, boot, installBt, jobOf, ok, run, until, waitState } from "../../tests/helpers/acquisition-rig.ts";
import { startSwarm } from "../../tests/helpers/bt-swarm.ts";
import { tmpDir } from "../../tests/helpers/plugin-fixtures.ts";

// A download of `bytes` bytes through the BitTorrent plugin from a seed on the loopback address: the tracker and the seed run in a process of
// their own, and nothing reaches a public tracker, the DHT or the LAN. The result is checked without trusting the engine: every piece of the
// finished file is hashed here and compared with the torrent's own list of piece hashes.

const PIECE_BYTES = 256 * 1024;

/** The SHA-1 of every piece of `file`, against the torrent file's list: how many pieces there are, how many match, and the first that does not. */
function verifyPieces(file, torrentFile) {
  const torrent = bencode.decode(fs.readFileSync(torrentFile));
  const pieceLength = Number(torrent.info["piece length"]);
  const hashes = Buffer.from(torrent.info.pieces);
  const pieces = hashes.length / 20;
  const fd = fs.openSync(file, "r");
  let verified = 0;
  let firstBad = -1;
  try {
    const buffer = Buffer.allocUnsafe(pieceLength);
    for (let i = 0; i < pieces; i += 1) {
      const read = fs.readSync(fd, buffer, 0, pieceLength, i * pieceLength);
      const digest = crypto.createHash("sha1").update(buffer.subarray(0, read)).digest();
      if (digest.equals(hashes.subarray(i * 20, i * 20 + 20))) verified += 1; else if (firstBad < 0) firstBad = i;
    }
  } finally { fs.closeSync(fd); }
  return { pieces, verified, firstBad, pieceLength };
}

export async function runBtBench({ bytes }) {
  const swarm = await startSwarm();
  const rig = await boot();
  try {
    await installBt(rig);
    const { dir, pathId } = await addLibrary(rig);
    const seeded = await swarm.seed({ id: "bench-bt", root: tmpDir(), name: "大包.bin", files: [{ path: "大包.bin", bytes }], pieceLength: PIECE_BYTES });
    const added = ok(await run(rig, "acquisition.add", { magnet: seeded.magnet, pathId, subdir: "下载" })).jobId;
    await waitState(rig, added, ["choosing"], 60_000);
    const started = performance.now();
    ok(await run(rig, "acquisition.select", { jobId: added, indexes: [0] }));
    const job = await until(() => jobOf(rig, added), (value) => value.state === "done" || value.state === "failed", 15 * 60_000, "the 200 MB download to end");
    const durationMs = performance.now() - started;
    if (job.state !== "done") throw new Error(`the download ended ${job.state}: ${JSON.stringify(job.error)}`);
    const file = path.join(dir, "下载", "大包.bin");
    const size = fs.statSync(file).size;
    if (size !== bytes) throw new Error(`the finished file holds ${size} bytes, not ${bytes}`);
    const checked = verifyPieces(file, seeded.torrentFile);
    const sha = crypto.createHash("sha256");
    await new Promise((resolve, reject) => fs.createReadStream(file).on("data", (chunk) => sha.update(chunk)).on("end", resolve).on("error", reject));
    const wanted = seeded.files[0].sha256;
    const left = fs.existsSync(path.join(rig.app.acquisition.stagingOf(added), "data"));
    return {
      bytes: size, pieces: checked.pieces, verifiedPieces: checked.verified, unverifiedPieces: checked.pieces - checked.verified, pieceLength: checked.pieceLength,
      sha256Matches: sha.digest("hex") === wanted, stagingLeft: left, durationMs: Math.round(durationMs), mibPerS: Math.round((bytes / 1024 / 1024 / (durationMs / 1000)) * 10) / 10,
      counts: job.counts, engine: "webtorrent loopback",
    };
  } finally {
    rig.app.close();
    await swarm.close();
  }
}
