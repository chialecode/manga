import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLaunchLayout } from "@manga/app-core";
import { testTempRoot, USER_PLACES } from "../helpers/global-temp.ts";

const inside = (child: string, parent: string) => {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};

describe("Test runs keep away from the person's own application places (LOOP-25)", () => {
  it("moves LOCALAPPDATA, APPDATA, Documents and Downloads under the run's temporary root", () => {
    for (const key of Object.keys(USER_PLACES)) expect(inside(process.env[key]!, testTempRoot()), key).toBe(true);
  });

  it("writes the launcher pointer of a release or development profile opened with only a profile root under the run, not the installed application's", () => {
    for (const channel of ["release", "development"] as const) {
      const layout = resolveLaunchLayout({ channel, profileRoot: path.join(testTempRoot(), `places-${channel}`) });
      expect(inside(layout.pointerPath, testTempRoot()), channel).toBe(true);
    }
  });
});
