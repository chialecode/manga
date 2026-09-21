import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { MangaRuntime, ResourceScope, planComposition } from "@manga/kernel";
import type { MangaModule, ModuleContext } from "@manga/plugin-sdk";
import { MangaError } from "@manga/contracts";
import { SqliteStore } from "@manga/storage-sqlite";
import { MangaApp } from "../application/app.ts";
import { isolateDir } from "../env.ts";
import { downloadToStaging, fingerprintFile, publishAtomic, safeFileName, startLoopbackServer, volumeOf } from "../domain/acquisition.ts";
import { startIpcClient } from "../hosts/ipc-client.ts";
import { expectOk, startedApp, user, writeCases } from "./helpers.ts";

test("review: note updates survive restart, preserve index scope and reject malformed input", async () => {
  const {app, profileDir} = await startedApp(["library", "notes"]);
  const call = (commandId:string, input:unknown, idempotencyKey: string = crypto.randomUUID()) => app.call(user(), {commandId,input,idempotencyKey});
  const created = await call("notes.create", {title:"review",text:"初始正文",resourceId:"allowed"});
  expectOk(created,"create");
  const {objectId} = created.value as {objectId:string};
  const updated = await call("notes.update", {objectId,expectedRevision:1,text:"更新正文"});
  expectOk(updated,"update");
  assert.equal(app.store.search({text:"初始正文"}).length,0);
  assert.equal(app.store.search({text:"更新正文",readAllowlist:["allowed"]}).length,1);
  assert.equal(app.store.search({text:"更新正文",readAllowlist:[]}).length,0);
  assert.equal((await call("notes.create",{title:"bad",text:7})).error?.code,"VALIDATION_ERROR");
  assert.equal((await call("notes.update",{objectId,expectedRevision:1,text:"lost"})).error?.code,"REVISION_CONFLICT");
  expectOk(await call("notes.create",{title:"stable",text:"original"},"reuse-key"),"idempotency setup");
  assert.equal((await call("notes.create",{title:"stable",text:"changed"},"reuse-key")).error?.code,"VALIDATION_ERROR");
  assert.throws(() => new MangaApp({profileDir,hostId:"test-host"}), (error:unknown) => error instanceof MangaError && error.code === "HOST_CONFLICT");
  app.close();
  const restored = new MangaApp({profileDir,hostId:"restart"});
  try { await restored.start(); assert.equal(restored.workspaceSnapshot().notes.find(note=>note.id === objectId)?.text,"更新正文"); assert.equal(restored.store.counts().content_objects,2); assert.equal(restored.runtime.snapshot().modules["m0.acquisition"]?.state,"discovered"); }
  finally { restored.close(); }
});

test("review: search filters before LIMIT and never leaks unscoped fragments", () => {
  const store = new SqliteStore({profileDir:isolateDir("search-review"),hostId:"review"});
  try {
    const mutations = Array.from({length:120}, (_,i) => store.indexFragment({id:`f${i}`,resourceId:i === 119 ? "allowed" : i === 0 ? undefined : "denied",kind:"body",text:"权限测试"})).flat();
    store.commit({mutations,events:[]});
    assert.deepEqual(store.search({text:"权限",readAllowlist:["allowed"],limit:1}).map(hit=>hit.resourceId),["allowed"]);
  } finally {store.close();}
});

