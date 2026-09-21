import assert from "node:assert/strict";
import test from "node:test";
import { UntrustedCommandSchema } from "@manga/contracts";

test("untrusted command payload cannot carry actor", () => {
  const parsed = UntrustedCommandSchema.parse({
    commandId: "notes.create",
    idempotencyKey: "k",
    input: { title: "x" },
    actor: { kind: "workflow", id: "escalated" },
  });
  assert.equal("actor" in parsed, false);
});
