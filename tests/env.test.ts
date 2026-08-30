import assert from "node:assert/strict";
import { test } from "node:test";

import { numberFromEnv } from "../src/env.ts";

const at = (value: string | undefined): NodeJS.ProcessEnv =>
  value === undefined ? {} : { CCC_TEST: value };

test("a well-formed value is read as written", () => {
  assert.equal(numberFromEnv("CCC_TEST", 1.3, 1, at("2.5")), 2.5);
  assert.equal(numberFromEnv("CCC_TEST", 1.3, 1, at("1")), 1);
  assert.equal(numberFromEnv("CCC_TEST", 60_000, 1, at("500")), 500);
});

test("an unset variable takes the fallback", () => {
  assert.equal(numberFromEnv("CCC_TEST", 1.3, 1, at(undefined)), 1.3);
});

test("a variable exported with no value takes the fallback, not zero", () => {
  // `Number("")` is 0 and `??` only defaults on undefined, so the old form
  // read `TOKEN_SAFETY_MARGIN=` as a margin of zero. That makes
  // estimateTokens return 0 for every input, so every window reports fitting
  // its budget and the overflow arrives at request time.
  for (const blank of ["", " ", "\t", "\n"]) {
    assert.equal(numberFromEnv("CCC_TEST", 1.3, 1, at(blank)), 1.3, JSON.stringify(blank));
  }
});

test("a value that is not a number is refused rather than passed through as NaN", () => {
  // The spend cap is enforced with `spent + projected > capUsd`, and every
  // ordered comparison is false against NaN, so a NaN cap authorized every
  // request instead of refusing them. Nothing threw and nothing logged.
  for (const bad of ["abc", "1.2.3", "$0.50", "1e", "0x", "Infinity", "-Infinity", "NaN"]) {
    assert.throws(
      () => numberFromEnv("CCC_TEST", 0.5, 0, at(bad)),
      /CCC_TEST must be a finite number no less than 0/,
      `${JSON.stringify(bad)} should be refused`,
    );
  }
});

test("a value below the floor is refused and the message names the floor", () => {
  assert.throws(
    () => numberFromEnv("CCC_TEST", 1.3, 1, at("0.5")),
    /CCC_TEST must be a finite number no less than 1, not "0\.5"/,
  );
  assert.throws(
    () => numberFromEnv("CCC_TEST", 0.5, 0, at("-1")),
    /no less than 0/,
  );
});

test("the floor is inclusive, so a zero cap means spend nothing", () => {
  // Distinct from a blank variable: `SPEND_CAP_USD=0` is a deliberate choice
  // and has to survive, or the guard would quietly restore the 0.5 default.
  assert.equal(numberFromEnv("CCC_TEST", 0.5, 0, at("0")), 0);
});

test("leading and trailing space around a real number is tolerated", () => {
  assert.equal(numberFromEnv("CCC_TEST", 1.3, 1, at(" 2.5 ")), 2.5);
});
