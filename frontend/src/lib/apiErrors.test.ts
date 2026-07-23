/**
 * Deterministic unit tests for C8 error classification.
 * Run: node --experimental-strip-types --test src/lib/*.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyOperationalError,
  isAuthExpiredError,
  isProviderTimeoutError,
  type ErrorFields,
} from "./apiErrors.ts";

function err(partial: Partial<ErrorFields> & { message: string }): ErrorFields {
  return {
    status: partial.status ?? 500,
    code: partial.code ?? "unknown",
    category: partial.category ?? "unknown",
    details: partial.details ?? null,
    message: partial.message,
  };
}

describe("classifyOperationalError", () => {
  it("classifies auth expiration", () => {
    const e = err({
      status: 401,
      code: "auth_required",
      category: "authentication",
      message: "session gone",
    });
    assert.equal(isAuthExpiredError(e), true);
    const c = classifyOperationalError(e);
    assert.equal(c.kind, "auth_expired");
    assert.equal(c.authExpired, true);
    assert.equal(c.blockMutation, true);
  });

  it("classifies Design timeout as provider_timeout", () => {
    const e = err({
      status: 504,
      code: "timeout",
      category: "timeout",
      message: "deadline",
    });
    const c = classifyOperationalError(e, { context: "Design" });
    assert.equal(c.kind, "provider_timeout");
    assert.ok(c.action && /Provider timed out/i.test(c.action));
    assert.equal(isProviderTimeoutError(e, { context: "Design" }), true);
  });

  it("classifies hardware control timeout as generic timeout (not provider)", () => {
    const e = err({
      status: 504,
      code: "timeout",
      category: "timeout",
      message: "BLE control timed out",
    });
    const c = classifyOperationalError(e, {
      context: "stop",
      knownWorkflowId: "wf_hw",
    });
    assert.equal(c.kind, "timeout");
    assert.notEqual(c.kind, "provider_timeout");
    assert.ok(c.action && /do not blindly repeat/i.test(c.action));
    assert.ok(c.action && !/Provider timed out/i.test(c.action));
    assert.equal(c.uncertain, true);
    assert.equal(isProviderTimeoutError(e, { context: "stop" }), false);
  });

  it("classifies explicit provider_timeout code regardless of context", () => {
    const e = err({
      status: 504,
      code: "provider_timeout",
      category: "provider",
      message: "vision deadline",
    });
    const c = classifyOperationalError(e, { context: "Dashboard" });
    assert.equal(c.kind, "provider_timeout");
  });

  it("classifies invalid candidate", () => {
    const e = err({
      status: 400,
      code: "invalid_candidate",
      category: "validation",
      message: "bad recipe",
    });
    const c = classifyOperationalError(e);
    assert.equal(c.kind, "invalid_candidate");
    assert.equal(c.blockMutation, false);
  });

  it("prefers server details.workflow_id over stale known id", () => {
    const e = err({
      status: 409,
      code: "workflow_mismatch",
      category: "bridge",
      message: "wrong workflow",
      details: { workflow_id: "wf_actual" },
    });
    const c = classifyOperationalError(e, { knownWorkflowId: "wf_stale" });
    assert.equal(c.kind, "workflow_mismatch");
    assert.equal(c.blockMutation, true);
    assert.equal(c.workflowId, "wf_actual");
    assert.equal(c.knownWorkflowId, "wf_stale");
  });

  it("classifies protocol incompatible", () => {
    const e = err({
      status: 503,
      code: "protocol_incompatible",
      category: "bridge",
      message: "rpc range",
    });
    const c = classifyOperationalError(e);
    assert.equal(c.kind, "protocol_incompatible");
  });

  it("classifies device_busy_external as sticky", () => {
    const e = err({
      status: 409,
      code: "device_busy_external",
      category: "bridge",
      message: "phone owns link",
    });
    const c = classifyOperationalError(e);
    assert.equal(c.kind, "device_busy_external");
    assert.equal(c.stickyBusy, true);
    assert.equal(c.uncertain, false);
  });

  it("classifies recovery_required without inventing ids", () => {
    const e = err({
      status: 409,
      code: "recovery_required",
      category: "bridge",
      message: "need reconcile",
      details: { workflow_id: "wf_rec" },
    });
    const c = classifyOperationalError(e);
    assert.equal(c.kind, "recovery_required");
    assert.equal(c.workflowId, "wf_rec");
    assert.ok(c.action && /Reconcile/i.test(c.action));
    // No internal request-id tutorial copy.
    assert.ok(c.action && !/request_id/i.test(c.action));
  });
});
