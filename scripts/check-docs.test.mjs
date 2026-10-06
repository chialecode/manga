import test from "node:test";
import assert from "node:assert/strict";
import { retiredDocumentErrors } from "./check-docs.mjs";

// Counterexamples for the stage-cleanup rule (documentation policy 8): a retired document must not linger.
const doc = (path, extra = {}) => ({ path, kind: "plan", status: "active", ...extra });

test("a document past its retireAfter stage that still exists is an error", () => {
  const registry = { currentStage: "m3", documents: [doc("docs/delivery/m2-media-mvp-plan.md", { retireAfter: "m2" })] };
  const errors = retiredDocumentErrors(registry, () => true);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /past retireAfter m2/);
});

test("the same document passes in its own stage, and once it is gone", () => {
  const registry = { currentStage: "m2", documents: [doc("docs/delivery/m2-media-mvp-plan.md", { retireAfter: "m2" })] };
  assert.deepEqual(retiredDocumentErrors(registry, () => true), []);
  assert.deepEqual(retiredDocumentErrors({ ...registry, currentStage: "m3" }, () => false), []);
});

test("an unknown stage name is rejected instead of silently passing", () => {
  assert.ok(retiredDocumentErrors({ currentStage: "m9", documents: [] }, () => true).length > 0);
  assert.ok(retiredDocumentErrors({ currentStage: "m2", documents: [doc("a.md", { retireAfter: "later" })] }, () => true).length > 0);
  assert.ok(retiredDocumentErrors({ documents: [doc("a.md", { retireAfter: "m2" })] }, () => true).length > 0);
});

test("documents without retireAfter are never retired", () => {
  assert.deepEqual(retiredDocumentErrors({ currentStage: "m4", documents: [doc("README.md")] }, () => true), []);
});
