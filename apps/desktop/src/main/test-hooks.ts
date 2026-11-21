/** Seams a test harness may set; production code only reads them. */
export const testHooks: { pick?: (request: { mode: "file" | "directory" }) => string | null | undefined } = {};
