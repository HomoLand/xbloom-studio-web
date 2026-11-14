/**
 * Run: node --experimental-strip-types --test src/lib/xbloomCloud.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  appEncryptForm,
  CloudError,
  cloudErrorMessage,
  buildCloudCoffeeForm,
  canUploadRecipeToCloud,
  collectRecipeRecords,
  resolveCloudCoffeeRpm,
  APP_RSA_PUBLIC_KEY_B64,
} from "./xbloomCloud.ts";
import { defaultTeaRecipe } from "./recipeDomain.ts";

describe("cloud login error display", () => {
  const t = (key: "cloud.networkError" | "cloud.sessionExpired") => key;

  it("keeps login transport failures distinct from rejected credentials", () => {
    assert.equal(
      cloudErrorMessage(new CloudError("xBloom cloud tMemberLogin.thtml request failed (network/CORS)"), t),
      "cloud.networkError",
    );
    assert.equal(
      cloudErrorMessage(new CloudError("xBloom account login was rejected"), t),
      "cloud.sessionExpired",
    );
    for (const detail of ["returned HTTP 500", "timed out", "returned invalid JSON"]) {
      const message = `xBloom cloud tMemberLogin.thtml ${detail}`;
      assert.equal(cloudErrorMessage(new CloudError(message), t), message);
    }
    assert.equal(
      cloudErrorMessage(new CloudError("xBloom cloud tuMyRecipeProduct.tuhtml returned HTTP 401"), t),
      "cloud.sessionExpired",
    );
  });
});

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

describe("resolveCloudCoffeeRpm & canUploadRecipeToCloud", () => {
  const dirtyLegacyRecipe = {
    name: "Legacy Dirty RPM Omni",
    kind: "hot" as const,
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
        pattern: "center" as const,
        vibration: "after" as const,
        pause_s: 30,
        rpm: 0,
        flow_ml_s: 3.0,
      },
      {
        label: "Pour 1",
        ml: 95,
        temp_c: 92,
        pattern: "spiral" as const,
        vibration: "none" as const,
        pause_s: 10,
        rpm: 110,
        flow_ml_s: 3.2,
      },
      {
        label: "Pour 2",
        ml: 100,
        temp_c: 91,
        pattern: "circular" as const,
        vibration: "none" as const,
        pause_s: 0,
        rpm: 90,
        flow_ml_s: 3.0,
      },
    ],
  };

  it("picks global grinder RPM cleanly and silently normalizes legacy dirty pours", () => {
    assert.equal(
      resolveCloudCoffeeRpm([
        { ...dirtyLegacyRecipe.pours[0] },
        { ...dirtyLegacyRecipe.pours[1], rpm: 90 },
      ]),
      90,
    );
    assert.equal(
      resolveCloudCoffeeRpm(
        dirtyLegacyRecipe.pours.map((p) => ({ ...p, rpm: 0 })),
      ),
      120,
    );
    assert.equal(resolveCloudCoffeeRpm(dirtyLegacyRecipe.pours), 110);

    const form = buildCloudCoffeeForm(dirtyLegacyRecipe);
    assert.equal(form.rpm, 110);
  });

  it("allows Omni and tea recipes while rejecting xPod recipes", () => {
    assert.deepEqual(canUploadRecipeToCloud(dirtyLegacyRecipe), { ok: true });
    assert.deepEqual(canUploadRecipeToCloud(defaultTeaRecipe()), { ok: true });

    const xpodCheck = canUploadRecipeToCloud({
      ...dirtyLegacyRecipe,
      dripper: "xPod",
    });
    assert.equal(xpodCheck.ok, false);
  });
});
