import test from "node:test";
import assert from "node:assert/strict";
import { readDesignStream } from "./designStream.ts";

function response(events: unknown[], closed = true): Response {
  const bytes = new TextEncoder().encode(": keepalive\n\n" + events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""));
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
    if (closed) controller.close();
  }}), { headers: { "Content-Type": "text/event-stream" } });
}

test("SSE preserves split UTF-8 and accepts only a validated final result", async () => {
  const events: unknown[] = [];
  const result = await readDesignStream(response([
    { kind: "draft", rationale: "花香与甜感" },
    { kind: "result", result: { recipe_candidate: { name: "测试配方" }, validation: { valid: true } } },
  ]), event => events.push(event));
  assert.equal(result.recipe_candidate.name, "测试配方");
  assert.deepEqual(events, [{ kind: "draft", rationale: "花香与甜感" }]);
});

test("truncated streams and invalid recipes cannot become usable cards", async () => {
  await assert.rejects(readDesignStream(response([{ kind: "stage", stage: "thinking" }]), () => {}), /before recipe validation/);
  await assert.rejects(readDesignStream(response([{ kind: "result", result: { validation: { valid: false } } }]), () => {}), /validation failed/);
  await assert.rejects(readDesignStream(response([{ kind: "error", error: { message: "Search unavailable" } }]), () => {}), /Search unavailable/);
});
