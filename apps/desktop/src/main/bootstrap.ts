import { app, dialog, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { startRollbackInstaller } from "./detached-installer.ts";
import {
  commitVerifiedRollback,
  evaluateBootstrapStart,
  questionText,
  RELEASES_PAGE,
  retryLaunch,
  verifiedPrevious,
  type GuardedBootstrapStart,
  type LaunchDecision,
} from "./launch-guard.ts";

/**
 * The packaged main entry (`main.cjs`, A-128, 4.1). Node and Electron only: it decides which main process this start is and loads it.
 *
 * - `--manga-light` loads light open (`light-main.cjs`), which never touches the library, plugins, the Agent or updates.
 * - Everything else (a normal start, `--manga-smoke`, `--quit-for-update`) loads the full application (`full-main.cjs`), as before.
 *
 * Before the full application of a release that came by an update, it keeps count of the starts that never reached the window and, after two of
 * them, asks what to do (4.2) before any other code is loaded.
 */
// The bundles sit next to this one; the path is worked out at run time, so the bundler leaves the require alone.
const load = (file: string): void => { require(path.join(__dirname, file)); };

/** The question, as a system dialog. A test identity may answer it from the environment; the question is then written where the test reads it. */
async function ask(start: GuardedBootstrapStart, decision: Extract<LaunchDecision, { kind: "ask" }>): Promise<void> {
  const previous = verifiedPrevious(start.paths);
  const text = questionText(decision.version, previous);
  let answer: "back" | "retry" | "download";
  const scripted = start.testIdentity ? process.env.MANGA_TEST_LAUNCH_ANSWER : undefined;
  if (scripted === "back" || scripted === "retry" || scripted === "download") {
    answer = scripted;
  } else {
    await app.whenReady();
    const { response } = await dialog.showMessageBox({ type: "warning", title: "MANGA", message: text.message, detail: text.detail, buttons: text.buttons, defaultId: previous ? 1 : 0, cancelId: previous ? 1 : 0, noLink: true });
    const choices: Array<"back" | "retry" | "download"> = previous ? ["back", "retry", "download"] : ["retry", "download"];
    answer = choices[response] ?? "retry";
  }
  if (start.testIdentity) {
    fs.mkdirSync(start.paths.runtime, { recursive: true });
    fs.writeFileSync(path.join(start.paths.runtime, "launch-question.json"), `${JSON.stringify({ ...text, answer, previous: previous?.version ?? null, at: new Date().toISOString() }, null, 2)}\n`);
  }
  if (answer === "back") {
    // Verify the kept installer and confirm the detached rollback helper is ready BEFORE mutating DB or clearing guard state.
    const verified = verifiedPrevious(start.paths);
    if (!verified) {
      await shell.openExternal(RELEASES_PAGE).catch(() => undefined);
    } else {
      const helper = await startRollbackInstaller({
        runtimeDir: start.paths.runtime,
        installer: verified.file,
        sha512Hex: verified.sha512Hex,
      });
      if (!helper.ok) {
        await shell.openExternal(RELEASES_PAGE).catch(() => undefined);
      } else {
        try {
          const committed = commitVerifiedRollback(start.paths, decision.version);
          if (committed.kind !== "rolled-back") {
            helper.cancel();
            await shell.openExternal(RELEASES_PAGE).catch(() => undefined);
          }
        } catch {
          helper.cancel();
          await shell.openExternal(RELEASES_PAGE).catch(() => undefined);
        }
      }
    }
  } else if (answer === "download") {
    await shell.openExternal(RELEASES_PAGE).catch(() => undefined);
  } else {
    retryLaunch(start.paths, decision.version);
    // The full application registers its schemes and takes its lock before the app is ready; a start that has shown a dialog is past that point.
    if (!start.testIdentity || (!scripted && process.env.MANGA_TEST_NO_RELAUNCH !== "1")) app.relaunch();
  }
  app.exit(0);
}

const outcome = evaluateBootstrapStart({
  packaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  argv: process.argv,
  env: process.env,
});
if (outcome.mode === "light") {
  load("light-main.cjs");
} else if (outcome.mode === "ask") {
  void ask(outcome.guarded, outcome.guarded.decision);
} else {
  if (outcome.attemptFile) process.env.MANGA_LAUNCH_ATTEMPT_FILE = outcome.attemptFile;
  // The rehearsal's stand-in for a version that does not start: only a test identity listens to it.
  if (outcome.failOnPurpose) app.exit(3);
  else load("full-main.cjs");
}
