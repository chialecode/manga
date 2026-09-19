import { MangaApp } from "./application/app.ts";
const [, , profileDir, json, crashAt] = process.argv;
if (!profileDir || !json || !crashAt) throw new Error("missing crash fixture args");
const app = new MangaApp({profileDir,hostId:"crash-host",crashAt});
await app.start(["library","download"]);
const result = await app.call({kind:"user",id:"fixture"},{commandId:"acquisition.start",idempotencyKey:"crash-download",input:JSON.parse(json)});
console.error(result); app.close(); process.exitCode = 2;
