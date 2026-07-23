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
  importCloudBrewRecords,
  listLocalHistory,
  parseLineChartTelemetry,
} = await import("./localHistory.ts");

const { parseBrewRecordPayload, normaliseBrewRecord } = await import(
  "./xbloomCloud.ts"
);

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

  it("imports cloud brew records idempotently", () => {
    const first = importCloudBrewRecords(
      [
        {
          remote_table_id: 88,
          recipe_name: "Morning Flash",
          serving_kind: "coffee",
          dose_g: 15,
          brew_time_s: 125,
          create_time_stamp: 1784000000,
          recorded_at: "2026-07-14T00:00:00.000Z",
          line_chart_raw: "1,2,3",
          group_name: "2026-07",
        },
      ],
      "china",
    );
    assert.equal(first.imported, 1);
    assert.equal(first.updated, 0);
    assert.equal(listLocalHistory()[0]?.source, "app-cloud");
    assert.equal(listLocalHistory()[0]?.remote_table_id, 88);
    assert.equal(listLocalHistory()[0]?.telemetry?.length, 3);

    const second = importCloudBrewRecords(
      [
        {
          remote_table_id: 88,
          recipe_name: "Morning Flash v2",
          serving_kind: "coffee",
          dose_g: 16,
          brew_time_s: 130,
          recorded_at: "2026-07-14T00:00:00.000Z",
        },
      ],
      "china",
    );
    assert.equal(second.imported, 0);
    assert.equal(second.updated, 1);
    assert.equal(historyStatus().total, 1);
    assert.equal(listLocalHistory()[0]?.recipe_name, "Morning Flash v2");
    // Preserves prior telemetry when update has none
    assert.equal(listLocalHistory()[0]?.telemetry?.length, 3);
  });
});

describe("parseLineChartTelemetry", () => {
  it("parses CSV numbers", () => {
    const s = parseLineChartTelemetry("10,20,30");
    assert.equal(s?.length, 3);
    assert.equal(s?.[2]?.dispensedWaterMl, 30);
  });
});

describe("parseBrewRecordPayload", () => {
  it("normalises gList groups like core catalog", () => {
    const records = parseBrewRecordPayload({
      result: "success",
      gList: [
        {
          groupName: "2026-07",
          list: [
            {
              tableId: 88,
              recipeName: "Morning Flash",
              dose: 15.0,
              brewTime: 125,
              cupType: 2,
              isHavePod: 0,
              createTimeStamp: 1784000000,
              lineChartData: "1,2,3",
            },
          ],
        },
      ],
    });
    assert.equal(records.length, 1);
    assert.equal(records[0]?.remote_table_id, 88);
    assert.equal(records[0]?.recipe_name, "Morning Flash");
    assert.equal(records[0]?.serving_kind, "coffee");
    assert.equal(records[0]?.has_line_chart, true);
    assert.equal(records[0]?.group_name, "2026-07");
  });

  it("marks tea and xpod serving kinds", () => {
    const tea = normaliseBrewRecord({ cupType: 4, theName: "Green", dose: 4 });
    assert.equal(tea.serving_kind, "tea");
    const pod = normaliseBrewRecord({
      isHavePod: 1,
      recipeName: "Pod",
      cupType: 1,
    });
    assert.equal(pod.serving_kind, "xpod");
  });
});
