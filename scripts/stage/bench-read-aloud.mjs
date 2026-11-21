import { startMockDeepSeek } from "../../packages/model-protocol/src/index.ts";
import { phase } from "./bench-reader.mjs";

// The fake DeepSeek accepts only the walk's synthetic key (apps/desktop/src/main/smoke/deepseek-walk.ts).
const SMOKE_DEEPSEEK_KEY = ["sk", "smoke", "deepseek", "walk"].join("-");

/**
 * The read-aloud figures (计划第 7 节): the packaged window reads ten answers and a novel of 24 paragraphs against the fake DeepSeek on the loopback address.
 * Every answer is a different text, so the speech cache never answers; each paragraph is about half a second of the fake service's audio.
 */
export async function runReadAloudBench({ executable, args, answers = 10, paragraphs = 24 }) {
  let count = 0;
  const fake = await startMockDeepSeek({ key: SMOKE_DEEPSEEK_KEY, answer: () => { count += 1; return `这是第 ${count} 个合成的回答，用来测朗读的第一声。`; } });
  try {
    const measured = await phase({
      executable, args, name: "bench-read-aloud", spec: { answers, paragraphs }, file: "bench-read-aloud-window.json",
      specEnv: "MANGA_SMOKE_READ_ALOUD_SPEC", extraEnv: { MANGA_SMOKE_PROVIDER_ORIGIN: fake.url },
    });
    return { ...measured, requests: fake.requests.length };
  } finally {
    await fake.close();
  }
}
