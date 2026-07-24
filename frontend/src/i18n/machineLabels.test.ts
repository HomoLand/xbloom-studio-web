/**
 * Run: node --experimental-strip-types --test src/i18n/machineLabels.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  labelMachineName,
  labelMachineOrPhase,
  labelPhase,
} from "./machineLabels.ts";
import { messages } from "./messages.ts";

function makeT(locale: "zh-CN" | "en") {
  return (key: string, fallback?: string) =>
    messages[locale][key] ?? messages["zh-CN"][key] ?? fallback ?? key;
}

describe("machineLabels zh-CN", () => {
  const t = makeT("zh-CN");

  it("labels session phases", () => {
    assert.equal(labelPhase(t, "brewing"), "冲煮中");
    assert.equal(labelPhase(t, "connecting"), "连接中");
    assert.equal(labelPhase(t, "idle"), "空闲");
  });

  it("labels machine states for tea/coffee", () => {
    assert.equal(labelMachineName(t, "tea_soaking"), "浸泡中");
    assert.equal(labelMachineName(t, "awaiting_confirm"), "等待确认");
    assert.equal(labelMachineName(t, "ready"), "冲煮完成");
    assert.equal(labelMachineName(t, "no_water"), "缺水");
  });

  it("labels FreeSolo activities", () => {
    assert.equal(labelMachineName(t, "brewer_started"), "开始出水");
    assert.equal(labelMachineName(t, "brewer_exited"), "退出出水");
    assert.equal(labelMachineName(t, "grinder_started"), "开始研磨");
  });

  it("never shows hex — 0x45 is tea steeping", () => {
    assert.equal(labelMachineName(t, "status_0x45"), "浸泡中");
    assert.equal(labelMachineName(t, "unknown_0x45"), "浸泡中");
    assert.equal(labelMachineName(t, "0x45"), "浸泡中");
    assert.equal(labelMachineName(t, "ack_0x2a"), "指令已确认");
    assert.equal(labelMachineName(t, "status_0xfe"), "运行中");
  });

  it("prefers machine state over phase", () => {
    assert.equal(labelMachineOrPhase(t, "tea_soaking", "brewing"), "浸泡中");
    assert.equal(labelMachineOrPhase(t, null, "connected"), "已连接");
  });
});

describe("machineLabels en", () => {
  const t = makeT("en");

  it("labels in English", () => {
    assert.equal(labelPhase(t, "brewing"), "Brewing");
    assert.equal(labelMachineName(t, "tea_soaking"), "Steeping");
    assert.equal(labelMachineName(t, "brewer_started"), "Pouring started");
  });
});
