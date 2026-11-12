import fs from "node:fs";
import { app, type BrowserWindow } from "electron";
import type { MangaProductApp } from "@manga/app-core";
import type { AsrModelFiles, AsrService } from "../asr-service.ts";
import { PICK, clickTestId, openFromShelf, setField, sleep, waitForTestId, waitFrames, waitUntil } from "./driver.ts";
import { caller, ensureDock, js, toRail } from "./common.ts";

export type DictationBenchSpec = {
  runs: number;
  audioSeconds: number;
  modelDir: string;
  extraModels?: Array<{ modelId: string; dir: string }>;
};

function readProcessMemoryMiB(pid: number | undefined): { workingSetMiB: number | null; peakWorkingSetMiB: number | null } {
  if (!pid) return { workingSetMiB: null, peakWorkingSetMiB: null };
  const metric = app.getAppMetrics().find((item) => item.pid === pid);
  if (!metric?.memory) return { workingSetMiB: null, peakWorkingSetMiB: null };
  return {
    workingSetMiB: Math.round((metric.memory.workingSetSize / 1024) * 100) / 100,
    peakWorkingSetMiB: Math.round(((metric.memory.peakWorkingSetSize ?? metric.memory.workingSetSize) / 1024) * 100) / 100,
  };
}

export async function measureDictationBench(
  appService: MangaProductApp,
  grant: string,
  view: BrowserWindow,
  asrService: AsrService | undefined,
  spec: DictationBenchSpec,
): Promise<Record<string, unknown> & { ok: boolean }> {
  const call = caller(appService, grant);
  const failures: string[] = [];
  const raw: number[] = [];
  const modelRecords: Record<string, unknown> = {};

  view.showInactive();

  if (!asrService) {
    return { ok: false, failures: ["asrService unavailable"], raw };
  }
  if (!spec.modelDir || !fs.existsSync(spec.modelDir)) {
    return { ok: false, failures: ["sense-voice-funasr-nano-int8 directory missing"], raw };
  }
  const clip = process.env.MANGA_SMOKE_AUDIO;
  if (!clip || !fs.existsSync(clip)) {
    return { ok: false, failures: ["MANGA_SMOKE_AUDIO synthetic speech clip missing"], raw };
  }

  await call("settings.skipAi", {});

  // Measure cold load & working-set memory for any extra installed local models first, then finish with `sense-voice-funasr-nano-int8` warm.
  const modelsToMeasure: Array<{ modelId: string; dir: string }> = [
    ...(spec.extraModels ?? []).filter((m) => m.modelId !== "sense-voice-funasr-nano-int8" && fs.existsSync(m.dir)),
    { modelId: "sense-voice-funasr-nano-int8", dir: spec.modelDir },
  ];

  for (const item of modelsToMeasure) {
    const handle = appService.registerPath("directory", item.dir);
    const imported = await call("asrModel.import", {
      modelId: item.modelId,
      pathHandle: handle,
      kind: "directory",
    });
    if (imported.status !== "ok") {
      failures.push(`failed to import ${item.modelId}: ${imported.error?.message ?? "unknown"}`);
      continue;
    }
    await asrService.unload();
    const runtime = appService.asrModels.getRuntimeFiles(item.modelId);
    const t0 = performance.now();
    const loaded = await asrService.load(item.modelId, runtime.model.kind, runtime.files as AsrModelFiles, { force: true });
    const wallColdLoadMs = Math.round((performance.now() - t0) * 100) / 100;
    await sleep(150); // real time: 模型加载完成后等待操作系统工作集统计刷新
    const mem = readProcessMemoryMiB(asrService.pid);
    modelRecords[item.modelId] = {
      source: "live-electron-asr-host",
      kind: runtime.model.kind,
      coldLoadMs: Math.round(loaded.elapsedMs * 100) / 100,
      spawnPlusLoadMs: wallColdLoadMs,
      rssMiB: Math.round((loaded.rssBytes / (1024 * 1024)) * 100) / 100,
      workingSetMiB: mem.workingSetMiB,
      peakWorkingSetMiB: mem.peakWorkingSetMiB,
    };
  }

  await call("settings.setRecording", {
    dictationEngine: { kind: "local", modelId: "sense-voice-funasr-nano-int8" },
    polishMode: "raw",
    dictationInsertMode: "stream_replace",
    retainDictationAudio24h: false,
  });

  const bookRes = await call("library.importDocument", {
    title: "听写基准样本文稿",
    format: "txt",
    bytes: [...Buffer.from("第一章 听写基准测试正文。".repeat(20))],
  });
  const resourceId = String((bookRes.value as { resourceId?: string } | undefined)?.resourceId ?? "");

  await view.webContents.reload();
  await toRail(view);
  if (resourceId) {
    await openFromShelf(view, "novel", resourceId, 10_000);
    await waitForTestId(view, "reading-body");
  }
  const dockReady = await ensureDock(view);
  if (!dockReady) {
    return { ok: false, failures: ["agent composer dock did not open"], raw, modelRecords };
  }
  await clickTestId(view, "chat-mode-ask", 3000);

  const holdMs = Math.max(2500, Math.round(spec.audioSeconds * 1000));
  const runs = Math.max(1, spec.runs);

  for (let i = 0; i < runs; i += 1) {
    await setField(view, "agent-composer", "");
    await waitFrames(view, 2);
    await js(view, `${PICK}("agent-composer")?.focus()`);

    view.webContents.focus();
    view.webContents.sendInputEvent({ type: "keyDown", keyCode: "AltGr" });
    const recording = await waitUntil(view, `Boolean(document.querySelector('[data-testid="dictation-capsule"]'))`, 5000);
    if (!recording) {
      view.webContents.sendInputEvent({ type: "keyUp", keyCode: "AltGr" });
      failures.push(`run ${i + 1}: dictation capsule did not enter recording state`);
      break;
    }

    await sleep(holdMs); // real time: 按住录制约 4 秒合成语音用于松开到上屏延迟基准测试

    // Arm an in-page timer from the exact `keyup` event to the frame after recognized Chinese text lands in the composer.
    const measurePromise = js<{ ok: boolean; ms: number; chars: number }>(view, `new Promise((resolve) => {
      let releasedAt = performance.now();
      window.addEventListener("keyup", () => { releasedAt = performance.now(); }, { capture: true, once: true });
      const deadline = Date.now() + 15000;
      const poll = () => {
        const val = (${PICK}("agent-composer")?.value ?? "").trim();
        const done = /[\u4e00-\u9fff]{2,}/.test(val) && !document.querySelector('[data-testid="dictation-capsule"]');
        if (done) {
          requestAnimationFrame(() => {
            resolve({ ok: true, ms: Math.round((performance.now() - releasedAt) * 100) / 100, chars: val.length });
          });
          return;
        }
        if (Date.now() > deadline) {
          resolve({ ok: false, ms: -1, chars: val.length });
          return;
        }
        setTimeout(poll, 8);
      };
      poll();
    })`);

    view.webContents.sendInputEvent({ type: "keyUp", keyCode: "AltGr" });
    const sample = await measurePromise;
    if (!sample.ok || sample.ms < 0) {
      failures.push(`run ${i + 1}: release-to-text timed out (chars=${sample.chars})`);
      break;
    }
    raw.push(sample.ms);
    await sleep(150); // real time: 相邻两轮听写基准采样之间的短暂复位间隔
  }

  const warmMem = readProcessMemoryMiB(asrService.pid);
  return {
    ok: failures.length === 0 && raw.length >= runs,
    failures,
    audioSeconds: spec.audioSeconds,
    runs,
    raw,
    warmWorkingSetMiB: warmMem.workingSetMiB,
    modelRecords,
  };
}
