import { MangaError } from "@manga/contracts";
import type { EmbeddingPort } from "../../packages/app-core/src/semantic/ports.ts";

export type Conn = { id: string; model: string; dim: number };

/** Hashes the character pairs of a text into a fixed number of buckets: texts that share words end up close, which is all these tests need of a model. */
export function embedText(text: string, dim: number): number[] {
  const vector = new Array<number>(dim).fill(0);
  const chars = Array.from(text.toLowerCase().replace(/\s+/g, ""));
  for (let i = 0; i < chars.length; i += 1) {
    const one = chars[i]!.codePointAt(0)!;
    vector[(one * 31) % dim]! += 0.4;
    if (i + 1 < chars.length) vector[(one * 131 + chars[i + 1]!.codePointAt(0)! * 17) % dim]! += 1;
  }
  return vector;
}

/** A model that is under the test's control: what it was asked, whether it waits, whether it fails, and what its connections are. */
export function controlled() {
  const state = {
    connections: [{ id: "emb-a", model: "model-a", dim: 48 }, { id: "emb-b", model: "model-b", dim: 32 }] as Conn[],
    calls: [] as Array<{ connectionId: string; model: string; inputs: string[] }>,
    gate: new Map<string, Promise<void>>(),
    /** Calls to let through before a gate applies to a connection. */
    passFirst: new Map<string, number>(),
    failWith: null as null | ((n: number, connectionId: string) => Error | null),
    wrong: null as null | "count" | "nan",
    failures: 0,
  };
  const port: EmbeddingPort = {
    resolve: (id) => { const found = id ? state.connections.find((item) => item.id === id) : state.connections[0]; return found ? { id: found.id, model: found.model, label: found.id } : null; },
    list: () => state.connections.map((item) => ({ id: item.id, model: item.model, label: item.id })),
    embed: async (connection, request) => {
      state.calls.push({ connectionId: connection.id, model: connection.model, inputs: request.inputs });
      const gate = state.gate.get(connection.id);
      const skip = state.passFirst.get(connection.id) ?? 0;
      if (gate && state.calls.filter((call) => call.connectionId === connection.id).length > skip) {
        await new Promise<void>((resolve, reject) => {
          void gate.then(resolve);
          if (request.signal.aborted) reject(new MangaError("CANCELLED", "cancelled"));
          request.signal.addEventListener("abort", () => reject(new MangaError("CANCELLED", "cancelled")));
        });
      }
      const failure = state.failWith?.(state.failures, connection.id);
      if (failure) { state.failures += 1; throw failure; }
      const dim = state.connections.find((item) => item.id === connection.id)!.dim;
      let vectors = request.inputs.map((input) => embedText(input, dim));
      if (state.wrong === "count") vectors = vectors.slice(1);
      if (state.wrong === "nan") vectors = vectors.map((vector) => vector.map(() => Number.NaN));
      return vectors;
    },
  };
  const hold = (connectionId: string, passFirst = 0) => {
    let release = () => {};
    state.gate.set(connectionId, new Promise<void>((resolve) => { release = resolve; }));
    state.passFirst.set(connectionId, passFirst);
    return () => { release(); state.gate.delete(connectionId); };
  };
  return { port, state, hold };
}

export const THEMES = {
  accordion: "手风琴的声音在雨夜的桥上慢慢响起。路灯照着湿漉漉的石板路。远处有人在轻轻地唱歌。桥下的水面倒映着整座城市的光。她撑着伞停了一会儿。雨点落在伞面上发出细碎的声响。拉琴的老人闭着眼睛，手指在琴键上缓缓地移动。曲子很慢，像是在等什么人回来。",
  piano: "钢琴比赛的决赛在周六下午举行。评委们认真地听着每一位选手演奏的肖邦夜曲。台下的观众屏住了呼吸。最后一个音符落下时掌声响了起来。获奖的少年向评委深深地鞠了一躬。他的老师坐在最后一排，悄悄地擦了擦眼角。后台的走廊里堆满了祝贺的花束。比赛结束后，大厅里的灯一盏一盏熄灭。",
  station: "火车站的大钟指向八点整。旅客们提着行李匆匆走过站台。广播里反复播报着晚点的消息。检票口前排起了长长的队伍。小孩子趴在窗边数着进站的列车。卖报的老人推着小车慢慢走过候车厅。售票窗口的灯一直亮到深夜。冬天的风从站台尽头吹过来，带着煤烟和雪的味道。",
};
export const BOOK = Object.values(THEMES).join("\n");
