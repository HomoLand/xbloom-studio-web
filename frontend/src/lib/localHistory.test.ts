/**
 * Run: node --experimental-strip-types --test src/lib/localHistory.test.ts
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

// Minimal localStorage polyfill for node tests.
const store = new Map<string, string>();
(globalThis as { localStorage?: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => {
    store.set(k, String(v));
  },
  removeItem: (k: string) => {
    store.delete(k);
  },
  clear: () => store.clear(),
  key: () => null,
  get length() {
    return store.size;
  },
} as Storage;

const {
  appendLocalHistory,
  clearLocalHistory,
  getLocalHistoryEvent,
  historyStatus,
  listLocalHistory,
} = await import("./localHistory.ts");

describe("localHistory", () => {
  beforeEach(() => {
    clearLocalHistory();
  });

  it("appends and lists with telemetry", () => {
    const e = appendLocalHistory({
      outcome: "completed",
      source: "web-bluetooth",
      recipe_name: "Test brew",
      telemetry: [
        { t: 0, cupWeightG: 0, dispensedWaterMl: 0 },
        { t: 1000, cupWeightG: 10, dispensedWaterMl: 40 },
      ],
    });
    assert.ok(e.event_id);
    assert.equal(listLocalHistory()[0]?.recipe_name, "Test brew");
    assert.equal(getLocalHistoryEvent(e.event_id)?.telemetry?.length, 2);
    assert.equal(historyStatus().total, 1);
    assert.equal(historyStatus().by_outcome.completed, 1);
  });
});
