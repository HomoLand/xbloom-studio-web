/**
 * Default driver selection (W4).
 * Run: node --experimental-strip-types --test src/machine/driver.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  defaultMachineDriver,
  isMachineDriver,
  readMachineDriver,
} from "./driver.ts";

describe("defaultMachineDriver", () => {
  it("selects web-bluetooth when capability usable", () => {
    assert.equal(defaultMachineDriver({ usable: true }), "web-bluetooth");
  });

  it("selects bridge when Web Bluetooth unusable", () => {
    assert.equal(defaultMachineDriver({ usable: false }), "bridge");
  });
});

describe("readMachineDriver without localStorage preference", () => {
  it("follows capability when storage empty", () => {
    // jsdom/node: localStorage may be missing → defaultMachineDriver(cap)
    const missing = typeof localStorage === "undefined";
    if (missing) {
      assert.equal(readMachineDriver({ usable: true }), "web-bluetooth");
      assert.equal(readMachineDriver({ usable: false }), "bridge");
    } else {
      const prev = localStorage.getItem("xbloom.machineDriver");
      localStorage.removeItem("xbloom.machineDriver");
      try {
        assert.equal(readMachineDriver({ usable: true }), "web-bluetooth");
        assert.equal(readMachineDriver({ usable: false }), "bridge");
      } finally {
        if (prev == null) localStorage.removeItem("xbloom.machineDriver");
        else localStorage.setItem("xbloom.machineDriver", prev);
      }
    }
  });
});

describe("isMachineDriver", () => {
  it("accepts only known drivers", () => {
    assert.equal(isMachineDriver("bridge"), true);
    assert.equal(isMachineDriver("web-bluetooth"), true);
    assert.equal(isMachineDriver("ble"), false);
  });
});
