import path from "node:path";
import { MangaProductApp, TestVault } from "@manga/app-core";

// A separate process is deliberately killed inside the real confirmation path; only a synthetic test profile is supplied.
const profileRoot = process.env.MANGA_PROPOSAL_TEST_PROFILE!;
const app = new MangaProductApp({
  profileRoot,
  channel: "test",
  documentsDir: path.join(profileRoot, "documents"),
  pointerPath: path.join(profileRoot, "launcher", "pointer.json"),
  hostId: "proposal-crash-child",
  vault: new TestVault("test-vault"),
  crashAt: process.env.MANGA_PROPOSAL_TEST_CRASH,
});
await app.start();
const actor = { kind: "user" as const, id: "tester" };
const grant = app.issueOwnerGrant(actor);
const dir = process.env.MANGA_PROPOSAL_TEST_EXPORT_DIR;
const result = await app.call(actor, {
  commandId: "proposal.apply",
  idempotencyKey: "crash-child-apply",
  input: {
    proposalId: process.env.MANGA_PROPOSAL_TEST_ID!,
    ...(dir ? { pathHandle: app.registerPath("directory", dir) } : {}),
  },
}, grant.handle);
app.close();
console.log(JSON.stringify({ status: result.status, code: result.error?.code ?? null }));
