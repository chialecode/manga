import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { startedApp, user, expectOk } from "./helpers.ts";
import { isolateDir } from "../env.ts";
import { exportLibraryPackage, importLibraryPackage } from "../domain/library-package.ts";
import { mediaTimeAt, mapCaptureToSources } from "../domain/capture.ts";

test("review closure: context uses the requested resource revision and code point range", async () => {
  const { app } = await startedApp(["library", "notes"]);
  try {
    const imported = await app.call(user(), { commandId: "library.importText", idempotencyKey: "ctx-source", input: { title: "old", bytes: [...Buffer.from("A🌸旧内容")] } });
    expectOk(imported, "import");
    const { resourceId, revisionId } = imported.value as {resourceId: string; revisionId: string};
    app.store.db.prepare("INSERT INTO resource_revisions(id,resource_id,fingerprint,parser_version,payload_json,created_at) VALUES (?,?,?,?,?,?)").run("new-rev", resourceId, "new", "v1", JSON.stringify({normalized:"新版正文"}), "9999");
    const result = await app.call(user(), { commandId:"library.contextSnapshot", idempotencyKey:"ctx-old", input:{resourceId,resourceRevisionId:revisionId,start:1,end:2} });
    expectOk(result, "context");
    assert.equal((result.value as {quote:string}).quote, "🌸");
    for (const [key, input] of Object.entries({foreign:{resourceId:"foreign",resourceRevisionId:revisionId}, part:{resourceId,resourceRevisionId:revisionId,partId:"absent"}, range:{resourceId,resourceRevisionId:revisionId,start:3,end:1}})) {
      assert.equal((await app.call(user(), {commandId:"library.contextSnapshot",idempotencyKey:key,input})).status,"error");
    }
    assert.equal((await app.call(user(), {commandId:"progress.set",idempotencyKey:"wrong-progress",input:{resourceId:"foreign",resourceRevisionId:revisionId,locator:{kind:"temporal",startMs:1}}})).status,"error");
  } finally { app.close(); }
});

test("review closure: editing a split note preserves other blocks and indexed scope", async () => {
  const { app } = await startedApp(["library","notes"]);
  try {
    const note = await app.call(user(),{commandId:"notes.create",idempotencyKey:"split-note",input:{title:"blocks",text:"春天花园",resourceId:"scope-resource"}});
    const id = (note.value as {objectId:string}).objectId;
    const split = await app.call(user(),{commandId:"notes.split",idempotencyKey:"split",input:{objectId:id,expectedRevision:1,blockId:"b1",offset:2}});
    expectOk(split,"split");
    const updated = await app.call(user(),{commandId:"notes.update",idempotencyKey:"block-update",input:{objectId:id,expectedRevision:2,blockId:"b1",text:"夏日"}});
    expectOk(updated,"block update");
    assert.equal(app.workspaceSnapshot().notes[0]?.text,"夏日\n花园");
    assert.equal(app.store.search({text:"夏日",readAllowlist:["scope-resource"]}).length,1);
    assert.equal(app.store.search({text:"春天"}).length,0);
    assert.equal((await app.call(user(),{commandId:"notes.update",idempotencyKey:"ambiguous-update",input:{objectId:id,expectedRevision:3,text:"whole doc"}})).status,"error");
  } finally { app.close(); }
});

test("review closure: package rejects traversal and does not overwrite export directories", async () => {
  const { app } = await startedApp(["library","notes"]);
  try {
    const pack = isolateDir("hostile-package");
    exportLibraryPackage(app.store,pack);
    assert.throws(()=>exportLibraryPackage(app.store,pack),/empty|exist/i);
    const manifestFile=path.join(pack,"manifest.json");
    const manifest=JSON.parse(fs.readFileSync(manifestFile,"utf8"));
    const bytes=Buffer.from("synthetic-private-sentinel");
    const outside=path.join(pack,"outside.txt");
    fs.writeFileSync(outside,bytes);
    manifest.attachments=[{id:"../escaped.txt",relativePath:"outside.txt",bytes:bytes.length,hash:createHash("sha256").update(bytes).digest("hex")}];
    fs.writeFileSync(manifestFile,JSON.stringify(manifest));
    assert.throws(()=>importLibraryPackage(app.store,pack),/attachment|path|package/i);
    assert.equal(fs.existsSync(path.join(app.store.attachmentsDir,"..","escaped.txt")),false);
  } finally { app.close(); }
});

