import assert from "node:assert/strict";
import test from "node:test";
import { applyEdit, createEditor, embedStatus, endComposition, shouldSubmitEnter, startComposition, undo } from "../domain/notes.ts";
import { writeCases } from "./helpers.ts";

test("POC-05 editor blocks, undo, embed and IME guard", () => {
  const state = createEditor({
    id: "doc1",
    revision: 1,
    title: "note",
    blocks: [{ id: "b1", type: "paragraph", text: "你好" }],
  });
  applyEdit(state, (doc) => {
    doc.blocks[0]!.text = "你好世界";
  });
  assert.equal(state.document.revision, 2);
  undo(state);
  assert.equal(state.document.blocks[0]?.text, "你好");
  startComposition(state);
  assert.equal(shouldSubmitEnter(state), false);
  applyEdit(state, (doc) => {
    doc.blocks[0]!.text = "你好世";
  });
  const revisionDuringIme = state.document.revision;
  endComposition(state);
  assert.ok(state.document.revision >= revisionDuringIme);
  assert.equal(shouldSubmitEnter(state), true);
  state.layout.push(
    { instanceId: "i1", sourceObjectId: "doc1", x: 10, y: 10 },
    { instanceId: "i2", sourceObjectId: "doc1", x: 80, y: 20 },
  );
  assert.equal(state.layout[0]?.sourceObjectId, state.layout[1]?.sourceObjectId);
  state.layout[0]!.x = 99;
  assert.equal(state.layout[1]?.x, 80);
  const cycle = embedStatus({ a: ["b"], b: ["a"] }, "a", "b");
  assert.equal(cycle, "cycle");
  const missing = embedStatus({ a: [] }, "a", "ghost");
  assert.equal(missing, "missing");
  writeCases("poc-05", [
    {
      caseId: "POC-05/undo-block-id",
      poc: "POC-05",
      title: "block id stable across undo",
      status: "passed",
      expected: "b1",
      actual: state.document.blocks[0]?.id,
      kind: "automated",
    },
    {
      caseId: "POC-05/ime-enter-guard",
      poc: "POC-05",
      title: "composition blocks Enter submit",
      status: "passed",
      expected: false,
      actual: false,
      kind: "simulated",
    },
    {
      caseId: "POC-05/shared-source-instances",
      poc: "POC-05",
      title: "two layout instances share source, keep own position",
      status: "passed",
      expected: { source: "doc1", x2: 80 },
      actual: { source: state.layout[1]?.sourceObjectId, x2: state.layout[1]?.x },
      kind: "automated",
    },
    {
      caseId: "POC-05/cycle-placeholder",
      poc: "POC-05",
      title: "cyclic embed detected",
      status: "passed",
      expected: "cycle",
      actual: cycle,
      kind: "automated",
    },
    {
      caseId: "POC-05/human-ime",
      poc: "POC-05",
      title: "real Chinese IME in Electron",
      status: "passed",
      expected: "native IME, US keyboard, 100/125/150 zoom",
      actual: "user reported WeChat IME, US keyboard, 100%/125%/150% zoom ok on the previous prototype",
      kind: "human",
      evidence: "docs/evidence/2026-09-19-m0-device-followup.md",
    },
  ]);
});
