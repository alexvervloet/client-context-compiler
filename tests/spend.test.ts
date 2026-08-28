/**
 * The control that was missing.
 *
 * A bench in this repository made twelve uncapped calls and the thing that
 * stopped it was the account running out of credit. These assert that a cap
 * refuses the request rather than reporting on it afterwards.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { makeLedger, projectWorstCaseUsd, SpendCapExceeded } from "../src/spend.ts";

test("a projection that fits is authorized", () => {
  const budget = makeLedger(1);
  assert.doesNotThrow(() => budget.authorize(0.5, "a call"));
});

test("a projection that would breach the cap is refused before the call", () => {
  const budget = makeLedger(0.1);
  assert.throws(() => budget.authorize(0.5, "an expensive call"), SpendCapExceeded);
  // Nothing was spent, because nothing was allowed to happen.
  assert.equal(budget.spentUsd(), 0);
});

test("spend accumulates and the cap tightens as it does", () => {
  const budget = makeLedger(1);
  budget.record(0.6);
  assert.doesNotThrow(() => budget.authorize(0.3, "fits"));
  assert.throws(() => budget.authorize(0.5, "no longer fits"), SpendCapExceeded);
  assert.equal(budget.remainingUsd().toFixed(2), "0.40");
});

test("the refusal says what it would have cost and what the cap is", () => {
  const budget = makeLedger(0.25);
  budget.record(0.2);
  try {
    budget.authorize(0.4, "compliance-review on claude-opus-5");
    assert.fail("should have thrown");
  } catch (error) {
    assert.ok(error instanceof SpendCapExceeded);
    assert.match(error.message, /compliance-review on claude-opus-5/);
    assert.match(error.message, /\$0\.4000/);
    assert.match(error.message, /\$0\.25/);
    assert.match(error.message, /SPEND_CAP_USD/);
  }
});

test("the projection is the worst case, not a typical one", () => {
  // Opus at $5 in / $25 out: 10k in and 16k out is the number that matters,
  // because max_tokens is what the request is actually allowed to generate.
  const worst = projectWorstCaseUsd("claude-opus-5", 10_000, 16_000);
  assert.equal(worst.toFixed(2), "0.45");

  // The same request with a per-task ceiling instead of a flat 16000.
  const bounded = projectWorstCaseUsd("claude-opus-5", 10_000, 4_000);
  assert.ok(bounded < worst / 2, "a tighter output ceiling should more than halve it");
});

test("cheaper models project cheaper, which is the point of routing down", () => {
  const opus = projectWorstCaseUsd("claude-opus-5", 10_000, 4_000);
  const sonnet = projectWorstCaseUsd("claude-sonnet-5", 10_000, 4_000);
  const haiku = projectWorstCaseUsd("claude-haiku-4-5", 10_000, 4_000);
  assert.ok(opus > sonnet && sonnet > haiku);
});
