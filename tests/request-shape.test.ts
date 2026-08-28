/**
 * The request body per model.
 *
 * Adaptive thinking and output_config.effort arrived with the 4.6 family, and
 * Haiku 4.5 returns 400 invalid_request_error rather than ignoring them. The
 * router can route to Haiku on a nearly empty window, so this is a live path,
 * not only a bench one. Asserting it here costs nothing; finding out costs a
 * failed request in production.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildRequestParams } from "../src/answer.ts";
import { CAPABILITIES, routeFor } from "../src/route.ts";
import type { ModelId, Route } from "../src/route.ts";

const route = (model: ModelId): Route => ({ model, effort: "high", rationale: "test" });

test("the 4.6-family models get adaptive thinking and an effort setting", () => {
  for (const model of ["claude-opus-5", "claude-sonnet-5"] as ModelId[]) {
    const params = buildRequestParams(route(model), "hello");
    assert.deepEqual(params.thinking, { type: "adaptive" });
    assert.deepEqual(params.output_config, { effort: "high" });
  }
});

test("Haiku 4.5 gets neither, because either one is a 400", () => {
  const params = buildRequestParams(route("claude-haiku-4-5"), "hello");
  assert.equal(params.thinking, undefined);
  assert.equal(params.output_config, undefined);
});

test("every model the router can return has a capability entry", () => {
  // A new model added to routing without one would throw at request time.
  const reachable: ModelId[] = ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"];
  for (const model of reachable) {
    assert.ok(CAPABILITIES[model] !== undefined, `${model} has no capability entry`);
    assert.doesNotThrow(() => buildRequestParams(route(model), "hello"));
  }
});

test("the route the router picks for a thin window is actually sendable", () => {
  // routeFor drops to Haiku when the window came back nearly empty, which is
  // exactly the case that used to build an unsendable request.
  const thin = routeFor("daily-briefing", {
    request: {
      task: "daily-briefing",
      clientId: "c",
      advisorId: "a",
      budgetTokens: 10000,
      now: "2026-08-27T09:00:00Z",
    },
    budgetTokens: 10000,
    usedTokens: 200,
    candidateCount: 1,
    entries: [],
    layers: {
      firm: { admitted: 0, dropped: 0, tokens: 0 },
      client: { admitted: 0, dropped: 0, tokens: 0 },
      conversation: { admitted: 0, dropped: 0, tokens: 0 },
    },
  });
  assert.equal(thin.model, "claude-haiku-4-5");
  const params = buildRequestParams(thin, "hello");
  assert.equal(params.thinking, undefined);
  assert.equal(params.model, "claude-haiku-4-5");
});

test("the prompt and streaming flag survive into the request", () => {
  const params = buildRequestParams(route("claude-opus-5"), "the compiled window");
  assert.equal(params.stream, true);
  assert.deepEqual(params.messages, [{ role: "user", content: "the compiled window" }]);
  assert.ok(typeof params.system === "string" && params.system.includes("citation"));
});