test("review: real migration failure rolls back; backup keeps unknown payload and actual attachment", () => {
  const profileDir = isolateDir("backup-review");
  const store = new SqliteStore({profileDir,hostId:"review"});
  try {
    assert.throws(() => store.migrate(2,["ALTER TABLE resources ADD COLUMN review_extra TEXT","INVALID SQL"]));
    assert.equal(store.db.prepare("SELECT value FROM schema_meta WHERE key='schemaVersion'").get()?.value,"1");
    assert.ok(!(store.db.prepare("PRAGMA table_info(resources)").all() as Array<{name:string}>).some(row=>row.name === "review_extra"));
    fs.writeFileSync(path.join(store.attachmentsDir,"att-review.bin"),Buffer.from([0,255,127,1]));
    store.db.prepare("INSERT INTO content_objects(id,type,owner_module_id,scope_json,schema_version,revision,title,payload_json,attachment_ids_json,preview_json,created_at,updated_at) VALUES ('future','unknown.type','absent','{}',9,1,'unknown','{\"future\":[1,2,3]}','[\"att-review.bin\"]','{}','now','now')").run();
    const backup = isolateDir("backup-package-review"); store.backupTo(backup);
    const restore = isolateDir("backup-restore-review"); store.restoreFrom(backup,restore);
    assert.equal(fingerprintFile(path.join(restore,"attachments/att-review.bin")),fingerprintFile(path.join(store.attachmentsDir,"att-review.bin")));
    const other = new SqliteStore({profileDir:restore,hostId:"verify"});
    assert.equal(other.db.prepare("SELECT payload_json FROM content_objects WHERE id='future'").get()?.payload_json,'{"future":[1,2,3]}'); other.close();
    assert.throws(() => store.restoreFrom(backup,profileDir));
    store.migrate(2,[]);store.close();
    assert.throws(()=>new MangaApp({profileDir,hostId:"old-version"}),/newer than/);
    assert.equal(fs.existsSync(path.join(profileDir,"WRITE_LOCK.json")),false,"failed open releases its host lock");
  } finally {store.close();}
});

test("review: cleanup attempts every handle and preserves failed-handle diagnostics", async () => {
  const scope = new ResourceScope(); const disposed:string[]=[];
  scope.register({kind:"subscription",id:"good",dispose:()=>{disposed.push("good");}});
  scope.register({kind:"subscription",id:"bad",dispose:()=>{disposed.push("bad");throw new Error("cleanup failed");}});
  await assert.rejects(scope.stop(),AggregateError);
  assert.deepEqual(disposed,["bad","good"]); assert.equal(scope.size,1);
});

function module(id:string, need?:string): MangaModule {
  return {manifest:{moduleId:id,version:"1",displayName:id,featureId:id,contributes:[{capabilityId:`cap.${id}`,version:"1"}],needs:need?[{capabilityId:`cap.${need}`,version:"1",required:true,cardinality:"single"}]:[],facets:["service"]},activate:()=>undefined,deactivate:()=>undefined};
}
test("review: topology, stale activation contexts, binding changes and activation rollback", async () => {
  const a=module("a","b"),b=module("b","c"),c=module("c");
  let context:ModuleContext|undefined;
  b.activate=ctx=>{context=ctx;};
  const runtime=new MangaRuntime([a,b,c]);
  const profile={profileId:"p",revision:1,enabledFeatures:["a"],disabledFeatures:[],preferredProviders:{}};
  assert.deepEqual(planComposition(runtime.getManifests(),profile).activationOrder,["c","b","a"]);
  await runtime.applyProfile(profile); assert.equal(context?.isCurrent(),true);
  const old = context!; await runtime.deactivate("b"); await runtime.activate("b");
  assert.equal(old.isCurrent(),false); assert.throws(()=>old.register({kind:"subscription",id:"stale",dispose:()=>undefined}));
  const consumer=module("consumer","provider"),one=module("one"),two=module("two");
  one.manifest.contributes=[{capabilityId:"cap.provider",version:"1"}]; two.manifest.contributes=[{capabilityId:"cap.provider",version:"1"}];
  let calls=0; consumer.activate=()=>{calls++;};
  const switching=new MangaRuntime([consumer,one,two]);
  const first={...profile,enabledFeatures:["consumer"],preferredProviders:{"cap.provider":["one"]}};
  await switching.applyProfile(first);
  await switching.applyProfile({...first,revision:2,preferredProviders:{"cap.provider":["two"]}});
  assert.equal(calls,2); assert.equal(switching.snapshot().modules.one?.state,"disabled");
  one.activate=()=>{throw new Error("broken provider");};
  await assert.rejects(switching.applyProfile(first));
  assert.equal(switching.snapshot().modules.two?.state,"active"); assert.equal(switching.snapshot().modules.consumer?.state,"active");
});

