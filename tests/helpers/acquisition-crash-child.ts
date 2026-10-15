// A process that starts an application, runs a download up to the moment it is told to die at, and ends there without cleaning up (process.exit is
// the nearest thing to a hard kill that leaves a trace the test can read). The test starts the application again on the same profile and looks at
// what recovery did. Settings arrive in the environment: MANGA_CHILD_PROFILE, _LIBRARY, _CRASH_AT, _COPY.
import { HASH, MAGNET, addLibrary, boot, emit, installFake, ok, run, stage, until } from "./acquisition-rig.ts";

const files = [{ path: "季卷/第1话.txt", text: `第一话\n\n${"这是用于崩溃恢复测试的一段合成文字。".repeat(20)}\n` }, { path: "季卷/第2话.txt", text: `第二话\n\n${"这是用于崩溃恢复测试的另一段合成文字。".repeat(20)}\n` }];
const at = process.env.MANGA_CHILD_CRASH_AT;
const rig = await boot({ profileRoot: process.env.MANGA_CHILD_PROFILE, acquisition: { forceCopy: process.env.MANGA_CHILD_COPY === "1", fault: (point) => { if (point === at) process.exit(137); } } });
await installFake(rig);
const { pathId } = await addLibrary(rig, "novel", process.env.MANGA_CHILD_LIBRARY);
const { jobId } = ok<{ jobId: string }>(await run(rig, "acquisition.add", { magnet: MAGNET(HASH(7)), pathId, subdir: "下载" }));
await emit(rig, "acq.metadata", { jobId, infoHash: HASH(7), name: "季卷", totalLength: 1000, pieceLength: 16384, files: files.map((file, index) => ({ index, path: file.path, length: Buffer.byteLength(file.text) })) });
await until(() => rig.app.store.sqlite.prepare("SELECT state FROM acquisition_jobs WHERE id = ?").get(jobId) as { state: string }, (row) => row.state === "choosing", 20_000, "the file list");
ok(await run(rig, "acquisition.select", { jobId, indexes: [0, 1] }));
for (const file of files) stage(rig, jobId, file.path, file.text);
process.stdout.write(`${jobId}\n`);
await emit(rig, "acq.verified", { jobId, files: files.map((file, index) => ({ index, path: file.path, length: Buffer.byteLength(file.text) })), downloaded: 1000, uploaded: 0 });
// Nothing more to do: either the hook ends the process, or the download finishes and the process is stopped by the test.
await new Promise((resolve) => setTimeout(resolve, 20_000));
process.exit(0);
