/**
 * Run: node --experimental-strip-types --test src/lib/shareRecipe.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseShareLinkId,
  regionForShareUrl,
} from "./xbloomCloud.ts";

describe("parseShareLinkId", () => {
  it("parses H5 query id", () => {
    const id = parseShareLinkId(
      "https://share-h5.xbloom.com/?id=u4nLTyKMHkocTrTVkxmZhg%3D%3D",
    );
    assert.equal(id, "u4nLTyKMHkocTrTVkxmZhg==");
  });

  it("accepts bare tokens", () => {
    assert.equal(
      parseShareLinkId("850qMtt0WPvyTOSvvizGlw=="),
      "850qMtt0WPvyTOSvvizGlw==",
    );
  });
});

describe("regionForShareUrl", () => {
  it("detects china hosts", () => {
    assert.equal(
      regionForShareUrl("https://share-h5.xbloomcoffee.cn/?id=x"),
      "china",
    );
    assert.equal(
      regionForShareUrl("https://share-h5.xbloom.com/?id=x"),
      "international",
    );
  });
});