test("review: IPC survives invalid input, cancels live download and rejects pending calls after exit", async () => {
  const root=isolateDir("http-review"); fs.writeFileSync(path.join(root,"sample.bin"),"SAMPLE");
  const server=await startLoopbackServer(root); const client=startIpcClient(isolateDir("ipc-review"));
  try {
    await client.snapshot();
    client.child.stdin.write("{bad-json\n");
    const targetDir=isolateDir("cancel-review");
    const downloading=client.send({commandId:"acquisition.start",idempotencyKey:"cancel-review",input:{url:`${server.url}/files/slow.bin`,fileName:"cancel.bin",targetDir}});
    await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal((await client.cancel("ipc-1") as {cancelled:boolean}).cancelled,true);
    assert.equal((await downloading as {error?:{code:string}}).error?.code,"CANCELLED");
    assert.equal(fs.existsSync(path.join(targetDir,"cancel.bin")),false);
    const malformed=await client.send({commandId:"notes.create",idempotencyKey:"bad",input:{text:8}}) as {status:string};
    assert.equal(malformed.status,"error");
    const pending=client.send({commandId:"acquisition.start",idempotencyKey:"killed",input:{url:`${server.url}/files/slow.bin`,fileName:"killed.bin",targetDir}});
    const rejected=assert.rejects(pending,/stopped|unavailable|pipe/i); client.child.kill(); await rejected;
  } finally {client.child.kill();await server.close();}
});

test("review: download rejects path escape, quota, short body, ETag drift and cancellation", async () => {
  const root=isolateDir("http-validation"); fs.writeFileSync(path.join(root,"sample.bin"),"SAMPLE");
  const server=await startLoopbackServer(root);
  const plan={id:"review",version:1,url:`${server.url}/files/ok.bin`,fileName:"test.bin",targetDir:root,quotaBytes:20};
  try {
    for(const name of ["../a","..\\a","CON.txt","a/../b","a:","a."]) assert.throws(()=>safeFileName(name));
    await assert.rejects(downloadToStaging({...plan,quotaBytes:2},path.join(root,"quota")),/quota/i);
    await assert.rejects(downloadToStaging({...plan,url:`${server.url}/files/wrong-length.bin`},path.join(root,"short")),/incomplete|aborted|timeout/i);
    await assert.rejects(downloadToStaging(plan,path.join(root,"etag"),{previousEtag:'"old"'}),/version changed/);
    const controller=new AbortController(); controller.abort();
    await assert.rejects(downloadToStaging(plan,path.join(root,"abort"),{signal:controller.signal}),/cancel/);
  } finally {await server.close();}
});

test("review: publish/import recovers from actual child exits without duplicate resources", async () => {
  const root=isolateDir("http-crash-review"); fs.writeFileSync(path.join(root,"sample.bin"),"crash recovery bytes");
  const server=await startLoopbackServer(root);
  try {
    for(const stage of ["after-verify-before-publish","after-publish-before-record","before-import","after-import-commit"]) {
      const profileDir=isolateDir("acquire-crash"),targetDir=isolateDir("acquire-target");
      const input={url:`${server.url}/files/sample.bin`,fileName:"recovered.bin",targetDir};
      const child=spawn(process.execPath,["--experimental-strip-types",path.resolve("experiments/m0/src/acquisition-crash-child.ts"),profileDir,JSON.stringify(input),stage],{env:{...process.env,M0_CRASH_AT:stage},stdio:["ignore","ignore","pipe"],windowsHide:true});
      let errors="";child.stderr.on("data",value=>errors+=value);
      const [code]=await once(child,"exit"); assert.equal(code,99,errors);
      const app=new MangaApp({profileDir,hostId:"recovery"});
      try {
        await app.start(["library","download"]);
        const payload={commandId:"acquisition.start",idempotencyKey:"crash-download",input};
        expectOk(await app.call(user(),payload),stage); expectOk(await app.call(user(),payload),"repeat");
        assert.equal(app.store.counts().resources,1);
        assert.equal(app.store.db.prepare("SELECT COUNT(*) AS n FROM import_receipts").get()?.n,1);
        assert.equal(app.store.db.prepare("SELECT status FROM jobs").get()?.status,"succeeded");
        assert.equal(fingerprintFile(path.join(targetDir,"recovered.bin")),fingerprintFile(path.join(root,"sample.bin")));
      } finally {app.close();}
    }
  } finally {await server.close();}
});
