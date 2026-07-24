/**
 * Run: node --experimental-strip-types --test src/ble/pairedDevice.test.ts
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

const store = new Map<string, string>();
(globalThis as { localStorage?: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => {
    store.set(k, v);
  },
  removeItem: (k: string) => {
    store.delete(k);
  },
  clear: () => store.clear(),
  key: () => null,
  get length() {
    return store.size;
  },
};

const { readPairedDevice, writePairedDevice, clearPairedDevice } = await import(
  "./pairedDevice.ts"
);

describe("pairedDevice storage", () => {
  beforeEach(() => {
    store.clear();
  });

  it("round-trips id and name", () => {
    writePairedDevice({ id: "dev-1", name: "XBLOOM-ABC" });
    const got = readPairedDevice();
    assert.ok(got);
    assert.equal(got.id, "dev-1");
    assert.equal(got.name, "XBLOOM-ABC");
    assert.ok(got.updatedAt);
  });

  it("rejects empty id", () => {
    writePairedDevice({ id: "  ", name: "x" });
    assert.equal(readPairedDevice(), null);
  });

  it("clears pair", () => {
    writePairedDevice({ id: "dev-2", name: null });
    clearPairedDevice();
    assert.equal(readPairedDevice(), null);
  });
});
