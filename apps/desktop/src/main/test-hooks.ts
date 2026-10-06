/** Seams a test harness may set; production code only reads them. */
export const testHooks: { chooseBook?: () => string | undefined; pick?: (request: { mode: "file" | "directory" }) => string | undefined } = {};
