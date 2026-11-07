import test from "node:test";
import assert from "node:assert/strict";
import { compareStages, parseStage, retiredDocumentErrors, stageLabelErrors, stageLabels } from "./check-docs.mjs";

// Counterexamples for the stage-cleanup rules (documentation policy 8): a retired document must not linger, and
// documents and code do not describe things by the stage they came from.
const doc = (path, extra = {}) => ({ path, kind: "plan", status: "active", ...extra });

test("a document past its retireAfter stage that still exists is an error", () => {
  const registry = { currentStage: "m4", documents: [doc("docs/delivery/old-plan.md", { retireAfter: "m3" })] };
  const errors = retiredDocumentErrors(registry, () => true);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /past retireAfter m3/);
});

test("the same document passes in its own stage, and once it is gone", () => {
  const registry = { currentStage: "m3", documents: [doc("docs/delivery/old-plan.md", { retireAfter: "m3" })] };
  assert.deepEqual(retiredDocumentErrors(registry, () => true), []);
  assert.deepEqual(retiredDocumentErrors({ ...registry, currentStage: "m4" }, () => false), []);
});

test("an unknown stage name is rejected instead of silently passing", () => {
  assert.ok(retiredDocumentErrors({ currentStage: "next", documents: [] }, () => true).length > 0);
  assert.ok(retiredDocumentErrors({ currentStage: "m3", documents: [doc("a.md", { retireAfter: "later" })] }, () => true).length > 0);
  assert.ok(retiredDocumentErrors({ documents: [doc("a.md", { retireAfter: "m3" })] }, () => true).length > 0);
});

test("documents without retireAfter are never retired", () => {
  assert.deepEqual(retiredDocumentErrors({ currentStage: "m4", documents: [doc("README.md")] }, () => true), []);
});

test("stages compare by number, so a stage the checker has never heard of still orders correctly", () => {
  assert.ok(compareStages("m10", "m9") > 0);
  assert.ok(compareStages("m2", "m10") < 0);
  assert.ok(compareStages("m1b", "m1a") > 0);
  assert.ok(compareStages("m2", "m1b") > 0);
  assert.equal(compareStages("m4", "m4"), 0);
  assert.deepEqual(parseStage("m12"), [12, ""]);
  assert.equal(parseStage("m"), null);
  assert.equal(parseStage("stage3"), null);
  const registry = { currentStage: "m12", documents: [doc("a.md", { retireAfter: "m11" })] };
  assert.equal(retiredDocumentErrors(registry, () => true).length, 1);
});

test("a label of an earlier stage is an error anywhere in a document", () => {
  const found = stageLabels("The M0 prototype and the m1b reader, in H-M2-01 and docs/evidence/m2/.", "m4");
  assert.deepEqual(found.map((entry) => entry.label), ["M0", "m1b", "M2", "m2"]);
  assert.equal(found[0].line, 1);
});

test("the current stage's name, file formats and similar names are not labels", () => {
  assert.deepEqual(stageLabels("M4 is the current stage; m4 too. Audio is m4a or m4v, playlists m3u8, transport streams m2ts, M4A.", "m4"), []);
});

test("SVG path data is not a label, but the same letters elsewhere on the line still are", () => {
  assert.deepEqual(stageLabels('<path d="M13 5H9a5 5 0 0 0-5 5v4" stroke="x" />', "m4"), []);
  assert.deepEqual(stageLabels('<path d="M13 5H9" /> // from M2', "m4").map((entry) => entry.label), ["M2"]);
});

test("a fixed archive link may carry the label of the path it points at, but the text around it may not", () => {
  const link = "https://github.com/owner/repo/tree/0123abc/docs/evidence/m1b-summary.md";
  assert.deepEqual(stageLabels(`archived in [the old summary](${link})`, "m4"), []);
  assert.deepEqual(stageLabels(`the M1b summary at ${link}`, "m4").map((entry) => entry.label), ["M1b"]);
  assert.deepEqual(stageLabels("see https://example.com/docs/m1b-summary.md", "m4").map((entry) => entry.label), ["m1b"]);
});

test("a registered document with a label fails, unless it is the current stage's own plan or report", () => {
  const registry = { currentStage: "m4", documents: [doc("a.md"), doc("docs/delivery/stage-plan.md", { retireAfter: "m4" })] };
  const markdown = new Map([["a.md", "intro\nsee the M1b report"], ["docs/delivery/stage-plan.md", "cleans up M0, M1a, M1b and M2 files"]]);
  const errors = stageLabelErrors(registry, markdown);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^a\.md:2: stage label M1b/);
});

test("a label in the registry's own descriptions is an error too", () => {
  const registry = { currentStage: "m4", documents: [doc("a.md", { scope: "reading, from M1b" })] };
  assert.equal(stageLabelErrors(registry, new Map([["a.md", "clean"]])).length, 1);
});
