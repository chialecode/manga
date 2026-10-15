import { describe, expect, it } from "vitest";
import { KEY_LIMIT, evenKeys, keyBetween } from "../../packages/app-core/src/creative/sort-key.ts";

describe("sort keys between siblings", () => {
  it("makes a key between any two neighbours, at the start and at the end, and never repeats one", () => {
    const keys: string[] = [keyBetween(null, null)];
    // Always insert at the front, at the end and in the middle: the order must stay strictly increasing.
    for (let i = 0; i < 300; i += 1) {
      if (i % 3 === 0) keys.unshift(keyBetween(null, keys[0]!));
      else if (i % 3 === 1) keys.push(keyBetween(keys[keys.length - 1]!, null));
      else { const at = Math.floor(keys.length / 2); keys.splice(at, 0, keyBetween(keys[at - 1]!, keys[at]!)); }
    }
    expect([...keys].sort()).toEqual(keys);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((key) => !key.endsWith("0"))).toBe(true);
  });

  it("grows slowly when items are appended, so a long list is renewed only now and then", () => {
    let key = keyBetween(null, null);
    let appended = 0;
    while (key.length <= KEY_LIMIT) { key = keyBetween(key, null); appended += 1; }
    expect(appended).toBeGreaterThan(80);
  });

  it("renews a list with even keys that keep their order, are short, and leave room to insert between any two", () => {
    for (const count of [1, 2, 5, 35, 36, 200, 1000]) {
      const keys = evenKeys(count);
      expect(keys).toHaveLength(count);
      expect([...keys].sort()).toEqual(keys);
      expect(new Set(keys).size).toBe(count);
      expect(Math.max(...keys.map((key) => key.length))).toBeLessThanOrEqual(3);
      for (let i = 1; i < keys.length; i += 1) {
        const middle = keyBetween(keys[i - 1]!, keys[i]!);
        expect(middle > keys[i - 1]! && middle < keys[i]!).toBe(true);
      }
      expect(keyBetween(null, keys[0]!) < keys[0]!).toBe(true);
    }
    expect(evenKeys(0)).toEqual([]);
  });

  it("refuses keys that are out of order", () => {
    expect(() => keyBetween("b", "a")).toThrow();
    expect(() => keyBetween("a", "a")).toThrow();
  });
});