test("review closure: package restores search and unknown attachments; invalid rows roll back files", async () => {
  const { app }=await startedApp(["library","notes"]);
  const { app: dest }=await startedApp(["library","notes"]);
  const { app: failed }=await startedApp(["library","notes"]);
  try {
    await app.call(user(),{commandId:"notes.create",idempotencyKey:"pkg-note",input:{title:"n",text:"恢复检索内容",resourceId:"scope-resource"}});
    const attachment=Buffer.from("unknown synthetic payload");
    fs.writeFileSync(path.join(app.store.attachmentsDir,"unknown.bin"),attachment);
    const pack=isolateDir("review-package");
    exportLibraryPackage(app.store,pack);
    const request={commandId:"library.importPackage",idempotencyKey:"restore-retry",input:{sourceDir:pack}};
    expectOk(await dest.call(user(),request),"restore");
    assert.equal((await dest.call(user(),request)).idempotentReplay,true);
    assert.equal(dest.store.search({text:"恢复检索"}).length,1);
    assert.equal(dest.store.search({text:"恢复检索",readAllowlist:["scope-resource"]}).length,1);
    assert.equal(dest.store.search({text:"恢复检索",readAllowlist:["foreign"]}).length,0);
    assert.deepEqual(fs.readFileSync(path.join(dest.store.attachmentsDir,"unknown.bin")),attachment);
    const file=path.join(pack,"manifest.json");
    const manifest=JSON.parse(fs.readFileSync(file,"utf8"));
    manifest.objects.push(manifest.objects[0]);
    fs.writeFileSync(file,JSON.stringify(manifest));
    assert.throws(()=>importLibraryPackage(failed.store,pack));
    assert.equal(failed.store.counts().content_objects,0);
    assert.equal(fs.readdirSync(failed.store.attachmentsDir).length,0);
    manifest.objects=[{...manifest.objects[0],id:null}];
    fs.writeFileSync(file,JSON.stringify(manifest));
    assert.throws(()=>importLibraryPackage(failed.store,pack));
    assert.equal(failed.store.counts().content_objects,0);
  } finally {app.close();dest.close();failed.close();}
});

test("review closure: late package publish conflict rolls back own files and preserves conflicting file", async (t) => {
  const {app}=await startedApp(["library","notes"]),{app:dest}=await startedApp(["library","notes"]);
  try {
    await app.call(user(),{commandId:"notes.create",idempotencyKey:"publish-note",input:{title:"n",text:"rollback"}});
    for(const name of ["a.bin","b.bin"]) fs.writeFileSync(path.join(app.store.attachmentsDir,name),"synthetic");
    const pack=isolateDir("publish-conflict");
    exportLibraryPackage(app.store,pack);
    const link=fs.linkSync;
    let calls=0;
    t.mock.method(fs,"linkSync",(source:fs.PathLike,target:fs.PathLike)=>{
      if(++calls===2) fs.writeFileSync(target,"concurrent-sentinel",{flag:"wx"});
      return link(source,target);
    });
    assert.throws(()=>importLibraryPackage(dest.store,pack),/exist/i);
    assert.equal(dest.store.counts().content_objects,0);
    assert.deepEqual(fs.readdirSync(dest.store.attachmentsDir),["b.bin"]);
    assert.equal(fs.readFileSync(path.join(dest.store.attachmentsDir,"b.bin"),"utf8"),"concurrent-sentinel");
  } finally {t.mock.restoreAll();app.close();dest.close();}
});

test("review closure: seek starts a new advancing segment and stop ends capture", () => {
  const events=[
    {captureOffsetMs:0,clockDomainId:"samples",resourceId:"video",resourceRevisionId:"v1",locator:{kind:"temporal" as const,startMs:1000},playing:true,playbackRate:1,reason:"start" as const},
    {captureOffsetMs:100,clockDomainId:"samples",resourceId:"video",resourceRevisionId:"v1",locator:{kind:"temporal" as const,startMs:8000},playing:true,playbackRate:2,reason:"seek" as const},
    {captureOffsetMs:400,clockDomainId:"samples",resourceId:"video",resourceRevisionId:"v1",locator:{kind:"temporal" as const,startMs:8600},playing:false,reason:"stop" as const},
  ];
  assert.equal(mediaTimeAt(events,200)?.mediaMs,8200);
  assert.equal(mediaTimeAt(events,500),undefined);
  assert.equal(mapCaptureToSources([{...events[0]!,resourceId:undefined}, {...events[1]!,reason:"resource_change"},events[2]!]).length,1);
});
