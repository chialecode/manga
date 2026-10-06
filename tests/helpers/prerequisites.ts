/**
 * The repository CI runs on Linux without the media prerequisites a developer machine has: the pinned Windows FFmpeg
 * build, the voice model, and the synthetic samples made with them. It says so with `MANGA_MEDIA_PREREQUISITES=absent`,
 * and only then are the tests that need them skipped; they are reported as skipped, never as passed. Anywhere else a
 * missing sample or tool fails the test, and the stage entry removes the variable, so stage evidence never has these gaps.
 */
export const mediaPrerequisitesAbsent = process.env.MANGA_MEDIA_PREREQUISITES === "absent";
