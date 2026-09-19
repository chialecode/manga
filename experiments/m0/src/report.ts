import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { CaseResult, CaseStatus, PocReport } from "@manga/contracts";

export function sourceFingerprint(root: string): string {
  const hash = createHash("sha256");
  const visit = (relative: string) => {
    const file=path.join(root,relative), stat=fs.statSync(file);
    if(stat.isDirectory()) {
      for(const name of fs.readdirSync(file).sort()) if(!["node_modules","dist",".cache"].includes(name)) visit(path.join(relative,name));
    } else {
      hash.update(relative.replaceAll("\\","/")); hash.update(fs.readFileSync(file));
    }
  };
  for(const entry of ["packages","experiments","scripts","package.json","pnpm-lock.yaml","pnpm-workspace.yaml","tsconfig.json"]) visit(entry);
  return hash.digest("hex");
}

export function fingerprintBuffer(buffer: Uint8Array | string): string {
  return createHash("sha256").update(typeof buffer === "string" ? buffer : Buffer.from(buffer)).digest("hex");
}

export class ResultSink {
  readonly cases: CaseResult[] = [];

  record(result: CaseResult): CaseResult {
    this.cases.push(result);
    const mark = result.status === "passed" ? "PASS" : result.status === "failed" ? "FAIL" : result.status.toUpperCase();
    console.log(`[${mark}] ${result.caseId} ${result.title}`);
    if (result.error) console.log(`         ${result.error}`);
    return result;
  }

  async run(input: Omit<CaseResult, "status" | "actual" | "durationMs"> & {
    actual?: unknown;
    fn: () => Promise<unknown> | unknown;
  }): Promise<CaseResult> {
    const started = Date.now();
    try {
      const actual = await input.fn();
      const passed = JSON.stringify(actual) === JSON.stringify(input.expected) || input.expected === undefined || actual === true;
      return this.record({
        ...input,
        actual: input.actual ?? actual,
        status: passed ? "passed" : "failed",
        durationMs: Date.now() - started,
        error: passed ? undefined : "expected/actual mismatch",
      });
    } catch (error) {
      return this.record({
        ...input,
        actual: String(error),
        status: "failed",
        durationMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  summarize(poc: string, version: string, env: Record<string, unknown>, limitations: string[] = []): PocReport {
    const statuses = this.cases.map((item) => item.status);
    let status: CaseStatus = "passed";
    if (statuses.some((item) => item === "failed")) status = "failed";
    else if (statuses.some((item) => item === "blocked")) status = "blocked";
    else if (statuses.length === 0 || statuses.every((item) => item === "not-run")) status = "not-run";
    else if (statuses.some((item) => item === "not-run") || statuses.some((item) => item === "blocked")) status = "blocked";
    return { poc, version, env, cases: this.cases, status, limitations };
  }
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeReport(file: string, report: PocReport): void {
  writeJson(file.replace(/\.md$/, ".json"), report);
}
