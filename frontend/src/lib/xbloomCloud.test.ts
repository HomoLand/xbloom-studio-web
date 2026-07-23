/**
 * Run: node --experimental-strip-types --test src/lib/xbloomCloud.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  appEncryptForm,
  buildCloudCoffeeForm,
  collectRecipeRecords,
  APP_RSA_PUBLIC_KEY_B64,
} from "./xbloomCloud.ts";

describe("xbloomCloud RSA form encrypt", () => {
  it("produces base64 ciphertext of expected block size", () => {
    const cipher = appEncryptForm({ hello: "world", n: 1 });
    assert.ok(typeof cipher === "string" && cipher.length > 20);
    // 1024-bit RSA → 128-byte blocks; one small JSON fits one block → 128 B → 172 b64 chars (with padding)
    const raw = Uint8Array.from(atob(cipher), (c) => c.charCodeAt(0));
    assert.equal(raw.length % 128, 0);
    assert.ok(raw.length >= 128);
  });

  it("public key is parseable (non-empty)", () => {
    assert.ok(APP_RSA_PUBLIC_KEY_B64.length > 100);
  });
});

describe("buildCloudCoffeeForm", () => {
  it("maps coffee pours to app form", () => {
    const form = buildCloudCoffeeForm({
      name: "Test Omni",
      kind: "hot",
      dripper: "Omni",
      dose_g: 15,
      grind: 50,
      ratio: 16,
      water_ml: 240,
      pours: [
        {
          label: "Bloom",
          ml: 45,
          temp_c: 92,
          pattern: "center",
          vibration: "after",
          pause_s: 30,
          rpm: 0,
          flow_ml_s: 3.0,
        },
        {
          label: "Main",
          ml: 195,
          temp_c: 92,
          pattern: "spiral",
          vibration: "none",
          pause_s: 10,
          rpm: 90,
          flow_ml_s: 3.2,
        },
      ],
    });
    assert.equal(form.theName, "Test Omni");
    assert.equal(form.cupType, 2);
    assert.equal(form.dose, 15);
    assert.equal(form.rpm, 90);
    assert.ok(typeof form.pourDataJSONStr === "string");
    const pours = JSON.parse(String(form.pourDataJSONStr)) as unknown[];
    assert.equal(pours.length, 2);
  });
});

describe("collectRecipeRecords", () => {
  it("finds nested recipe-like objects", () => {
    const payload = {
      result: "success",
      recipeList: [
        {
          theName: "A",
          dose: 15,
          pourDataJSONStr: "[]",
          tableId: 12,
        },
      ],
    };
    // pourDataJSONStr "[]" still has hasPours true but empty — still counted as record
    const recs = collectRecipeRecords(payload);
    assert.equal(recs.length, 1);
    assert.equal(recs[0]?.theName, "A");
  });
});
