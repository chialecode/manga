import { expect } from "vitest";
import { ok as okValue, type Rig } from "./acquisition-rig.ts";

export * from "./acquisition-rig.ts";

type Call = Awaited<ReturnType<Rig["app"]["call"]>>;
/** A command that must have succeeded: the test fails with what the host said otherwise. */
export const ok = <T = Record<string, any>>(result: Call): T => { expect(result.status, JSON.stringify(result)).toBe("ok"); return okValue<T>(result); };
export const fails = (result: Call) => { expect(result.status, JSON.stringify(result)).toBe("error"); return (result as unknown as { error: { code: string; message: string; details?: { reason?: string } } }).error; };
