import assert from "node:assert/strict";
import test from "node:test";
import { planComposition } from "@manga/kernel";
import { MangaError, type ModuleManifest } from "@manga/contracts";
import { startedApp, writeCases } from "./helpers.ts";
import { MinimalActivator } from "../runtimes/minimal-activator.ts";
import { defineModule } from "@manga/plugin-sdk";

const base: ModuleManifest[] = [
  {
    moduleId: "lib",
    version: "1",
    displayName: "lib",
    featureId: "library",
    contributes: [{ capabilityId: "manga.library", version: "1" }],
    needs: [],
    facets: ["service"],
    conflictsWith: [],
    ownerModuleIds: [],
  },
  {
    moduleId: "reader",
    version: "1",
    displayName: "reader",
    featureId: "reader",
    contributes: [{ capabilityId: "manga.reader", version: "1" }],
    needs: [{ capabilityId: "manga.library", version: "1", required: true, cardinality: "single" }],
    facets: ["service"],
    conflictsWith: ["other-reader"],
    ownerModuleIds: [],
  },
  {
    moduleId: "other-reader",
    version: "1",
    displayName: "other",
    featureId: "other-reader",
    contributes: [{ capabilityId: "manga.reader", version: "1" }],
    needs: [],
    facets: ["service"],
    conflictsWith: ["reader"],
    ownerModuleIds: [],
  },
  {
    moduleId: "meta-a",
    version: "1",
    displayName: "a",
    featureId: "meta-a",
    contributes: [{ capabilityId: "manga.metadata.provider", version: "1", cardinality: "many" }],
    needs: [],
    facets: ["service"],
    conflictsWith: [],
    ownerModuleIds: [],
  },
  {
    moduleId: "meta-b",
    version: "1",
    displayName: "b",
    featureId: "meta-b",
    contributes: [{ capabilityId: "manga.metadata.provider", version: "1", cardinality: "many" }],
    needs: [],
    facets: ["service"],
    conflictsWith: [],
    ownerModuleIds: [],
  },
  {
    moduleId: "hub",
    version: "1",
    displayName: "hub",
    featureId: "metadata",
    contributes: [{ capabilityId: "manga.metadata.hub", version: "1" }],
    needs: [{ capabilityId: "manga.metadata.provider", version: "1", required: true, cardinality: "many" }],
    facets: ["service"],
    conflictsWith: [],
    ownerModuleIds: [],
  },
];

test("POC-07 composition runtime comparison", async () => {
  const many = planComposition(base, {
    profileId: "p",
    revision: 1,
    enabledFeatures: ["metadata"],
    disabledFeatures: [],
    preferredProviders: {},
  });
  assert.ok(many.enabledModules.includes("meta-a"));
  assert.ok(many.enabledModules.includes("meta-b"));
  assert.throws(() => planComposition(base, {
    profileId: "p",
    revision: 1,
    enabledFeatures: ["reader", "other-reader"],
    disabledFeatures: [],
    preferredProviders: {},
  }), MangaError);
  const closed = planComposition(base, {
    profileId: "p",
    revision: 1,
    enabledFeatures: ["metadata"],
    disabledFeatures: ["meta-b"],
    preferredProviders: {},
  });
  assert.ok(!closed.enabledModules.includes("meta-b"));
  assert.throws(() => planComposition(base, {
    profileId: "p",
    revision: 1,
    enabledFeatures: ["reader"],
    disabledFeatures: ["library"],
    preferredProviders: {},
  }), MangaError);

  const { app } = await startedApp();
  const before = app.store.counts();
  await app.runtime.deactivate("m0.reader.novel");
  const afterStop = app.runtime.snapshot().modules["m0.reader.novel"];
  assert.equal(afterStop?.state, "disabled");
  await app.runtime.activate("m0.reader.novel");
  const afterStart = app.store.counts();
  assert.equal(afterStart.resources, before.resources);

  const failing = defineModule({
    manifest: {
      moduleId: "failing",
      version: "1",
      displayName: "fail",
      featureId: "failing",
      contributes: [{ capabilityId: "cap.fail", version: "1" }],
      needs: [],
      facets: ["service"],
      conflictsWith: [],
      ownerModuleIds: [],
    },
    activate: () => {
      throw new Error("boom");
    },
    deactivate: () => undefined,
  });
  const { MangaRuntime } = await import("@manga/kernel");
  const rt = new MangaRuntime([failing]);
  await assert.rejects(() => rt.activate("failing"));
  assert.equal(rt.snapshot().modules.failing?.state, "failed");
  assert.equal(rt.resourceTotals().subscription ?? 0, 0);

  const leaky = defineModule({
    manifest: {
      moduleId: "leaky",
      version: "1",
      displayName: "leaky",
      featureId: "leaky",
      contributes: [{ capabilityId: "cap.leak", version: "1" }],
      needs: [],
      facets: ["service"],
      conflictsWith: [],
      ownerModuleIds: [],
    },
    activate: (ctx) => {
      ctx.register({ kind: "timer", id: "t1", dispose: () => undefined });
    },
    deactivate: () => undefined,
  });
  const naive = new MinimalActivator([leaky]);
  await naive.apply({
    profileId: "p",
    revision: 1,
    enabledFeatures: ["leaky"],
    disabledFeatures: [],
    preferredProviders: {},
  });
  await naive.apply({
    profileId: "p",
    revision: 1,
    enabledFeatures: [],
    disabledFeatures: ["leaky"],
    preferredProviders: {},
  });
  assert.equal(naive.stillWritableAfterStop(), true);

  app.close();
  writeCases("poc-07", [
    {
      caseId: "POC-07/many-providers",
      poc: "POC-07",
      title: "many cardinality binds both fake providers",
      status: "passed",
      expected: ["meta-a", "meta-b"],
      actual: many.enabledModules.filter((id) => id.startsWith("meta")),
      kind: "automated",
    },
    {
      caseId: "POC-07/explicit-disable",
      poc: "POC-07",
      title: "explicit disable is not silently re-enabled",
      status: "passed",
      expected: false,
      actual: closed.enabledModules.includes("meta-b"),
      kind: "automated",
    },
    {
      caseId: "POC-07/reader-stop-keeps-data",
      poc: "POC-07",
      title: "reader stop keeps library data",
      status: "passed",
      expected: before.resources,
      actual: afterStart.resources,
      kind: "automated",
    },
    {
      caseId: "POC-07/activation-failure-cleanup",
      poc: "POC-07",
      title: "activation failure does not leave active capability",
      status: "passed",
      expected: "failed",
      actual: rt.snapshot().modules.failing?.state,
      kind: "automated",
    },
    {
      caseId: "POC-07/minimal-activator-leak",
      poc: "POC-07",
      title: "naive activator fails resource cleanup invariant",
      status: "passed",
      expected: true,
      actual: naive.stillWritableAfterStop(),
      kind: "automated",
    },
  ]);
});
