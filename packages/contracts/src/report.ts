export type CaseStatus = "not-run" | "running" | "passed" | "failed" | "blocked";

export type CaseResult = {
  caseId: string;
  poc: string;
  title: string;
  status: CaseStatus;
  expected: unknown;
  actual: unknown;
  evidence?: string;
  durationMs?: number;
  error?: string;
  kind: "automated" | "simulated" | "device" | "filesystem" | "human";
};

export type PocReport = {
  poc: string;
  version: string;
  commit?: string;
  dirtyFingerprint?: string;
  env: Record<string, unknown>;
  cases: CaseResult[];
  status: CaseStatus;
  limitations: string[];
};
